/**
 * Client entry for the WSL workspace browser.
 *
 * The native sidebar "Add workspace" button becomes a single split action:
 * its click is intercepted in the document CAPTURE phase (before React's
 * root-container listener can open the native picker) and a two-item menu is
 * shown —「Windows 工作区」replays the click through a one-shot passthrough so
 * the native directory flow opens exactly as usual, 「WSL 工作区」opens this
 * plugin's WSL browser. No second button is added; the header keeps the native
 * look.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis';
/** No client services are injected: this client is pure-DOM + fetch. */
export declare const inject: string[];
export declare function apply(ctx: ClientContext): void;
