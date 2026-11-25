// The words a usage line uses for the provider's prompt cache. Input read back
// from it is "reused", input written to it is "stored for reuse"; both are
// input, so the line's input count includes them.

/** All the input a turn sent: fresh, read from the cache and written to it. */
export function allInput(usage: { input: number; cacheRead: number; cacheWrite?: number }): number {
	return usage.input + usage.cacheRead + (usage.cacheWrite || 0);
}

/** "9.4k reused", "9.4k stored for reuse" or "9.0k reused, 455 stored"; null without a cache. */
export function cacheWords(usage: { cacheRead: number; cacheWrite?: number }, count: (tokens: number) => string): string | null {
	const read = usage.cacheRead;
	const write = usage.cacheWrite || 0;
	if (read > 0 && write > 0) return `${count(read)} reused, ${count(write)} stored`;
	if (read > 0) return `${count(read)} reused`;
	if (write > 0) return `${count(write)} stored for reuse`;
	return null;
}

/** The Wallet's one line, in place of the page, when the server could not give the usage. */
export const WALLET_UNREADABLE = "The Wallet can't show your usage right now.";

// Usage on a shared server: turns and tokens, never money. A person sees their
// own; the organisation's admin also sees everyone's together, by day and model.

/** The sidebar's name and hover text for the usage page on a shared server. */
export const SHARED_USAGE_NAV = "Usage";
export const SHARED_USAGE_NAV_HOVER = "What you've used in your rooms: turns and tokens";
/** The page's heading and its line on a shared server. */
export const SHARED_USAGE_HEADING = "Usage.";
export const SHARED_USAGE_LINE = "What you've used in your rooms.";
/** A person with no usage at all yet. */
export const SHARED_USAGE_EMPTY = "No usage yet. Send a message in one of your rooms.";
/** In place of a part whose usage the server could not give. */
export const SHARED_USAGE_UNREADABLE = "Usage can't be shown right now.";
/** Under the page: what the admin sees of everyone's usage. */
export const SHARED_USAGE_FOOTER = "Your organisation's admin sees totals for everyone together, by day and by model.";
/** A room of the person's whose name can't be shown, gone or unreadable, in place of its name. */
export const SHARED_USAGE_UNAVAILABLE_ROOM = "Room no longer available";
/** The hints on the person's own Rooms and Models cards: the organisation part has its own model choice. */
export const SHARED_USAGE_ROOMS_HINT = "Share of tokens. Select a room to scope your own usage.";
export const SHARED_USAGE_MODELS_HINT = "One entry per model. Select a model to scope your own usage.";
/** The admin's part: its title, its line, its empty state and its download's hover text. */
export const COMPANY_USAGE_TITLE = "Your organisation";
export const COMPANY_USAGE_LINE = "Everyone's usage together, by day and by model, up to yesterday.";
export const COMPANY_USAGE_EMPTY = "No usage in your organisation yet.";
export const COMPANY_USAGE_CSV_HOVER = "Download your organisation's usage by day and model as a CSV file";
