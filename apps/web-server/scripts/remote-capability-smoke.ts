import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authedFetch, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, type AuthedFetchInit } from "./smoke-server-process.js";

// Pins the capability + per-room-exposure unit:
//
// - the remote route policy is TOTAL: every registered route carries an
//   explicit class, asserted against the live route table, so a new route
//   cannot ship unclassified (the enforcement hook fails closed on those);
// - "local" routes refuse remote devices of any capability; "write" routes
//   refuse read-only devices (per-device, server-side, re-derived per
//   request; changing the capability on the computer takes effect on the
//   very next request);
// - a hidden room is indistinguishable from a nonexistent one to a remote
//   device: gone from listings and memory aggregations (with totals
//   recomputed), direct access answers with the byte-identical unknown-room
//   body, and its task artifacts answer the artifact route's own not-found;
// - the loopback listener sees everything, exposure writes are loopback
//   only, and a read-only device's WebSocket refuses every inbound frame.

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 26000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;
const tunnelHostHeader = `[::1]:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-remote-capability-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const productAppRoot = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(agentsRoot, { recursive: true, mode: 0o700 });
fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });

// Minimal synthetic provider (the detached-turn smoke's pattern, shrunk):
// the room WS below needs a bindable session, so a loopback SSE gateway
// stands in as the model. It only ever needs to answer enough for the
// session to bind; the smoke never runs a real turn through it.
const gateway = http.createServer((req, res) => {
	if (req.method !== "POST" || !String(req.url ?? "").endsWith("/chat/completions")) {
		res.writeHead(404).end();
		return;
	}
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
	const base = { id: "cmpl_1", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "room-model" };
	res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`);
	res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
	res.write("data: [DONE]\n\n");
	res.end();
});

function seedSyntheticProvider(gatewayPort: number): void {
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
		providers: {
			"openai-compatible": {
				name: "Synthetic Gateway",
				baseUrl: `http://127.0.0.1:${gatewayPort}/v1`,
				api: "openai-completions",
				models: [{ id: "room-model", name: "Room Model", contextWindow: 128000, maxTokens: 16384 }],
			},
		},
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-remote-capability-key" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(productAppRoot, "openai-compatible-ai-profile.json"), JSON.stringify({
		profileId: "openai-compatible",
		providerId: "openai-compatible",
		label: "Synthetic Gateway",
		roomModels: [{ modelId: "room-model", label: "Room Model" }],
		maintenanceModel: "room-model",
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(productAppRoot, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2), { mode: 0o600 });
}

async function adminJson(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, {
		...init,
		headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
	});
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

function tunnelRequest(pathname: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ host: "::1", port, path: pathname, method: options.method ?? "GET", headers: { Host: tunnelHostHeader, ...options.headers } },
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk) => chunks.push(chunk as Buffer));
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
			},
		);
		req.on("error", reject);
		if (options.body != null) req.write(options.body);
		req.end();
	});
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

// Enroll a device through the real flow and return its cookie header value.
async function enrollDevice(name: string): Promise<{ deviceId: string; cookie: string }> {
	const minted = await adminJson("/api/remote/enroll-code", { method: "POST" });
	assert(minted.status === 200, `enroll-code: expected 200, got ${minted.status}`);
	const code = new URL(String(minted.body.url)).searchParams.get("code") ?? "";
	const exchange = await tunnelRequest("/remote/enroll/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name }) });
	assert(exchange.status === 200, `exchange: expected 200, got ${exchange.status}`);
	const requestId = String((JSON.parse(exchange.body) as any).requestId);
	const approve = await adminJson("/api/remote/enroll-approve", { method: "POST", body: JSON.stringify({ requestId }) });
	assert(approve.status === 200, `approve: expected 200, got ${approve.status}`);
	const pollReq = await new Promise<{ headers: http.IncomingHttpHeaders }>((resolve, reject) => {
		const req = http.request({ host: "::1", port, path: `/remote/enroll/status?requestId=${requestId}`, headers: { Host: tunnelHostHeader } }, (res) => {
			res.resume();
			res.on("end", () => resolve({ headers: res.headers }));
			res.on("error", reject);
		});
		req.on("error", reject);
		req.end();
	});
	const setCookie = ([] as string[]).concat((pollReq.headers["set-cookie"] as string[] | undefined) ?? []).join("; ");
	const key = setCookie.match(/exxperts_remote_device=([0-9a-f]+)/)?.[1] ?? "";
	assert(key, "approved poll must set the device cookie");
	const devices = await adminJson("/api/remote/devices");
	const record = devices.body.devices.find((d: any) => d.name === name);
	assert(record, "device must appear in the admin list");
	return { deviceId: String(record.id), cookie: `exxperts_remote_device=${key}` };
}

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
try {
	await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
	seedSyntheticProvider((gateway.address() as { port: number }).port);
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: {
			...process.env,
			HOME: tempHome, USERPROFILE: tempHome,
			PORT: String(port),
			...SMOKE_SERVER_AUTH_ENV,
			EXXETA_HOME: repoRoot,
			EXXPERTS_CODING_AGENT_DIR: agentDir,
			EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot,
			EXXPERTS_REMOTE_TEST_ADDRESS: "::1",
		},
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server);

	// 1. Policy coverage: every registered route must be classified.
	const inventory = await adminJson("/api/remote/test/routes");
	assert(inventory.status === 200, `route inventory: expected 200, got ${inventory.status}`);
	const unclassified = inventory.body.routes.filter((route: any) => route.class == null);
	assert(unclassified.length === 0, `unclassified routes must not ship: ${JSON.stringify(unclassified)}`);

	const enable = await adminJson("/api/remote/enable", { method: "POST" });
	assert(enable.status === 200, `enable: expected 200, got ${enable.status}`);

	// Two rooms: one stays exposed, one gets hidden.
	const roomA = await adminJson("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: "Visible Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	const roomB = await adminJson("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: "Hidden Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	assert(roomA.status === 201 && roomB.status === 201, "room creation must succeed");
	const idA = String(roomA.body.agent.agentId);
	const idB = String(roomB.body.agent.agentId);

	const device = await enrollDevice("Capability phone");
	const asDevice = { Cookie: device.cookie };

	// 2. Full-capability device: reads and writes pass, "local" refuses.
	const listing = await tunnelRequest("/api/persistent-agents", { headers: asDevice });
	assert(listing.status === 200, `tunnel listing: expected 200, got ${listing.status}`);
	assert((JSON.parse(listing.body) as any[]).length === 2, "full device must see both rooms before hiding");
	const rename = await tunnelRequest(`/api/persistent-agents/${encodeURIComponent(idA)}/rename`, { method: "POST", headers: { ...asDevice, "content-type": "application/json" }, body: JSON.stringify({ displayName: "Visible Room Renamed", dryRun: true }) });
	assert(rename.status === 200, `tunnel write (rename dry-run): expected 200, got ${rename.status}`);
	for (const [label, pathAndMethod] of [
		["capability-widening room setting", { path: `/api/persistent-agents/${encodeURIComponent(idA)}/maintenance-settings`, method: "PUT" }],
		["host folder chooser", { path: "/api/system/choose-folder", method: "POST" }],
		["remote admin", { path: "/api/remote/status", method: "GET" }],
		["keep-awake setter", { path: "/api/remote/keep-awake", method: "POST" }],
		["skills install", { path: "/api/skills/upload", method: "POST" }],
	] as const) {
		const res = await tunnelRequest(pathAndMethod.path, {
			method: pathAndMethod.method,
			headers: { ...asDevice, ...(pathAndMethod.method === "GET" ? {} : { "content-type": "application/json" }) },
			...(pathAndMethod.method === "GET" ? {} : { body: "{}" }),
		});
		assert(res.status === 403, `${label}: expected 403 for a remote device, got ${res.status}`);
		assert((JSON.parse(res.body) as any).code === "remote_local_only", `${label}: expected remote_local_only`);
	}

	// 3. Exposure writes are loopback-only; hiding roomB makes it vanish.
	const exposureFromPhone = await tunnelRequest("/api/remote/rooms/exposure", { method: "POST", headers: { ...asDevice, "content-type": "application/json" }, body: JSON.stringify({ id: idB, exposed: true }) });
	assert(exposureFromPhone.status === 403, `exposure write from the tunnel: expected 403, got ${exposureFromPhone.status}`);
	const hide = await adminJson("/api/remote/rooms/exposure", { method: "POST", body: JSON.stringify({ id: idB, exposed: false }) });
	assert(hide.status === 200, `hide: expected 200, got ${hide.status}`);

	const afterHide = await tunnelRequest("/api/persistent-agents", { headers: asDevice });
	const visibleRooms = JSON.parse(afterHide.body) as any[];
	assert(visibleRooms.length === 1 && visibleRooms[0].id === idA, "hidden room must vanish from the tunnel listing");
	const loopbackListing = await adminJson("/api/persistent-agents");
	assert(loopbackListing.body.length === 2, "loopback must keep seeing both rooms");

	// Hidden must equal nonexistent, byte for byte modulo the id.
	const hiddenDirect = await tunnelRequest(`/api/persistent-agents/${encodeURIComponent(idB)}/status`, { headers: asDevice });
	const missingDirect = await tunnelRequest(`/api/persistent-agents/definitely-not-a-room/status`, { headers: asDevice });
	assert(hiddenDirect.status === 404 && missingDirect.status === 404, `hidden and nonexistent must both 404, got ${hiddenDirect.status}/${missingDirect.status}`);
	assert(hiddenDirect.body.replace(idB, "X") === missingDirect.body.replace("definitely-not-a-room", "X"), `hidden and nonexistent bodies must match: ${hiddenDirect.body} vs ${missingDirect.body}`);

	// Memory aggregations: the hidden room is out and totals follow.
	const overview = JSON.parse((await tunnelRequest("/api/memory/overview", { headers: asDevice })).body) as any;
	assert(overview.rooms.every((room: any) => room.id !== idB), "overview must not list the hidden room");
	assert(overview.totals.rooms === overview.rooms.length, "overview totals must be recomputed from the filtered rooms");
	const loopbackOverview = (await adminJson("/api/memory/overview")).body;
	assert(loopbackOverview.rooms.some((room: any) => room.id === idB), "loopback overview keeps the hidden room");

	// The artifact side channel: a task in the hidden room's ledger, with real
	// bytes in the store, is not found for the device; unhide and it serves.
	const taskId = "tsk-remote-cap-1";
	const ledgerDir = path.join(agentsRoot, idB, "runtime", "task-ledger");
	fs.mkdirSync(ledgerDir, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(ledgerDir, `${taskId}.json`), `${JSON.stringify({ schemaVersion: 1, taskId, roomId: idB, conversationId: "conv-x", templateId: "doc", templateVersion: 1, title: "T", startedAt: new Date().toISOString(), outcome: "completed" })}\n`, { mode: 0o600 });
	const artifactDir = path.join(tempHome, ".exxperts", "app", "artifacts", "tasks", taskId);
	fs.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(artifactDir, "out.html"), "<!doctype html><p>artifact</p>", { mode: 0o600 });
	const hiddenArtifact = await tunnelRequest(`/api/artifacts/${taskId}/out.html`, { headers: asDevice });
	assert(hiddenArtifact.status === 404, `hidden room's artifact: expected 404, got ${hiddenArtifact.status}`);
	await adminJson("/api/remote/rooms/exposure", { method: "POST", body: JSON.stringify({ id: idB, exposed: true }) });
	const exposedArtifact = await tunnelRequest(`/api/artifacts/${taskId}/out.html`, { headers: asDevice });
	assert(exposedArtifact.status === 200, `exposed room's artifact: expected 200, got ${exposedArtifact.status}`);
	await adminJson("/api/remote/rooms/exposure", { method: "POST", body: JSON.stringify({ id: idB, exposed: false }) });

	// 4. Read-only capability: flips on the computer, effective on the very
	//    next request; write routes refuse, reads keep working; the WS
	//    refuses every inbound frame.
	const flip = await adminJson("/api/remote/devices/capability", { method: "POST", body: JSON.stringify({ id: device.deviceId, capability: "read-only" }) });
	assert(flip.status === 200, `capability flip: expected 200, got ${flip.status}`);
	const readAfterFlip = await tunnelRequest("/api/persistent-agents", { headers: asDevice });
	assert(readAfterFlip.status === 200, "read-only device must keep reading");
	const writeAfterFlip = await tunnelRequest(`/api/persistent-agents/${encodeURIComponent(idA)}/rename`, { method: "POST", headers: { ...asDevice, "content-type": "application/json" }, body: JSON.stringify({ displayName: "Nope", dryRun: true }) });
	assert(writeAfterFlip.status === 403, `read-only write: expected 403, got ${writeAfterFlip.status}`);
	assert((JSON.parse(writeAfterFlip.body) as any).code === "remote_read_only", "read-only write must carry remote_read_only");

	// WS: connect to the visible room, send a frame, expect the read-only
	// refusal frame back and no other handling.
	const wsRefusal = await new Promise<any>((resolve, reject) => {
		const req = http.request({
			host: "::1", port, path: `/ws?persistentAgentId=${encodeURIComponent(idA)}&conversationId=conv-ws&modelProvider=openai-compatible&model=room-model`, method: "GET",
			agent: false,
			headers: {
				Host: tunnelHostHeader,
				Origin: `http://[::1]:${port}`,
				Connection: "Upgrade",
				Upgrade: "websocket",
				"Sec-WebSocket-Key": Buffer.from("the sample nonce").toString("base64"),
				"Sec-WebSocket-Version": "13",
				Cookie: device.cookie,
			},
		});
		const timer = setTimeout(() => reject(new Error("no read-only refusal frame within 10s")), 10000);
		req.on("response", (res) => { clearTimeout(timer); reject(new Error(`read-only WS upgrade got HTTP ${res.statusCode} instead of 101`)); });
		req.on("upgrade", (_res, socket) => {
			// Minimal client frame writer: masked text frame per RFC 6455.
			const payload = Buffer.from(JSON.stringify({ type: "effort", level: "high" }));
			const mask = Buffer.from([1, 2, 3, 4]);
			const header = Buffer.from([0x81, 0x80 | payload.length]);
			const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
			socket.write(Buffer.concat([header, mask, masked]));
			let buffered = Buffer.alloc(0);
			socket.on("data", (chunk: Buffer) => {
				buffered = Buffer.concat([buffered, chunk]);
				// Server frames are unmasked; scan for the refusal frame's JSON.
				const text = buffered.toString("utf8");
				const marker = text.indexOf('"remote_read_only"');
				if (marker !== -1) {
					clearTimeout(timer);
					socket.destroy();
					resolve(true);
				}
			});
			socket.on("error", () => {});
		});
		req.on("error", (error) => { clearTimeout(timer); reject(error); });
		req.end();
	});
	assert(wsRefusal === true, "read-only WS must answer inbound frames with the remote_read_only refusal");

	// 5. Sliding expiry: a successful device auth moves expiresAt forward to
	//    a fresh TTL from that request, so a device in regular use never dies
	//    30 days after PAIRING; only an idle device expires. Asserted through
	//    the admin list (the in-memory record is what authorizes; the disk
	//    write is throttled and not what this stage pins).
	const expiryBefore = Date.parse((await adminJson("/api/remote/devices")).body.devices.find((d: any) => d.id === device.deviceId).expiresAt);
	await new Promise((resolve) => setTimeout(resolve, 1100));
	const slideAuth = await tunnelRequest("/api/persistent-agents", { headers: asDevice });
	assert(slideAuth.status === 200, `sliding-expiry auth: expected 200, got ${slideAuth.status}`);
	const expiryAfter = Date.parse((await adminJson("/api/remote/devices")).body.devices.find((d: any) => d.id === device.deviceId).expiresAt);
	assert(expiryAfter >= expiryBefore + 1000, `expiresAt must slide forward on successful auth: before ${new Date(expiryBefore).toISOString()}, after ${new Date(expiryAfter).toISOString()}`);
	assert(expiryAfter > Date.now() + 29 * 24 * 60 * 60 * 1000, "the slid expiry must be a full TTL out from the authed request");

	console.log("remote capability smoke passed");
} catch (error) {
	console.error(serverOutput.join(""));
	throw error;
} finally {
	try { gateway.close(); } catch {}
	await stopSmokeServer(server);
}
