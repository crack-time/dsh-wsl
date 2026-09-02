export interface DirEntry {
    name: string;
    linuxPath: string;
    isDir: boolean;
    hidden: boolean;
}
export declare const client: {
    listDistros(): Promise<{
        distros: string[];
    }>;
    home(data: {
        distro: string;
    }): Promise<{
        home: string;
    }>;
    list(data: {
        distro: string;
        path: string;
    }): Promise<{
        path: string;
        entries: DirEntry[];
    }>;
    create(data: {
        distro: string;
        path: string;
        name: string;
    }): Promise<{
        ok: boolean;
    }>;
    register(data: {
        distro: string;
        path: string;
        title?: string;
    }): Promise<{
        workspace: {
            workspaceId: string;
            path: string;
            title: string;
        };
    }>;
};
