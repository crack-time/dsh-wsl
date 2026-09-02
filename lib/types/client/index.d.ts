/**
 * Client entry for the WSL workspace browser.
 *
 * Injects a "＋ WSL 工作区" button right after the native Add-workspace button
 * in the sidebar (DOM-injected like dsh-archive: the native workspace list has
 * no public slot contract for sibling header actions, so we seat next to the
 * found button). Clicking it mounts the WSL browser as a modal overlay via
 * React createRoot; style + shell are self-contained.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis';
/** No client services are injected: this client is pure-DOM + fetch. */
export declare const inject: string[];
export declare function apply(ctx: ClientContext): void;
