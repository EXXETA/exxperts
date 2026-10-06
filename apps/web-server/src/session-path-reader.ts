// The whole conversation, in the order it was had.
//
// The runtime's own view of a session (buildSessionContext) is what the MODEL
// is sent: after a compaction it opens with the compaction's summary and drops
// every message before the kept ones. That is right for the next turn and
// wrong for the two readers that have to see what was actually said: Remember,
// which turns the conversation into memory, and the search index, which makes
// a memorized conversation findable. Reading the model's view, both lost the
// words before a compaction for good, since the summary is a working note for
// the next turn, not the conversation.
//
// This reader walks the session path from its first entry to its leaf and
// returns every message on it, pre-compaction ones included. A compaction
// entry is skipped: its summary is a restatement of messages that are
// themselves on the path. A branch summary is kept: it describes a branch
// that is NOT on the path, so it is the only trace of that work here.
// Model and thinking-level changes, labels and extension bookkeeping carry no
// words and are skipped, as they are in the runtime's view.

import type { SessionEntry } from "@exxeta/exxperts-runtime";

/** The subset of the session manager this reader needs, so a caller can hand it any opened session. */
export interface SessionPathSource {
	getBranch(fromId?: string): SessionEntry[];
}

/**
 * The messages on the session path, root first, in the same shapes the
 * runtime's own view builds (a branch summary as a `branchSummary` message, an
 * extension message as a `custom` message), so a caller that maps the
 * runtime's messages maps these the same way.
 */
export function readSessionPathMessages(session: SessionPathSource): unknown[] {
	const messages: unknown[] = [];
	for (const entry of session.getBranch()) {
		if (entry.type === "message") {
			messages.push(entry.message);
		} else if (entry.type === "custom_message") {
			messages.push({
				role: "custom",
				customType: entry.customType,
				content: entry.content,
				display: entry.display,
				details: entry.details,
				timestamp: new Date(entry.timestamp).getTime(),
			});
		} else if (entry.type === "branch_summary" && entry.summary) {
			messages.push({ role: "branchSummary", summary: entry.summary, fromId: entry.fromId, timestamp: new Date(entry.timestamp).getTime() });
		}
	}
	return messages;
}
