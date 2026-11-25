// A link the connector add-on opens is a web link, handed to the system's
// opener as one argument with no shell to read it (scripts/patch-mcp-adapter.mjs,
// patch 27). The patched add-on's own code, as the app runs it: a sign-in
// started as the Connectors page starts it (mcp-admin.ts), against a stand-in
// service whose sign-in address the row chooses; a connector's request to open
// a link (handleUrlElicitation, its ability switched on here, which no room
// declares); and the browser for a connector's own page (`openBrowser`, as
// the add-on's start, initializeMcp, builds it). Every program start is caught before it reaches the system and
// recorded, and each row sets the platform it plays, so no browser opens and no
// real Windows run is made. Last, the patch on scratch copies of the add-on: it
// gives the installed files from the package's own text, and fails the install
// when its anchor is gone.
import childProcess, { ChildProcess, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire, syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { waitEvery } from "./smoke-wait.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "exx-link-open-smoke-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.PI_CODING_AGENT_DIR = path.join(home, "agent");
delete process.env.BROWSER;
// Where Windows is, as the Windows rows expect it, whatever this computer says.
process.env.SystemRoot = "C:\\Windows";
delete process.env.EXXPERTS_SHARED_SERVER;
// The add-on reads the sign-in's callback port when it loads: a free one, so no running app's is taken.
process.env.MCP_OAUTH_CALLBACK_PORT = String(await new Promise<number>((resolve) => {
	const probe = http.createServer().listen(0, "127.0.0.1", () => {
		const { port } = probe.address() as AddressInfo;
		probe.close(() => resolve(port));
	});
}));

const failures: string[] = [];
function check(ok: boolean, line: string): void {
	console.log(`${ok ? "PASS" : "FAIL"} ${line}`);
	if (!ok) failures.push(line);
}
const waitUntil = waitEvery(25, 20_000);
// A sign-in that ends must leave nothing unawaited: in the app's server that would end the server.
process.on("unhandledRejection", (reason) => check(false, `nothing is left unhandled, got ${reason instanceof Error ? reason.message : String(reason)}`));

// --- Every program start, recorded, and none reaching the system.
type Start = { program: string; args: string[]; shell?: unknown; verbatim?: unknown };
const starts: Start[] = [];
childProcess.spawn = ((program: string, args?: readonly string[], options?: { shell?: unknown; windowsVerbatimArguments?: unknown }) => {
	starts.push({ program, args: [...(args ?? [])], shell: options?.shell, verbatim: options?.windowsVerbatimArguments });
	const opener = Object.assign(new EventEmitter(), { pid: 4242, stdin: null, stdout: null, stderr: null, unref() {}, ref() {}, kill: () => true });
	process.nextTick(() => opener.emit("spawn"));
	return opener;
}) as unknown as typeof childProcess.spawn;
// Any other way to start a program is refused, and recorded.
(ChildProcess.prototype as unknown as { spawn: (options: { file?: string; args?: string[] }) => never }).spawn = (options) => {
	starts.push({ program: String(options.file), args: (options.args ?? []).slice(1), shell: "started another way" });
	throw new Error("this smoke starts no program");
};
syncBuiltinESMExports();
// The extension API the add-on starts with: what it asks it to run is recorded (the browser for a
// connector's own page went through it), and its connectors are read from an empty file.
const noConnectors = path.join(home, "no-connectors.json");
fs.writeFileSync(noConnectors, JSON.stringify({ mcpServers: {} }));
const pi = {
	getFlag: (flag: string) => (flag === "mcp-config" ? noConnectors : undefined),
	exec: async (program: string, args: string[]) => {
		starts.push({ program, args: [...args] });
		return { code: 0, stdout: "", stderr: "" };
	},
	sendMessage: () => {},
};
const emptyFolder = fs.mkdtempSync(path.join(home, "room-"));

const SHELLS = /^(cmd|powershell|pwsh)(\.exe)?$/i;
const RUNDLL32 = "C:\\Windows\\System32\\rundll32.exe";
const isShell = (start: Start) => SHELLS.test(path.win32.basename(start.program)) || Boolean(start.shell) || Boolean(start.verbatim);
const shown = (made: Start[]) => JSON.stringify(made);

/** Runs `row` with `process.platform` reading `platform`, and puts the real one back after. */
async function playing<T>(platform: NodeJS.Platform, row: () => Promise<T>): Promise<T> {
	const real = Object.getOwnPropertyDescriptor(process, "platform")!;
	Object.defineProperty(process, "platform", { ...real, value: platform });
	try {
		return await row();
	} finally {
		Object.defineProperty(process, "platform", real);
	}
}

// --- A stand-in service whose sign-in sends the browser to `address`.
const services: http.Server[] = [];
async function serviceSigningInAt(address: string): Promise<string> {
	let base = "";
	const service = http.createServer((req, res) => {
		req.resume().on("end", () => {
			const url = new URL(req.url ?? "/", base);
			const json = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
			if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
			if (url.pathname === "/.well-known/oauth-authorization-server") return json(200, { issuer: base, authorization_endpoint: address, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] });
			if (url.pathname === "/register") return json(201, { client_id: "row-client", redirect_uris: ["http://localhost/callback"] });
			res.writeHead(401, { "content-type": "text/plain", "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` }).end("sign in first");
		});
	});
	await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
	services.push(service);
	base = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
	return `${base}/mcp`;
}

const admin = await import("../src/mcp-admin.js");
const authFlow = await import("pi-mcp-adapter/mcp-auth-flow.ts" as string);
const init = await import("pi-mcp-adapter/init.ts" as string);
const elicitation = await import("pi-mcp-adapter/elicitation-handler.ts" as string);
const utils = await import("pi-mcp-adapter/utils.ts" as string);
const webLink = await import("pi-mcp-adapter/web-link.ts" as string);
/** The words the add-on refuses `address` with, from the add-on itself. */
const refusalOf = (address: string): string => {
	try {
		webLink.webLinkOf(address);
		return "";
	} catch (error) {
		return (error as Error).message;
	}
};

let rowCount = 0;
/**
 * Adds a connector of a service that signs in at `address` and starts its
 * sign-in as the Connectors page does, playing `platform`; waits until a
 * program started or the sign-in ended. A sign-in still waiting is stopped.
 */
async function signIn(platform: NodeJS.Platform, address: string) {
	const { name } = await admin.addMcpServer({ name: `row ${(rowCount += 1)}`, url: await serviceSigningInAt(address) });
	const before = starts.length;
	return playing(platform, async () => {
		await admin.startMcpServerLogin(name);
		await waitUntil(() => starts.length > before || !admin.getMcpServerLoginState(name).pending, `the sign-in of ${address} opened something or ended`);
		const state = admin.getMcpServerLoginState(name);
		if (state.pending) await admin.cancelMcpServerLogin(name);
		return { made: starts.slice(before), state };
	});
}

// 1. Windows, a sign-in address PowerShell would have read as a command: rundll32, the parsed link as one argument.
{
	const { made } = await signIn("win32", "https://evil.example/$(calc)#&x");
	const link = made[0]?.args[1] ?? "";
	check(made.length === 1 && made[0].program === RUNDLL32 && made[0].args.length === 2 && made[0].args[0] === "url.dll,FileProtocolHandler", `Windows: one start, rundll32 by its full path with the link as one argument, got ${shown(made)}`);
	check(link.startsWith("https://evil.example/$(calc)?") && link.endsWith("#&x") && link === new URL(link).href, `Windows: the link is the parsed sign-in address, got ${link}`);
	check(!made.some(isShell), `Windows: no cmd, PowerShell or shell start, got ${shown(made)}`);
}

// 2. Addresses that are no web link, on each platform: nothing starts, and the sign-in ends with the page's own failure.
for (const platform of ["win32", "darwin", "linux"] as const) {
	for (const address of ["file:///C:/Windows/System32/calc.exe", "smb://share.example/files", "ms-settings:privacy", "myapp://signed-in"]) {
		const { made, state } = await signIn(platform, address);
		const scheme = `${new URL(address).protocol}`;
		check(made.length === 0, `${platform}, ${scheme}: nothing starts, got ${shown(made)}`);
		// "other" is the Connectors page's "The sign-in didn't work." with Try again (connector-rows.ts).
		check(!state.pending && state.cause === "other" && state.detail === refusalOf(address), `${platform}, ${scheme}: the sign-in ends as a failed sign-in, got ${JSON.stringify(state)}`);
	}
}

// 2a. The refusal's words carry nothing the connector chose: an address whose scheme reads like a timeout still ends
// as the failed sign-in, whose page line is "The sign-in didn't work.", not as one that took too long.
{
	const { CONNECTOR_WORDS } = await import("../../web-ui/src/connector-rows.js");
	const { made, state } = await signIn("darwin", "timeout:x");
	check(made.length === 0 && !state.pending && state.cause === "other" && !(state.detail ?? "").includes("timeout"), `timeout:x ends as a failed sign-in, so the page says "${CONNECTOR_WORDS.signInFailed.other.fact}", got ${JSON.stringify(state)}`);
}

// 2b. Web addresses whose host name holds what a parsed link keeps as it is there (a quote, `$(`, `&`): refused on each
// platform, nothing started. The host is the one part where the parser leaves a quote.
for (const platform of ["win32", "darwin", "linux"] as const) {
	for (const address of ['https://a"b/x', "https://x$(calc)y/", "https://a&b/"]) {
		const { made, state } = await signIn(platform, address);
		check(made.length === 0, `${platform}, host of ${address}: nothing starts, got ${shown(made)}`);
		check(!state.pending && state.cause === "other" && state.detail === refusalOf(address) && refusalOf(address) !== refusalOf("file:///x"), `${platform}, host of ${address}: the sign-in ends as a failed sign-in, with the host's own words, got ${JSON.stringify(state)}`);
	}
}
// Their neighbours open: an international name (as punycode), an underscore, a bracketed IPv6 address.
for (const [address, opened] of [["https://bücher.example/", "https://xn--bcher-kva.example/?"], ["https://ex_ample.com/", "https://ex_ample.com/?"], ["https://[::1]:8080/a", "https://[::1]:8080/a?"]]) {
	const { made } = await signIn("win32", address);
	check(made.length === 1 && made[0].program === RUNDLL32 && made[0].args.length === 2 && made[0].args[1].startsWith(opened), `Windows, ${address}: opens with rundll32 as ${opened}..., got ${shown(made)}`);
}

// 3. Guard: a plain sign-in address opens unchanged on each platform: one start, the platform's opener, the link as one argument.
for (const [platform, program, lead] of [["darwin", "open", []], ["linux", "xdg-open", []], ["win32", RUNDLL32, ["url.dll,FileProtocolHandler"]]] as const) {
	const address = "https://sign-in.example/authorize";
	const { made, state } = await signIn(platform, address);
	const link = made[0]?.args.at(-1) ?? "";
	check(made.length === 1 && made[0].program === program && JSON.stringify(made[0].args) === JSON.stringify([...lead, link]) && link.startsWith(`${address}?`) && link.includes("client_id=row-client"), `${platform}: a plain sign-in opens with ${program}, got ${shown(made)}`);
	check(!made.some(isShell), `${platform}: no shell for a plain sign-in, got ${shown(made)}`);
	check(state.pending, `${platform}: the plain sign-in then waits for the browser, got ${JSON.stringify(state)}`);
}

// 4. A connector's link request with a quote and a line break: the opener gets only the parsed link.
{
	const before = starts.length;
	const notes: string[] = [];
	const ui = { select: async () => "Open", notify: (line: string) => notes.push(line) };
	const sent = 'https://docs.example/a"b\nc?q="x"';
	const answer = await playing<{ action?: string }>("win32", () => elicitation.handleUrlElicitation({ allowUrl: true, serverName: "row-link", ui }, { mode: "url", message: "Open the page", url: sent, elicitationId: "row-link-1" }));
	const made = starts.slice(before);
	const parsed = new URL(sent).href;
	check(answer?.action === "accept" && made.length === 1 && made[0].program === RUNDLL32 && JSON.stringify(made[0].args) === JSON.stringify(["url.dll,FileProtocolHandler", parsed]), `a link request opens only ${parsed}, got ${shown(made)}`);
	check(!made.some((start) => start.args.some((arg) => arg.includes('"') || arg.includes("\n"))) && !made.some(isShell), `a link request hands no quote, line break or shell to the opener, got ${shown(made)}`);
}

// 5. The browser for a connector's own page, as the add-on's start hands it on: an address with & on Windows starts no cmd.
const pageBrowser = async (page: string): Promise<void> => (await init.initializeMcp(pi, { cwd: emptyFolder, hasUI: false, mode: "json" })).openBrowser(page);
{
	const before = starts.length;
	const page = "http://localhost:4313/ui/row?session=1&notepad";
	await playing("win32", () => pageBrowser(page));
	const made = starts.slice(before);
	check(made.length === 1 && made[0].program === RUNDLL32 && JSON.stringify(made[0].args) === JSON.stringify(["url.dll,FileProtocolHandler", page]) && !made.some(isShell), `Windows: a connector page's address opens with rundll32, no cmd, got ${shown(made)}`);
}

// 5b. The add-on's exported openUrl, with or without a browser named: on Windows no cmd either, as nothing can reach it again.
for (const browser of [undefined, "C:\\Browsers\\row.exe"]) {
	const before = starts.length;
	const page = "http://localhost:4313/ui/row?session=3&notepad";
	await playing("win32", () => utils.openUrl(pi, page, browser));
	const made = starts.slice(before);
	check(made.length === 1 && made[0].program === RUNDLL32 && JSON.stringify(made[0].args) === JSON.stringify(["url.dll,FileProtocolHandler", page]) && !made.some(isShell), `Windows: openUrl (browser ${browser ?? "none"}) opens with rundll32, no cmd, got ${shown(made)}`);
}

// 6. Guard: the add-on's own local page still opens, unchanged, on a Mac.
{
	const before = starts.length;
	const page = "http://localhost:4313/ui/row?session=2";
	await playing("darwin", () => pageBrowser(page));
	const made = starts.slice(before);
	check(made.length === 1 && made[0].program === "open" && JSON.stringify(made[0].args) === JSON.stringify([page]), `Mac: the add-on's own page opens with open and its address, got ${shown(made)}`);
}

// 7. Guard: on a shared server a sign-in is refused before anything starts.
{
	const { name } = await admin.addMcpServer({ name: "row shared", url: await serviceSigningInAt("https://sign-in.example/authorize") });
	const before = starts.length;
	process.env.EXXPERTS_SHARED_SERVER = "1";
	try {
		const page = await admin.startMcpServerLogin(name).then(() => "started", (error: Error) => error.message);
		const beneath = await authFlow.authenticate(name, (await import("pi-mcp-adapter/config.ts" as string)).loadMcpConfig().mcpServers[name]?.url ?? "", undefined).then(() => "started", (error: Error) => error.message);
		check(page !== "started" && beneath !== "started" && starts.length === before, `a shared server refuses the sign-in and starts nothing (page: ${page}; add-on: ${beneath}; starts ${shown(starts.slice(before))})`);
	} finally {
		delete process.env.EXXPERTS_SHARED_SERVER;
	}
}

// 8. The patch, on scratch copies of the installed add-on: from the package's own sign-in text it gives the installed
// file; run again, it changes nothing; with its anchor gone, it fails the install and leaves the file as it was.
{
	const installed = path.dirname(createRequire(import.meta.url).resolve("pi-mcp-adapter/package.json"));
	const patchScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "patch-mcp-adapter.mjs");
	const patchedFlow = fs.readFileSync(path.join(installed, "mcp-auth-flow.ts"), "utf8");
	// The sign-in's three places, as the package has them and as the patch leaves them, written here by hand.
	const PAIRS: Array<[string, string]> = [
		['import open from "open"\n', 'import { openWebLink, webLinkOf } from "./web-link.ts"\n'],
		[
			"      console.log(`MCP Auth: Open this URL to authenticate ${serverName}:\\n${authorizationUrl}`)\n      try {\n        await open(authorizationUrl)\n",
			"      console.log(`MCP Auth: Open this URL to authenticate ${serverName}:\\n${webLink}`)\n      try {\n        await openWebLink(webLink)\n",
		],
		[
			"    // Register the callback BEFORE opening the browser\n    const callbackPromise = waitForCallback(oauthState)\n",
			"    // Anything but a web link ends the sign-in here, before its callback waits (patch 27).\n    let webLink: string\n    try {\n      webLink = webLinkOf(authorizationUrl).href\n    } catch (error) {\n      await clearPendingAuth(serverName, oauthState)\n      throw error\n    }\n\n    // Register the callback BEFORE opening the browser\n    const callbackPromise = waitForCallback(oauthState)\n",
		],
	];
	const holds = PAIRS.every(([, patched]) => patchedFlow.split(patched).length === 2);
	check(holds, "the installed add-on holds patch 27's sign-in places as this smoke knows them");
	if (holds) {
		const pristineFlow = PAIRS.reduce((text, [pristine, patched]) => text.replace(patched, () => pristine), patchedFlow);
		let scratches = 0;
		const scratch = (flowText: string): string => {
			const adapter = path.join(home, `patch-${(scratches += 1)}`, "node_modules", "pi-mcp-adapter");
			fs.cpSync(installed, adapter, { recursive: true });
			// Patch 11 looks for the AI library copy beside the add-on.
			const aiCopy = path.join(installed, "..", "@earendil-works", "pi-ai");
			if (fs.existsSync(aiCopy)) fs.cpSync(aiCopy, path.join(adapter, "..", "@earendil-works", "pi-ai"), { recursive: true });
			fs.writeFileSync(path.join(adapter, "mcp-auth-flow.ts"), flowText);
			return adapter;
		};
		const runPatch = (adapter: string) => {
			const result = spawnSync(process.execPath, [patchScript, "--adapter-dir", adapter], { cwd: home, encoding: "utf8", env: { PATH: process.env.PATH, HOME: home } });
			return { status: result.status, errors: `${result.stdout}${result.stderr}`.split("\n").filter((line) => line.includes("ERROR")), out: result.stdout };
		};
		const flowOf = (adapter: string) => fs.readFileSync(path.join(adapter, "mcp-auth-flow.ts"), "utf8");
		const fresh = scratch(pristineFlow);
		const freshRun = runPatch(fresh);
		check(freshRun.status === 0 && freshRun.errors.length === 0 && flowOf(fresh) === patchedFlow, `patch 27 applies to the package's own sign-in text, giving the installed file (status ${freshRun.status}, ${freshRun.errors.join(" | ")})`);
		const againRun = runPatch(fresh);
		check(againRun.status === 0 && againRun.out.includes("patch 27 (the sign-in address) already patched") && flowOf(fresh) === patchedFlow, `run again, it passes and changes nothing (status ${againRun.status})`);
		const moved = scratch(pristineFlow.replace("        await open(authorizationUrl)\n", "        await open(authorizationUrl, { wait: false })\n"));
		const movedBefore = flowOf(moved);
		const movedRun = runPatch(moved);
		check(movedRun.status === 1 && movedRun.errors.length === 1 && movedRun.errors[0].includes("patch 27") && flowOf(moved) === movedBefore, `an add-on whose sign-in opener changed fails the install on patch 27, one error line, the file unchanged (status ${movedRun.status}, ${movedRun.errors.join(" | ")})`);
	}
}

const callbackServer = await import("pi-mcp-adapter/mcp-callback-server.ts" as string);
await callbackServer.stopCallbackServer().catch(() => {});
for (const service of services) {
	service.closeAllConnections();
	service.close();
}
fs.rmSync(home, { recursive: true, force: true });
if (failures.length) {
	console.error(`connector link open smoke failed: ${failures.length} check(s)`);
	process.exit(1);
}
console.log("connector link open smoke passed");
process.exit(0);
