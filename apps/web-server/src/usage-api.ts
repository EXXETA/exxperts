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

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { calculateCost } from "@exxeta/exxperts-runtime";
import { canonicalModelName, modelIdDate, providerDisplayName, realModelName } from "../../web-ui/src/model-names.js";
import { GATEWAY_PROVIDER_ID_PREFIX } from "./openai-compatible-gateways.js";
import { forEachUsageRowYielding, loadUsage } from "./usage-log.js";
import { isSharedServer, serverHooks } from "./server-hooks.js";
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
	"Claude API key": "anthropic-api-key",
	OpenAI: "openai",
	"OpenAI-compatible gateway": "openai-compatible",
	"Google / Gemini": "google",
	OpenRouter: "openrouter",
};

// A saved gateway's provider id, or the single gateway the app had before those.
const isGateway = (provider: string): boolean => provider === "openai-compatible" || provider.startsWith(GATEWAY_PROVIDER_ID_PREFIX);

// Grouping builds on the shared naming module: two rows are the same model
// iff they display as the same canonical name (model-names.ts is the spec),
// and a dated snapshot stays apart from its undated name. A gateway's model is
// named from its id alone, never from the name its owner saved for it: two
// gateways can save "Fast" for two different models, and the Wallet counts
// real models, so a known family joins its row wherever it ran, a Bedrock
// region's copy included (realModelName).
// Cached because every request keys thousands of rows.
const modelGroupCache = new Map<string, { key: string; name: string; date?: string }>();
export function modelGroupOf(row: { model?: string; modelLabel?: string; provider?: string }): { key: string; name: string; date?: string } {
	const cacheKey = (row.model ?? "") + "|" + (row.modelLabel ?? "") + "|" + (row.provider ?? "");
	let group = modelGroupCache.get(cacheKey);
	if (!group) {
		const provider = providerOfRow(row);
		const real = provider && isGateway(provider) && row.model ? realModelName(row.model) : { name: canonicalModelName(row).name, date: row.model ? modelIdDate(row.model) : null };
		const name = real.name || (row.model ?? "");
		const date = real.date;
		group = date ? { key: `${name.toLowerCase()} (${date})`, name, date } : { key: name.toLowerCase(), name };
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
	/** On a shared server, the names of the rooms this request's person may see: live, and archived. */
	roomNames: (req: FastifyRequest) => Promise<OwnRoomNames>;
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
	const usage = { input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite || 0, cacheWrite1h: row.cacheWrite1h, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	return { cost: calculateCost({ cost: price }, usage).total, pricedAt: "today" };
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

function providerOfRow(row: Pick<UsageRow, "provider" | "modelLabel">): string | undefined {
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

/** The canonical model groups of a set of rows: what the model filter lists, and each group's label. */
class ModelCatalog {
	private readonly turns = new Map<string, number>();
	private readonly names = new Map<string, string>();
	private readonly rawIds = new Map<string, Set<string>>();
	private readonly dates = new Map<string, string>();

	add(row: UsageRow): void {
		if (!row.model) return;
		const { key, name, date } = modelGroupOf(row);
		this.turns.set(key, (this.turns.get(key) ?? 0) + 1);
		if (!this.names.has(key)) this.names.set(key, name);
		if (date) this.dates.set(key, date);
		let raw = this.rawIds.get(key);
		if (!raw) this.rawIds.set(key, (raw = new Set()));
		raw.add(row.model);
	}

	/** A dated snapshot shows its date only beside a model of the same name. */
	label(key: string): string {
		const name = this.names.get(key) ?? key;
		const date = this.dates.get(key);
		if (!date) return name;
		let sameName = 0;
		for (const other of this.names.values()) if (other.toLowerCase() === name.toLowerCase()) sameName += 1;
		return sameName > 1 ? `${name} (${date})` : name;
	}

	rawIdCount(key: string): number {
		return this.rawIds.get(key)?.size ?? 1;
	}

	/** Most used first. */
	list(): { id: string; label: string; turns: number; rawIds: number }[] {
		return Array.from(this.turns.entries())
			.sort((a, b) => b[1] - a[1])
			.map(([key, turns]) => ({ id: key, label: this.label(key), turns, rawIds: this.rawIdCount(key) }));
	}
}

type UsageRange = "24h" | "7d" | "30d" | "all";
const ALL_RANGES: readonly UsageRange[] = ["24h", "7d", "30d", "all"];
/** The organisation's totals have no hours. */
const DAY_RANGES: readonly UsageRange[] = ["7d", "30d", "all"];
const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;

function rangeOf(param: unknown, allowed: readonly UsageRange[]): UsageRange {
	const range = String(param ?? "all");
	return allowed.find((r) => r === range) ?? "all";
}

/** The server's local midnight of a time. */
function midnightOf(ts: number): number {
	const d = new Date(ts);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

/**
 * Local midnight k calendar days before today's: setDate handles DST, so a
 * window never starts at 23:00/01:00 around a transition.
 */
function midnightDaysAgo(todayStartMs: number, daysBack: number): number {
	const d = new Date(todayStartMs);
	d.setDate(d.getDate() - daysBack);
	return d.getTime();
}

/**
 * A series' empty buckets: the last 24 hours, or one per local day, keyed by
 * its true local midnight so day boundaries and labels stay right across DST.
 * "all" runs from the first row's day, capped at `dayCap` days when one is
 * given; with no row it is 30 days.
 */
function emptySeries<B>(range: UsageRange, now: number, todayStartMs: number, firstTs: number | undefined, dayCap: number | null, newBucket: (label: string, ts?: number) => B): { kind: "hourly" | "daily"; buckets: B[]; dayIndex: Map<number, number> } {
	if (range === "24h") {
		return { kind: "hourly", buckets: Array.from({ length: 24 }, (_, i) => newBucket(String(new Date(now - (23 - i) * HOUR_MS).getHours()).padStart(2, "0"))), dayIndex: new Map() };
	}
	let days = range === "7d" ? 7 : 30;
	if (range === "all" && firstTs !== undefined) {
		days = Math.max(1, Math.round((todayStartMs - midnightOf(firstTs)) / DAY_MS) + 1);
		if (dayCap !== null) days = Math.min(dayCap, days);
	}
	const dayIndex = new Map<number, number>();
	const buckets: B[] = [];
	for (let i = 0; i < days; i++) {
		const ts = midnightDaysAgo(todayStartMs, days - 1 - i);
		dayIndex.set(ts, i);
		buckets.push(newBucket(new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" }), ts));
	}
	return { kind: "daily", buckets, dayIndex };
}

/** Where a range's window starts: 24 hours back, or the local midnight 6 or 29 days back, or the beginning. */
function windowStartOf(range: UsageRange, now: number, todayStartMs: number): number {
	if (range === "24h") return now - DAY_MS;
	if (range === "7d") return midnightDaysAgo(todayStartMs, 6);
	if (range === "30d") return midnightDaysAgo(todayStartMs, 29);
	return 0;
}

/** Every token a turn moved: its input with the prompt cache (allInput in usage-words.ts), and its output. */
function allTokensOf(row: Pick<UsageRow, "input" | "output" | "cacheRead" | "cacheWrite">): number {
	return row.input + row.cacheRead + (row.cacheWrite || 0) + row.output;
}

// --- A shared server: a person's own usage, and the organisation's totals ---
// Turns and tokens only, never money; every token count is all of it.

/** The room names a person's own usage may show: the rooms they may see that exist, and those archived. */
export type OwnRoomNames = { live: ReadonlyMap<string, string>; archived: ReadonlyMap<string, string> };

type TokenCounts = { turns: number; input: number; output: number; cacheRead: number; cacheWrite: number };
type TokenBucket = { label: string; ts?: number; turns: number; tokens: number };
const newCounts = (): TokenCounts => ({ turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
function addCounts(into: TokenCounts, from: Omit<TokenCounts, "turns"> & { turns?: number }): void {
	into.turns += from.turns ?? 1;
	into.input += from.input;
	into.output += from.output;
	into.cacheRead += from.cacheRead;
	into.cacheWrite += from.cacheWrite || 0;
}

/** How many of a person's own turns their page lists, newest first. */
const OWN_RECENT_TURNS = 100;

/** A turn as its person's page lists it: what ran and its tokens, no money and no ids but the room's. */
function ownTurn(row: UsageRow) {
	return {
		ts: row.ts,
		agent: row.agent,
		model: row.model,
		modelLabel: row.modelLabel,
		...(row.model ? { modelName: modelGroupOf(row).name } : {}),
		provider: row.provider,
		kind: row.kind,
		input: row.input,
		output: row.output,
		cacheRead: row.cacheRead,
		cacheWrite: row.cacheWrite || 0,
	};
}

/**
 * A person's own usage from their own rows, oldest first: the Wallet's views
 * without money, every token counted, "all" without the Wallet's 120-day cap.
 */
export function ownUsage(rows: readonly UsageRow[], query: { range?: unknown; model?: unknown; agent?: unknown }, names: OwnRoomNames, now = Date.now()) {
	const range = rangeOf(query.range, ALL_RANGES);
	const catalog = new ModelCatalog();
	for (const r of rows) catalog.add(r);
	const models = catalog.list();
	const modelParam = String(query.model ?? "all");
	const model = models.some((m) => m.id === modelParam) ? modelParam : "all";
	const agent = String(query.agent ?? "all");
	const matches = (r: UsageRow): boolean => (model === "all" || (r.model ? modelGroupOf(r).key === model : false)) && (agent === "all" || r.agent === agent);

	const todayStartMs = midnightOf(now);
	const windowStart = windowStartOf(range, now, todayStartMs);
	const { dayIndex, ...series } = emptySeries<TokenBucket>(range, now, todayStartMs, rows[0]?.ts, null, (label, ts) => ({ label, ts, turns: 0, tokens: 0 }));
	const totals = newCounts();
	const activeDays = new Set<number>();
	const byAgent = new Map<string, { turns: number; tokens: number; kinds: Record<string, { turns: number }> }>();
	const byModel = new Map<string, { turns: number; tokens: number }>();
	const weekHour: number[][] = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
	for (const r of rows) {
		if (r.ts < windowStart || !matches(r)) continue;
		const tokens = allTokensOf(r);
		addCounts(totals, r);
		const day = midnightOf(r.ts);
		activeDays.add(day);
		let room = byAgent.get(r.agent);
		if (!room) byAgent.set(r.agent, (room = { turns: 0, tokens: 0, kinds: {} }));
		room.turns += 1;
		room.tokens += tokens;
		(room.kinds[r.kind ?? "chat"] ??= { turns: 0 }).turns += 1;
		if (r.model) {
			const key = modelGroupOf(r).key;
			let m = byModel.get(key);
			if (!m) byModel.set(key, (m = { turns: 0, tokens: 0 }));
			m.turns += 1;
			m.tokens += tokens;
		}
		const at = new Date(r.ts);
		weekHour[(at.getDay() + 6) % 7][at.getHours()] += 1;
		const index = series.kind === "hourly" ? 23 - Math.floor((now - r.ts) / HOUR_MS) : dayIndex.get(day);
		const bucket = index === undefined ? undefined : series.buckets[index];
		if (bucket) {
			bucket.turns += 1;
			bucket.tokens += tokens;
		}
	}

	// The window before, of the same span, for the turns' change.
	let previous: { turns: number; tokens: number } | null = null;
	if (range !== "all") {
		const windowLen = now - windowStart;
		previous = { turns: 0, tokens: 0 };
		for (const r of rows) {
			if (r.ts < windowStart - windowLen || r.ts >= windowStart || !matches(r)) continue;
			previous.turns += 1;
			previous.tokens += allTokensOf(r);
		}
	}

	// The newest turns after the filters, whatever the range, and how many there are.
	const recent: ReturnType<typeof ownTurn>[] = [];
	let recentTotal = 0;
	for (let i = rows.length - 1; i >= 0; i--) {
		if (!matches(rows[i])) continue;
		recentTotal += 1;
		if (recent.length < OWN_RECENT_TURNS) recent.push(ownTurn(rows[i]));
	}

	// A room the person's rows name that has neither a live nor an archived name is gone, or its record can't be read: it gets no name.
	const agentNames: Record<string, string> = {};
	for (const r of rows) {
		const name = names.live.get(r.agent) ?? names.archived.get(r.agent);
		if (name !== undefined) agentNames[r.agent] = name;
	}

	return {
		range,
		model,
		models,
		agent,
		agentNames,
		totals: { ...totals, activeDays: activeDays.size },
		previous,
		byAgent: Array.from(byAgent.entries())
			.map(([id, a]) => ({ agent: id, retired: !names.live.has(id), ...a }))
			.sort((a, b) => b.tokens - a.tokens || b.turns - a.turns),
		byModel: Array.from(byModel.entries())
			.map(([id, m]) => ({ id, label: catalog.label(id), rawIds: catalog.rawIdCount(id), ...m }))
			.sort((a, b) => b.tokens - a.tokens || b.turns - a.turns),
		series,
		weekHour,
		recent: { rows: recent, total: recentTotal },
	};
}

/** A spreadsheet cell: a cell starting with = + - @ or a tab is a formula there, so a leading apostrophe makes it text. */
function csvCell(value: unknown): string {
	let s = value == null ? "" : String(value);
	if (/^[=+\-@\t]/.test(s)) s = "'" + s;
	return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A local day as YYYY-MM-DD. */
function isoDay(midnight: number): string {
	const d = new Date(midnight);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * The organisation's totals, folded as the log is read: one count per finished
 * local day and model, and each model's catalog entry. Nothing else of a row is
 * kept, so nothing built from it can hold a room, a person, a turn, an hour or
 * money. Today's turns are left out: two reads in one day would say when
 * someone worked.
 */
export class CompanyUsage {
	private readonly days = new Map<number, Map<string, TokenCounts>>();
	private readonly catalog = new ModelCatalog();
	private readonly todayStartMs: number;

	constructor(now = Date.now()) {
		this.todayStartMs = midnightOf(now);
	}

	add(row: UsageRow): void {
		if (row.ts >= this.todayStartMs) return;
		const day = midnightOf(row.ts);
		let models = this.days.get(day);
		if (!models) this.days.set(day, (models = new Map()));
		// A row with no model counts in the totals under no model.
		const key = row.model ? modelGroupOf(row).key : "";
		let counts = models.get(key);
		if (!counts) models.set(key, (counts = newCounts()));
		addCounts(counts, row);
		this.catalog.add(row);
	}

	/** The admin's view: totals, by model and by finished day, in a range of 7 or 30 finished days or all of them. */
	answer(query: { range?: unknown; model?: unknown }) {
		const range = rangeOf(query.range, DAY_RANGES);
		const models = this.catalog.list();
		const modelParam = String(query.model ?? "all");
		const model = models.some((m) => m.id === modelParam) ? modelParam : "all";
		const firstDay = this.days.size > 0 ? Math.min(...this.days.keys()) : this.todayStartMs;
		const dayCount = range === "7d" ? 7 : range === "30d" ? 30 : Math.round((this.todayStartMs - firstDay) / DAY_MS);
		const buckets: TokenBucket[] = [];
		const totals = newCounts();
		let activeDays = 0;
		const byModel = new Map<string, { turns: number; tokens: number }>();
		for (let back = dayCount; back >= 1; back--) {
			const ts = midnightDaysAgo(this.todayStartMs, back);
			const bucket: TokenBucket = { label: new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" }), ts, turns: 0, tokens: 0 };
			buckets.push(bucket);
			for (const [key, counts] of this.days.get(ts) ?? []) {
				if (model !== "all" && key !== model) continue;
				addCounts(totals, counts);
				bucket.turns += counts.turns;
				bucket.tokens += allTokensOf(counts);
				if (!key) continue;
				let m = byModel.get(key);
				if (!m) byModel.set(key, (m = { turns: 0, tokens: 0 }));
				m.turns += counts.turns;
				m.tokens += allTokensOf(counts);
			}
			if (bucket.turns > 0) activeDays += 1;
		}
		return {
			range,
			model,
			models,
			totals: { ...totals, activeDays },
			byModel: Array.from(byModel.entries())
				.map(([id, m]) => ({ id, label: this.catalog.label(id), rawIds: this.catalog.rawIdCount(id), ...m }))
				.sort((a, b) => b.tokens - a.tokens || b.turns - a.turns),
			series: { kind: "daily" as const, buckets },
		};
	}

	/** One line per finished day and model, oldest day first, then by the model's label. */
	csv(): string {
		const lines = ["day,model,turns,input,output,cache_read,cache_write"];
		for (const day of Array.from(this.days.keys()).sort((a, b) => a - b)) {
			const rows = Array.from(this.days.get(day) ?? [])
				.map(([key, counts]) => ({ label: key ? this.catalog.label(key) : "", counts }))
				.sort((a, b) => a.label.localeCompare(b.label));
			for (const { label, counts } of rows) lines.push([isoDay(day), csvCell(label), counts.turns, counts.input, counts.output, counts.cacheRead, counts.cacheWrite].join(","));
		}
		return lines.join("\n") + "\n";
	}
}

/** On a shared server the asker's own person and space, or a refusal sent: nobody known reads no usage. */
async function askerOrRefusal(req: FastifyRequest, reply: FastifyReply): Promise<{ person: string; space: string } | null> {
	const asker = await serverHooks().whoIsAsking?.(req);
	if (asker) return asker;
	reply.code(403).send({ code: "usage_no_person" });
	return null;
}

/** The organisation's rows folded: only the asker's space, only rows that name a person. Null once a refusal or failure is sent. */
async function readCompanyUsage(req: FastifyRequest, reply: FastifyReply): Promise<CompanyUsage | null> {
	const asker = await askerOrRefusal(req, reply);
	if (!asker) return null;
	const company = new CompanyUsage();
	try {
		await forEachUsageRowYielding((row) => {
			if (row.space === asker.space && typeof row.person === "string") company.add(row);
		});
	} catch (err) {
		usageUnreadable(req, reply, err);
		return null;
	}
	return company;
}

/** A log that cannot be read is never shown as an empty one: the page says so in its own words. */
function usageUnreadable(req: FastifyRequest, reply: FastifyReply, err: unknown): FastifyReply {
	req.log.warn({ err }, "the usage log could not be read");
	return reply.code(500).send({ code: "usage_unreadable" });
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

	// A gateway goes by the name its owner gave it, so the person's own label
	// wins over the curated table there.
	const sourceDisplayName = (provider: string): string =>
		(isGateway(provider) ? deps.providerDisplayName(provider) : undefined) ??
		(providerDisplayName(provider) !== provider ? providerDisplayName(provider) : undefined) ??
		deps.providerDisplayName(provider) ??
		// A gateway id nothing answers for any more is a gateway that was
		// removed; its turns still happened and still cost money.
		(provider.startsWith(GATEWAY_PROVIDER_ID_PREFIX) ? `Removed gateway (${provider})` : provider);

	// The Wallet: every row, with money, on the desktop only.
	const walletUsage = (req: FastifyRequest, reply: FastifyReply) => {
		let rows: UsageRow[];
		try {
			rows = loadUsage();
		} catch (err) {
			return usageUnreadable(req, reply, err);
		}
		const priceOf = priceLookup();
		const now = Date.now();

		const query = (req.query as { range?: string; model?: string; agent?: string } | undefined) ?? {};
		const range = rangeOf(query.range, ALL_RANGES);

		// --- canonical model groups over the whole log (drives the filter) ---
		const catalog = new ModelCatalog();
		for (const r of rows) catalog.add(r);
		const models = catalog.list();
		const modelParam = String(query.model ?? "all");
		const model = models.some((m) => m.id === modelParam) ? modelParam : "all";
		const modelOk = (r: UsageRow) => model === "all" || (r.model ? modelGroupOf(r).key === model : false);

		const agentParam = String(query.agent ?? "all");
		const agentOk = (r: UsageRow) => agentParam === "all" || r.agent === agentParam;

		const todayStartMs = midnightOf(now);
		const windowStart = windowStartOf(range, now, todayStartMs);
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
		// The Wallet's "all" chart shows at most 120 days.
		const { dayIndex: dayIndexByMidnight, ...series } = emptySeries(range, now, todayStartMs, rows[0]?.ts, 120, newBucket);
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
				const hAgo = Math.floor((now - r.ts) / HOUR_MS);
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
					// Named as the Wallet's model rows name it, so a gateway's
					// turn reads as its real model, not the name saved for it.
					return { ...r, ...(r.model ? { modelName: modelGroupOf(r).name } : {}), cost: priced.cost, estimated: priced.pricedAt === "today" };
				})
				.reverse(),
		};
	};

	// On a shared server a person reads only their own rows, and the admin only
	// the organisation's totals; the desktop's answers stay.
	app.get("/api/usage", async (req, reply) => {
		if (!isSharedServer()) return walletUsage(req, reply);
		const company = await readCompanyUsage(req, reply);
		return company ? company.answer((req.query as Record<string, unknown> | undefined) ?? {}) : reply;
	});

	app.get("/api/usage/mine", async (req, reply) => {
		if (!isSharedServer()) return walletUsage(req, reply);
		const asker = await askerOrRefusal(req, reply);
		if (!asker) return reply;
		const rows: UsageRow[] = [];
		try {
			await forEachUsageRowYielding((row) => {
				if (row.person === asker.person && row.space === asker.space) rows.push(row);
			});
		} catch (err) {
			return usageUnreadable(req, reply, err);
		}
		// Imported older rows are appended after newer ones.
		rows.sort((a, b) => a.ts - b.ts);
		return ownUsage(rows, (req.query as Record<string, unknown> | undefined) ?? {}, await deps.roomNames(req));
	});

	app.get("/api/usage/export.csv", async (req, reply) => {
		if (isSharedServer()) {
			const company = await readCompanyUsage(req, reply);
			if (!company) return reply;
			reply.header("content-type", "text/csv; charset=utf-8");
			reply.header("content-disposition", 'attachment; filename="exxperts-usage.csv"');
			return company.csv();
		}
		let rows: UsageRow[];
		try {
			rows = loadUsage();
		} catch (err) {
			return usageUnreadable(req, reply, err);
		}
		const priceOf = priceLookup();
		const esc = csvCell;
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
