/**
 * The time a message shows in its action row, and the tooltip on it: a short
 * relative label ("5 minutes ago", "yesterday") that turns into the plain
 * date once it is a week old, with the full date and time on hover. Pure over
 * epoch milliseconds so it can be checked without a DOM; the locale comes from
 * the browser (undefined), like every other date the app shows.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Relative label for `ts` as seen at `now`. Under a minute: the locale's own
 * word for the present ("now"). Then minutes, hours and days up to six days ("yesterday" comes from the
 * formatter); seven days and older read as the date alone. A timestamp in
 * the future (clock skew) counts as now rather than "in 3 minutes".
 */
export function formatRelativeTime(ts: number, now: number = Date.now()): string {
	const elapsed = Math.max(0, now - ts);
	if (elapsed >= 7 * DAY) return new Date(ts).toLocaleDateString(undefined, { dateStyle: "medium" });
	const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
	if (elapsed < MINUTE) return relative.format(0, "second");
	if (elapsed < HOUR) return relative.format(-Math.floor(elapsed / MINUTE), "minute");
	if (elapsed < DAY) return relative.format(-Math.floor(elapsed / HOUR), "hour");
	return relative.format(-Math.floor(elapsed / DAY), "day");
}

/** Full date and time for the tooltip: "Sep 10, 2026, 11:18 PM" in an English locale. */
export function formatAbsoluteTime(ts: number): string {
	return new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
