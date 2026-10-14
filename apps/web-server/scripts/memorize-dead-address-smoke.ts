// Memorize against a Memory model nothing listens for, through the real
// server and its real calls: the fold and the one-time sort each say the wait
// at once ("can't reach", not "busy"), ask the probe after about 15 s, and
// stop on the notice then, never after the six minutes a busy model gets.
// The calls a screen waits on as one request (Memorize's and Review's first
// reads) publish the same wait on the room's status route while they wait.
// Offline: the provider's address is a closed port.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer } from "./smoke-server-process.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 27000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-memorize-dead-address-"));
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

async function api(pathname: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, { method: init.method ?? "GET", signal: AbortSignal.timeout(5_000), ...(init.body !== undefined ? { body: JSON.stringify(init.body), headers: { "content-type": "application/json" } } : {}) });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

try {
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "fake-claude": { name: "Fake Claude", baseUrl: "http://127.0.0.1:9", api: "anthropic-messages", models: [{ id: "claude-fake", name: "Claude Fake", input: ["text"], contextWindow: 200000, maxTokens: 32000 }] } } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "fake-claude": { type: "api_key", key: "synthetic-claude" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [{ id: "custom-fake-claude", providerId: "fake-claude", label: "Fake Claude", roomModels: ["claude-fake"], learnModel: "claude-fake", reviewMemoryModel: "claude-fake" }] }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "custom-fake-claude" }, null, 2), { mode: 0o600 });

	const agents = await import("../src/persistent-agents.js");
	const roomModels = await import("../src/room-models.js");
	const page = (id: string, title: string) => [`### ${id} | CLOSED | 2026-09-11 | ${title}`, "", `**Session arc:** ${title} was settled.`, "", "**Body:**", `- ${title} is the durable point.`, "", "**Parked:**", "None", ""].join("\n");
	const unsorted = ["### Unsorted", "", "<!-- e: id=m-0101 kind=fact saved=2026-09-01 -->", "- Invoices go out on the first working day.", "", ""].join("\n");
	const createRoom = (name: string, withUnsorted: boolean) => {
		const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName: name, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
		roomModels.writeRoomModels(agentId, { conversation: MODEL, memory: MODEL });
		const l1bPath = path.join(agentsRoot, agentId, "L1b", "current.md");
		let text = fs.readFileSync(l1bPath, "utf-8");
		if (withUnsorted) {
			const active = /^##\s+Active Items\s*$/m.exec(text)!;
			text = `${text.slice(0, active.index)}${unsorted}${text.slice(active.index)}`;
		}
		const at = /^##\s+Recent Context\s*$/m.exec(text)!;
		fs.writeFileSync(l1bPath, `${text.slice(0, at.index + at[0].length)}\n\n${page("RC-0001", "First plan")}\n`, "utf-8");
		return agentId;
	};
	const rooms = { fold: createRoom("Fold Room", false), sort: createRoom("Sort Room", true) };
	const readRooms = { absorb: createRoom("Memorize Read Room", true), review: createRoom("Review Read Room", true) };
	createRoom("Screen Room", true);

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

	await Promise.all(Object.entries(rooms).map(async ([kind, agentId]) => {
		const startedAt = Date.now();
		const proposed = await api(`/api/persistent-agents/${agentId}/absorb/propose`, { method: "POST", body: { assessmentMarkdown: "## What these sessions leave behind\n\n- One plan." } });
		assert(proposed.status === 202, `${kind}: Memorize starts, got ${proposed.status}: ${JSON.stringify(proposed.body)}`);
		const runUrl = `/api/persistent-agents/${agentId}/absorb/runs/${proposed.body.runId}`;
		let sawUnreached = false;
		let sawBusy = false;
		for (;;) {
			const polled = await api(runUrl);
			assert(polled.status === 200, `${kind}: the run can be watched, got ${polled.status}`);
			const run = polled.body;
			if (run.wait?.cause === "unreached") sawUnreached = true;
			if (run.wait?.cause === "busy") sawBusy = true;
			if (run.stop) {
				const seconds = (Date.now() - startedAt) / 1000;
				assert(run.stop.kind === "outage" && run.stop.cause === "not-answering", `${kind}: the run stops on the notice, got ${JSON.stringify(run.stop)}`);
				assert(sawUnreached && !sawBusy, `${kind}: the wait was said as can't reach, never as busy (unreached ${sawUnreached}, busy ${sawBusy})`);
				assert(seconds >= 12 && seconds < 45, `${kind}: the notice comes after about 15 s, got ${seconds} s`);
				console.log(`  ok  ${kind}: a dead address says the wait at once and reaches the notice in ${Math.round(seconds)} s`);
				return;
			}
			assert(Date.now() - startedAt < 60_000, `${kind}: no notice within a minute (unreached ${sawUnreached}, busy ${sawBusy}, state ${run.state})`);
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}));
	// The first reads: the request stays open through the wait, and the room's status says the wait meanwhile.
	await Promise.all(Object.entries(readRooms).map(async ([kind, agentId]) => {
		const startedAt = Date.now();
		const read = authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/${kind}/assess`, { method: "POST", body: "{}", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(60_000) }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }));
		let seen: any = null;
		let answered: { status: number; body: any } | null = null;
		void read.then((result) => { answered = result; });
		while (!answered && Date.now() - startedAt < 55_000) {
			const status = await api(`/api/persistent-agents/${agentId}/${kind}/status`);
			if (status.body?.wait) seen = status.body.wait;
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		const result = await read;
		assert(seen?.cause === "unreached" && typeof seen.nextTryAt === "string", `${kind}: the first read's wait shows on the room's status, got ${JSON.stringify(seen)}`);
		// Review's read ends in the notice; Memorize's never fails and answers with its first read missing.
		const ended = kind === "review" ? result.status === 503 && result.body?.code === "model_unreachable" : result.status === 200 && Boolean(result.body?.firstReadMissing);
		assert(ended && Date.now() - startedAt >= 12_000, `${kind}: the first read ends after the wait, got ${result.status} ${JSON.stringify(result.body).slice(0, 300)}`);
		const after = await api(`/api/persistent-agents/${agentId}/${kind}/status`);
		assert(!after.body?.wait, `${kind}: the wait is gone once the read ended, got ${JSON.stringify(after.body?.wait)}`);
		console.log(`  ok  ${kind}: the first read's wait is said on the room's status while the request is open`);
	}));
	// On screen: Memorize's first read says the wait while its one request is open.
	const executable = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!executable || !fs.existsSync(executable)) {
		console.log("  skip the screen check (Chromium not installed)");
	} else {
		const browser = await chromium.launch();
		try {
			const ui = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
			await ui.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
			await ui.waitForLoadState("networkidle");
			const dismiss = ui.locator(".whats-new-foot .btn-primary");
			if (await dismiss.count()) await dismiss.click();
			await ui.locator(".persistent-agent-card").filter({ hasText: "Screen Room" }).getByRole("button", { name: "Maintain", exact: true }).click();
			await ui.locator(".maintain-action").filter({ hasText: "Memorize" }).first().click();
			await ui.getByText(/^Can't reach the Memory model right now\. Trying again at .+\.$/).waitFor({ timeout: 12_000 });
			console.log("  ok  Memorize's first read says the wait on screen while it waits");
		} finally {
			await browser.close();
		}
	}
	console.log("memorize dead address smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-3000));
	throw error;
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
