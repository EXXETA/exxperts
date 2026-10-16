import assert from "node:assert/strict";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { RoomSkillsSection } from "../src/components/RoomSkillsSection";
import { defaultRepoPolicy } from "../src/skills-repo-api";
import { invalidateSkillSummaries, type SkillDetail } from "../src/skills-api";
import type { PersistentAgentStatus } from "../src/types";
import type { PersistentRoomSourceGrant } from "../src/persistent-room-management-api";

const material = { path: "extras/guide.md", localPath: "extras/guide.md", kind: "markdown" as const, size: 20, sha256: "e".repeat(64) };
const skills: SkillDetail[] = ["alpha", "bravo"].map((name) => ({ name, displayName: name === "alpha" ? "Alpha" : "Bravo", description: "Synthetic", body: `# ${name}\nSynthetic reviewed instructions.`, source: "user", protected: false, license: "MIT", rooms: [], fileCount: 0, scanFindings: [], bundledScripts: [], sha256: (name === "alpha" ? "a" : "b").repeat(64), packageSha256: (name === "alpha" ? "c" : "d").repeat(64), provenance: { source: "https://example.invalid/brand", importedAt: "2026-10-14T00:00:00Z", license: "MIT", repo: { libraryId: "brand", source: "https://example.invalid/brand", revision: "f".repeat(40), skillPath: `skills/${name}`, policy: defaultRepoPolicy, references: [] } } }));
const library = { id: "brand", name: "Brand", source: "https://example.invalid/brand", status: "current", ...defaultRepoPolicy };
skills[0].provenance!.repo!.references = [{ ...material, path: "skills/alpha/note.md", localPath: "skills/alpha/note.md" }];
let grant: PersistentRoomSourceGrant | null = null;
let currentMaterialsSha256 = "1".repeat(64);
let materialIndexes = 0;
const openedLibraries: Array<string | undefined> = [];
let previews = 0;
let reviews = 0;
let failEnable = false;
let independentEnabled = true;
let settingsReads = 0;
let paused = false;
const pausedCounts: number[] = [];
let deferSettings = false;
let finishSettings: (() => void) | undefined;
const writes: any[] = [];
const response = () => {
	const names = new Set([...(independentEnabled ? ["alpha"] : []), ...(grant?.skills.filter((skill) => !grant!.excludedSkills.includes(skill.name)).map((skill) => skill.name) ?? [])]);
	return { agentId: "room", settings: { schemaVersion: 1, enabledSkills: independentEnabled ? [{ name: "alpha", sha256: skills[0].sha256, packageSha256: skills[0].packageSha256 }] : [], enabledSources: grant ? [grant] : [], updatedAt: "2026-10-14T00:00:00Z" }, skills: [...names].map((name) => ({ name, sha256: skills.find((skill) => skill.name === name)!.sha256, currentSha256: skills.find((skill) => skill.name === name)!.sha256, status: paused ? "hash-mismatch" : "ok", executeState: "none", bundledFiles: [] })), sources: grant ? [{ libraryId: "brand", name: "Brand", source: library.source, materialsSha256: grant.materialsSha256, currentMaterialsSha256, materialCount: 1, skills: grant.skills.map((skill) => skill.name), excludedSkills: grant.excludedSkills, status: currentMaterialsSha256 === grant.materialsSha256 ? "ok" : "review-required" }] : [] };
};
const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost/" });
const previousFetch = globalThis.fetch;
const globals = ["window", "document", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
const previous = globals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
globalThis.fetch = (async (input, init) => {
	const url = String(input);
	let payload: unknown;
	if (url === "/api/remote/client-context") payload = { remote: false, capability: "full" };
	else if (url === "/api/skills?view=summary") payload = skills;
	else if (url === "/api/skills/libraries") payload = { libraries: [library] };
	else if (url === `/api/skills/libraries/brand/materials?version=${"1".repeat(64)}`) { materialIndexes++; payload = { manifest: { libraryId: "brand", materialsSha256: "1".repeat(64), files: [material] } }; }
	else if (url === "/api/persistent-agents/room/skill-sources/brand/review") { reviews++; payload = { libraryId: "brand", name: "Brand", source: library.source, materialsSha256: "1".repeat(64), materials: [material], skills }; }
	else if (url === `/api/skills/libraries/brand/materials/${"1".repeat(64)}/preview`) { previews++; payload = { path: material.path, kind: "markdown", size: 20, text: "# Reviewed extra material" }; }
	else if (url === `/api/skills/alpha/references/${encodeURIComponent("skills/alpha/note.md")}/preview`) { previews++; payload = { path: "skills/alpha/note.md", kind: "markdown", size: 20, text: "# Independent reference" }; }
	else if (url === "/api/persistent-agents/room/skill-settings?view=summary") {
		if (init?.method === "PUT") {
			const mutation = JSON.parse(String(init.body)); writes.push(mutation);
			if (mutation.action === "enable-source" && failEnable) return new Response(JSON.stringify({ error: "Source changed. Review again." }), { status: 409 });
			if (mutation.action === "enable-source") grant = { libraryId: mutation.libraryId, materialsSha256: mutation.materialsSha256, skills: mutation.skills, excludedSkills: mutation.excludedSkills };
			else if (mutation.action === "disable-source") grant = null;
			else if (mutation.action === "exclude-source-skill") { const excluded = new Set(grant!.excludedSkills); if (mutation.excluded) excluded.add(mutation.name); else excluded.delete(mutation.name); grant = { ...grant!, excludedSkills: [...excluded] }; }
			else if (mutation.action === "disable") independentEnabled = false;
			else assert.fail(`Unexpected mutation ${mutation.action}`);
		} else { settingsReads++; if (deferSettings) await new Promise<void>((resolve) => { finishSettings = resolve; }); }
		payload = response();
	} else assert.fail(`Unexpected fixture request ${url}`);
	return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
}) as typeof fetch;
const container = dom.window.document.getElementById("root")!;
const root = createRoot(container);
const click = async (element: Element) => act(async () => { (element as HTMLElement).click(); await new Promise<void>((resolve) => setImmediate(resolve)); });
const button = (label: string) => [...container.querySelectorAll("button")].find((element) => element.textContent?.trim() === label)!;
const input = (label: string) => container.querySelector(`input[aria-label='${label}']`)! as HTMLInputElement;
try {
	invalidateSkillSummaries();
	await act(async () => { root.render(createElement(RoomSkillsSection, { status: { id: "room" } as PersistentAgentStatus, onOpenSkillsLibrary: (id) => openedLibraries.push(id), onPausedCount: (count) => pausedCounts.push(count) })); await new Promise<void>((resolve) => setImmediate(resolve)); });
	assert.equal(pausedCounts.at(-1), 0);
	const rerenderPaused = async (refreshKey: number) => act(async () => { root.render(createElement(RoomSkillsSection, { status: { id: "room" } as PersistentAgentStatus, refreshKey, onOpenSkillsLibrary: (id) => openedLibraries.push(id), onPausedCount: (count) => pausedCounts.push(count) })); await new Promise<void>((resolve) => setImmediate(resolve)); });
	paused = true;
	await rerenderPaused(1);
	assert.equal(pausedCounts.at(-1), 1, "the upstream paused-skill count works with repository sources and cached metadata");
	paused = false;
	await rerenderPaused(2);
	assert.equal(pausedCounts.at(-1), 0, "refreshing reviewed skills clears the navigation count");

	await click(button("Open skills"));
	assert.deepEqual(openedLibraries, [undefined], "generic navigation must not pass a mouse event as a source ID");
	assert.equal(container.querySelectorAll("[aria-label='Repository sources'] > .room-skill").length, 1);
	assert(input("Enable source Brand").classList.contains("workspaces-tool-switch"));
	await click(input("Enable source Brand"));
	assert.equal(reviews, 1);
	assert.equal(writes.length, 0, "source switch opens a grouped review before granting access");
	assert.equal(previews, 0, "materials are not opened automatically");
	await click(input("Include Bravo"));
	const materialButton = [...container.querySelectorAll("button")].find((element) => element.textContent?.trim() === "guide.md")!;
	await click(materialButton);
	assert.equal(previews, 1, "reviewed extras open only on click");
	await click(button("I reviewed this source: enable"));
	assert.equal(writes[0].skills.length, 2, "one request includes all reviewed pins");
	assert.deepEqual(writes[0].excludedSkills, ["bravo"]);
	assert.equal(input("Enable source Brand").checked, true);
	assert(container.textContent?.includes("1 skills · 1 local references"), "references are counted separately from skill instructions");
	assert.equal(materialIndexes, 0, "approved metadata is loaded only when its list is opened");
	currentMaterialsSha256 = "2".repeat(64);
	await click(container.querySelector("button[aria-label='Show local references from Brand']")!);
	assert.equal(materialIndexes, 1, "the panel requests the room-pinned version instead of the newer current source");
	assert.equal(previews, 1, "expanding the reference list reads metadata only");
	await click(button("guide.md"));
	assert.equal(previews, 2);
	assert(container.textContent?.includes("Reviewed extra material"));
	await click(button("guide.md"));
	assert(!container.querySelector(".skill-file-preview"), "a repeated name click closes the preview");
	await click(button("Manage references"));
	assert.equal(openedLibraries.at(-1), "brand", "reference management targets this same source");
	assert(!container.textContent?.includes("Review Brand"), "successful grouped review returns to room settings");
	assert(!container.querySelector("input[aria-label='Use Bravo from Brand']"), "individual members stay folded initially");
	await click(button("Choose skills"));
	assert.equal(input("Use Bravo from Brand").checked, false);
	await click(input("Use Bravo from Brand"));
	assert.equal(writes.at(-1).action, "exclude-source-skill");
	assert.equal(input("Use Bravo from Brand").checked, true);
	await click(input("Enable source Brand"));
	assert.equal(writes.at(-1).action, "disable-source");
	assert.equal(input("Enable source Brand").checked, false);
	assert(container.querySelector(".room-skill-row")?.textContent?.includes("Alpha"), "source off retains independently enabled skill");
	await click(button("Show references"));
	await click(button("note.md"));
	assert(container.textContent?.includes("Independent reference"), "individually enabled references also load their saved preview");
	await click(button("Hide references"));
	await click(input("Enable source Brand"));
	failEnable = true;
	await click(button("I reviewed this source: enable"));
	assert(container.textContent?.includes("Source changed. Review again."));
	assert(container.textContent?.includes("Review Brand"), "failed stale review remains visible");
	await click(button("Cancel"));
	assert.equal(input("Enable source Brand").checked, false);
	const readsBeforeRemove = settingsReads;
	await click(button("Remove"));
	assert.equal(settingsReads, readsBeforeRemove, "removing uses its response, without a second settings GET");
	assert(!container.querySelector(".room-skill-row"), "removed independent skill disappears immediately after saving");
	await act(async () => root.render(null));
	deferSettings = true;
	await act(async () => { root.render(createElement(RoomSkillsSection, { status: { id: "room" } as PersistentAgentStatus })); await new Promise<void>((resolve) => setImmediate(resolve)); });
	assert(!container.textContent?.includes("Loading skills"), "reopening shows cached room metadata while its refresh is pending");
	assert(container.textContent?.includes("Brand"));
	await act(async () => { finishSettings?.(); await new Promise<void>((resolve) => setImmediate(resolve)); });
	console.log("room-skill-sources-smoke: OK");
} finally {
	await act(async () => root.unmount());
	globalThis.fetch = previousFetch;
	globals.forEach((name, index) => { if (previous[index]) Object.defineProperty(globalThis, name, previous[index]!); else delete (globalThis as any)[name]; });
	dom.window.close();
}
