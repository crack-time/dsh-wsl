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
}
export declare function WslBrowser({ onClose, onRegistered }: WslBrowserProps): import("react").JSX.Element;
