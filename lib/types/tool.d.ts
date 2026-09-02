import type { Context } from '@deepseek-ai/cordis';
export declare const name = "tool-wsl";
export declare const inject: string[];
export declare function apply(_ctx: Context, config?: {
    distro?: string;
    enableRunInBackground?: boolean;
}): void;
