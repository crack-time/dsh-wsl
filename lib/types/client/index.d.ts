/**
 * Client entry for the WSL workspace browser.
 *
 * The native sidebar "Add workspace" button becomes a single split action:
 * clicking it opens a two-item menu —「Windows 工作区」runs the native directory
 * flow, 「WSL 工作区」opens this plugin's WSL browser (pick a distro, walk the
 * Linux filesystem, register a directory as a native workspace). No second
 * button is added, so the header keeps the native look.
 *
 * Interception: a bubble-phase listener on the native button prevents the
 * suppressed React onClick from opening the native picker immediately; the
 * "Windows" choice re-fires a synthetic click that is allowed through a
 * one-shot passthrough flag, so the native flow opens exactly as if the button
 * had been clicked directly.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis';
/** No client services are injected: this client is pure-DOM + fetch. */
export declare const inject: string[];
export declare function apply(ctx: ClientContext): void;
