import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { SkillLibraries } from "../src/components/SkillLibraries";
import { defaultRepoPolicy, type SkillLibrary } from "../src/skills-repo-api";
import type { SkillListItem } from "../src/skills-api";

const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost/" });
// React is imported before JSDOM, so its legacy focus polyfill needs these test-only hooks.
Object.assign(dom.window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} });
const oldFetch = globalThis.fetch;
const names = ["window", "document", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
const oldGlobals = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const library: SkillLibrary = { id: "navigation", name: "Navigation fixture", source: "https://example.test/native", status: "checking", ...defaultRepoPolicy };
let libraries = [library];
const skill: SkillListItem = { name: "a", description: "Synthetic", body: "Local instructions", source: "user", protected: false, license: "MIT", fileCount: 0, rooms: [], provenance: { source: library.source, importedAt: "2026-10-14", license: "MIT", repo: { libraryId: library.id, source: library.source, revision: "a".repeat(40), skillPath: "skills/a", policy: library, references: [] } } };
let scans = 0;
let saves = 0;
let failSave = true;
let libraryReads = 0;
let skillReads = 0;
let createdInput: any;
const json = (data: unknown, status = 200) => Response.json(data, { status });
globalThis.fetch = (async (input, init) => {
	const route = String(input);
	const body = init?.body ? JSON.parse(String(init.body)) : {};
	if (route === "/api/skills/repo/auth/status") return json({ host: "example.test", provider: null, ready: false, issues: [], setupCommands: [], documentation: "", gitAvailable: true, mode: "anonymous", granted: false, confirmed: false, rememberLocalAccess: false, checkOnStartup: false });
	if (route === "/api/skills/libraries" && init?.method === "POST") { createdInput = body; const featured = { ...body, name: "Featured fixture", id: `created-${libraries.length}`, status: "unchecked" }; libraries = [...libraries, featured]; return json({ library: featured }); }
	if (route === "/api/skills/libraries") {
		libraryReads++;
		if (libraryReads === 2) libraries = libraries.map((entry) => entry.id === library.id ? { ...entry, status: "updates" } : entry);
		return json({ libraries });
	}
	if (route === "/api/skills?view=summary") { skillReads++; return json([skill]); }
	if (route === "/api/skills/libraries/navigation/materials") return json({ manifest: null });
	if (route === "/api/skills/libraries/navigation" && init?.method === "PUT") {
		saves++;
		if (failSave) { failSave = false; return json({ error: "Synthetic settings save failure" }, 409); }
		libraries = [{ ...library, ...body, status: "unchecked" }, ...libraries.filter((entry) => entry.id !== library.id)];
		return json({ library: libraries[0] });
	}
	if (route === "/api/skills/featured?view=catalog") return json({ sources: [{ source: "https://example.test/featured", author: "Featured author" }] });
	if (route.endsWith("/scan")) { scans++; return json({ error: "Synthetic offline source" }, 400); }
	assert.fail(`Unexpected navigation fixture request: ${route}`);
}) as typeof fetch;
const container = dom.window.document.getElementById("root")!;
const root = createRoot(container);
const flush = async () => { for (let pass = 0; pass < 5; pass++) await new Promise<void>((resolve) => setImmediate(resolve)); };
const visible = (node: Element) => !node.closest("[hidden]");
async function click(label: string) {
	const target = [...container.querySelectorAll("button")].find((button) => visible(button) && (button.textContent === label || button.querySelector("strong")?.textContent === label || button.getAttribute("aria-label") === label));
	assert(target && !target.disabled, `enabled navigation button ${label}`);
	await act(async () => { target.click(); await flush(); });
}
async function escape() { await act(async () => { dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await flush(); }); }

try {
	await act(async () => { root.render(createElement(SkillLibraries, { onImported: () => assert.fail("navigation must not import") })); await flush(); });
	assert.equal(scans, 0, "opening the library overview is metadata-only");
	assert(container.textContent?.includes("Checking for updates…"), "startup checking status is shown while local navigation stays usable");
	assert.equal(container.querySelectorAll(".skill-library-source .icon-btn").length, 2, "one update icon and one actions menu replace the old button row");
	await click("Navigation fixture");
	await click("Files");
	await click("Open folder skills");
	await click("Open folder skills/a");
	await click("SKILL.md");
	assert([...container.querySelectorAll(".skill-file-preview")].some(visible));
	assert.equal(scans, 0);
	const skillReadsBeforePoll = skillReads;
	await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2100)); await flush(); });
	assert.equal(libraryReads, 2, "the checking source polls its saved status metadata after two seconds");
	assert.equal(skillReads, skillReadsBeforePoll, "checking poll does not reload skill lists or reference bytes");
	assert.equal(scans, 0, "checking-status polling never starts a Git scan");
	assert([...container.querySelectorAll("button")].filter(visible).some((button) => button.textContent === "Review updates"), "completed checking status updates the open source action");
	assert([...container.querySelectorAll('.repo-browser-breadcrumbs button[aria-current="location"]')].filter(visible).some((button) => button.textContent === "a"), "status polling leaves the current local folder intact");
	assert([...container.querySelectorAll(".skill-file-preview")].some(visible), "local preview remains available through polling");
	await click("Repositories");
	await escape();
	await click("Navigation fixture");
	assert([...container.querySelectorAll('.repo-browser-breadcrumbs button[aria-current="location"]')].filter(visible).some((button) => button.textContent === "a"), "normal back/reopen retains the source folder");
	assert([...container.querySelectorAll(".skill-file-preview")].some(visible), "hidden preview layers do not intercept overview Escape");
	await escape();
	assert(![...container.querySelectorAll(".skill-file-preview")].some(visible), "the first source Escape closes the visible preview");
	assert([...container.querySelectorAll('.repo-browser-breadcrumbs button[aria-current="location"]')].filter(visible).some((button) => button.textContent === "a"));
	await escape();
	assert([...container.querySelectorAll(".skill-library-source-open")].some(visible), "Escape returns from a source to the overview");
	await click("Actions for Navigation fixture");
	await click("Settings");
	assert(container.querySelector('[aria-label="Repository access"]'), "source settings show access controls without another toggle");
	assert(container.textContent?.includes("Confirm repository access"), "old libraries show their required access confirmation");
	const design = () => [...container.querySelectorAll('input[role="switch"]')].find(visible) as HTMLInputElement;
	assert(!design().checked && design().classList.contains("workspaces-tool-switch"));
	await act(async () => { design().click(); await flush(); });
	assert.equal(saves, 1, "a switch saves immediately without an extra Save button");
	assert(!design().checked, "failed automatic save rolls back the switch");
	assert(container.querySelector('[role="alert"]')?.textContent?.includes("Synthetic settings save failure"));
	await act(async () => { design().click(); await flush(); });
	assert.equal(saves, 2);
	assert(design().checked);
	const format = (label: string) => [...container.querySelectorAll(".skill-reference-types label")].find((node) => visible(node) && node.textContent === label)?.querySelector("input") as HTMLInputElement;
	assert.equal(container.querySelectorAll('.skill-reference-types input[role="switch"]').length, 9, "editing exposes each optional format using the app switch");
	assert(!format("PDF").checked && !format("Fonts").checked, "design mode does not silently enable binary formats");
	await act(async () => { format("PDF").click(); await flush(); });
	assert(format("PDF").checked && libraries[0].allowedTypes.includes("pdf"), "editing a format persists immediately");
	failSave = true;
	await act(async () => { format("Fonts").click(); await flush(); });
	assert(!format("Fonts").checked && !libraries[0].allowedTypes.includes("fonts"), "failed format save rolls back selection");
	assert(container.querySelector('[role="alert"]')?.textContent?.includes("Synthetic settings save failure"));
    const scopes = container.querySelector(".skill-repo-policy textarea") as HTMLTextAreaElement;
    const savesBeforeDirectories = saves;
    await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(scopes, "assets\n"); Simulate.change(scopes); await flush();
    });
    assert.equal(scopes.value, "assets\n", "directory drafts retain newlines while typing");
    assert.equal(saves, savesBeforeDirectories, "directory typing does not write per key");
    await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(scopes, "assets\nshared"); Simulate.change(scopes); await flush();
    });
    await act(async () => { Simulate.blur(scopes); await flush(); });
    assert.equal(saves, savesBeforeDirectories + 1);
    assert.deepEqual(libraries[0].referenceRoots, ["assets", "shared"], "only explicit scoped changes are saved");

	await escape();
	assert([...container.querySelectorAll(".skill-library-source-open")].some(visible), "Escape closes settings before the surrounding overview");
	await click("Add featured");
	assert.equal(scans, 0, "featured names load from the catalog without Git");
	await escape();
	await click("Add featured");
	await click("Featured author");
	assert.equal(scans, 1, "only choosing a featured source reads its repository");
	assert(container.textContent?.includes("Synthetic offline source"));
	await click("Cancel");
	assert.equal(scans, 1, "cancelled import does not scan again or import files");
	await act(async () => { root.render(createElement(SkillLibraries, { key: "removed-source", initialLibraryId: "removed", onImported: () => assert.fail("navigation must not import") })); await flush(); });
	assert(container.querySelector('[role="status"]')?.textContent?.includes("approved room references remain available"), "a removed source target has a visible explanation instead of an empty pane");
	await click("Repositories");
	assert([...container.querySelectorAll(".skill-library-source-open")].some(visible), "removed-source navigation has a usable return to the registry");
	assert.equal(scans, 1);
	await click("Add custom");
	const advanced = container.querySelector(".skill-library-form details") as HTMLDetailsElement;
	advanced.open = true;
	const newDesign = container.querySelector('.skill-library-form input[role="switch"]') as HTMLInputElement;
	await act(async () => { newDesign.click(); await flush(); });
	assert(format("PDF") && !format("PDF").checked, "initial setup exposes optional formats before scanning");
	await act(async () => { format("PDF").click(); format("Images").click(); await flush(); });
	const urlInput = container.querySelector('.skill-library-form input[placeholder="https://github.com/user/repo"]') as HTMLInputElement;
	await act(async () => {
		Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(urlInput, "https://example.test/custom");
		Simulate.change(urlInput);
		await flush();
	});
	await click("Continue");
	assert.deepEqual(createdInput.allowedTypes.sort(), ["images", "markdown", "pdf"], "initial creation submits exactly the chosen formats");
	assert.equal(createdInput.designRepo, true);
	assert.deepEqual(createdInput.referenceRoots, [], "a new source starts with narrow default scopes");
	assert.equal(scans, 2, "choosing formats alone never scans or imports contents");
	console.log("skill-libraries-navigation smoke passed");
} finally {
	await act(async () => root.unmount());
	globalThis.fetch = oldFetch;
	for (const [index, name] of names.entries()) { const descriptor = oldGlobals[index]; if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as any)[name]; }
	dom.window.close();
}
