// A time on screen reads in the person's own clock: 12-hour where their
// browser's locale says so, 24-hour where it does not. Two lines show it, both
// worded on the page from the time the server sends as data: a sign-in plan's
// reset in a saved chat line, and the Memory model's wait while Memorize's
// first read waits on a model nothing listens for. Offline: the provider's
// address is a closed port.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort } from "./smoke-server-process.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

{
	const executable = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!executable || !fs.existsSync(executable)) {
		console.log("clock format smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-clock-format-"));
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
// Each locale's own clock: 12-hour with AM or PM, or two-digit 24-hour.
const LOCALES = [
	{ locale: "en-US", clock: /^\d{1,2}:\d\d\s[AP]M$/ },
	{ locale: "en-GB", clock: /^\d\d:\d\d$/ },
] as const;
let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];

try {
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "fake-claude": { name: "Fake Claude", baseUrl: "http://127.0.0.1:9", api: "anthropic-messages", models: [{ id: "claude-fake", name: "Claude Fake", input: ["text"], contextWindow: 200000, maxTokens: 32000 }] } } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "fake-claude": { type: "api_key", key: "synthetic-claude" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [{ id: "custom-fake-claude", providerId: "fake-claude", label: "Fake Claude", roomModels: ["claude-fake"], learnModel: "claude-fake", reviewMemoryModel: "claude-fake" }] }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "custom-fake-claude" }, null, 2), { mode: 0o600 });

	const agents = await import("../src/persistent-agents.js");
	const roomModels = await import("../src/room-models.js");
	// A room with a remembered conversation and an unsorted note, so Memorize has something to read.
	const createRoom = (name: string) => {
		const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName: name, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
		roomModels.writeRoomModels(agentId, { conversation: MODEL, memory: MODEL });
		const l1bPath = path.join(agentsRoot, agentId, "L1b", "current.md");
		let text = fs.readFileSync(l1bPath, "utf-8");
		const active = /^##\s+Active Items\s*$/m.exec(text)!;
		text = `${text.slice(0, active.index)}### Unsorted\n\n<!-- e: id=m-0101 kind=fact saved=2026-09-01 -->\n- Invoices go out on the first working day.\n\n\n${text.slice(active.index)}`;
		const at = /^##\s+Recent Context\s*$/m.exec(text)!;
		const page = ["### RC-0001 | CLOSED | 2026-09-11 | First plan", "", "**Session arc:** First plan was settled.", "", "**Body:**", "- First plan is the durable point.", "", "**Parked:**", "None", ""].join("\n");
		fs.writeFileSync(l1bPath, `${text.slice(0, at.index + at[0].length)}\n\n${page}\n`, "utf-8");
		return agentId;
	};
	const rooms = Object.fromEntries(LOCALES.map(({ locale }) => [locale, { name: `Clock Room ${locale}`, id: createRoom(`Clock Room ${locale}`) }]));

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	const ready = Date.now() + 25_000;
	while (!(await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(2_000) }).then((r) => r.ok).catch(() => false))) {
		assert(server.exitCode == null, `server exited before startup with code ${server.exitCode}`);
		assert(Date.now() < ready, "server did not become ready");
		await new Promise((resolve) => setTimeout(resolve, 150));
	}

	// A plan's limit reached earlier, saved with its reset two hours on: the line is worded again for the moment it is read.
	const resetsAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
	const quotaLine = {
		kind: "system",
		id: "s1",
		level: "error",
		text: "Claude Fake has reached your plan's usage limit. Nothing was lost. It resets at 03:00: try again then, or choose another model in Room settings, Model.",
		failure: "quota",
		provider: MODEL.provider,
		quotaWay: { kind: "sign-in", provider: "Fake Claude", resetsAt },
	};
	for (const { locale } of LOCALES) {
		const seeded = await authedFetch(`${baseUrl}/api/persistent-agents/${rooms[locale]!.id}/threads/c_clock_0001`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: "standby", origin: "home", items: [{ kind: "user", id: "u1", text: "Earlier question." }, quotaLine] }) });
		assert(seeded.ok, `${locale}: the conversation is saved, got ${seeded.status} ${await seeded.text()}`);
	}

	const browser = await chromium.launch();
	try {
		for (const { locale, clock } of LOCALES) {
			const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale });
			const page = await context.newPage();
			await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
			await page.waitForLoadState("networkidle");
			const dismiss = page.locator(".whats-new-close");
			if (await dismiss.count()) await dismiss.click();
			const room = rooms[locale]!;

			// The plan's reset, in the saved chat line.
			await page.locator(".persistent-agent-card").filter({ hasText: room.name }).getByRole("button", { name: "Resume →" }).click();
			await page.getByText("Earlier question.").first().waitFor({ timeout: 15_000 });
			const line = page.locator(".failure-line", { hasText: "It resets" });
			await line.waitFor({ timeout: 10_000 });
			const said = (await line.innerText()).replace(/\s+/g, " ").trim();
			const reset = /It resets (?:at|tomorrow at|on .+? at) (.+?): try again then/.exec(said)?.[1];
			assert(reset !== undefined && clock.test(reset), `${locale}: the plan's reset reads in the locale's clock, got ${JSON.stringify(said)}`);
			console.log(`  ok  ${locale}: a plan's reset reads "${reset}"`);

			// The Memory model's wait, on Memorize's first read.
			await page.goto(`${baseUrl}/`);
			await page.waitForLoadState("networkidle");
			if (await dismiss.count()) await dismiss.click();
			await page.locator(".persistent-agent-card").filter({ hasText: room.name }).getByRole("button", { name: "Maintain", exact: true }).click();
			await page.locator(".maintain-action").filter({ hasText: "Memorize" }).first().click();
			const wait = page.getByText(/^Can't reach the Memory model right now\. Trying again at .+\.$/);
			await wait.waitFor({ timeout: 12_000 });
			const next = /Trying again at (.+)\.$/.exec((await wait.innerText()).trim())?.[1];
			assert(next !== undefined && clock.test(next), `${locale}: the wait's next try reads in the locale's clock, got ${JSON.stringify(next)}`);
			console.log(`  ok  ${locale}: the Memory model's wait reads "${next}"`);
			await context.close();
		}
	} finally {
		await browser.close();
	}
	console.log("clock format smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-3000));
	throw error;
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
