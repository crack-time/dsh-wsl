export declare const DEFAULT_DISTRO = "Ubuntu-22.04";
export declare const WSL_UNC_RE: RegExp;
export declare const DEFAULT_TIMEOUT_MS = 120000;
export declare const MAX_TIMEOUT_MS = 600000;
/**
 * A saved window (1-based lines) for a structured `wsl_read`. Pure — returns
 * the bash `-lc` payload; no I/O here. Missing file → non-zero exit with a
 * clear message. Emits `[wsl_read] lines: <total>` so the model can page.
 */
export declare function readWindowCmd(path: string, offset?: number, limit?: number): string;
/**
 * A structured `wsl_grep`. Pure — returns the bash `-lc` payload. Prefers
 * `rg` when installed, else `grep -rnE`. `include` maps to ripgrep `--glob`
 * (or a find-style `-name` for grep). Pattern and paths are shell-quoted.
 */
export declare function grepCmd(pattern: string, path?: string, include?: string): string;
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
/** Base64-encode text (stable cross-platform; Buffer is a Node global). */
export declare function toBase64(text: string): string;
/** A `wsl_glob`: expand a glob under a dir and print matching regular files. */
export declare function globFindCmd(path: string, pattern: string): string;
/** A `wsl_write`: create/overwrite a file whose content is base64-encoded. */
export declare function writeFileCmd(path: string, contentB64: string): string;
/**
 * A `wsl_edit`: replace old/new in a file. old/new travel base64-encoded to
 * dodge quoting; decoded by python3. `replaceAll` toggles a global replace,
 * else exactly one occurrence must match (else it errors).
 */
export declare function editFileCmd(path: string, oldB64: string, newB64: string, replaceAll: boolean): string;
