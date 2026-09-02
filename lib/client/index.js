import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { WslBrowser } from './wsl-browser.js';
import { injectWslCss } from './wsl-css.js';
import { DICT, WSL_LOCALE } from './wsl-locale.js';
/** Injects the DSH locale service so the menu/dialog follow the active language. */
export const inject = ['locale'];
const NATIVE_ADD_LABELS = ['添加工作区', 'Add workspace', 'Add workspace…', 'Add workspace', 'Add Workspace'];
// ---------------------------------------------------------------------------
// WSL workspace browser (React modal)
// ---------------------------------------------------------------------------
function mountBrowser(locale) {
    const host = document.createElement('div');
    host.dataset.dshwslBrowser = '';
    document.body.appendChild(host);
    let root = null;
    let closed = false;
    const cleanup = () => {
        if (closed)
            return;
        closed = true;
        try {
            root?.unmount();
        }
        catch { /* already unmounted */ }
        root = null;
        host.remove();
    };
    root = createRoot(host);
    root.render(createElement(WslBrowser, { onClose: cleanup, locale }));
    return cleanup;
}
let browserCleanup = null;
let menuCleanup = null;
function closeMenu() {
    menuCleanup?.();
    menuCleanup = null;
}
function showMenu(anchor, t, onWindows, onWsl) {
    closeMenu();
    const rect = anchor.getBoundingClientRect();
    const backdrop = document.createElement('div');
    backdrop.className = 'dshwsl-menu-backdrop';
    const host = document.createElement('div');
    host.className = 'dshwsl-menu-wrap';
    host.style.top = `${Math.round(rect.bottom + 6)}px`;
    host.style.left = `${Math.round(rect.left)}px`;
    const menu = document.createElement('div');
    menu.className = 'dshwsl-menu';
    const item = (label, onClick) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'dshwsl-menu-item';
        b.textContent = label;
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            closeMenu();
            onClick();
        });
        return b;
    };
    // `t` reads the active locale at call time, so the menu matches the current
    // language (it is rebuilt on every open).
    menu.appendChild(item(t('menuWindows'), onWindows));
    menu.appendChild(item(t('menuWsl'), onWsl));
    host.appendChild(menu);
    const onKey = (e) => { if (e.key === 'Escape')
        closeMenu(); };
    const cleanup = () => {
        host.remove();
        backdrop.remove();
        document.removeEventListener('keydown', onKey);
    };
    backdrop.addEventListener('click', () => closeMenu());
    document.addEventListener('keydown', onKey);
    document.body.appendChild(backdrop);
    document.body.appendChild(host);
    menuCleanup = cleanup;
}
/**
 * Intercept a click on the native Add-workspace button in the document
 * CAPTURE phase so it runs before React's container listener. Returns the
 * button element when the click should be swallowed (menu shown), else null.
 */
function interceptAddButton(e, passthrough) {
    const t = e.target;
    if (!(t instanceof Element))
        return null;
    const btn = t.closest('button[aria-label]');
    if (!btn)
        return null;
    const label = (btn.getAttribute('aria-label') || '').trim();
    if (!NATIVE_ADD_LABELS.includes(label))
        return null;
    if (passthrough())
        return null; // one-shot replay → let React handle it
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    return btn;
}
export function apply(ctx) {
    injectWslCss();
    // Register the bilingual dict and bind a translate fn that reads the active
    // DSH locale at call time (auto-follows zh/en switches). Nullish-safe fallback.
    ctx.locale?.register?.(DICT, WSL_LOCALE);
    const t = ctx.locale?.bind?.(DICT) ?? ((key) => key);
    // One-shot passthrough for the "Windows 工作区" replay click.
    let passthrough = false;
    const onCaptureClick = (e) => {
        const btn = interceptAddButton(e, () => passthrough);
        if (!btn)
            return;
        showMenu(btn, t, () => {
            passthrough = true;
            btn.click();
            // Re-arm interception after this one-shot replay: `btn.click()` is
            // synchronous, so React's bubble handler opens the native picker within
            // this same dispatch; resetting on a following timeout restores the
            // menu for the next click instead of latching it to Windows forever.
            setTimeout(() => { passthrough = false; }, 0);
        }, () => {
            browserCleanup?.();
            browserCleanup = mountBrowser(ctx.locale);
        });
    };
    document.addEventListener('click', onCaptureClick, true);
    try {
        ctx.effect(() => () => {
            document.removeEventListener('click', onCaptureClick, true);
            closeMenu();
            browserCleanup?.();
            browserCleanup = null;
        }, 'dsh-wsl: workspace browser');
    }
    catch {
        /* effect unavailable; capture listener survives module teardown */
    }
}
