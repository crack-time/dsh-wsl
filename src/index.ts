/**
 * @crack/dsh-wsl — host loader entry.
 *
 * Lets an operator register a workspace *inside a WSL distro* into DSH's
 * native workspace registry. The directory stays on the Linux filesystem;
 * from the Windows host it is owned through its UNC share
 * `\\wsl.localhost\<distro>\<linux-path>`, so it is a completely ordinary
 * workspace record: the sidebar already lists every registry entry, so the
 * WSL workspace appears beside Windows workspaces and is session-attached,
 * opened, and persisted exactly like any other.
 *
 * This host half exposes a small JSON API under
 *   /plugins/@crack/dsh-wsl/api
 * that the client browser uses to enumerate distros, walk the Linux
 * filesystem, create a folder, and finally register a directory. Only the
 * final registration touches the registry; listing/creation shells out to
 * `wsl.exe` (the host runs in the full Node process, unsandboxed, so the WSL
 * service is reachable).
 *
 * The client half (src/client) injects a "＋ WSL 工作区" button next to the
 * native Add-workspace button in the sidebar and opens this browser.
 */
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
// Type-only imports load the cordis Context declaration-merges:
// webServer (dsh-host-webserver), workspaceRegistry (dsh-workspace).
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'

const execFile = promisify(execFileCb)

const API_PREFIX = '/plugins/@crack/dsh-wsl/api'

const inject = ['webServer', 'workspaceRegistry']

// ---------------------------------------------------------------------------
// JSON response helpers
// ---------------------------------------------------------------------------
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += String(chunk)
      if (data.length > 1_000_000) {
        reject(Object.assign(new Error('request body too large'), { code: 413 }))
        req.destroy()
      }
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return readBody(req)
    .then((raw) => {
      if (!raw) return {}
      try {
        return JSON.parse(raw) as Record<string, unknown>
      } catch (error) {
        const e = error instanceof Error ? error : new Error(String(error))
        throw Object.assign(e, { code: 400 })
      }
    })
}

// ---------------------------------------------------------------------------
// wsl.exe plumbing (runs in the full Node host)
// ---------------------------------------------------------------------------
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** Run one command inside a distro's default shell; resolves with stdout. */
async function wslBash(distro: string, script: string): Promise<string> {
  const { stdout } = await execFile('wsl.exe', ['-d', distro, '--', 'bash', '-lc', script], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
  })
  return stdout
}

/** Enumerate installed WSL distros (order preserved; defaults first).
 *  wsl.exe writes the listing as UTF-16LE, so read the buffer and sniff the
 *  encoding (BOM or embedded NULs) instead of assuming UTF-8. */
async function listDistros(): Promise<string[]> {
  const { stdout } = await execFile('wsl.exe', ['-l', '-q'], {
    encoding: 'buffer',
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    timeout: 15_000,
  })
  const buf = stdout as Buffer
  let text: string
  if (buf.length >= 2 && (buf.readUInt16LE(0) === 0xfeff || buf.indexOf(0) !== -1)) {
    // UTF-16LE (possibly with a BOM) → decode as utf16le and drop the BOM.
    text = buf.toString('utf16le').replace(/^\uFEFF/, '')
  } else {
    text = buf.toString('utf8')
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== '*')
}

/** The distro's default user home (Linux path), e.g. /home/crack. */
async function distroHome(distro: string): Promise<string> {
  return (await wslBash(distro, `printf %s "$HOME"`)).trim()
}

/** Translate a Linux path under a distro into its Windows UNC share path. */
function toUnc(distro: string, linuxPath: string): string {
  const p = `/${linuxPath.replace(/^\/+/, '').replace(/\/+$/, '')}`
  const win = p.split('/').filter(Boolean).join('\\')
  return `\\\\wsl.localhost\\${distro}\\${win}`
}

// ---------------------------------------------------------------------------
// API handler
// ---------------------------------------------------------------------------
interface DirEntry {
  name: string
  linuxPath: string
  isDir: boolean
  hidden: boolean
}

async function handleApi(
  ctx: { workspaceRegistry: WorkspaceRegistry },
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const reqUrl = req.url ?? '/'
  const url = new URL(reqUrl, 'http://localhost')
  const route = url.pathname.slice(API_PREFIX.length).replace(/\/+$/, '') || '/'

  if (req.method === 'GET' && route === '/distros') {
    try {
      const distros = await listDistros()
      sendJson(res, 200, { distros })
    } catch (error) {
      sendJson(res, 500, { error: String(error instanceof Error ? error.message : error) })
    }
    return
  }

  if (req.method === 'POST' && route === '/home') {
    const body = await readJson(req)
    const distro = String(body.distro ?? '')
    if (!distro) return sendJson(res, 400, { error: 'distro required' })
    try {
      const home = await distroHome(distro)
      sendJson(res, 200, { home })
    } catch (error) {
      sendJson(res, 500, { error: String(error instanceof Error ? error.message : error) })
    }
    return
  }

  if (req.method === 'POST' && route === '/list') {
    const body = await readJson(req)
    const distro = String(body.distro ?? '')
    const path = String(body.path ?? '')
    if (!distro || !path) return sendJson(res, 400, { error: 'distro and path required' })
    try {
      const out = await wslBash(distro, `ls -1ap -- ${shellQuote(path)}`)
      const entries: DirEntry[] = []
      for (const raw of out.split(/\r?\n/)) {
        const line = raw.replace(/\r$/, '')
        if (!line || line === '.' || line === '..') continue
        const isDir = line.endsWith('/')
        const name = isDir ? line.slice(0, -1) : line
        const linuxPath = `${path.replace(/\/+$/, '')}/${name}`
        entries.push({ name, linuxPath, isDir, hidden: name.startsWith('.') })
      }
      entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
      sendJson(res, 200, { path, entries })
    } catch (error) {
      sendJson(res, 500, { error: String(error instanceof Error ? error.message : error) })
    }
    return
  }

  if (req.method === 'POST' && route === '/create') {
    const body = await readJson(req)
    const distro = String(body.distro ?? '')
    const path = String(body.path ?? '')
    const name = String(body.name ?? '')
    if (!distro || !path || !name) return sendJson(res, 400, { error: 'distro, path and name required' })
    if (name === '.' || name === '..' || /[/\\]/.test(name)) {
      return sendJson(res, 400, { error: 'name must be a single path segment' })
    }
    try {
      await wslBash(distro, `mkdir -p -- ${shellQuote(path.replace(/\/+$/, '') + '/' + name)}`)
      sendJson(res, 200, { ok: true })
    } catch (error) {
      sendJson(res, 500, { error: String(error instanceof Error ? error.message : error) })
    }
    return
  }

  if (req.method === 'POST' && route === '/register') {
    const body = await readJson(req)
    const distro = String(body.distro ?? '')
    const path = String(body.path ?? '')
    const title = typeof body.title === 'string' && body.title ? body.title : undefined
    if (!distro || !path) return sendJson(res, 400, { error: 'distro and path required' })
    try {
      const unc = toUnc(distro, path)
      const registry = ctx.workspaceRegistry
      const existing = await registry.resolveByPath(unc)
      const workspace = existing ?? await registry.create(unc, title)
      sendJson(res, 200, {
        workspace: {
          workspaceId: workspace.id,
          path: workspace.path,
          title: workspace.title,
          sessionIds: [...workspace.sessionIds],
          createdAt: workspace.createdAt,
          updatedAt: workspace.updatedAt,
        },
      })
    } catch (error) {
      sendJson(res, 500, { error: String(error instanceof Error ? error.message : error) })
    }
    return
  }

  sendJson(res, 404, { error: `unknown route ${route}` })
}

/** Host apply: register the WSL workspace browser API. */
async function apply(ctx: Context): Promise<void> {
  ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: (req, res) => {
      void handleApi(ctx as Context & { workspaceRegistry: WorkspaceRegistry }, req, res)
    },
  })
  ctx.logger?.('dsh-wsl')?.info(`WSL workspace API mounted at ${API_PREFIX}`)
}

export { apply, inject }
export type { DirEntry }