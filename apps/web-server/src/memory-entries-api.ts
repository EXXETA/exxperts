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
import { withRoomSaveLock } from "./memory-commit.js";
import { createPersistentAgentInstance, saveWithOpenConversationCheck } from "./persistent-agents.js";
import { MEMORY_NOTE_MAX_CHARS, MEMORY_TOPIC_NAME_MAX_CHARS, memoryTextHasWords, memoryTopicName, memoryTopicNameProblem, memoryTypedText, topicNameSentence } from "./memory-typed-text.js";
import {
	deleteArchivedEntry,
	findMemoryEditRecord,
	loadMemoryDocument,
	memoryEntryAlreadyInCoreError,
	memoryEntryHistoryError,
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
	/** The day the text was learned and the day it stopped holding, when known: the Archive dates an older value by them. */
	learned?: string;
	until?: string;
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

// `standing`: the note is still in memory under this id or another version of it, so the restore route refuses it.
function archivedCard(entry: ArchivedEntry, doc: MemoryDocument): ArchivedEntryCard {
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
		...(entry.learned ? { learned: entry.learned } : {}),
		...(entry.until ? { until: entry.until } : {}),
		...(entry.why !== "history" && findEntryVersion(doc, entry.id) ? { standing: true } : {}),
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
function archivePayload(archive: ArchivedEntry[], doc: MemoryDocument): { count: number; history: number; byTopic: ArchiveTopicIndexRow[] } {
	// `history`: of the rows, the older values kept as history and the replaced texts whose note still stands, none of which can come back.
	return { count: archive.length, history: archive.filter((entry) => entry.why === "history" || findEntryVersion(doc, entry.id)).length, byTopic: Object.values(archiveIndex(archive)) };
}

function badRequest(message: string, code = "memory_bad_request"): Error {
	const error = new Error(message);
	(error as any).statusCode = 400;
	(error as any).code = code;
	return error;
}

/**
 * The person's words under the one rule (memory-typed-text.ts): every word is
 * kept, and a heading line or a comment becomes plain words instead of the
 * file's structure. Only a note with no words, or one past the limit, is refused.
 */
function requireText(raw: unknown): string {
	const text = typeof raw === "string" ? memoryTypedText(raw).replace(/\s+$/, "").replace(/^(?:[ \t]*\n)+/, "") : "";
	if (!memoryTextHasWords(text)) throw badRequest("An entry needs some text.");
	if (text.length > MEMORY_NOTE_MAX_CHARS) throw badRequest("That entry is too long to keep in memory. Shorten it and try again.");
	return text;
}

/**
 * A topic name: one line, its comment marks gone. A name the person typed as a
 * new topic is refused when it starts with # or is the open-items list's own
 * name; one chosen from the pane's list (the open-items list included) is taken.
 * Only a name the page says was chosen (newTopic false) is taken as chosen.
 */
function requireTopic(raw: unknown, typedNew: boolean): string {
	const topic = memoryTopicName(String(raw ?? ""));
	const problem = memoryTopicNameProblem(topic);
	if (problem && (typedNew || problem !== "reserved")) throw badRequest(topicNameSentence(problem, topic, MEMORY_TOPIC_NAME_MAX_CHARS), "memory_topic_name");
	return topic;
}

/** The page's id for an add, so the add sent again after a lost answer finds its first one. */
function requestIdOf(raw: unknown): string | undefined {
	const id = typeof raw === "string" ? raw.trim() : "";
	return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : undefined;
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

/**
 * Runs one pane write and, when it changed what a conversation reads while a
 * started conversation is open, says so on its answer, as Memorize and Review
 * do. A refusal is the route's own reply, never an answer to add to.
 */
async function withOpenConversationLine<T>(idRaw: string, save: () => Promise<T>): Promise<T> {
	try {
		createPersistentAgentInstance(idRaw);
	} catch {
		return save();
	}
	let answer: T | undefined;
	const checked = await saveWithOpenConversationCheck(idRaw, async () => {
		answer = await save();
		return {};
	});
	const plain = answer !== null && typeof answer === "object" && Object.getPrototypeOf(answer) === Object.prototype;
	return checked.openConversationKeepsMemory && plain ? ({ ...answer, openConversationKeepsMemory: true } as T) : (answer as T);
}

export function registerMemoryEntryRoutes(app: FastifyInstance, deps: MemoryEntryRouteDeps): void {
	const roomId = (req: any): string => deps.usableRoom(String((req.params as any).id ?? "").trim()).id;
	// Each write takes the room's save lock (memory-commit.ts), keyed by the id
	// the request names, so it never interleaves with another save of the room.
	const saveLocked = <T>(req: any, save: () => Promise<T>): Promise<T> => {
		const idRaw = String((req.params as any).id ?? "");
		return withRoomSaveLock(idRaw, () => withOpenConversationLine(idRaw, save));
	};
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
				archive: archivePayload(load.archive, load.doc),
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
			const doc = loadForRead(id).load.doc;
			const sorted = readArchive(id).sort((a, b) => (b.archived.localeCompare(a.archived) || b.id.localeCompare(a.id)));
			const from = before ? sorted.filter((entry) => `${entry.archived} ${entry.id}` < before) : sorted;
			const page = from.slice(0, limit);
			const next = from.length > page.length && page.length > 0 ? `${page[page.length - 1].archived} ${page[page.length - 1].id}` : undefined;
			return { agentId: id, entries: page.map((entry) => archivedCard(entry, doc)), ...(next ? { next } : {}), ...readOnlyFields(memoryRoomBusy(id)) };
		} catch (e) {
			return deps.errorReply(reply, e);
		}
	});

	app.post("/api/persistent-agents/:id/memory/entries", async (req, reply) => saveLocked(req, async () => {
		try {
			const id = roomId(req);
			const body = (req.body ?? {}) as any;
			const kind = requireKind(body.kind);
			const topic = kind === "item" && !String(body.topic ?? "").trim() ? MEMORY_ACTIVE_ITEMS_TOPIC : requireTopic(body.topic, body.newTopic !== false);
			const text = requireText(body.text);
			const requestId = requestIdOf(body.requestId);
			const load = loadMemoryDocument(id);
			// The same add sent again after its answer was lost: it landed once, and the answer names that note.
			const sent = requestId ? findMemoryEditRecord(id, (record) => record.requestId === requestId && record.entryOperation === "add") : null;
			if (sent?.entryId) {
				const card = findEntryLocation(load.doc, sent.entryId) ? cardOf(load.doc, sent.entryId) : null;
				return { agentId: id, entry: card, budget: load.budget, alreadySaved: true };
			}
			// The id the add is about to take: the document's own counter, which
			// applyUserEdit consumes. Reading it here beats hunting for "the new
			// one" in the result.
			const addedId = formatEntryId(load.doc.nextEntryNumber);
			const next = applyUserEdit(load.doc, { op: "add", topic, kind, text, saved: today() }).doc;
			const write = writeMemoryDocument(id, next, { why: "user_edit", snapshotLabel: "edit", operation: "add", entryId: addedId, ...(requestId ? { requestId } : {}) });
			return { agentId: id, entry: cardOf(next, addedId), budget: write.budget };
		} catch (e) {
			return deps.errorReply(reply, e);
		}
	}));

	// One field per request, exactly as the pane's controls are one action each.
	app.put("/api/persistent-agents/:id/memory/entries/:entryId", async (req, reply) => saveLocked(req, async () => {
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
				next = applyUserEdit(load.doc, { op: "move", id: entryId, topic: requireTopic(body.topic, body.newTopic !== false) }).doc;
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
	}));

	// A delete is a demotion to the archive with why=user: nothing a person
	// removes from the core is destroyed, and the archive list can restore it.
	app.delete("/api/persistent-agents/:id/memory/entries/:entryId", async (req, reply) => saveLocked(req, async () => {
		try {
			const id = roomId(req);
			const entryId = entryIdOf(req);
			const load = loadMemoryDocument(id);
			const found = findEntryLocation(load.doc, entryId);
			// A delete sent again after its answer was lost: the note is in the archive already, and the answer says so.
			const gone = found ? undefined : load.archive.find((entry) => entry.id === entryId && entry.why === "user");
			if (gone) return { agentId: id, archived: archivedCard(gone, load.doc), budget: load.budget, alreadySaved: true };
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
			return { agentId: id, archived: archivedCard(write.archived[0], applied.doc), budget: write.budget };
		} catch (e) {
			return deps.errorReply(reply, e);
		}
	}));

	// A restore may take the room over budget. That is allowed and disclosed:
	// the person asked for this entry back, and the budget line says where the
	// room now stands. A note the core already holds — in this version or
	// another — is not put in beside itself: that is a conflict, with its own
	// sentence, and the archive row stays where it is.
	app.post("/api/persistent-agents/:id/memory/archive/:entryId/restore", async (req, reply) => saveLocked(req, async () => {
		try {
			const id = roomId(req);
			const entryId = entryIdOf(req);
			const load = loadMemoryDocument(id);
			const archived = load.archive.find((entry) => entry.id === entryId);
			// A restore sent again after its answer was lost: the note is back in memory, and the answer says so.
			const restored = archived ? null : findMemoryEditRecord(id, (record) => record.entryOperation === "restore" && record.entryId === entryId);
			if (restored && findEntryLocation(load.doc, entryId)) return { agentId: id, entry: cardOf(load.doc, entryId), budget: load.budget, alreadySaved: true };
			if (!archived) throw memoryEntryUnknownError(true);
			if (archived.why === "history") throw memoryEntryHistoryError();
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
	}));

	// The one way out of the archive: the row is gone, nothing can bring it back
	// and no undo serves it. The store refuses a busy room and an unknown row
	// with the sentences every other write uses, and records the delete in the
	// room's history with the note's first lines.
	app.delete("/api/persistent-agents/:id/memory/archive/:entryId", async (req, reply) => saveLocked(req, async () => {
		try {
			const id = roomId(req);
			const entryId = entryIdOf(req);
			// A delete for good sent again after its answer was lost: the row is gone already, and the answer says so.
			const done = findMemoryEditRecord(id, (record) => record.entryOperation === "archive_delete" && record.entryId === entryId);
			if (done && !readArchive(id).some((entry) => entry.id === entryId)) {
				const doc = loadForRead(id).load.doc;
				return { agentId: id, deleted: null, archive: archivePayload(readArchive(id), doc), alreadySaved: true };
			}
			const result = deleteArchivedEntry(id, entryId);
			const doc = loadForRead(id).load.doc;
			return { agentId: id, deleted: archivedCard(result.deleted, doc), archive: archivePayload(result.archive, doc) };
		} catch (e) {
			return deps.errorReply(reply, e);
		}
	}));

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
