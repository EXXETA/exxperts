// Smoke for the message box's greyed hint (apps/web-ui/src/composer-hint.ts):
// every row of the ordered list, in the Mac, Windows and touch forms; each
// state wins over every state below it, and gives way to every state above.
//
// Run: npx tsx scripts/composer-hint-smoke.ts

import { composerHint, type ComposerHintState } from "../../web-ui/src/composer-hint.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

type Keys = ComposerHintState["keys"];
const idle = (keys: Keys): ComposerHintState => ({ room: "Atlas", asToday: false, connected: true, reconnect: "idle", reconnectingTurn: false, elsewhere: false, switchingTo: null, stopping: false, stepAsks: false, answering: false, keys });

// The decided list, first match wins: what turns each row on, and its words per key form.
const ROWS: Array<{ name: string; on: Partial<ComposerHintState>; words: Record<Keys, string> }> = [
	{ name: "as today (model gone, sign-in, closed)", on: { asToday: true }, words: { mac: "Ask Atlas…", windows: "Ask Atlas…", touch: "Ask Atlas…" } },
	{ name: "the retries have stopped", on: { connected: false, reconnect: "failed" }, words: { mac: "Not connected, press Reconnect", windows: "Not connected, press Reconnect", touch: "Not connected, press Reconnect" } },
	{ name: "offline, still trying", on: { connected: false, reconnect: "reconnecting" }, words: { mac: "Waiting for the connection…", windows: "Waiting for the connection…", touch: "Waiting for the connection…" } },
	{ name: "reconnecting during an answer", on: { reconnectingTurn: true }, words: { mac: "Reconnecting…", windows: "Reconnecting…", touch: "Reconnecting…" } },
	{ name: "open in another window", on: { elsewhere: true }, words: { mac: "Ask Atlas…", windows: "Ask Atlas…", touch: "Ask Atlas…" } },
	{ name: "a model switch settling", on: { switchingTo: "Room Model" }, words: { mac: "Switching to Room Model…", windows: "Switching to Room Model…", touch: "Switching to Room Model…" } },
	{ name: "stopping", on: { stopping: true }, words: { mac: "Stopping current response…", windows: "Stopping current response…", touch: "Stopping current response…" } },
	{ name: "a step waits for an OK", on: { stepAsks: true }, words: { mac: "Sending a message denies the step above", windows: "Sending a message denies the step above", touch: "Sending denies the step above" } },
	{ name: "it writes, thinks or runs a step", on: { answering: true }, words: { mac: "Queue a message, ⌘↵ sends now", windows: "Queue a message, Ctrl+Enter sends now", touch: "Queue a message" } },
	{ name: "nothing running", on: {}, words: { mac: "Ask Atlas…", windows: "Ask Atlas…", touch: "Ask Atlas…" } },
];

for (const keys of ["mac", "windows", "touch"] as const) {
	for (const [index, row] of ROWS.entries()) {
		// Alone, the row gives its words.
		const alone = composerHint({ ...idle(keys), ...row.on });
		assert(alone === row.words[keys], `${keys}, ${row.name}: got ${JSON.stringify(alone)}`);
		// With every state below it on too, it still wins.
		const below = ROWS.slice(index + 1).reduce((state, lower) => ({ ...state, ...lower.on }), idle(keys));
		// "offline" below "the retries have stopped" would turn reconnect back on; the higher row's own fields win.
		const withBelow = composerHint({ ...below, ...row.on });
		assert(withBelow === row.words[keys], `${keys}, ${row.name} wins over every row below it: got ${JSON.stringify(withBelow)}`);
		// The row just above, on too, takes over.
		const above = ROWS[index - 1];
		if (above) {
			const withAbove = composerHint({ ...idle(keys), ...row.on, ...above.on });
			assert(withAbove === above.words[keys], `${keys}, ${above.name} wins over ${row.name}: got ${JSON.stringify(withAbove)}`);
		}
	}
	for (const hint of ROWS.map((row) => composerHint({ ...idle(keys), ...row.on }))) assert(!/working/i.test(hint), `${keys}: the box never says Working, got ${JSON.stringify(hint)}`);
}
console.log(`ok composer hint: ${ROWS.length} rows, each in the Mac, Windows and touch forms, first match wins`);
console.log("composer-hint smoke: ok");
