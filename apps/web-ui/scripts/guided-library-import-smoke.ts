import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { GuidedLibraryImport } from "../src/components/GuidedLibraryImport";
import { MaterialSelectionTree } from "../src/components/MaterialSelectionTree";
import type { SkillListItem } from "../src/skills-api";
import { defaultRepoPolicy, type RepoScanResponse, type SkillLibrary } from "../src/skills-repo-api";

const dom = new JSDOM("<div id='root' class='settings-dialog-pane'></div>", { url: "http://localhost/" });
const previousFetch = globalThis.fetch;
const names = ["window", "document", "HTMLElement", "HTMLInputElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
const previousGlobals = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, IS_REACT_ACT_ENVIRONMENT: true });
const container = dom.window.document.getElementById("root")!;
const root = createRoot(container);
const flush = async () => { for (let step = 0; step < 5; step++) await new Promise<void>((resolve) => setImmediate(resolve)); };
const button = (label: string) => [...container.querySelectorAll("button")].find((entry) => !entry.closest("[hidden]") && entry.textContent === label)!;
async function expandFolders() {
    for (let pass = 0; pass < 4; pass++) await act(async () => {
        for (const folder of container.querySelectorAll<HTMLDetailsElement>("details.material-selection-folder:not([open])")) { folder.open = true; folder.dispatchEvent(new dom.window.Event("toggle", { bubbles: false })); }
        await flush();
    });
}
const checkbox = (label: string) => [...container.querySelectorAll("input")].find((entry) => !entry.closest("[hidden]") && entry.getAttribute("aria-label") === label) as HTMLInputElement;
let treeSelection = new Set<string>();
let previews = 0;
const treeFiles = [...Array.from({ length: 600 }, (_, index) => ({ path: `docs/nested/item-${index}.md`, kind: "markdown" as const, allowed: true })), { path: "docs/SKILL.md", kind: "markdown" as const, allowed: true }, { path: "docs/run.js", kind: null, allowed: true }, { path: "docs/logo.svg", kind: "svg" as const, allowed: false, reason: "Format not enabled" }];
function TreeFixture() {
	const [selected, setSelected] = useState(new Set<string>());
	treeSelection = selected;
	return createElement(MaterialSelectionTree, { files: treeFiles, selected, onChange: setSelected, onPreview: async (original) => { previews++; return { path: original, kind: "markdown", size: 7, text: "Fixture" }; } });
}

const library: SkillLibrary = { id: "fixture", name: "Fixture library", source: "https://example.test/brand", ref: "brand-main", status: "unchecked", ...defaultRepoPolicy, skillRoot: "skills", referenceRoots: ["assets"], repositoryAccess: { mode: "local-git", rememberLocalAccess: false, checkOnStartup: false, consentVersion: 1 } };
let scan: RepoScanResponse = { token: "first", libraryId: library.id, source: library.source, ref: library.ref, revision: "a".repeat(40), policy: library, skills: ["a", "b", "legacy"].map((name) => ({ name, description: "Synthetic", path: `skills/${name}`, license: "MIT", hasBundledScripts: false })), files: [
	{ path: "assets/guide.md", kind: "markdown", allowed: true },
	{ path: "assets/icon.svg", kind: "svg", allowed: false },
	{ path: "docs/extra.md", kind: "markdown", allowed: true },
	{ path: "README.md", kind: "markdown", allowed: true },
] };
const legacy: SkillListItem = { name: "legacy", description: "Synthetic", body: "Retained instructions", source: "user", protected: false, license: "MIT", rooms: [], fileCount: 0, provenance: { source: library.source, importedAt: "2026-10-14", license: "MIT", repo: { source: library.source, ref: library.ref, revision: scan.revision, skillPath: "skills/legacy", policy: library, references: [] } } };
const imported: string[] = [];
const policyWrites: any[] = [];
const scans: any[] = [];
let acceptedMaterials = 0;
let importedCallback = 0;
let prepared = 0;
let failB = true;
let failMaterials = true;
let expireCandidate = false;
let materialReferences: string[] = [];
let failFormatSave = false;
let failFormatDiscovery = false;
function json(payload: unknown, status = 200) { return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } }); }
globalThis.fetch = (async (input, options) => {
	const route = String(input);
	const request = options?.body ? JSON.parse(String(options.body)) : {};
	if (route === "/api/skills/repo/auth/status") return json({ host: "example.test", provider: null, ready: false, issues: [], setupCommands: [], documentation: "", gitAvailable: true, mode: "anonymous", granted: true, confirmed: false, rememberLocalAccess: false, checkOnStartup: false });
	if (route === "/api/skills/repo/discovery") {
		if (failFormatDiscovery) { failFormatDiscovery = false; return json({ error: "Synthetic rediscovery failure" }, 413); }
		return json({ token: request.token, source: scan.source, revision: scan.revision, referenced: scan.files.slice(0, 2).map((file) => ({ ...file, skillPaths: ["skills/a", "skills/b"], selected: file.allowed })), additional: scan.files.slice(2).map((file) => ({ ...file, skillPaths: [], selected: false })), formats: [...new Set(scan.files.map((file) => file.kind))].filter(Boolean).map((kind) => ({ kind, total: scan.files.filter((file) => file.kind === kind).length, referenced: scan.files.slice(0, 2).filter((file) => file.kind === kind).length, additional: scan.files.slice(2).filter((file) => file.kind === kind).length, enabled: scan.policy.allowedTypes.includes(kind!) })), missing: [], excludedCounts: { program: 3 }, warnings: [], incomplete: false });
	}
	if (route === "/api/skills/libraries/fixture/materials") return json({ manifest: null });
	if (route === "/api/skills/libraries/fixture/reconcile") return json({ library });
	if (route === "/api/skills/libraries/fixture" && options?.method === "PUT") {
		policyWrites.push(request);
		if (failFormatSave) { failFormatSave = false; return json({ error: "Synthetic format save failure" }, 409); }
		scan = { ...scan, policy: { ...scan.policy, ...request, referenceRoots: request.referenceRoots }, files: scan.files.map((file) => ({ ...file, allowed: file.kind === "markdown" || request.allowedTypes.includes(file.kind) })) };
		return json({ library: { ...library, ...request } });
	}
	if (route === "/api/skills/libraries/fixture/scan") { scans.push(request); scan = { ...scan, token: `scan-${scans.length}` }; return json(scan); }
	if (route === "/api/skills/repo/candidate") {
		if (expireCandidate) { expireCandidate = false; return json({ error: "repository snapshot expired", code: "REPOSITORY_SNAPSHOT_EXPIRED" }, 404); }
		prepared++;
		const name = request.path.split("/").at(-1);
		return json({ name, description: "Synthetic", body: `Actual instructions for ${name}`, source: scan.source, license: "MIT", scanFindings: { count: 0, findings: [] }, bundledScripts: [], revision: scan.revision, skillPath: request.path, references: request.references.map((original: string) => ({ path: original, localPath: original, kind: original.endsWith(".svg") ? "svg" : "markdown", size: 7, sha256: "b".repeat(64) })), reviewSha256: "c".repeat(64) });
	}
	if (route === "/api/skills/libraries/fixture/updates/legacy/candidate") {
        prepared++;
        return json({ name: "legacy", description: "Synthetic", body: "Reviewed legacy update", source: scan.source, license: "MIT", scanFindings: { count: 0, findings: [] }, bundledScripts: [], revision: scan.revision, skillPath: "skills/legacy", references: [], reviewSha256: "c".repeat(64), token: request.token, localPackageSha256: "f".repeat(64), affectedRooms: [], changes: [{ path: "[repository library]", status: "modified", before: "Unassigned", after: library.id }] });
    }
    if (route === "/api/skills/libraries/fixture/updates/legacy/apply") { imported.push("skills/legacy"); return json({ skill: { name: "legacy" } }); }
    if (route === "/api/skills/libraries/fixture/materials/candidate") {
		materialReferences = request.references;
		return json({ candidateSha256: "d".repeat(64), expectedCurrentHash: null, manifest: { schemaVersion: 1, libraryId: library.id, materialsSha256: "e".repeat(64), source: scan.source, revision: scan.revision, policy: scan.policy, files: request.references.map((original: string) => ({ path: original, kind: original.endsWith(".svg") ? "svg" : "markdown", size: 7, sha256: "b".repeat(64), mimeType: "text/plain" })) }, added: request.references, removed: [] });
	}
	if (route === "/api/skills/repo/import") {
		imported.push(request.path);
		if (request.path === "skills/b" && failB) { failB = false; return json({ error: "Synthetic interrupted import" }, 409); }
		return json({ skill: { name: request.path.split("/").at(-1) }, provenance: {}, bundledCopied: 0 });
	}
	if (route === "/api/skills/libraries/fixture/materials/accept") { acceptedMaterials++; if (failMaterials) { failMaterials = false; return json({ error: "Synthetic material save failure" }, 409); } return json({ manifest: { materialsSha256: "e".repeat(64) } }); }
	if (route === "/api/skills/repo/preview") { previews++; return json({ path: request.reference, kind: "markdown", size: 7, text: "Preview fixture" }); }
	assert.fail(`Unexpected guided fixture request: ${route}`);
}) as typeof fetch;

try {
	await act(async () => { root.render(createElement(TreeFixture)); await flush(); });
	assert.equal(container.querySelectorAll('.material-selection-file').length, 0, "closed folders do not mount file controls");
	await expandFolders();
	assert.equal(container.querySelectorAll('.material-selection-file input:not(:disabled)').length, 100, "large folders page visible names");
	assert.equal(previews, 0, "rendering never opens files automatically");
	assert(!container.textContent?.includes("SKILL.md") && !container.textContent?.includes("run.js"));
	await act(async () => { checkbox("Select folder docs").click(); });
	assert.equal(treeSelection.size, 600, "folder selection includes every allowed file beyond visible page and old500 cap");
	assert(!treeSelection.has("docs/logo.svg"));
	await act(async () => { checkbox("Select file docs/nested/item-0.md").click(); });
	assert(checkbox("Select folder docs").indeterminate, "partly selected original folders show mixed state");
	assert.equal(checkbox("Select folder docs").getAttribute("aria-checked"), "mixed");
	await act(async () => { (container.querySelector(".skill-reference-path") as HTMLButtonElement).click(); await flush(); });
	await expandFolders();
	assert.equal(previews, 1, "file preview loads only when clicked");
	const search = container.querySelector('input[type="search"]') as HTMLInputElement;
	await act(async () => {
		Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(search, "item-0.md");
		Simulate.change(search);
	});
	assert.equal(container.querySelectorAll(".material-selection-file").length, 1, "search narrows displayed names");
	await act(async () => { checkbox("Select folder docs").click(); });
	assert.equal(treeSelection.size, 600, "a filtered folder still selects all its allowed files");
	await act(async () => { root.render(createElement(GuidedLibraryImport, { library, initialScan: scan, installed: [legacy], onImported: () => { importedCallback++; }, onCancel: () => {} })); await flush(); });
	await expandFolders();
	assert.equal(container.querySelectorAll('[aria-label="Repository access"]').length, 1, "import shows one visible access panel before any authentication error");
	assert(!container.querySelector('[aria-label="Repository access"]')?.closest("[hidden]"));
	assert.deepEqual([...container.querySelectorAll("h3")].filter((node) => !node.closest("[hidden]")).map((node) => node.textContent), ["Fixture library"], "selection has one source heading");
	assert.equal(scans.length, 0, "an initial immutable scan needs no rescan");
	assert.equal(policyWrites.length, 0, "opening an import preserves restricted directories without saving policy");
	await expandFolders();
	assert(checkbox("Select skill a").checked && checkbox("Select skill b").checked && checkbox("Select skill legacy").checked);
	assert(container.textContent?.includes("Review update"), "legacy copies receive the reviewed update flow");
	assert(checkbox("Select file assets/guide.md").checked, "linked materials start selected");
	assert(!checkbox("Select file docs/extra.md").checked, "additional materials start off");
	assert(!checkbox("Select file README.md").disabled, "synthetic eligible files remain selectable");
	assert(checkbox("Select file assets/icon.svg").disabled, "disabled detected format stays visible");
	await act(async () => { button("Include suggested formats").click(); await flush(); });
	await expandFolders();
	assert.equal(policyWrites.length, 1);
	assert(policyWrites[0].designRepo && policyWrites[0].allowedTypes.includes("svg"));
	assert.deepEqual(policyWrites[0].referenceRoots, ["assets"], "format changes retain approved directory boundaries");
	assert(!("repositoryAccess" in policyWrites[0]));
	assert.equal(scans[0].token, "first", "format changes reuse the same Git snapshot");
	await expandFolders();
	assert(checkbox("Select file assets/icon.svg").checked && !checkbox("Select file assets/icon.svg").disabled);
	assert.equal(previews, 1, "format changes do not open file previews");
	const proposalTree = container.querySelector(".material-selection-tree")!;
	const proposalSearch = proposalTree.querySelector('input[type="search"]') as HTMLInputElement;
	await act(async () => {
		Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(proposalSearch, "assets");
		Simulate.change(proposalSearch);
	});
	const proposalFolder = proposalTree.querySelector('details.material-selection-folder') as HTMLDetailsElement;
	proposalFolder.open = true;
	container.scrollTop = 270;
	await act(async () => { button("Prepare review").click(); await flush(); });
	await expandFolders();
	assert.equal(container.scrollTop, 0, "a completed review starts at its title");
	assert.deepEqual([...container.querySelectorAll("h3")].filter((node) => !node.closest("[hidden]")).map((node) => node.textContent), ["Review Fixture library"], "review replaces the heading rather than adding another title");
	assert(proposalTree.closest("[hidden]"), "prepared review hides the selection tree without unmounting it");
	await act(async () => { button("Change selection").click(); await flush(); });
	await expandFolders();
	assert.equal(container.scrollTop, 270, "change selection restores the previous scroll position");
	assert.equal(container.querySelector(".material-selection-tree"), proposalTree, "review/back retains the same selection subtree");
	assert.equal(proposalSearch.value, "assets");
	assert(proposalFolder.open, "review/back preserves an opened original folder");
	await act(async () => { button("Prepare review").click(); await flush(); });
	await expandFolders();
	assert.equal(prepared, 6);
	assert(container.textContent?.includes("[repository library]"), "first binding is disclosed before apply");
	assert.deepEqual(materialReferences.sort(), ["assets/guide.md", "assets/icon.svg"]);
	assert.equal(imported.length + acceptedMaterials, 0, "combined review prepares all candidates before any import");
	assert(container.textContent?.includes("Actual instructions for a"));
	assert(container.textContent?.includes("Actual instructions for b"));
	assert(!button("guide.md").disabled, "read-only review still permits click-only previews");
	await act(async () => { button("Accept and save library").click(); await flush(); });
	await expandFolders();
	assert.equal(importedCallback, 0);
	assert(container.textContent?.includes("Partly saved."));
	assert.deepEqual(imported, ["skills/a", "skills/b", "skills/legacy"]);
	await act(async () => { button("Retry failed items").click(); await flush(); });
	await expandFolders();
	assert.deepEqual(imported, ["skills/a", "skills/b", "skills/legacy", "skills/b"], "successful skill imports are never replayed");
	assert.equal(acceptedMaterials, 2);
	assert.equal(importedCallback, 1);

	await act(async () => { root.render(createElement(GuidedLibraryImport, { key: "expiration", library, initialScan: scan, installed: [legacy], onImported: () => {}, onCancel: () => {} })); await flush(); });
	await expandFolders();
	await act(async () => { checkbox("Select file assets/guide.md").click(); });
	assert(!checkbox("Select file assets/guide.md").checked);
	expireCandidate = true;
	await act(async () => { button("Prepare review").click(); await flush(); });
	await expandFolders();
	assert(container.textContent?.includes("Repository review needs a fresh scan"));
	await act(async () => { button("Scan again and keep selection").click(); await flush(); });
	await expandFolders();
	assert.equal(scans.at(-1).forceRefresh, true);
	assert(!checkbox("Select file assets/guide.md").checked, "explicit deselections survive expiration recovery");
	assert(checkbox("Select file assets/icon.svg").checked, "checked files survive expiration recovery");
	assert(!checkbox("Select file docs/extra.md").checked);

	scan = { ...scan, token: "format-snapshot", policy: { ...library, referenceRoots: [""] }, files: [...scan.files.map((file) => ({ ...file, allowed: file.kind === "markdown" })), { path: "docs/guide.pdf", kind: "pdf", allowed: false }, { path: "assets/photo.png", kind: "images", allowed: false }] };
	await act(async () => { root.render(createElement(GuidedLibraryImport, { key: "kind-controls", library: { ...library, referenceRoots: [""] }, initialScan: scan, installed: [legacy], onImported: () => {}, onCancel: () => {} })); await flush(); });
	await expandFolders();
	assert(checkbox("Include SVG materials").classList.contains("workspaces-tool-switch"));
	assert(!checkbox("Include CSS / SCSS materials"), "only found formats receive controls");
	const beforeKindScans = scans.length;
	await act(async () => { checkbox("Include SVG materials").click(); await flush(); });
	await expandFolders();
	assert(checkbox("Include SVG materials").checked);
	assert(!checkbox("Include PDF materials").checked && !checkbox("Include Images materials").checked);
	assert.deepEqual(policyWrites.at(-1).allowedTypes, ["markdown", "svg"], "one format switch never enables other detected kinds");
	assert.equal(scans.at(-1).token, "format-snapshot", "per-kind format changes derive the same reviewed commit");
	assert(checkbox("Select file assets/icon.svg").checked);
	await act(async () => { checkbox("Include SVG materials").click(); await flush(); });
	await expandFolders();
	assert(!checkbox("Select file assets/icon.svg").checked && checkbox("Select file assets/icon.svg").disabled, "explicit format disable deselects those paths");
	failFormatSave = true;
	await act(async () => { checkbox("Include PDF materials").click(); await flush(); });
	await expandFolders();
	assert(container.textContent?.includes("Synthetic format save failure"));
	assert(button("Prepare review").disabled);
	await act(async () => { button("Retry").click(); await flush(); });
	await expandFolders();
	assert(!checkbox("Include PDF materials").checked, "failed format save rolls the switch back");
	failFormatDiscovery = true;
	await act(async () => { checkbox("Include SVG materials").click(); await flush(); });
	await expandFolders();
	assert(button("Prepare review").disabled, "failed rediscovery cannot prepare stale references");
	await act(async () => { button("Retry").click(); await flush(); });
	await expandFolders();
	assert(!checkbox("Include SVG materials").checked, "failed rediscovery restores both settings and switch");
	assert.deepEqual(policyWrites.at(-1).allowedTypes, ["markdown"]);
	assert(!checkbox("Select file assets/icon.svg").checked);
	assert(scans.slice(beforeKindScans).every((request) => request.token && !request.forceRefresh), "format changes and rollback never request a fresh clone");
	await act(async () => { button("Include suggested formats").click(); await flush(); });
	await expandFolders();
	assert(checkbox("Include SVG materials").checked && checkbox("Include PDF materials").checked && checkbox("Include Images materials").checked, "bulk suggestion remains available beside per-kind controls");
	failFormatDiscovery = true;
	const scanCountBeforeRetry = scans.length;
	await act(async () => { root.render(createElement(GuidedLibraryImport, { key: "initial-discovery-failure", library: { ...library, referenceRoots: [""] }, initialScan: scan, installed: [legacy], onImported: () => {}, onCancel: () => {} })); await flush(); });
	await expandFolders();
	assert(container.querySelector('input[aria-label="Select skill a"]'), "failed linked-reference analysis keeps the already found metadata visible");
	assert(button("Retry"), "early metadata does not remove the retry for failed initial reference analysis");
	await act(async () => { button("Retry").click(); await flush(); });
	await expandFolders();
	assert.equal(scans.length, scanCountBeforeRetry, "retrying reference analysis reuses its repository structure");
	assert(checkbox("Select file assets/guide.md"));
	const ordinaryFetch = globalThis.fetch;
	let finishDiscovery!: () => Promise<void>;
	let progressPolls = 0;
	globalThis.fetch = (async (input, options) => {
		if (String(input).startsWith("/api/skills/repo/progress/")) {
			progressPolls++;
			return progressPolls === 1 ? json({ error: "Synthetic unavailable progress" }, 503) : json({ progress: { message: "Following linked references", completed: 5, total: 7, status: "running" } });
		}
		if (String(input) === "/api/skills/repo/discovery") return new Promise<Response>((resolve) => { finishDiscovery = async () => { resolve(await ordinaryFetch(input, options)); }; });
		return ordinaryFetch(input, options);
	}) as typeof fetch;
	const progressProps = { library: { ...library, referenceRoots: [""] }, initialScan: scan, installed: [legacy], onImported: () => assert.fail("progress never imports"), onCancel: () => {} };
	await act(async () => { root.render(createElement(GuidedLibraryImport, { ...progressProps, key: "slow-progress" })); await flush(); });
	await expandFolders();
	assert(container.querySelector('input[aria-label="Select skill a"]'), "found skill metadata is visible before linked-reference analysis completes");
	assert(checkbox("Select skill a").disabled, "mounting the access panel does not clear an in-progress import's busy state");
	assert(container.textContent?.includes(`${scan.files.length} repository entries`));
	assert(!container.querySelector("progress")!.hasAttribute("value"), "unknown work has an indeterminate indicator instead of a guessed percentage");
	await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1150)); await flush(); });
	await expandFolders();
	assert(container.querySelector('.repo-import-progress[role="status"]')?.textContent?.includes("Following linked references · 5 / 7"));
	assert.equal(container.querySelector("progress")?.getAttribute("value"), "5");
	assert.equal(container.querySelector("progress")?.getAttribute("max"), "7");
	assert(!container.querySelector('[role="alert"]'), "a lost progress response does not fail the import flow");
	await act(async () => { await finishDiscovery(); await flush(); });
	await expandFolders();
	assert(!container.querySelector(".repo-import-progress"), "finished analysis removes its busy indicator");
	const finishedPolls = progressPolls;
	await new Promise((resolve) => setTimeout(resolve, 650));
	assert.equal(progressPolls, finishedPolls, "polling stops when the request finishes");
	await act(async () => { root.render(createElement(GuidedLibraryImport, { ...progressProps, key: "leave-progress" })); await flush(); });
	await act(async () => { root.render(createElement(TreeFixture)); await flush(); });
	const leftPolls = progressPolls;
	await new Promise((resolve) => setTimeout(resolve, 650));
	assert.equal(progressPolls, leftPolls, "leaving the view stops its progress polling");
	await finishDiscovery(); await flush();
	globalThis.fetch = ordinaryFetch;
	console.log("guided-library-import smoke passed");
} finally {
	await act(async () => root.unmount());
	globalThis.fetch = previousFetch;
	for (const [index, name] of names.entries()) { const descriptor = previousGlobals[index]; if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as any)[name]; }
	dom.window.close();
}
