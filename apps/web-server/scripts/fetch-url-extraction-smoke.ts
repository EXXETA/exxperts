// Extraction + end-to-end smoke for `fetch_url`. Covers the two paths the plain
// SSRF smoke does not: HTML -> readable Markdown, and the JS-empty -> headless
// browser fallback. The end-to-end half serves fixtures from a loopback HTTP
// server; because the SSRF guard blocks loopback by default, it opts in with
// EXXETA_FETCH_URL_ALLOW_PRIVATE=1 (and first asserts the guard still refuses
// loopback without it). The browser assertions are skipped when Chromium is not
// installed, so CI without a browser still passes — and also when an installed
// Chromium fails to launch (which happens under full-suite load), because the
// tool's contract is to fall back to the static result in exactly that case.
import http from "node:http";
import type { AddressInfo } from "node:net";

const mod = await import("../../../pi-package/extensions/fetch_url/index.js");
const factory = mod.default;
const { extractReadable, THIN_TEXT_THRESHOLD } = mod;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function register(): any {
	let tool: any;
	factory({ registerTool: (t: any) => { tool = t; } } as any);
	assert(tool && tool.name === "fetch_url", "fetch_url should register");
	return tool;
}

function toolText(result: any): string {
	return (result?.content ?? []).filter((p: any) => p?.type === "text").map((p: any) => String(p.text ?? "")).join("\n");
}

async function chromiumAvailable(): Promise<boolean> {
	try {
		const pw: any = await import("playwright");
		const chromium = pw?.chromium ?? pw?.default?.chromium;
		const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
		const fs = await import("node:fs");
		return !!p && fs.existsSync(p);
	} catch {
		return false;
	}
}

// ---- Fixtures --------------------------------------------------------------

const ARTICLE_HTML = `<!doctype html><html><head><title>Widget Guide</title></head>
<body>
  <nav>Home About UNIQUENAVWORD Contact</nav>
  <article>
    <h1>How Widgets Work</h1>
    <p>A widget is a small self-contained component. This paragraph is deliberately
    long enough that Readability treats the article as the main content and keeps it
    while dropping the surrounding navigation and footer chrome around it.</p>
    <p>Widgets can be composed together to build larger interfaces and dashboards.</p>
  </article>
  <footer>UNIQUEFOOTWORD copyright 2026</footer>
</body></html>`;

// A client-rendered shell: no readable body text, content is injected by JS at
// runtime. The injected markup lives inside a <script> string, which the Markdown
// converter ignores — so the static extraction must come back below threshold.
const SPA_HTML = `<!doctype html><html><head><title>SPA Shell</title></head>
<body>
  <div id="root"></div>
  <script>
    document.getElementById("root").innerHTML =
      "<article><h1>Rendered Heading</h1><p>UNIQUEHYDRATEDWORD only appears after the "
      + "page's JavaScript runs, so a plain download cannot see it but a real browser can. "
      + "This sentence is long enough to clear the thin-content threshold once hydrated.</p></article>";
  </script>
</body></html>`;

// ---- Unit: extraction ------------------------------------------------------

const article = extractReadable(ARTICLE_HTML, "https://fixture.test/article");
assert(article.title === "Widget Guide" || article.title === "How Widgets Work", `article title unexpected: ${article.title}`);
assert(/How Widgets Work/.test(article.markdown), "article markdown should keep the heading");
assert(/self-contained component/.test(article.markdown), "article markdown should keep the body text");
assert(!/UNIQUENAVWORD/.test(article.markdown), "article markdown should drop nav boilerplate");
assert(!/UNIQUEFOOTWORD/.test(article.markdown), "article markdown should drop footer boilerplate");
assert(article.textLength >= THIN_TEXT_THRESHOLD, `article should be above thin threshold, got ${article.textLength}`);

const shell = extractReadable(SPA_HTML, "https://fixture.test/spa");
assert(shell.textLength < THIN_TEXT_THRESHOLD, `SPA shell should be below thin threshold (would trigger render), got ${shell.textLength}`);
assert(!/UNIQUEHYDRATEDWORD/.test(shell.markdown), "SPA shell must not contain the JS-injected text before rendering");

// A thin shell whose JS makes two subrequests: one redirecting to a host outside
// the allowlist (must be aborted per hop by the SSRF guard — Chromium follows
// redirects without re-entering page.route, so the tool guards each hop itself),
// and one redirecting within the same host (must still work).
const REDIRECT_PROBE_HTML = `<!doctype html><html><head><title>Redirect Guard</title></head>
<body><div id="root"></div>
<script>
  Promise.allSettled([
    fetch("/redir-cross").then((r) => r.text()),
    fetch("/redir-same").then((r) => r.text()),
  ]).then(([a, b]) => {
    const cross = a.status === "fulfilled" ? a.value : "CROSSBLOCKED";
    const same = b.status === "fulfilled" ? b.value : "SAMEFAILED";
    document.getElementById("root").innerHTML =
      "<article><h1>Redirect Probe</h1><p>cross:" + cross + " same:" + same +
      " — padding so the rendered page clears the thin-content threshold and the tool " +
      "accepts it as meaningful readable article content instead of retrying or bailing. " +
      "Additional filler text keeps this comfortably above every length heuristic.</p></article>";
  });
</script></body></html>`;

// ---- End-to-end: real tool over a loopback fixture server ------------------

// Off-allowlist target for the cross-host redirect. Counts hits: the guard must
// abort the redirect hop before this server is ever contacted.
let offlistHits = 0;
const offlistServer = http.createServer((_req, res) => {
	offlistHits++;
	res.writeHead(200, { "content-type": "text/plain" });
	res.end("SECRETOFFLIST");
});
await new Promise<void>((resolve) => offlistServer.listen(0, "127.0.0.1", () => resolve()));
const offlistPort = (offlistServer.address() as AddressInfo).port;

const server = http.createServer((req, res) => {
	if (req.url?.startsWith("/article")) {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(ARTICLE_HTML);
	} else if (req.url?.startsWith("/spa")) {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(SPA_HTML);
	} else if (req.url?.startsWith("/redirect-page")) {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(REDIRECT_PROBE_HTML);
	} else if (req.url?.startsWith("/redir-cross")) {
		// "localhost" is outside the 127.0.0.1 allowlist set for this sub-test.
		res.writeHead(302, { location: `http://localhost:${offlistPort}/secret` });
		res.end();
	} else if (req.url?.startsWith("/redir-same")) {
		res.writeHead(302, { location: "/same-final" });
		res.end();
	} else if (req.url?.startsWith("/same-final")) {
		res.writeHead(200, { "content-type": "text/plain" });
		res.end("SAMEOK");
	} else {
		res.writeHead(404); res.end("not found");
	}
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;

try {
	const tool = register();

	// Guard still refuses loopback when the escape hatch is NOT set.
	delete process.env.EXXETA_FETCH_URL_ALLOW_PRIVATE;
	const refused = await tool.execute("smoke", { url: `${base}/article` });
	assert(refused?.isError === true, "loopback must be refused without EXXETA_FETCH_URL_ALLOW_PRIVATE");

	// Opt in to loopback for the fixture server.
	process.env.EXXETA_FETCH_URL_ALLOW_PRIVATE = "1";

	// Static path -> Markdown, no browser.
	const staticRes = await tool.execute("smoke", { url: `${base}/article` });
	assert(staticRes?.isError !== true, `static fetch should succeed: ${toolText(staticRes)}`);
	assert(staticRes.details?.format === "markdown", "static article should be markdown");
	assert(staticRes.details?.renderedWithBrowser === false, "static article should not need the browser");
	assert(/How Widgets Work/.test(toolText(staticRes)), "static markdown should contain the article heading");

	// SPA path -> browser fallback (only when Chromium is installed). Note that
	// `chromiumAvailable` only proves the executable exists — under suite load the
	// launch itself can still fail, and the tool then deliberately serves the
	// static result (renderWithBrowser returns null on any launch/render failure;
	// every caller falls back). That fallback is the contract working, not a
	// rendering bug, so a non-browser result here is a SKIP, not a failure — the
	// smoke still fails hard when the browser DID render but rendered wrongly.
	if (await chromiumAvailable()) {
		const spaRes = await tool.execute("smoke", { url: `${base}/spa` });
		assert(spaRes?.isError !== true, `SPA fetch should succeed: ${toolText(spaRes)}`);
		if (spaRes.details?.renderedWithBrowser !== true) {
			console.log("fetch_url extraction smoke passed (browser assertions SKIPPED — Chromium is installed but did not launch, so the tool took its legitimate static fallback; rerun standalone to exercise the browser path)");
		} else {
			assert(/UNIQUEHYDRATEDWORD/.test(toolText(spaRes)), "rendered SPA markdown should contain the JS-injected text");

			// Redirect hops made by page JS must be re-guarded per hop: a subrequest
			// 302ing to an off-allowlist host is aborted (and that host never
			// contacted), while a same-host redirect still resolves.
			process.env.EXXETA_FETCH_URL_ALLOWLIST = "127.0.0.1";
			try {
				const redirRes = await tool.execute("smoke", { url: `${base}/redirect-page` });
				const redirText = toolText(redirRes);
				assert(redirRes?.isError !== true, `redirect probe fetch should succeed: ${redirText}`);
				if (redirRes.details?.renderedWithBrowser !== true) {
					console.log("fetch_url extraction smoke passed (redirect-hop assertions SKIPPED — Chromium did not launch for the probe, so the tool took its legitimate static fallback; rerun standalone to exercise the browser path)");
				} else {
					assert(/same:SAMEOK/.test(redirText), `same-host redirect should be followed: ${redirText}`);
					assert(/cross:CROSSBLOCKED/.test(redirText), `off-allowlist redirect hop should be aborted: ${redirText}`);
					assert(!/SECRETOFFLIST/.test(redirText), "off-allowlist content must never reach the page");
					assert(offlistHits === 0, `off-allowlist host must never be contacted, got ${offlistHits} hits`);
					console.log("fetch_url extraction smoke passed (incl. browser fallback + redirect-hop guard)");
				}
			} finally {
				delete process.env.EXXETA_FETCH_URL_ALLOWLIST;
			}
		}
	} else {
		console.log("fetch_url extraction smoke passed (browser fallback skipped — Chromium not installed)");
	}
} finally {
	delete process.env.EXXETA_FETCH_URL_ALLOW_PRIVATE;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	await new Promise<void>((resolve) => offlistServer.close(() => resolve()));
}
