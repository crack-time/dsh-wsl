/**
 * Client entry for the WSL workspace browser.
 *
 * The native sidebar "Add workspace" button is replaced (in place, same native
 * look) by an identical-look button that belongs to this plugin. Clicking it
 * shows a two-item menu —「Windows 工作区」programmatically clicks the hidden
 * native button so React's own directory flow opens exactly as usual,
 * 「WSL 工作区」opens this plugin's WSL browser. Because the visible button has
 * no React fiber and carries only this plugin's click handler, React's event
 * delegation can never hijack the click (the earlier intercept-inside-a-button
 * approach did not fire before React's root listener on this skin).
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

// ---------------------------------------------------------------------------
// Replace the native add button with our identical-look button
// ---------------------------------------------------------------------------
function findNativeAddButton(): HTMLButtonElement | null {
  for (const btn of document.querySelectorAll<HTMLButtonElement>('button[aria-label]')) {
    const label = (btn.getAttribute('aria-label') || '').trim()
    if (NATIVE_ADD_LABELS.includes(label)) return btn
  }
  return null
}

function ensureButton(): void {
  const native = findNativeAddButton()
  if (!native) return
  // Already swapped and still has our button next to it → leave stable.
  if (native.dataset.dshwslSwapped === '1') {
    if (document.querySelector('[data-dshwsl-add-btn]')) return
    // fallthrough: clone was removed → rebuild below
  }

  // Drop any stale clones from earlier runs, then hide the native and seat ours.
  document.querySelectorAll('[data-dshwsl-add-btn]').forEach((el) => el.remove())

  native.dataset.dshwslSwapped = '1'
  native.style.display = 'none'

  const b = native.cloneNode(true) as HTMLButtonElement
  if (b.id) b.id = ''
  b.querySelectorAll<HTMLElement>('[id]').forEach((el) => el.removeAttribute('id'))
  b.dataset.dshwslAddBtn = ''
  b.removeAttribute('aria-pressed')
  b.title = 'WSL 工作区'
  b.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    showMenu(
      b,
      () => { native.click() }, // Windows → native flow via the hidden button
      () => {
        browserCleanup?.()
        browserCleanup = mountBrowser()
      },
    )
  })
  native.insertAdjacentElement('afterend', b)
}

export function apply(ctx: ClientContext): void {
  injectWslCss()
  ensureButton()

  let scheduled = false
  const schedule = (): void => {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(() => {
      scheduled = false
      ensureButton()
    })
  }
  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, subtree: true })

  try {
    ctx.effect(() => () => {
      observer.disconnect()
      closeMenu()
      browserCleanup?.()
      browserCleanup = null
      // Un-hide the native button and drop our clone on teardown.
      document.querySelectorAll('[data-dshwsl-add-btn]').forEach((el) => el.remove())
      document.querySelectorAll('[data-dshwsl-swapped]').forEach((el) => {
        ;(el as HTMLElement).style.display = ''
        el.removeAttribute('data-dshwsl-swapped')
      })
    }, 'dsh-wsl: workspace browser')
  } catch {
    /* effect unavailable; DOM entries survive module teardown */
  }
}