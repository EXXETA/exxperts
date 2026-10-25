// Home while the app's own server is down, and after it is back. Entering a
// room whose request gets no answer puts one plain sentence in Home's red
// strip, never the browser's "Failed to fetch", and the strip clears once the
// page reconnects after the server's restart. Archived rooms that could not be loaded say so with a space
// before "Try again", and are asked for again on the reconnect. That second
// ask keeps what the section was saying ("… is back on Home."), as a restore
// and an outage often come together.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort } from "./smoke-server-process.js";

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("home service back smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const SENTENCE = "exxperts could not reach its own service just now. Try again; if it repeats, restart exxperts.";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-home-service-back-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

async function waitUntil(predicate: () => Promise<boolean> | boolean, label: string, timeoutMs = 25_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`timed out waiting until ${label}`);
}

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];

async function startServer(): Promise<void> {
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready", 60_000);
}

try {
	// A provider at an address nobody answers: the room only has to be offered, never asked.
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
		providers: { "fake-claude": { name: "Fake Claude", baseUrl: "http://127.0.0.1:9", api: "anthropic-messages", models: [{ id: "claude-fake", name: "Claude Fake", input: ["text"], contextWindow: 200000, maxTokens: 32000 }] } },
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "fake-claude": { type: "api_key", key: "synthetic-claude" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [
		{ id: "custom-fake-claude", providerId: "fake-claude", label: "Fake Claude", roomModels: ["claude-fake"], learnModel: "claude-fake", reviewMemoryModel: "claude-fake" },
	] }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "custom-fake-claude" }, null, 2), { mode: 0o600 });
	const agents = await import("../src/persistent-agents.js");
	const roomModels = await import("../src/room-models.js");
	const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Strip Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	roomModels.writeRoomModels(agentId, { conversation: { provider: "fake-claude", model: "claude-fake" } });
	const oldRoom = agents.createPersistentAgentFromScaffoldInput({ displayName: "Old Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	agents.archivePersistentAgent(oldRoom, { confirmation: `DELETE ${oldRoom}` });
	await startServer();

	const browser = await chromium.launch();
	try {
		const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		const page = await ctx.newPage();
		// Requests get no answer while `down` holds: the archived list on the first
		// load, then the room's Enter, with the socket still open so the door is offered.
		const down = { archived: true, all: false };
		await page.route("**/api/**", (route) => {
			const url = route.request().url();
			if (down.all || (down.archived && url.endsWith("/api/persistent-agents/archived"))) return route.abort("failed");
			return route.continue();
		});
		await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await page.waitForLoadState("networkidle");
		const dismiss = page.locator(".whats-new-close");
		if (await dismiss.count()) await dismiss.click();

		const archivedNote = page.locator(".archived-rooms-note");
		await archivedNote.waitFor({ timeout: 15_000 });
		const noteText = (await archivedNote.innerText()).replace(/\s+/g, " ").trim();
		const failures: string[] = [];
		if (noteText !== "Archived rooms could not be loaded. Try again") failures.push(`archived note reads "${noteText}"`);

		down.all = true;
		const door = page.locator(".persistent-agent-card").filter({ hasText: "Strip Room" }).getByRole("button", { name: /^(Enter|Resume) →$/ });
		await door.click();
		const strip = page.locator(".home-resume-error");
		await strip.waitFor({ timeout: 15_000 });
		const stripText = (await strip.innerText()).trim();
		if (stripText !== SENTENCE) failures.push(`the strip reads "${stripText}"`);

		await stopSmokeServer(server);
		server = undefined;
		await page.waitForTimeout(1_500);
		down.archived = false;
		down.all = false;
		await startServer();
		try {
			await waitUntil(async () => (await strip.count()) === 0, "the strip clears once the page reconnects", 40_000);
		} catch (error) {
			failures.push(`${(error as Error).message}; it still reads "${(await strip.innerText().catch(() => "")).trim()}"`);
		}
		try {
			await waitUntil(async () => (await archivedNote.count()) === 0, "archived rooms are asked for again on the reconnect", 10_000);
		} catch (error) {
			failures.push((error as Error).message);
		}

		// A restore's note, then an outage: the reconnect's second ask keeps the note.
		await page.locator(".archived-rooms-summary").click();
		await page.locator(".archived-room-row").filter({ hasText: "Old Room" }).getByRole("button", { name: "Restore" }).click();
		const restored = page.locator('.archived-rooms-note[role="status"]');
		await restored.waitFor({ timeout: 15_000 });
		const restoredText = (await restored.innerText()).trim();
		await page.waitForTimeout(1_000);
		await stopSmokeServer(server);
		server = undefined;
		await page.waitForTimeout(1_500);
		const askedAgain = page.waitForResponse((response) => response.url().endsWith("/api/persistent-agents/archived"), { timeout: 40_000 });
		await startServer();
		await askedAgain;
		await page.waitForTimeout(500);
		const after = (await restored.count()) > 0 ? (await restored.innerText()).trim() : "(no note)";
		if (after !== restoredText) failures.push(`after the reconnect the archived section's note reads "${after}", not "${restoredText}"`);
		if (failures.length > 0) throw new Error(`home service back:\n  ${failures.join("\n  ")}`);
		await ctx.close();
	} finally {
		await browser.close();
	}
	console.log("home-service-back-ui smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-4000));
	throw error;
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
