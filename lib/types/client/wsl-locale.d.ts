/**
 * Locale dictionary for the WSL workspace browser and the Windows/WSL menu.
 *
 * Mirrors @crack/dsh-archive: a standalone dict so i18n data and UI stay
 * independent; the client registers it under the 'dsh-wsl' namespace with
 * DSH's `ctx.locale` and translates via `ctx.locale.bind()` at call time, so
 * it follows the active language (zh/en) automatically without manual detection.
 */
export declare const WSL_LOCALE: {
    zh: {
        menuWindows: string;
        menuWsl: string;
        title: string;
        distro: string;
        path: string;
        up: string;
        newFolder: string;
        folderName: string;
        create: string;
        register: string;
        close: string;
        done: string;
        loading: string;
        empty: string;
        file: string;
        registered: string;
        noDistro: string;
    };
    en: {
        menuWindows: string;
        menuWsl: string;
        title: string;
        distro: string;
        path: string;
        up: string;
        newFolder: string;
        folderName: string;
        create: string;
        register: string;
        close: string;
        done: string;
        loading: string;
        empty: string;
        file: string;
        registered: string;
        noDistro: string;
    };
};
export type WslTextKey = keyof typeof WSL_LOCALE.zh;
/** The client locale namespace this plugin registers its dict under. */
export declare const DICT = "dsh-wsl";
/** LocaleRuntime surface DSH exposes on the client context (`ctx.locale`). */
export type LocaleRuntime = {
    register(namespace: string, dict: Record<string, Record<string, string>>): void | Promise<void>;
    bind(namespace: string): (key: string) => string;
    getLocale(): {
        active: string;
    };
    subscribe(fn: () => void): () => void;
};
/** Simple `{key}` placeholder replacement used by dict values (none currently). */
export declare function formatText(template: string, vars?: Record<string, string | number>): string;
/** Translates using DSH's bound `t` when available, else the browser language. */
export declare function makeT(locale?: LocaleRuntime): (key: WslTextKey) => string;
