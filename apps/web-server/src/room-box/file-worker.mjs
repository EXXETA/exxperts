// One file tool call, run inside the room's box. The server spawns this under the
// box's rules for file tools, writes one request as JSON on stdin and reads one
// answer on stdout: a JSON line, then the file's raw bytes for a read. It does
// one job and exits. The Mac decides at every open, on the real path, so a link a
// job left behind leads nowhere the rules don't open.
//
// Node's built-ins only, and no secret: the server trusts nothing here but the bytes.
import fs from "node:fs";
import path from "node:path";

const { O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
// Never wait on a pipe or take a terminal: what opens is judged by fstat.
const NO_WAIT = (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOCTTY ?? 0);
const ZIP_LOCAL_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
// Far past any real walk's answer, so a folder of millions of files can't fill the server.
const WALK_ENTRIES_LIMIT = 100_000;
const UNREADABLE_KEPT = 1_000;
// A replace starts only when the disk holds the whole new file and this much more, for its
// blocks' rounding and the disk's own records. The old bytes count for nothing: a snapshot
// or a clone can still hold them after the truncate.
const SPACE_MARGIN_BYTES = 16 * 1024 * 1024;

/** A failure the server turns into the model's line, by its code. */
class Refused extends Error {
	constructor(code) {
		super(code);
		this.code = code;
	}
}

// As the server folds a name: a Mac's disk opens `.ENV` as `.env` and `ſ` as `s`.
const fold = (name) => name.toUpperCase().toLowerCase();
const byName = (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase());

function withOpen(target, flags, use) {
	const fd = fs.openSync(target, flags | NO_WAIT);
	try {
		return use(fd);
	} finally {
		fs.closeSync(fd);
	}
}

function startsAsZip(fd) {
	const head = Buffer.alloc(ZIP_LOCAL_HEADER.length);
	return fs.readSync(fd, head, 0, head.length, 0) === head.length && head.equals(ZIP_LOCAL_HEADER);
}

/** Whether a file named as a Keynote deck is one: a regular file that starts as a zip does. Any error is no. */
function isDeckFile(target) {
	try {
		return withOpen(target, O_RDONLY | O_NOFOLLOW, (fd) => fs.fstatSync(fd).isFile() && startsAsZip(fd));
	} catch {
		return false;
	}
}

const deckNamed = (name, decks) => decks.some((suffix) => fold(name).endsWith(suffix));

function kindOf(entry) {
	if (entry.isSymbolicLink()) return "link";
	if (entry.isDirectory()) return "dir";
	return entry.isFile() ? "file" : "other";
}

function readAll(fd, size) {
	const bytes = Buffer.alloc(size);
	let at = 0;
	while (at < size) {
		const read = fs.readSync(fd, bytes, at, size - at, at);
		if (read === 0) break;
		at += read;
	}
	return bytes.subarray(0, at);
}

const ops = {
	/**
	 * A regular file's bytes, up to `maxBytes`. A deck's name needs a deck's bytes,
	 * read on the same descriptor. The server hands over the real path, so a link
	 * at its last part came after the check, and refuses.
	 */
	read({ path: target, maxBytes, requireZip }) {
		return withOpen(target, O_RDONLY | O_NOFOLLOW, (fd) => {
			const stat = fs.fstatSync(fd);
			if (!stat.isFile()) throw new Refused("ENOTFILE");
			if (stat.size > maxBytes) throw new Refused("ETOOBIG");
			if (requireZip && !startsAsZip(fd)) throw new Refused("ENOTZIP");
			const bytes = readAll(fd, stat.size);
			return { header: { size: bytes.length }, bytes };
		});
	},

	/** One folder's entries, with which deck names hold a deck. */
	list({ path: target, decks }) {
		const entries = fs.readdirSync(target, { withFileTypes: true }).map((entry) => {
			const kind = kindOf(entry);
			return { name: entry.name, kind, ...(kind === "file" && deckNamed(entry.name, decks) ? { deck: isDeckFile(path.join(target, entry.name)) } : {}) };
		});
		return { header: { entries } };
	},

	/**
	 * Files and folders below a folder, depth first, each folder's entries by name
	 * as the server's own walk orders them. Links aren't followed; folders named in
	 * `skips` aren't entered. A folder the rules close can't be read, so nothing
	 * below it comes back.
	 */
	walk({ path: start, skips, maxFolders, decks }) {
		const entries = [];
		let folders = 0;
		let folderLimit = false;
		let skipped = false;
		const visit = (folder, below) => {
			if (folderLimit || entries.length >= WALK_ENTRIES_LIMIT) return;
			if ((folders += 1) > maxFolders) {
				folderLimit = true;
				return;
			}
			let listed;
			try {
				listed = fs.readdirSync(folder, { withFileTypes: true }).sort(byName);
			} catch {
				return;
			}
			for (const entry of listed) {
				if (entries.length >= WALK_ENTRIES_LIMIT) return;
				const kind = kindOf(entry);
				const rel = below ? `${below}/${entry.name}` : entry.name;
				if (kind === "file") entries.push({ rel, kind, ...(deckNamed(entry.name, decks) ? { deck: isDeckFile(path.join(folder, entry.name)) } : {}) });
				if (kind !== "dir") continue;
				entries.push({ rel, kind });
				if (skips.includes(fold(entry.name))) skipped = true;
				else visit(path.join(folder, entry.name), rel);
			}
		};
		visit(start, "");
		return { header: { entries, folderLimit, skipped, entryLimit: entries.length >= WALK_ENTRIES_LIMIT } };
	},

	/** Lines that match, as the server's walk search finds them, with the lines around each when asked. */
	search(request) {
		const { path: start, isFile, literal, ignoreCase, glob, context, limit, deadline, skips, maxFolders, maxFileBytes, maxScanLineChars, maxLineChars, decks } = request;
		let regex;
		try {
			regex = new RegExp(literal ? request.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : request.pattern, ignoreCase ? "i" : "");
		} catch {
			throw new Refused("EPATTERN");
		}
		const globRegex = glob ? new RegExp(glob.source) : null;
		const wanted = (below) => !globRegex || globRegex.test(glob.slash ? below : path.posix.basename(below));
		const matches = [];
		const unreadable = [];
		const state = { folders: 0, matchLimit: false, folderLimit: false, timeLimit: false, largeFiles: 0, longLines: false, skipped: false };
		const over = () => state.matchLimit || state.folderLimit || state.timeLimit;
		const unread = (rel) => {
			if (unreadable.length < UNREADABLE_KEPT) unreadable.push(rel);
		};
		const clip = (line) => line.replace(/\r$/, "").slice(0, maxLineChars + 1);
		const scan = (file, rel) => {
			const deck = deckNamed(path.basename(file), decks);
			let text;
			try {
				text = withOpen(file, O_RDONLY | O_NOFOLLOW, (fd) => {
					const stat = fs.fstatSync(fd);
					if (!stat.isFile()) return null;
					if (deck && !startsAsZip(fd)) throw new Refused("ENOTZIP");
					if (stat.size > maxFileBytes) {
						state.largeFiles += 1;
						return null;
					}
					return readAll(fd, stat.size).toString("utf8");
				});
			} catch {
				return unread(rel);
			}
			if (text === null) return;
			const lines = text.split("\n");
			for (let index = 0; index < lines.length; index += 1) {
				if ((index & 255) === 0 && Date.now() > deadline) {
					state.timeLimit = true;
					return;
				}
				let probe = lines[index].replace(/\r$/, "");
				if (probe.length > maxScanLineChars) {
					probe = probe.slice(0, maxScanLineChars);
					state.longLines = true;
				}
				if (!regex.test(probe)) continue;
				const first = Math.max(0, index - context);
				matches.push({ rel, line: index + 1, text: clip(lines[index]), ...(context > 0 ? { around: { start: first + 1, lines: lines.slice(first, index + context + 1).map(clip) } } : {}) });
				if (matches.length >= limit) {
					state.matchLimit = true;
					return;
				}
			}
		};
		const visit = (folder, below) => {
			if (over()) return;
			if ((state.folders += 1) > maxFolders) {
				state.folderLimit = true;
				return;
			}
			if (Date.now() > deadline) {
				state.timeLimit = true;
				return;
			}
			let listed;
			try {
				listed = fs.readdirSync(folder, { withFileTypes: true }).sort(byName);
			} catch {
				return;
			}
			for (const entry of listed) {
				if (over()) return;
				const rel = below ? `${below}/${entry.name}` : entry.name;
				const kind = kindOf(entry);
				if (kind === "dir") {
					if (skips.includes(fold(entry.name))) state.skipped = true;
					else visit(path.join(folder, entry.name), rel);
				} else if (kind === "file" && wanted(rel)) {
					scan(path.join(folder, entry.name), rel);
				}
			}
		};
		let top = [];
		if (isFile) {
			if (wanted(path.basename(start))) scan(start, path.basename(start));
		} else {
			try {
				top = ops.list({ path: start, decks }).header.entries;
			} catch {
				// An unreadable folder has no entries to count; the walk finds nothing in it either.
			}
			visit(start, "");
		}
		return { header: { matches, unreadable, top, ...state } };
	},

	/**
	 * Creates or replaces a file. Without `overwrite` the open refuses a file
	 * already there, whenever it came. A file is replaced in place, so it keeps
	 * what the Mac holds on it: its owner, its access list, its tags; and only
	 * when the new bytes fit on its disk, so a full disk leaves it as it was. A
	 * deck's name changes only an existing deck. No link at the last part is followed;
	 * folders are made only when one is missing.
	 */
	write({ path: target, content, overwrite, requireZip }) {
		const bytes = Buffer.from(content, "utf8");
		if (!requireZip) {
			try {
				const fd = withFolders(target, () => fs.openSync(target, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | NO_WAIT, 0o644));
				replaceAllAndClose(fd, bytes);
				return { header: { existed: false, bytes: bytes.length } };
			} catch (error) {
				if (error?.code !== "EEXIST" || !overwrite) throw error;
			}
		}
		const fd = fs.openSync(target, (requireZip ? O_RDWR : O_WRONLY) | O_NOFOLLOW | NO_WAIT);
		try {
			if (!fs.fstatSync(fd).isFile()) throw new Refused("ENOTFILE");
			if (requireZip && !startsAsZip(fd)) throw new Refused("ENOTZIP");
			if (!fitsOnDisk(target, bytes.length)) throw new Refused("ENOROOM");
		} catch (error) {
			fs.closeSync(fd);
			throw error;
		}
		replaceAllAndClose(fd, bytes);
		return { header: { existed: true, bytes: bytes.length } };
	},
};

/** Runs `open`, and when a folder on the way is missing, makes the folders and runs it once more. */
function withFolders(target, open) {
	try {
		return open();
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
		fs.mkdirSync(path.dirname(target), { recursive: true });
		return open();
	}
}

function fitsOnDisk(target, size) {
	const disk = fs.statfsSync(path.dirname(target));
	return disk.bavail * disk.bsize >= size + SPACE_MARGIN_BYTES;
}

function replaceAllAndClose(fd, bytes) {
	try {
		fs.ftruncateSync(fd, 0);
		let at = 0;
		while (at < bytes.length) at += fs.writeSync(fd, bytes, at, bytes.length - at, at);
	} finally {
		fs.closeSync(fd);
	}
}

function answer(header, bytes) {
	process.stdout.write(`${JSON.stringify(header)}\n`);
	if (bytes) process.stdout.write(bytes);
}

const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
	let request;
	try {
		request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		answer({ ok: false, code: "EREQUEST" });
		return;
	}
	const op = Object.hasOwn(ops, request?.op) ? ops[request.op] : null;
	if (!op) {
		answer({ ok: false, code: "EREQUEST" });
		return;
	}
	try {
		const { header, bytes } = op(request);
		answer({ ok: true, ...header }, bytes);
	} catch (error) {
		// ELOOP is a link at the last part; EPERM is the box's refusal, or a file another program has locked.
		answer({ ok: false, code: typeof error?.code === "string" ? error.code : "EFAILED" });
	}
});
