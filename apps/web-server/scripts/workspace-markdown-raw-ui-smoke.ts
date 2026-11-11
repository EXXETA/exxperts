// RAW mode of the Markdown editor is editable: what is typed there is what is
// saved, byte for byte, through the same save path as the rich editor.
// Offline: the room's model is never asked. Throwaway HOME, invented files only.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort, type AuthedFetchInit } from "./smoke-server-process.js";
import { waitEvery } from "./smoke-wait.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("workspace markdown raw ui smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-markdown-raw-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

const folder = path.join(tempHome, "Projects", "handbook");
fs.mkdirSync(folder, { recursive: true });
// Written with `*` bullets and a double blank line on purpose: the rich editor would normalise both.
const notes = path.join(folder, "notes.md");
const NOTES = "# Notes\n\n* first\n* second\n\n\nTail line\n";
const format = path.join(folder, "format.md");
const FORMAT = "# Format\n\n* a\n* b\n\n\nEnd\n";
fs.writeFileSync(format, FORMAT);
const todo = path.join(folder, "todo.md");
fs.writeFileSync(todo, "# Todo\n\n- [ ] first\n- [x] second\n");
fs.writeFileSync(notes, NOTES);

fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
	providers: { "fake-claude": { name: "Fake Claude", baseUrl: "http://127.0.0.1:9", api: "anthropic-messages", models: [{ id: "claude-fake", name: "Claude Fake", input: ["text"], contextWindow: 200000, maxTokens: 32000 }] } },
}, null, 2), { mode: 0o600 });
fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "fake-claude": { type: "api_key", key: "synthetic-claude" } }, null, 2), { mode: 0o600 });
fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [
	{ id: "custom-fake-claude", providerId: "fake-claude", label: "Fake Claude", roomModels: ["claude-fake"], learnModel: "claude-fake", reviewMemoryModel: "claude-fake" },
] }, null, 2), { mode: 0o600 });
fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "custom-fake-claude" }, null, 2), { mode: 0o600 });

const waitUntil = waitEvery(150, 15_000);

async function api(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
try {
	server = spawn(process.execPath, ["bin/exxperts-web.cjs", "--port", String(port), "--no-open"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: repoRoot,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready", 60_000);

	const created = await api("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: "Handbook", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	assert(created.status === 201, `the room is created, got ${created.status}`);
	const agentId = String(created.body?.agent?.id ?? "");
	const saved = await api(`/api/persistent-agents/${encodeURIComponent(agentId)}/workspace-default`, { method: "PUT", body: JSON.stringify({ root: folder, workspaceAccessMode: "localFiles" }) });
	assert(saved.status === 200, `the folder is saved, got ${saved.status}`);

	const browser = await chromium.launch();
	try {
		const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
		await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await page.waitForLoadState("networkidle");
		const dismiss = page.locator(".whats-new-close");
		if (await dismiss.count()) await dismiss.click();
		const card = page.locator(".persistent-agent-card").filter({ hasText: "Handbook" });
		await card.waitFor({ timeout: 10_000 });
		await card.getByRole("button", { name: /^(Enter|Resume)$/ }).click();

		const tree = page.locator(".sidebar-workspace-files");
		const openNotes = async () => { await tree.locator(".workspace-file-browser-file", { hasText: "notes.md" }).click({ timeout: 15_000 }); };
		const raw = page.getByRole("textbox", { name: "Raw Markdown source" });
		const status = page.locator(".markdown-editor-status");
		const initialRead = page.waitForResponse((response) => response.url().includes("/workspace-markdown?") && response.request().method() === "GET");
		await openNotes();
		const markdownUrl = new URL((await initialRead).url());
		const markdownRoute = markdownUrl.pathname + markdownUrl.search;
		await page.locator(".markdown-editor-tiptap .ProseMirror").waitFor();

		// A navigation choice held beyond the autosave delay must still discard the draft.
		await page.getByRole("button", { name: "RAW", exact: true }).click();
		await raw.fill(NOTES + "abandoned draft");
		await tree.locator(".workspace-file-browser-file", { hasText: "todo.md" }).click();
		const guard = page.getByRole("dialog", { name: "Unsaved Markdown changes" });
		await guard.waitFor();
		await page.waitForTimeout(1500);
		await guard.getByRole("button", { name: "Discard changes" }).click();
		await openNotes();
		await page.getByRole("button", { name: "RAW", exact: true }).click();
		await waitUntil(async () => (await raw.inputValue()) === NOTES, "discarded draft is absent after reopening");
		assert(fs.readFileSync(notes, "utf8") === NOTES, "discard keeps original disk bytes");
		const openGuard = async () => {
			await tree.locator(".workspace-file-browser-file", { hasText: "todo.md" }).click();
			await guard.waitFor();
		};
		const reopenNotes = async (expected: string) => {
			await openNotes();
			await page.getByRole("button", { name: "RAW", exact: true }).click();
			await waitUntil(async () => (await raw.inputValue()) === expected, "reopened notes match disk");
		};
		// Quick discard, cancel, save, and navigation after the normal idle save.
		await raw.fill(NOTES + "quick");
		await openGuard();
		await guard.getByRole("button", { name: "Discard changes" }).click();
		await page.waitForTimeout(1500);
		assert(fs.readFileSync(notes, "utf8") === NOTES, "quick discard cancels the pending timer");
		await reopenNotes(NOTES);
		await raw.fill(NOTES + "cancel");
		await openGuard();
		await page.waitForTimeout(1500);
		assert(fs.readFileSync(notes, "utf8") === NOTES, "guard pauses autosave before cancel");
		await guard.getByRole("button", { name: "Cancel" }).click();
		await waitUntil(() => fs.readFileSync(notes, "utf8") === NOTES + "cancel", "cancel resumes autosave");
		await waitUntil(async () => (await status.textContent())?.trim() === "Saved", "cancelled draft becomes saved");
		await raw.fill(NOTES + "save");
		await openGuard();
		await page.waitForTimeout(1500);
		await guard.getByRole("button", { name: "Save and continue" }).click();
		await reopenNotes(NOTES + "save");
		assert(fs.readFileSync(notes, "utf8") === NOTES + "save", "save and continue persists the draft");
		await raw.fill(NOTES);
		await waitUntil(() => fs.readFileSync(notes, "utf8") === NOTES, "idle save persists normally");
		await waitUntil(async () => (await status.textContent())?.trim() === "Saved", "idle save completes");
		await tree.locator(".workspace-file-browser-file", { hasText: "todo.md" }).click();
		assert(await guard.count() === 0, "navigation after autosave has no guard");
		await reopenNotes(NOTES);

		await raw.fill(NOTES + "escape draft");
		await openGuard();
		assert(await guard.getByRole("button", { name: "Cancel" }).isEnabled(), "Cancel is enabled before choosing Save or Discard");
		await page.keyboard.press("Escape");
		await guard.waitFor({ state: "hidden" });
		assert(await page.getByRole("tab", { name: "notes.md", exact: true }).getAttribute("aria-selected") === "true", "nonbusy Escape cancels the pending navigation");
		assert(await raw.inputValue() === NOTES + "escape draft", "nonbusy Escape retains the draft");
		await waitUntil(() => fs.readFileSync(notes, "utf8") === NOTES + "escape draft", "nonbusy Escape resumes autosave");
		await waitUntil(async () => (await status.textContent())?.trim() === "Saved", "escaped draft is saved");
		await raw.fill(NOTES);
		await waitUntil(async () => (await status.textContent())?.trim() === "Saved" && fs.readFileSync(notes, "utf8") === NOTES, "restore notes after nonbusy Escape");

		// Busy Save and Discard retain the navigation despite Escape, on either side of a real write.
		for (const { afterWrite, choice } of [
			{ afterWrite: false, choice: "Save and continue" },
			{ afterWrite: true, choice: "Save and continue" },
			{ afterWrite: false, choice: "Discard changes" },
			{ afterWrite: true, choice: "Discard changes" },
		]) {
			let release!: () => void;
			let started!: () => void;
			const held = new Promise<void>((resolve) => { release = resolve; });
			const startedPut = new Promise<void>((resolve) => { started = resolve; });
			let intercepted = false;
			await page.route("**/workspace-markdown?**", async (route) => {
				if (route.request().method() !== "PUT" || intercepted) return route.continue();
				intercepted = true;
				if (afterWrite) {
					const response = await route.fetch();
					started();
					await held;
					await route.fulfill({ response });
				} else {
					started();
					await held;
					await route.continue();
				}
			});
			await raw.fill(NOTES + "in flight");
			await startedPut;
			await openGuard();
			await guard.getByRole("button", { name: choice }).click();
			try {
				assert(await guard.getByRole("button", { name: "Cancel" }).isDisabled(), `Cancel is disabled during ${choice}`);
				await page.keyboard.press("Escape");
				assert(await guard.isVisible(), `Escape keeps the busy ${choice} dialog open`);
				assert(await guard.getByRole("button", { name: "Cancel" }).isDisabled(), "Escape does not re-enable Cancel while busy");
				assert(await page.getByRole("tab", { name: "notes.md", exact: true }).getAttribute("aria-selected") === "true", `${choice} retains the current file while busy`);
			} finally {
				release();
			}
			await guard.waitFor({ state: "hidden" });
			await waitUntil(async () => await page.getByRole("tab", { name: "todo.md", exact: true }).getAttribute("aria-selected") === "true", `${choice} completes the intended navigation after Escape`);
			await page.unroute("**/workspace-markdown?**");
			const expected = choice === "Discard changes" ? NOTES : NOTES + "in flight";
			await reopenNotes(expected);
			await page.waitForTimeout(1500);
			assert(fs.readFileSync(notes, "utf8") === expected, `${choice} keeps intended bytes with PUT held ${afterWrite ? "after" : "before"} the write`);
			if (choice === "Save and continue") {
				await raw.fill(NOTES);
				await waitUntil(async () => (await status.textContent())?.trim() === "Saved" && fs.readFileSync(notes, "utf8") === NOTES, "restore notes after Save and continue");
			}
		}
		console.log("  ok  busy Save and Discard ignore Escape; nonbusy Escape retains the draft and cancels navigation");
		let releaseConflict!: () => void;
		let conflictWritten!: () => void;
		const conflictHeld = new Promise<void>((resolve) => { releaseConflict = resolve; });
		const conflictStarted = new Promise<void>((resolve) => { conflictWritten = resolve; });
		let conflictIntercepted = false;
		await page.route("**/workspace-markdown?**", async (route) => {
			if (route.request().method() !== "PUT" || conflictIntercepted) return route.continue();
			conflictIntercepted = true;
			const response = await route.fetch();
			conflictWritten();
			await conflictHeld;
			await route.fulfill({ response });
		});
		await raw.fill(NOTES + "conflicting draft");
		await conflictStarted;
		await openGuard();
		releaseConflict();
		await waitUntil(async () => (await status.textContent())?.trim() === "Saved", "in-flight save settles while guard is open");
		fs.writeFileSync(notes, "# Independent change\n");
		await page.waitForTimeout(5500);
		await guard.getByRole("button", { name: "Discard changes" }).click();
		await page.locator(".markdown-editor-conflict").waitFor();
		assert(fs.readFileSync(notes, "utf8") === "# Independent change\n", "discard never overwrites an independent revision");
		await page.unroute("**/workspace-markdown?**");
		await page.getByRole("button", { name: "Reload" }).click();
		await waitUntil(async () => (await raw.inputValue()) === "# Independent change\n", "reload keeps external change");
		await raw.fill(NOTES);
		await waitUntil(() => fs.readFileSync(notes, "utf8") === NOTES, "restore demo file for remaining checks");
		await waitUntil(async () => (await status.textContent())?.trim() === "Saved", "demo file is saved");
		await tree.locator(".workspace-file-browser-file", { hasText: "todo.md" }).click();
		await page.getByRole("button", { name: "Edit", exact: true }).click();
		await page.locator('.markdown-editor-tiptap .ProseMirror input[type="checkbox"]').first().click();
		await openNotes();
		await guard.waitFor();
		await page.waitForTimeout(1500);
		await guard.getByRole("button", { name: "Discard changes" }).click();
		assert(fs.readFileSync(todo, "utf8") === "# Todo\n\n- [ ] first\n- [x] second\n", "checkbox discard preserves original bytes");
		await tree.locator(".workspace-file-browser-file", { hasText: "todo.md" }).click();
		assert(!(await page.locator('.markdown-editor-tiptap .ProseMirror input[type="checkbox"]').first().isChecked()), "discarded checkbox remains unchecked on reopen");
		await reopenNotes(NOTES);
		console.log("  ok  navigation choices preserve disk bytes across autosave and external conflicts");

		// 1. Switching modes without typing changes nothing on disk and leaves the file clean.
		await page.getByRole("button", { name: "RAW", exact: true }).click();
		await raw.waitFor();
		// The text field fills the pane: a click anywhere in it puts the cursor there.
		const box = await raw.boundingBox();
		const body = await page.locator(".markdown-editor-body").boundingBox();
		// Against the window, not just the pane: the pane itself must fill the space below the tabs (viewport is 900 high).
		assert(box && body && box.height >= 500 && box.height >= body.height - 60, `RAW fills the window height, got ${box?.height} of ${body?.height}`);
		await page.getByRole("button", { name: "Edit", exact: true }).click();
		await page.getByRole("button", { name: "RAW", exact: true }).click();
		await raw.waitFor();
		await page.waitForTimeout(1500);
		assert(fs.readFileSync(notes, "utf8") === NOTES, "switching modes without typing leaves the file byte-identical");
		assert((await status.textContent())?.trim() === "Saved", `the file stays clean, got ${await status.textContent()}`);
		console.log("  ok  switching modes without typing changes nothing");

		// 2. Typing in RAW is saved exactly as typed, not normalised.
		await raw.click();
		await raw.evaluate((el) => { const t = el as HTMLTextAreaElement; t.setSelectionRange(t.value.length, t.value.length); });
		await page.keyboard.type("RAW tail");
		await waitUntil(() => fs.readFileSync(notes, "utf8").includes("RAW tail"), "the RAW edit is autosaved");
		const afterRaw = fs.readFileSync(notes, "utf8");
		assert(afterRaw === NOTES + "RAW tail", `only the typed text is added, nothing is reformatted: ${JSON.stringify(afterRaw)}`);
		const shown = await raw.inputValue();
		assert(fs.readFileSync(notes, "utf8") === shown, `what RAW shows is what was saved, byte for byte: ${JSON.stringify(shown)} vs ${JSON.stringify(fs.readFileSync(notes, "utf8"))}`);
		await waitUntil(async () => (await status.textContent())?.trim() === "Saved", "RAW edit shows as saved");
		console.log("  ok  RAW typing is saved byte for byte");

		// 3. The rich editor shows the RAW edit, and a markup edit made in RAW is rendered.
		await raw.click();
		await raw.evaluate((el) => { const t = el as HTMLTextAreaElement; t.setSelectionRange(t.value.length, t.value.length); });
		await page.keyboard.type("\n\n## From RAW\n");
		await waitUntil(() => fs.readFileSync(notes, "utf8").includes("## From RAW"), "the heading typed in RAW is saved");
		await page.getByRole("button", { name: "Edit", exact: true }).click();
		await page.locator(".markdown-editor-tiptap .ProseMirror h2", { hasText: "From RAW" }).waitFor();
		console.log("  ok  Edit shows what RAW typed");
		await page.getByRole("button", { name: "Preview", exact: true }).click();
		await page.locator(".markdown-editor-tiptap .ProseMirror h2", { hasText: "From RAW" }).waitFor();
		await page.getByRole("button", { name: "Edit", exact: true }).click();
		const rich = page.locator(".markdown-editor-tiptap .ProseMirror");
		await rich.click();
		await page.keyboard.press("Control+End");
		await page.keyboard.type(" rich edit");
		await page.getByRole("button", { name: "RAW", exact: true }).click();
		assert((await raw.inputValue()).includes("rich edit"), "RAW shows the current rich edit");
		await waitUntil(() => fs.readFileSync(notes, "utf8").includes("rich edit"), "the rich edit is saved");
		console.log("  ok  Preview shows RAW text and RAW shows rich edits");


		// 4. A change made on disk while RAW is dirty gives the conflict choice, and Reload wins.
		await page.getByRole("button", { name: "RAW", exact: true }).click();
		await raw.waitFor();
		await page.route("**/workspace-markdown?**", async (route) => {
			if (route.request().method() === "PUT") await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "mock save failure" }) });
			else await route.continue();
		});
		await raw.click();
		await raw.evaluate((el) => { const t = el as HTMLTextAreaElement; t.setSelectionRange(t.value.length, t.value.length); });
		await page.keyboard.type(" unsaved");
		await page.locator(".markdown-editor-error").waitFor({ state: "visible" });
		await page.unroute("**/workspace-markdown?**");
		fs.writeFileSync(notes, "# Changed outside\n");
		await page.locator(".markdown-editor-save").click();
		await page.locator(".markdown-editor-conflict").waitFor({ state: "visible" });
		await page.getByRole("button", { name: "Reload" }).click();
		await waitUntil(async () => (await raw.inputValue()) === "# Changed outside\n", "Reload replaces the RAW text");
		await page.waitForTimeout(2500);
		assert(fs.readFileSync(notes, "utf8") === "# Changed outside\n", "an old RAW draft is not written over the reloaded file");
		console.log("  ok  Reload wins over a dirty RAW draft");

		// 5. Keep mine writes the RAW draft.
		await raw.click();
		await raw.evaluate((el) => { const t = el as HTMLTextAreaElement; t.setSelectionRange(t.value.length, t.value.length); });
		await page.keyboard.type("mine");
		await waitUntil(() => fs.readFileSync(notes, "utf8") === "# Changed outside\nmine", "the next RAW edit is saved on top of the reloaded file");
		console.log("  ok  RAW saves again after a reload");

		// A conflicting disk edit must retain the draft until Keep mine saves it.
		await page.route("**/workspace-markdown?**", async (route) => {
			if (route.request().method() === "PUT") await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "mock save failure" }) });
			else await route.continue();
		});
		await raw.fill("# Local draft\n");
		await page.locator(".markdown-editor-error").waitFor({ state: "visible" });
		assert((await raw.inputValue()) === "# Local draft\n", "failed save retains the draft");
		await page.unroute("**/workspace-markdown?**");
		fs.writeFileSync(notes, "# Outside revision\n");
		await page.locator(".markdown-editor-save").click();
		await page.locator(".markdown-editor-conflict").waitFor({ state: "visible" });
		await page.getByRole("button", { name: "Keep mine" }).click();
		await waitUntil(() => fs.readFileSync(notes, "utf8") === "# Local draft\n", "Keep mine saves the draft");
		await page.getByRole("button", { name: "Edit", exact: true }).click();
		await page.getByRole("button", { name: "RAW", exact: true }).click();
		assert((await raw.inputValue()) === "# Local draft\n", "Keep mine survives mode switches");
		console.log("  ok  failed save retains draft and Keep mine resolves conflict");

		// A later edit made while a PUT is held must also reach disk.
		let releasePut!: () => void;
		let signalPut!: () => void;
		const putStarted = new Promise<void>((resolve) => { signalPut = resolve; });
		const heldPut = new Promise<void>((resolve) => { releasePut = resolve; });
		let held = false;
		await page.route("**/workspace-markdown?**", async (route) => {
			if (route.request().method() === "PUT" && !held) { held = true; signalPut(); await heldPut; }
			await route.continue();
		});
		await raw.fill("# First save\n");
		await putStarted;
		await raw.fill("# Later edit\n");
		releasePut();
		await waitUntil(() => fs.readFileSync(notes, "utf8") === "# Later edit\n", "later edit saves after the held PUT");
		await page.unroute("**/workspace-markdown?**");
		await page.getByRole("button", { name: "Edit", exact: true }).click();
		await page.getByRole("button", { name: "RAW", exact: true }).click();
		assert((await raw.inputValue()) === "# Later edit\n", "later edit survives mode switches");
		console.log("  ok  later RAW edits survive an in-flight save");
		await waitUntil(async () => (await status.textContent())?.trim() === "Saved", "later edit is clean");
		const external = "# External clean update\n\n* one\n* two\n\n\nTail\n";
		const read = await api(markdownRoute);
		assert(read.status === 200, "read the workspace Markdown through its API");
		const replacement = await api(markdownRoute, { method: "PUT", body: JSON.stringify({ content: external, revision: read.body.revision }) });
		assert(replacement.status === 200, "replace the workspace Markdown through its API");
		await waitUntil(async () => (await raw.inputValue()) === external, "clean RAW adopts an external replacement", 15_000);
		let cleanPuts = 0;
		const countCleanPut = (request: import("playwright").Request) => {
			if (request.url().includes("/workspace-markdown?") && request.method() === "PUT") cleanPuts++;
		};
		page.on("request", countCleanPut);
		await page.keyboard.press("Control+s");
		await page.getByRole("button", { name: "Edit", exact: true }).click();
		await page.getByRole("button", { name: "RAW", exact: true }).click();
		assert((await raw.inputValue()) === external, "clean save and mode switches retain the exact external source");
		await page.waitForTimeout(1500);
		page.off("request", countCleanPut);
		assert(cleanPuts === 0, "clean save sends no workspace PUT");
		assert(fs.readFileSync(notes, "utf8") === external, "clean save does not rewrite the external source");

		await page.route("**/workspace-markdown?**", async (route) => {
			if (route.request().method() === "PUT") await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "mock save failure" }) });
			else await route.continue();
		});
		await raw.fill(external + "draft");
		await page.locator(".markdown-editor-error").waitFor({ state: "visible" });
		await tree.locator(".workspace-file-browser-file", { hasText: "todo.md" }).click();
		await page.getByRole("dialog", { name: "Unsaved Markdown changes" }).getByRole("button", { name: "Discard changes" }).click();
		await page.unroute("**/workspace-markdown?**");
		await openNotes();
		await page.getByRole("button", { name: "RAW", exact: true }).click();
		await waitUntil(async () => (await raw.inputValue()) === external, "discard restores the exact source");
		cleanPuts = 0;
		page.on("request", countCleanPut);
		await page.keyboard.press("Control+s");
		await page.getByRole("button", { name: "Edit", exact: true }).click();
		await page.getByRole("button", { name: "RAW", exact: true }).click();
		await page.waitForTimeout(1500);
		page.off("request", countCleanPut);
		assert(cleanPuts === 0, "save after discard sends no workspace PUT");
		assert((await raw.inputValue()) === external && fs.readFileSync(notes, "utf8") === external, "discard and save retain exact source");
		console.log("  ok  clean replacement and discard preserve source on save");


		// 6. Task checkmarks. In Edit a rendered checkbox is clickable and saves "[x]".
		await tree.locator(".workspace-file-browser-file", { hasText: "todo.md" }).click();
		await page.getByRole("button", { name: "Edit", exact: true }).click();
		const boxes = page.locator('.markdown-editor-tiptap .ProseMirror input[type="checkbox"]');
		await waitUntil(async () => (await boxes.count()) === 2, "both task items render as checkboxes");
		const offsets = await boxes.evaluateAll((all) => all.map((box) => {
			const text = box.closest("li")?.querySelector("p")?.getBoundingClientRect();
			const mark = box.getBoundingClientRect();
			return text ? Math.abs((mark.top + mark.height / 2) - (text.top + text.height / 2)) : 99;
		}));
		assert(offsets.every((offset) => offset <= 3), `each checkbox sits on its text line, offsets ${JSON.stringify(offsets)}`);
		await boxes.first().click();
		await waitUntil(() => fs.readFileSync(todo, "utf8").includes("- [x] first"), "clicking a checkbox saves it as done");
		assert(fs.readFileSync(todo, "utf8").includes("- [x] second"), "the other task is untouched");
		await boxes.last().click();
		await waitUntil(() => fs.readFileSync(todo, "utf8").includes("- [ ] second"), "clicking a checked checkbox saves it as open");
		console.log("  ok  Edit: checkboxes save in both directions");

		// In RAW the task button works on the text, per line: plain -> open -> done -> open.
		await page.getByRole("button", { name: "RAW", exact: true }).click();
		await raw.waitFor();
		await raw.click();
		await raw.evaluate((el) => { const t = el as HTMLTextAreaElement; t.setSelectionRange(t.value.length, t.value.length); });
		await page.keyboard.type("plain note");
		await waitUntil(() => fs.readFileSync(todo, "utf8").endsWith("plain note"), "a plain line is typed in RAW");
		const taskButton = page.getByRole("button", { name: "Task list" });
		assert((await taskButton.getAttribute("aria-pressed")) === "false", "the task button is not active on a plain line");
		await taskButton.click();
		await waitUntil(() => fs.readFileSync(todo, "utf8").endsWith("- [ ] plain note"), "the button turns the line into an open task");
		assert((await taskButton.getAttribute("aria-pressed")) === "true", "the task button is active on a task line");
		await taskButton.click();
		await waitUntil(() => fs.readFileSync(todo, "utf8").endsWith("- [x] plain note"), "the button marks it done");
		await taskButton.click();
		await waitUntil(() => fs.readFileSync(todo, "utf8").endsWith("- [ ] plain note"), "a done task goes back to open, its checkbox stays");
		assert(fs.readFileSync(todo, "utf8").startsWith("# Todo\n\n- [x] first\n- [ ] second\n"), "other lines stay as they were");
		// Selected lines move one by one: done -> open, open -> done, open -> done.
		await raw.evaluate((el) => { const t = el as HTMLTextAreaElement; t.setSelectionRange(t.value.indexOf("- [x] first"), t.value.length); });
		await taskButton.click();
		const taskLines = () => fs.readFileSync(todo, "utf8").split("\n").filter((line) => line !== "");
		await waitUntil(() => JSON.stringify(taskLines()) === JSON.stringify(["# Todo", "- [ ] first", "- [x] second", "- [x] plain note"]), `selected lines each take their own step, got ${JSON.stringify(taskLines())}`);
		// The other toolbar buttons stay visible but are disabled in RAW.
		const states = await page.locator(".markdown-editor-toolbar .markdown-editor-tool").evaluateAll((all) => all.map((button) => ({ title: button.getAttribute("title") ?? "", disabled: (button as HTMLButtonElement).disabled })));
		assert(states.length >= 15, `the toolbar stays visible in RAW, got ${states.length} buttons`);
		const enabled = states.filter((state) => !state.disabled).map((state) => state.title);
		assert(enabled.join() === "Task list", `only the task button is enabled in RAW, got ${JSON.stringify(enabled)}`);
		console.log("  ok  RAW: the task button works per line, shows its state, and the rest is disabled");

		// 6b. Switching views never rewrites RAW text that was typed and saved. format.md has `*`
		// bullets and a double blank line on purpose: the rich editor would normalise both.
		await tree.locator(".workspace-file-browser-file", { hasText: "format.md" }).click();
		await page.getByRole("button", { name: "RAW", exact: true }).click();
		await raw.waitFor();
		await waitUntil(async () => (await raw.inputValue()) === FORMAT, "format.md is shown in RAW, exactly as on disk");
		await raw.click();
		await raw.evaluate((el) => { const t = el as HTMLTextAreaElement; t.setSelectionRange(t.value.length, t.value.length); });
		await page.keyboard.type("one");
		await waitUntil(() => fs.readFileSync(format, "utf8") === FORMAT + "one", `the RAW edit is saved exactly, got ${JSON.stringify(fs.readFileSync(format, "utf8"))}`);
		await page.getByRole("button", { name: "Edit", exact: true }).click();
		await page.locator(".markdown-editor-tiptap .ProseMirror").waitFor();
		await page.getByRole("button", { name: "RAW", exact: true }).click();
		await raw.waitFor();
		assert((await raw.inputValue()) === FORMAT + "one", `RAW shows the saved text after a round trip, got ${JSON.stringify(await raw.inputValue())}`);
		await raw.click();
		await raw.evaluate((el) => { const t = el as HTMLTextAreaElement; t.setSelectionRange(t.value.length, t.value.length); });
		await page.keyboard.type("two");
		await waitUntil(() => fs.readFileSync(format, "utf8") === FORMAT + "onetwo", `the next RAW edit keeps the formatting, got ${JSON.stringify(fs.readFileSync(format, "utf8"))}`);
		console.log("  ok  a RAW to Edit to RAW round trip keeps the typed text exactly");

		// 7. A read-only grant makes the RAW text read-only.
		const readOnly = await api(`/api/persistent-agents/${encodeURIComponent(agentId)}/workspace-default`, { method: "PUT", body: JSON.stringify({ toolSelection: { kind: "custom", allowedToolNames: ["ls", "read"] } }) });
		assert(readOnly.status === 200, "switch the room to read-only tools");
		await page.reload();
		await page.waitForLoadState("networkidle");
		if (await dismiss.count()) await dismiss.click();
		// The reload may land inside the room already; the room list only shows when it does not.
		if (await card.count()) await card.getByRole("button", { name: /^(Enter|Resume)$/ }).click();
		await openNotes();
		await page.getByRole("button", { name: "RAW", exact: true }).click();
		await raw.waitFor();
		assert(await raw.evaluate((el) => (el as HTMLTextAreaElement).readOnly), "RAW is read-only without a write grant");
		console.log("  ok  RAW is read-only without write access");
	} finally {
		await browser.close();
	}
	console.log("workspace markdown raw ui smoke passed");
} catch (error) {
	console.error(serverOutput.join("").slice(-2000));
	throw error;
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
