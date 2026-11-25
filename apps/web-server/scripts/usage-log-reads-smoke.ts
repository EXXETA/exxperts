// The usage log's reads: bounded however long the log grows, and loud when the
// log cannot be read. A log that cannot be read is never taken for an empty one:
// the start's import appends nothing, the duplicate check writes its row marked
// unchecked and tells the operator, and the Wallet's routes answer an error.
//
//   R1 the start's import with the log unreadable, on two starts in a row
//   R2 the reader: chunk edges, long and broken lines, the log's end, failures
//   R3 the duplicate check: its 32 MiB bound and a log it cannot read
//   R4 the Wallet and the CSV
//
// A log that refuses reads but takes appends (mode 0200) is what a log past
// Node's longest string was to the old reader: the case that appended every
// turn again at each start. Taking rights away refuses no read on Windows or as
// root, so those rows are skipped there with the reason printed; a folder in the
// log's place refuses the read everywhere.
//
// Run: node --import tsx/esm apps/web-server/scripts/usage-log-reads-smoke.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-usage-log-reads-"));
const tempHome = path.join(tmp, "home");
const appDir = path.join(tempHome, ".exxperts", "app");
const agentsRoot = path.join(appDir, "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
fs.mkdirSync(agentsRoot, { recursive: true, mode: 0o700 });
fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;
process.env.EXXETA_HOME = repoRoot;

const logFile = path.join(appDir, "usage.jsonl");
const reconciledFile = path.join(appDir, "usage-reconciled.json");
const canForceFsRefusal = process.platform !== "win32" && process.getuid?.() !== 0;
const MiB = 1024 * 1024;

function skipped(row: string): void {
	console.log(`usage-log-reads-smoke: skipped "${row}": taking rights away refuses no read on Windows or as root`);
}

/** The log as it is on disk, rights given back first. */
function rowsOnDisk(): Array<Record<string, unknown>> {
	if (!fs.lstatSync(logFile, { throwIfNoEntry: false })?.isFile()) return [];
	giveRightsBack();
	return fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/** Gives a plain log file its rights back; never follows a link, so a link to a device is left as it is. */
function giveRightsBack(): void {
	if (fs.lstatSync(logFile, { throwIfNoEntry: false })?.isFile()) fs.chmodSync(logFile, 0o600);
}

function clearLog(): void {
	giveRightsBack();
	fs.rmSync(logFile, { recursive: true, force: true });
	fs.rmSync(reconciledFile, { force: true });
}

function row(i: number, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({ ts: 1_700_000_000_000 + i, agent: `room-${i % 7}`, persona: "business", model: "gpt-5.5", modelLabel: "Ünïcødé ✓ 日本語", input: i, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.001, ...extra });
}

try {
	const usageLog = await import("../src/usage-log.js");
	const { importHistoricalSessionUsage } = await import("../src/usage-import.js");

	// --- R1: the start's import with the log unreadable ---------------------
	const iso = (t: number) => new Date(t).toISOString();
	const sessions = path.join(agentsRoot, "room-r1", "runtime", "pi-sessions");
	fs.mkdirSync(sessions, { recursive: true });
	const now = Date.now();
	fs.writeFileSync(path.join(sessions, "c_r1.jsonl"), [
		JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: iso(now - 9000), cwd: "/tmp" }),
		JSON.stringify({ type: "model_change", id: "m1", parentId: null, timestamp: iso(now - 9000), provider: "openai-codex", modelId: "gpt-5.5" }),
		...[1, 2, 3].map((n) => JSON.stringify({ id: `a${n}`, parentId: "m1", timestamp: iso(now - 9000 + n * 1000), message: { role: "assistant", usage: { input: 100 * n, output: n, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } } })),
	].join("\n") + "\n");

	/** Two starts in a row on the log as `prepare` leaves it: the rows on disk after, and the lines warned. */
	function twoStarts(prepare: () => void): { rows: number; warned: string[] } {
		clearLog();
		prepare();
		const warned: string[] = [];
		for (let start = 0; start < 2; start += 1) importHistoricalSessionUsage(agentsRoot, (message) => warned.push(message));
		const rows = rowsOnDisk().length;
		return { rows, warned };
	}
	const skippedLines = (warned: string[]) => warned.filter((line) => line === usageLog.USAGE_RECONCILE_SKIPPED).length;

	const readable = twoStarts(() => fs.writeFileSync(logFile, "", { mode: 0o600 }));
	assert(readable.rows === 3 && skippedLines(readable.warned) === 0, `R1 control: a readable empty log takes the 3 turns once over two starts, got ${readable.rows} rows and ${JSON.stringify(readable.warned)}`);
	if (canForceFsRefusal) {
		const writeOnly = twoStarts(() => fs.writeFileSync(logFile, "", { mode: 0o200 }));
		assert(writeOnly.rows === 0, `R1: a log that refuses reads gets no row from either start, got ${writeOnly.rows} (3 a start is every turn appended again)`);
		assert(skippedLines(writeOnly.warned) === 2, `R1: each start says the log could not be read, got ${JSON.stringify(writeOnly.warned)}`);
		const noRights = twoStarts(() => fs.writeFileSync(logFile, "", { mode: 0o000 }));
		assert(noRights.rows === 0 && skippedLines(noRights.warned) === 2, `R1: a log with no rights: no row, the line each start, got ${noRights.rows} and ${JSON.stringify(noRights.warned)}`);
	} else skipped("R1 a log that refuses reads");
	const folder = twoStarts(() => fs.mkdirSync(logFile));
	assert(folder.rows === 0 && fs.statSync(logFile).isDirectory() && skippedLines(folder.warned) === 2, `R1: a folder in the log's place: nothing appended, the line each start, got ${JSON.stringify(folder.warned)}`);
	clearLog();
	console.log("R1 ok: a log that cannot be read gets nothing from the start's import, and each start says so");

	// --- R2: the reader -----------------------------------------------------
	const { forEachUsageLine, forEachUsageRow, loadUsage } = usageLog;
	const all = (): Array<Record<string, any>> => {
		const rows: Array<Record<string, any>> = [];
		forEachUsageRow((r) => rows.push(r as any));
		return rows;
	};
	assert(all().length === 0 && loadUsage().length === 0, "R2: a missing log is no rows");

	// A row whose multi-byte character starts one byte before the first chunk's edge.
	const lines: string[] = [];
	let bytes = 0;
	let i = 0;
	while (bytes < MiB - 64 * 1024) {
		const line = row(i++);
		lines.push(line);
		bytes += Buffer.byteLength(line) + 1;
	}
	const probe = row(i++, { agent: "probe" });
	const charAt = Buffer.from(probe).indexOf(Buffer.from("日"));
	const fillerBase = Buffer.byteLength(JSON.stringify({ ts: 1, agent: "filler", pad: "" })) + 1;
	const pad = MiB - 1 - charAt - bytes - fillerBase;
	lines.push(JSON.stringify({ ts: 1, agent: "filler", pad: "x".repeat(pad) }));
	bytes += fillerBase + pad;
	assert(bytes + charAt === MiB - 1, `R2 setup: the probe's character starts at ${bytes + charAt}, not one byte before the chunk's edge`);
	lines.push(probe);
	lines.push("{not json at all");
	const calls = Array.from({ length: 80_000 }, (_, n) => ({ input: n, output: 1, cacheRead: 0 }));
	lines.push(row(i++, { agent: "scheduled-big", kind: "scheduled", runId: "bg_big", calls }));
	while (bytes < 3 * MiB) {
		const line = row(i++);
		lines.push(line);
		bytes += Buffer.byteLength(line) + 1;
	}
	const lastRow = row(i++, { agent: "last" });
	fs.writeFileSync(logFile, `${lines.join("\n")}\n${lastRow}`, { mode: 0o600 });
	const read = all();
	const expected = [...lines, lastRow].filter((line) => line !== "{not json at all").map((line) => JSON.parse(line));
	assert(read.length === expected.length, `R2: every whole row is read, the broken one skipped: ${read.length} of ${expected.length}`);
	assert(JSON.stringify(read) === JSON.stringify(expected), "R2: the rows read are the rows written, in file order");
	const probeRead = read.find((r) => r.agent === "probe");
	assert(probeRead?.modelLabel === "Ünïcødé ✓ 日本語", `R2: a character cut by the chunk's edge reads whole, got ${probeRead?.modelLabel}`);
	const big = read.find((r) => r.agent === "scheduled-big");
	assert(big?.calls?.length === 80_000, `R2: a scheduled row of ${(Buffer.byteLength(JSON.stringify(calls)) / MiB).toFixed(1)} MiB is read whole, got ${big?.calls?.length} calls`);
	const brokenAt = read.findIndex((r) => r.agent === "probe");
	assert(read[brokenAt + 1]?.agent === "scheduled-big", "R2: both neighbours of the broken line are kept");
	assert(read.at(-1)?.agent === "last", "R2: the last line, with no line end, is read");
	assert(loadUsage().length === expected.length, "R2: loadUsage gives the same rows");

	// The log's end: the line cut there is left out, a whole one kept.
	fs.writeFileSync(logFile, "aaaa\nbbbb\ncccc\n", { mode: 0o600 });
	const tail = (lastBytes: number) => {
		const got: string[] = [];
		forEachUsageLine((line) => got.push(line), lastBytes);
		return got.join(",");
	};
	assert(tail(7) === "cccc", `R2: from inside "bbbb", only the lines after it, got ${tail(7)}`);
	assert(tail(10) === "bbbb,cccc", `R2: from the start of "bbbb", that line too, got ${tail(10)}`);
	assert(tail(100) === "aaaa,bbbb,cccc", `R2: more than the log is the whole log, got ${tail(100)}`);

	// A line past 16 MiB is no row we write: the read fails, it never skips.
	fs.writeFileSync(logFile, `${row(1)}\n${"x".repeat(17 * MiB)}\n${row(2)}\n`, { mode: 0o600 });
	let tooLong: unknown;
	try {
		all();
	} catch (error) {
		tooLong = error;
	}
	assert((tooLong as { code?: string })?.code === "usage_line_too_long", `R2: a 17 MiB line makes the read fail, got ${String(tooLong)}`);

	const readFails = (): unknown => {
		try {
			loadUsage();
		} catch (error) {
			return error;
		}
		return null;
	};
	clearLog();
	fs.mkdirSync(logFile);
	assert(readFails() !== null, "R2: a folder in the log's place makes the read fail");
	clearLog();
	// A device opens, has no size and gives no bytes, as a folder does on a file system that sizes it 0.
	if (process.platform !== "win32") {
		fs.symlinkSync("/dev/null", logFile);
		assert((readFails() as { code?: string } | null)?.code === "usage_log_not_a_file", `R2: a log that is no file makes the read fail, got ${String(readFails())}`);
		clearLog();
	} else console.log("usage-log-reads-smoke: skipped \"R2 a log that is no file\": /dev/null is not on Windows");
	if (canForceFsRefusal) {
		fs.writeFileSync(logFile, `${row(1)}\n`, { mode: 0o200 });
		assert((readFails() as NodeJS.ErrnoException | null)?.code === "EACCES", "R2: a log that refuses reads makes the read fail");
		fs.chmodSync(logFile, 0o600);
		assert(readFails() === null && loadUsage().length === 1, "R2 control: the same log readable gives its row");
	} else skipped("R2 a log that refuses reads");
	clearLog();
	console.log("R2 ok: rows across chunk edges read whole, a broken line skipped, a long row kept, failures thrown");

	// --- R3: the duplicate check ---------------------------------------------
	const { appendUsageOnce } = usageLog;
	const scheduled = (runId: string) => ({ ts: Date.now(), agent: "room-r3", persona: "business", kind: "scheduled" as const, input: 3, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.005, runId });
	const runRows = (runId: string) => rowsOnDisk().filter((r) => r.runId === runId);
	assert(appendUsageOnce(scheduled("bg_once")) === undefined && appendUsageOnce(scheduled("bg_once")) === undefined, "R3: a readable log reports no failure");
	assert(runRows("bg_once").length === 1, `R3: a run billed twice has one row, got ${runRows("bg_once").length}`);

	/** A log of `before` MiB of rows, the run's row, then `after` MiB of rows. */
	function plantAround(runId: string, before: number, after: number): void {
		clearLog();
		const fd = fs.openSync(logFile, "w", 0o600);
		const fill = (mib: number) => {
			let written = 0;
			let batch: string[] = [];
			for (let n = 0; written < mib * MiB; n += 1) {
				const line = row(n);
				batch.push(line);
				written += Buffer.byteLength(line) + 1;
				if (batch.length === 5000) {
					fs.writeSync(fd, `${batch.join("\n")}\n`);
					batch = [];
				}
			}
			if (batch.length) fs.writeSync(fd, `${batch.join("\n")}\n`);
		};
		fill(before);
		fs.writeSync(fd, `${JSON.stringify(scheduled(runId))}\n`);
		fill(after);
		fs.closeSync(fd);
	}
	plantAround("bg_near", 10, 30);
	appendUsageOnce(scheduled("bg_near"));
	assert(runRows("bg_near").length === 1, `R3: a row 30 MiB back in a 40 MiB log is found, got ${runRows("bg_near").length} rows`);
	plantAround("bg_far", 1, 33);
	appendUsageOnce(scheduled("bg_far"));
	assert(runRows("bg_far").length === 2, `R3: the bound: a row 33 MiB back is past the check, got ${runRows("bg_far").length} rows`);
	clearLog();

	if (canForceFsRefusal) {
		fs.writeFileSync(logFile, `${JSON.stringify(scheduled("bg_blind"))}\n`, { mode: 0o200 });
		const failure = appendUsageOnce(scheduled("bg_blind"));
		assert((failure as NodeJS.ErrnoException | undefined)?.code === "EACCES", `R3: a log the check cannot read reports the failure, got ${String(failure)}`);
		const blind = runRows("bg_blind");
		assert(blind.length === 2 && blind[1]?.unchecked === true && blind[0]?.unchecked === undefined, `R3: the row is written all the same, marked unchecked, with its run id, got ${JSON.stringify(blind)}`);
	} else skipped("R3 the check cannot read the log");
	clearLog();
	console.log("R3 ok: a run billed again within 32 MiB is not doubled; a log the check cannot read gets the row marked unchecked");

	// R3, through a scheduled run's billing: the line reaches the server's logger.
	if (canForceFsRefusal) await scheduledRunBilling();
	else skipped("R3 a scheduled run billed on a log the check cannot read");

	// --- R4: the Wallet and the CSV ------------------------------------------
	const { registerUsageApi } = await import("../src/usage-api.js");
	const app = Fastify();
	registerUsageApi(app, { findModel: () => undefined, liveAgents: () => new Map(), roomNames: async () => ({ live: new Map(), archived: new Map() }), providerDisplayName: () => undefined });
	await app.ready();
	fs.writeFileSync(logFile, `${row(1)}\n${row(2)}\n`, { mode: 0o600 });
	const wallet = await app.inject({ method: "GET", url: "/api/usage" });
	const csv = await app.inject({ method: "GET", url: "/api/usage/export.csv" });
	assert(wallet.statusCode === 200 && wallet.json().totals.turns === 2, `R4 control: a readable log's Wallet holds its 2 turns, got ${wallet.statusCode}`);
	assert(csv.statusCode === 200 && csv.body.trim().split("\n").length === 3, `R4 control: its CSV holds a header and 2 rows, got ${csv.statusCode}`);
	clearLog();
	fs.mkdirSync(logFile);
	for (const url of ["/api/usage", "/api/usage/export.csv"]) {
		const answer = await app.inject({ method: "GET", url });
		assert(answer.statusCode === 500 && answer.json().code === "usage_unreadable", `R4: ${url} on a log that cannot be read answers 500, got ${answer.statusCode} ${answer.body}`);
	}
	await app.close();
	clearLog();
	console.log("R4 ok: the Wallet and its CSV answer an error, never an empty log");

	console.log("usage log reads smoke passed");
} finally {
	giveRightsBack();
	fs.rmSync(tmp, { recursive: true, force: true });
}

/** A scheduled run billed again on a log its check cannot read: the row is written unchecked and the logger gets the line, as the server's loop passes it. */
async function scheduledRunBilling(): Promise<void> {
	const writeJson = (file: string, value: unknown) => {
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
	};
	writeJson(path.join(appDir, "openai-compatible-ai-profile.json"), { profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }], maintenanceModel: "gpt-5.5" });
	writeJson(path.join(appDir, "persistent-agent-ai-profile.json"), { profileId: "openai-compatible" });
	writeJson(path.join(agentDir, "models.json"), { providers: { "openai-compatible": { name: "Synthetic Gateway", baseUrl: "https://synthetic.invalid/v1", api: "openai-completions", models: [{ id: "gpt-5.5", name: "GPT 5.5" }] } } });
	writeJson(path.join(agentDir, "auth.json"), { "openai-compatible": { type: "api_key", key: "synthetic-key" } });
	const { writePersistentAgentAiProfileState } = await import("../src/persistent-agent-ai-profile-state.js");
	writePersistentAgentAiProfileState("openai-compatible");
	const { addPersistentRoomScheduleJob } = await import("../../../pi-package/extensions/schedule-prompt/index.js");
	const { createScheduledPromptBackgroundRunPreflight } = await import("../src/scheduled-prompt-runs.js");
	const { processScheduledPromptBackgroundRunExecutionOnce } = await import("../src/scheduled-prompt-background-execution.js");
	const { scheduledPromptBackgroundAssistantItemId, scheduledPromptBackgroundThreadId, scheduledPromptBackgroundUserItemId } = await import("../src/persistent-room-background-execution.js");
	const agents = await import("../src/persistent-agents.js");
	const { USAGE_ROW_UNCHECKED } = await import("../src/usage-log.js");
	const baseNow = new Date("2026-01-01T00:00:00.000Z");

	const fakeExecute = async (input: any) => {
		const runId = String(input.executionId);
		const threadId = scheduledPromptBackgroundThreadId(runId);
		const model = input.target.model;
		agents.writePersistentAgentThread(input.roomId, threadId, { state: "standby", origin: "home", model, items: [] }, {
			createRuntime: ({ instance, threadId: created, model: createdModel }: any) => agents.createPersistentAgentPiSessionJsonlThreadRuntime({ agentId: instance.agentId, threadId: created, model: createdModel, cwd: repoRoot }),
		});
		const assistantText = `synthetic answer for ${runId}`;
		const write = agents.writePersistentAgentThread(input.roomId, threadId, {
			state: "standby",
			origin: "home",
			model,
			items: [{ kind: "user", id: scheduledPromptBackgroundUserItemId(runId), text: input.prompt }, { kind: "assistant", id: scheduledPromptBackgroundAssistantItemId(runId), text: assistantText, streaming: false }],
		});
		return { roomId: input.roomId, threadId, targetKind: "fresh-thread", model, assistantText, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01 }, items: { userItemId: scheduledPromptBackgroundUserItemId(runId), assistantItemId: scheduledPromptBackgroundAssistantItemId(runId) }, thread: write.thread };
	};

	/** A run whose first bill is already in the log, billed again by a pass; the rows of the run after, and what the logger got. */
	async function billedAgain(name: string, mode: number): Promise<{ rows: Array<Record<string, unknown>>; logged: Array<{ fields: any; message?: string }> }> {
		const roomId = String(agents.createPersistentAgentFromScaffoldInput({ displayName: name, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId);
		const job = addPersistentRoomScheduleJob(roomId, { name, type: "once", schedule: "+30m", prompt: "a scheduled question", now: baseNow });
		const run = createScheduledPromptBackgroundRunPreflight({ roomId, scheduleJobId: job.id, dueAt: String(job.nextRunAt), now: baseNow }).run;
		clearLog();
		fs.writeFileSync(logFile, `${JSON.stringify({ ts: Date.now(), agent: roomId, persona: "business", kind: "scheduled", input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01, runId: run.runId })}\n`, { mode });
		const logged: Array<{ fields: any; message?: string }> = [];
		const summary = await processScheduledPromptBackgroundRunExecutionOnce({
			workerId: `usage-log-reads:${name}`,
			now: new Date("2026-01-01T01:00:00.000Z"),
			limit: 1,
			leaseMs: 60_000,
			heartbeatMs: 1_000,
			executePrompt: fakeExecute as any,
			logger: { warn: (fields, message) => logged.push({ fields, message }) },
		});
		assert(summary.processed.some((item) => item.runId === run.runId && item.finalStatus === "succeeded"), `R3 ${name}: the run completes, got ${JSON.stringify(summary.processed)}`);
		return { rows: rowsOnDisk().filter((r) => r.runId === run.runId), logged };
	}

	const readableRun = await billedAgain("R3 readable", 0o600);
	assert(readableRun.rows.length === 1 && readableRun.logged.length === 0, `R3 control: a readable log keeps the run at one row and logs nothing, got ${JSON.stringify(readableRun)}`);
	const blindRun = await billedAgain("R3 unreadable", 0o200);
	assert(blindRun.rows.length === 2 && blindRun.rows[1]?.unchecked === true, `R3: the run's second row is written, marked unchecked with its run id, got ${JSON.stringify(blindRun.rows)}`);
	const line = blindRun.logged.find((entry) => entry.message === USAGE_ROW_UNCHECKED);
	assert(line && (line.fields.err as NodeJS.ErrnoException)?.code === "EACCES" && blindRun.logged.length === 1, `R3: the logger gets the unchecked line with the read's failure, got ${JSON.stringify(blindRun.logged.map((entry) => entry.message))}`);
	clearLog();
	console.log("R3 ok: a scheduled run billed on a log its check cannot read tells the server's logger");
}
