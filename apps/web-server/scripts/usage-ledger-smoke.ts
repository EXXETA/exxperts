import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { UsageRow } from "../src/usage-log.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-usage-ledger-"));
const tempHome = path.join(tmp, "home");
fs.mkdirSync(tempHome, { recursive: true, mode: 0o700 });

process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = path.join(tempHome, ".exxperts", "agent");
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = path.join(tempHome, ".exxperts", "app", "personalized-agents");
process.env.EXXETA_HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

try {
	const { appendUsage, loadUsage } = await import("../src/usage-log.js");
	const { importHistoricalSessionUsage } = await import("../src/usage-import.js");
	const { modelGroupOf, registerUsageApi } = await import("../src/usage-api.js");

	// --- canonical model grouping (spec: model-names.ts) merges raw-id variants
	assert(modelGroupOf({ model: "claude-opus-4-8" }).key === modelGroupOf({ model: "claude-opus-4.8" }).key, "raw-id variants share a group");
	assert(modelGroupOf({ model: "claude-opus-4-8" }).name === "Claude Opus 4.8", "group renders the canonical name");
	assert(modelGroupOf({ model: "claude-sonnet-4-5-20250929" }).key !== modelGroupOf({ model: "claude-sonnet-4-5" }).key && modelGroupOf({ model: "claude-sonnet-4-5-20250929" }).name === "Claude Sonnet 4.5", "a dated snapshot keeps its own row, under its plain name");
	assert(modelGroupOf({ model: "gpt-5.5" }).key === modelGroupOf({ model: "gpt-5.5", modelLabel: "ChatGPT Plus/Pro — GPT-5.5" }).key, "label eras share a group");

	// --- ledger append + chronological load --------------------------------
	const now = Date.now();
	const day = 24 * 3600 * 1000;
	appendUsage({ ts: now - day, agent: "room-a", persona: "business", model: "gpt-5.5", modelLabel: "ChatGPT Plus/Pro — GPT-5.5", input: 100, output: 10, cacheRead: 50, cacheWrite: 0, cost: 0.01 });
	appendUsage({ ts: now, agent: "room-a", persona: "business", model: "claude-opus-4-8", provider: "anthropic", authType: "api_key", kind: "scheduled", input: 200, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.02 });
	appendUsage({ ts: now - 10 * day, agent: "room-a", persona: "business", model: "gpt-5.5", input: 300, output: 30, cacheRead: 0, cacheWrite: 0, cost: 0.03 });
	// Gateway turns on API keys, all recorded at zero. On the legacy gateway: one
	// that moved tokens on a model nothing prices even today, one that moved
	// none at all (an aborted turn: nothing to price; older builds wrote such
	// rows, the app no longer does, and the Wallet still reads the ones on
	// disk). On a live gateway whose
	// model has a price on file now: a turn from before the price was read. On
	// a gateway that was removed since: a turn whose model nobody answers for.
	appendUsage({ ts: now - 2 * day, agent: "room-b", persona: "business", model: "gateway-model", provider: "openai-compatible", authType: "api_key", input: 400, output: 40, cacheRead: 0, cacheWrite: 0, cost: 0 });
	appendUsage({ ts: now - 2 * day, agent: "room-b", persona: "business", model: "gateway-model", provider: "openai-compatible", authType: "api_key", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
	appendUsage({ ts: now - 2 * day, agent: "room-b", persona: "business", model: "foo-large", provider: "gateway-foo", authType: "api_key", input: 1000, output: 100, cacheRead: 500, cacheWrite: 0, cost: 0 });
	appendUsage({ ts: now - 3 * day, agent: "room-c", persona: "business", model: "old-model", provider: "gateway-old", authType: "api_key", input: 50, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0 });
	const loaded = loadUsage();
	assert(loaded.length === 7, "seven rows persisted");
	assert(loaded[0].ts <= loaded[1].ts && loaded[1].ts <= loaded[2].ts, "loadUsage restores chronological order");

	// --- historical import: dedupe, kind mapping, idempotence --------------
	const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
	const sessionsDir = path.join(agentsRoot, "room-a", "runtime", "pi-sessions");
	fs.mkdirSync(sessionsDir, { recursive: true });
	const iso = (t: number) => new Date(t).toISOString();
	// One assistant message matching an existing ledger row (100/10/50): must be skipped.
	// One unmatched message in a cli thread: must import with kind "cli".
	fs.writeFileSync(
		path.join(sessionsDir, "c_thread1.jsonl"),
		[
			JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: iso(now - day), cwd: "/tmp" }),
			JSON.stringify({ type: "model_change", id: "m1", parentId: null, timestamp: iso(now - day), provider: "openai-codex", modelId: "gpt-5.5" }),
			JSON.stringify({ id: "a1", parentId: "m1", timestamp: iso(now - day + 1000), message: { role: "assistant", usage: { input: 100, output: 10, cacheRead: 50, cacheWrite: 0, cost: { total: 0.01 } } } }),
		].join("\n") + "\n",
	);
	fs.writeFileSync(
		path.join(sessionsDir, "cli_thread2.jsonl"),
		[
			JSON.stringify({ type: "session", version: 3, id: "s2", timestamp: iso(now - 2 * day), cwd: "/tmp" }),
			JSON.stringify({ type: "model_change", id: "m2", parentId: null, timestamp: iso(now - 2 * day), provider: "openai-codex", modelId: "gpt-5.5" }),
			JSON.stringify({ id: "a2", parentId: "m2", timestamp: iso(now - 2 * day + 1000), message: { role: "assistant", usage: { input: 777, output: 66, cacheRead: 5, cacheWrite: 0, cost: { total: 0.055 } } } }),
		].join("\n") + "\n",
	);
	const summary = importHistoricalSessionUsage(agentsRoot, () => {});
	assert(summary !== null && summary.rows === 1, `reconcile recovers exactly the unmatched turn (got ${summary?.rows})`);
	const afterImport = loadUsage();
	assert(afterImport.length === 8, "one recovered row appended");
	const imported = afterImport.find((r) => r.input === 777);
	assert(imported?.kind === "cli", "cli thread imports as kind cli");
	assert(imported?.provider === "openai-codex", "import carries the thread's provider");
	const rerun = importHistoricalSessionUsage(agentsRoot, () => {});
	assert(rerun !== null && rerun.rows === 0, "re-running reconciliation imports nothing (dedupe)");
	assert(loadUsage().length === 8, "no rows duplicated by a re-run");

	// A truncated append must cost one row, not blank the ledger.
	const ledgerFile = path.join(tempHome, ".exxperts", "app", "usage.jsonl");
	fs.appendFileSync(ledgerFile, '{"ts":123,"agent":"room-a","persona":"business","inp');
	assert(loadUsage().length === 8, "damaged trailing line is skipped, ledger stays readable");
	fs.appendFileSync(ledgerFile, "\n");

	// --- /api/usage aggregation over the ledger ----------------------------
	const handlers = new Map<string, (req: unknown, reply?: unknown) => Promise<any>>();
	const fakeApp = { get: (route: string, handler: (req: unknown, reply?: unknown) => Promise<any>) => handlers.set(route, handler) };
	// The live gateway's price today: 1000 in x $2 + 100 out x $10 + 500 cache
	// reads x $0.2 per million is $0.0031 for the turn recorded at zero.
	const fooPrice = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
	const fooEstimate = (1000 * 2 + 100 * 10 + 500 * 0.2) / 1_000_000;
	registerUsageApi(fakeApp as any, {
		findModel: (provider, modelId) => {
			if (provider === "openai-codex" && modelGroupOf({ model: modelId }).key === "gpt-5.5") return { cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 6 } };
			if (provider === "gateway-foo" && modelId === "foo-large") return { cost: fooPrice };
			return undefined;
		},
		liveAgents: () => new Map([["room-a", "Room A"]]),
		providerDisplayName: (providerId) => (providerId === "gateway-foo" ? "Foo Gateway" : undefined),
	});
	const usage = await handlers.get("/api/usage")!({ query: {} });
	assert(usage.totals.turns === 8, "all rows aggregated");
	// The anthropic row's stored cost plus the live gateway's read-time estimate.
	assert(Math.abs(usage.totals.cost.billed - (0.02 + fooEstimate)) < 1e-9, `billed = stored api_key cost + estimate for the zero-cost gateway turn (got ${usage.totals.cost.billed})`);
	// Labeled ChatGPT row + imported openai-codex row are plan (OAuth-only channel).
	assert(Math.abs(usage.totals.cost.plan - 0.065) < 1e-9, `plan split (got ${usage.totals.cost.plan})`);
	assert(Math.abs(usage.totals.cost.unattributed - 0.03) < 1e-9, "label-less row stays unattributed");
	assert(usage.totals.cacheSavedEst > 0, "cache savings estimated where prices are known");
	// A zero-cost turn that moved tokens is priced at today's rate when the
	// model has one, and counted as unpriced when it does not; a zero-cost turn
	// that moved nothing is just an empty turn, neither.
	assert(usage.totals.estimatedTurns === 1, `exactly the zero-cost row with a price on file today is estimated, got ${usage.totals.estimatedTurns}`);
	assert(usage.totals.unpricedTurns === 2, `the two zero-cost rows nothing prices are unpriced, got ${usage.totals.unpricedTurns}`);
	const gatewaySource = usage.sources.find((s: any) => s.source === "billed" && s.name === "OpenAI-compatible gateway");
	assert(gatewaySource && gatewaySource.turns === 2 && gatewaySource.cost === 0 && gatewaySource.unpricedTurns === 1 && gatewaySource.estimatedTurns === 0, `the legacy gateway source carries its unpriced count, got ${JSON.stringify(gatewaySource)}`);
	// A live gateway's source row is named by the name its owner gave it and
	// carries the estimate; a removed gateway says so instead of showing its slug.
	const fooSource = usage.sources.find((s: any) => s.source === "billed" && s.name === "Foo Gateway");
	assert(fooSource && fooSource.turns === 1 && Math.abs(fooSource.cost - fooEstimate) < 1e-9 && fooSource.estimatedTurns === 1 && fooSource.unpricedTurns === 0, `the live gateway source is labeled and priced at today's rate, got ${JSON.stringify(fooSource)}`);
	const oldSource = usage.sources.find((s: any) => s.source === "billed" && s.name === "Removed gateway (gateway-old)");
	assert(oldSource && oldSource.turns === 1 && oldSource.cost === 0 && oldSource.unpricedTurns === 1, `a gateway nothing answers for reads as removed, got ${JSON.stringify(usage.sources.map((s: any) => s.name))}`);
	const anthropicSource = usage.sources.find((s: any) => s.source === "billed" && s.name === "Claude");
	assert(anthropicSource && Math.abs(anthropicSource.cost - 0.02) < 1e-9 && anthropicSource.unpricedTurns === 0 && anthropicSource.estimatedTurns === 0, `a stored-cost source stays exact, got ${JSON.stringify(anthropicSource)}`);
	const gpt = usage.byModel.find((m: any) => m.id === "gpt-5.5");
	assert(gpt && gpt.turns === 3, "canonical model group spans eras");
	const fooModel = usage.byModel.find((m: any) => m.id === modelGroupOf({ model: "foo-large", provider: "gateway-foo" }).key);
	assert(fooModel && Math.abs(fooModel.cost - fooEstimate) < 1e-9 && fooModel.estimatedTurns === 1, `the estimate lands on the model row, got ${JSON.stringify(fooModel)}`);
	const roomA = usage.byAgent.find((a: any) => a.agent === "room-a");
	assert(roomA && roomA.retired === false, "live room not marked retired");
	assert(usage.agentNames["room-a"] === "Room A", "live room display name exposed for the Wallet");
	assert(roomA.kinds.cli?.turns === 1 && roomA.kinds.scheduled?.turns === 1, "kind split per agent");
	const roomB = usage.byAgent.find((a: any) => a.agent === "room-b");
	assert(roomB && Math.abs(roomB.cost - fooEstimate) < 1e-9 && roomB.estimatedTurns === 1 && roomB.unpricedTurns === 1, `the estimate lands on the room row with its counts, got ${JSON.stringify(roomB)}`);
	assert(roomB.kinds.chat?.estimatedTurns === 1 && roomB.kinds.chat?.unpricedTurns === 1, `the room's kind split carries the same counts, got ${JSON.stringify(roomB.kinds)}`);
	assert(Array.isArray(usage.weekHour) && usage.weekHour.length === 7 && usage.weekHour[0].length === 24, "weekHour matrix shape");
	assert(usage.recent.length === 8 && usage.recent[0].ts >= usage.recent[7].ts, "recent newest first");
	const recentFoo = usage.recent.find((r: any) => r.model === "foo-large");
	assert(recentFoo && Math.abs(recentFoo.cost - fooEstimate) < 1e-9 && recentFoo.estimated === true, `the recent row carries the estimate and says so, got ${JSON.stringify(recentFoo)}`);
	const recentUnpriced = usage.recent.find((r: any) => r.model === "gateway-model" && r.input === 400);
	assert(recentUnpriced && recentUnpriced.cost === 0 && recentUnpriced.estimated === false, "a row nothing prices stays at zero and is not an estimate");
	const recentStored = usage.recent.find((r: any) => r.model === "claude-opus-4-8");
	assert(recentStored && recentStored.cost === 0.02 && recentStored.estimated === false, "a stored cost is passed through exact");
	// The bucket the estimated turn fell into carries the money on the billed layer.
	const billedInSeries = usage.series.buckets.reduce((sum: number, b: any) => sum + b.billed, 0);
	assert(Math.abs(billedInSeries - (0.02 + fooEstimate)) < 1e-9, `the activity series prices zero rows the same way, got ${billedInSeries}`);

	const scoped = await handlers.get("/api/usage")!({ query: { range: "7d", model: "gpt-5.5" } });
	assert(scoped.previous !== null, "bounded range returns a previous window");
	assert(scoped.totals.turns === 2, "range+model scoping applies (7d gpt-5.5)");

	// --- CSV export ---------------------------------------------------------
	const replyHeaders: Record<string, string> = {};
	const csv = await handlers.get("/api/usage/export.csv")!({}, { header: (k: string, v: string) => { replyHeaders[k] = v; } });
	const lines = String(csv).trim().split("\n");
	assert(lines.length === 9 && lines[0].startsWith("ts,iso,agent"), "csv has header plus one line per row");
	assert(replyHeaders["content-disposition"]?.includes("exxperts-usage.csv"), "csv download disposition");
	// The export carries the same effective cost the wallet shows, and says
	// per row whether it was stored at the turn, priced today, or never.
	const columns = lines[0].split(",");
	const col = (line: string, name: string) => line.split(",")[columns.indexOf(name)];
	const csvFoo = lines.find((line) => col(line, "model") === "foo-large");
	assert(csvFoo && col(csvFoo, "priced_at") === "today" && Math.abs(Number(col(csvFoo, "cost_est_usd")) - fooEstimate) < 1e-9, `csv prices the zero-cost gateway row today, got ${csvFoo}`);
	const csvUnpriced = lines.find((line) => col(line, "model") === "gateway-model" && col(line, "input") === "400");
	assert(csvUnpriced && col(csvUnpriced, "priced_at") === "none" && col(csvUnpriced, "cost_est_usd") === "0", `csv marks the row nothing prices as none, got ${csvUnpriced}`);
	const csvStored = lines.find((line) => col(line, "model") === "claude-opus-4-8");
	assert(csvStored && col(csvStored, "priced_at") === "turn" && col(csvStored, "cost_est_usd") === "0.02", `csv keeps a stored cost as the turn's own, got ${csvStored}`);

	// --- the import at the next start writes no row for a call that brought no answer and moved nothing ---
	// A failed attempt, a stopped one and an empty answer (a proxy's HTML page): the live path writes none,
	// so the import must not either. A failed call that moved tokens was paid, and is a row.
	const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
	const failedDir = path.join(agentsRoot, "room-failed", "runtime", "pi-sessions");
	fs.mkdirSync(failedDir, { recursive: true });
	fs.writeFileSync(
		path.join(failedDir, "c_failed.jsonl"),
		[
			JSON.stringify({ type: "session", version: 3, id: "s9", timestamp: iso(now - 3 * day), cwd: "/tmp" }),
			JSON.stringify({ type: "model_change", id: "m9", parentId: null, timestamp: iso(now - 3 * day), provider: "anthropic", modelId: "claude-haiku-5-5" }),
			JSON.stringify({ id: "f1", parentId: "m9", timestamp: iso(now - 3 * day + 1000), message: { role: "assistant", stopReason: "error", errorMessage: "529 overloaded", content: [], usage: zero } }),
			JSON.stringify({ id: "f2", parentId: "f1", timestamp: iso(now - 3 * day + 2000), message: { role: "assistant", stopReason: "aborted", content: [], usage: zero } }),
			JSON.stringify({ id: "f3", parentId: "f2", timestamp: iso(now - 3 * day + 3000), message: { role: "assistant", stopReason: "stop", content: [], usage: zero } }),
			JSON.stringify({ id: "f4", parentId: "f3", timestamp: iso(now - 3 * day + 4000), message: { role: "assistant", stopReason: "error", errorMessage: "terminated", content: [{ type: "text", text: "Half an" }], usage: { input: 900, output: 4, cacheRead: 0, cacheWrite: 0, cost: { total: 0.003 } } } }),
		].join("\n") + "\n",
	);
	const restarted = importHistoricalSessionUsage(agentsRoot, () => {});
	const failedRows = loadUsage().filter((row) => row.agent === "room-failed");
	assert(restarted?.rows === 1 && failedRows.length === 1 && failedRows[0].input === 900, `after a restart, only the paid failed call is a row, got ${restarted?.rows} imported: ${JSON.stringify(failedRows)}`);

	// --- a gateway's model is the real model behind it, whatever it was saved as ---
	// Rows as the ledger has always written them: the gateway's name before the
	// dash, the saved model name after it. The dash is the label's own separator
	// (splitProviderLabel in model-names.ts), spelled as its code point.
	const label = (gateway: string, model: string) => `${gateway} \u2014 ${model}`;
	const named = { agent: "room-names", persona: "business", authType: "api_key" as const, cacheRead: 0, cacheWrite: 0 };
	// One gateway saves "Fast" for two models, a second gateway saves "Fast" for a
	// third model and for one of the first gateway's, and a gateway saves a known
	// family's model under a name of its own.
	appendUsage({ ...named, ts: now - day, model: "kimi-k2.5", modelLabel: label("Work", "Fast"), provider: "gateway-work", input: 10, output: 1, cost: 0.4 });
	appendUsage({ ...named, ts: now - day, model: "kimi-k2.5", modelLabel: label("Work", "Fast"), provider: "gateway-work", input: 20, output: 2, cost: 0.1 });
	appendUsage({ ...named, ts: now - day, model: "glm-4.6", modelLabel: label("Work", "Fast"), provider: "gateway-work", input: 30, output: 3, cost: 0.07 });
	appendUsage({ ...named, ts: now - day, model: "glm-4.6", modelLabel: label("Home", "Fast"), provider: "gateway-home", input: 40, output: 4, cost: 0.02 });
	appendUsage({ ...named, ts: now - day, model: "deepseek.v3.2", modelLabel: label("Home", "Fast"), provider: "gateway-home", input: 50, output: 5, cost: 0.03 });
	appendUsage({ ...named, ts: now - day, model: "claude-opus-4.8", modelLabel: label("Work", "Opus"), provider: "gateway-work", input: 1, output: 1, cost: 0.01 });
	// A Bedrock gateway's region copies of one model are that model.
	appendUsage({ ...named, ts: now - day, model: "eu.anthropic.claude-sonnet-4-5-20250929-v1:0", modelLabel: label("Bedrock", "Sonnet EU"), provider: "gateway-bedrock", input: 1, output: 1, cost: 0.01 });
	appendUsage({ ...named, ts: now - day, model: "anthropic.claude-sonnet-4-5-20250929-v1:0", modelLabel: label("Bedrock", "anthropic.claude-sonnet-4-5-20250929-v1:0"), provider: "gateway-bedrock", input: 1, output: 1, cost: 0.01 });
	appendUsage({ ...named, ts: now - day, model: "anthropic.claude-opus-4-6-v1", modelLabel: label("Bedrock", "Claude Opus 4.6"), provider: "gateway-bedrock", input: 1, output: 1, cost: 0.01 });
	appendUsage({ ...named, ts: now - day, model: "au.anthropic.claude-opus-4-6-v1", modelLabel: label("Bedrock", "Opus AU"), provider: "gateway-bedrock", input: 1, output: 1, cost: 0.01 });
	appendUsage({ ...named, ts: now - day, model: "claude-opus-4-6", provider: "anthropic", input: 1, output: 1, cost: 0.01 });
	// A known family through two providers, and a dated snapshot beside its undated name.
	appendUsage({ ...named, ts: now - day, model: "claude-opus-4.8", modelLabel: label("GitHub Copilot", "Claude Opus 4.8"), provider: "github-copilot", authType: "oauth", input: 1, output: 1, cost: 0.01 });
	appendUsage({ ...named, ts: now - day, model: "claude-sonnet-4-5-20250929", provider: "anthropic", input: 1, output: 1, cost: 0.01 });
	appendUsage({ ...named, ts: now - day, model: "claude-sonnet-4-5", provider: "anthropic", input: 1, output: 1, cost: 0.01 });
	const byName = await handlers.get("/api/usage")!({ query: {} });
	const labels = JSON.stringify(byName.byModel.map((m: any) => m.label));
	const modelNamed = (name: string) => byName.byModel.filter((m: any) => m.label === name);
	const filterNamed = (name: string) => byName.models.filter((m: any) => m.label === name);
	assert(modelNamed("Fast").length === 0 && filterNamed("Fast").length === 0 && modelNamed("Opus").length === 0, `no model reads as a name a gateway saved, got ${labels}`);
	for (const [name, turns, tokens, cost, models] of [["Kimi K2.5", 2, 33, 0.5, ["kimi-k2.5"]], ["GLM 4.6", 2, 77, 0.09, ["glm-4.6"]], ["DeepSeek V3.2", 1, 55, 0.03, ["deepseek.v3.2"]]] as const) {
		const row = modelNamed(name);
		assert(row.length === 1 && row[0].turns === turns && row[0].tokens === tokens && Math.abs(row[0].cost - cost) < 1e-9, `${name} keeps its own turns, tokens and cost, got ${JSON.stringify(row)} among ${labels}`);
		const filter = filterNamed(name);
		assert(filter.length === 1 && filter[0].turns === turns, `the model filter offers ${name} once with its own turns, got ${JSON.stringify(byName.models)}`);
		const scopedByName = await handlers.get("/api/usage")!({ query: { model: filter[0].id } });
		assert(scopedByName.model === filter[0].id && scopedByName.totals.turns === turns && scopedByName.recent.every((r: any) => (models as readonly string[]).includes(r.model)), `filtering on ${name} shows only its own turns, got ${scopedByName.totals.turns}`);
	}
	const opus = modelNamed("Claude Opus 4.8");
	assert(opus.length === 1 && opus[0].turns === 3, `a known family is one model through a key, a sign-in and a gateway, got ${JSON.stringify(opus)} among ${labels}`);
	assert(modelNamed("Claude Sonnet 4.5 (29 Sep 2025)").length === 1 && modelNamed("Claude Sonnet 4.5").length === 1, `a dated snapshot reads with its date beside its undated name, got ${labels}`);
	assert(modelNamed("Claude Sonnet 4.5 (29 Sep 2025)")[0].turns === 3 && modelNamed("Sonnet EU").length === 0, `a Bedrock gateway's region copies join the dated snapshot's row, got ${labels}`);
	assert(modelNamed("Claude Opus 4.6").length === 1 && modelNamed("Claude Opus 4.6")[0].turns === 3, `Bedrock's Opus 4.6 ids join the Claude key's row, got ${labels}`);
	// Recent turns name each turn's model as the Wallet's rows do.
	const recentKimi = byName.recent.find((r: any) => r.model === "kimi-k2.5");
	const recentSonnet = byName.recent.find((r: any) => r.model === "eu.anthropic.claude-sonnet-4-5-20250929-v1:0");
	assert(recentKimi?.modelName === "Kimi K2.5" && recentSonnet?.modelName === "Claude Sonnet 4.5", `a recent turn carries its Wallet model name, got ${recentKimi?.modelName} and ${recentSonnet?.modelName}`);

	// --- a start reads only the session files that changed since they were reconciled ---
	const reconciledFile = path.join(tempHome, ".exxperts", "app", "usage-reconciled.json");
	const realRead = fs.readFileSync;
	let sessionReads: string[] = [];
	fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
		if (String(file).includes("pi-sessions")) sessionReads.push(path.basename(String(file)));
		return (realRead as (...args: unknown[]) => unknown)(file, ...rest);
	}) as typeof fs.readFileSync;
	const start = () => {
		sessionReads = [];
		const result = importHistoricalSessionUsage(agentsRoot, () => {});
		return { rows: result?.rows, reads: [...sessionReads].sort() };
	};
	const everyFile = ["c_failed.jsonl", "c_thread1.jsonl", "cli_thread2.jsonl"];
	const said = (value: unknown) => JSON.stringify(value);
	const assistant = (id: string, ts: number, input: number, output: number, cacheRead = 0) => JSON.stringify({ id, parentId: "m1", timestamp: iso(ts), message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "An answer." }], usage: { input, output, cacheRead, cacheWrite: 0, cost: { total: 0.001 } } } }) + "\n";
	const chatFile = path.join(sessionsDir, "c_thread1.jsonl");
	const cliFile = path.join(sessionsDir, "cli_thread2.jsonl");
	const rowsWith = (input: number) => loadUsage().filter((row) => row.input === input);
	const walletBefore = said((await handlers.get("/api/usage")!({ query: {} })).totals);

	start();
	const quiet = start();
	assert(quiet.rows === 0 && quiet.reads.length === 0, `a start with no session file changed reads none, got ${said(quiet)}`);
	assert(said((await handlers.get("/api/usage")!({ query: {} })).totals) === walletBefore, "the Wallet's totals stay the same across starts on an unchanged ledger");

	// A CLI turn written straight to its session file: that file alone is read, and its row comes back once.
	fs.appendFileSync(cliFile, assistant("cli-new", now - 1000, 1501, 11));
	const afterCli = start();
	assert(afterCli.rows === 1 && said(afterCli.reads) === said(["cli_thread2.jsonl"]), `a changed file is read again, and only that one, got ${said(afterCli)}`);
	assert(rowsWith(1501).length === 1 && rowsWith(1501)[0].kind === "cli", `the CLI turn reaches the ledger, got ${said(rowsWith(1501))}`);
	assert(said(start()) === said({ rows: 0, reads: [] }), "a rerun after a CLI turn reads nothing and adds nothing");

	// A chat turn whose row a crash dropped, with the same tokens as a turn another file already accounts for: it has a row of its own.
	fs.appendFileSync(chatFile, assistant("chat-new", now - 900, 1501, 11));
	const afterChat = start();
	assert(afterChat.rows === 1 && said(afterChat.reads) === said(["c_thread1.jsonl"]) && rowsWith(1501).length === 2, `a turn a crash dropped comes back, its tokens matching an older file's turn, got ${said(afterChat)} and ${said(rowsWith(1501))}`);
	assert(rowsWith(1501).filter((row) => row.kind === "chat").length === 1, "the dropped turn comes back as a chat row");
	assert(said(start()) === said({ rows: 0, reads: [] }), "a rerun after a dropped turn reads nothing and adds nothing");

	// A live turn with its row on the ledger: its file is read, and nothing is added.
	fs.appendFileSync(chatFile, assistant("chat-live", now - 800, 1601, 12));
	appendUsage({ ts: now - 800, agent: "room-a", persona: "business", model: "gpt-5.5", kind: "chat", input: 1601, output: 12, cacheRead: 0, cacheWrite: 0, cost: 0.001 });
	const afterLive = start();
	assert(afterLive.rows === 0 && rowsWith(1601).length === 1, `a turn that has its row is not counted again, got ${said(afterLive)}`);

	// --- what records the reconciled state survives a kill ---
	const whole = realRead(reconciledFile, "utf-8");
	const ledgerRows = loadUsage().length;
	for (const [what, damage] of [
		["missing", () => fs.rmSync(reconciledFile)],
		["torn", () => fs.writeFileSync(reconciledFile, whole.slice(0, Math.floor(whole.length / 2)))],
		["empty", () => fs.writeFileSync(reconciledFile, "")],
		["of another shape", () => fs.writeFileSync(reconciledFile, '{"files":{"room-a/c_thread1.jsonl":{"size":"big"},"room-a/cli_thread2.jsonl":7}}')],
	] as const) {
		damage();
		const reread = start();
		assert(reread.rows === 0 && said(reread.reads) === said(everyFile) && loadUsage().length === ledgerRows, `a record ${what} means the files are read again and no row is lost or doubled, got ${said(reread)} and ${loadUsage().length} rows`);
		assert(said(start()) === said({ rows: 0, reads: [] }), `the start after a record ${what} reads nothing`);
	}

	// A kill after the rows but before the record: the file is read again and its row is not doubled.
	const beforeTurn = realRead(reconciledFile, "utf-8");
	fs.appendFileSync(chatFile, assistant("chat-kill", now - 700, 1701, 13));
	assert(start().rows === 1, "the turn before the kill is imported");
	fs.writeFileSync(reconciledFile, beforeTurn);
	const afterKill = start();
	assert(afterKill.rows === 0 && said(afterKill.reads) === said(["c_thread1.jsonl"]) && rowsWith(1701).length === 1, `a kill before the record doubles nothing, got ${said(afterKill)} and ${said(rowsWith(1701))}`);

	// A kill in the middle of a row: the torn row comes back, and the row written after it is not lost with it.
	const cleanRecord = realRead(reconciledFile, "utf-8");
	fs.appendFileSync(chatFile, assistant("chat-torn-1", now - 600, 1801, 14) + assistant("chat-torn-2", now - 500, 1802, 14));
	assert(start().rows === 2, "the two turns before the kill are imported");
	fs.writeFileSync(reconciledFile, cleanRecord);
	fs.truncateSync(ledgerFile, fs.statSync(ledgerFile).size - 25);
	const afterTorn = start();
	assert(afterTorn.rows === 1 && rowsWith(1801).length === 1 && rowsWith(1802).length === 1, `a torn row comes back once and its neighbour stays, got ${said(afterTorn)}, ${said(rowsWith(1801))} and ${said(rowsWith(1802))}`);
	assert(said(start()) === said({ rows: 0, reads: [] }), "the start after a torn row reads nothing and adds nothing");

	// A row that could not be written: the file stays unreconciled, so the next start brings the row back.
	const realAppend = fs.appendFileSync;
	fs.appendFileSync(chatFile, assistant("chat-full-disk", now - 400, 1901, 15));
	fs.appendFileSync = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
		if (String(file) === ledgerFile) throw new Error("no space left on the disk");
		return (realAppend as (...args: unknown[]) => unknown)(file, ...rest);
	}) as typeof fs.appendFileSync;
	start();
	fs.appendFileSync = realAppend;
	assert(rowsWith(1901).length === 0, "control: the row was not written");
	const afterFullDisk = start();
	assert(afterFullDisk.rows === 1 && rowsWith(1901).length === 1, `a row that could not be written comes back at the next start, got ${said(afterFullDisk)}`);

	// A ledger that lost rows the record accounts for: the room's files are read and the rows come back.
	const ledgerLines = realRead(ledgerFile, "utf-8").split("\n");
	fs.writeFileSync(ledgerFile, ledgerLines.filter((line) => !line.includes('"input":1701,')).join("\n"));
	assert(rowsWith(1701).length === 0, "control: the ledger lost the row");
	const afterLoss = start();
	assert(afterLoss.rows === 1 && rowsWith(1701).length === 1 && afterLoss.reads.includes("cli_thread2.jsonl") && !afterLoss.reads.includes("c_failed.jsonl"), `a row the ledger lost comes back, reading that room's files alone, got ${said(afterLoss)}`);
	fs.readFileSync = realRead;

	// --- a scheduled run writes its usage when it ends, and the import never counts it twice ---
	// The stand-in model: each leg of a run's prompt spends its own tokens and calls a tool nobody has, then the last leg
	// answers or never ends. The run is cut there, by the time limit or the stop, once the model is seen waiting.
	const LEG_TOKENS = [{ prompt_tokens: 2100, completion_tokens: 21 }, { prompt_tokens: 2200, completion_tokens: 22 }];
	let served = 0;
	let atLastLeg = () => {};
	const sse = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
	const gateway = http.createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			const parsed = JSON.parse(body) as { model?: string; messages?: { role?: string; content?: unknown }[] };
			const asked = JSON.stringify(parsed.messages ?? []);
			// The legs of this try: a run that runs again holds the first try's tool results before its prompt.
			const roles = (parsed.messages ?? []).map((message) => message.role);
			const leg = roles.slice(roles.lastIndexOf("user")).filter((role) => role === "tool").length;
			const legs = asked.includes("no-tokens") ? 0 : LEG_TOKENS.length;
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			const base = { id: "cmpl", object: "chat.completion.chunk", created: 1, model: String(parsed.model) };
			const finish = (reason: string, usage: { prompt_tokens: number; completion_tokens: number }) => {
				res.write(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: reason }], usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } }));
				res.end("data: [DONE]\n\n");
			};
			if (leg < legs) {
				served += 1;
				res.write(sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${leg}`, type: "function", function: { name: "no_such_tool", arguments: "{}" } }] }, finish_reason: null }] }));
				return finish("tool_calls", LEG_TOKENS[leg]);
			}
			if (asked.includes("finishes")) {
				served += 1;
				res.write(sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Done." }, finish_reason: null }] }));
				return finish("stop", { prompt_tokens: 2300, completion_tokens: 23 });
			}
			res.flushHeaders();
			atLastLeg();
		});
	});
	await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
	try {
		const agentDir = process.env.EXXPERTS_CODING_AGENT_DIR!;
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "openai-compatible": { name: "Stand-in", baseUrl: `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1`, api: "openai-completions", models: [{ id: "stand-in", name: "Stand-in" }] } } }));
		fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-key" } }));
		const appDir = path.join(tempHome, ".exxperts", "app");
		fs.writeFileSync(path.join(appDir, "openai-compatible-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Stand-in", roomModels: [{ modelId: "stand-in" }], maintenanceModel: "stand-in" }));
		fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }));
		const { createPersistentAgentFromScaffoldInput } = await import("../src/persistent-agents.js");
		const { addPersistentRoomScheduleJob } = await import("../../../pi-package/extensions/schedule-prompt/index.js");
		const { createScheduledPromptBackgroundRunPreflight } = await import("../src/scheduled-prompt-runs.js");
		const { processScheduledPromptBackgroundRunExecutionOnce } = await import("../src/scheduled-prompt-background-execution.js");
		const { readBackgroundRun, updateBackgroundRunStatus } = await import("../src/background-runs.js");
		const { installServerStop } = await import("../src/server-stop.js");
		const baseNow = new Date("2026-01-01T00:00:00.000Z");
		const dueNow = new Date("2026-01-01T01:00:00.000Z");
		const makeRun = (name: string, prompt: string) => {
			const roomId = String(createPersistentAgentFromScaffoldInput({ displayName: name, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId);
			const job = addPersistentRoomScheduleJob(roomId, { name, type: "once", schedule: "+30m", prompt, now: baseNow });
			return { roomId, runId: createScheduledPromptBackgroundRunPreflight({ roomId, scheduleJobId: job.id, dueAt: String(job.nextRunAt), now: baseNow }).run.runId };
		};
		const tick = (options: Record<string, unknown> = {}) => processScheduledPromptBackgroundRunExecutionOnce({ workerId: "scheduler-execution:usage-ledger", now: dueNow, limit: 1, leaseMs: 60_000, heartbeatMs: 1_000, ...options });
		// The limit's timer is fired by hand once the model is seen waiting, so the row does not race the run's start.
		const LIMIT_MS = 987_654;
		const cutByLimit = async (options: Record<string, unknown> = {}) => {
			const realTimeout = globalThis.setTimeout;
			let fireLimit = () => {};
			globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
				if (ms === LIMIT_MS) fireLimit = fn;
				return (realTimeout as (...args: unknown[]) => NodeJS.Timeout)(fn, ms, ...rest);
			}) as typeof setTimeout;
			atLastLeg = () => fireLimit();
			try {
				return await tick({ runLimitMs: LIMIT_MS, ...options });
			} finally {
				globalThis.setTimeout = realTimeout;
			}
		};
		const roomRows = (roomId: string) => loadUsage().filter((row) => row.agent === roomId);
		const tokens = (rows: { input: number; output: number }[]) => rows.reduce((sum, row) => sum + row.input + row.output, 0);
		const LEG_SUM = LEG_TOKENS.reduce((sum, leg) => sum + leg.prompt_tokens + leg.completion_tokens, 0);
		const quietStart = () => importHistoricalSessionUsage(agentsRoot, () => {});

		// A finished run of several messages: one row, and the next import adds nothing beside it.
		const finished = makeRun("Finished Run", "finishes after two tool calls");
		const finishedTick = await tick();
		assert(finishedTick.counts.succeeded === 1, `the run finishes, got ${said(finishedTick)}`);
		const finishedRow = roomRows(finished.roomId);
		assert(finishedRow.length === 1 && finishedRow[0].runId === finished.runId && finishedRow[0].input === 6600, `a finished run writes one row of all its messages, got ${said(finishedRow)}`);
		quietStart();
		assert(said(roomRows(finished.roomId)) === said(finishedRow), `the import adds nothing beside a finished run's row, got ${said(roomRows(finished.roomId))}`);

		// Cut by the time limit: the row is there when the run ends, and the import counts nothing again.
		const limited = makeRun("Limited Run", "runs until it is cut");
		const limitTick = await cutByLimit();
		assert(limitTick.processed[0]?.finalStatus === "failed" && limitTick.processed[0]?.reason === "time_limit", `the limit ends the run, got ${said(limitTick.processed)}`);
		const limitRows = roomRows(limited.roomId);
		assert(limitRows.length === 1 && limitRows[0].kind === "scheduled" && limitRows[0].runId === limited.runId && tokens(limitRows) === LEG_SUM && limitRows[0].model === "stand-in" && limitRows[0].provider === "openai-compatible", `a run cut by the limit writes its usage when it ends, got ${said(limitRows)}`);
		quietStart();
		assert(said(roomRows(limited.roomId)) === said(limitRows), `the next import never bills a cut run twice, got ${said(roomRows(limited.roomId))}`);

		// The same run again, cut again: its one row stays, and what the second try spent is counted once, by the import.
		const servedBefore = served;
		const limitRecord = readBackgroundRun(limited.runId);
		updateBackgroundRunStatus(limited.runId, "deferred", { reason: "lease_expired", target: limitRecord.target, artifacts: limitRecord.artifacts, now: dueNow });
		await cutByLimit({ now: new Date(dueNow.getTime() + 60_000) });
		assert(served === servedBefore + LEG_TOKENS.length, `control: the run ran again, served ${served - servedBefore} legs`);
		assert(roomRows(limited.roomId).filter((row) => row.runId === limited.runId).length === 1, `a re-run never writes the run's row twice, got ${said(roomRows(limited.roomId))}`);
		quietStart();
		quietStart();
		assert(tokens(roomRows(limited.roomId)) === 2 * LEG_SUM, `each try is billed once, got ${said(roomRows(limited.roomId))}`);

		// Cut before the model moved a token: no row, then or at the next import.
		const empty = makeRun("Empty Cut Run", "no-tokens: runs until it is cut");
		const emptyTick = await cutByLimit();
		assert(emptyTick.processed[0]?.reason === "time_limit", `the limit ends the empty run, got ${said(emptyTick.processed)}`);
		assert(roomRows(empty.roomId).length === 0, `a cut run with no tokens moved writes no row, got ${said(roomRows(empty.roomId))}`);
		quietStart();
		assert(roomRows(empty.roomId).length === 0, `nor does the next import, got ${said(roomRows(empty.roomId))}`);

		// Cut by a server stop, in this process as index.ts installs it, while something the cut cannot reach (a tool's slow
		// page) holds the turn past the stop's ceiling, so the server exits first. Last, since the stop stays installed.
		const stopped = makeRun("Stopped Run", "runs until the server stops");
		let ticking = true;
		let rowsAtExit: UsageRow[] | undefined;
		const realExit = process.exit;
		const runtime = (await import("@exxeta/exxperts-runtime")) as unknown as { AgentSession: { prototype: { prompt: (this: unknown, text: string, options?: unknown) => Promise<void> } } };
		const realPrompt = runtime.AgentSession.prototype.prompt;
		let letGo = () => {};
		const held = new Promise<void>((resolve) => { letGo = resolve; });
		runtime.AgentSession.prototype.prompt = async function (this: unknown, text: string, options?: unknown) {
			await realPrompt.call(this, text, options);
			await held;
		};
		process.exit = (() => {
			process.emit("exit", 0);
			rowsAtExit = roomRows(stopped.roomId);
			letGo();
		}) as typeof process.exit;
		try {
			installServerStop({
				app: { close: async () => {}, server: { closeAllConnections: () => {} } } as unknown as Parameters<typeof installServerStop>[0]["app"],
				sharedServer: false,
				waitSeconds: () => 0,
				turnsRunning: () => 0,
				specialistTasksRunning: () => 0,
				abortSpecialistTasks: () => {},
				schedulerTickRunning: () => ticking,
				stopLoops: () => {},
			});
			atLastLeg = () => process.emit("SIGTERM", "SIGTERM");
			const stopTick = await tick();
			ticking = false;
			assert(rowsAtExit?.length === 1 && rowsAtExit[0].runId === stopped.runId && tokens(rowsAtExit) === LEG_SUM, `a run cut by a server stop has its row in the ledger when the server exits, got ${said(rowsAtExit)}`);
			// Let go after the exit, the run still ends as the stop's, and nothing writes its usage again.
			assert(stopTick.processed[0]?.finalStatus === "cancelled" && stopTick.processed[0]?.reason === "server_stopped", `the stop ends the run, got ${said(stopTick.processed)}`);
			assert(said(roomRows(stopped.roomId)) === said(rowsAtExit), `the run's end writes no second row, got ${said(roomRows(stopped.roomId))}`);
			quietStart();
			assert(said(roomRows(stopped.roomId)) === said(rowsAtExit), `the next import never bills a stopped run twice, got ${said(roomRows(stopped.roomId))}`);
		} finally {
			process.exit = realExit;
			runtime.AgentSession.prototype.prompt = realPrompt;
		}
	} finally {
		(gateway as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
		gateway.close();
	}

	console.log("usage ledger smoke passed");
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}
