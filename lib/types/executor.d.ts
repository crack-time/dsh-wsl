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
interface ExecutorInstance {
    readonly config: Record<string, unknown>;
    run(spec: ShellSpec): Promise<unknown>;
    start(spec: ShellSpec): unknown;
    runArgv(spec: ShellSpec, argv: string[]): Promise<unknown>;
    startArgv(spec: ShellSpec, argv: string[]): unknown;
}
type ExecutorCtor = new (ctx: unknown, config: Record<string, unknown>) => ExecutorInstance;
declare const pwshSandboxMod: {
    SandboxPwshExecutor: ExecutorCtor;
};
/** True when a workdir points into a WSL distro's filesystem via its UNC share. */
declare function isWslWorkdir(workdir: string): boolean;
/** Translate a WSL UNC workdir into its in-distro Linux absolute path. */
declare function toWslPath(unc: string): string;
/** Re-export env inside the Linux shell, then append the caller's command. */
declare function wslCommand(spec: ShellSpec, modelFriendlyEnv: Record<string, string>): string;
declare class WslAwarePwshExecutor extends pwshSandboxMod.SandboxPwshExecutor {
    private get wslDistro();
    /** A valid host Windows cwd to spawn wsl.exe from (the UNC itself is unusable as a spawn cwd). */
    private safeHostCwd;
    private wslArgv;
    run(spec: ShellSpec): Promise<unknown>;
    start(spec: ShellSpec): unknown;
}
export default WslAwarePwshExecutor;
export { WslAwarePwshExecutor, isWslWorkdir, toWslPath, wslCommand };
export type { ShellSpec };
