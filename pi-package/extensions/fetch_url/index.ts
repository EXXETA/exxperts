import * as dns from "node:dns/promises";
import * as net from "node:net";
import { Agent } from "undici";
import { Type } from "typebox";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { NodeHtmlMarkdown } from "node-html-markdown";
import type { ExtensionAPI } from "@exxeta/exxperts-runtime";

// Curated, JS-native single-purpose "fetch a URL" tool. Sibling to `web_search`
// in the room web-research lane: outbound-only, no filesystem, no shell. Web
// search finds pages; `fetch_url` reads one the user/agent already has a URL for
// (an article, a docs page, an API returning JSON).
//
// Pipeline: static fetch → readable-content extraction (Readability) → Markdown.
// If the static HTML is JS-empty (a client-rendered SPA), and a local Chromium
// is available, we fall back to rendering the page with Playwright and extract
// again. Everything runs locally — no external models or scraping services.
//
// This runs inside governed rooms, so the primary security surface is SSRF: an
// agent must not reach loopback/link-local/private hosts or cloud metadata
// endpoints. We validate the host before every top-level request, after every
// redirect hop, AND on every subrequest the rendered page tries to make.
//
// The static path is hardened against DNS rebinding: instead of "resolve, check,
// then connect (which may re-resolve)", it validates the address inside the
// connection's own DNS lookup (undici `connect.lookup`), so the IP that is
// checked is exactly the IP that is dialed. The headless-browser path proxies
// every page request through `route.fetch` with per-hop host validation
// (Chromium never dials the network itself), but that fetch resolves DNS
// independently of the guard's lookup, so a residual rebinding gap remains there.

const DEFAULT_MAX_CHARS = 15_000;
const HARD_MAX_CHARS = 50_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB raw download cap
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 15_000;

// Below this many characters of extracted text we treat the static HTML as
// "empty" (a client-rendered shell) and try the browser fallback. Exported for testing.
export const THIN_TEXT_THRESHOLD = 200;
const BROWSER_NAV_TIMEOUT_MS = 20_000;
// Short settle before the content wait below does the real work; kept low because
// ad/analytics-heavy pages never reach "network idle" and would burn the full budget.
const BROWSER_SETTLE_TIMEOUT_MS = 2_500;
// After navigating, wait until the page actually has meaningful text (SPAs paint
// their shell first and hydrate content later), rather than trusting "network
// idle" — otherwise we read an empty shell and return nothing.
const CONTENT_READY_CHARS = 500;
const CONTENT_WAIT_TIMEOUT_MS = 8_000;
// Cap concurrent headless renders so many rooms cannot exhaust memory at once.
const MAX_CONCURRENT_RENDERS = 2;

// Present as a mainstream desktop browser. Many sites (Cloudflare and other bot
// walls) reject non-browser user-agents outright, so a plain tool identity would
// fail on a large slice of the real web. The headless-browser fallback uses the
// same identity, removing the "HeadlessChrome" tell.
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const ACCEPT_LANGUAGE = "en-US,en;q=0.9";

// Status codes that typically mean "blocked / challenge / rate-limited" rather
// than a genuinely empty page — worth retrying through the real browser.
const BLOCKED_STATUSES = new Set([403, 429, 503]);

let activeRenders = 0;

function isDisabled(): boolean {
	return String(process.env.EXXETA_FETCH_URL_DISABLED ?? "").trim() === "1";
}

// Browser fallback is on by default when Chromium is available; set to "off" to
// force the static-only path (a governance kill-switch for the JS-render surface).
function browserFallbackEnabled(): boolean {
	return String(process.env.EXXETA_FETCH_URL_BROWSER ?? "").trim().toLowerCase() !== "off";
}

// Trusted-deployment escape hatch: when set, loopback/private/reserved hosts are
// permitted (e.g. fetching an internal wiki/docs server on a self-hosted setup).
// OFF by default — the SSRF guard blocks private ranges. Analogous to
// pi-web-access's `ssrf.allowRanges`. Governance-owned; do not enable in a
// multi-tenant/untrusted context.
function allowPrivateHosts(): boolean {
	return String(process.env.EXXETA_FETCH_URL_ALLOW_PRIVATE ?? "").trim() === "1";
}

// Optional governance knob: comma-separated host suffixes. When set, only hosts
// matching one suffix may be fetched (curated-allowlist mode). Unset = any
// public host (private ranges still blocked).
function hostAllowlist(): string[] {
	return String(process.env.EXXETA_FETCH_URL_ALLOWLIST ?? "")
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
}

function hostAllowed(hostname: string): boolean {
	const list = hostAllowlist();
	if (list.length === 0) return true;
	const host = hostname.toLowerCase();
	return list.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function ipv4IsPrivate(ip: string): boolean {
	const parts = ip.split(".").map((n) => Number(n));
	if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
	const [a, b] = parts;
	if (a === 0) return true; // 0.0.0.0/8
	if (a === 10) return true; // 10.0.0.0/8
	if (a === 127) return true; // loopback
	if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
	if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
	if (a === 192 && b === 168) return true; // 192.168.0.0/16
	if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
	if (a >= 224) return true; // multicast + reserved
	return false;
}

function ipv6IsPrivate(ip: string): boolean {
	const addr = ip.toLowerCase().replace(/^\[|\]$/g, "");
	if (addr === "::1" || addr === "::") return true; // loopback / unspecified
	if (addr.startsWith("fe80")) return true; // link-local
	if (addr.startsWith("fc") || addr.startsWith("fd")) return true; // unique local
	// IPv4-mapped (::ffff:a.b.c.d) — validate the embedded v4.
	const mapped = addr.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
	if (mapped) return ipv4IsPrivate(mapped[1]);
	return false;
}

function ipIsBlocked(ip: string): boolean {
	const kind = net.isIP(ip);
	if (kind === 4) return ipv4IsPrivate(ip);
	if (kind === 6) return ipv6IsPrivate(ip);
	return true; // not a recognisable IP → refuse
}

// DNS-rebinding-safe dispatcher: the address is validated inside the connection's
// own resolution, so the checked IP is the connected IP (no re-resolve window).
// Reused across requests; reads the allow-private flag dynamically per lookup.
// undici v7 calls the lookup with `all: true` and expects the address-array form
// `(err, [{ address, family }])`.
function guardedLookup(
	hostname: string,
	_options: unknown,
	callback: (err: NodeJS.ErrnoException | null, addresses?: Array<{ address: string; family: number }>) => void,
): void {
	const literal = net.isIP(hostname);
	if (literal) {
		if (!allowPrivateHosts() && ipIsBlocked(hostname)) return callback(new Error(`Refusing private/reserved address "${hostname}".`));
		return callback(null, [{ address: hostname, family: literal }]);
	}
	dns.lookup(hostname, { all: true })
		.then((addrs) => {
			if (addrs.length === 0) return callback(new Error(`Host "${hostname}" did not resolve.`));
			if (!allowPrivateHosts() && addrs.some((a) => ipIsBlocked(a.address))) {
				return callback(new Error(`Refusing "${hostname}" — it resolves to a private/reserved address.`));
			}
			callback(null, addrs.map((a) => ({ address: a.address, family: a.family })));
		})
		.catch((e) => callback(e as NodeJS.ErrnoException));
}

const guardedDispatcher = new Agent({ connect: { lookup: guardedLookup as any } });

// Resolve and validate the host. Returns an error string if the URL must be
// refused, or null if it is safe to fetch.
async function guardUrl(raw: string): Promise<string | null> {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return `"${raw}" is not a valid URL.`;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return `Only http and https URLs are allowed (got "${parsed.protocol}").`;
	}
	// URL.hostname keeps the brackets around IPv6 literals ("[::1]"); strip them
	// so the literal-IP guard below sees a value net.isIP() recognises.
	const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	const allowPrivate = allowPrivateHosts();
	if (
		!allowPrivate &&
		(hostname === "localhost" ||
			hostname.endsWith(".localhost") ||
			hostname.endsWith(".local") ||
			hostname.endsWith(".internal"))
	) {
		return `Refusing to fetch internal host "${hostname}".`;
	}
	if (!hostAllowed(hostname)) {
		return `Host "${hostname}" is not in the configured fetch allowlist.`;
	}

	// Literal IP in the URL — check directly.
	if (net.isIP(hostname)) {
		if (!allowPrivate && ipIsBlocked(hostname)) return `Refusing to fetch private/reserved address "${hostname}".`;
		return null;
	}

	// Hostname — resolve every address and block if any is private/reserved.
	let addrs: string[];
	try {
		const looked = await dns.lookup(hostname, { all: true });
		addrs = looked.map((a) => a.address);
	} catch (e) {
		return `Could not resolve host "${hostname}": ${(e as Error).message}`;
	}
	if (addrs.length === 0) return `Host "${hostname}" did not resolve to any address.`;
	if (!allowPrivate && addrs.some((a) => ipIsBlocked(a))) {
		return `Refusing to fetch "${hostname}" — it resolves to a private/reserved address.`;
	}
	return null;
}

async function readCapped(res: Response): Promise<{ text: string; truncatedBytes: boolean }> {
	const reader = res.body?.getReader();
	if (!reader) return { text: await res.text(), truncatedBytes: false };
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncatedBytes = false;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) {
			total += value.byteLength;
			if (total > MAX_RESPONSE_BYTES) {
				chunks.push(value.subarray(0, value.byteLength - (total - MAX_RESPONSE_BYTES)));
				truncatedBytes = true;
				await reader.cancel().catch(() => {});
				break;
			}
			chunks.push(value);
		}
	}
	return { text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf-8"), truncatedBytes };
}

interface FetchOutcome {
	finalUrl: string;
	status: number;
	statusText: string;
	contentType: string;
	body: string;
	truncatedBytes: boolean;
}

// Static fetch with manual redirect handling so every hop is SSRF-revalidated.
async function fetchStatic(startUrl: string): Promise<FetchOutcome> {
	let currentUrl = startUrl;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const guardError = await guardUrl(currentUrl);
		if (guardError) throw new Error(guardError);

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		let res: Response;
		try {
			res = await fetch(currentUrl, {
				redirect: "manual",
				signal: controller.signal,
				// undici extension: the guarded dispatcher pins DNS validation to the
				// connected IP (rebinding-safe). Not in the DOM RequestInit type.
				dispatcher: guardedDispatcher,
				headers: {
					"user-agent": USER_AGENT,
					"accept-language": ACCEPT_LANGUAGE,
					accept: "text/html,application/xhtml+xml,application/json,text/plain,*/*",
				},
			} as any);
		} catch (e) {
			throw new Error(`Request to ${currentUrl} failed: ${(e as Error).message}`);
		} finally {
			clearTimeout(timer);
		}

		if (res.status >= 300 && res.status < 400) {
			const location = res.headers.get("location");
			if (!location) throw new Error(`Redirect (${res.status}) from ${currentUrl} had no Location header.`);
			if (hop === MAX_REDIRECTS) throw new Error(`Too many redirects (>${MAX_REDIRECTS}) starting from ${startUrl}.`);
			currentUrl = new URL(location, currentUrl).toString();
			await res.body?.cancel().catch(() => {});
			continue;
		}

		const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
		const { text, truncatedBytes } = await readCapped(res);
		return { finalUrl: currentUrl, status: res.status, statusText: res.statusText, contentType, body: text, truncatedBytes };
	}
	throw new Error(`Too many redirects (>${MAX_REDIRECTS}) starting from ${startUrl}.`);
}

// Detect a body that decoded into binary junk rather than text. This happens
// in the wild when a proxy or TLS-inspection layer re-compresses responses but
// mislabels `Content-Encoding`, so the decompressed "text" is still compressed
// bytes. Compressed data decoded as UTF-8 is dense in control characters and
// U+FFFD replacement chars; real text (any language) is not. Exported for testing.
export function looksGarbled(text: string): boolean {
	const sample = text.slice(0, 4000);
	if (sample.length < 64) return false;
	let junk = 0;
	for (const ch of sample) {
		const code = ch.codePointAt(0) ?? 0;
		if (ch === "�" || (code < 32 && code !== 9 && code !== 10 && code !== 13)) junk++;
	}
	return junk / sample.length > 0.1;
}

const GARBLED_EXPLANATION =
	"the response body could not be decoded into readable text. This usually means a proxy or TLS-inspection layer on this network is corrupting compressed responses; it is an environment issue, not a problem with the page.";

function isTextualContentType(contentType: string): boolean {
	if (!contentType) return true; // unknown → attempt as text
	return (
		contentType.startsWith("text/") ||
		contentType.includes("json") ||
		contentType.includes("xml") ||
		contentType.includes("html") ||
		contentType.includes("javascript") ||
		contentType.includes("csv")
	);
}

interface ExtractedContent {
	title?: string;
	markdown: string;
	textLength: number;
}

// Cookie/consent banners (OneTrust and friends) and modal overlays are often
// scored by Readability as the "main content", so a fetch can return cookie
// legalese instead of the article. Remove them — plus non-content tags — before
// extraction. Errs toward removing consent chrome, not article text.
const BOILERPLATE_SELECTOR = [
	'[id*="onetrust" i]',
	'[class*="onetrust" i]',
	'[id*="cookie" i]',
	'[class*="cookie" i]',
	'[id*="consent" i]',
	'[class*="consent" i]',
	'[id*="gdpr" i]',
	'[class*="gdpr" i]',
	'[aria-label*="cookie" i]',
	'[aria-label*="consent" i]',
	'[role="dialog"]',
	'[aria-modal="true"]',
].join(",");
const NOISE_TAGS = ["script", "style", "noscript", "iframe", "svg", "template"];

function stripBoilerplate(doc: Document): void {
	try {
		for (const el of Array.from(doc.querySelectorAll(BOILERPLATE_SELECTOR))) el.remove();
	} catch {
		// A malformed selector engine state shouldn't abort extraction.
	}
	for (const tag of NOISE_TAGS) {
		for (const el of Array.from(doc.getElementsByTagName(tag))) el.remove();
	}
}

// Turn an HTML document into readable Markdown: isolate the main article with
// Readability, then convert that HTML to Markdown. Falls back to converting the
// whole <body> when Readability cannot find an article. Exported for testing.
export function extractReadable(html: string, url: string): ExtractedContent {
	let doc: Document;
	try {
		doc = new JSDOM(html, { url }).window.document;
	} catch {
		// Malformed HTML — degrade to a bare Markdown conversion of the raw string.
		const md = NodeHtmlMarkdown.translate(html);
		return { markdown: md, textLength: md.replace(/\s+/g, "").length };
	}

	const documentTitle = doc.querySelector("title")?.textContent?.trim() || undefined;
	stripBoilerplate(doc);

	let articleHtml: string | null = null;
	let articleTitle: string | undefined;
	try {
		// Readability mutates the document, so parse a clone.
		const parsed = new Readability(doc.cloneNode(true) as Document).parse();
		if (parsed?.content && (parsed.textContent?.trim().length ?? 0) > 0) {
			articleHtml = parsed.content;
			articleTitle = parsed.title?.trim() || undefined;
		}
	} catch {
		articleHtml = null;
	}

	const sourceHtml = articleHtml ?? doc.body?.innerHTML ?? html;
	const markdown = NodeHtmlMarkdown.translate(sourceHtml).trim();
	return {
		title: articleTitle || documentTitle,
		markdown,
		textLength: markdown.replace(/\s+/g, "").length,
	};
}

// Lazily resolve Playwright's chromium without importing at module load, so the
// extension loads fine when Playwright is not installed. Mirrors the Content
// Producer HTML-preview helper.
async function loadChromium(): Promise<any | null> {
	try {
		const mod: any = await import("playwright");
		const chromium = mod?.chromium ?? mod?.default?.chromium ?? null;
		if (!chromium) return null;
		const execPath = typeof chromium.executablePath === "function" ? chromium.executablePath() : "";
		// executablePath() throws if the browser was never installed.
		if (!execPath) return null;
		return chromium;
	} catch {
		return null;
	}
}

// Wait until the page has rendered meaningful text, so we don't read an empty
// SPA shell. Best-effort: on timeout we read whatever is present.
async function waitForContent(page: any): Promise<void> {
	try {
		await page.waitForFunction(
			(min: number) => (document.body?.innerText?.trim().length ?? 0) >= min,
			CONTENT_READY_CHARS,
			{ timeout: CONTENT_WAIT_TIMEOUT_MS, polling: 250 },
		);
	} catch {
		// Timed out — the page may genuinely be sparse; read what is there.
	}
}

// Best-effort: click a cookie-consent "accept/agree" control so the site reveals
// its content. Fully swallowed — a page with no banner, or an unclickable one,
// must never fail or slow the render meaningfully.
async function dismissConsent(page: any): Promise<void> {
	const selectors = [
		"#onetrust-accept-btn-handler",
		"#onetrust-reject-all-handler",
		"#didomi-notice-agree-button",
		".fc-cta-consent",
		"button[aria-label*='accept' i]",
		"button[aria-label*='agree' i]",
	];
	for (const sel of selectors) {
		try {
			const loc = page.locator(sel).first();
			if ((await loc.count()) > 0) {
				await loc.click({ timeout: 1500 });
				await page.waitForTimeout(400);
				return;
			}
		} catch {
			// try the next candidate
		}
	}
	for (const name of [/^accept all/i, /^accept/i, /^i accept/i, /^agree/i, /^allow all/i]) {
		try {
			const btn = page.getByRole("button", { name }).first();
			if ((await btn.count()) > 0) {
				await btn.click({ timeout: 1500 });
				await page.waitForTimeout(400);
				return;
			}
		} catch {
			// try the next candidate
		}
	}
}

// Render a URL in headless Chromium and return the fully-hydrated HTML. Returns
// null when the browser is unavailable, disabled, at the concurrency cap, or the
// render fails — every one of which falls back to the static result.
async function renderWithBrowser(url: string): Promise<{ html: string; finalUrl: string } | null> {
	if (!browserFallbackEnabled()) return null;
	if (activeRenders >= MAX_CONCURRENT_RENDERS) return null;
	// Claim the render slot before the first await — otherwise concurrent calls
	// all pass the check above before any of them counts itself, exceeding the cap.
	activeRenders++;
	let browser: any = null;
	try {
		const chromium = await loadChromium();
		if (!chromium) return null;
		browser = await chromium.launch({ headless: true });
		// serviceWorkers: "block" — service workers make network requests that
		// bypass page.route, which would sidestep the SSRF guard below.
		const context = await browser.newContext({ userAgent: USER_AGENT, acceptDownloads: false, javaScriptEnabled: true, serviceWorkers: "block" });
		const page = await context.newPage();

		// SSRF defense-in-depth: re-validate every subrequest the page makes. The
		// top-level URL was already vetted, but once page JS runs it can try to
		// fetch internal hosts (e.g. cloud metadata). We also drop heavy media we
		// never need for text, which speeds the render and shrinks the surface.
		//
		// Chromium follows redirects internally WITHOUT re-entering this handler
		// (verified: a fulfilled 3xx is followed straight to the network too), so a
		// vetted public URL could otherwise redirect a subrequest to an internal
		// host unchecked. To close that, we perform the request ourselves hop by
		// hop (`route.fetch` with redirects off), guarding every Location target,
		// and fulfill the final response.
		await page.route("**/*", async (route: any) => {
			try {
				const req = route.request();
				const reqUrl = req.url();
				if (reqUrl.startsWith("data:") || reqUrl.startsWith("blob:")) return route.continue();
				const type = req.resourceType();
				if (type === "image" || type === "media" || type === "font") return route.abort();
				let hopUrl = reqUrl;
				let res: any = null;
				for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
					const guardError = await guardUrl(hopUrl);
					if (guardError) return route.abort();
					res = await route.fetch({ url: hopUrl, maxRedirects: 0 });
					if (res.status() < 300 || res.status() >= 400) break;
					const location = res.headers()["location"];
					if (!location) break;
					if (hop === MAX_REDIRECTS) return route.abort();
					hopUrl = new URL(location, hopUrl).toString();
				}
				return route.fulfill({ response: res });
			} catch {
				return route.abort().catch(() => {});
			}
		});

		await page.goto(url, { waitUntil: "domcontentloaded", timeout: BROWSER_NAV_TIMEOUT_MS });
		// Let the consent banner mount, then dismiss it — some sites only render the
		// article once it is answered (removing it in extractReadable is not enough).
		await page.waitForTimeout(500);
		await dismissConsent(page);
		// Wait for the SPA to actually hydrate its content before reading, instead of
		// trusting "network idle" (which often fired before the article appeared and
		// left us reading an empty shell).
		await page.waitForLoadState("networkidle", { timeout: BROWSER_SETTLE_TIMEOUT_MS }).catch(() => {});
		await waitForContent(page);
		// Remove elements the browser is actually hiding. Responsive designs often
		// render the same text twice (one copy for mobile, one for desktop) and hide
		// one with CSS; jsdom/Readability don't apply CSS, so without this both copies
		// survive as duplicated text ("Attacking Attacking").
		await page
			.evaluate(() => {
				const doc = (globalThis as any).document;
				const win = globalThis as any;
				for (const el of Array.from(doc.querySelectorAll("body *")) as any[]) {
					const s = win.getComputedStyle(el);
					if (s && (s.display === "none" || s.visibility === "hidden")) el.remove();
				}
			})
			.catch(() => {});
		const html: string = await page.content();
		const finalUrl: string = page.url();
		return { html, finalUrl };
	} catch {
		return null;
	} finally {
		if (browser) await browser.close().catch(() => {});
		activeRenders--;
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "fetch_url",
		label: "Fetch URL",
		description:
			"Fetch a single public http(s) URL and return its main content as readable Markdown (JS-rendered pages are rendered locally when needed; JSON/plain text pass through). Outbound only; internal/private addresses are refused.",
		promptSnippet:
			// Deliberately does not name the search tool: a room whose model
			// searches through its own provider has no `web_search` registered, and
			// a description that pointed at it would be naming something absent.
			"Use `fetch_url` to read a specific web page or API the user references by URL, or to open a page you found or were given, for example a search result. It returns readable Markdown, not raw HTML, and can render JavaScript-heavy pages. It cannot reach internal/private hosts and does not download binary files. When you use anything from a fetched page in your answer, cite it as a clickable Markdown link to the exact URL you fetched — [page title](https://the-actual-url) — so the user can click through. Never mention tool or function names (e.g. `fetch_url`) anywhere in your answer, not even to describe how you got the content — say it in plain language instead (\"I read the page at …\"). Never present a URL as plain or code-formatted text; always make it a Markdown link.",
		parameters: Type.Object({
			url: Type.String({ description: "The absolute http(s) URL to fetch." }),
			max_chars: Type.Optional(
				Type.Number({ description: `Maximum characters of content to return. Default ${DEFAULT_MAX_CHARS}, max ${HARD_MAX_CHARS}.` }),
			),
		}),
		async execute(_id, { url, max_chars }): Promise<any> {
			if (isDisabled()) {
				return {
					content: [{ type: "text", text: "URL fetching is disabled in this environment." }],
					details: { disabled: true },
					isError: true,
				};
			}

			const limit = Math.max(500, Math.min(HARD_MAX_CHARS, Math.floor(Number(max_chars ?? DEFAULT_MAX_CHARS)) || DEFAULT_MAX_CHARS));

			let outcome: FetchOutcome;
			try {
				outcome = await fetchStatic(String(url).trim());
			} catch (e) {
				return {
					content: [{ type: "text", text: `Fetch failed: ${(e as Error).message}` }],
					details: { url, error: (e as Error).message },
					isError: true,
				};
			}

			if (!isTextualContentType(outcome.contentType)) {
				return {
					content: [
						{
							type: "text",
							text: `Cannot read "${outcome.finalUrl}" — content type "${outcome.contentType || "unknown"}" is not textual (binary/file downloads are not supported).`,
						},
					],
					details: { url, finalUrl: outcome.finalUrl, status: outcome.status, contentType: outcome.contentType, binary: true },
					isError: true,
				};
			}

			const isHtml = outcome.contentType.includes("html") || /^\s*<(?:!doctype|html)/i.test(outcome.body);

			// Non-HTML textual payloads (JSON, plain text, XML, CSV) pass through as-is.
			if (!isHtml) {
				if (looksGarbled(outcome.body)) {
					return {
						content: [{ type: "text", text: `Cannot read "${outcome.finalUrl}" — ${GARBLED_EXPLANATION}` }],
						details: { url, finalUrl: outcome.finalUrl, status: outcome.status, contentType: outcome.contentType, garbled: true },
						isError: true,
					};
				}
				const body = outcome.body.trim();
				const truncated = body.length > limit;
				const text = truncated ? body.slice(0, limit) : body;
				const header = [
					`Source: [${outcome.finalUrl}](${outcome.finalUrl})`,
					outcome.status !== 200 ? `_HTTP ${outcome.status} ${outcome.statusText}_` : null,
					truncated || outcome.truncatedBytes ? `_(truncated — showing the first ${text.length} characters)_` : null,
				]
					.filter(Boolean)
					.join("\n");
				return {
					content: [{ type: "text", text: `${header}\n\n${text}`.trim() }],
					details: { url, finalUrl: outcome.finalUrl, status: outcome.status, contentType: outcome.contentType, format: "raw", chars: text.length, truncated: truncated || outcome.truncatedBytes },
				};
			}

			// HTML → readable Markdown, with a browser fallback for JS-empty pages,
			// likely bot-block/challenge responses, and garbled (undecodable) bodies
			// (the browser runs page JS, looks like a real visitor, and handles
			// proxy quirks natively).
			const staticGarbled = looksGarbled(outcome.body);
			let extracted = staticGarbled ? { markdown: "", textLength: 0 } as ExtractedContent : extractReadable(outcome.body, outcome.finalUrl);
			let finalUrl = outcome.finalUrl;
			let renderedWithBrowser = false;
			let browserWanted = false;
			if (staticGarbled || extracted.textLength < THIN_TEXT_THRESHOLD || BLOCKED_STATUSES.has(outcome.status)) {
				browserWanted = true;
				const rendered = await renderWithBrowser(outcome.finalUrl);
				if (rendered) {
					const reExtracted = extractReadable(rendered.html, rendered.finalUrl);
					if (reExtracted.textLength > extracted.textLength) {
						extracted = reExtracted;
						finalUrl = rendered.finalUrl;
						renderedWithBrowser = true;
					}
				}
			}

			// The static body was undecodable and the browser could not recover it:
			// explain the situation instead of handing the model binary junk.
			if (staticGarbled && !renderedWithBrowser) {
				const chromiumMissing = browserFallbackEnabled() && !(await loadChromium());
				const hint = chromiumMissing
					? " The headless-browser fallback (which often works around this) is not installed — run `npx playwright install chromium` from the exxperts folder to enable it."
					: "";
				return {
					content: [{ type: "text", text: `Cannot read "${outcome.finalUrl}" — ${GARBLED_EXPLANATION}${hint}` }],
					details: { url, finalUrl: outcome.finalUrl, status: outcome.status, contentType: outcome.contentType, garbled: true, chromiumMissing },
					isError: true,
				};
			}

			// The page needed the browser fallback but Chromium is not installed:
			// tell the user how to enable it instead of silently returning a shell.
			const browserUnavailableNote =
				browserWanted && !renderedWithBrowser && browserFallbackEnabled() && !(await loadChromium())
					? "_(this page may need JavaScript rendering — install the headless browser with `npx playwright install chromium` from the exxperts folder for better results)_"
					: null;

			const truncatedChars = extracted.markdown.length > limit;
			const text = truncatedChars ? extracted.markdown.slice(0, limit) : extracted.markdown;
			const header = [
				extracted.title ? `# ${extracted.title}` : null,
				`Source: [${finalUrl}](${finalUrl})`,
				outcome.status !== 200 ? `_HTTP ${outcome.status} ${outcome.statusText}_` : null,
				renderedWithBrowser ? "_(rendered with a headless browser)_" : null,
				browserUnavailableNote,
				truncatedChars || outcome.truncatedBytes ? `_(truncated — showing the first ${text.length} characters)_` : null,
			]
				.filter(Boolean)
				.join("\n");

			return {
				content: [{ type: "text", text: `${header}\n\n${text}`.trim() }],
				details: {
					url,
					finalUrl,
					status: outcome.status,
					contentType: outcome.contentType,
					title: extracted.title,
					format: "markdown",
					renderedWithBrowser,
					chars: text.length,
					truncated: truncatedChars || outcome.truncatedBytes,
				},
			};
		},
	});
}
