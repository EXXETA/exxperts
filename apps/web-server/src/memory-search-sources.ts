// Where a room's searchable documents come from (memory v3, the search's
// document layer).
//
// The index next door is pure: it is handed documents and knows nothing about
// rooms, files or history. This module is the other half — it reads one room's
// own storage and turns it into that document list, and it is the only place
// that knows which of a room's words are searchable at all.
//
// Three sources, and the line between them is the line the product already
// draws:
//
//   1. NOTES — the entries of `L1b/current.md`, read through the product's own
//      parser so a note is exactly the note the entries pane shows. Recent
//      Context is deliberately NOT a source: those conversations are still in
//      the room's context, so searching them would return what the room can
//      already see and rank it against what it cannot.
//   2. ARCHIVE — every row of `L1b/archive/entries.md`, read through the store,
//      with the reason it left carried in the person's words rather than the
//      file's code.
//   3. CONVERSATIONS: the closed transcripts behind the fold. A Remember
//      writes a checkpoint event naming the Recent Context entry it created and
//      the session file of the conversation it closed; a Memorize writes an
//      absorb event saying, entry by entry, which of those it folded into
//      notes and which it dropped, and naming the conversation each one was.
//      EVERY memorized conversation is searchable, the dropped ones included:
//      the fold judges what is worth carrying in front of the room every turn,
//      not what stays findable, and a detail the fold left out of the notes is
//      answered from the transcript a month later or not at all. A dropped
//      conversation says so on its origin line, so a row from it shows that
//      the transcript is all memory kept of it. A conversation remembered but
//      not yet memorized is still in Recent Context and therefore still in
//      view; a conversation never Remembered has no checkpoint event and is
//      never indexed, whatever session files the room holds. The transcript
//      itself is read through the session manager, never by parsing the
//      session file by hand, so this module reads the same conversation the
//      compressor read.
//
// Nothing here writes. Not the memory file, not the settings, not a cache file
// — the one cache is in this process's memory and is dropped whenever a watched
// file's mtime moves. That matters more than it looks: the search is read on
// every question, and a read that wrote would rewrite a room's memory for
// asking it something.

import fs from "node:fs";
import path from "node:path";

import { MEMORY_ARCHIVE_ENTRIES_FILE, parseMemoryDocument, type ArchivedEntry, type MemoryEntry } from "./memory-entries.js";
import { readArchive } from "./memory-entries-store.js";
import { buildIndex, type SearchDocument, type SearchIndex, type SearchSource } from "./memory-search-index.js";
// The reason words live with the tool that reads them back to the room: a
// person reading a search result and a room reading a recall are reading one
// archive, and one table is how they keep saying the same thing.
import { MEMORY_RECALL_REASON_WORDS } from "./persistent-room-memory-recall-tool.js";
import {
	createPersistentAgentInstance,
	openPersistentAgentPiSessionManager,
	type AbsorbEventRecord,
	type CheckpointEventRecord,
} from "./persistent-agents.js";

/** A file whose mtime decides whether the cached corpus still holds. */
export interface WatchedFile {
	path: string;
	/** 0 when the path does not exist — so its appearance is a change like any other. */
	mtimeMs: number;
}

/** A folded conversation the corpus could not place or read, and the plain reason why. */
export interface SkippedConversation {
	recentContextId: string;
	checkpointId?: string;
	why: string;
}

export interface RoomDocuments {
	docs: SearchDocument[];
	builtFrom: WatchedFile[];
	skipped: SkippedConversation[];
}

export interface RoomCorpus {
	docs: SearchDocument[];
	index: SearchIndex;
	counts: Record<SearchSource, number>;
	builtFrom: WatchedFile[];
	skipped: SkippedConversation[];
}

export interface CollectRoomDocumentsOptions {
	/**
	 * The working directory the session manager resolves a transcript against —
	 * what `buildPersistentAgentCheckpointTranscriptSource` is given for the same
	 * read. The process's own directory is the right default for a server that
	 * runs where the rooms live.
	 */
	runtimeCwd?: string;
}

/** The longest a conversation chunk gets, in characters. */
export const CONVERSATION_CHUNK_CHARS = 1_200;

const ARCHIVE_REASON_FALLBACK = "moved to make room";

// --- watched files -----------------------------------------------------------

function watched(file: string): WatchedFile {
	try {
		return { path: file, mtimeMs: fs.statSync(file).mtimeMs };
	} catch {
		return { path: file, mtimeMs: 0 }; // absent today; its arrival moves the number off zero
	}
}

function watchedStillHolds(files: readonly WatchedFile[]): boolean {
	for (const file of files) {
		if (watched(file.path).mtimeMs !== file.mtimeMs) return false;
	}
	return true;
}

// --- notes -------------------------------------------------------------------

function noteDocuments(l1bPath: string): SearchDocument[] {
	let raw: string;
	try {
		raw = fs.readFileSync(l1bPath, "utf-8");
	} catch {
		return []; // a room with no memory file yet has no notes to search
	}
	const doc = parseMemoryDocument(raw);
	const docs: SearchDocument[] = [];
	let position = 0;
	for (const topic of doc.topics) {
		for (const entry of topic.entries) {
			position += 1;
			docs.push(noteDocument(entry, topic.title, position));
		}
	}
	return docs;
}

function noteDocument(entry: MemoryEntry, topic: string, position: number): SearchDocument {
	// A note in a file that has never been migrated carries no date of its own,
	// and none is invented for it: the day a file happens to have been touched
	// is not the day a note was written, and a date the room states is a date it
	// will be believed on. It stays empty, and it says so where it is read.
	//
	// An empty date is therefore a date NOBODY KNOWS, not a date before every
	// range: the index's `since` and `until` let it through, because a row that
	// may well be inside the period asked about cannot honestly be ruled out of
	// it, and a string comparison alone would put every undated row before every
	// day there is.
	const date = String(entry.updated || entry.saved || "").trim();
	const saved = String(entry.saved ?? "").trim();
	return {
		// A file that has never been migrated carries notes with no id of their
		// own. They are still the room's notes, so they are still searchable,
		// under their place in the file — the id the migration will give them
		// replaces it on the next build.
		id: entry.id || `note-${String(position).padStart(4, "0")}`,
		source: "note",
		topic,
		date,
		origin: saved ? `in memory, saved ${saved}` : "in memory, date unknown",
		text: entry.text,
		meta: { kind: entry.kind, pinned: entry.pinned, ...(entry.from ? { from: entry.from } : {}) },
	};
}

// --- archive -----------------------------------------------------------------

function archiveDocuments(agentId: string): SearchDocument[] {
	let rows: ArchivedEntry[];
	try {
		rows = readArchive(agentId);
	} catch {
		return []; // an unreadable archive costs the archive, never the notes
	}
	return rows.map((row) => ({
		id: row.id,
		source: "archive" as const,
		topic: row.topic,
		date: row.archived,
		origin: `archived ${row.archived}, ${MEMORY_RECALL_REASON_WORDS[row.why] ?? ARCHIVE_REASON_FALLBACK}`,
		text: row.text,
		meta: { why: row.why, saved: row.saved, section: row.section },
	}));
}

// --- event records -----------------------------------------------------------

/**
 * Every record of one kind, oldest approval first. A record whose `approvedAt`
 * cannot be read is dropped rather than guessed at: the whole matching below is
 * an ordering, and a record with no place in it would be matched at random.
 */
function readEventRecords<T extends { approvedAt: string }>(dir: string, watchList: WatchedFile[]): T[] {
	watchList.push(watched(dir));
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return []; // no events of this kind yet
	}
	const records: T[] = [];
	for (const name of names.sort()) {
		if (!name.endsWith(".json")) continue;
		const file = path.join(dir, name);
		watchList.push(watched(file));
		try {
			records.push(JSON.parse(fs.readFileSync(file, "utf-8")) as T);
		} catch {
			// a partial or unreadable record costs that record, not the room
		}
	}
	return records.filter((record) => Number.isFinite(Date.parse(record.approvedAt))).sort((a, b) => Date.parse(a.approvedAt) - Date.parse(b.approvedAt));
}

/** One memorized conversation: which Recent Context entry it was, which Remember closed it, and whether the fold took notes from it. */
interface MemorizedConversation {
	recentContextId: string;
	checkpoint: CheckpointEventRecord;
	outcome: "folded" | "dropped";
}

/**
 * Which closed conversation each memorized Recent Context entry actually was.
 *
 * A Recent Context id is only unique while the entry is in the file: the next
 * Remember numbers itself one above the highest id Recent Context currently
 * holds, so a Memorize that empties the section hands RC-0001 back to the
 * conversation after it. Matching by id alone would therefore hand a fold the
 * transcript of a conversation from two Memorizes ago.
 *
 * The exact answer is in the fold record. A Memorize copies each entry's
 * checkpoint id and conversation id out of the entry it folds, while the entry
 * is still in the file and can be nothing else, so a session that carries the
 * names claims the checkpoint record with that id and no clock is consulted.
 * A later record naming the same Remember is the same conversation memorized
 * again, as after an undo, and the row stands once, as the later record has
 * it. A named Remember whose record is gone is reported for a folded session.
 *
 * A record written before the names were kept falls back to time: absorb
 * events oldest first, each session claiming the OLDEST checkpoint of its id
 * that was approved at or before the absorb and that nothing else has claimed,
 * a named one included. Oldest, because the entry that had sat in Recent
 * Context longest is the one the fold consumed: when two Remembers of one id
 * straddle a Memorize, the earlier of them is the one that Memorize folded. On
 * a clock that only moves forward the newest that qualifies is the same
 * record; on a tie, or on a clock that stepped back between the two Remembers,
 * only the oldest is right, and the newest rule hands the fold the later
 * conversation's transcript and leaves the earlier one out of the index.
 *
 * Dropped entries are matched exactly like folded ones and become
 * conversations too. The fold judged that they left no note worth carrying in
 * front of the room every turn, not that their words are worth nothing, and a
 * question about them a month later is answered from the transcript or not at
 * all. They would have to be claimed either way: they were in the same Recent
 * Context and left with the same save, so letting them go unclaimed would push
 * their transcript onto the next reuse of the id.
 *
 * A folded entry that claims nothing is a memorized conversation this room
 * cannot search, so it is reported rather than dropped in silence. It happens
 * when the Remember's record is gone, and on a record without names it happens
 * when a clock stepped back and stamped the Remember after the Memorize that
 * folded it; either way the room has a memorized conversation whose words are
 * not in the index, and the only wrong answer is the one that says nothing
 * about it. A dropped entry that claims nothing is passed over: no note stands
 * behind it, and the row would name nothing the room could act on.
 */
function memorizedConversations(absorbEvents: readonly AbsorbEventRecord[], checkpoints: readonly CheckpointEventRecord[], skipped: SkippedConversation[]): MemorizedConversation[] {
	// By id first, so a room with a long history does not walk its whole
	// checkpoint list once per memorized conversation: a group holds only the
	// times that one id was used, which is the number of Memorizes the room has
	// had. By checkpoint id for the records that name theirs.
	const byRecentContextId = new Map<string, CheckpointEventRecord[]>();
	const byCheckpointId = new Map<string, CheckpointEventRecord>();
	for (const checkpoint of checkpoints) {
		byCheckpointId.set(checkpoint.checkpointId, checkpoint);
		const group = byRecentContextId.get(checkpoint.recentContextId);
		if (group) group.push(checkpoint);
		else byRecentContextId.set(checkpoint.recentContextId, [checkpoint]);
	}
	// A Remember any record names is spoken for before the time rule runs: a
	// name is a fact and the rule is a guess, so a guess may only fill what the
	// facts leave.
	const named = new Set<string>();
	for (const absorb of absorbEvents) {
		for (const session of absorb.run?.sessions ?? []) {
			if (session.checkpointId) named.add(session.checkpointId);
		}
	}
	// Keyed by the claimed checkpoint, so a claim is made once per Remember and
	// a repeat of a named claim replaces the earlier row in place.
	const memorized = new Map<string, MemorizedConversation>();
	// A session the person asked to be left out leaves Recent Context with the
	// same save and is not memorized: it becomes no document, but on a record
	// without names it still takes its Remember out of the running, or the next
	// use of its id would be handed the conversation that was left out.
	const leftOut = new Set<string>();
	for (const absorb of absorbEvents) {
		const at = Date.parse(absorb.approvedAt);
		for (const session of absorb.run?.sessions ?? []) {
			if (session.outcome === "skipped") {
				if (session.checkpointId) continue; // named, so already out of the time rule
				const taken = (byRecentContextId.get(session.id) ?? []).find((checkpoint) => !named.has(checkpoint.checkpointId) && !memorized.has(checkpoint.checkpointId) && !leftOut.has(checkpoint.checkpointId) && Date.parse(checkpoint.approvedAt) <= at);
				if (taken) leftOut.add(taken.checkpointId);
				continue;
			}
			if (session.outcome !== "folded" && session.outcome !== "dropped") continue;
			if (session.checkpointId) {
				const checkpoint = byCheckpointId.get(session.checkpointId);
				if (!checkpoint) {
					if (session.outcome === "folded") {
						skipped.push({ recentContextId: session.id, checkpointId: session.checkpointId, why: "the Remember's record for this folded conversation is gone, so its transcript cannot be found" });
					}
					continue;
				}
				memorized.set(checkpoint.checkpointId, { recentContextId: session.id, checkpoint, outcome: session.outcome });
				continue;
			}
			// The group is oldest first, so the first one standing is the oldest that qualifies.
			const match = (byRecentContextId.get(session.id) ?? []).find((checkpoint) => !named.has(checkpoint.checkpointId) && !memorized.has(checkpoint.checkpointId) && !leftOut.has(checkpoint.checkpointId) && Date.parse(checkpoint.approvedAt) <= at);
			if (!match) {
				if (session.outcome === "folded") {
					skipped.push({ recentContextId: session.id, why: "no Remember of this conversation was recorded before the Memorize that folded it, so which conversation it was cannot be told from another use of the same id" });
				}
				continue;
			}
			memorized.set(match.checkpointId, { recentContextId: session.id, checkpoint: match, outcome: session.outcome });
		}
	}
	return [...memorized.values()];
}

// --- transcripts -------------------------------------------------------------

/** One turn of a closed conversation, as the search stores it. */
interface TranscriptTurn {
	speaker: "user" | "assistant";
	text: string;
}

function textOfContent(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		const block = part as { type?: unknown; text?: unknown };
		if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n").trim();
}

/**
 * The turns the conversation is searched by: what the person said and what the
 * room answered. Tool results, command output and the summaries a compaction
 * leaves behind are the turn's machinery rather than its words, and a search
 * that returned them would answer a question about a conversation with its
 * plumbing.
 */
function transcriptTurns(messages: readonly unknown[]): TranscriptTurn[] {
	const turns: TranscriptTurn[] = [];
	for (const raw of messages) {
		const message = raw as { role?: unknown; content?: unknown };
		if (message?.role !== "user" && message?.role !== "assistant") continue;
		const text = textOfContent(message.content);
		if (!text) continue;
		turns.push({ speaker: message.role, text });
	}
	return turns;
}

/**
 * A message split at its sentence ends, into pieces that each fit the limit
 * once the speaker is in front of them. Only ever reached by a message that is
 * longer than a whole chunk on its own; a sentence longer than the limit is cut
 * where the limit falls, because there is nothing smaller left to cut at.
 */
function splitOversizedMessage(speaker: string, text: string, limit: number): string[] {
	const room = limit - `${speaker}: `.length;
	const sentences = text.match(/[^.!?\n]*(?:[.!?]+|\n+|$)/g)?.filter((sentence) => sentence.length > 0) ?? [text];
	const pieces: string[] = [];
	let current = "";
	const flush = () => {
		const trimmed = current.trim();
		if (trimmed) pieces.push(`${speaker}: ${trimmed}`);
		current = "";
	};
	for (const sentence of sentences) {
		let rest = sentence;
		while (rest.length > room) {
			flush();
			pieces.push(`${speaker}: ${rest.slice(0, room)}`);
			rest = rest.slice(room);
		}
		if (current.length + rest.length > room) flush();
		current += rest;
	}
	flush();
	return pieces;
}

/**
 * The chunks of one conversation. Messages are the seam: a chunk holds whole
 * messages and stops at the last one that fits, because a question is answered
 * by what somebody said and a half-sentence answers nothing. The one exception
 * is a message that is bigger than a chunk by itself, which is split at its
 * sentence ends.
 */
function chunkTurns(turns: readonly TranscriptTurn[], limit = CONVERSATION_CHUNK_CHARS): { text: string; speakers: string[] }[] {
	const chunks: { text: string; speakers: string[] }[] = [];
	let lines: string[] = [];
	let speakers: string[] = [];
	let length = 0;
	const flush = () => {
		if (lines.length === 0) return;
		chunks.push({ text: lines.join("\n"), speakers });
		lines = [];
		speakers = [];
		length = 0;
	};
	const take = (line: string, speaker: string) => {
		if (lines.length > 0 && length + 1 + line.length > limit) flush();
		length += line.length + (lines.length > 0 ? 1 : 0); // the newline that joins it to the line before
		lines.push(line);
		if (!speakers.includes(speaker)) speakers.push(speaker);
	};
	for (const turn of turns) {
		const line = `${turn.speaker}: ${turn.text}`;
		if (line.length > limit) {
			flush();
			for (const piece of splitOversizedMessage(turn.speaker, turn.text, limit)) take(piece, turn.speaker);
			continue;
		}
		take(line, turn.speaker);
	}
	flush();
	return chunks;
}

/** What a dropped conversation's origin line says after the day: the transcript is all memory kept of it. */
const NO_NOTES_TAKEN = " (no notes taken)";

function conversationDocuments(
	agentId: string,
	memorized: readonly MemorizedConversation[],
	runtimeCwd: string,
	watchList: WatchedFile[],
	skipped: SkippedConversation[],
): SearchDocument[] {
	const instance = createPersistentAgentInstance(agentId);
	// First pass: the conversations that can be read. Only these become
	// documents, so only these count when a day is shared further down.
	const readable: { entry: MemorizedConversation; turns: TranscriptTurn[] }[] = [];
	for (const entry of memorized) {
		const { recentContextId, checkpoint } = entry;
		const boundary = checkpoint.runtimeBoundary;
		const relPath = boundary?.oldSessionFileRelPath;
		const sessionId = boundary?.oldRuntimeSessionId;
		if (!relPath || !sessionId) {
			skipped.push({ recentContextId, checkpointId: checkpoint.checkpointId, why: "the conversation this Remember closed kept no session file" });
			continue;
		}
		try {
			watchList.push(watched(instance.resolveRootRelativePath(relPath, "memory search transcript path")));
		} catch {
			// a path that will not resolve is caught again by the read below
		}
		let turns: TranscriptTurn[];
		try {
			const session = openPersistentAgentPiSessionManager(agentId, { sessionFileRelPath: relPath, sessionId }, runtimeCwd);
			turns = transcriptTurns(session.buildSessionContext().messages);
		} catch (error) {
			skipped.push({ recentContextId, checkpointId: checkpoint.checkpointId, why: error instanceof Error ? error.message : String(error) });
			continue;
		}
		if (turns.length === 0) {
			skipped.push({ recentContextId, checkpointId: checkpoint.checkpointId, why: "the conversation's transcript holds no words of its own" });
			continue;
		}
		readable.push({ entry, turns });
	}
	// How many indexed conversations share a day, and a minute of that day.
	// approvedAt is an ISO string in UTC (Date.toISOString), read as stored:
	// characters 0 to 10 are the day, 11 to 16 the minute, 11 to 19 the second.
	const onDay = new Map<string, number>();
	const onMinute = new Map<string, number>();
	for (const { entry } of readable) {
		const day = entry.checkpoint.approvedAt.slice(0, 10);
		const minute = entry.checkpoint.approvedAt.slice(0, 16);
		onDay.set(day, (onDay.get(day) ?? 0) + 1);
		onMinute.set(minute, (onMinute.get(minute) ?? 0) + 1);
	}
	const docs: SearchDocument[] = [];
	for (const { entry, turns } of readable) {
		const { recentContextId, checkpoint, outcome } = entry;
		const date = checkpoint.approvedAt.slice(0, 10);
		const chunks = chunkTurns(turns);
		// A Recent Context id is handed back to a later conversation once a
		// Memorize empties the section, so the conversation it was said in is part
		// of a chunk's address: without it two conversations two Memorizes apart
		// would share document ids, and whatever reads a result by id (a rank, a
		// deduplication, a later citation) would read one of them as the other.
		// The Recent Context id stays in the document id and in the meta, for the
		// tools. The origin is what the room reads and repeats, so it names the
		// day, and the time where the day is shared, and never the id.
		const conversation = checkpoint.conversationId || checkpoint.checkpointId;
		// A conversation alone on its day carries no time. Where the day is
		// shared every conversation on it says HH:MM UTC, and HH:MM:SS UTC where
		// the minute is shared too, so two origins of one room can be told apart
		// and a person in another zone is told which clock the time is on.
		const sharedDay = (onDay.get(date) ?? 0) > 1;
		const sharedMinute = (onMinute.get(checkpoint.approvedAt.slice(0, 16)) ?? 0) > 1;
		const time = sharedDay ? ` at ${checkpoint.approvedAt.slice(11, sharedMinute ? 19 : 16)} UTC` : "";
		// A dropped conversation says so where the row is read: the person and
		// the room both see why no note carries the point.
		const origin = `from a conversation on ${date}${time}${outcome === "dropped" ? NO_NOTES_TAKEN : ""}`;
		chunks.forEach((chunk, index) => {
			docs.push({
				id: `${recentContextId}#${index + 1}@${conversation}`,
				source: "conversation",
				date,
				origin,
				text: chunk.text,
				meta: {
					rcId: recentContextId,
					conversationId: checkpoint.conversationId,
					outcome,
					chunk: index + 1,
					chunks: chunks.length,
					speakers: chunk.speakers,
				},
			});
		});
	}
	return docs;
}

// --- the collection ----------------------------------------------------------

/**
 * Every document one room can be searched on, and every file the answer was
 * built from. Pure as far as the disk is concerned: it reads, and the files it
 * read come back with it so a caller can tell when its answer went stale.
 */
export function collectRoomDocuments(roomId: string, options: CollectRoomDocumentsOptions = {}): RoomDocuments {
	const instance = createPersistentAgentInstance(roomId);
	const meta = instance.readAgentJson();
	const l1bPath = instance.l1bCurrentPath(meta);
	const archiveEntriesPath = path.join(instance.l1bArchiveDir(meta), MEMORY_ARCHIVE_ENTRIES_FILE);
	const builtFrom: WatchedFile[] = [watched(l1bPath), watched(archiveEntriesPath)];
	const skipped: SkippedConversation[] = [];

	const checkpoints = readEventRecords<CheckpointEventRecord>(instance.checkpointEventDir(), builtFrom);
	const absorbs = readEventRecords<AbsorbEventRecord>(instance.absorbEventDir(), builtFrom);
	const docs = [
		...noteDocuments(l1bPath),
		...archiveDocuments(instance.agentId),
		...conversationDocuments(instance.agentId, memorizedConversations(absorbs, checkpoints, skipped), options.runtimeCwd || process.cwd(), builtFrom, skipped),
	];
	return { docs, builtFrom, skipped };
}

// --- the cache ---------------------------------------------------------------

/**
 * One corpus per room, for this process. A room is searched many times per
 * turn and its files change a handful of times a day, so the build is done
 * when something moved and not when something asked.
 */
const ROOM_CORPUS = new Map<string, RoomCorpus>();

function countBySource(docs: readonly SearchDocument[]): Record<SearchSource, number> {
	const counts: Record<SearchSource, number> = { note: 0, archive: 0, conversation: 0 };
	for (const doc of docs) counts[doc.source] += 1;
	return counts;
}

/**
 * The room's corpus, built once and handed back until a file it was built from
 * moves. "Moves" is every file the build read: the memory file, the archive,
 * both event directories AND every record in them, and every transcript a
 * memorized conversation was read from, so a new Remember, a new Memorize, a
 * hand edit or a rewritten transcript each rebuild it, and nothing else does.
 */
export function loadRoomCorpus(roomId: string, options: CollectRoomDocumentsOptions = {}): RoomCorpus {
	const agentId = createPersistentAgentInstance(roomId).agentId;
	const cached = ROOM_CORPUS.get(agentId);
	if (cached && watchedStillHolds(cached.builtFrom)) return cached;
	const { docs, builtFrom, skipped } = collectRoomDocuments(agentId, options);
	const corpus: RoomCorpus = { docs, index: buildIndex(docs), counts: countBySource(docs), builtFrom, skipped };
	ROOM_CORPUS.set(agentId, corpus);
	return corpus;
}

/** Drops one room's corpus, or every room's. The next read builds it again. */
export function invalidateRoomCorpus(roomId?: string): void {
	if (roomId === undefined) {
		ROOM_CORPUS.clear();
		return;
	}
	try {
		ROOM_CORPUS.delete(createPersistentAgentInstance(roomId).agentId);
	} catch {
		ROOM_CORPUS.delete(roomId); // an id that will not normalize can still have been cached under its own spelling
	}
}
