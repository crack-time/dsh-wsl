import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { WslBrowser } from './wsl-browser.js';
import { injectWslCss } from './wsl-css.js';
/** No client services are injected: this client is pure-DOM + fetch. */
export const inject = [];
const NATIVE_ADD_LABELS = ['添加工作区', 'Add workspace', 'Add workspace…', 'Add workspace', 'Add Workspace'];
// ---------------------------------------------------------------------------
// WSL workspace browser (React modal)
// ---------------------------------------------------------------------------
function mountBrowser() {
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
    root.render(createElement(WslBrowser, { onClose: cleanup }));
    return cleanup;
}
let browserCleanup = null;
let menuCleanup = null;
function closeMenu() {
    menuCleanup?.();
    menuCleanup = null;
}
function showMenu(anchor, onWindows, onWsl) {
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
    menu.appendChild(item('Windows 工作区', onWindows));
    menu.appendChild(item('WSL 工作区', onWsl));
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
// ---------------------------------------------------------------------------
// Replace the native add button with our identical-look button
// ---------------------------------------------------------------------------
function findNativeAddButton() {
    for (const btn of document.querySelectorAll('button[aria-label]')) {
        const label = (btn.getAttribute('aria-label') || '').trim();
        if (NATIVE_ADD_LABELS.includes(label))
            return btn;
    }
    return null;
}
function ensureButton() {
    const native = findNativeAddButton();
    if (!native)
        return;
    // Already swapped and still has our button next to it → leave stable.
    if (native.dataset.dshwslSwapped === '1') {
        if (document.querySelector('[data-dshwsl-add-btn]'))
            return;
        // fallthrough: clone was removed → rebuild below
    }
    // Drop any stale clones from earlier runs, then hide the native and seat ours.
    document.querySelectorAll('[data-dshwsl-add-btn]').forEach((el) => el.remove());
    native.dataset.dshwslSwapped = '1';
    native.style.display = 'none';
    const b = native.cloneNode(true);
    if (b.id)
        b.id = '';
    b.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
    b.dataset.dshwslAddBtn = '';
    b.removeAttribute('aria-pressed');
    b.title = 'WSL 工作区';
    b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showMenu(b, () => { native.click(); }, // Windows → native flow via the hidden button
        () => {
            browserCleanup?.();
            browserCleanup = mountBrowser();
        });
    });
    native.insertAdjacentElement('afterend', b);
}
export function apply(ctx) {
    injectWslCss();
    ensureButton();
    let scheduled = false;
    const schedule = () => {
        if (scheduled)
            return;
        scheduled = true;
        requestAnimationFrame(() => {
            scheduled = false;
            ensureButton();
        });
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    try {
        ctx.effect(() => () => {
            observer.disconnect();
            closeMenu();
            browserCleanup?.();
            browserCleanup = null;
            // Un-hide the native button and drop our clone on teardown.
            document.querySelectorAll('[data-dshwsl-add-btn]').forEach((el) => el.remove());
            document.querySelectorAll('[data-dshwsl-swapped]').forEach((el) => {
                ;
                el.style.display = '';
                el.removeAttribute('data-dshwsl-swapped');
            });
        }, 'dsh-wsl: workspace browser');
    }
    catch {
        /* effect unavailable; DOM entries survive module teardown */
    }
}
