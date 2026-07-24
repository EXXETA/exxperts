import * as fs from "node:fs";
import { Type } from "typebox";
import type { ExtensionAPI } from "@exxeta/exxperts-runtime";
import { productAppStatePath } from "../../product-state-paths.js";

// Search backends: DuckDuckGo's HTML endpoint is the zero-setup default
// (works out of the box, no Docker); a local SearXNG instance is the
// preferred/power path whenever one is configured, with DuckDuckGo as the
// fallback when SearXNG is configured but not answering. An explicit
// EXXETA_SEARCH_PROVIDER=disabled turns web search off entirely.
type SearchProvider = "duckduckgo" | "searxng" | "disabled";

// Setup command shown in user-facing messages, shell-appropriate per platform
// (the bash entry point does not run from PowerShell/cmd).
const SEARXNG_START = process.platform === "win32" ? "node scripts\\searxng.mjs start" : "./scripts/searxng start";

const DDG_ENDPOINT = "https://html.duckduckgo.com/html/";

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

interface SearxngResult {
	title?: string;
	url?: string;
	content?: string;
}

// Shared web-search config in the user data dir. Written by `./scripts/searxng
// start` and read here, so search works the same whether the app is launched
// via the global `exxperts` command or the repo `./scripts/exxeta` — and it
// survives reinstalls. Environment variables still override it.
interface SharedSearchConfig {
	provider?: string;
	baseUrl?: string;
}

let sharedConfigCache: SharedSearchConfig | null | undefined;

function sharedConfig(): SharedSearchConfig {
	if (sharedConfigCache !== undefined) return sharedConfigCache ?? {};
	try {
		const file = productAppStatePath("web-search.json");
		const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
		sharedConfigCache = parsed && typeof parsed === "object" ? (parsed as SharedSearchConfig) : null;
	} catch {
		sharedConfigCache = null;
	}
	return sharedConfigCache ?? {};
}

function getProvider(): SearchProvider {
	const raw = String(process.env.EXXETA_SEARCH_PROVIDER || sharedConfig().provider || "").trim().toLowerCase();
	if (raw === "searxng") return "searxng";
	if (raw === "disabled") return "disabled";
	return "duckduckgo";
}

function clampLimit(limit: unknown): number {
	const n = Number(limit ?? 5);
	if (!Number.isFinite(n)) return 5;
	return Math.max(1, Math.min(10, Math.floor(n)));
}

function formatResults(query: string, results: SearchResult[]): string {
	if (results.length === 0) return `No web results for "${query}".`;
	return results
		.map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   Snippet: ${r.snippet}`)
		.join("\n\n");
}

// A SearXNG outage should cost ONE probe, not one per search: the failure is
// negative-cached and searches go straight to DuckDuckGo until the window
// expires (so an OrbStack restart recovers on the next probe). Exported as a
// factory so the fixture smoke can unit-test the window logic offline.
export function createOutageCache(windowMs: number) {
	let downUntil = 0;
	return {
		isDown: (now: number) => now < downUntil,
		markDown: (now: number) => { downUntil = now + windowMs; },
		markUp: () => { downUntil = 0; },
	};
}

// DDG's HTML endpoint rate-limits rapid bursts (seen live: a 6-query burst
// all rejected). Pure helper: how long to wait before the next request.
export function ddgDelayMs(lastRequestAt: number, now: number, minGapMs: number): number {
	return Math.max(0, lastRequestAt + minGapMs - now);
}

// DDG answers bot-flagged clients with HTTP 200 and a challenge page instead
// of results. That block is per-network and tends to persist, so the error
// must not promise that waiting helps; it names the real cure instead. The
// message is a soft tool error: the model reads it and can adapt (fetch_url,
// telling the user about SearXNG) rather than retrying into the same wall.
export const DDG_BLOCKED_MESSAGE =
	"DuckDuckGo is blocking automated searches from this network: it served its bot-challenge page instead of results. Retrying soon is unlikely to help. For reliable web search on this network, set up a local SearXNG instance; see docs/web-search.md.";

export function isDdgChallenge(html: string, resultCount: number): boolean {
	return resultCount === 0 && /anomaly|captcha|challenge/i.test(html);
}

const SEARXNG_TIMEOUT_MS = 3_000;
const SEARXNG_OUTAGE_WINDOW_MS = 5 * 60_000;
const DDG_MIN_GAP_MS = 1_500;
const searxngOutage = createOutageCache(SEARXNG_OUTAGE_WINDOW_MS);
let lastDdgRequestAt = 0;
// The agent loop can fire several tool calls in ONE Promise.all: an inline
// wait computed from a shared timestamp lets a burst all see wait=0. The
// promise chain serializes the pacing so each request takes its slot in
// turn.
let ddgPacingQueue: Promise<void> = Promise.resolve();
function takeDdgSlot(): Promise<void> {
	const slot = ddgPacingQueue.then(async () => {
		const wait = ddgDelayMs(lastDdgRequestAt, Date.now(), DDG_MIN_GAP_MS);
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
		lastDdgRequestAt = Date.now();
	});
	ddgPacingQueue = slot.catch(() => undefined);
	return slot;
}

async function searchSearxng(query: string, limit: number): Promise<SearchResult[]> {
	const baseUrl = process.env.EXXETA_SEARCH_BASE_URL || sharedConfig().baseUrl;
	if (!baseUrl) {
		throw new Error(`SearXNG is selected but has no base URL. Run ${SEARXNG_START} to write the config, then restart the app.`);
	}

	const url = new URL(baseUrl.replace(/\/+$/, "") + "/search");
	url.searchParams.set("q", query);
	url.searchParams.set("format", "json");

	let res: Response;
	try {
		// Bounded so a wedged-but-port-open SearXNG falls back to DuckDuckGo
		// instead of hanging the tool call forever.
		res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(SEARXNG_TIMEOUT_MS) });
	} catch (e) {
		throw new Error(`SearXNG is not reachable at ${baseUrl}. Start it with ${SEARXNG_START} (and make sure the container engine is running). ${(e as Error).message}`);
	}
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`SearXNG search failed (${res.status} ${res.statusText}). ${body}`.trim());
	}

	const data = await res.json() as { results?: SearxngResult[] };
	return (data.results ?? []).slice(0, limit).map((r) => ({
		title: r.title || "Untitled",
		url: r.url || "",
		snippet: r.content || "",
	}));
}

// --- DuckDuckGo HTML endpoint ------------------------------------------------

function decodeEntities(s: string): string {
	// &amp; decodes LAST: doing it first turns "&amp;lt;" into "&lt;" which the
	// next pass would double-decode into a real "<".
	return s
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#x27;|&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&");
}

function stripTags(s: string): string {
	return decodeEntities(s.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

// DDG result links are redirect URLs (//duckduckgo.com/l/?uddg=<encoded>);
// the real target is the uddg parameter. Links without it (ads, internal
// y.js click-tracking) are dropped.
function resolveDdgHref(href: string): string | null {
	const raw = decodeEntities(href);
	if (/duckduckgo\.com\/y\.js/i.test(raw)) return null;
	try {
		const abs = raw.startsWith("//") ? `https:${raw}` : raw;
		const parsed = new URL(abs, "https://duckduckgo.com/");
		const uddg = parsed.searchParams.get("uddg");
		if (uddg) {
			// The decoded redirect target is feed-controlled: parse it and
			// require http(s), or a hostile feed hands javascript:/file:/data:
			// URLs to whatever renders the results.
			try {
				const target = new URL(uddg);
				return /^https?:$/.test(target.protocol) ? target.href : null;
			} catch {
				return null;
			}
		}
		if (/^https?:$/.test(parsed.protocol) && !/duckduckgo\.com$/i.test(parsed.hostname)) return parsed.href;
		return null;
	} catch {
		return null;
	}
}

// Exported for the fixture-based smoke: the endpoint's markup is the one
// contract we do not control, so the parser is testable offline.
export function parseDuckDuckGoHtml(html: string, limit: number): SearchResult[] {
	const results: SearchResult[] = [];
	// Each organic result lives in a block whose class list starts with
	// "result"; ads carry result--ad and are dropped via their y.js hrefs.
	const blocks = html.split(/<div[^>]*class="[^"]*\bresult\b[^"]*"/).slice(1);
	for (const block of blocks) {
		if (results.length >= limit) break;
		const anchor = /<a[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
		if (!anchor) continue;
		const url = resolveDdgHref(anchor[1] ?? "");
		if (!url) continue;
		const title = stripTags(anchor[2] ?? "");
		if (!title) continue;
		const snippetMatch = /<a[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(block)
			?? /<td[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/td>/.exec(block)
			?? /<div[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(block);
		// Length caps: feed-controlled text never balloons a tool result.
		results.push({
			title: title.slice(0, 300),
			url: url.slice(0, 2000),
			snippet: snippetMatch ? stripTags(snippetMatch[1] ?? "").slice(0, 500) : "",
		});
	}
	return results;
}

async function searchDuckDuckGo(query: string, limit: number): Promise<SearchResult[]> {
	const url = new URL(DDG_ENDPOINT);
	url.searchParams.set("q", query);
	await takeDdgSlot();
	let res: Response;
	try {
		res = await fetch(url, {
			headers: {
				accept: "text/html",
				// The HTML endpoint serves plain browsers; an empty UA gets blocked.
				"user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
			},
			signal: AbortSignal.timeout(15_000),
		});
	} catch (e) {
		throw new Error(`DuckDuckGo is not reachable. ${(e as Error).message}`);
	}
	if (!res.ok) {
		throw new Error(`DuckDuckGo search failed (${res.status} ${res.statusText}).${res.status === 403 || res.status === 429 ? " DuckDuckGo rate-limits or blocks automated queries on some networks; if this persists, a local SearXNG instance is the reliable path; see docs/web-search.md." : ""}`);
	}
	const html = await res.text();
	const results = parseDuckDuckGoHtml(html, limit);
	if (isDdgChallenge(html, results.length)) {
		throw new Error(DDG_BLOCKED_MESSAGE);
	}
	return results;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web search",
		description:
			"Search the public web. Works out of the box (DuckDuckGo); a local SearXNG instance is used instead when one is configured (optional, for heavier use).",
		promptSnippet:
			"Use `web_search` when the user asks for latest/current web information, market/client research, trends, or sourced briefings. Cite URLs in the final answer.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query." }),
			limit: Type.Optional(Type.Number({ description: "Maximum number of results to return. Default 5, max 10." })),
		}),
		async execute(_id, { query, limit = 5 }): Promise<any> {
			const provider = getProvider();
			const maxResults = clampLimit(limit);

			if (provider === "disabled") {
				return {
					content: [
						{
							type: "text",
							text: "Web search is disabled (EXXETA_SEARCH_PROVIDER=disabled). Remove that setting to re-enable it.",
						},
					],
					details: { configured: false, provider },
					isError: true,
				};
			}

			// SearXNG when configured, DuckDuckGo as the fallback when it is not
			// answering; plain DuckDuckGo otherwise.
			let searxngError: string | null = null;
			if (provider === "searxng" && searxngOutage.isDown(Date.now())) {
				searxngError = "SearXNG is marked unreachable; retrying it automatically in a few minutes.";
			} else if (provider === "searxng") {
				try {
					const results = await searchSearxng(query, maxResults);
					searxngOutage.markUp();
					return {
						content: [{ type: "text", text: formatResults(query, results) }],
						details: { configured: true, provider, query, count: results.length, results },
					};
				} catch (e) {
					searxngError = (e as Error).message;
					searxngOutage.markDown(Date.now());
				}
			}
			try {
				const results = await searchDuckDuckGo(query, maxResults);
				return {
					content: [{ type: "text", text: formatResults(query, results) }],
					details: {
						configured: true,
						provider: "duckduckgo",
						query,
						count: results.length,
						results,
						...(searxngError ? { fallbackFrom: "searxng", searxngError } : {}),
					},
				};
			} catch (e) {
				const parts = [
					`Web search failed: ${(e as Error).message}`,
					...(searxngError ? [`(SearXNG was tried first: ${searxngError})`] : []),
				];
				return {
					content: [{ type: "text", text: parts.join(" ") }],
					details: { configured: true, provider, error: (e as Error).message, ...(searxngError ? { searxngError } : {}) },
					isError: true,
				};
			}
		},
	});
}
