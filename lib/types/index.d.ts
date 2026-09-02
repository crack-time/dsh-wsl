import type { Context } from '@deepseek-ai/cordis';
/** Resolved execution settings handed to run/start by the caller. */
interface ShellSpec {
    command: string;
    workdir?: string;
    timeoutMs: number;
    stdoutMaxBytes: number;
    signal?: AbortSignal;
    stdin?: {
        data: string;
    };
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
    readOutput(): {
        delta: string;
        lossy: boolean;
    };
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
    resolve(request: Partial<ShellSpec> & {
        command: string;
    }): ShellSpec;
    run(spec: ShellSpec): Promise<ShellRunResult>;
    start(spec: ShellSpec): ShellProcess;
    runArgv(spec: ShellSpec, argv: string[]): Promise<ShellRunResult>;
    startArgv(spec: ShellSpec, argv: string[]): ShellProcess;
}
interface LocalBashExecutorCtor {
    prototype: LocalBashExecutorLike;
    new (ctx: unknown, config: WslExecutorConfig): LocalBashExecutorLike;
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
declare function toWslPath(workdir: string): string;
/**
 * Build the string handed to `bash -c` inside WSL: an `export`/`unset`
 * prefix that re-creates the model-friendly and DSH_* environment (wsl.exe
 * does not forward the parent environment), then the caller's command.
 * Caller entries win over the model-friendly defaults, DSH_* entries win
 * over both — the same precedence the base class applies on the Windows side.
 */
declare function wslCommand(spec: ShellSpec, modelFriendlyEnv: Record<string, string>): string;
declare const bashLocal: {
    LocalBashExecutor: LocalBashExecutorCtor;
    ENV_OVERRIDES: Record<string, string>;
};
/**
 * WSL bash executor. Registers as `ctx.shell`; pair with the re-enabled
 * `tool-bash` row so the model writes bash and every command lands in the
 * distro. The base class keeps deadlines, bounded output, spill files, and
 * the background-process lifecycle; only the argv changes.
 */
declare class WslBashExecutor extends bashLocal.LocalBashExecutor {
    readonly config: WslExecutorConfig;
    constructor(ctx: Context, config: WslExecutorConfig);
    /** Distro selection: env override, then composition config; absent → wsl.exe default. */
    private get wslDistro();
    private get loginShell();
    /** The rewritten argv: same spec semantics, remote execution boundary. */
    private wslArgv;
    run(spec: ShellSpec): Promise<ShellRunResult>;
    start(spec: ShellSpec): ShellProcess;
}
export { WslBashExecutor, WslBashExecutor as default, toWslPath, wslCommand };
