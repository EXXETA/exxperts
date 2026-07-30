// Room-files routes smoke (files UI + files-management slices): upload with
// type gates and the collision rule, list with origins, inline-preview vs
// download serving, the unified delete (stage → undo → commit; the retired
// direct DELETE), inline rename with the collision rule, and the 💾 Save…
// export with its local-action guard, saveAs filename, and collision flow.
// Boots the real server against an isolated HOME.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authedFetch, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-room-files-"));
const tempHome = path.join(tempRoot, "home");
const tempAgentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const tempAgentRuntimeRoot = path.join(tempHome, ".exxperts", "agent");
const ROOM_ID = "room-files-smoke";
fs.mkdirSync(path.join(tempAgentsRoot, ROOM_ID), { recursive: true, mode: 0o700 });
const saveTargetDir = path.join(tempRoot, "picked-folder");
fs.mkdirSync(saveTargetDir, { recursive: true });

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 28000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;

async function waitForServer(server: ChildProcessWithoutNullStreams): Promise<void> {
	const deadline = Date.now() + 15000;
	let lastError = "server did not respond";
	while (Date.now() < deadline) {
		if (server.exitCode != null) throw new Error(`server exited before startup with code ${server.exitCode}`);
		try {
			const response = await fetch(`${baseUrl}/healthz`);
			if (response.ok) return;
			lastError = `healthz returned ${response.status}`;
		} catch (error) {
			lastError = (error as Error).message;
		}
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`server did not become ready: ${lastError}`);
}

function upload(filename: string, content: Buffer): Promise<Response> {
	return authedFetch(`${baseUrl}/api/persistent-agents/${ROOM_ID}/files`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ filename, contentBase64: content.toString("base64") }),
	});
}

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
try {
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: {
			...process.env,
			HOME: tempHome, USERPROFILE: tempHome,
			PORT: String(port),
			...SMOKE_SERVER_AUTH_ENV,
			EXXETA_HOME: repoRoot,
			EXXPERTS_CODING_AGENT_DIR: tempAgentRuntimeRoot,
			EXXETA_PERSISTENT_AGENTS_ROOT: tempAgentsRoot,
		},
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server);

	// 1. Upload a text file; a same-named second upload takes the collision name.
	const first = await upload("notes.md", Buffer.from("# alpha\nbeta\n"));
	const firstText = await first.text();
	assert(first.status === 200, `upload: expected 200, got ${first.status}: ${firstText}`);
	const firstBody = JSON.parse(firstText) as { name: string; kind: string };
	assert(firstBody.name === "notes.md" && firstBody.kind === "text", `upload result: ${JSON.stringify(firstBody)}`);
	const second = await upload("notes.md", Buffer.from("second body"));
	const secondBody = (await second.json()) as { name: string };
	assert(secondBody.name === "notes (2).md", `collision rule: expected notes (2).md, got ${secondBody.name}`);

	// 2. Tier-3 refusals name the safe path and never land.
	const ole = await upload("legacy.doc", Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]));
	assert(ole.status === 415, `OLE upload: expected 415, got ${ole.status}`);
	const oleBody = (await ole.json()) as { error: string };
	assert(oleBody.error.includes(".docx"), `OLE refusal must name the safe path, got: ${oleBody.error}`);
	const binary = await upload("blob.bin", Buffer.from([0, 1, 2, 3, 0, 5]));
	assert(binary.status === 415, `binary upload: expected 415, got ${binary.status}`);
	const empty = await upload("empty.txt", Buffer.alloc(0));
	assert(empty.status === 400, `empty upload: expected 400, got ${empty.status}`);

	// 3. Images are accepted-stored with the honest vision note.
	const png = await upload("shot.png", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fakepngdata")]));
	assert(png.status === 200, `png upload: expected 200, got ${png.status}`);
	const pngBody = (await png.json()) as { kind: string; parseNote?: string };
	assert(pngBody.kind === "image" && String(pngBody.parseNote).includes("reads it visually"), `png parse note must state the visual read, got ${JSON.stringify(pngBody)}`);

	// 4. List: user origin, sizes, extensions.
	const list = await authedFetch(`${baseUrl}/api/persistent-agents/${ROOM_ID}/files`);
	assert(list.status === 200, `list: expected 200, got ${list.status}`);
	const listBody = (await list.json()) as { files: Array<{ name: string; origin: string; extension: string }> };
	const names = listBody.files.map((file) => file.name).sort();
	assert(names.join(",") === "notes (2).md,notes.md,shot.png", `list names: ${names.join(",")}`);
	assert(listBody.files.every((file) => file.origin === "user"), "uploads must list as user origin");

	// 5. Serving: markdown inline as text/plain; png inline as image; a type
	// without an inline preview is 415 inline but downloads fine.
	const inline = await authedFetch(`${baseUrl}/api/persistent-agents/${ROOM_ID}/files/${encodeURIComponent("notes.md")}`);
	assert(inline.status === 200 && (inline.headers.get("content-type") ?? "").startsWith("text/plain"), `md inline: ${inline.status} ${inline.headers.get("content-type")}`);
	assert(inline.headers.get("content-security-policy")?.includes("sandbox"), "serving must carry the artifact CSP");
	const pngInline = await authedFetch(`${baseUrl}/api/persistent-agents/${ROOM_ID}/files/${encodeURIComponent("shot.png")}`);
	assert(pngInline.status === 200 && pngInline.headers.get("content-type") === "image/png", `png inline: ${pngInline.status}`);
	// PDF preview (vision slice): a real %PDF- file serves inline as
	// application/pdf with the plugin-permitting header set (no `sandbox` in the
	// CSP — that directive blocks the browser's PDF viewer); a text file merely
	// NAMED .pdf keeps the full sandboxed headers and has no inline preview.
	const pdf = await upload("doc.pdf", Buffer.from("%PDF-1.4\nnot really parseable\n"));
	assert(pdf.status === 200, `pdf upload: expected 200, got ${pdf.status}`);
	const pdfInline = await authedFetch(`${baseUrl}/api/persistent-agents/${ROOM_ID}/files/${encodeURIComponent("doc.pdf")}`);
	assert(pdfInline.status === 200 && pdfInline.headers.get("content-type") === "application/pdf", `pdf inline: ${pdfInline.status} ${pdfInline.headers.get("content-type")}`);
	const pdfCsp = pdfInline.headers.get("content-security-policy") ?? "";
	assert(!pdfCsp.includes("sandbox") && pdfCsp.includes("default-src 'none'"), `pdf CSP must drop sandbox but keep default-src 'none', got: ${pdfCsp}`);
	assert(pdfInline.headers.get("x-content-type-options") === "nosniff", "pdf serving keeps nosniff");
	const fakePdf = await upload("fake.pdf", Buffer.from("just text pretending"));
	assert(fakePdf.status === 200, `fake pdf upload: expected 200, got ${fakePdf.status}`);
	const fakePdfInline = await authedFetch(`${baseUrl}/api/persistent-agents/${ROOM_ID}/files/${encodeURIComponent("fake.pdf")}`);
	assert(fakePdfInline.status === 415, `fake pdf inline: expected 415 (magic sniff, not extension), got ${fakePdfInline.status}`);
	assert((fakePdfInline.headers.get("content-security-policy") ?? "").includes("sandbox"), "a non-PDF named .pdf keeps the sandboxed headers");
	// Plain-text user files (polish regression): .txt/.csv/.json preview inline
	// as text/plain under the full artifact CSP, exactly like .md — no more
	// "cannot be previewed" for the formats users upload most.
	const csv = await upload("data.csv", Buffer.from("a,b\n1,2\n"));
	assert(csv.status === 200, "csv upload must succeed");
	const csvInline = await authedFetch(`${baseUrl}/api/persistent-agents/${ROOM_ID}/files/${encodeURIComponent("data.csv")}`);
	assert(csvInline.status === 200 && (csvInline.headers.get("content-type") ?? "").startsWith("text/plain"), `csv inline: expected text/plain 200, got ${csvInline.status} ${csvInline.headers.get("content-type")}`);
	assert((csvInline.headers.get("content-security-policy") ?? "").includes("sandbox"), "plain-text serving must carry the artifact CSP");
	const txt = await upload("plain.txt", Buffer.from("plain words\n"));
	assert(txt.status === 200, "txt upload must succeed");
	const txtInline = await authedFetch(`${baseUrl}/api/persistent-agents/${ROOM_ID}/files/${encodeURIComponent("plain.txt")}`);
	assert(txtInline.status === 200 && (txtInline.headers.get("content-type") ?? "").startsWith("text/plain"), `txt inline: expected text/plain 200, got ${txtInline.status}`);
	const jsonUpload = await upload("data.json", Buffer.from('{"a":1}\n'));
	assert(jsonUpload.status === 200, "json upload must succeed");
	const jsonInline = await authedFetch(`${baseUrl}/api/persistent-agents/${ROOM_ID}/files/${encodeURIComponent("data.json")}`);
	assert(jsonInline.status === 200 && (jsonInline.headers.get("content-type") ?? "").startsWith("text/plain"), `json inline: expected text/plain (inert source, never application/json for a document view), got ${jsonInline.status} ${jsonInline.headers.get("content-type")}`);
	const csvDownload = await authedFetch(`${baseUrl}/api/persistent-agents/${ROOM_ID}/files/${encodeURIComponent("data.csv")}?download=1`);
	assert(csvDownload.status === 200 && (csvDownload.headers.get("content-disposition") ?? "").includes('filename="data.csv"'), `csv download: ${csvDownload.status}`);
	const missing = await authedFetch(`${baseUrl}/api/persistent-agents/${ROOM_ID}/files/${encodeURIComponent("nope.md")}`);
	assert(missing.status === 404, `missing file: expected 404, got ${missing.status}`);

	// 6. 💾 Save…: guarded by the local-action header; collision → 409 → rename.
	const noHeader = await authedFetch(`${baseUrl}/api/persistent-agents/${ROOM_ID}/files/${encodeURIComponent("notes.md")}/save`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ targetDir: saveTargetDir }),
	});
	assert(noHeader.status === 403, `save without local-action header: expected 403, got ${noHeader.status}`);
	const save = (name: string, body: Record<string, unknown>) => authedFetch(`${baseUrl}/api/persistent-agents/${ROOM_ID}/files/${encodeURIComponent(name)}/save`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-Exxperts-Local-Action": "save-file" },
		body: JSON.stringify(body),
	});
	const saved = await save("notes.md", { targetDir: saveTargetDir });
	const savedText = await saved.text();
	assert(saved.status === 200, `save: expected 200, got ${saved.status}: ${savedText}`);
	assert(fs.readFileSync(path.join(saveTargetDir, "notes.md"), "utf-8") === "# alpha\nbeta\n", "saved snapshot must carry the shelf bytes");
	const conflict = await save("notes.md", { targetDir: saveTargetDir });
	assert(conflict.status === 409, `save conflict: expected 409, got ${conflict.status}`);
	const keepBoth = await save("notes.md", { targetDir: saveTargetDir, rename: true });
	const keepBothBody = (await keepBoth.json()) as { savedTo: string };
	assert(keepBothBody.savedTo.endsWith("notes-2.md"), `keep both must suffix, got ${keepBothBody.savedTo}`);
	const insideState = await save("notes.md", { targetDir: path.join(tempHome, ".exxperts", "app") });
	assert(insideState.status === 400, `save into app state: expected 400, got ${insideState.status}`);
	// The shelf original is untouched by exporting snapshots.
	const stillThere = await authedFetch(`${baseUrl}/api/persistent-agents/${ROOM_ID}/files/${encodeURIComponent("notes.md")}`);
	assert(stillThere.status === 200, "the shelf original stays after saving snapshots");
	// Save… filename field: the export and its collision flow key off saveAs.
	const savedAs = await save("notes.md", { targetDir: saveTargetDir, saveAs: "renamed-snapshot.md" });
	const savedAsBody = (await savedAs.json()) as { savedTo: string };
	assert(savedAsBody.savedTo.endsWith("renamed-snapshot.md"), `saveAs must name the export, got ${savedAsBody.savedTo}`);
	const savedAsConflict = await save("notes.md", { targetDir: saveTargetDir, saveAs: "renamed-snapshot.md" });
	assert(savedAsConflict.status === 409, `saveAs collision: expected 409, got ${savedAsConflict.status}`);
	const savedAsBadName = await save("notes.md", { targetDir: saveTargetDir, saveAs: "../escape.md" });
	const savedAsBadBody = (await savedAsBadName.json()) as { savedTo?: string };
	assert(savedAsBadName.status !== 200 || !String(savedAsBadBody.savedTo ?? "").includes(".."), "a traversal saveAs must never escape the chosen folder");
	assert(!fs.existsSync(path.join(tempRoot, "escape.md")), "traversal saveAs must not land outside the chosen folder");

	// 7. Unified delete: stage returns a token → gone from the list; undo(token)
	// → back; stage + commit(token) → bytes gone; missing name 404s.
	const stage = (name: string) => authedFetch(`${baseUrl}/api/persistent-agents/${ROOM_ID}/files/${encodeURIComponent(name)}/delete`, { method: "POST" });
	const undo = (name: string, token: string) => authedFetch(`${baseUrl}/api/persistent-agents/${ROOM_ID}/files/${encodeURIComponent(name)}/delete/undo`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
	const commit = (name: string, token: string) => authedFetch(`${baseUrl}/api/persistent-agents/${ROOM_ID}/files/${encodeURIComponent(name)}/delete/commit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
	const staged = await stage("notes (2).md");
	const stagedBody = (await staged.json()) as { token: string };
	assert(staged.status === 200 && /^[0-9a-f]{8,}$/.test(stagedBody.token), `stage delete: expected 200 + token, got ${staged.status} ${JSON.stringify(stagedBody)}`);
	const listStaged = (await (await authedFetch(`${baseUrl}/api/persistent-agents/${ROOM_ID}/files`)).json()) as { files: Array<{ name: string }> };
	assert(!listStaged.files.some((file) => file.name === "notes (2).md"), "a staged delete must leave the list at once");
	const undone = await undo("notes (2).md", stagedBody.token);
	const undoneBody = (await undone.json()) as { name: string };
	assert(undone.status === 200 && undoneBody.name === "notes (2).md", `undo: expected the file back, got ${undone.status} ${JSON.stringify(undoneBody)}`);
	const listUndone = (await (await authedFetch(`${baseUrl}/api/persistent-agents/${ROOM_ID}/files`)).json()) as { files: Array<{ name: string }> };
	assert(listUndone.files.some((file) => file.name === "notes (2).md"), "an undone delete must return to the list");
	const staged2 = await stage("notes (2).md");
	const staged2Body = (await staged2.json()) as { token: string };
	assert(staged2.status === 200, "re-stage after undo");
	assert((await commit("notes (2).md", staged2Body.token)).status === 200, "commit finishes the delete");
	assert((await undo("notes (2).md", staged2Body.token)).status === 404, "undo after commit: the window has passed");
	const missingStage = await stage("never-was.md");
	assert(missingStage.status === 404, `stage on a missing file: expected 404, got ${missingStage.status}`);
	const listAfter = (await (await authedFetch(`${baseUrl}/api/persistent-agents/${ROOM_ID}/files`)).json()) as { files: Array<{ name: string }> };
	assert(!listAfter.files.some((file) => file.name === "notes (2).md"), "deleted file must leave the list");
	// The old direct DELETE route retired with the unified flow.
	const oldDelete = await authedFetch(`${baseUrl}/api/persistent-agents/${ROOM_ID}/files/${encodeURIComponent("notes.md")}`, { method: "DELETE" });
	assert(oldDelete.status === 404 || oldDelete.status === 405, `the direct DELETE route is retired, got ${oldDelete.status}`);
	assert((await authedFetch(`${baseUrl}/api/persistent-agents/${ROOM_ID}/files/${encodeURIComponent("notes.md")}`)).status === 200, "the retired route deleted nothing");

	// 8. Inline rename: fs rename under the collision rule; the manifest/list
	// shows the new name; renaming to a taken name allocates "(2)".
	const rename = (name: string, newName: string) => authedFetch(`${baseUrl}/api/persistent-agents/${ROOM_ID}/files/${encodeURIComponent(name)}/rename`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ newName }),
	});
	const renamed = await rename("notes.md", "meeting-notes.md");
	const renamedBody = (await renamed.json()) as { name: string; collided: boolean };
	assert(renamed.status === 200 && renamedBody.name === "meeting-notes.md" && renamedBody.collided === false, `rename: ${renamed.status} ${JSON.stringify(renamedBody)}`);
	const listRenamed = (await (await authedFetch(`${baseUrl}/api/persistent-agents/${ROOM_ID}/files`)).json()) as { files: Array<{ name: string }> };
	assert(listRenamed.files.some((file) => file.name === "meeting-notes.md") && !listRenamed.files.some((file) => file.name === "notes.md"), "the list shows the renamed file only");
	const renameCollide = await rename("data.csv", "meeting-notes.md");
	const renameCollideBody = (await renameCollide.json()) as { name: string; collided: boolean };
	assert(renameCollideBody.name === "meeting-notes (2).md" && renameCollideBody.collided === true, `rename collision must allocate (2), got ${JSON.stringify(renameCollideBody)}`);
	const renameMissing = await rename("never-was.md", "x.md");
	assert(renameMissing.status === 404, `rename on a missing file: expected 404, got ${renameMissing.status}`);
	const renameTraversal = await rename("meeting-notes.md", "../../escape.md");
	const renameTraversalBody = (await renameTraversal.json()) as { name?: string };
	assert(renameTraversal.status === 200 && renameTraversalBody.name === "escape.md", `a traversal newName is sanitised to its basename, got ${renameTraversal.status} ${JSON.stringify(renameTraversalBody)}`);
	assert(!fs.existsSync(path.join(tempAgentsRoot, "escape.md")), "a traversal rename must never leave the shelf folder");

	// 9. Unknown rooms 404 without creating anything.
	const alien = await authedFetch(`${baseUrl}/api/persistent-agents/no-such-room/files`);
	assert(alien.status === 404, `unknown room: expected 404, got ${alien.status}`);

	console.log("room-files-routes smoke: PASS");
} catch (error) {
	console.error("room-files-routes smoke: FAIL —", (error as Error).message);
	console.error(serverOutput.slice(-20).join(""));
	console.error(`  temp root kept for inspection: ${tempRoot}`);
	process.exitCode = 1;
} finally {
	if (server) await stopSmokeServer(server);
	if (process.exitCode !== 1) fs.rmSync(tempRoot, { recursive: true, force: true });
}
