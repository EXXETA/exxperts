// A turn a kill ended says so, with the line a clean stop lands. A keyed turn
// says it runs, with its question, in its room's folder until it finishes
// (turn-pieces-store.ts `running`); a kill leaves that behind. The page saves
// the question some time after it is sent, so after a kill mid-answer it may
// be missing too. The room's settle (room-settle.ts), the step every reader of
// the room runs first, lands the question as a clean stop does (a saved copy
// is only stamped) and STOP_CUT_ANSWER_SENTENCE after the turn's last item,
// under the id a clean stop's landing gives it, and then removes the file, so
// the line lands once and never on a later turn.
//
// The line is marked landed, so a save from a window that still holds the
// copy it had before the kill keeps it. A part of the answer the page saved is
// not: a window open across the kill keeps its own copy of an item of its turn
// the server did not mark (apps/web-ui/src/room-thread-items.ts
// `withShownTurn`), which can be longer, and saves it with the line.
//
// A killed turn's file is older than this process, so one look per room per
// process finds them all, and the room's first settle comes before any turn
// of this process begins there (beginPersistentAgentTurn settles first). A
// look that failed looks again at the next settle, so a conversation this
// process has run a turn in owns its file then: that turn is running, or it
// finished and its file went with it. Landing again after a kill between the
// line and the file's removal finds the line by its id and writes nothing.

import { persistentAgentActiveTurnKey, persistentAgentActiveTurns } from "./persistent-agent-store.js";
import { getPersistentAgentThread, writePersistentAgentThread } from "./persistent-agent-threads.js";
import { failureLineId, landTurnItems, ofTurn, partialLineId, type ThreadItem } from "./thread-items-by-id.js";
import { dropRunningTurn, readRunningTurn, readTurnItemsMemory, runningTurnConversations, type RunningTurn } from "./turn-pieces-store.js";
import { STOP_CUT_ANSWER_SENTENCE } from "./turn-ended-by.js";

/** The conversation's items with the killed turn's question and the clean stop's line after the turn's last item, or null when its line is there already. */
function withStopLine(file: readonly ThreadItem[], turn: RunningTurn, recentKeys: readonly string[], removed: ReadonlySet<string>): ThreadItem[] | null {
	const { key } = turn;
	const items = turn.own.length ? landTurnItems(file, turn.own, { key, continued: turn.continued, startAnchorId: turn.startAnchorId, recentKeys }, removed) : [...file];
	const answered = items.some((item) => item.kind === "assistant" && ofTurn(item, key) && String(item.text ?? "").trim());
	const id = answered ? partialLineId(key) : failureLineId(key);
	if (items.some((item) => item.id === id)) return null;
	// After the turn's last item; a Try again the page saved nothing of goes after the item it continues.
	let at = -1;
	items.forEach((item, index) => { if (ofTurn(item, key)) at = index; });
	if (at < 0 && turn.startAnchorId) at = items.findIndex((item) => item.id === turn.startAnchorId);
	if (at < 0) at = items.length - 1;
	return [...items.slice(0, at + 1), { kind: "system", id, text: STOP_CUT_ANSWER_SENTENCE, level: "error", landed: true }, ...items.slice(at + 1)];
}

const LOOKED = new Set<string>();

/** Lands the line of every turn of this room a kill ended: one folder read, at the room's first settle in this process. */
export function landKilledTurnLines(agentId: string, roomDir: string): void {
	if (LOOKED.has(roomDir)) return;
	LOOKED.add(roomDir);
	for (const conversationId of runningTurnConversations(roomDir)) {
		if (persistentAgentActiveTurns.has(persistentAgentActiveTurnKey(agentId, conversationId))) continue;
		try {
			const running = readRunningTurn(agentId, conversationId);
			const memory = readTurnItemsMemory(agentId, conversationId);
			const thread = running ? getPersistentAgentThread(agentId, conversationId) : null;
			const items = running && thread && thread.state !== "closed" ? withStopLine((thread.items ?? []) as ThreadItem[], running, memory.keys, new Set(memory.removed)) : null;
			if (thread && items) writePersistentAgentThread(agentId, conversationId, { state: thread.state, origin: thread.origin, model: thread.model, items }, { allowInactiveProfileModel: true, keepRuntimeIfMoved: true });
			dropRunningTurn(agentId, conversationId);
		} catch (error) {
			LOOKED.delete(roomDir);
			console.error(`[killed-turn-line] a killed turn in ${agentId} could not be told yet: ${(error as Error)?.name ?? "Error"}`);
		}
	}
}
