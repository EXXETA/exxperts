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

// A refusal that names the absolute path the model itself gave: only its code is checked.
async function expectCode(fn: () => unknown | Promise<unknown>, code: string, label: string): Promise<void> {
	try {
		await fn();
	} catch (error) {
		assert(error instanceof PersistentRoomWorkspaceToolError && error.code === code, `${label}: expected ${code}, got ${(error as Error).message}`);
		return;
	}
	throw new Error(`${label}: expected rejection`);
}

// In the home: a room's folder in the shared temp is one no room may use.
const tmp = fs.mkdtempSync(path.join(os.homedir(), "exxperts-workspace-tools-"));

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
	assert(createPersistentRoomWorkspaceTools(legacyNoToolPolicy).length === 0, "legacy MR5.5a policy should not create workspace tools");

	const tools = new Map(createPersistentRoomWorkspaceTools(policy).map((tool: any) => [tool.name, tool]));
	assert([...tools.keys()].sort().join(",") === "edit,find,grep,ls,read,write", "should register exactly the standard bounded workspace tools");
	assert(!tools.has("bash"), "should not register bash");

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
	const localFilesTools = createPersistentRoomWorkspaceTools(localFilesPolicy, { localFilesCwd: workspaceRoot });
	assert(localFilesTools.map((tool: any) => tool.name).join(",") === "ls,find,grep,read,write,edit", "Full access should register the six file tools");
	assert(localFilesTools.every((tool: any) => tool.parameters === tools.get(tool.name)?.parameters), "Full access and Bounded rooms get the same fenced tools");
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
	assert(createPersistentRoomWorkspaceTools(localFilesNoSpreadsheetPolicy, { localFilesCwd: workspaceRoot }).map((tool: any) => tool.name).join(",") === "ls,read", "a local-files custom selection should wrap exactly its own native tools");

	const lsRoot = await execute(tools, "ls", { path: "." }, tmp);
	assert(lsRoot.includes("README.md"), "ls . should include safe file");
	assert(lsRoot.includes("docs/"), "ls . should suffix directories with slash");
	const lsRootLines = lsRoot.split("\n");
	assert(lsRootLines.includes(".git/"), "ls . lists .git");
	assert(lsRootLines.includes(".gitignore"), "ls . should list the plain .gitignore file");
	assert(!lsRoot.includes(".exxeta"), "ls . must omit .exxeta");
	assert(lsRootLines.includes("node_modules/"), "ls . lists node_modules");
	assert(!lsRoot.includes(".env"), "ls . must omit .env files");
	assert(!lsRoot.includes("private.pem") && !lsRoot.includes("deploy.key") && !lsRoot.includes("id_rsa"), "ls . must omit secret-looking filenames");

	const findMarkdown = await execute(tools, "find", { pattern: "**/*.md", path: "." }, tmp);
	assert(findMarkdown.includes("README.md"), "find should include root markdown files");
	assert(findMarkdown.includes("docs/plan.md"), "find should include nested safe markdown files");
	assert(!findMarkdown.includes(workspaceRoot), "find output must not include absolute workspace root");
	const foundFiles = findMarkdown.split("\n\n")[0]!.split("\n");
	assert(!foundFiles.some((line) => line.includes(".git") || line.includes(".exxeta") || line.includes("node_modules")), "find must skip closed folders, and .git and node_modules unless it starts in one");
	assert(findMarkdown.includes("were not searched"), "find says it skipped .git and node_modules");
	fs.writeFileSync(path.join(workspaceRoot, "node_modules", "README.md"), "# vendored\n");
	assert((await execute(tools, "find", { pattern: "*.md", path: "node_modules" }, tmp)).includes("node_modules/README.md"), "find started inside node_modules searches it");
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
	await executeResult(tools, "write", { path: path.join(workspaceRoot, "abs.md"), content: "yes" }, tmp);
	assert(fs.readFileSync(path.join(workspaceRoot, "abs.md"), "utf-8") === "yes", "an absolute path inside the room's folder takes a write");
	await expectReject(() => execute(tools, "write", { path: "~/test.md", content: "no" }, tmp), tmp, "write home path");
	await expectReject(() => execute(tools, "write", { path: "../escape.md", content: "no" }, tmp), tmp, "write parent escape");
	await expectReject(() => execute(tools, "write", { path: ".git/config", content: "no", overwrite: true }, tmp), tmp, "write git settings");
	await expectReject(() => execute(tools, "write", { path: ".exxeta/test.md", content: "no" }, tmp), tmp, "write denied .exxeta");
	await execute(tools, "write", { path: "node_modules/test.md", content: "yes" }, tmp);
	assert(fs.existsSync(path.join(workspaceRoot, "node_modules", "test.md")), "node_modules takes a write");
	await expectReject(() => execute(tools, "write", { path: "existing-dir.md", content: "no" }, tmp), tmp, "write existing directory");
	if (fs.existsSync(path.join(workspaceRoot, "outside-link.md"))) {
		await expectReject(() => execute(tools, "write", { path: "outside-link.md", content: "no", overwrite: true }, tmp), tmp, "write symlink target");
	}
	if (fs.existsSync(path.join(workspaceRoot, "outside-dir-link"))) {
		await expectReject(() => execute(tools, "write", { path: "outside-dir-link/escape.md", content: "no" }, tmp), tmp, "write parent symlink escape");
	}
	await execute(tools, "write", { path: "large.md", content: "x".repeat(128 * 1024 + 1) }, tmp);
	assert(fs.statSync(path.join(workspaceRoot, "large.md")).size === 128 * 1024 + 1, "a write over 128 KiB goes through");

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
		await expectReject(() => execute(tools, "grep", { pattern: "x", path: ".exxeta" }, tmp), tmp, `${label} grep denied directory`);
		assert(toolOutput(await executeResult(tools, "grep", { pattern: "secret", path: ".git" }, tmp)).includes(".git/config:1: [secret]"), `${label}: grep started in .git searches it`);
	};

	const ripgrepPath = getToolPath("rg");
	if (ripgrepPath) {
		await runGrepEngineAssertions("ripgrep", "rg engine");
		const lookaround = await executeResult(tools, "grep", { pattern: "Plan(?= line)" }, tmp);
		assert(lookaround.details?.engine === "walk", "lookaround pattern should fall back to the walk engine");
		assert(toolOutput(lookaround).includes("docs/plan.md:1:"), "lookaround pattern should still match via automatic fallback");
	} else {
		console.log("SKIPPED: the ripgrep-engine grep cases (ripgrep is not installed here, and smokes never download it)");
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
	await expectCode(() => execute(tools, "write", { path: path.join(outsideRoot, "abs.txt"), content: "x" }, tmp), "outside_workspace", "write absolute path outside");
	await expectReject(() => execute(tools, "write", { path: "../escape.txt", content: "x" }, tmp), tmp, "write parent escape non-md");
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
	await execute(tools, "edit", { path: "data/grow.txt", edits: [{ oldText: "seed", newText: "x".repeat(128 * 1024) }] }, tmp);
	assert(fs.statSync(path.join(workspaceRoot, "data", "grow.txt")).size > 128 * 1024, "an edit that grows a file past 128 KiB goes through");
	await expectReject(() => execute(tools, "edit", { path: "missing.txt", edits: [{ oldText: "a", newText: "b" }] }, tmp), tmp, "edit missing file");
	await expectReject(() => execute(tools, "edit", { path: ".env", edits: [{ oldText: "TOKEN", newText: "T" }] }, tmp), tmp, "edit deny-listed file");
	await expectReject(() => execute(tools, "edit", { path: "../outside/outside.txt", edits: [{ oldText: "outside", newText: "x" }] }, tmp), tmp, "edit parent escape");
	if (fs.existsSync(path.join(workspaceRoot, "outside-link.txt"))) {
		await expectReject(() => execute(tools, "edit", { path: "outside-link.txt", edits: [{ oldText: "outside", newText: "x" }] }, tmp), tmp, "edit symlink target");
	}

	assert((await execute(tools, "read", { path: path.join(workspaceRoot, "README.md") }, tmp)).includes("Safe file."), "an absolute path inside the room's folder reads");
	await expectCode(() => execute(tools, "read", { path: path.join(outsideRoot, "outside.txt") }, tmp), "outside_workspace", "absolute path outside");
	await expectReject(() => execute(tools, "read", { path: "~/README.md" }, tmp), tmp, "home path");
	await expectReject(() => execute(tools, "read", { path: "../outside/outside.txt" }, tmp), tmp, "parent escape");
	assert((await execute(tools, "read", { path: ".git/config" }, tmp)).includes("[secret]"), ".git reads");
	await expectReject(() => execute(tools, "read", { path: ".exxeta/state.json" }, tmp), tmp, ".exxeta read");
	assert((await execute(tools, "read", { path: "node_modules/package.json" }, tmp)).includes("{}"), "node_modules reads");
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
	// A folder that no longer matches the one chosen: the room still binds with its tools, and each call says so.
	const tamperedTools = new Map(createPersistentRoomWorkspaceTools(tamperedHashPolicy).map((tool: any) => [tool.name, tool]));
	assert(tamperedTools.size === 6, "a room whose folder moved still gets its six tools");
	try {
		await executeResult(tamperedTools, "read", { path: "README.md" }, tmp);
		throw new Error("tampered pathHash: expected folder_moved rejection");
	} catch (error) {
		assert(error instanceof PersistentRoomWorkspaceToolError && error.code === "folder_moved" && /moved or replaced/.test(error.message), "a moved folder's call says the folder moved");
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
			throw new Error("symlink swap: expected folder_moved rejection");
		} catch (error) {
			assert(error instanceof PersistentRoomWorkspaceToolError && error.code === "folder_moved", "symlink-swapped workspace root should say the folder moved");
		}
	}

	await expectReject(() => execute(customDenyTools, "read", { path: "private/x.txt" }, tmp), tmp, "custom denySegments read");
	await expectReject(() => execute(customDenyTools, "read", { path: "extra.secretx" }, tmp), tmp, "custom deny glob read");
	await expectReject(() => execute(customDenyTools, "read", { path: ".exxeta/state.json" }, tmp), tmp, "the app's data stays closed beside custom denySegments");
	// A stored policy that still lists .git and node_modules, as every saved one does: the fence opens them anyway.
	assert(policy.denySegments.includes(".git") && policy.denySegments.includes("node_modules"), "the stored policy still lists .git and node_modules");
	assert((await execute(customDenyTools, "read", { path: ".git/config" }, tmp)).includes("[secret]"), ".git reads on a policy that lists it");
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
	assert(defaultResolution.policy, "room-default fallback should resolve a policy");
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
