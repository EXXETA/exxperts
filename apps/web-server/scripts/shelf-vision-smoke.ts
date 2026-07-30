// Smoke for the vision slice: read_file hands images to the provider's vision
// (pass-through under the caps, worker-downscaled JPEG above them), a scanned
// PDF (blank extraction) is read as rendered page images with page-window
// paging, and search_file skips both with the honest visual-read note. All
// decode/render work runs in the isolated parse worker.
//
// Run: npm run smoke:shelf-vision   (or: node scripts/run-smokes.mjs shelf-vision)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-shelf-vision-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const { persistentRoomShelfDirPath } = await import("../src/persistent-room-shelf.js");
const { NOTE_IMAGE_IS_VISUAL, NOTE_PDF_NO_TEXT_LAYER, SHELF_RASTER_PAGES_PER_READ, readShelfImageForVision, rasterizeShelfPdfForVision } = await import("../src/persistent-room-shelf-reading.js");
const { createPersistentRoomShelfTools } = await import("../src/persistent-room-shelf-tools.js");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// ── Fixtures ────────────────────────────────────────────────────────────────

async function makePng(width: number, height: number): Promise<Buffer> {
	const canvasModule = await import("@napi-rs/canvas");
	const canvas = canvasModule.createCanvas(width, height);
	const context = canvas.getContext("2d");
	context.fillStyle = "#3366cc";
	context.fillRect(0, 0, width, height);
	context.fillStyle = "#ffffff";
	context.fillRect(Math.floor(width / 4), Math.floor(height / 4), Math.floor(width / 2), Math.floor(height / 2));
	return canvas.toBuffer("image/png");
}

/**
 * A minimal REAL pdf with correct xref offsets: `pageCount` pages whose only
 * content is a filled rectangle — extraction finds no text, so this is exactly
 * the scanned-document shape the raster path exists for.
 */
function makeScannedPdf(pageCount: number): Buffer {
	const objects: string[] = [];
	const kids = Array.from({ length: pageCount }, (_v, index) => `${3 + index * 2} 0 R`).join(" ");
	objects.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
	objects.push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>\nendobj\n`);
	for (let index = 0; index < pageCount; index += 1) {
		const pageObj = 3 + index * 2;
		const contentObj = pageObj + 1;
		const stream = `0.2 0.4 0.8 rg 20 20 160 60 re f`;
		objects.push(`${pageObj} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents ${contentObj} 0 R >>\nendobj\n`);
		objects.push(`${contentObj} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);
	}
	const header = "%PDF-1.4\n";
	let body = "";
	const offsets: number[] = [];
	for (const object of objects) {
		offsets.push(header.length + body.length);
		body += object;
	}
	const xrefAt = header.length + body.length;
	let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
	const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
	return Buffer.from(header + body + xref + trailer, "latin1");
}

type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
const contentOf = (result: unknown): ToolContent[] => (result as { content: ToolContent[] }).content;
const textOf = (result: unknown): string => contentOf(result).filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n");
const imagesOf = (result: unknown): Array<{ data: string; mimeType: string }> => contentOf(result).filter((c): c is { type: "image"; data: string; mimeType: string } => c.type === "image");

try {
	const roomId = "vision-room";
	const shelfDir = persistentRoomShelfDirPath(roomId);
	fs.mkdirSync(shelfDir, { recursive: true, mode: 0o700 });

	const smallPng = await makePng(320, 200);
	fs.writeFileSync(path.join(shelfDir, "small.png"), smallPng);
	const bigPng = await makePng(2400, 900); // over the 1568px dimension cap
	fs.writeFileSync(path.join(shelfDir, "big.png"), bigPng);
	fs.writeFileSync(path.join(shelfDir, "scan.pdf"), makeScannedPdf(SHELF_RASTER_PAGES_PER_READ + 2));
	fs.writeFileSync(path.join(shelfDir, "notes.md"), "alpha\nsearchable TERM here\n");

	// ---- reading layer: pass-through vs downscale ---------------------------
	const small = await readShelfImageForVision(roomId, "small.png");
	assert(small.mimeType === "image/png" && !small.downscaled, "an in-cap image passes through");
	assert(small.dataBase64 === smallPng.toString("base64"), "pass-through carries the ORIGINAL bytes");
	assert(small.width === 320 && small.height === 200, "decoded dimensions are reported");
	const big = await readShelfImageForVision(roomId, "big.png");
	assert(big.downscaled && big.mimeType === "image/jpeg", "an over-cap image is downscaled to jpeg");
	assert(big.width === 1568 && big.height === Math.round(900 * (1568 / 2400)), `downscale lands on the dimension cap, got ${big.width}x${big.height}`);

	// ---- hardening (adversarial pass): decode budgets before native decode --
	// A dimension bomb is a tiny file whose HEADER declares a huge picture: the
	// budget check reads the header in pure JS and refuses before any native
	// decoder allocates (native allocation is outside the worker's JS heap cap,
	// so the memory limit alone would not contain it).
	const pngBomb = Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		Buffer.from([0, 0, 0, 0x0d]), Buffer.from("IHDR"),
		(() => { const b = Buffer.alloc(13); b.writeUInt32BE(50000, 0); b.writeUInt32BE(50000, 4); b[8] = 8; b[9] = 6; return b; })(),
		Buffer.alloc(8),
	]);
	fs.writeFileSync(path.join(shelfDir, "bomb.png"), pngBomb);
	let bombRefused = "";
	try { await readShelfImageForVision(roomId, "bomb.png"); } catch (error) { bombRefused = (error as Error).message; }
	assert(/megapixel budget/.test(bombRefused), `a dimension bomb must refuse before decoding, got: ${bombRefused}`);

	// Bytes beyond what the pixels justify are not picture: a padded image is
	// re-encoded rather than passed through, so padding cannot ride into the
	// room's context verbatim.
	fs.writeFileSync(path.join(shelfDir, "padded.png"), Buffer.concat([smallPng, Buffer.alloc(1024 * 1024, 0x41)]));
	const padded = await readShelfImageForVision(roomId, "padded.png");
	assert(padded.downscaled && padded.dataBase64.length < 100_000, `a padded image must be re-encoded, not passed through (got ${padded.dataBase64.length} b64 chars for a 1 MB padded file)`);
	assert(padded.width === 320 && padded.height === 200, "re-encoding a padded image keeps its real dimensions");

	// ---- reading layer: scanned-pdf raster window ---------------------------
	const raster = await rasterizeShelfPdfForVision(roomId, "scan.pdf", 1);
	assert(raster.totalPages === SHELF_RASTER_PAGES_PER_READ + 2, `total pages survive, got ${raster.totalPages}`);
	assert(raster.pages.length === SHELF_RASTER_PAGES_PER_READ && raster.firstPage === 1 && raster.lastPage === SHELF_RASTER_PAGES_PER_READ, "the first window is page-capped");
	assert(raster.pages.every((page) => page.mimeType === "image/jpeg" && page.dataBase64.length > 100), "every page renders to a real jpeg");
	const tail = await rasterizeShelfPdfForVision(roomId, "scan.pdf", SHELF_RASTER_PAGES_PER_READ + 1);
	assert(tail.pages.length === 2 && tail.firstPage === SHELF_RASTER_PAGES_PER_READ + 1, "the continuation window picks up where the first ended");
	const beyond = await rasterizeShelfPdfForVision(roomId, "scan.pdf", 999);
	assert(beyond.pages.length >= 1 && beyond.lastPage === raster.totalPages, "an offset past the end clamps to the last page");

	// ---- tools: read_file image + scanned-pdf envelopes ---------------------
	const tools = createPersistentRoomShelfTools({ roomId });
	const [readFileTool, searchFileTool] = tools;
	const imageRead = await readFileTool!.execute("v1", { name: "small.png" }, undefined as any, undefined as any, undefined as any);
	assert(textOf(imageRead).startsWith("[FILE: small.png]"), "image read opens the envelope");
	assert(/shown to you visually/.test(textOf(imageRead)), "image read says it is a visual read");
	assert(imagesOf(imageRead).length === 1 && imagesOf(imageRead)[0].mimeType === "image/png", "image read carries exactly one image block");

	const scanRead = await readFileTool!.execute("v2", { name: "scan.pdf" }, undefined as any, undefined as any, undefined as any);
	assert(/Scanned document \(no text layer\)/.test(textOf(scanRead)), "scanned read names the no-text-layer condition");
	assert(imagesOf(scanRead).length === SHELF_RASTER_PAGES_PER_READ, "scanned read carries one image per rendered page");
	assert(new RegExp(`use offset=${SHELF_RASTER_PAGES_PER_READ + 1} to continue`).test(textOf(scanRead)), "the continuation notice names the next page offset");
	const scanTail = await readFileTool!.execute("v3", { name: "scan.pdf", offset: SHELF_RASTER_PAGES_PER_READ + 1 }, undefined as any, undefined as any, undefined as any);
	assert(imagesOf(scanTail).length === 2 && !/use offset=/.test(textOf(scanTail)), "the final window carries the tail pages and no continuation notice");

	// ---- tools: search_file skips visual files honestly ---------------------
	const search = await searchFileTool!.execute("v4", { query: "term" }, undefined as any, undefined as any, undefined as any);
	const searchText = textOf(search);
	assert(/notes\.md/.test(searchText), "text files still match");
	assert(searchText.includes(NOTE_IMAGE_IS_VISUAL.slice(0, 30)) || /small\.png/.test(searchText), "images are listed as skipped, not silently dropped");
	assert(searchText.includes(NOTE_PDF_NO_TEXT_LAYER.slice(0, 30)) || /scan\.pdf/.test(searchText), "scanned pdfs are listed as skipped, not silently dropped");

	fs.rmSync(tempHome, { recursive: true, force: true });
	console.log("shelf vision smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp HOME preserved for inspection: ${tempHome}`);
	process.exitCode = 1;
}
