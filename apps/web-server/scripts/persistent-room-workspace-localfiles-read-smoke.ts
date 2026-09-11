// Full-access (localFiles) document read smoke: the read wrapper that
// overrides the runtime's native read at the room session bind. pdf/docx route
// through the shared shelf extraction + line windowing; EVERYTHING else must
// delegate verbatim — text, image, and .xlsx reads are asserted byte-identical
// to the native tool. Offline, deterministic, isolated temp workspace.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as XLSX from "xlsx";
import { createReadToolDefinition } from "@exxeta/exxperts-runtime";

const {
	createPersistentRoomCapabilityPolicy,
} = await import("../src/persistent-room-workspace-policy.js");
const {
	createPersistentRoomWorkspaceTools,
	createPersistentRoomLocalFilesReadTool,
} = await import("../src/persistent-room-workspace-tools.js");
const { SHELF_READ_MAX_FILE_BYTES } = await import("../src/persistent-room-shelf-reading.js");

const agentId = "workspace-localfiles-read-smoke-room";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function toolOutput(result: any): string {
	return (result?.content ?? []).filter((part: any) => part?.type === "text").map((part: any) => String(part.text ?? "")).join("\n");
}

// Same minimal-PDF skeleton as the workspace spreadsheet smoke, one page per entry.
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
	zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Full access clause: renewal is automatic.</w:t></w:r></w:p></w:body></w:document>`);
	return zip.generateAsync({ type: "nodebuffer" });
}

function writeWorkbook(file: string): void {
	const wb = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
		["Name", "Revenue"],
		["Alice", 100],
		["Bob", 250],
	]), "Sales");
	fs.writeFileSync(file, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}

const ONE_PIXEL_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-localfiles-read-"));

try {
	const repoRoot = path.join(tmp, "repo");
	const exxetaStateRoot = path.join(tmp, "home", ".exxperts", "app");
	const persistentAgentsRoot = path.join(exxetaStateRoot, "personalized-agents");
	const workspaceRoot = path.join(tmp, "workspace");
	for (const dir of [repoRoot, exxetaStateRoot, persistentAgentsRoot, workspaceRoot]) fs.mkdirSync(dir, { recursive: true });

	fs.writeFileSync(path.join(workspaceRoot, "report.pdf"), pdfWithPages(["Quarterly payment terms are 60 days", "Page two carries the renewal clause"]));
	fs.writeFileSync(path.join(workspaceRoot, "contract.docx"), await minimalDocx());
	fs.writeFileSync(path.join(workspaceRoot, "scanned.pdf"), blankPdf());
	fs.writeFileSync(path.join(workspaceRoot, "huge.pdf"), Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(SHELF_READ_MAX_FILE_BYTES)]));
	fs.writeFileSync(path.join(workspaceRoot, "notes.txt"), "line one\nline two\nline three\n");
	fs.writeFileSync(path.join(workspaceRoot, "pixel.png"), Buffer.from(ONE_PIXEL_PNG_BASE64, "base64"));
	writeWorkbook(path.join(workspaceRoot, "sales.xlsx"));

	const makePolicy = (toolSelection?: { kind: "custom"; allowedToolNames: string[] }) => createPersistentRoomCapabilityPolicy({
		agentId,
		conversationId: "c_workspace_localfiles_read_smoke",
		repoRoot,
		persistentAgentsRoot,
		exxetaStateRoot,
		root: workspaceRoot,
		workspaceAccessMode: "localFiles",
		source: "manual",
		now: new Date("2026-07-01T00:00:00.000Z"),
		...(toolSelection ? { toolSelection } : {}),
	});

	const policy = makePolicy();
	assert(createPersistentRoomWorkspaceTools(policy).length === 0, "localFiles without a session cwd should register no curated tools (back-compat)");
	const noReadSelection = makePolicy({ kind: "custom", allowedToolNames: ["ls", "grep"] });
	assert(createPersistentRoomWorkspaceTools(noReadSelection, { localFilesReadCwd: workspaceRoot }).length === 0, "a Full access selection without read should get no read wrapper");

	const tools = createPersistentRoomWorkspaceTools(policy, { localFilesReadCwd: workspaceRoot });
	assert(tools.length === 1 && tools[0]!.name === "read", "localFiles with read selected should register exactly the read wrapper");
	const wrapper: any = tools[0];
	const native = createReadToolDefinition(workspaceRoot);
	assert(wrapper.parameters === native.parameters, "the wrapper must keep the native read schema, nothing more");
	assert(String(wrapper.description).startsWith(native.description), "the wrapper description must extend the native one, not replace it");
	assert(typeof wrapper.renderCall === "function" && typeof wrapper.renderResult === "function", "the wrapper must keep the native renderers");

	// ---- pdf/docx through the shared extraction path -------------------------
	const pdfResult = await wrapper.execute("smoke-pdf", { path: "report.pdf" }, undefined, undefined, {} as any);
	const pdfOutput = toolOutput(pdfResult);
	assert(pdfOutput.includes("Quarterly payment terms are 60 days"), "wrapper pdf read should extract page-1 text");
	assert(pdfOutput.includes("PDF, 2 pages;"), "wrapper pdf read should state the page count");
	assert(pdfResult.details?.pages === 2, "wrapper pdf details should carry the page count");

	const pageTwoLine = pdfOutput.split("\n").findIndex((line) => line.includes("Page two carries the renewal clause"));
	assert(pageTwoLine >= 0, "page-2 content should be locatable for the paging probe");
	const pagedOutput = toolOutput(await wrapper.execute("smoke-pdf-paged", { path: "report.pdf", offset: pageTwoLine + 1 }, undefined, undefined, {} as any));
	assert(pagedOutput.includes("Page two carries the renewal clause"), "wrapper offset into page-2 content should return it");
	assert(!pagedOutput.includes("Quarterly payment terms are 60 days"), "wrapper offset past page 1 should not repeat page-1 text");

	const absoluteOutput = toolOutput(await wrapper.execute("smoke-pdf-absolute", { path: path.join(workspaceRoot, "report.pdf") }, undefined, undefined, {} as any));
	assert(absoluteOutput.includes("Quarterly payment terms are 60 days"), "full access reads absolute paths; the wrapper must too");

	const docxOutput = toolOutput(await wrapper.execute("smoke-docx", { path: "contract.docx" }, undefined, undefined, {} as any));
	assert(docxOutput.includes("renewal is automatic"), "wrapper docx read should extract text");
	assert(docxOutput.includes("Word document; extracted text."), "wrapper docx read should identify itself");

	const scannedOutput = toolOutput(await wrapper.execute("smoke-scanned", { path: "scanned.pdf" }, undefined, undefined, {} as any));
	assert(scannedOutput.includes("no extractable text"), "wrapper scanned pdf should get the honest no-text note");

	try {
		await wrapper.execute("smoke-huge", { path: "huge.pdf" }, undefined, undefined, {} as any);
		throw new Error("oversized pdf should be rejected");
	} catch (error) {
		assert(error instanceof Error && /too large/i.test(error.message), `oversized pdf should reject honestly (got: ${(error as Error).message})`);
	}

	// ---- everything else delegates byte-identically to the native tool -------
	for (const [label, params] of [
		["text", { path: "notes.txt" }],
		["text windowed", { path: "notes.txt", offset: 2, limit: 1 }],
		["image", { path: "pixel.png" }],
		["xlsx", { path: "sales.xlsx", sheet: "Sales", limit: 2, columns: 2 }],
		["missing file", { path: "no-such-file.txt" }],
	] as Array<[string, Record<string, unknown>]>) {
		let wrapperOutcome: unknown;
		let nativeOutcome: unknown;
		try {
			wrapperOutcome = await wrapper.execute("smoke-delegate", params, undefined, undefined, {} as any);
		} catch (error) {
			wrapperOutcome = { error: (error as Error).message };
		}
		try {
			nativeOutcome = await native.execute("smoke-delegate", params as any, undefined, undefined, {} as any);
		} catch (error) {
			nativeOutcome = { error: (error as Error).message };
		}
		assert(JSON.stringify(wrapperOutcome) === JSON.stringify(nativeOutcome), `${label} read must route identically to the native tool`);
	}

	// Direct factory export stays usable on its own (the background bind uses
	// the same construction through createPersistentRoomWorkspaceTools).
	const direct = createPersistentRoomLocalFilesReadTool(workspaceRoot);
	assert(direct.name === "read", "direct wrapper factory should produce the read override");

	console.log("persistent-room workspace localfiles read smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	process.exitCode = 1;
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}
