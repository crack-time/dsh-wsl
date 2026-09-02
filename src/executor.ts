/**
 * @crack/dsh-wsl/executor — per-workspace shell routing.
 *
 * Extends the native Windows sandboxed PowerShell executor
 * (`SandboxPwshExecutor`) so `ctx.shell` routes every command by working
 * directory:
 *
 *   - Windows workspace (workdir is a normal Windows path) → untouched native
 *     behavior: `super.run/start` keeps the sandboxed pwsh path exactly as
 *     `dsh-pwsh-sandbox` ships it.
 *   - WSL workspace (workdir is `\\wsl.localhost\<distro>\...` or `\\wsl$\...`)
 *     → the command executes inside the WSL distro via
 *     `wsl.exe [-d <distro>] --cd <linux-path> --exec bash -c <cmd>`, with the
 *     model-friendly/env re-exported in the Linux shell (the Windows file
 *     sandbox cannot sensibly confine Linux-side work, so this path uses the
 *     raw subprocess machinery and skips the Windows file-sandbox wrap).
 *
 * Mount this as the single `ctx.shell` provider in place of `dsh-pwsh-sandbox`
 * (disable that row). The model-facing tools are unchanged; only execution is
 * routed by the session's working directory.
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// ---------------------------------------------------------------------------
// Base-class resolution against the RUNNING dsh install (same ESM instances,
// so class identity and `inject` wiring match the host).
// ---------------------------------------------------------------------------
function resolveDshPackage(name: string): string {
    const attempts: string[] = []
    const anchors = [process.argv[1], path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')]
        .filter((anchor): anchor is string => typeof anchor === 'string' && anchor.length > 0)
    for (const anchor of anchors) {
        try {
            return createRequire(anchor).resolve(name)
        } catch (error) {
            attempts.push(`${anchor}: ${error instanceof Error ? error.message : String(error)}`)
        }
    }
    throw new Error(
        `@crack/dsh-wsl/executor: cannot locate ${name} from the running dsh install. Tried:\n${attempts.join('\n')}`,
    )
}

// ---------- Minimal structural types for the (type-less) base classes ----------
interface ShellSpec {
    command: string
    workdir?: string
    timeoutMs: number
    stdoutMaxBytes: number
    signal?: AbortSignal
    stdin?: { data: string }
    env?: Record<string, string | undefined>
    dshEnv?: Record<string, string | undefined>
    sandboxPolicy?: unknown
}

interface ExecutorInstance {
    readonly config: Record<string, unknown>
    run(spec: ShellSpec): Promise<unknown>
    start(spec: ShellSpec): unknown
    runArgv(spec: ShellSpec, argv: string[]): Promise<unknown>
    startArgv(spec: ShellSpec, argv: string[]): unknown
}

type ExecutorCtor = new (ctx: unknown, config: Record<string, unknown>) => ExecutorInstance

// ---------- Load the real base classes from the running dsh install ----------
const pwshSandboxMod = (await import(pathToFileURL(resolveDshPackage('@deepseek-ai/dsh-pwsh-sandbox')).href)) as {
    SandboxPwshExecutor: ExecutorCtor
}
const pwshLocalMod = (await import(pathToFileURL(resolveDshPackage('@deepseek-ai/dsh-pwsh-local')).href)) as {
    ENV_OVERRIDES: Record<string, string>
}

// ---------- WSL-side helpers ----------
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const WSL_UNC_RE = /^\\\\wsl(?:\$|\.localhost)\\([^\\]+)\\(.*)$/i

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`
}

/** True when a workdir points into a WSL distro's filesystem via its UNC share. */
function isWslWorkdir(workdir: string): boolean {
    if (!workdir) return false
    return WSL_UNC_RE.test(workdir.replaceAll('/', '\\'))
}

/** Translate a WSL UNC workdir into its in-distro Linux absolute path. */
function toWslPath(unc: string): string {
    const win = unc.replaceAll('/', '\\')
    const m = WSL_UNC_RE.exec(win)
    if (!m) return '/'
    const inside = m[2] ?? ''
    return `/${inside.replaceAll('\\', '/')}`
}

/** Re-export env inside the Linux shell, then append the caller's command. */
function wslCommand(spec: ShellSpec, modelFriendlyEnv: Record<string, string>): string {
    const lines: string[] = []
    const merged: Record<string, string | undefined> = { ...modelFriendlyEnv, ...spec.env, ...spec.dshEnv }
    for (const [key, value] of Object.entries(merged)) {
        if (!ENV_KEY_RE.test(key)) continue
        if (value === undefined) lines.push(`unset ${key}`)
        else lines.push(`export ${key}=${shellQuote(value)}`)
    }
    lines.push(spec.command)
    return lines.join('\n')
}

// ---------- The executor ----------
class WslAwarePwshExecutor extends pwshSandboxMod.SandboxPwshExecutor {
    private get wslDistro(): string | undefined {
        return process.env.DSH_WSL_DISTRO?.trim() || String(this.config.distro ?? '').trim() || undefined
    }

    /** A valid host Windows cwd to spawn wsl.exe from (the UNC itself is unusable as a spawn cwd). */
    private safeHostCwd(): string {
        const configured = typeof this.config.cwd === 'string' ? this.config.cwd : ''
        if (configured && !isWslWorkdir(configured)) return configured
        return process.cwd()
    }

    private wslArgv(spec: ShellSpec): string[] {
        const argv = ['wsl.exe']
        const distro = this.wslDistro
        if (distro) argv.push('-d', distro)
        argv.push('--cd', toWslPath(String(spec.workdir ?? '')))
        // --exec hands the tail to execve argument-by-argument (a bare `--`
        // would re-parse through the distro shell and shred the export prefix).
        argv.push('--exec', 'bash', '-c', wslCommand(spec, pwshLocalMod.ENV_OVERRIDES))
        return argv
    }

    override run(spec: ShellSpec): Promise<unknown> {
        if (isWslWorkdir(String(spec.workdir ?? ''))) {
            // Raw subprocess machinery (not the Windows file-sandbox wrap),
            // spawned from a valid host cwd; --cd puts the Linux process inside
            // the WSL workspace.
            return this.runArgv({ ...spec, workdir: this.safeHostCwd() }, this.wslArgv(spec))
        }
        return (super.run as (s: ShellSpec) => Promise<unknown>)(spec)
    }

    override start(spec: ShellSpec): unknown {
        if (isWslWorkdir(String(spec.workdir ?? ''))) {
            return this.startArgv({ ...spec, workdir: this.safeHostCwd() }, this.wslArgv(spec))
        }
        return (super.start as (s: ShellSpec) => unknown)(spec)
    }
}

export default WslAwarePwshExecutor
export { WslAwarePwshExecutor, isWslWorkdir, toWslPath, wslCommand }
export type { ShellSpec }