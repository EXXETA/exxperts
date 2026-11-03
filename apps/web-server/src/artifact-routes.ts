import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PERSISTENT_AGENTS_ROOT } from "./persistent-agents.js";
import { resolvePersistentRoomCapabilityPolicy, readPersistentRoomDefaultCapabilityPolicy } from "./persistent-room-workspace-policy.js";
import { resolveShelfFilePath } from "./persistent-room-shelf.js";
import { listTaskLedgerRecords, appendTaskLedgerExport } from "./persistent-room-task-ledger.js";
import { SAFE_SEGMENT, validateArtifactPath } from "../../../pi-package/extensions/artifacts/index.js";
import { app } from "./server-app.js";
import { ARTIFACT_SECURITY_HEADERS } from "./request-checks.js";
import { PLAIN_TEXT_PREVIEW_EXTENSIONS } from "./plain-text-preview.js";

// Servable artifact types. .md is served as text/plain deliberately so markdown
// source renders inert in a tab rather than as HTML. Named explicitly rather
// than reusing the store's write-side allowlist so a future widening of what
// may be WRITTEN (e.g. .pptx derivatives) never silently widens what this
// route SERVES with these headers.
const ARTIFACT_SERVABLE_EXTENSIONS: ReadonlySet<string> = new Set([".md", ".html", ".svg"]);

// Plain-text types preview inline the way .md does: text/plain under the full
// artifact CSP, so the bytes render as inert source in the sandboxed frame —
// .json/.csv/.py never become a scriptable or styled document. Honored by the
// SHELF resolvers only (room-files route + shelf-canonical rows, where users
// upload and rename these types); the task-STORE path keeps the narrow
// write-side set above. The viewer reads the same list.
const SHELF_PLAIN_TEXT_EXTENSIONS: ReadonlySet<string> = PLAIN_TEXT_PREVIEW_EXTENSIONS;

function artifactContentType(extension: string): string | null {
	if (extension === ".svg") return "image/svg+xml; charset=utf-8";
	if (extension === ".html") return "text/html; charset=utf-8";
	if (extension === ".md") return "text/plain; charset=utf-8";
	if (SHELF_PLAIN_TEXT_EXTENSIONS.has(extension)) return "text/plain; charset=utf-8";
	return null;
}

// The room that owns a task, resolved by probing each room's ledger for the
// record file (rooms are few; this is a handful of existence checks). Shelf
// continuity (files core slice) needs it because the artifact routes are
// task-scoped while migrated/absorbed files live under the owning room.
function findRoomIdForTask(taskId: string): string | null {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(PERSISTENT_AGENTS_ROOT, { withFileTypes: true });
	} catch {
		return null;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]{1,160}$/.test(entry.name)) continue;
		try {
			if (fs.existsSync(path.join(PERSISTENT_AGENTS_ROOT, entry.name, "runtime", "task-ledger", `${taskId}.json`))) return entry.name;
		} catch {
			// keep probing
		}
	}
	return null;
}

// A task's shelf file, served/exported through the task-scoped routes below:
// membership of `files/<name>` in THIS task's ledger record is the
// authorization, and the bytes come from the owning room's shelf. Returns null
// (route falls through to 404) for anything that is not exactly that.
function resolveTaskShelfFile(taskId: string, name: string): { roomId: string; absolutePath: string; stat: fs.Stats; extension: string } | null {
	if (!name || name.includes("/") || name.startsWith(".")) return null;
	const roomId = findRoomIdForTask(taskId);
	if (!roomId) return null;
	let record;
	try {
		record = listTaskLedgerRecords(roomId).find((row) => row.taskId === taskId);
	} catch {
		return null;
	}
	if (!record?.artifacts?.some((artifact) => artifact.relativePath === `files/${name}`)) return null;
	const extension = path.extname(name).toLowerCase();
	// Shelf files also serve the plain-text preview set: a rename can point a
	// row's files/<name> at a .txt/.csv/.py, and those preview like .md.
	if (!ARTIFACT_SERVABLE_EXTENSIONS.has(extension) && !SHELF_PLAIN_TEXT_EXTENSIONS.has(extension)) return null;
	try {
		const resolved = resolveShelfFilePath(roomId, name);
		return { roomId, absolutePath: resolved.absolutePath, stat: resolved.stat, extension };
	} catch {
		return null;
	}
}

app.get("/api/artifacts/:taskId/*", async (req, reply) => {
	// Sandbox headers ride every response from this route — success and error —
	// so no artifact path can ever return document bytes without the CSP.
	reply.headers(ARTIFACT_SECURITY_HEADERS);
	const taskId = String((req.params as any).taskId ?? "");
	const rest = String((req.params as any)["*"] ?? "");
	// taskId is a per-task subfolder governed by the same SAFE_SEGMENT that
	// specialists write under; reject anything else and never echo it back.
	if (!SAFE_SEGMENT.test(taskId)) return reply.code(404).send({ error: "Artifact not found." });
	// Reject any dot-leading path segment. validateArtifactPath's SAFE_SEGMENT
	// already rejects these, but assert it here so server-internal dot-dirs
	// (e.g. .thumbs) can never be served even if that validation ever loosens.
	if (rest.split("/").some((segment) => segment.startsWith("."))) return reply.code(404).send({ error: "Artifact not found." });
	// Store path first (pre-absorb tasks and in-flight runs), then the shelf
	// (files core slice: migrated/absorbed rows carry files/<name> paths but keep
	// their task-scoped URLs, so the client's URL derivation never changes).
	let servePath: string | null = null;
	let serveName = "";
	let serveExtension = "";
	let stat: fs.Stats | null = null;
	try {
		const target = validateArtifactPath(rest, "default", `tasks/${taskId}`, ARTIFACT_SERVABLE_EXTENSIONS);
		// lstat, not stat: a symlink under the task folder must not be followed
		// out of the store, so refuse anything that is not a real regular file.
		const lstat = fs.lstatSync(target.fullPath);
		if (lstat.isFile()) {
			servePath = target.fullPath;
			serveName = path.basename(target.relativePath);
			serveExtension = target.extension;
			stat = lstat;
		}
	} catch {
		// fall through to the shelf
	}
	if (!servePath || !stat) {
		const shelf = resolveTaskShelfFile(taskId, rest);
		if (!shelf) return reply.code(404).send({ error: "Artifact not found." });
		servePath = shelf.absolutePath;
		serveName = rest;
		serveExtension = shelf.extension;
		stat = shelf.stat;
	}
	const type = artifactContentType(serveExtension);
	// Unreachable (both resolvers enforce the servable-extension set) but fail closed.
	if (!type) return reply.code(404).send({ error: "Artifact not found." });
	if (stat.size > 40_000_000) return reply.code(413).send({ error: "Artifact is too large to serve." });
	if (String((req.query as any)?.download ?? "") === "1") {
		// Strip quotes/backslashes/control chars so the basename cannot break out
		// of the quoted filename or inject additional header directives.
		const basename = serveName.replace(/["\\\r\n]/g, "").replace(/[\x00-\x1f\x7f]/g, "");
		reply.header("content-disposition", `attachment; filename="${basename}"`);
	}
	reply.header("content-length", String(stat.size));
	return reply.type(type).send(fs.createReadStream(servePath));
});

// A name counts as taken when anything is at it, a link that leads nowhere
// included, since on Windows an exclusive create is not known to stop at such
// a link.
function nameIsTaken(candidate: string): boolean {
	try {
		fs.lstatSync(candidate);
		return true;
	} catch {
		return false;
	}
}

// On Windows a rename fails while another program, such as a virus scanner or
// the search indexer, briefly holds one of the two files, so there it is tried
// again for about a second.
async function renameOverName(from: string, to: string): Promise<void> {
	const giveUpAt = Date.now() + 1000;
	for (;;) {
		try {
			fs.renameSync(from, to);
			return;
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if (process.platform !== "win32" || Date.now() >= giveUpAt || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")) throw e;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

// The old bytes are held in memory while a file is written in place, so a
// larger file takes the rename.
const IN_PLACE_UP_TO = 64 * 1024 * 1024;

// A disk that cannot sync a file (some network and FUSE ones) still keeps
// what was written; any other answer is a failed write.
function syncToDisk(fd: number): void {
	try {
		fs.fsyncSync(fd);
	} catch (e) {
		if (!["EINVAL", "ENOTSUP", "ENOSYS", "EOPNOTSUPP"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
	}
}

// Puts the bytes in as the whole file, from its start, and on the disk.
function writeWhole(fd: number, bytes: Buffer): void {
	fs.ftruncateSync(fd);
	for (let done = 0; done < bytes.length; ) done += fs.writeSync(fd, bytes, done, bytes.length - done, done);
	syncToDisk(fd);
}

// Writes into the old file through a descriptor that is still the plain file
// the check saw, with no other name, so nothing put at the name after the
// check (a link, a FIFO, another file) is written. Answers false, with nothing
// written, when it is not. A write that fails hands over to orElse, and when
// that fails too, the old bytes go back in before the error is thrown. With
// nothing else to try, a file it may not read is written without them.
async function writeInPlaceIfSoleName(destPath: string, old: fs.BigIntStats, bytes: Buffer, orElse?: () => Promise<void>): Promise<boolean> {
	const open = (access: number) => fs.openSync(destPath, access | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
	let fd: number;
	let readable = true;
	try {
		fd = open(fs.constants.O_RDWR);
	} catch (e) {
		if (orElse || (e as NodeJS.ErrnoException).code !== "EACCES") return false;
		try {
			fd = open(fs.constants.O_WRONLY);
			readable = false;
		} catch {
			return false;
		}
	}
	try {
		let before: Buffer | undefined;
		try {
			const now = fs.fstatSync(fd, { bigint: true });
			if (!now.isFile() || now.nlink !== 1n || now.dev !== old.dev || now.ino !== old.ino) return false;
			if (readable && now.size <= IN_PLACE_UP_TO) before = fs.readFileSync(fd);
			else if (orElse) return false;
		} catch {
			return false;
		}
		try {
			writeWhole(fd, bytes);
		} catch (failed) {
			try {
				if (!orElse) throw failed;
				await orElse();
			} catch {
				try { if (before) writeWhole(fd, before); } catch {}
				throw failed;
			}
		}
		return true;
	} finally {
		fs.closeSync(fd);
	}
}

// The old bytes are cut before the new ones land, so a write in place needs
// the disk to have room for them; one that cannot say so has none.
function folderHasRoomFor(folder: string, size: number): boolean {
	try {
		const disk = fs.statfsSync(folder);
		return disk.bavail * disk.bsize >= size + 1024 * 1024;
	} catch {
		return false;
	}
}

// Writes a new file beside the name and renames it over the name, so whatever
// the name pointed at is never written. It takes the old file's permission
// bits, and its group where the system allows it; a folder that lets no new
// file be made leaves only a write in place, when inPlaceIfNoNewFile allows it.
async function writeNewFileOverName(destPath: string, old: fs.BigIntStats | undefined, bytes: Buffer, newFileMode: number, inPlaceIfNoNewFile: boolean): Promise<void> {
	const tempPath = path.join(path.dirname(destPath), `.save-${crypto.randomBytes(8).toString("hex")}.tmp`);
	// Created owner-only, so no other account can open it before it has the
	// old file's bits.
	let fd: number;
	try {
		fd = fs.openSync(tempPath, "wx", old?.isFile() ? 0o600 : newFileMode);
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (inPlaceIfNoNewFile && old?.isFile() && (code === "EACCES" || code === "EPERM") && (await writeInPlaceIfSoleName(destPath, old, bytes))) return;
		throw e;
	}
	try {
		try {
			if (old?.isFile()) {
				// The group first, so the old bits never apply to another group; where
				// the old group cannot be kept, the group the file has gets no access.
				let bits = Number(old.mode & 0o777n);
				try {
					fs.fchownSync(fd, -1, Number(old.gid));
				} catch {
					if (fs.fstatSync(fd).gid !== Number(old.gid)) bits &= 0o707;
				}
				fs.fchmodSync(fd, bits);
			}
			fs.writeFileSync(fd, bytes);
			syncToDisk(fd);
		} finally {
			fs.closeSync(fd);
		}
		await renameOverName(tempPath, destPath);
	} catch (e) {
		try { fs.rmSync(tempPath, { force: true }); } catch {}
		throw e;
	}
}

// Replace on Save… or an export writes a plain file with one name in place,
// so it keeps what it carries beside its bytes (Finder tags and comments,
// ACLs, its creation date); anything else takes writeNewFileOverName. A
// symbolic link at the name is refused first, since the person can see it and
// choose around it. Answers false for a symbolic link.
async function writeReplacingNoLink(destPath: string, bytes: Buffer, newFileMode: number): Promise<boolean> {
	let old: fs.BigIntStats | undefined;
	try {
		old = fs.lstatSync(destPath, { bigint: true });
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
	}
	if (old?.isSymbolicLink()) return false;
	// The rename needs only the folder's write permission, so a file the person
	// may not write is refused here, with the error a write into it would give.
	if (old) fs.accessSync(destPath, fs.constants.W_OK);
	if (old?.isFile() && old.nlink === 1n && old.size <= IN_PLACE_UP_TO && folderHasRoomFor(path.dirname(destPath), bytes.length)) {
		if (await writeInPlaceIfSoleName(destPath, old, bytes, () => writeNewFileOverName(destPath, old, bytes, newFileMode, false))) return true;
	}
	await writeNewFileOverName(destPath, old, bytes, newFileMode, true);
	return true;
}

// V5 — export a task artifact into a room's workspace folder. Self-contained
// sibling to the GET route above. The export click in the UI IS the human
// approval (locked decision D7): there is no ui_request bridge and no interactive
// confirm here. (The "Save to workspace" viewer button that fired this is retired
// in favor of snapshot Save…; the route remains for callers with a workspace folder.) The route therefore applies the SAME source path discipline as
// the GET route (SAFE_SEGMENT taskId, validateArtifactPath, dot-segment refusal)
// and additionally confines the DESTINATION to the room's approved workspace
// root. The global loopback guard (onRequest) is inherited automatically.
app.post("/api/artifacts/:taskId/export", async (req, reply) => {
	const taskId = String((req.params as any).taskId ?? "");
	if (!SAFE_SEGMENT.test(taskId)) return reply.code(404).send({ error: "Artifact not found." });
	const body = (req.body ?? {}) as { relativePath?: unknown; roomId?: unknown; conversationId?: unknown; overwrite?: unknown; rename?: unknown };
	const relativePath = String(body.relativePath ?? "");
	const roomId = String(body.roomId ?? "").trim();
	const conversationId = String(body.conversationId ?? "").trim();
	if (!roomId) return reply.code(400).send({ error: "roomId is required." });
	// Collision resolutions (assets contract §5): both must be EXPLICIT client
	// choices from the three-button flow — never defaults, never combined.
	const overwrite = body.overwrite === true;
	const rename = body.rename === true;
	if (overwrite && rename) return reply.code(400).send({ error: "overwrite and rename are mutually exclusive." });

	// The UI passes the row's store-relative path. Two shapes exist: legacy
	// tasks/<taskId>/<rest> (the taskId in the URL must own it), and — files
	// core slice — files/<name> for rows whose artifact lives on the owning
	// room's shelf, authorized by membership in this task's ledger record.
	let sourceFullPath: string;
	let sourceBasename: string;
	let sourceStat: fs.Stats;
	if (relativePath.startsWith("files/")) {
		const shelf = resolveTaskShelfFile(taskId, relativePath.slice("files/".length));
		if (!shelf || shelf.roomId !== roomId) return reply.code(404).send({ error: "Artifact not found." });
		sourceFullPath = shelf.absolutePath;
		sourceBasename = path.basename(shelf.absolutePath);
		sourceStat = shelf.stat;
	} else {
		const prefix = `tasks/${taskId}/`;
		if (!relativePath.startsWith(prefix)) return reply.code(400).send({ error: "relativePath must be inside this task." });
		const rest = relativePath.slice(prefix.length);
		// Mirror the GET route: never copy server-internal dot-dirs (e.g. .thumbs) even
		// if validateArtifactPath's segment check ever loosens.
		if (!rest || rest.split("/").some((segment) => segment.startsWith("."))) return reply.code(404).send({ error: "Artifact not found." });
		let source: ReturnType<typeof validateArtifactPath>;
		try {
			source = validateArtifactPath(rest, "default", `tasks/${taskId}`, ARTIFACT_SERVABLE_EXTENSIONS);
		} catch {
			return reply.code(404).send({ error: "Artifact not found." });
		}
		try {
			// lstat, not stat: a symlink under the task folder must not be followed out
			// of the store, so refuse anything that is not a real regular file.
			sourceStat = fs.lstatSync(source.fullPath);
		} catch {
			return reply.code(404).send({ error: "Artifact not found." });
		}
		if (!sourceStat.isFile()) return reply.code(404).send({ error: "Artifact not found." });
		sourceFullPath = source.fullPath;
		sourceBasename = path.basename(source.relativePath);
	}
	if (sourceStat.size > 40_000_000) return reply.code(413).send({ error: "Artifact is too large to export." });

	// Resolve the room's THREAD-EFFECTIVE workspace policy when the UI names the
	// conversation (thread override → room default, same resolution the room's
	// own tools use), falling back to the room default for calls without one.
	// Both readers validate the id shapes (throw on malformed) and return null
	// when the room does not exist or has no workspace configured — every
	// failure surfaces as the same 400 below.
	let workspaceRoot: string | null = null;
	try {
		const policy = conversationId
			? resolvePersistentRoomCapabilityPolicy(roomId, conversationId).policy
			: readPersistentRoomDefaultCapabilityPolicy(roomId);
		const rootGrant = policy?.roots?.[0];
		if (rootGrant) {
			// Prefer the realpath grant; fall back to the stored path. Resolving the
			// real path here means the confinement check below compares like with like.
			for (const candidate of [rootGrant.realpath, rootGrant.path]) {
				try {
					const real = fs.realpathSync.native(candidate);
					if (fs.statSync(real).isDirectory()) { workspaceRoot = real; break; }
				} catch {
					// try the next candidate
				}
			}
		}
	} catch {
		workspaceRoot = null;
	}
	if (!workspaceRoot) return reply.code(400).send({ error: "This room has no workspace folder configured; exports need one." });

	// Destination = source basename directly inside the workspace root. basename()
	// strips any separators, and we re-check confinement so a resolved destination
	// can never land outside the approved workspace folder.
	const destName = sourceBasename;
	const confinedDestPath = (name: string): string | null => {
		const candidate = path.resolve(workspaceRoot, name);
		if (candidate !== workspaceRoot && !candidate.startsWith(workspaceRoot + path.sep)) return null;
		return candidate;
	};
	const destPath = confinedDestPath(destName);
	if (!destPath) {
		return reply.code(400).send({ error: "Export destination escapes the room workspace folder." });
	}
	if (!overwrite && !rename && nameIsTaken(destPath)) {
		return reply.code(409).send({ error: "A file with this name already exists in the room workspace.", code: "exists" });
	}
	let savedTo = destPath;
	try {
		const bytes = fs.readFileSync(sourceFullPath);
		if (rename) {
			// Keep both: first free suffixed name (deck-2.html, deck-3.html, …).
			// Each attempt uses "wx", so a concurrent claim of the same name just
			// moves us to the next suffix — race-safe without locks.
			const parsed = path.parse(destName);
			let written = false;
			for (let suffix = 1; suffix <= 200; suffix += 1) {
				const candidateName = suffix === 1 ? destName : `${parsed.name}-${suffix}${parsed.ext}`;
				const candidate = confinedDestPath(candidateName);
				if (!candidate) return reply.code(400).send({ error: "Export destination escapes the room workspace folder." });
				if (nameIsTaken(candidate)) continue;
				try {
					fs.writeFileSync(candidate, bytes, { flag: "wx", mode: 0o600 });
					savedTo = candidate;
					written = true;
					break;
				} catch (e) {
					if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
				}
			}
			if (!written) return reply.code(500).send({ error: "Could not find a free name for the exported file." });
		} else {
			// flag "wx" fails closed if a same-name file appears between the check
			// above and the write; only the client's explicit Replace choice
			// replaces. 0o600 keeps a new exported copy private like other
			// server-side writes.
			if (!overwrite) fs.writeFileSync(destPath, bytes, { flag: "wx", mode: 0o600 });
			else if (!(await writeReplacingNoLink(destPath, bytes, 0o600))) {
				return reply.code(400).send({ error: "The file with this name in the room's folder is a shortcut to somewhere else, so it was not replaced. Use Keep both instead." });
			}
		}
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "EEXIST") {
			return reply.code(409).send({ error: "A file with this name already exists in the room workspace.", code: "exists" });
		}
		return reply.code(500).send({ error: "Failed to export the artifact to the room workspace." });
	}
	// Ledger mapping (assets contract §3): ingest-on-iterate needs to know which
	// workspace file came from which task artifact. Best-effort — pre-ledger
	// tasks export fine without a row.
	try {
		appendTaskLedgerExport(roomId, taskId, { relativePath, savedTo, at: new Date().toISOString() });
	} catch (e) {
		app.log.warn({ err: (e as Error).message, taskId }, "task ledger export append failed");
	}
	return reply.send({ savedTo });
});

export { artifactContentType, nameIsTaken, writeReplacingNoLink };
