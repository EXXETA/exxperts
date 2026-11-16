// The small pieces of a conversation's turns that the next request needs and a
// restart must not lose, one file per piece and conversation in the room's
// folder: runtime/turn-pieces/<conversation>.<piece>.json. Each piece has one
// writer, and none is copied into memory, so the file is all there is:
//
// - running: the keyed turn running now and its question (persistent-agent-turns.ts);
//   a file left by a process that is gone is a turn a kill ended, told at the
//   room's settle;
// - items: the latest-turn marker, the recent turns' keys and the ids removed
//   on purpose lately (persistent-agent-turns.ts);
// - taken: the messages the last turn took or gave back (room-socket.ts);
// - note: what the person saw of an answer their Stop or cut ended, for the
//   next message (room-socket.ts);
// - kept: the landing of a message the room offered back, waiting for the
//   page to say it kept the message above (room-socket.ts).
//
// Each write goes whole through the runtime's writeFileAtomic, so a kill
// leaves the last whole file and at most a temporary one beside it, which no
// reader opens. A file that is missing, torn or of another shape reads as no
// piece. The running turn, the note and the kept landing hold the
// conversation's words, so
// Forget and a conversation's delete erase every piece (`turnPieceFiles`).

import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "@exxeta/exxperts-runtime";
import type { AnswerNote } from "./cut-answer-note.js";
import { DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT, persistentAgentRootPath } from "./persistent-room-workspace-policy.js";
import { readTurnKey, type ThreadItem } from "./thread-items-by-id.js";

type TurnPiece = "running" | "items" | "taken" | "note" | "kept";

const TURN_PIECES_DIR = "turn-pieces";
const SCHEMA_VERSION = 1;

function turnPiecePath(agentId: string, conversationId: string, piece: TurnPiece): string | null {
	// A conversation id names a file: anything that could leave the folder is no conversation.
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(conversationId)) return null;
	return path.join(persistentAgentRootPath(agentId, DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT), "runtime", TURN_PIECES_DIR, `${conversationId}.${piece}.json`);
}

/** The piece's value as written, or null: no file, a torn one, or another shape. Each piece's reader below takes its fields leniently. */
function readTurnPiece(agentId: string, conversationId: string, piece: TurnPiece): unknown {
	const file = turnPiecePath(agentId, conversationId, piece);
	if (!file) return null;
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as { schemaVersion?: unknown; value?: unknown } | null;
		return parsed?.schemaVersion === SCHEMA_VERSION && parsed.value !== undefined ? parsed.value : null;
	} catch {
		return null;
	}
}

function writeTurnPiece(agentId: string, conversationId: string, piece: TurnPiece, value: unknown): void {
	const file = turnPiecePath(agentId, conversationId, piece);
	if (!file) return;
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	writeFileAtomic(file, JSON.stringify({ schemaVersion: SCHEMA_VERSION, value }));
}

function dropTurnPiece(agentId: string, conversationId: string, piece: TurnPiece): void {
	const file = turnPiecePath(agentId, conversationId, piece);
	if (file) fs.rmSync(file, { force: true });
}

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const texts = (value: unknown): string[] => (Array.isArray(value) ? value.filter(isText) : []);
/** A landing's items: each an object with an id. */
const ownItems = (value: unknown): ThreadItem[] => (Array.isArray(value) ? value.filter((item): item is ThreadItem => !!item && typeof item === "object" && !Array.isArray(item) && isText((item as ThreadItem).id)) : []);

// --- running ---------------------------------------------------------------

/** A keyed turn that began and has not finished, with what its landing puts first and where (thread-items-by-id.ts `landTurnItems`): its question as the bubble showed it, which the page may not have saved yet. */
export interface RunningTurn { turnId: string; key: string; startedAt: number; continued: boolean; startAnchorId?: string; own: ThreadItem[] }

export function readRunningTurn(agentId: string, conversationId: string): RunningTurn | null {
	const raw = readTurnPiece(agentId, conversationId, "running") as Partial<RunningTurn> | null;
	const key = readTurnKey(raw?.key);
	if (!raw || !isText(raw.turnId) || !key || typeof raw.startedAt !== "number") return null;
	return { turnId: raw.turnId, key, startedAt: raw.startedAt, continued: raw.continued === true, ...(isText(raw.startAnchorId) ? { startAnchorId: raw.startAnchorId } : {}), own: ownItems(raw.own) };
}

/** The conversations of a room with a running-turn file: one folder read, none when the folder is missing. */
export function runningTurnConversations(roomDir: string): string[] {
	let names: string[] = [];
	try { names = fs.readdirSync(path.join(roomDir, "runtime", TURN_PIECES_DIR)); } catch { return []; }
	return names.filter((name) => name.endsWith(".running.json")).map((name) => name.slice(0, -".running.json".length));
}

export const writeRunningTurn = (agentId: string, conversationId: string, turn: RunningTurn): void => writeTurnPiece(agentId, conversationId, "running", turn);
export const dropRunningTurn = (agentId: string, conversationId: string): void => dropTurnPiece(agentId, conversationId, "running");

// --- items -----------------------------------------------------------------

/** What a conversation's keyed turns leave for later requests (thread-items-by-id.ts): the latest-turn marker, the keys of recent turns in start order and the ids removed on purpose lately. */
export interface TurnItemsMemory { marker?: string; keys: string[]; removed: string[] }

export function readTurnItemsMemory(agentId: string, conversationId: string): TurnItemsMemory {
	const raw = readTurnPiece(agentId, conversationId, "items") as Partial<TurnItemsMemory> | null;
	return { ...(isText(raw?.marker) ? { marker: raw.marker } : {}), keys: texts(raw?.keys), removed: texts(raw?.removed) };
}

export const writeTurnItemsMemory = (agentId: string, conversationId: string, memory: TurnItemsMemory): void => writeTurnPiece(agentId, conversationId, "items", memory);

// --- taken -----------------------------------------------------------------

/** A message the last turn took in, or one the person took back out of it (`withdrawn`). */
export interface TakenSteer { id: string; withdrawn?: true }

export function readTakenSteers(agentId: string, conversationId: string): TakenSteer[] {
	const raw = readTurnPiece(agentId, conversationId, "taken");
	return Array.isArray(raw) ? raw.flatMap((entry: any) => (isText(entry?.id) ? [{ id: entry.id, ...(entry.withdrawn === true ? { withdrawn: true as const } : {}) }] : [])) : [];
}

/** The newest `kept` only: it bounds what one conversation holds. */
export function addTakenSteer(agentId: string, conversationId: string, steer: TakenSteer, kept: number): void {
	writeTurnPiece(agentId, conversationId, "taken", [...readTakenSteers(agentId, conversationId), steer].slice(-kept));
}

export const dropTakenSteers = (agentId: string, conversationId: string): void => dropTurnPiece(agentId, conversationId, "taken");

// --- note ------------------------------------------------------------------

export function readAnswerNote(agentId: string, conversationId: string): AnswerNote | undefined {
	const raw = readTurnPiece(agentId, conversationId, "note") as Partial<AnswerNote> | null;
	return raw && (raw.kind === "cut" || raw.kind === "stop" || raw.kind === "server-stop") && isText(raw.shown) ? { kind: raw.kind, shown: raw.shown } : undefined;
}

/** The note the next message carries; none drops it. */
export function keepAnswerNoteFor(agentId: string, conversationId: string, note: AnswerNote | undefined): void {
	if (note) writeTurnPiece(agentId, conversationId, "note", note);
	else dropTurnPiece(agentId, conversationId, "note");
}

// --- kept ------------------------------------------------------------------

/** A keyed turn's landing as its items stand, and where its first item goes (thread-items-by-id.ts `landTurnItems`). */
export interface KeyedLanding { key: string; continued: boolean; startAnchorId?: string; own: ThreadItem[]; gone: string[] }

export function readKeptLanding(agentId: string, conversationId: string): KeyedLanding | null {
	const raw = readTurnPiece(agentId, conversationId, "kept") as Partial<KeyedLanding> | null;
	const key = readTurnKey(raw?.key);
	if (!raw || !key || !Array.isArray(raw.own)) return null;
	return { key, continued: raw.continued === true, ...(isText(raw.startAnchorId) ? { startAnchorId: raw.startAnchorId } : {}), own: ownItems(raw.own), gone: texts(raw.gone) };
}

export const writeKeptLanding = (agentId: string, conversationId: string, landing: KeyedLanding): void => writeTurnPiece(agentId, conversationId, "kept", landing);
export const dropKeptLanding = (agentId: string, conversationId: string): void => dropTurnPiece(agentId, conversationId, "kept");

/** Every piece of a conversation in a room's folder, with any temporary file a kill left beside one. */
export function turnPieceFiles(roomDir: string, conversationId: string): string[] {
	const dir = path.join(roomDir, "runtime", TURN_PIECES_DIR);
	let names: string[] = [];
	try { names = fs.readdirSync(dir); } catch { return []; }
	return names.filter((name) => name.startsWith(`${conversationId}.`) && /^[a-z]+\.json(\.tmp-.*)?$/.test(name.slice(conversationId.length + 1))).map((name) => path.join(dir, name));
}
