import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-permissions-"));

const mod = await import("./index.ts");
const registerPermissions = mod.default;

let toolCallHandler: ((event: any, ctx: any) => Promise<any>) | undefined;
registerPermissions({
	on(name: string, handler: any) {
		if (name === "tool_call") toolCallHandler = handler;
	},
} as any);

assert.ok(toolCallHandler, "permissions registered a tool_call handler");

const ctx = { cwd: tempCwd, ui: { setStatus: () => undefined } };

// Base room gate: capability tools pass, filesystem tools are blocked until a
// validated persistent-room workspace marker grants them.
for (const toolName of ["kb_search", "artifact_write_html_deck", "memory_recall", "web_search", "fetch_url", "mcp", "mcp_list"]) {
	const result = await toolCallHandler!({ toolName, input: {} }, ctx);
	assert.equal(result, undefined, `room persona allows ${toolName}`);
}
for (const toolName of ["bash", "read", "ls", "find", "grep", "write", "edit"]) {
	const result = await toolCallHandler!({ toolName, input: {} }, ctx);
	assert.equal(result?.block, true, `room persona blocks ${toolName} without a workspace marker`);
}
const workspaceWriteWithoutMarker = await toolCallHandler!({ toolName: "write_markdown_file", input: { path: "notes/test.md", content: "# Test" } }, ctx);
assert.equal(workspaceWriteWithoutMarker?.block, true, "write_markdown_file is blocked without a validated persistent-room workspace marker");

process.env.EXXETA_PERSISTENT_ROOM_SESSION = "1";
process.env.EXXETA_PERSISTENT_ROOM_AGENT = "wolfgang";
process.env.EXXETA_PERSISTENT_ROOM_WORKSPACE_ACCESS_MODE = "bounded";
process.env.EXXETA_PERSISTENT_ROOM_WORKSPACE_TOOLS = "ls,find,grep,read,write,edit";
toolCallHandler = undefined;
registerPermissions({
	on(name: string, handler: any) {
		if (name === "tool_call") toolCallHandler = handler;
	},
} as any);
assert.ok(toolCallHandler, "permissions registered persistent-room tool_call handler");
for (const toolName of ["ls", "find", "grep", "read", "write", "edit"]) {
	const result = await toolCallHandler!({ toolName, input: {} }, ctx);
	assert.equal(result, undefined, `selected persistent room can use bounded workspace tool ${toolName}`);
}
for (const toolName of ["bash", "write_markdown_file", "read_spreadsheet"]) {
	const result = await toolCallHandler!({ toolName, input: {} }, ctx);
	assert.equal(result?.block, true, `selected persistent room still blocks ${toolName}`);
}

process.env.EXXETA_PERSISTENT_ROOM_WORKSPACE_TOOLS = "ls,grep";
toolCallHandler = undefined;
registerPermissions({
	on(name: string, handler: any) {
		if (name === "tool_call") toolCallHandler = handler;
	},
} as any);
assert.ok(toolCallHandler, "permissions registered custom subset workspace tool_call handler");
for (const toolName of ["ls", "grep"]) {
	const result = await toolCallHandler!({ toolName, input: {} }, ctx);
	assert.equal(result, undefined, `selected persistent room can use custom subset tool ${toolName}`);
}
for (const toolName of ["find", "read", "write_markdown_file", "read_spreadsheet", "write", "edit", "bash"]) {
	const result = await toolCallHandler!({ toolName, input: {} }, ctx);
	assert.equal(result?.block, true, `custom subset persistent room blocks ${toolName}`);
}

process.env.EXXETA_PERSISTENT_ROOM_AGENT = "../wolfgang";
toolCallHandler = undefined;
registerPermissions({
	on(name: string, handler: any) {
		if (name === "tool_call") toolCallHandler = handler;
	},
} as any);
assert.ok(toolCallHandler, "permissions registered invalid persistent-room tool_call handler");
const invalidAgentReadResult = await toolCallHandler!({ toolName: "read", input: {} }, ctx);
assert.equal(invalidAgentReadResult?.block, true, "invalid persistent-room agent marker should not allow read");

process.env.EXXETA_PERSISTENT_ROOM_AGENT = "wolfgang";
process.env.EXXETA_PERSISTENT_ROOM_WORKSPACE_TOOLS = "ls,read,read";
toolCallHandler = undefined;
registerPermissions({
	on(name: string, handler: any) {
		if (name === "tool_call") toolCallHandler = handler;
	},
} as any);
assert.ok(toolCallHandler, "permissions registered duplicate workspace bundle tool_call handler");
const duplicateBundleReadResult = await toolCallHandler!({ toolName: "read", input: {} }, ctx);
assert.equal(duplicateBundleReadResult?.block, true, "duplicate workspace tool bundle should not allow read");

process.env.EXXETA_PERSISTENT_ROOM_WORKSPACE_TOOLS = "ls,find,read,write_markdown_file";
toolCallHandler = undefined;
registerPermissions({
	on(name: string, handler: any) {
		if (name === "tool_call") toolCallHandler = handler;
	},
} as any);
assert.ok(toolCallHandler, "permissions registered invalid workspace bundle tool_call handler");
const invalidBundleReadResult = await toolCallHandler!({ toolName: "read", input: {} }, ctx);
assert.equal(invalidBundleReadResult?.block, true, "workspace tool bundle naming retired tools should fail closed at the gate");

process.env.EXXETA_PERSISTENT_ROOM_WORKSPACE_ACCESS_MODE = "localFiles";
process.env.EXXETA_PERSISTENT_ROOM_WORKSPACE_TOOLS = "read,ls,find,grep,write,edit";
toolCallHandler = undefined;
registerPermissions({
	on(name: string, handler: any) {
		if (name === "tool_call") toolCallHandler = handler;
	},
} as any);
assert.ok(toolCallHandler, "permissions registered local-files workspace tool_call handler");
for (const toolName of ["read", "ls", "find", "grep", "write", "edit"]) {
	const result = await toolCallHandler!({ toolName, input: {} }, ctx);
	assert.equal(result, undefined, `local-files persistent room can use ${toolName}`);
}
const localFilesBashResult = await toolCallHandler!({ toolName: "bash", input: {} }, ctx);
assert.equal(localFilesBashResult?.block, true, "local-files persistent room must block bash unless explicitly enabled for manual room use");
process.env.EXXETA_PERSISTENT_ROOM_BASH_ENABLED = "1";
process.env.EXXETA_PERSISTENT_ROOM_EXECUTION_CONTEXT = "manual";
toolCallHandler = undefined;
registerPermissions({
	on(name: string, handler: any) {
		if (name === "tool_call") toolCallHandler = handler;
	},
} as any);
assert.ok(toolCallHandler, "permissions registered local-files bash-enabled tool_call handler");
const localFilesBashEnabledResult = await toolCallHandler!({ toolName: "bash", input: {} }, ctx);
assert.equal(localFilesBashEnabledResult, undefined, "local-files manual persistent room can use bash when explicitly enabled");
process.env.EXXETA_PERSISTENT_ROOM_EXECUTION_CONTEXT = "background";
toolCallHandler = undefined;
registerPermissions({
	on(name: string, handler: any) {
		if (name === "tool_call") toolCallHandler = handler;
	},
} as any);
assert.ok(toolCallHandler, "permissions registered local-files background bash marker handler");
const localFilesBackgroundBashResult = await toolCallHandler!({ toolName: "bash", input: {} }, ctx);
assert.equal(localFilesBackgroundBashResult?.block, true, "background persistent room should block bash even when room default has bash enabled");
process.env.EXXETA_PERSISTENT_ROOM_WORKSPACE_ACCESS_MODE = "bounded";
process.env.EXXETA_PERSISTENT_ROOM_EXECUTION_CONTEXT = "manual";
toolCallHandler = undefined;
registerPermissions({
	on(name: string, handler: any) {
		if (name === "tool_call") toolCallHandler = handler;
	},
} as any);
assert.ok(toolCallHandler, "permissions registered bounded bash marker handler");
const boundedBashMarkerResult = await toolCallHandler!({ toolName: "bash", input: {} }, ctx);
assert.equal(boundedBashMarkerResult?.block, true, "bounded persistent room should block bash even if bash marker is present");
delete process.env.EXXETA_PERSISTENT_ROOM_BASH_ENABLED;
delete process.env.EXXETA_PERSISTENT_ROOM_EXECUTION_CONTEXT;
process.env.EXXETA_PERSISTENT_ROOM_WORKSPACE_ACCESS_MODE = "localFiles";
const localFilesMarkdownWriteResult = await toolCallHandler!({ toolName: "write_markdown_file", input: {} }, ctx);
assert.equal(localFilesMarkdownWriteResult?.block, true, "local-files persistent room should not allow retired write_markdown_file");

process.env.EXXETA_PERSISTENT_ROOM_WORKSPACE_TOOLS = "read,grep";
toolCallHandler = undefined;
registerPermissions({
	on(name: string, handler: any) {
		if (name === "tool_call") toolCallHandler = handler;
	},
} as any);
assert.ok(toolCallHandler, "permissions registered local-files custom subset tool_call handler");
for (const toolName of ["read", "grep"]) {
	const result = await toolCallHandler!({ toolName, input: {} }, ctx);
	assert.equal(result, undefined, `local-files custom subset can use ${toolName}`);
}
for (const toolName of ["ls", "find", "write", "edit", "read_spreadsheet", "bash", "write_markdown_file"]) {
	const result = await toolCallHandler!({ toolName, input: {} }, ctx);
	assert.equal(result?.block, true, `local-files custom subset blocks ${toolName}`);
}

process.env.EXXETA_PERSISTENT_ROOM_WORKSPACE_TOOLS = "";
toolCallHandler = undefined;
registerPermissions({
	on(name: string, handler: any) {
		if (name === "tool_call") toolCallHandler = handler;
	},
} as any);
assert.ok(toolCallHandler, "permissions registered local-files all-off tool_call handler");
const localFilesAllOffReadResult = await toolCallHandler!({ toolName: "read", input: {} }, ctx);
assert.equal(localFilesAllOffReadResult?.block, true, "local-files all-off selection should block read");

process.env.EXXETA_PERSISTENT_ROOM_WORKSPACE_TOOLS = "read,bash";
toolCallHandler = undefined;
registerPermissions({
	on(name: string, handler: any) {
		if (name === "tool_call") toolCallHandler = handler;
	},
} as any);
assert.ok(toolCallHandler, "permissions registered local-files bash bundle tool_call handler");
const invalidLocalFilesBashBundleReadResult = await toolCallHandler!({ toolName: "read", input: {} }, ctx);
assert.equal(invalidLocalFilesBashBundleReadResult?.block, true, "local-files bundle containing bash should fail closed");

process.env.EXXETA_PERSISTENT_ROOM_WORKSPACE_ACCESS_MODE = "invalid";
process.env.EXXETA_PERSISTENT_ROOM_WORKSPACE_TOOLS = "read";
toolCallHandler = undefined;
registerPermissions({
	on(name: string, handler: any) {
		if (name === "tool_call") toolCallHandler = handler;
	},
} as any);
assert.ok(toolCallHandler, "permissions registered invalid local-files mode tool_call handler");
const invalidModeReadResult = await toolCallHandler!({ toolName: "read", input: {} }, ctx);
assert.equal(invalidModeReadResult?.block, true, "invalid workspace access mode should fail closed");

delete process.env.EXXETA_PERSISTENT_ROOM_SESSION;
delete process.env.EXXETA_PERSISTENT_ROOM_AGENT;
delete process.env.EXXETA_PERSISTENT_ROOM_WORKSPACE_ACCESS_MODE;
delete process.env.EXXETA_PERSISTENT_ROOM_WORKSPACE_TOOLS;
delete process.env.EXXETA_PERSISTENT_ROOM_BASH_ENABLED;
delete process.env.EXXETA_PERSISTENT_ROOM_EXECUTION_CONTEXT;

fs.rmSync(tempCwd, { recursive: true, force: true });
console.log("permissions agent-domain tests passed");
