// What a Remember has already read, kept on disk.
//
// Each part's note is written the moment it is accepted, to
// `<room>/runtime/remember/<conversationId>/parts.json`. A Remember that
// stopped (a failure, a cancel, a restart) and is generated again pays only
// for the parts it lacks. A note is found by a key over the model, the
// density and the part's prompt without its number and count, which holds
// the transcript stretch, its place in the conversation, the prompt version
// and the steering, so a changed conversation or a changed request never
// reuses an old note, and a replan that adds a part re-reads only what changed.
//
// The folder also keeps a finished job's proposal (remember-job.ts). It goes
// at Save, Discard and Forget. Notes hold conversation words, so the folder
// stays inside the room's own folder, like the conversation itself.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const CONVERSATION_ID = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;

/** The folder a Remember of this conversation works in. */
export function rememberWorkDir(roomDir: string, conversationId: string): string {
	if (!CONVERSATION_ID.test(conversationId) || conversationId.includes("..")) throw new Error("invalid conversation id");
	return path.join(roomDir, "runtime", "remember", conversationId);
}

function partsPath(roomDir: string, conversationId: string): string {
	return path.join(rememberWorkDir(roomDir, conversationId), "parts.json");
}

/** The key a part's note is kept under. */
export function rememberPartKey(input: { model: { provider: string; model: string }; density: string; prompt: string }): string {
	return crypto.createHash("sha256").update(JSON.stringify([input.model.provider, input.model.model, input.density, input.prompt])).digest("hex");
}

function readNotes(roomDir: string, conversationId: string): Record<string, string> {
	try {
		const parsed = JSON.parse(fs.readFileSync(partsPath(roomDir, conversationId), "utf-8")) as { notes?: unknown };
		return parsed.notes && typeof parsed.notes === "object" ? (parsed.notes as Record<string, string>) : {};
	} catch {
		return {};
	}
}

/** Writes one file of a Remember's folder whole, or not at all. */
export function writeRememberFile(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
	fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
	fs.renameSync(tmp, file);
}

/** A note this conversation's Remember already paid for, or null. */
export function readRememberPartNote(roomDir: string, conversationId: string, key: string): string | null {
	const note = readNotes(roomDir, conversationId)[key];
	return typeof note === "string" && note.trim() ? note : null;
}

/** Keeps an accepted note. A note that cannot be written is only read again next time. */
export function keepRememberPartNote(roomDir: string, conversationId: string, key: string, note: string): void {
	try {
		writeRememberFile(partsPath(roomDir, conversationId), { schemaVersion: 1, notes: { ...readNotes(roomDir, conversationId), [key]: note } });
	} catch (error) {
		console.error(`[remember] a part's note could not be kept: ${(error as Error)?.name ?? "Error"}`);
	}
}

/** How many notes are kept for this conversation: the restart line counts them. */
export function countRememberPartNotes(roomDir: string, conversationId: string): number {
	return Object.keys(readNotes(roomDir, conversationId)).length;
}

/** Deletes the conversation's notes and kept proposal: Save, Discard and Forget. */
export function clearRememberWork(roomDir: string, conversationId: string): void {
	try {
		fs.rmSync(rememberWorkDir(roomDir, conversationId), { recursive: true, force: true });
	} catch {
		// an id that is not a conversation's has no folder
	}
}
