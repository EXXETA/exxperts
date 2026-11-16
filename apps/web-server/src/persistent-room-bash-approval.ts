/**
 * Per-command bash approval for live Full-access rooms.
 *
 * Bash is the one tool whose blast radius is the whole machine, so a live
 * room session pauses every bash call on a question to the person unless
 * the room has been explicitly told to stop asking (the per-room auto-approve
 * setting, default off). Where commands run outside the box, auto-approve
 * holds only while someone can see the room, unless the room is on Auto
 * without protection: there a turn left running goes on, bounded by the away
 * limits. Elsewhere a turn left running, or a page closed mid-answer, gets no
 * command. The question is the bridge's own kind
 * (`ctx.ui.askRun`): the page's panel draws the command whole in its own box,
 * as the run-outside question does, so the command that runs is the one shown.
 *
 * Deliberately dependency-light (no imports from index.ts): the guard takes
 * its one live dependency — the current auto-approve answer — as a closure,
 * so it stays unit-testable and background/scheduled sessions simply never
 * construct it.
 */

import { isNoShellFoundMessage } from "@exxeta/exxperts-runtime";
import type { WebUiContext } from "./web-ui-context.js";

export type PersistentRoomBashApprovalDecision = { allow: true } | { allow: false; reason: string };

/** The minimal slice of the runtime's ExtensionContext the guard touches. */
export interface PersistentRoomBashApprovalContext {
	hasUI?: boolean;
	cwd?: string;
	/** The live room's WebUiContext: a person leaving detaches it, so `watcher()` turns "none" while `hasUI` stays true. */
	ui?: Pick<WebUiContext, "askRun" | "watcher">;
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
	/** Whether this session's commands run in the room's box, as its bind decided. Left out, they don't: a yes then needs someone watching. */
	boxed?: () => boolean;
	/** Whether a yes holds with nobody there outside the box too: a room without protection on Auto. Read at each command; left out, it doesn't. */
	runsWhileAway?: () => boolean;
}

export function createPersistentRoomBashApprovalGuard(options: CreatePersistentRoomBashApprovalGuardOptions): PersistentRoomBashApprovalGuard {
	return {
		async beforeBashCall(command: string, ctx: PersistentRoomBashApprovalContext | undefined): Promise<PersistentRoomBashApprovalDecision> {
			if (options.isAutoApproved()) {
				if (options.boxed?.() === true || someoneWatches(ctx) || options.runsWhileAway?.() === true) return { allow: true };
				return { allow: false, reason: NOBODY_TO_APPROVE_COMMAND };
			}
			if (!ctx?.hasUI) {
				return { allow: false, reason: NOBODY_TO_APPROVE_COMMAND };
			}
			const folder = typeof ctx.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : null;
			// A client disconnect mid-question is NOT caught here: the web UI bridge
			// rejects the pending question with its detach message, which surfaces
			// as this tool call's error result, and the auto-declined-question log
			// leaves the transcript system note — the same path every other
			// detached dialog takes.
			const approved = await ctx.ui!.askRun({ command: String(command ?? ""), folder });
			if (!approved) {
				return { allow: false, reason: `${COMMAND_DECLINED} Do not run it or retry variants of it unless the user asks.` };
			}
			return { allow: true };
		},
	};
}

function someoneWatches(ctx: PersistentRoomBashApprovalContext | undefined): boolean {
	return ctx?.hasUI === true && typeof ctx.ui?.watcher === "function" && ctx.ui.watcher() !== "none";
}

/** The refusals the page reads as "not run"; the outside tool's card says them too. */
export const COMMAND_DECLINED = "The user declined this command.";
export const NOBODY_TO_APPROVE_COMMAND = "Running commands requires the interactive room UI; there is no user here to approve them.";

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
export function createPersistentRoomBashApprovalExtension(guard: PersistentRoomBashApprovalGuard, started: (toolCallId: string) => boolean = () => true) {
	return async function persistentRoomBashApproval(pi: BashApprovalExtensionApi) {
		pi.on("tool_call", async (event: any, ctx: any) => {
			if (event?.toolName !== "bash") return undefined;
			const command = typeof event?.input?.command === "string" ? event.input.command : "";
			const decision = await guard.beforeBashCall(command, ctx);
			if (decision.allow) return undefined;
			return { block: true, reason: decision.reason };
		});
		pi.on("tool_result", async (event: any) => {
			if (event?.toolName !== "bash" && event?.toolName !== "run_outside_box") return undefined;
			// Refused before it began: a card's Decline, or a box that didn't start.
			if (!started(String(event?.toolCallId ?? ""))) return undefined;
			const content: Array<{ type?: string; text?: string }> = Array.isArray(event.content) ? event.content : [];
			if (event.isError === true && isNoShellFoundMessage(content.map((part) => (part?.type === "text" ? String(part.text ?? "") : "")).join("\n"))) return undefined;
			const details = event.details && typeof event.details === "object" ? event.details as Record<string, unknown> : {};
			return { details: { ...details, [COMMAND_RAN]: true } };
		});
	};
}
