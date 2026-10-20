// Room-files routes smoke (files UI + files-management slices): upload with
// type gates and the collision rule, list with origins, inline-preview vs
// download serving, the unified delete (stage → undo → commit; the retired
// direct DELETE), inline rename with the collision rule, and the 💾 Save…
// export with its local-action guard, saveAs filename, and collision flow.
// Boots the real server against an isolated HOME.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { authedFetch, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, freePort } from "./smoke-server-process.js";

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
// While short-space exists, the server's disk reports no free space, so a
// Replace must take the rename path. While failing-writes exists, every write
// through a descriptor of bytes that contain its text fails. While unsyncable
// exists, fsync answers ENOTSUP, as on a disk that cannot sync.
const shortSpaceFlag = path.join(tempRoot, "short-space");
const failingWritesFlag = path.join(tempRoot, "failing-writes");
const unsyncableFlag = path.join(tempRoot, "unsyncable");
const diskFakesPreload = path.join(tempRoot, "disk-fakes.mjs");
fs.writeFileSync(diskFakesPreload, `import fs from "node:fs";
const realStatfs = fs.statfsSync;
fs.statfsSync = (...args) => fs.existsSync(${JSON.stringify(shortSpaceFlag)}) ? { ...realStatfs(...args), bavail: 0, bfree: 0 } : realStatfs(...args);
const fails = (file, data) => {
	if (typeof file !== "number" || !fs.existsSync(${JSON.stringify(failingWritesFlag)})) return false;
	const bytes = typeof data === "string" ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	return bytes.includes(fs.readFileSync(${JSON.stringify(failingWritesFlag)}));
};
const failure = () => Object.assign(new Error("EIO: i/o error, write"), { code: "EIO" });
const realFsync = fs.fsyncSync;
fs.fsyncSync = (fd) => { if (fs.existsSync(${JSON.stringify(unsyncableFlag)})) throw Object.assign(new Error("ENOTSUP: operation not supported, fsync"), { code: "ENOTSUP" }); return realFsync(fd); };
for (const name of ["writeSync", "writeFileSync"]) {
	const real = fs[name];
	fs[name] = (file, data, ...rest) => { if (fails(file, data)) throw failure(); return real(file, data, ...rest); };
}
`);
const port = await freePort();
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
			NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(diskFakesPreload).href}`.trim(),
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

	// 6b. A link in the chosen folder that carries the saved file's name: Save…
	//     never writes through it. The default answers "exists", Keep both takes
	//     the next free name, and Replace is refused in plain words, whether the
	//     link points outside the folder or at a file inside it.
	const linkFolder = path.join(tempRoot, "link-folder");
	fs.mkdirSync(linkFolder, { recursive: true });
	const linkFolderReal = fs.realpathSync.native(linkFolder);
	const linkPath = path.join(linkFolderReal, "notes.md");
	let linksWork = true;
	for (const [label, target] of [["outside", path.join(tempRoot, "outside-target.md")], ["inside", path.join(linkFolderReal, "inside-target.md")]] as const) {
		fs.writeFileSync(target, "LINK-TARGET-ORIGINAL");
		try {
			fs.symlinkSync(target, linkPath);
		} catch (error) {
			console.log(`room-files-routes-smoke: link case skipped (${(error as NodeJS.ErrnoException).code ?? "no symlink"})`);
			linksWork = false;
			fs.rmSync(target, { force: true });
			break;
		}
		const asIs = await save("notes.md", { targetDir: linkFolder });
		assert(asIs.status === 409, `${label} link, default: expected 409, got ${asIs.status}`);
		const replaced = await save("notes.md", { targetDir: linkFolder, overwrite: true });
		const replacedBody = (await replaced.json()) as { error?: string };
		assert(replaced.status === 400, `${label} link, Replace: expected 400, got ${replaced.status}: ${JSON.stringify(replacedBody)}`);
		assert(replacedBody.error === "The file with this name in the chosen folder is a shortcut to somewhere else, so it was not replaced. Use Keep both, or pick another name.", `${label} link, Replace: the refusal must be the plain sentence, got ${JSON.stringify(replacedBody)}`);
		const keptBoth = await save("notes.md", { targetDir: linkFolder, rename: true });
		const keptBothBody = (await keptBoth.json()) as { savedTo: string };
		assert(keptBoth.status === 200 && keptBothBody.savedTo === path.join(linkFolderReal, "notes-2.md"), `${label} link, Keep both: expected notes-2.md, got ${keptBoth.status}: ${JSON.stringify(keptBothBody)}`);
		assert(!fs.lstatSync(keptBothBody.savedTo).isSymbolicLink() && fs.readFileSync(keptBothBody.savedTo, "utf-8") === "# alpha\nbeta\n", `${label} link, Keep both: notes-2.md must be a real copy`);
		assert(fs.readFileSync(target, "utf-8") === "LINK-TARGET-ORIGINAL", `${label} link: the link's target was written`);
		assert(fs.lstatSync(linkPath).isSymbolicLink(), `${label} link: the link itself must be left in place`);
		fs.unlinkSync(linkPath);
		fs.unlinkSync(keptBothBody.savedTo);
		fs.rmSync(target, { force: true });
	}
	if (linksWork) {
		// A link that leads nowhere, at the name and at the next free name: both
		// count as taken, and nothing is created through either.
		const danglingTarget = path.join(tempRoot, "dangling-target.md");
		const nextLinkPath = path.join(linkFolderReal, "notes-2.md");
		fs.symlinkSync(danglingTarget, linkPath);
		fs.symlinkSync(danglingTarget, nextLinkPath);
		const danglingDefault = await save("notes.md", { targetDir: linkFolder });
		const danglingReplace = await save("notes.md", { targetDir: linkFolder, overwrite: true });
		assert(danglingDefault.status === 409 && danglingReplace.status === 400, `dangling link: expected 409 and 400, got ${danglingDefault.status} and ${danglingReplace.status}`);
		const danglingKeptBoth = await save("notes.md", { targetDir: linkFolder, rename: true });
		const danglingKeptBothBody = (await danglingKeptBoth.json()) as { savedTo: string };
		assert(danglingKeptBoth.status === 200 && danglingKeptBothBody.savedTo === path.join(linkFolderReal, "notes-3.md"), `dangling links, Keep both: expected notes-3.md, got ${danglingKeptBoth.status}: ${JSON.stringify(danglingKeptBothBody)}`);
		assert(!fs.existsSync(danglingTarget), "dangling links: a file was created through a link");
		for (const name of [linkPath, nextLinkPath, danglingKeptBothBody.savedTo]) fs.unlinkSync(name);
	}

	// 6c. Another name of an outside file (a hard link) and a FIFO at the saved
	//     file's name: Replace puts a new file at the name and writes into
	//     neither, and the server keeps answering.
	const answerWithin = <T,>(promise: Promise<T>, label: string): Promise<T> => Promise.race([
		promise,
		new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label}: the server did not answer within 10 s`)), 10_000).unref()),
	]);
	const hardTarget = path.join(tempRoot, "hard-target.md");
	fs.writeFileSync(hardTarget, "HARD-TARGET-ORIGINAL");
	fs.linkSync(hardTarget, linkPath);
	const hardDefault = await save("notes.md", { targetDir: linkFolder });
	assert(hardDefault.status === 409, `hard link, default: expected 409, got ${hardDefault.status}`);
	const hardReplace = await answerWithin(save("notes.md", { targetDir: linkFolder, overwrite: true }), "hard link, Replace");
	assert(hardReplace.status === 200, `hard link, Replace: expected 200, got ${hardReplace.status}: ${await hardReplace.text()}`);
	assert(fs.readFileSync(hardTarget, "utf-8") === "HARD-TARGET-ORIGINAL", "hard link, Replace: the other name's file was written");
	assert(fs.readFileSync(linkPath, "utf-8") === "# alpha\nbeta\n" && fs.statSync(linkPath).nlink === 1, "hard link, Replace: the name must now hold a new file of its own");
	fs.unlinkSync(linkPath);
	if (process.platform !== "win32" && spawnSync("mkfifo", [linkPath]).status === 0) {
		const fifoReplace = await answerWithin(save("notes.md", { targetDir: linkFolder, overwrite: true }), "FIFO, Replace");
		assert(fifoReplace.status === 200 && fs.lstatSync(linkPath).isFile() && fs.readFileSync(linkPath, "utf-8") === "# alpha\nbeta\n", `FIFO, Replace: expected a new file at the name, got ${fifoReplace.status}`);
		assert((await answerWithin(fetch(`${baseUrl}/healthz`), "health after the FIFO")).ok, "the server must keep answering after a FIFO at the name");
		fs.unlinkSync(linkPath);
	} else {
		console.log("room-files-routes-smoke: FIFO case skipped");
	}
	assert(fs.readdirSync(linkFolderReal).every((name) => !name.endsWith(".tmp")), "Replace must leave no temporary file behind");

	// 6d. Replace gives the new file the old file's permission bits and, when
	//     the account belongs to it, its group; a Replace with nothing at the
	//     name gives what a new save gives.
	if (process.platform !== "win32") {
		const keptPath = path.join(linkFolderReal, "kept.md");
		const replaceKept = () => save("notes.md", { targetDir: linkFolder, saveAs: "kept.md", overwrite: true });
		for (const mode of [0o600, 0o664]) {
			fs.writeFileSync(keptPath, "KEPT-ORIGINAL");
			fs.chmodSync(keptPath, mode);
			const replacedKept = await replaceKept();
			const modeAfter = fs.statSync(keptPath).mode & 0o777;
			assert(replacedKept.status === 200 && fs.readFileSync(keptPath, "utf-8") === "# alpha\nbeta\n", `a 0${mode.toString(8)} file, Replace: expected the new bytes, got ${replacedKept.status}: ${await replacedKept.text()}`);
			assert(modeAfter === mode, `a 0${mode.toString(8)} file, Replace: the file came back 0${modeAfter.toString(8)}`);
			fs.unlinkSync(keptPath);
		}
		const savedNew = await save("notes.md", { targetDir: linkFolder, saveAs: "kept.md" });
		const newMode = fs.statSync(keptPath).mode & 0o777;
		fs.unlinkSync(keptPath);
		const replacedNothing = await replaceKept();
		const replacedNothingMode = fs.statSync(keptPath).mode & 0o777;
		assert(savedNew.status === 200 && replacedNothing.status === 200 && replacedNothingMode === newMode, `Replace with nothing at the name: expected 0${newMode.toString(8)}, as a new save gets, got 0${replacedNothingMode.toString(8)}`);
		const otherGroup = process.getgroups?.().find((gid) => gid !== fs.statSync(keptPath).gid);
		let grouped = false;
		if (otherGroup !== undefined) {
			try {
				fs.chownSync(keptPath, -1, otherGroup);
				grouped = true;
			} catch {}
		}
		if (grouped) {
			const replacedGrouped = await replaceKept();
			const groupAfter = fs.statSync(keptPath).gid;
			assert(replacedGrouped.status === 200 && groupAfter === otherGroup, `a file in group ${otherGroup}, Replace: the file came back in group ${groupAfter}`);
		} else {
			console.log("room-files-routes-smoke: group case skipped (no second group to give the file)");
		}
		fs.unlinkSync(keptPath);
		assert(fs.readdirSync(linkFolderReal).every((name) => !name.endsWith(".tmp")), "Replace must leave no temporary file behind");
	} else {
		console.log("room-files-routes-smoke: permission case skipped (Windows has no permission bits)");
	}

	// 6f. On macOS, Replace keeps what the old file carried beside its bytes:
	//     its Finder tag and comment (extended attributes) and its creation date.
	if (process.platform === "darwin") {
		const detailsPath = path.join(linkFolderReal, "details.md");
		const tags = "com.apple.metadata:_kMDItemUserTags";
		const comment = "com.apple.metadata:kMDItemFinderComment";
		fs.writeFileSync(detailsPath, "KEPT-ORIGINAL");
		assert(spawnSync("xattr", ["-w", tags, "(\"Red\\n6\")", detailsPath]).status === 0 && spawnSync("xattr", ["-w", comment, "a comment", detailsPath]).status === 0, "the Finder tag and comment could not be set");
		// A modification time before the creation date moves the creation date back on macOS.
		const created = new Date("2020-01-02T10:00:00Z");
		fs.utimesSync(detailsPath, created, created);
		const createdMs = fs.statSync(detailsPath).birthtimeMs;
		const replacedDetails = await save("notes.md", { targetDir: linkFolder, saveAs: "details.md", overwrite: true });
		const read = (attribute: string) => spawnSync("xattr", ["-p", attribute, detailsPath], { encoding: "utf-8" }).stdout.trim();
		assert(replacedDetails.status === 200 && fs.readFileSync(detailsPath, "utf-8") === "# alpha\nbeta\n", `a tagged file, Replace: expected the new bytes`);
		assert(read(tags) === "(\"Red\\n6\")", `a tagged file, Replace: the Finder tag is gone, got "${read(tags)}"`);
		assert(read(comment) === "a comment", `a tagged file, Replace: the Finder comment is gone, got "${read(comment)}"`);
		assert(fs.statSync(detailsPath).birthtimeMs === createdMs, `a tagged file, Replace: the creation date moved from ${new Date(createdMs).toISOString()} to ${fs.statSync(detailsPath).birthtime.toISOString()}`);
		fs.unlinkSync(detailsPath);
		assert(fs.readdirSync(path.dirname(detailsPath)).every((name) => !name.endsWith(".tmp")), "Replace must leave no temporary file behind");
	} else {
		console.log("SKIPPED: room-files-routes-smoke: Finder details case (macOS only)");
	}

	// 6g. A plain file with one name is written in place, so it stays the same
	//     file; on a disk short of room for the new bytes, the new file is
	//     written beside it and renamed over it, so the old one stays whole
	//     until then.
	{
		const placePath = path.join(linkFolderReal, "in-place.md");
		const replacePlace = () => save("notes.md", { targetDir: linkFolder, saveAs: "in-place.md", overwrite: true });
		fs.writeFileSync(placePath, "KEPT-ORIGINAL");
		const fileBefore = fs.statSync(placePath).ino;
		const inPlace = await replacePlace();
		assert(inPlace.status === 200 && fs.readFileSync(placePath, "utf-8") === "# alpha\nbeta\n" && fs.statSync(placePath).ino === fileBefore, `a plain file, Replace: expected the new bytes in the same file, got ${inPlace.status}`);
		fs.writeFileSync(placePath, "KEPT-ORIGINAL");
		fs.writeFileSync(shortSpaceFlag, "");
		let shortReplace: Response;
		try {
			shortReplace = await replacePlace();
		} finally {
			fs.rmSync(shortSpaceFlag);
		}
		assert(shortReplace.status === 200 && fs.readFileSync(placePath, "utf-8") === "# alpha\nbeta\n" && fs.statSync(placePath).ino !== fileBefore, `a disk short of room, Replace: expected the new bytes in a new file renamed over the name, got ${shortReplace.status}`);
		// Over 64 MiB, the old bytes are not held in memory, so the rename is used.
		fs.truncateSync(placePath, 64 * 1024 * 1024 + 1);
		const largeBefore = fs.statSync(placePath).ino;
		const largeReplace = await replacePlace();
		assert(largeReplace.status === 200 && fs.readFileSync(placePath, "utf-8") === "# alpha\nbeta\n" && fs.statSync(placePath).ino !== largeBefore, `a file over 64 MiB, Replace: expected the new bytes in a new file renamed over the name, got ${largeReplace.status}`);
		fs.unlinkSync(placePath);
		assert(fs.readdirSync(linkFolderReal).every((name) => !name.endsWith(".tmp")), "Replace must leave no temporary file behind");
	}

	// 6h. When the write in place fails and the rename fails too, the old
	//     bytes go back into the same file, and the save answers its failure.
	{
		const failPath = path.join(linkFolderReal, "double-failure.md");
		fs.writeFileSync(failPath, "KEPT-ORIGINAL");
		const fileBefore = fs.statSync(failPath).ino;
		fs.writeFileSync(failingWritesFlag, "# alpha");
		let failedReplace: Response;
		try {
			failedReplace = await save("notes.md", { targetDir: linkFolder, saveAs: "double-failure.md", overwrite: true });
		} finally {
			fs.rmSync(failingWritesFlag);
		}
		const failedBody = (await failedReplace.json()) as { error?: string };
		assert(failedReplace.status === 500 && failedBody.error === "The file could not be saved to the chosen folder.", `both writes failing, Replace: expected 500 with the save failure, got ${failedReplace.status}: ${JSON.stringify(failedBody)}`);
		assert(fs.readFileSync(failPath, "utf-8") === "KEPT-ORIGINAL" && fs.statSync(failPath).ino === fileBefore, `both writes failing, Replace: the old file is not whole, got "${fs.readFileSync(failPath, "utf-8")}"`);
		fs.unlinkSync(failPath);
		assert(fs.readdirSync(linkFolderReal).every((name) => !name.endsWith(".tmp")), "Replace must leave no temporary file behind");
	}

	// 6i. A disk that cannot sync a file still takes the save.
	{
		const syncPath = path.join(linkFolderReal, "unsyncable.md");
		fs.writeFileSync(syncPath, "KEPT-ORIGINAL");
		const fileBefore = fs.statSync(syncPath).ino;
		fs.writeFileSync(unsyncableFlag, "");
		let unsynced: Response;
		try {
			unsynced = await save("notes.md", { targetDir: linkFolder, saveAs: "unsyncable.md", overwrite: true });
		} finally {
			fs.rmSync(unsyncableFlag);
		}
		assert(unsynced.status === 200 && fs.readFileSync(syncPath, "utf-8") === "# alpha\nbeta\n" && fs.statSync(syncPath).ino === fileBefore, `a disk that cannot sync, Replace: expected the new bytes in the same file, got ${unsynced.status}: ${await unsynced.text()}`);
		fs.unlinkSync(syncPath);
	}

	// 6e. A file the account may not write is not replaced, as before: the
	//     answer is the one a failed save gives, and the file stays as it was.
	if (process.platform === "win32" || process.getuid?.() !== 0) {
		const readOnlyPath = path.join(linkFolderReal, "read-only.md");
		fs.writeFileSync(readOnlyPath, "READ-ONLY-ORIGINAL");
		fs.chmodSync(readOnlyPath, 0o444);
		try {
			const refused = await save("notes.md", { targetDir: linkFolder, saveAs: "read-only.md", overwrite: true });
			const refusedBody = (await refused.json()) as { error?: string };
			assert(refused.status === 500 && refusedBody.error === "The file could not be saved to the chosen folder.", `read-only file, Replace: expected 500 with the save failure, got ${refused.status}: ${JSON.stringify(refusedBody)}`);
			assert(fs.readFileSync(readOnlyPath, "utf-8") === "READ-ONLY-ORIGINAL", "read-only file, Replace: the file was replaced");
		} finally {
			fs.chmodSync(readOnlyPath, 0o644);
			fs.unlinkSync(readOnlyPath);
		}
	} else {
		console.log("room-files-routes-smoke: read-only file case skipped (root may write any file)");
	}

	// 6f. A folder where the file can be changed but no new file can be made:
	//     Replace writes into the file itself when it is a plain file with no
	//     other name, one it may write but not read included, and refuses a
	//     second name of an outside file.
	if (process.platform !== "win32" && process.getuid?.() !== 0) {
		const lockedFolder = path.join(tempRoot, "locked-folder");
		fs.mkdirSync(lockedFolder);
		const lockedReal = fs.realpathSync.native(lockedFolder);
		const lockedPath = path.join(lockedReal, "notes.md");
		const lockedOutside = path.join(tempRoot, "locked-outside.md");
		fs.writeFileSync(lockedPath, "LOCKED-ORIGINAL");
		fs.writeFileSync(lockedOutside, "LOCKED-OUTSIDE-ORIGINAL");
		fs.linkSync(lockedOutside, path.join(lockedReal, "second-name.md"));
		const writeOnlyPath = path.join(lockedReal, "write-only.md");
		fs.writeFileSync(writeOnlyPath, "WRITE-ONLY-ORIGINAL");
		fs.chmodSync(writeOnlyPath, 0o200);
		const inodeBefore = fs.statSync(lockedPath).ino;
		const writeOnlyBefore = fs.statSync(writeOnlyPath).ino;
		fs.chmodSync(lockedReal, 0o555);
		try {
			const inPlace = await save("notes.md", { targetDir: lockedFolder, overwrite: true });
			assert(inPlace.status === 200 && fs.readFileSync(lockedPath, "utf-8") === "# alpha\nbeta\n" && fs.statSync(lockedPath).ino === inodeBefore, `folder without new files, Replace: expected the file itself rewritten, got ${inPlace.status}: ${await inPlace.text()}`);
			const writeOnly = await save("notes.md", { targetDir: lockedFolder, saveAs: "write-only.md", overwrite: true });
			fs.chmodSync(writeOnlyPath, 0o600);
			assert(writeOnly.status === 200 && fs.readFileSync(writeOnlyPath, "utf-8") === "# alpha\nbeta\n" && fs.statSync(writeOnlyPath).ino === writeOnlyBefore, `folder without new files, a file it may write but not read, Replace: expected the file itself rewritten, got ${writeOnly.status}: ${await writeOnly.text()}`);
			const secondName = await save("notes.md", { targetDir: lockedFolder, saveAs: "second-name.md", overwrite: true });
			const secondNameBody = (await secondName.json()) as { error?: string };
			assert(secondName.status === 500 && secondNameBody.error === "The file could not be saved to the chosen folder.", `folder without new files, a second name of an outside file: expected the save failure, got ${secondName.status}: ${JSON.stringify(secondNameBody)}`);
			assert(fs.readFileSync(lockedOutside, "utf-8") === "LOCKED-OUTSIDE-ORIGINAL", "folder without new files: the outside file was written through its second name");
		} finally {
			fs.chmodSync(lockedReal, 0o755);
		}
	} else {
		console.log("room-files-routes-smoke: folder without new files case skipped (a read-only folder does not stop new files on Windows or for root)");
	}

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
