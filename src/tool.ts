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
import { connect } from 'node:net'
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { parseExitStatus } from '@deepseek-ai/dsh-shell'
import { clampTimeout, deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { Context } from '@deepseek-ai/cordis'
import {
  buildScript,
  distroOf,
  editFileCmd,
  globFindCmd,
  grepCmd,
  readWindowCmd,
  toBase64,
  toWslPath,
  wslArgv,
  writeFileCmd,
  resolveWorkdir,
  shellQuote,
  workspaceWriteGuard,
  assertWslPathInside,
  DEFAULT_DISTRO,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
} from './wsl-util.ts'

export const name = 'tool-wsl'
export const inject = ['tools', 'systemPrompt', 'subprocess', 'shellEnv', 'jobs']

// ---------------------------------------------------------------------------
// WSL / env helpers (pure helpers live in wsl-util.ts, imported above)
// ---------------------------------------------------------------------------
const TIMEOUT_CODE = 'TOOL_WSL_TIMEOUT'
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024
const DEFAULT_GRACE_MS = 3000

// ---------------------------------------------------------------------------
// Resident-execution daemon client (daemon/exec-server.js)
// ---------------------------------------------------------------------------
interface DaemonFrame {
  id?: number
  channel?: 'stdout' | 'stderr'
  text?: string
  done?: boolean
  exitCode?: number | null
  signal?: string | null
  error?: string
}

interface DaemonResult {
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  timedOut: boolean
  error?: string
}

/**
 * Run a single foreground command against the resident WSL exec-server
 * (daemon/exec-server.js) over a localhost TCP socket. Opens a fresh
 * connection per call; the daemon's own persistent bash holds `cd`/`export`
 * across calls. The daemon enforces the timeout and replies done with the
 * exit code; the local timer is only a safety net for total unavailability.
 */
function runViaDaemon(host: string, port: number, req: {
  cmd: string
  session?: string
  initWorkdir?: string
  workdir?: string
  env?: Record<string, string>
  timeoutMs: number
  token?: string
}): Promise<DaemonResult> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port })
    let buf = ''
    let stdout = ''
    let stderr = ''
    let done = false
    const settle = (fn: () => void) => { if (!done) { done = true; fn() } }
    const fail = (msg: string) => settle(() => { socket.destroy(); reject(new Error(msg)) })
    const idle = setTimeout(() => fail(`daemon unresponsive after ${req.timeoutMs}ms`), req.timeoutMs + 8000)
    socket.on('error', (e: Error) => settle(() => { fail(`daemon connect failed: ${e.message}`) }))
    socket.on('connect', () => {
      socket.write(JSON.stringify({
        id: 1,
        cmd: req.cmd,
        session: req.session,
        initWorkdir: req.initWorkdir,
        workdir: req.workdir,
        env: req.env,
        timeoutMs: req.timeoutMs,
        ...(req.token ? { token: req.token } : {}),
      }) + '\n')
    })
    socket.on('data', (chunk: Buffer | string) => {
      buf += chunk.toString('utf8')
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        let f: DaemonFrame
        try { f = JSON.parse(line) } catch { continue }
        if (f.id !== 1) continue
        if (f.channel === 'stdout') stdout += f.text ?? ''
        else if (f.channel === 'stderr') stderr += f.text ?? ''
        else if (f.done) {
          clearTimeout(idle)
          if (f.error === 'unauthorized') {
            socket.end()
            settle(() => reject(new Error('wsl daemon refused the request (token mismatch)')))
          } else {
            settle(() => {
              socket.end()
              resolve({
                exitCode: f.exitCode ?? null,
                signal: f.signal ?? null,
                stdout,
                stderr,
                timedOut: f.error === 'timed out' || /timed out/.test(f.error ?? ''),
                error: f.error,
              })
            })
          }
        }
      }
    })
  })
}

// ---------------------------------------------------------------------------
// Daemon auto-start (self-contained; no dependency on daemon/launch.sh)
// ---------------------------------------------------------------------------
// State is module-level so concurrent sessions in the host process share one
// in-flight launch and a throttle window (we don't hammer wsl.exe per call).
let daemonLaunching: Promise<void> | null = null
let lastDaemonStart = 0
const DAEMON_AUTO_START_THROTTLE_MS = 15000
const DAEMON_START_WAIT_MS = 3500

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// The three runtime files the resident exec-server needs inside WSL (~/.dshwsl).
const DAEMON_PAYLOAD = ['daemon/exec-server.js', 'daemon/launch.sh', 'daemon/dshwsl-env.bash'] as const

/** Map a Windows path to its WSL /mnt/<drive>/... mount (WSL2 default automount). */
function toWslMount(winPath: string): string {
  return winPath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d: string) => `/mnt/${d.toLowerCase()}`)
}

/** Run a short `wsl.exe -d <distro> -- bash -lc <cmd>` and await exit. */
async function wslSh(ctx: { subprocess: { spawn(spec: unknown): any } }, distro: string, cmd: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const handle = ctx.subprocess.spawn({
      argv: ['wsl.exe', '-d', distro, '--', 'bash', '-lc', cmd],
      cwd: process.cwd(),
      stdio: { stdin: 'ignore' as const, stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
      graceMs: 2000,
      ...(signal ? { signal } : {}),
    })
    await handle.done
    return true
  } catch {
    return false
  }
}

/**
 * Auto-deploy the daemon payload (~/.dshwsl/{exec-server.js,launch.sh,
 * dshwsl-env.bash}) from the installed package's `daemon/` dir, so a fresh WSL
 * needs NO manual copy step. Writes each file to a Windows temp then `cp`s it
 * across through wsl.exe (avoids sending the file body through process argv).
 * Idempotent: bash receives the bytes but the script runs unconditionally and
 * simply overwrites the target; call it before (re)launching.
 */
async function deployDaemonPayload(ctx: { subprocess: { spawn(spec: unknown): any } }, distro: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await wslSh(ctx, distro, 'mkdir -p "$HOME/.dshwsl"', signal)
    for (const rel of DAEMON_PAYLOAD) {
      const src = fileURLToPath(new URL(`../${rel}`, import.meta.url))
      if (!existsSync(src)) continue // daemon/ not shipped in this install — skip
      const tmp = join(tmpdir(), `dshwsl-${rel.replace(/[\\/]/g, '-')}`)
      try { writeFileSync(tmp, readFileSync(src, 'utf8')) } catch { continue }
      const ok = await wslSh(ctx, distro, `cp '${toWslMount(tmp)}' "$HOME/.dshwsl/${rel.split('/')[1]}"`, signal)
      try { rmSync(tmp, { force: true }) } catch { /* best-effort */ }
      if (!ok) return false
    }
    return true
  } catch {
    return false
  }
}

// ── daemon background ops (op: bg / bg-status / bg-read / bg-cancel) ───────
/** One-shot daemon op: connect, send one request, return the matching reply. */
function daemonOp(host: string, port: number, token: string | undefined, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port })
    const reqId = Math.floor(Math.random() * 1e9)
    let buf = ''
    const fail = (msg: string) => { socket.destroy(); reject(new Error(msg)) }
    const idle = setTimeout(() => fail('daemon op timed out'), 15000)
    socket.on('error', () => fail('daemon op connect failed'))
    socket.on('connect', () => {
      socket.write(JSON.stringify({ ...payload, id: reqId, ...(token ? { token } : {}) }) + '\n')
    })
    socket.on('data', (chunk: Buffer | string) => {
      buf += chunk.toString('utf8')
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        let f: Record<string, unknown>
        try { f = JSON.parse(line) } catch { continue }
        if (f.id !== reqId) continue
        clearTimeout(idle)
        socket.end()
        resolve(f)
      }
    })
  })
}

/**
 * Start a detached daemon background job. Returns the daemon's jobId, which the
 * caller folds into a `ctx.jobs` handle whose `done`/`readOutput`/`cancel` poll
 * the daemon over fresh connections (bg-status / bg-read / bg-cancel).
 */
async function startDaemonBackground(host: string, port: number, token: string | undefined, req: {
  cmd: string
  session: string
  initWorkdir: string
  workdir?: string
  env?: Record<string, string>
}): Promise<string> {
  const r = await daemonOp(host, port, token, {
    op: 'bg',
    cmd: req.cmd,
    session: req.session,
    initWorkdir: req.initWorkdir,
    workdir: req.workdir,
    env: req.env,
  })
  if (typeof r.jobId !== 'string' || !r.jobId) throw new Error(`wsl daemon bg start failed: ${String(r.error ?? '')}`)
  return r.jobId
}

function makeDaemonBackgroundHandle(host: string, port: number, token: string | undefined, jobId: string) {
  const waitDone = (): Promise<{ status: string; detail: string }> => new Promise((resolve) => {
    const poll = async () => {
      const st = await daemonOp(host, port, token, { op: 'bg-status', jobId }).catch(() => ({ done: true, exitCode: null }))
      if (st.done) {
        resolve({
          status: 'completed',
          detail: `exit code: ${st.exitCode == null ? 0 : String(st.exitCode)}`,
        })
      } else {
        setTimeout(poll, 600)
      }
    }
    void poll()
  })
  let readOffset = 0
  return {
    cancel: () => void daemonOp(host, port, token, { op: 'bg-cancel', jobId }).catch(() => {}),
    done: waitDone(),
    readOutput: async () => {
      const r = await daemonOp(host, port, token, { op: 'bg-read', jobId }).catch(() => ({ text: '' }))
      const text = String(r.text ?? '')
      const delta = text.slice(readOffset)
      readOffset = text.length
      return { delta, lossy: false }
    },
  }
}

// ── backend strategy: two execution backends + a daemon-first coordinator ───
// A "foreground value" is the tool's model-facing foreground result object.
type FgValue = {
  kind: 'foreground'
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  aborted: boolean
  timeoutMs: number
  stdout: { text: string; truncated: boolean }
  stderr: { text: string; truncated: boolean }
}
/** Daemon backend outcome: a real result, or a note signalling bridge fallback. */
type DaemonOutcome = { value: FgValue } | { note: string }

interface DaemonForegroundDeps {
  ctx: {
    shellEnv: { collect(exec: unknown): Record<string, string> }
    subprocess: { spawn(spec: unknown): any }
  }
  exec: { signal: AbortSignal }
  distro: string
  linuxPath: string
  args: { command: string; workdir?: string; env?: Record<string, string | undefined> }
  dshEnv: Record<string, string>
  timeoutMs: number
  daemonHost: string
  daemonPort: number
  daemonToken?: string
  daemonAutoStart: boolean
}

/** The daemon execution backend: persistent shell via the resident exec-server. */
async function runDaemonForegroundBackend(d: DaemonForegroundDeps): Promise<DaemonOutcome> {
  const { ctx, exec, distro, linuxPath, args, dshEnv, timeoutMs, daemonHost, daemonPort, daemonToken, daemonAutoStart } = d
  if (args.env) {
    for (const [k, v] of Object.entries(args.env)) if (typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) dshEnv[k] = v
  }
  const daemonReq = {
    cmd: args.command,
    session: linuxPath || '/',
    initWorkdir: linuxPath || '/',
    workdir: args.workdir !== void 0 ? linuxPath : undefined,
    env: dshEnv,
    timeoutMs,
    token: daemonToken,
  }
  const toValue = (r: DaemonResult): FgValue => ({
    kind: 'foreground' as const,
    exitCode: r.exitCode,
    signal: r.signal,
    timedOut: r.timedOut,
    aborted: false,
    timeoutMs,
    stdout: { text: r.stdout, truncated: false },
    stderr: { text: r.stderr, truncated: false },
  })
  try {
    // Per-workspace persistent shell: key by the workspace's Linux path, seed it
    // once to that path, only override cwd when the model explicitly passed a
    // workdir — so `cd` inside a prior command persists.
    return { value: toValue(await runViaDaemon(daemonHost, daemonPort, daemonReq)) }
  } catch (e) {
    const now = Date.now()
    if (daemonAutoStart && now - lastDaemonStart >= DAEMON_AUTO_START_THROTTLE_MS) {
      lastDaemonStart = now
      if (!daemonLaunching) {
        daemonLaunching = (async () => {
          try { await deployDaemonPayload(ctx, distro, exec.signal) } catch {}
          try { await launchDaemonViaWsl(ctx, distro, exec.signal, daemonToken) } catch {}
          await sleep(DAEMON_START_WAIT_MS)
        })()
        daemonLaunching.catch(() => {}).finally(() => { daemonLaunching = null })
      }
      await daemonLaunching
      try {
        return { value: toValue(await runViaDaemon(daemonHost, daemonPort, daemonReq)) }
      } catch (e2) {
        return { note: `[wsl daemon unreachable after auto-start at ${daemonHost}:${daemonPort} — fell back to one-shot bridge; state will NOT persist this call] (${(e2 as Error).message})` }
      }
    }
    return { note: `[wsl daemon unreachable at ${daemonHost}:${daemonPort} — fell back to one-shot bridge; state will NOT persist this call] (${(e as Error).message})` }
  }
}

// exec-server detached (setsid nohup + </dev/null + disown) with an optional
// shared secret. The trailing `sleep 2` keeps the parent bash alive long
// enough for setsid to fully detach so the process survives the wsl.exe client
// exiting — without it the daemon is reaped on exit. `$VAR` stays literal for
// bash (JS only expands `${`). Mirrors daemon/launch.sh so the tool is
// self-sufficient without it.
function daemonLaunchBash(token?: string): string {
  const tokenAssign = token ? `DSHWSL_TOKEN=${shellQuote(token)} ` : ''
  return [
    'cd "$HOME/.dshwsl" 2>/dev/null || { echo "dsh-wsl: ~/.dshwsl missing" >&2; exit 2; }',
    'if command -v node >/dev/null 2>&1; then NODE="$(command -v node)"; elif [ -x /home/linuxbrew/.linuxbrew/bin/node ]; then NODE="/home/linuxbrew/.linuxbrew/bin/node"; elif [ -x "$HOME/.zcode/server/node" ]; then NODE="$HOME/.zcode/server/node"; else echo "dsh-wsl: no node in WSL" >&2; exit 3; fi',
    '[ -f exec-server.js ] || { echo "dsh-wsl: daemon payload missing (run daemon/launch.sh once)" >&2; exit 4; }',
    `${tokenAssign}setsid nohup "$NODE" exec-server.js > exec.log 2>&1 < /dev/null & disown 2>/dev/null || true`,
    'sleep 2',
  ].join('; ')
}

async function launchDaemonViaWsl(ctx: { subprocess: { spawn(spec: unknown): any } }, distro: string, signal?: AbortSignal, token?: string): Promise<boolean> {
  try {
    const handle = ctx.subprocess.spawn({
      argv: ['wsl.exe', '-d', distro, '--', 'bash', '-lc', daemonLaunchBash(token)],
      cwd: process.cwd(),
      stdio: {
        stdin: 'ignore' as const,
        stdout: { maxBytes: 4096 },
        stderr: { maxBytes: 4096 },
      },
      graceMs: 2000,
      ...(signal ? { signal } : {}),
    })
    await handle.done
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Stream + result projection (mirror @deepseek-ai/dsh-tool-bash)
// ---------------------------------------------------------------------------
function finalOutput(reader: { readFrom(from: number): { text: string; lossy: boolean; spillPath?: string } }): {
  text: string
  truncated: boolean
  spillPath?: string
} {
  const read = reader.readFrom(0)
  return {
    text: read.text,
    truncated: read.lossy,
    ...(read.spillPath !== void 0 ? { spillPath: read.spillPath } : {}),
  }
}

function streamText(output: { text: string; truncated: boolean; spillPath?: string }): string {
  if (!output.truncated) return output.text
  return `${output.text}\n[output truncated; full output: ${output.spillPath ?? '(unavailable)'}]`
}

function renderResult(result: {
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  timeoutMs: number
  stdout: { text: string; truncated: boolean; spillPath?: string }
  stderr: { text: string; truncated: boolean; spillPath?: string }
}): string {
  const out = streamText(result.stdout)
  const err = streamText(result.stderr)
  let body = out
  if (err.length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${err}`
  }
  if (body.length === 0) body = '(no output)'
  const markers: string[] = []
  if (result.timedOut) markers.push(`[timed out after ${result.timeoutMs}ms]`)
  if (result.signal !== null) markers.push(`[killed by signal: ${result.signal}]`)
  else if (result.exitCode !== 0) markers.push(`[exit code: ${result.exitCode}]`)
  if (markers.length === 0) return body
  if (!body.endsWith('\n')) body += '\n'
  return body + markers.join('\n')
}

function validateArgs(args: { command: string; description: string; timeoutMs?: number }): void {
  if (args.command.trim().length === 0) throw new Error('invalid command: expected a non-empty string')
  if (args.description.trim().length === 0) throw new Error('invalid description: expected a non-empty string')
  if (args.timeoutMs !== void 0 && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`)
  }
}

function presentResult(args: { run_in_background?: boolean }, result: { content: { type: string; text: string }[]; isError?: boolean }): unknown {
  const block = result.content.length === 1 ? result.content[0] : void 0
  if (block === void 0 || block.type !== 'text') return void 0
  const raw = block.text
  if (result.isError === true || args.run_in_background === true) {
    return { card: 'generic', content: [{ type: 'text', text: `\`\`\`console\n${raw.replace(/\n+$/, '')}\n\`\`\`` }] }
  }
  const { body, ...exit } = parseExitStatus(raw)
  return { card: 'terminal', output: body, ...exit }
}

/** Build a `bash` prefix that re-exports model-facing env inside the distro. */
// Bridge-mode env bootstrap. `wsl.exe --exec bash -lc` is non-interactive, so
// it never reads ~/.bashrc and brew/conda/cuda/lammps are off PATH — uv/conda
// report "not found" for one-shot commands. Source the SAME dshwsl-env.bash the
// daemon's persistent bash loads via BASH_ENV, so bridge and daemon expose the
// identical environment (uv/conda/brew/node reachable in both). Best-effort:
// skipped when the file is absent (fresh clone / not yet deployed).
const BRIDGE_ENV_BOOT = '[ -r "$HOME/.dshwsl/dshwsl-env.bash" ] && . "$HOME/.dshwsl/dshwsl-env.bash" || true'

// Sandbox-mode read (mirrors tool-fs: `ctx.get("sandboxPolicy").resolve({ session })`).
// Returns 'danger-full-access' when the policy service is unavailable or unreadable,
// so the tool never blocks on a missing dependency. On WSL, read-only is effectively
// workspace-write, so confinement kicks in whenever the mode is NOT danger-full-access.
type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
function resolveSandboxMode(ctx: { get(n: string): unknown }, exec: { agent?: { session: unknown } }): SandboxMode {
  try {
    const policy = ctx.get('sandboxPolicy') as { resolve?(request?: { session?: unknown }): { mode?: string } | void } | undefined
    const req = exec.agent ? { session: exec.agent.session } : void 0
    const mode = policy?.resolve?.(req)?.mode
    if (mode === 'read-only' || mode === 'workspace-write' || mode === 'danger-full-access') return mode
    return 'danger-full-access'
  } catch {
    return 'danger-full-access'
  }
}
/** When the device surface is writable within the workspace (everything but danger). */
function confining(mode: SandboxMode): boolean {
  return mode !== 'danger-full-access'
}

// ---------------------------------------------------------------------------
// The tool plugin
// ---------------------------------------------------------------------------
export function apply(_ctx: Context, config: {
  distro?: string
  enableRunInBackground?: boolean
  /** 'bridge' (default) spawns wsl.exe per call; 'daemon' sends commands to a resident WSL exec-server. */
  runtime?: 'bridge' | 'daemon'
  /** Connection target when runtime === 'daemon'. host/port default to the localhost-forwarded WSL2 target. */
  daemon?: { host?: string; port?: number; autoStart?: boolean; token?: string }
} = {}): void {
  const ctx = _ctx as unknown as {
    systemPrompt: { section(o: unknown): void; getSectionOrder(n: string): number }
    tools: { register(t: unknown): void }
    subprocess: { spawn(spec: unknown): any }
    shellEnv: { collect(exec: unknown): Record<string, string> }
    get(n: string): unknown
  }
  const configuredDistro = typeof config.distro === 'string' && config.distro ? config.distro : DEFAULT_DISTRO
  const backgroundEnabled = config.enableRunInBackground ?? true
  // daemon is the preferred execution mode (resident, state persists); an
  // explicit runtime: 'bridge' opts out. When no runtime is set, daemon wins
  // and falls back to the bridge if the daemon is unreachable.
  const daemonEnabled = config.runtime !== 'bridge'
  const daemonHost = config.daemon?.host ?? '127.0.0.1'
  const daemonPort = config.daemon?.port ?? 37778
  // Optional shared secret; when set, sent to the exec-server and injected into
  // the auto-launched daemon's env (daemon refuses requests without a match).
  const daemonToken = config.daemon?.token
  // On first unreachable call, self-launch the daemon via wsl.exe (then retry
  // once) instead of only falling back to the bridge. Default on.
  const daemonAutoStart = config.daemon?.autoStart ?? true
  const maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES

  const collect = (maxBytes: number) => ({ maxBytes, spill: { maxBytes } })

  ctx.systemPrompt.section({
    name: 'tool:wsl',
    // External contributions may use any finite order. getSectionOrder('TOOL_WSL')
    // is not in the reserved PromptSectionOrderName set and would resolve to NaN
    // (throwing "order must be a finite number"), so pass a literal 1000 to sit
    // beside the tool-bash/pwsh guidance (equal orders break by name).
    order: 1000,
    // The native file tools (read/write/edit/glob/grep) run on the Windows host,
    // so on a WSL-UNC workspace they can't work against the share (write/edit
    // fail on atomic rename ENOTSUP; grep fails with ripgrep os error 3). The
    // standard-wsl preset DISABLES them entirely, so every file operation must
    // go through `wsl` (bash).
    text: 'Check the [exit code: N] marker on every wsl result; investigate failures before moving on. ' +
      'This session runs on a WSL workspace: the native file tools (read, write, edit, glob, grep) are DISABLED here. ' +
      'Use the WSL-native tools instead — `wsl_read` (read), `wsl_grep` (search), `wsl_glob` (list), `wsl_write` (write), ' +
      '`wsl_edit` (edit) — or run arbitrary shell commands with `wsl`. ' +
      'This session sandbox constrains WSL writes to the workspace root: `wsl_write`/`wsl_edit` refuse targets outside it, and ' +
      'the `wsl` shell mutating commands (rm/mv/mkdir/touch/truncate/ln/cp dest) are shadowed to reject writes outside it. ' +
      'When danger-full-access applies, no restriction is injected.',
  })

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
      render: (_args: unknown, value: { kind: string; jobId?: string } & Record<string, unknown>): { type: string; text: string }[] => {
        const text = value.kind === 'background'
          ? `started background job ${value.jobId ?? ''}`
          : renderResult(value as unknown as Parameters<typeof renderResult>[0])
        return [{ type: 'text', text }]
      },
    },
    async execute(args: {
      command: string
      description: string
      timeoutMs?: number
      workdir?: string
      run_in_background?: boolean
      env?: Record<string, string | undefined>
    }, exec: {
      agent?: { session: { header: { cwd?: string } } }
      signal: AbortSignal
    }): Promise<unknown> {
      validateArgs(args)
      const sessionCwd = exec.agent?.session.header.cwd
      const workdir = resolveWorkdir(args.workdir, sessionCwd)
      const distro = distroOf(workdir, configuredDistro)
      const linuxPath = toWslPath(workdir ?? '')
      const dshEnv = ctx.shellEnv.collect(exec) as Record<string, string>
      // Sandbox read: on WSL read-only ≈ workspace-write, so confine whenever mode is
      // not danger-full-access. workspaceRoot here = the session workspace (its Linux path).
      const mode = resolveSandboxMode(ctx, exec)
      const workspaceRoot = toWslPath(sessionCwd ?? '')
      const guard = confining(mode) ? workspaceWriteGuard(workspaceRoot) : ''
      const command = guard ? `${guard}\n${args.command}` : args.command
      const script = [BRIDGE_ENV_BOOT, buildScript(dshEnv)].filter(Boolean).join('\n')
      const argv = wslArgv(distro, linuxPath, script, command)

      const timeoutMs = clampTimeout(args.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, 'request.timeoutMs')

      // Resident-execution path (preferred): the daemon backend first, with automatic
      // bridge fallback (daemon-first coordinator). Daemon preferred, bridge kept.
      let daemonFallbackNote: string | undefined
      if (daemonEnabled && args.run_in_background !== true) {
        const outcome = await runDaemonForegroundBackend({
          ctx, exec, distro, linuxPath, args: { ...args, command }, dshEnv, timeoutMs,
          daemonHost, daemonPort, daemonToken, daemonAutoStart,
        })
        if ('value' in outcome) return outcome.value
        daemonFallbackNote = outcome.note
      }

      const spawnSpec = {
        argv,
        cwd: process.cwd(),
        stdio: {
          stdin: 'ignore' as const,
          stdout: collect(maxOutputBytes),
          stderr: collect(maxOutputBytes),
        },
        graceMs: DEFAULT_GRACE_MS,
        env: args.env,
      }

      if (args.run_in_background === true) {
        if (!backgroundEnabled) throw new Error('run_in_background is disabled for this deployment')
        const jobs = ctx.get('jobs') as { start(opts: {
          kind: string
          label: string
          owner?: unknown
          run(): Record<string, unknown>
        }): string } | void
        if (jobs === void 0) throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
        if (exec.signal.aborted) {
          const error = new HarnessError('tool call aborted', TOOL_ABORTED)
          error.name = 'AbortError'
          throw error
        }
        // Daemon mode: run the background job against the resident exec-server
        // (detached bash) so persistence semantics apply here too; else bridge.
        if (daemonEnabled) {
          const dJobId = await startDaemonBackground(daemonHost, daemonPort, daemonToken, {
            cmd: command,
            session: linuxPath || '/',
            initWorkdir: linuxPath || '/',
            workdir: args.workdir !== void 0 ? linuxPath : undefined,
            env: dshEnv,
          })
          return {
            kind: 'background',
            jobId: jobs.start({
              kind: 'wsl',
              label: args.command,
              ...(exec.agent ? { owner: exec.agent } : {}),
              run: () => makeDaemonBackgroundHandle(daemonHost, daemonPort, daemonToken, dJobId),
            }),
          }
        }
        return {
          kind: 'background',
          jobId: jobs.start({
            kind: 'wsl',
            label: args.command,
            ...(exec.agent ? { owner: exec.agent } : {}),
            run: () => {
              const proc = ctx.subprocess.spawn({ ...spawnSpec, signal: exec.signal })
              const readAll = () => {
                const out = proc.collected.stdout ? finalOutput(proc.collected.stdout) : { text: '', truncated: false }
                const err = proc.collected.stderr ? finalOutput(proc.collected.stderr) : { text: '', truncated: false }
                let delta = out.text
                if (err.text.length > 0) delta += `${delta.length > 0 && !delta.endsWith('\n') ? '\n' : ''}[stderr]\n${err.text}`
                return { delta, lossy: out.truncated || err.truncated }
              }
              return {
                cancel: () => void proc.terminate(),
                done: proc.done.then((outcome: { exitCode: number | null; signal: string | null }) => ({
                  status: outcome.signal !== null ? 'killed' : 'completed',
                  detail: outcome.signal !== null ? `signal: ${outcome.signal}` : `exit code: ${outcome.exitCode ?? 0}`,
                })),
                readOutput: readAll,
              }
            },
          }),
        }
      }

      const d = deadline(exec.signal, timeoutMs, TIMEOUT_CODE)
      try {
        const handle = ctx.subprocess.spawn({ ...spawnSpec, signal: d.signal })
        const outcome = await handle.done
        const timedOut = timeoutOf(d.signal, TIMEOUT_CODE) !== void 0
        const aborted = d.signal.aborted && !timedOut
        const stdout = handle.collected.stdout ? finalOutput(handle.collected.stdout) : { text: '', truncated: false }
        const stderr = handle.collected.stderr ? finalOutput(handle.collected.stderr) : { text: '', truncated: false }
        if (daemonFallbackNote) {
          stdout.text = `${daemonFallbackNote}\n${stdout.text}`
        }
        if (d.signal.aborted) await handle.waitForExit(d.signal).catch(() => {})
        if (aborted) {
          const error = new HarnessError('tool call aborted', TOOL_ABORTED)
          error.name = 'AbortError'
          throw error
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
        }
      } finally {
        d[Symbol.dispose]()
      }
    },
    presentCall: (args: { command: string; description: string }) => ({ card: 'terminal', title: args.command, description: args.description }),
    presentResult: presentResult as never,
  } as never))

  // ── Structured file sub-tools ────────────────────────────────────────────
  // Execute one computed bash command through the same daemon-first backend,
  // returning the rendered foreground text (or the bridge fallback note).
  async function execWslText(exec: { signal: AbortSignal; agent?: { session: { header: { cwd?: string } } } }, command: string, workdirArg?: string, envArg?: Record<string, string | undefined>, mutation?: { file: string; op: string }): Promise<string> {
    const sessionCwd = (exec as { agent?: { session: { header: { cwd?: string } } } }).agent?.session?.header?.cwd
    const workdir = resolveWorkdir(workdirArg, sessionCwd)
    const distro = distroOf(workdir, configuredDistro)
    const linuxPath = toWslPath(workdir ?? '')
    // Sandbox: on WSL read-only ≈ workspace-write, so any mode other than
    // danger-full-access confines writes to the session workspace root.
    const mode = resolveSandboxMode(ctx, exec)
    const workspaceRoot = toWslPath(sessionCwd ?? '')
    if (confining(mode) && mutation) {
      assertWslPathInside(workspaceRoot, mutation.file, mutation.op)
    }
    const guard = confining(mode) ? workspaceWriteGuard(workspaceRoot) : ''
    const guardedCommand = guard ? `${guard}\n${command}` : command
    let dshEnv = ctx.shellEnv.collect(exec) as Record<string, string>
    if (envArg) {
      for (const [k, v] of Object.entries(envArg)) if (typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) dshEnv[k] = v
    }
    let fallbackNote: string | undefined
    if (daemonEnabled) {
      const outcome = await runDaemonForegroundBackend({
        ctx: ctx as never,
        exec,
        distro,
        linuxPath,
        args: { command: guardedCommand, workdir },
        dshEnv,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        daemonHost,
        daemonPort,
        daemonToken,
        daemonAutoStart,
      })
      if ('value' in outcome) return renderResult(outcome.value)
      fallbackNote = outcome.note
    }
    // Bridge (or daemon-unreachable fallback): one-shot wsl.exe spawn.
    const script = [BRIDGE_ENV_BOOT, buildScript(dshEnv)].filter(Boolean).join('\n')
    const argv = wslArgv(distro, linuxPath, script, guardedCommand)
    const spawnSpec = {
      argv,
      cwd: process.cwd(),
      stdio: {
        stdin: 'ignore' as const,
        stdout: collect(DEFAULT_MAX_OUTPUT_BYTES),
        stderr: collect(DEFAULT_MAX_OUTPUT_BYTES),
      },
      graceMs: DEFAULT_GRACE_MS,
      env: envArg,
      signal: exec.signal,
    }
    const d = deadline(exec.signal, DEFAULT_TIMEOUT_MS, TIMEOUT_CODE)
    try {
      const handle = ctx.subprocess.spawn(spawnSpec)
      const outcome = await handle.done
      const timedOut = timeoutOf(d.signal, TIMEOUT_CODE) !== void 0
      const stdout = handle.collected.stdout ? finalOutput(handle.collected.stdout) : { text: '', truncated: false }
      const stderr = handle.collected.stderr ? finalOutput(handle.collected.stderr) : { text: '', truncated: false }
      if (fallbackNote) stdout.text = `${fallbackNote}\n${stdout.text}`
      return renderResult({ exitCode: outcome.exitCode, signal: outcome.signal, timedOut, timeoutMs: DEFAULT_TIMEOUT_MS, stdout, stderr })
    } finally {
      d[Symbol.dispose]()
    }
  }

  ctx.tools.register(defineTool({
    name: 'wsl_read',
    description: 'Read a text file inside the WSL distro and return line-numbered content. ' +
      'Like the native read tool but runs in WSL (native read is disabled on this preset). ' +
      'Path is a Linux path or a WSL UNC workspace path; it is translated into the distro automatically.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to read inside the WSL distro.' },
      offset: { type: 'number', description: '1-based first line to return. Defaults to 1.' },
      limit: { type: 'number', description: 'Max number of lines to return. Defaults to the whole file.' },
    },
    async execute(args: { file_path: string; offset?: number; limit?: number }, exec: { signal: AbortSignal }): Promise<unknown> {
      const text = await execWslText(exec, readWindowCmd(args.file_path, args.offset, args.limit))
      return { text }
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } } },
      render: (_a: unknown, v: { text: string }) => [{ type: 'text', text: v.text }],
    },
  } as never))

  ctx.tools.register(defineTool({
    name: 'wsl_grep',
    description: 'Search files inside the WSL distro with a regular expression and return matching lines. ' +
      'Like the native grep tool but runs in WSL (native grep is disabled on this preset). ' +
      'Uses ripgrep if installed, else grep -rnE. Path defaults to the current workspace.',
    parameters: {
      pattern: { type: 'string', required: true, description: 'Regular expression to search for (ripgrep/grep -E syntax).' },
      path: { type: 'string', description: 'File or directory to search inside the WSL distro. Defaults to the session workspace.' },
      include: { type: 'string', description: 'Glob filter for which files to search (e.g. "*.ts", "*.{js,jsx}").' },
    },
    async execute(args: { pattern: string; path?: string; include?: string }, exec: { signal: AbortSignal }): Promise<unknown> {
      const text = await execWslText(exec, grepCmd(args.pattern, args.path, args.include))
      return { text }
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } } },
      render: (_a: unknown, v: { text: string }) => [{ type: 'text', text: v.text }],
    },
  } as never))

  ctx.tools.register(defineTool({
    name: 'wsl_glob',
    description: 'Find files inside the WSL distro whose paths match a glob pattern. ' +
      'Like the native glob tool but runs in WSL (native glob is disabled on this preset). ' +
      'Bash globstar: a pattern with no "/" matches basenames at any depth; include a separator to anchor.',
    parameters: {
      pattern: { type: 'string', required: true, description: 'Glob pattern to match, e.g. "**/*.ts", "*.out".' },
      path: { type: 'string', description: 'Directory to search inside the WSL distro. Defaults to the session workspace.' },
    },
    async execute(args: { pattern: string; path?: string }, exec: { signal: AbortSignal }): Promise<unknown> {
      const text = await execWslText(exec, globFindCmd(args.path ?? '', args.pattern))
      return { text }
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } } },
      render: (_a: unknown, v: { text: string }) => [{ type: 'text', text: v.text }],
    },
  } as never))

  ctx.tools.register(defineTool({
    name: 'wsl_write',
    description: 'Create or fully replace a text file inside the WSL distro. ' +
      'Like the native write tool but runs in WSL (native write is disabled on this preset). ' +
      'Content is base64-encoded across the bridge so multi-line text survives intact.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to write inside the WSL distro.' },
      content: { type: 'string', required: true, description: 'Full UTF-8 text content to write.' },
    },
    async execute(args: { file_path: string; content: string }, exec: { signal: AbortSignal }): Promise<unknown> {
      const text = await execWslText(exec, writeFileCmd(args.file_path, toBase64(args.content ?? '')), undefined, undefined, { file: args.file_path, op: 'write' })
      return { text }
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } } },
      render: (_a: unknown, v: { text: string }) => [{ type: 'text', text: v.text }],
    },
  } as never))

  ctx.tools.register(defineTool({
    name: 'wsl_edit',
    description: 'Edit an existing text file inside the WSL distro by replacing literal text. ' +
      'Like the native edit tool but runs in WSL (native edit is disabled on this preset). ' +
      'old_string/new_string are base64-encoded across the bridge. By default old_string must appear exactly once.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to edit inside the WSL distro.' },
      old_string: { type: 'string', required: true, description: 'Literal text to replace. Must match exactly.' },
      new_string: { type: 'string', required: true, description: 'Literal replacement text. Use an empty string to delete the match.' },
      replace_all: { type: 'boolean', description: 'Replace all matches. Defaults to false; when false, old_string must appear exactly once.' },
    },
    async execute(args: { file_path: string; old_string: string; new_string: string; replace_all?: boolean }, exec: { signal: AbortSignal }): Promise<unknown> {
      const text = await execWslText(exec, editFileCmd(args.file_path, toBase64(args.old_string ?? ''), toBase64(args.new_string ?? ''), !!args.replace_all), undefined, undefined, { file: args.file_path, op: 'edit' })
      return { text }
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } } },
      render: (_a: unknown, v: { text: string }) => [{ type: 'text', text: v.text }],
    },
  } as never))
}