import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-usage-ledger-"));
const tempHome = path.join(tmp, "home");
fs.mkdirSync(tempHome, { recursive: true, mode: 0o700 });

process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = path.join(tempHome, ".exxperts", "agent");

try {
	const { appendUsage, loadUsage } = await import("../src/usage-log.js");
	const { importHistoricalSessionUsage } = await import("../src/usage-import.js");
	const { modelGroupOf, registerUsageApi } = await import("../src/usage-api.js");

	// --- canonical model grouping (spec: model-names.ts) merges raw-id variants
	assert(modelGroupOf({ model: "claude-opus-4-8" }).key === modelGroupOf({ model: "claude-opus-4.8" }).key, "raw-id variants share a group");
	assert(modelGroupOf({ model: "claude-opus-4-8" }).name === "Claude Opus 4.8", "group renders the canonical name");
	assert(modelGroupOf({ model: "gpt-5.5" }).key === modelGroupOf({ model: "gpt-5.5", modelLabel: "ChatGPT Plus/Pro — GPT-5.5" }).key, "label eras share a group");

	// --- ledger append + chronological load --------------------------------
	const now = Date.now();
	const day = 24 * 3600 * 1000;
	appendUsage({ ts: now - day, agent: "room-a", persona: "business", model: "gpt-5.5", modelLabel: "ChatGPT Plus/Pro — GPT-5.5", input: 100, output: 10, cacheRead: 50, cacheWrite: 0, cost: 0.01 });
	appendUsage({ ts: now, agent: "room-a", persona: "business", model: "claude-opus-4-8", provider: "anthropic", authType: "api_key", kind: "scheduled", input: 200, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.02 });
	appendUsage({ ts: now - 10 * day, agent: "room-a", persona: "business", model: "gpt-5.5", input: 300, output: 30, cacheRead: 0, cacheWrite: 0, cost: 0.03 });
	// Gateway turns on API keys, all recorded at zero. On the legacy gateway: one
	// that moved tokens on a model nothing prices even today, one that moved
	// none at all (an aborted turn: nothing to price). On a live gateway whose
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
	const anthropicSource = usage.sources.find((s: any) => s.source === "billed" && s.name === "Anthropic / Claude");
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

	console.log("usage ledger smoke passed");
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}
