import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-content-policy-"));
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
process.env.HOME = tempHome;
// os.homedir() ignores HOME on Windows; USERPROFILE keeps the test isolated there too.
process.env.USERPROFILE = tempHome;

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

if (previousHome === undefined) delete process.env.HOME;
else process.env.HOME = previousHome;
if (previousUserProfile === undefined) delete process.env.USERPROFILE;
else process.env.USERPROFILE = previousUserProfile;
fs.rmSync(tempHome, { recursive: true, force: true });
console.log("content-policy coordination-tool tests passed");
