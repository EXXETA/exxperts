import assert from "node:assert/strict";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { LibraryRoomUpdates } from "../src/components/LibraryRoomUpdates";
import { RoomSkillUpdateButton } from "../src/components/SkillUpdateNotice";
import { roomSkillUpdateLabel } from "../src/skill-update-notices";
import type { LibraryRoomsReview } from "../src/skills-repo-api";
import type { SkillDetail } from "../src/skills-api";

const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost/" });
const globals = ["window", "document", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
const previous = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const originalFetch = globalThis.fetch;
const changes: LibraryRoomsReview["rooms"][number]["changes"] = { total: 4, skills: [{ name: "brand", status: "changed", instructionsChanged: true, enabled: true }, { name: "new", status: "added", instructionsChanged: false, enabled: false }], references: [{ path: "logo.svg", status: "changed", beforeVersion: "old", afterVersion: "current" }, { path: "removed.md", status: "removed", beforeVersion: "old" }], referenceVersionChanged: false, previousReferencesUnavailable: false };
let rooms = ["Alpha", "Beta", "Working"].map((name) => ({ id: name.toLowerCase(), name, busy: name === "Working", enabledSkills: ["brand"], independentSkills: [], changes }));
const skills = ["brand", "new", "unchanged"].map((name) => ({ name, body: `Current ${name} instructions`, scanFindings: [] }) as unknown as SkillDetail);
const review = (): LibraryRoomsReview => ({ libraryId: "brand", name: "Brand", source: "https://example.invalid/brand", revision: "a".repeat(40), materialsSha256: "b".repeat(64), materials: [], skills, rooms, reviewSha256: "c".repeat(64) });
const writes: Array<{ reviewSha256: string; roomIds: string[] }> = [];
let stale = false;
let back = 0;
let noticeRequests = 0;
const previews: string[] = [];
let notices = [{ id: "brand", name: "Brand", status: "updates", rooms: [{ id: "alpha", reviewRequired: true }, { id: "beta", reviewRequired: false }] }];
globalThis.fetch = (async (input, init) => {
	const route = String(input);
	if (route === "/api/skills/libraries/brand/rooms/review") return Response.json(review());
	if (route.endsWith("/preview")) { previews.push(route); return Response.json({ path: "logo.svg", kind: "text", size: 20, text: route.includes("/old/") ? "Previous logo" : "Current logo" }); }
	if (route === "/api/skills/libraries/brand/rooms/apply") {
		const body = JSON.parse(String(init?.body)); writes.push(body);
		if (stale) return Response.json({ error: "Library changed. Review again." }, { status: 409 });
		if (writes.length === 1) { rooms = rooms.filter((room) => room.id !== "alpha"); return Response.json({ updated: ["alpha"], failures: [{ id: "beta", name: "Beta", error: "Synthetic disk failure" }] }); }
		rooms = rooms.filter((room) => room.id !== "beta"); return Response.json({ updated: ["beta"], failures: [] });
	}
	if (route === "/api/remote/client-context") return Response.json({ remote: false, capability: "full" });
	if (route === "/api/skills/update-notices") { noticeRequests++; return Response.json({ libraries: notices }); }
	assert.fail(`Unexpected room-update request: ${route}`);
}) as typeof fetch;
const container = document.getElementById("root")!;
const root = createRoot(container);
const flush = async () => { for (let pass = 0; pass < 5; pass++) await new Promise<void>((resolve) => setTimeout(resolve, 0)); };
const confirm = () => [...container.querySelectorAll("button")].find((button) => button.textContent?.startsWith("I reviewed this:"))!;
try {
	await act(async () => { root.render(createElement(LibraryRoomUpdates, { libraryId: "brand", onBack: () => { back++; } })); await flush(); });
	assert.equal(writes.length, 0, "opening a review never changes room grants");
	assert.equal(confirm().textContent, "I reviewed this: update 2 rooms");
	assert(container.querySelector<HTMLInputElement>('[aria-label="Update Working"]')?.disabled, "working rooms cannot be selected");
	const alpha = container.querySelector<HTMLDetailsElement>(".room-update-details")!;
	assert.equal(alpha.open, false, "room details start collapsed with their change metric visible");
	assert.equal(container.querySelectorAll(".room-update-objects").length, 0, "closed rooms do not render their file and instruction details");
	assert(alpha.querySelector("summary")?.textContent?.includes("4 changes"));
	assert(alpha.querySelector("summary")?.textContent?.includes("1 reference changed"));
	assert(!container.textContent?.includes("Current unchanged instructions"), "unchanged skills are not repeated in room reviews");
	await act(async () => { alpha.querySelector("summary")!.click(); await flush(); });
	assert(alpha.open);
	assert.equal(container.querySelectorAll(".room-update-objects").length, 1);
	const brand = alpha.querySelector<HTMLDetailsElement>(".room-update-skill")!;
	assert(!brand.textContent?.includes("Current brand instructions"), "instruction documents wait for their own explicit expansion");
	await act(async () => { brand.querySelector("summary")!.click(); await flush(); });
	assert(brand.textContent?.includes("Current brand instructions"));
	assert(alpha.open, "opening a skill never collapses its room");
	await act(async () => { brand.querySelector("summary")!.click(); await flush(); });
	assert(alpha.textContent?.includes("Instructions changed"));
	assert(alpha.textContent?.includes("New · stays off"));
	assert(alpha.textContent?.includes("removed.md"));
	assert.equal(previews.length, 0, "expanding a room never fetches file previews");
	await act(async () => { [...alpha.querySelectorAll("button")].find((button) => button.textContent === "logo.svg")!.click(); await flush(); [...alpha.querySelectorAll("button")].find((button) => button.textContent === "Previous version")!.click(); await flush(); });
	assert.deepEqual(previews, ["/api/skills/libraries/brand/materials/current/preview", "/api/skills/libraries/brand/materials/old/preview"]);
	await act(async () => { document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await flush(); document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await flush(); });
	assert.equal(back, 0, "Escape closes reference previews before leaving the room review");
	assert(alpha.open, "closing previews keeps the expanded room");
	await act(async () => { confirm().click(); await flush(); });
	assert.deepEqual(writes[0].roomIds, ["alpha", "beta"], "one confirmation sends both existing assignments");
	assert(container.textContent?.includes("Synthetic disk failure"));
	assert.equal(confirm().textContent, "I reviewed this: update 1 room");
    const beta = container.querySelector<HTMLDetailsElement>(".room-update-details")!;
    await act(async () => { beta.querySelector("summary")!.click(); await flush(); });
    await act(async () => { [...beta.querySelectorAll("button")].find((button) => button.textContent === "logo.svg")!.click(); await flush(); });
    assert(beta.querySelector(".skill-file-preview"));
    changes.references = changes.references.map((change) => change.path === "logo.svg" ? { ...change, afterVersion: "latest" } : change);
    await act(async () => { [...container.querySelectorAll("button")].find((button) => button.textContent === "Refresh review")!.click(); await flush(); });
    assert(beta.open, "refresh preserves the expanded room");
    assert(!beta.querySelector(".skill-file-preview"), "refreshed material versions discard the prior open preview");
    await act(async () => { [...beta.querySelectorAll("button")].find((button) => button.textContent === "logo.svg")!.click(); await flush(); });
    assert.equal(previews.at(-1), "/api/skills/libraries/brand/materials/latest/preview");

	stale = true;
	await act(async () => { confirm().click(); await flush(); });
	assert.deepEqual(writes[1].roomIds, ["beta"], "retry only failed rooms");
	assert(container.textContent?.includes("Library changed. Review again."));
	stale = false;
	await act(async () => { [...container.querySelectorAll("button")].find((button) => button.textContent === "Refresh review")!.click(); await flush(); confirm().click(); await flush(); });
	assert.deepEqual(writes[2].roomIds, ["beta"]);
	assert(confirm().disabled, "only working rooms remain after success");
	await act(async () => { document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await flush(); });
	assert.equal(back, 1, "Escape returns to the same library");
	assert.equal(roomSkillUpdateLabel(notices, "alpha"), "Review room changes");
	assert.equal(roomSkillUpdateLabel(notices, "beta"), "Repository update");
	assert.equal(roomSkillUpdateLabel(notices, "unassigned"), null);
	await act(async () => { root.render(createElement("div", null, createElement(RoomSkillUpdateButton, { roomId: "alpha", onClick() {} }), createElement(RoomSkillUpdateButton, { roomId: "beta", onClick() {} }))); await flush(); });
	assert.equal(noticeRequests, 1, "all notice surfaces share one request");
	assert(container.textContent?.includes("Review room changes"));
	notices = [];
	await act(async () => { window.dispatchEvent(new window.Event("display-caches-cleared")); await flush(); });
	assert.equal(container.querySelectorAll("button").length, 0, "profile invalidation clears previous profile notices");
	console.log("library-room-updates smoke passed");
} finally {
	await act(async () => root.unmount());
	globalThis.fetch = originalFetch;
	for (let index = 0; index < globals.length; index++) { if (previous[index]) Object.defineProperty(globalThis, globals[index], previous[index]!); else delete (globalThis as any)[globals[index]]; }
	dom.window.close();
}
