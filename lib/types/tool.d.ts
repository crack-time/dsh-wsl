import type { Context } from '@deepseek-ai/cordis';
export declare const name = "tool-wsl";
export declare const inject: string[];
export declare function apply(_ctx: Context, config?: {
    distro?: string;
    enableRunInBackground?: boolean;
    /** 'bridge' (default) spawns wsl.exe per call; 'daemon' sends commands to a resident WSL exec-server. */
    runtime?: 'bridge' | 'daemon';
    /** Connection target when runtime === 'daemon'. host/port default to the localhost-forwarded WSL2 target. */
    daemon?: {
        host?: string;
        port?: number;
        autoStart?: boolean;
    };
}): void;
