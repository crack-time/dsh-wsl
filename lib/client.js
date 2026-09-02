window.__ModuleLoader__.load({ id: "@crack/dsh-wsl", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
let react = require("react");
let react_dom_client = require("react-dom/client");
let react_jsx_runtime = require("react/jsx-runtime");

//#region lib/client/api.js
/**
* Small JSON client for the WSL workspace host API.
*/
const API = "/plugins/@crack/dsh-wsl/api";
async function parseError(status, body) {
	try {
		const j = JSON.parse(body);
		if (j.error) return j.error;
	} catch {}
	return `HTTP ${status}`;
}
async function api(path, init) {
	const res = await fetch(API + path, {
		headers: { "content-type": "application/json" },
		...init
	});
	const text = await res.text();
	if (!res.ok) throw new Error(await parseError(res.status, text));
	return text ? JSON.parse(text) : {};
}
const client = {
	listDistros() {
		return api("/distros");
	},
	home(data) {
		return api("/home", {
			method: "POST",
			body: JSON.stringify(data)
		});
	},
	list(data) {
		return api("/list", {
			method: "POST",
			body: JSON.stringify(data)
		});
	},
	create(data) {
		return api("/create", {
			method: "POST",
			body: JSON.stringify(data)
		});
	},
	register(data) {
		return api("/register", {
			method: "POST",
			body: JSON.stringify(data)
		});
	}
};

//#endregion
//#region lib/client/wsl-browser.js
/**
* WSL workspace browser: pick a distro, walk the Linux filesystem, create a
* folder, register the current directory as a DSH workspace (stored via its
* `\\wsl.localhost\<distro>\...` UNC path so it shows up in the native sidebar
* mixed with Windows workspaces).
*/
const LABELS = {
	title: "WSL 工作区",
	distro: "发行版",
	path: "路径",
	up: "← 上级",
	newFolder: "新建文件夹",
	folderName: "文件夹名称",
	create: "创建",
	register: "注册为工作区",
	close: "关闭",
	done: "完成",
	loading: "加载中…",
	empty: "（空目录）",
	file: "文件",
	registered: "已注册，可在侧边栏看到该工作区。",
	noDistro: "未检测到可用的 WSL 发行版。"
};
function WslBrowser({ onClose, onRegistered }) {
	const [distros, setDistros] = (0, react.useState)([]);
	const [distro, setDistro] = (0, react.useState)("");
	const [path, setPath] = (0, react.useState)("");
	const [entries, setEntries] = (0, react.useState)([]);
	const [loading, setLoading] = (0, react.useState)(false);
	const [error, setError] = (0, react.useState)("");
	const [newName, setNewName] = (0, react.useState)("");
	const [registered, setRegistered] = (0, react.useState)(null);
	const darkRef = (0, react.useRef)(false);
	const load = (0, react.useCallback)(async (d, p) => {
		setLoading(true);
		setError("");
		try {
			const r = await client.list({
				distro: d,
				path: p
			});
			setPath(r.path);
			setEntries(r.entries);
		} catch (e) {
			setError(String(e instanceof Error ? e.message : e));
		} finally {
			setLoading(false);
		}
	}, []);
	(0, react.useEffect)(() => {
		let alive = true;
		(async () => {
			try {
				const { distros } = await client.listDistros();
				if (!alive) return;
				setDistros(distros);
				const first = distros[0];
				if (!first) {
					setError(LABELS.noDistro);
					return;
				}
				setDistro(first);
				const { home } = await client.home({ distro: first });
				if (alive) await load(first, home || "/home");
			} catch (e) {
				if (alive) setError(String(e instanceof Error ? e.message : e));
			}
		})();
		return () => {
			alive = false;
		};
	}, [load]);
	(0, react.useEffect)(() => {
		const root = document.documentElement;
		const sync = () => {
			darkRef.current = root.classList.contains("dark") || root.getAttribute("data-theme") === "dark";
			document.querySelector(".dshwsl-card")?.classList.toggle("dark", darkRef.current);
		};
		sync();
		const obs = new MutationObserver(sync);
		obs.observe(root, {
			attributes: true,
			attributeFilter: ["class", "data-theme"]
		});
		return () => obs.disconnect();
	}, []);
	const onDistroChange = async (d) => {
		setDistro(d);
		setRegistered(null);
		try {
			const { home } = await client.home({ distro: d });
			await load(d, home || "/home");
		} catch (e) {
			setError(String(e instanceof Error ? e.message : e));
		}
	};
	const createFolder = async () => {
		const name = newName.trim();
		if (!name || !distro || !path) return;
		setLoading(true);
		setError("");
		try {
			await client.create({
				distro,
				path,
				name
			});
			setNewName("");
			await load(distro, path);
		} catch (e) {
			setError(String(e instanceof Error ? e.message : e));
		} finally {
			setLoading(false);
		}
	};
	const parent = (p) => {
		const p2 = p.replace(/\/+$/, "");
		const idx = p2.lastIndexOf("/");
		return idx <= 0 ? "/" : p2.slice(0, idx) || "/";
	};
	const register = async () => {
		if (!distro || !path) return;
		setLoading(true);
		setError("");
		try {
			const title = path === "/" ? distro : path.split("/").filter(Boolean).pop() || distro;
			const { workspace } = await client.register({
				distro,
				path,
				title
			});
			setRegistered(workspace);
			onRegistered?.(workspace);
		} catch (e) {
			setError(String(e instanceof Error ? e.message : e));
		} finally {
			setLoading(false);
		}
	};
	const enter = (entry) => {
		if (!entry.isDir) return;
		setRegistered(null);
		load(distro, entry.linuxPath);
	};
	return (0, react_jsx_runtime.jsx)("div", {
		className: "dshwsl-modal",
		onClick: onClose,
		children: (0, react_jsx_runtime.jsxs)("div", {
			className: "dshwsl-card",
			onClick: (e) => e.stopPropagation(),
			children: [
				(0, react_jsx_runtime.jsxs)("div", {
					className: "dshwsl-head",
					children: [(0, react_jsx_runtime.jsx)("h3", {
						className: "dshwsl-title",
						children: LABELS.title
					}), (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "dshwsl-close",
						onClick: onClose,
						"aria-label": "close",
						children: "×"
					})]
				}),
				(0, react_jsx_runtime.jsxs)("div", {
					className: "dshwsl-row",
					children: [(0, react_jsx_runtime.jsx)("span", {
						className: "dshwsl-label",
						children: LABELS.distro
					}), (0, react_jsx_runtime.jsx)("select", {
						className: "dshwsl-select",
						value: distro,
						onChange: (e) => void onDistroChange(e.target.value),
						children: distros.map((d) => (0, react_jsx_runtime.jsx)("option", {
							value: d,
							children: d
						}, d))
					})]
				}),
				(0, react_jsx_runtime.jsxs)("div", {
					className: "dshwsl-row",
					children: [(0, react_jsx_runtime.jsx)("span", {
						className: "dshwsl-label",
						children: LABELS.path
					}), (0, react_jsx_runtime.jsx)("span", {
						className: "dshwsl-path",
						title: path,
						children: path
					})]
				}),
				(0, react_jsx_runtime.jsxs)("div", {
					className: "dshwsl-row",
					children: [(0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "dshwsl-up",
						onClick: () => void load(distro, parent(path)),
						children: LABELS.up
					}), (0, react_jsx_runtime.jsxs)("div", {
						className: "dshwsl-btnbar",
						children: [(0, react_jsx_runtime.jsx)("input", {
							className: "dshwsl-input",
							placeholder: LABELS.folderName,
							value: newName,
							onChange: (e) => setNewName(e.target.value),
							onKeyDown: (e) => {
								if (e.key === "Enter") createFolder();
							}
						}), (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dshwsl-btn",
							onClick: () => void createFolder(),
							children: LABELS.create
						})]
					})]
				}),
				loading && entries.length === 0 && (0, react_jsx_runtime.jsx)("div", {
					className: "dshwsl-status",
					children: LABELS.loading
				}),
				error && (0, react_jsx_runtime.jsx)("div", {
					className: "dshwsl-status dshwsl-error",
					children: error
				}),
				registered && (0, react_jsx_runtime.jsxs)("div", {
					className: "dshwsl-status dshwsl-ok",
					children: ["✓ ", LABELS.registered]
				}),
				(0, react_jsx_runtime.jsxs)("div", {
					className: "dshwsl-list",
					children: [!loading && entries.length === 0 && !error && (0, react_jsx_runtime.jsx)("div", {
						className: "dshwsl-empty",
						children: LABELS.empty
					}), entries.map((entry) => (0, react_jsx_runtime.jsxs)("div", {
						className: `dshwsl-item${entry.isDir ? "" : " file"}`,
						onClick: () => enter(entry),
						children: [(0, react_jsx_runtime.jsx)("span", {
							className: "dshwsl-icon",
							children: entry.isDir ? "📁" : "📄"
						}), (0, react_jsx_runtime.jsx)("span", { children: entry.name })]
					}, entry.linuxPath))]
				}),
				(0, react_jsx_runtime.jsxs)("div", {
					className: "dshwsl-foot",
					children: [(0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "dshwsl-btn",
						onClick: onClose,
						children: registered ? LABELS.done : LABELS.close
					}), !registered && (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "dshwsl-btn primary",
						disabled: loading || !distro || !path,
						onClick: () => void register(),
						children: LABELS.register
					})]
				})
			]
		})
	});
}

//#endregion
//#region lib/client/wsl-css.js
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
const DSW_FONT = "var(--dsw-font-family, -apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Hiragino Sans GB\", \"Microsoft YaHei\", \"Helvetica Neue\", Helvetica, Arial, sans-serif)";
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
  flex:1; font-family: var(--dsw-font-markdown-code, ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Mono", Consolas, "Microsoft YaHei", monospace); font-size:12px;
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
`;
function injectWslCss() {
	if (document.getElementById("dshwsl-style")) return;
	const style = document.createElement("style");
	style.id = "dshwsl-style";
	style.textContent = CSS;
	document.head.appendChild(style);
}

//#endregion
//#region lib/client/index.js
/** No client services are injected: this client is pure-DOM + fetch. */
const inject = [];
const NATIVE_ADD_LABELS = [
	"添加工作区",
	"Add workspace",
	"Add workspace…",
	"Add workspace",
	"Add Workspace"
];
function mountBrowser() {
	const host = document.createElement("div");
	host.dataset.dshwslBrowser = "";
	document.body.appendChild(host);
	let root = null;
	let closed = false;
	const cleanup = () => {
		if (closed) return;
		closed = true;
		try {
			root?.unmount();
		} catch {}
		root = null;
		host.remove();
	};
	root = (0, react_dom_client.createRoot)(host);
	root.render((0, react.createElement)(WslBrowser, { onClose: cleanup }));
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
	const backdrop = document.createElement("div");
	backdrop.className = "dshwsl-menu-backdrop";
	const host = document.createElement("div");
	host.className = "dshwsl-menu-wrap";
	host.style.top = `${Math.round(rect.bottom + 6)}px`;
	host.style.left = `${Math.round(rect.left)}px`;
	const menu = document.createElement("div");
	menu.className = "dshwsl-menu";
	const item = (label, onClick) => {
		const b = document.createElement("button");
		b.type = "button";
		b.className = "dshwsl-menu-item";
		b.textContent = label;
		b.addEventListener("click", (e) => {
			e.stopPropagation();
			closeMenu();
			onClick();
		});
		return b;
	};
	menu.appendChild(item("Windows 工作区", onWindows));
	menu.appendChild(item("WSL 工作区", onWsl));
	host.appendChild(menu);
	const onKey = (e) => {
		if (e.key === "Escape") closeMenu();
	};
	const cleanup = () => {
		host.remove();
		backdrop.remove();
		document.removeEventListener("keydown", onKey);
	};
	backdrop.addEventListener("click", () => closeMenu());
	document.addEventListener("keydown", onKey);
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
	if (!(t instanceof Element)) return null;
	const btn = t.closest("button[aria-label]");
	if (!btn) return null;
	const label = (btn.getAttribute("aria-label") || "").trim();
	if (!NATIVE_ADD_LABELS.includes(label)) return null;
	if (passthrough()) return null;
	e.preventDefault();
	e.stopPropagation();
	e.stopImmediatePropagation();
	return btn;
}
function apply(ctx) {
	injectWslCss();
	let passthrough = false;
	const onCaptureClick = (e) => {
		const btn = interceptAddButton(e, () => passthrough);
		if (!btn) return;
		showMenu(btn, () => {
			passthrough = true;
			btn.click();
			setTimeout(() => {
				passthrough = false;
			}, 0);
		}, () => {
			browserCleanup?.();
			browserCleanup = mountBrowser();
		});
	};
	document.addEventListener("click", onCaptureClick, true);
	try {
		ctx.effect(() => () => {
			document.removeEventListener("click", onCaptureClick, true);
			closeMenu();
			browserCleanup?.();
			browserCleanup = null;
		}, "dsh-wsl: workspace browser");
	} catch {}
}

//#endregion
exports.apply = apply;
exports.inject = inject;
return module.exports; } });
//# sourceMappingURL=client.js.map