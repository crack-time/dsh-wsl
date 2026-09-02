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
        // Find the native sidebar "Add workspace" icon button and seat ours after it.
        const labels = NATIVE_ADD_LABELS;
        for (const btn of document.querySelectorAll('button[aria-label]')) {
            const label = (btn.getAttribute('aria-label') || '').trim();
            if (labels.includes(label)) {
                const b = document.createElement('button');
                b.type = 'button';
                b.dataset.dshwslAddBtn = '';
                b.setAttribute('aria-label', 'WSL 工作区');
                b.title = 'WSL 工作区';
                // Plus-in-folder icon (native minimal style).
                b.innerHTML =
                    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
                        '<path fill="currentColor" d="M5.4 2.1 4.7 2.5 5.4 2.1Zm7.6 9.8h-6v1h6v-1ZM6.5 1.9v3.6h1V1.9h-1Zm3.4 3.6V1.9h-1v3.6h1Zm-4.6 3.7h3v-1h-3v1Z" transform="translate(1.5 1)" opacity="0.9"/>' +
                        '<path fill="currentColor" d="M2.5 1.5h4.2v1H3.5v11h9v-4.2h1V13a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2.5 13V3a1.5 1.5 0 0 1 1.5-1.5Zm7 8V6.3h3v1h-2v2.2h-1Z" transform="translate(1.5 1)"/>' +
                        '</svg>';
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
