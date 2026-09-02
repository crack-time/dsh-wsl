/**
 * Small JSON client for the WSL workspace host API.
 */
const API = '/plugins/@crack/dsh-wsl/api'

async function parseError(status: number, body: string): Promise<string> {
  try {
    const j = JSON.parse(body) as { error?: string }
    if (j.error) return j.error
  } catch { /* not JSON */ }
  return `HTTP ${status}`
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API + path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(await parseError(res.status, text))
  return (text ? JSON.parse(text) : {}) as T
}

export interface DirEntry {
  name: string
  linuxPath: string
  isDir: boolean
  hidden: boolean
}

export const client = {
  listDistros(): Promise<{ distros: string[] }> {
    return api('/distros')
  },
  home(data: { distro: string }): Promise<{ home: string }> {
    return api('/home', { method: 'POST', body: JSON.stringify(data) })
  },
  list(data: { distro: string; path: string }): Promise<{ path: string; entries: DirEntry[] }> {
    return api('/list', { method: 'POST', body: JSON.stringify(data) })
  },
  create(data: { distro: string; path: string; name: string }): Promise<{ ok: boolean }> {
    return api('/create', { method: 'POST', body: JSON.stringify(data) })
  },
  register(data: { distro: string; path: string; title?: string }): Promise<{
    workspace: { workspaceId: string; path: string; title: string }
  }> {
    return api('/register', { method: 'POST', body: JSON.stringify(data) })
  },
}