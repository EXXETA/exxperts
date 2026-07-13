// Visuals V1 smoke (contract spec §3/§7): specialist template floors, session
// plan confinement, and the artifacts extension's pre-approved write scope —
// exercised through the REAL tool execute paths with a headless UI context,
// under an isolated temp HOME. Model-free by design: everything here must
// hold before any session exists.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-specialist-runtime-"));
const tempHome = path.join(tempRoot, "home");
fs.mkdirSync(tempHome, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const artifacts = await import("../../../pi-package/extensions/artifacts/index.js");
const templates = await import("../src/specialist-templates.js");
const execution = await import("../src/persistent-room-specialist-execution.js");

// Headless tool context: hasUI false means approve() returns false — exactly
// what a specialist session sees. notify must exist (called on granted writes).
const headlessCtx = { hasUI: false, ui: { notify() {}, async confirm() { throw new Error("smoke: confirm must never be called headless"); } } };

type RegisteredTool = { name: string; execute: (id: string, params: any, signal: any, onUpdate: any, ctx: any) => Promise<any> };
function instantiate(options?: any): Map<string, RegisteredTool> {
	const tools = new Map<string, RegisteredTool>();
	const fakePi = { registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); } };
	(options === undefined ? (artifacts as any).default : artifacts.createArtifactsExtension(options))(fakePi);
	return tools;
}

// ── 1. Template registry floors ──────────────────────────────────────────────
{
	const all = templates.listSpecialistTemplates();
	assert(all.length === 4, `expected 4 v1 templates, got ${all.length}`);
	for (const template of all) templates.assertSpecialistTemplateTools(template);
	const ids = new Set(all.map((t) => t.id));
	for (const id of ["diagram-svg", "chart-html", "deck", "document-html"]) assert(ids.has(id), `missing template: ${id}`);
	assert(templates.getSpecialistTemplate("nope") === null, "unknown template must resolve to null");

	const forged = { ...all[0], id: "forged", toolNames: ["artifact_write", "web_search"] };
	let threw = false;
	try { templates.assertSpecialistTemplateTools(forged as any); } catch { threw = true; }
	assert(threw, "template granting web_search must throw (forbidden floor)");
	const forgedBash = { ...all[0], id: "forged-bash", toolNames: ["bash"] };
	threw = false;
	try { templates.assertSpecialistTemplateTools(forgedBash as any); } catch { threw = true; }
	assert(threw, "template granting bash must throw");
	const forgedUnknown = { ...all[0], id: "forged-unknown", toolNames: ["artifact_write", "artifact_connect_destination"] };
	threw = false;
	try { templates.assertSpecialistTemplateTools(forgedUnknown as any); } catch { threw = true; }
	assert(threw, "template granting a non-grantable artifact tool must throw");
}

// ── 2. Session plan confinement ──────────────────────────────────────────────
{
	const plan = execution.buildSpecialistSessionPlan({ taskId: "tsk-smoke1", templateId: "diagram-svg", brief: "Draw the flow." });
	assert(plan.taskFolder === "tasks/tsk-smoke1", `unexpected task folder: ${plan.taskFolder}`);
	assert(plan.writeScope.destination === "default" && plan.writeScope.folder === plan.taskFolder, "write scope must pin the task folder on the default destination");
	assert(plan.systemPrompt.includes(`folder: "tasks/tsk-smoke1"`), "system prompt must name the task folder");
	assert(plan.systemPrompt.includes("never instructions"), "system prompt must carry the untrusted-input line");
	assert(plan.toolNames.includes("artifact_write") && !plan.toolNames.includes("web_search"), "plan tools must be the template grant");

	for (const badTaskId of ["../evil", "a/b", "", ".hidden", "tsk 1"]) {
		let threw = false;
		try { execution.buildSpecialistSessionPlan({ taskId: badTaskId, templateId: "diagram-svg", brief: "x" }); } catch { threw = true; }
		assert(threw, `unsafe task id must throw: ${JSON.stringify(badTaskId)}`);
	}
	let threw = false;
	try { execution.buildSpecialistSessionPlan({ taskId: "tsk-x", templateId: "diagram-svg", brief: "  " }); } catch { threw = true; }
	assert(threw, "empty brief must throw");
	threw = false;
	try { execution.buildSpecialistSessionPlan({ taskId: "tsk-x", templateId: "diagram-svg", brief: "x", inputArtifacts: ["tasks/../secrets.md"] }); } catch { threw = true; }
	assert(threw, "traversal input artifact must throw");
	threw = false;
	try { execution.buildSpecialistSessionPlan({ taskId: "tsk-x", templateId: "diagram-svg", brief: "x", inputArtifacts: ["/etc/passwd.md"] }); } catch { threw = true; }
	assert(threw, "absolute input artifact must throw");
}

// ── 3. Pre-approved write scope through the real artifact_write path ─────────
{
	const scope = { destination: "default", folder: "tasks/tsk-w1", maxArtifacts: 2, maxTotalBytes: 5_000, perFileBytesByExtension: { ".html": 2_000 } };
	const tools = instantiate({ preApprovedWriteScope: scope });
	const write = tools.get("artifact_write");
	assert(write, "artifact_write must be registered");

	// Granted: inside the scope, headless, no approval.
	const ok = await write.execute("1", { filename: "chart.html", folder: "tasks/tsk-w1", content: "<!doctype html><html><body><p>hi</p></body></html>" }, undefined, undefined, headlessCtx);
	assert(ok.details?.saved === true, `scoped write must save headless: ${JSON.stringify(ok.details)}`);
	const storeRoot = artifacts.artifactRoot();
	assert(fs.existsSync(path.join(storeRoot, "tasks", "tsk-w1", "chart.html")), "scoped write must land in the task folder");

	// Not granted: outside the scope → falls to approval → headless declines.
	const outside = await write.execute("2", { filename: "escape.html", folder: "elsewhere", content: "<p>x</p>" }, undefined, undefined, headlessCtx);
	assert(outside.details?.saved === false && outside.isError === true, "out-of-scope write must fail headless");
	assert(!fs.existsSync(path.join(storeRoot, "elsewhere", "escape.html")), "out-of-scope write must not land");

	// Traversal is rejected by path validation before any grant logic.
	const traversal = await write.execute("3", { filename: "../../escape.html", folder: "tasks/tsk-w1", content: "<p>x</p>" }, undefined, undefined, headlessCtx);
	assert(traversal.isError === true && traversal.details?.saved !== true, "traversal filename must be rejected");

	// Per-file cap inside the scope is a hard rejection, not an approval fallback.
	const big = await write.execute("4", { filename: "big.html", folder: "tasks/tsk-w1", content: `<p>${"y".repeat(3_000)}</p>` }, undefined, undefined, headlessCtx);
	assert(big.isError === true && String(big.content?.[0]?.text ?? "").includes("size cap"), "scoped per-file cap must reject");

	// maxArtifacts: second file fits, third is rejected.
	const second = await write.execute("5", { filename: "notes.md", folder: "tasks/tsk-w1", content: "note" }, undefined, undefined, headlessCtx);
	assert(second.details?.saved === true, "second scoped write must save");
	const third = await write.execute("6", { filename: "extra.md", folder: "tasks/tsk-w1", content: "more" }, undefined, undefined, headlessCtx);
	assert(third.isError === true && String(third.content?.[0]?.text ?? "").includes("artifact limit"), "artifact-count cap must reject");

	// Overwriting an existing scoped file is not a new artifact and stays granted.
	const overwrite = await write.execute("7", { filename: "notes.md", folder: "tasks/tsk-w1", content: "note v2" }, undefined, undefined, headlessCtx);
	assert(overwrite.details?.saved === true && overwrite.details?.replaced === true, "scoped overwrite must stay granted");
}

// ── 4. SVG first-class + cap ─────────────────────────────────────────────────
{
	const scope = { destination: "default", folder: "tasks/tsk-svg", maxArtifacts: 8, maxTotalBytes: 40_000_000 };
	const tools = instantiate({ preApprovedWriteScope: scope });
	const write = tools.get("artifact_write")!;
	const svg = await write.execute("1", { filename: "diagram.svg", folder: "tasks/tsk-svg", content: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>` }, undefined, undefined, headlessCtx);
	assert(svg.details?.saved === true, `scoped .svg write must save: ${JSON.stringify(svg.details)}`);
	const oversized = await write.execute("2", { filename: "huge.svg", folder: "tasks/tsk-svg", content: `<svg>${"z".repeat(1_000_001)}</svg>` }, undefined, undefined, headlessCtx);
	assert(oversized.isError === true && String(oversized.content?.[0]?.text ?? "").includes("capped"), "oversized svg must be rejected everywhere");
}

// ── 5. Deck template v2: free model-authored HTML (D3 amendment 2026-07-12) ──
{
	const deck = templates.getSpecialistTemplate("deck")!;
	assert(deck.version === 2, `deck template must be v2, got v${deck.version}`);
	assert(deck.toolNames.includes("artifact_write") && !deck.toolNames.includes("artifact_write_html_deck"), "deck v2 grants artifact_write, not the deterministic renderer");
	assert(deck.promptIntro.includes('<section class="slide">'), "deck v2 prompt must require the slide-section structure");
	assert(!deck.exportMenu.includes("pptx" as never), "deck v2 export menu must not offer pptx");

	const scope = { destination: "default", folder: "tasks/tsk-deck", maxArtifacts: 8, maxTotalBytes: 40_000_000, allowedExtensions: [".html"] };
	const tools = instantiate({ preApprovedWriteScope: scope });
	const write = tools.get("artifact_write")!;

	// A free-HTML deck with slide sections saves headless in the deck scope, and
	// its structure matches what the write-time slide thumbnailer keys on.
	const DECK_HTML = [
		"<!doctype html><html><head><style>.slide{width:1280px;height:720px;background:#111;color:#eee}</style></head><body>",
		'<section class="slide"><h1>Opening frame</h1><p>One message.</p></section>',
		'<section class="slide"><h2>Closing action</h2><p>Do the thing.</p></section>',
		"</body></html>",
	].join("\n");
	const saved = await write.execute("1", { filename: "deck.html", folder: "tasks/tsk-deck", content: DECK_HTML }, undefined, undefined, headlessCtx);
	assert(saved.details?.saved === true, `free-HTML deck must save headless in the deck scope: ${JSON.stringify(saved.details)}`);
	const html = fs.readFileSync(path.join(artifacts.artifactRoot(), "tasks", "tsk-deck", "deck.html"), "utf-8");
	const SLIDE_DETECT = /<section[^>]+class="[^"]*\bslide\b/i; // same pattern as task-artifact-thumbnails.ts
	assert(SLIDE_DETECT.test(html), "saved deck must match the thumbnailer's slide-section detection");

	// The raw-HTML safety validation still gates the free path: scripts, inline
	// handlers, and external references are write-rejected.
	const scripted = await write.execute("2", { filename: "evil.html", folder: "tasks/tsk-deck", content: '<section class="slide"><script>alert(1)</script></section>' }, undefined, undefined, headlessCtx);
	assert(scripted.isError === true && String(scripted.content?.[0]?.text ?? "").includes("<script>"), "scripted deck html must be write-rejected");
	const external = await write.execute("3", { filename: "beacon.html", folder: "tasks/tsk-deck", content: '<section class="slide"><img src="https://evil.example/x.png"></section>' }, undefined, undefined, headlessCtx);
	assert(external.isError === true, "externally-referencing deck html must be write-rejected");

	// The deterministic renderer stays registered (main-room tool) and its output
	// stays script-free; outside a scope it falls to approval and fails headless.
	const writeDeckTool = tools.get("artifact_write_html_deck");
	assert(writeDeckTool, "artifact_write_html_deck must stay registered for main-room use");
	const rendered = await writeDeckTool.execute("4", {
		filename: "renderer.html",
		folder: "tasks/tsk-deck",
		title: "Smoke Deck",
		slides: [{ title: "One", keyMessage: "First", bullets: ["a", "b"] }, { title: "Two", keyMessage: "Second", bullets: ["c"] }],
	}, undefined, undefined, headlessCtx);
	assert(rendered.details?.saved === true, `renderer write must still work in-scope: ${JSON.stringify(rendered.details)}`);
	const rendererHtml = fs.readFileSync(path.join(artifacts.artifactRoot(), "tasks", "tsk-deck", "renderer.html"), "utf-8");
	assert(!/<script\b/i.test(rendererHtml) && !/\son[a-z]+\s*=/i.test(rendererHtml), "renderer output must stay script-free");
	const outside = await writeDeckTool.execute("5", { filename: "free.html", folder: "decks", title: "X", slides: [{ title: "s" }] }, undefined, undefined, headlessCtx);
	assert(outside.details?.saved === false && outside.isError === true, "out-of-scope renderer write must fail headless");
}

// ── 6. No grant leak into the default extension ──────────────────────────────
{
	const tools = instantiate(undefined); // the default export every existing session uses
	const write = tools.get("artifact_write")!;
	const result = await write.execute("1", { filename: "leak.md", folder: "tasks/tsk-w1", content: "x" }, undefined, undefined, headlessCtx);
	assert(result.details?.saved === false && result.isError === true, "default extension must still require approval for task-folder paths");
}

// ── 7. Read scope through the real artifact_read/artifact_list paths ─────────
// Hardening pass (F2): a specialist may read/list ONLY its own task folder plus
// the exact input artifacts its brief declared — never sibling tasks, never the
// wider store. Normal (unscoped) sessions stay unconfined.
{
	const storeRoot = artifacts.artifactRoot();
	fs.mkdirSync(path.join(storeRoot, "tasks", "tsk-r1"), { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(storeRoot, "tasks", "tsk-r1", "own.md"), "own-content");
	fs.mkdirSync(path.join(storeRoot, "tasks", "tsk-r0"), { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(storeRoot, "tasks", "tsk-r0", "input.md"), "input-content");
	fs.writeFileSync(path.join(storeRoot, "tasks", "tsk-r0", "sibling.md"), "sibling-content");
	fs.mkdirSync(path.join(storeRoot, "private"), { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(storeRoot, "private", "secret.md"), "SECRET-CONTENT");

	const readScope = { destination: "default", folders: ["tasks/tsk-r1"], paths: ["tasks/tsk-r0/input.md"] };
	const tools = instantiate({ readScope });
	const read = tools.get("artifact_read")!;
	const list = tools.get("artifact_list")!;

	const own = await read.execute("1", { filename: "own.md", folder: "tasks/tsk-r1" }, undefined, undefined, headlessCtx);
	assert(own.isError !== true && String(own.content?.[0]?.text ?? "").includes("own-content"), "own-task read must pass");
	const input = await read.execute("2", { filename: "input.md", folder: "tasks/tsk-r0" }, undefined, undefined, headlessCtx);
	assert(input.isError !== true && String(input.content?.[0]?.text ?? "").includes("input-content"), "declared input artifact read must pass");
	const sibling = await read.execute("3", { filename: "sibling.md", folder: "tasks/tsk-r0" }, undefined, undefined, headlessCtx);
	assert(sibling.isError === true && String(sibling.content?.[0]?.text ?? "").includes("read scope"), "sibling-task read must be refused");
	const secret = await read.execute("4", { filename: "secret.md", folder: "private" }, undefined, undefined, headlessCtx);
	assert(secret.isError === true && !String(secret.content?.[0]?.text ?? "").includes("SECRET-CONTENT"), "store-wide read must be refused without leaking content");

	const listed = await list.execute("5", {}, undefined, undefined, headlessCtx);
	const listedPaths: string[] = (listed.details?.artifacts ?? []).map((a: any) => String(a.path));
	assert(listedPaths.includes("tasks/tsk-r1/own.md"), "list must include the own task folder");
	assert(listedPaths.includes("tasks/tsk-r0/input.md"), "list must include declared input artifacts");
	assert(!listedPaths.some((p) => p === "tasks/tsk-r0/sibling.md" || p.startsWith("private/")), "list must hide everything outside the scope");

	// The unscoped default extension keeps full visibility — no read-scope leak
	// into normal room sessions.
	const defaultList = await instantiate(undefined).get("artifact_list")!.execute("6", {}, undefined, undefined, headlessCtx);
	const defaultPaths: string[] = (defaultList.details?.artifacts ?? []).map((a: any) => String(a.path));
	assert(defaultPaths.some((p) => p.startsWith("private/")), "default extension list must stay unconfined");
}

// ── 8. Template outputExtensions enforced at write (hardening pass) ──────────
{
	const deckPlan = execution.buildSpecialistSessionPlan({ taskId: "tsk-ext1", templateId: "deck", brief: "Deck it.", inputArtifacts: ["tasks/tsk-r0/input.md"] });
	assert(Array.isArray(deckPlan.writeScope.allowedExtensions) && deckPlan.writeScope.allowedExtensions.join(",") === ".html", "deck write scope must carry the template outputExtensions");
	assert(deckPlan.inputArtifacts.length === 1 && deckPlan.inputArtifacts[0] === "tasks/tsk-r0/input.md", "plan must retain validated input artifacts for the read scope");
	const svgPlan = execution.buildSpecialistSessionPlan({ taskId: "tsk-ext2", templateId: "diagram-svg", brief: "Draw it." });
	assert(svgPlan.inputArtifacts.length === 0, "plan without inputs must carry an empty inputArtifacts list");

	// A deck-scoped session cannot write .svg, and a diagram-scoped one cannot
	// write .md — hard validation rejection, never an approval fallback.
	const deckWrite = instantiate({ preApprovedWriteScope: deckPlan.writeScope }).get("artifact_write")!;
	const wrongExt = await deckWrite.execute("1", { filename: "sneak.svg", folder: deckPlan.taskFolder, content: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>` }, undefined, undefined, headlessCtx);
	assert(wrongExt.isError === true && String(wrongExt.content?.[0]?.text ?? "").includes("only writes"), "deck scope must reject non-.html extensions at write");
	const svgWrite = instantiate({ preApprovedWriteScope: svgPlan.writeScope }).get("artifact_write")!;
	const wrongMd = await svgWrite.execute("2", { filename: "notes.md", folder: svgPlan.taskFolder, content: "notes" }, undefined, undefined, headlessCtx);
	assert(wrongMd.isError === true && String(wrongMd.content?.[0]?.text ?? "").includes("only writes"), "diagram scope must reject .md at write");
	const rightExt = await svgWrite.execute("3", { filename: "diagram.svg", folder: svgPlan.taskFolder, content: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>` }, undefined, undefined, headlessCtx);
	assert(rightExt.details?.saved === true, `template extension must still save: ${JSON.stringify(rightExt.details)}`);
}

// ── 9. Thumbnail generation is never-throw (hardening pass) ──────────────────
// task_end waits on this call: whatever goes wrong (missing files here; a hung
// chromium.launch in production, bounded by the internal deadline), it must
// resolve [] rather than throw — a cosmetic failure can never fail the task.
{
	const thumbs = await import("../src/task-artifact-thumbnails.js");
	const result = await thumbs.generateTaskArtifactThumbnails(
		"tasks/tsk-none",
		[{ relativePath: "tasks/tsk-none/ghost.html", bytes: 10, extension: ".html" }],
		() => {},
	);
	assert(Array.isArray(result) && result.length === 0, "thumbnail generation must resolve [] on failure, never throw");
}

// ── 10. task_error keeps chips (bug 10) ─────────────────────────────────────
// When a worker throws AFTER writing files, the launch catch path recomputes the
// written-artifact list from the task folder alone (listSpecialistTaskArtifacts)
// so task_error carries the same artifacts the aborted-resolved branch derives
// from result.artifacts — chips survive the throw. The recompute must also never
// throw on a missing folder (the catch guards it, but empty-is-[] keeps chips
// degradation cosmetic).
{
	const plan = execution.buildSpecialistSessionPlan({ taskId: "tsk-err1", templateId: "deck", brief: "Deck it." });
	const write = instantiate({ preApprovedWriteScope: plan.writeScope }).get("artifact_write")!;
	const saved = await write.execute("1", { filename: "slides.html", folder: plan.taskFolder, content: "<!doctype html><html><body><section>Hi</section></body></html>" }, undefined, undefined, headlessCtx);
	assert(saved.details?.saved === true, `write must land before the throw: ${JSON.stringify(saved.details)}`);
	const listed = execution.listSpecialistTaskArtifacts(plan.taskFolder);
	assert(listed.length === 1 && listed[0].relativePath === `${plan.taskFolder}/slides.html`, "listSpecialistTaskArtifacts must return files written before a worker throw");
	assert(listed[0].extension === ".html" && listed[0].bytes > 0, "the artifact entry must carry the shape task_error ships");
	assert(execution.listSpecialistTaskArtifacts("tasks/tsk-does-not-exist").length === 0, "missing task folder must list as empty, not throw");
}

console.log("specialist runtime smoke passed");
