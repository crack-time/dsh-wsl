import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { WslBrowser } from './wsl-browser.js';
import { injectWslCss } from './wsl-css.js';
/** No client services are injected: this client is pure-DOM + fetch. */
export const inject = [];
const NATIVE_ADD_LABELS = ['添加工作区', 'Add workspace', 'Add workspace…', 'Add workspace', 'Add Workspace'];
function mountBrowser(onClose) {
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
    root.render(createElement(WslBrowser, {
        onClose: cleanup,
        onRegistered: () => {
            // Registration alone updates the native sidebar via the workspace feed;
            // the new entry appears beside Windows ones and is opened on click.
        },
    }));
    return cleanup;
}
let currentCleanup = null;
export function apply(ctx) {
    injectWslCss();
    function ensureButton() {
        if (document.querySelector('[data-dshwsl-add-btn]'))
            return;
        // Seat ours right after the native sidebar "Add workspace" button. Clone
        // the native element so the icon, size, and styles match the native skin
        // exactly (the clone carries the same classes/attribute/SVG, only the
        // aria-label + tooltip + click target change).
        const labels = NATIVE_ADD_LABELS;
        for (const btn of document.querySelectorAll('button[aria-label]')) {
            const label = (btn.getAttribute('aria-label') || '').trim();
            if (labels.includes(label)) {
                const b = btn.cloneNode(true);
                // Cloning must not duplicate DOM ids (the native tree may use them).
                if (b.id)
                    b.id = '';
                b.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
                b.removeAttribute('aria-pressed');
                b.dataset.dshwslAddBtn = '';
                b.setAttribute('aria-label', 'WSL 工作区');
                b.title = 'WSL 工作区';
                b.addEventListener('click', () => {
                    currentCleanup?.();
                    currentCleanup = mountBrowser(() => {
                        currentCleanup = null;
                    });
                });
                btn.insertAdjacentElement('afterend', b);
                return;
            }
        }
    }
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
            currentCleanup?.();
            currentCleanup = null;
            document.querySelectorAll('[data-dshwsl-add-btn]').forEach((el) => el.remove());
        }, 'dsh-wsl: workspace browser');
    }
    catch {
        /* effect unavailable; DOM entries survive module teardown */
    }
}
