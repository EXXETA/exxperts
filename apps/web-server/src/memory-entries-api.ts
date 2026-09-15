// The entries API (memory v2, stream D2): the room's memory, entry by entry,
// over HTTP. Every route here is the Memory pane's one request for one action
// — list, add, edit, pin, move, close, delete, restore, delete for good — and every write goes
// through the store, so it carries the same snapshot, event record and
// active-turn refusal a Memorize carries. No model is ever involved.
//
// READS NEVER REFUSE. A write waits for a running turn, because memory is the
// one thing that turn is reading; a read changes nothing, so the three GETs here
// answer while the room is mid-conversation and say `readOnly` with the reason
// instead of handing a pane an error where its memory should be. On a room whose
// file has no entry ids yet, a busy read migrates in memory only — cards with
// ids, a file nobody touched.
//
// The routes live under /api/persistent-agents/:id/ beside the room's other
// per-room routes, share their auth, their `{ error, code? }` envelope and
// their remote-route classification, and are registered from index.ts with one
// line next to the maintenance-settings pair.

import type { FastifyInstance } from "fastify";
import {
	applyUserEdit,
	archiveIndex,
	entryTokens,
	ENTRY_KINDS,
	findEntryLocation,
	findEntryVersion,
	findStructuralLine,
	formatEntryId,
	MEMORY_ACTIVE_ITEMS_TOPIC,
	restoreEntry,
	type ArchivedEntry,
	type ArchiveTopicIndexRow,
	type EntryKind,
	type ItemStatus,
	type MemoryDocument,
	type MemoryEntry,
	type MemorySection,
	type MemoryTopic,
} from "./memory-entries.js";
import {
	deleteArchivedEntry,
	loadMemoryDocument,
	memoryEntryAlreadyInCoreError,
	memoryEntryUnknownError,
	memoryRoomBusy,
	MEMORY_ROOM_BUSY_SENTENCE,
	readArchive,
	writeMemoryDocument,
	type MemoryDocumentLoad,
	type MemoryEditOperation,
} from "./memory-entries-store.js";

/** One entry as the pane shows it. The text never carries the metadata line. */
export interface EntryCard {
	id: string;
	section: MemorySection;
	topic: string;
	kind: EntryKind;
	saved: string;
	from?: string;
	pinned: boolean;
	status?: ItemStatus;
	updated?: string;
	refs?: number;
	tokens: number;
	text: string;
}

export interface ArchivedEntryCard extends EntryCard {
	archived: string;
	why: ArchivedEntry["why"];
}

export interface MemoryEntryRouteDeps {
	/** The room's own usable-status check, so these routes refuse exactly like their neighbours. */
	usableRoom(idRaw: string): { id: string };
	/** The room routes' error envelope: `{ error, code? }` at the error's own status. */
	errorReply(reply: any, error: unknown): unknown;
	/** Today's memory history for the room, so the pane and the Memory tab read one list. */
	history(idRaw: string): unknown[];
}

const ARCHIVE_PAGE_DEFAULT = 50;
const ARCHIVE_PAGE_MAX = 200;
const ENTRY_TEXT_MAX_CHARS = 20_000;
const TOPIC_TITLE_MAX_CHARS = 120;

function entryCard(entry: MemoryEntry, topic: MemoryTopic): EntryCard {
	return {
		id: entry.id,
		section: topic.section,
		topic: topic.title,
		kind: entry.kind,
		saved: entry.saved,
		...(entry.from ? { from: entry.from } : {}),
		pinned: entry.pinned,
		...(entry.status ? { status: entry.status } : {}),
		...(entry.updated ? { updated: entry.updated } : {}),
		...(entry.refs !== undefined ? { refs: entry.refs } : {}),
		tokens: entryTokens(entry),
		text: entry.text,
	};
}

function archivedCard(entry: ArchivedEntry): ArchivedEntryCard {
	return {
		id: entry.id,
		section: entry.section,
		topic: entry.topic,
		kind: entry.kind,
		saved: entry.saved,
		...(entry.from ? { from: entry.from } : {}),
		pinned: entry.pinned,
		...(entry.status ? { status: entry.status } : {}),
		...(entry.updated ? { updated: entry.updated } : {}),
		...(entry.refs !== undefined ? { refs: entry.refs } : {}),
		tokens: entryTokens(entry),
		text: entry.text,
		archived: entry.archived,
		why: entry.why,
	};
}

function cardOf(doc: MemoryDocument, id: string): EntryCard {
	const found = findEntryLocation(doc, id);
	if (!found) throw memoryEntryUnknownError();
	return entryCard(found.entry, found.topic);
}

function topicsPayload(doc: MemoryDocument): Array<{ section: MemorySection; title: string; entries: EntryCard[] }> {
	return doc.topics.map((topic) => ({
		section: topic.section,
		title: topic.title,
		entries: topic.entries.map((entry) => entryCard(entry, topic)),
	}));
}

// The same per-topic counts the context render's pointer lines are built from,
// so the pane and the room are looking at one archive, not two summaries of it.
function archivePayload(archive: ArchivedEntry[]): { count: number; byTopic: ArchiveTopicIndexRow[] } {
	return { count: archive.length, byTopic: Object.values(archiveIndex(archive)) };
}

function badRequest(message: string, code = "memory_bad_request"): Error {
	const error = new Error(message);
	(error as any).statusCode = 400;
	(error as any).code = code;
	return error;
}

function requireText(raw: unknown): string {
	const text = typeof raw === "string" ? raw.replace(/\s+$/, "") : "";
	if (!text.trim()) throw badRequest("An entry needs some text.");
	if (text.length > ENTRY_TEXT_MAX_CHARS) throw badRequest("That entry is too long to keep in memory. Shorten it and try again.");
	// A heading line would become a topic and cut the note in two; a comment
	// line is how the file writes ids, and a pasted one claims another note's.
	if (findStructuralLine(text) !== null) throw badRequest("A note cannot contain a heading line or a hidden comment; write it as plain text.", "memory_entry_text_structural");
	return text;
}

function requireTopic(raw: unknown): string {
	const topic = String(raw ?? "").trim();
	if (!topic) throw badRequest("A topic needs a name.");
	if (topic.length > TOPIC_TITLE_MAX_CHARS) throw badRequest("That topic name is too long.");
	if (/[\r\n]/.test(topic)) throw badRequest("A topic name is one line.");
	return topic;
}

function requireKind(raw: unknown): EntryKind {
	const kind = String(raw ?? "").trim() as EntryKind;
	if (!ENTRY_KINDS.includes(kind)) throw badRequest(`An entry is one of: ${ENTRY_KINDS.join(", ")}.`);
	return kind;
}

function today(now = new Date()): string {
	return now.toISOString().slice(0, 10);
}

/**
 * What the read-only fields say when the room is mid-turn, and nothing at all
 * when it is not. Reading a memory is never a change to it, so the pane opens
 * either way; what it loses while a turn is in flight is the ability to edit,
 * and that is what these two fields tell it.
 */
function readOnlyFields(readOnly: boolean): { readOnly: true; reason: string } | Record<string, never> {
	return readOnly ? { readOnly: true, reason: MEMORY_ROOM_BUSY_SENTENCE } : {};
}

/** The entries load for a READ: never a write, read-only while the room is busy. */
function loadForRead(id: string): { load: MemoryDocumentLoad; readOnly: boolean } {
	// Reading never writes: a file without entry ids is migrated in memory for
	// the pane, and the first edit (or the first approved memory update) is what
	// performs the real migration, with its snapshot and its history row.
	return { load: loadMemoryDocument(id, { migrate: "in-memory" }), readOnly: memoryRoomBusy(id) };
}

export function registerMemoryEntryRoutes(app: FastifyInstance, deps: MemoryEntryRouteDeps): void {
	const roomId = (req: any): string => deps.usableRoom(String((req.params as any).id ?? "").trim()).id;
	const entryIdOf = (req: any): string => {
		const id = String((req.params as any).entryId ?? "").trim();
		if (!id) throw memoryEntryUnknownError();
		return id;
	};

	app.get("/api/persistent-agents/:id/memory/entries", async (req, reply) => {
		try {
			const id = roomId(req);
			const { load, readOnly } = loadForRead(id);
			return {
				agentId: id,
				budget: load.budget,
				topics: topicsPayload(load.doc),
				archive: archivePayload(load.archive),
				...(load.migrated ? { migrated: true } : {}),
				...readOnlyFields(readOnly),
			};
		} catch (e) {
			return deps.errorReply(reply, e);
		}
	});

	// Newest first, paged by the archived stamp the previous page ended on.
	// Entries sharing a stamp are kept together by paging on id within a day.
	app.get("/api/persistent-agents/:id/memory/archive", async (req, reply) => {
		try {
			const id = roomId(req);
			const query = (req.query ?? {}) as any;
			const limitRaw = Number.parseInt(String(query.limit ?? ""), 10);
			const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(ARCHIVE_PAGE_MAX, limitRaw) : ARCHIVE_PAGE_DEFAULT;
			const before = String(query.before ?? "").trim();
			const sorted = readArchive(id).sort((a, b) => (b.archived.localeCompare(a.archived) || b.id.localeCompare(a.id)));
			const from = before ? sorted.filter((entry) => `${entry.archived} ${entry.id}` < before) : sorted;
			const page = from.slice(0, limit);
			const next = from.length > page.length && page.length > 0 ? `${page[page.length - 1].archived} ${page[page.length - 1].id}` : undefined;
			return { agentId: id, entries: page.map(archivedCard), ...(next ? { next } : {}), ...readOnlyFields(memoryRoomBusy(id)) };
		} catch (e) {
			return deps.errorReply(reply, e);
		}
	});

	app.post("/api/persistent-agents/:id/memory/entries", async (req, reply) => {
		try {
			const id = roomId(req);
			const body = (req.body ?? {}) as any;
			const kind = requireKind(body.kind);
			const topic = kind === "item" && !String(body.topic ?? "").trim() ? MEMORY_ACTIVE_ITEMS_TOPIC : requireTopic(body.topic);
			const text = requireText(body.text);
			const load = loadMemoryDocument(id);
			// The id the add is about to take: the document's own counter, which
			// applyUserEdit consumes. Reading it here beats hunting for "the new
			// one" in the result.
			const addedId = formatEntryId(load.doc.nextEntryNumber);
			const next = applyUserEdit(load.doc, { op: "add", topic, kind, text, saved: today() }).doc;
			const write = writeMemoryDocument(id, next, { why: "user_edit", snapshotLabel: "edit", operation: "add", entryId: addedId });
			return { agentId: id, entry: cardOf(next, addedId), budget: write.budget };
		} catch (e) {
			return deps.errorReply(reply, e);
		}
	});

	// One field per request, exactly as the pane's controls are one action each.
	app.put("/api/persistent-agents/:id/memory/entries/:entryId", async (req, reply) => {
		try {
			const id = roomId(req);
			const entryId = entryIdOf(req);
			const body = (req.body ?? {}) as any;
			const load = loadMemoryDocument(id);
			if (!findEntryLocation(load.doc, entryId)) throw memoryEntryUnknownError();
			let operation: MemoryEditOperation;
			let next: MemoryDocument;
			if (body.text !== undefined) {
				operation = "edit";
				next = applyUserEdit(load.doc, { op: "edit", id: entryId, text: requireText(body.text), today: today() }).doc;
			} else if (body.pinned !== undefined) {
				if (typeof body.pinned !== "boolean") throw badRequest("Pinned is on or off.");
				operation = body.pinned ? "pin" : "unpin";
				next = applyUserEdit(load.doc, { op: body.pinned ? "pin" : "unpin", id: entryId }).doc;
			} else if (body.topic !== undefined) {
				operation = "move";
				next = applyUserEdit(load.doc, { op: "move", id: entryId, topic: requireTopic(body.topic) }).doc;
			} else if (body.status !== undefined) {
				const status = String(body.status ?? "").trim();
				if (status !== "open" && status !== "done") throw badRequest("An open loop is either open or done.");
				operation = "status";
				next = applyUserEdit(load.doc, { op: "status", id: entryId, status, today: today() }).doc;
			} else {
				throw badRequest("Nothing to change: send the entry's text, pinned, topic or status.");
			}
			const write = writeMemoryDocument(id, next, { why: "user_edit", snapshotLabel: "edit", operation, entryId });
			return { agentId: id, entry: cardOf(next, entryId), budget: write.budget };
		} catch (e) {
			return deps.errorReply(reply, e);
		}
	});

	// A delete is a demotion to the archive with why=user: nothing a person
	// removes from the core is destroyed, and the archive list can restore it.
	app.delete("/api/persistent-agents/:id/memory/entries/:entryId", async (req, reply) => {
		try {
			const id = roomId(req);
			const entryId = entryIdOf(req);
			const load = loadMemoryDocument(id);
			const found = findEntryLocation(load.doc, entryId);
			if (!found) throw memoryEntryUnknownError();
			const section = found.topic.section;
			const topicTitle = found.topic.title;
			const applied = applyUserEdit(load.doc, { op: "delete", id: entryId });
			if (!applied.archived) throw memoryEntryUnknownError();
			const write = writeMemoryDocument(id, applied.doc, {
				why: "user_edit",
				snapshotLabel: "edit",
				operation: "delete",
				entryId,
				archiveAppend: [{ entry: applied.archived, why: "user", topic: topicTitle, section }],
			});
			return { agentId: id, archived: archivedCard(write.archived[0]), budget: write.budget };
		} catch (e) {
			return deps.errorReply(reply, e);
		}
	});

	// A restore may take the room over budget. That is allowed and disclosed:
	// the person asked for this entry back, and the budget line says where the
	// room now stands. A note the core already holds — in this version or
	// another — is not put in beside itself: that is a conflict, with its own
	// sentence, and the archive row stays where it is.
	app.post("/api/persistent-agents/:id/memory/archive/:entryId/restore", async (req, reply) => {
		try {
			const id = roomId(req);
			const entryId = entryIdOf(req);
			const load = loadMemoryDocument(id);
			const archived = load.archive.find((entry) => entry.id === entryId);
			if (!archived) throw memoryEntryUnknownError(true);
			if (findEntryVersion(load.doc, entryId)) throw memoryEntryAlreadyInCoreError();
			const next = restoreEntry(load.doc, archived);
			const write = writeMemoryDocument(id, next, {
				why: "user_edit",
				snapshotLabel: "edit",
				operation: "restore",
				entryId,
				archiveRemoveIds: [entryId],
			});
			return { agentId: id, entry: cardOf(next, entryId), budget: write.budget };
		} catch (e) {
			return deps.errorReply(reply, e);
		}
	});

	// The one way out of the archive: the row is gone, nothing can bring it back
	// and no undo serves it. The store refuses a busy room and an unknown row
	// with the sentences every other write uses, and records the delete in the
	// room's history with the note's first lines.
	app.delete("/api/persistent-agents/:id/memory/archive/:entryId", async (req, reply) => {
		try {
			const id = roomId(req);
			const entryId = entryIdOf(req);
			const result = deleteArchivedEntry(id, entryId);
			return { agentId: id, deleted: archivedCard(result.deleted), archive: archivePayload(result.archive) };
		} catch (e) {
			return deps.errorReply(reply, e);
		}
	});

	// Today's history, unchanged, on the room's own route: user edits and the
	// migration appear in it beside checkpoints, Memorize and Review.
	app.get("/api/persistent-agents/:id/memory/history", async (req, reply) => {
		try {
			const id = roomId(req);
			return { agentId: id, history: deps.history(id), ...readOnlyFields(memoryRoomBusy(id)) };
		} catch (e) {
			return deps.errorReply(reply, e);
		}
	});
}
