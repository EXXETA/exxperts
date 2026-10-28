import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authedFetch, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";
import { readRoomPermissions, resolveRoomPermission } from "../src/persistent-room-permissions.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const webServerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-permissions-api-"));
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
let roomId = "";
const port = 27000 + Math.floor(Math.random() * 10000);
let server: ChildProcessWithoutNullStreams | undefined;
const output: string[] = [];

async function request(method: "GET" | "PUT", body?: string): Promise<{ status: number; value: any }> {
	const response = await authedFetch(`http://127.0.0.1:${port}/api/persistent-agents/${roomId}/permissions`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body });
	return { status: response.status, value: await response.json() };
}

try {
	fs.mkdirSync(agentsRoot, { recursive: true });
	server = spawn("npx", ["tsx", "src/index.ts"], {
		cwd: webServerDir,
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		env: {
			...process.env,
			HOME: tempHome,
			USERPROFILE: tempHome,
			PORT: String(port),
			EXXETA_HOME: path.resolve(webServerDir, "../.."),
			EXXPERTS_CODING_AGENT_DIR: path.join(tempHome, ".exxperts", "agent"),
			EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot,
			...SMOKE_SERVER_AUTH_ENV,
		},
	});
	server.stdout.on("data", (chunk) => output.push(String(chunk)));
	server.stderr.on("data", (chunk) => output.push(String(chunk)));
	const deadline = Date.now() + 30_000;
	while (true) {
		if (server.exitCode !== null) throw new Error(`server exited ${server.exitCode}: ${output.join("")}`);
		try {
			if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break;
		} catch {}
		if (Date.now() > deadline) throw new Error(`server did not start: ${output.join("")}`);
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	const created = await authedFetch(`http://127.0.0.1:${port}/api/persistent-agents`, {
		method: "POST", headers: { "content-type": "application/json" },
		body: JSON.stringify({ displayName: "Permissions Test", userName: "Test", preferredUserAddress: "Test" }),
	});
	const createdBody = await created.json() as any;
	assert(created.status === 201 && typeof createdBody.agent?.id === "string", `room creation: ${created.status} ${JSON.stringify(createdBody)}`);
	roomId = createdBody.agent.id;
	const file = path.join(agentsRoot, roomId, "runtime", "permissions.json");
	const runtimeDir = path.dirname(file);
	assert(fs.statSync(runtimeDir).isDirectory(), "room scaffold creates its runtime directory");
	const missing = await request("GET");
	assert(missing.status === 200 && JSON.stringify(missing.value) === JSON.stringify({ exists: false, document: null, error: null }), `missing permissions GET has exactly the documented shape: ${JSON.stringify(missing)}`);
	const raw = '{"permission":{"bash":{"*":"deny","0":"allow"}}}';
	const saved = await request("PUT", raw);
	assert(saved.status === 200 && Object.keys(saved.value).join(",") === "exists,document,error" && saved.value.document.permission.bash["0"] === "allow", `PUT response has exactly the documented shape: ${JSON.stringify(saved)}`);
	const read = await request("GET");
	assert(read.status === 200 && Object.keys(read.value).join(",") === "exists,document,error" && read.value.document.permission.bash["0"] === "allow", `GET response has exactly the documented shape: ${JSON.stringify(read)}`);
	const routePolicy = await import("../src/remote-route-policy.js");
	assert(routePolicy.classifyRemoteRoute("GET", "/api/persistent-agents/:id/permissions") === "read", "remote GET permission route is readable");
	assert(routePolicy.classifyRemoteRoute("PUT", "/api/persistent-agents/:id/permissions") === "local", "remote PUT permission route is loopback-only");
	assert(resolveRoomPermission(readRoomPermissions(roomId, { persistentAgentsRoot: agentsRoot }), "bash", "0")?.action === "allow", "PUT preserves effective last-match precedence");
	assert(fs.readFileSync(file, "utf-8").indexOf('"*"') < fs.readFileSync(file, "utf-8").indexOf('"0"'), "file preserves source order");
	const encoded = await request("PUT", '{"permission":{"bash":{"*":"deny","\\u0030":"allow","0":"ask"}}}');
	assert(encoded.status === 200 && encoded.value.document.permission.bash["0"] === "ask", "duplicate escaped key uses JSON.parse last value");
	assert(fs.readFileSync(file, "utf-8").indexOf('"*"') < fs.readFileSync(file, "utf-8").indexOf('"0"'), "escaped key retains first source position");
	const roundTrip = await request("PUT", raw);
	assert(roundTrip.status === 200 && fs.readFileSync(file, "utf-8").indexOf('"*"') < fs.readFileSync(file, "utf-8").indexOf('"0"'), "source-ordered PUT keeps precedence");
	const before = fs.readFileSync(file, "utf-8");
	const rejectedMalformed = await request("PUT", '{"permission":{"bash":{"*":"allow"}},"permission":{"bash":{"*":"deny"}}} trailing');
	assert(rejectedMalformed.status === 400, `malformed raw JSON must 400: ${JSON.stringify(rejectedMalformed)}`);
	assert(fs.readFileSync(file, "utf-8") === before, "malformed raw JSON keeps old bytes");
	const missingRoom = await authedFetch(`http://127.0.0.1:${port}/api/persistent-agents/no-such-room/permissions`);
	assert(missingRoom.status === 404, `unknown room GET must 404, got ${missingRoom.status}`);
	const missingRoomPut = await authedFetch(`http://127.0.0.1:${port}/api/persistent-agents/no-such-room/permissions`, {
		method: "PUT", headers: { "content-type": "application/json" }, body: raw,
	});
	assert(missingRoomPut.status === 404 && !fs.existsSync(path.join(agentsRoot, "no-such-room", "runtime", "permissions.json")), "unknown room PUT must 404 without writing");
	const unauthenticated = await fetch(`http://127.0.0.1:${port}/api/persistent-agents/${roomId}/permissions`);
	assert(unauthenticated.status === 401, `unauthenticated GET must 401, got ${unauthenticated.status}`);
	const unauthorizedWrite = await fetch(`http://127.0.0.1:${port}/api/persistent-agents/${roomId}/permissions`, {
		method: "PUT", headers: { "content-type": "application/json" }, body: raw,
	});
	assert(unauthorizedWrite.status === 401 && fs.readFileSync(file, "utf-8") === before, "unauthenticated PUT must 401 without writing");
	fs.rmSync(path.join(agentsRoot, roomId, "runtime"), { recursive: true, force: true });
	fs.writeFileSync(path.join(agentsRoot, roomId, "runtime"), "cannot create permissions file");
	const storageFailure = await request("PUT", raw);
	assert(storageFailure.status === 500 && storageFailure.value.error === "permissions could not be saved", `storage errors must 500: ${JSON.stringify(storageFailure)}`);
	assert(fs.readFileSync(path.join(agentsRoot, roomId, "runtime"), "utf-8") === "cannot create permissions file", "failed storage write preserves existing bytes");
	fs.rmSync(path.join(agentsRoot, roomId, "runtime"));
	fs.mkdirSync(path.join(agentsRoot, roomId, "runtime"));
	fs.writeFileSync(file, before);
	const invalidRawShape = await request("PUT", '{"permission":{"bash":{"*":"allow"},"bash":{"":"deny"}}}');
	assert(invalidRawShape.status === 400 && typeof invalidRawShape.value.error === "string", `raw document validation errors must 400: ${JSON.stringify(invalidRawShape)}`);
	assert(fs.readFileSync(file, "utf-8") === before, "raw document validation leaves old bytes unchanged");
	const invalidRawSyntax = await request("PUT", '{"permission":{"bash":{"*":"allow"}}} trailing');
	assert(invalidRawSyntax.status === 400 && fs.readFileSync(file, "utf-8") === before, "invalid JSON syntax returns 400 without changing the file");
	for (const bad of ['{"permission":{"bash":{"":"deny"}}}', '{"permission":{"bash":"maybe"}}', '{ bad json']) {
		const invalid = await request("PUT", bad);
		assert(invalid.status === 400 && typeof invalid.value.error === "string", `invalid PUT must 400: ${JSON.stringify(invalid)}`);
		assert(fs.readFileSync(file, "utf-8") === before, "invalid PUT keeps old bytes");
	}
	const oversized = await request("PUT", JSON.stringify({ permission: { bash: { "*": "allow" }, padding: "a".repeat(1_100_000) } }));
	assert(oversized.status === 413, `oversized PUT must be limited: ${JSON.stringify(oversized)}`);
	assert(fs.readFileSync(file, "utf-8") === before, "oversized PUT keeps old bytes");
	console.log("room-permissions-api smoke: ok");
} catch (error) {
	console.error(output.join(""));
	throw error;
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempHome, { recursive: true, force: true });
}
