// A Memorize cut by a restart, in the browser: Maintain opens the kept card at
// once (not the plain chooser), and the card offers Continue, not Choose
// another model, since the model was answering. A run cut before any conversation
// was read shows Review's paused card with Memorize's name, and its Cancel asks
// nothing. Offline: the run is journaled
// by the real run code in this process, then the server starts and revives it.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort } from "./smoke-server-process.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("memorize restart card smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-memorize-restart-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

const MODEL = { provider: "fake-claude", model: "claude-fake", label: "Claude Fake" };
let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];

async function waitUntil(predicate: () => Promise<boolean> | boolean, label: string, timeoutMs = 25_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`timed out waiting until ${label}`);
}

try {
	// Nothing listens here: the revived run makes no call until Continue.
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "fake-claude": { name: "Fake Claude", baseUrl: "http://127.0.0.1:9", api: "anthropic-messages", models: [{ id: "claude-fake", name: "Claude Fake", input: ["text"], contextWindow: 200000, maxTokens: 32000 }] } } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "fake-claude": { type: "api_key", key: "synthetic-claude" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [{ id: "custom-fake-claude", providerId: "fake-claude", label: "Fake Claude", roomModels: ["claude-fake"], learnModel: "claude-fake", reviewMemoryModel: "claude-fake" }] }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "custom-fake-claude" }, null, 2), { mode: 0o600 });

	const agents = await import("../src/persistent-agents.js");
	const roomModels = await import("../src/room-models.js");
	const run = await import("../src/absorb-run.js");
	const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Restart Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	roomModels.writeRoomModels(agentId, { conversation: MODEL, memory: MODEL });
	const l1bPath = path.join(agentsRoot, agentId, "L1b", "current.md");
	const page = (id: string, title: string) => [`### ${id} | CLOSED | 2026-09-11 | ${title}`, "", `**Session arc:** ${title} was settled.`, "", "**Body:**", `- ${title} is the durable point.`, "", "**Parked:**", "None", ""].join("\n");
	const scaffold = fs.readFileSync(l1bPath, "utf-8");
	const at = /^##\s+Recent Context\s*$/m.exec(scaffold)!;
	fs.writeFileSync(l1bPath, `${scaffold.slice(0, at.index + at[0].length)}\n\n${page("RC-0001", "First plan")}\n${page("RC-0002", "Second plan")}\n`, "utf-8");

	// The run folds the first page, then hangs on the second: the app "restarts" there.
	const fence = (ops: unknown[]) => `\`\`\`json\n${JSON.stringify({ ops })}\n\`\`\``;
	const started = run.startAbsorbRun({
		agentId,
		assessmentMarkdown: "## What these sessions leave behind\n\n- Two plans.",
		model: MODEL,
		generate: async (prompt) => (prompt.includes("RC-0001") ? { text: fence([{ op: "add", topic: "Plans", kind: "fact", text: "- First plan is the durable point." }]) } : new Promise(() => {})),
		probe: async () => ({ text: "OK" }),
	});
	await waitUntil(() => run.getAbsorbRun(agentId, started.runId).sessions.some((session) => session.outcome === "folded"), "the first page is folded");
	await waitUntil(() => fs.existsSync(path.join(agentsRoot, agentId, "runtime", "memorize-run.json")), "the run is journaled");

	// A second room whose run the restart cuts before any conversation was read: Review's paused card, with Memorize's name.
	const unreadId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Unread Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	roomModels.writeRoomModels(unreadId, { conversation: MODEL, memory: MODEL });
	const unreadL1b = path.join(agentsRoot, unreadId, "L1b", "current.md");
	const unreadScaffold = fs.readFileSync(unreadL1b, "utf-8");
	const unreadAt = /^##\s+Recent Context\s*$/m.exec(unreadScaffold)!;
	fs.writeFileSync(unreadL1b, `${unreadScaffold.slice(0, unreadAt.index + unreadAt[0].length)}\n\n${page("RC-0001", "First plan")}\n${page("RC-0002", "Second plan")}\n`, "utf-8");
	const unread = run.startAbsorbRun({ agentId: unreadId, assessmentMarkdown: "## What these sessions leave behind\n\n- Two plans.", model: MODEL, generate: () => new Promise(() => {}), probe: async () => ({ text: "OK" }) });
	const unreadJournal = path.join(agentsRoot, unreadId, "runtime", "memorize-run.json");
	await waitUntil(() => run.getAbsorbRun(unreadId, unread.runId).sessions.some((session) => session.outcome === "folding") && fs.existsSync(unreadJournal) && fs.readFileSync(unreadJournal, "utf-8").includes('"folding"'), "the unread room's first page is in flight and journaled");

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready");

	const browser = await chromium.launch();
	try {
		const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		const ui = await ctx.newPage();
		await ui.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await ui.waitForLoadState("networkidle");
		const dismiss = ui.locator(".whats-new-close");
		if (await dismiss.count()) await dismiss.click();
		await ui.locator(".persistent-agent-card").filter({ hasText: "Restart Room" }).getByRole("button", { name: "Maintain", exact: true }).click();
		const card = ui.locator('[aria-label="Memory absorption workflow"]');
		await card.getByText("The app restarted.").waitFor({ timeout: 15000 });
		assert(await card.getByRole("button", { name: "Continue" }).count() === 1, "the kept card offers Continue");
		assert(await card.getByRole("button", { name: "Choose another model" }).count() === 0, "a restart where the model answered offers no other model");
		await ctx.close();

		const unreadCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		const unreadUi = await unreadCtx.newPage();
		await unreadUi.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await unreadUi.waitForLoadState("networkidle");
		if (await unreadUi.locator(".whats-new-close").count()) await unreadUi.locator(".whats-new-close").click();
		await unreadUi.locator(".persistent-agent-card").filter({ hasText: "Unread Room" }).getByRole("button", { name: "Maintain", exact: true }).click();
		const unreadCard = unreadUi.locator('[aria-label="Memory absorption workflow"]');
		await unreadCard.getByText("The app restarted.").waitFor({ timeout: 15000 });
		const unreadText = await unreadCard.innerText();
		assert(await unreadCard.getByRole("heading", { name: "Memorize paused." }).count() === 1 && unreadText.includes("The app restarted. Nothing was lost.") && !unreadText.includes("Continue reads") && !unreadText.includes("will keep") && !unreadText.includes("Step 2 of 2"), `nothing read: "Memorize paused." over Review's restart words, with no step line (got: ${JSON.stringify(unreadText.slice(0, 600))})`);
		assert(!unreadText.includes("New in memory") && !unreadText.includes("No conversation was read yet."), `nothing read: no empty block (got: ${JSON.stringify(unreadText.slice(0, 600))})`);
		const unreadRow = (await unreadCard.locator(".checkpoint-preview-actions button").allInnerTexts()).map((label) => label.trim());
		const unreadMain = (await unreadCard.locator(".checkpoint-preview-actions button.rs-btn-primary").allInnerTexts()).map((label) => label.trim());
		assert(unreadRow.join("|") === "Cancel|Continue" && unreadMain.join("|") === "Continue", `nothing read: one row, Cancel, then Continue as the main button (got: ${unreadRow.join("|")}, main ${unreadMain.join("|")})`);
		// Cancel asks nothing on a card with nothing to save. This card was opened because its run was waiting, so a first read of the conversations starts.
		await unreadCard.locator(".checkpoint-preview-actions").getByRole("button", { name: "Cancel", exact: true }).click();
		await unreadUi.waitForTimeout(800);
		assert(await unreadUi.getByRole("dialog", { name: "Stop this memory update?" }).count() === 0, "nothing read: Cancel asks nothing");
		await unreadCard.getByText("Reading the waiting conversations").first().waitFor({ timeout: 15000 });
		assert(await unreadCard.getByRole("heading", { name: "Memorize paused." }).count() === 0, "nothing read: Cancel leaves the paused card for a first read");
		await unreadCtx.close();
	} finally {
		await browser.close();
	}
	console.log("memorize restart card smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-3000));
	throw error;
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
