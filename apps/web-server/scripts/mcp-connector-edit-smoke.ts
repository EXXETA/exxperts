// A connector's display name and a changed address, against a really spawned
// web server, row by row:
//
//  D  the add route: any name, a fixed name made from it, no two alike, and an
//     entry named as before written exactly as before;
//  A  PUT /api/mcp/servers/:name/address: the same site keeps the sign-in and
//     the key, another site drops them and asks for the key again, rooms keep
//     their access, the cached tools and the last check go either way, and an
//     imported connector, a program or a malformed address is refused;
//  K  where a connector keeps its key, in the status and in Change key: a new
//     key goes where the old one was, its "Bearer " and its own sign-in app
//     kept, and one it can't place is refused; a connector that would lose
//     more than its key on another site can't move there;
//  T  a tool's own title reaches /api/mcp/status after a check;
//  C  the last check is kept and read back with the status;
//  U  the rooms that may use each connector, archived rooms left out.
//
// Offline: the connectors are stand-ins on 127.0.0.1; "another site" is the
// same stand-in under the name localhost, which is another origin.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONNECTOR_FORM_LINES, CONNECTOR_REQUEST_LINES, connectorShownName } from "../src/connector-form.js";
import { markedConnector } from "./smoke-marked-connector.js";
import { authedFetch, freePort, type AuthedFetchInit, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, waitForServer } from "./smoke-server-process.js";

const tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-connector-edit-home-")));
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const agentDir = path.join(tempHome, ".exxperts", "agent");
const productAppRoot = path.join(tempHome, ".exxperts", "app");
const agentsRoot = path.join(productAppRoot, "personalized-agents");
const configFile = path.join(agentDir, "mcp.json");
// The smoke reads the adapter's sign-in store from the same folder the server writes.
process.env.PI_CODING_AGENT_DIR = agentDir;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function smokeEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "AZURE_OPENAI_API_KEY", "EXXETA_AI_API_KEY", "COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "GEMINI_API_KEY", "GOOGLE_CLOUD_API_KEY", "OPENROUTER_API_KEY", "EXXPERTS_SHARED_SERVER"]) {
		delete env[key];
	}
	env.HOME = tempHome;
	env.USERPROFILE = tempHome;
	env.PORT = String(port);
	Object.assign(env, SMOKE_SERVER_AUTH_ENV);
	env.EXXETA_HOME = repoRoot;
	env.EXXPERTS_CODING_AGENT_DIR = agentDir;
	return env;
}

async function requestJson(pathname: string, init?: AuthedFetchInit): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, init);
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}
const send = (method: string, pathname: string, body: unknown) => requestJson(pathname, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const changeAddress = (name: string, body: unknown) => send("PUT", `/api/mcp/servers/${encodeURIComponent(name)}/address`, body);
const entries = (): Record<string, any> => JSON.parse(fs.readFileSync(configFile, "utf-8")).mcpServers;
async function statusOf(name: string): Promise<any> {
	const status = await requestJson("/api/mcp/status");
	assert(status.status === 200, `the status answers, got ${status.status}`);
	return status.body.servers.find((server: { name: string }) => server.name === name);
}
function grantsOf(roomId: string): string[] {
	return JSON.parse(fs.readFileSync(path.join(agentsRoot, roomId, "runtime", "mcp-settings.json"), "utf-8")).grantedConnectors;
}
function seedRoom(id: string, displayName: string, granted: string[], archived = false): void {
	fs.mkdirSync(path.join(agentsRoot, id, "runtime"), { recursive: true });
	fs.writeFileSync(path.join(agentsRoot, id, "agent.json"), JSON.stringify({ agentId: id, displayName, ...(archived ? { archivedAt: 1 } : {}) }));
	fs.writeFileSync(path.join(agentsRoot, id, "runtime", "mcp-settings.json"), JSON.stringify({ schemaVersion: 1, grantedConnectors: granted, updatedAt: "" }));
}

let server: ChildProcessWithoutNullStreams | null = null;
const serverOutput: string[] = [];
const connector = markedConnector();
connector.tools = [
	{ name: "create-page", title: "Create pages" },
	{ name: "update_database", annotations: { title: "Update a database" } },
	{ name: "get-self" },
] as typeof connector.tools;
await new Promise<void>((resolve) => connector.server.listen(0, "127.0.0.1", resolve));
const standInPort = (connector.server.address() as AddressInfo).port;
const here = (pathname: string) => `http://127.0.0.1:${standInPort}${pathname}`;
const elsewhere = (pathname: string) => `http://localhost:${standInPort}${pathname}`;
const notFound = http.createServer((_req, res) => res.writeHead(404).end("not here"));
await new Promise<void>((resolve) => notFound.listen(0, "127.0.0.1", resolve));
// Holds every request until released, then says the address isn't there: a check that outlives a change.
let releaseSlow!: () => void;
const slowReleased = new Promise<void>((resolve) => { releaseSlow = resolve; });
let slowAsked!: () => void;
const slowReached = new Promise<void>((resolve) => { slowAsked = resolve; });
const slow = http.createServer((req, res) => {
	req.resume();
	slowAsked();
	void slowReleased.then(() => res.writeHead(404).end("not here"));
});
await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", resolve));

try {
	fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	fs.mkdirSync(path.join(tempHome, ".cursor"), { recursive: true });
	fs.writeFileSync(path.join(tempHome, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { "from-cursor": { url: here("/cursor") } } }));
	fs.writeFileSync(configFile, JSON.stringify({
		imports: ["cursor"],
		mcpServers: {
			"My_Tool": { url: here("/mine") },
			"wiki-key": { displayName: "Team wiki", url: here("/wiki"), auth: "bearer", bearerToken: "key-one" },
			signed: { url: here("/signed") },
			"header-key": { url: here("/header"), auth: false, headers: { "X-Api-Key": "header-one", "X-Tenant": "acme" } },
			"odd-header": { url: here("/odd"), headers: { "X-Key": "odd-secret" } },
			"solo-key": { url: here("/solo"), auth: false, headers: { "X-Api-Key": "solo-one" } },
			"auth-header": { url: here("/auth"), auth: false, headers: { Authorization: "Bearer auth-one" } },
			"app-and-key": { url: here("/app"), oauth: { clientId: "synthetic-client" }, headers: { "X-Api-Key": "app-one" } },
			"key-and-signed": { url: here("/kas"), headers: { "X-Api-Key": "kas-one" } },
			"spaced-key": { url: here("/spaced"), auth: false, headers: { "X-Api-Key": "old value" } },
			"two-keys": { url: here("/two"), auth: false, headers: { "X-Api-Key": "two-one", Authorization: "Bearer two-one" } },
			"tenant-only": { url: here("/tenant"), headers: { "X-Tenant": "acme" } },
			"open-one": { url: here("/open"), auth: false },
			"not-found": { url: `http://127.0.0.1:${(notFound.address() as AddressInfo).port}/mcp`, auth: false },
			"slow-one": { url: `http://127.0.0.1:${(slow.address() as AddressInfo).port}/mcp`, auth: false },
			files: { command: "node", args: ["server.js"] },
		},
	}, null, 2));
	// No update-day migration: every room below has its own grants file.
	fs.mkdirSync(agentsRoot, { recursive: true });
	fs.writeFileSync(path.join(agentsRoot, ".mcp-grants-migration.json"), "{}");
	seedRoom("room-b", "Sales Review", ["wiki-key", "signed"]);
	seedRoom("room-a", "Board prep", ["wiki-key", "signed", "open-one"]);
	seedRoom("room-c", "Old archive", ["wiki-key"], true);
	const authStore = await import("pi-mcp-adapter/mcp-auth.ts" as string);
	authStore.saveAuthEntry("signed", { tokens: { accessToken: "signed-token", refreshToken: "signed-refresh" } }, here("/signed"));
	authStore.saveAuthEntry("key-and-signed", { tokens: { accessToken: "kas-token", refreshToken: "kas-refresh" } }, here("/kas"));

	server = spawn("npx", ["tsx", "src/index.ts"], { shell: process.platform === "win32", ...SMOKE_SERVER_SPAWN_TREE_OPTIONS, cwd: webServerDir, env: smokeEnv() });
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server, baseUrl, 30_000);

	// D: the add route.
	const teamWiki = await send("POST", "/api/mcp/servers", { name: "  Café   notes ", url: here("/notes") });
	assert(teamWiki.status === 200 && teamWiki.body.name === "cafe-notes", `D1 a typed name makes a fixed name, got ${JSON.stringify(teamWiki)}`);
	assert(entries()["cafe-notes"].displayName === "Café notes", `D1 the typed name is kept, got ${JSON.stringify(entries()["cafe-notes"])}`);
	assert((await statusOf("cafe-notes")).displayName === "Café notes", "D1 the status carries the typed name");
	const taken = await send("POST", "/api/mcp/servers", { name: "team WIKI", url: here("/other") });
	assert(taken.status === 409 && taken.body.error === CONNECTOR_FORM_LINES.nameTaken("Team wiki"), `D2 a name shown already is refused without case, got ${JSON.stringify(taken)}`);
	const takenDirectory = await send("POST", "/api/mcp/servers", { name: "My_tool", url: here("/other") });
	assert(takenDirectory.status === 409, `D2 an older connector's name as typed is taken too, got ${JSON.stringify(takenDirectory)}`);
	const sameFixed = await send("POST", "/api/mcp/servers", { name: "Wiki key", url: here("/other") });
	assert(sameFixed.status === 200 && sameFixed.body.name === "wiki-key-2" && entries()["wiki-key-2"].displayName === "Wiki key", `D3 a fixed name in use gets a number, got ${JSON.stringify(sameFixed)}`);
	const plain = await send("POST", "/api/mcp/servers", { name: "linear", url: here("/linear") });
	assert(plain.status === 200 && JSON.stringify(entries().linear) === JSON.stringify({ url: here("/linear") }), `D4 a name that is its own fixed name is written as before, got ${JSON.stringify(entries().linear)}`);
	const blank = await send("POST", "/api/mcp/servers", { name: " ​ ", url: here("/blank") });
	assert(blank.status === 400 && blank.body.error === CONNECTOR_FORM_LINES.nameMissing, `D5 a name of nothing is refused, got ${JSON.stringify(blank)}`);
	const older = await statusOf("My_Tool");
	assert(older && older.displayName === undefined && connectorShownName(older.name, older.displayName) === "My_Tool", `D6 an older connector shows its name as typed, got ${JSON.stringify(older)}`);
	assert(connectorShownName("notion") === "Notion" && connectorShownName("wiki-key", "Team wiki") === "Team wiki", "D6 the directory's name, else the typed name");
	const badAddress = await send("POST", "/api/mcp/servers", { name: "No scheme", url: "wiki.example.com/mcp" });
	assert(badAddress.status === 400 && badAddress.body.error === CONNECTOR_FORM_LINES.addressNotAnAddress, `D7 an address without its scheme gets the form's line, got ${JSON.stringify(badAddress)}`);

	// T and C: a check keeps the tools with their titles and its own result.
	const checked = await send("POST", "/api/mcp/servers/open-one/test", {});
	assert(checked.status === 200 && checked.body.ok === true, `T1 the check connects, got ${JSON.stringify(checked)}`);
	const openOne = await statusOf("open-one");
	assert(JSON.stringify(openOne.tools?.titles) === JSON.stringify({ "create-page": "Create pages", update_database: "Update a database" }), `T1 each tool's own title is passed, got ${JSON.stringify(openOne.tools)}`);
	assert(openOne.tools.names.includes("get-self"), "T1 a tool with no title keeps its name");
	assert(openOne.lastCheck?.ok === true, `C1 the last check is kept, got ${JSON.stringify(openOne.lastCheck)}`);
	const failed = await send("POST", "/api/mcp/servers/not-found/test", {});
	assert(failed.status === 200 && failed.body.ok === false, `C2 the check fails, got ${JSON.stringify(failed)}`);
	const notFoundRow = await statusOf("not-found");
	assert(notFoundRow.lastCheck?.ok === false && notFoundRow.lastCheck.httpStatus === 404, `C2 a failed check is kept with its status, got ${JSON.stringify(notFoundRow.lastCheck)}`);
	// Technical details: the status and the service's own words, nothing of ours.
	assert(notFoundRow.lastCheck.error === "HTTP 404: not here", `C2 a failed check keeps the service's words, got ${JSON.stringify(notFoundRow.lastCheck.error)}`);
	// C3: a check still running when its address changes says nothing about the new one, so nothing of it is kept.
	const staleCheck = send("POST", "/api/mcp/servers/slow-one/test", {});
	await slowReached;
	const moved = await changeAddress("slow-one", { url: here("/open") });
	assert(moved.status === 200, `C3 the address changes while a check runs, got ${JSON.stringify(moved)}`);
	releaseSlow();
	const stale = await staleCheck;
	assert(stale.status === 200 && stale.body.superseded === true, `C3 the old address's check says it was superseded, got ${JSON.stringify(stale)}`);
	const movedRow = await statusOf("slow-one");
	assert(movedRow.lastCheck == null && movedRow.tools == null, `C3 the old address's result is not kept for the new one, got ${JSON.stringify({ lastCheck: movedRow.lastCheck, tools: movedRow.tools })}`);

	// U: the rooms that may use each connector.
	const wiki = await statusOf("wiki-key");
	assert(JSON.stringify(wiki.usedIn) === JSON.stringify([{ id: "room-a", name: "Board prep" }, { id: "room-b", name: "Sales Review" }]), `U1 the rooms by name, the archived one left out, got ${JSON.stringify(wiki.usedIn)}`);
	assert(JSON.stringify((await statusOf("linear")).usedIn) === "[]", "U1 a connector no room uses");
	assert(wiki.editable === true && (await statusOf("files")).editable === false && (await statusOf("from-cursor")).editable === false, "U2 only a web connector added here can change its address");

	// A: the address route.
	const sameSiteOpen = await changeAddress("open-one", { url: here("/open/v2") });
	assert(sameSiteOpen.status === 200 && sameSiteOpen.body.sameSite === true, `A1 same site, got ${JSON.stringify(sameSiteOpen)}`);
	const openAfter = await statusOf("open-one");
	assert(openAfter.tools === null && openAfter.lastCheck === null, `A1 the cached tools and the last check go, got ${JSON.stringify([openAfter.tools, openAfter.lastCheck])}`);
	const cached = JSON.parse(fs.readFileSync(path.join(agentDir, "mcp-cache.json"), "utf-8")).servers;
	assert(!("open-one" in cached), `A1 the old address's tools leave the cache file, got ${JSON.stringify(Object.keys(cached))}`);
	assert(entries()["open-one"].auth === false && entries()["open-one"].url === here("/open/v2"), "A1 the entry keeps what it had");
	assert(grantsOf("room-a").includes("open-one"), "A1 rooms keep their access");

	const sameSiteSigned = await changeAddress("signed", { url: here("/signed/v2") });
	assert(sameSiteSigned.status === 200 && sameSiteSigned.body.sameSite === true, `A2 same site, got ${JSON.stringify(sameSiteSigned)}`);
	assert(authStore.getAuthForUrl("signed", here("/signed/v2"))?.tokens?.accessToken === "signed-token", `A2 the sign-in stays, at the new address, got ${JSON.stringify(authStore.getAuthEntry("signed"))}`);
	assert((await statusOf("signed")).auth.hasStoredTokens === true, "A2 the row is still signed in");

	const sameSiteKey = await changeAddress("wiki-key", { url: here("/wiki/v2") });
	assert(sameSiteKey.status === 200 && entries()["wiki-key"].bearerToken === "key-one" && entries()["wiki-key"].displayName === "Team wiki", `A3 same site keeps the key and the name, got ${JSON.stringify(entries()["wiki-key"])}`);

	const noKeyAgain = await changeAddress("wiki-key", { url: elsewhere("/wiki") });
	assert(noKeyAgain.status === 400 && noKeyAgain.body.error === CONNECTOR_FORM_LINES.anotherSiteKey, `A4 another site asks for the key again, got ${JSON.stringify(noKeyAgain)}`);
	assert(entries()["wiki-key"].url === here("/wiki/v2"), "A4 a refused change leaves the address");
	const keyAgain = await changeAddress("wiki-key", { url: elsewhere("/wiki"), key: "key-two" });
	assert(keyAgain.status === 200 && keyAgain.body.sameSite === false, `A4 another site with its key, got ${JSON.stringify(keyAgain)}`);
	assert(entries()["wiki-key"].bearerToken === "key-two" && entries()["wiki-key"].auth === "bearer", `A4 the new key replaces the old, got ${JSON.stringify(entries()["wiki-key"])}`);
	assert(grantsOf("room-a").includes("wiki-key") && grantsOf("room-b").includes("wiki-key"), "A4 rooms keep their access");

	const otherSiteSigned = await changeAddress("signed", { url: elsewhere("/signed") });
	assert(otherSiteSigned.status === 200 && otherSiteSigned.body.sameSite === false, `A5 another site, got ${JSON.stringify(otherSiteSigned)}`);
	assert(!authStore.hasStoredTokens("signed") && (await statusOf("signed")).auth.hasStoredTokens === false, `A5 the sign-in goes, got ${JSON.stringify(authStore.getAuthEntry("signed"))}`);
	assert(grantsOf("room-b").includes("signed"), "A5 rooms keep their access");

	const headerAgain = await changeAddress("solo-key", { url: elsewhere("/solo"), key: "solo-two" });
	assert(headerAgain.status === 200 && JSON.stringify(entries()["solo-key"].headers) === JSON.stringify({ "X-Api-Key": "solo-two" }) && entries()["solo-key"].auth === false, `A6 a key kept in its own header goes back there on another site, got ${JSON.stringify(entries()["solo-key"])}`);
	// A header's name can't tell whether its value is a secret: the same site keeps every one.
	const oddSameSite = await changeAddress("odd-header", { url: here("/odd/v2") });
	assert(oddSameSite.status === 200 && entries()["odd-header"].headers?.["X-Key"] === "odd-secret", `A6 the same site keeps every header, got ${JSON.stringify(entries()["odd-header"])}`);
	const headerSameSite = await changeAddress("header-key", { url: here("/header"), key: "header-two" });
	assert(headerSameSite.status === 200 && JSON.stringify(entries()["header-key"].headers) === JSON.stringify({ "X-Api-Key": "header-two", "X-Tenant": "acme" }), `A6 a new key on the same site keeps the other headers, got ${JSON.stringify(entries()["header-key"])}`);

	// K: where each connector keeps its key, as the page reads it from the status.
	const keyPlaces: Record<string, [string, boolean]> = {
		"wiki-key": ["replaceable", true],
		"open-one": ["none", true],
		"solo-key": ["replaceable", true],
		"auth-header": ["replaceable", true],
		"header-key": ["replaceable", false],
		"odd-header": ["none", false],
		"tenant-only": ["none", false],
		"app-and-key": ["replaceable", false],
		"two-keys": ["fixed", false],
	};
	for (const [name, [key, moves]] of Object.entries(keyPlaces)) {
		const row = await statusOf(name);
		assert(row.key === key && row.movesToAnotherSite === moves, `K1 ${name} keeps its key ${key} and ${moves ? "moves" : "can't move"} to another site, got ${JSON.stringify([row.key, row.movesToAnotherSite])}`);
	}
	const bearerKept = await changeAddress("auth-header", { url: here("/auth"), key: "auth-two" });
	assert(bearerKept.status === 200 && entries()["auth-header"].headers?.Authorization === "Bearer auth-two", `K2 a new key in an Authorization header keeps its "Bearer ", got ${JSON.stringify(entries()["auth-header"])}`);
	const ownScheme = await changeAddress("auth-header", { url: here("/auth"), key: "Token auth-three" });
	assert(ownScheme.status === 200 && entries()["auth-header"].headers?.Authorization === "Token auth-three", `K2 a key typed with its own scheme word stays as typed, got ${JSON.stringify(entries()["auth-header"])}`);
	const signInKept = await changeAddress("app-and-key", { url: here("/app"), key: "app-two" });
	const appAndKey = entries()["app-and-key"];
	assert(signInKept.status === 200 && appAndKey.headers?.["X-Api-Key"] === "app-two" && appAndKey.auth !== false && appAndKey.oauth?.clientId === "synthetic-client", `K3 a new key beside its own sign-in app keeps the sign-in on, got ${JSON.stringify(appAndKey)}`);
	// A key header beside a sign-in the connector finds by itself: a new key leaves the sign-in as it was, here and on another site.
	const keySigned = await changeAddress("key-and-signed", { url: here("/kas"), key: "kas-two" });
	const kas = entries()["key-and-signed"];
	assert(keySigned.status === 200 && kas.headers?.["X-Api-Key"] === "kas-two" && !("auth" in kas) && (await statusOf("key-and-signed")).auth.mode === "oauth" && authStore.hasStoredTokens("key-and-signed"), `K6 a new key beside a found sign-in keeps the sign-in, got ${JSON.stringify([kas, (await statusOf("key-and-signed")).auth])}`);
	const keySignedMoved = await changeAddress("key-and-signed", { url: elsewhere("/kas"), key: "kas-three" });
	const kasMoved = entries()["key-and-signed"];
	assert(keySignedMoved.status === 200 && kasMoved.headers?.["X-Api-Key"] === "kas-three" && !("auth" in kasMoved) && (await statusOf("key-and-signed")).auth.mode === "oauth", `K6 on another site it signs in again, as the page says, got ${JSON.stringify([kasMoved, (await statusOf("key-and-signed")).auth])}`);
	// Only an Authorization header has a scheme word; any other key header takes the new key as typed.
	const spaced = await changeAddress("spaced-key", { url: here("/spaced"), key: "new-value" });
	assert(spaced.status === 200 && entries()["spaced-key"].headers?.["X-Api-Key"] === "new-value", `K7 a key header other than Authorization takes the key as typed, got ${JSON.stringify(entries()["spaced-key"])}`);
	const unplaced = fs.readFileSync(configFile, "utf-8");
	for (const name of ["two-keys", "tenant-only"]) {
		const refusedKey = await changeAddress(name, { url: entries()[name].url, key: "new-key" });
		assert(refusedKey.status === 400 && refusedKey.body.error === CONNECTOR_FORM_LINES.keyNotChangeable, `K4 ${name}'s key can't be changed here, got ${JSON.stringify(refusedKey)}`);
	}
	for (const name of ["header-key", "app-and-key", "odd-header"]) {
		const stays = await changeAddress(name, { url: elsewhere(`/${name}`), key: "new-key" });
		assert(stays.status === 400 && stays.body.error === CONNECTOR_FORM_LINES.cantMoveSite, `K5 ${name} would lose its sign-in app or a header on another site, so it can't move there, got ${JSON.stringify(stays)}`);
	}
	assert(fs.readFileSync(configFile, "utf-8") === unplaced, "K4 K5 a refused change writes nothing");

	const before = fs.readFileSync(configFile, "utf-8");
	const imported = await changeAddress("from-cursor", { url: here("/elsewhere") });
	assert(imported.status === 409 && imported.body.error === CONNECTOR_FORM_LINES.addressNotChangeable, `A7 an imported connector is refused, got ${JSON.stringify(imported)}`);
	const program = await changeAddress("files", { url: here("/files") });
	assert(program.status === 400, `A7 a program is refused, got ${JSON.stringify(program)}`);
	const unknown = await changeAddress("ghost", { url: here("/ghost") });
	assert(unknown.status === 404 && unknown.body.error === CONNECTOR_REQUEST_LINES.noLongerExists, `A7 an unknown connector, got ${JSON.stringify(unknown)}`);
	const malformed = await changeAddress("open-one", { url: "ftp://files.example.com" });
	assert(malformed.status === 400 && malformed.body.error === CONNECTOR_FORM_LINES.addressNotWeb, `A7 a malformed address, got ${JSON.stringify(malformed)}`);
	assert(fs.readFileSync(configFile, "utf-8") === before, "A7 a refused change writes nothing");

	// D8: names are unique as people see them, a directory connector's own name included.
	const customHf = await send("POST", "/api/mcp/servers", { name: "Hugging Face", url: here("/hf") });
	assert(customHf.status === 200 && customHf.body.name === "hugging-face", `D8 a custom connector may take a directory connector's name while that one isn't added, got ${JSON.stringify(customHf)}`);
	const directoryHf = await send("POST", "/api/mcp/servers", { name: "huggingface", url: here("/hf-directory") });
	assert(directoryHf.status === 409 && directoryHf.body.error === CONNECTOR_FORM_LINES.nameTaken("Hugging Face"), `D8 the directory's Hugging Face would show the same name, got ${JSON.stringify(directoryHf)}`);

	console.log("mcp-connector-edit-smoke: OK");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp home preserved for inspection: ${tempHome}`);
	console.error(serverOutput.slice(-40).join(""));
	process.exitCode = 1;
} finally {
	await stopSmokeServer(server);
	connector.server.close();
	notFound.close();
	releaseSlow();
	slow.close();
	if (process.exitCode !== 1) fs.rmSync(tempHome, { recursive: true, force: true });
}
