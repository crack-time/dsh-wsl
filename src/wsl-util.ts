/**
 * Pure WSL path / argv / script helpers, moved out of tool.ts so they can be
 * unit-tested without loading the cordis plugin (tool.ts's `apply` needs a
 * full host context). No imports beyond `node:path`; nothing here touches a
 * socket, subprocess, or the daemon.
 */
import { isAbsolute, resolve } from 'node:path'

export const DEFAULT_DISTRO = 'Ubuntu-22.04'
export const WSL_UNC_RE = /^\\\\wsl(?:\$|\.localhost)\\([^\\]+)\\(.*)$/i
export const DEFAULT_TIMEOUT_MS = 120_000
export const MAX_TIMEOUT_MS = 600_000

/** Single-quote a value for safe interpolation into a bash `-c` style block. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** True when a workdir points into a WSL distro via its UNC share. */
export function isWslUnc(workdir: string): boolean {
  return WSL_UNC_RE.test(workdir.replaceAll('/', '\\'))
}

/** Translate a workdir into the in-distro path (UNC share or bare Linux path). */
export function toWslPath(workdir: string): string {
  if (!workdir) return '/'
  const win = workdir.replaceAll('/', '\\')
  const m = WSL_UNC_RE.exec(win)
  if (!m) return workdir
  const inside = m[2] ?? ''
  return `/${inside.replaceAll('\\', '/')}`
}

/** The distro name from a WSL UNC workdir, else the configured default. */
export function distroOf(workdir: string | undefined, configuredDistro: string): string {
  const win = String(workdir ?? '').replaceAll('/', '\\')
  const m = WSL_UNC_RE.exec(win)
  if (m && m[1]) return m[1]
  return (configuredDistro && configuredDistro.trim()) || DEFAULT_DISTRO
}

/** Build the bridge `wsl.exe` argv: `-d <distro> --cd <linux> --exec bash -lc script`. */
export function wslArgv(distro: string, linuxPath: string, script: string, command: string): string[] {
  return ['wsl.exe', '-d', distro, '--cd', linuxPath, '--exec', 'bash', '-lc', `${script}\n${command}`]
}

/** Export the model-facing env into the bash script (valid identifier keys only). */
export function buildScript(modelFriendlyEnv: Record<string, string>): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(modelFriendlyEnv)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    lines.push(`export ${key}=${shellQuote(value)}`)
  }
  return lines.join('\n')
}

/**
 * Resolve a model `workdir` arg against the session cwd, mirroring the tool's
 * semantics: an absolute path is used as-is, a relative one is joined onto the
 * session cwd; absent → the session cwd.
 */
export function resolveWorkdir(modelWorkdir: string | undefined, sessionCwd: string | undefined): string | undefined {
  if (modelWorkdir === void 0) return sessionCwd
  if (isAbsolute(modelWorkdir)) return modelWorkdir
  return resolve(sessionCwd ?? '', modelWorkdir)
}