import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { SkillFileButton, resolveRepositoryLink } from "../src/components/SkillFileButton";
import { SkillReferences } from "../src/components/SkillReferences";
import type { SkillFilePreviewData, SkillReference } from "../src/skills-repo-api";

assert.equal(resolveRepositoryLink("skills/a/SKILL.md", "../../shared/next%20step.md#details"), "shared/next step.md");
assert.equal(resolveRepositoryLink("shared/a#b/guide.md", "next%20step.md"), "shared/a#b/next step.md");
assert.equal(resolveRepositoryLink("skills/a/SKILL.md", "shared/child.md", ["shared/child.md"]), "shared/child.md", "canonical repository-root paths resolve against the selected path index");
assert.throws(() => resolveRepositoryLink("skills/a/SKILL.md", "https://outside.invalid/file.md"), /not a file/);
const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost/" });
const globals = ["window", "document", "navigator", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
const previous = globals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: dom.window.navigator });
const { createRoot } = await import("react-dom/client");
const container = dom.window.document.getElementById("root")!;
const root = createRoot(container);
const calls: string[] = [];
const files: Record<string, SkillFilePreviewData> = {
	"skills/a/SKILL.md": { path: "skills/a/SKILL.md", kind: "markdown", size: 42, text: "---\nname: a\ndescription: Synthetic manifest\n---\n# Main instructions\n\nRead [child](../../shared/child.md).\n\n![logo](logo.png)" },
	"shared/child.md": { path: "shared/child.md", kind: "markdown", size: 42, text: "## Child instructions\n\n**Rendered reference.**" },
	"skills/a/reference.md": { path: "skills/a/reference.md", kind: "markdown", size: 42, text: "## Relative instructions" },
	"page.html": { path: "page.html", kind: "html", size: 42, text: '<h1>Design preview</h1><script>window.bad = true</script><img src="https://outside.invalid/beacon">' },
	"run.cmd": { path: "run.cmd", kind: "text", size: 42, text: "echo must-not-execute > marker.txt" },
};
const load = async (path: string) => { calls.push(path); assert(files[path], `unexpected file: ${path}`); return files[path]; };
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
async function click(label: string) {
	const button = [...container.querySelectorAll("button")].find((node) => node.textContent === label)!;
	assert(button, label);
	await act(async () => { button.click(); await settle(); });
}
async function render(path: string, showLocalCopy = false) {
	await act(async () => root.render(createElement(SkillFileButton, { key: path, path, load, showLocalCopy })));
}
try {
	await render("skills/a/SKILL.md", true);
	assert.equal(calls.length, 0, "mounting a file row never reads or opens its contents");
	assert(!container.querySelector(".skill-file-preview"));
	await click("skills/a/SKILL.md");
	assert.equal(container.querySelector("h1")?.textContent, "Main instructions", "the main manifest is rendered as Markdown");
	assert(!container.querySelector(".skill-doc")?.textContent?.includes("name: a"), "manifest metadata does not become a Markdown heading");
	await click("Source");
	assert(container.querySelector("pre")?.textContent?.includes("name: a"), "source mode preserves the full original frontmatter");
	await click("Rendered");
	assert(!container.querySelector("img"), "linked assets stay click-to-open, without automatic fetches");
	assert.deepEqual(calls, ["skills/a/SKILL.md"]);
	await click("skills/a/SKILL.md");
	assert(!container.querySelector(".skill-file-preview"), "a second filename click closes the preview");
	assert.equal(calls.length, 1, "closing through the filename never reloads or downloads the file");
	await click("Show local copy");
	assert.equal(container.querySelector("h1")?.textContent, "Main instructions", "Show local copy opens the same rendered preview");
	assert.equal(container.querySelector('button[title="skills/a/SKILL.md"]')?.getAttribute("aria-expanded"), "true");
	await click("child");
	assert.equal(container.querySelector("h2")?.textContent, "Child instructions", "a relative subfile opens in the same viewer");
	assert.equal(container.querySelector("strong:last-child")?.textContent?.includes("Rendered reference"), true);
	await click("Close preview");
	assert(!container.querySelector(".skill-file-preview"));
	await click("Show local copy");
	await click("Hide local copy");
	assert(!container.querySelector(".skill-file-preview"), "the local-copy action also toggles the preview");
	await render("page.html");
	assert.equal(calls.length, 4);
	await click("page.html");
	const frame = container.querySelector("iframe")!;
	assert.equal(frame.getAttribute("sandbox"), "");
	assert(frame.srcdoc.includes("default-src 'none'"), "rendering never loads external resources or grants scripts access to app data");
	assert(frame.srcdoc.includes("Design preview"));
	await click("Source");
	assert(!container.querySelector("iframe"));
	assert(container.querySelector("pre")?.textContent?.includes("<h1>Design preview"));
	await render("run.cmd");
	await click("run.cmd");
	assert.equal(container.querySelector("pre")?.textContent, files["run.cmd"].text, "CMD files are readable source, never executable content");
	assert(!container.querySelector("iframe, script"));
	await act(async () => root.render(createElement(SkillFileButton, { key: "instructions", path: "skills/a/SKILL.md", body: "# Canonical sources\n\nRead `shared/child.md`, then `reference.md` and `run.cmd`.\n\n![remote](https://outside.invalid/file.png)", referencePaths: ["shared/child.md", "skills/a/reference.md"], load })));
	const previousCalls = calls.length;
	assert.equal(container.querySelectorAll(".skill-file-preview").length, 0);
	assert(![...container.querySelectorAll("button")].some((button) => button.textContent === "run.cmd"), "excluded programs do not become reference links");
	await click("shared/child.md");
	assert.equal(calls.length, previousCalls + 1);
	assert.equal(calls.at(-1), "shared/child.md");
	assert.equal(container.querySelector("h2")?.textContent, "Child instructions", "canonical inline file paths open a saved copy from the instructions");
	await click("reference.md");
	assert.equal(calls.at(-1), "skills/a/reference.md", "links in the still-visible main instructions keep their own base directory after opening another reference");
	assert.equal(container.querySelector("h2")?.textContent, "Relative instructions");
	await click("Close preview");
	const readsBeforeInvalidLink = calls.length;
	await click("remote (open image)");
	assert(container.querySelector('[role="alert"]')?.textContent?.includes("not a file in the repository"), "invalid links also show an error from initially displayed instructions");
	assert.equal(calls.length, readsBeforeInvalidLink, "invalid external links never reach the loader");
    const packageReferences: SkillReference[] = [
        { path: "guide.md", localPath: "guide.md", kind: "markdown", sha256: "a".repeat(64), size: 20 },
        { path: "child.md", localPath: "child.md", kind: "markdown", sha256: "b".repeat(64), size: 20 },
    ];
    let childBody = "Original linked reference";
    const previewPackage = async (path: string): Promise<SkillFilePreviewData> => ({ path, kind: "markdown", size: 20, text: path === "guide.md" ? "Read [nested child](child.md)." : childBody });
    const renderReferences = async (references: SkillReference[]) => act(async () => root.render(createElement(SkillReferences, { references, stored: true, onPreview: previewPackage })));
    await renderReferences(packageReferences); await click("guide.md"); await click("nested child");
    assert(container.querySelector(".skill-file-preview")?.textContent?.includes(childBody));
    const previousPreview = container.querySelector(".skill-file-preview");
    await renderReferences([...packageReferences]);
    assert.equal(container.querySelector(".skill-file-preview"), previousPreview, "unrelated rerenders preserve preview when the reference version is unchanged");
    childBody = "Updated linked reference";
    await renderReferences([packageReferences[0], { ...packageReferences[1], sha256: "c".repeat(64) }]);
    assert(!container.querySelector(".skill-file-preview"), "a linked target change invalidates the unchanged entry file's preview");
    await click("guide.md"); await click("nested child");
    assert(container.querySelector(".skill-file-preview")?.textContent?.includes(childBody));

	console.log("Skill file preview smoke passed.");
} finally {
	await act(async () => root.unmount());
	globals.forEach((name, index) => { const descriptor = previous[index]; if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as any)[name]; });
	dom.window.close();
}
