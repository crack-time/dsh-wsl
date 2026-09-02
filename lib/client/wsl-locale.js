/**
 * Locale dictionary for the WSL workspace browser and the Windows/WSL menu.
 *
 * Mirrors @crack/dsh-archive: a standalone dict so i18n data and UI stay
 * independent; the client registers it under the 'dsh-wsl' namespace with
 * DSH's `ctx.locale` and translates via `ctx.locale.bind()` at call time, so
 * it follows the active language (zh/en) automatically without manual detection.
 */
export const WSL_LOCALE = {
    zh: {
        // Two-option menu attached to the native Add-workspace button.
        menuWindows: 'Windows 工作区',
        menuWsl: 'WSL 工作区',
        // Workspace browser dialog.
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
    },
    en: {
        // Two-option menu attached to the native Add-workspace button.
        menuWindows: 'Windows workspace',
        menuWsl: 'WSL workspace',
        // Workspace browser dialog.
        title: 'WSL workspace',
        distro: 'Distro',
        path: 'Path',
        up: '← Up',
        newFolder: 'New folder',
        folderName: 'Folder name',
        create: 'Create',
        register: 'Register as workspace',
        close: 'Close',
        done: 'Done',
        loading: 'Loading…',
        empty: '(empty directory)',
        file: 'File',
        registered: 'Registered. The workspace will appear in the sidebar.',
        noDistro: 'No usable WSL distro detected.',
    },
};
/** The client locale namespace this plugin registers its dict under. */
export const DICT = 'dsh-wsl';
/** Simple `{key}` placeholder replacement used by dict values (none currently). */
export function formatText(template, vars) {
    if (!vars)
        return template;
    return template.replace(/\{(\w+)\}/g, (_, key) => key in vars ? String(vars[key]) : `{${key}}`);
}
/** Translates using DSH's bound `t` when available, else the browser language. */
export function makeT(locale) {
    const bound = locale?.bind?.(DICT);
    if (bound)
        return (key) => bound(key);
    // No DSH locale service → follow the browser language.
    const lang = typeof navigator !== 'undefined' && navigator.language && navigator.language.toLowerCase().startsWith('zh')
        ? 'zh'
        : 'en';
    return (key) => WSL_LOCALE[lang][key] ?? key;
}
