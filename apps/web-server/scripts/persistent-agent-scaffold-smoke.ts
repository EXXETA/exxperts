import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-agent-scaffold-home-"));
const tempAgentsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-agent-scaffold-root-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = tempAgentsRoot;

const {
	createPersistentAgentFromScaffoldInput,
	listPersistentAgents,
} = await import("../src/persistent-agents.js");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function assertIncludes(haystack: string, needle: string, label: string): void {
	assert(haystack.includes(needle), `${label}: expected to include ${needle}`);
}

function assertNotIncludes(haystack: string, needle: string, label: string): void {
	assert(!haystack.includes(needle), `${label}: expected not to include ${needle}`);
}

function readText(file: string): string {
	return fs.readFileSync(file, "utf-8");
}

function readJson(file: string): any {
	return JSON.parse(readText(file));
}

function assertFile(relRoot: string, relPath: string): void {
	const file = path.join(relRoot, relPath);
	assert(fs.existsSync(file) && fs.statSync(file).isFile(), `expected file: ${relPath}`);
}

function assertDir(relRoot: string, relPath: string): void {
	const dir = path.join(relRoot, relPath);
	assert(fs.existsSync(dir) && fs.statSync(dir).isDirectory(), `expected directory: ${relPath}`);
}

function assertCanonicalScaffoldDirs(agentRoot: string): void {
	for (const rel of [
		"runtime",
		"runtime/threads",
		"runtime/workspace-policies",
		"events",
		"events/checkpoint",
		"events/absorb",
		"events/structural-review",
	]) {
		assertDir(agentRoot, rel);
	}
}

function assertNoMutationEventFiles(agentRoot: string): void {
	for (const rel of ["events/checkpoint", "events/absorb", "events/structural-review"]) {
		const dir = path.join(agentRoot, rel);
		const eventJsonFiles = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith(".json")) : [];
		assert(eventJsonFiles.length === 0, `scaffolding must not create mutation event JSON files in ${rel}`);
	}
}

function assertNoLifecycleEventsDir(agentRoot: string): void {
	assert(!fs.existsSync(path.join(agentRoot, "events", "lifecycle")), "scaffolding must not create events/lifecycle");
}

function assertCanonicalScaffoldShape(agentRoot: string): void {
	assertCanonicalScaffoldDirs(agentRoot);
	assertNoMutationEventFiles(agentRoot);
	assertNoLifecycleEventsDir(agentRoot);
}

function assertNoGlobalStateCopied(agentRoot: string): void {
	const forbidden = [
		"persistent-agent-ai-profile.json",
		"auth.json",
		"models.json",
		"usage.jsonl",
		"web-chat-model.json",
		"provider.json",
		"providers.json",
		"model-registry.json",
		"model-cache.json",
	];
	for (const rel of forbidden) {
		assert(!fs.existsSync(path.join(agentRoot, rel)), `agent root must not contain global state file: ${rel}`);
	}
}

function assertGenericAnatomy(agentRoot: string): void {
	assertFile(agentRoot, "agent.json");
	assertFile(agentRoot, "L1a.md");
	assertFile(agentRoot, "L1b/current.md");
	assertDir(agentRoot, "L1b/archive");
	assertFile(agentRoot, "section_registry.json");
	assertFile(agentRoot, "runtime/state.json");
	assertCanonicalScaffoldShape(agentRoot);
	for (const legacyExtra of ["sessions", "checkpoints", "telemetry", "imports", "exports"]) {
		assert(!fs.existsSync(path.join(agentRoot, legacyExtra)), `generic scaffold should not create legacy directory: ${legacyExtra}`);
	}
}

const MODE_BODY_SENTINELS: Record<string, string> = {
	"default": "sharp thinking partner",
	learning: "patient mentor",
};

function assertGenericAgent(agentId: string, expected: { displayName: string; userName: string; preferredAddress: string; role?: string; description?: string; mode?: string; shouldContainBorja?: boolean }): void {
	const agentRoot = path.join(tempAgentsRoot, agentId);
	assertGenericAnatomy(agentRoot);
	assertNoGlobalStateCopied(agentRoot);

	const meta = readJson(path.join(agentRoot, "agent.json"));
	assert(meta.id === agentId, `${agentId}: agent.json id should equal generated id`);
	assert(meta.agentId === agentId, `${agentId}: agent.json agentId should equal generated id`);
	assert(meta.displayName === expected.displayName, `${agentId}: displayName should preserve friendly name`);
	assert(meta.role === (expected.role ?? "personal-coordinator"), `${agentId}: role should be preserved/defaulted`);
	assert(meta.templateId === (expected.role ?? "personal-coordinator"), `${agentId}: templateId should be preserved/defaulted`);
	assert(meta.description === (expected.description ?? ""), `${agentId}: description should be preserved/defaulted`);
	assert(meta.user?.displayName === expected.userName, `${agentId}: user.displayName should be stored`);
	assert(meta.user?.preferredAddress === expected.preferredAddress, `${agentId}: user.preferredAddress should be stored`);
	assert(!Object.prototype.hasOwnProperty.call(meta, "model"), `${agentId}: generic agent.json.model should be absent`);

	const l1a = readText(path.join(agentRoot, "L1a.md"));
	assertIncludes(l1a, `You are **${expected.displayName}**`, `${agentId}: L1a agent identity`);
	assertIncludes(l1a, `You work with **${expected.userName}**`, `${agentId}: L1a user identity`);
	assertIncludes(l1a, `refer to the user as **${expected.preferredAddress}**`, `${agentId}: L1a preferred address instruction`);
	const expectedMode = expected.mode ?? "default";
	assert(meta.mode === expectedMode, `${agentId}: agent.json mode should be ${expectedMode}`);
	assertIncludes(l1a, `template_version=2 mode=${expectedMode}`, `${agentId}: L1a template version marker`);
	assertIncludes(l1a, `l1a-mode-begin id=${expectedMode}`, `${agentId}: L1a mode slot begin marker`);
	assertIncludes(l1a, "l1a-mode-end", `${agentId}: L1a mode slot end marker`);
	assertIncludes(l1a, MODE_BODY_SENTINELS[expectedMode], `${agentId}: L1a mode body should match ${expectedMode} preset`);
	assertNotIncludes(l1a, "L1b", `${agentId}: L1a should not teach internal layer jargon`);
	if (!expected.shouldContainBorja) assertNotIncludes(l1a, "Borja", `${agentId}: L1a should not hard-code Borja`);

	const l1b = readText(path.join(agentRoot, "L1b/current.md"));
	assertIncludes(l1b, `Persistent agent id: ${agentId}`, `${agentId}: L1b generated id`);
	for (const section of ["## Chronos", "## Deep Memory", "## Active Items", "## Recent Context"]) {
		assertIncludes(l1b, section, `${agentId}: L1b mandatory section ${section}`);
	}
	assertNotIncludes(l1b, "Keep durable memory sparse", `${agentId}: L1b Active Items should be user-facing, not workflow mechanics`);

	const runtime = readJson(path.join(agentRoot, "runtime/state.json"));
	assert(runtime.agentId === agentId, `${agentId}: runtime state should record agent id`);
	assert(runtime.state === "idle", `${agentId}: runtime state should initialize idle`);
	assert(runtime.activeThreadId === null, `${agentId}: runtime activeThreadId should initialize null`);
	assert(runtime.model === null, `${agentId}: runtime model should initialize null`);
}

try {
	const initiallyListed = listPersistentAgents();
	assert(Array.isArray(initiallyListed) && initiallyListed.length === 0, "fresh empty agents root should list no rooms");
	assert(!fs.existsSync(path.join(tempAgentsRoot, "borja-coordinator")), "fresh listing must not create borja-coordinator");

	const tom = createPersistentAgentFromScaffoldInput({
		displayName: "  Tom  ",
		userName: "Alice Example",
		preferredUserAddress: "Alice",
		description: "Friendly planning companion",
	});
	assert(tom.agent.agentId === "tom", "Tom should produce agentId tom");
	assert(tom.agent.displayName === "Tom", "Tom displayName should be normalized but preserve case");
	assert(tom.status.status === "ready", "Tom status should be ready");
	const tomAgentBeforeDuplicate = readText(path.join(tempAgentsRoot, "tom", "agent.json"));

	// Room names are unique now: a duplicate (even case-shifted) is refused
	// with a 409 before any scaffold directory is reserved.
	for (const duplicateName of ["Tom", "  toM "]) {
		let duplicateRefused = false;
		try {
			createPersistentAgentFromScaffoldInput({
				displayName: duplicateName,
				user: { displayName: "Alice Example", preferredAddress: "Alice" },
			});
		} catch (error) {
			duplicateRefused = /already exists/.test((error as Error).message) && (error as any).statusCode === 409;
		}
		assert(duplicateRefused, `duplicate room name ${JSON.stringify(duplicateName)} should be refused with a 409`);
	}
	assert(!fs.existsSync(path.join(tempAgentsRoot, "tom-2")), "refused duplicate must not leave a scaffold root behind");
	assert(readText(path.join(tempAgentsRoot, "tom", "agent.json")) === tomAgentBeforeDuplicate, "refused duplicate must not touch original tom");

	const wolfgang = createPersistentAgentFromScaffoldInput({
		displayName: "Wolfgang",
		userName: "Alice Example",
		preferredUserAddress: "Alice",
	});
	assert(wolfgang.agent.agentId === "wolfgang", "Wolfgang should produce agentId wolfgang");

	const accented = createPersistentAgentFromScaffoldInput({
		displayName: "Tóm! Smith",
		userName: "Alice Example",
		preferredUserAddress: "Alice",
		role: "personal-coordinator",
	});
	assert(accented.agent.agentId === "tom-smith", "accented/punctuated name should produce safe slug tom-smith");

	// NFC/NFD twins are the same name: macOS paste can deliver the decomposed
	// spelling, which must refuse as a duplicate instead of slipping past the
	// uniqueness check as a byte-different twin.
	let nfdDuplicateRefused = false;
	try {
		createPersistentAgentFromScaffoldInput({
			displayName: "Tóm! Smith".normalize("NFD"),
			userName: "Alice Example",
			preferredUserAddress: "Alice",
		});
	} catch (error) {
		nfdDuplicateRefused = /already exists/.test((error as Error).message) && (error as any).statusCode === 409;
	}
	assert(nfdDuplicateRefused, "an NFD spelling of an existing room name should be refused with a 409");
	// Intake canonicalizes to NFC, so stored names are composed going forward.
	const nfdIntake = createPersistentAgentFromScaffoldInput({
		displayName: "Café Nord".normalize("NFD"),
		userName: "Alice Example",
		preferredUserAddress: "Alice",
	});
	assert(nfdIntake.agent.displayName === "Café Nord".normalize("NFC"), "display-name intake should store the NFC form");

	const mentor = createPersistentAgentFromScaffoldInput({
		displayName: "Mentor Max",
		userName: "Alice Example",
		preferredUserAddress: "Alice",
		mode: "  Learning ",
	});
	assert(mentor.agent.agentId === "mentor-max", "learning-mode scaffold should produce agentId mentor-max");

	let unknownModeRejected = false;
	try {
		createPersistentAgentFromScaffoldInput({ displayName: "Bad Mode", userName: "Alice Example", mode: "chaotic" });
	} catch (error) {
		unknownModeRejected = /mode must be one of/.test((error as Error).message);
	}
	assert(unknownModeRejected, "unknown mode should be rejected with the mode list");
	assert(!fs.existsSync(path.join(tempAgentsRoot, "bad-mode")), "rejected mode must not leave a scaffold root behind");

	assertGenericAgent("tom", {
		displayName: "Tom",
		userName: "Alice Example",
		preferredAddress: "Alice",
		description: "Friendly planning companion",
	});
	assertGenericAgent("wolfgang", { displayName: "Wolfgang", userName: "Alice Example", preferredAddress: "Alice" });
	assertGenericAgent("tom-smith", { displayName: "Tóm! Smith", userName: "Alice Example", preferredAddress: "Alice" });
	assertGenericAgent("mentor-max", { displayName: "Mentor Max", userName: "Alice Example", preferredAddress: "Alice", mode: "learning" });

	assert(!fs.existsSync(path.join(tempAgentsRoot, "borja-coordinator")), "generic scaffolding must not create borja-coordinator");

	const listed = listPersistentAgents();
	const listedIds = listed.map((status: any) => status.id);
	const sortedListedIds = [...listedIds].sort((a, b) => a.localeCompare(b));
	assert(JSON.stringify(listedIds) === JSON.stringify(sortedListedIds), "listPersistentAgents should be sorted deterministically");
	for (const id of ["tom", "tom-smith", "wolfgang"]) {
		assert(listedIds.includes(id), `listPersistentAgents should include ${id}`);
	}
	assert(!listedIds.includes("borja-coordinator"), "listPersistentAgents should not inject borja-coordinator");
	const listedTom = listed.find((status: any) => status.id === "tom");
	assert(listedTom?.displayName === "Tom" && listedTom?.status === "ready", "list should return Tom ready status");

	fs.rmSync(tempAgentsRoot, { recursive: true, force: true });
	fs.rmSync(tempHome, { recursive: true, force: true });
	console.log("persistent-agent scaffold smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp HOME preserved for inspection: ${tempHome}`);
	console.error(`temp agents root preserved for inspection: ${tempAgentsRoot}`);
	process.exitCode = 1;
}
