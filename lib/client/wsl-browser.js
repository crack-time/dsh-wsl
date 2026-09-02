import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * WSL workspace browser: pick a distro, walk the Linux filesystem, create a
 * folder, register the current directory as a DSH workspace (stored via its
 * `\\wsl.localhost\<distro>\...` UNC path so it shows up in the native sidebar
 * mixed with Windows workspaces).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { client } from './api.js';
const LABELS = {
    title: 'WSL 工作区',
    distro: '发行版',
    path: '路径',
    up: '← 上级',
    newFolder: '新建文件夹',
    folderName: '文件夹名称',
    create: '创建',
    register: '注册为工作区',
    close: '关闭',
    done: '完成',
    loading: '加载中…',
    empty: '（空目录）',
    file: '文件',
    registered: '已注册，可在侧边栏看到该工作区。',
    noDistro: '未检测到可用的 WSL 发行版。',
};
export function WslBrowser({ onClose, onRegistered }) {
    const [distros, setDistros] = useState([]);
    const [distro, setDistro] = useState('');
    const [path, setPath] = useState('');
    const [entries, setEntries] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [newName, setNewName] = useState('');
    const [registered, setRegistered] = useState(null);
    const darkRef = useRef(false);
    const load = useCallback(async (d, p) => {
        setLoading(true);
        setError('');
        try {
            const r = await client.list({ distro: d, path: p });
            setPath(r.path);
            setEntries(r.entries);
        }
        catch (e) {
            setError(String(e instanceof Error ? e.message : e));
        }
        finally {
            setLoading(false);
        }
    }, []);
    // Seed: distros → pick first → load its home.
    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const { distros } = await client.listDistros();
                if (!alive)
                    return;
                setDistros(distros);
                const first = distros[0];
                if (!first) {
                    setError(LABELS.noDistro);
                    return;
                }
                setDistro(first);
                const { home } = await client.home({ distro: first });
                if (alive)
                    await load(first, home || '/home');
            }
            catch (e) {
                if (alive)
                    setError(String(e instanceof Error ? e.message : e));
            }
        })();
        return () => { alive = false; };
    }, [load]);
    // Dark theme follow (best-effort): respect a class toggle on <html>.
    useEffect(() => {
        const root = document.documentElement;
        const sync = () => {
            darkRef.current = root.classList.contains('dark')
                || root.getAttribute('data-theme') === 'dark';
            const card = document.querySelector('.dshwsl-card');
            card?.classList.toggle('dark', darkRef.current);
        };
        sync();
        const obs = new MutationObserver(sync);
        obs.observe(root, { attributes: true, attributeFilter: ['class', 'data-theme'] });
        return () => obs.disconnect();
    }, []);
    const onDistroChange = async (d) => {
        setDistro(d);
        setRegistered(null);
        try {
            const { home } = await client.home({ distro: d });
            await load(d, home || '/home');
        }
        catch (e) {
            setError(String(e instanceof Error ? e.message : e));
        }
    };
    const createFolder = async () => {
        const name = newName.trim();
        if (!name || !distro || !path)
            return;
        setLoading(true);
        setError('');
        try {
            await client.create({ distro, path, name });
            setNewName('');
            await load(distro, path);
        }
        catch (e) {
            setError(String(e instanceof Error ? e.message : e));
        }
        finally {
            setLoading(false);
        }
    };
    const parent = (p) => {
        const p2 = p.replace(/\/+$/, '');
        const idx = p2.lastIndexOf('/');
        return idx <= 0 ? '/' : p2.slice(0, idx) || '/';
    };
    const register = async () => {
        if (!distro || !path)
            return;
        setLoading(true);
        setError('');
        try {
            const title = path === '/' ? distro : path.split('/').filter(Boolean).pop() || distro;
            const { workspace } = await client.register({ distro, path, title });
            setRegistered(workspace);
            onRegistered?.(workspace);
        }
        catch (e) {
            setError(String(e instanceof Error ? e.message : e));
        }
        finally {
            setLoading(false);
        }
    };
    const enter = (entry) => {
        if (!entry.isDir)
            return;
        setRegistered(null);
        void load(distro, entry.linuxPath);
    };
    return (_jsx("div", { className: "dshwsl-modal", onClick: onClose, children: _jsxs("div", { className: "dshwsl-card", onClick: (e) => e.stopPropagation(), children: [_jsxs("div", { className: "dshwsl-head", children: [_jsx("h3", { className: "dshwsl-title", children: LABELS.title }), _jsx("button", { type: "button", className: "dshwsl-close", onClick: onClose, "aria-label": "close", children: "\u00D7" })] }), _jsxs("div", { className: "dshwsl-row", children: [_jsx("span", { className: "dshwsl-label", children: LABELS.distro }), _jsx("select", { className: "dshwsl-select", value: distro, onChange: (e) => void onDistroChange(e.target.value), children: distros.map((d) => _jsx("option", { value: d, children: d }, d)) })] }), _jsxs("div", { className: "dshwsl-row", children: [_jsx("span", { className: "dshwsl-label", children: LABELS.path }), _jsx("span", { className: "dshwsl-path", title: path, children: path })] }), _jsxs("div", { className: "dshwsl-row", children: [_jsx("button", { type: "button", className: "dshwsl-up", onClick: () => void load(distro, parent(path)), children: LABELS.up }), _jsxs("div", { className: "dshwsl-btnbar", children: [_jsx("input", { className: "dshwsl-input", placeholder: LABELS.folderName, value: newName, onChange: (e) => setNewName(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter')
                                        void createFolder(); } }), _jsx("button", { type: "button", className: "dshwsl-btn", onClick: () => void createFolder(), children: LABELS.create })] })] }), (loading && entries.length === 0) && _jsx("div", { className: "dshwsl-status", children: LABELS.loading }), error && _jsx("div", { className: "dshwsl-status dshwsl-error", children: error }), registered && _jsxs("div", { className: "dshwsl-status dshwsl-ok", children: ["\u2713 ", LABELS.registered] }), _jsxs("div", { className: "dshwsl-list", children: [!loading && entries.length === 0 && !error && _jsx("div", { className: "dshwsl-empty", children: LABELS.empty }), entries.map((entry) => (_jsxs("div", { className: `dshwsl-item${entry.isDir ? '' : ' file'}`, onClick: () => enter(entry), children: [_jsx("span", { className: "dshwsl-icon", children: entry.isDir ? '📁' : '📄' }), _jsx("span", { children: entry.name })] }, entry.linuxPath)))] }), _jsxs("div", { className: "dshwsl-foot", children: [_jsx("button", { type: "button", className: "dshwsl-btn", onClick: onClose, children: registered ? LABELS.done : LABELS.close }), !registered && (_jsx("button", { type: "button", className: "dshwsl-btn primary", disabled: loading || !distro || !path, onClick: () => void register(), children: LABELS.register }))] })] }) }));
}
