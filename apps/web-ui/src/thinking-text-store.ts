// The words of each thinking row, kept outside React state: a thinking delta
// arrives many times a second, and putting it in the chat's items would
// re-render the whole room for each one. Only the row that shows the words
// subscribes to them. The room clears the store when it leaves a conversation,
// and nothing here is ever saved: after a reload an answer shows no thinking.
import { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type UIEvent } from "react";
import type { ChatItem } from "./types";

type ThinkingItem = Extract<ChatItem, { kind: "thinking" }>;

const texts = new Map<string, string>();
const listeners = new Map<string, Set<() => void>>();

function changed(id: string) {
	for (const listener of listeners.get(id) ?? []) listener();
}

export const thinkingTextStore = {
	get(id: string): string {
		return texts.get(id) ?? "";
	},
	append(id: string, delta: string) {
		if (!delta) return;
		texts.set(id, (texts.get(id) ?? "") + delta);
		changed(id);
	},
	set(id: string, text: string) {
		if (texts.get(id) === text) return;
		texts.set(id, text);
		changed(id);
	},
	subscribe(id: string, listener: () => void): () => void {
		const set = listeners.get(id) ?? new Set();
		set.add(listener);
		listeners.set(id, set);
		return () => {
			set.delete(listener);
			if (set.size === 0) listeners.delete(id);
		};
	},
	clear() {
		const ids = [...texts.keys()];
		texts.clear();
		for (const id of ids) changed(id);
	},
};

/**
 * Thinking with nothing shown between, drawn as one row: the blocks of one
 * answer, or a thought a retry cut short and the retry's own. The row's time
 * is theirs added up; opened,
 * it shows each thought in order.
 */
export type ThoughtGroup = readonly ThinkingItem[];

// The words a thought may show: none for a redacted block.
function shownWords(item: ThinkingItem): string {
	return item.redacted ? "" : thinkingTextStore.get(item.id).trim();
}

/** One thought of a row, opened: its words, and whether they are still being written. */
export type Thought = { words: string; live: boolean };

/** The row's thoughts that have words, in order. Only the group's last thought can be live, and only while it runs. */
export function useThoughtWords(group: ThoughtGroup): readonly Thought[] {
	// One snapshot the store can compare: the thoughts' words as a JSON array, which no character in a thought can split.
	const read = () => JSON.stringify(group.map(shownWords));
	const ids = group.map((item) => item.id).join(" ");
	const subscribe = useCallback((listener: () => void) => {
		const stops = ids.split(" ").map((id) => thinkingTextStore.subscribe(id, listener));
		return () => stops.forEach((stop) => stop());
	}, [ids]);
	const joined = useSyncExternalStore(subscribe, read, read);
	const live = group[group.length - 1]?.ms === undefined;
	return useMemo(() => {
		const all = JSON.parse(joined) as string[];
		return all.flatMap((words, index) => (words ? [{ words, live: live && index === all.length - 1 }] : []));
	}, [joined, live]);
}

/** A row's time: still thinking while its last thought is; the ended thoughts' times added up, and `since` for the one still running. */
export function thoughtTime(group: ThoughtGroup): { live: boolean; ms: number; since?: number } {
	const last = group[group.length - 1];
	const ms = group.reduce((sum, item) => sum + (item.ms ?? 0), 0);
	return last.ms === undefined ? { live: true, ms, since: last.ts } : { live: false, ms };
}

// Each thought the person opened, and where they read in it. One rule for
// every part of the page: a thought the person opened is hidden only by the
// person. A row drawn anew (its stretch turning into a work card) comes back
// open where they read; a card does not fold over it, the row cap and the
// long turn's fold leave it out. Ids are never reused, so leaving a
// conversation leaves them be.
//
// Where they read is the block of the thought at the top of its box and how
// far into that block: in pixels while the box keeps its width (a paragraph
// that grows below them does not move them), as a share of the block in a box
// of another width (the card's row is narrower, its letters smaller), which
// then shows the same words.
type Reading = { pinned: boolean; block: number; into: number; px: number; width: number };
const reading = new Map<string, Reading>();
const readingListeners = new Set<() => void>();

/** A thought the person opened is open now. */
export function isThoughtOpen(id: string): boolean {
	return reading.has(id);
}

function subscribeReading(listener: () => void): () => void {
	readingListeners.add(listener);
	return () => readingListeners.delete(listener);
}

// The thought's blocks: its paragraphs, lists, rules, code and the like, through the
// wrapping divs of each thought's document. A paragraph is a block even with no element inside.
function blocksOf(root: Element): HTMLElement[] {
	return [...root.children].flatMap((child) => (child.tagName === "DIV" && child.children.length > 0 ? blocksOf(child) : [child as HTMLElement]));
}

function topOf(box: HTMLElement, el: HTMLElement): number {
	return el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
}

function readingAt(box: HTMLElement): Reading {
	const pinned = box.scrollHeight - box.scrollTop - box.clientHeight < 8;
	const blocks = blocksOf(box);
	for (let index = 0; index < blocks.length; index++) {
		const top = topOf(box, blocks[index]);
		const height = blocks[index].offsetHeight;
		// Negative in the gap above a block: the gap scales with it, near enough.
		if (top + height > box.scrollTop) return { pinned, block: index, into: height > 0 ? (box.scrollTop - top) / height : 0, px: box.scrollTop - top, width: box.clientWidth };
	}
	return { pinned, block: 0, into: 0, px: 0, width: box.clientWidth };
}

function scrollTo(box: HTMLElement, at: Reading): void {
	if (at.pinned) {
		box.scrollTop = box.scrollHeight;
		return;
	}
	// At or above the first block's top is the start: the box's own padding shows too, clear of its fading edge.
	if (at.block === 0 && at.into <= 0 && at.px <= 0) {
		box.scrollTop = 0;
		return;
	}
	const block = blocksOf(box)[at.block];
	const into = box.clientWidth === at.width ? at.px : at.into * (block?.offsetHeight ?? 0);
	box.scrollTop = block ? Math.max(0, topOf(box, block) + into) : 0;
}

/**
 * The whole thought behind a click. Opened while it thinks, it follows the
 * newest line until the person scrolls up in it, and again once they scroll
 * back to its end; opened after it ended, it starts at the top, to be read
 * from the start. `words` empty: nothing to open.
 */
export function useOpenThought<T extends HTMLElement>(id: string, words: readonly Thought[], live: boolean) {
	const isOpen = () => reading.has(id);
	const open = useSyncExternalStore(subscribeReading, isOpen, isOpen);
	const ref = useRef<T>(null);
	// Where the page itself last put the box, so its own scroll (or the browser's clamp of it) is not read as the person's.
	const placed = useRef<number | null>(null);
	const toggle = () => {
		if (reading.has(id)) reading.delete(id);
		else reading.set(id, { pinned: live, block: 0, into: 0, px: 0, width: 0 });
		for (const listener of [...readingListeners]) listener();
	};
	// Back where the person left it on a row drawn anew, and whenever what it shows changes height:
	// new words, the end of the thinking, a diagram drawn after its words, a narrower window.
	useLayoutEffect(() => {
		const box = ref.current;
		if (!box || !open) return;
		const restore = () => {
			const at = reading.get(id);
			if (!at) return;
			scrollTo(box, at);
			placed.current = box.scrollTop;
		};
		restore();
		const watch = new ResizeObserver(restore);
		for (const child of box.children) watch.observe(child);
		return () => watch.disconnect();
	}, [id, words, open, live]);
	// Only the person's own scroll changes where they read: not one in a box that has nothing to scroll (it fits, as when the window widens), nor the page's own.
	const onScroll = (event: UIEvent<T>) => {
		const box = event.currentTarget;
		if (!reading.has(id) || box.scrollHeight <= box.clientHeight + 1) return;
		if (placed.current !== null && Math.abs(box.scrollTop - placed.current) < 1) return;
		placed.current = null;
		reading.set(id, readingAt(box));
	};
	return { open: open && words.length > 0, toggle, ref, onScroll };
}

/** "Thought for 12 s", "Thought for 1 min 5 s", or "Thought briefly" for a short block with words. */
export function thoughtForText(ms: number, hasText: boolean): string {
	if (ms < 1000 && hasText) return "Thought briefly";
	const seconds = Math.max(1, Math.round(ms / 1000));
	return seconds < 60 ? `Thought for ${seconds} s` : `Thought for ${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}
