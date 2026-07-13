// Visuals V2 smoke (contract spec §5): the delegate_task tool's gate order
// (validate → cap → approval → launch), the approval text's write-grant
// wording, the L2 specialist index, and the permission-policy baseline —
// the read_skill field bug (skills MR-5) must not repeat for delegate_task.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-delegate-task-"));
const tempHome = path.join(tempRoot, "home");
fs.mkdirSync(tempHome, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const delegate = await import("../src/persistent-room-delegate-tool.js");
const templates = await import("../src/specialist-templates.js");

// ── 1. L2 specialist index ───────────────────────────────────────────────────
{
	const section = delegate.buildSpecialistTemplatesIndexSection();
	assert(section.includes("## Visual specialists"), "index must have its section header");
	for (const template of templates.listSpecialistTemplates()) {
		assert(section.includes(`- ${template.doctrineLine}`), `index must list template ${template.id}`);
	}
	assert(section.includes("must approve"), "index must state the approval requirement");
	assert(section.includes("no memory"), "index must state the no-memory posture");
	assert(delegate.buildSpecialistTemplatesIndexSection([]).length === 0, "empty registry must render nothing");
}

// ── 2. Tool gate order ───────────────────────────────────────────────────────
type Launched = { taskFolder: string; templateId: string };
function makeTool(input: { running?: number; confirmResult?: boolean; launchOk?: boolean }) {
	const calls = { confirms: [] as Array<{ title: string; detail: string }>, launches: [] as Launched[] };
	let taskCounter = 0;
	const tool = delegate.createDelegateTaskTool({
		agentId: "room-1",
		taskCap: 2,
		runningCount: () => input.running ?? 0,
		generateTaskId: () => `tsk-smoke${++taskCounter}`,
		launch: (plan: any) => {
			calls.launches.push({ taskFolder: plan.taskFolder, templateId: plan.template.id });
			return input.launchOk === false ? { ok: false as const, reason: "smoke launch refused" } : { ok: true as const };
		},
	});
	const ctx = {
		hasUI: true,
		ui: {
			async confirm(title: string, detail: string) {
				calls.confirms.push({ title, detail });
				return input.confirmResult ?? true;
			},
		},
	};
	return { tool, ctx, calls };
}

{
	// Unknown template refuses BEFORE any approval prompt.
	const { tool, ctx, calls } = makeTool({});
	const result = await tool.execute("1", { template: "nope", brief: "x" }, undefined, undefined, ctx);
	assert(String(result.content[0].text).includes("not a specialist template"), "unknown template must refuse");
	assert(calls.confirms.length === 0 && calls.launches.length === 0, "unknown template must not prompt or launch");
}
{
	// Invalid brief refuses BEFORE any approval prompt.
	const { tool, ctx, calls } = makeTool({});
	const result = await tool.execute("1", { template: "deck", brief: "   " }, undefined, undefined, ctx);
	assert(result.details?.outcome === "invalid", "empty brief must refuse as invalid");
	assert(calls.confirms.length === 0 && calls.launches.length === 0, "invalid input must not prompt or launch");
}
{
	// Cap reached refuses without prompting.
	const { tool, ctx, calls } = makeTool({ running: 2 });
	const result = await tool.execute("1", { template: "deck", brief: "Make slides about X." }, undefined, undefined, ctx);
	assert(result.details?.outcome === "cap-reached", "cap must refuse");
	assert(calls.confirms.length === 0 && calls.launches.length === 0, "cap refusal must not prompt or launch");
}
{
	// No UI = structural refusal (background/CLI contexts stay delegation-free).
	const { tool, calls } = makeTool({});
	const result = await tool.execute("1", { template: "deck", brief: "Make slides about X." }, undefined, undefined, { hasUI: false });
	assert(result.details?.outcome === "no-ui", "headless context must refuse");
	assert(calls.launches.length === 0, "headless refusal must not launch");
}
{
	// Decline path: prompted once, never launched.
	const { tool, ctx, calls } = makeTool({ confirmResult: false });
	const result = await tool.execute("1", { template: "deck", brief: "Make slides about X." }, undefined, undefined, ctx);
	assert(result.details?.outcome === "declined", "declined approval must refuse");
	assert(calls.confirms.length === 1 && calls.launches.length === 0, "decline must prompt exactly once and never launch");
}
{
	// Approve path: the approval text names the exact write-grant folder; launch
	// receives a plan confined to that folder.
	const { tool, ctx, calls } = makeTool({});
	const result = await tool.execute("1", { template: "diagram-svg", brief: "Draw the architecture." }, undefined, undefined, ctx);
	assert(result.details?.outcome === "started", `approved delegation must start: ${JSON.stringify(result.details)}`);
	assert(calls.confirms.length === 1 && calls.launches.length === 1, "approve must prompt once and launch once");
	const detail = calls.confirms[0].detail;
	const launched = calls.launches[0];
	assert(launched.taskFolder.startsWith("tasks/tsk-smoke"), `launched plan must target a task folder, got ${launched.taskFolder}`);
	// The client parses the title to build the family chip ("Slide deck
	// specialist") — pin the format so copy edits cannot silently break it.
	assert(/^Have a specialist create (a|an) .+\?$/.test(calls.confirms[0].title), `approval title must keep the parseable question shape; got "${calls.confirms[0].title}"`);
	assert(detail.includes(`${launched.taskFolder}/`), "approval text must name the exact task folder being granted");
	assert(detail.includes("write access"), "approval text must say it grants write access");
	assert(detail.includes("no memory access, no web access"), "approval text must state the isolation posture");
	// Anti-spoof separator (hardening pass): the model-written brief must be
	// labelled as such, and every app-drawn fact must come BEFORE it — a brief
	// mimicking those lines can then never read as the app speaking.
	const separatorAt = detail.indexOf("written by the room's model");
	assert(separatorAt >= 0, "approval text must label the model-written brief");
	assert(detail.indexOf("Draw the architecture.") > separatorAt, "the brief must appear only after the separator");
	assert(detail.lastIndexOf("write access") < separatorAt, "all app-drawn fact lines must precede the separator");
	assert(String(result.content[0].text).includes(launched.taskFolder.split("/")[1]), "tool result must name the taskId");
}
{
	// Launch refusal surfaces to the model as a refusal, not a success.
	const { tool, ctx } = makeTool({ launchOk: false });
	const result = await tool.execute("1", { template: "deck", brief: "Make slides about X." }, undefined, undefined, ctx);
	assert(result.details?.outcome === "launch-failed", "failed launch must refuse");
}
{
	// Traversal-shaped inputArtifacts refuse before approval.
	const { tool, ctx, calls } = makeTool({});
	const result = await tool.execute("1", { template: "deck", brief: "x".repeat(10), inputArtifacts: ["tasks/../../secret.md"] }, undefined, undefined, ctx);
	assert(result.details?.outcome === "invalid", "traversal inputArtifacts must refuse as invalid");
	assert(calls.confirms.length === 0, "traversal refusal must not prompt");
}
{
	// Preview truncation must never hide the input-artifacts list: those paths
	// are the read grant under review. A brief long enough to hit the 1,200-char
	// clip still shows every artifact path (after the truncation marker).
	const { tool, ctx, calls } = makeTool({});
	const longBrief = `Make slides. ${"padding words ".repeat(200)}`;
	const result = await tool.execute("1", { template: "deck", brief: longBrief, inputArtifacts: ["tasks/tsk-prior/deck.html", "tasks/tsk-prior/notes.md"] }, undefined, undefined, ctx);
	assert(result.details?.outcome === "started", "long-brief delegation must still start");
	const detail = calls.confirms[0].detail;
	assert(detail.includes("[brief preview truncated]"), "an over-length brief must be visibly truncated");
	assert(detail.includes("tasks/tsk-prior/deck.html") && assertVisibleAfterTruncation(detail, "tasks/tsk-prior/notes.md"), "every input-artifact path must survive the truncation");
	function assertVisibleAfterTruncation(text: string, needle: string): boolean {
		return text.indexOf(needle) > text.indexOf("[brief preview truncated]");
	}
}

// ── 3. Permission-policy baseline (the read_skill lesson) ───────────────────
{
	const permissions = await import("../../../pi-package/extensions/permissions/index.js");
	let toolCallHandler: ((event: { toolName: string }) => Promise<any> | any) | undefined;
	const fakePi = { on(event: string, handler: any) { if (event === "tool_call") toolCallHandler = handler; } };
	(permissions as any).default(fakePi);
	assert(toolCallHandler, "permissions extension must register a tool_call handler");
	const allowed = await toolCallHandler({ toolName: "delegate_task" });
	assert(allowed === undefined, "delegate_task must pass the permission-policy baseline (read_skill field-bug regression guard)");
	const blocked = await toolCallHandler({ toolName: "bash" });
	assert(blocked?.block === true, "bash must remain blocked at the baseline");
}

console.log("delegate task smoke passed");
