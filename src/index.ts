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

/** An HTTP error whose message is safe to echo verbatim as the JSON `error` field. */
class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
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

// ---------------------------------------------------------------------------
// API handler: a small route table with shared body validation and error
// normalization, replacing the previous if-chain of repeated try/catch blocks.
// ---------------------------------------------------------------------------

/** Parse the JSON request body and reject with a 400 when a required field is blank. */
async function requireBody(
  req: IncomingMessage,
  required: string[],
): Promise<Record<string, unknown>> {
  const body = await readJson(req)
  const missing = required.filter((key) => String(body[key] ?? '').trim().length === 0)
  if (missing.length > 0) {
    throw new HttpError(400, `missing required field(s): ${missing.join(', ')}`)
  }
  return body
}

/** Run a route handler and normalize its rejection into an HTTP error JSON response. */
async function wrap(
  res: ServerResponse,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn()
  } catch (error) {
    if (res.headersSent) return
    if (error instanceof HttpError) {
      sendJson(res, error.status, { error: error.message })
      return
    }
    const detail = error instanceof Error ? error.message : String(error)
    const status = typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code?: unknown }).code === 'number'
      ? (error as { code: number }).code
      : 500
    sendJson(res, status >= 400 && status < 600 ? status : 500, { error: detail })
  }
}

interface RouteContext {
  workspaceRegistry: WorkspaceRegistry
}

type Handler = (c: RouteContext, req: IncomingMessage, res: ServerResponse) => Promise<void>

const routes: Record<string, Handler> = {
  'GET /distros': async (_c, _req, res) => {
    const distros = await listDistros()
    sendJson(res, 200, { distros })
  },

  'POST /home': async (_c, req, res) => {
    const body = await requireBody(req, ['distro'])
    const home = await distroHome(String(body.distro))
    sendJson(res, 200, { home })
  },

  'POST /list': async (_c, req, res) => {
    const body = await requireBody(req, ['distro', 'path'])
    const distro = String(body.distro)
    const path = String(body.path)
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
  },

  'POST /create': async (_c, req, res) => {
    const body = await requireBody(req, ['distro', 'path', 'name'])
    const name = String(body.name)
    if (name === '.' || name === '..' || /[/\\]/.test(name)) {
      throw new HttpError(400, 'name must be a single path segment')
    }
    const base = String(body.path)
    await wslBash(String(body.distro), `mkdir -p -- ${shellQuote(base.replace(/\/+$/, '') + '/' + name)}`)
    sendJson(res, 200, { ok: true })
  },

  'POST /register': async (c, req, res) => {
    const body = await requireBody(req, ['distro', 'path'])
    const distro = String(body.distro)
    const path = String(body.path)
    const title = typeof body.title === 'string' && body.title ? body.title : undefined
    const unc = toUnc(distro, path)
    const registry = c.workspaceRegistry
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
  },
}

async function handleApi(
  ctx: { workspaceRegistry: WorkspaceRegistry },
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const reqUrl = req.url ?? '/'
  const url = new URL(reqUrl, 'http://localhost')
  const route = url.pathname.slice(API_PREFIX.length).replace(/\/+$/, '') || '/'
  const key = `${req.method ?? 'GET'} ${route}`
  const handler = routes[key]
  if (!handler) {
    sendJson(res, 404, { error: `unknown route ${req.method ?? 'GET'} ${route}` })
    return
  }
  await wrap(res, () => handler(ctx, req, res))
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