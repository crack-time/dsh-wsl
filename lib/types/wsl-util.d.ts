export declare const DEFAULT_DISTRO = "Ubuntu-22.04";
export declare const WSL_UNC_RE: RegExp;
export declare const DEFAULT_TIMEOUT_MS = 120000;
export declare const MAX_TIMEOUT_MS = 600000;
/** Single-quote a value for safe interpolation into a bash `-c` style block. */
export declare function shellQuote(value: string): string;
/** True when a workdir points into a WSL distro via its UNC share. */
export declare function isWslUnc(workdir: string): boolean;
/** Translate a workdir into the in-distro path (UNC share or bare Linux path). */
export declare function toWslPath(workdir: string): string;
/** The distro name from a WSL UNC workdir, else the configured default. */
export declare function distroOf(workdir: string | undefined, configuredDistro: string): string;
/** Build the bridge `wsl.exe` argv: `-d <distro> --cd <linux> --exec bash -lc script`. */
export declare function wslArgv(distro: string, linuxPath: string, script: string, command: string): string[];
/** Export the model-facing env into the bash script (valid identifier keys only). */
export declare function buildScript(modelFriendlyEnv: Record<string, string>): string;
/**
 * Resolve a model `workdir` arg against the session cwd, mirroring the tool's
 * semantics: an absolute path is used as-is, a relative one is joined onto the
 * session cwd; absent → the session cwd.
 */
export declare function resolveWorkdir(modelWorkdir: string | undefined, sessionCwd: string | undefined): string | undefined;
