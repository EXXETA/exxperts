// A room's id can be up to 120 characters, and every room route must still
// answer for it. A name made only of invisible characters is refused like an
// empty one, and the app's source writes such characters only as escapes.
// ONLY=long, ONLY=invisible or ONLY=source runs one part.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authedFetch, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort } from "./smoke-server-process.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const only = process.env.ONLY;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-long-id-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

async function waitUntil(predicate: () => Promise<boolean> | boolean, label: string, timeoutMs = 25_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`timed out waiting until ${label}`);
}

async function create(displayName: string): Promise<{ status: number; body: any }> {
	const res = await authedFetch(`${baseUrl}/api/persistent-agents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName, userName: "Synthetic User" }) });
	return { status: res.status, body: await res.json().catch(() => null) };
}

async function rename(id: string, displayName: string, dryRun = false): Promise<{ status: number; body: any }> {
	const res = await authedFetch(`${baseUrl}/api/persistent-agents/${id}/rename`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName, dryRun }) });
	return { status: res.status, body: await res.json().catch(() => null) };
}

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];

try {
	// Written raw, an invisible or direction character can't be seen in a review,
	// and the public mirror flags every file that holds one.
	if (!only || only === "source") {
		const invisible = /[\u00AD\u061C\u115F\u1160\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\u3164\uFFA0]/u;
		const found: string[] = [];
		const scan = (file: string): void => {
			fs.readFileSync(file, "utf-8").split("\n").forEach((line, index) => { if (invisible.test(line)) found.push(`${path.relative(repoRoot, file)}:${index + 1}`); });
		};
		const walk = (dir: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (/\.tsx?$/.test(entry.name)) scan(full);
			}
		};
		walk(path.join(repoRoot, "apps", "web-ui", "src"));
		walk(path.join(webServerDir, "src"));
		scan(fileURLToPath(import.meta.url));
		assert(found.length === 0, `the source writes invisible and direction characters as escapes, found raw ones at ${found.join(", ")}`);
		console.log("  ok  the source writes invisible and direction characters as escapes");
	}

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready");

	if (!only || only === "long") {
		const created = await create("Quarterly planning ".repeat(8).trim());
		assert(created.status === 201, `a long name creates a room, got ${created.status} ${JSON.stringify(created.body)}`);
		const id = String(created.body?.agent?.id ?? "");
		assert(id.length === 120, `the long name's id is the longest the server makes (120), got ${id.length}`);
		for (const route of ["status", "workspace-default"]) {
			const res = await authedFetch(`${baseUrl}/api/persistent-agents/${id}/${route}`);
			assert(res.status === 200, `GET ${route} answers 200 for a 120-character id, got ${res.status} ${(await res.text()).slice(0, 200)}`);
		}
		const renamed = await rename(id, "Short again", true);
		assert(renamed.status === 200, `rename answers for a 120-character id, got ${renamed.status} ${JSON.stringify(renamed.body)}`);
	}

	if (!only || only === "invisible") {
		for (const name of ["\u200B", "\u200B\u200D\uFEFF", " \u2060 \u200E ", "\u3164", "\u202E\u2066\u2069", "\u00AD"]) {
			const refused = await create(name);
			assert(refused.status === 400 && refused.body?.error === "Room name is required.", `a name of only ${JSON.stringify(name)} is refused like an empty one, got ${refused.status} ${JSON.stringify(refused.body)}`);
		}
		const trimmed = await create("\u200B Client C \u200B\uFEFF");
		assert(trimmed.status === 201 && trimmed.body?.agent?.displayName === "Client C", `invisible characters at both ends are trimmed, got ${trimmed.status} ${JSON.stringify(trimmed.body?.agent?.displayName)}`);
		const emoji = await create("Team \u{1F469}\u200D\u{1F4BB}");
		assert(emoji.status === 201 && emoji.body?.agent?.displayName === "Team \u{1F469}\u200D\u{1F4BB}", `an emoji joined with a zero-width joiner stays whole, got ${JSON.stringify(emoji.body?.agent?.displayName)}`);
		const flag = await create("Pub \u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}");
		assert(flag.status === 201 && flag.body?.agent?.displayName === "Pub \u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}", `a tag-sequence flag at the end stays whole, got ${JSON.stringify(flag.body?.agent?.displayName)}`);
		const renameId = String(trimmed.body.agent.id);
		const blank = await rename(renameId, "\u200B\u200C");
		assert(blank.status === 400 && blank.body?.error === "Room name is required.", `renaming to only invisible characters is refused, got ${blank.status} ${JSON.stringify(blank.body)}`);
		const duplicate = await create("Client C\u200B");
		assert(duplicate.status === 409 || /already exists/i.test(String(duplicate.body?.error ?? "")), `a name that differs only by an invisible character is the same name, got ${duplicate.status} ${JSON.stringify(duplicate.body)}`);
	}
	console.log("room-long-id-and-invisible-name smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
