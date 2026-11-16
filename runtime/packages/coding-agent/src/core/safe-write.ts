// The one way a stored file is written so a kill or a power cut leaves it
// whole: the old bytes or the new ones, never a mix. The web server imports it
// from here because the runtime cannot import the web server.
//
// A replace writes a temporary file beside the target, flushes it to the disk,
// renames it over the target, then flushes the folder so the rename itself
// survives. The order matters: a rename that reaches the disk before the
// bytes it points at leaves an empty file after a power cut.
//
// The functions stay synchronous: every save runs from its intent to its clear
// without yielding (memory-commit.ts in the web server says why).

import fs from "node:fs";
import path from "node:path";

/** Answers from a file system that cannot flush a folder. The rename itself landed, so none of them fails a save. */
const FOLDER_SYNC_REFUSALS = new Set(["EACCES", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"]);

/** Windows answers these when something still holds the target open: a scanner, an indexer, a reader. */
const WINDOWS_FILE_BUSY = new Set(["EACCES", "EBUSY", "EPERM"]);
const WINDOWS_RENAME_TRIES = 8;
const WINDOWS_RENAME_PAUSE_MS = 20;

function pause(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Flushes a folder's entries to the disk. Windows has no such call: a folder cannot be opened for it, and NTFS journals the rename. */
export function syncFolder(folder: string): void {
	if (process.platform === "win32") return;
	let fd: number;
	try {
		fd = fs.openSync(folder, "r");
	} catch (error) {
		if (FOLDER_SYNC_REFUSALS.has((error as NodeJS.ErrnoException).code ?? "")) return;
		throw error;
	}
	try {
		fs.fsyncSync(fd);
	} catch (error) {
		if (!FOLDER_SYNC_REFUSALS.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
	} finally {
		fs.closeSync(fd);
	}
}

/** Renames over the target; on Windows a target held open gets a short, bounded wait before the failure stands. */
export function renameOver(from: string, to: string): void {
	for (let tries = 1; ; tries += 1) {
		try {
			fs.renameSync(from, to);
			return;
		} catch (error) {
			const busy = process.platform === "win32" && WINDOWS_FILE_BUSY.has((error as NodeJS.ErrnoException).code ?? "");
			if (!busy || tries >= WINDOWS_RENAME_TRIES) throw error;
			pause(tries * WINDOWS_RENAME_PAUSE_MS);
		}
	}
}

function writeAndFlush(file: string, content: string | Uint8Array, flags: string, mode: number): void {
	const fd = fs.openSync(file, flags, mode);
	try {
		fs.writeFileSync(fd, content);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

export interface WriteFileAtomicOptions {
	/** The file's permissions; private by default. */
	mode?: number;
	/** Names the temporary file with a leading dot, for a folder whose listing shows every other file. */
	hiddenTemp?: boolean;
	/** Refuses with EEXIST rather than replace a file already there, on a file system with hard links. */
	exclusive?: boolean;
}

/** Lands a file only under a free name: a hard link, unlike a rename, never replaces what is there. A file system with no hard links gets the rename, which keeps the file whole and gives up only the refusal. */
function landOnFreeName(from: string, to: string): void {
	try {
		fs.linkSync(from, to);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") throw error;
		renameOver(from, to);
		return;
	}
	try {
		fs.rmSync(from, { force: true });
	} catch {
		// The file has landed. What stays is what a kill can leave too.
	}
}

/**
 * Replaces a file whole, or creates it. A failure leaves the target as it was
 * and takes the temporary file with it; only a kill can leave one behind, and
 * its name still starts with the target's, so whoever erases the target finds it.
 */
export function writeFileAtomic(file: string, content: string | Uint8Array, options: WriteFileAtomicOptions = {}): void {
	const folder = path.dirname(file);
	const name = `${path.basename(file)}.tmp-${process.pid}-${Date.now()}`;
	const temporary = path.join(folder, options.hiddenTemp ? `.${name}` : name);
	try {
		writeAndFlush(temporary, content, "wx", options.mode ?? 0o600);
		if (options.exclusive) landOnFreeName(temporary, file);
		else renameOver(temporary, file);
	} catch (error) {
		fs.rmSync(temporary, { force: true });
		throw error;
	}
	syncFolder(folder);
}

/** Appends to a file and flushes it, so what a caller was told is stored survives a power cut. A kill can still cut the bytes: a reader of the file skips a broken last line. */
export function appendFileFlushed(file: string, content: string): void {
	writeAndFlush(file, content, "a", 0o600);
}
