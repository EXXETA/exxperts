import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-cli-room-home-"));
const tempAgentsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-cli-room-root-"));
const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-cli-room-cwd-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const smokeAppDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(smokeAppDir, { recursive: true });
fs.writeFileSync(
	path.join(smokeAppDir, "openai-compatible-ai-profile.json"),
	JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }, { modelId: "claude-opus-4.6" }], maintenanceModel: "claude-opus-4.6" }, null, 2),
);
fs.writeFileSync(path.join(smokeAppDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = tempAgentsRoot;

const {
	createPersistentAgentInstance,
	createPersistentAgentPiSessionJsonlThreadRuntime,
	getPersistentAgentThread,
	writePersistentAgentThread,
} = await import("../src/persistent-agents.js");
const {
	createPersistentRoomDefaultCapabilityPolicy,
	writePersistentRoomDefaultCapabilityPolicy,
} = await import("../src/persistent-room-workspace-policy.js");
const { roomRuntimeArgs, sanitizeRoomPassthroughArgs } = require(path.join(repoRoot, "bin", "lib", "exxcode-launcher.cjs"));

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function assertIncludes(haystack: string, needle: string, label: string): void {
	assert(haystack.includes(needle), `${label}: expected to include ${needle}`);
}

function assertNotIncludes(haystack: string, needle: string, label: string): void {
	assert(!haystack.includes(needle), `${label}: expected not to include ${needle}`);
}

function readJson(file: string): any {
	return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function l1b(agentId: string, sentinel: string): string {
	return `<!-- exxeta:l1b schema_version=1 -->\n\n## Chronos\n\n- Persistent agent id: ${agentId}\n- Last checkpoint: none\n\n## Deep Memory\n\n${sentinel} deep memory.\n\n## Active Items\n\n${sentinel} active item.\n\n## Recent Context\n\nNo checkpointed sessions yet.\n`;
}

function writeFixtureAgent(agentId: string, displayName: string, sentinel: string): void {
	const root = path.join(tempAgentsRoot, agentId);
	fs.mkdirSync(path.join(root, "L1b", "archive"), { recursive: true, mode: 0o700 });
	fs.mkdirSync(path.join(root, "events", "checkpoint"), { recursive: true, mode: 0o700 });
	fs.mkdirSync(path.join(root, "events", "absorb"), { recursive: true, mode: 0o700 });
	fs.mkdirSync(path.join(root, "events", "structural-review"), { recursive: true, mode: 0o700 });
	const now = Date.now();
	fs.writeFileSync(path.join(root, "agent.json"), JSON.stringify({
		schemaVersion: 1,
		id: agentId,
		displayName,
		description: `${displayName} fixture`,
		role: "smoke-fixture",
		status: "ready",
		createdAt: now,
		updatedAt: now,
		l1aPath: "L1a.md",
		l1bCurrentPath: "L1b/current.md",
		l1bArchiveDir: "L1b/archive",
		sectionRegistryPath: "section_registry.json",
		currentSessionId: null,
		lastCheckpointId: null,
		recentContextSoftCap: 7,
		recentContextHardCap: 10,
		memoryTokenBudget: 12000,
	}, null, 2) + "\n", { mode: 0o600 });
	fs.writeFileSync(path.join(root, "L1a.md"), `# ${displayName} Constitution\n\n${sentinel} L1A sentinel.\n`, { mode: 0o600 });
	fs.writeFileSync(path.join(root, "L1b", "current.md"), l1b(agentId, sentinel), { mode: 0o600 });
	fs.writeFileSync(path.join(root, "section_registry.json"), JSON.stringify({
		schemaVersion: 1,
		sections: {
			Chronos: { status: "mandatory" },
			"Deep Memory": { status: "mandatory" },
			"Active Items": { status: "mandatory" },
			"Recent Context": { status: "mandatory" },
		},
		updatedAt: now,
	}, null, 2) + "\n", { mode: 0o600 });
}

function runBootstrap(input: any): { ok: true; boot: any } | { ok: false; message: string } {
	const result = spawnSync(process.execPath, [require.resolve("tsx/cli"), path.join(repoRoot, "bin", "lib", "persistent-room-bootstrap.ts")], {
		cwd: repoRoot,
		env: {
			...process.env,
			HOME: tempHome, USERPROFILE: tempHome,
			EXXETA_HOME: repoRoot,
			EXXETA_PERSISTENT_AGENTS_ROOT: tempAgentsRoot,
		},
		input: JSON.stringify({ cwd: tempCwd, ...input }),
		encoding: "utf8",
		stdio: ["pipe", "pipe", "pipe"],
		maxBuffer: 20 * 1024 * 1024,
	});
	if (result.status !== 0) return { ok: false, message: (result.stderr || result.stdout || "bootstrap failed").trim() };
	return { ok: true, boot: JSON.parse(result.stdout) };
}

function requireBootstrap(input: any): any {
	const result = runBootstrap(input);
	assert(result.ok, `bootstrap should succeed: ${result.ok ? "" : result.message}`);
	return result.boot;
}

function assertBootstrapFails(input: any, expected: string, label: string): void {
	const result = runBootstrap(input);
	assert(!result.ok, `${label}: bootstrap should fail`);
	assertIncludes(result.message, expected, label);
}

function assertPiLauncherArgs(boot: any, label: string): void {
	const args = roomRuntimeArgs(repoRoot, boot, [
		"--provider", "bad-provider",
		"--model", "bad-model",
		"--models", "bad/*",
		"--no-session",
		"--session", "/tmp/other.jsonl",
		"--raw-system-prompt", "bad prompt",
		"--system-prompt", "bad system",
		"--api-key", "bad-secret",
		"-p", "hello",
	]);
	assertIncludes(args.join("\u0000"), "--session", `${label} args`);
	assert(args[args.indexOf("--session") + 1] === boot.runtime.sessionFilePath, `${label}: --session should point to room JSONL`);
	assertIncludes(args.join("\u0000"), "--raw-system-prompt", `${label} args`);
	assert(args[args.indexOf("--raw-system-prompt") + 1] === boot.runtime.bootPromptSnapshot, `${label}: raw prompt should use sidecar snapshot`);
	assert(!args.includes("--no-session"), `${label}: Pi-backed args must not include --no-session`);
	assert(!args.includes("bad-provider") && !args.includes("bad-model") && !args.includes("bad/*"), `${label}: model overrides should be removed`);
	assert(!args.includes("bad-secret") && !args.includes("bad prompt") && !args.includes("bad system"), `${label}: auth/prompt overrides should be removed`);
	assert(args.includes("-p") && args.includes("hello"), `${label}: benign print passthrough should remain`);
	assert(args[args.lastIndexOf("--provider") + 1] === boot.model.provider, `${label}: locked provider should be final provider`);
	assert(args[args.lastIndexOf("--model") + 1] === boot.model.model, `${label}: locked model should be final model`);
}

const agentId = "cli-parity-smoke";
const model = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT 5.5" };

try {
	writeFixtureAgent(agentId, "CLI Parity Smoke Room", "CLI_PARITY_SENTINEL");
	const instance = createPersistentAgentInstance(agentId);

	// New CLI-created activeThread: bootstrap should create web-compatible Pi runtime metadata and sidecars.
	const cliCreatedThreadId = "cli_new_00000001";
	const cliCreatedBoot = requireBootstrap({ agentId, threadId: cliCreatedThreadId, model });
	assert(cliCreatedBoot.runtime.kind === "pi-session-jsonl", "CLI-created bootstrap should return pi-session-jsonl runtime");
	assert(cliCreatedBoot.restoredBlock === "", "CLI-created Pi-backed bootstrap should not return recap block");
	const cliCreatedThread = getPersistentAgentThread(agentId, cliCreatedThreadId);
	assert(cliCreatedThread?.runtime.kind === "pi-session-jsonl", "CLI-created thread metadata should be pi-session-jsonl");
	const cliRuntime = cliCreatedThread.runtime;
	const cliSessionFile = instance.runtimePiSessionPath(cliCreatedThreadId);
	const cliBootFile = instance.runtimeBootPromptSnapshotPath(cliCreatedThreadId);
	assert(fs.existsSync(cliSessionFile), "CLI-created Pi JSONL file should exist");
	assert(fs.existsSync(cliBootFile), "CLI-created boot-prompt sidecar should exist");
	const cliHeader = fs.readFileSync(cliSessionFile, "utf-8").trim().split(/\r?\n/).map((line) => JSON.parse(line))[0];
	assert(cliHeader?.type === "session" && cliHeader.id === cliRuntime.sessionId, "CLI-created JSONL header should match runtime session id");
	assert(cliHeader.cwd === tempCwd, "CLI-created JSONL header should use launcher/user cwd");
	const cliBootSnapshot = fs.readFileSync(cliBootFile, "utf-8");
	assert(crypto.createHash("sha256").update(cliBootSnapshot, "utf-8").digest("hex") === cliRuntime.bootPromptSha256, "CLI-created boot hash should match metadata");
	assert(cliCreatedBoot.runtime.sessionFilePath === cliSessionFile, "bootstrap Pi session absolute path should match room path");
	assert(cliCreatedBoot.runtime.bootPromptSha256 === cliRuntime.bootPromptSha256, "bootstrap Pi boot hash should match thread metadata");
	assertPiLauncherArgs(cliCreatedBoot, "CLI-created Pi thread");

	// Existing web-style Pi-backed activeThread: bootstrap should preserve and validate runtime, not recap from display cache.
	const webThreadId = "web_pi_00000001";
	const webWrite = writePersistentAgentThread(agentId, webThreadId, {
		state: "standby",
		origin: "home",
		model,
		items: [{ kind: "user", text: "WEB_DISPLAY_CACHE_SHOULD_NOT_BECOME_RECAP" }],
	}, {
		createRuntime: ({ model }) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId: webThreadId, model, cwd: tempCwd }),
	});
	assert(webWrite.thread.runtime.kind === "pi-session-jsonl", "web-style fixture should be pi-session-jsonl");
	const webBoot = requireBootstrap({ agentId, threadId: webThreadId, model });
	assert(webBoot.runtime.kind === "pi-session-jsonl", "existing Pi thread bootstrap should return pi-session-jsonl");
	assert(webBoot.runtime.sessionId === webWrite.thread.runtime.sessionId, "existing Pi bootstrap should preserve session id");
	assert(webBoot.restoredBlock === "", "existing Pi bootstrap should not return restored recap block");
	assertPiLauncherArgs(webBoot, "existing Pi thread");

	// Legacy transcript-recap thread: bootstrap and launcher should keep old recap/no-session path.
	const legacyThreadId = "legacy_00000001";
	writePersistentAgentThread(agentId, legacyThreadId, {
		state: "standby",
		origin: "home",
		model,
		items: [{ kind: "user", text: "legacy user turn" }, { kind: "assistant", text: "legacy assistant turn" }],
	});
	const legacyBoot = requireBootstrap({ agentId, threadId: legacyThreadId, model });
	assert(legacyBoot.runtime.kind === "transcript-recap-v1", "legacy bootstrap should stay transcript-recap-v1");
	assertIncludes(legacyBoot.restoredBlock, "legacy user turn", "legacy bootstrap recap");
	const legacyArgs = roomRuntimeArgs(repoRoot, legacyBoot, ["--model", "bad-model"]);
	assert(legacyArgs.includes("--system-prompt"), "legacy args should include --system-prompt");
	assertIncludes(legacyArgs[legacyArgs.indexOf("--system-prompt") + 1], "legacy assistant turn", "legacy system prompt should include recap");
	assert(legacyArgs.includes("--no-session"), "legacy args should include --no-session");
	assert(!legacyArgs.includes("--raw-system-prompt"), "legacy args should not use raw system prompt");
	assert(!legacyArgs.includes("bad-model"), "legacy args should still neutralize model override");

	// Broken Pi-backed runtime artifacts should fail clearly, with no silent downgrade to recap.
	const missingBootThreadId = "missing_boot_0001";
	const missingBootWrite = writePersistentAgentThread(agentId, missingBootThreadId, {
		state: "standby",
		origin: "home",
		model,
		items: [{ kind: "user", text: "display cache must not rescue missing boot" }],
	}, {
		createRuntime: ({ model }) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId: missingBootThreadId, model, cwd: tempCwd }),
	});
	assert(missingBootWrite.thread.runtime.kind === "pi-session-jsonl", "missing boot fixture should be Pi-backed");
	fs.rmSync(instance.runtimeBootPromptSnapshotPath(missingBootThreadId), { force: true });
	assertBootstrapFails({ agentId, threadId: missingBootThreadId, model }, "boot prompt snapshot is missing", "missing boot sidecar");

	const corruptJsonlThreadId = "bad_jsonl_000001";
	writePersistentAgentThread(agentId, corruptJsonlThreadId, {
		state: "standby",
		origin: "home",
		model,
		items: [{ kind: "assistant", text: "display cache must not rescue corrupt jsonl" }],
	}, {
		createRuntime: ({ model }) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId: corruptJsonlThreadId, model, cwd: tempCwd }),
	});
	fs.writeFileSync(instance.runtimePiSessionPath(corruptJsonlThreadId), "not json\n", { mode: 0o600 });
	assertBootstrapFails({ agentId, threadId: corruptJsonlThreadId, model }, "invalid JSON", "corrupt Pi JSONL");

	const localFilesWorkspace = path.join(tempHome, "local-files-workspace");
	fs.mkdirSync(localFilesWorkspace, { recursive: true });
	writePersistentRoomDefaultCapabilityPolicy(createPersistentRoomDefaultCapabilityPolicy({
		agentId,
		repoRoot,
		persistentAgentsRoot: tempAgentsRoot,
		root: localFilesWorkspace,
		workspaceAccessMode: "localFiles",
		displayLabel: "Local Files Workspace",
		source: "manual",
		mode: "read",
	}), { persistentAgentsRoot: tempAgentsRoot });
	const localFilesThreadId = "local_files_cli_0001";
	const localFilesBoot = requireBootstrap({ agentId, threadId: localFilesThreadId, model });
	assert(localFilesBoot.workspaceAccessMode === "localFiles", "CLI bootstrap should expose Local files workspace mode");
	assert(localFilesBoot.runtimeCwd === fs.realpathSync.native(localFilesWorkspace), "CLI bootstrap local-files runtime cwd should be workspace root realpath");
	assert(localFilesBoot.allowedToolNames.join(",") === "web_search,fetch_url,read_file,search_file,mcp,read,ls,find,grep,write,edit,read_spreadsheet", "CLI bootstrap local-files allowed tools should include native files and no bash");
	assert(!localFilesBoot.allowedToolNames.includes("bash"), "CLI bootstrap local-files allowed tools must not include bash");
	const localFilesThread = getPersistentAgentThread(agentId, localFilesThreadId);
	assert(localFilesThread?.runtime.kind === "pi-session-jsonl", "local-files CLI thread should be Pi-backed");
	const localFilesHeader = fs.readFileSync(instance.runtimePiSessionPath(localFilesThreadId), "utf-8").trim().split(/\r?\n/).map((line) => JSON.parse(line))[0];
	assert(localFilesHeader.cwd === fs.realpathSync.native(localFilesWorkspace), "local-files CLI JSONL header should use workspace root cwd");

	writePersistentRoomDefaultCapabilityPolicy(createPersistentRoomDefaultCapabilityPolicy({
		agentId,
		repoRoot,
		persistentAgentsRoot: tempAgentsRoot,
		root: localFilesWorkspace,
		workspaceAccessMode: "localFiles",
		displayLabel: "Local Files Workspace",
		source: "manual",
		mode: "read",
		bashEnabled: true,
	}), { persistentAgentsRoot: tempAgentsRoot });
	const localFilesBashThreadId = "local_files_bash_cli_0001";
	const localFilesBashBoot = requireBootstrap({ agentId, threadId: localFilesBashThreadId, model });
	assert(localFilesBashBoot.allowedToolNames.join(",") === "web_search,fetch_url,read_file,search_file,mcp,read,ls,find,grep,write,edit,read_spreadsheet,bash", "CLI bootstrap should include bash for explicit manual Local files bash policy");
	assert(localFilesBashBoot.workspaceCapability?.bashEnabled === true, "CLI bootstrap capability should expose explicit bash enabled");

	const sanitized = sanitizeRoomPassthroughArgs(["--model=bad", "--provider", "bad", "--no-session", "--session", "/tmp/x.jsonl", "--raw-system-prompt", "bad", "-p", "benign"]);
	assert(sanitized.join("\u0000") === ["-p", "benign"].join("\u0000"), "room passthrough sanitizer should keep benign prompt and remove controlled runtime/model flags");
	const malformedControlled = sanitizeRoomPassthroughArgs(["--model", "--print", "hello"]);
	assert(malformedControlled.join("\u0000") === ["--print", "hello"].join("\u0000"), "sanitizer should not swallow a following flag when a controlled value is omitted");

	fs.rmSync(tempAgentsRoot, { recursive: true, force: true });
	fs.rmSync(tempHome, { recursive: true, force: true });
	fs.rmSync(tempCwd, { recursive: true, force: true });
	console.log("cli persistent-room parity smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp HOME preserved for inspection: ${tempHome}`);
	console.error(`temp agents root preserved for inspection: ${tempAgentsRoot}`);
	console.error(`temp cwd preserved for inspection: ${tempCwd}`);
	process.exitCode = 1;
}
