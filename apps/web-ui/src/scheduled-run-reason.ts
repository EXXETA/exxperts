import { modelNotOnAccountSentence } from "../../web-server/src/model-not-on-account";
import { modelDisplayName } from "./model-names";
import type { PersistentRoomBackgroundRunView } from "./types";

/** A scheduled run's line in the Scheduled tasks pane: what it waits for, or plainly why it did not run. */
export function formatFriendlyRunReason(run: Pick<PersistentRoomBackgroundRunView, "status" | "reason" | "readiness" | "error" | "message"> & Partial<Pick<PersistentRoomBackgroundRunView, "target">>): string | null {
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
		// The provider refused the room's model for this account: the run says so, with the way out.
		case "model_not_on_account": return modelNotOnAccountSentence(run.target?.model ? modelDisplayName({ model: run.target.model.model, modelLabel: run.target.model.label, provider: run.target.model.provider }) || "This room's model" : "This room's model", run.target?.model?.provider);
		case "schedule_missing": return "Schedule was deleted before it ran.";
		case "schedule_disabled": return "Schedule was disabled before it ran.";
		case "completed": return "Completed.";
		case "already_completed": return "Already completed; no duplicate execution was performed.";
		default: break;
	}
	// The server's own text names engine parts and ids: never shown.
	if (run.status === "failed") return "Something went wrong, so this run did not finish.";
	if (run.status === "cancelled") return "Did not run.";
	// A blocked run is checked again unless a reason above ended it.
	if (run.status === "blocked" || run.status === "deferred") return "Waiting to run.";
	return null;
}

/** Blocks that only wait their turn: the run goes on by itself once the room is free or its next conversation has started. */
const WAIT_REASONS = new Set(["prepared_runtime_boundary", "room_in_use", "active_turn_in_flight"]);

/** The status the pane shows: a run blocked only to wait reads as waiting (decision 47), not as a block. */
export function runShownStatus(run: Pick<PersistentRoomBackgroundRunView, "status" | "reason" | "readiness">): PersistentRoomBackgroundRunView["status"] {
	const reason = run.reason === "transient_block_revived" ? run.readiness?.reason ?? run.reason : run.reason || run.readiness?.reason;
	return run.status === "blocked" && reason && WAIT_REASONS.has(reason) ? "deferred" : run.status;
}
