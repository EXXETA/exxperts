// Shelf reading-copy parser worker (files core slice).
//
// Runs OUTSIDE the server process on purpose: pdf is THE hostile format, so a
// malicious or pathological document must at worst cost this worker its life
// (the driver kills it on timeout), never the server. A CHILD PROCESS, not a
// worker thread: pdfjs loads a native addon (@napi-rs/canvas) even for text
// extraction, and a thread cannot fence native code — an access violation in
// the addon kills the whole process, which on Windows happens deterministically
// whenever the last thread that loaded the addon exits (nodejs/node#43122).
// Only a process boundary makes the blast fence real. Plain .mjs, not
// TypeScript, so `fork()` with a bare node works identically under tsx in dev
// and in the shipped payload — the server has no build step. No tools, no
// network, no state access: the worker receives one absolute path plus caps
// as its single JSON argv, extracts text, and posts the result over IPC.
import fs from "node:fs";
import { inflateRawSync } from "node:zlib";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import dgram from "node:dgram";
import http2 from "node:http2";
import { syncBuiltinESMExports } from "node:module";

const post = (message) => {
	if (typeof process.send !== "function") {
		console.error("shelf parse worker was started without an IPC channel; the shelf reading driver must fork() it");
		process.exit(1);
	}
	// Exit through the send callback so the message is fully flushed first —
	// pdfjs can leave timers alive that would otherwise keep the process up.
	process.send(message, () => process.exit(0));
};

function decodeXmlEntities(value) {
	return value
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
		.replace(/&amp;/g, "&");
}

/**
 * word/document.xml → plain text. Paragraphs (`</w:p>`) become newlines, tabs
 * and breaks keep their meaning, every other tag is stripped. Deliberately
 * simple tier-1 extraction: honest text for reading and search, not layout.
 */
function extractDocxText(documentXml) {
	const text = documentXml
		.replace(/<w:tab[^>]*\/>/g, "\t")
		.replace(/<w:br[^>]*\/>/g, "\n")
		.replace(/<\/w:p>/g, "\n")
		.replace(/<[^>]+>/g, "");
	return decodeXmlEntities(text)
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

async function parsePdf(buffer, maxPages) {
	const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
	const task = getDocument({
		data: new Uint8Array(buffer),
		// Embedded JavaScript in the PDF is never evaluated; fonts stay data.
		isEvalSupported: false,
		disableFontFace: true,
		useSystemFonts: false,
	});
	const doc = await task.promise;
	const totalPages = doc.numPages;
	const readPages = Math.min(totalPages, maxPages);
	const parts = [];
	for (let pageNumber = 1; pageNumber <= readPages; pageNumber += 1) {
		const page = await doc.getPage(pageNumber);
		const content = await page.getTextContent();
		let pageText = "";
		for (const item of content.items) {
			if (typeof item.str === "string") pageText += item.str;
			if (item.hasEOL) pageText += "\n";
		}
		parts.push(`[page ${pageNumber}]\n${pageText.trim()}`);
		page.cleanup();
	}
	await doc.destroy();
	let text = parts.join("\n\n");
	if (totalPages > readPages) {
		text += `\n\n[stopped at the ${readPages}-page cap; the document has ${totalPages} pages]`;
	}
	return { text, pages: totalPages };
}

// ── Vision paths (vision slice) ─────────────────────────────────────────────
// Image decode and PDF page rendering live in THIS worker on purpose: both run
// native decode paths (@napi-rs/canvas) over hostile bytes, so they get the
// same blast fence as text extraction — a crash or hang costs the worker, the
// driver's timeout reports an honest failure, and the event loop never blocks.

async function loadNapiCanvas() {
	try {
		return await import("@napi-rs/canvas");
	} catch {
		// Optional native dep (pdfjs-dist ships it as an optionalDependency): a
		// platform without the prebuilt binary loses vision, never the server.
		throw new Error("image rendering is unavailable on this system (@napi-rs/canvas could not be loaded)");
	}
}

// Native decoders allocate OUTSIDE the V8 heap, so the worker's JS memory cap
// cannot contain a decompression bomb (a tiny file declaring huge dimensions).
// The containment is this pre-check: dimensions read from the FORMAT HEADER,
// pure JS, before any native decode — over-budget or unparseable-but-large
// files refuse without decoding a single pixel.
const MAX_DECODE_PIXELS = 40_000_000;
const MAX_UNKNOWN_DIMENSION_BYTES = 2 * 1024 * 1024;

function sniffImageDimensions(buffer) {
	// PNG: IHDR width/height, big-endian u32 right after the 8-byte signature + chunk header.
	if (buffer.length >= 24 && buffer[0] === 0x89 && buffer[1] === 0x50) {
		return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
	}
	// JPEG: first SOF0/1/2 segment carries height u16 @+5, width u16 @+7.
	if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
		let at = 2;
		while (at + 9 < buffer.length) {
			if (buffer[at] !== 0xff) { at += 1; continue; }
			const marker = buffer[at + 1];
			if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
				return { width: buffer.readUInt16BE(at + 7), height: buffer.readUInt16BE(at + 5) };
			}
			if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { at += 2; continue; }
			at += 2 + buffer.readUInt16BE(at + 2);
		}
		return null;
	}
	// GIF: logical screen size, u16 little-endian at 6/8.
	if (buffer.length >= 10 && buffer[0] === 0x47 && buffer[1] === 0x49) {
		return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
	}
	// WEBP: VP8X extended header (24-bit minus-one), VP8L lossless (14-bit
	// minus-one), or VP8 lossy frame header (14-bit).
	if (buffer.length >= 30 && buffer.subarray(8, 12).toString("latin1") === "WEBP") {
		const chunk = buffer.subarray(12, 16).toString("latin1");
		if (chunk === "VP8X") {
			return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
		}
		if (chunk === "VP8L" && buffer[20] === 0x2f) {
			const bits = buffer.readUInt32LE(21);
			return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
		}
		if (chunk === "VP8 ") {
			return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
		}
		return null;
	}
	return null;
}

function assertDecodableImageBudget(buffer) {
	const dims = sniffImageDimensions(buffer);
	if (dims) {
		if (dims.width < 1 || dims.height < 1) throw new Error("the image header declares a degenerate size");
		if (dims.width * dims.height > MAX_DECODE_PIXELS) {
			throw new Error(`the image is too large to read visually (${dims.width}x${dims.height} exceeds the ${Math.round(MAX_DECODE_PIXELS / 1_000_000)} megapixel budget)`);
		}
		return;
	}
	if (buffer.length > MAX_UNKNOWN_DIMENSION_BYTES) {
		throw new Error("the image's dimensions could not be verified from its header, so it is not decoded");
	}
}

function encodeJpegBase64(canvasModule, canvas) {
	const jpeg = canvas.toBuffer("image/jpeg", 82);
	return { imageBase64: jpeg.toString("base64"), mimeType: "image/jpeg" };
}

/**
 * An image prepared for provider vision. Small originals pass through
 * unchanged (no recompression); anything over the pixel/byte caps is decoded
 * and downscaled onto a canvas, re-encoded as JPEG. Decode happens here even
 * for the pass-through probe: dimensions come from the decoder, not headers.
 */
async function prepareImage(buffer, { maxDimension, maxPassthroughBytes, mimeType }) {
	assertDecodableImageBudget(buffer);
	const canvasModule = await loadNapiCanvas();
	const image = await canvasModule.loadImage(buffer);
	const width = Number(image.width) || 0;
	const height = Number(image.height) || 0;
	if (width < 1 || height < 1) throw new Error("the image could not be decoded");
	// Pass through the ORIGINAL bytes only when they are plausible for the
	// picture: within the caps AND within a generous byte-per-pixel budget.
	// Bytes beyond that are not picture (trailing garbage after the image data
	// decodes fine and would otherwise ride into the room's context verbatim),
	// so such a file goes down the re-encode path, which keeps only pixels.
	const plausibleBytes = Math.max(64 * 1024, width * height);
	if (buffer.length <= Math.min(maxPassthroughBytes, plausibleBytes) && width <= maxDimension && height <= maxDimension) {
		return { imageBase64: buffer.toString("base64"), mimeType, width, height, downscaled: false };
	}
	const scale = Math.min(1, maxDimension / Math.max(width, height));
	const outWidth = Math.max(1, Math.round(width * scale));
	const outHeight = Math.max(1, Math.round(height * scale));
	const canvas = canvasModule.createCanvas(outWidth, outHeight);
	const context = canvas.getContext("2d");
	context.drawImage(image, 0, 0, outWidth, outHeight);
	const encoded = encodeJpegBase64(canvasModule, canvas);
	if (encoded.imageBase64.length > maxPassthroughBytes * 2) throw new Error("the image is too large to pass to vision even after downscaling");
	return { ...encoded, width: outWidth, height: outHeight, downscaled: true };
}

/**
 * PDF pages rendered to JPEG for provider vision (the scanned-document path).
 * Renders a bounded window [firstPage, firstPage+pageCount) at a bounded pixel
 * budget per page; embedded JavaScript is never evaluated.
 */
async function rasterizePdf(buffer, { firstPage, pageCount, targetWidth, maxPixels }) {
	await loadNapiCanvas(); // fail fast with the honest reason before pdfjs asks for it
	const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
	const task = getDocument({
		data: new Uint8Array(buffer),
		isEvalSupported: false,
		disableFontFace: true,
		useSystemFonts: false,
	});
	const doc = await task.promise;
	const totalPages = doc.numPages;
	const start = Math.min(Math.max(1, firstPage), totalPages);
	const end = Math.min(start + pageCount - 1, totalPages);
	const canvasModule = await loadNapiCanvas();
	const pages = [];
	for (let pageNumber = start; pageNumber <= end; pageNumber += 1) {
		const page = await doc.getPage(pageNumber);
		const base = page.getViewport({ scale: 1 });
		if (base.width < 1 || base.height < 1) throw new Error(`page ${pageNumber} has a degenerate size`);
		// Pixel budget first, target width second, never upscale beyond 4x: a
		// hostile /MediaBox cannot demand a gigapixel canvas.
		let scale = Math.min(targetWidth / base.width, 4);
		if (base.width * scale * (base.height * scale) > maxPixels) {
			scale = Math.sqrt(maxPixels / (base.width * base.height));
		}
		const width = Math.max(1, Math.floor(base.width * scale));
		const height = Math.max(1, Math.floor(base.height * scale));
		const viewport = page.getViewport({ scale });
		const canvas = canvasModule.createCanvas(width, height);
		const context = canvas.getContext("2d");
		context.fillStyle = "#ffffff";
		context.fillRect(0, 0, width, height);
		await page.render({ canvasContext: context, viewport }).promise;
		const encoded = encodeJpegBase64(canvasModule, canvas);
		pages.push({ page: pageNumber, ...encoded });
		page.cleanup();
	}
	await doc.destroy();
	return { pages, totalPages };
}

function previewError(code) {
	const error = new Error(code);
	error.previewCode = code;
	return error;
}

function readPreviewSnapshot(request) {
	const fd = fs.openSync(request.absolutePath, "r");
	try {
		// Not ctime: it moves on metadata alone (seen on files whose content was a day old), and the content is what must not change.
		const matches = (stat) => stat.isFile() && String(stat.dev) === request.expected.dev && String(stat.ino) === request.expected.ino
			&& stat.size === request.expected.size && stat.mtimeMs === request.expected.mtimeMs;
		const before = fs.fstatSync(fd);
		if (!matches(before)) throw previewError("file_changed");
		if (before.size > 26_214_400) throw previewError("file_too_large");
		const buffer = Buffer.alloc(before.size);
		let offset = 0;
		while (offset < buffer.length) {
			const count = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
			if (count === 0) throw previewError("file_changed");
			offset += count;
		}
		if (!matches(fs.fstatSync(fd))) throw previewError("file_changed");
		return buffer;
	} finally {
		fs.closeSync(fd);
	}
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
	let value = index;
	for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
	return value >>> 0;
});

function crc32(buffer) {
	let value = 0xffffffff;
	for (const byte of buffer) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
	return (value ^ 0xffffffff) >>> 0;
}

function previewZipEntries(buffer) {
	const fits = (offset, length) => Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0 && length >= 0 && offset <= buffer.length && length <= buffer.length - offset;
	let end = -1;
	for (let offset = buffer.length - 22, lower = Math.max(0, buffer.length - 65_557); offset >= lower; offset--) {
		if (buffer.readUInt32LE(offset) === 0x06054b50 && fits(offset, 22) && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) { end = offset; break; }
	}
	if (end < 0) throw previewError("damaged_file");
	let disk = buffer.readUInt16LE(end + 4), centralDisk = buffer.readUInt16LE(end + 6);
	let count = buffer.readUInt16LE(end + 10), countOnDisk = buffer.readUInt16LE(end + 8);
	let size = buffer.readUInt32LE(end + 12), start = buffer.readUInt32LE(end + 16);
	if (disk || centralDisk || count !== countOnDisk) throw previewError("unsupported_document_feature");
	if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) {
		const locator = end - 20;
		if (!fits(locator, 20) || buffer.readUInt32LE(locator) !== 0x07064b50 || buffer.readUInt32LE(locator + 4) !== 0 || buffer.readUInt32LE(locator + 16) !== 1) throw previewError("damaged_file");
		const offsetBig = buffer.readBigUInt64LE(locator + 8);
		if (offsetBig > BigInt(buffer.length)) throw previewError("damaged_file");
		const offset = Number(offsetBig);
		if (!fits(offset, 56) || buffer.readUInt32LE(offset) !== 0x06064b50 || buffer.readUInt32LE(offset + 16) || buffer.readUInt32LE(offset + 20)) throw previewError("damaged_file");
		const diskCount = buffer.readBigUInt64LE(offset + 24), total = buffer.readBigUInt64LE(offset + 32);
		const sizeBig = buffer.readBigUInt64LE(offset + 40), startBig = buffer.readBigUInt64LE(offset + 48);
		if (diskCount !== total || total > 10_000n) throw previewError(total > 10_000n ? "preview_too_complex" : "damaged_file");
		if (sizeBig > BigInt(buffer.length) || startBig > BigInt(buffer.length)) throw previewError("damaged_file");
		count = Number(total); size = Number(sizeBig); start = Number(startBig);
	}
	if (count > 10_000) throw previewError("preview_too_complex");
	if (!fits(start, size) || start + size > end) throw previewError("damaged_file");
	const names = new Set(), entries = [], spans = [];
	let offset = start, totalInflated = 0;
	for (let index = 0; index < count; index++) {
		if (!fits(offset, 46) || buffer.readUInt32LE(offset) !== 0x02014b50) throw previewError("damaged_file");
		const flags = buffer.readUInt16LE(offset + 8), method = buffer.readUInt16LE(offset + 10), checksum = buffer.readUInt32LE(offset + 16);
		let compressed = buffer.readUInt32LE(offset + 20), expanded = buffer.readUInt32LE(offset + 24), local = buffer.readUInt32LE(offset + 42);
		const zip64Sizes = compressed === 0xffffffff || expanded === 0xffffffff;
		const nameLength = buffer.readUInt16LE(offset + 28), extraLength = buffer.readUInt16LE(offset + 30), commentLength = buffer.readUInt16LE(offset + 32);
		const entryLength = 46 + nameLength + extraLength + commentLength;
		if (!fits(offset, entryLength) || offset + entryLength > start + size || buffer.readUInt16LE(offset + 34)) throw previewError("damaged_file");
		if (flags & (1 | 0x40 | 0x2000)) throw previewError("encrypted_file");
		if (method !== 0 && method !== 8) throw previewError("unsupported_document_feature");
		const nameBytes = buffer.subarray(offset + 46, offset + 46 + nameLength);
		const name = nameBytes.toString("utf8");
		if (Buffer.from(name, "utf8").compare(nameBytes) !== 0 || !name || name.includes("\\") || name.startsWith("/") || name.includes("\0") || name.split("/").some((part, i, all) => part === "." || part === ".." || (!part && i !== all.length - 1)) || names.has(name)) throw previewError("damaged_file");
		names.add(name);
		if (compressed === 0xffffffff || expanded === 0xffffffff || local === 0xffffffff) {
			let at = offset + 46 + nameLength, zip64 = null, endExtra = at + extraLength;
			while (at + 4 <= endExtra) {
				const tag = buffer.readUInt16LE(at), length = buffer.readUInt16LE(at + 2); at += 4;
				if (length > endExtra - at) throw previewError("damaged_file");
				if (tag === 1) zip64 = { at, end: at + length };
				at += length;
			}
			if (!zip64) throw previewError("damaged_file");
			const next = () => { if (zip64.at + 8 > zip64.end) throw previewError("damaged_file"); const value = buffer.readBigUInt64LE(zip64.at); zip64.at += 8; if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw previewError("preview_too_complex"); return Number(value); };
			if (expanded === 0xffffffff) expanded = next();
			if (compressed === 0xffffffff) compressed = next();
			if (local === 0xffffffff) local = next();
		}
		if (expanded > 33_554_432 || (expanded > 0 && (compressed === 0 || expanded > compressed * 200))) throw previewError("expanded_content_too_large");
		totalInflated += expanded;
		if (totalInflated > 134_217_728) throw previewError("expanded_content_too_large");
		if (!fits(local, 30) || buffer.readUInt32LE(local) !== 0x04034b50 || buffer.readUInt16LE(local + 6) !== flags || buffer.readUInt16LE(local + 8) !== method) throw previewError("damaged_file");
		const localNameLength = buffer.readUInt16LE(local + 26), localExtraLength = buffer.readUInt16LE(local + 28);
		const dataOffset = local + 30 + localNameLength + localExtraLength;
		if (!fits(local + 30, localNameLength + localExtraLength) || !buffer.subarray(local + 30, local + 30 + localNameLength).equals(nameBytes) || !fits(dataOffset, compressed) || dataOffset + compressed > start) throw previewError("damaged_file");
		let localCompressed = buffer.readUInt32LE(local + 18), localExpanded = buffer.readUInt32LE(local + 22);
		const localChecksum = buffer.readUInt32LE(local + 14);
		if (!(flags & 8) && (localCompressed === 0xffffffff || localExpanded === 0xffffffff)) {
			let at = local + 30 + localNameLength, zip64 = null, endExtra = at + localExtraLength;
			while (at + 4 <= endExtra) {
				const tag = buffer.readUInt16LE(at), length = buffer.readUInt16LE(at + 2); at += 4;
				if (length > endExtra - at) throw previewError("damaged_file");
				if (tag === 1) zip64 = { at, end: at + length };
				at += length;
			}
			if (!zip64) throw previewError("damaged_file");
			const next = () => { if (zip64.at + 8 > zip64.end) throw previewError("damaged_file"); const value = buffer.readBigUInt64LE(zip64.at); zip64.at += 8; if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw previewError("preview_too_complex"); return Number(value); };
			if (localExpanded === 0xffffffff) localExpanded = next();
			if (localCompressed === 0xffffffff) localCompressed = next();
		}
		let recordEnd = dataOffset + compressed;
		if (!(flags & 8)) {
			if (localChecksum !== checksum || localCompressed !== compressed || localExpanded !== expanded) throw previewError("damaged_file");
		} else {
			if ((localChecksum !== 0 && localChecksum !== checksum) || (localCompressed !== 0 && localCompressed !== 0xffffffff && localCompressed !== compressed) || (localExpanded !== 0 && localExpanded !== 0xffffffff && localExpanded !== expanded)) throw previewError("damaged_file");
			const positions = fits(recordEnd, 4) && buffer.readUInt32LE(recordEnd) === 0x08074b50 ? [recordEnd + 4, recordEnd] : [recordEnd];
			const widths = zip64Sizes || localCompressed === 0xffffffff || localExpanded === 0xffffffff ? [20, 12] : [12, 20];
			let matchedEnd = -1;
			for (const position of positions) {
				for (const descriptorBytes of widths) {
					if (!fits(position, descriptorBytes) || position + descriptorBytes > start || buffer.readUInt32LE(position) !== checksum) continue;
					const descriptorCompressed = descriptorBytes === 20 ? buffer.readBigUInt64LE(position + 4) : BigInt(buffer.readUInt32LE(position + 4));
					const descriptorExpanded = descriptorBytes === 20 ? buffer.readBigUInt64LE(position + 12) : BigInt(buffer.readUInt32LE(position + 8));
					if (descriptorCompressed === BigInt(compressed) && descriptorExpanded === BigInt(expanded)) { matchedEnd = position + descriptorBytes; break; }
				}
				if (matchedEnd >= 0) break;
			}
			if (matchedEnd < 0) throw previewError("damaged_file");
			recordEnd = matchedEnd;
		}
		spans.push({ start: local, end: recordEnd });
		entries.push({ name, method, checksum, compressed, expanded, dataOffset });
		offset += entryLength;
	}
	if (offset !== start + size) throw previewError("damaged_file");
	spans.sort((a, b) => a.start - b.start);
	for (let i = 1; i < spans.length; i++) if (spans[i].start < spans[i - 1].end) throw previewError("damaged_file");
	return entries;
}

function rasterMime(buffer) {
	if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
	if (buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
	if (/^GIF8[79]a$/.test(buffer.subarray(0, 6).toString("ascii"))) return "image/gif";
	if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
	return null;
}

function countXmlElements(text, current) {
	let offset = 0;
	while ((offset = text.indexOf("<", offset)) !== -1) {
		if (text.startsWith("<!--", offset) || text.startsWith("<![CDATA[", offset) || text.startsWith("<?", offset)) {
			const close = text.startsWith("<!--", offset) ? "-->" : text.startsWith("<![CDATA[", offset) ? "]]>" : "?>";
			const end = text.indexOf(close, offset + 2);
			if (end < 0) throw previewError("damaged_file");
			offset = end + close.length;
			continue;
		}
		const next = text[offset + 1];
		if (!next || next === "!") throw previewError("unsupported_document_feature");
		if (next !== "/" && ++current > 200_000) throw previewError("preview_too_complex");
		let quote = "";
		let end = offset + 1;
		for (; end < text.length; end++) {
			const char = text[end];
			if (quote) { if (char === quote) quote = ""; }
			else if (char === "\"" || char === "'") quote = char;
			else if (char === ">") break;
		}
		if (end === text.length) throw previewError("damaged_file");
		offset = end + 1;
	}
	return current;
}

function inflatePreviewEntry(buffer, entry) {
	let output;
	try {
		const compressed = buffer.subarray(entry.dataOffset, entry.dataOffset + entry.compressed);
		output = entry.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.expanded) });
	} catch { throw previewError("damaged_file"); }
	if (output.length !== entry.expanded || crc32(output) !== entry.checksum) throw previewError("damaged_file");
	return output;
}

async function preflightPreviewZip(buffer) {
	const entries = previewZipEntries(buffer);
	const relationships = new Map();
	let imagePixels = 0;
	let xmlElements = 0;
	for (const entry of entries) {
		let output;
		try {
			const compressed = buffer.subarray(entry.dataOffset, entry.dataOffset + entry.compressed);
			output = entry.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.expanded) });
		} catch { throw previewError("damaged_file"); }
		if (output.length !== entry.expanded || crc32(output) !== entry.checksum) throw previewError("damaged_file");
		if (/\.(?:xml|rels)$/i.test(entry.name)) {
			let encoding = "utf-8";
			if (output[0] === 0xff && output[1] === 0xfe || output[0] === 0x3c && output[1] === 0) encoding = "utf-16le";
			if (output[0] === 0xfe && output[1] === 0xff || output[0] === 0 && output[1] === 0x3c) encoding = "utf-16be";
			let text;
			try { text = new TextDecoder(encoding, { fatal: true }).decode(output); } catch { throw previewError("damaged_file"); }
			xmlElements = countXmlElements(text, xmlElements);
			if (entry.name.endsWith(".rels")) relationships.set(entry.name, text);
		}
		if (!entry.name.endsWith("/") && (entry.name.startsWith("word/media/") || /\.(?:png|jpe?g|gif|webp)$/i.test(entry.name))) {
			const mime = rasterMime(output);
			if (!mime) throw previewError("unsupported_document_feature");
			const extension = entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase();
			const expectedMime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" }[extension];
			if (mime !== expectedMime) throw previewError("damaged_file");
			const dimensions = sniffImageDimensions(output);
			if (!dimensions || dimensions.width < 1 || dimensions.height < 1) throw previewError("unsupported_document_feature");
			const pixels = dimensions.width * dimensions.height;
			imagePixels += pixels;
			if (pixels > 40_000_000 || imagePixels > 80_000_000) throw previewError("decoded_image_too_large");
			let canvas;
			try { canvas = await loadNapiCanvas(); } catch { throw previewError("renderer_unavailable"); }
			try {
				const image = await canvas.loadImage(output);
				if (image.width !== dimensions.width || image.height !== dimensions.height) throw previewError("damaged_file");
			} catch { throw previewError("damaged_file"); }
		}
	}
	return relationships;
}

function denyPreviewNetwork() {
	const deny = () => { throw previewError("unsupported_document_feature"); };
	globalThis.fetch = deny;
	globalThis.WebSocket = deny;
	globalThis.EventSource = deny;
	http.request = http.get = https.request = https.get = deny;
	net.connect = net.createConnection = tls.connect = dgram.createSocket = http2.connect = deny;
	net.Socket.prototype.connect = deny;
	for (const name of ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa", "resolveCname", "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTxt", "reverse"]) {
		if (name in dns) dns[name] = deny;
		if (name in dns.promises) dns.promises[name] = deny;
		if (name in dns.Resolver.prototype) dns.Resolver.prototype[name] = deny;
		if (name in dns.promises.Resolver.prototype) dns.promises.Resolver.prototype[name] = deny;
	}
	syncBuiltinESMExports();
}

const WORD_CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
const WORD_CSS_PROPERTIES = new Set(("background background-color border border-top border-right border-bottom border-left border-color border-style border-width border-collapse border-spacing border-radius box-sizing color display direction flex flex-basis flex-direction flex-flow flex-grow flex-shrink flex-wrap align-items align-self justify-content z-index font font-family font-size font-style font-weight font-variant height line-height margin margin-top margin-right margin-bottom margin-left max-height max-width min-height min-width overflow overflow-wrap padding padding-top padding-right padding-bottom padding-left page-break-after page-break-before page-break-inside position left top right bottom transform transform-origin text-align text-decoration text-indent text-transform vertical-align white-space width word-break word-spacing letter-spacing list-style-type table-layout").split(" "));

function safeWordStyle(style, markBlocked) {
	const declarations = [];
	let declarationBytes = 0;
	for (let index = 0; index < style.length; index++) {
		const property = style[index].toLowerCase();
		const value = style.getPropertyValue(property);
		if (Buffer.byteLength(value) > 16_777_216) throw previewError("preview_too_complex");
		const decoded = value.replace(/\\([0-9a-fA-F]{1,6}\s?|.)/g, (_, escape) => /^[0-9a-fA-F]/.test(escape) ? String.fromCodePoint(Number.parseInt(escape.trim(), 16) || 0xfffd) : escape);
		if (/url\s*\(|(?:-webkit-)?image-set\s*\(|cross-fade\s*\(|src\s*\(/i.test(decoded)) markBlocked();
		if (!WORD_CSS_PROPERTIES.has(property) || /url\s*\(|(?:-webkit-)?image-set\s*\(|cross-fade\s*\(|src\s*\(|expression\s*\(|behavior|binding|@|[<>\x00-\x1f]/i.test(decoded)) continue;
		declarationBytes += Buffer.byteLength(property) + Buffer.byteLength(value) + 16;
		if (declarationBytes > 16_777_216) throw previewError("preview_too_complex");
		declarations.push(`${property}: ${value}${style.getPropertyPriority(property) ? " !important" : ""}`);
	}
	return declarations.join("; ");
}

function serializeWordBody(document, head) {
	const chunks = [];
	let bytes = 0;
	const append = (value) => {
		const size = Buffer.byteLength(value);
		if (bytes + size > 16_777_216) throw previewError("preview_too_complex");
		bytes += size;
		chunks.push(value);
	};
	const escaped = (value, attribute) => {
		let extra = 0;
		for (const character of value) {
			if (character === "&") extra += 4;
			else if (character === "<" || character === ">") extra += 3;
			else if (attribute && character === '"') extra += 5;
		}
		if (bytes + Buffer.byteLength(value) + extra > 16_777_216) throw previewError("preview_too_complex");
		return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', attribute ? "&quot;" : '"');
	};
	append(head);
	const voidTags = new Set(["BR", "HR", "IMG", "COL"]);
	const stack = [{ node: document.body, closing: false }];
	while (stack.length) {
		const { node, closing } = stack.pop();
		if (node.nodeType === 3) { append(escaped(node.nodeValue ?? "", false)); continue; }
		if (node.nodeType !== 1) continue;
		const tag = node.tagName.toLowerCase();
		if (closing) { append(`</${tag}>`); continue; }
		append(`<${tag}`);
		for (const attribute of node.attributes) {
			append(` ${attribute.name}="`);
			append(escaped(attribute.value, true));
			append('"');
		}
		append(">");
		if (voidTags.has(node.tagName)) continue;
		stack.push({ node, closing: true });
		for (let child = node.lastChild; child; child = child.previousSibling) stack.push({ node: child, closing: false });
	}
	append("</html>");
	return chunks.join("");
}

function sanitizeWordDocument(document, notices) {
	const markBlocked = () => {
		if (!notices.some((notice) => notice.code === "external_resources_blocked")) notices.push({ code: "external_resources_blocked", text: "External document resources are blocked." });
	};
	const styles = [];
	let styleBytes = 0;
	for (const element of document.querySelectorAll("style")) {
		try {
			for (const rule of element.sheet?.cssRules ?? []) {
				if (!rule.selectorText || !rule.style || /[@\\{}<>]/.test(rule.selectorText)) continue;
				const body = safeWordStyle(rule.style, markBlocked);
				if (body) {
					styleBytes += Buffer.byteLength(rule.selectorText) + Buffer.byteLength(body) + 6;
					if (styleBytes > 16_777_216) throw previewError("preview_too_complex");
					styles.push(`${rule.selectorText} { ${body} }`);
				}
			}
		} catch (error) { if (error?.previewCode) throw error; throw previewError("damaged_file"); }
	}
	// Word's horizontal lines (VML) come out of docx-preview as <svg>, which is removed below; keep them as a plain double rule.
	for (const svg of document.querySelectorAll("svg")) {
		const rule = document.createElement("div");
		rule.setAttribute("style", svg.getAttribute("style") || "");
		if (!rule.style.width) continue;
		rule.style.height = "0";
		rule.style.borderTop = "3px double #000";
		svg.replaceWith(rule);
	}
	for (const element of document.querySelectorAll("script, style, link, iframe, frame, object, embed, svg, math, form, input, button, textarea, select, meta, base, video, audio, source")) element.remove();
	const allowedTags = new Set("DIV SECTION ARTICLE HEADER FOOTER P SPAN B STRONG I EM U S STRIKE TABLE TBODY THEAD TFOOT TR TD TH COLGROUP COL BR HR IMG H1 H2 H3 H4 H5 H6 OL UL LI SUP SUB BLOCKQUOTE PRE CODE A".split(" "));
	const elements = [...document.body.querySelectorAll("*")];
	let renderedPixels = 0;
	if (elements.length > 200_000) throw previewError("preview_too_complex");
	for (const element of elements) {
		if (!allowedTags.has(element.tagName)) { element.replaceWith(...element.childNodes); continue; }
		for (const attr of [...element.attributes]) {
			const name = attr.name.toLowerCase();
			if (name === "style") {
				const value = safeWordStyle(element.style, markBlocked);
				if (value) element.setAttribute("style", value); else element.removeAttribute("style");
			} else if (name === "class" || name === "colspan" || name === "rowspan" || name === "width" || name === "height" || name === "alt") {
				continue;
			} else if (element.tagName === "IMG" && name === "src" && /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/i.test(attr.value)) {
				continue;
			} else element.removeAttribute(attr.name);
		}
		if (element.tagName === "IMG") {
			const src = element.getAttribute("src");
			if (!src) throw previewError("unsupported_document_feature");
			const base64 = src.slice(src.indexOf(",") + 1);
			if (base64.length > 22_369_624 || base64.length % 4 !== 0) throw previewError("preview_too_complex");
			const bytes = Buffer.from(base64, "base64");
			if (rasterMime(bytes) !== src.slice(5, src.indexOf(";")).toLowerCase()) throw previewError("damaged_file");
			const dimensions = sniffImageDimensions(bytes);
			if (!dimensions || dimensions.width < 1 || dimensions.height < 1) throw previewError("damaged_file");
			const pixels = dimensions.width * dimensions.height;
			renderedPixels += pixels;
			if (pixels > 40_000_000 || renderedPixels > 80_000_000) throw previewError("decoded_image_too_large");
		}
	}
	const escapedCsp = WORD_CSP.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
	// docx-preview paints a grey desk behind its pages; a light desk keeps the white page reading as paper.
	const css = `${styles.join("\n")}\nbody { margin: 0; background: #f3f0ea; }\n.docx-wrapper { background: #f3f0ea; padding: 24px; align-items: safe center; width: fit-content; min-width: 100%; box-sizing: border-box; }\n.docx-wrapper > section.docx { flex: none; background: #fff; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.18); margin-bottom: 24px; }`.replaceAll("<", "\\3c ");
	const html = serializeWordBody(document, `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${escapedCsp}"><style>${css}</style></head>`);
	return { ok: true, schemaVersion: 1, notices, result: { kind: "word", html } };
}

// Word also allows sizes like w:sz="4.3mm" (Teams transcripts do this). docx-preview reads only the number,
// so that text comes out at 2pt. It gets the plain numbers it expects: half-points for font sizes, twips elsewhere.
function wordMeasuresToNumbers(xml) {
	const points = (value, unit) => Number(value) * { mm: 72 / 25.4, cm: 72 / 2.54, in: 72, pt: 1, pc: 12, pi: 12 }[unit];
	return xml
		.replace(/(<w:(?:sz|szCs|kern|position)\b[^>]*?w:val=")(-?[\d.]+)(mm|cm|in|pt|pc|pi)"/g, (_, start, value, unit) => `${start}${Math.round(points(value, unit) * 2)}"`)
		.replace(/(\sw:[A-Za-z]+=")(-?[\d.]+)(mm|cm|in|pt|pc|pi)"/g, (_, start, value, unit) => `${start}${Math.round(points(value, unit) * 20)}"`);
}

async function previewWord(buffer) {
	const relationships = await preflightPreviewZip(buffer);
	denyPreviewNetwork();
	let JSDOM, JSZip, renderAsync;
	try {
		({ JSDOM } = await import("jsdom"));
		({ default: JSZip } = await import("jszip"));
		({ renderAsync } = await import("docx-preview"));
	} catch { throw previewError("renderer_unavailable"); }
	const dom = new JSDOM("<!doctype html><html><head></head><body><div id=styles></div><div id=content></div></body></html>", { pretendToBeVisual: true });
	const { window } = dom;
	try {
		for (const name of ["window", "document", "HTMLElement", "Element", "Node", "DOMParser", "XMLSerializer", "FileReader", "Blob"]) globalThis[name] = name === "window" ? window : window[name];
		globalThis.getComputedStyle = window.getComputedStyle.bind(window);
		// docx-preview measures legacy drawings (VML) in a frame callback; jsdom has no layout, so the callback never runs.
		globalThis.requestAnimationFrame = () => 0;
		globalThis.cancelAnimationFrame = () => {};
		let createdElements = 0;
		let createdTextBytes = 0;
		let encodedImageBytes = 0;
		const readDataUrl = window.FileReader.prototype.readAsDataURL;
		window.FileReader.prototype.readAsDataURL = function(blob) {
			encodedImageBytes += Math.ceil(blob.size / 3) * 4 + 100;
			if (encodedImageBytes > 16_777_216) throw previewError("preview_too_complex");
			return readDataUrl.call(this, blob);
		};
		const createText = window.document.createTextNode.bind(window.document);
		window.document.createTextNode = (value) => {
			createdTextBytes += Buffer.byteLength(String(value));
			if (createdTextBytes > 16_777_216) throw previewError("preview_too_complex");
			return createText(value);
		};
		for (const name of ["createElement", "createElementNS"]) {
			const create = window.document[name].bind(window.document);
			window.document[name] = (...args) => {
				if (++createdElements > 200_000) throw previewError("preview_too_complex");
				return create(...args);
			};
		}
		window.fetch = () => { throw previewError("unsupported_document_feature"); };
		window.WebSocket = window.EventSource = window.XMLHttpRequest = function() { throw previewError("unsupported_document_feature"); };
		const zip = await JSZip.loadAsync(buffer);
		let blocked = false;
		for (const [name, text] of relationships) {
			const xml = new window.DOMParser().parseFromString(text, "application/xml");
			if (xml.querySelector("parsererror, doctype")) throw previewError("damaged_file");
			const externalImages = new Set();
			for (const relation of [...xml.getElementsByTagNameNS("*", "Relationship")]) {
				if (relation.getAttribute("TargetMode")?.toLowerCase() === "external") {
					if (relation.getAttribute("Type")?.endsWith("/image")) externalImages.add(relation.getAttribute("Id"));
					relation.remove(); blocked = true;
				}
			}
			zip.file(name, new window.XMLSerializer().serializeToString(xml));
			if (externalImages.size) {
				const partName = name.replace(/(^|\/)_rels\/([^/]+)\.rels$/, "$1$2");
				const part = zip.file(partName);
				if (!part) throw previewError("damaged_file");
				const partXml = new window.DOMParser().parseFromString(await part.async("string"), "application/xml");
				if (partXml.querySelector("parsererror")) throw previewError("damaged_file");
				for (const blip of [...partXml.getElementsByTagNameNS("*", "blip")]) {
					const link = blip.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "link");
					if (!externalImages.has(link)) continue;
					let drawing = blip.parentNode;
					while (drawing && drawing.localName !== "drawing") drawing = drawing.parentNode;
					if (!drawing?.parentNode) throw previewError("unsupported_document_feature");
					const text = partXml.createElementNS("http://schemas.openxmlformats.org/wordprocessingml/2006/main", "w:t");
					text.textContent = "External image blocked.";
					drawing.parentNode.replaceChild(text, drawing);
				}
				zip.file(partName, new window.XMLSerializer().serializeToString(partXml));
			}
		}
		// docx-preview lays every anchored drawing out from its paragraph, so a page-relative horizontal offset must lose the page's left margin.
		const pageMarginLeftEmu = Number(/<w:pgMar\b[^>]*\sw:left="(\d+)"/.exec(await zip.file("word/document.xml")?.async("string") ?? "")?.[1] ?? 0) * 635;
		const anchoredFromPage = (xml) => pageMarginLeftEmu ? xml.replace(/(<wp:positionH\b[^>]*relativeFrom="page"[^>]*>\s*<wp:posOffset>)(-?\d+)(<\/wp:posOffset>)/g, (_, head, offset, tail) => `${head}${Number(offset) - pageMarginLeftEmu}${tail}`) : xml;
		for (const part of zip.file(/^word\/[^/]+\.xml$/)) zip.file(part.name, anchoredFromPage(wordMeasuresToNumbers(await part.async("string"))));
		const sanitized = await zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
		await renderAsync(sanitized, window.document.getElementById("content"), window.document.getElementById("styles"), { inWrapper: true, ignoreWidth: false, ignoreHeight: false, ignoreLastRenderedPageBreak: false, useBase64URL: true });
		const notices = blocked ? [{ code: "external_resources_blocked", text: "External document resources are blocked." }] : [];
		return sanitizeWordDocument(window.document, notices);
	} catch (error) {
		if (error?.previewCode) throw error;
		const name = ["Error", "TypeError", "ReferenceError", "RangeError", "SyntaxError"].includes(error?.name) ? error.name : "UnknownError";
		const message = error?.message === "requestAnimationFrame is not defined" ? error.message : "Unexpected renderer error";
		await new Promise((resolve) => process.stderr.write(`WORD_PREVIEW_DIAGNOSTIC ${name}|${message}\n`, resolve));
		throw previewError("damaged_file");
	} finally { window.close(); }
}

async function previewPdf(buffer) {
	if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") throw previewError("damaged_file");
	let canvasModule;
	try { canvasModule = await loadNapiCanvas(); } catch { throw previewError("renderer_unavailable"); }
	for (const name of ["DOMMatrix", "ImageData", "Path2D"]) {
		if (globalThis[name] === undefined) globalThis[name] = canvasModule[name];
	}
	let getDocument;
	try { ({ getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs")); } catch { throw previewError("renderer_unavailable"); }
	let doc;
	try {
		doc = await getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, disableFontFace: true, useSystemFonts: false }).promise;
	} catch (error) {
		throw previewError(error?.name === "PasswordException" ? "encrypted_file" : "damaged_file");
	}
	try {
		const totalPages = doc.numPages;
		if (!Number.isInteger(totalPages) || totalPages < 1) throw previewError("damaged_file");
		if (totalPages > 200) throw previewError("preview_too_complex");
		const geometry = [];
		let totalPixels = 0;
		for (let pageNumber = 1; pageNumber <= totalPages; pageNumber++) {
			const page = await doc.getPage(pageNumber);
			const base = page.getViewport({ scale: 1 });
			if (!Number.isFinite(base.width) || !Number.isFinite(base.height) || base.width < 1 || base.height < 1) throw previewError("damaged_file");
			let scale = Math.min(1400 / base.width, 4);
			if (base.width * scale * base.height * scale > 4_000_000) scale = Math.sqrt(4_000_000 / (base.width * base.height));
			const widthPx = Math.max(1, Math.floor(base.width * scale));
			const heightPx = Math.max(1, Math.floor(base.height * scale));
			totalPixels += widthPx * heightPx;
			if (totalPixels > 80_000_000) throw previewError("preview_too_complex");
			geometry.push({ widthPx, heightPx, scale });
			page.cleanup();
		}
		const pages = [];
		let jpegBytes = 0;
		for (let index = 0; index < totalPages; index++) {
			const page = await doc.getPage(index + 1);
			const { widthPx, heightPx, scale } = geometry[index];
			const canvas = canvasModule.createCanvas(widthPx, heightPx);
			const context = canvas.getContext("2d");
			context.fillStyle = "#ffffff";
			context.fillRect(0, 0, widthPx, heightPx);
			await page.render({ canvasContext: context, viewport: page.getViewport({ scale }) }).promise;
			const jpeg = canvas.toBuffer("image/jpeg", 82);
			jpegBytes += jpeg.length;
			if (jpegBytes > 33_554_432) throw previewError("preview_too_complex");
			pages.push({ page: index + 1, mimeType: "image/jpeg", imageBase64: jpeg.toString("base64"), widthPx, heightPx });
			page.cleanup();
		}
		const reply = { ok: true, schemaVersion: 1, notices: [], result: { kind: "pdf", totalPages, pages } };
		if (Buffer.byteLength(JSON.stringify(reply)) > 50_331_648) throw previewError("preview_too_complex");
		return reply;
	} finally {
		await doc.destroy();
	}
}

const EXCEL_DEFAULT_THEME = ["FFFFFF", "000000", "E7E6E6", "44546A", "4472C4", "ED7D31", "A5A5A5", "FFC000", "5B9BD5", "70AD47", "0563C1", "954F72"];
const EXCEL_INDEXED = "000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF 000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF 800000 008000 000080 808000 800080 008080 C0C0C0 808080 9999FF 993366 FFFFCC CCFFFF 660066 FF8080 0066CC CCCCFF 000080 FF00FF FFFF00 00FFFF 800080 800000 008080 0000FF 00CCFF CCFFFF CCFFCC FFFF99 99CCFF FF99CC CC99FF FFCC99 3366FF 33CCCC 99CC00 FFCC00 FF9900 FF6600 666699 969696 003366 339966 003300 333300 993300 993366 333399 333333".split(" ");

// Excel numbers theme colours light before dark, the theme file lists dark first.
function excelThemePalette(workbook) {
	const xml = Object.values(workbook.model?.themes ?? {}).find((item) => typeof item === "string") ?? "";
	const scheme = /<a:clrScheme\b[^]*?<\/a:clrScheme>/.exec(xml)?.[0];
	if (!scheme) return EXCEL_DEFAULT_THEME;
	const read = (name, fallback) => {
		const entry = new RegExp(`<a:${name}>([^]*?)</a:${name}>`).exec(scheme)?.[1] ?? "";
		return (/lastClr="([0-9a-f]{6})"/i.exec(entry) ?? /srgbClr val="([0-9a-f]{6})"/i.exec(entry))?.[1].toUpperCase() ?? fallback;
	};
	return ["lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"].map((name, index) => read(name, EXCEL_DEFAULT_THEME[index]));
}

function excelTint(hex, tint) {
	const [r, g, b] = [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);
	const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
	let l = (max + min) / 2;
	const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));
	const h = delta === 0 ? 0 : max === r ? ((g - b) / delta + 6) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
	l = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
	const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(h % 2 - 1)), m = l - c / 2;
	const rgb = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h) % 6];
	return rgb.map((part) => Math.round(Math.min(1, Math.max(0, part + m)) * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
}

function excelColor(value, palette) {
	if (/^[0-9a-f]{8}$/i.test(value?.argb ?? "")) return `#${value.argb.slice(2).toUpperCase()}`;
	const base = Number.isInteger(value?.theme) ? palette[value.theme] : Number.isInteger(value?.indexed) ? EXCEL_INDEXED[value.indexed] : undefined;
	if (!base) return null;
	const tint = Number(value.tint);
	return `#${tint ? excelTint(base, Math.max(-1, Math.min(1, tint))) : base}`;
}

// shortcut: the number and date formats people commonly use, in en-US digits; use a compatible formatter when broader fidelity is approved.
const excelLiteral = (part) => part.replace(/\[\$([^\]-]*)(?:-[^\]]*)?\]/g, "$1").replace(/\[[^\]]*\]/g, "").replace(/"([^"]*)"/g, "$1").replace(/\\(.)/g, "$1").replace(/_./g, " ").replace(/\*./g, "");

function excelNumberText(value, numFmt) {
	const sections = numFmt.split(";");
	const section = value < 0 && sections[1] !== undefined ? sections[1] : value === 0 && sections[2] !== undefined ? sections[2] : sections[0];
	const signed = value < 0 && sections[1] === undefined;
	const literal = excelLiteral(section);
	const core = /[#0?][#0?,]*(?:\.[#0?]*)?|\.[#0?]+/.exec(literal);
	if (!core) return literal;
	const percent = literal.includes("%");
	const digits = Math.min(core[0].split(".")[1]?.length ?? 0, 20);
	const number = Math.abs(percent ? value * 100 : value).toLocaleString("en-US", { useGrouping: core[0].includes(","), minimumFractionDigits: digits, maximumFractionDigits: digits });
	return (signed ? "-" : "") + literal.slice(0, core.index) + number + literal.slice(core.index + core[0].length);
}

function excelDateText(date, numFmt) {
	const pad = (n, width = 2) => String(n).padStart(width, "0");
	const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
	const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
	const midnight = date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0;
	const format = excelLiteral((numFmt || (midnight ? "yyyy-mm-dd" : "yyyy-mm-dd hh:mm")).split(";")[0]);
	const tokens = format.match(/y+|m+|d+|h+|s+|am\/pm|a\/p|[^ymdhs]/gi) ?? [];
	const twelveHour = tokens.some((token) => /^a/i.test(token) && token.includes("/"));
	const hours = twelveHour ? date.getUTCHours() % 12 || 12 : date.getUTCHours();
	return tokens.map((token, index) => {
		const lower = token.toLowerCase(), size = token.length;
		if (lower.includes("/") && lower.startsWith("a")) return date.getUTCHours() < 12 ? "AM" : "PM";
		if (lower[0] === "y") return size <= 2 ? pad(date.getUTCFullYear() % 100) : String(date.getUTCFullYear());
		if (lower[0] === "d") return size >= 4 ? days[date.getUTCDay()] : size === 3 ? days[date.getUTCDay()].slice(0, 3) : size === 2 ? pad(date.getUTCDate()) : String(date.getUTCDate());
		if (lower[0] === "h") return size >= 2 ? pad(hours) : String(hours);
		if (lower[0] === "s") return size >= 2 ? pad(date.getUTCSeconds()) : String(date.getUTCSeconds());
		if (lower[0] === "m") {
			// "m" means minutes right after hours or right before seconds, otherwise month.
			const isField = (item) => /^[ymdhs]/i.test(item);
			const before = tokens.slice(0, index).findLast(isField), after = tokens.slice(index + 1).find(isField);
			if (size <= 2 && (/^h/i.test(before ?? "") || /^s/i.test(after ?? ""))) return size === 2 ? pad(date.getUTCMinutes()) : String(date.getUTCMinutes());
			return size >= 4 ? months[date.getUTCMonth()] : size === 3 ? months[date.getUTCMonth()].slice(0, 3) : size === 2 ? pad(date.getUTCMonth() + 1) : String(date.getUTCMonth() + 1);
		}
		return token;
	}).join("");
}

function previewSpreadsheet(workbook) {
	const palette = excelThemePalette(workbook);
	const color = (value, fallback) => excelColor(value, palette) ?? fallback;
	const styles = [];
	const styleIds = new Map();
	const addStyle = (source = {}, generalAlign = "left") => {
		const font = source.font ?? {}, alignment = source.alignment ?? {}, borders = source.border ?? {};
		const side = (item) => item?.style ? { style: item.style, color: color(item.color, "#000000") } : null;
		const style = { fill: source.fill?.type === "pattern" && source.fill.pattern === "solid" ? color(source.fill.fgColor, null) : null,
			font: { family: font.name || "Arial", sizePt: font.size || 11, color: color(font.color, "#000000"), bold: !!font.bold, italic: !!font.italic, underline: font.underline === "double" ? "double" : font.underline ? "single" : "none", strike: !!font.strike },
			borders: { top: side(borders.top), right: side(borders.right), bottom: side(borders.bottom), left: side(borders.left) },
			align: { horizontal: ["left", "center", "right"].includes(alignment.horizontal) ? alignment.horizontal : generalAlign, vertical: ["top", "middle", "bottom"].includes(alignment.vertical) ? alignment.vertical : "bottom", wrap: !!alignment.wrapText } };
		const key = JSON.stringify(style);
		if (!styleIds.has(key)) { styleIds.set(key, styles.length); styles.push(style); }
		return styleIds.get(key);
	};
	addStyle();
	const sheets = workbook.worksheets.map((sheet, index) => {
		const merges = Object.values(sheet.model.merges ?? {}).map((range) => {
			const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);
			const column = (name) => [...name].reduce((n, char) => n * 26 + char.charCodeAt(0) - 64, 0);
			return { top: Number(match[2]), left: column(match[1]), bottom: Number(match[4]), right: column(match[3]) };
		});
		const rowCount = sheet.rowCount, columnCount = sheet.columnCount;
		const cells = [], rows = [], columns = [];
		sheet.eachRow((row, rowNumber) => {
			if (row.height) rows.push({ index: rowNumber, heightPx: row.height * 4 / 3 });
			row.eachCell((cell, columnNumber) => {
				if (merges.some((merge) => rowNumber >= merge.top && rowNumber <= merge.bottom && columnNumber >= merge.left && columnNumber <= merge.right && (rowNumber !== merge.top || columnNumber !== merge.left))) return;
				let value = cell.value, valueKind = "text";
				if (value && typeof value === "object" && !(value instanceof Date) && ("formula" in value || "sharedFormula" in value)) { value = value.result; valueKind = value == null ? "formula-result-unavailable" : "formula-result"; }
				else if (value instanceof Date) valueKind = "date";
				else if (typeof value === "number") valueKind = "number";
				else if (typeof value === "boolean") valueKind = "boolean";
				else if (value?.error) valueKind = "error";
				let text = value == null ? "" : value instanceof Date ? excelDateText(value, cell.numFmt) : value?.error ?? value?.text ?? (value?.richText ? value.richText.map((run) => run.text).join("") : String(value));
				if (typeof value === "number" && cell.numFmt && /[0#]/.test(cell.numFmt)) text = excelNumberText(value, cell.numFmt);
				cells.push({ row: rowNumber, column: columnNumber, text, style: addStyle(cell.style, typeof value === "number" || value instanceof Date ? "right" : typeof value === "boolean" || value?.error ? "center" : "left"), runs: null, valueKind });
			});
		});
		for (let i = 1; i <= columnCount; i++) { const width = sheet.getColumn(i).width; if (width) columns.push({ index: i, widthPx: Math.round(width * 7 + 5) }); }
		return { id: String(index + 1), name: sheet.name, visibility: sheet.state, showGridLines: sheet.views?.[0]?.showGridLines !== false, rowCount, columnCount, defaultRowHeightPx: (sheet.properties.defaultRowHeight || 15) * 4 / 3, defaultColumnWidthPx: Math.round((sheet.properties.defaultColWidth || 8.43) * 7 + 5), rows, columns, cells, merges };
	});
	return { ok: true, schemaVersion: 1, notices: [], result: { kind: "spreadsheet", workbook: { dateSystem: workbook.properties.date1904 ? "1904" : "1900", styles, sheets } } };
}

async function parseDocx(buffer) {
	const { default: JSZip } = await import("jszip");
	const zip = await JSZip.loadAsync(buffer);
	const documentEntry = zip.file("word/document.xml");
	if (!documentEntry) throw new Error("not a readable .docx document (word/document.xml missing)");
	const documentXml = await documentEntry.async("string");
	return { text: extractDocxText(documentXml), pages: null };
}

(async () => {
	try {
		const request = JSON.parse(process.argv[2] ?? "");
		const { absolutePath, kind, maxPages, maxChars } = request;
		if (request.mode === "workspace-preview-v1") {
			const buffer = readPreviewSnapshot(request);
			if (kind === "pdf") post(await previewPdf(buffer));
			else if (kind === "word") post(await previewWord(buffer));
			else if (kind === "spreadsheet") {
				for (const entry of previewZipEntries(buffer)) inflatePreviewEntry(buffer, entry);
				let ExcelJS;
				try { ({ default: ExcelJS } = await import("exceljs")); } catch { throw previewError("renderer_unavailable"); }
				denyPreviewNetwork();
				let workbook;
				try { workbook = await new ExcelJS.Workbook().xlsx.load(buffer); }
				catch (error) { if (error?.previewCode) throw error; throw previewError("damaged_file"); }
				post(previewSpreadsheet(workbook));
			}
			else throw previewError("renderer_unavailable");
			return;
		}
		const buffer = fs.readFileSync(absolutePath);
		if (kind === "image") {
			const image = await prepareImage(buffer, request.image);
			post({ ok: true, image });
			return;
		}
		if (kind === "pdf-raster") {
			const raster = await rasterizePdf(buffer, request.raster);
			post({ ok: true, raster });
			return;
		}
		let parsed;
		if (kind === "pdf") parsed = await parsePdf(buffer, maxPages);
		else if (kind === "docx") parsed = await parseDocx(buffer);
		else throw new Error(`unsupported parse kind: ${String(kind)}`);
		let { text } = parsed;
		let truncated = false;
		if (text.length > maxChars) {
			text = `${text.slice(0, maxChars)}\n\n[extraction truncated at the ${Math.round(maxChars / 1000)}k-character cap]`;
			truncated = true;
		}
		post({ ok: true, text, pages: parsed.pages, truncated });
	} catch (error) {
		let workspaceMode = false;
		try { workspaceMode = JSON.parse(process.argv[2] ?? "").mode === "workspace-preview-v1"; } catch {}
		if (workspaceMode) post({ ok: false, schemaVersion: 1, code: error?.previewCode ?? "preview_failed" });
		else post({ ok: false, error: error instanceof Error ? error.message : String(error) });
	}
})();
