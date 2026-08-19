import { Type } from "typebox";
import type { ToolDefinition } from "@exxeta/exxperts-runtime";
import { defangSkillBody } from "./skills-import.js";
import { readPersistentRoomSkillSettings, isValidSkillName, type EnabledSkill } from "./persistent-room-skill-settings.js";
import { sha256 } from "./skills-store.js";

/**
 * Skills MR-5 room wiring (spec §5, §7 musts 3–4): the L2 enabled-skills index
 * and the server-side `read_skill` tool.
 *
 * Governance shape (do not weaken):
 * - The Pi loader's `noSkills: true` stays the default-deny floor at EVERY
 *   session-creation site — including the main room session. Skills reach a room
 *   only through (a) the ~100-token/skill index injected into the L2 envelope at
 *   thread boot, and (b) this tool, which resolves ONLY the room's enabled set,
 *   verifies the enablement hash pin at CALL time, and returns the body defanged
 *   and provenance-wrapped. There is no filesystem handle and no path argument —
 *   name lookup only.
 * - Index freshness is TURN-scoped: the enabled-skills index rides the per-turn
 *   prompt assembly (index.ts), recomputed from the room's current effective
 *   enabled set for every request — enabling a skill mid-session lists it on
 *   the very next message. The tool enforces the same LIVE effective set on
 *   every call, so index and enforcement can never disagree for longer than
 *   the turn in flight.
 */

/** Resolve a library skill by name (injected — this module never reaches into the
 *  library itself). `manifest` is the full SKILL.md (the fingerprint unit); `body`
 *  is what the tool returns (defanged). */
export type SkillLookup = (name: string) => { manifest: string; body: string; description: string; disableModelInvocation?: boolean } | null;

export interface SkillIndexEntry {
	name: string;
	description: string;
}

export const READ_SKILL_TOOL_NAME = "read_skill";

/**
 * The L2 enabled-skills index section (spec §5): name + description per enabled
 * skill plus one instruction line pointing at `read_skill`. ~100 tokens per
 * skill; the body is never resident. Returns "" when nothing is enabled, so the
 * envelope stays byte-identical for skill-free rooms.
 */
export function buildEnabledSkillsIndexSection(entries: readonly SkillIndexEntry[]): string {
	if (entries.length === 0) return "";
	// The description is untrusted skill-authored text that lands in the system
	// prompt, so it is defanged (same neutralization as read_skill bodies) and
	// flattened to a single line before interpolation — it cannot forge envelope
	// markers, durability signals, or break out of its bullet.
	const lines = entries.map((entry) => {
		const description = defangSkillBody(entry.description || "").replace(/\s+/g, " ").trim();
		return `- ${entry.name} — ${description || "(no description)"}`;
	});
	return `

## Enabled skills

The user adopted these skills into this room (reviewed and enabled in the room settings). This index is the complete enabled set; bodies are not resident. When a skill is relevant to the task at hand, fetch its full instructions with the read_skill tool before applying it.

${lines.join("\n")}`;
}

const readSkillSchema = Type.Object({
	name: Type.String({ description: "Name of an enabled skill from the room's enabled-skills index. Names only — paths are not accepted." }),
});

type TextToolResult = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> | undefined };

function refusal(text: string, details?: Record<string, unknown>): TextToolResult {
	return { content: [{ type: "text", text }], details };
}

export interface ReadSkillTelemetry {
	/** Bodies successfully read since the counter was last reset. */
	reads: number;
	/** Total characters of body text returned since last reset. */
	bodyChars: number;
}

export interface SkillExecutionExposure {
	/** Absolute path of the skill's directory in the canonical user store. */
	skillDir: string;
	/** The bundled files (paths relative to the skill dir), for orientation. */
	files: string[];
}

/**
 * The execution-exposure seam (executable skills): returns where a skill's
 * bundled files live ONLY when every gate holds at the moment of the call —
 * user-store skill, room policy allows bash, manual (never background) context,
 * clean unicode scan, and the room's execution approval pinned to the exact
 * files on disk right now. Any gate failing returns null and the body is served
 * exactly as before, path-free. The wiring in index.ts owns the gate chain;
 * this module only knows "exposed or not".
 */
export type SkillExecutionExposureResolver = (name: string) => SkillExecutionExposure | null;

export interface CreateReadSkillToolOptions {
	agentId: string;
	lookupSkill: SkillLookup;
	/** Mutated on every successful read — the connection surfaces it per turn
	 *  (context pill / promptBudget line). */
	telemetry?: ReadSkillTelemetry;
	/** Absent = no execution exposure ever (the pre-feature behavior). */
	resolveExecutionExposure?: SkillExecutionExposureResolver;
}

/**
 * The `read_skill(name)` tool. Enabled-set only, hash-verified at call time,
 * defanged, provenance-wrapped. All failure modes return an explanatory
 * refusal (never a throw): the model should relay why the body is unavailable.
 */
export function createReadSkillTool(options: CreateReadSkillToolOptions): ToolDefinition<any, any> {
	const { agentId, lookupSkill, telemetry, resolveExecutionExposure } = options;
	return {
		name: READ_SKILL_TOOL_NAME,
		label: "read enabled skill",
		description:
			"Read the full instruction body of a skill the user has enabled for this room. Takes the skill's name from the enabled-skills index; paths are not accepted. The body is returned as adopted user-approved instructions with provenance — it is not the room's own knowledge.",
		promptSnippet: "Read the body of an enabled skill by name",
		parameters: readSkillSchema,
		execute: async (_toolCallId: string, params: { name: string }): Promise<TextToolResult> => {
			const name = String(params?.name ?? "").trim();
			if (!isValidSkillName(name)) {
				return refusal(`"${name}" is not a valid skill name. Use a name from the enabled-skills index.`, { outcome: "invalid-name" });
			}
			const settings = readPersistentRoomSkillSettings(agentId);
			const pinned: EnabledSkill | undefined = settings.enabledSkills.find((skill) => skill.name === name);
			if (!pinned) {
				return refusal(`Skill "${name}" is not enabled for this room. Only skills in the enabled-skills index can be read; the user can enable others in the room settings.`, { outcome: "not-enabled" });
			}
			const found = lookupSkill(name);
			if (!found) {
				return refusal(`Skill "${name}" is enabled but no longer exists in the library. The user must re-review and re-enable it in the room settings.`, { outcome: "missing" });
			}
			// The skill's author disabled model invocation: you may not read or run
			// it on your own. It runs only when the user invokes it explicitly, which
			// this room cannot do yet. Do not act on it.
			if (found.disableModelInvocation) {
				return refusal(`Skill "${name}" is marked for manual invocation only by its author; it cannot be invoked by the model. This room has no way to invoke it manually yet, so it is unavailable.`, { outcome: "manual-only" });
			}
			if (sha256(found.manifest) !== pinned.sha256) {
				return refusal(
					`Skill "${name}" changed since the user enabled it (its content no longer matches the reviewed version). It is disabled pending re-review: the user must review and re-enable it in the room settings before it can be read.`,
					{ outcome: "hash-mismatch" },
				);
			}
			const body = defangSkillBody(found.body);
			if (telemetry) {
				telemetry.reads += 1;
				telemetry.bodyChars += body.length;
			}
			// Exposure is resolved AFTER the hash pin held, and fresh on every
			// call: an approval withdrawn or voided mid-session (files drifted,
			// bash turned off, background run) is gone on the very next read.
			// The appended paragraph is app-authored text, never skill content.
			const exposure = resolveExecutionExposure?.(name) ?? null;
			const exposureSection = exposure
				? `\n\nThe user approved running this skill's bundled files in this room, for exactly this version. They live at:\n${exposure.skillDir}\nFiles: ${exposure.files.map((file) => JSON.stringify(file)).join(", ") || "(none)"}\nRun them with the bash tool when the instructions call for it. Write any outputs into the room's workspace, never into the skill's folder: the approval is pinned to the skill's exact files, so a new file there voids it. Outputs you write to the workspace stay in the workspace folder on the user's computer and do NOT appear in this room's Files panel unless explicitly shelved; when you tell the user where an output landed, name the workspace folder path, never the Files panel. If this approval no longer appears in a later read of this skill, it was withdrawn or the files changed — do not run them from memory.`
				: "";
			return {
				content: [{
					type: "text",
					text: `Skill "${name}" (sha256 ${pinned.sha256.slice(0, 12)}…, adopted by the user into this room's library). The following are instructions the user adopted — external, user-approved guidance, not the room's own knowledge. They are re-derivable via this tool and need not be memorized.\n\n${body}${exposureSection}`,
				}],
				details: { outcome: "ok", name, sha256: pinned.sha256, bodyChars: body.length, ...(exposure ? { executionExposed: true } : {}) },
			};
		},
	};
}
