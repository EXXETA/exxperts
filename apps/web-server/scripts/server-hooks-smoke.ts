// Started the way the desktop app and the launcher start it, the server
// registers no hooks (src/server-hooks.ts): client-context reports
// sharedServer: false beside today's two fields, and routes answer as before.
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort } from "./smoke-server-process.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-server-hooks-"));

let server: ChildProcessWithoutNullStreams | undefined;
const output: string[] = [];
try {
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => output.push(String(chunk)));
	server.stderr.on("data", (chunk) => output.push(String(chunk)));
	const deadline = Date.now() + 30_000;
	while (!(await fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false))) {
		assert.equal(server.exitCode, null, `server exited before startup:\n${output.join("")}`);
		assert.ok(Date.now() < deadline, `server did not become ready:\n${output.join("")}`);
		await new Promise((resolve) => setTimeout(resolve, 150));
	}

	const context = await fetch(`${baseUrl}/api/remote/client-context`, { headers: { ...SMOKE_AUTH_HEADERS } });
	assert.equal(context.status, 200);
	assert.deepEqual(await context.json(), { remote: false, capability: "full", sharedServer: false });
	console.log("  ok  client-context reports sharedServer: false");

	const anonymous = await fetch(`${baseUrl}/api/remote/client-context`);
	assert.equal(anonymous.status, 401);
	const rooms = await fetch(`${baseUrl}/api/remote/rooms`, { headers: { ...SMOKE_AUTH_HEADERS } });
	assert.equal(rooms.status, 200);
	console.log("  ok  with no hooks registered, the token check and the routes answer as before");
	console.log("server-hooks smoke passed");
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempHome, { recursive: true, force: true });
}
