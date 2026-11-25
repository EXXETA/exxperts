import { Type } from "typebox";
import type { ToolDefinition } from "@exxeta/exxperts-runtime";
import { defangSkillBody } from "./skills-import.js";
import { readPersistentRoomSkillSettings, isValidSkillName, roomSkillState, type EnabledSkill } from "./persistent-room-skill-settings.js";
import { countSkillFiles, sha256 } from "./skills-store.js";
import { librarySkillFolderView, resolveLibrarySkillManifest, roomSkillFolders, roomSkillInRoom, skillPathFitsText } from "./skills-executable.js";
import { WINDOWS_SKILL_READ_ONLY_LINE, WINDOWS_SKILL_RUN_LINE } from "./room-box/windows/model-lines.js";
import { ASK_FOR_FOLDER_TOOL_NAME } from "./room-box/card-text.js";
import { roomFence } from "./room-files.js";
import type { PersistentRoomEffectiveWorkspacePolicy } from "./persistent-room-workspace-policy.js";

/**
 * Skills MR-5 room wiring (spec §5, §7 musts 3–4): the L2 enabled-skills index
 * and the server-side `read_skill` tool.
 *
 * Governance shape (do not weaken):
 * - The Pi loader's `noSkills: true` stays the default-deny floor at EVERY
 *   session-creation site — including the main room session. Skills reach a room
 *   only through (a) the ~100-token/skill index injected into the L2 envelope at
 *   thread boot, and (b) this tool, which resolves ONLY the room's enabled set at
 *   CALL time, and returns the current body defanged and provenance-wrapped.
 *   There is no filesystem handle and no path argument: name lookup only.
 * - Index freshness is TURN-scoped: the enabled-skills index rides the per-turn
 *   prompt assembly (room-socket.ts), recomputed from the room's current effective
 *   enabled set for every request — enabling a skill mid-session lists it on
 *   the very next message. The tool enforces the same LIVE effective set on
 *   every call, so index and enforcement can never disagree for longer than
 *   the turn in flight.
 */

/** Resolve a library skill by name (injected — this module never reaches into the
 *  library itself). `manifest` is the full SKILL.md (its hash names the version served); `body`
 *  is what the tool returns (defanged); `identity` is the one it was added with
 *  (absent or null for none). `{ unreadable: true }` is a read that failed; null,
 *  no skill of that name. */
export type SkillLookup = (name: string) => { manifest: string; body: string; description: string; disableModelInvocation?: boolean; identity?: string | null } | { unreadable: true } | null;

export interface SkillIndexEntry {
	name: string;
	description: string;
	/** Its SKILL.md as the library holds it now: its line names the version (`skillVersionMark`). */
	manifest?: string;
}

/**
 * A skill's version as the room's index and read_skill name it: the start of its
 * SKILL.md's hash. Instructions a conversation has read change only with it; its
 * files are read afresh at each use, so they need no mark.
 */
export function skillVersionMark(manifest: string): string {
	return sha256(manifest).slice(0, 12);
}

export const READ_SKILL_TOOL_NAME = "read_skill";

/** The most characters of a skill's instructions the assistant is given, by `read_skill` or with a message that picks it (skill-pick.ts), before its folder is filled in (`withSkillFolder`): as much as a waiting message may hold. */
export const SKILL_INSTRUCTIONS_MAX_CHARS = 100_000;

/** A skill's instructions as a room may be given them, or why not. `byHand`: its author marked it to start only when the person picks it. */
export type RoomSkillLoad =
	| { outcome: "ok"; body: string; manifest: string; byHand: boolean }
	| { outcome: "not-enabled" }
	| { outcome: "unreadable" }
	| { outcome: "too-big"; byHand: boolean };

/**
 * The one loader of a skill's instructions for a room, at the moment of the
 * call: on in the room now (`roomSkillState`), read from the library's own
 * copy (`found`, the lookup's answer for the name), defanged, and within
 * `SKILL_INSTRUCTIONS_MAX_CHARS`. `read_skill` and a message that picks the
 * skill both load through here; who may use a by-hand skill is theirs to say.
 */
export function loadRoomSkill(agentId: string, name: string, found: ReturnType<SkillLookup>): RoomSkillLoad {
	const entry: EnabledSkill | undefined = readPersistentRoomSkillSettings(agentId).enabledSkills.find((skill) => skill.name === name);
	const state = entry ? roomSkillState(entry, found) : "gone";
	// A skill deleted from the library has left the room, even when one was added again under its name.
	if (!entry || state === "gone") return { outcome: "not-enabled" };
	if (state === "unreadable" || !found || "unreadable" in found) return { outcome: "unreadable" };
	const byHand = found.disableModelInvocation === true;
	const body = defangSkillBody(found.body);
	if (body.length > SKILL_INSTRUCTIONS_MAX_CHARS) return { outcome: "too-big", byHand };
	return { outcome: "ok", body, manifest: found.manifest, byHand };
}

/** What a room can do with a skill's files now: read them and run its scripts, read them only, or neither. */
export type SkillFilesReach = "run" | "read" | "none";

/**
 * What a room can do with its skills' files, from its effective policy as the
 * live conversation has it, so a folder that can't be found or commands that
 * can't run on this computer count as they do there, and from the file fence's
 * own judgement of the room's folder (`roomFence`). A shared server opens no
 * skill's folder. The model's text and the Skills page's line both read this.
 */
export function skillFilesReach(policy: Pick<PersistentRoomEffectiveWorkspacePolicy, "policy" | "source" | "workspaceAccessMode" | "workspaceToolsEnabled" | "allowedToolNames" | "bashEnabled"> | null, sharedServer: boolean): SkillFilesReach {
	if (!policy || sharedServer || policy.source === "room-files") return "none";
	// A folder the fence won't open (moved, replaced, or one no room may use) opens nothing, as the file tools find.
	if (!policy.policy || !roomFence(policy.policy, () => []).room) return "none";
	if (policy.workspaceAccessMode === "localFiles" && policy.bashEnabled) return "run";
	return policy.workspaceToolsEnabled && policy.allowedToolNames.includes("read") ? "read" : "none";
}

/**
 * What the assistant is told of a skill's files beside its SKILL.md: where they
 * are, in a room that can open them (`reach`); where its way enters the room's
 * own folders ("in-room"), which the room opens and runs from by its own rights
 * and lists itself; how many there are, in one that can't, and whether the
 * person can change that from the computer
 * (`personCanOpen`); or that no room opens them, for a skill outside the
 * person's own library. A skill with SKILL.md alone has none.
 */
export type SkillFilesView =
	| { kind: "open"; reach: "run" | "read"; skillDir: string; files: string[]; windowsRuns?: boolean }
	| { kind: "in-room"; reach: "run" | "read"; place: string }
	| { kind: "closed"; count: number; personCanOpen: boolean }
	| { kind: "instructions-only"; count: number };

/** Past this many files, a skill no room opens is said to have more than this, and its files are counted no further. */
const SKILL_FILES_COUNTED_MAX = 2_000;

/**
 * What a skill on in the room has of its files, given what the room can do
 * with them now (`reach`): one whose folder rooms open (`roomSkillFolders`: the
 * person's own, or a shared-folder skill at its real folder) its folder, or its
 * count where this room can't open it; a shared-folder skill whose way enters
 * the room's own folders (`roomSkillInRoom`) where it does, unlisted, since
 * the room opens it by its own rights; any other its
 * count, since no room opens it, counted only to one past
 * `SKILL_FILES_COUNTED_MAX`. Null for a
 * skill with SKILL.md alone. `personCanOpen`: the person can give the room a
 * folder and Commands, as on the desktop.
 */
export function roomSkillFilesView(roomId: string, name: string, reach: SkillFilesReach, personCanOpen: boolean): SkillFilesView | null {
	const folder = roomSkillFolders(roomId).find((skill) => skill.name === name);
	if (folder) {
		if (folder.files.length === 0) return null;
		return reach === "none" ? { kind: "closed", count: folder.files.length, personCanOpen } : { kind: "open", reach, skillDir: folder.skillDir, files: folder.files };
	}
	if (reach !== "none") {
		const inRoom = roomSkillInRoom(roomId, name);
		if (inRoom !== undefined) return { kind: "in-room", reach, place: inRoom };
	}
	const opened = librarySkillFolderView(name).folder;
	if (opened) return opened.files.length === 0 ? null : { kind: "closed", count: opened.files.length, personCanOpen: false };
	const skill = resolveLibrarySkillManifest(name);
	const count = skill ? countSkillFiles(skill.folder, SKILL_FILES_COUNTED_MAX) : null;
	return count ? { kind: "instructions-only", count } : null;
}

/** The most files listed by name, and the most characters a list of them takes, before the list gives the folder's top instead. */
const SKILL_FILES_LISTED_MAX = 100;
const SKILL_FILES_LIST_MAX_CHARS = 2_000;
/** The most entries of the folder's top that summary names. */
const SKILL_TOP_ENTRIES_MAX = 40;

/**
 * A skill's files as the assistant reads them: every name when they are few and
 * short; otherwise their count and the folder's top, each folder with how many
 * files it holds, cut at a bound, so a skill of hundreds of files costs no more
 * than a small one. The ls tool lists the rest.
 */
function skillFilesListing(files: readonly string[]): string {
	const quoted = files.map((file) => JSON.stringify(file));
	const whole = quoted.join(", ");
	if (files.length <= SKILL_FILES_LISTED_MAX && whole.length <= SKILL_FILES_LIST_MAX_CHARS) return `Files: ${whole}`;
	const top = new Map<string, number>();
	for (const file of files) {
		const slash = file.indexOf("/");
		const entry = slash === -1 ? file : `${file.slice(0, slash)}/`;
		top.set(entry, (top.get(entry) ?? 0) + 1);
	}
	const entries = [...top.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	const shown: string[] = [];
	let chars = 0;
	for (const entry of entries) {
		const count = top.get(entry)!;
		const line = entry.endsWith("/") ? `${JSON.stringify(entry)} (${count} ${count === 1 ? "file" : "files"})` : JSON.stringify(entry);
		if (shown.length === SKILL_TOP_ENTRIES_MAX || chars + line.length > SKILL_FILES_LIST_MAX_CHARS) break;
		shown.push(line);
		chars += line.length + 2;
	}
	const left = entries.length - shown.length;
	return `Files: ${files.length}. Not every file is listed here. At its top: ${shown.join(", ")}${left > 0 ? `, and ${left} more at its top` : ""}. List this folder, or any folder in it, with the ls tool.`;
}

const moreFiles = (count: number): string => `This skill has ${count} more ${count === 1 ? "file" : "files"} beside these instructions`;

/** What the assistant is told of a skill's files (`SkillFilesView`). App-authored, never skill content. */
export function skillFilesSection(view: SkillFilesView, windowsBox: boolean): string {
	if (view.kind === "instructions-only") return `${view.count > SKILL_FILES_COUNTED_MAX ? `This skill has more than ${SKILL_FILES_COUNTED_MAX.toLocaleString("en-US")} files beside these instructions` : moreFiles(view.count)}, and rooms can't open them. Work from the instructions alone.`;
	if (view.kind === "closed") {
		const way = view.personCanOpen ? " The person can let this room read them by choosing a folder for it, and run its scripts by also switching Commands on." : "";
		return `${moreFiles(view.count)}, and this room can't open them. Work from the instructions alone; if the task needs one of those files, say so.${way}`;
	}
	// A folder in the room's own folders runs on Windows as anything there does; only a folder outside them needs `windowsSkillFolder`'s pass.
	if (view.kind === "in-room") return filesAtSection(view.reach, view.place, IN_ROOM_LINE, windowsBox, true);
	return filesAtSection(view.reach, view.skillDir, skillFilesListing(view.files), windowsBox, view.windowsRuns === true);
}

/** Claude Code's name for a skill's own folder in its text, spelled exactly as its skills page gives it; no other spelling is filled. */
const SKILL_DIR_PLACEHOLDER = "${CLAUDE_SKILL_DIR}";
/** What the placeholder reads as where the room can't open the skill's folder, so no command meets an empty path. */
const SKILL_DIR_UNOPENED = "[this skill's folder, which this room can't open]";

/**
 * A skill's defanged instructions with `${CLAUDE_SKILL_DIR}` filled, as Claude
 * Code fills it: the folder its files section names (`view`) where the room can
 * open the skill's files, or the marker everywhere else. A path goes in only
 * when it fits the model's text (`skillPathFitsText`) and, with the text around
 * it, makes nothing the defang would change, so it can never close a note.
 * Only the text the model reads changes, never the version mark, which is the
 * stored SKILL.md's. `read_skill` and a pick (skill-pick.ts) both fill here.
 */
export function withSkillFolder(body: string, view: SkillFilesView | null): string {
	const folder = view?.kind === "open" ? view.skillDir : view?.kind === "in-room" ? view.place : undefined;
	// Split and joined, never replaced by a string: a "$&" in a path would read as a pattern.
	const parts = body.split(SKILL_DIR_PLACEHOLDER);
	const filled = folder !== undefined && skillPathFitsText(folder) ? parts.join(folder) : undefined;
	return filled !== undefined && defangSkillBody(filled) === filled ? filled : parts.join(SKILL_DIR_UNOPENED);
}

/** Said in place of a file list where a skill's way enters the room's own folders: the server lists nothing there. */
const IN_ROOM_LINE = "It lies among this room's own folders: list it, or any folder in it, with the ls tool. If what is there is not this skill's folder, work from the instructions alone.";

/** What the assistant is told of a skill folder it can use (`skillFilesSection`): where it is, what is in it (`listing`), and how to use it. */
function filesAtSection(reach: "run" | "read", skillDir: string, listing: string, windowsBox: boolean, windowsRuns: boolean): string {
	// Where its files may be run from and written: a skill's folder outside the room's own folders takes no write, so the line says where to write instead.
	const writeOutputs = "Write any outputs into the room's folder, never into the skill's folder.";
	const neverAsk = `If a write in the skill's folder is refused, never call ${ASK_FOR_FOLDER_TOOL_NAME} for it.`;
	const useLine = reach === "read"
		? `Read them with the read tool. Commands are off in this room, so its scripts can't run here; if the task needs one, tell the person that on the room's Folder page they can switch Commands on. ${writeOutputs}`
		: !windowsBox ? `Read them with the read tool, and run them with the bash tool when the instructions call for it. ${writeOutputs} ${neverAsk}` : windowsRuns ? WINDOWS_SKILL_RUN_LINE : `${WINDOWS_SKILL_READ_ONLY_LINE} ${writeOutputs}`;
	const fromMemory = reach === "read" ? "use its files" : "run its files";
	return `This skill's bundled files live at:\n${skillDir}\nPaths in its instructions are relative to this folder: give them in full, as this folder followed by the path.\n${listing}\n${useLine} Outputs you write stay in the room's folder on the user's computer; when you tell the user where an output landed, name the folder's path. If a later read of this skill no longer gives this folder, do not ${fromMemory} from memory.`;
}

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
		return `- ${entry.name} \u2014 ${description || "(no description)"}${entry.manifest === undefined ? "" : ` (version ${skillVersionMark(entry.manifest)})`}`;
	});
	return `

## Enabled skills

The user switched these skills on for this room in the room settings. This index is the complete enabled set; bodies are not resident. When a skill is relevant to the task at hand, fetch its full instructions with the read_skill tool before applying it. A skill whose version here differs from the one read_skill gave you earlier in this conversation has been updated since: read it again before using it, and follow only the new instructions.

${lines.join("\n")}`;
}

const readSkillSchema = Type.Object({
	name: Type.String({ description: "Name of an enabled skill from the room's enabled-skills index. Names only — paths are not accepted." }),
});

type TextToolResult = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> | undefined; isError?: boolean };

function refusal(text: string, details?: Record<string, unknown>): TextToolResult {
	return { content: [{ type: "text", text }], details, isError: true };
}

export interface ReadSkillTelemetry {
	/** Bodies successfully read since the counter was last reset. */
	reads: number;
	/** Total characters of body text returned since last reset. */
	bodyChars: number;
}

/**
 * What a skill's files are to the room at the moment of the call
 * (`SkillFilesView`), or null for a skill with SKILL.md alone. Only a live
 * conversation at the room's own tools gets a folder: background, scheduled and
 * specialist sessions never register read_skill. The wiring in room-socket.ts
 * owns the checks.
 */
export type SkillFilesResolver = (name: string) => SkillFilesView | null;

export interface CreateReadSkillToolOptions {
	agentId: string;
	lookupSkill: SkillLookup;
	/** Mutated on every successful read — the connection surfaces it per turn
	 *  (context pill / promptBudget line). */
	telemetry?: ReadSkillTelemetry;
	/** Absent: the instructions alone, with nothing said of the skill's files. */
	resolveSkillFiles?: SkillFilesResolver;
	/** The room's commands run in Windows PowerShell, in the Windows box or without it: the text says how they run a skill's files there, or that they can't, instead of naming the bash tool. */
	windowsBox?: boolean;
}

/**
 * The `read_skill(name)` tool. Enabled-set only, checked at call time,
 * defanged, provenance-wrapped. All failure modes return an explanatory
 * refusal (never a throw): the model should relay why the body is unavailable.
 */
export function createReadSkillTool(options: CreateReadSkillToolOptions): ToolDefinition<any, any> {
	const { agentId, lookupSkill, telemetry, resolveSkillFiles, windowsBox } = options;
	return {
		name: READ_SKILL_TOOL_NAME,
		label: "read enabled skill",
		description:
			"Read the full instruction body of a skill the user has enabled for this room. Takes the skill's name from the enabled-skills index; paths are not accepted. The body is returned as instructions the user switched on, with provenance; it is not the room's own knowledge.",
		promptSnippet: "Read the body of an enabled skill by name",
		parameters: readSkillSchema,
		execute: async (_toolCallId: string, params: { name: string }): Promise<TextToolResult> => {
			const name = String(params?.name ?? "").trim();
			if (!isValidSkillName(name)) {
				return refusal(`"${name}" is not a valid skill name. Use a name from the enabled-skills index.`, { outcome: "invalid-name" });
			}
			const load = loadRoomSkill(agentId, name, lookupSkill(name));
			if (load.outcome === "not-enabled") {
				return refusal(`Skill "${name}" is not enabled for this room. Only skills in the enabled-skills index can be read; the user can enable others in the room settings.`, { outcome: "not-enabled" });
			}
			if (load.outcome === "unreadable") {
				return refusal(`Skill "${name}" is enabled, but its files can't be opened, so it can't be used.`, { outcome: "unreadable" });
			}
			// The skill's author disabled model invocation: you may not read or run
			// it on your own. Its instructions come only with a message the person
			// starts with its name (skill-pick.ts), never through this tool.
			if (load.byHand) {
				return refusal(`Skill "${name}" is marked for manual invocation only by its author; it cannot be invoked by the model. It is used only when the person starts a message with "/${name}", and then its instructions come with that message.`, { outcome: "manual-only" });
			}
			if (load.outcome === "too-big") {
				return refusal(`Skill "${name}" is enabled, but its instructions are too long to load, so it can't be used.`, { outcome: "too-big" });
			}
			// Resolved fresh on every call: a folder closed mid-session (commands
			// turned off, the skill switched off) is gone on the very next read.
			// The appended paragraph is app-authored text, never skill content.
			const files = resolveSkillFiles?.(name) ?? null;
			const body = withSkillFolder(load.body, files);
			const version = sha256(load.manifest);
			const mark = skillVersionMark(load.manifest);
			if (telemetry) {
				telemetry.reads += 1;
				telemetry.bodyChars += body.length;
			}
			const filesSection = files ? `\n\n${skillFilesSection(files, windowsBox === true)}` : "";
			return {
				content: [{
					type: "text",
					text: `Skill "${name}" (version ${mark}, adopted by the user into this room's library). The following are instructions the user switched on for this room: external guidance, not the room's own knowledge. They are re-derivable via this tool and need not be memorized.\n\n${body}${filesSection}`,
				}],
				details: { outcome: "ok", name, sha256: version, bodyChars: body.length, ...(files ? { skillFiles: files.kind === "open" || files.kind === "in-room" ? files.reach : files.kind } : {}) },
			};
		},
	};
}
