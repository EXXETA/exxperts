import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import { apiFetch } from "../api";
import { pollWhileShown } from "../visible-poll";
import { knownRemoteClientContext, refreshRemoteClientContext, sharedServerRole, useRemoteClientContext } from "../remote-client-context";
import { agentLabel } from "../types";
import { CloseIcon } from "./icons";
import { GATEWAY_PROVIDER_ID_PREFIX, canonicalModelName, formatModelWithProvider, modelDisplayName } from "../model-names";
import {
	COMPANY_USAGE_CSV_HOVER,
	COMPANY_USAGE_EMPTY,
	COMPANY_USAGE_LINE,
	COMPANY_USAGE_TITLE,
	SHARED_USAGE_EMPTY,
	SHARED_USAGE_FOOTER,
	SHARED_USAGE_MODELS_HINT,
	SHARED_USAGE_ROOMS_HINT,
	SHARED_USAGE_UNAVAILABLE_ROOM,
	SHARED_USAGE_UNREADABLE,
	WALLET_UNREADABLE,
	allInput,
	cacheWords,
} from "../usage-words";

// The Wallet never blends real and estimated dollars: the server splits every
// aggregate by source (billed API spend, plan-covered subscription usage,
// unattributed history) and this page keeps them apart visually too.

type UsageSource = "billed" | "plan" | "unattributed";
type SourceSplit = { billed: number; plan: number; unattributed: number };

interface UsageRow {
	ts: number;
	agent: string;
	model?: string;
	modelLabel?: string;
	/** the model's name as the Wallet's model rows show it */
	modelName?: string;
	provider?: string;
	authType?: "oauth" | "api_key";
	kind?: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	/** the cost is tokens x today's price, for a turn stored at zero before its model had a price */
	estimated: boolean;
}

/** Money plus how much of it is a read-time estimate or still missing; every aggregate carries it. */
interface Priced {
	cost: number;
	turns: number;
	/** turns stored at zero and priced at today's rate on the way out */
	estimatedTurns: number;
	/** turns that moved tokens and still have no price anywhere */
	unpricedTurns: number;
}

interface SeriesBucket extends SourceSplit {
	label: string;
	ts?: number;
	turns: number;
	tokens: number;
}

interface UsagePayload {
	range: Range;
	model: string;
	models: { id: string; label: string; turns: number; rawIds: number }[];
	agent: string;
	/** current display name per live room id; retired rooms are absent */
	agentNames?: Record<string, string>;
	totals: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		turns: number;
		cost: SourceSplit;
		cacheSavedEst: number;
		cacheSavedKnownTurns: number;
		estimatedTurns: number;
		unpricedTurns: number;
		cacheHitRate: number;
		activeDays: number;
	};
	previous: { cost: SourceSplit; turns: number; tokens: number } | null;
	sources: (Priced & { source: UsageSource; name: string })[];
	byAgent: (Priced & { agent: string; retired: boolean; input: number; output: number; kinds: Record<string, Priced> })[];
	byModel: (Priced & { id: string; label: string; rawIds: number; tokens: number })[];
	series: { kind: "hourly" | "daily"; buckets: SeriesBucket[] };
	weekHour: number[][];
	recent: UsageRow[];
}

type Range = "24h" | "7d" | "30d" | "all";
const RANGES: { id: Range; label: string }[] = [
	{ id: "24h", label: "24h" },
	{ id: "7d", label: "7d" },
	{ id: "30d", label: "30d" },
	{ id: "all", label: "All" },
];

// Rows shown before a bar list collapses behind "Show all". Collapse only
// kicks in past limit+1 so we never hide a single row behind a same-size button.
const BAR_COLLAPSE_LIMIT = 6;

const SOURCE_CHIP: Record<UsageSource, string> = { billed: "Billed", plan: "Plan", unattributed: "Unattributed" };

const KIND_LABELS: Record<string, string> = {
	chat: "Chat",
	upkeep: "Upkeep",
	scheduled: "Scheduled",
	hivemind: "Ask your rooms",
	cli: "CLI",
	consult: "Consult",
};

function fmtTok(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10_000) return (n / 1000).toFixed(1) + "k";
	if (n < 1_000_000) return Math.round(n / 1000) + "k";
	return (n / 1_000_000).toFixed(1) + "M";
}

function fmtCost(n: number): string {
	if (n === 0) return "$0.00";
	if (n < 0.01) return "<$0.01";
	return "$" + n.toFixed(2);
}

/** Estimated money is always marked as such; only billed spend is plain. */
function fmtEst(n: number): string {
	return n === 0 ? "$0.00" : "≈ " + fmtCost(n);
}

function fmtAgo(ts: number): string {
	const s = Math.round((Date.now() - ts) / 1000);
	if (s < 60) return s + "s ago";
	if (s < 3600) return Math.round(s / 60) + "m ago";
	if (s < 86400) return Math.round(s / 3600) + "h ago";
	return Math.round(s / 86400) + "d ago";
}

function totalCost(split: SourceSplit): number {
	return split.billed + split.plan + split.unattributed;
}

/**
 * Money in three states. Exact money is plain; money that includes turns
 * priced at today's rate is an estimate and wears the ≈; a zero standing for
 * turns nobody could price is an unknown bill, not a free one, and says so.
 * Only billed sources ever earn the plain form: everything else on the page
 * is list-price value and estimated by nature.
 */
function fmtPriced(p: Priced, exact: boolean): string {
	if (p.cost === 0 && p.unpricedTurns > 0) return "no price on file";
	return exact && p.estimatedTurns === 0 ? fmtCost(p.cost) : fmtEst(p.cost);
}

/** The caveat beside the money: how many turns are priced today, how many not at all. */
function pricingNote(p: Priced): string | undefined {
	const parts: string[] = [];
	if (p.estimatedTurns > 0) parts.push(`${p.estimatedTurns.toLocaleString()} turn${p.estimatedTurns === 1 ? "" : "s"} priced at today's rate`);
	if (p.unpricedTurns > 0) parts.push(`${p.unpricedTurns.toLocaleString()} turn${p.unpricedTurns === 1 ? "" : "s"} without a price`);
	return parts.length ? parts.join(", ") : undefined;
}

function turnsNote(turns: number): string {
	return `${turns.toLocaleString()} turn${turns === 1 ? "" : "s"}`;
}

/** One tally over many; the three states survive the sum untouched. */
function sumPriced(rows: Priced[]): Priced {
	return rows.reduce(
		(acc, p) => ({ cost: acc.cost + p.cost, turns: acc.turns + p.turns, estimatedTurns: acc.estimatedTurns + p.estimatedTurns, unpricedTurns: acc.unpricedTurns + p.unpricedTurns }),
		{ cost: 0, turns: 0, estimatedTurns: 0, unpricedTurns: 0 },
	);
}

// The server names a source row this way when its gateway id no longer
// answers for anything; the client folds those rows behind one quiet header.
const REMOVED_GATEWAY_PREFIX = "Removed gateway (";

/** Short source name for the recent-turns table. */
const PROVIDER_SHORT: Record<string, string> = {
	"openai-codex": "ChatGPT",
	"github-copilot": "Copilot",
	anthropic: "Claude",
	"anthropic-api-key": "Claude API key",
	openai: "OpenAI",
	"openai-compatible": "gateway",
	google: "Gemini",
	openrouter: "OpenRouter",
};

type ModelFields = Pick<UsageRow, "model" | "modelLabel" | "modelName" | "provider">;

function modelCell(row: ModelFields): string {
	return row.modelName || modelDisplayName(row) || "?";
}

/** Same cell, with the provider added: the table shows names, hover disambiguates. */
function modelCellTitle(row: ModelFields): string | undefined {
	const full = formatModelWithProvider(row.modelName || modelDisplayName(row), canonicalModelName(row).provider);
	return full && full !== modelCell(row) ? full : undefined;
}

// Mirrors the server's sourceOfRow: authType is exact; without it only the
// OAuth-only channels (ChatGPT, Copilot) may be called plans — anything else
// stays a bare provider name so the table never contradicts the KPIs.
// A saved gateway's provider id is a slug nobody chose to read ("gateway-
// project-gateway"); the row's label already carries the name they did choose,
// so that wins for gateways and the curated table speaks for everything else.
function shortSourceName(row: UsageRow): string | undefined {
	const fromLabel = row.modelLabel?.split(" — ")[0];
	if (!row.provider) return fromLabel;
	if (row.provider.startsWith(GATEWAY_PROVIDER_ID_PREFIX)) return fromLabel ?? "gateway";
	return PROVIDER_SHORT[row.provider] ?? row.provider;
}

function sourceCell(row: UsageRow): string {
	// The Claude key sits beside the Claude plan, so its rows say which one paid.
	if (row.provider === "anthropic-api-key") return "Claude API key";
	if (row.authType === "api_key") return "API key";
	const short = shortSourceName(row);
	if (row.authType === "oauth") return short ? short + " plan" : "plan";
	if (row.modelLabel?.startsWith("ChatGPT Plus/Pro") || row.provider === "openai-codex") return "ChatGPT plan";
	if (row.modelLabel?.startsWith("GitHub Copilot") || row.provider === "github-copilot") return "Copilot plan";
	return short ?? "unknown";
}

function DashboardLine({ text }: { text: string }) {
	return <div className="dashboard"><div className="sub">{text}</div></div>;
}

const CONTEXT_RETRY_MS = 5000;

// A shared server gives each person their own usage and its admin the
// company's totals, never the Wallet's whole log. The page must not ask for the
// Wallet's read there, so nothing reads usage until the server has said which
// kind it is. useRemoteClientContext says "this computer" before that and
// after a failed read, so only an answer opens either page.
export function Dashboard() {
	const context = useRemoteClientContext();
	const { sharedServer } = context;
	const [contextKnown, setContextKnown] = useState(() => knownRemoteClientContext()?.sharedServer === true);
	useEffect(() => {
		if (contextKnown) return;
		let alive = true;
		let retry: ReturnType<typeof setTimeout> | undefined;
		const ask = () => {
			void refreshRemoteClientContext().then((result) => {
				if (!alive) return;
				if (result === "answered") setContextKnown(true);
				else if (result === "no answer") retry = setTimeout(ask, CONTEXT_RETRY_MS);
			});
		};
		ask();
		return () => { alive = false; clearTimeout(retry); };
	}, [contextKnown]);
	if (!contextKnown) return <DashboardLine text="Loading…" />;
	if (sharedServer) return <SharedUsage admin={sharedServerRole(context) === "admin"} />;
	return <Wallet />;
}

// What the last answer about usage was. A server that could not give it is
// said plainly, never shown as an empty Wallet; no answer at all keeps the last.
type WalletAnswer = { kind: "waiting" } | { kind: "shown"; data: UsagePayload } | { kind: "unreadable" };

function Wallet() {
	const [answer, setAnswer] = useState<WalletAnswer>({ kind: "waiting" });
	const [recentOpen, setRecentOpen] = useState(false);
	const [removedOpen, setRemovedOpen] = useState(false);
	const [retiredOpen, setRetiredOpen] = useState(false);
	const [agentsExpanded, setAgentsExpanded] = useState(false);
	const [modelsExpanded, setModelsExpanded] = useState(false);
	const [range, setRange] = useState<Range>("all");
	const [model, setModel] = useState("all");
	const [agent, setAgent] = useState("all");
	const [activityMetric, setActivityMetric] = useState<"tokens" | "value">("value");

	// Every filter (range, model, exxpert) scopes the entire page server-side.
	useEffect(() => {
		let cancelled = false;
		let requestSeq = 0;
		const load = () => {
			// Sequence the polls: a slow older response must not overwrite a
			// newer one after the server has answered again.
			const seq = ++requestSeq;
			// Only an OK answer is usage: a refusal's body would break the page.
			apiFetch(`/api/usage?range=${range}&model=${encodeURIComponent(model)}&agent=${encodeURIComponent(agent)}`)
				.then(async (r): Promise<WalletAnswer> => (r.ok ? { kind: "shown", data: await r.json() } : { kind: "unreadable" }))
				.then((next) => { if (!cancelled && seq === requestSeq) setAnswer(next); })
				.catch(() => {});
		};
		const stop = pollWhileShown(load, 5000);
		return () => { cancelled = true; stop(); };
	}, [range, model, agent]);

	if (answer.kind === "waiting") return <DashboardLine text="Loading…" />;
	if (answer.kind === "unreadable") return <DashboardLine text={WALLET_UNREADABLE} />;
	const data = answer.data;

	const t = data.totals;
	const est = totalCost(t.cost);
	// Only billed rows can turn a zero into a wrong bill or an estimate into
	// exact money; plan and older rows are estimates already and say so in
	// their own words.
	const billed: Priced = sumPriced(data.sources.filter((s) => s.source === "billed"));
	const billedNote = pricingNote(billed);
	// Rows whose gateway no longer exists fold behind one row; the stacked bar
	// above keeps every segment, history is not rewritten.
	const liveSources = data.sources.filter((s) => !s.name.startsWith(REMOVED_GATEWAY_PREFIX));
	const removedSources = data.sources.filter((s) => s.name.startsWith(REMOVED_GATEWAY_PREFIX));
	const removedSum = sumPriced(removedSources);
	const buckets = data.series.buckets;
	const unit = data.series.kind === "hourly" ? "hour" : "day";
	const activityTitle = range === "24h" ? "Last 24 hours" : range === "7d" ? "Last 7 days" : range === "30d" ? "Last 30 days" : "All time";

	// KPI deltas vs the previous window of the same length; meaningless for
	// the all-time range, so they only render on bounded ranges.
	const delta = (current: number, prev: number | undefined): string | null => {
		if (data.previous == null || prev == null) return null;
		const diff = current - prev;
		if (Math.abs(diff) < 0.005) return null;
		return (diff > 0 ? "+$" : "-$") + Math.abs(diff).toFixed(2);
	};
	const turnsDelta = data.previous ? t.turns - data.previous.turns : 0;

	const hasModelFilter = data.models.length > 1;

	// Prefer the room's CURRENT display name (renames included) from the live
	// statuses the server joins in; retired/archived rooms fall back to the
	// recorded label or id, exactly as before.
	const nameOf = (id: string): string => (id === "hivemind:memory" ? KIND_LABELS.hivemind : data.agentNames?.[id] ?? agentLabel(id));

	// Retired rooms (archived and deleted alike) sit folded under the active
	// ones; the memory chat is a live surface and always counts as active.
	const isActiveRoom = (a: UsagePayload["byAgent"][number]): boolean => !a.retired || a.agent === "hivemind:memory";
	const activeRooms = data.byAgent.filter(isActiveRoom);
	const retiredRooms = data.byAgent.filter((a) => !isActiveRoom(a));
	const retiredSum = sumPriced(retiredRooms);
	const roomRow = (a: UsagePayload["byAgent"][number]): BarListRow => ({
		key: a.agent,
		name: nameOf(a.agent),
		tag: a.agent === "hivemind:memory" ? "memory chat" : a.retired ? "retired" : undefined,
		share: a.cost,
		detail: `${fmtPriced(a, false)}, ${turnsNote(a.turns)}`,
		subDetail: a.agent === "hivemind:memory" ? pricingNote(a) : [backgroundKindsNote(a.kinds), pricingNote(a)].filter(Boolean).join("; ") || undefined,
	});

	return (
		<div className="dashboard">
			<section className="dash-section">
				<div className="dash-section-head">
					<div className="dash-section-label">Overview</div>
					<div className="dash-toggles">
						{hasModelFilter && (
							<select className="model-select" aria-label="Model" value={model} onChange={(e) => setModel(e.target.value)}>
								<option value="all">All models</option>
								{data.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
							</select>
						)}
						<div className="range-toggle" role="group" aria-label="Time range">
							{RANGES.map((r) => (
								<button key={r.id} type="button" className={range === r.id ? "active" : ""} aria-pressed={range === r.id} onClick={() => setRange(r.id)}>
									{r.label}
								</button>
							))}
						</div>
						<a className="rs-btn rs-btn-sm export-btn" href="/api/usage/export.csv" download title="Download the full turn log as a CSV file">
							<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 1.5v6m0 0L3.5 5M6 7.5 8.5 5M1.5 9.5v1h9v-1" /></svg>
							CSV
						</a>
					</div>
				</div>
				<div className="kpis">
					<div className="kpi" title="Pay-per-token usage on API keys and gateways, at the provider's or gateway's published rates. Everything else on this page is an estimate at public API list prices.">
						<div className="label">Billed spend</div>
						<div className="value">{fmtPriced(billed, true)}</div>
						<div className="hint">
							{billed.cost === 0 ? (billedNote ?? "no pay-per-token usage") : `pay-per-token API usage${billedNote ? ` (${billedNote})` : ""}`}
							{data.previous ? ` (${delta(t.cost.billed, data.previous.cost.billed) ?? "no change"} vs prior)` : ""}
						</div>
					</div>
					<div className="kpi" title="What this usage would have cost at public API list prices. It ran on subscriptions you already pay for (ChatGPT, Copilot, Claude plans).">
						<div className="label">Covered by plans</div>
						<div className="value">{fmtEst(t.cost.plan)}</div>
						<div className="hint">list value of plan usage{data.previous ? ` (${delta(t.cost.plan, data.previous.cost.plan) ?? "no change"} vs prior)` : ""}</div>
					</div>
					<div className="kpi" title="Estimated list-price savings from cache reads, over the turns whose model price is known. Cached input is billed at a fraction of fresh input.">
						<div className="label">Caching saved</div>
						<div className="value">{fmtEst(t.cacheSavedEst)}</div>
						<div className="hint">{(t.cacheHitRate * 100).toFixed(0)}% of input read from cache</div>
					</div>
					<div className="kpi">
						<div className="label">Turns</div>
						<div className="value">{t.turns.toLocaleString()}</div>
						<div className="hint">
							{t.activeDays > 0 ? `${t.activeDays} active day${t.activeDays === 1 ? "" : "s"}, ` : ""}{fmtTok(t.input + t.output)} tokens
							{data.previous && turnsDelta !== 0 ? ` (${turnsDelta > 0 ? "+" : ""}${turnsDelta} vs prior)` : ""}
						</div>
					</div>
				</div>
			</section>

			<section className="dash-section">
				<div className="dash-section-label">Where usage comes from</div>
				<div className="chart-block">
					{data.sources.length === 0 && <div className="sub">No usage recorded yet. Send a prompt.</div>}
					{data.sources.length > 0 && (
						<>
							<div className="source-splitbar" aria-hidden="true">
								{data.sources.filter((s) => s.cost > 0).map((s, i) => (
									<div key={i} className={`seg-${s.source}`} style={{ width: `${est > 0 ? (s.cost / est) * 100 : 0}%` }} />
								))}
							</div>
							{liveSources.map((s, i) => (
								<SourceRow key={i} s={s} />
							))}
							{removedSources.length > 0 && (
								<>
									<button
										type="button"
										className="src-row src-row-fold"
										aria-expanded={removedOpen}
										onClick={() => setRemovedOpen((v) => !v)}
									>
										<span className="fold-caret" aria-hidden="true">{removedOpen ? "▾" : "▸"}</span>
										<span className="src-name">
											Removed gateways
											<span className="src-chip billed">Billed</span>
										</span>
										<span className="src-money">{fmtPriced(removedSum, removedSources.every((s) => s.source === "billed"))}</span>
										<span className="src-meta">
											{turnsNote(removedSum.turns)} across {removedSources.length} gateway{removedSources.length === 1 ? "" : "s"}
											{removedSum.cost > 0 && pricingNote(removedSum) ? ` (${pricingNote(removedSum)})` : ""}
										</span>
									</button>
									{removedOpen && removedSources.map((s, i) => <SourceRow key={i} s={s} indented />)}
								</>
							)}
							<div className="src-note">
								Estimated values use public API list prices. Gateway turns use the rates the gateway publishes; turns
								from before a price was on file are priced at today's rate and marked ≈. Memory upkeep, Ask your rooms
								answers and scheduled runs are recorded from July 2026; earlier upkeep was never persisted and is
								not included.
							</div>
						</>
					)}
				</div>
			</section>

			<section className="dash-section">
				<div className="dash-section-label">Activity</div>
				<div className="chart-grid">
					<div className="chart-block">
						<div className="chart-head with-toggle">
							<div>
								<h2>{activityTitle}</h2>
								<div className="sub">{activityMetric === "value" ? `Est. value per ${unit}, split by source.` : `Tokens per ${unit}.`}</div>
							</div>
							<div className="range-toggle" role="group" aria-label="Activity metric">
								<button type="button" className={activityMetric === "tokens" ? "active" : ""} aria-pressed={activityMetric === "tokens"} title="Chart token counts" onClick={() => setActivityMetric("tokens")}>Tokens</button>
								<button type="button" className={activityMetric === "value" ? "active" : ""} aria-pressed={activityMetric === "value"} title="Chart estimated cost at list prices" onClick={() => setActivityMetric("value")}>Value</button>
							</div>
						</div>
						<StackedChart buckets={buckets} metric={activityMetric} unit={unit} />
					</div>
					<div className="chart-block">
						<div className="chart-head">
							<h2>Rhythm</h2>
							<div className="sub">Turns by weekday and hour, local time.</div>
						</div>
						<RhythmHeatmap weekHour={data.weekHour} totalTurns={t.turns} />
					</div>
				</div>
			</section>

			<section className="dash-section">
				<div className="dash-section-label">Rooms</div>
				<div className="chart-block">
					<div className="sub bar-list-sub">Share of est. value. Select a room to scope the whole page.</div>
					{data.byAgent.length === 0 && <div className="sub">No usage recorded yet. Send a prompt.</div>}
					<BarList
						rows={activeRooms.map(roomRow)}
						shareBase={est}
						selected={agent}
						onSelect={(key) => setAgent(agent === key ? "all" : key)}
						expanded={agentsExpanded}
						onToggleExpanded={() => setAgentsExpanded((v) => !v)}
						collapseNoun="rooms"
						fold={retiredRooms.length > 0 ? {
							label: `Retired rooms (${retiredRooms.length})`,
							detail: `${fmtPriced(retiredSum, false)}, ${turnsNote(retiredSum.turns)}`,
							share: retiredSum.cost,
							rows: retiredRooms.map(roomRow),
							open: retiredOpen,
							onToggle: () => setRetiredOpen((v) => !v),
						} : undefined}
					/>
				</div>
			</section>

			<section className="dash-section">
				<div className="dash-section-label">Models</div>
				<div className="chart-block">
					<div className="sub bar-list-sub">One entry per model. Select a model to scope the whole page.</div>
					{data.byModel.length === 0 && <div className="sub">No usage recorded yet.</div>}
					<BarList
						rows={data.byModel.map((m) => ({
							key: m.id,
							name: m.label,
							share: m.cost,
							detail: `${fmtPriced(m, false)}, ${turnsNote(m.turns)}`,
							subDetail: pricingNote(m),
						}))}
						shareBase={est}
						selected={model}
						onSelect={(key) => setModel(model === key ? "all" : key)}
						expanded={modelsExpanded}
						onToggleExpanded={() => setModelsExpanded((v) => !v)}
						collapseNoun="models"
					/>
				</div>
			</section>

			{/* Plain <section> + controlled toggle. <details>/<summary>
			   collapsed weirdly inside the .dashboard flex column on some
			   browsers — rows rendered but were clipped. */}
			<section className="recent-block" data-open={recentOpen ? "true" : "false"}>
				<button
					type="button"
					className="recent-summary"
					aria-expanded={recentOpen}
					aria-controls="recent-turns-body"
					onClick={() => setRecentOpen((v) => !v)}
				>
					<span className="recent-title">Recent turns</span>
					{agent !== "all" && (
						<span
							className="recent-filter"
							role="button"
							tabIndex={0}
							title="Clear this filter"
							onClick={(e) => { e.stopPropagation(); setAgent("all"); }}
							onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); setAgent("all"); } }}
						>
							{nameOf(agent)} <CloseIcon size={12} />
						</span>
					)}
					<span className="recent-meta">{data.recent.length} entries, all time</span>
					<span className="recent-toggle" aria-hidden="true">{recentOpen ? "–" : "+"}</span>
				</button>
				{recentOpen && (
					<div id="recent-turns-body" className="recent-body">
						{/* The roles repeat the table's own: a phone shows each turn as a card
						    (19-wallet.css), and a table whose display changes loses its
						    semantics in some browsers unless they are stated. */}
						<table role="table">
							<thead role="rowgroup">
								<tr role="row">
									<th role="columnheader">When</th>
									<th role="columnheader">Room</th>
									<th role="columnheader">Model</th>
									<th role="columnheader">Source</th>
									<th role="columnheader">Kind</th>
									<th role="columnheader">↑ In</th>
									<th role="columnheader">↓ Out</th>
									<th role="columnheader">Value</th>
								</tr>
							</thead>
							<tbody role="rowgroup">
								{data.recent.map((r, i) => (
									<tr key={i} role="row">
										<td role="cell">{fmtAgo(r.ts)}</td>
										<td role="cell" className="first">{nameOf(r.agent)}</td>
										<td role="cell" title={modelCellTitle(r)}>{modelCell(r)}</td>
										<td role="cell">{sourceCell(r)}</td>
										<td role="cell"><span className="kind-chip">{KIND_LABELS[r.kind ?? "chat"] ?? r.kind}</span></td>
										<td role="cell" title={turnTokensTitle(r)}>{fmtTok(allInput(r))}{cacheWords(r, fmtTok) && <span className="recent-cache-note">({cacheWords(r, fmtTok)})</span>}</td>
										<td role="cell">{fmtTok(r.output)}</td>
										<td role="cell">{fmtPriced(rowPriced(r), r.authType === "api_key")}</td>
									</tr>
								))}
								{data.recent.length === 0 && (
									<tr role="row">
										<td role="cell" colSpan={8}>{agent !== "all" ? "No turns for this room." : "No turns yet."}</td>
									</tr>
								)}
							</tbody>
						</table>
					</div>
				)}
			</section>

			<div className="dash-footer">Everything on this page is measured locally on this machine and never leaves it.</div>
		</div>
	);
}

/** One source line; removed gateways reuse it indented under their fold. */
function SourceRow({ s, indented }: { s: UsagePayload["sources"][number]; indented?: boolean }) {
	return (
		<div className={`src-row${indented ? " src-row-inner" : ""}`}>
			<span className={`src-dot seg-${s.source}`} />
			<span className="src-name">
				{s.name}
				<span className={`src-chip ${s.source}`}>{SOURCE_CHIP[s.source]}</span>
			</span>
			<span className="src-money">{fmtPriced(s, s.source === "billed")}</span>
			<span className="src-meta">
				{turnsNote(s.turns)}
				{s.source === "billed" && s.cost > 0 && pricingNote(s) ? ` (${pricingNote(s)})` : ""}
				{s.source === "plan" ? ", included in your subscription" : ""}
				{s.source === "unattributed" ? ", recorded before provider tracking" : ""}
			</span>
		</div>
	);
}

// The words for each background kind inside a sentence; the kind ids are stored and never shown.
const BACKGROUND_KIND_WORDS: Record<string, string> = {
	upkeep: "upkeep",
	consult: "consult",
	scheduled: "scheduled",
	hivemind: KIND_LABELS.hivemind,
	cli: "cli",
};

/** "incl. upkeep ≈ $0.12 over 6 runs" line under a room with background kinds. */
function backgroundKindsNote(kinds: Record<string, Priced>): string | undefined {
	const parts: string[] = [];
	for (const [kind, words] of Object.entries(BACKGROUND_KIND_WORDS)) {
		const k = kinds[kind];
		if (!k || k.turns === 0) continue;
		parts.push(`${words} ${fmtPriced(k, false)} over ${k.turns} run${k.turns === 1 ? "" : "s"}`);
	}
	return parts.length ? `incl. ${parts.join(", ")}` : undefined;
}

/**
 * The turn's tokens and value in full numbers: "9,413 in (9,409 stored for
 * reuse), 44 out, $0.05". A cost under a cent shows to three decimals
 * ("$0.001"), where the table's cell says "<$0.01".
 */
function turnTokensTitle(r: UsageRow): string {
	const full = (tokens: number) => tokens.toLocaleString("en-US");
	const cache = cacheWords(r, full);
	const priced = rowPriced(r);
	const exact = r.authType === "api_key" && priced.estimatedTurns === 0;
	const cost = priced.cost >= 0.01 ? fmtCost(priced.cost) : priced.cost >= 0.001 ? `$${priced.cost.toFixed(3)}` : "<$0.001";
	const value = priced.cost === 0 ? (priced.unpricedTurns > 0 ? "no price on file" : "$0.00") : `${exact ? "" : "≈ "}${cost}`;
	return `${full(allInput(r))} in${cache ? ` (${cache})` : ""}, ${full(r.output)} out, ${value}`;
}

/** One ledger row as the three-state money helper sees it. */
function rowPriced(r: UsageRow): Priced {
	const moved = r.input + r.output + r.cacheRead + (r.cacheWrite || 0) > 0;
	return { cost: r.cost, turns: 1, estimatedTurns: r.estimated ? 1 : 0, unpricedTurns: r.cost === 0 && moved && !r.estimated ? 1 : 0 };
}

interface BarListRow {
	key: string;
	name: string;
	tag?: string;
	/** What the bar's share counts: money on the Wallet, tokens on a shared server. */
	share: number;
	detail: string;
	subDetail?: string;
}

/** Rows folded behind one quiet header row below the list; no rows, no fold. */
interface BarListFold {
	label: string;
	detail: string;
	share: number;
	rows: BarListRow[];
	open: boolean;
	onToggle: () => void;
}

function BarList({
	rows,
	shareBase,
	selected,
	onSelect,
	expanded,
	onToggleExpanded,
	collapseNoun,
	fold,
}: {
	rows: BarListRow[];
	shareBase: number;
	selected: string;
	onSelect: (key: string) => void;
	expanded: boolean;
	onToggleExpanded: () => void;
	collapseNoun: string;
	fold?: BarListFold;
}) {
	const collapsible = rows.length > BAR_COLLAPSE_LIMIT + 1;
	const visible = collapsible && !expanded ? rows.filter((r, i) => i < BAR_COLLAPSE_LIMIT || r.key === selected) : rows;
	const pct = (cost: number) => (shareBase > 0 ? (cost / shareBase) * 100 : 0);
	// A selected folded row keeps the fold open so the active filter never hides.
	const foldSelected = fold != null && fold.rows.some((r) => r.key === selected);
	const foldOpen = fold != null && (fold.open || foldSelected);
	const renderRow = (r: BarListRow, folded = false) => {
		const sharePct = pct(r.share);
		const isSelected = selected === r.key;
		return (
			<div key={r.key} className={folded ? "bar-fold-row" : undefined}>
				<button
					type="button"
					className={`bar-row${isSelected ? " selected" : ""}${selected !== "all" && !isSelected ? " dim" : ""}`}
					aria-pressed={isSelected}
					onClick={() => onSelect(r.key)}
				>
					<div className="name">
						{r.name}
						{r.tag && <span className="bar-tag">{r.tag}</span>}
					</div>
					<div className="bar-track"><div className="bar-fill" style={{ width: `${sharePct}%` }} /></div>
					<div className="pct">{sharePct.toFixed(1)}%</div>
					<div className="num">{r.detail}</div>
				</button>
				{r.subDetail && <div className="bar-subdetail">{r.subDetail}</div>}
			</div>
		);
	};
	return (
		<>
			{visible.map((r) => renderRow(r))}
			{collapsible && (
				<button type="button" className="bar-row-more" onClick={onToggleExpanded}>
					{expanded ? `Show top ${collapseNoun} only` : `Show all ${rows.length} ${collapseNoun}`}
				</button>
			)}
			{fold && fold.rows.length > 0 && (
				<>
					<button
						type="button"
						className={`bar-row bar-row-fold${selected !== "all" && !foldSelected ? " dim" : ""}`}
						aria-expanded={foldOpen}
						onClick={fold.onToggle}
					>
						<div className="name">
							<span className="fold-caret" aria-hidden="true">{foldOpen ? "▾" : "▸"}</span>
							{fold.label}
						</div>
						<div className="bar-track"><div className="bar-fill" style={{ width: `${pct(fold.share)}%` }} /></div>
						<div className="pct">{pct(fold.share).toFixed(1)}%</div>
						<div className="num">{fold.detail}</div>
					</button>
					{foldOpen && fold.rows.map((r) => renderRow(r, true))}
				</>
			)}
		</>
	);
}

// Stacked bars: unattributed (gray) under plan (lila) under billed (ink), so
// real money always sits on top of the estimate layers.
function StackedChart({ buckets, metric, unit }: { buckets: SeriesBucket[]; metric: "tokens" | "value"; unit: string }) {
	const W = 640;
	const H = 160;
	const pad = { top: 12, bottom: 6, side: 6 };
	const innerH = H - pad.top - pad.bottom;
	const val = (b: SeriesBucket) => (metric === "value" ? b.billed + b.plan + b.unattributed : b.tokens);
	const fmtVal = (n: number) => (metric === "value" ? fmtEst(n) : fmtTok(n));
	const max = Math.max(1e-9, ...buckets.map(val));
	const step = (W - 2 * pad.side) / buckets.length;
	const barW = Math.max(2, step * 0.62);
	const total = buckets.reduce((s, b) => s + val(b), 0);
	const totalTurns = buckets.reduce((s, b) => s + b.turns, 0);

	if (total === 0) return <div className="chart-empty">No activity in this range.</div>;

	const mid = Math.floor((buckets.length - 1) / 2);
	const axis = buckets.length <= 1 ? [buckets[0].label] : [buckets[0].label, buckets[mid].label, buckets[buckets.length - 1].label];

	return (
		<div className="chart-wrap">
			<svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="chart-svg" role="img" aria-label={metric === "value" ? "Estimated value per period by source" : "Tokens per period"}>
				<line x1={pad.side} y1={pad.top + innerH} x2={W - pad.side} y2={pad.top + innerH} stroke="currentColor" />
				{buckets.map((b, i) => {
					const v = val(b);
					if (v <= 0) return null;
					const x = pad.side + i * step + (step - barW) / 2;
					const hTot = Math.max(2, (v / max) * innerH);
					const title = `${b.label}: ${fmtVal(v)}, ${b.turns} turn${b.turns === 1 ? "" : "s"}`;
					if (metric === "tokens") {
						return (
							<g key={i}>
								<title>{title}</title>
								<rect x={x} y={pad.top + innerH - hTot} width={barW} height={hTot} fill="currentColor" />
							</g>
						);
					}
					let y = pad.top + innerH;
					const segs: { cls: string; v: number }[] = [
						{ cls: "seg-unattributed", v: b.unattributed },
						{ cls: "seg-plan", v: b.plan },
						{ cls: "seg-billed", v: b.billed },
					];
					return (
						<g key={i}>
							<title>{title}</title>
							{segs.map((seg, j) => {
								if (seg.v <= 0) return null;
								const h = Math.max(1.5, (seg.v / v) * hTot);
								y -= h;
								return <rect key={j} className={seg.cls} x={x} y={y} width={barW} height={h} />;
							})}
						</g>
					);
				})}
			</svg>
			<div className="chart-axis">
				{axis.map((l, i) => <span key={i}>{l}</span>)}
			</div>
			<div className="chart-legend">
				{metric === "value" && (
					<>
						<span className="lg"><i className="seg-unattributed" />earlier</span>
						<span className="lg"><i className="seg-plan" />plans</span>
						<span className="lg"><i className="seg-billed" />billed</span>
					</>
				)}
				<span><strong>{fmtVal(total)}</strong> {metric === "value" ? "total value" : "tokens"}</span>
				<span><strong>{totalTurns.toLocaleString()}</strong> turn{totalTurns === 1 ? "" : "s"}</span>
				<span>peak <strong>{fmtVal(max)}</strong>/{unit}</span>
			</div>
		</div>
	);
}

function RhythmHeatmap({ weekHour, totalTurns }: { weekHour: number[][]; totalTurns: number }) {
	const W = 640;
	const H = 160;
	const labelW = 30;
	const pad = { top: 12, bottom: 14 };
	const DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
	const DAY_FULL = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
	const max = Math.max(1, ...weekHour.flat());
	const cellW = (W - labelW - 6) / 24;
	const cellH = (H - pad.top - pad.bottom) / 7;
	const hourTotals = Array.from({ length: 24 }, (_, h) => weekHour.reduce((s, d) => s + d[h], 0));
	const peakHour = hourTotals.indexOf(Math.max(...hourTotals));
	// Hovered cell + tooltip anchor in .chart-wrap pixel coordinates. The svg
	// scales with preserveAspectRatio="none", so the cell under the mouse is
	// recovered by mapping the pointer back into viewBox space.
	const [tip, setTip] = useState<{ day: number; hour: number; x: number; y: number } | null>(null);

	if (totalTurns === 0) return <div className="chart-empty">No turns recorded yet.</div>;

	const onMove = (e: ReactMouseEvent<SVGSVGElement>) => {
		const rect = e.currentTarget.getBoundingClientRect();
		const sx = ((e.clientX - rect.left) / rect.width) * W;
		const sy = ((e.clientY - rect.top) / rect.height) * H;
		const hour = Math.floor((sx - labelW) / cellW);
		const day = Math.floor((sy - pad.top) / cellH);
		if (hour < 0 || hour > 23 || day < 0 || day > 6) {
			setTip(null);
			return;
		}
		// Anchor above the cell's centre and clamp so the tooltip stays inside.
		const x = Math.min(Math.max(((labelW + (hour + 0.5) * cellW) / W) * rect.width, 78), rect.width - 78);
		const y = ((pad.top + day * cellH) / H) * rect.height;
		setTip({ day, hour, x, y });
	};

	const hh = (h: number) => String(h % 24).padStart(2, "0") + ":00";
	const tipValue = tip ? weekHour[tip.day][tip.hour] : 0;

	return (
		<div className="chart-wrap heat-hover-wrap">
			<svg
				viewBox={`0 0 ${W} ${H}`}
				preserveAspectRatio="none"
				className="chart-svg"
				role="img"
				aria-label="Turns by weekday and hour"
				onMouseMove={onMove}
				onMouseLeave={() => setTip(null)}
			>
				{DAYS.map((d, r) => (
					<text key={d} x={2} y={pad.top + r * cellH + cellH / 2 + 3} className="heat-label">{d}</text>
				))}
				{/* Every slot gets a base cell so empty hours read as explicitly
				   empty instead of blending into the page background; counts
				   overlay it with an intensity ramp. */}
				{weekHour.map((dayRow, r) =>
					dayRow.map((v, c) => {
						const x = labelW + c * cellW;
						const y = pad.top + r * cellH;
						const w = Math.max(1, cellW - 2);
						const h = Math.max(1, cellH - 2);
						// sqrt scale keeps low counts visible next to the peak
						const opacity = v > 0 ? 0.25 + 0.75 * Math.sqrt(v / max) : 0;
						const hovered = tip !== null && tip.day === r && tip.hour === c;
						return (
							<g key={`${r}-${c}`}>
								<rect className="heat-cell-empty" x={x} y={y} width={w} height={h} rx={2} />
								{v > 0 && <rect x={x} y={y} width={w} height={h} rx={2} fill="currentColor" opacity={opacity} />}
								{hovered && <rect className="heat-cell-hover" x={x} y={y} width={w} height={h} rx={2} />}
							</g>
						);
					}),
				)}
			</svg>
			{tip && (
				<div className="heat-tip" style={{ left: tip.x, top: tip.y }} role="status">
					<div className="heat-tip-when">{DAY_FULL[tip.day]} {hh(tip.hour)} to {hh(tip.hour + 1)}</div>
					<div className="heat-tip-value">{tipValue === 0 ? "no turns" : `${tipValue} turn${tipValue === 1 ? "" : "s"}`}</div>
				</div>
			)}
			<div className="chart-axis heat-axis">
				{["00", "06", "12", "18", "23"].map((l) => <span key={l}>{l}</span>)}
			</div>
			<div className="chart-legend">
				<span><strong>{totalTurns.toLocaleString()}</strong> turns</span>
				<span>peak hour <strong>{String(peakHour).padStart(2, "0")}:00</strong></span>
				<span className="lg heat-ramp" aria-label="Cell shading intensity increases with the number of turns">
					none <i className="empty" /><i style={{ opacity: 0.3 }} /><i style={{ opacity: 0.6 }} /><i style={{ opacity: 1 }} /> more
				</span>
			</div>
		</div>
	);
}

// --- On a shared server: turns and tokens, no money ---------------------------
// Every token count here is all of it: input with the prompt cache, plus output.

interface TokenTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	turns: number;
	activeDays: number;
}

interface TokenBucket {
	label: string;
	ts?: number;
	turns: number;
	tokens: number;
}

interface TokenModel {
	id: string;
	label: string;
	rawIds: number;
	turns: number;
	tokens: number;
}

/** One turn of the person's own, as `/api/usage/mine` gives it: no money, no person. */
interface OwnTurn extends ModelFields {
	ts: number;
	agent: string;
	kind?: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

interface OwnUsagePayload {
	range: Range;
	model: string;
	models: { id: string; label: string; turns: number; rawIds: number }[];
	agent: string;
	/** The names of the person's rooms that still exist, archived ones included; a room with none is deleted. */
	agentNames: Record<string, string>;
	totals: TokenTotals;
	previous: { turns: number; tokens: number } | null;
	byAgent: { agent: string; retired: boolean; turns: number; tokens: number; kinds: Record<string, { turns: number }> }[];
	byModel: TokenModel[];
	series: { kind: "hourly" | "daily"; buckets: TokenBucket[] };
	weekHour: number[][];
	/** The newest turns after the filters, and how many there are in all. */
	recent: { rows: OwnTurn[]; total: number };
}

interface CompanyUsagePayload {
	range: CompanyRange;
	model: string;
	models: { id: string; label: string; turns: number; rawIds: number }[];
	totals: TokenTotals;
	byModel: TokenModel[];
	series: { kind: "daily"; buckets: TokenBucket[] };
}

type CompanyRange = "7d" | "30d" | "all";
const COMPANY_RANGES: { id: CompanyRange; label: string }[] = RANGES.filter((r): r is { id: CompanyRange; label: string } => r.id !== "24h");

/**
 * What a part's last answer was. A refusal is apart from a failure: the
 * company's routes refuse anyone who is no longer the admin, and that part
 * then goes and asks no more.
 */
type PartAnswer<T> = { kind: "waiting" } | { kind: "shown"; data: T } | { kind: "failed" } | { kind: "refused" };

/**
 * Asks now and each time the tab is shown again, never on a timer: on a shared
 * server a read of the usage log costs everyone, so it runs only when someone
 * looks. A hidden tab asks nothing.
 */
function askWhenShown(ask: () => void): () => void {
	const onShow = () => {
		if (!document.hidden) ask();
	};
	onShow();
	document.addEventListener("visibilitychange", onShow);
	return () => document.removeEventListener("visibilitychange", onShow);
}

function useUsageAnswer<T>(url: string): { answer: PartAnswer<T>; askAgain: () => void } {
	const [answer, setAnswer] = useState<PartAnswer<T>>({ kind: "waiting" });
	const [asked, setAsked] = useState(0);
	useEffect(() => {
		let cancelled = false;
		let refused = false;
		let requestSeq = 0;
		const stop = askWhenShown(() => {
			if (refused) return;
			// A slow older answer must not overwrite a newer one.
			const seq = ++requestSeq;
			apiFetch(url)
				.then(async (r): Promise<PartAnswer<T>> => (r.ok ? { kind: "shown", data: await r.json() } : r.status === 403 ? { kind: "refused" } : { kind: "failed" }))
				.catch((): PartAnswer<T> => ({ kind: "failed" }))
				.then((next) => {
					if (cancelled || seq !== requestSeq) return;
					if (next.kind === "refused") refused = true;
					setAnswer(next);
				});
		});
		return () => { cancelled = true; stop(); };
	}, [url, asked]);
	const askAgain = () => {
		setAnswer({ kind: "waiting" });
		setAsked((n) => n + 1);
	};
	return { answer, askAgain };
}

/** In place of a part whose usage the server could not give, with the one way on. */
function UsageUnreadable({ onTryAgain }: { onTryAgain: () => void }) {
	return (
		<div className="sub usage-unreadable">
			<span>{SHARED_USAGE_UNREADABLE}</span> <button type="button" className="rs-btn rs-btn-sm" onClick={onTryAgain}>Try again</button>
		</div>
	);
}

function RangeToggle<R extends string>({ ranges, value, onChange }: { ranges: { id: R; label: string }[]; value: R; onChange: (range: R) => void }) {
	return (
		<div className="range-toggle" role="group" aria-label="Time range">
			{ranges.map((r) => (
				<button key={r.id} type="button" className={value === r.id ? "active" : ""} aria-pressed={value === r.id} onClick={() => onChange(r.id)}>
					{r.label}
				</button>
			))}
		</div>
	);
}

function ModelSelect({ models, value, onChange }: { models: { id: string; label: string }[]; value: string; onChange: (model: string) => void }) {
	if (models.length <= 1) return null;
	return (
		<select className="model-select" aria-label="Model" value={value} onChange={(e) => onChange(e.target.value)}>
			<option value="all">All models</option>
			{models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
		</select>
	);
}

function rangeTitle(range: Range): string {
	return range === "24h" ? "Last 24 hours" : range === "7d" ? "Last 7 days" : range === "30d" ? "Last 30 days" : "All time";
}

/** Turns, all input and output: the three counts a shared server shows. */
function TokenKpis({ totals, previous }: { totals: TokenTotals; previous?: { turns: number } | null }) {
	const input = allInput(totals);
	const turnsDelta = previous ? totals.turns - previous.turns : 0;
	return (
		<div className="kpis">
			<div className="kpi">
				<div className="label">Turns</div>
				<div className="value">{totals.turns.toLocaleString()}</div>
				<div className="hint">
					{totals.activeDays} active day{totals.activeDays === 1 ? "" : "s"}
					{previous && turnsDelta !== 0 ? ` (${turnsDelta > 0 ? "+" : ""}${turnsDelta} vs prior)` : ""}
				</div>
			</div>
			<div className="kpi">
				<div className="label">Tokens in</div>
				<div className="value">{fmtTok(input)}</div>
				<div className="hint">{input > 0 ? ((totals.cacheRead / input) * 100).toFixed(0) : 0}% of input read from cache</div>
			</div>
			<div className="kpi">
				<div className="label">Tokens out</div>
				<div className="value">{fmtTok(totals.output)}</div>
			</div>
		</div>
	);
}

/** The activity chart in its tokens form; a shared server has no money to split by. */
function TokenChart({ buckets, unit }: { buckets: TokenBucket[]; unit: string }) {
	return <StackedChart buckets={buckets.map((b) => ({ ...b, billed: 0, plan: 0, unattributed: 0 }))} metric="tokens" unit={unit} />;
}

function tokensDetail(tokens: number, turns: number): string {
	return `${fmtTok(tokens)} tokens, ${turnsNote(turns)}`;
}

/** "incl. upkeep over 6 runs" under a room with background kinds, without money. */
function backgroundKindsTurns(kinds: Record<string, { turns: number }>): string | undefined {
	const parts: string[] = [];
	for (const [kind, words] of Object.entries(BACKGROUND_KIND_WORDS)) {
		const turns = kinds[kind]?.turns ?? 0;
		if (turns > 0) parts.push(`${words} over ${turns} run${turns === 1 ? "" : "s"}`);
	}
	return parts.length ? `incl. ${parts.join(", ")}` : undefined;
}

/** The person's own usage, then, for the admin, the company's totals below it. */
function SharedUsage({ admin }: { admin: boolean }) {
	return (
		<div className="dashboard">
			<OwnUsage />
			{admin && <CompanyUsage />}
			{/* What the admin sees, said to the people it is about; the admin's own part shows it. */}
			{!admin && <div className="dash-footer shared-usage-footer">{SHARED_USAGE_FOOTER}</div>}
		</div>
	);
}

function OwnUsage() {
	const [range, setRange] = useState<Range>("all");
	const [model, setModel] = useState("all");
	const [agent, setAgent] = useState("all");
	const [recentOpen, setRecentOpen] = useState(false);
	const [earlierOpen, setEarlierOpen] = useState(false);
	const [agentsExpanded, setAgentsExpanded] = useState(false);
	const [modelsExpanded, setModelsExpanded] = useState(false);
	const { answer, askAgain } = useUsageAnswer<OwnUsagePayload>(`/api/usage/mine?range=${range}&model=${encodeURIComponent(model)}&agent=${encodeURIComponent(agent)}`);

	if (answer.kind === "waiting") return <div className="sub">Loading…</div>;
	if (answer.kind === "refused") return <div className="sub">{SHARED_USAGE_UNREADABLE}</div>;
	if (answer.kind === "failed") return <UsageUnreadable onTryAgain={askAgain} />;
	const data = answer.data;
	if (data.recent.total === 0 && data.model === "all" && data.agent === "all") return <div className="sub">{SHARED_USAGE_EMPTY}</div>;

	const t = data.totals;
	const unit = data.series.kind === "hourly" ? "hour" : "day";
	const allTokens = allInput(t) + t.output;
	// A room with no name is gone, or its record can't be read: it is never shown by its id.
	const nameOf = (id: string): string => (id === "hivemind:memory" ? KIND_LABELS.hivemind : data.agentNames[id] ?? SHARED_USAGE_UNAVAILABLE_ROOM);
	const isActiveRoom = (a: OwnUsagePayload["byAgent"][number]): boolean => !a.retired || a.agent === "hivemind:memory";
	const activeRooms = data.byAgent.filter(isActiveRoom);
	const earlierRooms = data.byAgent.filter((a) => !isActiveRoom(a));
	const earlierTokens = earlierRooms.reduce((sum, a) => sum + a.tokens, 0);
	const earlierTurns = earlierRooms.reduce((sum, a) => sum + a.turns, 0);
	const roomRow = (a: OwnUsagePayload["byAgent"][number]): BarListRow => ({
		key: a.agent,
		name: nameOf(a.agent),
		tag: a.agent === "hivemind:memory" ? "memory chat" : a.retired && data.agentNames[a.agent] ? "archived" : undefined,
		share: a.tokens,
		detail: tokensDetail(a.tokens, a.turns),
		subDetail: a.agent === "hivemind:memory" ? undefined : backgroundKindsTurns(a.kinds),
	});
	const shown = data.recent.rows.length;

	return (
		<>
			<section className="dash-section">
				<div className="dash-section-head">
					<div className="dash-section-label">Overview</div>
					<div className="dash-toggles">
						<ModelSelect models={data.models} value={model} onChange={setModel} />
						<RangeToggle ranges={RANGES} value={range} onChange={setRange} />
					</div>
				</div>
				<TokenKpis totals={t} previous={data.previous} />
			</section>

			<section className="dash-section">
				<div className="dash-section-label">Activity</div>
				<div className="chart-grid">
					<div className="chart-block">
						<div className="chart-head">
							<h2>{rangeTitle(range)}</h2>
							<div className="sub">{unit === "hour" ? "Tokens per hour." : "Tokens per day."}</div>
						</div>
						<TokenChart buckets={data.series.buckets} unit={unit} />
					</div>
					<div className="chart-block">
						<div className="chart-head">
							<h2>Rhythm</h2>
							<div className="sub">Turns by weekday and hour, local time.</div>
						</div>
						<RhythmHeatmap weekHour={data.weekHour} totalTurns={t.turns} />
					</div>
				</div>
			</section>

			<section className="dash-section">
				<div className="dash-section-label">Rooms</div>
				<div className="chart-block">
					<div className="sub bar-list-sub">{SHARED_USAGE_ROOMS_HINT}</div>
					<BarList
						rows={activeRooms.map(roomRow)}
						shareBase={allTokens}
						selected={agent}
						onSelect={(key) => setAgent(agent === key ? "all" : key)}
						expanded={agentsExpanded}
						onToggleExpanded={() => setAgentsExpanded((v) => !v)}
						collapseNoun="rooms"
						fold={earlierRooms.length > 0 ? {
							label: `Earlier rooms (${earlierRooms.length})`,
							detail: tokensDetail(earlierTokens, earlierTurns),
							share: earlierTokens,
							rows: earlierRooms.map(roomRow),
							open: earlierOpen,
							onToggle: () => setEarlierOpen((v) => !v),
						} : undefined}
					/>
				</div>
			</section>

			<section className="dash-section">
				<div className="dash-section-label">Models</div>
				<div className="chart-block">
					<div className="sub bar-list-sub">{SHARED_USAGE_MODELS_HINT}</div>
					<BarList
						rows={data.byModel.map((m) => ({ key: m.id, name: m.label, share: m.tokens, detail: tokensDetail(m.tokens, m.turns) }))}
						shareBase={allTokens}
						selected={model}
						onSelect={(key) => setModel(model === key ? "all" : key)}
						expanded={modelsExpanded}
						onToggleExpanded={() => setModelsExpanded((v) => !v)}
						collapseNoun="models"
					/>
				</div>
			</section>

			<section className="recent-block" data-open={recentOpen ? "true" : "false"}>
				<button type="button" className="recent-summary" aria-expanded={recentOpen} aria-controls="recent-turns-body" onClick={() => setRecentOpen((v) => !v)}>
					<span className="recent-title">Recent turns</span>
					{agent !== "all" && (
						<span
							className="recent-filter"
							role="button"
							tabIndex={0}
							title="Clear this filter"
							onClick={(e) => { e.stopPropagation(); setAgent("all"); }}
							onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); setAgent("all"); } }}
						>
							{nameOf(agent)} <CloseIcon size={12} />
						</span>
					)}
					<span className="recent-meta">{shown < data.recent.total ? `Newest ${shown} of ${data.recent.total.toLocaleString()}` : turnsNote(data.recent.total)}</span>
					<span className="recent-toggle" aria-hidden="true">{recentOpen ? "–" : "+"}</span>
				</button>
				{recentOpen && (
					<div id="recent-turns-body" className="recent-body recent-tokens">
						<table role="table">
							<thead role="rowgroup">
								<tr role="row">
									<th role="columnheader">When</th>
									<th role="columnheader">Room</th>
									<th role="columnheader">Model</th>
									<th role="columnheader">Kind</th>
									<th role="columnheader">↑ In</th>
									<th role="columnheader">↓ Out</th>
								</tr>
							</thead>
							<tbody role="rowgroup">
								{data.recent.rows.map((r, i) => (
									<tr key={i} role="row">
										<td role="cell">{fmtAgo(r.ts)}</td>
										<td role="cell" className="first">{nameOf(r.agent)}</td>
										<td role="cell" title={modelCellTitle(r)}>{modelCell(r)}</td>
										<td role="cell"><span className="kind-chip">{KIND_LABELS[r.kind ?? "chat"] ?? r.kind}</span></td>
										<td role="cell">{fmtTok(allInput(r))}{cacheWords(r, fmtTok) && <span className="recent-cache-note">({cacheWords(r, fmtTok)})</span>}</td>
										<td role="cell">{fmtTok(r.output)}</td>
									</tr>
								))}
								{shown === 0 && (
									<tr role="row">
										<td role="cell" colSpan={6}>{agent !== "all" ? "No turns for this room." : "No turns yet."}</td>
									</tr>
								)}
							</tbody>
						</table>
					</div>
				)}
			</section>
		</>
	);
}

/** The admin's part: everyone's usage together, by day and by model, up to yesterday. */
function CompanyUsage() {
	const [range, setRange] = useState<CompanyRange>("all");
	const [model, setModel] = useState("all");
	const [modelsExpanded, setModelsExpanded] = useState(false);
	const { answer, askAgain } = useUsageAnswer<CompanyUsagePayload>(`/api/usage?range=${range}&model=${encodeURIComponent(model)}`);
	// No longer the admin: the part goes, and its routes are asked no more.
	if (answer.kind === "refused") return null;
	const data = answer.kind === "shown" ? answer.data : null;
	const allTokens = data ? allInput(data.totals) + data.totals.output : 0;
	// Only the whole log can say there is none: a row with no model counts in the turns but not in the models.
	const noUsage = data !== null && data.range === "all" && data.models.length === 0 && data.totals.turns === 0;

	return (
		<section className="dash-section company-usage">
			<div className="dash-section-head">
				<div>
					<h2 className="company-usage-title">{COMPANY_USAGE_TITLE}</h2>
					<div className="sub">{COMPANY_USAGE_LINE}</div>
				</div>
				{data && !noUsage && (
					<div className="dash-toggles">
						<ModelSelect models={data.models} value={model} onChange={setModel} />
						<RangeToggle ranges={COMPANY_RANGES} value={range} onChange={setRange} />
						<a className="rs-btn rs-btn-sm export-btn" href="/api/usage/export.csv" download title={COMPANY_USAGE_CSV_HOVER}>
							<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 1.5v6m0 0L3.5 5M6 7.5 8.5 5M1.5 9.5v1h9v-1" /></svg>
							CSV
						</a>
					</div>
				)}
			</div>
			{answer.kind === "waiting" && <div className="sub">Loading…</div>}
			{answer.kind === "failed" && <UsageUnreadable onTryAgain={askAgain} />}
			{noUsage && <div className="sub">{COMPANY_USAGE_EMPTY}</div>}
			{data && !noUsage && (
				<>
					<TokenKpis totals={data.totals} />
					<div className="chart-block">
						<div className="chart-head">
							<h2>{rangeTitle(range)}</h2>
							<div className="sub">Tokens per day.</div>
						</div>
						<TokenChart buckets={data.series.buckets} unit="day" />
					</div>
					<div className="chart-block">
						<div className="chart-head">
							<h2>Models</h2>
							<div className="sub">One entry per model. Select a model to scope this part.</div>
						</div>
						<BarList
							rows={data.byModel.map((m) => ({ key: m.id, name: m.label, share: m.tokens, detail: tokensDetail(m.tokens, m.turns) }))}
							shareBase={allTokens}
							selected={model}
							onSelect={(key) => setModel(model === key ? "all" : key)}
							expanded={modelsExpanded}
							onToggleExpanded={() => setModelsExpanded((v) => !v)}
							collapseNoun="models"
						/>
					</div>
				</>
			)}
		</section>
	);
}
