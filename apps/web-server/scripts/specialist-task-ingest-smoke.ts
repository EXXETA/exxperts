// Smoke for revise-run staging + the revise-in-place commit gate (files spec,
// "the specialist write fence"): ingestShelfInputs stages CURRENT shelf bytes
// under the new task's inputs/ (symlink-refusing lstat, per-type caps, content
// validators) and hash-pins every staged file as a revise target; the commit
// gate then replaces the canonical shelf file only while it still hashes to
// that baseline — a mid-run rewrite or delete refuses the overwrite and lands
// the output as a NEW file under the collision rule, reported as a conflict.
// Also pins: nested outputs can never claim the canonical file, non-target
// outputs absorb as plain task outputs, and inputs/ never lists as outputs.
//
// Run: npm run smoke:specialist-task-ingest   (or: node scripts/run-smokes.mjs specialist-task-ingest)

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-task-ingest-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const { ingestShelfInputs, listSpecialistTaskArtifacts } = await import("../src/persistent-room-specialist-execution.js");
const { SPECIALIST_TASK_CAPS } = await import("../src/specialist-templates.js");
const { commitReviseArtifactsOntoShelf, persistentRoomShelfDirPath, persistentRoomReadingCacheDirPath } = await import("../src/persistent-room-shelf.js");
const { artifactRoot } = await import("../../../pi-package/extensions/artifacts/index.js");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const sha256 = (buffer: Buffer | string) => crypto.createHash("sha256").update(buffer).digest("hex");

try {
	const roomId = "room";
	const shelfDir = persistentRoomShelfDirPath(roomId);
	fs.mkdirSync(shelfDir, { recursive: true, mode: 0o700 });
	const okHtml = "<!doctype html><title>v1</title><p>current shelf version</p>";
	fs.writeFileSync(path.join(shelfDir, "deck.html"), okHtml);
	fs.writeFileSync(path.join(shelfDir, "evil.html"), "<!doctype html><script>alert(1)</script>");
	fs.writeFileSync(path.join(shelfDir, "big.pptx"), "not really a deck");
	fs.symlinkSync(path.join(shelfDir, "deck.html"), path.join(shelfDir, "link.html"));
	fs.writeFileSync(path.join(shelfDir, "huge.md"), Buffer.alloc(SPECIALIST_TASK_CAPS.perFileBytesByExtension[".md"] + 1));

	const resolveShelfSource = (name: string) => path.join(shelfDir, name);

	// ---- staging: guards + hash-pinned revise targets ----------------------
	const staged = ingestShelfInputs(
		["files/deck.html", "files/evil.html", "files/link.html", "files/gone.html", "files/big.pptx", "files/huge.md", "tasks/tsk-old/kept.html"],
		"tasks/tsk-new",
		resolveShelfSource,
	);
	assert(staged.inputArtifacts.includes("tasks/tsk-new/inputs/deck.html"), "valid shelf file stages under inputs/");
	assert(staged.inputArtifacts.includes("tasks/tsk-old/kept.html"), "non-shelf inputs pass through untouched");
	assert(staged.inputArtifacts.length === 2, `only the valid file + passthrough survive, got ${JSON.stringify(staged.inputArtifacts)}`);
	assert(staged.dropped.length === 5, `every refused shelf input is reported dropped, got ${JSON.stringify(staged.dropped)}`);
	assert(staged.dropped.some((d) => d.sourceRelativePath === "files/evil.html" && /script/i.test(d.reason)), "unsafe html is refused by the content validator");
	assert(staged.dropped.some((d) => d.sourceRelativePath === "files/link.html"), "symlinks are refused (lstat)");
	assert(staged.dropped.some((d) => d.sourceRelativePath === "files/gone.html"), "missing shelf file is dropped");
	assert(staged.dropped.some((d) => d.sourceRelativePath === "files/big.pptx" && /cannot be ingested/.test(d.reason)), "extensions without a cap are refused");
	assert(staged.dropped.some((d) => d.sourceRelativePath === "files/huge.md" && /size cap/.test(d.reason)), "over-cap shelf files are refused");
	const stagedFile = path.join(artifactRoot(), "tasks", "tsk-new", "inputs", "deck.html");
	assert(fs.readFileSync(stagedFile, "utf-8") === okHtml, "staged copy carries the CURRENT shelf bytes");
	if (process.platform !== "win32") {
		assert((fs.statSync(stagedFile).mode & 0o777) === 0o600, "staged copy is 0600");
	}
	assert(staged.reviseTargets.length === 1, "exactly the staged shelf file is hash-pinned as a revise target");
	assert(staged.reviseTargets[0].name === "deck.html", "the revise target keys on the SHELF name");
	assert(staged.reviseTargets[0].baselineHash === sha256(okHtml), "the baseline hash is the sha256 of the staged bytes");
	assert(!fs.existsSync(path.join(artifactRoot(), "tasks", "tsk-new", "inputs", "evil.html")), "refused content must not land in the store");

	// ---- staging: a de-duplicated name is never a commit claim -------------
	const dup = ingestShelfInputs(["files/deck.html", "files/deck.html"], "tasks/tsk-dup", resolveShelfSource);
	assert(dup.inputArtifacts.length === 2 && dup.inputArtifacts[1] === "tasks/tsk-dup/inputs/deck-2.html", "duplicate staging suffixes the second copy");
	assert(dup.reviseTargets.length === 1 && dup.reviseTargets[0].name === "deck.html", "only the name-preserving copy hash-pins");

	// ---- staging: a collision-named shelf file stages under a safe alias ---
	// The collision rule's own names ("deck (2).html") are not store-safe, so
	// staging aliases them (files-management follow-up); the claim records the
	// alias and the commit gate maps the alias output back onto the canonical.
	fs.writeFileSync(path.join(shelfDir, "deck (2).html"), "<!doctype html><title>c1</title><p>collision original</p>");
	const aliasStaged = ingestShelfInputs(["files/deck (2).html"], "tasks/tsk-alias", resolveShelfSource);
	assert(aliasStaged.inputArtifacts[0] === "tasks/tsk-alias/inputs/deck-2.html", `collision name stages under a safe alias, got ${JSON.stringify(aliasStaged.inputArtifacts)}`);
	assert(aliasStaged.reviseTargets.length === 1 && aliasStaged.reviseTargets[0].name === "deck (2).html" && aliasStaged.reviseTargets[0].outputName === "deck-2.html", "the claim maps alias → canonical shelf name");
	const aliasRevised = "<!doctype html><title>c2</title><p>collision revised</p>";
	fs.writeFileSync(path.join(artifactRoot(), "tasks", "tsk-alias", "deck-2.html"), aliasRevised);
	const aliasCommit = commitReviseArtifactsOntoShelf(roomId, artifactRoot(), listSpecialistTaskArtifacts("tasks/tsk-alias"), aliasStaged.reviseTargets);
	assert(aliasCommit.conflicts.length === 0, `alias commit is clean, got ${JSON.stringify(aliasCommit.conflicts)}`);
	assert(fs.readFileSync(path.join(shelfDir, "deck (2).html"), "utf-8") === aliasRevised, "the alias output replaced the collision-named canonical in place");
	assert(aliasCommit.artifacts[0].relativePath === "files/deck (2).html", "the committed artifact reports the canonical files/ path");
	fs.rmSync(path.join(shelfDir, "deck (2).html"));

	// ---- commit gate: unchanged canonical → replaced in place --------------
	const taskDir = path.join(artifactRoot(), "tasks", "tsk-new");
	const revised = "<!doctype html><title>v2</title><p>revised</p>";
	fs.writeFileSync(path.join(taskDir, "deck.html"), revised);
	fs.writeFileSync(path.join(taskDir, "notes.html"), "<!doctype html><p>an extra new file</p>");
	fs.mkdirSync(path.join(taskDir, "sub"), { recursive: true });
	fs.writeFileSync(path.join(taskDir, "sub", "deck.html"), "<!doctype html><p>nested impostor</p>");
	const cacheDir = persistentRoomReadingCacheDirPath(roomId);
	fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
	const cacheKey = sha256("deck.html").slice(0, 16);
	fs.writeFileSync(path.join(cacheDir, `${cacheKey}.json`), "{}");
	fs.writeFileSync(path.join(cacheDir, `${cacheKey}.txt`), "stale text");

	const outputs = listSpecialistTaskArtifacts("tasks/tsk-new");
	assert(outputs.every((a) => !a.relativePath.includes("/inputs/")), "inputs/ never lists as outputs");
	const commit = commitReviseArtifactsOntoShelf(roomId, artifactRoot(), outputs, staged.reviseTargets);
	assert(commit.conflicts.length === 0, `clean commit reports no conflicts, got ${JSON.stringify(commit.conflicts)}`);
	assert(fs.readFileSync(path.join(shelfDir, "deck.html"), "utf-8") === revised, "the canonical shelf file was replaced in place");
	const committedPaths = commit.artifacts.map((a) => a.relativePath).sort();
	assert(committedPaths.includes("files/deck.html"), "the committed target reports the SAME files/ path (same row, no new file)");
	assert(committedPaths.includes("files/notes.html"), "a new-name output absorbs as a plain new shelf file");
	// The nested impostor absorbed under the collision rule (its basename
	// collides with the just-committed canonical) — it can never commit.
	const nested = commit.artifacts.find((a) => a.relativePath !== "files/deck.html" && a.relativePath !== "files/notes.html");
	assert(nested && nested.relativePath.startsWith("files/deck") && fs.readFileSync(path.join(shelfDir, nested.relativePath.slice("files/".length)), "utf-8").includes("nested impostor"), "the nested output landed as a separate collision-named file, not over the canonical");
	assert(fs.readFileSync(path.join(shelfDir, "deck.html"), "utf-8") === revised, "the canonical still holds the top-level revision after the nested absorb");
	assert(!fs.existsSync(path.join(cacheDir, `${cacheKey}.json`)) && !fs.existsSync(path.join(cacheDir, `${cacheKey}.txt`)), "the stale reading-cache pair drops with the commit");

	// ---- commit gate: canonical changed mid-run → refuse + save as new -----
	const staged2 = ingestShelfInputs(["files/deck.html"], "tasks/tsk-2", resolveShelfSource);
	fs.writeFileSync(path.join(shelfDir, "deck.html"), "<!doctype html><p>hand-edited while the specialist worked</p>");
	const task2Dir = path.join(artifactRoot(), "tasks", "tsk-2");
	fs.writeFileSync(path.join(task2Dir, "deck.html"), "<!doctype html><p>the doomed revision</p>");
	const commit2 = commitReviseArtifactsOntoShelf(roomId, artifactRoot(), listSpecialistTaskArtifacts("tasks/tsk-2"), staged2.reviseTargets);
	assert(commit2.conflicts.length === 1 && commit2.conflicts[0].name === "deck.html", "a mid-run rewrite reports a conflict");
	assert(fs.readFileSync(path.join(shelfDir, "deck.html"), "utf-8").includes("hand-edited"), "the changed canonical was NOT overwritten");
	const savedAs = commit2.conflicts[0].savedAs;
	assert(savedAs !== "deck.html" && fs.readFileSync(path.join(shelfDir, savedAs), "utf-8").includes("doomed revision"), "the refused revision landed as a new collision-named file");
	assert(commit2.artifacts[0].relativePath === `files/${savedAs}`, "the reported artifact path follows the saved-as name");

	// ---- commit gate: canonical deleted mid-run → refuse (deleted counts) --
	const staged3 = ingestShelfInputs(["files/deck.html"], "tasks/tsk-3", resolveShelfSource);
	fs.rmSync(path.join(shelfDir, "deck.html"));
	const task3Dir = path.join(artifactRoot(), "tasks", "tsk-3");
	fs.writeFileSync(path.join(task3Dir, "deck.html"), "<!doctype html><p>revision of a deleted file</p>");
	const commit3 = commitReviseArtifactsOntoShelf(roomId, artifactRoot(), listSpecialistTaskArtifacts("tasks/tsk-3"), staged3.reviseTargets);
	assert(commit3.conflicts.length === 1, "a mid-run delete reports a conflict (never a silent resurrection-as-overwrite)");
	assert(fs.readFileSync(path.join(shelfDir, commit3.conflicts[0].savedAs), "utf-8").includes("revision of a deleted file"), "the work still lands as a new file");

	// ---- staging preserves non-UTF-8 bytes end to end (critical fix) -------
	// A Windows-1252 .md (0xE9 = "é", not valid UTF-8) must survive staging
	// byte-for-byte: staging a lossily DECODED string would bake U+FFFD into
	// the copy the specialist revises, while the untouched canonical still
	// hashes to baseline — so the commit gate would replace the intact
	// original with the corrupted revision. Full revise→commit chain:
	const cp1252 = Buffer.concat([Buffer.from("Caf", "ascii"), Buffer.from([0xe9]), Buffer.from(" plan, v1\n", "ascii")]);
	fs.writeFileSync(path.join(shelfDir, "notes.md"), cp1252);
	const stagedCp = ingestShelfInputs(["files/notes.md"], "tasks/tsk-cp1252", resolveShelfSource);
	assert(stagedCp.inputArtifacts[0] === "tasks/tsk-cp1252/inputs/notes.md" && stagedCp.dropped.length === 0, `the cp1252 file must stage, got ${JSON.stringify(stagedCp)}`);
	const stagedCpBytes = fs.readFileSync(path.join(artifactRoot(), "tasks", "tsk-cp1252", "inputs", "notes.md"));
	assert(stagedCpBytes.equals(cp1252), `staging must preserve the exact bytes (0xE9 intact, no U+FFFD), got ${stagedCpBytes.toString("hex")}`);
	assert(stagedCp.reviseTargets[0].baselineHash === sha256(cp1252), "the baseline hash pins the same raw bytes the specialist received");
	// The specialist edits the staged copy byte-preservingly and outputs it:
	const cpRevised = Buffer.concat([stagedCpBytes.subarray(0, stagedCpBytes.length - 3), Buffer.from("2\n", "ascii")]);
	fs.writeFileSync(path.join(artifactRoot(), "tasks", "tsk-cp1252", "notes.md"), cpRevised);
	const cpCommit = commitReviseArtifactsOntoShelf(roomId, artifactRoot(), listSpecialistTaskArtifacts("tasks/tsk-cp1252"), stagedCp.reviseTargets);
	assert(cpCommit.conflicts.length === 0, `the unchanged canonical must commit cleanly, got ${JSON.stringify(cpCommit.conflicts)}`);
	const cpCanonical = fs.readFileSync(path.join(shelfDir, "notes.md"));
	assert(cpCanonical.equals(cpRevised) && cpCanonical.includes(0xe9) && !cpCanonical.includes(Buffer.from([0xef, 0xbf, 0xbd])), `the committed canonical must keep the 0xE9 byte and carry no U+FFFD, got ${cpCanonical.toString("hex")}`);
	// Raw staging must not open an encoding-confusion door: a UTF-16 .html
	// interleaves NULs, so the validators' decoded view can never see the
	// `<script>` a browser would — such files are refused, not staged.
	fs.writeFileSync(path.join(shelfDir, "utf16.html"), Buffer.from("<!doctype html><script>alert(1)</script>", "utf16le"));
	const utf16 = ingestShelfInputs(["files/utf16.html"], "tasks/tsk-utf16", resolveShelfSource);
	assert(utf16.inputArtifacts.length === 0 && utf16.dropped.length === 1 && /encoding/.test(utf16.dropped[0].reason), `a NUL-bearing html must be refused, got ${JSON.stringify(utf16)}`);

	// ---- commit gate: no targets → byte-identical plain absorb -------------
	const task4Dir = path.join(artifactRoot(), "tasks", "tsk-4");
	fs.mkdirSync(task4Dir, { recursive: true });
	fs.writeFileSync(path.join(task4Dir, "fresh.html"), "<!doctype html><p>plain task output</p>");
	const commit4 = commitReviseArtifactsOntoShelf(roomId, artifactRoot(), listSpecialistTaskArtifacts("tasks/tsk-4"), []);
	assert(commit4.conflicts.length === 0 && commit4.artifacts[0].relativePath === "files/fresh.html", "an empty target list degrades to the plain absorb path");

	fs.rmSync(tempHome, { recursive: true, force: true });
	console.log("specialist task ingest smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp HOME preserved for inspection: ${tempHome}`);
	process.exitCode = 1;
}
