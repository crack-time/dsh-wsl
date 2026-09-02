/**
 * @crack/dsh-wsl/tool — model-facing WSL shell tool.
 *
 * Runs commands *inside* a WSL distro via `wsl.exe` WITHOUT going through
 * `ctx.shell`. Rationale: `ctx.shell` is a single-provider seam owned by the
 * host composition (`SandboxPwshExecutor` on Windows). A second executor
 * mounting `shell` is rejected by cordis (`service "shell" has been
 * registered`), and an agent preset cannot publish a root-realm provider
 * (`leakedServices` audit). So a per-WSL-workspace shell cannot be installed
 * into `ctx.shell`.
 *
 * Instead this is a normal CONSUMER of the host `ctx.subprocess` service
 * (host-plane, injected legally), delivered as an `@crack/dsh-wsl/tool` plugin
 * row inside the `standard-wsl` agent preset. It builds a `wsl.exe` argv that
 * runs the command in the distro:
 *
 *     wsl.exe [-d <distro>] --cd <linux-path> --exec bash -lc <script>
 *
 * and delegates process mechanics to `ctx.subprocess` with the SAME request/
 * spec, deadline, and bounded-collect vocabulary the stock executors use
 * (`@deepseek-ai/dsh-timeout` `deadline`, the local subprocess collect + spill
 * shape). Foreground output, background handles, and cancellation behave like
 * `bash`/`pwsh`; only the argv (wsl.exe) and the lack of a Windows file-sandbox
 * wrap differ (Linux-side work cannot be confined by the Windows ACL sandbox).
 */
import { isAbsolute, resolve } from 'node:path';
import { connect } from 'node:net';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { TOOL_ABORTED } from '@deepseek-ai/dsh-tools';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { parseExitStatus } from '@deepseek-ai/dsh-shell';
import { clampTimeout, deadline, timeoutOf } from '@deepseek-ai/dsh-timeout';
export const name = 'tool-wsl';
export const inject = ['tools', 'systemPrompt', 'subprocess', 'shellEnv', 'jobs'];
// ---------------------------------------------------------------------------
// WSL / env helpers
// ---------------------------------------------------------------------------
const DEFAULT_DISTRO = 'Ubuntu-22.04';
const TIMEOUT_CODE = 'TOOL_WSL_TIMEOUT';
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_TIMEOUT_MS = 600000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_GRACE_MS = 3000;
const WSL_UNC_RE = /^\\\\wsl(?:\$|\.localhost)\\([^\\]+)\\(.*)$/i;
function shellQuote(value) {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}
/** True when a workdir points into a WSL distro via its UNC share. */
function isWslUnc(workdir) {
    return WSL_UNC_RE.test(workdir.replaceAll('/', '\\'));
}
/** Translate a workdir into the in-distro path (UNC share or bare Linux path). */
function toWslPath(workdir) {
    if (!workdir)
        return '/';
    const win = workdir.replaceAll('/', '\\');
    const m = WSL_UNC_RE.exec(win);
    if (!m)
        return workdir;
    const inside = m[2] ?? '';
    return `/${inside.replaceAll('\\', '/')}`;
}
/** The distro name from a WSL UNC workdir, else the configured default. */
function distroOf(workdir, configuredDistro) {
    const win = String(workdir ?? '').replaceAll('/', '\\');
    const m = WSL_UNC_RE.exec(win);
    if (m && m[1])
        return m[1];
    return (configuredDistro && configuredDistro.trim()) || DEFAULT_DISTRO;
}
function wslArgv(distro, linuxPath, script, command) {
    return ['wsl.exe', '-d', distro, '--cd', linuxPath, '--exec', 'bash', '-lc', `${script}\n${command}`];
}
/**
 * Run a single foreground command against the resident WSL exec-server
 * (daemon/exec-server.js) over a localhost TCP socket. Opens a fresh
 * connection per call; the daemon's own persistent bash holds `cd`/`export`
 * across calls. The daemon enforces the timeout and replies done with the
 * exit code; the local timer is only a safety net for total unavailability.
 */
function runViaDaemon(host, port, req) {
    return new Promise((resolve, reject) => {
        const socket = connect({ host, port });
        let buf = '';
        let stdout = '';
        let stderr = '';
        let done = false;
        const settle = (fn) => { if (!done) {
            done = true;
            fn();
        } };
        const fail = (msg) => settle(() => { socket.destroy(); reject(new Error(msg)); });
        const idle = setTimeout(() => fail(`daemon unresponsive after ${req.timeoutMs}ms`), req.timeoutMs + 8000);
        socket.on('error', (e) => settle(() => { fail(`daemon connect failed: ${e.message}`); }));
        socket.on('connect', () => {
            socket.write(JSON.stringify({
                id: 1,
                cmd: req.cmd,
                session: req.session,
                initWorkdir: req.initWorkdir,
                workdir: req.workdir,
                env: req.env,
                timeoutMs: req.timeoutMs,
            }) + '\n');
        });
        socket.on('data', (chunk) => {
            buf += chunk.toString('utf8');
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, i).trim();
                buf = buf.slice(i + 1);
                if (!line)
                    continue;
                let f;
                try {
                    f = JSON.parse(line);
                }
                catch {
                    continue;
                }
                if (f.id !== 1)
                    continue;
                if (f.channel === 'stdout')
                    stdout += f.text ?? '';
                else if (f.channel === 'stderr')
                    stderr += f.text ?? '';
                else if (f.done) {
                    clearTimeout(idle);
                    settle(() => {
                        socket.end();
                        resolve({
                            exitCode: f.exitCode ?? null,
                            signal: f.signal ?? null,
                            stdout,
                            stderr,
                            timedOut: f.error === 'timed out' || /timed out/.test(f.error ?? ''),
                            error: f.error,
                        });
                    });
                }
            }
        });
    });
}
// ---------------------------------------------------------------------------
// Daemon auto-start (self-contained; no dependency on daemon/launch.sh)
// ---------------------------------------------------------------------------
// State is module-level so concurrent sessions in the host process share one
// in-flight launch and a throttle window (we don't hammer wsl.exe per call).
let daemonLaunching = null;
let lastDaemonStart = 0;
const DAEMON_AUTO_START_THROTTLE_MS = 15000;
const DAEMON_START_WAIT_MS = 3500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Bash one-liner, spawn via `wsl.exe -d <distro> -- bash -lc <this>`.
// Resolves a node by preference, cd's into ~/.dshwsl, and starts the
// exec-server detached (setsid nohup + </dev/null + disown). The trailing
// `sleep 2` keeps the parent bash alive long enough for setsid to fully
// detach so the process survives the wsl.exe client exiting — without it the
// daemon is reaped on exit. `$VAR` stays literal for bash (JS only expands
// `${`). Mirrors daemon/launch.sh so the tool is self-sufficient without it.
const DAEMON_LAUNCH_BASH = [
    'cd "$HOME/.dshwsl" 2>/dev/null || { echo "dsh-wsl: ~/.dshwsl missing" >&2; exit 2; }',
    'if command -v node >/dev/null 2>&1; then NODE="$(command -v node)"; elif [ -x /home/linuxbrew/.linuxbrew/bin/node ]; then NODE="/home/linuxbrew/.linuxbrew/bin/node"; elif [ -x "$HOME/.zcode/server/node" ]; then NODE="$HOME/.zcode/server/node"; else echo "dsh-wsl: no node in WSL" >&2; exit 3; fi',
    '[ -f exec-server.js ] || { echo "dsh-wsl: daemon payload missing (run daemon/launch.sh once)" >&2; exit 4; }',
    'setsid nohup "$NODE" exec-server.js > exec.log 2>&1 < /dev/null & disown 2>/dev/null || true',
    'sleep 2',
].join('; ');
async function launchDaemonViaWsl(ctx, distro, signal) {
    try {
        const handle = ctx.subprocess.spawn({
            argv: ['wsl.exe', '-d', distro, '--', 'bash', '-lc', DAEMON_LAUNCH_BASH],
            cwd: process.cwd(),
            stdio: {
                stdin: 'ignore',
                stdout: { maxBytes: 4096 },
                stderr: { maxBytes: 4096 },
            },
            graceMs: 2000,
            ...(signal ? { signal } : {}),
        });
        await handle.done;
        return true;
    }
    catch {
        return false;
    }
}
// ---------------------------------------------------------------------------
// Stream + result projection (mirror @deepseek-ai/dsh-tool-bash)
// ---------------------------------------------------------------------------
function finalOutput(reader) {
    const read = reader.readFrom(0);
    return {
        text: read.text,
        truncated: read.lossy,
        ...(read.spillPath !== void 0 ? { spillPath: read.spillPath } : {}),
    };
}
function streamText(output) {
    if (!output.truncated)
        return output.text;
    return `${output.text}\n[output truncated; full output: ${output.spillPath ?? '(unavailable)'}]`;
}
function renderResult(result) {
    const out = streamText(result.stdout);
    const err = streamText(result.stderr);
    let body = out;
    if (err.length > 0) {
        if (body.length > 0 && !body.endsWith('\n'))
            body += '\n';
        body += `[stderr]\n${err}`;
    }
    if (body.length === 0)
        body = '(no output)';
    const markers = [];
    if (result.timedOut)
        markers.push(`[timed out after ${result.timeoutMs}ms]`);
    if (result.signal !== null)
        markers.push(`[killed by signal: ${result.signal}]`);
    else if (result.exitCode !== 0)
        markers.push(`[exit code: ${result.exitCode}]`);
    if (markers.length === 0)
        return body;
    if (!body.endsWith('\n'))
        body += '\n';
    return body + markers.join('\n');
}
function validateArgs(args) {
    if (args.command.trim().length === 0)
        throw new Error('invalid command: expected a non-empty string');
    if (args.description.trim().length === 0)
        throw new Error('invalid description: expected a non-empty string');
    if (args.timeoutMs !== void 0 && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
        throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`);
    }
}
function presentResult(args, result) {
    const block = result.content.length === 1 ? result.content[0] : void 0;
    if (block === void 0 || block.type !== 'text')
        return void 0;
    const raw = block.text;
    if (result.isError === true || args.run_in_background === true) {
        return { card: 'generic', content: [{ type: 'text', text: `\`\`\`console\n${raw.replace(/\n+$/, '')}\n\`\`\`` }] };
    }
    const { body, ...exit } = parseExitStatus(raw);
    return { card: 'terminal', output: body, ...exit };
}
/** Build a `bash` prefix that re-exports model-facing env inside the distro. */
function buildScript(modelFriendlyEnv) {
    const lines = [];
    for (const [key, value] of Object.entries(modelFriendlyEnv)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
            continue;
        lines.push(`export ${key}=${shellQuote(value)}`);
    }
    return lines.join('\n');
}
// Bridge-mode env bootstrap. `wsl.exe --exec bash -lc` is non-interactive, so
// it never reads ~/.bashrc and brew/conda/cuda/lammps are off PATH — uv/conda
// report "not found" for one-shot commands. Source the SAME dshwsl-env.bash the
// daemon's persistent bash loads via BASH_ENV, so bridge and daemon expose the
// identical environment (uv/conda/brew/node reachable in both). Best-effort:
// skipped when the file is absent (fresh clone / not yet deployed).
const BRIDGE_ENV_BOOT = '[ -r "$HOME/.dshwsl/dshwsl-env.bash" ] && . "$HOME/.dshwsl/dshwsl-env.bash" || true';
// ---------------------------------------------------------------------------
// The tool plugin
// ---------------------------------------------------------------------------
export function apply(_ctx, config = {}) {
    const ctx = _ctx;
    const configuredDistro = typeof config.distro === 'string' && config.distro ? config.distro : DEFAULT_DISTRO;
    const backgroundEnabled = config.enableRunInBackground ?? true;
    // daemon is the preferred execution mode (resident, state persists); an
    // explicit runtime: 'bridge' opts out. When no runtime is set, daemon wins
    // and falls back to the bridge if the daemon is unreachable.
    const daemonEnabled = config.runtime !== 'bridge';
    const daemonHost = config.daemon?.host ?? '127.0.0.1';
    const daemonPort = config.daemon?.port ?? 37778;
    // On first unreachable call, self-launch the daemon via wsl.exe (then retry
    // once) instead of only falling back to the bridge. Default on.
    const daemonAutoStart = config.daemon?.autoStart ?? true;
    const maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES;
    const collect = (maxBytes) => ({ maxBytes, spill: { maxBytes } });
    ctx.systemPrompt.section({
        name: 'tool:wsl',
        // External contributions may use any finite order. getSectionOrder('TOOL_WSL')
        // is not in the reserved PromptSectionOrderName set and would resolve to NaN
        // (throwing "order must be a finite number"), so pass a literal 1000 to sit
        // beside the tool-bash/pwsh guidance (equal orders break by name).
        order: 1000,
        text: 'Check the [exit code: N] marker on every wsl result; investigate failures before moving on.',
    });
    ctx.tools.register(defineTool({
        name: 'wsl',
        description: 'Execute a command inside a WSL distro and return its stdout/stderr. ' +
            'Use this for WSL workspaces (paths under \\\\wsl.localhost\\... or \\\\wsl$\\...); the session workspace is ' +
            'translated to its in-distro Linux path. ' +
            (daemonEnabled
                ? 'Commands run against a RESIDENT bash session in WSL via the exec-server; state (cd, exports) persists across calls, so "cd" and environment changes survive.'
                : 'Each call bridges into WSL via wsl.exe in a fresh bash shell: no state persists between calls — pass "workdir" instead of using "cd".') +
            ' Non-zero exits are reported as "[exit code: N]". ' +
            (backgroundEnabled
                ? 'Set "run_in_background: true" for long-running commands: the call returns a job id immediately; read its output with "job_output" and stop it with "job_kill".'
                : 'Background execution is not available; long-running commands must finish within the timeout.'),
        parameters: {
            command: { type: 'string', required: true, description: 'The bash command to execute inside the WSL distro.' },
            description: { type: 'string', required: true, description: 'Clear, concise description of what this command does in active voice, 5-10 words.' },
            timeoutMs: { type: 'number', description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, capped at ${MAX_TIMEOUT_MS}). The runner kills the command on expiry.` },
            workdir: { type: 'string', description: 'Working directory inside the WSL distro. Defaults to the session workspace (its UNC is translated to a Linux path).' },
            ...(backgroundEnabled ? { run_in_background: { type: 'boolean', description: 'Run in the background and return a job id immediately.' } } : {}),
        },
        output: {
            schema: {
                oneOf: [
                    { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', required: true, const: 'background' }, jobId: { type: 'string', required: true } } },
                    { type: 'object', additionalProperties: false, properties: {
                            kind: { type: 'string', required: true, const: 'foreground' },
                            exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
                            signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
                            timedOut: { type: 'boolean' },
                            aborted: { type: 'boolean' },
                            timeoutMs: { type: 'number' },
                            stdout: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' }, truncated: { type: 'boolean' }, spillPath: { type: 'string' } } },
                            stderr: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' }, truncated: { type: 'boolean' }, spillPath: { type: 'string' } } },
                        } },
                ],
            },
            render: (_args, value) => {
                const text = value.kind === 'background'
                    ? `started background job ${value.jobId ?? ''}`
                    : renderResult(value);
                return [{ type: 'text', text }];
            },
        },
        async execute(args, exec) {
            validateArgs(args);
            const sessionCwd = exec.agent?.session.header.cwd;
            const workdir = args.workdir !== void 0
                ? (isAbsolute(args.workdir) ? args.workdir : resolve(sessionCwd ?? '', args.workdir))
                : sessionCwd;
            const distro = distroOf(workdir, configuredDistro);
            const linuxPath = toWslPath(workdir ?? '');
            const dshEnv = ctx.shellEnv.collect(exec);
            const script = [BRIDGE_ENV_BOOT, buildScript(dshEnv)].filter(Boolean).join('\n');
            const argv = wslArgv(distro, linuxPath, script, args.command);
            const timeoutMs = clampTimeout(args.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, 'request.timeoutMs');
            // Resident-execution path (preferred): send foreground commands to the WSL
            // exec-server instead of bridging wsl.exe per call. If the daemon is not
            // reachable, auto-start it (throttled) and retry once; only if that still
            // fails do we gracefully fall back to the one-shot bridge.
            let daemonFallbackNote;
            if (daemonEnabled && args.run_in_background !== true) {
                if (args.env) {
                    for (const [k, v] of Object.entries(args.env))
                        if (typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
                            dshEnv[k] = v;
                }
                // Rebuild the daemon request (dshEnv may have grown above).
                const daemonReq = {
                    cmd: args.command,
                    session: linuxPath || '/',
                    initWorkdir: linuxPath || '/',
                    workdir: args.workdir !== void 0 ? linuxPath : undefined,
                    env: dshEnv,
                    timeoutMs,
                };
                try {
                    // Per-workspace persistent shell: key by the workspace's Linux path,
                    // seed it once to that path, and only override cwd when the model
                    // explicitly passed a workdir — so `cd` inside a prior command persists.
                    const r = await runViaDaemon(daemonHost, daemonPort, daemonReq);
                    return {
                        kind: 'foreground',
                        exitCode: r.exitCode,
                        signal: r.signal,
                        timedOut: r.timedOut,
                        aborted: false,
                        timeoutMs,
                        stdout: { text: r.stdout, truncated: false },
                        stderr: { text: r.stderr, truncated: false },
                    };
                }
                catch (e) {
                    // Daemon unreachable. Try to self-launch it (first time, throttled) and
                    // retry once; if still unreachable, note and fall through to the bridge.
                    const now = Date.now();
                    if (daemonAutoStart && now - lastDaemonStart >= DAEMON_AUTO_START_THROTTLE_MS) {
                        lastDaemonStart = now;
                        if (!daemonLaunching) {
                            daemonLaunching = (async () => {
                                try {
                                    await launchDaemonViaWsl(ctx, distro, exec.signal);
                                }
                                catch { }
                                await sleep(DAEMON_START_WAIT_MS);
                            })();
                            daemonLaunching.catch(() => { }).finally(() => { daemonLaunching = null; });
                        }
                        const inFlight = daemonLaunching;
                        await inFlight;
                        try {
                            const r2 = await runViaDaemon(daemonHost, daemonPort, daemonReq);
                            daemonFallbackNote = undefined;
                            return {
                                kind: 'foreground',
                                exitCode: r2.exitCode,
                                signal: r2.signal,
                                timedOut: r2.timedOut,
                                aborted: false,
                                timeoutMs,
                                stdout: { text: r2.stdout, truncated: false },
                                stderr: { text: r2.stderr, truncated: false },
                            };
                        }
                        catch (e2) {
                            daemonFallbackNote = `[wsl daemon unreachable after auto-start at ${daemonHost}:${daemonPort} — fell back to one-shot bridge; state will NOT persist this call] (${e2.message})`;
                        }
                    }
                    else {
                        daemonFallbackNote = `[wsl daemon unreachable at ${daemonHost}:${daemonPort} — fell back to one-shot bridge; state will NOT persist this call] (${e.message})`;
                    }
                }
            }
            const spawnSpec = {
                argv,
                cwd: process.cwd(),
                stdio: {
                    stdin: 'ignore',
                    stdout: collect(maxOutputBytes),
                    stderr: collect(maxOutputBytes),
                },
                graceMs: DEFAULT_GRACE_MS,
                env: args.env,
            };
            if (args.run_in_background === true) {
                if (!backgroundEnabled)
                    throw new Error('run_in_background is disabled for this deployment');
                const jobs = ctx.get('jobs');
                if (jobs === void 0)
                    throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs');
                if (exec.signal.aborted) {
                    const error = new HarnessError('tool call aborted', TOOL_ABORTED);
                    error.name = 'AbortError';
                    throw error;
                }
                return {
                    kind: 'background',
                    jobId: jobs.start({
                        kind: 'wsl',
                        label: args.command,
                        ...(exec.agent ? { owner: exec.agent } : {}),
                        run: () => {
                            const proc = ctx.subprocess.spawn({ ...spawnSpec, signal: exec.signal });
                            const readAll = () => {
                                const out = proc.collected.stdout ? finalOutput(proc.collected.stdout) : { text: '', truncated: false };
                                const err = proc.collected.stderr ? finalOutput(proc.collected.stderr) : { text: '', truncated: false };
                                let delta = out.text;
                                if (err.text.length > 0)
                                    delta += `${delta.length > 0 && !delta.endsWith('\n') ? '\n' : ''}[stderr]\n${err.text}`;
                                return { delta, lossy: out.truncated || err.truncated };
                            };
                            return {
                                cancel: () => void proc.terminate(),
                                done: proc.done.then((outcome) => ({
                                    status: outcome.signal !== null ? 'killed' : 'completed',
                                    detail: outcome.signal !== null ? `signal: ${outcome.signal}` : `exit code: ${outcome.exitCode ?? 0}`,
                                })),
                                readOutput: readAll,
                            };
                        },
                    }),
                };
            }
            const d = deadline(exec.signal, timeoutMs, TIMEOUT_CODE);
            try {
                const handle = ctx.subprocess.spawn({ ...spawnSpec, signal: d.signal });
                const outcome = await handle.done;
                const timedOut = timeoutOf(d.signal, TIMEOUT_CODE) !== void 0;
                const aborted = d.signal.aborted && !timedOut;
                const stdout = handle.collected.stdout ? finalOutput(handle.collected.stdout) : { text: '', truncated: false };
                const stderr = handle.collected.stderr ? finalOutput(handle.collected.stderr) : { text: '', truncated: false };
                if (daemonFallbackNote) {
                    stdout.text = `${daemonFallbackNote}\n${stdout.text}`;
                }
                if (d.signal.aborted)
                    await handle.waitForExit(d.signal).catch(() => { });
                if (aborted) {
                    const error = new HarnessError('tool call aborted', TOOL_ABORTED);
                    error.name = 'AbortError';
                    throw error;
                }
                return {
                    kind: 'foreground',
                    exitCode: outcome.exitCode,
                    signal: outcome.signal,
                    timedOut,
                    aborted,
                    timeoutMs,
                    stdout,
                    stderr,
                };
            }
            finally {
                d[Symbol.dispose]();
            }
        },
        presentCall: (args) => ({ card: 'terminal', title: args.command, description: args.description }),
        presentResult: presentResult,
    }));
}
