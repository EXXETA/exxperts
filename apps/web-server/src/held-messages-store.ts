// Messages the person queued while a room answered that no answer took and
// no window received: the window was gone, or the server stopped. They wait
// here, one file per conversation, until the person sends, edits or removes
// them; nothing sends them by itself. The running answer's own waiting
// messages stay in its memory (room-socket.ts `pendingSteers`); only the ones
// it gives up come here.
//
// Each write reads the file, changes it and puts it back through a temporary
// file and a rename, so a write cut halfway leaves the last whole list, and
// holding a message twice keeps it once (by id). The list never passes
// held-message-limits.ts: a message past them is refused, and none held
// already is ever pushed out.

import fs from "node:fs";
import path from "node:path";
import { fitsHeldLimits, MAX_QUEUED_MESSAGE_CHARS } from "./held-message-limits.js";
import { DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT, persistentAgentRootPath } from "./persistent-room-workspace-policy.js";

export interface HeldMessage {
	id: string;
	text: string;
}

const HELD_MESSAGES_DIR = "held-messages";
const HELD_SCHEMA_VERSION = 1;

function heldMessagesPath(agentId: string, conversationId: string, root: string): string | null {
	// A conversation id names a file: anything that could leave the folder is no conversation.
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(conversationId)) return null;
	return path.join(persistentAgentRootPath(agentId, root), "runtime", HELD_MESSAGES_DIR, `${conversationId}.json`);
}

/**
 * The files that hold a conversation's held messages in a room's folder: the
 * list and any leftover of a write a crash cut short. Forget erases them.
 */
export function heldMessageFiles(roomDir: string, conversationId: string): string[] {
	const dir = path.join(roomDir, "runtime", HELD_MESSAGES_DIR);
	let names: string[] = [];
	try { names = fs.readdirSync(dir); } catch { return []; }
	return names.filter((name) => name === `${conversationId}.json` || (name.startsWith(`${conversationId}.json.`) && name.endsWith(".tmp"))).map((name) => path.join(dir, name));
}

/** The messages a page sends, read leniently: an id and some words each, none longer than a queued message may be. */
export function readHeldMessageList(raw: unknown): HeldMessage[] {
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((entry: any) => (typeof entry?.id === "string" && entry.id && entry.id.length <= 128 && typeof entry?.text === "string" && entry.text.trim() && entry.text.length <= MAX_QUEUED_MESSAGE_CHARS ? [{ id: entry.id, text: entry.text }] : []));
}

function readFile(file: string): HeldMessage[] {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as { schemaVersion?: unknown; messages?: unknown } | null;
		return parsed?.schemaVersion === HELD_SCHEMA_VERSION ? readHeldMessageList(parsed.messages) : [];
	} catch {
		return [];
	}
}

function writeFile(file: string, messages: HeldMessage[]): void {
	if (messages.length === 0) {
		fs.rmSync(file, { force: true });
		return;
	}
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: HELD_SCHEMA_VERSION, messages }), { mode: 0o600 });
	fs.renameSync(temporary, file);
}

/** The conversation's held messages, oldest first. Never throws: an absent or damaged file holds none. */
export function readHeldMessages(agentId: string, conversationId: string, root = DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT): HeldMessage[] {
	const file = heldMessagesPath(agentId, conversationId, root);
	return file ? readFile(file) : [];
}

/**
 * Adds these after the ones held already; an id held already keeps its place.
 * Returns the ids it could not keep, past the limits: those stay with the page
 * that has them, and none held already goes.
 */
export function holdMessages(agentId: string, conversationId: string, messages: readonly HeldMessage[], root = DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT): string[] {
	const file = heldMessagesPath(agentId, conversationId, root);
	if (!file || messages.length === 0) return [];
	const held = readFile(file);
	const known = new Set(held.map((message) => message.id));
	const refused: string[] = [];
	const list = [...held];
	for (const message of messages) {
		if (!message.id || !message.text.trim() || known.has(message.id)) continue;
		if (!fitsHeldLimits(list, message.text)) { refused.push(message.id); continue; }
		known.add(message.id);
		list.push(message);
	}
	if (list.length !== held.length) writeFile(file, list);
	return refused;
}

/** Takes these ids off the list: the person sent, edited or removed them. */
export function dropHeldMessages(agentId: string, conversationId: string, ids: readonly string[], root = DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT): void {
	const file = heldMessagesPath(agentId, conversationId, root);
	if (!file || ids.length === 0) return;
	const held = readFile(file);
	const kept = held.filter((message) => !ids.includes(message.id));
	if (kept.length !== held.length) writeFile(file, kept);
}
