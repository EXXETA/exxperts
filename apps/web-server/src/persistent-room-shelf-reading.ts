import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import {
	PersistentRoomShelfError,
	persistentRoomReadingCacheDirPath,
	resolveShelfFilePath,
	type PersistentRoomShelfStorageOptions,
	type ShelfFileEntry,
} from "./persistent-room-shelf.js";

/**
 * Shelf reading layer (files core slice): how bytes on the shelf become text a
 * room can read and search.
 *
 * - Content is SNIFFED, never trusted by extension: `%PDF-` is a pdf whatever
 *   it is called; a zip is only a docx if it carries word/document.xml.
 * - pdf and docx are extracted in an isolated worker thread with a hard
 *   timeout — a hostile document's worst case is a failed parse.
 * - Extractions land in a reading cache under runtime/reading-cache/, keyed by
 *   filename + content hash, so re-reads and manifest page counts are free.
 *   The cache is regenerable: deleting it just means the next read re-parses.
 * - Unsupported formats refuse HONESTLY, each refusal naming the safe path.
 */

export const SHELF_READ_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const SHELF_PARSE_MAX_PDF_PAGES = 200;
export const SHELF_PARSE_TIMEOUT_MS = 30_000;
export const SHELF_PARSE_MAX_EXTRACT_CHARS = 2_000_000;

// Vision caps (vision slice). Image dimension tracks the provider sweet spot
// (~1.5k px); the pass-through byte cap keeps a raw original safely under
// provider per-image limits, anything larger is downscaled to JPEG in the
// worker. Rasterized scanned-PDF reads are paged: a bounded page window per
// read call, each page bounded in pixels, with a longer timeout because
// rendering costs more than text extraction.
export const SHELF_VISION_IMAGE_MAX_DIMENSION = 1568;
// Deliberately modest: an image is passed through VERBATIM under this cap, and
// a file can carry far more bytes than its pixels justify (trailing garbage
// after the image data decodes fine and rides along). Above the cap the worker
// re-encodes, which drops everything that is not picture — so the cap is what
// bounds what padding can cost the room's context, not just what a provider
// accepts.
export const SHELF_VISION_IMAGE_PASSTHROUGH_MAX_BYTES = 1_500_000;
export const SHELF_RASTER_PAGES_PER_READ = 8;
export const SHELF_RASTER_TARGET_WIDTH = 1400;
export const SHELF_RASTER_MAX_PIXELS = 4_000_000;
export const SHELF_VISION_TIMEOUT_MS = 60_000;

const READING_CACHE_SCHEMA_VERSION = 1;
const SNIFF_BYTES = 8192;

export type ShelfFileKind = "text" | "pdf" | "docx" | "image" | "refused";

export interface ShelfFileSniff {
	kind: ShelfFileKind;
	/** For refused kinds: the honest, safe-path-naming reason. */
	refusalReason?: string;
	/** For image kind: the mime the magic bytes identify (vision pass-through labels). */
	imageMimeType?: string;
}

const REFUSAL_LEGACY_OFFICE = "Legacy Office formats (.doc/.xls/.ppt) cannot be read safely. Save the file as .docx or export it to PDF and add it again.";
const REFUSAL_ARCHIVE = "Archives cannot be read. Extract the file you need and add it to this room's Files directly.";
const REFUSAL_SPREADSHEET = "Spreadsheets in this room's Files are not readable yet. Export the sheet as CSV and add that, or use a workspace with read_spreadsheet.";
const REFUSAL_PRESENTATION = "This presentation format is not readable yet. Export it to PDF and add that instead.";
const REFUSAL_BINARY = "This is a binary file the room cannot read as text. Converting it to PDF or plain text almost always works.";
const REFUSAL_MEDIA = "Audio and video cannot be read. Add a transcript or notes as text instead.";
/**
 * Vision slice: images and scanned PDFs are READ VISUALLY now — these two
 * lines are what the TEXT paths say about them. read_file branches to the
 * vision path before ever seeing them; search_file (text-only by nature)
 * relays them as its honest skip reason.
 */
export const NOTE_IMAGE_IS_VISUAL = "This is an image — read_file shows it to the room visually; it has no text to search.";
export const NOTE_PDF_NO_TEXT_LAYER = "This PDF has no extractable text (likely a scanned document) — read_file shows its pages to the room visually; there is no text to search.";

/** True when a PDF extraction produced only page markers — a scanned/image-only document. */
export function shelfPdfExtractionIsBlank(kind: ShelfFileKind, text: string): boolean {
	if (kind !== "pdf") return false;
	return text.replace(/\[page \d+\]/g, "").trim().length === 0;
}

function startsWithBytes(buffer: Buffer, signature: number[]): boolean {
	if (buffer.length < signature.length) return false;
	return signature.every((byte, index) => buffer[index] === byte);
}

function zipContainsLocalEntry(buffer: Buffer, entryName: string): boolean {
	// Cheap containment probe over local-file-header names — enough to tell a
	// docx from any other zip without inflating anything.
	return buffer.includes(Buffer.from(entryName, "utf-8"));
}

/** Sniff a shelf file's kind from its leading bytes (plus, for zips, entry names). */
export function sniffShelfFileBuffer(head: Buffer, name: string): ShelfFileSniff {
	const extension = path.posix.extname(name).toLowerCase();
	if (startsWithBytes(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { kind: "pdf" }; // %PDF-
	if (startsWithBytes(head, [0x50, 0x4b, 0x03, 0x04]) || startsWithBytes(head, [0x50, 0x4b, 0x05, 0x06])) {
		if (zipContainsLocalEntry(head, "word/document.xml") || (extension === ".docx" && zipContainsLocalEntry(head, "[Content_Types].xml"))) return { kind: "docx" };
		if (extension === ".xlsx") return { kind: "refused", refusalReason: REFUSAL_SPREADSHEET };
		if (extension === ".pptx") return { kind: "refused", refusalReason: REFUSAL_PRESENTATION };
		if (extension === ".docx") return { kind: "docx" };
		return { kind: "refused", refusalReason: REFUSAL_ARCHIVE };
	}
	if (startsWithBytes(head, [0xd0, 0xcf, 0x11, 0xe0])) return { kind: "refused", refusalReason: REFUSAL_LEGACY_OFFICE }; // OLE compound file
	if (startsWithBytes(head, [0x89, 0x50, 0x4e, 0x47])) return { kind: "image", imageMimeType: "image/png" };
	if (startsWithBytes(head, [0xff, 0xd8, 0xff])) return { kind: "image", imageMimeType: "image/jpeg" };
	if (startsWithBytes(head, [0x47, 0x49, 0x46, 0x38])) return { kind: "image", imageMimeType: "image/gif" };
	if (startsWithBytes(head, [0x52, 0x49, 0x46, 0x46]) && head.subarray(8, 12).toString("latin1") === "WEBP") return { kind: "image", imageMimeType: "image/webp" };
	if ([".mp3", ".mp4", ".mov", ".wav", ".m4a", ".avi", ".mkv", ".webm"].includes(extension)) return { kind: "refused", refusalReason: REFUSAL_MEDIA };
	if (head.subarray(0, SNIFF_BYTES).includes(0)) return { kind: "refused", refusalReason: REFUSAL_BINARY };
	return { kind: "text" };
}

export function sniffShelfFile(absolutePath: string, name: string): ShelfFileSniff {
	let head: Buffer;
	let fd: number | null = null;
	try {
		fd = fs.openSync(absolutePath, "r");
		head = Buffer.alloc(SNIFF_BYTES);
		const read = fs.readSync(fd, head, 0, SNIFF_BYTES, 0);
		head = head.subarray(0, read);
	} catch {
		throw new PersistentRoomShelfError("not_readable", "File cannot be read in this room's Files.");
	} finally {
		if (fd !== null) fs.closeSync(fd);
	}
	return sniffShelfFileBuffer(head, name);
}

interface ReadingCacheMeta {
	schemaVersion: number;
	name: string;
	contentHash: string;
	sizeBytes: number;
	mtimeMs: number;
	kind: ShelfFileKind;
	pages: number | null;
	truncated: boolean;
	parsedAt: string;
}

function readingCacheKey(name: string): string {
	return crypto.createHash("sha256").update(name).digest("hex").slice(0, 16);
}

function readingCachePaths(roomId: string, name: string, options: PersistentRoomShelfStorageOptions): { metaPath: string; textPath: string } {
	const dir = persistentRoomReadingCacheDirPath(roomId, options);
	const key = readingCacheKey(name);
	return { metaPath: path.join(dir, `${key}.json`), textPath: path.join(dir, `${key}.txt`) };
}

function readCachedMeta(metaPath: string): ReadingCacheMeta | null {
	try {
		const raw = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
		if (!raw || typeof raw !== "object" || raw.schemaVersion !== READING_CACHE_SCHEMA_VERSION) return null;
		if (typeof raw.name !== "string" || typeof raw.contentHash !== "string") return null;
		return raw as ReadingCacheMeta;
	} catch {
		return null;
	}
}

/**
 * Cheap page-count lookup for manifest lines: cache-only, size+mtime staleness
 * check, NEVER parses. A file without a fresh cache entry just shows its size.
 */
export function cachedShelfPageCount(roomId: string, name: string, entry: ShelfFileEntry, options: PersistentRoomShelfStorageOptions = {}): number | null {
	const { metaPath } = readingCachePaths(roomId, name, options);
	const meta = readCachedMeta(metaPath);
	if (!meta || meta.name !== name || meta.sizeBytes !== entry.bytes || meta.mtimeMs !== entry.mtimeMs) return null;
	return meta.pages;
}

interface ShelfWorkerMessage {
	ok: boolean;
	text?: string;
	pages?: number | null;
	truncated?: boolean;
	image?: { imageBase64: string; mimeType: string; width: number; height: number; downscaled: boolean };
	raster?: { pages: Array<{ page: number; imageBase64: string; mimeType: string }>; totalPages: number };
	error?: string;
}

function runShelfWorker(workerData: Record<string, unknown>, timeoutMs: number): Promise<ShelfWorkerMessage> {
	return new Promise((resolve, reject) => {
		const worker = new Worker(new URL("./shelf-parse-worker.mjs", import.meta.url), {
			workerData,
			resourceLimits: { maxOldGenerationSizeMb: 512 },
		});
		let settled = false;
		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			void worker.terminate();
			fn();
		};
		const timer = setTimeout(() => {
			settle(() => reject(new PersistentRoomShelfError("parse_timeout", `The document could not be processed within ${timeoutMs / 1000}s and was given up on.`)));
		}, timeoutMs);
		worker.once("message", (message: ShelfWorkerMessage) => {
			settle(() => {
				if (message?.ok) resolve(message);
				else reject(new PersistentRoomShelfError("parse_failed", `The document could not be processed: ${String(message?.error ?? "unknown parser error")}`));
			});
		});
		worker.once("error", (error) => {
			// A document that exhausts the worker's memory cap (a compression bomb
			// inflating to hundreds of MB of drawing operations is the real case)
			// arrives here as a V8 OOM. The fence held — say so in the room's
			// language instead of relaying heap internals.
			const outOfMemory = /memory limit|heap out of memory/i.test(error.message);
			settle(() => reject(new PersistentRoomShelfError(
				outOfMemory ? "too_complex" : "parse_failed",
				outOfMemory
					? "This document is too complex to process — it was given up on rather than allowed to exhaust memory. If it is a scanned document, exporting a smaller page range usually works."
					: `The document could not be processed: ${error.message}`,
			)));
		});
		worker.once("exit", (code) => {
			settle(() => reject(new PersistentRoomShelfError("parse_failed", `The document parser exited unexpectedly (code ${code}).`)));
		});
	});
}

async function runShelfParseWorker(absolutePath: string, kind: "pdf" | "docx"): Promise<{ text: string; pages: number | null; truncated: boolean }> {
	const message = await runShelfWorker({ absolutePath, kind, maxPages: SHELF_PARSE_MAX_PDF_PAGES, maxChars: SHELF_PARSE_MAX_EXTRACT_CHARS }, SHELF_PARSE_TIMEOUT_MS);
	if (typeof message.text !== "string") throw new PersistentRoomShelfError("parse_failed", "The document could not be parsed: the parser returned no text.");
	return { text: message.text, pages: typeof message.pages === "number" ? message.pages : null, truncated: message.truncated === true };
}

export interface ShelfFileText {
	name: string;
	kind: ShelfFileKind;
	text: string;
	pages: number | null;
	truncated: boolean;
}

/**
 * The readable text of one shelf file. Text formats decode directly; pdf/docx
 * go through cache-or-worker. Refused kinds throw with the honest reason.
 */
export async function readShelfFileText(roomIdRaw: string, rawName: string, options: PersistentRoomShelfStorageOptions = {}): Promise<ShelfFileText> {
	const resolved = resolveShelfFilePath(roomIdRaw, rawName, options);
	if (resolved.stat.size > SHELF_READ_MAX_FILE_BYTES) {
		throw new PersistentRoomShelfError("file_too_large", `The file is larger than the ${SHELF_READ_MAX_FILE_BYTES / (1024 * 1024)} MB reading cap.`);
	}
	const sniff = sniffShelfFile(resolved.absolutePath, resolved.name);
	if (sniff.kind === "refused") throw new PersistentRoomShelfError("unsupported_format", sniff.refusalReason ?? REFUSAL_BINARY);
	if (sniff.kind === "image") throw new PersistentRoomShelfError("image_not_text", NOTE_IMAGE_IS_VISUAL);
	if (sniff.kind === "text") {
		let text: string;
		try {
			text = fs.readFileSync(resolved.absolutePath, "utf-8");
		} catch {
			throw new PersistentRoomShelfError("not_readable", "File cannot be read in this room's Files.");
		}
		return { name: resolved.name, kind: "text", text, pages: null, truncated: false };
	}

	// pdf / docx: reading cache keyed by filename + content hash.
	const contentHash = crypto.createHash("sha256").update(fs.readFileSync(resolved.absolutePath)).digest("hex");
	const { metaPath, textPath } = readingCachePaths(String(roomIdRaw), resolved.name, options);
	const cached = readCachedMeta(metaPath);
	if (cached && cached.name === resolved.name && cached.contentHash === contentHash) {
		let text: string | null = null;
		try {
			text = fs.readFileSync(textPath, "utf-8");
		} catch {
			// Stale/torn cache: fall through to a fresh parse.
		}
		if (text !== null) {
			// The scanned-PDF refusal applies to cached extractions too — the
			// cache remembers the (empty) parse so the refusal stays cheap.
			if (shelfPdfExtractionIsBlank(sniff.kind, text)) throw new PersistentRoomShelfError("no_text_layer", NOTE_PDF_NO_TEXT_LAYER);
			return { name: resolved.name, kind: sniff.kind, text, pages: cached.pages, truncated: cached.truncated };
		}
	}
	const parsed = await runShelfParseWorker(resolved.absolutePath, sniff.kind);
	try {
		const dir = path.dirname(metaPath);
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const meta: ReadingCacheMeta = {
			schemaVersion: READING_CACHE_SCHEMA_VERSION,
			name: resolved.name,
			contentHash,
			sizeBytes: resolved.stat.size,
			mtimeMs: resolved.stat.mtimeMs,
			kind: sniff.kind,
			pages: parsed.pages,
			truncated: parsed.truncated,
			parsedAt: new Date().toISOString(),
		};
		fs.writeFileSync(textPath, parsed.text, { encoding: "utf-8", mode: 0o600 });
		fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
	} catch {
		// The cache is an optimization; a failed cache write never fails the read.
	}
	// Extraction succeeded but produced no text: the honest scanned-PDF note,
	// AFTER the cache write so the next attempt branches without re-parsing.
	if (shelfPdfExtractionIsBlank(sniff.kind, parsed.text)) throw new PersistentRoomShelfError("no_text_layer", NOTE_PDF_NO_TEXT_LAYER);
	return { name: resolved.name, kind: sniff.kind, text: parsed.text, pages: parsed.pages, truncated: parsed.truncated };
}

// ── Vision reads (vision slice) ─────────────────────────────────────────────

export interface ShelfImageForVision {
	name: string;
	mimeType: string;
	/** base64 of the pass-through original, or of the worker's downscaled JPEG. */
	dataBase64: string;
	width: number;
	height: number;
	/** Bytes of the ORIGINAL file on disk (what the room should cite). */
	bytes: number;
	downscaled: boolean;
}

/**
 * An image shelf file prepared for the provider's vision: decoded (and, when
 * over the caps, downscaled) inside the isolated worker — hostile image bytes
 * get the same blast fence as hostile documents.
 */
export async function readShelfImageForVision(roomIdRaw: string, rawName: string, options: PersistentRoomShelfStorageOptions = {}): Promise<ShelfImageForVision> {
	const resolved = resolveShelfFilePath(roomIdRaw, rawName, options);
	if (resolved.stat.size > SHELF_READ_MAX_FILE_BYTES) {
		throw new PersistentRoomShelfError("file_too_large", `The file is larger than the ${SHELF_READ_MAX_FILE_BYTES / (1024 * 1024)} MB reading cap.`);
	}
	const sniff = sniffShelfFile(resolved.absolutePath, resolved.name);
	if (sniff.kind !== "image" || !sniff.imageMimeType) throw new PersistentRoomShelfError("not_image", "This file is not an image.");
	const message = await runShelfWorker({
		absolutePath: resolved.absolutePath,
		kind: "image",
		image: { maxDimension: SHELF_VISION_IMAGE_MAX_DIMENSION, maxPassthroughBytes: SHELF_VISION_IMAGE_PASSTHROUGH_MAX_BYTES, mimeType: sniff.imageMimeType },
	}, SHELF_VISION_TIMEOUT_MS);
	const image = message.image;
	if (!image || typeof image.imageBase64 !== "string" || !image.imageBase64) throw new PersistentRoomShelfError("parse_failed", "The image could not be prepared for visual reading.");
	return {
		name: resolved.name,
		mimeType: image.mimeType,
		dataBase64: image.imageBase64,
		width: image.width,
		height: image.height,
		bytes: resolved.stat.size,
		downscaled: image.downscaled === true,
	};
}

export interface ShelfPdfRasterForVision {
	name: string;
	pages: Array<{ page: number; mimeType: string; dataBase64: string }>;
	totalPages: number;
	firstPage: number;
	lastPage: number;
}

/**
 * A window of PDF pages rendered to images for the provider's vision — the
 * scanned-document path (extraction came back blank, so the text layer cannot
 * carry the content). Bounded per read: at most SHELF_RASTER_PAGES_PER_READ
 * pages from `firstPage`, each within the pixel budget, all inside the worker.
 */
export async function rasterizeShelfPdfForVision(roomIdRaw: string, rawName: string, firstPage: number, options: PersistentRoomShelfStorageOptions = {}): Promise<ShelfPdfRasterForVision> {
	const resolved = resolveShelfFilePath(roomIdRaw, rawName, options);
	if (resolved.stat.size > SHELF_READ_MAX_FILE_BYTES) {
		throw new PersistentRoomShelfError("file_too_large", `The file is larger than the ${SHELF_READ_MAX_FILE_BYTES / (1024 * 1024)} MB reading cap.`);
	}
	const sniff = sniffShelfFile(resolved.absolutePath, resolved.name);
	if (sniff.kind !== "pdf") throw new PersistentRoomShelfError("not_pdf", "This file is not a PDF.");
	const start = Number.isFinite(firstPage) && firstPage >= 1 ? Math.floor(firstPage) : 1;
	const message = await runShelfWorker({
		absolutePath: resolved.absolutePath,
		kind: "pdf-raster",
		raster: { firstPage: start, pageCount: SHELF_RASTER_PAGES_PER_READ, targetWidth: SHELF_RASTER_TARGET_WIDTH, maxPixels: SHELF_RASTER_MAX_PIXELS },
	}, SHELF_VISION_TIMEOUT_MS);
	const raster = message.raster;
	if (!raster || !Array.isArray(raster.pages) || raster.pages.length === 0) throw new PersistentRoomShelfError("parse_failed", "The document's pages could not be rendered for visual reading.");
	const pages = raster.pages
		.filter((page) => typeof page?.imageBase64 === "string" && page.imageBase64 && typeof page?.page === "number")
		.map((page) => ({ page: page.page, mimeType: String(page.mimeType || "image/jpeg"), dataBase64: page.imageBase64 }));
	if (pages.length === 0) throw new PersistentRoomShelfError("parse_failed", "The document's pages could not be rendered for visual reading.");
	return {
		name: resolved.name,
		pages,
		totalPages: raster.totalPages,
		firstPage: pages[0]!.page,
		lastPage: pages[pages.length - 1]!.page,
	};
}
