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
assert.match(notification || "", /blocked \.env access/);

if (previousHome === undefined) delete process.env.HOME;
else process.env.HOME = previousHome;
if (previousUserProfile === undefined) delete process.env.USERPROFILE;
else process.env.USERPROFILE = previousUserProfile;
fs.rmSync(tempHome, { recursive: true, force: true });
console.log("content-policy coordination-tool tests passed");
