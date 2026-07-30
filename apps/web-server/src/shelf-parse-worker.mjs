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
		post({ ok: false, error: error instanceof Error ? error.message : String(error) });
	}
})();
