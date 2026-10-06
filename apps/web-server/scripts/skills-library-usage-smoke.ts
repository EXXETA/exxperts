import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { authedFetch, type AuthedFetchInit, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "../src/skills-store.js";

// The Skills library says what each skill carries and where it is used: the
// detail lists the files a room can be allowed to run, and the list and the
// detail name the rooms that enable the skill, with its file count.
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-skills-usage-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const canonicalDir = path.join(tempHome, ".exxperts", "agent", "skills");
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 24000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// A library skill with bundled files in two folders, written as an import leaves
// it: the manifest, the files, then the provenance sidecar.
function writeLibrarySkill(name: string, description: string, files: string[], options: { frontmatterLicense?: string; recordLicense?: string; dir?: string; record?: boolean } = {}): void {
	const dir = options.dir ?? path.join(canonicalDir, name);
	fs.mkdirSync(dir, { recursive: true });
	const licenseLine = options.frontmatterLicense ? [`license: ${options.frontmatterLicense}`] : [];
	const manifest = ["---", `name: ${name}`, `description: ${description}`, ...licenseLine, "---", "", "Use the bundled files.", ""].join("\n");
	fs.writeFileSync(path.join(dir, "SKILL.md"), manifest);
	for (const file of files) {
		fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
		fs.writeFileSync(path.join(dir, file), `# ${file}\n`);
	}
	if (options.record === false) return;
	fs.writeFileSync(path.join(dir, "provenance.json"), `${JSON.stringify({ source: "local", importedAt: new Date().toISOString(), license: options.recordLicense ?? null, sha256: sha256(manifest) })}\n`);
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

async function api(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, {
		...init,
		headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
	});
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

let server: ChildProcessWithoutNullStreams | null = null;
const serverOutput: string[] = [];

try {
	const files = ["LICENSE.txt", "scripts/build.py", "scripts/helpers/theme.py"];
	writeLibrarySkill("deck-builder", "Builds slide decks", files);
	writeLibrarySkill("plain-notes", "Instructions only", []);
	// Licenses: a shared skill declares one in its SKILL.md; an import record's
	// license wins over the file's; a record without one falls back to the file.
	writeLibrarySkill("house-style", "Writes in the house style", [], { dir: path.join(tempHome, ".agents", "skills", "house-style"), frontmatterLicense: "MIT", record: false });
	writeLibrarySkill("recorded", "Carries a recorded license", [], { frontmatterLicense: "MIT", recordLicense: "Apache-2.0" });
	writeLibrarySkill("file-only", "Declares its license in the file", [], { frontmatterLicense: "BSD-3-Clause" });

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome, PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot },
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server);

	// --- The detail lists the skill's files --------------------------------------
	let detail = await api("/api/skills/deck-builder");
	assert(detail.status === 200, `detail should load, got ${detail.status}`);
	assert(JSON.stringify([...detail.body.bundledScripts].sort()) === JSON.stringify([...files].sort()), `the detail lists every bundled file, got ${JSON.stringify(detail.body.bundledScripts)}`);
	assert(detail.body.fileCount === files.length, `the detail counts the files, got ${detail.body.fileCount}`);
	assert(Array.isArray(detail.body.rooms) && detail.body.rooms.length === 0, "a skill no room enables has no rooms");
	assert(!("usedByAgents" in detail.body), "the dead usedByAgents field is gone");
	const plain = await api("/api/skills/plain-notes");
	assert(plain.status === 200 && plain.body.bundledScripts.length === 0 && plain.body.fileCount === 0, "a skill without files lists none");

	// --- The license a skill carries --------------------------------------------
	const listedNow = (await api("/api/skills")).body as Array<{ name: string; license: string | null; source: string }>;
	const byName = new Map(listedNow.map((skill) => [skill.name, skill] as const));
	assert(byName.get("house-style")?.source === "shared" && byName.get("house-style")?.license === "MIT", `a shared skill's own license shows in the list, got ${JSON.stringify(byName.get("house-style"))}`);
	assert((await api("/api/skills/house-style")).body.license === "MIT", "and in its detail");
	assert(byName.get("recorded")?.license === "Apache-2.0", `an import record's license wins over the file's, got ${JSON.stringify(byName.get("recorded"))}`);
	assert(byName.get("file-only")?.license === "BSD-3-Clause", `a record without a license falls back to the file's, got ${JSON.stringify(byName.get("file-only"))}`);
	assert(byName.get("plain-notes")?.license === null, "a skill that declares none has none");

	// --- Rooms that enable a skill appear in the list and the detail ------------
	const makeRoom = async (displayName: string): Promise<string> => {
		const created = await api("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
		const id = String(created.body?.agent?.id ?? "");
		assert(created.status < 300 && id, `room ${displayName} should be created, got ${created.status}`);
		return id;
	};
	const football = await makeRoom("Football");
	const discovery = await makeRoom("AI Discovery");
	const idle = await makeRoom("Idle Room");
	for (const room of [football, discovery]) {
		const enabled = await api(`/api/persistent-agents/${room}/skill-settings`, { method: "PUT", body: JSON.stringify({ action: "enable", name: "deck-builder" }) });
		assert(enabled.status === 200, `enable in ${room} should succeed, got ${enabled.status}`);
	}

	const list = await api("/api/skills");
	assert(list.status === 200, `list should load, got ${list.status}`);
	const listed = list.body.find((skill: any) => skill.name === "deck-builder");
	assert(listed, "the list carries deck-builder");
	assert(JSON.stringify(listed.rooms) === JSON.stringify([{ id: discovery, name: "AI Discovery" }, { id: football, name: "Football" }]), `the list names both rooms by display name, sorted, got ${JSON.stringify(listed.rooms)}`);
	assert(listed.fileCount === files.length, `the list counts the files, got ${listed.fileCount}`);
	assert(!listed.rooms.some((room: any) => room.id === idle), "a room that does not enable the skill is not listed");
	assert(list.body.find((skill: any) => skill.name === "plain-notes").rooms.length === 0, "an unused skill lists no rooms");

	detail = await api("/api/skills/deck-builder");
	assert(detail.body.rooms.map((room: any) => room.name).join(",") === "AI Discovery,Football", `the detail names the same rooms, got ${JSON.stringify(detail.body.rooms)}`);

	// Removing it from a room takes that room off the skill.
	await api(`/api/persistent-agents/${football}/skill-settings`, { method: "PUT", body: JSON.stringify({ action: "disable", name: "deck-builder" }) });
	detail = await api("/api/skills/deck-builder");
	assert(detail.body.rooms.map((room: any) => room.id).join(",") === discovery, `a disabled room leaves the skill's rooms, got ${JSON.stringify(detail.body.rooms)}`);

	console.log("skills-library-usage-smoke: OK");
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
