import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { SkillSourceBrowser } from "../src/components/SkillSourceBrowser";
import { SkillLibraries } from "../src/components/SkillLibraries";
import { defaultRepoPolicy, type SkillReference, type SkillLibrary } from "../src/skills-repo-api";
import type { SkillListItem } from "../src/skills-api";

const reference: SkillReference = { path: "brands/a/colors.svg", description: "Synthetic palette.", localPath: ".skill-references/brands/a/colors.svg", kind: "svg", size: 42, sha256: "a".repeat(64) };
function skill(name: string, libraryId: string, skillPath = `skills/${name}`): SkillListItem {
	return { name, description: "Synthetic", body: "Saved local instructions.", source: "user", protected: false, license: "MIT", rooms: [], fileCount: 1, provenance: { source: "https://example.invalid/brand", importedAt: "2026-10-13T00:00:00Z", license: "MIT", repo: { libraryId, source: "https://example.invalid/brand", revision: "b".repeat(40), skillPath, policy: defaultRepoPolicy, references: [reference] } } };
}
const skills = [skill("brand-a", "library-a"), skill("brand-b", "library-a"), skill("other-brand", "library-b"), skill("root-skill", "library-a", "")];
skills[1].provenance!.repo!.references = [{ ...reference, sha256: "c".repeat(64) }];
const library = { ...defaultRepoPolicy, id: "library-a", name: "Synthetic library", source: "https://example.invalid/brand", status: "error", error: "Source offline" };
const calls: string[] = [];
const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost/" });
const previousFetch = globalThis.fetch;
const globals = ["window", "document", "navigator", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
const previous = globals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: dom.window.navigator });
const { createRoot } = await import("react-dom/client");
let fileStatus = 200;
let previewText = '<svg onload="alert(1)"><script>must stay inert</script></svg>';
globalThis.fetch = (async (input) => {
	const url = String(input);
	if (url === "/api/remote/client-context") return Response.json({ remote: false, capability: "full" });
	if (url === "/api/skills/update-notices") return Response.json({ libraries: [] });
	calls.push(url);
	if (url === "/api/skills/libraries") return Response.json({ libraries: [library] });
	if (url === "/api/skills?view=summary") return Response.json(skills);
	if (url === "/api/skills/libraries/library-a/materials") return Response.json({ manifest: null });
	assert(/^\/api\/skills\/(?:brand-a|brand-b)\/references\/brands%2Fa%2Fcolors\.svg\/preview$/.test(url), `unexpected request (no Git scan permitted): ${url}`);
	return fileStatus === 200 ? Response.json({ path: reference.path, kind: "svg", size: 42, text: previewText }) : Response.json({ error: "Local file unavailable" }, { status: fileStatus });
}) as typeof fetch;
const container = dom.window.document.getElementById("root")!;
const root = createRoot(container);
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
async function click(label: string) {
	const button = [...container.querySelectorAll("button")].find((node) => node.textContent === label || node.querySelector("strong")?.textContent === label);
	assert(button, `button: ${label}`);
	await act(async () => { button.click(); await settle(); });
}
async function search(value: string) {
	const input = container.querySelector('input[aria-label="Search local repository files"]')!;
	await act(async () => {
		Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
		input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
		await settle();
	});
}
try {
	await act(async () => { root.render(createElement(SkillLibraries, { onImported: () => assert.fail("browsing must not import") })); await settle(); });
	await click("Synthetic library");
	await click("Files");
	assert.deepEqual(calls, ["/api/skills/libraries", "/api/skills?view=summary", "/api/skills/libraries/library-a/materials"], "opening local files needs saved metadata only, even with an offline source");
	assert(container.textContent?.includes("4 saved files · 3 skills"), "the tree explicitly counts saved files, not source inventory");
	assert.equal(container.querySelector(".repo-browser-title h3")?.textContent, "Saved local files");
	assert(!container.textContent?.includes("other-brand"));
	assert(!container.textContent?.includes("Only imported instructions"), "guidance stays behind the information control");
	assert.equal(container.querySelectorAll(".repo-browser-local-row").length, 1, "root files and top-level folders are shown instead of nested skill cards");
	await click("▸ brands/1 files");
	await click("▸ a/1 files");
	assert.equal(calls.length, 3, "folder navigation never reads file contents or scans Git");
	assert.equal(container.querySelectorAll(".skill-file-open").length, 2, "different reviewed versions of one shared path remain available");
	assert.equal(container.querySelector(".skill-reference-path[title]")?.getAttribute("title"), reference.path);
	assert(container.querySelector(".skill-reference-description")?.textContent === reference.description);
	const preview = container.querySelector(".skill-file-row .rs-text-btn") as HTMLButtonElement;
	assert(preview.textContent?.startsWith("colors.svg · brand-a"));
	await act(async () => { preview.click(); await settle(); });
	assert(container.querySelector("iframe")?.getAttribute("sandbox") === "", "SVG renders only in an isolated frame after clicking");
	await click("Source");
	assert(container.querySelector("pre.skill-reference-preview")?.textContent?.includes("<svg onload="));
	assert(!container.querySelector("svg, script, img"), "source is escaped, never executed");
	await act(async () => { preview.click(); await settle(); });
	assert(!container.querySelector(".skill-file-preview"), "clicking the filename again closes the preview");
	assert.equal(calls.length, 4, "closing a preview reads no additional files");
	await click("Repository root");
	await click("▸ skills/2 files");
	await click("▸ brand-a/1 files");
	await click("SKILL.md");
	assert(container.querySelector(".skill-doc")?.textContent?.includes("Saved local instructions."));
	assert.equal(calls.length, 4, "local instructions are already in the loaded skill metadata");
	await search("brand-b");
	assert.equal(container.querySelectorAll(".repo-browser-local-row").length, 1);
	assert.equal(container.querySelector(".skill-file-row .rs-text-btn")?.getAttribute("title"), "skills/brand-b/SKILL.md");
	await search("colors.svg");
	const otherPreview = container.querySelectorAll(".skill-file-row .rs-text-btn")[1] as HTMLButtonElement;
	fileStatus = 400;
	await act(async () => { otherPreview.click(); await settle(); });
	assert(container.querySelector('[role="alert"]')?.textContent?.includes("Local file unavailable"));
	await act(async () => { otherPreview.click(); await settle(); });
	assert(!container.querySelector(".skill-file-preview"), "failed previews can also be closed through the filename");
	fileStatus = 200;
	await act(async () => { otherPreview.click(); await settle(); });
	assert(container.querySelector("iframe"), "a failed local read can be retried");
	await search("no-such-file");
	assert(container.textContent?.includes("No files found."));
	await search("brands/a/");
	assert.equal(container.querySelectorAll(".repo-browser-local-row").length, 1, "reference search finds the original path, outside the skill folders");
	await click("Repositories");
	assert(container.textContent?.includes("Source offline"));
    const firstCopy = skills[0];
    const renderSource = async (value: SkillListItem) => act(async () => { root.render(createElement(SkillSourceBrowser, { library: library as SkillLibrary, skills: [value], installed: [value], readOnly: false, initialView: "files", onImported: () => {} })); await settle(); });
    await renderSource(firstCopy);
    await click("▸ brands/1 files"); await click("▸ a/1 files"); await click("colors.svg");
    assert(container.querySelector(".skill-file-preview"));
    const revisedCopy = { ...firstCopy, provenance: { ...firstCopy.provenance!, repo: { ...firstCopy.provenance!.repo!, references: [{ ...reference, sha256: "d".repeat(64) }] } } };
    previewText = "<svg>Reviewed new version</svg>";
    await renderSource(revisedCopy);
    assert(!container.querySelector(".skill-file-preview"), "a changed local hash discards the previous open preview");
    const readsBeforeUpdatePreview = calls.length;
    await click("colors.svg"); await click("Source");
    assert.equal(container.querySelector("pre.skill-reference-preview")?.textContent, previewText);
    assert.equal(calls.length, readsBeforeUpdatePreview + 1, "the new local version is loaded only on a fresh click");

    await click("Repository root"); await click("▸ skills/1 files"); await click("▸ brand-a/1 files"); await click("SKILL.md");
    assert(container.querySelector(".skill-doc")?.textContent?.includes(revisedCopy.body));
    await renderSource({ ...revisedCopy, body: "Edited local instructions, unchanged provenance." });
    assert(!container.querySelector(".skill-file-preview"), "an edited manifest invalidates preview even with unchanged provenance");
    await click("SKILL.md");
    assert(container.querySelector(".skill-doc")?.textContent?.includes("Edited local instructions, unchanged provenance."));

    const linkedManifest = { ...revisedCopy, body: "# Saved instructions\n\nRead [palette](../../brands/a/colors.svg)." };
    await renderSource(linkedManifest); await click("SKILL.md"); await click("palette");
    assert(container.querySelector("iframe"));
    previewText = "<svg>Updated linked palette</svg>";
    await renderSource({ ...linkedManifest, provenance: { ...linkedManifest.provenance!, repo: { ...linkedManifest.provenance!.repo!, references: [{ ...reference, sha256: "e".repeat(64) }] } } });
    assert(!container.querySelector(".skill-file-preview"), "an unchanged manifest invalidates its opened link when the package changes");
    await click("SKILL.md"); await click("palette"); await click("Source");
    assert.equal(container.querySelector("pre.skill-reference-preview")?.textContent, previewText);

    for (const view of ["remote", "shared-server"]) {
        const beforeReadOnlyPreview = calls.filter((route) => route.endsWith("/preview")).length;
        await act(async () => { root.render(createElement(SkillSourceBrowser, { key: view, library: library as SkillLibrary, skills: [linkedManifest], installed: [linkedManifest], readOnly: true, initialView: "files", onImported: () => assert.fail("read-only views never import") })); await settle(); });
        await click("▸ skills/1 files"); await click("▸ brand-a/1 files"); await click("SKILL.md");
        assert(container.querySelector(".skill-doc")?.textContent?.includes("Saved instructions"), `${view}: saved manifest metadata remains readable`);
        await click("palette");
        assert(container.querySelector('[role="alert"]')?.textContent?.includes("read-only view"), `${view}: linked local references explain their unavailable preview`);
        assert.equal(calls.filter((route) => route.endsWith("/preview")).length, beforeReadOnlyPreview, `${view}: a manifest link never requests a local preview route`);
    }

	console.log("Skill local files smoke passed.");
} finally {
	await act(async () => root.unmount());
	globalThis.fetch = previousFetch;
	globals.forEach((name, index) => { const descriptor = previous[index]; if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as any)[name]; });
	dom.window.close();
}
