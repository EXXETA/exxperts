// The Memory model's size against the room's memory (decision 1).
//
// One number, minimumMemoryWindow(budget, model): the smallest window whose
// prompt budget, by the formula every fit guard uses, holds Memorize's fold
// for a room whose memory stands at its budget. Offline it is measured: a room
// built from the frozen corpus at budgets of 10k, 20k and 80k, its fold prompt
// with the first read and a page at their caps, and its Review first read, fit
// the window the function names, on Claude and on another model, and the
// numbers are printed. Against a spawned server, a window too small is refused
// where it is chosen and where it starts to matter: the Memory pick (and a
// pick cleared back to a default too small, naming the default), raising the
// memory budget, the AI defaults (every room on the default, naming the first
// that does not fit and its own pick as the other way out), and the start of
// Memorize and Review after a gateway's window shrank, with the code the model
// notice reads.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { authedFetch, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, type AuthedFetchInit } from "./smoke-server-process.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-memory-model-size-"));
const tempHome = path.join(tempRoot, "home");
fs.mkdirSync(tempHome, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = path.join(tempHome, ".exxperts", "app", "personalized-agents");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const failures: string[] = [];
async function check(label: string, run: () => void | Promise<void>): Promise<void> {
	try {
		await run();
		console.log(`  ok  ${label}`);
	} catch (error) {
		failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
		console.log(`  FAIL ${label}`);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");

const CLAUDE = { provider: "anthropic", model: "claude-sonnet-5-5" };
const OTHER = { provider: "openai-codex", model: "gpt-6.1-sol" };
const BUDGETS = [10_000, 20_000, 80_000];

// --- Offline: the number, measured ------------------------------------------------

const tokenEstimate = await import("../src/token-estimate.js");
const memoryEntries = await import("../src/memory-entries.js");
const absorbOps = await import("../src/absorb-ops.js");
const reviewAssess = await import("../src/review-assess.js");
const { maintenancePromptTokenBudget } = await import("../src/persistent-agents.js");
const { ABSORB_RUN_ASSESSMENT_MAX_CHARS } = await import("../src/absorb-run.js");
const { CHECKPOINT_PAGE_MAX_CHARS } = await import("../src/checkpoint-compression.js");

const corpus = JSON.parse(fs.readFileSync(path.join(scriptDir, "fixtures", "synthetic-room-corpus.json"), "utf-8")) as { sections: Array<{ topic: string; entries: Array<{ text: string }> }> };
const corpusNotes = corpus.sections.flatMap((section) => section.entries.map((entry) => entry.text));

/** A room whose Deep Memory and Active Items stand at `budget`: corpus notes in their topics, every tenth an open item, each with the day a conversation taught it. */
function roomAtBudget(budget: number) {
	const doc: any = { preamble: "<!-- exxeta:l1b schema_version=1 -->\n\n", chronos: "", topics: [], recentContext: "", otherSections: [], nextEntryNumber: 1 };
	for (const section of corpus.sections) doc.topics.push({ section: "Deep Memory", title: section.topic, heading: `### ${section.topic}`, intro: "", entries: [] });
	const items = { section: "Active Items", title: "Active Items", heading: null, intro: "", entries: [] as any[] };
	doc.topics.push(items);
	for (let n = 0; ; n += 1) {
		const item = n % 10 === 9;
		const topic = item ? items : doc.topics[n % corpus.sections.length];
		const text = `${corpusNotes[n % corpusNotes.length]}${n >= corpusNotes.length ? ` (${Math.floor(n / corpusNotes.length) + 1})` : ""}`;
		topic.entries.push({ id: memoryEntries.formatEntryId(n + 1), kind: item ? "item" : "fact", saved: "2026-08-02", from: `RC-${String(n + 1).padStart(4, "0")}`, learned: "2026-08-02", pinned: false, ...(item ? { status: "open" } : {}), text: `- ${text}` });
		if (memoryEntries.reviewTargetTokens(doc) > budget) {
			topic.entries.pop();
			doc.nextEntryNumber = n + 1;
			return doc;
		}
	}
}

const firstRead = `### What this run should do\n\n${"The renewal moved to June, Mara owns the vendor review now, and the pilot numbers replace the March estimate. ".repeat(400)}`.slice(0, ABSORB_RUN_ASSESSMENT_MAX_CHARS);
const page = `### RC-0020 | OPEN | 2026-09-01 | The vendor review and the June renewal\n\n${`**Session arc:** We moved the renewal and handed the vendor review to Mara.\n\n**Body:**\n${"- The renewal moves to June, and Mara takes the vendor review with the second quote.\n".repeat(200)}`.slice(0, CHECKPOINT_PAGE_MAX_CHARS)}`;
const now = new Date("2026-10-10T10:00:00.000Z");

await check("the minimum window holds the fold and the Review first read of a room at 10k, 20k and 80k, on Claude and on another model, and no more", () => {
	assert(typeof tokenEstimate.minimumMemoryWindow === "function", "token-estimate.ts has minimumMemoryWindow(budget, model)");
	const rows: string[] = [];
	for (const budget of BUDGETS) {
		const doc = roomAtBudget(budget);
		const held = memoryEntries.reviewTargetTokens(doc);
		assert(held > budget * 0.98 && held <= budget, `the room stands at its budget, got ${held} for ${budget}`);
		const coreContext = memoryEntries.renderMemoryDocument(doc, "context", { entryIds: true, sections: memoryEntries.MEMORY_SECTIONS }).trim();
		const areas = memoryEntries.listAreas(doc);
		const topics = doc.topics.map((topic: any) => ({ title: topic.title, section: topic.section, notes: topic.entries.length, tokens: topic.entries.reduce((total: number, entry: any) => total + memoryEntries.entryTokens(entry), 0) }));
		for (const model of [CLAUDE, OTHER]) {
			const fold = absorbOps.buildFoldPrompt({ agentId: "a_size", model, coreContext, areas, assessmentMarkdown: firstRead, session: { id: "RC-0020", text: page, date: "2026-09-01" }, sessionIndex: 20, sessionCount: 20, now }).telemetry.promptEstimatedTokens;
			const review = reviewAssess.buildReviewAssessmentPrompt({ agentId: "a_size", model, contextRender: coreContext, topics, budgetTokens: budget, reviewTargetTokens: held, now }).telemetry.promptEstimatedTokens;
			const window = tokenEstimate.minimumMemoryWindow(budget, model);
			const guard = maintenancePromptTokenBudget({ contextWindow: window, maxOutputTokens: 32_000 }, model)!;
			const below = maintenancePromptTokenBudget({ contextWindow: window - 1_000, maxOutputTokens: 32_000 }, model)!;
			assert(fold <= guard, `at a budget of ${budget}, ${model.model}'s fold (${fold}) fits the guard's budget at the minimum window ${window} (${guard})`);
			assert(review <= guard, `at a budget of ${budget}, ${model.model}'s Review first read (${review}) fits the same window (${guard})`);
			assert(fold >= below * 0.9, `the minimum is no larger than the fold needs: at ${window - 1_000} the guard holds ${below}, the fold is ${fold}`);
			rows.push(`    budget ${budget / 1000}k, ${model.provider === "anthropic" ? "Claude" : "other "}: minimum window ${window.toLocaleString("en-US")} (guard budget ${guard.toLocaleString("en-US")}); fold ${fold.toLocaleString("en-US")}, Review first read ${review.toLocaleString("en-US")} (${areas.length} notes)`);
		}
	}
	console.log(rows.join("\n"));
});

// The guards stay behind the check, as the backstop for a memory over its
// budget: their remedies name the Memory model and where to choose it.
await check("the size guards behind the check name the Memory model and Room settings, Model", () => {
	const reviewRoutes = fs.readFileSync(path.join(webServerDir, "src", "review-assess-routes.ts"), "utf-8");
	const agents = fs.readFileSync(path.join(webServerDir, "src", "persistent-agents.ts"), "utf-8");
	const reviewGuidance = /const REVIEW_OVERFLOW_GUIDANCE =\s*"([^"]+)"/.exec(reviewRoutes)?.[1] ?? "";
	const memorizeGuidance = /const ABSORB_OVERFLOW_GUIDANCE =\s*"([^"]+)"/.exec(agents)?.[1] ?? "";
	for (const [name, guidance] of [["Review", reviewGuidance], ["Memorize", memorizeGuidance]]) {
		assert(guidance.includes("Memory model that can read more at once in Room settings, Model") && !/window/.test(guidance) && !/maintenance model|AI setup|memory model/.test(guidance), `${name}'s guard names the Memory model and Room settings, Model, got ${JSON.stringify(guidance)}`);
	}
});

// --- Against a server: the refusals ---------------------------------------------------

const port = 27000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(agentsRoot, { recursive: true, mode: 0o700 });
fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });

// Windows chosen around the minimum on a model that is not Claude: Small holds
// a 10k memory and not a 20k one, Mid holds 40k and not 80k, Maintenance all.
const gatewayModels = (maintenanceWindow: number) => [
	{ id: "room-model", name: "Room Model", contextWindow: 128000, maxTokens: 16384 },
	{ id: "small-model", name: "Small Model", contextWindow: 40000, maxTokens: 8000 },
	{ id: "mid-model", name: "Mid Model", contextWindow: 100000, maxTokens: 16000 },
	{ id: "maint-model", name: "Maintenance Model", contextWindow: maintenanceWindow, maxTokens: 32000 },
];
function writeGateway(maintenanceWindow: number): void {
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "openai-compatible": { name: "Synthetic Gateway", baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", models: gatewayModels(maintenanceWindow) } } }, null, 2), { mode: 0o600 });
}
writeGateway(200000);
fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-memory-size-key" } }, null, 2), { mode: 0o600 });
fs.writeFileSync(path.join(appDir, "openai-compatible-ai-profile.json"), JSON.stringify({
	profileId: "openai-compatible",
	providerId: "openai-compatible",
	label: "Synthetic Gateway",
	roomModels: [{ modelId: "room-model", label: "Room Model" }, { modelId: "small-model", label: "Small Model" }, { modelId: "mid-model", label: "Mid Model" }],
	maintenanceModel: "maint-model",
}, null, 2), { mode: 0o600 });
fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2), { mode: 0o600 });

// Every call is bounded. The server answers each in milliseconds, and a refusal
// comes before any model call, so a start it does not refuse (that one would
// call the dead gateway and wait out its patience) or a server that hangs fails
// its check in five seconds.
const CALL_LIMIT_MS = 5_000;
async function api(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	try {
		const response = await authedFetch(`${baseUrl}${pathname}`, { ...init, signal: AbortSignal.timeout(CALL_LIMIT_MS), headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
		const text = await response.text();
		return { status: response.status, body: text ? JSON.parse(text) : null };
	} catch (error) {
		if ((error as { name?: unknown } | null)?.name === "TimeoutError") throw new Error(`${init.method ?? "GET"} ${pathname} did not answer within ${CALL_LIMIT_MS / 1000} seconds`);
		throw error;
	}
}
const put = (pathname: string, body: unknown) => api(pathname, { method: "PUT", body: JSON.stringify(body) });
const post = (pathname: string, body: unknown = {}) => api(pathname, { method: "POST", body: JSON.stringify(body) });
const start = (pathname: string, body: unknown = {}) => post(pathname, body).catch((error: unknown) => ({ status: 0, body: { error: `no refusal: ${error instanceof Error ? error.message : String(error)}` } }));
const lock = (model: string) => ({ provider: "openai-compatible", model });
const tooSmall = (model: string) => `${model} is too small for this room's memory. Choose another Memory model, or lower the memory budget in Memory.`;
// Memorize, Remember and Review say it outside Room settings, so they say where the budget is.
const tooSmallOutside = (model: string) => `${model} is too small for this room's memory. Choose another Memory model, or lower the memory budget in Room settings, Memory.`;
const tooSmallForRoomOnDefault = (model: string, room: string) => `${model} is too small for ${room}'s memory. Choose a larger default, or give ${room} its own Memory model in its Room settings.`;
const defaultTooSmall = (model: string) => `The default, ${model}, is too small for this room's memory. Keep this room's own Memory model, or choose a larger default in Settings, AI setup.`;

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
try {
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	const deadline = Date.now() + 20_000;
	while (!(await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(2_000) }).then((r) => r.ok).catch(() => false))) {
		assert(server.exitCode == null, `server exited before startup with code ${server.exitCode}`);
		assert(Date.now() < deadline, "server did not become ready");
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	const createRoom = async (displayName: string) => String((await post("/api/persistent-agents", { displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" })).body?.agent?.id ?? "");
	const ten = await createRoom("Ten Room");
	const twenty = await createRoom("Twenty Room");
	const own = await createRoom("Own Room");
	assert(ten && twenty && own, "three rooms are created");
	assert((await put(`/api/persistent-agents/${ten}/maintenance-settings`, { memoryBudgetTokens: 10_000 })).status === 200, "a lower budget is never refused");

	await check("the Memory pick refuses a model too small for this room's memory, and takes it for a room whose memory it holds", async () => {
		const refusedPick = await put(`/api/persistent-agents/${twenty}/models`, { memory: lock("small-model") });
		assert(refusedPick.status === 400 && refusedPick.body.error === tooSmall("Small Model"), `a Memory model too small for this room's 20k memory is refused at the pick, got ${refusedPick.status} ${JSON.stringify(refusedPick.body)}`);
		assert((await api(`/api/persistent-agents/${twenty}/models`)).body.models.memory.stored === null, "a refused pick changes nothing");
		const fitPick = await put(`/api/persistent-agents/${ten}/models`, { memory: lock("small-model") });
		assert(fitPick.status === 200 && fitPick.body.models.memory.stored?.model === "small-model", `the same model holds a 10k memory, got ${fitPick.status} ${JSON.stringify(fitPick.body)}`);
		const conversationPick = await put(`/api/persistent-agents/${twenty}/models`, { conversation: lock("small-model") });
		assert(conversationPick.status === 200, `the conversation row is not measured against the memory, got ${conversationPick.status} ${JSON.stringify(conversationPick.body)}`);
	});

	await check("raising the memory budget past what the room's Memory model holds is refused, and every other change is taken", async () => {
		const raised = await put(`/api/persistent-agents/${ten}/maintenance-settings`, { memoryBudgetTokens: 20_000 });
		assert(raised.status === 400 && raised.body.error === "A memory budget of 20k needs a larger Memory model than Small Model. Choose one in Room settings, Model first.", `raising the budget past what the Memory model holds is refused, got ${raised.status} ${JSON.stringify(raised.body)}`);
		assert((await api(`/api/persistent-agents/${ten}/maintenance-settings`)).body.settings.memoryBudgetTokens === 10_000, "a refused raise keeps the budget");
		assert((await put(`/api/persistent-agents/${ten}/maintenance-settings`, { fastPathSecondApproval: true })).status === 200, "the other settings are not measured");
		assert((await put(`/api/persistent-agents/${own}/models`, { memory: lock("mid-model") })).status === 200, "Mid Model holds a 20k memory");
		assert((await put(`/api/persistent-agents/${own}/maintenance-settings`, { memoryBudgetTokens: 40_000 })).status === 200, "and a raise to 40k");
		const ceiling = await put(`/api/persistent-agents/${own}/maintenance-settings`, { memoryBudgetTokens: 80_000 });
		assert(ceiling.status === 400 && ceiling.body.error === "A memory budget of 80k needs a larger Memory model than Mid Model. Choose one in Room settings, Model first.", `but not 80k, got ${ceiling.status} ${JSON.stringify(ceiling.body)}`);
	});

	await check("the AI defaults refuse a Memory model too small for a room on the default, naming the first such room", async () => {
		assert((await put(`/api/persistent-agents/${ten}/models`, { memory: null })).status === 200, "Ten Room goes back to the default");
		const refusedDefault = await put("/api/ai/defaults", { memory: lock("small-model") });
		assert(refusedDefault.status === 400 && refusedDefault.body.error === tooSmallForRoomOnDefault("Small Model", "Twenty Room"), `the default refuses a model too small for a room on the default, names the room and its own pick as the other way out, got ${refusedDefault.status} ${JSON.stringify(refusedDefault.body)}`);
		assert((await api("/api/ai/defaults")).body.defaults.memory.stored?.model === "maint-model", "a refused default changes nothing");
		const midDefault = await put("/api/ai/defaults", { memory: lock("mid-model") });
		assert(midDefault.status === 200 && midDefault.body.defaults.memory.stored?.model === "mid-model", `a room with its own pick is not measured (Own Room holds 40k on its own Mid Model), got ${midDefault.status} ${JSON.stringify(midDefault.body)}`);
		assert((await put("/api/ai/defaults", { memory: lock("maint-model") })).status === 200, "the default goes back");
	});

	await check("clearing a room's Memory pick back to a default too small for its memory is refused, naming the default", async () => {
		assert((await put(`/api/persistent-agents/${twenty}/models`, { memory: lock("mid-model") })).status === 200, "Twenty Room picks Mid Model");
		assert((await put("/api/ai/defaults", { memory: lock("small-model") })).status === 200, "Small Model becomes the default: it holds Ten Room's 10k, the one room on the default");
		try {
			const cleared = await put(`/api/persistent-agents/${twenty}/models`, { memory: null });
			assert(cleared.status === 400 && cleared.body.error === defaultTooSmall("Small Model"), `going back to a default too small for this room's 20k memory is refused, naming the default, got ${cleared.status} ${JSON.stringify(cleared.body)}`);
			assert((await api(`/api/persistent-agents/${twenty}/models`)).body.models.memory.stored?.model === "mid-model", "a refused clear keeps the room's own pick");
			assert((await put(`/api/persistent-agents/${ten}/models`, { memory: null })).status === 200, "a room whose memory the default holds goes back to it");
		} finally {
			await put("/api/ai/defaults", { memory: lock("maint-model") });
		}
	});

	await check("Memorize and Review stop at their start when the Memory model's window shrank below the room's memory, with the model notice's code", async () => {
		assert((await put(`/api/persistent-agents/${twenty}/models`, { memory: lock("maint-model") })).status === 200, "Twenty Room picks the Maintenance Model");
		writeGateway(40000);
		try {
			const refusals = {
				"Memorize's first read": await start(`/api/persistent-agents/${twenty}/absorb/assess`),
				"Memorize's run": await start(`/api/persistent-agents/${twenty}/absorb/propose`, { assessmentMarkdown: "None." }),
				"Review's first read": await start(`/api/persistent-agents/${twenty}/review/assess`),
				"Review's tidy": await start(`/api/persistent-agents/${twenty}/review/runs`, { depth: "wording", topics: [] }),
			};
			for (const [what, refused] of Object.entries(refusals)) {
				assert(refused.status === 409 && refused.body.code === "memory_model_too_small" && refused.body.error === tooSmallOutside("Maintenance Model"), `${what} stops before any call, with the model notice's code and sentence, got ${refused.status} ${JSON.stringify(refused.body)}`);
			}
		} finally {
			writeGateway(200000);
		}
	});

	await check("the screens show the start's refusal as the model notice, with Choose another model", async () => {
		const { ApiRequestError } = await import("../../web-ui/src/api.js");
		// A component file: loaded by its path, as the scripts' type check reads no JSX.
		const { modelNoticeFromError } = await import(pathToFileURL(path.join(repoRoot, "apps", "web-ui", "src", "components", "model-notice.tsx")).href) as { modelNoticeFromError(error: unknown): { detail: string; sentence: string } | null };
		const notice = modelNoticeFromError(new ApiRequestError(tooSmallOutside("Maintenance Model"), 409, "memory_model_too_small"));
		assert(notice?.detail === "too-small" && notice.sentence === tooSmallOutside("Maintenance Model"), `the refusal is shown as the model notice, with Choose another model, got ${JSON.stringify(notice)}`);
		const app = fs.readFileSync(path.join(repoRoot, "apps", "web-ui", "src", "App.tsx"), "utf-8");
		const runStart = (name: string) => app.slice(app.indexOf(`async function ${name}(`), app.indexOf("\n\t}\n", app.indexOf(`async function ${name}(`)));
		assert(/modelNoticeFromError\(e\)/.test(runStart("generateAbsorbProposal")), "Memorize's run start shows the refusal as the notice");
		assert(/modelNoticeFromError\(e\)/.test(runStart("startReviewTidy")), "so does Review's tidy start");
	});

	if (failures.length > 0) throw new Error(`${failures.length} check(s) failed:\n${failures.join("\n")}`);
	console.log("memory model size smoke passed");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
