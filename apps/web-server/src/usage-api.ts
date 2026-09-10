/**
 * Wallet aggregations over the local usage ledger.
 *
 * The ledger's `cost` is always tokens x public API list price — honest as a
 * measure of usage, fiction as a bill when the turn rode a subscription. The
 * API therefore never returns one blended "cost": every aggregate is split by
 * source (billed / plan / unattributed) so the UI can say which dollars are
 * real, which are covered by plans, and which are too old to attribute.
 *
 * A row stored at zero that moved tokens is priced on the way out, at the
 * price on file today, and reported as an estimate (priceRow). The ledger
 * itself is never rewritten.
 */

import type { FastifyInstance } from "fastify";
import { canonicalModelName } from "../../web-ui/src/model-names.js";
import { GATEWAY_PROVIDER_ID_PREFIX } from "./openai-compatible-gateways.js";
import { loadUsage } from "./usage-log.js";
import type { UsageRow } from "./usage-log.js";

export type UsageSource = "billed" | "plan" | "unattributed";

/** Subscription-only OAuth channels: rows from these are plan usage even without authType. */
const OAUTH_ONLY_PROVIDERS = new Set(["openai-codex", "github-copilot"]);

/** Reverse of the curated web-chat provider labels, for rows that only carry a label. */
const PROVIDER_BY_LABEL_PREFIX: Record<string, string> = {
	"ChatGPT Plus/Pro": "openai-codex",
	"OpenAI / ChatGPT subscription": "openai-codex",
	"GitHub Copilot": "github-copilot",
	"Anthropic / Claude": "anthropic",
	OpenAI: "openai",
	"OpenAI-compatible gateway": "openai-compatible",
	"Google / Gemini": "google",
	OpenRouter: "openrouter",
};

const SOURCE_DISPLAY: Record<string, string> = {
	"openai-codex": "ChatGPT Plus/Pro",
	"github-copilot": "GitHub Copilot",
	anthropic: "Anthropic / Claude",
	openai: "OpenAI",
	"openai-compatible": "OpenAI-compatible gateway",
	google: "Google / Gemini",
	openrouter: "OpenRouter",
};

// Grouping builds on the shared naming module: two rows are the same model
// iff they display as the same canonical name (model-names.ts is the spec).
// Cached because every request keys thousands of rows.
const modelGroupCache = new Map<string, { key: string; name: string }>();
export function modelGroupOf(row: { model?: string; modelLabel?: string; provider?: string }): { key: string; name: string } {
	const cacheKey = (row.model ?? "") + "|" + (row.modelLabel ?? "") + "|" + (row.provider ?? "");
	let group = modelGroupCache.get(cacheKey);
	if (!group) {
		const name = canonicalModelName(row).name || (row.model ?? "");
		group = { key: name.toLowerCase(), name };
		modelGroupCache.set(cacheKey, group);
	}
	return group;
}

/** A model's price in USD per million tokens, the runtime's own unit. */
export type UsagePrice = { input: number; output: number; cacheRead: number; cacheWrite: number };

export interface UsageApiDeps {
	/** Resolve a runtime model for price lookups; undefined when unknown. */
	findModel: (provider: string, modelId: string) => { cost?: UsagePrice } | undefined;
	/** Rooms that currently exist (non-archived): id → current display name. */
	liveAgents: () => Map<string, string>;
	/**
	 * The name a provider goes by today (a gateway carries the name the person
	 * gave it); undefined when nothing is registered under the id any more.
	 */
	providerDisplayName: (providerId: string) => string | undefined;
}

/**
 * Where a row's money came from. "turn" is the cost the ledger stored when
 * the turn ran; "today" is tokens x the price on file now, for a turn that
 * ran before its model had a price; "none" is a turn that moved tokens and
 * still has no price anywhere.
 */
export type PricedAt = "turn" | "today" | "none";

function tokensOf(row: UsageRow): number {
	return row.input + row.output + row.cacheRead + (row.cacheWrite || 0);
}

/**
 * A row's effective cost. The ledger is never rewritten: a stored cost above
 * zero is the turn's own and stays exact. A zero that moved tokens means the
 * model had no price on file when the turn ran (a gateway whose price was
 * read later, or never), so it is priced at today's rate and marked as an
 * estimate. A price block that is all zeros counts as no price at all: a
 * model declared free looks exactly like a model nobody priced, and the
 * wallet would rather say "no price" than show a free turn it cannot vouch
 * for. A zero that moved no tokens is an empty turn, exact at zero.
 */
function priceRow(row: UsageRow, priceOf: (row: UsageRow) => UsagePrice | undefined): { cost: number; pricedAt: PricedAt } {
	if (row.cost > 0 || tokensOf(row) === 0) return { cost: row.cost, pricedAt: "turn" };
	const price = priceOf(row);
	if (!price || price.input + price.output + price.cacheRead + price.cacheWrite <= 0) return { cost: 0, pricedAt: "none" };
	const cost = (row.input * price.input + row.output * price.output + row.cacheRead * price.cacheRead + (row.cacheWrite || 0) * price.cacheWrite) / 1_000_000;
	return { cost, pricedAt: "today" };
}

/** Money plus how much of it is read-time estimate or still missing; every aggregate carries it. */
type PricedTally = { cost: number; turns: number; estimatedTurns: number; unpricedTurns: number };
const newTally = (): PricedTally => ({ cost: 0, turns: 0, estimatedTurns: 0, unpricedTurns: 0 });
function tally(agg: PricedTally, priced: { cost: number; pricedAt: PricedAt }): void {
	agg.cost += priced.cost;
	agg.turns += 1;
	if (priced.pricedAt === "today") agg.estimatedTurns += 1;
	if (priced.pricedAt === "none") agg.unpricedTurns += 1;
}

function providerOfRow(row: UsageRow): string | undefined {
	if (row.provider) return row.provider;
	if (row.modelLabel) {
		const prefix = row.modelLabel.split(" — ")[0];
		return PROVIDER_BY_LABEL_PREFIX[prefix];
	}
	return undefined;
}

/**
 * Classify a row's billing reality. Rows recorded since enrichment carry
 * authType and classify exactly. Older rows classify only by what the row
 * itself proves: ChatGPT/Copilot are OAuth-only channels, so their labeled
 * rows are plan usage. Everything else stays unattributed — how a provider
 * is authenticated TODAY says nothing about how a past turn was billed, so
 * we never guess (billed dollars must never be invented or hidden).
 */
function sourceOfRow(row: UsageRow): UsageSource {
	if (row.authType === "api_key") return "billed";
	if (row.authType === "oauth") return "plan";
	const provider = providerOfRow(row);
	if (provider && OAUTH_ONLY_PROVIDERS.has(provider)) return "plan";
	return "unattributed";
}


export function registerUsageApi(app: FastifyInstance, deps: UsageApiDeps): void {
	// One registry lookup per (provider, model) per request: a ledger has
	// thousands of rows and a few dozen distinct models.
	const priceLookup = () => {
		const cache = new Map<string, UsagePrice | undefined>();
		return (row: UsageRow): UsagePrice | undefined => {
			const provider = providerOfRow(row);
			if (!provider || !row.model) return undefined;
			const key = provider + "|" + row.model;
			if (!cache.has(key)) cache.set(key, deps.findModel(provider, row.model)?.cost);
			return cache.get(key);
		};
	};

	// A gateway goes by the name its owner gave it, the legacy single-gateway
	// id included, so the person's own label wins over the curated table there.
	const isGateway = (provider: string): boolean => provider === "openai-compatible" || provider.startsWith(GATEWAY_PROVIDER_ID_PREFIX);
	const sourceDisplayName = (provider: string): string =>
		(isGateway(provider) ? deps.providerDisplayName(provider) : undefined) ??
		SOURCE_DISPLAY[provider] ??
		deps.providerDisplayName(provider) ??
		// A gateway id nothing answers for any more is a gateway that was
		// removed; its turns still happened and still cost money.
		(provider.startsWith(GATEWAY_PROVIDER_ID_PREFIX) ? `Removed gateway (${provider})` : provider);

	app.get("/api/usage", async (req) => {
		const rows = loadUsage();
		const priceOf = priceLookup();
		const now = Date.now();
		const day = 24 * 3600 * 1000;
		const hourMs = 3600 * 1000;

		const query = (req.query as { range?: string; model?: string; agent?: string } | undefined) ?? {};
		const rangeParam = String(query.range ?? "all");
		const range = (["24h", "7d", "30d", "all"].includes(rangeParam) ? rangeParam : "all") as "24h" | "7d" | "30d" | "all";

		// --- canonical model groups over the whole log (drives the filter) ---
		const groupTurns = new Map<string, number>();
		const groupNames = new Map<string, string>();
		const groupRawIds = new Map<string, Set<string>>();
		for (const r of rows) {
			if (!r.model) continue;
			const { key, name } = modelGroupOf(r);
			groupTurns.set(key, (groupTurns.get(key) ?? 0) + 1);
			if (!groupNames.has(key)) groupNames.set(key, name);
			let raw = groupRawIds.get(key);
			if (!raw) groupRawIds.set(key, (raw = new Set()));
			raw.add(r.model);
		}
		const models = Array.from(groupTurns.entries())
			.sort((a, b) => b[1] - a[1])
			.map(([key, turns]) => ({ id: key, label: groupNames.get(key) ?? key, turns, rawIds: groupRawIds.get(key)?.size ?? 1 }));
		const modelParam = String(query.model ?? "all");
		const model = models.some((m) => m.id === modelParam) ? modelParam : "all";
		const modelOk = (r: UsageRow) => model === "all" || (r.model ? modelGroupOf(r).key === model : false);

		const agentParam = String(query.agent ?? "all");
		const agentOk = (r: UsageRow) => agentParam === "all" || r.agent === agentParam;

		const todayStart = new Date();
		todayStart.setHours(0, 0, 0, 0);
		const todayStartMs = todayStart.getTime();
		// Local midnight k calendar days back — setDate handles DST, so a
		// window never starts at 23:00/01:00 around a transition.
		const localMidnightDaysAgo = (daysBack: number): number => {
			const d = new Date(todayStartMs);
			d.setDate(d.getDate() - daysBack);
			return d.getTime();
		};

		let windowStart = 0;
		if (range === "24h") windowStart = now - day;
		else if (range === "7d") windowStart = localMidnightDaysAgo(6);
		else if (range === "30d") windowStart = localMidnightDaysAgo(29);
		const scoped = rows.filter((r) => r.ts >= windowStart && modelOk(r) && agentOk(r));

		// --- accumulators ------------------------------------------------
		interface SourceSplit {
			billed: number;
			plan: number;
			unattributed: number;
		}
		const newSplit = (): SourceSplit => ({ billed: 0, plan: 0, unattributed: 0 });

		const totals = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			turns: 0,
			cost: newSplit(),
			/** est. list-price savings from cache reads, only over rows whose price is known */
			cacheSavedEst: 0,
			cacheSavedKnownTurns: 0,
			/**
			 * Turns recorded at zero that are priced at today's rate on the way
			 * out (see priceRow), and turns that moved tokens and still have no
			 * price anywhere. Counted so the UI can mark the first as estimates
			 * and say "no price on file" for the second, where a zero would
			 * otherwise read as a free turn.
			 */
			estimatedTurns: 0,
			unpricedTurns: 0,
		};
		const bySource = new Map<string, PricedTally & { source: UsageSource; name: string }>();
		const byModel = new Map<string, PricedTally & { tokens: number }>();
		const byAgent = new Map<string, PricedTally & { input: number; output: number; kinds: Record<string, PricedTally> }>();
		const activeDays = new Set<number>();

		type Bucket = { label: string; ts?: number; turns: number; tokens: number } & SourceSplit;
		const newBucket = (label: string, ts?: number): Bucket => ({ label, ts, turns: 0, tokens: 0, ...newSplit() });
		let series: { kind: "hourly" | "daily"; buckets: Bucket[] };
		let dayIndexByMidnight: Map<number, number> | null = null;
		if (range === "24h") {
			series = { kind: "hourly", buckets: Array.from({ length: 24 }, (_, i) => newBucket(String(new Date(now - (23 - i) * hourMs).getHours()).padStart(2, "0"))) };
		} else {
			let days = range === "7d" ? 7 : 30;
			if (range === "all" && rows.length > 0) {
				const earliest = new Date(rows[0].ts);
				earliest.setHours(0, 0, 0, 0);
				days = Math.min(120, Math.max(1, Math.round((todayStartMs - earliest.getTime()) / day) + 1));
			}
			// Buckets keyed by their true local midnight; rows join via the
			// map, so day boundaries and labels stay correct across DST.
			dayIndexByMidnight = new Map();
			const buckets: Bucket[] = [];
			for (let i = 0; i < days; i++) {
				const ts = localMidnightDaysAgo(days - 1 - i);
				dayIndexByMidnight.set(ts, i);
				buckets.push(newBucket(new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" }), ts));
			}
			series = { kind: "daily", buckets };
		}
		const weekHour: number[][] = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));

		for (const r of scoped) {
			const source = sourceOfRow(r);
			const priced = priceRow(r, priceOf);
			totals.input += r.input;
			totals.output += r.output;
			totals.cacheRead += r.cacheRead;
			totals.cacheWrite += r.cacheWrite || 0;
			totals.turns += 1;
			totals.cost[source] += priced.cost;
			if (priced.pricedAt === "today") totals.estimatedTurns += 1;
			if (priced.pricedAt === "none") totals.unpricedTurns += 1;

			const price = priceOf(r);
			if (price && price.input > 0) {
				totals.cacheSavedEst += (r.cacheRead * (price.input - price.cacheRead)) / 1_000_000;
				totals.cacheSavedKnownTurns += 1;
			}

			const provider = providerOfRow(r);
			const sourceKey = source === "unattributed" ? "unattributed" : `${source}:${provider ?? "unknown"}`;
			let sourceAgg = bySource.get(sourceKey);
			if (!sourceAgg) {
				const name = source === "unattributed" ? "Earlier usage" : provider ? sourceDisplayName(provider) : "Unknown";
				bySource.set(sourceKey, (sourceAgg = { source, name, ...newTally() }));
			}
			tally(sourceAgg, priced);

			if (r.model) {
				const modelKey = modelGroupOf(r).key;
				let modelAgg = byModel.get(modelKey);
				if (!modelAgg) byModel.set(modelKey, (modelAgg = { ...newTally(), tokens: 0 }));
				tally(modelAgg, priced);
				modelAgg.tokens += r.input + r.output;
			}

			let agentAgg = byAgent.get(r.agent);
			if (!agentAgg) byAgent.set(r.agent, (agentAgg = { ...newTally(), input: 0, output: 0, kinds: {} }));
			tally(agentAgg, priced);
			agentAgg.input += r.input;
			agentAgg.output += r.output;
			tally((agentAgg.kinds[r.kind ?? "chat"] ??= newTally()), priced);

			const rowDate = new Date(r.ts);
			const dayKeyDate = new Date(r.ts);
			dayKeyDate.setHours(0, 0, 0, 0);
			activeDays.add(dayKeyDate.getTime());
			weekHour[(rowDate.getDay() + 6) % 7][rowDate.getHours()] += 1;

			if (series.kind === "hourly") {
				const hAgo = Math.floor((now - r.ts) / hourMs);
				if (hAgo >= 0 && hAgo < 24) {
					const b = series.buckets[23 - hAgo];
					b.turns += 1;
					b.tokens += r.input + r.output;
					b[source] += priced.cost;
				}
			} else {
				const idx = dayIndexByMidnight?.get(dayKeyDate.getTime());
				if (idx !== undefined) {
					const b = series.buckets[idx];
					b.turns += 1;
					b.tokens += r.input + r.output;
					b[source] += priced.cost;
				}
			}
		}

		// Previous window for KPI deltas: exactly the current window's span
		// (which includes a partial today), shifted to end where it starts —
		// unequal spans would bias every delta.
		let previous: { cost: SourceSplit; turns: number; tokens: number } | null = null;
		if (range !== "all") {
			const windowLen = now - windowStart;
			const prevRows = rows.filter((r) => r.ts >= windowStart - windowLen && r.ts < windowStart && modelOk(r) && agentOk(r));
			previous = { cost: newSplit(), turns: prevRows.length, tokens: 0 };
			for (const r of prevRows) {
				previous.cost[sourceOfRow(r)] += priceRow(r, priceOf).cost;
				previous.tokens += r.input + r.output;
			}
		}

		const live = deps.liveAgents();
		return {
			range,
			model,
			models,
			agent: agentParam,
			// Current display names for live rooms, so the Wallet shows what a
			// room is CALLED now (renames included), not the id the ledger
			// recorded. Retired rooms are absent and fall back client-side.
			agentNames: Object.fromEntries(live),
			totals: {
				...totals,
				activeDays: activeDays.size,
				cacheHitRate: totals.cacheRead + totals.input > 0 ? totals.cacheRead / (totals.cacheRead + totals.input) : 0,
			},
			previous,
			sources: Array.from(bySource.values()).sort((a, b) => b.cost - a.cost || b.turns - a.turns),
			byAgent: Array.from(byAgent.entries())
				.map(([agent, a]) => ({ agent, retired: !live.has(agent), ...a }))
				.sort((a, b) => b.cost - a.cost || b.turns - a.turns),
			byModel: Array.from(byModel.entries())
				.map(([id, m]) => {
					const meta = models.find((entry) => entry.id === id);
					return { id, label: meta?.label ?? id, rawIds: meta?.rawIds ?? 1, ...m };
				})
				.sort((a, b) => b.cost - a.cost || b.turns - a.turns),
			series,
			weekHour,
			// Full turn log newest first, model/agent-filtered, range-independent
			// so a filter can surface every matching turn. Each row carries its
			// effective cost and whether that cost is a read-time estimate.
			recent: rows
				.filter((r) => modelOk(r) && agentOk(r))
				.map((r) => {
					const priced = priceRow(r, priceOf);
					return { ...r, cost: priced.cost, estimated: priced.pricedAt === "today" };
				})
				.reverse(),
		};
	});

	app.get("/api/usage/export.csv", async (_req, reply) => {
		const rows = loadUsage();
		const priceOf = priceLookup();
		const esc = (value: unknown): string => {
			let s = value == null ? "" : String(value);
			// Spreadsheets execute cells starting with = + - @ or a tab as
			// formulas; a leading apostrophe forces them to render as text.
			if (/^[=+\-@\t]/.test(s)) s = "'" + s;
			return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
		};
		// cost_est_usd is the same effective cost the wallet shows, and priced_at
		// says where it came from, so a spreadsheet can tell a stored cost from
		// a read-time estimate from a turn nobody could price.
		const header = "ts,iso,agent,persona,kind,provider,auth,model,model_label,input,output,cache_read,cache_write,cost_est_usd,priced_at,tools";
		const lines = rows.map((r) => {
			const priced = priceRow(r, priceOf);
			return [
				r.ts,
				new Date(r.ts).toISOString(),
				esc(r.agent),
				esc(r.persona),
				esc(r.kind ?? ""),
				esc(r.provider ?? ""),
				esc(r.authType ?? ""),
				esc(r.model ?? ""),
				esc(r.modelLabel ?? ""),
				r.input,
				r.output,
				r.cacheRead,
				r.cacheWrite || 0,
				priced.cost,
				priced.pricedAt,
				esc(r.tools?.join(" ") ?? ""),
			].join(",");
		});
		reply.header("content-type", "text/csv; charset=utf-8");
		reply.header("content-disposition", 'attachment; filename="exxperts-usage.csv"');
		return [header, ...lines].join("\n") + "\n";
	});
}
