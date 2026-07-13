import { Type } from "typebox";
import type { ToolDefinition } from "@exxeta/exxperts-runtime";
import {
	buildSpecialistSessionPlan,
	type SpecialistSessionPlan,
} from "./persistent-room-specialist-execution.js";
import {
	listSpecialistTemplates,
	getSpecialistTemplate,
	SPECIALIST_TASK_CAPS,
	type SpecialistTemplate,
} from "./specialist-templates.js";

/**
 * Visuals V2 room wiring (contract spec §5): the L2 specialist-templates index
 * and the model-proposed `delegate_task` tool.
 *
 * Governance shape (do not weaken):
 * - `delegate_task` never spawns anything by itself. It validates against the
 *   static template registry, then asks the USER through the interactive
 *   approval bridge; the approval text names the exact task-private folder the
 *   specialist may write, because approving IS the write grant (artifacts
 *   extension pre-approved scope, V1). No UI → structural refusal, which keeps
 *   background/CLI contexts delegation-free without a separate gate.
 * - The launch itself is injected by the connection (run-free beside the
 *   room's turn); this module never touches sessions, sockets, or the store.
 */

export const DELEGATE_TASK_TOOL_NAME = "delegate_task";

/**
 * The L2 specialist-templates index: static registry, so unlike the skills
 * index it carries no user-authored text and needs no defang. Rendered for
 * every web room (v1) — templates are a platform capability, not a setting.
 */
export function buildSpecialistTemplatesIndexSection(templates: readonly SpecialistTemplate[] = listSpecialistTemplates()): string {
	if (templates.length === 0) return "";
	const lines = templates.map((template) => `- ${template.doctrineLine}`);
	return `

## Visual specialists

You can propose delegating visual work to an ephemeral specialist with the delegate_task tool. The user must approve each delegation; approval spawns the specialist and grants it write access to one new task-private artifact folder. Specialists have no memory, no web access, and no knowledge of this conversation beyond the brief you write — put ALL needed data in the brief (or reference prior task artifacts via inputArtifacts). Results appear on a task card beside the chat, not in this conversation; never claim, invent, or wait for a specialist's results in your reply. Available templates:

${lines.join("\n")}`;
}

const delegateTaskSchema = Type.Object({
	template: Type.String({ description: "Template id from the visual-specialists list (e.g. deck, diagram-svg, chart-html, document-html)." }),
	brief: Type.String({ description: "Complete standalone working brief for the specialist, including all data it needs. It cannot see this conversation and cannot fetch anything." }),
	expectedResult: Type.Optional(Type.String({ description: "One or two sentences describing the artifact(s) the user expects." })),
	inputArtifacts: Type.Optional(Type.Array(Type.String(), { description: "Store-relative paths of prior task artifacts to build on (e.g. tasks/tsk-abc123/deck.html)." })),
});

type TextToolResult = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> | undefined; isError?: boolean };

function refusal(text: string, details?: Record<string, unknown>): TextToolResult {
	return { content: [{ type: "text", text }], details };
}

export interface CreateDelegateTaskToolOptions {
	agentId: string;
	/** Concurrent-specialist ceiling (contract D9: 2). */
	taskCap: number;
	runningCount: () => number;
	generateTaskId: () => string;
	/**
	 * Fire-and-forget launch injected by the connection: registers the slot,
	 * emits `task_started`, and runs the worker beside the live thread. Must not
	 * throw; a refused launch returns a reason for the model.
	 */
	launch: (plan: SpecialistSessionPlan) => { ok: true } | { ok: false; reason: string };
}

export function createDelegateTaskTool(options: CreateDelegateTaskToolOptions): ToolDefinition<any, any> {
	const { taskCap, runningCount, generateTaskId, launch } = options;
	return {
		name: DELEGATE_TASK_TOOL_NAME,
		label: "delegate visual task",
		description:
			"Propose delegating a visual artifact (deck, diagram, chart, document) to an ephemeral specialist. The user must approve; approval spawns the specialist with write access to one new task-private folder. Results appear on a task card, never in this conversation.",
		promptSnippet: "Propose a user-approved visual-specialist delegation",
		parameters: delegateTaskSchema,
		execute: async (_toolCallId: string, params: { template: string; brief: string; expectedResult?: string; inputArtifacts?: string[] }, _signal: unknown, _onUpdate: unknown, ctx: any): Promise<TextToolResult> => {
			const templateId = String(params?.template ?? "").trim();
			const template = getSpecialistTemplate(templateId);
			if (!template) {
				const known = listSpecialistTemplates().map((t) => t.id).join(", ");
				return refusal(`"${templateId}" is not a specialist template. Available templates: ${known}.`, { outcome: "unknown-template" });
			}
			if (runningCount() >= taskCap) {
				return refusal(`The specialist limit (${taskCap} at a time) is reached. Wait for a running task to finish or ask the user to stop one.`, { outcome: "cap-reached" });
			}
			// Validation happens BEFORE the approval prompt: the user is never asked
			// to approve something that could not run.
			let plan: SpecialistSessionPlan;
			try {
				plan = buildSpecialistSessionPlan({
					taskId: generateTaskId(),
					templateId,
					brief: String(params?.brief ?? ""),
					...(params?.expectedResult ? { expectedResult: String(params.expectedResult) } : {}),
					...(Array.isArray(params?.inputArtifacts) ? { inputArtifacts: params.inputArtifacts.map(String) } : {}),
				});
			} catch (e) {
				return refusal(`Delegation not possible: ${(e as Error).message}`, { outcome: "invalid" });
			}
			if (!ctx?.hasUI) {
				return refusal("Delegation requires the interactive room UI; there is no user here to approve it.", { outcome: "no-ui" });
			}
			// Truncate only the brief text, never the input-artifacts list: those
			// paths are the read grant under review, so they must stay visible no
			// matter how long the model's brief runs.
			const artifactsAt = plan.triggerPrompt.indexOf("\nInput artifacts (");
			const briefHead = artifactsAt >= 0 ? plan.triggerPrompt.slice(0, artifactsAt) : plan.triggerPrompt;
			const artifactsTail = artifactsAt >= 0 ? plan.triggerPrompt.slice(artifactsAt) : "";
			const clippedHead = briefHead.length > 1_200 ? `${briefHead.slice(0, 1_200)}\n[brief preview truncated]` : briefHead;
			const briefPreview = `${clippedHead}${artifactsTail}`;
			// The approval question is the consent: action-first, no jargon. The
			// mechanics (isolation, folder grant, brief) live behind the client's
			// Show details.
			const noun = /^[A-Z]{2,}/.test(template.label) ? template.label : template.label.charAt(0).toLowerCase() + template.label.slice(1);
			const article = /^(svg|html|[aeiou])/i.test(noun) ? "an" : "a";
			const approved = await ctx.ui.confirm(
				`Have a specialist create ${article} ${noun}?`,
				[
					// The guidance the client shows behind "Details": three short
					// paragraphs (isolation, grant, lifecycle), no redundancy. The
					// consent anchors the smoke pins live here, before the separator.
					"A separate specialist runs this task in isolation: no memory access, no web access, no shell.",
					"",
					`It can only write into one new folder made for this task: ${plan.taskFolder}/ (at most ${SPECIALIST_TASK_CAPS.maxArtifacts} files). Approving starts it and grants that folder write access.`,
					"",
					"The result lands on a task card. Keep it by adding it to the conversation or saving it to your workspace.",
					"",
					// Anti-spoof separator: everything below is the room model's own text
					// appended after the app-drawn facts above; a brief that mimics those
					// fact lines must not be able to pass as the app speaking.
					"─── Brief it will receive (written by the room's model; the app has not verified anything below this line) ───",
					briefPreview,
				].join("\n"),
			);
			if (!approved) {
				return refusal("The user declined the specialist. Do not propose it again unless they ask. If they still want the content, offer to work it out directly in the conversation instead.", { outcome: "declined" });
			}
			const started = launch(plan);
			if (!started.ok) {
				return refusal(`The specialist could not start: ${started.reason}`, { outcome: "launch-failed" });
			}
			return {
				content: [{
					type: "text",
					text: `Specialist started (task ${plan.taskId}, template ${template.id}). The user sees a live task card; artifacts will appear there when ready. Tell the user it is underway — do not describe, invent, or wait for its results.`,
				}],
				details: { outcome: "started", taskId: plan.taskId, template: template.id },
			};
		},
	};
}
