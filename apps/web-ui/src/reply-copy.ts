import type { ChatItem } from "./types";

/** What the transcript hangs under a reply's last segment: the copy text and the reply's start. */
export interface ReplyCopyTarget {
	text: string;
	/** When the reply began: the earliest `ts` among its assistant segments; absent when none carries one. */
	ts?: number;
}

/**
 * Where the one copy button of each reply goes, and what it copies:
 * assistant item id → the whole reply's text plus the time the reply began.
 * Pure over the raw items array, so the transcript can group tool chips
 * however it likes without moving the button.
 *
 * A reply is the run of items after a user item up to the next user item;
 * items before the first user item (a greeting) form a reply of their own.
 * The transcript keeps one assistant item per text segment, so a reply that
 * calls tools between its paragraphs is several items — and used to show a
 * copy button under each. The button sits under the LAST non-empty assistant
 * segment and copies every non-empty segment of the reply, including the
 * lead-in written before the first tool call, joined by a blank line. Tool
 * calls, approvals, consult and task items and system lines are not part of
 * the answer and are left out.
 *
 * A reply gets its button only once it has settled: no segment still
 * streaming, no tool still running, and — for the last reply — no turn in
 * flight. Otherwise the button would flash under one segment and jump to the
 * next as the answer keeps growing.
 */
// A picture in a reply is written as `![alt](url)` with a link that only
// resolves inside the app, so the copied text leaves pictures out the way it
// leaves tool cards out, and the blank lines the picture stood between
// collapse. Code is copied exactly as shown: fenced blocks and inline code
// spans are left untouched, so a block's deliberate blank lines and an
// example of the image syntax itself survive.
const MARKDOWN_IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const CODE_SEGMENT = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g;
export function copyableReplyText(text: string): string {
	return text
		.split(CODE_SEGMENT)
		.map((segment, index) => (index % 2 === 1 ? segment : segment.replace(MARKDOWN_IMAGE, "").replace(/\n{3,}/g, "\n\n")))
		.join("")
		.trim();
}

export function replyCopyTargets(items: ChatItem[], busy = false): Map<string, ReplyCopyTarget> {
	const targets = new Map<string, ReplyCopyTarget>();
	let texts: string[] = [];
	let lastTextId: string | null = null;
	let settled = true;
	let startedAt: number | undefined;
	const closeReply = (last: boolean) => {
		if (lastTextId && settled && !(last && busy)) targets.set(lastTextId, { text: texts.join("\n\n"), ...(startedAt === undefined ? {} : { ts: startedAt }) });
		texts = [];
		lastTextId = null;
		settled = true;
		startedAt = undefined;
	};
	for (const item of items) {
		if (item.kind === "user") {
			closeReply(false);
		} else if (item.kind === "assistant") {
			if (item.streaming) settled = false;
			if (typeof item.ts === "number" && (startedAt === undefined || item.ts < startedAt)) startedAt = item.ts;
			const text = copyableReplyText(String(item.text ?? ""));
			if (text) {
				texts.push(text);
				lastTextId = item.id;
			}
		} else if (item.kind === "tool" && item.status === "running") {
			settled = false;
		}
	}
	closeReply(true);
	return targets;
}
