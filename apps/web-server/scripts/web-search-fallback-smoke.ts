// Pins the DuckDuckGo HTML parser of the web_search extension against a
// saved-markup fixture: the endpoint's markup is the one contract we do not
// control, so the parse rules (uddg redirect decoding, ad dropping, entity
// decoding, snippet pairing, limit) are asserted offline - no network, CI
// safe. The live endpoint is exercised in release verification, not here.
import { parseDuckDuckGoHtml } from "../../../pi-package/extensions/web-search/index.js";

function fail(msg: string): never {
	console.error(`web-search-fallback-smoke: FAIL ${msg}`);
	process.exit(1);
}

// Trimmed real-world shape: two organic results (one with entities, one with
// a nested <b> in the title and no snippet), one ad (y.js href), one
// uddg-less internal link.
const FIXTURE = `
<div class="serp__results">
<div class="result results_links results_links_deep result--ad">
  <a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_provider=x&u3=https%3A%2F%2Fads.example.com">Sponsored thing</a>
  <a class="result__snippet" href="#">Buy now.</a>
</div>
<div class="result results_links results_links_deep web-result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs%3Fa%3D1%26b%3D2&amp;rut=abc">Example Docs &amp; Guides</a>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">The <b>official</b> docs &#x27;guide&#x27; for examples.</a>
</div>
<div class="result results_links results_links_deep web-result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fsecond.example.org%2F&amp;rut=def">Second <b>Result</b></a>
</div>
<div class="result results_links">
  <a rel="nofollow" class="result__a" href="https://duckduckgo.com/settings">Settings</a>
</div>
</div>`;

const parsed = parseDuckDuckGoHtml(FIXTURE, 10);
if (parsed.length !== 2) fail(`expected 2 organic results, got ${parsed.length}: ${JSON.stringify(parsed)}`);
const [first, second] = parsed;
if (first!.url !== "https://example.com/docs?a=1&b=2") fail(`uddg decode wrong: ${first!.url}`);
if (first!.title !== "Example Docs & Guides") fail(`entity decode wrong: ${JSON.stringify(first!.title)}`);
if (first!.snippet !== "The official docs 'guide' for examples.") fail(`snippet wrong: ${JSON.stringify(first!.snippet)}`);
if (second!.url !== "https://second.example.org/") fail(`second url wrong: ${second!.url}`);
if (second!.title !== "Second Result") fail(`tag strip wrong: ${JSON.stringify(second!.title)}`);
if (second!.snippet !== "") fail(`missing snippet must be empty, got ${JSON.stringify(second!.snippet)}`);

const limited = parseDuckDuckGoHtml(FIXTURE, 1);
if (limited.length !== 1) fail(`limit not applied: got ${limited.length}`);

// Hostile feed: uddg targets with non-http(s) schemes must be dropped, not
// handed to whatever renders the results.
const HOSTILE = `
<div class="result web-result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=javascript%3Aalert(1)">Evil JS</a>
</div>
<div class="result web-result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=file%3A%2F%2F%2Fetc%2Fpasswd">Evil file</a>
</div>
<div class="result web-result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=data%3Atext%2Fhtml%3Bbase64%2CZXZpbA">Evil data</a>
</div>
<div class="result web-result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=not%20a%20url">Evil garbage</a>
</div>
<div class="result web-result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fok.example.com%2F">Legit survivor</a>
</div>`;
const hostile = parseDuckDuckGoHtml(HOSTILE, 10);
if (hostile.length !== 1 || hostile[0]!.url !== "https://ok.example.com/") {
	fail(`hostile uddg schemes must be dropped, only the http(s) survivor kept: ${JSON.stringify(hostile)}`);
}

// Double-escaped entities must single-decode ("&amp;lt;b&amp;gt;" is the
// literal text "&lt;b&gt;", never a real tag).
const DOUBLE = `
<div class="result web-result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fd.example.com%2F">Uses &amp;lt;b&amp;gt; literally</a>
</div>`;
const doubled = parseDuckDuckGoHtml(DOUBLE, 10);
if (doubled[0]?.title !== "Uses &lt;b&gt; literally") {
	fail(`entity double-decode: expected the literal escaped form, got ${JSON.stringify(doubled[0]?.title)}`);
}

if (parseDuckDuckGoHtml("<html><body>anomaly page, no results</body></html>", 5).length !== 0) fail("garbage HTML must parse to zero results");

console.log("web-search-fallback-smoke: OK (2 organic parsed, ad and internal links dropped, entities and uddg decoded, limit applied, hostile uddg schemes dropped, double-escaped entities single-decoded)");

// S6: outage cache and DDG pacing logic, offline.
import { createOutageCache, ddgDelayMs } from "../../../pi-package/extensions/web-search/index.js";
{
	const cache = createOutageCache(5 * 60_000);
	const t0 = 1_000_000;
	if (cache.isDown(t0)) fail("outage cache must start up");
	cache.markDown(t0);
	if (!cache.isDown(t0 + 1)) fail("outage cache must report down inside the window");
	if (!cache.isDown(t0 + 5 * 60_000 - 1)) fail("outage cache must hold for the full window");
	if (cache.isDown(t0 + 5 * 60_000)) fail("outage cache must expire at the window edge (re-probe)");
	cache.markDown(t0);
	cache.markUp();
	if (cache.isDown(t0 + 1)) fail("markUp must clear the outage immediately");
	if (ddgDelayMs(0, 10_000, 1_500) !== 0) fail("first request must not wait");
	if (ddgDelayMs(10_000, 10_400, 1_500) !== 1_100) fail("burst request must wait out the remaining gap");
	if (ddgDelayMs(10_000, 12_000, 1_500) !== 0) fail("spaced request must not wait");
	console.log("web-search-fallback-smoke: S6 OK (outage window holds/expires/clears, ddg pacing gaps computed)");
}

// Challenge-page detection and the honest block message, offline.
import { DDG_BLOCKED_MESSAGE, isDdgChallenge } from "../../../pi-package/extensions/web-search/index.js";
{
	if (!isDdgChallenge("<html><body>anomaly detected, complete the challenge</body></html>", 0)) fail("challenge page with zero results must be detected");
	if (!isDdgChallenge("<html><body>please solve this CAPTCHA</body></html>", 0)) fail("captcha page with zero results must be detected");
	if (isDdgChallenge("<html><body>the daily challenge quiz</body></html>", 3)) fail("marker words with real results must not be treated as a block");
	if (isDdgChallenge("<html><body>no results for this query</body></html>", 0)) fail("plain zero-result page must not be treated as a block");
	const expected =
		"DuckDuckGo is blocking automated searches from this network: it served its bot-challenge page instead of results. Retrying soon is unlikely to help. For reliable web search on this network, set up a local SearXNG instance; see docs/web-search.md.";
	if (DDG_BLOCKED_MESSAGE !== expected) fail(`block message drifted from the pinned wording: ${JSON.stringify(DDG_BLOCKED_MESSAGE)}`);
	if (/try again in a moment/i.test(DDG_BLOCKED_MESSAGE)) fail("block message must not promise that waiting helps");
	console.log("web-search-fallback-smoke: challenge OK (detection edges pinned, honest block message pinned)");
}
