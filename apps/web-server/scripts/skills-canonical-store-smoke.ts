import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { authedFetch, type AuthedFetchInit, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "../src/skills-store.js";

// Isolated HOME: the canonical store resolves to <HOME>/.exxperts/agent/skills
// (loader dir) and the legacy store to <HOME>/.exxperts/app/skills.
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-skills-canonical-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const legacyDir = path.join(tempHome, ".exxperts", "app", "skills");
const canonicalDir = path.join(tempHome, ".exxperts", "agent", "skills");

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 24000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function seedSkill(dir: string, id: string, instructions: string): void {
	const skillDir = path.join(dir, id);
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(
		path.join(skillDir, "SKILL.md"),
		["---", `name: ${id}`, `displayName: ${id}`, `description: seeded ${id}`, "---", "", instructions, ""].join("\n"),
	);
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

async function requestJson(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, {
		...init,
		headers: {
			...(init.body ? { "content-type": "application/json" } : {}),
			...(init.headers ?? {}),
		},
	});
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

// --- Pre-boot fixtures for the move-on-boot migration (spec §1) --------------
// A legacy-only skill must move into the canonical store; a name that exists in
// BOTH must NOT be overwritten (canonical wins, legacy copy left in place).
seedSkill(legacyDir, "legacy-migrated-skill", "moved from the pre-unification web store");
seedSkill(legacyDir, "collision-skill", "LEGACY body that must NOT overwrite canonical");
seedSkill(canonicalDir, "collision-skill", "CANONICAL body that must survive the migration");

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
			...SMOKE_SERVER_AUTH_ENV,
			EXXETA_HOME: repoRoot,
		},
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server);

	// Migration moved the legacy-only skill into the canonical store and removed
	// it from the legacy dir.
	assert(fs.existsSync(path.join(canonicalDir, "legacy-migrated-skill", "SKILL.md")), "migration should move the legacy-only skill into the canonical store");
	assert(!fs.existsSync(path.join(legacyDir, "legacy-migrated-skill")), "migration should remove the moved skill from the legacy store");

	// Collision: canonical body survives, legacy copy left in place (no overwrite).
	const collisionCanonical = fs.readFileSync(path.join(canonicalDir, "collision-skill", "SKILL.md"), "utf-8");
	assert(collisionCanonical.includes("CANONICAL body"), "collision must keep the canonical body");
	assert(!collisionCanonical.includes("LEGACY body"), "collision must not overwrite canonical with the legacy body");
	assert(fs.existsSync(path.join(legacyDir, "collision-skill", "SKILL.md")), "collision must leave the legacy copy in place");

	// GET lists the migrated skill from the canonical dir (source "user").
	const list = await requestJson("/api/skills");
	assert(list.status === 200, `GET /api/skills should succeed, got ${list.status}`);
	const names: string[] = (list.body as any[]).map((s) => s.name);
	assert(names.includes("legacy-migrated-skill"), "GET /api/skills should surface the migrated skill from the canonical store");
	const migratedView = (list.body as any[]).find((s) => s.name === "legacy-migrated-skill");
	assert(migratedView.source === "user", "migrated skill should read as a user-source skill");

	// --- Canonical read/write via API + provenance sidecar (spec §1) ----------
	const instructions = "Always cite your sources before answering.";
	const created = await requestJson("/api/skills", {
		method: "POST",
		body: JSON.stringify({ id: "cite-sources", displayName: "Cite Sources", description: "cite before answering", instructions }),
	});
	assert(created.status === 201, `POST /api/skills should create, got ${created.status}: ${JSON.stringify(created.body)}`);

	const createdSkillDir = path.join(canonicalDir, "cite-sources");
	assert(fs.existsSync(path.join(createdSkillDir, "SKILL.md")), "created skill SKILL.md should land in the canonical store");
	// It must NOT land in the legacy store.
	assert(!fs.existsSync(path.join(legacyDir, "cite-sources")), "created skill must not be written to the legacy store");

	// provenance.json sidecar: source "local", sha256 = hash of the whole SKILL.md.
	const provenancePath = path.join(createdSkillDir, "provenance.json");
	assert(fs.existsSync(provenancePath), "created skill should have a provenance.json sidecar");
	const provenance = JSON.parse(fs.readFileSync(provenancePath, "utf-8"));
	assert(provenance.source === "local", "hand-written skill provenance source should be 'local'");
	assert(provenance.license === null, "hand-written skill provenance license should be null");
	assert(typeof provenance.importedAt === "string" && !Number.isNaN(Date.parse(provenance.importedAt)), "provenance importedAt should be an ISO timestamp");
	// The fingerprint is the whole SKILL.md on disk (frontmatter + body), so a
	// description edit forces re-review just like a body edit (spec §7 must 2).
	const createdManifest = fs.readFileSync(path.join(createdSkillDir, "SKILL.md"), "utf-8");
	assert(provenance.sha256 === sha256(createdManifest), `provenance sha256 should hash the whole SKILL.md, got ${provenance.sha256}`);
	assert(createdManifest.includes(instructions), "the SKILL.md must contain the submitted instructions");
	assert(created.body?.body === instructions, "created skill body should equal the submitted instructions");

	// Round-trip GET.
	const fetched = await requestJson("/api/skills/cite-sources");
	assert(fetched.status === 200 && fetched.body?.name === "cite-sources", "GET /api/skills/:id should return the created skill");

	// Edit refreshes the sidecar hash.
	const newInstructions = "Always cite sources AND provide a confidence level.";
	const updated = await requestJson("/api/skills/cite-sources", {
		method: "PUT",
		body: JSON.stringify({ id: "cite-sources", displayName: "Cite Sources", description: "cite before answering", instructions: newInstructions }),
	});
	assert(updated.status === 200, `PUT /api/skills/:id should succeed, got ${updated.status}: ${JSON.stringify(updated.body)}`);
	const updatedProvenance = JSON.parse(fs.readFileSync(provenancePath, "utf-8"));
	const updatedManifest = fs.readFileSync(path.join(createdSkillDir, "SKILL.md"), "utf-8");
	assert(updatedProvenance.sha256 === sha256(updatedManifest), "editing a skill should refresh the provenance sha256 over the new SKILL.md");
	assert(updatedProvenance.sha256 !== provenance.sha256, "a body change must change the sha256 (rug-pull signal)");
	// Only the hash refreshes — origin fields survive a local edit (an edited
	// imported skill must not lose where it came from).
	assert(updatedProvenance.source === provenance.source, "editing a skill must preserve the provenance source");
	assert(updatedProvenance.importedAt === provenance.importedAt, "editing a skill must preserve the provenance importedAt");
	assert(updatedProvenance.license === provenance.license, "editing a skill must preserve the provenance license");

	// Delete removes the whole skill dir (SKILL.md + sidecar).
	const deleted = await requestJson("/api/skills/cite-sources", { method: "DELETE" });
	assert(deleted.status === 200 && deleted.body?.deleted === "cite-sources", "DELETE /api/skills/:id should succeed");
	assert(!fs.existsSync(createdSkillDir), "DELETE should remove the skill dir including the provenance sidecar");

	console.log("skills-canonical-store-smoke: OK");
} catch (error) {
	const output = serverOutput.join("").trim();
	if (output) console.error(output.split("\n").slice(-60).join("\n"));
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp HOME preserved for inspection: ${tempHome}`);
	process.exitCode = 1;
} finally {
	await stopSmokeServer(server);
	if (process.exitCode == null || process.exitCode === 0) {
		fs.rmSync(tempHome, { recursive: true, force: true });
	}
}
