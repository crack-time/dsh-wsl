/**
 * Client entry for the WSL workspace browser.
 *
 * The native sidebar "Add workspace" button is replaced (in place, same native
 * look) by an identical-look button that belongs to this plugin. Clicking it
 * shows a two-item menu —「Windows 工作区」programmatically clicks the hidden
 * native button so React's own directory flow opens exactly as usual,
 * 「WSL 工作区」opens this plugin's WSL browser. Because the visible button has
 * no React fiber and carries only this plugin's click handler, React's event
 * delegation can never hijack the click (the earlier intercept-inside-a-button
 * approach did not fire before React's root listener on this skin).
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis';
/** No client services are injected: this client is pure-DOM + fetch. */
export declare const inject: string[];
export declare function apply(ctx: ClientContext): void;
