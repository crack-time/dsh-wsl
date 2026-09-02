/**
 * @crack/dsh-wsl — host-only executor plugin.
 *
 * Replaces the Windows shell executor (pwsh-sandbox) with a WSL-forwarding
 * bash executor: the model's `bash` tool runs inside a WSL distro — the
 * remote-connection experience — while the DSH host keeps running natively
 * on Windows (file tools, web UI, persistence untouched; the Windows-side
 * session workspace is reached from Linux through /mnt/<drive>/...).
 *
 * How: subclass LocalBashExecutor at its documented execution boundary (its
 * runArgv/startArgv exist so subclasses can "replace the public command's
 * shell argv") and rewrite the argv to
 *
 *   wsl.exe [-d <distro>] --cd <posix workdir> -- bash [-l] -c <command>
 *
 * Windows workdirs are translated (E:\x → /mnt/e/x, \\wsl.localhost\D\h\y →
 * /y); spec env and DSH_* variables are re-exported inside the Linux shell
 * because wsl.exe does not forward the parent environment.
 *
 * Composition (rows the installer adds to the profile cordis.patch.yml):
 *
 *   - id: pwsh-sandbox
 *     disabled: true
 *   - id: tool-pwsh
 *     disabled: true
 *   - id: tool-bash
 *     disabled: false
 *   - insert:
 *       - id: wsl
 *         name: '@crack/dsh-wsl'
 *         config:
 *           distro: Ubuntu-22.04
 *
 * The base class import resolves against the RUNNING dsh install (same file
 * URL → the exact ESM module instance the host already loaded), so there is
 * no version drift and no runtime dependency to install.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Context } from '@deepseek-ai/cordis';

//#region base-class resolution

/**
 * Resolve `name` inside the dsh install that is loading this plugin.
 *
 * The plugin itself is loaded from a link: directory outside any node_modules
 * that carries @deepseek-ai packages, so bare-specifier resolution fails.
 * Anchor on the host's own entry script (the global npm launcher layout) and
 * fall back to the standard Windows global install location — the resolved
 * file URL equals the one the host already imported, so the ESM cache returns
 * the same class identity.
 */
function resolveDshPackage(name: string): string {
    const attempts: string[] = [];
    const anchors = [process.argv[1], path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')]
        .filter((anchor): anchor is string => typeof anchor === 'string' && anchor.length > 0);
    for (const anchor of anchors) {
        try {
            return createRequire(anchor).resolve(name);
        } catch (error) {
            attempts.push(`${anchor}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    throw new Error(
        `@crack/dsh-wsl: cannot locate ${name} from the running dsh install. `
        + `Tried:\n${attempts.join('\n')}`,
    );
}

//#endregion
//#region local structural types for the (type-less) base class

/** Resolved execution settings handed to run/start by the caller. */
interface ShellSpec {
    command: string;
    workdir?: string;
    timeoutMs: number;
    stdoutMaxBytes: number;
    signal?: AbortSignal;
    stdin?: { data: string };
    env?: Record<string, string | undefined>;
    dshEnv?: Record<string, string | undefined>;
    sandboxPolicy?: unknown;
}

/** One collected output stream. */
interface StreamOutput {
    text: string;
    truncated: boolean;
    spillPath?: string;
}

/** Foreground run outcome (subset the executor contract guarantees). */
interface ShellRunResult {
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    aborted: boolean;
    timeoutMs: number;
    stdout: StreamOutput;
    stderr: StreamOutput;
}

/** Background process handle (subset). */
interface ShellProcess {
    status: 'running' | 'completed' | 'killed';
    done: Promise<unknown>;
    readOutput(): { delta: string; lossy: boolean };
    kill(): boolean;
}

/** Executor configuration: the base class's numeric/cwd plumbing plus ours. */
interface WslExecutorConfig {
    cwd?: string;
    timeoutMs?: number;
    maxTimeoutMs?: number;
    maxOutputBytes?: number;
    maxSpillBytes?: number;
    graceMs?: number;
    distro?: string;
    login?: boolean;
}

/** The members of LocalBashExecutor this plugin touches. */
interface LocalBashExecutorLike {
    readonly config: WslExecutorConfig;
    ctx: unknown;
    resolve(request: Partial<ShellSpec> & { command: string }): ShellSpec;
    run(spec: ShellSpec): Promise<ShellRunResult>;
    start(spec: ShellSpec): ShellProcess;
    runArgv(spec: ShellSpec, argv: string[]): Promise<ShellRunResult>;
    startArgv(spec: ShellSpec, argv: string[]): ShellProcess;
}

interface LocalBashExecutorCtor {
    prototype: LocalBashExecutorLike;
    new (ctx: unknown, config: WslExecutorConfig): LocalBashExecutorLike;
}

//#endregion
//#region WSL-side helpers

/** Keys eligible for the in-shell `export` prefix; anything else is skipped. */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Single-quote a value for POSIX shell consumption. */
function shellQuote(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Translate a Windows-side directory into the path the Linux side should use.
 *
 * - drive paths → /mnt/<drive>/... (E:\work → /mnt/e/work, E:/x → /mnt/e/x)
 * - WSL UNC paths (\\wsl.localhost\<distro>\... and \\wsl$\<distro>\...)
 *   → the in-distro absolute path; a UNC pointing at a different distro than
 *   the configured one surfaces as a plain "no such directory" from bash
 * - already-POSIX paths and relative paths pass through unchanged
 */
function toWslPath(workdir: string): string {
    if (workdir.startsWith('/')) return workdir;
    const windows = workdir.replaceAll('/', '\\');
    const unc = /^\\\\wsl(?:\$|\.localhost)\\([^\\]+)\\(.*)$/i.exec(windows);
    if (unc) {
        const inside = unc[2] ?? '';
        return `/${inside.replaceAll('\\', '/')}`;
    }
    const drive = /^([A-Za-z]):\\(.*)$/.exec(windows);
    if (drive) {
        const rest = drive[2] ?? '';
        return `/mnt/${(drive[1] as string).toLowerCase()}/${rest.replaceAll('\\', '/')}`;
    }
    const bareDrive = /^([A-Za-z]):$/.exec(windows);
    if (bareDrive) return `/mnt/${(bareDrive[1] as string).toLowerCase()}`;
    return workdir;
}

/**
 * Build the string handed to `bash -c` inside WSL: an `export`/`unset`
 * prefix that re-creates the model-friendly and DSH_* environment (wsl.exe
 * does not forward the parent environment), then the caller's command.
 * Caller entries win over the model-friendly defaults, DSH_* entries win
 * over both — the same precedence the base class applies on the Windows side.
 */
function wslCommand(spec: ShellSpec, modelFriendlyEnv: Record<string, string>): string {
    const lines: string[] = [];
    const merged: Record<string, string | undefined> = { ...modelFriendlyEnv, ...spec.env, ...spec.dshEnv };
    for (const [key, value] of Object.entries(merged)) {
        if (!ENV_KEY_RE.test(key)) continue;
        if (value === undefined) {
            lines.push(`unset ${key}`);
        } else {
            lines.push(`export ${key}=${shellQuote(value)}`);
        }
    }
    lines.push(spec.command);
    return lines.join('\n');
}

//#endregion
//#region the executor

// Same-module-instance import of the base class (see resolveDshPackage).
const bashLocal = (await import(pathToFileURL(resolveDshPackage('@deepseek-ai/dsh-bash-local')).href)) as {
    LocalBashExecutor: LocalBashExecutorCtor;
    ENV_OVERRIDES: Record<string, string>;
};

/**
 * WSL bash executor. Registers as `ctx.shell`; pair with the re-enabled
 * `tool-bash` row so the model writes bash and every command lands in the
 * distro. The base class keeps deadlines, bounded output, spill files, and
 * the background-process lifecycle; only the argv changes.
 */
class WslBashExecutor extends bashLocal.LocalBashExecutor {
    declare readonly config: WslExecutorConfig;

    constructor(ctx: Context, config: WslExecutorConfig) {
        super(ctx, config);
        try {
            // Best-effort model awareness: tell the agent its shell is Linux.
            const anyCtx = ctx as unknown as {
                logger?(label: string): { info(message: string): void };
                inject?(deps: string[], cb: (scoped: unknown) => void): void;
            };
            anyCtx.logger?.('dsh-wsl')?.info(`bash tool executes inside WSL${this.wslDistro ? ` (${this.wslDistro})` : ' (default distro)'}`);
            anyCtx.inject?.(['systemPrompt'], (scoped: unknown) => {
                try {
                    const sp = scoped as {
                        systemPrompt: {
                            getSectionOrder(name: string): number;
                            section(section: { name: string; order: number; text: string }): unknown;
                        };
                    };
                    sp.systemPrompt.section({
                        name: 'wsl-remote',
                        order: sp.systemPrompt.getSectionOrder('TOOL_BASH'),
                        text: 'Bash commands execute inside WSL (Linux): Windows workspace paths appear under /mnt/<drive>/ '
                            + '(e.g. E:\\work → /mnt/e/work). Use POSIX paths and Linux tooling in commands; '
                            + 'when you need the Windows view of the workspace, the file tools still take Windows paths.',
                    });
                } catch {
                    // The prompt section is best-effort; execution does not depend on it.
                }
            });
        } catch {
            // Environment description is best-effort; never block activation.
        }
    }

    /** Distro selection: env override, then composition config; absent → wsl.exe default. */
    private get wslDistro(): string | undefined {
        const fromEnv = process.env.DSH_WSL_DISTRO?.trim();
        return fromEnv || this.config.distro?.trim() || undefined;
    }

    private get loginShell(): boolean {
        return this.config.login === true;
    }

    /** The rewritten argv: same spec semantics, remote execution boundary. */
    private wslArgv(spec: ShellSpec): string[] {
        const argv = ['wsl.exe'];
        const distro = this.wslDistro;
        if (distro) argv.push('-d', distro);
        argv.push('--cd', toWslPath(spec.workdir ?? this.config.cwd ?? process.cwd()));
        // --exec, not `--`: the plain `--` form joins the tail into one line
        // and re-parses it through the distro's default shell, which shreds a
        // multi-line `bash -c` script (the export prefix especially). --exec
        // hands the tail to execve argument-by-argument, untouched.
        argv.push('--exec', 'bash');
        if (this.loginShell) argv.push('-l');
        argv.push('-c', wslCommand(spec, bashLocal.ENV_OVERRIDES));
        return argv;
    }

    override async run(spec: ShellSpec): Promise<ShellRunResult> {
        return this.runArgv(spec, this.wslArgv(spec));
    }

    override start(spec: ShellSpec): ShellProcess {
        return this.startArgv(spec, this.wslArgv(spec));
    }
}

//#endregion

export { WslBashExecutor, WslBashExecutor as default, toWslPath, wslCommand };
