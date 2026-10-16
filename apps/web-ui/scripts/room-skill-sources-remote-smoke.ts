import assert from "node:assert/strict";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { RoomSkillsSection } from "../src/components/RoomSkillsSection";
import { invalidateSkillSummaries } from "../src/skills-api";
import type { PersistentAgentStatus } from "../src/types";

const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost/" });
const previousFetch = globalThis.fetch;
const globals = ["window", "document", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
const previous = globals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const reads: string[] = [];
const sharedServer = process.argv.includes("--shared-server");
globalThis.fetch = (async (input) => {
	const url = String(input); reads.push(url);
	let payload: unknown;
	if (url === "/api/remote/client-context") payload = { remote: !sharedServer, capability: sharedServer ? "full" : "read-only", sharedServer };
	else if (url === "/api/skills?view=summary") payload = [];
	else if (url === "/api/persistent-agents/room/skill-settings?view=summary") payload = { agentId: "room", settings: { schemaVersion: 1, enabledSkills: [], enabledSources: [{ libraryId: "source", materialsSha256: "a".repeat(64), skills: [], excludedSkills: [] }], updatedAt: "" }, skills: [], sources: [{ libraryId: "source", name: "Approved materials", source: "https://example.invalid/source", materialsSha256: "a".repeat(64), currentMaterialsSha256: "a".repeat(64), materialCount: 1, skills: [], excludedSkills: [], status: "ok" }] };
	else assert.fail(`Remote room requested local administration: ${url}`);
	return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
}) as typeof fetch;
const container = dom.window.document.getElementById("root")!;
const root = createRoot(container);
try {
	invalidateSkillSummaries();
	await act(async () => { root.render(createElement(RoomSkillsSection, { status: { id: "room" } as PersistentAgentStatus })); await new Promise<void>((resolve) => setImmediate(resolve)); });
	assert(container.textContent?.includes("Approved materials"), "remote rooms retain their approved source summary");
	assert.equal((container.querySelector("input[aria-label='Enable source Approved materials']") as HTMLInputElement)?.disabled, true);
	assert.equal(container.querySelectorAll(".checkpoint-proposal-error").length, 0);
	assert.equal(reads.filter((url) => url === "/api/remote/client-context").length, 1, "the existing context probe is shared");
	assert(!reads.includes("/api/skills/libraries"));
	console.log(`room-skill-sources-remote-smoke${sharedServer ? " (shared server)" : ""}: OK`);
} finally {
	await act(async () => root.unmount()); globalThis.fetch = previousFetch;
	globals.forEach((name, index) => { if (previous[index]) Object.defineProperty(globalThis, name, previous[index]!); else delete (globalThis as any)[name]; });
	dom.window.close();
}
