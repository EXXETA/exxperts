/**
 * Per-command bash approval for live Full-access rooms.
 *
 * Bash is the one tool whose blast radius is the whole machine, so a live
 * room session pauses every bash call on an approval card in the chat unless
 * the room has been explicitly told to stop asking (the per-room auto-approve
 * setting, default off). The card rides the existing delegate-approval
 * machinery end to end: `ctx.ui.confirm` → `ui_request`/`ui_response` frames →
 * the web client's Approval card, whose `───` fence chrome renders the
 * model-written command as unverified text.
 *
 * Deliberately dependency-light (no imports from index.ts): the guard takes
 * its one live dependency — the current auto-approve answer — as a closure,
 * so it stays unit-testable and background/scheduled sessions simply never
 * construct it.
 */

import { isNoShellFoundMessage } from "@exxeta/exxperts-runtime";
import { PERSISTENT_ROOM_COMMAND_APPROVAL_TITLE } from "./room-approval-titles.js";

export type PersistentRoomBashApprovalDecision = { allow: true } | { allow: false; reason: string };

/** The minimal slice of the runtime's ExtensionContext the guard touches. */
export interface PersistentRoomBashApprovalContext {
	hasUI?: boolean;
	cwd?: string;
	ui?: { confirm(title: string, message: string): Promise<boolean> };
}

export interface PersistentRoomBashApprovalGuard {
	beforeBashCall(command: string, ctx: PersistentRoomBashApprovalContext | undefined): Promise<PersistentRoomBashApprovalDecision>;
}

export interface CreatePersistentRoomBashApprovalGuardOptions {
	/**
	 * Read live on EVERY call (like the read_skill exposure gate): flipping the
	 * room's auto-approve setting must take effect on the very next command,
	 * with no session rebind.
	 */
	isAutoApproved: () => boolean;
}

const COMMAND_PREVIEW_MAX_CHARS = 1_200;

export function createPersistentRoomBashApprovalGuard(options: CreatePersistentRoomBashApprovalGuardOptions): PersistentRoomBashApprovalGuard {
	return {
		async beforeBashCall(command: string, ctx: PersistentRoomBashApprovalContext | undefined): Promise<PersistentRoomBashApprovalDecision> {
			if (options.isAutoApproved()) return { allow: true };
			if (!ctx?.hasUI) {
				return { allow: false, reason: "Running commands requires the interactive room UI; there is no user here to approve them." };
			}
			const commandText = String(command ?? "");
			const commandPreview = commandText.length > COMMAND_PREVIEW_MAX_CHARS
				? `${commandText.slice(0, COMMAND_PREVIEW_MAX_CHARS)}\n[command preview clipped]`
				: commandText;
			const cwd = typeof ctx.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : null;
			// A client disconnect mid-card is NOT caught here: the web UI bridge
			// rejects the pending confirm with its detach message, which surfaces
			// as this tool call's error result, and the auto-declined-question log
			// leaves the transcript system note — the same path every other
			// detached dialog takes.
			const approved = await ctx.ui!.confirm(
				PERSISTENT_ROOM_COMMAND_APPROVAL_TITLE,
				[
					...(cwd ? [`Runs in: ${cwd}`] : []),
					"You can auto-approve bash for this room in Room settings, Folder.",
					"",
					// Anti-spoof separator: everything below is the room model's own
					// text appended after the app-drawn facts above; a command that
					// mimics those fact lines must not be able to pass as the app
					// speaking.
					"─── Command (written by the room's model; the app has not verified it) ───",
					commandPreview,
				].join("\n"),
			);
			if (!approved) {
				return { allow: false, reason: "The user declined this command. Do not run it or retry variants of it unless the user asks." };
			}
			return { allow: true };
		},
	};
}

// Set on a command's result details once it ran. The runtime gives a
// refused, a missing and a failed command the same error result, and a
// command that ran and then failed may still have changed things
// (edit-last-message.ts names it among the steps an edit does not undo).
const COMMAND_RAN = "commandRan";

/** Whether a command's result says it ran, whatever its exit. */
export function commandRan(details: unknown): boolean {
	return !!details && typeof details === "object" && (details as Record<string, unknown>)[COMMAND_RAN] === true;
}

interface BashApprovalExtensionApi {
	on(event: "tool_call", handler: (event: any, ctx: any) => Promise<{ block: boolean; reason: string } | undefined>): void;
	on(event: "tool_result", handler: (event: any) => Promise<{ details: Record<string, unknown> } | undefined>): void;
}

/**
 * The room-scoped extension that interposes the guard: only `bash` tool calls
 * are touched, every other tool passes through untouched. Built inside the
 * live web session bind only, so background, scheduled, and specialist runs
 * (which never get bash anyway) never see an approval pause. The runtime
 * calls `tool_result` for a call it executed, never for one a hook blocked or
 * the turn stopped before, so a bash result there marks the command as run,
 * except the no-shell failure, which started nothing. This extension is
 * registered before the one that rewrites that failure's words, so it reads
 * them raw (persistent-room-shell-missing.ts).
 */
export function createPersistentRoomBashApprovalExtension(guard: PersistentRoomBashApprovalGuard) {
	return async function persistentRoomBashApproval(pi: BashApprovalExtensionApi) {
		pi.on("tool_call", async (event: any, ctx: any) => {
			if (event?.toolName !== "bash") return undefined;
			const command = typeof event?.input?.command === "string" ? event.input.command : "";
			const decision = await guard.beforeBashCall(command, ctx);
			if (decision.allow) return undefined;
			return { block: true, reason: decision.reason };
		});
		pi.on("tool_result", async (event: any) => {
			if (event?.toolName !== "bash") return undefined;
			const content: Array<{ type?: string; text?: string }> = Array.isArray(event.content) ? event.content : [];
			if (event.isError === true && isNoShellFoundMessage(content.map((part) => (part?.type === "text" ? String(part.text ?? "") : "")).join("\n"))) return undefined;
			const details = event.details && typeof event.details === "object" ? event.details as Record<string, unknown> : {};
			return { details: { ...details, [COMMAND_RAN]: true } };
		});
	};
}
