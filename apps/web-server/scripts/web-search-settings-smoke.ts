// The app's own web search, as a setting you can see and change.
//
// Two things used to be true and both were wrong. The choice lived only in a
// JSON file a terminal command wrote, with nothing in the app admitting it
// existed; and the search tool read that file once per process and cached the
// answer forever, so even editing the file by hand did nothing until the next
// launch. This proves the pair of fixes end to end: the endpoint reads and
// writes the same file the setup command writes, the answer changes inside one
// long-running server with no restart anywhere, and an environment variable
// still wins and is reported as the thing that won rather than hidden behind
// the saved value.
//
// Run: node scripts/run-smokes.mjs web-search-settings

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { authedFetch, type AuthedFetchInit, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-web-search-settings-"));
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const productAppRoot = path.join(tempHome, ".exxperts", "app");
const configPath = path.join(productAppRoot, "web-search.json");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

let port = 0;
let baseUrl = "";

function smokeEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	// A search variable inherited from the developer's own shell would decide
	// the answer for us, which is exactly the thing under test.
	delete env.EXXETA_SEARCH_PROVIDER;
	delete env.EXXETA_SEARCH_BASE_URL;
	env.HOME = tempHome;
	env.USERPROFILE = tempHome;
	env.PORT = String(port);
	env.EXXPERTS_AUTH_TOKEN = SMOKE_SERVER_AUTH_ENV.EXXPERTS_AUTH_TOKEN;
	env.EXXETA_HOME = repoRoot;
	env.EXXPERTS_CODING_AGENT_DIR = agentDir;
	return { ...env, ...extra };
}

async function waitForServer(server: ChildProcessWithoutNullStreams): Promise<void> {
	const deadline = Date.now() + 20000;
	let lastError = "server did not respond";
	while (Date.now() < deadline) {
		if (server.exitCode != null) throw new Error(`server exited before startup with code ${server.exitCode}`);
		try {
			const response = await fetch(`${baseUrl}/healthz`);
			if (response.ok) return;
			lastError = `healthz returned ${response.status}`;
		} catch (error) {
			lastError = (error as Error).message;
		}
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`server did not become ready: ${lastError}`);
}

async function requestJson(pathname: string, init?: AuthedFetchInit): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, init);
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

function putSettings(provider: string, searxngBaseUrl?: string) {
	return requestJson("/api/settings/web-search", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ provider, ...(searxngBaseUrl === undefined ? {} : { baseUrl: searxngBaseUrl }) }),
	});
}

function putProviderSearch(providerSearch: unknown) {
	return requestJson("/api/settings/web-search", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ providerSearch }),
	});
}

let server: ChildProcessWithoutNullStreams | null = null;
const serverOutput: string[] = [];

async function startServer(extraEnv: NodeJS.ProcessEnv = {}): Promise<void> {
	port = 24000 + Math.floor(Math.random() * 10000);
	baseUrl = `http://127.0.0.1:${port}`;
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeEnv(extraEnv),
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server);
}

try {
	fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	fs.mkdirSync(productAppRoot, { recursive: true, mode: 0o700 });

	// ---- the resolver the search tool itself uses ---------------------------
	// Same process, same module, three different answers as the file changes:
	// the cache that made this impossible is gone.
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
	delete process.env.EXXETA_SEARCH_PROVIDER;
	delete process.env.EXXETA_SEARCH_BASE_URL;
	const { resolveWebSearchSettings } = await import("../../../pi-package/extensions/web-search/index.js");
	assert(resolveWebSearchSettings().provider === "duckduckgo", "with nothing configured, search is DuckDuckGo");
	assert(resolveWebSearchSettings().source === "default", `nobody chose it, so nobody is credited with it, got ${JSON.stringify(resolveWebSearchSettings())}`);
	fs.writeFileSync(configPath, JSON.stringify({ provider: "searxng", baseUrl: "http://localhost:8080" }), { mode: 0o600 });
	assert(resolveWebSearchSettings().provider === "searxng", "a file written under the resolver's feet is read on the next call");
	fs.writeFileSync(configPath, JSON.stringify({ provider: "disabled" }), { mode: 0o600 });
	assert(resolveWebSearchSettings().provider === "disabled", "and again, so no restart is ever needed to change it");
	fs.rmSync(configPath);

	// ---- the endpoint, in a server that stays up ----------------------------
	await startServer();

	const initial = await requestJson("/api/settings/web-search");
	assert(initial.status === 200, `reading the setting should work, got ${initial.status}: ${JSON.stringify(initial.body)}`);
	assert(initial.body.provider === "duckduckgo" && initial.body.source === "default", `an unconfigured app reports the zero-setup default, got ${JSON.stringify(initial.body)}`);
	assert(initial.body.saved.provider === null, `nothing is saved yet, and the payload should say so, got ${JSON.stringify(initial.body)}`);

	const toSearxng = await putSettings("searxng", "http://localhost:8888/");
	assert(toSearxng.status === 200, `saving SearXNG should work, got ${toSearxng.status}: ${JSON.stringify(toSearxng.body)}`);
	assert(toSearxng.body.provider === "searxng" && toSearxng.body.source === "settings", `the saved choice is now the one in force, got ${JSON.stringify(toSearxng.body)}`);
	assert(toSearxng.body.baseUrl === "http://localhost:8888", `a trailing slash is trimmed once, here, rather than at every search, got ${JSON.stringify(toSearxng.body)}`);

	// Parity with the setup command: same file, same two keys, either writer.
	const written = JSON.parse(fs.readFileSync(configPath, "utf-8"));
	assert(written.provider === "searxng" && written.baseUrl === "http://localhost:8888", `the file shape must stay what ./scripts/searxng start writes, got ${JSON.stringify(written)}`);

	// The same server, still running, answering differently.
	const toOff = await putSettings("disabled");
	assert(toOff.body.provider === "disabled" && toOff.body.source === "settings", `switching off must take effect immediately, got ${JSON.stringify(toOff.body)}`);
	assert(toOff.body.saved.baseUrl === "http://localhost:8888", `switching off must not throw away the instance address, got ${JSON.stringify(toOff.body)}`);
	const reread = await requestJson("/api/settings/web-search");
	assert(reread.body.provider === "disabled", `a fresh read of the same live server agrees, got ${JSON.stringify(reread.body)}`);
	const backOn = await putSettings("duckduckgo");
	assert(backOn.body.provider === "duckduckgo", `and back again, no restart, got ${JSON.stringify(backOn.body)}`);

	// An address that could never work is refused where somebody can still fix
	// it, not at search time in a room.
	const noAddress = await putSettings("searxng", "");
	assert(noAddress.status === 400, `SearXNG with no address should be refused, got ${noAddress.status}: ${JSON.stringify(noAddress.body)}`);
	const badAddress = await putSettings("searxng", "localhost:8080");
	assert(badAddress.status === 400, `an address with no scheme should be refused, got ${badAddress.status}: ${JSON.stringify(badAddress.body)}`);
	const badScheme = await putSettings("searxng", "ftp://localhost:8080");
	assert(badScheme.status === 400, `a non-http scheme should be refused, got ${badScheme.status}: ${JSON.stringify(badScheme.body)}`);
	const nonsense = await putSettings("bing");
	assert(nonsense.status === 400, `an unknown provider should be refused, got ${nonsense.status}: ${JSON.stringify(nonsense.body)}`);
	const stillDuckDuckGo = await requestJson("/api/settings/web-search");
	assert(stillDuckDuckGo.body.provider === "duckduckgo", `a refused save must leave the setting alone, got ${JSON.stringify(stillDuckDuckGo.body)}`);

	// ---- provider search: on unless somebody said otherwise -----------------
	// The file phase one wrote says nothing about provider search, and silence
	// has to read as the default rather than as off, or upgrading would quietly
	// take the better search away from every Claude and ChatGPT room.
	const legacyShaped = JSON.parse(fs.readFileSync(configPath, "utf-8"));
	assert(legacyShaped.providerSearch === undefined, "the file only grows the key once somebody sets it");
	const beforeToggle = await requestJson("/api/settings/web-search");
	assert(beforeToggle.body.providerSearch === true, `an older file must read as provider search on, got ${JSON.stringify(beforeToggle.body)}`);

	const toggledOff = await putProviderSearch(false);
	assert(toggledOff.status === 200, `turning provider search off should work, got ${toggledOff.status}: ${JSON.stringify(toggledOff.body)}`);
	assert(toggledOff.body.providerSearch === false, `the toggle must round-trip, got ${JSON.stringify(toggledOff.body)}`);
	// The two decisions are independent: flipping one must not restate the other.
	assert(toggledOff.body.provider === "duckduckgo", `the backend choice must survive a toggle, got ${JSON.stringify(toggledOff.body)}`);
	assert(toggledOff.body.saved.baseUrl === "http://localhost:8888", `the saved address must survive a toggle, got ${JSON.stringify(toggledOff.body)}`);
	assert(JSON.parse(fs.readFileSync(configPath, "utf-8")).providerSearch === false, "the choice is on disk, not only in the answer");

	const backToSearxng = await putSettings("searxng", "http://localhost:8888");
	assert(backToSearxng.body.providerSearch === false, `choosing a backend must not silently re-enable provider search, got ${JSON.stringify(backToSearxng.body)}`);
	const toggledOn = await putProviderSearch(true);
	assert(toggledOn.body.providerSearch === true && toggledOn.body.provider === "searxng", `turning it back on must leave the backend alone, got ${JSON.stringify(toggledOn.body)}`);
	const notABoolean = await putProviderSearch("yes");
	assert(notABoolean.status === 400, `a non-boolean toggle should be refused, got ${notABoolean.status}: ${JSON.stringify(notABoolean.body)}`);
	await putSettings("duckduckgo");

	// ---- a stale address must not block turning search off ------------------
	// The address is only the SearXNG address when SearXNG is the choice. Any
	// other time it is a remembered value, and refusing to save because a
	// remembered value looks wrong would trap somebody who just wants search off.
	await putSettings("searxng", "http://localhost:8888");
	const offWithStaleAddress = await requestJson("/api/settings/web-search", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ provider: "disabled", baseUrl: "not a url at all" }),
	});
	assert(offWithStaleAddress.status === 200, `switching off must not be blocked by the address field, got ${offWithStaleAddress.status}: ${JSON.stringify(offWithStaleAddress.body)}`);
	assert(offWithStaleAddress.body.provider === "disabled", `and must actually switch off, got ${JSON.stringify(offWithStaleAddress.body)}`);
	// An explicit empty string is the one way to say "forget the address".
	const cleared = await requestJson("/api/settings/web-search", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ provider: "duckduckgo", baseUrl: "" }),
	});
	assert(cleared.body.saved.baseUrl === "", `an empty address must clear the saved one, got ${JSON.stringify(cleared.body)}`);
	const searxngNeedsOne = await putSettings("searxng", "");
	assert(searxngNeedsOne.status === 400, `and SearXNG with nothing remembered must still be refused, got ${searxngNeedsOne.status}`);
	await putSettings("duckduckgo");

	// ---- a settings file nobody can read ------------------------------------
	// Reading it as empty would silently delete whatever it says on the next
	// save, and would hand a deployment the provider search it may have turned
	// off. Both directions are refused instead.
	fs.writeFileSync(configPath, "{ this is not json", { mode: 0o600 });
	const brokenRead = await requestJson("/api/settings/web-search");
	assert(brokenRead.status === 200, `reading a broken file should still answer, got ${brokenRead.status}`);
	assert(brokenRead.body.unreadable, `and must say the file is broken, got ${JSON.stringify(brokenRead.body)}`);
	assert(brokenRead.body.providerSearch === false, `a broken file fails closed on provider search, got ${JSON.stringify(brokenRead.body)}`);
	const brokenWrite = await putProviderSearch(true);
	assert(brokenWrite.status === 500, `saving over an unreadable file must be refused, got ${brokenWrite.status}: ${JSON.stringify(brokenWrite.body)}`);
	assert(/Refusing to save/.test(String(brokenWrite.body?.error ?? "")), `and must say why, got ${JSON.stringify(brokenWrite.body)}`);
	assert(fs.readFileSync(configPath, "utf-8") === "{ this is not json", "a refused save leaves the file exactly as it was");
	fs.rmSync(configPath);
	const afterRepair = await requestJson("/api/settings/web-search");
	assert(!afterRepair.body.unreadable && afterRepair.body.providerSearch === true, `removing the broken file restores the defaults, got ${JSON.stringify(afterRepair.body)}`);
	await putSettings("duckduckgo");

	// ---- the environment still wins, and says so ----------------------------
	await stopSmokeServer(server);
	server = null;
	await startServer({ EXXETA_SEARCH_PROVIDER: "disabled" });

	const overridden = await requestJson("/api/settings/web-search");
	assert(overridden.body.provider === "disabled", `the environment variable decides what runs, got ${JSON.stringify(overridden.body)}`);
	assert(overridden.body.source === "environment", `and the payload must credit it, not the saved file, got ${JSON.stringify(overridden.body)}`);
	assert(overridden.body.envProvider === "disabled", `the screen needs the variable's value to name it, got ${JSON.stringify(overridden.body)}`);
	assert(overridden.body.saved.provider === "duckduckgo", `the saved choice is still visible underneath, got ${JSON.stringify(overridden.body)}`);
	// The variable picks a local backend. Reading it as "and no provider search
	// either" would turn a backend choice into a data-governance decision
	// nobody made, so provider search is deliberately deaf to it.
	assert(overridden.body.providerSearch === true, `the environment variable must not govern provider search, got ${JSON.stringify(overridden.body)}`);

	// Saving under an override is allowed and honest: it is written, and the
	// answer still says the variable is the one being obeyed.
	const savedUnderOverride = await putSettings("searxng", "http://localhost:9999");
	assert(savedUnderOverride.status === 200, `saving under an override should still work, got ${savedUnderOverride.status}`);
	assert(savedUnderOverride.body.provider === "disabled" && savedUnderOverride.body.source === "environment", `saving must not pretend the override went away, got ${JSON.stringify(savedUnderOverride.body)}`);
	assert(savedUnderOverride.body.saved.provider === "searxng", `what was saved must be reported as saved, got ${JSON.stringify(savedUnderOverride.body)}`);

	console.log("web-search settings smoke passed");
} catch (error) {
	const output = serverOutput.join("").trim();
	if (output) console.error(output.split("\n").slice(-80).join("\n"));
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp HOME preserved for inspection: ${tempHome}`);
	process.exitCode = 1;
} finally {
	await stopSmokeServer(server);
	if (process.exitCode == null || process.exitCode === 0) {
		fs.rmSync(tempHome, { recursive: true, force: true });
	}
}
