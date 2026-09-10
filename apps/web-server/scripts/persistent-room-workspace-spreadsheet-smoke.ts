import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as XLSX from "xlsx";

const {
	createPersistentRoomCapabilityPolicy,
} = await import("../src/persistent-room-workspace-policy.js");
const {
	createPersistentRoomWorkspaceTools,
	PersistentRoomWorkspaceToolError,
} = await import("../src/persistent-room-workspace-tools.js");
const { SHELF_READ_MAX_FILE_BYTES } = await import("../src/persistent-room-shelf-reading.js");

const agentId = "workspace-spreadsheet-smoke-room";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function toolOutput(result: any): string {
	return (result?.content ?? []).filter((part: any) => part?.type === "text").map((part: any) => String(part.text ?? "")).join("\n");
}

function assertNoAbsoluteLeak(value: unknown, tmp: string, label: string): void {
	const serialized = typeof value === "string" ? value : JSON.stringify(value);
	assert(!serialized.includes(tmp), `${label}: must not leak temp absolute workspace path`);
}

async function executeResult(tools: Map<string, any>, name: string, params: Record<string, unknown>, tmp: string): Promise<any> {
	const tool = tools.get(name);
	assert(tool, `tool ${name} should be registered`);
	const result = await tool.execute(`smoke-${name}`, params, undefined, undefined, {} as any);
	assertNoAbsoluteLeak(result, tmp, `${name} result`);
	return result;
}

async function execute(tools: Map<string, any>, name: string, params: Record<string, unknown>, tmp: string): Promise<string> {
	const result = await executeResult(tools, name, params, tmp);
	const output = toolOutput(result);
	assertNoAbsoluteLeak(output, tmp, `${name} output`);
	return output;
}

async function expectReject(fn: () => unknown | Promise<unknown>, tmp: string, label: string): Promise<void> {
	try {
		await fn();
	} catch (error) {
		assert(error instanceof PersistentRoomWorkspaceToolError, `${label}: expected PersistentRoomWorkspaceToolError`);
		assertNoAbsoluteLeak(error.message, tmp, `${label} error`);
		assert(!/\/var\/|\/tmp\/|Users\//.test(error.message), `${label}: error should stay generic`);
		return;
	}
	throw new Error(`${label}: expected rejection`);
}

function writeWorkbook(file: string): void {
	const wb = XLSX.utils.book_new();
	const sales = XLSX.utils.aoa_to_sheet([
		["Name", "Revenue", "Double revenue", "Notes"],
		["Alice", 100, null, "North"],
		["Bob", 250, null, "South"],
		["Carla", 325, null, "West"],
	]);
	sales.C2 = { t: "n", f: "B2*2", v: 200, w: "200" } as any;
	sales.C3 = { t: "n", f: "B3*2", v: 500, w: "500" } as any;
	XLSX.utils.book_append_sheet(wb, sales, "Sales");

	const rows: any[][] = [["Index", "Value", "Extra"]];
	for (let i = 1; i <= 12; i += 1) rows.push([i, `value-${i}`, `extra-${i}`]);
	XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Large");

	const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
	fs.writeFileSync(file, buffer);
}

// A minimal but valid PDF with one page per entry of `pageTexts` — the same
// skeleton the shelf smoke builds, generalized to several pages so document
// paging has real page-2 content to land on.
function pdfWithPages(pageTexts: string[]): Buffer {
	const kids = pageTexts.map((_, index) => `${3 + index * 2} 0 R`).join(" ");
	const objects: string[] = [
		"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
		`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pageTexts.length} >>\nendobj\n`,
	];
	for (let index = 0; index < pageTexts.length; index += 1) {
		const pageId = 3 + index * 2;
		const contentId = pageId + 1;
		const fontId = 3 + pageTexts.length * 2;
		objects.push(`${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>\nendobj\n`);
		const stream = `BT /F1 12 Tf 72 720 Td (${pageTexts[index]}) Tj ET`;
		objects.push(`${contentId} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);
	}
	objects.push(`${3 + pageTexts.length * 2} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`);
	let body = "%PDF-1.4\n";
	const offsets: number[] = [];
	for (const object of objects) {
		offsets.push(Buffer.byteLength(body, "latin1"));
		body += object;
	}
	const xrefOffset = Buffer.byteLength(body, "latin1");
	let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
	body += `${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
	return Buffer.from(body, "latin1");
}

// Same skeleton with an EMPTY content stream: a valid PDF whose extraction
// yields only the page marker — the scanned-document shape.
function blankPdf(): Buffer {
	const objects = [
		"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
		"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
		"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n",
		"4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n",
	];
	let body = "%PDF-1.4\n";
	const offsets: number[] = [];
	for (const object of objects) {
		offsets.push(Buffer.byteLength(body, "latin1"));
		body += object;
	}
	const xrefOffset = Buffer.byteLength(body, "latin1");
	let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
	body += `${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
	return Buffer.from(body, "latin1");
}

async function minimalDocx(): Promise<Buffer> {
	const { default: JSZip } = await import("jszip");
	const zip = new JSZip();
	zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
	zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Contract clause: renewal is automatic &amp; annual.</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph here.</w:t></w:r></w:p></w:body></w:document>`);
	return zip.generateAsync({ type: "nodebuffer" });
}

const ONE_PIXEL_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-workspace-spreadsheet-"));
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;

try {
	const repoRoot = path.join(tmp, "repo");
	const homeRoot = path.join(tmp, "home");
	const exxetaStateRoot = path.join(homeRoot, ".exxperts", "app");
	const persistentAgentsRoot = path.join(exxetaStateRoot, "personalized-agents");
	const workspaceRoot = path.join(tmp, "workspace");
	const outsideRoot = path.join(tmp, "outside");
	for (const dir of [repoRoot, exxetaStateRoot, persistentAgentsRoot, workspaceRoot, outsideRoot]) fs.mkdirSync(dir, { recursive: true });

	const workbookPath = path.join(workspaceRoot, "sales.xlsx");
	writeWorkbook(workbookPath);
	fs.writeFileSync(path.join(workspaceRoot, "not-a-workbook.txt"), "Name,Revenue\nAlice,100\n");
	fs.writeFileSync(path.join(workspaceRoot, "pixel.png"), Buffer.from(ONE_PIXEL_PNG_BASE64, "base64"));
	fs.mkdirSync(path.join(workspaceRoot, "node_modules"), { recursive: true });
	writeWorkbook(path.join(workspaceRoot, "node_modules", "vendored.xlsx"));
	const outsideWorkbookPath = path.join(outsideRoot, "outside.xlsx");
	writeWorkbook(outsideWorkbookPath);
	const homeWorkbookPath = path.join(homeRoot, "home.xlsx");
	writeWorkbook(homeWorkbookPath);
	process.env.HOME = homeRoot;
	process.env.USERPROFILE = homeRoot;
	try {
		fs.symlinkSync(outsideWorkbookPath, path.join(workspaceRoot, "outside-link.xlsx"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EPERM" && (error as NodeJS.ErrnoException).code !== "EACCES") throw error;
	}

	const policy = createPersistentRoomCapabilityPolicy({
		agentId,
		conversationId: "c_workspace_spreadsheet_smoke",
		repoRoot,
		persistentAgentsRoot,
		exxetaStateRoot,
		root: workspaceRoot,
		workspaceAccessMode: "bounded",
		source: "manual",
		now: new Date("2026-07-01T00:00:00.000Z"),
	});
	const tools = new Map(createPersistentRoomWorkspaceTools(policy).map((tool: any) => [tool.name, tool]));
	assert(tools.has("read"), "read should be registered for bounded workspace policy");
	assert(!tools.has("read_spreadsheet") && !tools.has("write_markdown_file"), "retired workspace tools must not register");

	const firstSheet = await execute(tools, "read", { path: "sales.xlsx" }, tmp);
	assert(firstSheet.includes("# Spreadsheet preview: sales.xlsx"), "output should identify workbook basename only");
	assert(firstSheet.includes("Sheets (2):"), "output should list workbook sheets");
	assert(firstSheet.includes("1. Sales"), "output should list Sales sheet");
	assert(firstSheet.includes("2. Large"), "output should list Large sheet");
	assert(firstSheet.includes("Selected sheet: Sales"), "default should preview first sheet");
	assert(firstSheet.includes("| Name | Revenue | Double revenue | Notes |"), "output should include readable table header");
	assert(firstSheet.includes("| Alice | 100 | 200 | North |"), "output should include cached/display formula value without raw ZIP/XML");
	assert(firstSheet.includes("Warning: formula cells were detected"), "output should warn when formulas are present");
	assert(!firstSheet.includes("PK\u0003\u0004") && !firstSheet.includes("xl/workbook.xml"), "output should not expose raw XLSX ZIP/XML bytes");

	const selectedByName = await execute(tools, "read", { path: "sales.xlsx", sheet: "Large", limit: 3, columns: 2 }, tmp);
	assert(selectedByName.includes("Selected sheet: Large"), "sheet name selection should work");
	assert(selectedByName.includes("Preview: 3 of 13 rows, 2 of 3 columns."), "preview dimensions should respect row/column limits");
	assert(selectedByName.includes("Truncated preview: row cap 3, column cap 2."), "output should explain row/column truncation");
	assert(selectedByName.includes("| Index | Value |"), "bounded preview should include selected sheet table");
	assert(!selectedByName.includes("Extra"), "column cap should omit later columns from preview table");

	const selectedByIndex = await execute(tools, "read", { path: "sales.xlsx", sheet: 2, limit: 2, columns: 2 }, tmp);
	assert(selectedByIndex.includes("Selected sheet: Large"), "1-based numeric sheet selection should work");

	const offsetPreview = await execute(tools, "read", { path: "sales.xlsx", sheet: "Sales", offset: 2, limit: 2 }, tmp);
	assert(offsetPreview.includes("Showing rows 2-3 of 4. Use offset=4 to continue."), "row offset should page through the sheet");
	assert(offsetPreview.includes("| Alice |"), "offset preview should start at the requested row");

	const detailResult = await executeResult(tools, "read", { path: "sales.xlsx", sheet: "Sales", limit: 2, columns: 2 }, tmp);
	assert(detailResult.details?.path === "sales.xlsx", "details should include workspace-relative path only");
	assert(detailResult.details?.workbook === "sales.xlsx", "details should include workbook basename");
	assert(detailResult.details?.sheet === "Sales", "details should include selected sheet name");
	assert(detailResult.details?.previewRows === 2 && detailResult.details?.previewColumns === 2, "details should include bounded preview dimensions");

	const textFile = await execute(tools, "read", { path: "not-a-workbook.txt" }, tmp);
	assert(textFile.includes("Name,Revenue"), "plain text files should still read as text");

	// ---- pdf/docx documents through the shared shelf extraction --------------
	fs.writeFileSync(path.join(workspaceRoot, "report.pdf"), pdfWithPages(["Quarterly payment terms are 60 days", "Page two carries the renewal clause"]));
	fs.writeFileSync(path.join(workspaceRoot, "renamed-report.txt"), pdfWithPages(["Content sniffing beats the extension"]));
	fs.writeFileSync(path.join(workspaceRoot, "contract.docx"), await minimalDocx());
	fs.writeFileSync(path.join(workspaceRoot, "scanned.pdf"), blankPdf());
	fs.writeFileSync(path.join(workspaceRoot, "huge.pdf"), Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(SHELF_READ_MAX_FILE_BYTES)]));
	fs.writeFileSync(path.join(workspaceRoot, "node_modules", "vendored.pdf"), pdfWithPages(["deny-listed document"]));

	const pdfResult = await executeResult(tools, "read", { path: "report.pdf" }, tmp);
	const pdfOutput = toolOutput(pdfResult);
	assert(pdfOutput.includes("Quarterly payment terms are 60 days"), "pdf read should extract page-1 text");
	assert(pdfOutput.includes("Page two carries the renewal clause"), "pdf read should extract page-2 text");
	assert(pdfOutput.includes("[page 1]"), "pdf read should carry page markers");
	assert(pdfOutput.includes("PDF, 2 pages;"), "pdf read should state the page count in the notice");
	assert(pdfResult.details?.pages === 2, "pdf details should carry the page count");
	assert(pdfResult.details?.path === "report.pdf", "pdf details should stay workspace-relative");

	const pageTwoLine = pdfOutput.split("\n").findIndex((line) => line.includes("Page two carries the renewal clause"));
	assert(pageTwoLine >= 0, "page-2 content should be locatable for the paging probe");
	const pagedPdf = await execute(tools, "read", { path: "report.pdf", offset: pageTwoLine + 1 }, tmp);
	assert(pagedPdf.includes("Page two carries the renewal clause"), "offset into page-2 content should return it");
	assert(!pagedPdf.includes("Quarterly payment terms are 60 days"), "offset past page 1 should not repeat page-1 text");

	const limitedPdf = await execute(tools, "read", { path: "report.pdf", offset: 1, limit: 1 }, tmp);
	assert(limitedPdf.includes("Use offset=2 to continue."), "limited pdf read should name the next offset");

	const sniffedPdf = await execute(tools, "read", { path: "renamed-report.txt" }, tmp);
	assert(sniffedPdf.includes("Content sniffing beats the extension"), "a pdf named .txt should still extract as a document");
	assert(sniffedPdf.includes("[page 1]"), "a pdf named .txt should carry page markers, not raw bytes");

	const docxOutput = await execute(tools, "read", { path: "contract.docx" }, tmp);
	assert(docxOutput.includes("renewal is automatic & annual"), "docx read should decode entities");
	assert(docxOutput.includes("Word document; extracted text."), "docx read should identify itself in the notice");

	const scannedOutput = await execute(tools, "read", { path: "scanned.pdf" }, tmp);
	assert(scannedOutput.includes("no extractable text"), "scanned pdf should get the honest no-text note");
	assert(scannedOutput.includes("Files"), "scanned pdf note should point at the room's Files");

	try {
		await executeResult(tools, "read", { path: "huge.pdf" }, tmp);
		throw new Error("oversized pdf should be rejected");
	} catch (error) {
		assert(error instanceof PersistentRoomWorkspaceToolError && error.code === "file_too_large", "oversized pdf should reject as file_too_large");
	}
	await expectReject(() => execute(tools, "read", { path: "node_modules/vendored.pdf" }, tmp), tmp, "deny-listed pdf path");

	const imageResult = await executeResult(tools, "read", { path: "pixel.png" }, tmp);
	const imageBlocks = (imageResult?.content ?? []).filter((part: any) => part?.type === "image");
	assert(imageBlocks.length === 1, "image read should return an image content block");
	assert(String(imageBlocks[0].mimeType ?? "").startsWith("image/"), "image block should carry an image mime type");
	assert(typeof imageBlocks[0].data === "string" && imageBlocks[0].data.length > 0, "image block should carry base64 data");
	assert(toolOutput(imageResult).includes("Read image file [image/"), "image read should include a text note");
	assert(imageResult.details?.path === "pixel.png", "image details should include workspace-relative path only");

	await expectReject(() => execute(tools, "read", { path: path.join(workspaceRoot, "sales.xlsx") }, tmp), tmp, "absolute spreadsheet path");
	await expectReject(() => execute(tools, "read", { path: "~/home.xlsx" }, tmp), tmp, "home spreadsheet path");
	await expectReject(() => execute(tools, "read", { path: "../outside/outside.xlsx" }, tmp), tmp, "parent traversal spreadsheet path");
	await expectReject(() => execute(tools, "read", { path: "node_modules/vendored.xlsx" }, tmp), tmp, "deny-listed spreadsheet path");
	await expectReject(() => execute(tools, "read", { path: "sales.xlsx", sheet: 99 }, tmp), tmp, "missing numeric sheet");
	await expectReject(() => execute(tools, "read", { path: "sales.xlsx", sheet: "Missing" }, tmp), tmp, "missing named sheet");
	if (fs.existsSync(path.join(workspaceRoot, "outside-link.xlsx"))) {
		await expectReject(() => execute(tools, "read", { path: "outside-link.xlsx" }, tmp), tmp, "symlink file escape");
	}

	console.log("persistent-room workspace spreadsheet smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	process.exitCode = 1;
} finally {
	process.env.HOME = previousHome;
	if (previousUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = previousUserProfile;
	fs.rmSync(tmp, { recursive: true, force: true });
}
