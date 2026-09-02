import { type LocaleRuntime } from './wsl-locale.ts';
export interface WslBrowserProps {
    onClose: () => void;
    /**
     * Called after a directory is successfully registered, with the new
     * workspace title so the host flow can navigate/dispose.
     */
    onRegistered?: (workspace: {
        workspaceId: string;
        path: string;
        title: string;
    }) => void;
    errorMessage?: string;
    /** DSH client locale runtime, for automatic zh/en switching. */
    locale?: LocaleRuntime;
}
export declare function WslBrowser({ onClose, onRegistered, locale }: WslBrowserProps): import("react").JSX.Element;
