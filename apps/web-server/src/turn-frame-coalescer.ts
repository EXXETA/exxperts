// Merges a turn's small frames before they are serialised and sent. A provider
// sends one text delta every few milliseconds, and a thinking or tool-call
// phase sends hundreds of small progress frames; each one used to be its own
// socket message and its own entry in the reattach buffer.
//
// What merges:
//   - consecutive text deltas of one block become one delta with the strings
//     joined, so the frame looks exactly like a single delta to every reader;
//   - consecutive thinking deltas of one block, the same way;
//   - consecutive previews of one tool call being written: the newest stands
//     for them all, since each one carries the whole label so far;
//   - consecutive type-only frames (progress with nothing to say) collapse
//     to the first of them.
// When it sends:
//   - a merge-able frame that arrives with no window open goes out at once
//     and opens a window; so do text or thinking words inside a window that
//     has not just sent their kind, so the first words never wait behind a
//     text_start;
//   - what arrives inside the window waits for its end, then the window
//     reopens if anything was sent;
//   - pending text reaching MAX_PENDING_CHARS goes out at once;
//   - any other frame sends what is pending first, so an approval card, a
//     message end, the turn's end or an error never overtakes text written
//     before it. `flush` does the same for frames that bypass the coalescer.

export const COALESCE_WINDOW_MS = 40;
export const MAX_PENDING_CHARS = 8 * 1024;

const HEARTBEAT_KINDS = new Set(["text_start", "thinking_start", "thinking_delta", "thinking_end", "toolcall_start", "toolcall_delta", "toolcall_end"]);

type DeltaKind = "text_delta" | "thinking_delta";
const isDelta = (kind: MergeKey["kind"] | null): kind is DeltaKind => kind === "text_delta" || kind === "thinking_delta";

/** Where a frame may merge: a delta of one block, a tool call's preview, or a run of type-only frames. */
type MergeKey = { kind: DeltaKind | "toolcall_preview"; contentIndex: unknown } | { kind: "heartbeat" };

function mergeKeyOf(frame: unknown): MergeKey | null {
	const f = frame as { type?: unknown; event?: { type?: unknown; assistantMessageEvent?: unknown } } | null;
	if (f?.type !== "event" || f.event?.type !== "message_update") return null;
	const update = f.event.assistantMessageEvent as { type?: unknown; contentIndex?: unknown; delta?: unknown; preview?: unknown } | undefined;
	if ((update?.type === "text_delta" || update?.type === "thinking_delta") && typeof update.delta === "string") return { kind: update.type, contentIndex: update.contentIndex };
	if (update?.type === "toolcall_delta" && update.preview && typeof update.preview === "object") return { kind: "toolcall_preview", contentIndex: update.contentIndex };
	// A frame the projection cut to its kind (web-client-event-projection.ts): one stands for a run. One that still says something never collapses.
	if (typeof update?.type === "string" && HEARTBEAT_KINDS.has(update.type) && Object.keys(update).every((key) => key === "type" || key === "contentIndex")) return { kind: "heartbeat" };
	return null;
}

function sameKey(a: MergeKey, b: MergeKey): boolean {
	return a.kind === b.kind && (a.kind === "heartbeat" || a.contentIndex === (b as { contentIndex: unknown }).contentIndex);
}

export type TurnFrameCoalescer = {
	/** A turn frame, in the order the turn produced it. */
	push: (frame: unknown) => void;
	/** Sends what is pending now. */
	flush: () => void;
};

/** The window's timer; a smoke passes a hand-driven one. The window only reopens after it sent something, so nothing needs clearing. */
export type CoalescerTimer = (fn: () => void, ms: number) => unknown;

export function createTurnFrameCoalescer(emit: (frame: unknown) => void, setTimer: CoalescerTimer = setTimeout): TurnFrameCoalescer {
	let pending: { key: MergeKey; frame: unknown; parts: string[]; chars: number } | null = null;
	// What the open window last sent, null while no window is open: words never wait in a window that has not just sent their kind.
	let windowSent: MergeKey["kind"] | null = null;

	const flush = () => {
		const held = pending;
		if (!held) return;
		// Cleared before emitting: the emitter may send another frame, which flushes again.
		pending = null;
		if (!isDelta(held.key.kind) || held.parts.length <= 1) { emit(held.frame); return; }
		const f = held.frame as { event: { assistantMessageEvent: Record<string, unknown> } };
		emit({ ...f, event: { ...f.event, assistantMessageEvent: { ...f.event.assistantMessageEvent, delta: held.parts.join("") } } });
	};
	const openWindow = (sent: MergeKey["kind"]) => {
		windowSent = sent;
		setTimer(() => {
			windowSent = null;
			if (!pending) return;
			const kind = pending.key.kind;
			flush();
			openWindow(kind);
		}, COALESCE_WINDOW_MS);
	};

	return {
		push(frame) {
			const key = mergeKeyOf(frame);
			if (!key) {
				flush();
				emit(frame);
				return;
			}
			const delta = isDelta(key.kind) ? (frame as { event: { assistantMessageEvent: { delta: string } } }).event.assistantMessageEvent.delta : "";
			if (pending && sameKey(pending.key, key)) {
				if (key.kind === "heartbeat") return;
				if (key.kind === "toolcall_preview") {
					pending.frame = frame;
					return;
				}
				pending.parts.push(delta);
				pending.chars += delta.length;
				if (pending.chars >= MAX_PENDING_CHARS) flush();
				return;
			}
			flush();
			if (windowSent === null || (isDelta(key.kind) && windowSent !== key.kind)) {
				emit(frame);
				if (windowSent === null) openWindow(key.kind);
				else windowSent = key.kind;
				return;
			}
			pending = { key, frame, parts: isDelta(key.kind) ? [delta] : [], chars: delta.length };
			if (pending.chars >= MAX_PENDING_CHARS) flush();
		},
		flush,
	};
}
