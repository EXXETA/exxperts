import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { RepositorySignIn } from "../src/components/RepositorySignIn";
import { GuidedLibraryImport } from "../src/components/GuidedLibraryImport";
import { defaultRepoPolicy, type RepositorySignInStatus } from "../src/skills-repo-api";

const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost/" });
const previousFetch = globalThis.fetch;
const keys = ["window", "document", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
const previous = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const container = dom.window.document.getElementById("root")!;
const root = createRoot(container);
const source = "https://github.com/fixture/private";
let signedIn = false, logins = 0, scans = 0, retry = 0, denied = false, pending = false, revoked = 0;
let loginSignal: AbortSignal | undefined;
const requests: Array<{ route: string; body: any }> = [];
const anonymous = (): RepositorySignInStatus => ({ host: "github.com", provider: "github", ready: false, issues: [], setupCommands: [], documentation: "https://github.com/git-ecosystem/git-credential-manager", gitAvailable: true, mode: "anonymous", granted: true, confirmed: false, rememberLocalAccess: false, checkOnStartup: false });
let status = anonymous();
const json = (value: unknown, code = 200) => new Response(JSON.stringify(value), { status: code, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input, init) => {
	const route = String(input), body = init?.body ? JSON.parse(String(init.body)) : {};
	requests.push({ route, body });
	if (route.endsWith("/auth/status")) return json(status);
	if (route.endsWith("/access/revoke")) { revoked++; status = anonymous(); return json(status); }
	if (route.endsWith("/repo/access")) { status = { ...status, mode: body.mode, granted: body.mode !== "anonymous", confirmed: true, ready: body.mode === "local-git" && !status.setupCommands.length, rememberLocalAccess: body.rememberLocalAccess, checkOnStartup: body.checkOnStartup, accessId: "session-access" }; return json(status); }
	if (route.endsWith("/auth/login")) {
		assert.equal(body.allowCredentialStorage, true); assert.equal(body.libraryId, "fixture");
		logins++; loginSignal = init?.signal ?? undefined;
		if (pending) return new Promise((_, reject) => loginSignal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
		if (denied) return json({ error: "Provider denied or cancelled sign-in." }, 400);
		signedIn = true; return json({ signedIn: true });
	}
	if (route === "/api/skills/libraries/fixture/scan") {
		scans++;
		if (!signedIn) return json({ error: "Repository may be private, unavailable or not accessible to this account.", code: "REPOSITORY_AUTH_REQUIRED" }, 403);
		return json({ token: "new-snapshot", source, revision: "a".repeat(40), transport: "git", policy: { ...defaultRepoPolicy, referenceRoots: [""] }, skills: [], files: [] });
	}
	if (route === "/api/skills/repo/discovery") return json({ token: "new-snapshot", source, revision: "a".repeat(40), referenced: [], additional: [], formats: [], missing: [], excludedCounts: {}, warnings: [], incomplete: false });
	if (route === "/api/skills/libraries/fixture/materials") return json({ manifest: null });
	throw new Error(`Unexpected request: ${route}`);
}) as typeof fetch;
async function flush() { for (let i = 0; i < 6; i++) await new Promise<void>((resolve) => setImmediate(resolve)); }
function button(label: string) { return [...container.querySelectorAll("button")].find((node) => !node.closest("[hidden]") && node.textContent === label); }
async function click(label: string) { const node = button(label); assert(node && !node.disabled, label); await act(async () => { node.click(); await flush(); }); }
async function select(value: string) { await act(async () => { const node = container.querySelector<HTMLSelectElement>('[aria-label="Access method"]')!; node.value = value; node.dispatchEvent(new dom.window.Event("change", { bubbles: true })); await flush(); }); }
async function check(label: string) { const node = [...container.querySelectorAll("label")].find((entry) => entry.textContent?.includes(label))?.querySelector<HTMLInputElement>('input[type="checkbox"]'); assert(node); await act(async () => { node.click(); await flush(); }); }
async function render(key: string) { await act(async () => { root.render(createElement(RepositorySignIn, { key, source, libraryId: "fixture", onRetry: async (id) => { assert.equal(id, "session-access"); retry++; } })); await flush(); }); }
try {
	await render("initial");
	assert(container.querySelector('[aria-label="Repository access"]'));
	assert(container.textContent?.includes("Confirm repository access"));
	assert.equal(logins, 0); assert.equal(requests.filter((r) => r.route.endsWith("/repo/access")).length, 0, "mounting never grants access");
	assert(!container.querySelector<HTMLInputElement>('input[role="switch"]')!.checked, "startup checks start disabled");
	await select("local-git");
	assert.equal(requests.filter((r) => r.route.endsWith("/repo/access")).length, 0, "choosing a method is not consent");
	await check("Check for updates when EXXPERTS starts");
	assert(![...container.querySelectorAll("label")].find((node) => node.textContent?.includes("Remember local Git access"))?.querySelector<HTMLInputElement>("input")?.checked, "enabling startup checks never silently remembers local access");
	assert(!button("Sign in in browser and retry"), "browser login is unavailable before a local access grant");
	await click("Allow local Git access and retry");
	assert.equal(retry, 1); assert.equal(logins, 0);
	assert.equal(requests.at(-1)?.body.rememberLocalAccess, false); assert.equal(requests.at(-1)?.body.checkOnStartup, true, "startup checks are an independent explicit choice");
	assert(button("Sign in in browser and retry")?.disabled, "browser login needs separate storage consent");
	await check("I agree that this browser login saves credentials");
	denied = true; await click("Sign in in browser and retry");
	assert(container.textContent?.includes("Provider denied")); assert.equal(retry, 1);
	denied = false; pending = true;
	await click("Sign in in browser and retry"); await click("Cancel sign-in");
	assert(loginSignal?.aborted); assert.equal(retry, 1); assert(container.textContent?.includes("Sign-in cancelled"));
	pending = false;
	await select("session-token");
	await act(async () => { const node = container.querySelector<HTMLInputElement>('[aria-label="Session token"]')!; Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(node, "synthetic-token"); Simulate.change(node); await flush(); });
	await click("Use token for this session and retry");
	assert.equal(requests.at(-1)?.body.token, "synthetic-token");
	assert.equal(container.querySelector<HTMLInputElement>('[aria-label="Session token"]')!.value, "", "token field clears after submission");
	assert.equal(dom.window.localStorage.length, 0); assert.equal(dom.window.sessionStorage.length, 0);
	await check("Check for updates when EXXPERTS starts");
	await click("Use token for this session and retry");
	assert(!("token" in requests.at(-1)!.body), "changing settings on an active token session omits an empty replacement token");
	assert.equal(requests.at(-1)?.body.checkOnStartup, false);
	await click("Remove access"); assert.equal(revoked, 1); assert(container.textContent?.includes("Shared system Git credentials have not been deleted"));
	assert(container.textContent?.includes("Confirm repository access"));
	status = { ...anonymous(), mode: "session-token", granted: false, confirmed: true };
	await render("expired-token");
	assert(container.textContent?.includes("Access required. Private update checks are paused"));
	assert(button("Use token for this session and retry")?.disabled, "expired tokens must be entered again rather than treating private contents as current");
	status = { ...anonymous(), gitAvailable: false };
	await render("no-git"); assert(container.textContent?.includes("Git is not installed"));
	await select("session-token"); assert(button("Use token for this session and retry")?.disabled);
	status = { ...anonymous(), mode: "local-git", granted: true, confirmed: true, host: "gitlab.example.invalid", provider: "gitlab", setupCommands: ["git config --global credential.https://gitlab.example.invalid.gitLabDevClientId <APPLICATION_ID>"], issues: ["Register a non-confidential OAuth application."] };
	await render("gitlab"); assert(container.textContent?.includes("non-confidential OAuth")); assert(container.textContent?.includes("gitLabDevClientId")); assert(!container.querySelector("details"), "setup and access controls are visible");
	assert(button("Sign in in browser and retry")?.disabled);
	status = anonymous(); signedIn = false;
	await act(async () => { root.render(createElement(GuidedLibraryImport, { library: { id: "fixture", name: "Private fixture", source, ...defaultRepoPolicy, status: "unchecked" }, installed: [], onImported: () => {}, onCancel: () => {} })); await flush(); });
	assert.equal(scans, 1); assert.equal(logins, 2);
	await select("local-git"); await click("Allow local Git access and retry"); assert.equal(scans, 2);
	await check("I agree that this browser login saves credentials"); await click("Sign in in browser and retry");
	assert.equal(scans, 3); assert.equal(logins, 3);
	assert(container.textContent?.includes("Prepare review")); assert(container.textContent?.includes("Loaded using Git"));
	assert(!requests.some((entry) => entry.route.endsWith("/import")), "successful authentication only retries, never imports");
	console.log("repository-sign-in-smoke: OK (explicit access and storage consent, session token, revoke, setup, missing Git, retry and cancellation)");
} finally {
	await act(async () => root.unmount()); globalThis.fetch = previousFetch;
	keys.forEach((key, index) => { const value = previous[index]; if (value) Object.defineProperty(globalThis, key, value); else delete (globalThis as any)[key]; }); dom.window.close();
}
