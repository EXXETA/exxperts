import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-task-ingest-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const { planExportedInputIngest } = await import("../src/persistent-room-task-ledger.js");
const { ingestExportedInputs, listSpecialistTaskArtifacts } = await import("../src/persistent-room-specialist-execution.js");
const { SPECIALIST_TASK_CAPS } = await import("../src/specialist-templates.js");
const { artifactRoot } = await import("../../../pi-package/extensions/artifacts/index.js");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const ledgerRow = (exports: { relativePath: string; savedTo: string; at: string }[]) =>
	({
		schemaVersion: 1 as const,
		taskId: "tsk-src",
		roomId: "room",
		conversationId: "conv",
		templateId: "deck",
		templateVersion: 1,
		title: "Source",
		startedAt: "2026-07-18T10:00:00.000Z",
		outcome: "ok" as const,
		exports,
	});

try {
	const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-task-ingest-ws-"));
	const okHtml = "<!doctype html><title>edited</title><p>current workspace version</p>";
	fs.writeFileSync(path.join(workspace, "deck.html"), okHtml);
	fs.writeFileSync(path.join(workspace, "evil.html"), "<!doctype html><script>alert(1)</script>");
	fs.writeFileSync(path.join(workspace, "big.md"), "x".repeat(50));
	fs.symlinkSync(path.join(workspace, "deck.html"), path.join(workspace, "link.html"));

	// Planning: only exported inputs map; latest export wins; collisions suffix.
	const row = ledgerRow([
		{ relativePath: "tasks/tsk-src/deck.html", savedTo: path.join(workspace, "old-deck.html"), at: "1" },
		{ relativePath: "tasks/tsk-src/deck.html", savedTo: path.join(workspace, "deck.html"), at: "2" },
		{ relativePath: "tasks/tsk-src/sub/deck.html", savedTo: path.join(workspace, "deck.html"), at: "3" },
	]);
	const plan = planExportedInputIngest(row, ["tasks/tsk-src/deck.html", "tasks/tsk-src/sub/deck.html", "tasks/tsk-src/never-exported.md"], "tasks/tsk-new");
	assert(plan.length === 2, "only exported inputs plan an ingest");
	assert(plan[0].savedTo === path.join(workspace, "deck.html"), "the LATEST export of an artifact wins");
	assert(plan[0].ingestedRelativePath === "tasks/tsk-new/inputs/deck.html", "ingest lands under the new task's inputs/");
	assert(plan[1].ingestedRelativePath === "tasks/tsk-new/inputs/deck-2.html", "basename collisions suffix");
	assert(planExportedInputIngest(null, ["a"], "tasks/t").length === 0, "no ledger row plans nothing");
	assert(planExportedInputIngest(ledgerRow([]), ["a"], "tasks/t").length === 0, "no exports plans nothing");

	// Execution: happy copy; every refusal falls back instead of throwing.
	const results = ingestExportedInputs([
		{ sourceRelativePath: "a", savedTo: path.join(workspace, "deck.html"), ingestedRelativePath: "tasks/tsk-new/inputs/deck.html" },
		{ sourceRelativePath: "b", savedTo: path.join(workspace, "evil.html"), ingestedRelativePath: "tasks/tsk-new/inputs/evil.html" },
		{ sourceRelativePath: "c", savedTo: path.join(workspace, "link.html"), ingestedRelativePath: "tasks/tsk-new/inputs/link.html" },
		{ sourceRelativePath: "d", savedTo: path.join(workspace, "gone.html"), ingestedRelativePath: "tasks/tsk-new/inputs/gone.html" },
		{ sourceRelativePath: "e", savedTo: path.join(workspace, "big.md"), ingestedRelativePath: "tasks/tsk-new/inputs/big.pptx" },
	]);
	assert(results[0].ingested === true, "valid current file ingests");
	const ingestedFile = path.join(artifactRoot(), "tasks", "tsk-new", "inputs", "deck.html");
	assert(fs.readFileSync(ingestedFile, "utf-8") === okHtml, "ingested copy carries the CURRENT workspace bytes");
	if (process.platform !== "win32") {
		assert((fs.statSync(ingestedFile).mode & 0o777) === 0o600, "ingested copy is 0600");
	}
	assert(results[1].ingested === false && /script/i.test(results[1].reason ?? ""), "a workspace file edited into unsafety is refused");
	assert(!fs.existsSync(path.join(artifactRoot(), "tasks", "tsk-new", "inputs", "evil.html")), "refused content must not land in the store");
	assert(results[2].ingested === false, "symlinks are refused (lstat)");
	assert(results[3].ingested === false && /no longer exists/.test(results[3].reason ?? ""), "missing workspace file falls back");
	assert(results[4].ingested === false && /cannot be ingested/.test(results[4].reason ?? ""), "extensions without a cap are refused");

	// Size cap: a workspace file grown past the per-extension cap is refused.
	fs.writeFileSync(path.join(workspace, "huge.md"), Buffer.alloc(SPECIALIST_TASK_CAPS.perFileBytesByExtension[".md"] + 1));
	const capped = ingestExportedInputs([{ sourceRelativePath: "f", savedTo: path.join(workspace, "huge.md"), ingestedRelativePath: "tasks/tsk-new/inputs/huge.md" }]);
	assert(capped[0].ingested === false && /size cap/.test(capped[0].reason ?? ""), "over-cap workspace files are refused");

	// The new task's OUTPUT listing never includes ingested inputs.
	fs.writeFileSync(path.join(artifactRoot(), "tasks", "tsk-new", "out.html"), "<!doctype html><p>output</p>");
	const listed = listSpecialistTaskArtifacts("tasks/tsk-new");
	assert(listed.length === 1 && listed[0].relativePath === "tasks/tsk-new/out.html", `inputs/ must not list as outputs, got ${JSON.stringify(listed.map((a) => a.relativePath))}`);

	fs.rmSync(tempHome, { recursive: true, force: true });
	fs.rmSync(workspace, { recursive: true, force: true });
	console.log("specialist task ingest smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp HOME preserved for inspection: ${tempHome}`);
	process.exitCode = 1;
}
