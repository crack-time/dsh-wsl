import type { Context } from '@deepseek-ai/cordis';
declare const inject: string[];
interface DirEntry {
    name: string;
    linuxPath: string;
    isDir: boolean;
    hidden: boolean;
}
/** Host apply: register the WSL workspace browser API. */
declare function apply(ctx: Context): Promise<void>;
export { apply, inject };
export type { DirEntry };
