import { modelNotOnAccountSentence } from "../../web-server/src/model-not-on-account";
import { withoutRestartSentence } from "../../web-server/src/scheduled-run-pause-words";
import { modelDisplayName } from "./model-names";
import { knownRemoteClientContext } from "./remote-client-context";
import type { PersistentRoomBackgroundRunView } from "./types";

/**
 * A scheduled run's line in the Scheduled tasks pane: what it waits for, or plainly why it did not run. `repeating`: the run's task runs
 * again at a next time; a caller that does not know gets the line that promises nothing.
 */
export function formatFriendlyRunReason(run: Pick<PersistentRoomBackgroundRunView, "status" | "reason" | "readiness" | "error" | "message"> & Partial<Pick<PersistentRoomBackgroundRunView, "target">>, repeating = false): string | null {
	// A blocked run being checked again keeps saying what it was blocked for.
	const reason = run.reason === "transient_block_revived" ? run.readiness?.reason ?? run.reason : run.reason || run.readiness?.reason || run.error?.code;
	switch (reason) {
		case "transient_block_revived": return "Waiting to run.";
		case "superseded_by_later_run": return "A later run of this task took its place.";
		case "prepared_conversation_ended": return "Did not run. The conversation it was waiting for has ended.";
		case "prepared_conversation_not_recorded": return "Did not run.";
		case "room_in_use": return "Room is in use; will retry.";
		case "active_turn_in_flight": return "Room has work in progress.";
		case "prepared_runtime_boundary": return "Waits until the next conversation in this room has started.";
		case "model_not_found": return "Scheduled model is not available.";
		case "provider_not_connected": return "AI provider is not connected.";
		case "model_policy_unavailable": return "This room's model cannot run. See Room settings, Model.";
		// The provider refused the room's model for this account: the run says so, with the way out. On a shared server the account is the server's.
		case "model_not_on_account": return modelNotOnAccountSentence(run.target?.model ? modelDisplayName({ model: run.target.model.model, modelLabel: run.target.model.label, provider: run.target.model.provider }) || "This room's model" : "This room's model", run.target?.model?.provider, "room", knownRemoteClientContext()?.sharedServer === true);
		case "schedule_missing": return "Schedule was deleted before it ran.";
		case "schedule_disabled": return "Schedule was disabled before it ran.";
		case "completed": return "Completed.";
		case "already_completed": return "Already completed; no duplicate execution was performed.";
		case "server_stopped": return "Stopped when exxperts stopped.";
		// A shared server's run rules write the person's own sentence as the message (the time limit's names the limit).
		case "time_limit":
		case "interrupted_by_restart": if (run.message) return run.message; break;
		// Opening the room lets a repeating task run again; a one-time task's paused run never does, so its line stops before that.
		case "owner_paused": if (run.message) return repeating ? run.message : withoutRestartSentence(run.message); break;
		default: break;
	}
	// The server's own text names engine parts and ids: never shown.
	if (run.status === "failed") return "Something went wrong, so this run did not finish.";
	if (run.status === "cancelled") return "Did not run.";
	// A blocked run is checked again unless a reason above ended it.
	if (run.status === "blocked" || run.status === "deferred") return "Waiting to run.";
	return null;
}

/** A run's line under Recent runs: only runs that waited or went wrong carry one there, an unexpected stop included. */
export function recentRunReason(run: PersistentRoomBackgroundRunView, repeating = false): string | null {
	const shown = run.status === "deferred" || run.status === "blocked" || run.status === "failed" || run.reason === "interrupted_by_restart";
	return shown ? formatFriendlyRunReason(run, repeating) : null;
}

/** Blocks that only wait their turn: the run goes on by itself once the room is free or its next conversation has started. */
const WAIT_REASONS = new Set(["prepared_runtime_boundary", "room_in_use", "active_turn_in_flight"]);

/** A run's status as the pane shows it: "paused" is a repeating task's run a shared server's run rules held back (owner_paused). */
export type RunShownStatus = PersistentRoomBackgroundRunView["status"] | "paused";

/**
 * The status the pane shows: a run blocked only to wait reads as waiting, not as a block; a repeating task's run a shared server paused
 * reads as paused, since the task runs again; a one-time task's stays blocked, since it never does, and so does one whose kind the
 * caller does not know.
 */
export function runShownStatus(run: Pick<PersistentRoomBackgroundRunView, "status" | "reason" | "readiness">, repeating = false): RunShownStatus {
	const reason = run.reason === "transient_block_revived" ? run.readiness?.reason ?? run.reason : run.reason || run.readiness?.reason;
	if (run.status === "blocked" && reason === "owner_paused" && repeating) return "paused";
	return run.status === "blocked" && reason && WAIT_REASONS.has(reason) ? "deferred" : run.status;
}
