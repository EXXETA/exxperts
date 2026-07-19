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

console.log("fetch_url tool smoke passed");

export {};
