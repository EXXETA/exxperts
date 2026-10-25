// Where a room's folder path may go: the server decides per request whether a
// workspace answer carries the folder's full path. On this computer every
// route that sends the workspace view carries it; through a remote device and
// on a shared server none does, checked in the JSON of each route, and the
// page there shows the folder's name only. The per-room exposure list never
// carries a path either way. A next message the room cannot apply its new
// settings for keeps the raw error, which can name a path, in its frame's
// details only on this computer.
// Offline: no model is called. Throwaway HOMEs; the shared server is this
// server started with an empty hook registry, as a shared-server entry does.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { authedFetch, SMOKE_AUTH_HEADERS, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort, type AuthedFetchInit } from "./smoke-server-process.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function pass(label: string): void {
	console.log(`  ok  ${label}`);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const tsxLoader = pathToFileURL(createRequire(path.join(webServerDir, "package.json")).resolve("tsx/esm")).href;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-workspace-path-reach-"));

const ROOM_NAME = "Quarterly Desk";
const OLD_LINE = "The full path stays on this computer and is not shown here.";

interface Place {
	home: string;
	agentsRoot: string;
	folder: string;
	port: number;
	baseUrl: string;
}

function makePlace(name: string, port: number): Place {
	const home = path.join(tempRoot, name, "home");
	const agentsRoot = path.join(home, ".exxperts", "app", "personalized-agents");
	fs.mkdirSync(agentsRoot, { recursive: true, mode: 0o700 });
	fs.mkdirSync(path.join(home, ".exxperts", "agent"), { recursive: true, mode: 0o700 });
	const folder = path.join(home, "Projects", "Client work", "Quarterly reports");
	fs.mkdirSync(folder, { recursive: true });
	// A model to enter a room with; the messages here are refused before it, so its address answers nothing.
	const agentDir = path.join(home, ".exxperts", "agent");
	const appDir = path.join(home, ".exxperts", "app");
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "openai-compatible": { name: "Synthetic Gateway", baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", models: [{ id: "room-model", name: "Room Model", contextWindow: 128000, maxTokens: 16384 }] } } }), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-path-reach-key" } }), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "openai-compatible-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "room-model", label: "Room Model" }], maintenanceModel: "room-model" }), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }), { mode: 0o600 });
	return { home, agentsRoot, folder, port, baseUrl: `http://127.0.0.1:${port}` };
}

function serverEnv(place: Place, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	return smokeHomeEnv(place.home, { PORT: String(place.port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXETA_PERSISTENT_AGENTS_ROOT: place.agentsRoot, ...extra }) as NodeJS.ProcessEnv;
}

async function waitForServer(server: ChildProcessWithoutNullStreams, place: Place): Promise<void> {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (server.exitCode != null) throw new Error(`server exited before startup with code ${server.exitCode}`);
		if (await fetch(`${place.baseUrl}/healthz`).then((r) => r.ok).catch(() => false)) return;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error("server did not come up");
}

async function api(place: Place, pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; text: string; body: any }> {
	const response = await authedFetch(`${place.baseUrl}${pathname}`, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
	const text = await response.text();
	return { status: response.status, text, body: text ? JSON.parse(text) : null };
}

function tunnelRequest(port: number, pathname: string, cookie: string, options: { method?: string; body?: string } = {}): Promise<{ status: number; text: string }> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ host: "::1", port, path: pathname, method: options.method ?? "GET", agent: false, headers: { Host: `[::1]:${port}`, Cookie: cookie, ...(options.body != null ? { "content-type": "application/json" } : {}) } },
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk) => chunks.push(chunk as Buffer));
				res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
			},
		);
		req.on("error", reject);
		if (options.body != null) req.write(options.body);
		req.end();
	});
}

// A room with its folder saved, and one conversation with a folder of its own.
async function roomWithFolder(place: Place): Promise<{ roomId: string; conversationId: string }> {
	const created = await api(place, "/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: ROOM_NAME, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	assert(created.status === 201, `the room is created, got ${created.status} ${created.text}`);
	const roomId = String(created.body?.agent?.agentId ?? "");
	const saved = await api(place, `/api/persistent-agents/${encodeURIComponent(roomId)}/workspace-default`, { method: "PUT", body: JSON.stringify({ root: place.folder, workspaceAccessMode: "localFiles" }) });
	assert(saved.status === 200, `the folder is saved, got ${saved.status} ${saved.text}`);
	const conversationId = "conv_path_reach";
	const own = await api(place, `/api/persistent-agents/${encodeURIComponent(roomId)}/workspace/validate`, { method: "POST", body: JSON.stringify({ conversationId, root: place.folder, workspaceAccessMode: "localFiles" }) });
	assert(own.status === 200, `the conversation's folder is saved, got ${own.status} ${own.text}`);
	return { roomId, conversationId };
}

// Every route that answers with the workspace view, as the page and the tools ask them.
function viewRoutes(roomId: string, conversationId: string, folder: string): Array<{ label: string; method: string; pathname: string; body?: string }> {
	const room = `/api/persistent-agents/${encodeURIComponent(roomId)}`;
	return [
		{ label: "GET workspace-default", method: "GET", pathname: `${room}/workspace-default` },
		{ label: "PUT workspace-default", method: "PUT", pathname: `${room}/workspace-default`, body: JSON.stringify({ workspaceAccessMode: "localFiles" }) },
		{ label: "POST workspace/validate", method: "POST", pathname: `${room}/workspace/validate`, body: JSON.stringify({ conversationId, root: folder, workspaceAccessMode: "localFiles" }) },
		{ label: "GET workspace-policy", method: "GET", pathname: `${room}/workspace-policy?conversationId=${conversationId}` },
	];
}

function assertNoPath(text: string, place: Place, label: string): void {
	for (const blocked of [place.folder, place.home, JSON.stringify(place.folder).slice(1, -1), "Client work"]) {
		assert(!text.includes(blocked), `${label}: the answer carries no part of the folder's path, got ${text}`);
	}
	assert(!text.includes('"path"') && !text.includes("realpath"), `${label}: the answer has no path field, got ${text}`);
}

// Taking a file's read away fails a read only off Windows and not as root.
const canForceFsRefusal = process.platform !== "win32" && process.getuid?.() !== 0;

// A next message after the room's settings changed, with a room file the
// rebuild must read made unreadable: the error frame off the room's socket.
async function settingsFailureFrame(place: Place, roomId: string, conversationId: string, socketAt: { url: string; headers: Record<string, string> }): Promise<any> {
	const room = `/api/persistent-agents/${encodeURIComponent(roomId)}`;
	const opened = await api(place, `${room}/threads/${conversationId}`, { method: "PUT", body: JSON.stringify({ state: "active", origin: "launcher", model: { provider: "openai-compatible", model: "room-model" }, items: [] }) });
	assert(opened.status === 200, `the conversation is open, got ${opened.status} ${opened.text}`);
	const WebSocketImpl: any = (await import("ws")).default;
	const frames: any[] = [];
	const socket = new WebSocketImpl(`${socketAt.url}/ws?persistentAgentId=${encodeURIComponent(roomId)}&conversationId=${conversationId}&modelProvider=openai-compatible&model=room-model`, { headers: socketAt.headers });
	socket.on("message", (data: unknown) => { try { frames.push(JSON.parse(String(data))); } catch {} });
	await new Promise<void>((resolve, reject) => { socket.once("open", () => resolve()); socket.once("error", (error: Error) => reject(new Error(`the room's socket failed to connect: ${error.message}`))); });
	const roomFile = path.join(place.agentsRoot, roomId, "runtime", "pi-sessions", `${conversationId}.boot-prompt.txt`);
	try {
		await waitUntil(() => frames.some((frame) => frame.type === "ready"), "the room's socket is ready");
		const current = await api(place, `${room}/workspace-default`);
		const mode = current.body?.policy?.workspaceAccessMode === "bounded" ? "localFiles" : "bounded";
		const changed = await api(place, `${room}/workspace-default`, { method: "PUT", body: JSON.stringify({ root: place.folder, workspaceAccessMode: mode }) });
		assert(changed.status === 200, `the room's settings change, got ${changed.status} ${changed.text}`);
		assert(fs.existsSync(roomFile), `the room keeps ${roomFile}`);
		fs.chmodSync(roomFile, 0o000);
		const from = frames.length;
		socket.send(JSON.stringify({ type: "prompt", text: "A message after the settings changed." }));
		await waitUntil(() => frames.slice(from).some((frame) => frame.type === "error"), "the message is refused");
		return frames.slice(from).find((frame) => frame.type === "error");
	} finally {
		fs.chmodSync(roomFile, 0o600);
		socket.close();
	}
}

async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`timed out waiting until ${label}`);
}

function assertSettingsFrameWithoutPath(frame: any, place: Place, where: string): void {
	assert(frame?.code === "room_settings_not_applied", `${where}: the message is refused as settings not applied, got ${JSON.stringify(frame)}`);
	assert(!("details" in frame), `${where}: the frame has no details, got ${JSON.stringify(frame)}`);
	assertNoPath(JSON.stringify(frame), place, `the settings frame ${where}`);
	assert(!JSON.stringify(frame).includes("boot-prompt"), `${where}: the frame names no room file, got ${JSON.stringify(frame)}`);
}

async function openWorkspacePane(page: Page) {
	const card = page.locator(".persistent-agent-card").filter({ hasText: ROOM_NAME });
	await card.waitFor({ timeout: 15_000 });
	await card.locator(".card-gear-btn").click();
	await page.waitForSelector(".settings-dialog", { timeout: 10_000 });
	await page.locator(".settings-dialog-nav-item").filter({ hasText: /^Workspace$/ }).first().click();
	const pane = page.locator(".room-settings-section:not([hidden]) .room-workspace-section");
	await pane.locator(".workspace-folder-name").waitFor({ timeout: 10_000 });
	return pane;
}

async function dismissWhatsNew(page: Page): Promise<void> {
	await page.waitForLoadState("networkidle");
	const close = page.locator(".whats-new-close");
	if (await close.count()) await close.click();
}

// The page there shows the folder's name, and no path and no line about one.
async function assertNameOnlyPage(page: Page, place: Place, where: string): Promise<void> {
	const pane = await openWorkspacePane(page);
	const name = await pane.locator(".workspace-folder-name").textContent();
	assert(name === "Quarterly reports", `${where}: the folder row names the folder, got ${name}`);
	const text = await pane.innerText();
	assert(!text.includes(place.folder) && !text.includes("Client work"), `${where}: the page shows no path, got: ${text}`);
	assert(!text.includes(OLD_LINE), `${where}: the line about the hidden path is gone, got: ${text}`);
	assert(await pane.locator(".workspace-folder-path").count() === 0, `${where}: the folder row has no path`);
}

const servers: ChildProcessWithoutNullStreams[] = [];
const serverOutput: string[] = [];
let browser: Browser | undefined;
const chromiumPath = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
const withBrowser = Boolean(chromiumPath && fs.existsSync(chromiumPath));
// ONLY=<computer|remote|shared|page|frame> checks one part alone, each its own red-first command.
const only = process.env.ONLY;
const checks = (part: string): boolean => !only || only === part;
try {
	// 1. This computer, with remote access on a test address.
	const desk = makePlace("desk", await freePort());
	const deskServer = spawn("npx", ["tsx", "src/index.ts"], { shell: process.platform === "win32", ...SMOKE_SERVER_SPAWN_TREE_OPTIONS, cwd: webServerDir, env: serverEnv(desk, { EXXPERTS_REMOTE_TEST_ADDRESS: "::1" }) });
	servers.push(deskServer);
	deskServer.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	deskServer.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(deskServer, desk);
	const deskRoom = await roomWithFolder(desk);
	if (checks("computer")) {
		for (const route of viewRoutes(deskRoom.roomId, deskRoom.conversationId, desk.folder)) {
			const answer = await api(desk, route.pathname, { method: route.method, ...(route.body ? { body: route.body } : {}) });
			assert(answer.status === 200, `${route.label} on this computer answers, got ${answer.status} ${answer.text}`);
			const root = answer.body?.policy?.roots?.[0];
			assert(root?.path === desk.folder, `${route.label} on this computer carries the folder's full path, got ${JSON.stringify(root)}`);
			assert(!answer.text.includes("realpath"), `${route.label} on this computer carries the path the person chose, never the resolved one`);
		}
		const deskExposure = await api(desk, "/api/remote/rooms");
		assert(deskExposure.status === 200, `the exposure list answers on this computer, got ${deskExposure.status}`);
		assertNoPath(deskExposure.text, desk, "the exposure list on this computer");
		pass("on this computer every workspace answer carries the folder's full path; the exposure list carries none");
	}

	// 2. A paired remote device: the reads answer without any path, the changes are refused before any view.
	const enabled = await api(desk, "/api/remote/enable", { method: "POST" });
	assert(enabled.status === 200, `remote access turns on, got ${enabled.status} ${enabled.text}`);
	const minted = await api(desk, "/api/remote/enroll-code", { method: "POST" });
	const code = new URL(String(minted.body?.url)).searchParams.get("code") ?? "";
	const exchange = await tunnelRequest(desk.port, "/remote/enroll/exchange", "", { method: "POST", body: JSON.stringify({ code, name: "Path phone" }) });
	assert(exchange.status === 200, `the pairing code is exchanged, got ${exchange.status} ${exchange.text}`);
	const requestId = String(JSON.parse(exchange.text).requestId);
	const approved = await api(desk, "/api/remote/enroll-approve", { method: "POST", body: JSON.stringify({ requestId }) });
	assert(approved.status === 200, `the device is approved, got ${approved.status}`);
	const deviceKey = await new Promise<string>((resolve, reject) => {
		const req = http.request({ host: "::1", port: desk.port, path: `/remote/enroll/status?requestId=${requestId}`, agent: false, headers: { Host: `[::1]:${desk.port}` } }, (res) => {
			res.resume();
			const cookies = ([] as string[]).concat((res.headers["set-cookie"] as string[] | undefined) ?? []).join("; ");
			res.on("end", () => resolve(cookies.match(/exxperts_remote_device=([0-9a-f]+)/)?.[1] ?? ""));
		});
		req.on("error", reject);
		req.end();
	});
	assert(deviceKey, "the approved device gets its cookie");
	const deviceCookie = `exxperts_remote_device=${deviceKey}`;
	if (checks("remote")) {
		const remoteStatuses: string[] = [];
		for (const route of viewRoutes(deskRoom.roomId, deskRoom.conversationId, desk.folder)) {
			const answer = await tunnelRequest(desk.port, route.pathname, deviceCookie, { method: route.method, ...(route.body ? { body: route.body } : {}) });
			remoteStatuses.push(`${route.label} ${answer.status}`);
			if (route.method === "GET") {
				assert(answer.status === 200, `${route.label} answers a remote device, got ${answer.status} ${answer.text}`);
				assert(JSON.parse(answer.text)?.policy?.roots?.[0]?.basename === "Quarterly reports", `${route.label} names the folder for a remote device, got ${answer.text}`);
			} else {
				assert(answer.status === 403, `${route.label} is refused to a remote device, got ${answer.status} ${answer.text}`);
			}
			assertNoPath(answer.text, desk, `${route.label} through a remote device`);
		}
		const remoteExposure = await tunnelRequest(desk.port, "/api/remote/rooms", deviceCookie);
		assert(remoteExposure.status === 403, `the exposure list is refused to a remote device, got ${remoteExposure.status}`);
		pass(`through a remote device no workspace answer carries a path (${remoteStatuses.join(", ")})`);
	}

	// 3. A shared server: this server with an empty hook registry, its folder saved from its own loopback.
	const shared = makePlace("shared", await freePort());
	const startShared = `const hooks = await import(${JSON.stringify(pathToFileURL(path.join(webServerDir, "src", "server-hooks.js")).href)}); hooks.registerServerHooks({}); await import(${JSON.stringify(pathToFileURL(path.join(webServerDir, "src", "index.js")).href)});`;
	const sharedServer = spawn(process.execPath, ["--import", tsxLoader, "--input-type=module", "-e", startShared], { ...SMOKE_SERVER_SPAWN_TREE_OPTIONS, cwd: webServerDir, env: serverEnv(shared) });
	servers.push(sharedServer);
	sharedServer.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	sharedServer.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(sharedServer, shared);
	const context = await api(shared, "/api/remote/client-context");
	assert(context.body?.sharedServer === true, `the second server is a shared server, got ${context.text}`);
	const sharedRoom = await roomWithFolder(shared);
	if (checks("shared")) {
		for (const route of viewRoutes(sharedRoom.roomId, sharedRoom.conversationId, shared.folder)) {
			const answer = await api(shared, route.pathname, { method: route.method, ...(route.body ? { body: route.body } : {}) });
			assert(answer.status === 200, `${route.label} answers on the shared server, got ${answer.status} ${answer.text}`);
			assert(answer.body?.policy?.roots?.[0]?.basename === "Quarterly reports", `${route.label} names the folder on the shared server, got ${answer.text}`);
			assertNoPath(answer.text, shared, `${route.label} on a shared server`);
		}
		const sharedExposure = await api(shared, "/api/remote/rooms");
		assertNoPath(sharedExposure.text, shared, "the exposure list on a shared server");
		pass("on a shared server no workspace answer carries a path");
	}

	// 4. A next message the new settings could not be applied for: the raw error stays in the frame's details on this computer only.
	if (checks("frame") && !canForceFsRefusal) {
		console.log("  skip the settings frame rows (a file's read cannot be taken away here)");
	} else if (checks("frame")) {
		const local = await settingsFailureFrame(desk, deskRoom.roomId, "conv_settings_local", { url: `ws://127.0.0.1:${desk.port}`, headers: { ...SMOKE_AUTH_HEADERS } });
		assert(local?.code === "room_settings_not_applied", `on this computer the message is refused as settings not applied, got ${JSON.stringify(local)}`);
		assert(typeof local.details === "string" && local.details.includes("conv_settings_local.boot-prompt.txt") && local.details.includes(desk.home), `on this computer the details keep the raw error, got ${JSON.stringify(local)}`);
		const remote = await settingsFailureFrame(desk, deskRoom.roomId, "conv_settings_remote", { url: `ws://[::1]:${desk.port}`, headers: { Host: `[::1]:${desk.port}`, Cookie: deviceCookie } });
		assertSettingsFrameWithoutPath(remote, desk, "through a remote device");
		const sharedFrame = await settingsFailureFrame(shared, sharedRoom.roomId, "conv_settings_shared", { url: `ws://127.0.0.1:${shared.port}`, headers: { ...SMOKE_AUTH_HEADERS } });
		assertSettingsFrameWithoutPath(sharedFrame, shared, "on a shared server");
		pass("a message the new settings could not be applied for keeps the raw error in its details on this computer only");
	}

	// 5. The page: through the remote device and on the shared server, the folder's name only.
	if (!checks("page")) {
		// Another part was asked for alone.
	} else if (!withBrowser) {
		console.log("  skip the page rows (Chromium not installed)");
	} else {
		browser = await chromium.launch();
		const remoteContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
		await remoteContext.addCookies([{ name: "exxperts_remote_device", value: deviceKey, url: `http://[::1]:${desk.port}` }]);
		const remotePage = await remoteContext.newPage();
		await remotePage.goto(`http://[::1]:${desk.port}/`);
		await dismissWhatsNew(remotePage);
		await assertNameOnlyPage(remotePage, desk, "through a remote device");
		await remoteContext.close();
		const sharedContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
		const sharedPage = await sharedContext.newPage();
		await sharedPage.goto(`${shared.baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await dismissWhatsNew(sharedPage);
		await assertNameOnlyPage(sharedPage, shared, "on a shared server");
		await sharedContext.close();
		pass("the page through a remote device and on a shared server shows the folder's name only");
	}
	console.log("room workspace path reach smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-4000));
	throw error;
} finally {
	await browser?.close().catch(() => {});
	for (const server of servers) await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
