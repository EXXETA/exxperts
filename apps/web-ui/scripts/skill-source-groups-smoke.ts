import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { groupSkillsBySource } from "../src/skill-source-copy";
import { SkillsPage } from "../src/components/SkillsPage";
import { SkillSourceBrowser } from "../src/components/SkillSourceBrowser";
import type { SkillListItem } from "../src/skills-api";
import { defaultRepoPolicy, type RepoScanResponse } from "../src/skills-repo-api";

function skill(name: string, source: string, origin?: string, locallyModified = false): SkillListItem {
	return { name, description: "Synthetic", body: "Synthetic instructions.", source, protected: source !== "user", license: null, rooms: [], fileCount: 0, locallyModified, provenance: origin ? { source: origin, importedAt: "2026-01-01T00:00:00Z", license: "MIT" } : null };
}
const fixtures = [
	skill("built-in", "builtin"), skill("shared-skill", "shared"), skill("project-skill", "project"),
	skill("brand-a", "user", "https://example.invalid/team/brand.git#main"),
	skill("brand-b", "user", "git@example.invalid:team/brand.git"),
	skill("other-brand", "user", "https://secret@example.invalid/partner/brand.git/"),
	skill("local", "user", "local"), skill("upload", "user", "upload"), skill("manual", "user"),
	skill("adapted", "user", "https://example.invalid/team/brand", true),
	skill("unknown", "user", "javascript:alert(1)"),
].sort((a, b) => a.name.localeCompare(b.name));
const groups = groupSkillsBySource(fixtures);
for (const entry of fixtures.filter((skill) => ["brand-a", "brand-b", "adapted"].includes(skill.name))) entry.provenance!.repo = { libraryId: "brand", source: entry.provenance!.source, revision: "b".repeat(40), skillPath: `skills/${entry.name}`, policy: defaultRepoPolicy, references: [] };
const library = { id: "brand", name: "Brand", source: "https://example.invalid/team/brand.git", status: "current", ...defaultRepoPolicy, skillRoot: "skills" };
const scan: RepoScanResponse = { token: "source-snapshot", source: library.source, libraryId: library.id, revision: "b".repeat(40), policy: library, skills: fixtures.filter((skill) => skill.provenance?.repo).map((skill) => ({ name: skill.name, path: skill.provenance!.repo!.skillPath, description: skill.description, license: null, hasBundledScripts: false })), files: [
	{ path: "skills/brand-a/SKILL.md", kind: "markdown", allowed: true },
	{ path: "skills/brand-b/SKILL.md", kind: "markdown", allowed: true },
	{ path: "shared/logo.svg", kind: "svg", allowed: false },
	{ path: "docs/guide.md", kind: "markdown", allowed: false },
] };
const materialManifest = { schemaVersion: 1, libraryId: library.id, materialsSha256: "c".repeat(64), source: library.source, revision: scan.revision, policy: library, files: [{ path: "shared/logo.svg", kind: "svg", size: 12, sha256: "d".repeat(64), mimeType: "image/svg+xml" }, { path: "docs/guide.md", kind: "markdown", size: 12, sha256: "e".repeat(64), mimeType: "text/plain" }] };
let scans = 0;
let failScan = true;
let previews = 0;
const writes: any[] = [];
assert.deepEqual(groups.slice(0, 3).map((group) => group.key), ["builtin", "shared", "project"]);
assert.deepEqual(groups.find((group) => group.label === "example.invalid/team/brand")?.skills.map((skill) => skill.name), ["adapted", "brand-a", "brand-b"], "source provenance stays visible after local edits");
assert.equal(groups.filter((group) => group.key.startsWith("repo:")).length, 2, "different repository paths remain separate");
assert(!JSON.stringify(groups.map((group) => group.label)).includes("secret"), "group headings omit URL credentials");
assert.deepEqual(groups.at(-1)?.skills.map((skill) => skill.name), ["local", "manual", "unknown", "upload"]);
assert.equal(groupSkillsBySource([fixtures.find((skill) => skill.source === "builtin")!]).find((group) => group.key === "custom")?.skills.length, 0, "custom section remains available when empty");

const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost/" });
const previousFetch = globalThis.fetch;
const globals = ["window", "document", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
const previous = globals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
globalThis.fetch = (async (input, init) => {
	const url = String(input).split("?")[0];
	let payload: unknown;
	if (url === "/api/skills") payload = fixtures;
	else if (url === "/api/skills/repo/auth/status") payload = { host: "example.invalid", provider: null, ready: false, issues: [], setupCommands: [], documentation: "", gitAvailable: true, mode: "anonymous", granted: true, confirmed: false, rememberLocalAccess: false, checkOnStartup: false };
	else if (url === "/api/remote/client-context") payload = { remote: false, capability: "full" };
	else if (url === "/api/skills/libraries") payload = { libraries: [library] };
	else if (url === "/api/skills/libraries/brand/materials") payload = { manifest: materialManifest };
	else if (url === `/api/skills/libraries/brand/materials/${materialManifest.materialsSha256}/preview`) { previews++; payload = { path: JSON.parse(String(init?.body)).reference, kind: "svg", size: 12, text: "<svg></svg>" }; }
	else if (url === "/api/skills/repo/discovery") payload = { token: scan.token, source: scan.source, revision: scan.revision, referenced: [], additional: scan.files.filter((file) => !file.path.endsWith("SKILL.md")).map((file) => ({ ...file, skillPaths: [], selected: false })), formats: [], missing: [], excludedCounts: {}, warnings: [], incomplete: false };
	else if (url === "/api/skills/libraries/brand/scan") { scans++; if (failScan) { failScan = false; throw new Error("Synthetic offline scan"); } payload = scan; }
	else if (url === "/api/skills/libraries/brand" && init?.method === "PUT") { writes.push(JSON.parse(String(init.body))); payload = { library: { ...library, ...writes.at(-1), referenceRoots: [""] } }; scan.policy = { ...scan.policy, referenceRoots: [""] }; }
	else if (url === "/api/skills/repo/preview") { previews++; assert.equal(JSON.parse(String(init?.body)).reference, "shared/logo.svg"); payload = { path: "shared/logo.svg", kind: "svg", size: 12, text: "<svg></svg>" }; }
	else assert.fail(`unexpected fixture request: ${url}`);
	return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
}) as typeof fetch;
const container = dom.window.document.getElementById("root")!;
const root = createRoot(container);
try {
	await act(async () => { root.render(createElement(SkillsPage)); await new Promise<void>((resolve) => setImmediate(resolve)); });
	const toggle = container.querySelector(".skill-source-toggle input") as HTMLInputElement;
	assert(toggle.checked, "source grouping is the default");
	assert(toggle.classList.contains("workspaces-tool-switch"), "grouping reuses the Web search switch style");
	assert.equal(toggle.getAttribute("role"), "switch");
	assert.equal(toggle.closest(".skill-library-controls")?.parentElement?.className, "pane-head-actions", "grouping belongs to the Skills header actions");
	assert.equal(toggle.closest(".skill-library-controls")?.firstElementChild?.className, "skill-library-buttons", "the switch appears below the existing library buttons");
	assert.equal(container.querySelectorAll(".skill-source-group").length, groups.length);
	assert.equal(container.querySelectorAll(".skill-row").length, fixtures.length, "grouping keeps every existing row and its action");
	assert(!container.querySelector('section[aria-label="Custom"]')?.textContent?.includes("adapted"));
	await act(async () => toggle.click());
	assert(!toggle.checked);
	assert.equal(container.querySelectorAll(".skill-source-group").length, 0);
	assert.deepEqual([...container.querySelectorAll(".skill-table-name")].map((node) => node.textContent), fixtures.map((skill) => skill.name), "flat view retains the full API order");
	await act(async () => toggle.click());
	assert.equal(container.querySelectorAll(".skill-source-group").length, groups.length);
	const sourceButton = container.querySelector(".skill-source-link") as HTMLButtonElement;
	assert.equal(sourceButton.textContent, "example.invalid/team/brand");
	await act(async () => sourceButton.click());
	const button = (text: string) => [...container.querySelectorAll("button")].find((node) => node.textContent === text)!;
	assert(container.textContent?.includes("Saved skills"), "a source opens its saved skills immediately");
	assert.equal(scans, 0, "opening a source never starts Git");
	await act(async () => button("Files").click());
	assert(container.querySelector('section[aria-label="Local repository files"]'));
	assert(container.querySelector('button[aria-label="Open folder docs"]'));
	assert(container.querySelector('button[aria-label="Open folder shared"]'), "accepted shared source assets retain their original top-level folders");
	assert(container.textContent?.includes("5 saved files · 3 skills"));
	assert.equal(writes.length, 0, "opening a source never changes reference permissions or imports files");
	await act(async () => (container.querySelector('button[aria-label="Open folder shared"]') as HTMLButtonElement).click());
	assert.equal(previews, 0, "browsing saved folders never opens their files automatically");
	await act(async () => button("logo.svg").click());
	assert.equal(previews, 1);
	assert(container.querySelector('iframe[title="shared/logo.svg"]'), "an accepted local asset renders when clicked");
	await act(async () => dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
	assert(!container.querySelector('iframe[title="shared/logo.svg"]'), "the same control closes its preview");
	await act(async () => button("Skills").click());
	await act(async () => button("Files").click());
	assert(container.querySelector('.repo-browser-breadcrumbs button[aria-current="location"]')?.textContent === "shared", "tab changes retain the local folder");
	assert.equal(scans, 0);
	await act(async () => button("Add references").click());
	assert(container.textContent?.includes("Synthetic offline scan"), "network failure affects only the explicit add flow");
	await act(async () => button("Retry").click());
	assert.equal(scans, 2, "retry performs one scan without an implicit policy rescan");
	await act(async () => button("Cancel").click());
	assert(container.querySelector('.repo-browser-breadcrumbs button[aria-current="location"]')?.textContent === "shared", "returning from guided import preserves the local folder");
	assert.equal(writes.length, 0, "opening and cancelling the material flow preserve reference permissions");
	await act(async () => (container.querySelector('nav[aria-label="Skills navigation"] button') as HTMLButtonElement).click());
	assert.equal(container.querySelectorAll(".skill-source-group").length, groups.length, "back returns to the existing grouped list");
	const scansBeforeRemote = scans;
	await act(async () => root.render(createElement(SkillSourceBrowser, { skills: fixtures.filter((skill) => skill.provenance?.repo), readOnly: true, onImported: () => assert.fail("remote import") })));
	assert(!button("Add references"));
	await act(async () => button("Files").click());
	assert(container.querySelector('section[aria-label="Local repository files"]'));
	assert.equal(scans, scansBeforeRemote, "remote clients never gain repository scans");
	console.log("Skill source groups smoke passed.");
} finally {
	await act(async () => root.unmount());
	globalThis.fetch = previousFetch;
	globals.forEach((name, index) => { const descriptor = previous[index]; if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as any)[name]; });
	dom.window.close();
}
