import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { GuidedLibraryImport } from "../src/components/GuidedLibraryImport";
import { defaultRepoPolicy, type RepoScanResponse, type SkillLibrary } from "../src/skills-repo-api";

const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost/" });
Object.assign(dom.window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} });
const previousFetch = globalThis.fetch;
const names = ["window", "document", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
const previous = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const container = dom.window.document.getElementById("root")!;
const root = createRoot(container);
const library: SkillLibrary = { id: "fixture", name: "Fixture", source: "https://example.test/skills", ref: "main", status: "unchecked", ...defaultRepoPolicy, referenceRoots: ["assets"] };
let scan: RepoScanResponse = { token: "first", source: library.source, ref: library.ref, libraryId: library.id, policy: library, revision: "a".repeat(40), skills: ["a", "b"].map((name) => ({ name, description: "Synthetic", path: `skills/${name}`, license: "MIT", hasBundledScripts: false })), files: [{ path: "assets/old.md", kind: "markdown", allowed: true }, { path: "assets/new.md", kind: "markdown", allowed: true }, { path: "skills/a/SKILL.md", kind: "markdown", allowed: true }, { path: "excluded.js", kind: null, allowed: false, reason: "Programs excluded" }] };
let scans = 0, candidates = 0, imports = 0, failDiscovery = false, expireCandidate = true, expireImport = true;
const response = (value: unknown, status = 200) => Response.json(value, { status });
globalThis.fetch = (async (input, init) => {
    const route = String(input), body = init?.body ? JSON.parse(String(init.body)) : {};
    if (route.endsWith("/repo/auth/status")) return response({ host: "example.test", provider: null, ready: false, issues: [], setupCommands: [], documentation: "", gitAvailable: true, mode: "anonymous", granted: true, confirmed: false, rememberLocalAccess: false, checkOnStartup: false });
    if (route.endsWith("/fixture/scan")) { scans++; assert(body.forceRefresh || body.token === scan.token); scan = { ...scan, token: `fresh-${scans}`, files: scans > 1 ? scan.files.filter((file) => file.path !== "assets/old.md") : scan.files }; return response(scan); }
    if (route.endsWith("/repo/discovery")) {
        if (failDiscovery) { failDiscovery = false; return response({ error: "Synthetic discovery failure" }, 500); }
        return response({ token: scan.token, source: scan.source, revision: scan.revision, referenced: scan.files.filter((file) => file.path === "assets/old.md").map((file) => ({ ...file, skillPaths: body.skillPaths, selected: true })), additional: scan.files.filter((file) => file.path === "assets/new.md").map((file) => ({ ...file, skillPaths: [], selected: false })), formats: [], missing: [], excludedCounts: {}, warnings: [], incomplete: false });
    }
    if (route.endsWith("/fixture/materials")) return response({ manifest: null });
    if (route.endsWith("/repo/candidate")) {
        candidates++;
        if (expireCandidate) { expireCandidate = false; return response({ error: "repository snapshot expired", code: "REPOSITORY_SNAPSHOT_EXPIRED" }, 404); }
        assert.equal(body.token, scan.token);
        return response({ name: body.path.split("/").at(-1), description: "Fixture", body: `Reviewed ${body.token}`, source: scan.source, license: "MIT", revision: scan.revision, skillPath: body.path, references: [], scanFindings: { count: 0, findings: [] }, bundledScripts: [], reviewSha256: "c".repeat(64) });
    }
    if (route.endsWith("/materials/candidate")) return response({ candidateSha256: "d".repeat(64), expectedCurrentHash: null, manifest: { schemaVersion: 1, libraryId: library.id, source: scan.source, revision: scan.revision, policy: library, materialsSha256: "e".repeat(64), files: [] }, added: [], removed: [] });
    if (route.endsWith("/repo/import")) { imports++; if (expireImport) { expireImport = false; return response({ error: "repository snapshot expired", code: "REPOSITORY_SNAPSHOT_EXPIRED" }, 404); } return response({ skill: { name: "a" } }); }
    if (route.endsWith("/materials/accept")) return response({ manifest: { materialsSha256: "e".repeat(64) } });
    if (route.endsWith("/fixture/reconcile")) return response({ library });
    assert.fail(`Unexpected fixture request ${route}`);
}) as typeof fetch;
const flush = async () => { for (let step = 0; step < 5; step++) await new Promise<void>((resolve) => setImmediate(resolve)); };
const button = (label: string) => [...container.querySelectorAll("button")].find((entry) => !entry.closest("[hidden]") && (entry.textContent === label || entry.getAttribute("aria-label") === label))!;
const checkbox = (name: string) => container.querySelector(`input[aria-label="${name}"]`) as HTMLInputElement;
async function click(label: string) { assert(button(label) && !button(label).disabled, `enabled ${label}`); await act(async () => { button(label).click(); await flush(); }); }
try {
    await act(async () => { root.render(createElement(GuidedLibraryImport, { library, initialScan: scan, installed: [], onImported: () => {}, onCancel: () => {} })); await flush(); });
    assert.equal(scans, 0, "opening a reviewed scan does not write or broaden its policy");
    const selectedBefore = [...container.querySelectorAll('input[type="checkbox"]:checked')].length;
    await click("Repository files");
    await click("Open folder skills"); await click("Open folder skills/a"); await click("Inspect file skills/a/SKILL.md"); await click("Open skill");
    assert.equal(dom.window.document.activeElement, checkbox("Select skill a"));
    assert.equal([...container.querySelectorAll('input[type="checkbox"]:checked')].length, selectedBefore, "metadata navigation keeps selection");
    assert.equal(scans + candidates + imports, 0);
    failDiscovery = true;
    await act(async () => { checkbox("Select skill b").click(); await flush(); });
    assert(!checkbox("Select skill b").checked);
    assert(button("Prepare review").disabled, "a failed rediscovery cannot reuse the previous skill mapping");
    assert(container.textContent?.includes("Synthetic discovery failure"));
    await click("Retry");
    assert(!button("Prepare review").disabled && !checkbox("Select skill b").checked, "successful retry keeps current selection");
    await click("Prepare review");
    assert(container.textContent?.includes("Repository review needs a fresh scan"));
    await click("Scan again and keep selection");
    assert(!checkbox("Select skill b").checked);
    assert(!button("Prepare review").disabled);
    await click("Prepare review");
    assert(container.textContent?.includes("Reviewed fresh-1"));
    await click("Change selection");
    expireCandidate = true;
    await click("Prepare review"); await click("Scan again and keep selection");
    assert(container.textContent?.includes("Unavailable selections: assets/old.md"), "removed selected paths stay visible for explicit deselection");
    assert(button("Prepare review").disabled);
    await click("Remove unavailable selections");
    assert(!button("Prepare review").disabled);
    await click("Prepare review");
    assert(container.textContent?.includes("Reviewed fresh-2"));
    assert.equal(imports, 0, "recovery, navigation and preparation never accept automatically");
    await click("Accept and save library");
    assert.equal(imports, 1);
    assert(container.textContent?.includes("Partly saved."));
    failDiscovery = true;
    await click("Scan again and keep selection");
    assert(!button("Accept and save library") && !button("Retry failed items"), "a failed new snapshot analysis cannot re-enable the old acceptance");
    assert(button("Prepare review").disabled);
    await click("Retry");
    assert.equal(imports, 1, "an interrupted accept never retries against new bytes automatically");
    await click("Prepare review");
    assert(container.textContent?.includes("Reviewed fresh-3"));
    await click("Accept and save library");
    assert.equal(imports, 2, "a refreshed package requires another review and explicit accept");
    failDiscovery = true;
    await act(async () => { root.render(createElement(GuidedLibraryImport, { key: "initial-failure-selection", library, initialScan: scan, installed: [], onImported: () => {}, onCancel: () => {} })); await flush(); });
    assert(container.textContent?.includes("Synthetic discovery failure"));
    failDiscovery = true;
    await act(async () => { checkbox("Select skill b").click(); await flush(); });
    assert(!checkbox("Select skill b").checked && button("Prepare review").disabled);
    await click("Retry");
    assert(!checkbox("Select skill b").checked, "retry after an initial discovery failure preserves an edited skill selection");
    assert(!button("Prepare review").disabled);
    assert.equal(imports, 2, "metadata retry does not import");

    console.log("Skill repository recovery smoke passed.");
} finally {
    await act(async () => root.unmount()); globalThis.fetch = previousFetch;
    names.forEach((name, index) => { const descriptor = previous[index]; if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as any)[name]; });
    dom.window.close();
}
