import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The cross-tool shared skills directory (~/.agents/skills): skills there LIST
// in the library (source "shared", read-only) but the trust gate is unchanged —
// enablement pins the manifest hash, an external edit trips re-review, and the
// store routes never write into the shared dir. Symlinked skill dirs (the common
// shape of ~/.agents/skills) must both list AND enable.

// Isolated HOME: shared dir resolves to <HOME>/.agents/skills, the canonical
// user store to <HOME>/.exxperts/agent/skills.
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-skills-shared-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const sharedDir = path.join(tempHome, ".agents", "skills");
const canonicalDir = path.join(tempHome, ".exxperts", "agent", "skills");

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 24000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function seedSkill(dir: string, id: string, instructions: string): string {
	const skillDir = path.join(dir, id);
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(
		path.join(skillDir, "SKILL.md"),
		["---", `name: ${id}`, `displayName: ${id}`, `description: seeded ${id}`, "---", "", instructions, ""].join("\n"),
	);
	return skillDir;
}

async function waitForServer(server: ChildProcessWithoutNullStreams): Promise<void> {
	const deadline = Date.now() + 15000;
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

async function requestJson(pathname: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
	const response = await fetch(`${baseUrl}${pathname}`, {
		...init,
		headers: {
			...(init.body ? { "content-type": "application/json" } : {}),
			...(init.headers ?? {}),
		},
	});
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

// --- Pre-boot fixtures --------------------------------------------------------
// A shared-only skill; a name that exists in BOTH shared and the user store
// (user must win); and a skill dir symlinked INTO the shared dir, the common
// layout when other tools populate ~/.agents/skills.
seedSkill(sharedDir, "shared-cite", "SHARED cite instructions from ~/.agents/skills");
seedSkill(sharedDir, "collide", "SHARED body that must lose to the user store");
seedSkill(canonicalDir, "collide", "USER body that must win the collision");
const linkedTarget = seedSkill(path.join(tempHome, "elsewhere"), "linked-skill", "symlinked shared skill body");
// Junctions work on Windows without symlink privileges; "dir" everywhere else.
fs.symlinkSync(linkedTarget, path.join(sharedDir, "linked-skill"), process.platform === "win32" ? "junction" : "dir");

let server: ChildProcessWithoutNullStreams | null = null;
const serverOutput: string[] = [];

try {
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: {
			...process.env,
			HOME: tempHome,
			USERPROFILE: tempHome,
			PORT: String(port),
			EXXETA_HOME: repoRoot,
		},
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server);

	// --- Listing: shared skills appear, read-only, no provenance sidecar -------
	const list = await requestJson("/api/skills");
	assert(list.status === 200, `GET /api/skills should succeed, got ${list.status}`);
	const byName = new Map<string, any>((list.body as any[]).map((s) => [s.name, s]));
	const shared = byName.get("shared-cite");
	assert(shared, "shared-dir skill should list in the library");
	assert(shared.source === "shared", `shared skill should carry source "shared", got ${shared.source}`);
	assert(shared.protected === true, "shared skill must be protected (not editable/deletable from the library)");
	assert(shared.provenance === null || shared.provenance === undefined, "shared skill must carry no provenance sidecar data");

	// Precedence: the user store wins a name collision with the shared dir.
	const collide = byName.get("collide");
	assert(collide, "colliding skill should list once");
	assert(collide.source === "user", `user store must win the collision, got source ${collide.source}`);
	assert(collide.body.includes("USER body"), "collision must surface the user-store body");

	// The symlinked shared skill lists too.
	assert(byName.get("linked-skill"), "symlinked shared skill should list in the library");

	// --- Read-only: no write route can touch the shared dir --------------------
	const edited = await requestJson("/api/skills/shared-cite", {
		method: "PUT",
		body: JSON.stringify({ id: "shared-cite", displayName: "x", description: "x", instructions: "overwritten" }),
	});
	assert(edited.status === 404, `PUT of a shared skill must 404, got ${edited.status}`);
	const deleted = await requestJson("/api/skills/shared-cite", { method: "DELETE" });
	assert(deleted.status === 404, `DELETE of a shared skill must 404, got ${deleted.status}`);
	const recreated = await requestJson("/api/skills", {
		method: "POST",
		body: JSON.stringify({ id: "shared-cite", displayName: "x", description: "x", instructions: "shadow attempt" }),
	});
	assert(recreated.status === 409, `POST with a shared skill's name must 409, got ${recreated.status}`);
	const sharedManifest = fs.readFileSync(path.join(sharedDir, "shared-cite", "SKILL.md"), "utf-8");
	assert(sharedManifest.includes("SHARED cite instructions"), "the shared dir file must be untouched by write attempts");
	assert(!fs.existsSync(path.join(sharedDir, "shared-cite", "provenance.json")), "no provenance sidecar may be written into the shared dir");

	// --- Enablement: the hash pin covers shared skills, symlinks included ------
	const created = await requestJson("/api/persistent-agents", {
		method: "POST",
		body: JSON.stringify({ displayName: "Shared Skills Smoke Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }),
	});
	assert(created.status === 201, `room create should succeed, got ${created.status}: ${JSON.stringify(created.body)}`);
	const agentId = String(created.body?.agent?.agentId ?? "");
	assert(agentId, "room create should return an agent id");

	const enableShared = await requestJson(`/api/persistent-agents/${encodeURIComponent(agentId)}/skill-settings`, {
		method: "PUT",
		body: JSON.stringify({ action: "enable", name: "shared-cite" }),
	});
	assert(enableShared.status === 200, `enabling a shared skill should succeed, got ${enableShared.status}: ${JSON.stringify(enableShared.body)}`);
	const sharedStatus = (enableShared.body.skills as any[]).find((s) => s.name === "shared-cite");
	assert(sharedStatus?.status === "ok", `freshly enabled shared skill should be status ok, got ${JSON.stringify(sharedStatus)}`);

	// Symlinked skills must ENABLE, not just list (the fingerprint resolves
	// through the link; the content hash is the integrity unit).
	const enableLinked = await requestJson(`/api/persistent-agents/${encodeURIComponent(agentId)}/skill-settings`, {
		method: "PUT",
		body: JSON.stringify({ action: "enable", name: "linked-skill" }),
	});
	assert(enableLinked.status === 200, `enabling a symlinked shared skill should succeed, got ${enableLinked.status}: ${JSON.stringify(enableLinked.body)}`);
	const linkedStatus = (enableLinked.body.skills as any[]).find((s) => s.name === "linked-skill");
	assert(linkedStatus?.status === "ok", `symlinked shared skill should enable with status ok, got ${JSON.stringify(linkedStatus)}`);

	// --- Rug-pull: an external edit to a shared skill trips re-review ----------
	fs.writeFileSync(
		path.join(sharedDir, "shared-cite", "SKILL.md"),
		["---", "name: shared-cite", "displayName: shared-cite", "description: seeded shared-cite", "---", "", "EDITED by another tool behind exxperts' back", ""].join("\n"),
	);
	const afterEdit = await requestJson(`/api/persistent-agents/${encodeURIComponent(agentId)}/skill-settings`);
	assert(afterEdit.status === 200, `skill-settings read should succeed, got ${afterEdit.status}`);
	const editedStatus = (afterEdit.body.skills as any[]).find((s) => s.name === "shared-cite");
	assert(editedStatus?.status === "hash-mismatch", `externally edited shared skill must flip to hash-mismatch, got ${JSON.stringify(editedStatus)}`);

	console.log("skills shared-dir smoke passed: ~/.agents/skills lists as a read-only shared root (user store wins collisions, no route writes into it, no sidecars), symlinked skills list and enable, and an external edit to an enabled shared skill trips hash-mismatch re-review");
} finally {
	if (server) await stopSmokeServer(server);
	fs.rmSync(tempHome, { recursive: true, force: true });
}
