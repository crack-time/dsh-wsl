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
function mountBrowser(onRegistered) {
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
    root.render(createElement(WslBrowser, { onClose: cleanup, onRegistered }));
    return cleanup;
}
let browserCleanup = null;
let menuCleanup = null;
// ---------------------------------------------------------------------------
// Two-option menu (plain DOM, native-aligned styling from wsl-css.ts)
// ---------------------------------------------------------------------------
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
        menuCleanup = null;
    };
    backdrop.addEventListener('click', cleanup);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(backdrop);
    document.body.appendChild(host);
    menuCleanup = cleanup;
}
// ---------------------------------------------------------------------------
// Wire the single native add button
// ---------------------------------------------------------------------------
function findNativeAddButton() {
    for (const btn of document.querySelectorAll('button[aria-label]')) {
        const label = (btn.getAttribute('aria-label') || '').trim();
        if (NATIVE_ADD_LABELS.includes(label))
            return btn;
    }
    return null;
}
export function apply(ctx) {
    injectWslCss();
    // One-shot passthrough: when set, the next click on the native button is NOT
    // swallowed — it propagates to React so the native directory flow opens.
    let passthrough = false;
    function ensureWiring() {
        const btn = findNativeAddButton();
        if (!btn || btn.hasAttribute('data-dshwsl-wired'))
            return;
        btn.setAttribute('data-dshwsl-wired', 'true');
        btn.addEventListener('click', (e) => {
            if (passthrough) {
                passthrough = false;
                return; // let this synthetic click reach React → native flow
            }
            e.preventDefault();
            e.stopPropagation(); // suppress React's onClick (native picker stays closed)
            const native = btn;
            showMenu(native, 
            // "Windows 工作区": re-fire a click that propagates to React.
            () => { passthrough = true; native.click(); }, 
            // "WSL 工作区": open this plugin's WSL browser.
            () => {
                browserCleanup?.();
                browserCleanup = mountBrowser(() => {
                    browserCleanup = null;
                });
            });
        });
    }
    ensureWiring();
    let scheduled = false;
    const schedule = () => {
        if (scheduled)
            return;
        scheduled = true;
        requestAnimationFrame(() => {
            scheduled = false;
            ensureWiring();
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
            // Drop our wiring marker so a fresh module pass re-wires the button.
            document.querySelectorAll('[data-dshwsl-wired]').forEach((el) => el.removeAttribute('data-dshwsl-wired'));
        }, 'dsh-wsl: workspace browser');
    }
    catch {
        /* effect unavailable; DOM entries survive module teardown */
    }
}
