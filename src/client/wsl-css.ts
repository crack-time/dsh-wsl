/**
 * WSL workspace browser styles, injected once as a <style> with a prefixed
 * class namespace (nothing in the native skin carries class names "dshwsl-*").
 */
const CSS = `
.dshwsl-modal {
  position: fixed; inset: 0; z-index: 9999;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,0.35);
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
}
.dshwsl-card {
  width: min(560px, 92vw); max-height: 82vh; overflow: auto;
  background: var(--modal-background, #fff);
  color: var(--modal-foreground, #1f2328);
  border: 1px solid var(--modal-border, #d0d7de);
  border-radius: 12px;
  box-shadow: 0 12px 40px rgba(0,0,0,0.25);
  padding: 16px 18px;
}
.dshwsl-card.dark { background:#0d1117; color:#e6edf3; border-color:#30363d; }
.dshwsl-head { display:flex; align-items:center; justify-content:space-between; margin-bottom: 12px; }
.dshwsl-title { font-size: 15px; font-weight: 600; margin: 0; }
.dshwsl-close { border:0; background:transparent; font-size:18px; line-height:1; cursor:pointer; color:inherit; padding:4px 6px; border-radius:6px; }
.dshwsl-close:hover { background: rgba(128,128,128,0.18); }
.dshwsl-row { display:flex; gap:8px; align-items:center; margin: 8px 0; }
.dshwsl-label { font-size:12px; opacity:.75; min-width: 72px; }
.dshwsl-select, .dshwsl-input {
  flex:1; padding:6px 8px; border-radius:6px;
  border:1px solid var(--modal-border,#d0d7de); background:var(--modal-input,#fff); color:inherit; font:inherit; font-size:13px;
}
.dshwsl-input { min-width: 0; }
.dshwsl-path { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size:12.5px; background:rgba(128,128,128,.10); border-radius:6px; padding:6px 9px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; width:100%; }
.dshwsl-list { margin: 8px 0; border:1px solid var(--modal-border,#d0d7de); border-radius:8px; max-height: 300px; overflow:auto; }
.dshwsl-item { display:flex; align-items:center; gap:8px; padding:6px 10px; cursor:pointer; font-size:13.5px; border-radius:6px; }
.dshwsl-item:hover { background: rgba(128,128,128,.12); }
.dshwsl-item.file { cursor: default; opacity: .65; }
.dshwsl-icon { width: 15px; text-align: center; flex: none; }
.dshwsl-up { cursor:pointer; font-size:13px; padding: 4px 8px; border-radius:6px; border:1px solid var(--modal-border,#d0d7de); background:transparent; color:inherit; }
.dshwsl-up:hover { background: rgba(128,128,128,.12); }
.dshwsl-status { font-size:12.5px; margin: 4px 0; }
.dshwsl-error { color:#e5534b; }
.dshwsl-ok { color:#1a7f37; }
.dshwsl-foot { display:flex; justify-content:flex-end; gap:8px; margin-top: 12px; }
.dshwsl-btn { border:1px solid var(--modal-border,#d0d7de); background:transparent; color:inherit; padding:7px 14px; border-radius:7px; cursor:pointer; font-size:13.5px; }
.dshwsl-btn:hover { background: rgba(128,128,128,.12); }
.dshwsl-btn.primary { background:#0969da; border-color:#0969da; color:#fff; }
.dshwsl-btn.primary:hover { background:#0a5fc7; }
.dshwsl-btn.primary:disabled { opacity:.5; cursor:default; }
.dshwsl-btnbar { display:flex; gap:6px; }
.dshwsl-empty { text-align:center; color:inherit; opacity:.5; padding:18px; font-size:13px; }

/* Two-option menu attached to the native Add-workspace button. */
.dshwsl-menu-backdrop { position: fixed; inset:0; z-index: 9997; background: transparent; }
.dshwsl-menu-wrap { position: fixed; z-index: 9998; }
.dshwsl-menu {
  min-width: 168px;
  background: var(--modal-background, #fff);
  color: var(--modal-foreground, #1f2328);
  border: 1px solid var(--modal-border, #d0d7de);
  border-radius: 8px;
  box-shadow: 0 6px 24px rgba(0,0,0,0.18);
  padding: 4px;
}
.dshwsl-menu.dark { background:#0d1117; color:#e6edf3; border-color:#30363d; }
.dshwsl-menu-item {
  display:block; width:100%; text-align:left;
  border:0; background:transparent; color:inherit;
  padding: 7px 10px; border-radius: 5px; cursor:pointer;
  font-size: 13.5px; font-family: inherit;
}
.dshwsl-menu-item:hover { background: rgba(128,128,128,0.14); }
.dshwsl-menu-item + .dshwsl-menu-item { margin-top: 2px; }
`

export function injectWslCss(): void {
  if (document.getElementById('dshwsl-style')) return
  const style = document.createElement('style')
  style.id = 'dshwsl-style'
  style.textContent = CSS
  document.head.appendChild(style)
}