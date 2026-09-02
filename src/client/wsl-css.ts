/**
 * WSL workspace browser styles, injected once as a <style> with a prefixed
 * class namespace (nothing in the native skin carries class names "dshwsl-*").
 *
 * Visual language follows the native dsh web skin: it references the runtime
 * DSW design tokens (--dsw-*), so colors/theme adapt automatically, with
 * static fallbacks for environments where those tokens are absent. Font stack,
 * sizes and radii mirror native (system sans incl. Chinese, 13px body, 12px
 * captions, 12px surface radius).
 */
const DSW_FONT = 'var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif)'
const DSW_MONO = 'var(--dsw-font-markdown-code, ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Mono", Consolas, "Microsoft YaHei", monospace)'

const CSS = `
.dshwsl-modal {
  position: fixed; inset: 0; z-index: 9999;
  display: flex; align-items: center; justify-content: center;
  background: var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.35));
  font-family: ${DSW_FONT};
}
.dshwsl-card {
  width: min(560px, 92vw); max-height: 82vh; overflow: auto;
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  color: var(--dsw-alias-label-primary, #1f2328);
  border: 1px solid var(--dsw-alias-border-l2, #e2e4e8);
  border-radius: 12px;
  box-shadow: var(--dsw-elevation-stroke-color, rgba(0,0,0,0.12)) 0 12px 40px;
  padding: 16px 18px;
  font-size: 13px;
  font-family: ${DSW_FONT};
}
.dshwsl-card.dark { background:#0d1117; color:#e6edf3; border-color:#30363d; }
.dshwsl-head { display:flex; align-items:center; justify-content:space-between; margin-bottom: 14px; }
.dshwsl-title { font-size: 14px; font-weight: 600; margin: 0; color: var(--dsw-alias-label-primary, inherit); }
.dshwsl-close { border:0; background:transparent; font-size:16px; line-height:1; cursor:pointer; color: var(--dsw-alias-label-secondary, inherit); padding:4px 6px; border-radius:6px; }
.dshwsl-close:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.18)); }
.dshwsl-row { display:flex; gap:8px; align-items:center; margin: 9px 0; }
.dshwsl-label {
  font-size: 12px; color: var(--dsw-alias-label-caption, var(--dsw-alias-label-secondary, #6b7280));
  min-width: 72px; flex: none;
}
.dshwsl-select, .dshwsl-input {
  flex:1; padding:6px 9px; border-radius:8px;
  border:1px solid var(--dsw-alias-border-l2, #d0d7de);
  background: var(--dsw-alias-bg-base, #fff); color: var(--dsw-alias-label-primary, inherit);
  font-family: ${DSW_FONT}; font-size: 13px;
}
.dshwsl-select:focus, .dshwsl-input:focus { outline:none; border-color: var(--dsw-alias-brand-primary, #0969da); }
.dshwsl-input { min-width: 0; }
.dshwsl-path {
  flex:1; font-family: ${DSW_MONO}; font-size:12px;
  background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.10));
  color: var(--dsw-alias-label-secondary, inherit);
  border:1px solid transparent; border-radius:8px; padding:6px 9px;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0;
}
.dshwsl-list { margin: 8px 0; border:1px solid var(--dsw-alias-border-l2, #d0d7de); border-radius:10px; max-height: 300px; overflow:auto; }
.dshwsl-item { display:flex; align-items:center; gap:9px; padding:6px 10px; cursor:pointer; font-size:13px; border-radius:7px; }
.dshwsl-item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }
.dshwsl-item.file { cursor: default; color: var(--dsw-alias-label-tertiary, inherit); opacity:.8; }
.dshwsl-icon { width: 16px; text-align: center; flex: none; font-size: 14px; }
.dshwsl-up {
  cursor:pointer; font-size:13px; padding: 5px 10px; border-radius:8px;
  border:1px solid var(--dsw-alias-border-l2, #d0d7de);
  background: var(--dsw-alias-bg-base, transparent); color: var(--dsw-alias-label-primary, inherit);
  font-family: ${DSW_FONT};
}
.dshwsl-up:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }
.dshwsl-status { font-size:12.5px; margin: 5px 0; }
.dshwsl-error { color: var(--dsw-alias-state-error-primary, #e5534b); }
.dshwsl-ok { color: var(--dsw-alias-state-success-primary, #1a7f37); }
.dshwsl-foot { display:flex; justify-content:flex-end; gap:8px; margin-top: 14px; }
.dshwsl-btn {
  border:1px solid var(--dsw-alias-border-l2, #d0d7de);
  background: transparent; color: var(--dsw-alias-label-primary, inherit);
  padding:7px 14px; border-radius:8px; cursor:pointer; font-size:13px;
  font-family: ${DSW_FONT};
}
.dshwsl-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }
.dshwsl-btn.primary {
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #0969da));
  border-color: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #0969da));
  color: var(--dsw-alias-label-primary-foreground, #fff);
}
.dshwsl-btn.primary:hover { background: var(--dsw-alias-button-primary-hover, #0a5fc7); border-color: var(--dsw-alias-button-primary-hover, #0a5fc7); }
.dshwsl-btn.primary:disabled { opacity:.5; cursor:default; }
.dshwsl-btnbar { display:flex; gap:6px; }
.dshwsl-empty { text-align:center; color: var(--dsw-alias-label-secondary, inherit); opacity:.6; padding:18px; font-size:13px; }

/* Two-option menu attached to the native Add-workspace button. */
.dshwsl-menu-backdrop { position: fixed; inset:0; z-index: 9997; background: transparent; }
.dshwsl-menu-wrap { position: fixed; z-index: 9998; }
.dshwsl-menu {
  min-width: 176px;
  background: var(--dsw-alias-bg-layer-1, #fff);
  color: var(--dsw-alias-label-primary, #1f2328);
  border: 1px solid var(--dsw-alias-border-l2, #d0d7de);
  border-radius: 10px;
  box-shadow: var(--dsw-elevation-stroke-color, rgba(0,0,0,0.18)) 0 6px 24px;
  padding: 4px;
  font-family: ${DSW_FONT};
}
.dshwsl-menu.dark { background:#0d1117; color:#e6edf3; border-color:#30363d; }
.dshwsl-menu-item {
  display:block; width:100%; text-align:left;
  border:0; background:transparent; color: var(--dsw-alias-label-primary, inherit);
  padding: 7px 10px; border-radius: 7px; cursor:pointer;
  font-size: 13px; font-family: inherit;
}
.dshwsl-menu-item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.14)); }
.dshwsl-menu-item + .dshwsl-menu-item { margin-top: 2px; }
`

export function injectWslCss(): void {
  if (document.getElementById('dshwsl-style')) return
  const style = document.createElement('style')
  style.id = 'dshwsl-style'
  style.textContent = CSS
  document.head.appendChild(style)
}