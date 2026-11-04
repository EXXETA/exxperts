import fs from "node:fs";
import path from "node:path";
import { PERSISTENT_AGENTS_ROOT } from "./persistent-agents.js";
import { sweepExpiredShelfTrash, replayShelfRenameJournals, listShelfFilesWithOrigin, persistentRoomShelfDirPath, allocateShelfFilename, PersistentRoomShelfError, resolveShelfFilePath, stageShelfFileDelete, undoShelfFileDelete, commitShelfFileDelete, renameShelfFile, validateShelfFilename, sanitizeShelfFilename } from "./persistent-room-shelf.js";
import { cachedShelfPageCount, SHELF_READ_MAX_FILE_BYTES, sniffShelfFileBuffer, readShelfFileText } from "./persistent-room-shelf-reading.js";
import { stateHome } from "../../../pi-package/product-state-paths.js";
import { app } from "./server-app.js";
import { ARTIFACT_SECURITY_HEADERS, isLoopbackAddress, isLoopbackOrLocalhostOrigin, requestRemoteAddresses } from "./request-checks.js";
import { artifactContentType, nameIsTaken, writeReplacingNoLink } from "./artifact-routes.js";

// ── Room files routes (files UI slice) ─────────────────────────────────────
// The shelf's HTTP face: list rows for the Attachments panel, take uploads onto the
// shelf, serve/preview user-added files, undo a staged upload, and export a
// snapshot to a user-picked folder. Room-made files keep flowing through the
// task-scoped /api/artifacts routes; these routes exist for what has no task.

const ROOM_FILES_PREVIEW_IMAGE_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};

// Inline PDF preview (vision slice): served with the browser's own PDF viewer.
// The CSP keeps default-src 'none' but drops `sandbox` for THIS type only —
// the sandbox directive blocks the PDF viewer plugin outright, and a PDF
// response with nosniff cannot become a scriptable document. Everything else
// keeps the full artifact headers.
const ROOM_FILES_PDF_TYPE = "application/pdf";

function readFileHead(absolutePath: string): Buffer {
	try {
		const fd = fs.openSync(absolutePath, "r");
		try {
			const head = Buffer.alloc(8192);
			const read = fs.readSync(fd, head, 0, 8192, 0);
			return head.subarray(0, read);
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return Buffer.alloc(0);
	}
}

const ROOM_FILES_PDF_SECURITY_HEADERS: Record<string, string> = {
	"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
	"cache-control": "no-store",
};

const SAFE_ROOM_ID = /^[a-zA-Z0-9_-]{1,160}$/;

function roomFilesRoomId(req: any): string | null {
	const roomId = String((req.params as any).id ?? "").trim();
	return SAFE_ROOM_ID.test(roomId) && fs.existsSync(path.join(PERSISTENT_AGENTS_ROOT, roomId)) ? roomId : null;
}

function isLocalSaveFileRequest(req: any): boolean {
	const actionHeader = String(req.headers?.["x-exxperts-local-action"] ?? "").trim();
	if (actionHeader !== "save-file") return false;
	if (!requestRemoteAddresses(req).some(isLoopbackAddress)) return false;
	const origin = req.headers?.origin;
	if (typeof origin === "string" && origin.trim() && !isLoopbackOrLocalhostOrigin(origin.trim())) return false;
	return true;
}

app.get("/api/persistent-agents/:id/files", async (req, reply) => {
	const roomId = roomFilesRoomId(req);
	if (!roomId) return reply.code(404).send({ error: "Room not found." });
	// Housekeeping rides the listing (the panel's entry point): finish staged
	// deletes whose undo window expired without a commit (closed tab, crash) and
	// heal any rename whose crash window left a journal. Both best-effort.
	try { sweepExpiredShelfTrash(roomId); } catch {}
	try { replayShelfRenameJournals(roomId); } catch {}
	const files = listShelfFilesWithOrigin(roomId).map((entry) => ({
		name: entry.name,
		bytes: entry.bytes,
		mtimeMs: entry.mtimeMs,
		origin: entry.origin,
		...(entry.madeAt ? { madeAt: entry.madeAt } : {}),
		pages: cachedShelfPageCount(roomId, entry.name, entry),
		extension: path.posix.extname(entry.name).toLowerCase(),
	}));
	return { files };
});

// Upload: base64 JSON like /api/skills/upload (no multipart anywhere in the
// app). 40 MB body limit covers the 25 MB shelf cap plus base64 inflation.
// The file is sniffed BEFORE landing: tier-3 formats refuse honestly with the
// named safe path; accepted bytes take a collision-rule name on the shelf and
// are parsed once (pdf/docx through the isolated worker) so the response can
// state the parse result honestly — the staging chip shows exactly this.
app.post("/api/persistent-agents/:id/files", { bodyLimit: 40 * 1024 * 1024 }, async (req, reply) => {
	const roomId = roomFilesRoomId(req);
	if (!roomId) return reply.code(404).send({ error: "Room not found." });
	const body = (req.body ?? {}) as { filename?: unknown; contentBase64?: unknown };
	const desiredName = String(body.filename ?? "").trim();
	if (!desiredName) return reply.code(400).send({ error: "filename is required." });
	if (typeof body.contentBase64 !== "string" || !body.contentBase64) return reply.code(400).send({ error: "contentBase64 is required." });
	let bytes: Buffer;
	try {
		bytes = Buffer.from(body.contentBase64, "base64");
	} catch {
		return reply.code(400).send({ error: "contentBase64 is not valid base64." });
	}
	if (bytes.byteLength === 0) return reply.code(400).send({ error: "The file is empty." });
	if (bytes.byteLength > SHELF_READ_MAX_FILE_BYTES) {
		return reply.code(413).send({ error: `Files up to ${SHELF_READ_MAX_FILE_BYTES / (1024 * 1024)} MB can be added to this room's Attachments.` });
	}
	const sniff = sniffShelfFileBuffer(bytes.subarray(0, 8192), desiredName);
	if (sniff.kind === "refused") {
		return reply.code(415).send({ error: sniff.refusalReason ?? "This file type cannot be added.", code: "unsupported_format" });
	}
	const shelfDir = persistentRoomShelfDirPath(roomId);
	fs.mkdirSync(shelfDir, { recursive: true, mode: 0o700 });
	let name: string;
	try {
		name = allocateShelfFilename(desiredName, (candidate) => fs.existsSync(path.join(shelfDir, candidate)));
		fs.writeFileSync(path.join(shelfDir, name), bytes, { flag: "wx", mode: 0o600 });
	} catch (e) {
		app.log.warn({ err: (e as Error).message, roomId }, "shelf upload write failed");
		return reply.code(500).send({ error: "The file could not be saved to this room's Attachments." });
	}
	// Parse once, honestly. A parse failure is reported, not hidden — the file
	// stays on the shelf (read_file will state the same failure) and the chip
	// carries the truth before the user commits the message.
	let pages: number | null = null;
	let parseNote: string | null = null;
	if (sniff.kind === "pdf" || sniff.kind === "docx") {
		try {
			const parsed = await readShelfFileText(roomId, name);
			pages = parsed.pages;
			parseNote = parsed.pages !== null ? `${parsed.pages} page${parsed.pages === 1 ? "" : "s"}` : "text extracted";
		} catch (e) {
			parseNote = e instanceof PersistentRoomShelfError ? e.message : "could not be parsed";
		}
	} else if (sniff.kind === "xlsx") {
		parseNote = "spreadsheet · previewed as a table";
	} else if (sniff.kind === "image") {
		parseNote = "image · the room reads it visually";
	}
	return {
		name,
		bytes: bytes.byteLength,
		kind: sniff.kind,
		extension: path.posix.extname(name).toLowerCase(),
		...(pages !== null ? { pages } : {}),
		...(parseNote ? { parseNote } : {}),
	};
});

// Serve a shelf file. Inline preview only for the sandbox-safe set (the
// artifact CSP rides every response) plus images; everything else downloads
// with ?download=1 or is refused — never sniffed into an inline document.
app.get("/api/persistent-agents/:id/files/:name", async (req, reply) => {
	const roomId = roomFilesRoomId(req);
	if (!roomId) {
		reply.headers(ARTIFACT_SECURITY_HEADERS);
		return reply.code(404).send({ error: "File not found." });
	}
	let resolved: ReturnType<typeof resolveShelfFilePath>;
	try {
		resolved = resolveShelfFilePath(roomId, String((req.params as any).name ?? ""));
	} catch {
		reply.headers(ARTIFACT_SECURITY_HEADERS);
		return reply.code(404).send({ error: "File not found." });
	}
	const extension = path.posix.extname(resolved.name).toLowerCase();
	// PDFs sniff before they get the plugin-permitting header set: a non-PDF
	// byte stream named .pdf keeps the full sandboxed headers.
	const isPdf = extension === ".pdf" && sniffShelfFileBuffer(readFileHead(resolved.absolutePath), resolved.name).kind === "pdf";
	reply.headers(isPdf ? ROOM_FILES_PDF_SECURITY_HEADERS : ARTIFACT_SECURITY_HEADERS);
	if (resolved.stat.size > 40_000_000) return reply.code(413).send({ error: "File is too large to serve." });
	const download = String((req.query as any)?.download ?? "") === "1";
	const inlineType = (isPdf ? ROOM_FILES_PDF_TYPE : null) ?? artifactContentType(extension) ?? ROOM_FILES_PREVIEW_IMAGE_TYPES[extension] ?? null;
	if (!download && !inlineType) return reply.code(415).send({ error: "This file type has no inline preview. Use download." });
	if (download) {
		const basename = resolved.name.replace(/["\\\r\n]/g, "").replace(/[\x00-\x1f\x7f]/g, "");
		reply.header("content-disposition", `attachment; filename="${basename}"`);
	}
	reply.header("content-length", String(resolved.stat.size));
	return reply.type(inlineType ?? "application/octet-stream").send(fs.createReadStream(resolved.absolutePath));
});

// Unified delete (files-management slice): the ONE delete path with one
// semantics — Delete really deletes (bytes + reading cache), with an undo
// window. Stage moves the file into the hidden holding dir, so panel, folder
// and manifest agree the instant the user acts; undo brings it back; commit
// (toast expiry, or immediately for the staging chip's ✕) makes the bytes go.
// The old direct DELETE route retired with this: it could delete
// ledger-referenced room-made files with no undo and no confirm.
app.post("/api/persistent-agents/:id/files/:name/delete", async (req, reply) => {
	const roomId = roomFilesRoomId(req);
	if (!roomId) return reply.code(404).send({ error: "File not found." });
	try {
		// The token names THIS delete's holding slot: undo/commit reference it, so
		// two windows on the same name never collide or eat each other's bytes.
		return { ok: true, token: stageShelfFileDelete(roomId, String((req.params as any).name ?? "")) };
	} catch (e) {
		if (e instanceof PersistentRoomShelfError && e.code === "file_not_found") return reply.code(404).send({ error: "File not found." });
		return reply.code(400).send({ error: "The file could not be deleted." });
	}
});

app.post("/api/persistent-agents/:id/files/:name/delete/undo", async (req, reply) => {
	const roomId = roomFilesRoomId(req);
	if (!roomId) return reply.code(404).send({ error: "File not found." });
	const token = String(((req.body ?? {}) as { token?: unknown }).token ?? "");
	try {
		return { name: undoShelfFileDelete(roomId, token) };
	} catch (e) {
		if (e instanceof PersistentRoomShelfError && e.code === "file_not_found") return reply.code(404).send({ error: "There is nothing to restore — the undo window has passed." });
		return reply.code(400).send({ error: "The file could not be restored." });
	}
});

app.post("/api/persistent-agents/:id/files/:name/delete/commit", async (req, reply) => {
	const roomId = roomFilesRoomId(req);
	if (!roomId) return reply.code(404).send({ error: "File not found." });
	const token = String(((req.body ?? {}) as { token?: unknown }).token ?? "");
	try {
		commitShelfFileDelete(roomId, token);
	} catch {
		// Commit is idempotent housekeeping; the expiry sweep retries anything stuck.
	}
	return { ok: true };
});

// Inline rename (files-management slice): fs rename under the collision rule
// plus the journal-guarded ledger rewrite, so room-made origin stories and
// viewer links survive; the manifest picks the new name up next turn.
app.post("/api/persistent-agents/:id/files/:name/rename", async (req, reply) => {
	const roomId = roomFilesRoomId(req);
	if (!roomId) return reply.code(404).send({ error: "File not found." });
	const newName = String(((req.body ?? {}) as { newName?: unknown }).newName ?? "").trim();
	if (!newName) return reply.code(400).send({ error: "newName is required." });
	try {
		const result = renameShelfFile(roomId, String((req.params as any).name ?? ""), newName);
		return { name: result.name, collided: result.collided, unchanged: result.unchanged };
	} catch (e) {
		if (e instanceof PersistentRoomShelfError && e.code === "file_not_found") return reply.code(404).send({ error: "File not found." });
		if (e instanceof PersistentRoomShelfError) return reply.code(400).send({ error: e.message });
		return reply.code(400).send({ error: "The file could not be renamed." });
	}
});

// 💾 Save… — export a snapshot of a shelf file into a folder the user picked
// with the native chooser. Local-action guarded like the chooser itself; the
// destination must be an existing directory outside the app's own state.
app.post("/api/persistent-agents/:id/files/:name/save", async (req, reply) => {
	if (!isLocalSaveFileRequest(req)) {
		return reply.code(403).send({ error: "Saving to a folder is only available from the local Exxperts app.", code: "local_request_required" });
	}
	const roomId = roomFilesRoomId(req);
	if (!roomId) return reply.code(404).send({ error: "File not found." });
	let resolved: ReturnType<typeof resolveShelfFilePath>;
	try {
		resolved = resolveShelfFilePath(roomId, String((req.params as any).name ?? ""));
	} catch {
		return reply.code(404).send({ error: "File not found." });
	}
	const body = (req.body ?? {}) as { targetDir?: unknown; overwrite?: unknown; rename?: unknown; saveAs?: unknown };
	const targetDirRaw = String(body.targetDir ?? "").trim();
	if (!targetDirRaw || !path.isAbsolute(targetDirRaw)) return reply.code(400).send({ error: "targetDir must be an absolute folder path." });
	// Save… ships a filename field pre-filled with the shelf name; the export
	// (and its collision flow below) keys off the chosen name. Coerced to one
	// plain segment — the folder choice stays the only place a path is picked.
	let exportName = resolved.name;
	if (body.saveAs !== undefined) {
		try {
			exportName = validateShelfFilename(sanitizeShelfFilename(String(body.saveAs ?? "")));
		} catch {
			return reply.code(400).send({ error: "The chosen file name is not valid." });
		}
	}
	const overwrite = body.overwrite === true;
	const rename = body.rename === true;
	if (overwrite && rename) return reply.code(400).send({ error: "overwrite and rename are mutually exclusive." });
	let targetDir: string;
	try {
		targetDir = fs.realpathSync.native(targetDirRaw);
		if (!fs.statSync(targetDir).isDirectory()) throw new Error("not a directory");
	} catch {
		return reply.code(400).send({ error: "The chosen folder no longer exists." });
	}
	// Never export INTO the app's own state — snapshots leave the app, they do
	// not silently create second truths inside it. Compare realpaths: targetDir
	// was resolved above, so the state root must be resolved the same way
	// (macOS /var vs /private/var would otherwise defeat the prefix check).
	let stateRoot = path.join(stateHome(), ".exxperts");
	try {
		stateRoot = fs.realpathSync.native(stateRoot);
	} catch {
		// State root missing entirely — nothing to protect.
	}
	if (targetDir === stateRoot || targetDir.startsWith(stateRoot + path.sep)) {
		return reply.code(400).send({ error: "Pick a folder outside the app's own storage." });
	}
	const confined = (candidateName: string): string | null => {
		const candidate = path.resolve(targetDir, candidateName);
		return candidate !== targetDir && candidate.startsWith(targetDir + path.sep) ? candidate : null;
	};
	const destPath = confined(exportName);
	if (!destPath) return reply.code(400).send({ error: "The file name cannot land in the chosen folder." });
	if (!overwrite && !rename && nameIsTaken(destPath)) {
		return reply.code(409).send({ error: "A file with this name already exists in the chosen folder.", code: "exists" });
	}
	let savedTo = destPath;
	try {
		const content = fs.readFileSync(resolved.absolutePath);
		if (rename) {
			const parsed = path.parse(exportName);
			let written = false;
			for (let suffix = 1; suffix <= 200; suffix += 1) {
				const candidateName = suffix === 1 ? exportName : `${parsed.name}-${suffix}${parsed.ext}`;
				const candidate = confined(candidateName);
				if (!candidate) return reply.code(400).send({ error: "The file name cannot land in the chosen folder." });
				if (nameIsTaken(candidate)) continue;
				try {
					fs.writeFileSync(candidate, content, { flag: "wx", mode: 0o644 });
					savedTo = candidate;
					written = true;
					break;
				} catch (e) {
					if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
				}
			}
			if (!written) return reply.code(500).send({ error: "Could not find a free name in the chosen folder." });
		} else {
			if (!overwrite) fs.writeFileSync(destPath, content, { flag: "wx", mode: 0o644 });
			else if (!(await writeReplacingNoLink(destPath, content, 0o644))) {
				return reply.code(400).send({ error: "The file with this name in the chosen folder is a shortcut to somewhere else, so it was not replaced. Use Keep both, or pick another name." });
			}
		}
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "EEXIST") {
			return reply.code(409).send({ error: "A file with this name already exists in the chosen folder.", code: "exists" });
		}
		return reply.code(500).send({ error: "The file could not be saved to the chosen folder." });
	}
	return { savedTo };
});
