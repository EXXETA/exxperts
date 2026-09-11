// Smoke for the web-ui message time labels (apps/web-ui/src/message-time.ts):
// the relative label under a message and the absolute date-time tooltip.
// Expectations are built with the same Intl calls on the same (undefined)
// locale, so the checks pin the bucket and the count, not one language.
//
// Run: npm run smokes -- message-time   (or tsx this file)

import { formatAbsoluteTime, formatRelativeTime } from "../../web-ui/src/message-time.js";

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
	if (condition) {
		console.log(`  ok  ${name}`);
	} else {
		failures += 1;
		console.error(`FAIL  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
	}
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// A fixed "now" in the middle of a day, so day arithmetic never straddles a boundary in the checks.
const now = new Date(2026, 8, 10, 12, 0, 0).getTime();
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const justNow = relative.format(0, "second");
const dateOnly = (ts: number) => new Date(ts).toLocaleDateString(undefined, { dateStyle: "medium" });

function expectRelative(name: string, ts: number, want: string): void {
	const got = formatRelativeTime(ts, now);
	check(name, got === want, { got, want });
}

console.log("relative time:");
expectRelative("the same instant reads as now", now, justNow);
expectRelative("59 seconds ago still reads as now", now - 59_000, justNow);
expectRelative("a timestamp slightly in the future (clock skew) reads as now, never as upcoming", now + 30_000, justNow);
expectRelative("60 seconds ago is one minute", now - MINUTE, relative.format(-1, "minute"));
expectRelative("5 minutes and some seconds ago floors to 5 minutes", now - 5 * MINUTE - 20_000, relative.format(-5, "minute"));
expectRelative("59 minutes ago stays in minutes", now - 59 * MINUTE, relative.format(-59, "minute"));
expectRelative("60 minutes ago is one hour", now - HOUR, relative.format(-1, "hour"));
expectRelative("23 hours ago stays in hours", now - 23 * HOUR - 30 * MINUTE, relative.format(-23, "hour"));
expectRelative("24 hours ago is one day (the formatter's own word for it)", now - DAY, relative.format(-1, "day"));
expectRelative("6 days ago stays in days", now - 6 * DAY - HOUR, relative.format(-6, "day"));
expectRelative("7 days ago is the plain date", now - 7 * DAY, dateOnly(now - 7 * DAY));
expectRelative("months ago is the plain date", now - 90 * DAY, dateOnly(now - 90 * DAY));
check("the plain date carries no time of day", !/\d:\d\d/.test(formatRelativeTime(now - 30 * DAY, now)), formatRelativeTime(now - 30 * DAY, now));
check("the relative label defaults `now` to the clock", formatRelativeTime(Date.now() - 3 * MINUTE) === relative.format(-3, "minute"));

console.log("absolute time:");
const stamp = new Date(2026, 8, 10, 23, 18, 0).getTime();
const absolute = formatAbsoluteTime(stamp);
check("the tooltip is the locale's medium date with a short time", absolute === new Date(stamp).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }), absolute);
check("the tooltip carries a time of day", /\d{1,2}[:.]\d\d/.test(absolute), absolute);
check("the tooltip carries the year", absolute.includes("2026"), absolute);

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nmessage time smoke passed");
