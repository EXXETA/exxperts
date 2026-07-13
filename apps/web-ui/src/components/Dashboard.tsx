import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import { agentLabel } from "../types";
import { modelDisplayName } from "../model-names";

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
	provider?: string;
	authType?: "oauth" | "api_key";
	kind?: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
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
		cacheHitRate: number;
		activeDays: number;
	};
	previous: { cost: SourceSplit; turns: number; tokens: number } | null;
	sources: { source: UsageSource; name: string; cost: number; turns: number }[];
	byAgent: { agent: string; retired: boolean; cost: number; turns: number; input: number; output: number; kinds: Record<string, { cost: number; turns: number }> }[];
	byModel: { id: string; label: string; rawIds: number; cost: number; turns: number; tokens: number }[];
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

const KIND_LABELS: Record<string, string> = {
	chat: "chat",
	upkeep: "upkeep",
	scheduled: "scheduled",
	hivemind: "hivemind",
	cli: "cli",
	consult: "consult",
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

/** Short source name for the recent-turns table. */
const PROVIDER_SHORT: Record<string, string> = {
	"openai-codex": "ChatGPT",
	"github-copilot": "Copilot",
	anthropic: "Claude",
	openai: "OpenAI",
	"openai-compatible": "gateway",
	google: "Gemini",
	openrouter: "OpenRouter",
};

function modelCell(row: UsageRow): string {
	return modelDisplayName(row) || "?";
}

// Mirrors the server's sourceOfRow: authType is exact; without it only the
// OAuth-only channels (ChatGPT, Copilot) may be called plans — anything else
// stays a bare provider name so the table never contradicts the KPIs.
function sourceCell(row: UsageRow): string {
	if (row.authType === "api_key") return "API key";
	const short = row.provider ? PROVIDER_SHORT[row.provider] ?? row.provider : row.modelLabel?.split(" — ")[0];
	if (row.authType === "oauth") return short ? short + " plan" : "plan";
	if (row.modelLabel?.startsWith("ChatGPT Plus/Pro") || row.provider === "openai-codex") return "ChatGPT plan";
	if (row.modelLabel?.startsWith("GitHub Copilot") || row.provider === "github-copilot") return "Copilot plan";
	return short ?? "unknown";
}

export function Dashboard() {
	const [data, setData] = useState<UsagePayload | null>(null);
	const [recentOpen, setRecentOpen] = useState(false);
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
			fetch(`/api/usage?range=${range}&model=${encodeURIComponent(model)}&agent=${encodeURIComponent(agent)}`)
				.then((r) => r.json())
				.then((d) => { if (!cancelled && seq === requestSeq) setData(d); })
				.catch(() => {});
		};
		load();
		const id = setInterval(load, 5000);
		return () => { cancelled = true; clearInterval(id); };
	}, [range, model, agent]);

	if (!data) return <div className="dashboard"><div className="sub">Loading…</div></div>;

	const t = data.totals;
	const est = totalCost(t.cost);
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
	const nameOf = (id: string): string => (id === "hivemind:memory" ? "HiveMind" : data.agentNames?.[id] ?? agentLabel(id));

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
						<a className="export-btn" href="/api/usage/export.csv" download title="Download the full turn log as a CSV file">
							<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 1.5v6m0 0L3.5 5M6 7.5 8.5 5M1.5 9.5v1h9v-1" /></svg>
							CSV
						</a>
					</div>
				</div>
				<div className="kpis">
					<div className="kpi" title="Real pay-per-token spend on API keys. Everything else on this page is an estimate at public API list prices.">
						<div className="label">Billed spend</div>
						<div className="value">{fmtCost(t.cost.billed)}</div>
						<div className="hint">{t.cost.billed === 0 ? "no pay-per-token usage" : "pay-per-token API usage"}{data.previous ? ` (${delta(t.cost.billed, data.previous.cost.billed) ?? "no change"} vs prior)` : ""}</div>
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
							{data.sources.map((s, i) => (
								<div key={i} className="src-row">
									<span className={`src-dot seg-${s.source}`} />
									<span className="src-name">
										{s.name}
										<span className={`src-chip ${s.source}`}>{s.source === "unattributed" ? "unattributed" : s.source}</span>
									</span>
									<span className="src-money">{s.source === "billed" ? fmtCost(s.cost) : fmtEst(s.cost)}</span>
									<span className="src-meta">
										{s.turns.toLocaleString()} turn{s.turns === 1 ? "" : "s"}
										{s.source === "plan" ? ", included in your subscription" : ""}
										{s.source === "unattributed" ? ", recorded before provider tracking" : ""}
									</span>
								</div>
							))}
							<div className="src-note">
								Estimated values use public API list prices. Memory upkeep, HiveMind answers and scheduled runs
								are recorded from July 2026; earlier upkeep was never persisted and is not included.
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
								<button type="button" className={activityMetric === "tokens" ? "active" : ""} aria-pressed={activityMetric === "tokens"} onClick={() => setActivityMetric("tokens")}>Tokens</button>
								<button type="button" className={activityMetric === "value" ? "active" : ""} aria-pressed={activityMetric === "value"} onClick={() => setActivityMetric("value")}>Value</button>
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
				<div className="dash-section-label">Exxperts</div>
				<div className="chart-block">
					<div className="sub bar-list-sub">Share of est. value. Select an exxpert to scope the whole page.</div>
					{data.byAgent.length === 0 && <div className="sub">No usage recorded yet. Send a prompt.</div>}
					<BarList
						rows={data.byAgent.map((a) => ({
							key: a.agent,
							name: nameOf(a.agent),
							tag: a.agent === "hivemind:memory" ? "memory chat" : a.retired ? "retired" : undefined,
							cost: a.cost,
							detail: `${fmtEst(a.cost)}, ${a.turns.toLocaleString()} turn${a.turns === 1 ? "" : "s"}`,
							subDetail: a.agent === "hivemind:memory" ? undefined : backgroundKindsNote(a.kinds),
						}))}
						shareBase={est}
						selected={agent}
						onSelect={(key) => setAgent(agent === key ? "all" : key)}
						expanded={agentsExpanded}
						onToggleExpanded={() => setAgentsExpanded((v) => !v)}
						collapseNoun="exxperts"
					/>
				</div>
			</section>

			<section className="dash-section">
				<div className="dash-section-label">Models</div>
				<div className="chart-block">
					<div className="sub bar-list-sub">One entry per model, raw provider ids merged. Select a model to scope the whole page.</div>
					{data.byModel.length === 0 && <div className="sub">No usage recorded yet.</div>}
					<BarList
						rows={data.byModel.map((m) => ({
							key: m.id,
							name: m.label,
							cost: m.cost,
							detail: `${fmtEst(m.cost)}, ${m.turns.toLocaleString()} turn${m.turns === 1 ? "" : "s"}${m.rawIds > 1 ? `, ${m.rawIds} raw ids merged` : ""}`,
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
							onClick={(e) => { e.stopPropagation(); setAgent("all"); }}
							onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); setAgent("all"); } }}
						>
							{nameOf(agent)} <span aria-hidden="true">×</span>
						</span>
					)}
					<span className="recent-meta">{data.recent.length} entries, all time</span>
					<span className="recent-toggle" aria-hidden="true">{recentOpen ? "–" : "+"}</span>
				</button>
				{recentOpen && (
					<div id="recent-turns-body" className="recent-body">
						<table>
							<thead>
								<tr>
									<th>When</th>
									<th>Exxpert</th>
									<th>Model</th>
									<th>Source</th>
									<th>Kind</th>
									<th>↑ in</th>
									<th>↓ out</th>
									<th>value</th>
								</tr>
							</thead>
							<tbody>
								{data.recent.map((r, i) => (
									<tr key={i}>
										<td>{fmtAgo(r.ts)}</td>
										<td className="first">{nameOf(r.agent)}</td>
										<td>{modelCell(r)}</td>
										<td>{sourceCell(r)}</td>
										<td><span className="kind-chip">{KIND_LABELS[r.kind ?? "chat"] ?? r.kind}</span></td>
										<td>{fmtTok(r.input)}</td>
										<td>{fmtTok(r.output)}</td>
										<td>{r.authType === "api_key" ? fmtCost(r.cost) : fmtEst(r.cost)}</td>
									</tr>
								))}
								{data.recent.length === 0 && (
									<tr>
										<td colSpan={8}>{agent !== "all" ? "No turns for this exxpert." : "No turns yet."}</td>
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

/** "plus upkeep ≈ $0.12 over 6 runs" line under an exxpert with background kinds. */
function backgroundKindsNote(kinds: Record<string, { cost: number; turns: number }>): string | undefined {
	const parts: string[] = [];
	for (const kind of ["upkeep", "consult", "scheduled", "hivemind", "cli"]) {
		const k = kinds[kind];
		if (!k || k.turns === 0) continue;
		parts.push(`${kind} ${fmtEst(k.cost)} over ${k.turns} run${k.turns === 1 ? "" : "s"}`);
	}
	return parts.length ? `incl. ${parts.join(", ")}` : undefined;
}

interface BarListRow {
	key: string;
	name: string;
	tag?: string;
	cost: number;
	detail: string;
	subDetail?: string;
}

function BarList({
	rows,
	shareBase,
	selected,
	onSelect,
	expanded,
	onToggleExpanded,
	collapseNoun,
}: {
	rows: BarListRow[];
	shareBase: number;
	selected: string;
	onSelect: (key: string) => void;
	expanded: boolean;
	onToggleExpanded: () => void;
	collapseNoun: string;
}) {
	const collapsible = rows.length > BAR_COLLAPSE_LIMIT + 1;
	const visible = collapsible && !expanded ? rows.filter((r, i) => i < BAR_COLLAPSE_LIMIT || r.key === selected) : rows;
	return (
		<>
			{visible.map((r) => {
				const sharePct = shareBase > 0 ? (r.cost / shareBase) * 100 : 0;
				const isSelected = selected === r.key;
				return (
					<div key={r.key}>
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
			})}
			{collapsible && (
				<button type="button" className="bar-row-more" onClick={onToggleExpanded}>
					{expanded ? `Show top ${collapseNoun} only` : `Show all ${rows.length} ${collapseNoun}`}
				</button>
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
