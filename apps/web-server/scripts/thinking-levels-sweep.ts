import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The live thinking-level sweep, run by hand against a lab server. For every
// model a provider offers rooms, it opens one room conversation on that model
// the way the page does (Room settings' model pick), then turns the dial up
// one rung at a time with the room socket's effort frame, so the server's
// clamp runs, and sends one short message per rung. Each rung writes one TSV
// row: the thinking fields the request carried, whether the provider took it,
// and the thinking that came back. One conversation per model keeps the
// rooms few, but it does not keep the prompt cache: a level change between
// messages drops the cached prompt on some Claude models (Sonnet 5, Opus 4.7,
// Opus 5 throw away tools and system too), so their rungs pay the whole room
// prompt each time. A room that keeps one level reads the cache from its
// second message.
//
// What was sent is read by thinking-levels-sweep-recorder.mjs inside the
// server process. Start a lab server from a built checkout on a scratch home,
// with the recorder loaded through these two settings in its environment:
//
//   NODE_OPTIONS="--import <abs>/apps/web-server/scripts/thinking-levels-sweep-recorder.mjs"
//   THINKING_SWEEP_LOG=<abs>/recorder.jsonl
//
// Its run dir holds run.json (the server's `base` address) and a `token`
// file. Then, from apps/web-server, once the provider is signed in or has its key:
//
//   npx tsx scripts/thinking-levels-sweep.ts --run <run dir> --provider <id> --log <abs>/recorder.jsonl --out <file.tsv> [--max-usd 1] [--models id,id]
//
// --models picks the models and their order (the budget stops at the first
// rung that would start past it, so put the dearest last). The run dir's
// token file is read, never printed.

export type Rung = { level: string; label: string };
export type SentThinking = { reasoning?: { effort?: unknown; [key: string]: unknown }; reasoning_effort?: unknown; thinking?: { type?: unknown; budget_tokens?: unknown; [key: string]: unknown }; output_config?: { effort?: unknown } };
export type RecordedAnswer = { status: number; reasoningTokens: number; reasoningItems: number; thinkingBlocks: number; thinkingChars: number; effort: string | null; inputTokens: number; outputTokens: number; error: string | null };
export type RecordedCall = { seq: string; at: number; model: string | null; sent: SentThinking; answer?: RecordedAnswer };

export type SweepRow = {
	route: string;
	model: string;
	label: string;
	level: string;
	shown: string;
	sent: string;
	accepted: string;
	reasoningTokens: number;
	thinkingBlocks: number;
	thinkingChars: number;
	answerEffort: string;
	calls: number;
	costUsd: number;
	flags: string[];
	/** Why the rung was not run (the budget); its row then holds the rung alone. */
	notRun?: string;
};

export const TSV_HEADER = ["route", "model", "rung_label", "level", "shown_after_set", "sent", "accepted", "reasoning_tokens", "thinking_blocks", "thinking_chars", "answer_effort", "calls", "cost_usd", "verdict"];

const SWEEP_PROMPT = "What is 17 times 23? Answer with the number only.";
const TURN_TIMEOUT_MS = 180_000;
// The thinking types that stop Claude's thinking: "disabled", or a row's own
// off type such as Sonnet 5.5's "between_tools".
const OFF_THINKING_TYPES = new Set(["disabled", "between_tools"]);

function sentEffort(sent: SentThinking): unknown {
	return sent.reasoning?.effort ?? sent.reasoning_effort ?? sent.output_config?.effort;
}

/** The thinking fields as one short readable cell: "nothing" when the request carried none. */
export function describeSent(sent: SentThinking): string {
	const parts: string[] = [];
	if (sent.reasoning !== undefined) parts.push(`reasoning=${JSON.stringify(sent.reasoning)}`);
	if (sent.reasoning_effort !== undefined) parts.push(`reasoning_effort=${JSON.stringify(sent.reasoning_effort)}`);
	if (sent.thinking !== undefined) parts.push(`thinking=${JSON.stringify(sent.thinking)}`);
	if (sent.output_config !== undefined) parts.push(`output_config=${JSON.stringify(sent.output_config)}`);
	return parts.length > 0 ? parts.join(" ") : "nothing";
}

function thought(answer: RecordedAnswer): boolean {
	return answer.reasoningTokens > 0 || answer.thinkingBlocks > 0 || answer.thinkingChars > 0;
}

/**
 * What is wrong with one rung's call, empty when nothing is: the label and
 * what was sent disagree, the provider refused it, an off rung still thought,
 * or the answer reports a different effort than was asked. A budget model's
 * rungs carry no effort; `previousBudget` is the rung below's, which the
 * budget must exceed.
 */
export function judgeRung(rung: Rung, call: RecordedCall | undefined, previousBudget?: number): string[] {
	if (!call) return ["no provider request was recorded"];
	const flags: string[] = [];
	const answer = call.answer;
	if (!answer) flags.push("no answer was recorded");
	else if (answer.error || answer.status >= 400 || answer.status === 0) flags.push(`refused: ${answer.error ?? `status ${answer.status}`}`);
	const effort = sentEffort(call.sent);
	const type = call.sent.thinking?.type;
	const budget = call.sent.thinking?.budget_tokens;
	if (rung.level === "off") {
		if (effort !== "none" && !OFF_THINKING_TYPES.has(String(type))) flags.push(`off rung "${rung.label}" sent ${describeSent(call.sent)}`);
		if (answer && thought(answer)) flags.push(`off still thought (reasoning tokens ${answer.reasoningTokens}, thinking blocks ${answer.thinkingBlocks}, thinking chars ${answer.thinkingChars})`);
	} else if (type === "enabled" && typeof budget === "number" && effort === undefined) {
		if (previousBudget !== undefined && budget <= previousBudget) flags.push(`rung "${rung.label}" sent budget ${budget}, not above the rung below's ${previousBudget}`);
	} else if (typeof effort !== "string" || effort.toLowerCase() !== rung.label.toLowerCase()) {
		flags.push(`rung "${rung.label}" sent ${describeSent(call.sent)}`);
	}
	if (answer?.effort && typeof effort === "string" && answer.effort !== effort) flags.push(`answer reports effort ${answer.effort}, sent ${effort}`);
	return flags;
}

/** The recorder's log as calls, request and answer lines joined by seq. */
export function readRecorderLog(file: string): RecordedCall[] {
	if (!fs.existsSync(file)) return [];
	const calls = new Map<string, RecordedCall>();
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.kind === "request") calls.set(entry.seq, { seq: entry.seq, at: entry.at, model: entry.model, sent: entry.sent ?? {} });
		else if (entry.kind === "answer" && calls.has(entry.seq)) {
			const { kind: _kind, seq: _seq, ...answer } = entry;
			calls.get(entry.seq)!.answer = answer;
		}
	}
	return [...calls.values()];
}

function cell(value: unknown): string {
	return String(value).replace(/[\t\r\n]+/g, " ");
}

export function rowToTsv(row: SweepRow): string {
	return [row.route, row.model, row.label, row.level, row.shown, row.sent, row.accepted, row.reasoningTokens, row.thinkingBlocks, row.thinkingChars, row.answerEffort, row.calls, row.costUsd.toFixed(6), row.notRun ?? (row.flags.length > 0 ? row.flags.join("; ") : "ok")].map(cell).join("\t");
}

const WebSocketImpl: any = (await import("ws")).default;

type Frame = Record<string, any>;

class RoomSocket {
	readonly frames: Frame[] = [];
	private constructor(private readonly socket: any) {
		socket.on("message", (data: unknown) => {
			try {
				this.frames.push(JSON.parse(String(data)));
			} catch {}
		});
	}

	static async open(base: string, token: string, roomId: string, conversationId: string, provider: string, model: string): Promise<RoomSocket> {
		const url = new URL("/ws", base.replace(/^http/, "ws"));
		url.search = new URLSearchParams({ persistentAgentId: roomId, conversationId, modelProvider: provider, model, reattach: "1" }).toString();
		const socket = new WebSocketImpl(url.toString(), { headers: { "X-Exxperts-Auth": token } });
		const room = new RoomSocket(socket);
		await new Promise<void>((resolve, reject) => {
			socket.once("open", () => resolve());
			socket.once("error", (error: Error) => reject(new Error(`the room socket did not open: ${error.message}`)));
		});
		return room;
	}

	send(frame: Frame): void {
		this.socket.send(JSON.stringify(frame));
	}

	// Sets the room's effort and waits for its echo, the first effort frame
	// after the send.
	async setEffort(level: string, what: string): Promise<Frame> {
		const from = this.frames.length;
		this.send({ type: "effort", level });
		return this.waitFor((frame) => frame.type === "effort", what, from, 15_000);
	}

	async waitFor(predicate: (frame: Frame) => boolean, what: string, from: number, timeoutMs: number): Promise<Frame> {
		const deadline = Date.now() + timeoutMs;
		let index = from;
		while (Date.now() < deadline) {
			for (; index < this.frames.length; index++) if (predicate(this.frames[index])) return this.frames[index];
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		throw new Error(`timed out waiting for ${what}`);
	}

	async close(): Promise<void> {
		if (this.socket.readyState === WebSocketImpl.CLOSED) return;
		await new Promise<void>((resolve) => {
			this.socket.once("close", () => resolve());
			this.socket.close();
			setTimeout(resolve, 3000);
		});
	}
}

export type SweepOptions = {
	base: string;
	token: string;
	provider: string;
	/** The name the TSV gives the route; the provider id when not set. */
	route?: string;
	log: string;
	out: string;
	maxUsd: number;
	models?: string[];
	/** How long one rung's answer may take before the turn is stopped. */
	turnTimeoutMs?: number;
	onRow?: (row: SweepRow) => void;
};

export type SweepResult = { rows: SweepRow[]; costUsd: number; stoppedForBudget: boolean; notSwept: string[] };

async function api(options: SweepOptions, pathname: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<{ status: number; body: any }> {
	const response = await fetch(new URL(pathname, options.base), {
		method: init.method ?? "GET",
		headers: { "X-Exxperts-Auth": options.token, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
		...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
		...(init.timeoutMs !== undefined ? { signal: AbortSignal.timeout(init.timeoutMs) } : {}),
	});
	const text = await response.text();
	let body: any = null;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		body = text;
	}
	return { status: response.status, body };
}

async function offeredModels(options: SweepOptions): Promise<string[]> {
	const status = await api(options, "/api/persistent-agent-room/model-status");
	if (status.status !== 200) throw new Error(`model status answered ${status.status}`);
	const provider = (status.body?.providers ?? []).find((entry: any) => entry.id === options.provider);
	if (!provider) throw new Error(`the server offers no provider ${options.provider}`);
	if (!provider.ready) throw new Error(`${options.provider} has no key or sign-in on this server`);
	return (provider.conversation ?? []).map((option: any) => String(option.model));
}

async function freshConversation(options: SweepOptions, roomId: string, model: string): Promise<RoomSocket> {
	const conversationId = `sweep_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
	const thread = await api(options, `/api/persistent-agents/${roomId}/threads/${conversationId}`, { method: "PUT", body: { state: "active", origin: "launcher", model: { provider: options.provider, model }, items: [] } });
	if (thread.status !== 200) throw new Error(`a new conversation answered ${thread.status}: ${JSON.stringify(thread.body)}`);
	return RoomSocket.open(options.base, options.token, roomId, conversationId, options.provider, model);
}

function turnCost(agentEnd: Frame): number {
	return (agentEnd.event?.messages ?? []).filter((message: any) => message?.role === "assistant").reduce((sum: number, message: any) => sum + (Number(message?.usage?.cost?.total) || 0), 0);
}

// Every attempt's and answer's cost: a failed attempt the room retries ends
// with its own agent_end (marked retrying), and so does each prompt the room
// sends within the turn.
function framesCost(frames: Frame[]): number {
	return frames.filter((frame) => frame.type === "event" && frame.event?.type === "agent_end").reduce((sum, frame) => sum + turnCost(frame), 0);
}

function turnError(frames: Frame[]): string | undefined {
	const error = frames.find((frame) => frame.type === "error");
	if (error) return String(error.message ?? error.code ?? "error").slice(0, 300);
	const lastEnd = frames.filter((frame) => frame.type === "event" && frame.event?.type === "agent_end").at(-1);
	const last = [...(lastEnd?.event?.messages ?? [])].reverse().find((message: any) => message?.role === "assistant");
	return last?.stopReason === "error" ? String(last.errorMessage ?? "error").slice(0, 300) : undefined;
}

// The room's own word that its turn is over: no turn in flight and none
// cancelling. Its frames cannot say it: a retried attempt, a Stop during the
// retry wait and the answer the room asks for after a thin tool turn all
// fall either side of an agent_end.
async function roomSettled(options: SweepOptions, roomId: string, timeoutMs: number): Promise<boolean> {
	const status = await api(options, "/api/persistent-agents", { timeoutMs });
	const rooms: any[] = status.body?.agents ?? (Array.isArray(status.body) ? status.body : []);
	const thread = rooms.find((room) => room.id === roomId)?.activeThread;
	return thread?.inFlight === false && thread?.cancelling !== true;
}

// A status read that fails or stalls says nothing about the turn, so it is
// read again; each read ends by the deadline, so a lost read never keeps
// the sweep from sending Stop.
async function waitSettled(options: SweepOptions, roomId: string, deadline: number): Promise<boolean> {
	while (Date.now() < deadline) {
		try {
			if (await roomSettled(options, roomId, Math.max(1, deadline - Date.now()))) return true;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	return false;
}

// One turn on the socket: the effort frame, then the prompt, then the room
// settled. A turn past its timeout is stopped with the page's Stop frame, so
// it does not go on spending on the server. Returns the shown rung, the cost
// of every attempt and answer in the turn, and its error.
async function runRung(options: SweepOptions, room: RoomSocket, roomId: string, rung: Rung, timeoutMs: number): Promise<{ shown: string; costUsd: number; appError?: string; timedOut?: boolean; sentAt: number }> {
	const echo = await room.setEffort(rung.level, "the effort echo");
	for (let attempt = 0; attempt < 20; attempt++) {
		const from = room.frames.length;
		const sentAt = Date.now();
		const deadline = sentAt + timeoutMs;
		room.send({ type: "prompt", text: SWEEP_PROMPT });
		let stopped = false;
		try {
			// The first frame says the room took the message, or refused it.
			const first = await room.waitFor((frame) => frame.type === "event" || frame.type === "error", "the turn to start", from, timeoutMs);
			if (first.type === "error" && /still running|is cancelling/.test(String(first.message ?? ""))) {
				await new Promise((resolve) => setTimeout(resolve, 500));
				continue;
			}
			if (!(await waitSettled(options, roomId, deadline))) {
				stopped = true;
				room.send({ type: "abort" });
				if (!(await waitSettled(options, roomId, Date.now() + 30_000))) throw new Error(`the room's turn did not settle 30 s after Stop (rung ${rung.label})`);
			}
			// The status read can run ahead of the socket, with the turn's last
			// frames still on their way. An effort frame sent now is echoed
			// behind them on the same socket, so the frames before its echo are
			// the whole turn.
			const ack = room.frames.indexOf(await room.setEffort(rung.level, "the settled turn's echo"));
			const frames = room.frames.slice(from, ack);
			return { shown: String(echo.level), costUsd: framesCost(frames), ...(stopped ? { timedOut: true } : { appError: turnError(frames) }), sentAt };
		} catch (error) {
			// The turn may still be spending on the server: stop it before the
			// error ends the sweep, since a closed socket leaves it running.
			if (!stopped) {
				try {
					room.send({ type: "abort" });
				} catch {}
				await waitSettled(options, roomId, Date.now() + 30_000);
			}
			throw error;
		}
	}
	throw new Error("the room never took the message");
}

// Every call this turn made to the room's model, once each answer is logged.
// The sweep runs one turn at a time, so these are the turn's own: retried
// attempts, the steps of a tool loop, the answer asked for after one.
async function callsFor(log: string, model: string, sentAt: number): Promise<RecordedCall[]> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const calls = readRecorderLog(log).filter((call) => call.at >= sentAt && call.model === model);
		if ((calls.length > 0 && calls.every((call) => call.answer)) || Date.now() > deadline) return calls;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
}

export async function runSweep(options: SweepOptions): Promise<SweepResult> {
	if (!Number.isFinite(options.maxUsd) || options.maxUsd < 0) throw new Error(`--max-usd must be a number of dollars, 0 or more, got ${options.maxUsd}`);
	const turnTimeoutMs = options.turnTimeoutMs ?? TURN_TIMEOUT_MS;
	const route = options.route ?? options.provider;
	const offered = await offeredModels(options);
	const models = options.models ? options.models.filter((model) => offered.includes(model)) : offered;
	const notOffered = options.models?.filter((model) => !offered.includes(model)) ?? [];
	const rows: SweepRow[] = [];
	const notSwept: string[] = notOffered.map((model) => `${model} (not offered by ${options.provider})`);
	let costUsd = 0;
	let stoppedForBudget = false;
	// Room names are unique, and a second sweep on the same server must not clash with the first.
	const sweepStamp = new Date().toISOString().slice(11, 19);
	fs.mkdirSync(path.dirname(options.out), { recursive: true });
	fs.writeFileSync(options.out, `${TSV_HEADER.join("\t")}\n`);
	const keep = (row: SweepRow) => {
		rows.push(row);
		fs.appendFileSync(options.out, `${rowToTsv(row)}\n`);
		options.onRow?.(row);
	};

	for (const model of models) {
		const created = await api(options, "/api/persistent-agents", { method: "POST", body: { displayName: `Sweep ${model} ${sweepStamp}`, userName: "Sweep", preferredUserAddress: "Sweep" } });
		const roomId = String(created.body?.agent?.id ?? "");
		if (created.status !== 201 || !roomId) throw new Error(`creating a room answered ${created.status}: ${JSON.stringify(created.body)}`);
		const pick = await api(options, `/api/persistent-agents/${roomId}/models`, { method: "PUT", body: { conversation: { provider: options.provider, model } } });
		if (pick.status !== 200) {
			notSwept.push(`${model} (the model pick answered ${pick.status}: ${JSON.stringify(pick.body?.error ?? pick.body)})`);
			continue;
		}
		const room = await freshConversation(options, roomId, model);
		try {
			const ready = await room.waitFor((frame) => frame.type === "ready" || frame.type === "error", "the ready frame", 0, 30_000);
			if (ready.type === "error") {
				notSwept.push(`${model} (the room refused to open: ${String(ready.message ?? ready.code ?? "error").slice(0, 200)})`);
				continue;
			}
			// A model that cannot think offers "off" alone, and the composer hides
			// its dial: nothing to sweep.
			let ladder: Rung[] = ready.effort?.ladder ?? [];
			if (ladder.every((rung) => rung.level === "off")) {
				notSwept.push(`${model} (no thinking dial)`);
				ladder = [];
			}
			let previousBudget: number | undefined;
			for (const rung of ladder) {
				// Past the budget a model is still opened, which costs nothing, so a
				// model without a dial is still told apart from one left unswept.
				if (costUsd >= options.maxUsd) {
					stoppedForBudget = true;
					keep({ route, model, label: rung.label, level: rung.level, shown: "", sent: "", accepted: "", reasoningTokens: 0, thinkingBlocks: 0, thinkingChars: 0, answerEffort: "", calls: 0, costUsd: 0, flags: [], notRun: "not run (budget)" });
					continue;
				}
				const turn = await runRung(options, room, roomId, rung, turnTimeoutMs);
				costUsd += turn.costUsd;
				const calls = await callsFor(options.log, model, turn.sentAt);
				if (calls.length === 0 && turn.costUsd > 0) throw new Error(`a paid turn on ${model} left no record in ${options.log}: is the recorder loaded into the server?`);
				// Every call that answered is judged (a tool loop makes several);
				// whether the rung was taken is the last call's word, and the
				// failed attempts before it were retried.
				const answered = (call: RecordedCall) => Boolean(call.answer && !call.answer.error && call.answer.status > 0 && call.answer.status < 400);
				const last = calls.at(-1);
				const judged = [...calls.filter(answered), ...(last && !answered(last) ? [last] : [])];
				const failedBefore = calls.slice(0, -1).filter((attempt) => !answered(attempt));
				let flags = [...new Set((judged.length > 0 ? judged : [undefined]).flatMap((call) => judgeRung(rung, call, previousBudget)))];
				if (turn.timedOut) flags = [`timed out after ${Math.round(turnTimeoutMs / 1000)} s; the turn was stopped`, ...flags.filter((flag) => !flag.startsWith("refused") && flag !== "no answer was recorded")];
				const budget = last?.sent.thinking?.budget_tokens;
				if (typeof budget === "number") previousBudget = budget;
				const answers = turn.timedOut ? [] : calls.filter(answered).map((call) => call.answer!);
				const lastAnswer = turn.timedOut ? undefined : last?.answer;
				const refusal = turn.timedOut ? "timed out" : ((lastAnswer && !answered(last!) ? (lastAnswer.error ?? `status ${lastAnswer.status}`) : undefined) ?? turn.appError);
				if (turn.appError && !flags.some((flag) => flag.startsWith("refused"))) flags.push(`the room reported: ${turn.appError}`);
				const retried = failedBefore.length > 0 ? `, after ${failedBefore.length} failed attempt(s): ${failedBefore[0].answer?.error ?? `status ${failedBefore[0].answer?.status}`}` : "";
				const sum = (pick: (answer: RecordedAnswer) => number) => answers.reduce((total, answer) => total + pick(answer), 0);
				keep({
					route,
					model,
					label: rung.label,
					level: rung.level,
					shown: turn.shown,
					sent: calls.length > 0 ? [...new Set(calls.map((call) => describeSent(call.sent)))].join(" | ") : "not recorded",
					accepted: refusal ? `no: ${refusal}` : `yes${retried}`,
					reasoningTokens: sum((answer) => answer.reasoningTokens),
					thinkingBlocks: sum((answer) => answer.thinkingBlocks),
					thinkingChars: sum((answer) => answer.thinkingChars),
					answerEffort: [...new Set(answers.map((answer) => answer.effort).filter(Boolean))].join(" | "),
					calls: calls.length,
					costUsd: turn.costUsd,
					flags,
				});
			}
		} finally {
			await room.close();
		}
	}
	return { rows, costUsd, stoppedForBudget, notSwept };
}

function argValue(args: string[], name: string): string | undefined {
	const index = args.indexOf(`--${name}`);
	return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const runDir = argValue(args, "run");
	const provider = argValue(args, "provider");
	const log = argValue(args, "log");
	const out = argValue(args, "out");
	if (!runDir || !provider || !log || !out) {
		console.error("usage: thinking-levels-sweep.ts --run <verify run dir> --provider <id> --log <recorder jsonl> --out <file.tsv> [--route <name>] [--max-usd 1] [--models id,id]");
		process.exit(2);
	}
	const run = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8"));
	const token = fs.readFileSync(path.join(runDir, "token"), "utf8").trim();
	const result = await runSweep({
		base: run.base,
		token,
		provider,
		route: argValue(args, "route"),
		log: path.resolve(log),
		out: path.resolve(out),
		maxUsd: Number(argValue(args, "max-usd") ?? 1),
		models: argValue(args, "models")?.split(","),
		onRow: (row) => console.log(`${row.model}\t${row.label}\t${row.sent}\t${row.accepted}\t$${row.costUsd.toFixed(4)}\t${row.notRun ?? (row.flags.join("; ") || "ok")}`),
	});
	const flagged = result.rows.filter((row) => row.flags.length > 0);
	const notRun = result.rows.filter((row) => row.notRun).length;
	console.log(`rows ${result.rows.length}, flagged ${flagged.length}${notRun ? `, not run ${notRun}` : ""}, cost $${result.costUsd.toFixed(4)}${result.stoppedForBudget ? ", stopped at the budget" : ""}`);
	for (const skipped of result.notSwept) console.log(`not swept: ${skipped}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main();
}
