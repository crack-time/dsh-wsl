/**
 * Pure WSL path / argv / script helpers, moved out of tool.ts so they can be
 * unit-tested without loading the cordis plugin (tool.ts's `apply` needs a
 * full host context). No imports beyond `node:path`; nothing here touches a
 * socket, subprocess, or the daemon.
 */
import { isAbsolute, resolve, dirname, posix } from 'node:path';
export const DEFAULT_DISTRO = 'Ubuntu-22.04';
export const WSL_UNC_RE = /^\\\\wsl(?:\$|\.localhost)\\([^\\]+)\\(.*)$/i;
export const DEFAULT_TIMEOUT_MS = 120000;
export const MAX_TIMEOUT_MS = 600000;
/**
 * A saved window (1-based lines) for a structured `wsl_read`. Pure — returns
 * the bash `-lc` payload; no I/O here. Missing file → non-zero exit with a
 * clear message. Emits `[wsl_read] lines: <total>` so the model can page.
 */
export function readWindowCmd(path, offset, limit) {
    const file = shellQuote(path || '/dev/null');
    const start = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 1;
    const hasLimit = Number.isFinite(limit) && limit > 0;
    const end = hasLimit ? start + Math.floor(limit) - 1 : Number.MAX_SAFE_INTEGER;
    const awkProg = `NR>=${start}&&NR<=${end}{printf "%d:%s\\n",NR,$0}`;
    return [
        `if [ ! -f ${file} ]; then echo "cannot read ${file}: not found" >&2; exit 1; fi`,
        `awk '${awkProg}' ${file}`,
        `WC=$(wc -l < ${file}); echo "[wsl_read] lines: $WC${hasLimit ? ', window ' + start + '-' + end : ''}"`,
    ].join('; ');
}
/**
 * A structured `wsl_grep`. Pure — returns the bash `-lc` payload. Prefers
 * `rg` when installed, else `grep -rnE`. `include` maps to ripgrep `--glob`
 * (or a find-style `-name` for grep). Pattern and paths are shell-quoted.
 */
export function grepCmd(pattern, path, include) {
    const expr = shellQuote(pattern);
    const cwd = path || '.';
    const dict = shellQuote(cwd || '/dev/null');
    const inc = include && include.trim();
    // rg flags: -n line numbers, --no-heading flat list (no "file:" banner per file).
    const rg = `rg -n --no-heading${inc ? ` --glob ${shellQuote(inc)}` : ''} ${expr} ${dict}`;
    // grep fallback: -R recursive, -n numbers, -E ext regex; include via --include if present.
    const grep = `grep -RnE${inc ? ` --include=${shellQuote(inc)}` : ''} ${expr} ${dict}`;
    return `command -v rg >/dev/null 2>&1 && ${rg} || ${grep}`;
}
/** Single-quote a value for safe interpolation into a bash `-c` style block. */
export function shellQuote(value) {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}
/** True when a workdir points into a WSL distro via its UNC share. */
export function isWslUnc(workdir) {
    return WSL_UNC_RE.test(workdir.replaceAll('/', '\\'));
}
/** Translate a workdir into the in-distro path (UNC share or bare Linux path). */
export function toWslPath(workdir) {
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
export function distroOf(workdir, configuredDistro) {
    const win = String(workdir ?? '').replaceAll('/', '\\');
    const m = WSL_UNC_RE.exec(win);
    if (m && m[1])
        return m[1];
    return (configuredDistro && configuredDistro.trim()) || DEFAULT_DISTRO;
}
/** Build the bridge `wsl.exe` argv: `-d <distro> --cd <linux> --exec bash -lc script`. */
export function wslArgv(distro, linuxPath, script, command) {
    return ['wsl.exe', '-d', distro, '--cd', linuxPath, '--exec', 'bash', '-lc', `${script}\n${command}`];
}
/** Export the model-facing env into the bash script (valid identifier keys only). */
export function buildScript(modelFriendlyEnv) {
    const lines = [];
    for (const [key, value] of Object.entries(modelFriendlyEnv)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
            continue;
        lines.push(`export ${key}=${shellQuote(value)}`);
    }
    return lines.join('\n');
}
/**
 * Resolve a model `workdir` arg against the session cwd, mirroring the tool's
 * semantics: an absolute path is used as-is, a relative one is joined onto the
 * session cwd; absent → the session cwd.
 */
export function resolveWorkdir(modelWorkdir, sessionCwd) {
    if (modelWorkdir === void 0)
        return sessionCwd;
    if (isAbsolute(modelWorkdir))
        return modelWorkdir;
    return resolve(sessionCwd ?? '', modelWorkdir);
}
// ---------------------------------------------------------------------------
// Structured file sub-tools: glob / write / edit command builders. These return
// bash `-lc` payloads; pure and unit-testable, exactly like readWindowCmd.
//
// Multi-line text crossing the Windows→WSL argv boundary is a known mangling
// trap, so `write`/`edit` move content as **base64** (A-Za-z0-9+/= — no quotes,
// no spaces, no $) decoded inside Linux. Only the content bytes travel encoded.
// ---------------------------------------------------------------------------
/** Base64-encode text (stable cross-platform; Buffer is a Node global). */
export function toBase64(text) {
    return Buffer.from(text, 'utf8').toString('base64');
}
/** A `wsl_glob`: expand a glob under a dir and print matching regular files. */
export function globFindCmd(path, pattern) {
    const dir = shellQuote(path || '.');
    // bash globstar + nullglob: `**` recurses. The pattern is quoted so a path
    // with spaces still expands (quotes inside the pattern are preserved by the
    // quoted expansion). Only regular files are printed.
    const body = `shopt -s globstar nullglob; for f in ${pattern}; do [ -f "$f" ] && echo "$f"; done`;
    return `cd ${dir} 2>/dev/null || exit 1; ${body}`;
}
/** A `wsl_write`: create/overwrite a file whose content is base64-encoded. */
export function writeFileCmd(path, contentB64) {
    const file = shellQuote(path || '/');
    const dir = shellQuote(dirname(path || '/') || '/');
    return `mkdir -p ${dir} 2>/dev/null || exit 1; printf '%s' ${shellQuote(contentB64)} | base64 -d > ${file}`;
}
/**
 * A `wsl_edit`: replace old/new in a file. old/new travel base64-encoded to
 * dodge quoting; decoded by python3. `replaceAll` toggles a global replace,
 * else exactly one occurrence must match (else it errors).
 */
export function editFileCmd(path, oldB64, newB64, replaceAll) {
    const file = shellQuote(path || '/');
    // python reads the file, decodes the two base64 blobs, does a str.replace,
    // asserts the expected occurrence count, writes back, prints the count.
    // Interpolate the JS boolean as a PYTHON boolean literal (False/True), not the
    // JS false/true — python would otherwise raise NameError: name 'false'.
    const pyBool = replaceAll ? 'True' : 'False';
    const py = [
        "import base64,sys",
        `old=base64.b64decode(${shellQuote(oldB64)}).decode('utf8')`,
        `new=base64.b64decode(${shellQuote(newB64)}).decode('utf8')`,
        `p=sys.argv[1]`,
        `s=open(p,encoding='utf8').read()`,
        `cnt=s.count(old)`,
        `if cnt==0: print('no occurrences of old_string',file=sys.stderr); sys.exit(1)`,
        `if not ${pyBool} and cnt!=1: print('expected 1 occurrence, found '+str(cnt),file=sys.stderr); sys.exit(1)`,
        `s=s.replace(old,new)`,
        `open(p,'w',encoding='utf8').write(s)`,
        `print('replaced '+str(cnt)+' occurrence(s)')`,
    ].join('\n');
    return `python3 -c ${shellQuote(py)} ${file}`;
}
// ---------------------------------------------------------------------------
// Workspace-write confinement (Linux-side enforcement of the sandbox mode).
//
// Two layers, both pure and unit-testable:
//
//   1. `wslPathInside(root, target)` — the *precise* host-side check used by the
//      structured file tools (`wsl_write`, `wsl_edit`). A discrete file_path is
//      canonicalized and compared against the workspace root; cheap and exact.
//   2. `workspaceWriteGuard(root)` — a bash prefix for the free-form `wsl` shell:
//      the mutating commands (rm/mv/mkdir/touch/truncate/ln/cp-dest) are shadowed
//      by functions that refuse any target that resolves outside the root.
//
// Which modes enforce: DANGER is "no interception" (current behavior); on WSL,
// read-only is effectively workspace-write, so BOTH read-only and workspace-write
// get this guard. Only danger-full-access passes through untouched.
//
// Honest boundary (surface it to the model, do not over-claim): a bash *prefix*
// cannot intercept `>`/`>>` redirections, `sed -i`, `python open(...,'w')`, or
// `dd of=` — those write operators are shell-syntax / embedded and escape the
// shadowed-function net. The exact enforcement therefore lives in the structured
// tools (wsl_write/wsl_edit use wslPathInside); the shell guard is best-effort.
// ---------------------------------------------------------------------------
/** Resolve a canonical (normalized, workspace-anchored) Linux path for `target`. */
export function canonicalWslPath(root, target) {
    const r = posix.normalize(root || '/') || '/';
    let t = toWslPath(target);
    if (!posix.isAbsolute(t))
        t = posix.resolve(r, t);
    return posix.normalize(t);
}
/** True when a canonicalized target lives inside <root> (equal to root, or a descendant). */
export function wslPathInside(root, target) {
    const r = posix.normalize(root || '/') || '/';
    const t = canonicalWslPath(r, target);
    if (t === r)
        return true;
    const prefix = r === '/' ? '/' : `${r}/`;
    return t.startsWith(prefix);
}
/** Raise (Mark required: true — no-op) a sandbox marker when target escapes root. */
export function assertWslPathInside(root, target, op) {
    if (!wslPathInside(root, target)) {
        throw new Error(`[dsh-wsl sandbox] ${op} outside the workspace root: ${target} (confined to ${root})`);
    }
}
/**
 * Build the bash prefix that confines the free-form `wsl` shell to the workspace
 * root. Mutating commands are shadowed by functions that refute (exit 1 + stderr
 * marker) any target resolving outside the root. Returns '' for an empty/rootless
 * root (nothing to confine to — caller should not inject at all). Best-effort:
 * `>`/`sed -i`/python writes are NOT intercepted (see header comment).
 */
export function workspaceWriteGuard(root) {
    const ws = posix.normalize(root || '') || '';
    if (!ws || ws === '/' || ws === '.')
        return '';
    const q = shellQuote(ws);
    return [
        `DSS_WS=${q}`,
        // resolve a possibly-relative target to a canonical absolute path
        'dss_resolve(){ local p="$1"; case "$p" in /*) ;; *) p="$(pwd 2>/dev/null || printf .)/$p";; esac; realpath -m -- "$p" 2>/dev/null || printf "%s" "$p"; }',
        // refute a target escaping the workspace root (prints a stderr marker, exit 1)
        'dss_in_ws(){ local r; r=$(dss_resolve "$1"); case "$r" in "$DSS_WS"|"$DSS_WS"/*) return 0;; esac; printf "[dsh-wsl sandbox] write outside workspace root: %s\\n" "$r" >&2; return 1; }',
        // every multi-arg mutator: reject immediately on the first escaping arg
        'dss_all(){ for a in "$@"; do case "$a" in -*) continue;; esac; dss_in_ws "$a" || return 1; done; }',
        // single-target mutators
        'rm(){ dss_all "$@" || return 1; command rm "$@"; }',
        'rmdir(){ dss_all "$@" || return 1; command rmdir "$@"; }',
        'unlink(){ dss_all "$@" || return 1; command unlink "$@"; }',
        'mkdir(){ dss_all "$@" || return 1; command mkdir "$@"; }',
        'touch(){ dss_all "$@" || return 1; command touch "$@"; }',
        'truncate(){ dss_all "$@" || return 1; command truncate "$@"; }',
        'ln(){ dss_all "$@" || return 1; command ln "$@"; }',
        'mv(){ dss_all "$@" || return 1; command mv "$@"; }',
        // cp: only the destination must stay inside; source(s) may be anywhere (reads allowed).
        'cp(){ local last=; for a in "$@"; do case "$a" in -*) continue;; esac; last="$a"; done; if [ -n "$last" ]; then dss_in_ws "$last" || return 1; fi; command cp "$@"; }',
    ].join('\n');
}
