import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-content-policy-"));
// The rule reads its settings and writes its log under EXXPERTS_STATE_HOME when
// it is set, and under the home folder when it is not; os.homedir() ignores
// HOME on Windows, so USERPROFILE too. All three point at the temp folder, so
// the machine's own settings and log are never read or written.
const ISOLATED = ["EXXPERTS_STATE_HOME", "HOME", "USERPROFILE"] as const;
const previous = ISOLATED.map((name) => process.env[name]);
for (const name of ISOLATED) process.env[name] = tempHome;

const mod = await import("./index.ts");
const registerContentPolicy = mod.default;
const { buildPolicy, scanArguments, shouldScanTool } = mod;

const policy = buildPolicy({});
assert.equal(shouldScanTool("start_handoff"), false);
assert.equal(shouldScanTool("return_handoff"), false);
assert.equal(shouldScanTool("delegate"), false);
assert.equal(shouldScanTool("read"), true);
assert.equal(shouldScanTool("artifact_write"), true);
assert.equal(shouldScanTool("mcp_filesystem_read_file"), true);
assert.equal(shouldScanTool("web_search"), true);
assert.equal(shouldScanTool("bash"), true);

assert.equal(
	scanArguments({ path: ".env" }, policy.rules)?.rule.id,
	"dot-env",
	"real filesystem/action tool arguments mentioning .env are still detected",
);

// A command that reads the environment in code names no .env file; the files keep their refusal.
const commandVerdict = (command: string) => scanArguments({ command }, policy.rules)?.rule.id;
for (const command of [
	"__import__('os').environ['TMPDIR']",
	"getattr(os, 'x').environ.get('HOME')",
	"foo().environment",
	"x[0].environ['A']",
	"cat .env.example",
	"process.env.HOME",
	"os.environ['HOME']",
]) {
	assert.equal(commandVerdict(command), undefined, `passes through: ${command}`);
}
for (const command of [
	"cat .env",
	"cat ./.env",
	'cat "/a/b/.env"',
	"cat .env.local",
	"cat .env.production",
	"cat .env-prod",
	"cat .env_prod",
	"cat .envrc",
	"source ./.envrc",
	"cat .envs",
	"cat .environment",
	"source ./.environment",
	"cat .environ",
	"cat .environment.production",
	"cat .environ-prod",
	"cat .environmental",
	"__import__('os').environ['TMPDIR'] && cat .env",
]) {
	assert.equal(commandVerdict(command), "dot-env", `still refused: ${command}`);
}

// A log written before this update holds a preview of a blocked call's arguments.
const logPath = path.join(tempHome, ".exxperts", "app", "content-policy-blocks.jsonl");
fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.writeFileSync(logPath, `${JSON.stringify({ ts: "2026-09-01T10:00:00.000Z", cwd: "/old", tool: "bash", ruleId: "dot-env", reason: "blocked .env access", argumentsPreview: "cat .env OLD-PREVIEW-TEXT" })}\n`);

let toolCallHandler: ((event: any, ctx: any) => Promise<any>) | undefined;
let notification: string | undefined;
registerContentPolicy({
	on(name: string, handler: any) {
		if (name === "tool_call") toolCallHandler = handler;
	},
} as any);

assert.ok(toolCallHandler, "content-policy registered a tool_call handler");

const ctx = {
	cwd: tempHome,
	hasUI: true,
	ui: {
		setStatus: () => undefined,
		notify: (message: string) => {
			notification = message;
		},
	},
};

const handoffResult = await toolCallHandler!({
	toolName: "start_handoff",
	input: {
		targetAgent: "target-room",
		task: "Create a deck from notes that mention .env access as a policy example.",
	},
}, ctx);
assert.equal(handoffResult, undefined, "start_handoff context mentioning .env is internal coordination text and is not blocked");

const filesystemResult = await toolCallHandler!({ toolName: "read", input: { path: ".env" } }, ctx);
assert.equal(filesystemResult?.block, true, "real filesystem/action tool arguments mentioning .env are still blocked");
assert.match(filesystemResult?.reason, /blocked \.env access/);
assert.equal(notification, undefined, "the reason is the model's; the page shows the person its own line on the step's card");

// The log keeps the tool, the rule, the time and the folder, never the arguments' text.
const rows = fs.readFileSync(logPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
assert.equal(rows.length, 2, "the old row and the new one");
assert.ok(rows.every((row) => !("argumentsPreview" in row)), "no row of the log holds a preview of the arguments");
assert.deepEqual(rows[0], { ts: "2026-09-01T10:00:00.000Z", cwd: "/old", tool: "bash", ruleId: "dot-env", reason: "blocked .env access" }, "the update strips the preview from an old row and keeps the rest");
assert.equal(rows[1].tool, "read");
assert.equal(rows[1].ruleId, "dot-env");
assert.equal(rows[1].cwd, tempHome);
assert.ok(typeof rows[1].ts === "string" && rows[1].reason === "blocked .env access");

// In a room that asks nothing the built-in rules step aside for the room's file
// tools and its command, and nowhere else; the person's own settings keep their meaning.
const configPath = path.join(tempHome, ".exxperts", "app", "content-policy.json");
const key = `sk-${"Synth3ticKey".repeat(2)}`;
function hookOf(asksNothing: (() => boolean) | undefined): (event: any, ctx: any) => Promise<any> {
	let hook: ((event: any, ctx: any) => Promise<any>) | undefined;
	mod.createContentPolicyExtension({ asksNothing })({ on: (name: string, handler: any) => { if (name === "tool_call") hook = handler; } } as any);
	return hook!;
}
async function reasons(asksNothing: (() => boolean) | undefined, calls: Array<[string, Record<string, unknown>]>): Promise<Array<string | undefined>> {
	const hook = hookOf(asksNothing);
	const out: Array<string | undefined> = [];
	for (const [toolName, input] of calls) out.push((await hook({ toolName, input }, ctx))?.reason);
	return out;
}
const yes = () => true;

assert.deepEqual([...mod.ROOM_FILE_AND_COMMAND_TOOLS].sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"]);
const hands: Array<[string, Record<string, unknown>]> = [
	["read", { path: ".env" }],
	["write", { path: "notes.txt", content: `OPENAI_API_KEY=${key}` }],
	["bash", { command: "ssh -i ~/keys/server.pem" }],
	["bash", { command: "cat ~/.ssh/id_rsa" }],
];
assert.deepEqual(await reasons(yes, hands), [undefined, undefined, undefined, undefined], "in the state the room's hands pass");
for (const [label, reader] of [["no", () => false], ["throws", () => { throw new Error("unreadable"); }], ["none", undefined]] as const) {
	assert.ok((await reasons(reader, hands)).every((reason) => typeof reason === "string"), `a reader that answers ${label}: every call is blocked`);
}
// Read at each call: the same session follows a switch.
let onAuto = false;
const sameSession = hookOf(() => onAuto);
assert.equal((await sameSession({ toolName: "read", input: { path: ".env" } }, ctx))?.block, true, "on Ask");
onAuto = true;
assert.equal(await sameSession({ toolName: "read", input: { path: ".env" } }, ctx), undefined, "back on Auto");
// Every other tool keeps every rule in the state.
for (const [toolName, input] of [["mcp", { tool: "notes_make", args: JSON.stringify({ text: key }) }], ["mcp", { args: JSON.stringify({ file: ".env" }) }], ["web_search", { query: key }], ["fetch_url", { url: `https://example.com/?k=${key}` }], ["read_file", { name: ".env" }], ["readx", { path: ".env" }]] as const) {
	assert.ok((await reasons(yes, [[toolName, input]]))[0]?.startsWith(`Content policy blocked tool '${toolName}': `), `still blocked in the state: ${toolName}`);
}
assert.equal((await reasons(yes, [["mcp", { tool: "notes_make", args: "{}" }]]))[0], undefined, "a plain connector call passes");

// The person's own rule applies in the state too, for a file tool and a command.
fs.writeFileSync(configPath, JSON.stringify({ rules: [{ id: "launch-codes", pattern: "launch-codes" }] }));
assert.deepEqual(await reasons(yes, [["read", { path: "launch-codes.txt" }], ["bash", { command: "cat launch-codes.txt" }], ["read", { path: "notes.txt" }]]), [
	"Content policy blocked tool 'read': blocked by local content policy. Do not try this file or value again another way; other files you are allowed to use are fine. Explain the constraint to the user and ask for a safe alternative.",
	"Content policy blocked tool 'bash': blocked by local content policy. Do not try this file or value again another way; other files you are allowed to use are fine. Explain the constraint to the user and ask for a safe alternative.",
	undefined,
]);
// A rule switched off stays off, in the state and out of it; its neighbour still blocks a connector call.
fs.writeFileSync(configPath, JSON.stringify({ disabledRuleIds: ["openai-key", "launch-codes"], rules: [{ id: "launch-codes", pattern: "launch-codes", enabled: false }] }));
for (const reader of [yes, () => false]) {
	assert.deepEqual(await reasons(reader, [["mcp", { args: JSON.stringify({ text: key }) }], ["read", { path: "launch-codes.txt" }]]), [undefined, undefined]);
	assert.match((await reasons(reader, [["mcp", { args: JSON.stringify({ file: ".env" }) }]]))[0] ?? "", /blocked \.env access/);
}
// The check switched off stays off everywhere.
fs.writeFileSync(configPath, JSON.stringify({ enabled: false }));
for (const reader of [yes, () => false]) {
	assert.deepEqual(await reasons(reader, [["mcp", { args: JSON.stringify({ text: key }) }], ["read", { path: ".env" }]]), [undefined, undefined]);
}
fs.rmSync(configPath, { force: true });

ISOLATED.forEach((name, i) => {
	if (previous[i] === undefined) delete process.env[name];
	else process.env[name] = previous[i];
});
fs.rmSync(tempHome, { recursive: true, force: true });
console.log("content-policy coordination-tool tests passed");
