// Smoke test for the curated `fetch_url` room tool. Covers registration, the
// SSRF guard (internal/private/reserved hosts and non-http schemes must be
// refused), the optional host allowlist, and the disable kill-switch. Network
// egress is deliberately NOT exercised so the test is deterministic offline.
const factory = (await import("../../../pi-package/extensions/fetch_url/index.js")).default;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function register(): any {
	let tool: any;
	factory({ registerTool: (t: any) => { tool = t; } } as any);
	assert(tool && tool.name === "fetch_url", "fetch_url tool should register");
	return tool;
}

function toolText(result: any): string {
	return (result?.content ?? []).filter((p: any) => p?.type === "text").map((p: any) => String(p.text ?? "")).join("\n");
}

async function expectRefused(tool: any, url: string): Promise<void> {
	const result = await tool.execute("smoke", { url });
	assert(result?.isError === true, `expected refusal for ${url}, got: ${toolText(result)}`);
}

const REFUSED_URLS = [
	"http://127.0.0.1/",
	"http://localhost:8080/admin",
	"http://169.254.169.254/latest/meta-data/", // cloud metadata endpoint
	"http://10.0.0.5/",
	"http://192.168.1.1/",
	"http://172.16.0.1/",
	"https://[::1]/",
	"http://[fd00::1]/",
	"http://[::ffff:169.254.169.254]/", // IPv4-mapped metadata endpoint, dotted spelling
	"http://[::ffff:a9fe:a9fe]/", // same address in the hex spelling URL normalisation produces
	"http://[::ffff:7f00:1]/", // IPv4-mapped loopback, hex spelling
	"http://[::169.254.169.254]/", // IPv4-compatible spelling
	"http://[0:0:0:0:0:0:0:1]/", // uncompressed loopback spelling
	"http://[fe80::1]/", // link-local
	"ftp://example.com/file",
	"file:///etc/passwd",
	"http://foo.internal/",
	"http://bar.local/",
	"not-a-url",
];

const tool = register();

for (const url of REFUSED_URLS) {
	await expectRefused(tool, url);
}

// Host allowlist: when set, hosts outside the suffix list are refused even if public.
process.env.EXXETA_FETCH_URL_ALLOWLIST = "example.com";
const allowScoped = register();
const blockedByAllowlist = await allowScoped.execute("smoke", { url: "https://not-listed.org/" });
assert(blockedByAllowlist?.isError === true, "host outside allowlist should be refused");
assert(/allowlist/i.test(toolText(blockedByAllowlist)), "refusal should mention the allowlist");
delete process.env.EXXETA_FETCH_URL_ALLOWLIST;

// Kill-switch: disabling the tool refuses everything before any network work.
process.env.EXXETA_FETCH_URL_DISABLED = "1";
const disabled = register();
const disabledResult = await disabled.execute("smoke", { url: "https://example.com/" });
assert(disabledResult?.isError === true, "disabled fetch_url should refuse");
assert(/disabled/i.test(toolText(disabledResult)), "refusal should mention disabled state");
delete process.env.EXXETA_FETCH_URL_DISABLED;

// A page or an API that answers 4xx or 5xx is a failure the room and the model both see, not a page read.
{
	const http = await import("node:http");
	const server = http.createServer((req, res) => {
		if (req.url === "/missing.json") { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "not found; use /v2/notes" })); return; }
		if (req.url === "/long-404") { res.writeHead(404, { "content-type": "text/plain" }); res.end("gone ".repeat(4_000)); return; }
		if (req.url === "/broken") { res.writeHead(500, { "content-type": "text/html" }); res.end("<html><head><title>Server Error</title></head><body><h1>Server Error</h1><p>Something broke on our side, please try again later.</p></body></html>"); return; }
		res.writeHead(200, { "content-type": "text/plain" }); res.end("The export takes five minutes.");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	process.env.EXXETA_FETCH_URL_ALLOW_PRIVATE = "1";
	process.env.EXXETA_FETCH_URL_BROWSER = "off";
	try {
		const local = register();
		const missing = await local.execute("smoke", { url: `http://127.0.0.1:${port}/missing.json` });
		assert(missing?.isError === true && toolText(missing).startsWith("Couldn't read page: the site answered 404 Not Found.\n"), `a 404 is a failure, got ${missing?.isError} ${toolText(missing)}`);
		assert(toolText(missing).includes('{"error":"not found; use /v2/notes"}'), `the model keeps what the site said beside the failure, got ${toolText(missing)}`);
		const broken = await local.execute("smoke", { url: `http://127.0.0.1:${port}/broken` });
		assert(broken?.isError === true && toolText(broken).startsWith("Couldn't read page: the site answered 500 Internal Server Error.\n") && toolText(broken).includes("Something broke on our side"), `a 500 is a failure, with the page's words for the model, got ${broken?.isError} ${toolText(broken)}`);
		const long = await local.execute("smoke", { url: `http://127.0.0.1:${port}/long-404` });
		assert(long?.isError === true && toolText(long).length < 2_300, `what the site said is kept short, got ${toolText(long).length} characters`);
		const { stepPlainLine } = await import("../../web-ui/src/step-lines.js");
		// The card's label already says it could not read the page; its line says what the site answered.
		assert(stepPlainLine(toolText(missing)) === "The site answered 404 Not Found.", `the card shows only the plain line, got ${stepPlainLine(toolText(missing))}`);
		const fine = await local.execute("smoke", { url: `http://127.0.0.1:${port}/notes.txt` });
		assert(fine?.isError !== true && toolText(fine).includes("five minutes"), `a page that answers is read, got ${toolText(fine)}`);
	} finally {
		delete process.env.EXXETA_FETCH_URL_ALLOW_PRIVATE;
		delete process.env.EXXETA_FETCH_URL_BROWSER;
		server.close();
	}
}

console.log("fetch_url tool smoke passed");

export {};
