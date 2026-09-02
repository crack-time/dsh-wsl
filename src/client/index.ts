/**
 * Client entry for the WSL workspace browser.
 *
 * Injects a "＋ WSL 工作区" button right after the native Add-workspace button
 * in the sidebar (DOM-injected like dsh-archive: the native workspace list has
 * no public slot contract for sibling header actions, so we seat next to the
 * found button). Clicking it mounts the WSL browser as a modal overlay via
 * React createRoot; style + shell are self-contained.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { WslBrowser } from './wsl-browser.tsx'
import { injectWslCss } from './wsl-css.ts'

/** No client services are injected: this client is pure-DOM + fetch. */
export const inject: string[] = []

const NATIVE_ADD_LABELS = ['添加工作区', 'Add workspace', 'Add workspace…', 'Add workspace', 'Add Workspace']

function mountBrowser(onClose: () => void): () => void {
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
  root.render(createElement(WslBrowser, {
    onClose: cleanup,
    onRegistered: () => {
      // Registration alone updates the native sidebar via the workspace feed;
      // the new entry appears beside Windows ones and is opened on click.
    },
  }))
  return cleanup
}

let currentCleanup: (() => void) | null = null

export function apply(ctx: ClientContext): void {
  injectWslCss()

  function ensureButton(): void {
    if (document.querySelector('[data-dshwsl-add-btn]')) return

    // Seat ours right after the native sidebar "Add workspace" button. Clone
    // the native element so the icon, size, and styles match the native skin
    // exactly (the clone carries the same classes/attribute/SVG, only the
    // aria-label + tooltip + click target change).
    const labels = NATIVE_ADD_LABELS
    for (const btn of document.querySelectorAll<HTMLButtonElement>('button[aria-label]')) {
      const label = (btn.getAttribute('aria-label') || '').trim()
      if (labels.includes(label)) {
        const b = btn.cloneNode(true) as HTMLButtonElement
        // Cloning must not duplicate DOM ids (the native tree may use them).
        if (b.id) b.id = ''
        b.querySelectorAll<HTMLElement>('[id]').forEach((el) => el.removeAttribute('id'))
        b.removeAttribute('aria-pressed')
        b.dataset.dshwslAddBtn = ''
        b.setAttribute('aria-label', 'WSL 工作区')
        b.title = 'WSL 工作区'
        b.addEventListener('click', () => {
          currentCleanup?.()
          currentCleanup = mountBrowser(() => {
            currentCleanup = null
          })
        })
        btn.insertAdjacentElement('afterend', b)
        return
      }
    }
  }

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
      currentCleanup?.()
      currentCleanup = null
      document.querySelectorAll('[data-dshwsl-add-btn]').forEach((el) => el.remove())
    }, 'dsh-wsl: workspace browser')
  } catch {
    /* effect unavailable; DOM entries survive module teardown */
  }
}