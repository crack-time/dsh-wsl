/**
 * WSL workspace browser: pick a distro, walk the Linux filesystem, create a
 * folder, register the current directory as a DSH workspace (stored via its
 * `\\wsl.localhost\<distro>\...` UNC path so it shows up in the native sidebar
 * mixed with Windows workspaces).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { client, type DirEntry } from './api.ts'
import { formatText, makeT, type LocaleRuntime, type WslTextKey } from './wsl-locale.ts'

export interface WslBrowserProps {
  onClose: () => void
  /**
   * Called after a directory is successfully registered, with the new
   * workspace title so the host flow can navigate/dispose.
   */
  onRegistered?: (workspace: { workspaceId: string; path: string; title: string }) => void
  errorMessage?: string
  /** DSH client locale runtime, for automatic zh/en switching. */
  locale?: LocaleRuntime
}

export function WslBrowser({ onClose, onRegistered, locale }: WslBrowserProps) {
  const [distros, setDistros] = useState<string[]>([])
  const [distro, setDistro] = useState('')
  const [path, setPath] = useState('')
  const [entries, setEntries] = useState<DirEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [newName, setNewName] = useState('')
  const [registered, setRegistered] = useState<null | { workspaceId: string; path: string; title: string }>(null)
  const darkRef = useRef(false)

  // Translate at render time (`makeT` reads the active locale). Subscribe to
  // the locale runtime so an open dialog switches language live.
  const t = makeT(locale)
  const [, bump] = useState(0)
  useEffect(() => {
    if (!locale?.subscribe) return
    return locale.subscribe(() => bump((i) => i + 1))
  }, [locale])
  const L = (key: WslTextKey): string => formatText(t(key))

  const load = useCallback(async (d: string, p: string) => {
    setLoading(true)
    setError('')
    try {
      const r = await client.list({ distro: d, path: p })
      setPath(r.path)
      setEntries(r.entries)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setLoading(false)
    }
  }, [])

  // Seed: distros → pick first → load its home.
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const { distros } = await client.listDistros()
        if (!alive) return
        setDistros(distros)
        const first = distros[0]
        if (!first) {
          setError(L('noDistro'))
          return
        }
        setDistro(first)
        const { home } = await client.home({ distro: first })
        if (alive) await load(first, home || '/home')
      } catch (e) {
        if (alive) setError(String(e instanceof Error ? e.message : e))
      }
    })()
    return () => { alive = false }
  }, [load])

  // Dark theme follow (best-effort): respect a class toggle on <html>.
  useEffect(() => {
    const root = document.documentElement
    const sync = () => {
      darkRef.current = root.classList.contains('dark')
        || root.getAttribute('data-theme') === 'dark'
      const card = document.querySelector('.dshwsl-card')
      card?.classList.toggle('dark', darkRef.current)
    }
    sync()
    const obs = new MutationObserver(sync)
    obs.observe(root, { attributes: true, attributeFilter: ['class', 'data-theme'] })
    return () => obs.disconnect()
  }, [])

  const onDistroChange = async (d: string) => {
    setDistro(d)
    setRegistered(null)
    try {
      const { home } = await client.home({ distro: d })
      await load(d, home || '/home')
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    }
  }

  const createFolder = async () => {
    const name = newName.trim()
    if (!name || !distro || !path) return
    setLoading(true)
    setError('')
    try {
      await client.create({ distro, path, name })
      setNewName('')
      await load(distro, path)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setLoading(false)
    }
  }

  const parent = (p: string): string => {
    const p2 = p.replace(/\/+$/, '')
    const idx = p2.lastIndexOf('/')
    return idx <= 0 ? '/' : p2.slice(0, idx) || '/'
  }

  const register = async () => {
    if (!distro || !path) return
    setLoading(true)
    setError('')
    try {
      const title = path === '/' ? distro : path.split('/').filter(Boolean).pop() || distro
      const { workspace } = await client.register({ distro, path, title })
      setRegistered(workspace)
      onRegistered?.(workspace)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setLoading(false)
    }
  }

  const enter = (entry: DirEntry) => {
    if (!entry.isDir) return
    setRegistered(null)
    void load(distro, entry.linuxPath)
  }

  return (
    <div className="dshwsl-modal" onClick={onClose}>
      <div className="dshwsl-card" onClick={(e) => e.stopPropagation()}>
        <div className="dshwsl-head">
          <h3 className="dshwsl-title">{L('title')}</h3>
          <button type="button" className="dshwsl-close" onClick={onClose} aria-label="close">×</button>
        </div>

        <div className="dshwsl-row">
          <span className="dshwsl-label">{L('distro')}</span>
          <select className="dshwsl-select" value={distro} onChange={(e) => void onDistroChange(e.target.value)}>
            {distros.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>

        <div className="dshwsl-row">
          <span className="dshwsl-label">{L('path')}</span>
          <span className="dshwsl-path" title={path}>{path}</span>
        </div>

        <div className="dshwsl-row">
          <button type="button" className="dshwsl-up" onClick={() => void load(distro, parent(path))}>{L('up')}</button>
          <div className="dshwsl-btnbar">
            <input
              className="dshwsl-input" placeholder={L('folderName')} value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void createFolder() }}
            />
            <button type="button" className="dshwsl-btn" onClick={() => void createFolder()}>{L('create')}</button>
          </div>
        </div>

        {(loading && entries.length === 0) && <div className="dshwsl-status">{L('loading')}</div>}
        {error && <div className="dshwsl-status dshwsl-error">{error}</div>}
        {registered && <div className="dshwsl-status dshwsl-ok">✓ {L('registered')}</div>}

        <div className="dshwsl-list">
          {!loading && entries.length === 0 && !error && <div className="dshwsl-empty">{L('empty')}</div>}
          {entries.map((entry) => (
            <div key={entry.linuxPath} className={`dshwsl-item${entry.isDir ? '' : ' file'}`} onClick={() => enter(entry)}>
              <span className="dshwsl-icon">{entry.isDir ? '📁' : '📄'}</span>
              <span>{entry.name}</span>
            </div>
          ))}
        </div>

        <div className="dshwsl-foot">
          <button type="button" className="dshwsl-btn" onClick={onClose}>
            {registered ? L('done') : L('close')}
          </button>
          {!registered && (
            <button type="button" className="dshwsl-btn primary" disabled={loading || !distro || !path} onClick={() => void register()}>
              {L('register')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}