import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { Simulate } from "react-dom/test-utils";
import { SkillRepoPolicy } from "../src/components/SkillRepoPolicy";
import { SkillReferences } from "../src/components/SkillReferences";
import { MaterialSelectionTree } from "../src/components/MaterialSelectionTree";
import { RepoRepositoryBrowser } from "../src/components/RepoRepositoryBrowser";
import { skillBelongsToLibrary } from "../src/skill-source-copy";
import { defaultRepoPolicy, type RepoFile } from "../src/skills-repo-api";

const normal = renderToStaticMarkup(createElement(SkillRepoPolicy, { value: defaultRepoPolicy, onChange: () => {} }));
assert(!normal.includes("Optional reference formats"));
const design = renderToStaticMarkup(createElement(SkillRepoPolicy, { value: { ...defaultRepoPolicy, designRepo: true }, onChange: () => {} }));
for (const label of ["CSS / SCSS", "PDF", "SVG", "Word", "Excel", "Images", "Fonts"]) assert(design.includes(label));
assert.equal((design.match(/checked=""/g) || []).length, 1, "optional formats and repository-wide scope require opt-in");
const library = { id: "a", source: "https://example.test/brand", ref: "main" };
assert(skillBelongsToLibrary({ ...library, libraryId: "a", source: "old" }, library));
assert(!skillBelongsToLibrary({ ...library, libraryId: "other" }, library), "an explicit different binding never falls back to source");
assert(skillBelongsToLibrary(library, library), "exact unbound source and ref are reviewable updates");
assert(!skillBelongsToLibrary({ ...library, ref: "other" }, library));
const references = renderToStaticMarkup(createElement(SkillReferences, { references: [{ path: "brand/logo.svg", localPath: "logo.svg", kind: "svg", size: 42, sha256: "b".repeat(64), preview: '<svg onload="alert(1)"><script>bad()</script></svg>' }] }));
assert(!references.includes("<svg") && !references.includes("<script") && !references.includes("&lt;svg"), "contents stay closed until a click");
const dom = new JSDOM("<div id='root'></div>");
const globals = ["window", "document", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
const previous = globals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const container = dom.window.document.getElementById("root")!;
const root = createRoot(container);
const files: RepoFile[] = Array.from({ length: 21000 }, (_, index) => ({ path: `docs/group-${String(Math.floor(index / 210)).padStart(3, "0")}/item-${String(index).padStart(5, "0")}.md`, kind: "markdown", allowed: true }));
files.push({ path: "docs/blocked.svg", kind: "svg", allowed: false, reason: "Format not enabled" });
let selected = new Set<string>(), previews = 0;
function Tree() {
    const [selection, setSelection] = useState(new Set<string>()); selected = selection;
    return createElement(MaterialSelectionTree, { files, selected: selection, onChange: setSelection, onPreview: async (path) => { previews++; return { path, kind: "markdown", size: 4, text: "Test" }; } });
}
const flush = async () => { for (let index = 0; index < 4; index++) await new Promise<void>((resolve) => setImmediate(resolve)); };
const checkbox = (label: string) => container.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
async function expand(path: string) {
    const details = checkbox(`Select folder ${path}`).closest("details")!;
    await act(async () => { details.open = true; details.dispatchEvent(new dom.window.Event("toggle", { bubbles: false })); await flush(); });
}
try {
    await act(async () => root.render(createElement(Tree)));
    assert.equal(container.querySelectorAll(".material-selection-file").length, 0, "21,000 distributed files do not mount inside closed folders");
    assert.equal(container.querySelectorAll("details").length, 1, "nested folder contents are lazy too");
    await act(async () => checkbox("Select folder docs").click());
    assert.equal(selected.size, 21000, "a closed folder selects its full original inventory");
    await expand("docs"); await expand("docs/group-000");
    assert.equal(container.querySelectorAll(".material-selection-file").length, 101, "open folders page their own names");
    const blocked = [...container.querySelectorAll("button")].find((button) => button.textContent === "blocked.svg")!;
    assert(blocked.disabled, "excluded files are metadata-only");
    const search = container.querySelector('input[type="search"]') as HTMLInputElement;
    await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(search, "item-00000"); Simulate.change(search); await flush(); });
    assert.equal(container.querySelectorAll(".material-selection-file").length, 1);
    await act(async () => checkbox("Select folder docs/group-000").click());
    assert.equal(selected.size, 21000 - 210, "search never limits folder selection");
    assert(checkbox("Select folder docs").indeterminate);
    assert.equal(previews, 0);
    let opened = "";
    const scan = { files: [{ path: "skills/a/SKILL.md", kind: "markdown" as const, allowed: true }, { path: "program/run.js", kind: null, allowed: false, reason: "Programs are excluded" }], skills: [{ name: "a", path: "skills/a", description: "", license: "MIT", hasBundledScripts: false }] };
    await act(async () => root.render(createElement(RepoRepositoryBrowser, { scan, onOpenSkill: (skill) => { opened = skill.path; }, onPreview: async (path) => { previews++; return { path, kind: "markdown", text: "fixture", size: 7 }; } })));
    async function click(label: string) { const button = [...container.querySelectorAll("button")].find((node) => node.getAttribute("aria-label") === label || node.textContent === label)!; assert(button && !button.disabled); await act(async () => { button.click(); await flush(); }); }
    await click("Open folder program"); await click("Inspect file program/run.js");
    assert([...container.querySelectorAll("button")].find((button) => button.textContent === "Show source file")?.disabled);
    assert.equal(previews, 0);
    await click("Repository root"); await click("Open folder skills"); await click("Open folder skills/a"); await click("Inspect file skills/a/SKILL.md"); await click("Open skill");
    assert.equal(opened, "skills/a"); assert.equal(previews, 0, "opening a skill from metadata does not download instructions");
    console.log("Skill repository selection smoke passed.");
} finally {
    await act(async () => root.unmount());
    globals.forEach((name, index) => { const descriptor = previous[index]; if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as any)[name]; });
    dom.window.close();
}
