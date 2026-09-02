/**
 * Client entry for the WSL workspace browser.
 *
 * The native sidebar "Add workspace" button stays untouched (always visible,
 * never hidden/replaced). Its click is intercepted in the document CAPTURE
 * phase — before React's container listener can open the native picker — and a
 * two-item menu is shown:「Windows 工作区」replays the click through a one-shot
 * passthrough so React's own directory flow opens exactly as usual,
 * 「WSL 工作区」opens this plugin's WSL browser. If interception ever fails,
 * the click falls through to the native flow, so the button never breaks.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { WslBrowser } from './wsl-browser.tsx'
import { injectWslCss } from './wsl-css.ts'

/** No client services are injected: this client is pure-DOM + fetch. */
export const inject: string[] = []

const NATIVE_ADD_LABELS = ['添加工作区', 'Add workspace', 'Add workspace…', 'Add workspace', 'Add Workspace']

// ---------------------------------------------------------------------------
// WSL workspace browser (React modal)
// ---------------------------------------------------------------------------
function mountBrowser(): () => void {
  const host = document.createElement('div')
  host.dataset.dshwslBrowser = ''
  document.body.appendChild(host)
  let root: Root | null = null
  let closed = false
  const cleanup = () => {
    if (closed) return
    closed = true
    try { root?.unmount() } catch { /* already unmounted */ }
    root = null
    host.remove()
  }
  root = createRoot(host)
  root.render(createElement(WslBrowser, { onClose: cleanup }))
  return cleanup
}

let browserCleanup: (() => void) | null = null
let menuCleanup: (() => void) | null = null

function closeMenu(): void {
  menuCleanup?.()
  menuCleanup = null
}

function showMenu(anchor: HTMLElement, onWindows: () => void, onWsl: () => void): void {
  closeMenu()
  const rect = anchor.getBoundingClientRect()

  const backdrop = document.createElement('div')
  backdrop.className = 'dshwsl-menu-backdrop'

  const host = document.createElement('div')
  host.className = 'dshwsl-menu-wrap'
  host.style.top = `${Math.round(rect.bottom + 6)}px`
  host.style.left = `${Math.round(rect.left)}px`

  const menu = document.createElement('div')
  menu.className = 'dshwsl-menu'

  const item = (label: string, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'dshwsl-menu-item'
    b.textContent = label
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      closeMenu()
      onClick()
    })
    return b
  }

  menu.appendChild(item('Windows 工作区', onWindows))
  menu.appendChild(item('WSL 工作区', onWsl))
  host.appendChild(menu)

  const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') closeMenu() }
  const cleanup = (): void => {
    host.remove()
    backdrop.remove()
    document.removeEventListener('keydown', onKey)
  }
  backdrop.addEventListener('click', () => closeMenu())
  document.addEventListener('keydown', onKey)
  document.body.appendChild(backdrop)
  document.body.appendChild(host)
  menuCleanup = cleanup
}

/**
 * Intercept a click on the native Add-workspace button in the document
 * CAPTURE phase so it runs before React's container listener. Returns the
 * button element when the click should be swallowed (menu shown), else null.
 */
function interceptAddButton(e: Event, passthrough: () => boolean): HTMLButtonElement | null {
  const t = e.target
  if (!(t instanceof Element)) return null
  const btn = t.closest<HTMLButtonElement>('button[aria-label]')
  if (!btn) return null
  const label = (btn.getAttribute('aria-label') || '').trim()
  if (!NATIVE_ADD_LABELS.includes(label)) return null
  if (passthrough()) return null // one-shot replay → let React handle it
  e.preventDefault()
  e.stopPropagation()
  e.stopImmediatePropagation()
  return btn
}

export function apply(ctx: ClientContext): void {
  injectWslCss()

  // One-shot passthrough for the "Windows 工作区" replay click.
  let passthrough = false

  const onCaptureClick = (e: Event): void => {
    const btn = interceptAddButton(e, () => passthrough)
    if (!btn) return
    showMenu(
      btn,
      () => {
        passthrough = true
        btn.click()
        // Re-arm interception after this one-shot replay: `btn.click()` is
        // synchronous, so React's bubble handler opens the native picker within
        // this same dispatch; resetting on a following timeout restores the
        // menu for the next click instead of latching it to Windows forever.
        setTimeout(() => { passthrough = false }, 0)
      },
      () => {
        browserCleanup?.()
        browserCleanup = mountBrowser()
      },
    )
  }

  document.addEventListener('click', onCaptureClick, true)

  try {
    ctx.effect(() => () => {
      document.removeEventListener('click', onCaptureClick, true)
      closeMenu()
      browserCleanup?.()
      browserCleanup = null
    }, 'dsh-wsl: workspace browser')
  } catch {
    /* effect unavailable; capture listener survives module teardown */
  }
}