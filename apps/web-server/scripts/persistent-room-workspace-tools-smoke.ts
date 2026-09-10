import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const {
	createPersistentRoomCapabilityPolicy,
	createPersistentRoomDefaultCapabilityPolicy,
	deletePersistentRoomDefaultCapabilityPolicy,
	persistentRoomWorkspacePolicyPath,
	resolvePersistentRoomCapabilityPolicy,
	writePersistentRoomDefaultCapabilityPolicy,
} = await import("../src/persistent-room-workspace-policy.js");
const {
	createPersistentRoomWorkspaceTools,
	isPersistentRoomWorkspaceToolPolicyEnabled,
	PersistentRoomWorkspaceToolError,
	resolvePersistentRoomWorkspacePath,
} = await import("../src/persistent-room-workspace-tools.js");
// The same manager path the bounded grep uses to locate ripgrep.
const { getToolPath } = await import("@exxeta/exxperts-runtime");

const agentId = "workspace-tools-smoke-room";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function toolOutput(result: any): string {
	return (result?.content ?? []).filter((part: any) => part?.type === "text").map((part: any) => String(part.text ?? "")).join("\n");
}

function assertNoAbsoluteLeak(value: unknown, tmp: string, label: string): void {
	const serialized = typeof value === "string" ? value : JSON.stringify(value);
	assert(!serialized.includes(tmp), `${label}: must not leak temp absolute workspace path`);
}

async function executeResult(tools: Map<string, any>, name: string, params: Record<string, unknown>, tmp: string): Promise<any> {
	const tool = tools.get(name);
	assert(tool, `tool ${name} should be registered`);
	const result = await tool.execute(`smoke-${name}`, params, undefined, undefined, {} as any);
	assertNoAbsoluteLeak(result, tmp, `${name} result`);
	return result;
}

async function execute(tools: Map<string, any>, name: string, params: Record<string, unknown>, tmp: string): Promise<string> {
	const result = await executeResult(tools, name, params, tmp);
	const output = toolOutput(result);
	assertNoAbsoluteLeak(output, tmp, `${name} output`);
	return output;
}

async function expectReject(fn: () => unknown | Promise<unknown>, tmp: string, label: string): Promise<void> {
	try {
		await fn();
	} catch (error) {
		assert(error instanceof PersistentRoomWorkspaceToolError, `${label}: expected PersistentRoomWorkspaceToolError`);
		assertNoAbsoluteLeak(error.message, tmp, `${label} error`);
		assert(!/\/var\/|\/tmp\/|Users\//.test(error.message), `${label}: error should stay generic`);
		return;
	}
	throw new Error(`${label}: expected rejection`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-workspace-tools-"));

try {
	const repoRoot = path.join(tmp, "repo");
	const homeRoot = path.join(tmp, "home");
	const exxetaStateRoot = path.join(homeRoot, ".exxeta");
	const persistentAgentsRoot = path.join(exxetaStateRoot, "personalized-agents");
	const workspaceRoot = path.join(tmp, "workspace");
	const outsideRoot = path.join(tmp, "outside");
	for (const dir of [repoRoot, exxetaStateRoot, persistentAgentsRoot, workspaceRoot, outsideRoot]) fs.mkdirSync(dir, { recursive: true });

	fs.writeFileSync(path.join(workspaceRoot, "README.md"), "# Workspace\n\nSafe file.\n");
	fs.mkdirSync(path.join(workspaceRoot, "docs"));
	fs.writeFileSync(path.join(workspaceRoot, "docs", "plan.md"), "Plan line 1\nPlan line 2\n");
	fs.writeFileSync(path.join(workspaceRoot, "docs", "notes.txt"), "Notes are safe.\n");
	fs.writeFileSync(path.join(workspaceRoot, "docs", "many.txt"), Array.from({ length: 10 }, (_, i) => `needle ${i}`).join("\n") + "\n");
	fs.mkdirSync(path.join(workspaceRoot, "existing-dir.md"));
	fs.mkdirSync(path.join(workspaceRoot, ".git"));
	fs.writeFileSync(path.join(workspaceRoot, ".git", "config"), "[secret]\n");
	fs.mkdirSync(path.join(workspaceRoot, ".exxeta"));
	fs.writeFileSync(path.join(workspaceRoot, ".exxeta", "state.json"), "{}\n");
	fs.mkdirSync(path.join(workspaceRoot, "node_modules"));
	fs.writeFileSync(path.join(workspaceRoot, "node_modules", "package.json"), "{}\n");
	fs.writeFileSync(path.join(workspaceRoot, ".env"), "TOKEN=secret\n");
	fs.writeFileSync(path.join(workspaceRoot, ".env.local"), "TOKEN=secret\n");
	fs.writeFileSync(path.join(workspaceRoot, "private.pem"), "secret\n");
	fs.writeFileSync(path.join(workspaceRoot, "deploy.key"), "secret\n");
	fs.writeFileSync(path.join(workspaceRoot, "id_rsa"), "secret\n");
	fs.writeFileSync(path.join(workspaceRoot, ".gitignore"), "ignored.log\n");
	fs.writeFileSync(path.join(workspaceRoot, "ignored.log"), "gitignored-marker hit\n");
	fs.writeFileSync(path.join(outsideRoot, "outside.txt"), "outside secret\n");
	fs.writeFileSync(path.join(outsideRoot, "outside.md"), "outside markdown\n");
	try {
		fs.symlinkSync(path.join(outsideRoot, "outside.txt"), path.join(workspaceRoot, "outside-link.txt"));
		fs.symlinkSync(path.join(outsideRoot, "outside.md"), path.join(workspaceRoot, "outside-link.md"));
		fs.symlinkSync(outsideRoot, path.join(workspaceRoot, "outside-dir-link"), "dir");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EPERM" && (error as NodeJS.ErrnoException).code !== "EACCES") throw error;
	}

	const policy = createPersistentRoomCapabilityPolicy({
		agentId: agentId,
		conversationId: "c_workspace_tools_smoke",
		repoRoot,
		persistentAgentsRoot,
		exxetaStateRoot,
		root: workspaceRoot,
		workspaceAccessMode: "bounded",
		source: "manual",
		now: new Date("2026-05-27T00:00:00.000Z"),
	});
	const legacyNoToolPolicy = { ...policy, allowedToolNames: [] };
	delete (legacyNoToolPolicy as any).toolSelection;
	assert(!isPersistentRoomWorkspaceToolPolicyEnabled(legacyNoToolPolicy), "legacy MR5.5a policy with root but empty allowedToolNames must not activate workspace tools");
	assert(createPersistentRoomWorkspaceTools(legacyNoToolPolicy).length === 0, "legacy MR5.5a policy should not create workspace tools");

	const tools = new Map(createPersistentRoomWorkspaceTools(policy).map((tool: any) => [tool.name, tool]));
	assert(isPersistentRoomWorkspaceToolPolicyEnabled(policy), "workspace policy should activate workspace tools");
	assert([...tools.keys()].sort().join(",") === "edit,find,grep,ls,read,write", "should register exactly the standard bounded workspace tools");
	assert(!tools.has("bash"), "should not register bash");
	for (const tool of tools.values()) {
		assert(String(tool.description).includes("workspace-relative") || String(tool.description).includes("workspace-relative paths"), `${tool.name} description should state workspace-relative contract`);
	}
	for (const toolName of ["find", "grep"]) {
		assert(String(tools.get(toolName)?.description).includes(".gitignore"), `${toolName} description should state that results include gitignored files`);
	}

	const localFilesPolicy = createPersistentRoomCapabilityPolicy({
		agentId: agentId,
		conversationId: "c_workspace_tools_local_files_smoke",
		repoRoot,
		persistentAgentsRoot,
		exxetaStateRoot,
		root: workspaceRoot,
		workspaceAccessMode: "localFiles",
		source: "manual",
		now: new Date("2026-05-27T00:05:00.000Z"),
	});
	const localFilesTools = new Map(createPersistentRoomWorkspaceTools(localFilesPolicy).map((tool: any) => [tool.name, tool]));
	assert(isPersistentRoomWorkspaceToolPolicyEnabled(localFilesPolicy), "local-files policy should activate workspace tools");
	assert(localFilesTools.size === 0, "local-files mode should register no curated workspace tools; native runtime tools own that surface");
	const localFilesNoSpreadsheetPolicy = createPersistentRoomCapabilityPolicy({
		agentId: agentId,
		conversationId: "c_workspace_tools_local_files_no_spreadsheet_smoke",
		repoRoot,
		persistentAgentsRoot,
		exxetaStateRoot,
		root: workspaceRoot,
		workspaceAccessMode: "localFiles",
		source: "manual",
		toolSelection: { kind: "custom", allowedToolNames: ["read", "ls"] },
		now: new Date("2026-05-27T00:06:00.000Z"),
	});
	assert(isPersistentRoomWorkspaceToolPolicyEnabled(localFilesNoSpreadsheetPolicy), "local-files native-only custom policy should still activate native runtime tools");
	assert(createPersistentRoomWorkspaceTools(localFilesNoSpreadsheetPolicy).length === 0, "local-files custom selection should register no curated tools either");

	const lsRoot = await execute(tools, "ls", { path: "." }, tmp);
	assert(lsRoot.includes("README.md"), "ls . should include safe file");
	assert(lsRoot.includes("docs/"), "ls . should suffix directories with slash");
	const lsRootLines = lsRoot.split("\n");
	assert(!lsRootLines.includes(".git") && !lsRootLines.includes(".git/"), "ls . must omit .git");
	assert(lsRootLines.includes(".gitignore"), "ls . should list the plain .gitignore file");
	assert(!lsRoot.includes(".exxeta"), "ls . must omit .exxeta");
	assert(!lsRoot.includes("node_modules"), "ls . must omit node_modules");
	assert(!lsRoot.includes(".env"), "ls . must omit .env files");
	assert(!lsRoot.includes("private.pem") && !lsRoot.includes("deploy.key") && !lsRoot.includes("id_rsa"), "ls . must omit secret-looking filenames");

	const findMarkdown = await execute(tools, "find", { pattern: "**/*.md", path: "." }, tmp);
	assert(findMarkdown.includes("README.md"), "find should include root markdown files");
	assert(findMarkdown.includes("docs/plan.md"), "find should include nested safe markdown files");
	assert(!findMarkdown.includes(workspaceRoot), "find output must not include absolute workspace root");
	assert(!findMarkdown.includes(".git") && !findMarkdown.includes(".exxeta") && !findMarkdown.includes("node_modules"), "find must skip denied directories");
	assert(!findMarkdown.includes(".env") && !findMarkdown.includes("private.pem") && !findMarkdown.includes("deploy.key") && !findMarkdown.includes("id_rsa"), "find must skip secret-looking files");
	assert(!findMarkdown.includes("outside"), "find must not follow symlinked directories or expose outside paths");

	const readSafe = await execute(tools, "read", { path: "docs/plan.md" }, tmp);
	assert(readSafe.includes("Plan line 1") && readSafe.includes("Plan line 2"), "read should return safe file contents");
	assert(!readSafe.includes("bash"), "workspace read output should not suggest bash fallback");

	const writeContent = "# Test\n\nSmall synthetic body.\n";
	const writeResult = await executeResult(tools, "write", { path: "notes/test.md", content: writeContent }, tmp);
	const writeOutput = toolOutput(writeResult);
	assert(writeOutput.includes("file generated to notes/test.md"), "write should report generated workspace-relative path");
	assert(writeResult.details?.path === "notes/test.md", "write details should include workspace-relative path");
	assert(writeResult.details?.bytes === Buffer.byteLength(writeContent, "utf-8"), "write details should include byte count");
	assert(writeResult.details?.created === true && writeResult.details?.overwritten === false, "write details should report created metadata");
	assert(!JSON.stringify(writeResult).includes(writeContent.trim()), "write result/details must not echo full content");
	assert(fs.readFileSync(path.join(workspaceRoot, "notes", "test.md"), "utf-8") === writeContent, "write should create Markdown file under workspace");

	const nestedContent = "# Nested\n";
	await execute(tools, "write", { path: "reports/demo/test.md", content: nestedContent }, tmp);
	assert(fs.readFileSync(path.join(workspaceRoot, "reports", "demo", "test.md"), "utf-8") === nestedContent, "write should create missing parent directories inside workspace");
	await expectReject(() => execute(tools, "write", { path: "notes/test.md", content: "replacement" }, tmp), tmp, "write existing without overwrite");
	const overwriteResult = await executeResult(tools, "write", { path: "notes/test.md", content: "# Replacement\n", overwrite: true }, tmp);
	assert(overwriteResult.details?.created === false && overwriteResult.details?.overwritten === true, "overwrite details should report overwritten metadata");
	assert(fs.readFileSync(path.join(workspaceRoot, "notes", "test.md"), "utf-8") === "# Replacement\n", "overwrite should replace existing Markdown file");
	await expectReject(() => execute(tools, "write", { path: path.join(workspaceRoot, "abs.md"), content: "no" }, tmp), tmp, "write absolute path");
	await expectReject(() => execute(tools, "write", { path: "~/test.md", content: "no" }, tmp), tmp, "write home path");
	await expectReject(() => execute(tools, "write", { path: "../escape.md", content: "no" }, tmp), tmp, "write parent escape");
	await expectReject(() => execute(tools, "write", { path: ".git/test.md", content: "no" }, tmp), tmp, "write denied .git");
	await expectReject(() => execute(tools, "write", { path: ".exxeta/test.md", content: "no" }, tmp), tmp, "write denied .exxeta");
	await expectReject(() => execute(tools, "write", { path: "node_modules/test.md", content: "no" }, tmp), tmp, "write denied node_modules");
	await expectReject(() => execute(tools, "write", { path: "existing-dir.md", content: "no" }, tmp), tmp, "write existing directory");
	if (fs.existsSync(path.join(workspaceRoot, "outside-link.md"))) {
		await expectReject(() => execute(tools, "write", { path: "outside-link.md", content: "no", overwrite: true }, tmp), tmp, "write symlink target");
	}
	if (fs.existsSync(path.join(workspaceRoot, "outside-dir-link"))) {
		await expectReject(() => execute(tools, "write", { path: "outside-dir-link/escape.md", content: "no" }, tmp), tmp, "write parent symlink escape");
	}
	await expectReject(() => execute(tools, "write", { path: "too-large.md", content: "x".repeat(128 * 1024 + 1) }, tmp), tmp, "write oversized content");

	fs.mkdirSync(path.join(workspaceRoot, "private"), { recursive: true });
	fs.writeFileSync(path.join(workspaceRoot, "private", "x.txt"), "custom-denied\n");
	fs.writeFileSync(path.join(workspaceRoot, "extra.secretx"), "custom-denied\n");
	const customDenyPolicy = { ...policy, denySegments: ["private"], denyFilenameGlobs: ["*.secretx"] };
	const customDenyTools = new Map(createPersistentRoomWorkspaceTools(customDenyPolicy).map((tool: any) => [tool.name, tool]));

	const runGrepEngineAssertions = async (engine: "ripgrep" | "walk", label: string): Promise<void> => {
		const grepPlan = await executeResult(tools, "grep", { pattern: "Plan line", path: "." }, tmp);
		assert(grepPlan.details?.engine === engine, `${label}: grep details should report the ${engine} engine`);
		const grepPlanOutput = toolOutput(grepPlan);
		assert(grepPlanOutput.includes("docs/plan.md:1: Plan line 1"), `${label}: grep should report workspace-relative path, line number, and text`);
		assert(grepPlanOutput.includes("docs/plan.md:2: Plan line 2"), `${label}: grep should report every matching line`);
		const grepCase = await executeResult(tools, "grep", { pattern: "PLAN LINE", ignoreCase: true }, tmp);
		assert(grepCase.details?.engine === engine, `${label}: ignoreCase grep should report the ${engine} engine`);
		assert(toolOutput(grepCase).includes("docs/plan.md:1:"), `${label}: grep ignoreCase should match case-insensitively`);
		const grepSecrets = await executeResult(tools, "grep", { pattern: "secret" }, tmp);
		assert(grepSecrets.details?.engine === engine, `${label}: secrets grep should report the ${engine} engine`);
		assert(toolOutput(grepSecrets).includes("No matches found"), `${label}: grep must not surface content from deny-listed or symlinked files`);
		const grepOutside = await executeResult(tools, "grep", { pattern: "outside secret" }, tmp);
		assert(toolOutput(grepOutside).includes("No matches found"), `${label}: grep must not surface symlinked-outside content`);
		const grepEnvDenied = await executeResult(tools, "grep", { pattern: "TOKEN=" }, tmp);
		assert(toolOutput(grepEnvDenied).includes("No matches found"), `${label}: grep must not surface .env content`);
		const grepIgnored = await executeResult(tools, "grep", { pattern: "gitignored-marker" }, tmp);
		assert(toolOutput(grepIgnored).includes("ignored.log:1:"), `${label}: grep should find files .gitignore would hide`);
		const grepCustomDenied = await executeResult(customDenyTools, "grep", { pattern: "custom-denied" }, tmp);
		assert(grepCustomDenied.details?.engine === engine, `${label}: custom-deny grep should report the ${engine} engine`);
		assert(toolOutput(grepCustomDenied).includes("No matches found"), `${label}: grep must not surface custom-denied segments or filename globs`);
		const grepLimited = await executeResult(tools, "grep", { pattern: "needle", limit: 5 }, tmp);
		const grepLimitedOutput = toolOutput(grepLimited);
		assert(grepLimitedOutput.split("\n").filter((line: string) => line.includes("docs/many.txt:")).length === 5, `${label}: grep should stop at the match limit`);
		assert(grepLimitedOutput.includes("5 matches limit reached"), `${label}: grep should note the match limit`);
		assert(grepLimited.details?.matchLimitReached === 5, `${label}: grep details should report the match limit`);
		await expectReject(() => execute(tools, "grep", { pattern: "a".repeat(513) }, tmp), tmp, `${label} grep overlong pattern`);
		await expectReject(() => execute(tools, "grep", { pattern: "x", path: "../outside" }, tmp), tmp, `${label} grep outside path`);
		await expectReject(() => execute(tools, "grep", { pattern: "x", path: ".git" }, tmp), tmp, `${label} grep denied directory`);
	};

	const ripgrepPath = getToolPath("rg");
	if (ripgrepPath) {
		await runGrepEngineAssertions("ripgrep", "rg engine");
		const lookaround = await executeResult(tools, "grep", { pattern: "Plan(?= line)" }, tmp);
		assert(lookaround.details?.engine === "walk", "lookaround pattern should fall back to the walk engine");
		assert(toolOutput(lookaround).includes("docs/plan.md:1:"), "lookaround pattern should still match via automatic fallback");
	} else {
		console.log("ripgrep binary not present; skipping ripgrep-engine grep assertions (smokes never download)");
	}
	const previousDisableRipgrep = process.env.EXXETA_BOUNDED_GREP_DISABLE_RIPGREP;
	process.env.EXXETA_BOUNDED_GREP_DISABLE_RIPGREP = "1";
	try {
		await runGrepEngineAssertions("walk", "walk engine");
		await expectReject(() => execute(tools, "grep", { pattern: "([" }, tmp), tmp, "grep invalid regex");
	} finally {
		if (previousDisableRipgrep === undefined) delete process.env.EXXETA_BOUNDED_GREP_DISABLE_RIPGREP;
		else process.env.EXXETA_BOUNDED_GREP_DISABLE_RIPGREP = previousDisableRipgrep;
	}

	const jsonContent = "{\"a\": 1}\n";
	const writeAnyResult = await executeResult(tools, "write", { path: "data/config.json", content: jsonContent }, tmp);
	assert(toolOutput(writeAnyResult).includes("file generated to data/config.json"), "write should create nested non-Markdown files");
	assert(fs.readFileSync(path.join(workspaceRoot, "data", "config.json"), "utf-8") === jsonContent, "write should persist non-Markdown content under workspace");
	await expectReject(() => execute(tools, "write", { path: "data/config.json", content: "{}" }, tmp), tmp, "write existing non-md without overwrite");
	const overwriteAnyResult = await executeResult(tools, "write", { path: "data/config.json", content: "{}\n", overwrite: true }, tmp);
	assert(overwriteAnyResult.details?.overwritten === true, "write overwrite=true should replace existing file");
	await expectReject(() => execute(tools, "write", { path: "sub/.env", content: "TOKEN=x" }, tmp), tmp, "write deny-listed filename");
	await expectReject(() => execute(tools, "write", { path: "sub/secrets.pem", content: "x" }, tmp), tmp, "write secret-looking filename");
	await expectReject(() => execute(tools, "write", { path: path.join(workspaceRoot, "abs.txt"), content: "x" }, tmp), tmp, "write absolute non-md path");
	await expectReject(() => execute(tools, "write", { path: "../escape.txt", content: "x" }, tmp), tmp, "write parent escape non-md");
	await expectReject(() => execute(tools, "write", { path: "too-large.txt", content: "x".repeat(128 * 1024 + 1) }, tmp), tmp, "write oversized non-md content");
	if (fs.existsSync(path.join(workspaceRoot, "outside-link.txt"))) {
		await expectReject(() => execute(tools, "write", { path: "outside-link.txt", content: "x", overwrite: true }, tmp), tmp, "write symlink target non-md");
	}
	if (fs.existsSync(path.join(workspaceRoot, "outside-dir-link"))) {
		await expectReject(() => execute(tools, "write", { path: "outside-dir-link/escape.txt", content: "x" }, tmp), tmp, "write parent symlink escape non-md");
	}

	const editResult = await executeResult(tools, "edit", { path: "docs/notes.txt", edits: [{ oldText: "safe", newText: "sound" }] }, tmp);
	assert(toolOutput(editResult).includes("file edited at docs/notes.txt"), "edit should report the workspace-relative path");
	assert(editResult.details?.edits === 1, "edit details should report a single applied edit");
	assert(fs.readFileSync(path.join(workspaceRoot, "docs", "notes.txt"), "utf-8") === "Notes are sound.\n", "edit should replace the unique text");
	await execute(tools, "write", { path: "data/multi.txt", content: "alpha one\nbeta two\n" }, tmp);
	const editMultiResult = await executeResult(tools, "edit", { path: "data/multi.txt", edits: [{ oldText: "alpha", newText: "gamma" }, { oldText: "two", newText: "three" }] }, tmp);
	assert(editMultiResult.details?.edits === 2, "edit details should count every applied edit");
	assert(fs.readFileSync(path.join(workspaceRoot, "data", "multi.txt"), "utf-8") === "gamma one\nbeta three\n", "two disjoint edits in one call should both apply");
	await execute(tools, "write", { path: "data/dup.txt", content: "aaa bbb aaa\n" }, tmp);
	await expectReject(() => execute(tools, "edit", { path: "data/dup.txt", edits: [{ oldText: "aaa", newText: "ccc" }] }, tmp), tmp, "edit duplicate oldText");
	await execute(tools, "write", { path: "data/overlap.txt", content: "abcdef\n" }, tmp);
	await expectReject(() => execute(tools, "edit", { path: "data/overlap.txt", edits: [{ oldText: "abcd", newText: "x" }, { oldText: "cdef", newText: "y" }] }, tmp), tmp, "edit overlapping edits");
	await expectReject(() => execute(tools, "edit", { path: "data/overlap.txt", edits: [{ oldText: "zzz", newText: "yyy" }] }, tmp), tmp, "edit oldText not found");
	await expectReject(() => execute(tools, "edit", { path: "data/overlap.txt", edits: [] }, tmp), tmp, "edit empty edits array");
	await execute(tools, "write", { path: "data/fuzzy.txt", content: "it\u2019s fine\n" }, tmp);
	await executeResult(tools, "edit", { path: "data/fuzzy.txt", edits: [{ oldText: "it's fine", newText: "it is fine" }] }, tmp);
	assert(fs.readFileSync(path.join(workspaceRoot, "data", "fuzzy.txt"), "utf-8").includes("it is fine"), "fuzzy matching should tolerate smart-quote differences");
	await execute(tools, "write", { path: "data/grow.txt", content: "seed\n" }, tmp);
	await expectReject(() => execute(tools, "edit", { path: "data/grow.txt", edits: [{ oldText: "seed", newText: "x".repeat(128 * 1024) }] }, tmp), tmp, "edit oversized result");
	await expectReject(() => execute(tools, "edit", { path: "missing.txt", edits: [{ oldText: "a", newText: "b" }] }, tmp), tmp, "edit missing file");
	await expectReject(() => execute(tools, "edit", { path: ".env", edits: [{ oldText: "TOKEN", newText: "T" }] }, tmp), tmp, "edit deny-listed file");
	await expectReject(() => execute(tools, "edit", { path: "../outside/outside.txt", edits: [{ oldText: "outside", newText: "x" }] }, tmp), tmp, "edit parent escape");
	if (fs.existsSync(path.join(workspaceRoot, "outside-link.txt"))) {
		await expectReject(() => execute(tools, "edit", { path: "outside-link.txt", edits: [{ oldText: "outside", newText: "x" }] }, tmp), tmp, "edit symlink target");
	}

	await expectReject(() => execute(tools, "read", { path: path.join(workspaceRoot, "README.md") }, tmp), tmp, "absolute path");
	await expectReject(() => execute(tools, "read", { path: "~/README.md" }, tmp), tmp, "home path");
	await expectReject(() => execute(tools, "read", { path: "../outside/outside.txt" }, tmp), tmp, "parent escape");
	await expectReject(() => execute(tools, "read", { path: ".git/config" }, tmp), tmp, ".git read");
	await expectReject(() => execute(tools, "read", { path: ".exxeta/state.json" }, tmp), tmp, ".exxeta read");
	await expectReject(() => execute(tools, "read", { path: "node_modules/package.json" }, tmp), tmp, "node_modules read");
	await expectReject(() => execute(tools, "read", { path: ".env" }, tmp), tmp, ".env read");
	await expectReject(() => execute(tools, "read", { path: ".env.local" }, tmp), tmp, ".env.* read");
	await expectReject(() => execute(tools, "read", { path: "private.pem" }, tmp), tmp, "pem read");
	await expectReject(() => execute(tools, "read", { path: "deploy.key" }, tmp), tmp, "key read");
	await expectReject(() => execute(tools, "read", { path: "id_rsa" }, tmp), tmp, "id_rsa read");
	await expectReject(() => execute(tools, "read", { path: "docs" }, tmp), tmp, "read directory");
	await expectReject(() => execute(tools, "read", { path: "missing.txt" }, tmp), tmp, "nonexistent read");
	if (fs.existsSync(path.join(workspaceRoot, "outside-link.txt"))) {
		await expectReject(() => execute(tools, "read", { path: "outside-link.txt" }, tmp), tmp, "symlink file escape");
	}
	if (fs.existsSync(path.join(workspaceRoot, "outside-dir-link"))) {
		await expectReject(() => execute(tools, "ls", { path: "outside-dir-link" }, tmp), tmp, "symlink directory ls");
	}

	await expectReject(() => resolvePersistentRoomWorkspacePath(policy, "/etc/passwd", "read"), tmp, "direct guard absolute");
	await expectReject(() => resolvePersistentRoomWorkspacePath(policy, "~/.ssh/id_rsa", "read"), tmp, "direct guard home");
	await expectReject(() => resolvePersistentRoomWorkspacePath(policy, "../outside/outside.txt", "read"), tmp, "direct guard traversal");

	const tamperedHashPolicy = { ...policy, roots: [{ ...policy.roots[0]!, pathHash: { algorithm: "sha256" as const, value: "0".repeat(64) } }] };
	assert(!isPersistentRoomWorkspaceToolPolicyEnabled(tamperedHashPolicy), "policy with mismatched root pathHash must not activate workspace tools");
	assert(createPersistentRoomWorkspaceTools(tamperedHashPolicy).length === 0, "policy with mismatched root pathHash should create no tools");
	try {
		resolvePersistentRoomWorkspacePath(tamperedHashPolicy, "README.md", "read");
		throw new Error("tampered pathHash: expected workspace_unavailable rejection");
	} catch (error) {
		assert(error instanceof PersistentRoomWorkspaceToolError && error.code === "workspace_unavailable", "tampered pathHash should report workspace unavailable");
	}

	const swapWorkspace = path.join(tmp, "swap-workspace");
	const swapElsewhere = path.join(tmp, "swap-elsewhere");
	fs.mkdirSync(swapWorkspace);
	fs.mkdirSync(swapElsewhere);
	fs.writeFileSync(path.join(swapWorkspace, "keep.md"), "keep\n");
	fs.writeFileSync(path.join(swapElsewhere, "keep.md"), "elsewhere\n");
	const swapPolicy = createPersistentRoomCapabilityPolicy({
		agentId,
		conversationId: "c_workspace_tools_swap_smoke",
		repoRoot,
		persistentAgentsRoot,
		exxetaStateRoot,
		root: swapWorkspace,
		workspaceAccessMode: "bounded",
		source: "manual",
		now: new Date("2026-05-27T00:10:00.000Z"),
	});
	const swapTools = new Map(createPersistentRoomWorkspaceTools(swapPolicy).map((tool: any) => [tool.name, tool]));
	assert((await execute(swapTools, "read", { path: "keep.md" }, tmp)).includes("keep"), "swap policy should read before the swap");
	const swapGrantedPath = swapPolicy.roots[0]!.realpath;
	fs.renameSync(swapGrantedPath, `${swapGrantedPath}-moved`);
	let swapLinked = true;
	try {
		fs.symlinkSync(swapElsewhere, swapGrantedPath, "dir");
	} catch (error) {
		swapLinked = false;
		if ((error as NodeJS.ErrnoException).code !== "EPERM" && (error as NodeJS.ErrnoException).code !== "EACCES") throw error;
	}
	if (swapLinked) {
		try {
			await executeResult(swapTools, "read", { path: "keep.md" }, tmp);
			throw new Error("symlink swap: expected workspace_unavailable rejection");
		} catch (error) {
			assert(error instanceof PersistentRoomWorkspaceToolError && error.code === "workspace_unavailable", "symlink-swapped workspace root should report workspace unavailable");
		}
	}

	await expectReject(() => execute(customDenyTools, "read", { path: "private/x.txt" }, tmp), tmp, "custom denySegments read");
	await expectReject(() => execute(customDenyTools, "read", { path: "extra.secretx" }, tmp), tmp, "custom deny glob read");
	await expectReject(() => execute(customDenyTools, "read", { path: ".git/config" }, tmp), tmp, "default .git deny must survive custom denySegments");
	await expectReject(() => execute(customDenyTools, "read", { path: ".env" }, tmp), tmp, "default .env deny must survive custom deny globs");

	const noWorkspaceResolution = resolvePersistentRoomCapabilityPolicy(agentId, "c_workspace_tools_no_default", { persistentAgentsRoot });
	assert(noWorkspaceResolution.source === "none" && noWorkspaceResolution.policy === null, "resolver without thread/default policy should be normal none case");
	const defaultPolicy = createPersistentRoomDefaultCapabilityPolicy({
		agentId: agentId,
		repoRoot,
		persistentAgentsRoot,
		exxetaStateRoot,
		root: workspaceRoot,
		workspaceAccessMode: "bounded",
		displayLabel: "Default Tools Workspace",
		source: "manual",
		now: new Date("2026-05-27T01:00:00.000Z"),
	});
	writePersistentRoomDefaultCapabilityPolicy(defaultPolicy, { persistentAgentsRoot });
	assert(!fs.existsSync(persistentRoomWorkspacePolicyPath(agentId, "room_default", { persistentAgentsRoot })), "room-default fallback must not create a room_default thread sidecar");
	const defaultResolution = resolvePersistentRoomCapabilityPolicy(agentId, "c_workspace_tools_default_fallback", { persistentAgentsRoot });
	assert(defaultResolution.source === "room-default", "resolver should use room default when no thread policy exists");
	assert(isPersistentRoomWorkspaceToolPolicyEnabled(defaultResolution.policy), "room-default fallback policy should activate workspace tools");
	const defaultTools = new Map(createPersistentRoomWorkspaceTools(defaultResolution.policy).map((tool: any) => [tool.name, tool]));
	const defaultRead = await execute(defaultTools, "read", { path: "README.md" }, tmp);
	assert(defaultRead.includes("Safe file."), "workspace tools should read via room-default fallback policy");
	deletePersistentRoomDefaultCapabilityPolicy(agentId, { persistentAgentsRoot });
	assert(resolvePersistentRoomCapabilityPolicy(agentId, "c_workspace_tools_default_fallback", { persistentAgentsRoot }).source === "none", "resolver should return none after clearing room default");

	console.log("persistent-room workspace tools smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	process.exitCode = 1;
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}
