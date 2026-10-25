// A provider refusing a model for this account (the person's plan does not
// include it, an administrator has not turned it on): ChatGPT answers a 400,
// "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT
// account.", as `{"detail": ...}` or as `{"error": {"message": ...}}`. This
// smoke fakes that backend locally and proves, under a synthetic ChatGPT
// sign-in, that each place says so plainly with the way out and never shows
// the provider's words:
// - the matcher takes only that wording, and an API key's words for a model
//   it has no access to, never a 400 about a parameter or a model at capacity;
// - the runtime reads the words out of a `detail` body, and asks only once;
// - a chat turn shows the one line, the cause, then that the message is
//   back in the box, then Choose another model in Room settings, Model, which
//   the line's button takes the place of; the next message no longer
//   carries it;
// - Remember, Memorize and Review end in the shared notice, which names the
//   model and the account and says nothing was lost; nothing is written to
//   memory, nothing goes to Unsorted, and the conversation still waits;
// - a scheduled run fails with the same sentence, in the conversation and in
//   the Scheduled tasks pane, read from the run the scheduler records;
// - a specialist task's line, a consult's card and HiveMind's reply say the
//   same, with the way out that fits: the room's Memory model, the consulted
//   or asked room's Memory model, or AI setup's default for several rooms;
// - a model the provider no longer serves (a 404 in OpenAI's own words,
//   "The model `gpt-6.1-sol` does not exist.", the dotted id inside) gives
//   those three the sentence a Memory model
//   no longer offered gets before any call, Remember, Memorize and Review
//   the shared notice, and a chat turn the line the room's model row says,
//   never the provider's words.
// Offline: the backend is a local fake.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { authedFetch, SMOKE_AUTH_HEADERS, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort } from "./smoke-server-process.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function pass(label: string): void {
	console.log(`  ok  ${label}`);
}

// Each path is its own section: one that fails is reported and the rest still run.
const failures: string[] = [];
async function section(label: string, run: () => Promise<void>): Promise<void> {
	try {
		await run();
	} catch (error) {
		failures.push(label);
		console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-not-on-account-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
const threadCwd = path.join(tempRoot, "cwd");
for (const dir of [agentsRoot, agentDir, threadCwd]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

const SOL = { provider: "openai-codex", model: "gpt-6.1-sol" };
const WORDS = "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.";
const RAW = /not supported when using Codex/i;
const NOTICE = "GPT-6.1 Sol isn't available on your ChatGPT account. Nothing was lost.";
const LINE = "GPT-6.1 Sol isn't available on your ChatGPT account. Choose another model in Room settings, Model.";
const roomLine = (room: string) => `GPT-6.1 Sol isn't available on your ChatGPT account. Choose another Memory model in ${room}'s Room settings, Model.`;
const MEMORY_LINE = "GPT-6.1 Sol isn't available on your ChatGPT account. Choose another Memory model in Room settings, Model.";
const DEFAULTS_LINE = "GPT-6.1 Sol isn't available on your ChatGPT account. Choose another default in Settings, AI setup.";
const GONE_WORDS = "The model `gpt-6.1-sol` does not exist.";
const GONE_NOTICE = "GPT-6.1 Sol is no longer offered. Nothing was lost.";
const GONE_ROOM_LINE = "This room's memory model, GPT-6.1 Sol on ChatGPT Plus/Pro, is no longer offered. Choose another Memory model in Room settings, Model.";
const goneLine = (room: string) => `The memory model of ${room}, GPT-6.1 Sol on ChatGPT Plus/Pro, is no longer offered. Choose another Memory model in its Room settings, Model.`;
const GONE_RAW = /does not exist/i;
const GONE_DEFAULTS_LINE = "The default memory model, GPT-6.1 Sol on ChatGPT Plus/Pro, is no longer offered. Choose another default in Settings, AI setup.";

// The ChatGPT backend, as far as this refusal goes: every request is refused
// with the 400 in the shape the section asks for. A WebSocket upgrade finds
// no listener, so the runtime falls back to the plain request.
// "gone" and "gone-detail" are the provider no longer serving the model: a
// 404 in OpenAI's words, in either body shape.
let shape: "detail" | "error" | "gone" | "gone-detail" = "detail";
let requests = 0;
// What each request carried, to see a refused message leave the conversation.
const requestBodies: string[] = [];
const backend = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		requests += 1;
		requestBodies.push(raw);
		const body = shape === "detail"
			? { detail: WORDS }
			: shape === "gone"
				? { error: { message: GONE_WORDS, type: "invalid_request_error", code: "model_not_found" } }
				: shape === "gone-detail"
					? { detail: GONE_WORDS }
					: { type: "error", status: 400, error: { type: "invalid_request_error", message: WORDS } };
		res.writeHead(shape === "gone" || shape === "gone-detail" ? 404 : 400, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	});
});

// A ChatGPT sign-in as the runtime reads it: a token carrying an account id.
const base64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64").replace(/=+$/, "");
const syntheticToken = `${base64({ alg: "none" })}.${base64({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })}.synthetic`;

async function waitUntil(predicate: () => Promise<boolean> | boolean, label: string, timeoutMs = 25_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`timed out waiting until ${label}`);
}

async function api(pathname: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, { method: init.method ?? "GET", signal: AbortSignal.timeout(init.timeoutMs ?? 10_000), ...(init.body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) }) });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];

try {
	// --- The matcher -------------------------------------------------------------------------
	const { modelNotOnAccount } = await import("../src/model-not-on-account.js");
	const causes = await import("../src/model-call-causes.js");
	await section("the matcher", async () => {
		const positives = [
			WORDS,
			"The \"gpt-6.1-sol\" model is not supported when using Codex with a ChatGPT account.",
			"The gpt-5.2 model is not supported when using Codex with a ChatGPT account.",
			"the 'gpt-5.4' MODEL IS NOT SUPPORTED WHEN USING CODEX WITH A CHATGPT ACCOUNT",
			JSON.stringify({ detail: WORDS }),
			JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error", message: "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account." } }),
		];
		const negatives = [
			"Unsupported parameter: 'temperature' is not supported with this model.",
			"Unsupported value: 'reasoning.effort' does not support 'minimal' with the 'gpt-6.1-sol' model.",
			"reasoning.effort 'xhigh' is not supported for this model",
			"Selected model is at capacity. Please try a different model.",
			"400 Bad Request",
		];
		for (const words of positives) {
			assert(modelNotOnAccount(words), `the matcher takes ${JSON.stringify(words)}`);
			const failure = causes.classifyModelFailure(new Error(words));
			assert(failure.cause === "unreachable" && failure.detail === "not-on-account", `${JSON.stringify(words)} reads as not on the account, got ${JSON.stringify(failure)}`);
		}
		for (const words of negatives) {
			assert(!modelNotOnAccount(words), `the matcher leaves ${JSON.stringify(words)}`);
			const failure = causes.classifyModelFailure(new Error(words));
			assert(!(failure.cause === "unreachable" && failure.detail === "not-on-account"), `${JSON.stringify(words)} is not read as not on the account, got ${JSON.stringify(failure)}`);
		}
		// An API key without access to a model reads the same: not available, never "no longer offered".
		for (const words of ["404 The model `gpt-scripted` does not exist or you do not have access to it.", "403 Project `proj_scripted` does not have access to model `gpt-scripted`"]) {
			const failure = causes.classifyModelFailure(new Error(words));
			assert(modelNotOnAccount(words) && failure.cause === "unreachable" && failure.detail === "not-on-account", `${JSON.stringify(words)} reads as not on the account, got ${JSON.stringify(failure)}`);
		}
		assert(causes.modelUnreachableSentence("not-on-account", { provider: "openai", model: "gpt-scripted", label: "GPT Scripted" }) === "GPT Scripted isn't available on your account. Nothing was lost.", "the notice says the model is not available, never no longer offered");
		// The runtime keeps its own copy of ChatGPT's words, to answer this refusal once: the two must agree.
		const { codexModelNotOnAccount } = await import("@exxeta/exxperts-ai");
		for (const words of [...positives, ...negatives]) assert(codexModelNotOnAccount(words) === modelNotOnAccount(words), `the runtime's copy of the words agrees on ${JSON.stringify(words)}`);
		assert(causes.modelUnreachableSentence("not-on-account", SOL) === NOTICE, `the notice's sentence, got ${JSON.stringify(causes.modelUnreachableSentence("not-on-account", SOL))}`);
		pass("the matcher takes ChatGPT's words for a model not on the account, in either body shape, and an API key's words for a model it cannot use");
	});

	await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
	const backendPort = (backend.address() as AddressInfo).port;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "openai-codex": { baseUrl: `http://127.0.0.1:${backendPort}` } } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": { type: "api_key", key: syntheticToken } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "chatgpt-codex" }, null, 2), { mode: 0o600 });

	// --- The runtime reads the words out of either body ---------------------------------------
	const ai = await import("@exxeta/exxperts-ai");
	const solModel = { ...(ai.getModel("openai-codex" as any, SOL.model as any) as any), baseUrl: `http://127.0.0.1:${backendPort}` };
	await section("the runtime", async () => {
		for (const body of ["detail", "error"] as const) {
			shape = body;
			const requestsBefore = requests;
			const answer = await ai.complete(solModel, { messages: [{ role: "user", content: "Hello.", timestamp: Date.now() }] } as any, { apiKey: syntheticToken, transport: "sse" } as any);
			assert(answer.stopReason === "error" && answer.errorMessage === WORDS, `a ${body} body yields the words themselves, got ${JSON.stringify(answer.errorMessage)}`);
			assert(requests - requestsBefore === 1, `a ${body} body is asked once, never again, got ${requests - requestsBefore} requests`);
		}
		pass("the runtime reads the words out of a detail body and an error body alike, and asks once");
	});

	const agents = await import("../src/persistent-agents.js");
	const roomModels = await import("../src/room-models.js");
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const page = (id: string, title: string) => [`### ${id} | CLOSED | 2026-10-01 | ${title}`, "", `**Session arc:** ${title} was settled.`, "", "**Body:**", `- ${title} is the durable point.`, "", "**Parked:**", "None", ""].join("\n");
	const unsorted = ["### Unsorted", "", "<!-- e: id=m-0101 kind=fact saved=2026-09-01 -->", "- Invoices go out on the first working day.", "", ""].join("\n");

	// A room on GPT-6.1 Sol for both models, with a conversation started on it,
	// a page waiting to be memorized and one note in Unsorted.
	function roomOnSol(displayName: string, conversationId: string): string {
		const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
		roomModels.writeRoomModels(agentId, { conversation: SOL, memory: SOL });
		const l1bPath = path.join(agentsRoot, agentId, "L1b", "current.md");
		let text = fs.readFileSync(l1bPath, "utf-8");
		const active = /^##\s+Active Items\s*$/m.exec(text)!;
		text = `${text.slice(0, active.index)}${unsorted}${text.slice(active.index)}`;
		const at = /^##\s+Recent Context\s*$/m.exec(text)!;
		fs.writeFileSync(l1bPath, `${text.slice(0, at.index + at[0].length)}\n\n${page("RC-0001", "First plan")}\n`, "utf-8");
		const created = agents.writePersistentAgentThread(agentId, conversationId, { state: "standby", origin: "home", model: SOL, items: [{ kind: "user", id: "u1", text: "Earlier question." }, { kind: "assistant", id: "a1", text: "Earlier answer." }] }, {
			createRuntime: ({ model }) => agents.createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId: conversationId, model, cwd: threadCwd }),
		});
		const seed = agents.openPersistentAgentPiSessionManager(agentId, created.thread.runtime as any, threadCwd);
		seed.appendMessage({ role: "user", content: [{ type: "text", text: "Earlier question." }], timestamp: Date.now() } as any);
		seed.appendMessage({ role: "assistant", content: [{ type: "text", text: "Earlier answer." }], api: "openai-codex-responses", provider: SOL.provider, model: SOL.model, usage, stopReason: "stop", timestamp: Date.now() } as any);
		return agentId;
	}
	roomOnSol("Chat On Sol", "c_chat_on_sol");
	const rememberRoom = roomOnSol("Remember On Sol", "c_remember_on_sol");
	const memorizeRoom = roomOnSol("Memorize On Sol", "c_memorize_on_sol");
	const reviewRoom = roomOnSol("Review On Sol", "c_review_on_sol");
	const rememberGoneRoom = roomOnSol("Remember Gone", "c_remember_gone");
	const memorizeGoneRooms = { gone: roomOnSol("Memorize Gone", "c_memorize_gone"), "gone-detail": roomOnSol("Memorize Gone Detail", "c_memorize_gone_detail") };
	const reviewGoneRoom = roomOnSol("Review Gone", "c_review_gone");
	const scheduledRoom = roomOnSol("Scheduled On Sol", "c_scheduled_on_sol");
	const scheduledRunRoom = roomOnSol("Scheduled Run On Sol", "c_scheduled_run_on_sol");
	const consultFromRoom = roomOnSol("Consult From", "c_consult_from");
	const consultedRoom = roomOnSol("Consulted On Sol", "c_consulted_on_sol");
	const hiveRoom = roomOnSol("Hive On Sol", "c_hive_on_sol");
	const chatGoneRooms = { gone: "Gone Chat Error", "gone-detail": "Gone Chat Detail" } as const;
	for (const [body, room] of Object.entries(chatGoneRooms)) roomOnSol(room, `c_chat_${body.replace("-", "_")}`);
	// HiveMind asked across several rooms answers on the Memory default.
	roomModels.writeAiDefaults({ conversation: SOL, memory: SOL });
	const memoryOf = (agentId: string) => fs.readFileSync(path.join(agentsRoot, agentId, "L1b", "current.md"), "utf-8");

	// --- A scheduled run ---------------------------------------------------------------------
	await section("a scheduled run", async () => {
		shape = "error";
		const { executePersistentRoomBackgroundPrompt } = await import("../src/persistent-room-background-execution.js");
		let scheduled: any = null;
		try {
			await executePersistentRoomBackgroundPrompt({ roomId: scheduledRoom, target: { kind: "resume-thread", roomId: scheduledRoom, threadId: "c_scheduled_on_sol", model: SOL }, prompt: "The morning summary.", executionId: "not-on-account-run", cwd: threadCwd, agentDir } as any);
		} catch (error) {
			scheduled = error;
		}
		assert(scheduled?.code === "model_not_on_account" && scheduled.message === LINE, `a scheduled run fails with its own code and the sentence, got ${scheduled?.code} ${JSON.stringify(scheduled?.message)}`);
		const failureLines = (agents.getPersistentAgentThread(scheduledRoom, "c_scheduled_on_sol")?.items ?? []).filter((item: any) => item.kind === "system" && item.level === "error").map((item: any) => String(item.text));
		assert(failureLines.includes(LINE) && !failureLines.some((text) => RAW.test(text)), `the run's conversation carries the sentence, never the words, got ${JSON.stringify(failureLines)}`);
		// The run the scheduler itself makes and records, read back as the Scheduled tasks pane reads it.
		const { addPersistentRoomScheduleJob } = await import("../../../pi-package/extensions/schedule-prompt/index.js");
		const { createScheduledPromptBackgroundRunPreflight } = await import("../src/scheduled-prompt-runs.js");
		const { processScheduledPromptBackgroundRunExecutionOnce } = await import("../src/scheduled-prompt-background-execution.js");
		const { readBackgroundRun } = await import("../src/background-runs.js");
		const job = addPersistentRoomScheduleJob(scheduledRunRoom, { name: "Morning summary", type: "once", schedule: "+30m", prompt: "The morning summary.", now: new Date(Date.now() - 60 * 60 * 1000) });
		const queued = createScheduledPromptBackgroundRunPreflight({ roomId: scheduledRunRoom, scheduleJobId: job.id, dueAt: String(job.nextRunAt), now: new Date() }).run;
		await processScheduledPromptBackgroundRunExecutionOnce({ workerId: "scheduler-execution:not-on-account", now: new Date(), limit: 1 });
		const recorded = readBackgroundRun(queued.runId);
		assert(recorded.status === "failed" && recorded.reason === "model_not_on_account", `the scheduler's own run record carries the reason, got ${recorded.status} ${recorded.reason}`);
		const { formatFriendlyRunReason } = await import("../../web-ui/src/scheduled-run-reason.js");
		const shownReason = formatFriendlyRunReason(recorded as any);
		assert(shownReason === LINE, `the Scheduled tasks pane says the sentence for the recorded run, got ${JSON.stringify(shownReason)}`);
		pass("a scheduled run fails with the sentence in its conversation and in the Scheduled tasks pane");
	});

	// --- A specialist task ----------------------------------------------------------------------
	await section("a specialist task", async () => {
		const execution = await import("../src/persistent-room-specialist-execution.js");
		const { AuthStorage, ModelRegistry } = await import("@exxeta/exxperts-runtime");
		for (const body of ["detail", "error"] as const) {
			shape = body;
			const plan = execution.buildSpecialistSessionPlan({ taskId: `tsk-not-on-account-${body}`, templateId: "document-html", brief: "Write the one-pager." });
			let failed: any = null;
			try {
				await execution.runSpecialistWorker({ plan, modelLock: SOL, resolveExpectedModel: (registry: any, lock: any) => registry.find(lock.provider, lock.model), modelRegistry: ModelRegistry.create(AuthStorage.create(path.join(agentDir, "auth.json")), path.join(agentDir, "models.json")), cwd: threadCwd, agentDir });
			} catch (error) {
				failed = error;
			}
			// The launch puts this message on the task's line as it is.
			// A specialist runs on the room's Memory model: the way out points there.
			assert(failed?.message === MEMORY_LINE, `a ${body} body ends the task with the sentence, got ${JSON.stringify(failed?.message)}`);
			assert(failed.providerMessage === WORDS, "the provider's words ride along for the log only");
		}
		for (const body of ["gone", "gone-detail"] as const) {
			shape = body;
			const gonePlan = execution.buildSpecialistSessionPlan({ taskId: `tsk-not-on-account-${body}`, templateId: "document-html", brief: "Write the one-pager." });
			let gone: any = null;
			try {
				await execution.runSpecialistWorker({ plan: gonePlan, modelLock: SOL, resolveExpectedModel: (registry: any, lock: any) => registry.find(lock.provider, lock.model), modelRegistry: ModelRegistry.create(AuthStorage.create(path.join(agentDir, "auth.json")), path.join(agentDir, "models.json")), cwd: threadCwd, agentDir });
			} catch (error) {
				gone = error;
			}
			assert(gone?.message === GONE_ROOM_LINE && gone.providerMessage === GONE_WORDS, `a model the provider no longer serves (${body}) ends the task with the room's sentence, got ${JSON.stringify(gone?.message)}`);
		}
		pass("a specialist task ends with the sentence on its line, not on the account or no longer offered, never the provider's words");
	});

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready");

	// --- Remember, Memorize and Review ---------------------------------------------------------
	const { modelNoticeFromError } = await import(new URL("../../web-ui/src/components/model-notice.tsx", import.meta.url).href) as { modelNoticeFromError(error: unknown): { detail: string; sentence: string } | null };
	const { ApiRequestError } = await import("../../web-ui/src/api.js");
	const { absorbRunOutageModelName, absorbRunOutageSentence, memoryModelStopWhy } = await import("../../web-ui/src/memory-v2-copy.js");

	await section("Remember", async () => {
		shape = "detail";
		const rememberBefore = memoryOf(rememberRoom);
		const remember = await api(`/api/persistent-agents/${rememberRoom}/checkpoint/propose`, { method: "POST", body: { conversationId: "c_remember_on_sol", density: "standard" }, timeoutMs: 120_000 });
		assert(remember.body?.code === "model_unreachable" && remember.body.details?.detail === "not-on-account" && remember.body.error === NOTICE, `Remember ends in the shared notice, got ${remember.status} ${JSON.stringify(remember.body)}`);
		const rememberShown = modelNoticeFromError(new ApiRequestError(remember.body.error, remember.status, remember.body.code, remember.body.details));
		assert(rememberShown?.detail === "not-on-account" && rememberShown.sentence === NOTICE, `the screens read it as the one notice, got ${JSON.stringify(rememberShown)}`);
		assert(memoryOf(rememberRoom) === rememberBefore, "Remember wrote nothing to memory: no page, nothing in Unsorted");
		assert(agents.getPersistentAgentRuntimeState(rememberRoom).activeThreadId === "c_remember_on_sol" && agents.getPersistentAgentThread(rememberRoom, "c_remember_on_sol")?.state !== "closed", "the conversation still waits to be remembered");
		// A model the provider no longer serves: the notice says so, in either body shape.
		const goneBefore = memoryOf(rememberGoneRoom);
		for (const body of ["gone", "gone-detail"] as const) {
			shape = body;
			const gone = await api(`/api/persistent-agents/${rememberGoneRoom}/checkpoint/propose`, { method: "POST", body: { conversationId: "c_remember_gone", density: "standard" }, timeoutMs: 120_000 });
			assert(gone.body?.code === "model_unreachable" && gone.body.details?.detail === "not-offered" && gone.body.error === GONE_NOTICE, `Remember on a model no longer served (${body}) ends in the shared notice, got ${gone.status} ${JSON.stringify(gone.body)}`);
			const goneShown = modelNoticeFromError(new ApiRequestError(gone.body.error, gone.status, gone.body.code, gone.body.details));
			assert(goneShown?.detail === "not-offered" && goneShown.sentence === GONE_NOTICE, `the screens read it as the one notice, got ${JSON.stringify(goneShown)}`);
		}
		assert(memoryOf(rememberGoneRoom) === goneBefore && agents.getPersistentAgentThread(rememberGoneRoom, "c_remember_gone")?.state !== "closed", "Remember on a model no longer served wrote nothing and the conversation waits");
		pass("Remember ends in the shared notice, not on the account or no longer offered; nothing is written and the conversation waits");
	});

	await section("Memorize", async () => {
		shape = "error";
		const memorizeBefore = memoryOf(memorizeRoom);
		const proposed = await api(`/api/persistent-agents/${memorizeRoom}/absorb/propose`, { method: "POST", body: { assessmentMarkdown: "## What these sessions leave behind\n\n- One plan." } });
		assert(proposed.status === 202, `Memorize starts, got ${proposed.status} ${JSON.stringify(proposed.body)}`);
		let run: any = null;
		await waitUntil(async () => {
			run = (await api(`/api/persistent-agents/${memorizeRoom}/absorb/runs/${proposed.body.runId}`)).body;
			return Boolean(run?.stop);
		}, "the Memorize run stops", 120_000);
		assert(run.stop.kind === "outage" && run.stop.cause === "not-on-account", `the Memorize run stops on the notice, got ${JSON.stringify(run.stop)}`);
		const memorizeSentence = absorbRunOutageSentence(absorbRunOutageModelName(run.stop.model, null), run.stop.cause, 1, run.stop.model.provider);
		assert(/^Memorize paused because GPT-6\.1 Sol isn't available on your ChatGPT account\. 1 conversation is still waiting\.$/.test(memorizeSentence), `the run's notice names the model and the account, got ${JSON.stringify(memorizeSentence)}`);
		assert(memoryOf(memorizeRoom) === memorizeBefore, "the page still waits and nothing went to Unsorted");
		for (const body of ["gone", "gone-detail"] as const) {
			shape = body;
			const room = memorizeGoneRooms[body];
			const goneBefore = memoryOf(room);
			const started = await api(`/api/persistent-agents/${room}/absorb/propose`, { method: "POST", body: { assessmentMarkdown: "## What these sessions leave behind\n\n- One plan." } });
			assert(started.status === 202, `Memorize starts, got ${started.status} ${JSON.stringify(started.body)}`);
			let goneRun: any = null;
			await waitUntil(async () => {
				goneRun = (await api(`/api/persistent-agents/${room}/absorb/runs/${started.body.runId}`)).body;
				return Boolean(goneRun?.stop);
			}, "the Memorize run stops", 120_000);
			assert(goneRun.stop.kind === "outage" && goneRun.stop.cause === "not-offered", `Memorize on a model no longer served (${body}) stops on the notice, got ${JSON.stringify(goneRun.stop)}`);
			const goneSentence = absorbRunOutageSentence(absorbRunOutageModelName(goneRun.stop.model, null), goneRun.stop.cause, 1, goneRun.stop.model.provider);
			assert(/^Memorize paused because GPT-6\.1 Sol is no longer offered\. 1 conversation is still waiting\.$/.test(goneSentence), `the run's notice says the model is no longer offered, got ${JSON.stringify(goneSentence)}`);
			assert(memoryOf(room) === goneBefore, "the page still waits and nothing went to Unsorted");
		}
		pass("Memorize stops on the notice, not on the account or no longer offered; the page still waits and nothing goes to Unsorted");
	});

	await section("Review", async () => {
		shape = "detail";
		const reviewBefore = memoryOf(reviewRoom);
		const review = await api(`/api/persistent-agents/${reviewRoom}/review/assess`, { method: "POST", body: {}, timeoutMs: 120_000 });
		assert(review.status === 503 && review.body?.code === "model_unreachable" && review.body.details?.detail === "not-on-account" && review.body.error === NOTICE, `Review ends in the shared notice, got ${review.status} ${JSON.stringify(review.body)}`);
		assert(memoryOf(reviewRoom) === reviewBefore, "Review changed nothing");
		assert(memoryModelStopWhy("not-on-account", SOL.provider) === "isn't available on your ChatGPT account", "a stopped Review run says the same why");
		const goneBefore = memoryOf(reviewGoneRoom);
		for (const body of ["gone", "gone-detail"] as const) {
			shape = body;
			const gone = await api(`/api/persistent-agents/${reviewGoneRoom}/review/assess`, { method: "POST", body: {}, timeoutMs: 120_000 });
			assert(gone.status === 503 && gone.body?.code === "model_unreachable" && gone.body.details?.detail === "not-offered" && gone.body.error === GONE_NOTICE, `Review on a model no longer served (${body}) ends in the shared notice, got ${gone.status} ${JSON.stringify(gone.body)}`);
		}
		assert(memoryOf(reviewGoneRoom) === goneBefore, "Review on a model no longer served changed nothing");
		pass("Review ends in the shared notice, not on the account or no longer offered, and changes nothing");
	});

	// --- A consult ---------------------------------------------------------------------------
	await section("a consult", async () => {
		const WebSocketImpl: any = (await import("ws")).default;
		const socket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${consultFromRoom}&conversationId=c_consult_from&modelProvider=${SOL.provider}&model=${SOL.model}`, { headers: { ...SMOKE_AUTH_HEADERS } });
		const frames: any[] = [];
		socket.addEventListener("message", (event: { data: unknown }) => { try { frames.push(JSON.parse(String(event.data))); } catch {} });
		try {
			await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve()); socket.addEventListener("error", () => reject(new Error("the room's socket did not open"))); });
			await waitUntil(() => frames.some((frame) => frame.type === "ready"), "the room is ready");
			for (const body of ["detail", "error"] as const) {
				shape = body;
				const consultId = `c_not_on_account_${body}`;
				socket.send(JSON.stringify({ type: "consult", consultId, targetRoomId: consultedRoom, question: "What did we settle?" }));
				await waitUntil(() => frames.some((frame) => (frame.type === "consult_error" || frame.type === "consult_end") && frame.consultId === consultId), "the consult ends", 60_000);
				const ended = frames.find((frame) => (frame.type === "consult_error" || frame.type === "consult_end") && frame.consultId === consultId);
				assert(ended.type === "consult_error" && ended.message === roomLine("Consulted On Sol"), `a ${body} body ends the consult with the sentence, got ${JSON.stringify(ended)}`);
			}
			for (const body of ["gone", "gone-detail"] as const) {
				shape = body;
				const consultId = `c_not_offered_${body}`;
				socket.send(JSON.stringify({ type: "consult", consultId, targetRoomId: consultedRoom, question: "What did we settle?" }));
				await waitUntil(() => frames.some((frame) => (frame.type === "consult_error" || frame.type === "consult_end") && frame.consultId === consultId), "the consult ends", 60_000);
				const gone = frames.find((frame) => (frame.type === "consult_error" || frame.type === "consult_end") && frame.consultId === consultId);
				assert(gone.type === "consult_error" && gone.message === goneLine("Consulted On Sol"), `a model the provider no longer serves (${body}) ends the consult with the sentence, got ${JSON.stringify(gone)}`);
			}
		} finally {
			try { socket.close(); } catch {}
		}
		pass("a consult's card says the consulted room's Memory model is not on the account, or no longer offered, never the provider's words");
	});

	// --- HiveMind -----------------------------------------------------------------------------
	await section("HiveMind", async () => {
		for (const body of ["detail", "error"] as const) {
			shape = body;
			const one = await api("/api/memory/ask", { method: "POST", body: { question: "What did we settle?", rooms: [hiveRoom] }, timeoutMs: 70_000 });
			assert(one.body?.ok === false && one.body.message === roomLine("Hive On Sol"), `asked about one room, a ${body} body says the sentence, got ${JSON.stringify(one.body)}`);
			const all = await api("/api/memory/ask", { method: "POST", body: { question: "What did we settle?" }, timeoutMs: 70_000 });
			assert(all.body?.ok === false && all.body.message === DEFAULTS_LINE, `asked across all rooms, a ${body} body says the sentence, got ${JSON.stringify(all.body)}`);
		}
		for (const body of ["gone", "gone-detail"] as const) {
			shape = body;
			const one = await api("/api/memory/ask", { method: "POST", body: { question: "What did we settle?", rooms: [hiveRoom] }, timeoutMs: 70_000 });
			assert(one.body?.ok === false && one.body.message === goneLine("Hive On Sol"), `asked about one room, a model the provider no longer serves (${body}) says the sentence, got ${JSON.stringify(one.body)}`);
			const all = await api("/api/memory/ask", { method: "POST", body: { question: "What did we settle?" }, timeoutMs: 70_000 });
			assert(all.body?.ok === false && all.body.message === GONE_DEFAULTS_LINE, `asked across all rooms, a model the provider no longer serves (${body}) says the sentence, got ${JSON.stringify(all.body)}`);
		}
		pass("HiveMind says the asked room's Memory model, or the Memory default, is not on the account, or no longer offered, never the provider's words");
	});

	// --- A chat turn -------------------------------------------------------------------------
	// The room's chat: send one message, and the line the turn ends in must be
	// `line`, with `raw` (the provider's words) nowhere on the page, only in the console.
	// `line` is what the newest failure line shows; `saved`, the line the conversation keeps.
	async function chatTurnEndsIn(browser: Awaited<ReturnType<typeof chromium.launch>>, room: string, line: string, saved: string, raw: RegExp): Promise<void> {
		const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		try {
			const ui = await ctx.newPage();
			const consoleLines: string[] = [];
			ui.on("console", (message) => consoleLines.push(message.text()));
			await ui.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
			await ui.waitForLoadState("networkidle");
			const dismiss = ui.locator(".whats-new-close");
			if (await dismiss.count()) await dismiss.click();
			await ui.locator(".persistent-agent-card").filter({ hasText: room }).getByRole("button", { name: "Resume →" }).click();
			const composer = ui.locator("textarea").first();
			await ui.locator('button[title="Send"]').first().waitFor({ timeout: 15000 });
			await ui.waitForTimeout(800);
			const requestsBefore = requests;
			await composer.fill("Still there?");
			await composer.press("Enter");
			const newestLine = async () => (await ui.locator(".failure-line:not(.is-folded) .system-line-text").allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim()).at(-1);
			await waitUntil(async () => (await newestLine()) === line, `${room}: the line ${JSON.stringify(line)} shows`, 60000).catch(async () => {
				throw new Error(`${room}: the line ${JSON.stringify(line)} never showed; the newest line says ${JSON.stringify(await newestLine())} and the page ${JSON.stringify((await ui.locator("body").innerText()).slice(-600))}`);
			});
			assert((await ui.locator(".failure-line:not(.is-folded) .failure-actions .rs-btn").allInnerTexts()).join("|") === "Choose another model", `${room}: the line's one way on is its button, got ${JSON.stringify(await ui.locator(".failure-line:not(.is-folded) .failure-actions .rs-btn").allInnerTexts())}`);
			const roomId = room.toLowerCase().replace(/\s+/g, "-");
			const savedLine = async () => {
				const threadId = String((await api(`/api/persistent-agents/${roomId}/status`)).body?.activeThread?.threadId ?? "");
				const thread = (await api(`/api/persistent-agents/${roomId}/threads/${encodeURIComponent(threadId)}`)).body;
				const items: any[] = thread?.thread?.items ?? thread?.items ?? [];
				return items.filter((item) => item?.kind === "system" && item?.level === "error").at(-1)?.text;
			};
			await waitUntil(async () => (await savedLine()) === saved, `${room}: the conversation keeps the line in one order, the cause, where the message is, then the way on`, 10000).catch(async () => {
				throw new Error(`${room}: the conversation keeps ${JSON.stringify(await savedLine())}, not ${JSON.stringify(saved)}`);
			});
			assert(requests > requestsBefore, `${room}: the turn reached the backend`);
			assert(!raw.test(await ui.locator("body").innerText()), `${room}: the provider's words are nowhere on the page`);
			assert(consoleLines.some((consoleLine) => raw.test(consoleLine)), `${room}: the provider's words go to the console`);
			assert((await composer.inputValue()) === "Still there?" && (await ui.getByText("Earlier answer.").count()) === 1, `${room}: the message is back in the box and the earlier turn is kept, got ${JSON.stringify(await composer.inputValue())}`);
			await waitUntil(async () => (await api(`/api/persistent-agents/${room.toLowerCase().replace(/\s+/g, "-")}/status`)).body?.activeThread?.inFlight === false, `${room}: the failed turn settled`);
			const bodiesBefore = requestBodies.length;
			await composer.fill("Another question.");
			await composer.press("Enter");
			await waitUntil(() => requestBodies.slice(bodiesBefore).some((body) => body.includes("Another question.")), `${room}: the next message reached the backend`);
			assert(!requestBodies.slice(bodiesBefore).some((body) => body.includes("Still there?")), `${room}: the next message no longer carries the refused one`);
		} finally {
			await ctx.close();
		}
	}
	// A machine without Chromium (CI skips its download) cannot run a chat turn in a page:
	// the two chat sections skip there, and every other section still runs.
	const chromiumPath = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	const hasChromium = Boolean(chromiumPath) && fs.existsSync(chromiumPath);
	await section("a chat turn", async () => {
		if (!hasChromium) {
			console.log("  skip  a chat turn (Chromium not installed)");
			return;
		}
		shape = "detail";
		const browser = await chromium.launch();
		try {
			await chatTurnEndsIn(browser, "Chat On Sol", "GPT-6.1 Sol isn't available on your ChatGPT account. Your message is back in the box.", "GPT-6.1 Sol isn't available on your ChatGPT account. Your message is back in the box. Choose another model in Room settings, Model.", RAW);
			pass("a chat turn shows the one line with the way out, never the provider's words");
		} finally {
			await browser.close();
		}
	});
	// A model the provider no longer serves: the line the room's model row says, in either body shape.
	await section("a chat turn on a model no longer offered", async () => {
		if (!hasChromium) {
			console.log("  skip  a chat turn on a model no longer offered (Chromium not installed)");
			return;
		}
		const browser = await chromium.launch();
		try {
			for (const body of ["gone", "gone-detail"] as const) {
				shape = body;
				await chatTurnEndsIn(browser, chatGoneRooms[body], "This room's model, GPT-6.1 Sol on ChatGPT Plus/Pro, is no longer offered. Your message is back in the box.", "This room's model, GPT-6.1 Sol on ChatGPT Plus/Pro, is no longer offered. Your message is back in the box. Choose another model in Room settings, Model.", GONE_RAW);
			}
			pass("a chat turn on a model no longer offered says so with the way out, never the provider's words, in either body shape");
		} finally {
			await browser.close();
		}
	});

	if (failures.length) throw new Error(`room-model-not-on-account smoke failed: ${failures.join(", ")}`);
	console.log("room-model-not-on-account smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").split("\n").filter((line) => !line.includes("token=")).join("\n").slice(-6000));
	throw error;
} finally {
	try { (backend as any).closeAllConnections?.(); } catch {}
	try { backend.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
