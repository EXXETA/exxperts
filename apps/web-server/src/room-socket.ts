/**
 * The room's live connection: GET /ws, one agent session per WebSocket
 * connection.
 *
 * Wire protocol (JSON over WS):
 *   client -> server:  { type: "prompt", text: string, id?, shown?: { text, files: [{ name, bytes, extension }] }, effort?: ThinkingLevel, explicit?: true }
 *                        (`id`: the question's id, which keys the turn's items,
 *                        thread-items-by-id.ts; one the conversation already
 *                        used makes the turn old-style. `shown`: the bubble's
 *                        words and file chips, which a landing writes)
 *                        (`effort` is stored raw for this conversation exactly
 *                        like the effort frame's level; omit it to keep
 *                        whatever the conversation already runs at. This app's
 *                        composer always omits it: echoing back the clamped
 *                        level it was shown would overwrite the raw stored
 *                        preference)
 *                      { type: "continue", id? }
 *                        (Try again under a failed answer; `id` keys the
 *                        turn's items as a prompt's does)
 *                      { type: "abort", shown?: number, forNext?: true }
 *                        (also hands back every steer the runtime has not
 *                        taken, as steer_returned; `shown`: how many
 *                        characters of the answer being written the page had
 *                        shown, so the next message tells the model what the
 *                        person saw, cut-answer-note.ts; `forNext`: the
 *                        person's waiting messages stopped it (Send now), so
 *                        that note says their message cut the answer)
 *                      { type: "stop_reveal", shown, itemId? }
 *                        (Stop after the answer ended while the page still
 *                        showed its rest: `shown` characters of the last
 *                        message were on screen; the next message is told so,
 *                        and no landing brings back the rest. With `itemId`,
 *                        an answer part of the newest turn: `shown` counts
 *                        that part's saved text)
 *                      { type: "steer", id, text, shown?, declines?, now? }
 *                        (a message sent while the room answers; the server
 *                        decides where it goes from its own state,
 *                        steer-route.ts, and answers steer_waiting,
 *                        steer_cut or steer_refused)
 *                      { type: "hold", messages: [{ id, text }] }
 *                        (messages the page queued that the server never
 *                        took, after its connection dropped, or that only
 *                        the page held when it went away: they wait in
 *                        held-messages-store.ts until the person acts)
 *                      { type: "held_drop", id }
 *                        (the person sent, edited or removed a held message)
 *                      { type: "steer_withdraw", id, edit? }
 *                        (Edit or Remove on a message the running answer
 *                        holds: it comes out of the runtime's queue, unless
 *                        the runtime is taking queued messages in; answers
 *                        steer_withdrawn or steer_withdraw_refused)
 *                      { type: "effort", level: ThinkingLevel, explicit?: true }
 *                        (this conversation's reasoning effort, chosen
 *                        between turns; `explicit`: the person picked it, so
 *                        it is stored even when it equals the level shown)
 *   server -> client:  { type: "event", event: <session event>, seq? }
 *                        (every turn frame sent while a turn runs, events or
 *                        not, carries seq: 1, 2, 3… per turn, the same numbers
 *                        in a reattach replay.
 *                        Text deltas arrive merged, turn-frame-coalescer.ts)
 *                        (the frame that ends the turn, agent_end or a
 *                        cut-short auto_retry_end, carries endedBy: "stop" | "next" |
 *                        "server-stop" | "left" | "failed" when the turn ended
 *                        before its answer did, turn-ended-by.ts)
 *                        (a keyed turn's frame that opens an item names it:
 *                        `itemId` inside assistantMessageEvent of a
 *                        message_update, on the event of a message_start;
 *                        a message_end carries `echoOf` when its message
 *                        repeats an earlier part and writes none)
 *                      { type: "ready", model: string, effort: { level, supported, ladder }, waiting, taken, withdrawn, reattaching, held }
 *                        (`held`: the conversation's held messages,
 *                        [{ id, text }], held-messages-store.ts, kept on disk)
 *                        (`waiting`, also on turn_reattach: the messages the
 *                        running answer this window steps back into still
 *                        holds, [{ id, text }]; `taken`: the ids of the
 *                        messages the conversation's last turn took or the
 *                        person took back out of it, the newest 50;
 *                        `withdrawn`: those of them taken back, so a window
 *                        whose Edit went unanswered puts its text back in
 *                        the box; `reattaching`: a turn_reattach and its
 *                        replay follow, or, when another window took the
 *                        turn or its replay ran out meanwhile, an error that
 *                        closes the connection. Kept in memory only)
 *                        (ladder = the model's OWN dial, one {level,label} per
 *                        distinct effort it can produce, so tokens that come
 *                        out identical are one rung and each rung carries the
 *                        provider's own name for it. `supported` is the older,
 *                        unfolded token list, kept for clients that predate
 *                        the ladder. level is CLAMPED for display and must
 *                        never be sent back as a choice. A room that never
 *                        chose reports the level its session resolved on its
 *                        own)
 *                      { type: "edit_refused", replaces, reason, held }
 *                        (`held`: the conversation's held messages, as on
 *                        ready, so a message held from another window shows
 *                        with the refusal)
 *                      { type: "effort", level, supported }
 *                        (what an effort frame actually took hold as)
 *                      { type: "error", message: string }
 *                      { type: "turn_reattach", turnId, conversationId, settled, userText?, promptId?, promptFiles?, anchorItemId?, startedAt?, now, waiting }
 *                        (`promptId` and `promptFiles`: a keyed turn's question
 *                        by id with its file chips; `userText` is then its
 *                        bubble's words, also when empty)
 *                        (sent right after "ready" when this session
 *                        stepped back into a room whose detached turn is still
 *                        cooking or just landed; the whole turn's event frames
 *                        replay immediately after it, then live frames continue.
 *                        anchorItemId names the last persisted item of EARLIER
 *                        TURNS: everything after it is this turn's debris, null
 *                        means there is none, absent means unknown;
 *                        now is the server's clock, so a page whose clock differs
 *                        dates the replayed steps by its own)
 *                      { type: "steer_waiting", id, afterText? } | { type: "steer_cut", id, quiet } | { type: "steer_refused", id }
 *                        (where a steer goes, steer-route.ts SteerRouted)
 *                      { type: "steer_withdrawn", id, edit } | { type: "steer_withdraw_refused", id }
 *                        (the message came out of the running answer, or
 *                        it stays because the room is taking it in)
 *                      { type: "steer_taken", id, text }
 *                        (the runtime took that steer in: the person's
 *                        message sits here in the conversation)
 *                      { type: "steer_returned", messages: [{ id, text }], held? }
 *                        (steers not taken: after Stop, at the answer's end
 *                        and when the turn settles; `held`: no window was
 *                        there to take them, or the server stops, so they
 *                        wait as held messages)
 *                      { type: "turn_reattach_replay_done", turnId }
 *                        (closes the replay window opened by turn_reattach —
 *                        every frame between the two is catch-up the client
 *                        should render instantly; frames after it are live
 *                        and reveal at reading pace)
 *                      { type: "error", code: "room_displaced", ... }
 *                        (this session's adopted turn was taken over
 *                        by a newer connection for the same room)
 */

import { estimateTokens, estimateTokensFromChars } from "./token-estimate.js";
import { createAgentSession, getAgentDir, DefaultResourceLoader, SessionManager } from "@exxeta/exxperts-runtime";
import { createWebUiContext } from "./web-ui-context.js";
import { type AnswerNote, serverStopNote, shownPart, withAnswerNote } from "./cut-answer-note.js";
import { answerPhase, bubbleIdOf, readShownChars, readSteerRequest, steerWay, type SteerRequest, type SteerRouted } from "./steer-route.js";
import { createTurnFrameCoalescer } from "./turn-frame-coalescer.js";
import { dropHeldMessages, holdMessages, readHeldMessageList, readHeldMessages } from "./held-messages-store.js";
import { STOPPED_BEFORE_ANSWER_SENTENCE, type TurnEndedBy } from "./turn-ended-by.js";
import { ConsultPromptOverflowError } from "./consult.js";
import { createPersistentAgentInstance, parsePersistentAgentL1aMarker, PERSISTENT_AGENT_L1A_TEMPLATE_VERSION, planPersistentAgentConstitutionUpgrade, upgradePersistentAgentConstitution, assertPersistentAgentAcceptsSession, RECENT_CONTEXT_BLOCK_CAP, getPersistentAgentThread, getPersistentAgentActiveTurnState, clearPersistentAgentUnseenLandedAnswerForBind, markPersistentAgentTurnCancelling, writePersistentAgentThread, recordPersistentAgentUnseenLandedAnswer, switchPersistentAgentThreadModel, createPersistentRoomAutoDeclinedQuestionLog, refreshEmptyPersistentAgentThreadModel, persistentAgentThreadFollowsConversationPick, persistentAgentThreadIsEmpty, refreshEmptyPersistentAgentThreadBootSnapshot, buildPersistentAgentCurrentIdentitySection, fingerprintPersistentAgentBootContextInstructions, buildPersistentRoomCurrentWorkspaceSection, buildPersistentAgentBootContext, readPersistentAgentBootPromptSnapshot, assertPersistentAgentBootPromptFitsWindow, openPersistentAgentPiSessionManager, PersistentAgentMemoryOverflowError, emptyPersistentAgentThreadModelTarget, beginPersistentAgentTurn, clearPersistentAgentThreadPendingHandoffs, finishPersistentAgentTurn, buildConsultAnswer } from "./persistent-agents.js";
import { buildPersistentRoomRestoredLiveThreadContext } from "./persistent-room-resume-context.js";
import { getPersistentRoomToolPolicy, persistentRoomBlockedToolLeaks } from "./persistent-room-tool-policy.js";
import { persistentRoomRuntimeCwdForEffectiveWorkspacePolicy, resolvePersistentRoomEffectiveWorkspacePolicy, persistentRoomSettingsNotAppliedFrame } from "./persistent-room-workspace-policy.js";
import { createPersistentRoomBashApprovalExtension, createPersistentRoomBashApprovalGuard } from "./persistent-room-bash-approval.js";
import { readPersistentRoomBashSettings } from "./persistent-room-bash-settings.js";
import { createPersistentRoomShellMissingExtension } from "./persistent-room-shell-missing.js";
import { createTurnStepLog, landedTextAfter, withFrameIds } from "./persistent-room-turn-steps.js";
import { RoomModelUnavailableError, createRoomModelCatalog, resolveRoomModel } from "./room-models.js";
import { effectiveConversationEffortChoice, isRoomEffortLevel, settleConversationEffortChoice } from "./persistent-room-effort-settings.js";
import { readPersistentRoomInstructionsNow } from "./persistent-room-instructions.js";
import { nextRoomStateMessage } from "./room-state-message.js";
import { readPersistentRoomSkillSettings, effectiveEnabledSkills } from "./persistent-room-skill-settings.js";
import { createReadSkillTool, buildEnabledSkillsIndexSection } from "./persistent-room-skill-tool.js";
import { userAuthoredPromptText } from "./persistent-room-delegate-tool.js";
import { SPECIALISTS_OFF_SENTENCE } from "./room-approval-titles.js";
import { buildShelfManifestSection } from "./persistent-room-shelf.js";
import { createPersistentRoomShelfTools } from "./persistent-room-shelf-tools.js";
import { createPersistentRoomMemoryRecallTool } from "./persistent-room-memory-recall-tool.js";
import { listTaskLedgerRecords, selectTaskLedgerAwayNotices, markTaskLedgerRecordsAwayNoticed } from "./persistent-room-task-ledger.js";
import { bindSpecialistSink, abortSpecialistTask, unbindSpecialistSink } from "./persistent-room-specialist-registry.js";
import { createPersistentRoomWorkspaceTools } from "./persistent-room-workspace-tools.js";
import type { PersistentAgentModelLock } from "./persistent-agent-ai-profiles.js";
import { gatewayModelFind } from "./gateway-model-find.js";
import { runIsolatedPersistentAgentWorker } from "./persistent-agent-worker-runtime.js";
import { callCacheRetention } from "./memory-call-cache.js";
import { type PromptDiagnosticsModel, type RedactedPromptComponent, componentFromText, createPromptAssemblyManifest, estimateTextTokens } from "./prompt-diagnostics.js";
import { recordPromptAssemblyManifest } from "./prompt-diagnostics-store.js";
import { createWebClientEventProjector } from "./web-client-event-projection.js";
import { createStreamTrace, isStreamTraceEnabled } from "./stream-trace.js";
import { persistentRoomMcpGrantsFingerprint } from "./persistent-room-mcp-settings.js";
// Import extension factories directly. This is the most reliable way to
// register them with the SDK runtime.
import contentPolicyExt from "../../../pi-package/extensions/content-policy/index.js";
import permissionsExt from "../../../pi-package/extensions/permissions/index.js";
import artifactsExt from "../../../pi-package/extensions/artifacts/index.js";
import { createRoomScopedMcpExtension } from "../../../pi-package/extensions/mcp/index.js";
import { roomLoaderSettings } from "./room-loader-settings.js";
import webSearchExt from "../../../pi-package/extensions/web-search/index.js";
import { resolveNativeProviderSearchDecision, shouldRegisterClientWebSearch, createNativeProviderSearchExtension } from "../../../pi-package/extensions/web-search/native-provider-search.js";
import fetchUrlExt from "../../../pi-package/extensions/fetch_url/index.js";
import toolResultAgingExt, { readAgedToolResultMarker } from "../../../pi-package/extensions/tool-result-aging/index.js";
import { agentSkillsDir } from "./skills-store.js";
import { emptyAnswer, answerlessCallMovedNothing, resolveUsageAuthType } from "./usage-log.js";
import { keptBeforeNextMessage, markAppPrompt, notEditableMessageId, notUndoneLine, readEditFrame, replacedItemIds, stepBackForEdit, withEditNote, type NotUndoneLine } from "./edit-last-message.js";
import { keepAppTurnFailure, stepBackFromFailedPrompt, lastShownUserText, returnedPromptOf, type ReturnedPrompt, settleReturnedPrompt } from "./failed-prompt-step-back.js";
import { lastUserItemIsScheduledPrompt } from "./persistent-room-background-execution.js";
import { credentialKeyOf, failureCodesOf, failedTurnCredential, noteKeyOutcome, turnFailureOf, answerStarted, retryFailureOf, failedMessageError, quotaWayOf, compactionFailureOf, notOnAccountLine, notOfferedLine, failureWords } from "./model-call-causes.js";
import { serverHooks, isSharedServer } from "./server-hooks.js";
import { STOP_CUT_ANSWER_SENTENCE, trackLiveConnection, STOP_QUESTIONS_SENTENCE, answerAlreadyEnded, serverStopping, SERVER_STOPPING_SENTENCE, SERVER_STOPPING_CODE, trackRunningWork } from "./server-stop.js";
import { REPO_ROOT, roomLock, roomLockBusyInstruction, roomLockBusyStatus } from "./server-install-root.js";
import fs from "node:fs";
import path from "node:path";
import { readAppVersion } from "./whats-new.js";
import { persistentAgentInstallationSection } from "./persistent-agent-constitution.js";
import { DETACHED_TURN_LIMIT_MS, DETACHED_TURN_SILENCE_MS, detachedCookingRooms, type DetachedCookingTurnHandle, detachedCookingTurnHandles, OVERFLOW_RECOVERY_CEILING_MS, type PersistentRoomLiveSession, persistentRoomLiveSessions, REATTACH_REPLAY_CAP_BYTES, reattachBufferProbe, SWITCH_WHILE_ANSWERING_MESSAGE, TEST_INTROSPECTION_ENABLED } from "./room-live-sessions.js";
import { app } from "./server-app.js";
import { isLocalPromptDiagnosticsRequest, isPromptDiagnosticsEnabled, remoteRoomExposure } from "./request-checks.js";
import { recordPersistentRoomPromptDiagnostics, safeDiagnosticIdPart } from "./room-prompt-diagnostics.js";
import { getPersistentAgentStatusForMaintenance, getUsablePersistentAgentStatusForNormalUse } from "./room-status.js";
import { threadItemsCarryAssistantText } from "./room-thread-routes.js";
import { assertPersistentAgentTurnCanBegin, latestTurnKey, recentTurnKeys, rememberRemovedIds, removedIdsOf } from "./persistent-agent-turns.js";
import { acceptAnswerCut, removeEditedAwayItems } from "./persistent-agent-threads.js";
import { type AwayLimit, awayLimitLine, cutAnswerPart, endsOnAwayLimitStop, declinedNoticeIdPrefix, failureLineId, isAnswerPartId, isEmptyCut, keyOfId, landTurnItems, partialLineId, readShownPrompt, readTurnKey, type ShownPrompt, type ThreadItem } from "./thread-items-by-id.js";
import { requestGetsLocalPaths } from "./room-settings-routes.js";
import { applyRoomEffortToSession, contextHealthForSession, getWebChatModelRegistry, initialContextHealthForSession, modelContextWindow, modelStatusPayload, recordConversationEffortChoice, roomEffortStatusPayload, roomModelRefusal, webChatModelLabel } from "./ai-models.js";
import { CONSULT_TRIGGER_PROMPT, consultModelWindow, resolveConsultModel, resolvePersistentAgentBindModel, roomMemoryModelSelection } from "./ai-profile-models.js";
import { resolveExecutableSkillFiles, resolveLibrarySkillManifest, skillLibraryFingerprint } from "./skills-library.js";
import { logProviderCallFailed, recordUsage, recordWorkerUsage, safeConversationId } from "./usage-recording.js";

// Rooms that were written before the current constitution template keep the
// words they were scaffolded with until something re-renders them, and the only
// thing that did was the operator runner — so a room nobody ran a script for
// never learned what a later template teaches. This is that re-render on the
// room's next open, with the same archive copy and event record the runner
// writes, taken BEFORE the room lock and under the open's own gate: a room that
// is merely selected — which is every room the web UI opens, because it saves
// the thread active before it opens the socket — is re-rendered, while a room
// with a turn in flight or held by another surface is not.
//
// It never costs the user the open. A room mid-turn, locked, archived or
// unreadable is opened exactly as it is and catches up at a later open, and the
// reason is said once per room per process rather than on every connect.
const constitutionUpgradeOnOpenSaidFor = new Set<string>();

// Read once, when the server starts: an update restarts it.
const PERSISTENT_ROOM_INSTALLATION_SECTION = persistentAgentInstallationSection({
	version: readAppVersion(REPO_ROOT),
	developmentBuild: fs.existsSync(path.join(REPO_ROOT, ".git")),
});
// The note the next message of a conversation carries after its answer was
// cut or stopped, by room and conversation: the window that sends the next
// message may not be the one whose session ran the stopped answer.
const answerNotes = new Map<string, AnswerNote>();
// A keyed turn whose message the room offered back lands only once the page
// says it kept the message above (returned_prompt_handled), from whichever
// window answers; by room and conversation. A restart forgets it.
const pendingKeptLandings = new Map<string, (kept: boolean) => void>();
/** Under an answer that failed while nobody was in the room: some of it was written, or none. */
const AWAY_PARTIAL_SENTENCE = "This response could not be fully finished after you left the room. Send the message again if something is missing.";
const AWAY_FAILURE_SENTENCE = "The response could not be finished after you left the room. Send the message again to retry.";
/** The model is told the person declined the step because they sent a message instead. */
const DECLINED_FOR_MESSAGE_SENTENCE = "The person declined this step and sent a message instead.";
// The most messages one answer holds for its next step: it bounds what one socket can hold. Past it a message is refused, and the page sends it as the next turn.
const MAX_WAITING_STEERS = 20;
// The messages the last turn of a conversation took while it answered, or
// that the person took back out of it (`withdrawn`), by room and
// conversation, so a window that comes back (a reload, a second window)
// learns which of its messages are settled and keeps none of them, and puts
// back in the box one it asked to edit. The newest
// TAKEN_STEERS_KEPT only: it bounds what one conversation holds in memory.
const takenSteers = new Map<string, Array<{ id: string; withdrawn?: true }>>();
const TAKEN_STEERS_KEPT = 50;
// How long a message sent the moment an answer ended waits for that turn to close before the running-turn guard answers it.
const TURN_WINDING_DOWN_WAIT_MS = 1500;

/** The reason a room opened on its old constitution, said once per room per process. */
function noteConstitutionUpgradeSkippedOnOpen(agentId: string, reason: string): void {
	if (constitutionUpgradeOnOpenSaidFor.has(agentId)) return;
	constitutionUpgradeOnOpenSaidFor.add(agentId);
	app.log.warn({ agentId, reason }, "room opened without upgrading its constitution");
}

function upgradePersistentRoomConstitutionOnOpen(agentId: string): void {
	try {
		const instance = createPersistentAgentInstance(agentId);
		const meta = instance.readAgentJson();
		if (!meta) return;
		const l1a = instance.readL1a(meta);
		// A constitution with no template marker at all was not written by this
		// template — a hand-written file, an import, a shape from somewhere else.
		// It is nobody's to re-render silently. The marker's presence is read here
		// rather than taken from the plan, which reads a missing marker as the
		// first generation and would upgrade it.
		if (!/<!--\s*exxeta:persistent-agent:l1a\b/.test(l1a)) {
			noteConstitutionUpgradeSkippedOnOpen(agentId, "the constitution carries no template marker");
			return;
		}
		const marker = parsePersistentAgentL1aMarker(l1a);
		if (marker.templateVersion > PERSISTENT_AGENT_L1A_TEMPLATE_VERSION) {
			noteConstitutionUpgradeSkippedOnOpen(agentId, `the constitution is template v${marker.templateVersion}, newer than the v${PERSISTENT_AGENT_L1A_TEMPLATE_VERSION} this build writes`);
			return;
		}
		const plan = planPersistentAgentConstitutionUpgrade(agentId);
		// Silent on the ordinary path: a room already on the current template
		// opens without a word about it.
		if (plan.action !== "upgrade" || plan.toTemplateVersion !== PERSISTENT_AGENT_L1A_TEMPLATE_VERSION) return;
		const result = upgradePersistentAgentConstitution(agentId, { gate: "on-open" });
		if (result.upgradeId) {
			app.log.info({
				agentId,
				fromTemplateVersion: result.plan.fromTemplateVersion,
				toTemplateVersion: result.plan.toTemplateVersion,
				archivedL1a: result.archivedL1aRelPath,
				eventRecord: result.eventRecordRelPath,
			}, "room constitution upgraded on open");
		}
	} catch (error) {
		// The room opens either way: an upgrade refused because the room is
		// mid-turn or locked is a later open's job, and nothing here may cost
		// this one.
		noteConstitutionUpgradeSkippedOnOpen(agentId, (error as Error).message);
	}
}

const lastThreadItemId = (items: readonly unknown[]): string | null => {
	const last = items[items.length - 1] as any;
	return last ? (String(last.id ?? "") || null) : null;
};

const lastIndexOfItemId = (items: readonly unknown[], id: string): number => {
	for (let i = items.length - 1; i >= 0; i--) if (String((items[i] as any)?.id ?? "") === id) return i;
	return -1;
};

/** A turn's own prompt in the thread file: a message the room took while it answered (`steered`) is part of that turn, never a prompt of its own. */
function isPromptItem(item: unknown): boolean {
	return (item as any)?.kind === "user" && (item as any)?.steered !== true;
}

/**
 * Whether a turn may take the key its page named (thread-items-by-id.ts): a
 * key the conversation used before, or one an item of the file other than
 * the message itself carries, makes the turn old-style. A Try again adds no
 * message, so its key must be new to the file. A file that can't be read
 * says no.
 */
function keyFreeInConversation(agentId: string, threadId: string, key: string, continued: boolean): boolean {
	if (recentTurnKeys(agentId, threadId).includes(key)) return false;
	let items: unknown[];
	try {
		items = getPersistentAgentThread(agentId, threadId)?.items ?? [];
	} catch {
		return false;
	}
	return items.every((item) => {
		const id = String((item as any)?.id ?? "");
		if (keyOfId(id) === key) return false;
		return id !== key || (!continued && isPromptItem(item) && (item as any)?.landed !== true);
	});
}

/** What the next message needs to know of the last turn that had a prompt. */
type PromptTurnStart = { anchorItemId: string | null | undefined; earlierPromptsAfterAnchor: number; promptKept: boolean };

/**
 * How many prompts of earlier turns the thread file still lacks as a message
 * arrives: they will be saved after this turn's start anchor. The page saves
 * a message about half a second after it is sent, so a quick follow-up can
 * arrive before the previous turn's prompt is in the file. Read from the file
 * past the previous turn's anchor, so the count settles back to 0 as soon as
 * the saves catch up. A prompt handed back to the box is not expected there.
 */
function earlierPromptsAwaitingSave(items: readonly unknown[], previousTurn: PromptTurnStart | null): number {
	if (!previousTurn || previousTurn.anchorItemId === undefined) return 0;
	const startIndex = previousTurn.anchorItemId === null ? -1 : lastIndexOfItemId(items, previousTurn.anchorItemId);
	if (previousTurn.anchorItemId !== null && startIndex < 0) return 0;
	const savedSince = items.slice(startIndex + 1).filter(isPromptItem).length;
	return Math.max(0, previousTurn.earlierPromptsAfterAnchor + (previousTurn.promptKept ? 1 : 0) - savedSince);
}

/**
 * The last item in the thread file that belongs to earlier turns, read when a
 * turn lands or a page steps back into it: everything after it is the turn's
 * own and may be superseded. Past the start anchor the page saves the
 * earlier prompts it had not saved yet, then this turn's prompt, then this
 * turn's content, so this turn's prompt is the user item after those; with
 * none, nothing of this turn is saved yet. `earlierPromptsAfterAnchor` is
 * null for a continued turn, which has no prompt of its own; it and an
 * unknown or missing start anchor keep their own rule.
 */
function earlierTurnsAnchorItemId(items: readonly unknown[], startAnchorItemId: string | null | undefined, earlierPromptsAfterAnchor: number | null): string | null | undefined {
	if (earlierPromptsAfterAnchor === null || startAnchorItemId === undefined) return startAnchorItemId;
	const startIndex = startAnchorItemId === null ? -1 : lastIndexOfItemId(items, startAnchorItemId);
	if (startAnchorItemId !== null && startIndex < 0) return startAnchorItemId;
	let promptIndex = -1;
	let earlierPrompts = 0;
	for (let i = startIndex + 1; i < items.length && promptIndex < 0; i++) {
		if (!isPromptItem(items[i])) continue;
		if (earlierPrompts === earlierPromptsAfterAnchor) promptIndex = i;
		else earlierPrompts++;
	}
	const lastEarlierIndex = promptIndex >= 0 ? promptIndex - 1 : items.length - 1;
	if (lastEarlierIndex < 0) return null;
	return String((items[lastEarlierIndex] as any)?.id ?? "") || startAnchorItemId;
}

// No HEAD route: Fastify adds one for every GET, and the websocket plugin
// leaves it alone, so HEAD /ws would run this handler without a socket.
app.get("/ws", { websocket: true, exposeHeadRoute: false }, async (socket, req) => {
	const rawUrl = (req as any).url ?? (req as any).raw?.url ?? "";
	const params = new URLSearchParams(rawUrl.split("?")[1] ?? "");
	const conversationId = safeConversationId(params.get("conversationId") || "");
	const persistentAgentIdRaw = String(params.get("persistentAgentId") ?? "").trim();
	const isPersistentAgentSession = Boolean(persistentAgentIdRaw);
	if (!isPersistentAgentSession) {
		// The web UI is rooms-only. It still opens a bare socket from Home before
		// a room is picked; keep that connection as an inert no-op session so the
		// UI's connection indicator works, but never create an agent session.
		socket.on("message", (raw: Buffer) => {
			let msg: any;
			try { msg = JSON.parse(raw.toString()); } catch { return; }
			if (msg?.type === "prompt") {
				try { socket.send(JSON.stringify({ type: "error", message: "This server only hosts persistent-agent rooms. Open a room to chat." })); } catch {}
			}
		});
		return;
	}
	// The socket is open from the upgrade onward, but this handler binds the
	// session before it can attach the real message listener below, and a
	// client is entitled to send its first frame the moment the socket opens.
	// Anything arriving in that window would reach a socket with no listener
	// and be dropped without a trace: no error, no log, and a client waiting
	// forever for an answer to a message the server never saw. So the window
	// is covered from the first synchronous line — early frames are held and
	// replayed in order once the listener exists. The hold is bounded because
	// a client that floods the window must not be able to grow this queue
	// without limit; past the bound the connection is refused outright rather
	// than half-answered.
	const framesBeforeListener: Buffer[] = [];
	let framesBeforeListenerOverflowed = false;
	const holdFrameUntilListener = (raw: Buffer) => {
		if (framesBeforeListener.length >= 64) { framesBeforeListenerOverflowed = true; return; }
		framesBeforeListener.push(raw);
	};
	socket.on("message", holdFrameUntilListener);

	const status = getUsablePersistentAgentStatusForNormalUse(persistentAgentIdRaw);
	try {
		assertPersistentAgentAcceptsSession(status);
	} catch (error) {
		// A room holding as many remembered conversations as it can: a bare close
		// reads as a lost connection and the client redials into the same refusal.
		// A coded frame lets it stand down and name the way out. A room hidden
		// from a remote device still fails as a missing room does, below.
		const entries = status.recentContext?.fullEntries ?? 0;
		const roomFull = status.exists && (status.status === "ready" || status.status === "needs_absorb") && entries >= RECENT_CONTEXT_BLOCK_CAP;
		const hiddenFromDevice = !!(req as any).exxRemoteDevice && remoteRoomExposure.isHidden(status.id);
		if (!roomFull || hiddenFromDevice) throw error;
		const message = `${status.displayName || "This room"} holds ${entries} remembered conversations, as many as it can. Memorize them from Maintain on its Home card to start a new conversation.`;
		try { socket.send(JSON.stringify({ type: "error", code: "room_full", message })); } catch {}
		socket.close();
		return;
	}
	// Remote devices: a hidden room's socket fails exactly like a
	// nonexistent room's (same thrown shape as the unknown-room path above),
	// and capability is re-derived from the device record at attach, with
	// anything that is not exactly "full" treated as read-only.
	const remoteDeviceForSession = (req as any).exxRemoteDevice as { id: string; capability?: string } | undefined;
	if (remoteDeviceForSession && remoteRoomExposure.isHidden(status.id)) {
		const hiddenError = new Error(`persistent agent not found: ${status.id}`);
		(hiddenError as any).statusCode = 404;
		throw hiddenError;
	}
	const remoteReadOnlySession = Boolean(remoteDeviceForSession && remoteDeviceForSession.capability !== "full");
	if (remoteReadOnlySession) {
		// Attached synchronously, before any session setup can stall or fail:
		// a read-only device's frames are refused from the first byte, and the
		// refusal does not depend on the room session coming up (the socket
		// stays open as an observer for server-pushed events). The main
		// message handler below additionally drops these frames silently, so
		// the held-frame replay cannot act on them either.
		socket.on("message", () => {
			try { socket.send(JSON.stringify({ type: "error", message: "This device is set to viewing only. Change it on the computer to interact remotely.", code: "remote_read_only" })); } catch {}
		});
	}
	const persistentAgentIdForSession = status.id;
	const promptDiagnosticsEnabledForConnection = isPromptDiagnosticsEnabled() && isLocalPromptDiagnosticsRequest(req);
	const persistentConversationId = conversationId ?? `local_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
	let persistentAgentThreadForSession: ReturnType<typeof getPersistentAgentThread> = null;
	let persistentAgentThreadLoadError: Error | null = null;
	let persistentRoomRestoredLiveThreadContext: ReturnType<typeof buildPersistentRoomRestoredLiveThreadContext> = null;
	try {
		persistentAgentThreadForSession = getPersistentAgentThread(persistentAgentIdForSession, persistentConversationId);
		if (persistentAgentThreadForSession?.runtime.kind === "transcript-recap-v1") {
			// Restoring happens as a session binds, so a turn in flight here means
			// one adopted from another connection. Only then is a streaming mark
			// describing something genuinely still being written.
			const turnAtRestore = getPersistentAgentActiveTurnState(persistentAgentIdForSession, persistentConversationId);
			persistentRoomRestoredLiveThreadContext = buildPersistentRoomRestoredLiveThreadContext(
				persistentAgentThreadForSession.items ?? [],
				turnAtRestore.state === "running" || turnAtRestore.state === "cancelling",
			);
		}
	} catch (error) {
		persistentAgentThreadLoadError = error instanceof Error ? error : new Error(String(error));
	}
	let persistentRoomRestoredLiveThreadPending = Boolean(persistentRoomRestoredLiveThreadContext);
	// Web is the business/user workspace. Coding/filesystem/shell work is CLI-only.
	const persona = "business";
	process.env.EXXETA_PERSONA = persona;

	const connectionId = `ws_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
	// Wire-level trace of this conversation (EXXETA_STREAM_TRACE=1): the
	// evidence recorder for streaming bugs that only reproduce against real
	// providers. See stream-trace.ts for what is (and is not) written.
	const streamTrace = createStreamTrace({ agentId: persistentAgentIdForSession, conversationId: persistentConversationId, connectionId });

	// Advisory lock: a persistent room may be driven from only one place at a
	// time (web vs CLI), so the shared thread file is not clobbered. If the room
	// is already active elsewhere, refuse this connection with a clear message.
	const roomLockOwner = { surface: "web", connectionId, pid: process.pid, label: persistentAgentIdForSession };
	let roomLockHeartbeat: ReturnType<typeof setInterval> | null = null;
	const releaseRoomLockNow = () => {
		if (roomLockHeartbeat) { clearInterval(roomLockHeartbeat); roomLockHeartbeat = null; }
		try { roomLock.release(persistentAgentIdForSession, roomLockOwner); } catch {}
	};
	// The detached cooking turn this connection stepped back into.
	// Claimed synchronously below (before any await), adopted once the session
	// is bound. Null on the ordinary connect path.
	let claimedCookingTurn: DetachedCookingTurnHandle | null = null;
	// Reattach is OPT-IN, declared by the client on the connect URL. A client
	// that does not declare it (an older bundle in a stale tab) would ignore
	// turn_reattach, double-render the replay under its persisted partial and
	// then PERSIST the duplicated transcript over the clean landing write; such
	// clients keep the older room_cooking bounce they understand.
	const clientSupportsReattach = params.get("reattach") === "1";
	{
		// A detached turn still cooking for THIS conversation no longer bounces
		// the connection: the session claims it here and adopts it
		// after binding, so the user steps back into the answer being written.
		// The lock acquire below is then the ordinary web-over-web takeover;
		// the detaching connection's release and heartbeat are owner-checked,
		// so they go inert the moment the lock record changes hands.
		const cookingHandle = detachedCookingTurnHandles.get(persistentAgentIdForSession) ?? null;
		const roomHasCookingTurn = !!(cookingHandle && !cookingHandle.settled);
		if (roomHasCookingTurn && cookingHandle.conversationId === persistentConversationId && clientSupportsReattach && !cookingHandle.replayUnavailable()) {
			claimedCookingTurn = cookingHandle;
		} else if (roomHasCookingTurn || detachedCookingRooms.has(persistentAgentIdForSession)) {
			// A cooking room asked for under a DIFFERENT conversation id (stale
			// client state): reattach cannot bind that thread, so the honest
			// refusal stays. Keyed on the HANDLE, not only the cooking set:
			// adopt() clears the set while an adopter watches, and without this
			// room-level key a stale-conversation connection would sail past the
			// bounce into a web-over-web lock takeover, stealing the cooking
			// turn's lock mid-stream. `code` is the client's detach-vs-death
			// signal: the original drop delivers nothing (the network is gone),
			// so the signal rides on this reconnect bounce.
			try { socket.send(JSON.stringify({ type: "error", code: "room_cooking", message: "This room is currently finishing a response in the background. The answer is saved into the conversation when it is done; open the room again then." })); } catch {}
			try { socket.close(); } catch {}
			return;
		}
		// The last moment the constitution can be re-rendered for this open: the
		// upgrade refuses while the lock is held, and the boot prompt below is
		// built from the file this leaves behind.
		upgradePersistentRoomConstitutionOnOpen(persistentAgentIdForSession);
		const acquired = roomLock.tryAcquire(persistentAgentIdForSession, roomLockOwner);
		if (!acquired.ok) {
			claimedCookingTurn = null;
			const busyStatus = roomLockBusyStatus(acquired.heldBy);
			const instruction = roomLockBusyInstruction(acquired.heldBy);
			const since = acquired.heldBy ? new Date(acquired.heldBy.acquiredAt).toLocaleTimeString() : "";
			try { socket.send(JSON.stringify({ type: "error", message: `This room is currently ${busyStatus}${since ? ` (since ${since})` : ""}. ${instruction}` })); } catch {}
			try { socket.close(); } catch {}
			return;
		}
		// The cooking turn's lock record is this connection's now: register who
		// releases it, so the settle path can free it even if this connection
		// dies before the adopt, and how to tell this connection if a NEWER
		// claim displaces it while it is still binding (the adopt upgrades the
		// hook to the adopter flavor). A displaced mid-bind claimant has no
		// lock, no heartbeat and a pre-landing thread snapshot, so the only
		// coherent outcome is the honest frame and a close; raw socket.send
		// because the closure's `send` is declared later in this scope.
		claimedCookingTurn?.claim(connectionId, releaseRoomLockNow, () => {
			claimedCookingTurn = null;
			try { socket.send(JSON.stringify({ type: "error", code: "room_displaced", message: "This room is now open in another window." })); } catch {}
			try { socket.close(); } catch {}
		});
		roomLockHeartbeat = setInterval(() => roomLock.heartbeat(persistentAgentIdForSession, roomLockOwner), 30_000);
		// A session is binding to this room: whatever landed unseen in THIS
		// conversation is about to be seen in the transcript, so its marker's
		// job is done (the away-notice clear). A badge
		// for an answer waiting in another conversation of this room survives a
		// bind that never opens it.
		try { clearPersistentAgentUnseenLandedAnswerForBind(persistentAgentIdForSession, persistentConversationId); } catch {}
		// Register release immediately so the lock is freed even if later session
		// setup throws or the connection drops before the main close handler.
		// A turn detached by the disconnect keeps the lock — the
		// heartbeat keeps running and the prompt handler releases after the
		// finished answer lands in the thread file.
		socket.on("close", () => {
			if (turnKeepsCookingOnClose()) return;
			// Leaving (or dying) while a claimed cooking turn is still in
			// flight re-detaches it. The lock this connection took over stays
			// held for the cooking turn (this closure's heartbeat keeps it
			// fresh); the settle path releases it through the handle's claim.
			const cooking = claimedCookingTurn;
			if (cooking && !cooking.settled && cooking.claimantConnectionId === connectionId) {
				cooking.redetach(connectionId);
				return;
			}
			releaseRoomLockNow();
		});
	}

	// Rooms are single-owner: the persistent agent itself.
	const activeOwner = persistentAgentIdForSession;

	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | null = null;
	type PersistentWebTurnTerminalReason = "completed" | "cancelled" | "failed" | "disconnect_cancelled";
	type ActivePersistentWebTurn = {
		turnId: string;
		/** When the turn began (epoch ms), from the active-turn record. */
		startedAt?: number;
		terminalReason?: PersistentWebTurnTerminalReason;
		abortPromise?: Promise<void>;
		promptSettled: boolean;
		/** Set when a server stop ended the turn: its end events carry it, and a landing after its person left uses the cut answer's sentence. */
		stoppedByServer?: true;
		/** Set when the person's message cut the turn rather than their Stop. */
		stoppedForNext?: true;
		/** How many characters of the answer being written the page had shown at the cut or the Stop. */
		shownAtStop?: number;
		/** Set when an away limit stopped the turn while nobody was in the room: its line names the limit. */
		awayLimit?: AwayLimit;
	};
	let activePersistentWebTurn: ActivePersistentWebTurn | null = null;
	// From a turn's end until the prompt handler records its finish: a
	// message the page sends the moment the answer ended (the next one after a
	// cut) waits for that finish instead of being refused as a running turn.
	let turnWindingDown: { turnId: string; done: Promise<void>; finish: () => void } | null = null;
	const windingDownOfThisTurn = (): Promise<void> | undefined => (turnWindingDown && activePersistentWebTurn?.turnId === turnWindingDown.turnId ? turnWindingDown.done : undefined);
	// What a message or consult sent the moment an answer ended waits for: that turn winding down. A turn this window adopted winds down in the closure that runs it.
	const windingDownForThisWindow = (): Promise<void> | undefined => {
		const cooking = claimedCookingTurn;
		return windingDownOfThisTurn() ?? (cooking && !cooking.settled && cooking.claimantConnectionId === connectionId ? cooking.windingDown() : undefined);
	};
	// Detach instead of abort: a disconnect while a turn is in
	// flight no longer cancels it. All close handlers consult this predicate in
	// the same tick, so the lock listener, the live-session listener and the
	// main close handler agree on the same answer. A turn the user already
	// stopped (terminalReason set by the abort frame) is NOT detached — the
	// user asked for cancellation, the disconnect merely raced it.
	const turnKeepsCookingOnClose = (): boolean => !!(activePersistentWebTurn && !activePersistentWebTurn.promptSettled && !activePersistentWebTurn.terminalReason);
	// Set once the close handler decides to detach; from then on the prompt
	// handler owns landing the finished answer, releasing the room lock and
	// disposing the session.
	let detachedFromClient = false;
	// Set when the client left during a server stop after the answer had ended,
	// while the runtime's post-turn work still ran: the person watched it end.
	let leftAfterAnswerEndedInStop = false;
	// Post-stream tail: thread answers are client-
	// authored and the debounced persist rearms on every reveal tick, so the
	// first write carrying the answer lands ~500ms after the LAST tick. A turn
	// that settled "completed" therefore has a window where the finished answer
	// exists only client-side. This snapshot, taken at settle (after
	// finishPersistentAgentTurn, preserving the no-turn-in-flight write order),
	// is what the close handler needs to land the answer server-side when the
	// client dies inside that window. Per-connection closure state, cleared
	// when the next turn begins; error/cancel settles never set it, except a
	// turn a server stop ended, which sets it for its partial and marks it
	// `stoppedByServer`, so the partial lands as cut.
	// `startedAt` and `settledAt` stamp the landed items with the turn's own
	// times, not the moment the close handler ran.
	type SettledTurnLandingSnapshot = { turnId: string; finalAssistantText: string; anchorItemId: string | null | undefined; earlierPromptsAfterAnchor: number | null; userText: string; startedAt?: number; settledAt: number; stepLog?: ReturnType<typeof createTurnStepLog>; stoppedByServer?: true };
	let settledTurnLandingSnapshot: SettledTurnLandingSnapshot | null = null;
	// The turn's user-authored prompt text, kept through settle: the landing
	// may still need it to restore a never-persisted user item.
	let currentTurnUserTextForLanding = "";
	// The reattach handle THIS connection registered when its turn
	// detached, plus the hooks the adopting connection registered on it. All
	// null until a detach happens; the handle methods run in this closure.
	let detachedCookingHandle: DetachedCookingTurnHandle | null = null;
	// The last item the detached landing wrote of its own, for the adopter's next message (DetachedCookingTurnHandle.landedItemId).
	let landedThroughItemId: string | undefined;
	let adopterReleaseLock: (() => void) | null = null;
	let adopterOnSettled: (() => void) | null = null;
	let adopterOnDisplaced: (() => void) | null = null;
	// The last persisted thread item when the CURRENT turn began: the landing
	// and a reattach supersede start after it (or after an earlier answer the
	// page saved later, earlierTurnsAnchorItemId), so they can never delete a
	// completed prior answer. Null means the thread was empty at turn start;
	// undefined means the read failed.
	let turnStartAnchorItemId: string | null | undefined = undefined;
	// Prompts of earlier turns the file still lacked then (null: a continued
	// turn), and the last prompt turn's start, which the next message reads.
	let turnStartEarlierPrompts: number | null = null;
	let lastPromptTurnStart: PromptTurnStart | null = null;
	// While the turn cooks detached and a NEW connection adopted it, turn
	// frames are forwarded there instead of this (closed) socket.
	let cookingTurnSink: ((frame: string) => void) | null = null;
	// Every frame belonging to the CURRENT turn, recorded from turn start, so a
	// session that steps back in mid-turn replays the whole stream and then
	// continues live with no gap and no duplicated text at the seam. Reset when
	// a prompt begins and CLEARED at settle (review: an idle tab must not
	// retain its last turn's stream) with one exception: a claimant mid-bind
	// still needs it for the settled replay, and releases it after replaying.
	// Byte-capped: overflow frees the buffer and marks the turn
	// replay-unavailable, so a reattach degrades to the honest bounce instead
	// of a truncated replay.
	let turnFrameBuffer: string[] = [];
	let turnFrameBufferBytes = 0;
	let turnReplayOverflowed = false;
	// Every turn frame carries `seq`, counting up from 1 per turn, so a page
	// can drop a frame it has already applied.
	let turnFrameSeq = 0;
	const updateReattachBufferProbe = (): void => {
		if (TEST_INTROSPECTION_ENABLED) reattachBufferProbe.set(persistentAgentIdForSession, { frames: turnFrameBuffer.length, bytes: turnFrameBufferBytes, overflowed: turnReplayOverflowed });
	};
	const releaseTurnFrameBuffer = (): void => {
		turnFrameBuffer = [];
		turnFrameBufferBytes = 0;
		updateReattachBufferProbe();
	};
	// How the current turn is going, for the away limits: its last runtime
	// event and the local tools it runs now. Every event of the turn updates
	// it, watched or not; the tools are forgotten when a turn begins, so a tool
	// whose end an earlier turn never saw cannot hold the clock.
	const turnProgress = { lastEventAt: 0, toolsRunning: new Set<string>() };
	const noteTurnProgress = (event: { type?: string; toolCallId?: string } | undefined): void => {
		turnProgress.lastEventAt = Date.now();
		if (event?.type === "tool_execution_start" && event.toolCallId) turnProgress.toolsRunning.add(event.toolCallId);
		else if (event?.type === "tool_execution_end" && event.toolCallId) turnProgress.toolsRunning.delete(event.toolCallId);
	};
	// Armed by the close handler when the turn detaches, cleared when someone
	// steps back in or the turn settles. One pair per connection, and a room
	// cooks on exactly one connection, so several cooking rooms each carry
	// their own limits.
	let awaySilenceTimer: ReturnType<typeof setTimeout> | null = null;
	let awayTotalTimer: ReturnType<typeof setTimeout> | null = null;
	const clearAwayLimits = (): void => {
		if (awaySilenceTimer) { clearTimeout(awaySilenceTimer); awaySilenceTimer = null; }
		if (awayTotalTimer) { clearTimeout(awayTotalTimer); awayTotalTimer = null; }
	};
	// Past a limit the turn is aborted the way a user stop aborts it, with
	// terminal reason `failed`, so the landing write parks what it finished
	// under the limit's line, and the settle path releases the lock and
	// disposes the session. A timer that lost the race against a normal settle
	// or a stop finds the turn ended and does nothing.
	const stopForAwayLimit = (turnId: string | undefined, limit: AwayLimit): void => {
		const turn = activePersistentWebTurn;
		if (!turn || turn.turnId !== turnId || turn.promptSettled || turn.terminalReason) return;
		turn.awayLimit = limit;
		app.log.warn({ agentId: persistentAgentIdForSession, turnId, limit, silenceMs: DETACHED_TURN_SILENCE_MS, limitMs: DETACHED_TURN_LIMIT_MS }, "detached turn reached an away limit; aborting");
		void abortActivePersistentWebTurn("failed").catch((error) => {
			app.log.warn({ err: error }, "away-limit abort failed");
		});
	};
	// Factored out so a reattach that leaves again re-arms them. Both clocks
	// start at each leave, since they bound the work done on its own: time
	// someone watched was theirs to stop. The silence timer wakes when the
	// window could have passed and looks again: events only stamp a time, so a
	// stream of deltas never re-arms a timer.
	const armAwayLimits = (): void => {
		const turnId = activePersistentWebTurn?.turnId;
		const leftAt = Date.now();
		clearAwayLimits();
		const checkSilence = (): void => {
			const quietFor = Date.now() - Math.max(turnProgress.lastEventAt, leftAt);
			if (turnProgress.toolsRunning.size > 0 || quietFor < DETACHED_TURN_SILENCE_MS) {
				awaySilenceTimer = setTimeout(checkSilence, turnProgress.toolsRunning.size > 0 ? DETACHED_TURN_SILENCE_MS : DETACHED_TURN_SILENCE_MS - quietFor);
				return;
			}
			awaySilenceTimer = null;
			stopForAwayLimit(turnId, "no-progress");
		};
		awaySilenceTimer = setTimeout(checkSilence, DETACHED_TURN_SILENCE_MS);
		awayTotalTimer = setTimeout(() => {
			awayTotalTimer = null;
			stopForAwayLimit(turnId, "time-limit");
		}, DETACHED_TURN_LIMIT_MS);
	};
	// One consult at a time per connection (v1). The consult worker is
	// independent of the room's turn machinery: prompts stay allowed while a
	// consult runs; starting a consult while a turn is in flight is rejected.
	type ActiveWebConsult = { consultId: string; abortController: AbortController; stoppedByUser: boolean };
	let activeWebConsult: ActiveWebConsult | null = null;
	let sessionDisposed = false;
	let autoSummaryRunning = false;
	// The workspace policy this connection's session was built against. The
	// prompt handler compares it to the LIVE effective policy before starting a
	// turn: a mismatch (workspace default changed since bind) rebinds the
	// session, so the next message runs with the current tools instead of the
	// tool set frozen at connect.
	let boundWorkspaceFingerprint: string | null = null;
	// Same discipline for per-room MCP grants: enforcement is per-call inside
	// the room-scope wrapper (always live), but the proxy tool's DESCRIPTION is
	// built at bind time - a grant change rebinds before the next turn so what
	// the model sees in its manifest matches what it may call.
	let boundMcpGrantsFingerprint: string | null = null;
	// And the same discipline for native provider search. Whether the room's own
	// web_search tool is registered is decided when the session binds, because
	// both providers' server-side search is itself called web_search and the two
	// cannot both be on the request. So a change to the setting has to rebuild
	// the session before the next turn, exactly like a workspace or grant
	// change, or the room would keep whichever tool set it happened to bind.
	let boundNativeProviderSearch: boolean | null = null;
	/** The provider the live session bound against, so the check above compares the setting and not the model. */
	let boundSessionProviderId: string | null = null;
	// The single in-flight rebind: while a rebind runs, `session` is null and
	// every frame that needs the session awaits THIS promise instead of racing
	// past the guards onto the disposed session with the old toolset.
	let workspaceRebindInFlight: Promise<void> | null = null;
	type PromptDiagnosticsPendingTurn = {
		turnId: string;
		turnOrdinal: number;
		promptSource: string;
		activeOwner: string;
		preStartSystemPrompt: string;
		model: PromptDiagnosticsModel;
		relatedManifestId?: string;
		components: RedactedPromptComponent[];
	};
	let promptDiagnosticsTurnOrdinal = 0;
	let promptDiagnosticsCurrentModel: PromptDiagnosticsModel | undefined;
	let promptDiagnosticsPendingTurn: PromptDiagnosticsPendingTurn | undefined;
	let turnTrace: {
		toolCalls: { id?: string; name: string; args: any }[];
		toolResults: { name: string; text: string; isError: boolean }[];
		toolNameById: Map<string, string>;
		sawToolResult: boolean;
		sawAssistantAfterToolResult: boolean;
		usedRetrievalTools: boolean;
		finalAssistantText: string;
		/** The answer's text before a failed attempt the runtime is asking again. */
		retryFrom?: string;
	} = { toolCalls: [], toolResults: [], toolNameById: new Map(), sawToolResult: false, sawAssistantAfterToolResult: false, usedRetrievalTools: false, finalAssistantText: "" };
	// Kept apart from the trace, which the tool-turn recovery resets before a landing reads it.
	let turnSteps = createTurnStepLog();
	// The current or last turn the page named (thread-items-by-id.ts): its
	// key, its question as the bubble shows it, and where its first item
	// goes. Null after a turn without a key.
	// `editLine`: the not-undone line of an edit, which the landing puts before its message.
	type KeyedTurn = { key: string; continued: boolean; shown?: ShownPrompt; strippedText: string; startAnchorId: string | null | undefined; startedAt?: number; steps: ReturnType<typeof createTurnStepLog>; editLine?: NotUndoneLine };
	let keyedTurn: KeyedTurn | null = null;

	// Skills MR-5 telemetry (spec §5): bodies read via read_skill, surfaced per
	// turn. Mutated by the tool, reported + reset when the next turn's trace opens.
	const persistentRoomSkillTelemetry = { reads: 0, bodyChars: 0 };
	// The condense-failure notice is said once per turn (a turn may attempt twice).
	let lastCompactionNoticeCause: string | undefined;
	// The runtime's own overflow recovery (shorten, then ask again) ends after the turn does; true when it will ask again,
	// or when the turn was left, stopped or waited too long while it ran: the message then stays where it is.
	let overflowRecovery: Promise<boolean> | undefined;
	let endOverflowRecovery: ((askAgain: boolean) => void) | undefined;
	// The person stopped or left during the shortening: its cancelled end says nothing.
	let overflowRecoveryStopped = false;
	// Ends the wait and the runtime's shortening with it, so the runtime never asks the model again behind a freed conversation.
	const stopOverflowRecovery = (quiet: boolean): void => {
		if (!endOverflowRecovery) return;
		overflowRecoveryStopped = quiet;
		endOverflowRecovery(true);
		endOverflowRecovery = undefined;
		try { (session as any)?.abortCompaction?.(); } catch (error) { app.log.warn({ err: error }, "stopping the overflow shortening failed"); }
	};
	// A spent quota's retry is stopped after the runtime let the failed attempt go from its list: the turn still ended failed.
	let stoppedForQuota = false;
	const resetTurnTrace = () => {
		lastCompactionNoticeCause = undefined;
		overflowRecovery = undefined;
		stoppedForQuota = false;
		if (persistentRoomSkillTelemetry.reads > 0) {
			app.log.info({ agentId: persistentAgentIdForSession, skillReads: persistentRoomSkillTelemetry.reads, skillBodyChars: persistentRoomSkillTelemetry.bodyChars }, "persistent-room turn read skill bodies");
			streamTrace.note("skill_reads", { reads: persistentRoomSkillTelemetry.reads, bodyChars: persistentRoomSkillTelemetry.bodyChars });
			persistentRoomSkillTelemetry.reads = 0;
			persistentRoomSkillTelemetry.bodyChars = 0;
		}
		turnTrace = { toolCalls: [], toolResults: [], toolNameById: new Map(), sawToolResult: false, sawAssistantAfterToolResult: false, usedRetrievalTools: false, finalAssistantText: "" };
	};

	const textFromParts = (content: any): string => {
		if (!Array.isArray(content)) return "";
		return content.filter((c: any) => c?.type === "text" && typeof c.text === "string").map((c: any) => c.text).join("\n").trim();
	};

	const argPreview = (args: any): string => {
		try {
			const s = JSON.stringify(args ?? {});
			return s.length > 260 ? s.slice(0, 257) + "…" : s;
		} catch {
			return String(args ?? "").slice(0, 260);
		}
	};

	const resultPreview = (s: string, max = 500): string => {
		const clean = s.replace(/\s+/g, " ").trim();
		return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
	};
	const withPersistentRoomRestoredLiveThreadContext = (prompt: string): string => {
		if (!persistentRoomRestoredLiveThreadPending || !persistentRoomRestoredLiveThreadContext) return prompt;
		persistentRoomRestoredLiveThreadPending = false;
		const block = persistentRoomRestoredLiveThreadContext.block;
		const pending = promptDiagnosticsPendingTurn;
		if (promptDiagnosticsEnabledForConnection && pending) {
			try {
				pending.components.push(componentFromText({
					id: `persistent-room:${safeDiagnosticIdPart(pending.turnId)}:restored-live-thread-context`,
					type: "restored-live-thread-context",
					text: block,
					source: { "function": "withPersistentRoomRestoredLiveThreadContext" },
					metadata: {
						phase: "restored_live_thread_context",
						...persistentRoomRestoredLiveThreadContext.metadata,
						firstPromptOnly: true,
						durability: "uncheckpointed_thread_context_not_l1b_memory",
					},
				}));
			} catch (error) {
				app.log.warn({ err: error }, "failed to record persistent-room restored live-thread context diagnostics");
			}
		}
		return [
			block,
			"",
			prompt,
		].join("\n");
	};
	const isRetrievalTool = (name: string): boolean =>
		name.startsWith("kb_") || name.startsWith("graph_") || name.startsWith("memory_");
	const flushSessionEvents = () => new Promise<void>((resolve) => setTimeout(resolve, 25));
	// Only what ended the turn by the time its last frame goes out. Whether a model call's failure ends the turn is
	// decided after the prompt returns (overflow recovery, the step-back), so a failed call is told by its own `failure`.
	const turnEndedByOf = (turn: ActivePersistentWebTurn | null): TurnEndedBy | null => {
		if (!turn) return null;
		if (turn.stoppedByServer) return "server-stop";
		return turn.terminalReason === "cancelled" ? (turn.stoppedForNext ? "next" : "stop") : turn.terminalReason === "disconnect_cancelled" ? "left" : turn.terminalReason === "failed" ? "failed" : null;
	};
	const setActivePersistentWebTurnTerminalReason = (reason: PersistentWebTurnTerminalReason): void => {
		const turn = activePersistentWebTurn;
		if (!turn || turn.terminalReason) return;
		turn.terminalReason = reason;
	};
	const abortActivePersistentWebTurn = (reason: "cancelled" | "disconnect_cancelled" | "failed" = "cancelled"): Promise<void> => {
		const turn = activePersistentWebTurn;
		const sessionToAbort = session;
		if (!sessionToAbort) return Promise.resolve();
		if (!turn) {
			return Promise.resolve((sessionToAbort as any).abort?.()).then(() => undefined);
		}
		setActivePersistentWebTurnTerminalReason(reason);
		// The person's Stop answers the card the turn waits on; otherwise the
		// abort below would wait for that answer forever.
		if (reason === "cancelled") uiContext.declineOpenQuestions(STOPPED_BEFORE_ANSWER_SENTENCE);
		stopOverflowRecovery(true);
		try { markPersistentAgentTurnCancelling(persistentAgentIdForSession, persistentConversationId, reason); } catch (error) { app.log.warn({ err: error }, "failed to mark persistent-room turn cancelling"); }
		if (!turn.abortPromise) {
			turn.abortPromise = (async () => {
				try {
					await (sessionToAbort as any).abort?.();
					await flushSessionEvents();
				} catch (error) {
					app.log.warn({ err: error }, "persistent-room abort failed");
				}
			})();
		}
		return turn.abortPromise;
	};
	// Before the abort sets the turn's reason: a turn that already ended keeps what ended it.
	const markStop = (forNext: boolean, shown: number | undefined): void => {
		const turn = activePersistentWebTurn;
		if (!turn || turn.terminalReason) return;
		if (forNext) turn.stoppedForNext = true;
		if (shown !== undefined) turn.shownAtStop = shown;
	};
	// A message's text as the page counts it while it reveals: as written, untrimmed and unjoined.
	const revealedTextOf = (content: unknown): string => Array.isArray(content) ? content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("") : "";
	const answerNoteKey = (): string => `${persistentAgentIdForSession}\u0000${persistentConversationId}`;
	// What the person saw of an answer their cut or Stop ended, for the next message; any other end leaves no note.
	const keepAnswerNote = (turn: ActivePersistentWebTurn | null): void => {
		const key = answerNoteKey();
		answerNotes.delete(key);
		// A Stop that names no count says nothing about what was on screen, so it tells the model nothing.
		if (!turn || turn.terminalReason !== "cancelled" || turn.stoppedByServer || turn.shownAtStop === undefined || !session) return;
		const last = session.agent.state.messages.at(-1) as { role?: string; stopReason?: string; content?: unknown } | undefined;
		if (last?.role !== "assistant" || last.stopReason !== "aborted") return;
		const shown = shownPart(revealedTextOf(last.content), turn.shownAtStop);
		if (shown) answerNotes.set(key, { kind: turn.stoppedForNext ? "cut" : "stop", shown });
	};
	// Stop after the model finished, while the page still showed the rest: the landing that guards the answer
	// against a lost save keeps only the words shown, and the next message tells the model what the person saw.
	const applyRevealCut = (shownChars: number): void => {
		const last = session?.agent.state.messages.at(-1) as { role?: string; content?: unknown } | undefined;
		if (last?.role !== "assistant" || !Array.isArray(last.content)) return;
		const text = revealedTextOf(last.content);
		const shown = shownPart(text, shownChars);
		if (shown === text.trim()) return;
		// The landing holds every text of the turn, the last one at its end, joined as the turn trace joins it: only that one is cut, what the turn wrote before its steps stays.
		const snapshot = settledTurnLandingSnapshot;
		const stopped = textFromParts(last.content).trim();
		if (snapshot && stopped && snapshot.finalAssistantText.endsWith(stopped)) {
			const kept = `${snapshot.finalAssistantText.slice(0, snapshot.finalAssistantText.length - stopped.length)}${shown}`.trim();
			// Nothing of the answer left: the landing still guards the turn's prompt and steps, with no answer.
			settledTurnLandingSnapshot = { ...snapshot, finalAssistantText: kept };
		}
		if (shown) answerNotes.set(answerNoteKey(), { kind: "stop", shown });
	};
	// The page's turn can end before the server's settles: the cut then waits for the settle.
	let revealCutAtSettle: number | undefined;
	const stopReveal = (shownChars: number | undefined): void => {
		if (!session || shownChars === undefined) return;
		if (activePersistentWebTurn) {
			revealCutAtSettle = shownChars;
			return;
		}
		// A keyed last turn already landed: its last message's parts are cut where they lie.
		if (keyedTurn && keyedTurn.steps === turnSteps) for (const cut of keyedTurn.steps.cutLastMessage(shownChars)) cutLandedPart(cut.id, cut.kept);
		applyRevealCut(shownChars);
	};
	/**
	 * Stop on a part that already landed: an accepted cut, written now and by
	 * every later write of the conversation until one carries it (a write
	 * refused while a turn runs leaves it for that turn's landing). Only the
	 * newest turn's parts: a late Stop never shortens an older answer.
	 */
	const cutLandedPart = (partId: string, kept: number): string | undefined => {
		const key = keyOfId(partId);
		if (!key || key !== latestTurnKey(persistentAgentIdForSession, persistentConversationId)) return undefined;
		acceptAnswerCut(persistentAgentIdForSession, persistentConversationId, partId, kept);
		let words: string | undefined;
		try {
			const current = getPersistentAgentThread(persistentAgentIdForSession, persistentConversationId);
			if (!current || current.state === "closed") return undefined;
			// The words the cut keeps, for the next message's note.
			const part = (current.items ?? []).find((item: any) => item?.kind === "assistant" && item.id === partId) as ThreadItem | undefined;
			if (part) {
				const cut = cutAnswerPart(part, kept);
				words = String(cut.text).slice(0, Number(cut.stoppedAt));
			}
			writePersistentAgentThread(persistentAgentIdForSession, persistentConversationId, { state: current.state, origin: current.origin, model: current.model, items: current.items ?? [] }, { allowInactiveProfileModel: true, keepRuntimeIfMoved: true });
		} catch (error) {
			app.log.warn({ err: error }, "a Stop's cut waits for the conversation's next write");
		}
		return words;
	};
	// A Stop on a part of the turn still settling: its note waits for the settle, which would drop a note set before it.
	let partRevealNoteAtSettle: string | undefined;
	/** Stop after the answer ended, on the part the page still revealed: the running turn cuts its own log, a landed part is cut in the file. `shown` counts that part's saved text. */
	const stopRevealPart = (partId: string, shown: number): void => {
		const running = !!activePersistentWebTurn && !!keyedTurn && keyedTurn.steps === turnSteps && keyOfId(partId) === keyedTurn.key;
		const keptRunning = running ? keyedTurn!.steps.cutNamedPart(partId, shown) : undefined;
		if (keptRunning !== undefined) {
			partRevealNoteAtSettle = keptRunning;
			return;
		}
		// The next message tells the model what the person saw of the answer.
		const kept = cutLandedPart(partId, shown);
		if (kept) answerNotes.set(answerNoteKey(), { kind: "stop", shown: kept });
	};
	// Messages the person sent into the running answer, oldest first: the
	// runtime takes all of them at its next check, in the order they came.
	let pendingSteers: { id: string; text: string }[] = [];
	// The provider's own tools (its web search) running inside the message being written: a message sent meanwhile waits for them as for a step.
	const providerToolsRunning = new Set<string>();
	// A turn's own message reaches the session as its first user message;
	// every user message after it in the same run is a steer the runtime took.
	let turnPromptMessageSeen = false;
	// A steer goes in only while this turn's own run streams: before its first
	// frame or after its last one the runtime would start a run of its own,
	// outside the turn's bookkeeping. The recovery prompt is the server's and
	// takes none.
	const turnTakesSteers = (): boolean => !!(session && activePersistentWebTurn && !activePersistentWebTurn.promptSettled && !activePersistentWebTurn.terminalReason && !autoSummaryRunning && !serverStopping() && session.isStreaming);
	// Steers and take-backs change the runtime's queue one at a time: a
	// take-back clears it and queues the rest again, so a steer that arrives
	// meanwhile waits behind them and keeps its place.
	let steerQueueChange: Promise<unknown> = Promise.resolve();
	const inQueueOrder = <T>(change: () => Promise<T>): Promise<T> => {
		const run = steerQueueChange.then(change, change);
		steerQueueChange = run.catch(() => {});
		return run;
	};
	// Into the runtime's queue, outside the order below: callers go through steerInOrder, or already hold its turn.
	const steerActiveTurn = async (id: string, text: string): Promise<boolean> => {
		if (!id || !text.trim() || !turnTakesSteers() || pendingSteers.length >= MAX_WAITING_STEERS) return false;
		pendingSteers.push({ id, text });
		try {
			// prompt, not steer(): it carries the registry's options, so a shared server's "/" text reaches the model as written.
			await session!.prompt(text, { streamingBehavior: "steer", ...serverHooks().promptOptions?.() });
			return true;
		} catch (error) {
			pendingSteers = pendingSteers.filter((steer) => steer.id !== id);
			app.log.warn({ err: error }, "steer into the running answer failed");
			return false;
		}
	};
	/** Resolves false when the steer was not taken in, so the page sends it as its own message once the answer ends. */
	const steerInOrder = (id: string, text: string): Promise<boolean> => inQueueOrder(() => steerActiveTurn(id, text));
	// The runtime takes its queued messages in all at once, at a run's start
	// and after every step, and starts each as a user message within the same
	// stretch of its loop (agent-loop.ts), before any socket message can be
	// read. This connection hears of those starts later, through the session's
	// own event chain, where pendingSteers loses them. The agent's own listener
	// counts the user messages the runtime started (`runtime`), the session's
	// listener the ones it has heard of (`heard`): while they differ, a message
	// in pendingSteers may be in the conversation already, so none comes out.
	let steerIntake = { runtime: 0, heard: 0 };
	/**
	 * Edit or Remove on a message the running answer holds. The runtime can
	 * only clear its whole queue (AgentSession.clearQueue), so the others go
	 * in again, in order, through the same steer; one that no longer can goes
	 * back to the page as an untaken steer does.
	 */
	const withdrawSteer = (id: string): Promise<boolean> => inQueueOrder(async () => {
		if (!session || !turnTakesSteers() || steerIntake.runtime !== steerIntake.heard || !pendingSteers.some((steer) => steer.id === id)) return false;
		const rest = pendingSteers.filter((steer) => steer.id !== id);
		pendingSteers = [];
		takenSteers.set(answerNoteKey(), [...(takenSteers.get(answerNoteKey()) ?? []), { id, withdrawn: true as const }].slice(-TAKEN_STEERS_KEPT));
		try {
			session.clearQueue();
		} catch (error) {
			app.log.warn({ err: error }, "clearing the runtime's message queue failed");
		}
		const returned: Array<{ id: string; text: string }> = [];
		for (const steer of rest) if (!(await steerActiveTurn(steer.id, steer.text))) returned.push(steer);
		if (returned.length) sendTurnFrame({ type: "steer_returned", messages: returned });
		return true;
	});
	// What the running answer still holds, as a window that comes back lists it.
	const waitingSteers = (): Array<{ id: string; text: string }> => pendingSteers.map(({ id, text }) => ({ id, text }));
	// The runtime keeps steers it has not taken across Stop and into its next
	// run. They go back to the page after Stop, at the answer's end and when
	// the turn settles, so none rides silently into a later message.
	const returnUntakenSteers = (): void => {
		if (!session) return;
		const returned = pendingSteers;
		pendingSteers = [];
		try { session.clearQueue(); } catch (error) { app.log.warn({ err: error }, "clearing the runtime's message queue failed"); }
		if (returned.length === 0) return;
		// With no window to take them, or the server stopping before a page could send them on, they wait on disk until the person acts.
		const held = serverStopping() || (detachedFromClient && !detachedCookingHandle?.adopterConnectionId);
		if (held) {
			try {
				const refused = holdMessages(persistentAgentIdForSession, persistentConversationId, returned);
				if (refused.length) app.log.warn({ refused: refused.length }, "untaken messages past the held limits stay with the page only");
			} catch (error) { app.log.warn({ err: error }, "holding the untaken messages failed"); }
		}
		sendTurnFrame({ type: "steer_returned", messages: returned, ...(held ? { held: true } : {}) });
	};
	/**
	 * A message the person sent while the room answers. During a step it goes
	 * in after the step; a waiting question it declines (when the person
	 * started typing after it opened) once the message is in; while the
	 * model thinks or writes, it goes in at the next step or right after the
	 * answer. Cmd/Ctrl+Enter stops the answer at the words on screen and the
	 * message goes next.
	 */
	const routeSteer = async (request: SteerRequest): Promise<SteerRouted> => {
		const refused = { type: "steer_refused" as const, id: request.id };
		if (!request.id || !request.text.trim() || !turnTakesSteers() || !session) return refused;
		const state = session.agent.state;
		const phase = answerPhase({ questionOpen: uiContext.hasOpenQuestions(), pendingToolCalls: state.pendingToolCalls.size, retrying: ((session as any).retryAttempt ?? 0) > 0, providerTools: providerToolsRunning.size, streaming: state.streamingMessage as any, last: state.messages.at(-1) as any });
		const way = steerWay(phase, request);
		if (way === "cut" || way === "cut-quiet") {
			markStop(true, way === "cut" ? request.shown : 0);
			// Messages still waiting for a step go with this one.
			returnUntakenSteers();
			// The person answered the waiting question with a message, not with Stop.
			if (phase === "question") uiContext.declineOpenQuestionsOnce(DECLINED_FOR_MESSAGE_SENTENCE);
			void abortActivePersistentWebTurn("cancelled");
			return { type: "steer_cut", id: request.id, quiet: way === "cut-quiet" };
		}
		if (!(await steerInOrder(request.id, request.text))) return refused;
		if (way === "steer-then-decline") uiContext.declineOpenQuestionsOnce(DECLINED_FOR_MESSAGE_SENTENCE);
		// The model already finished its text: the message goes in right after it, not after a step.
		return { type: "steer_waiting", id: request.id, ...(phase === "ending" ? { afterText: true as const } : {}) };
	};
	const disposeSessionAfterAbortIfNeeded = async (reason: "cancelled" | "disconnect_cancelled" = "disconnect_cancelled"): Promise<void> => {
		if (sessionDisposed) return;
		const sessionToDispose = session;
		if (!sessionToDispose) return;
		if (activePersistentWebTurn && !activePersistentWebTurn.promptSettled) {
			await abortActivePersistentWebTurn(reason);
		}
		if (sessionDisposed) return;
		sessionDisposed = true;
		stopOverflowRecovery(true);
		try { (sessionToDispose as any).dispose?.(); } catch {}
	};

	// The client is gone but the turn ran to its end —
	// land the outcome into the thread file server-side, the same write shape
	// scheduled background execution uses. The client may have persisted a
	// partial tail of this very answer before the drop (debounced persist /
	// leave save); the landed text carries the WHOLE turn, so trailing
	// assistant items after the last user item are superseded, not additional.
	// Parked as standby so the launcher offers Resume, like a scheduled run.
	const landDetachedTurnOutcome = (turnId: string, terminalReason: PersistentWebTurnTerminalReason, options: { watchedByAdopter?: boolean; snapshot?: SettledTurnLandingSnapshot; handedBack?: boolean } = {}): void => {
		const current = getPersistentAgentThread(persistentAgentIdForSession, persistentConversationId);
		if (!current || current.state === "closed") return;
		// `watchedByAdopter` means a session stepped back in and
		// watched this turn land live. The write itself stays (it is the
		// crash-safe record of the paid answer, and the adopter's own persist
		// supersedes it with equivalent content), but everything that assumes
		// nobody saw the landing does not: no "after you left the room" notes
		// (the adopter watched the live error), no standby parking (the room is
		// open), no unseen marker (the answer was seen landing).
		const watched = options.watchedByAdopter === true;
		// A message handed back to the box took its failed attempts with it: their partial text is no answer to land.
		const finalText = options.handedBack ? "" : (options.snapshot ? options.snapshot.finalAssistantText : turnTrace.finalAssistantText).trim();
		const safeTurnId = turnId.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 96);
		let items = [...(current.items ?? [])];
		// Where the landing's own items begin: past what it keeps of the file.
		let ownFrom = items.length;
		// A snapshot outlives its turn, so it says itself whether the stop cut it.
		const stopCut = options.snapshot ? options.snapshot.stoppedByServer === true : activePersistentWebTurn?.turnId === turnId && activePersistentWebTurn.stoppedByServer === true;
		// A snapshot is of a turn that ended with its person in the room: no away limit stopped it.
		const awayLimit = options.snapshot || activePersistentWebTurn?.turnId !== turnId ? undefined : activePersistentWebTurn.awayLimit;
		// A turn with no answer keeps its steps too: they say what became of a question nobody answered.
		// A handed-back message is back in the box, so its attempts' steps (a call cut off mid-stream reads as "stopped") are no record of it.
		const landedSteps = options.handedBack ? [] : (options.snapshot ? options.snapshot.stepLog : turnSteps)?.items(`detached-step-${safeTurnId}`) ?? [];
		// A snapshot whose answer the person stopped before any of it showed still lands its prompt.
		if (finalText || landedSteps.length > 0 || options.snapshot) {
			// Supersede anchored on the last item the file held at TURN START
			// (same fix as the client's reattach supersede): only items the
			// cooking turn itself produced are debris. Anchoring on the last
			// USER item, as this used to, deleted the PREVIOUS turn's completed
			// answer whenever the crash-leave never persisted this turn's
			// prompt. Null anchor means the thread was empty at turn start
			// (everything is this turn's); a set-but-missing anchor deletes
			// nothing; an unknown anchor falls back to the old rule. An earlier
			// answer the page saved after this turn began stays too.
			const anchorItemId = options.snapshot
				? earlierTurnsAnchorItemId(items, options.snapshot.anchorItemId, options.snapshot.earlierPromptsAfterAnchor)
				: earlierTurnsAnchorItemId(items, detachedCookingHandle?.anchorItemId, detachedCookingHandle?.earlierPromptsAfterAnchor ?? null);
			let cutIndex: number;
			if (anchorItemId === null) {
				cutIndex = -1;
			} else if (typeof anchorItemId === "string") {
				let found = -1;
				for (let i = items.length - 1; i >= 0; i--) {
					if (String((items[i] as any)?.id ?? "") === anchorItemId) { found = i; break; }
				}
				cutIndex = found >= 0 ? found : items.length - 1;
			} else {
				let lastUserIndex = -1;
				for (let i = items.length - 1; i >= 0; i--) {
					if ((items[i] as any)?.kind === "user") { lastUserIndex = i; break; }
				}
				cutIndex = lastUserIndex;
			}
			// A message the turn took lands where the turn took it: the bubble the page saved for it goes, so it shows once.
			const tookIds = new Set(landedSteps.flatMap((item) => (item.kind === "user" ? [item.id] : [])));
			items = items.filter((item, index) => !(index > cutIndex && (item as any)?.kind === "user" && tookIds.has(String((item as any)?.id ?? ""))));
			const tailHasUser = items.some((item, index) => index > cutIndex && isPromptItem(item));
			// Assistant AND tool items go, the same predicate as the client's
			// reattach supersede: a persisted tool chip's toolCallId died with
			// the connection that ran it, so leaving it would strand a
			// permanent running spinner in the landed transcript.
			// The turn's own away-notes are stripped alongside the superseded
			// tail and re-appended below, so a landing that runs twice keeps
			// the transcript in the order it happened instead of leaving its
			// notes stranded in front of the answer.
			items = items.filter((item, index) => !((index > cutIndex && ((item as any)?.kind === "assistant" || (item as any)?.kind === "tool")) || String((item as any)?.id ?? "").startsWith(`detached-declined-${safeTurnId}-`)));
			ownFrom = items.length;
			// The crash-leave that lost the partial can lose the PROMPT too:
			// land it alongside the answer, so the transcript never shows an
			// answer to a question that is not there.
			// The restored prompt is stamped with the turn's start (when it was
			// sent), the answer with the moment the turn settled; a repair that
			// runs later must not date the messages by its own clock. No known
			// start means no stamp rather than a wrong one.
			const anchorUserText = (options.snapshot ? options.snapshot.userText : detachedCookingHandle?.userText ?? "").trim();
			const turnStartedAt = options.snapshot ? options.snapshot.startedAt : detachedCookingHandle?.startedAt;
			if (!tailHasUser && anchorUserText) {
				items.push({ kind: "user", id: `detached-user-${safeTurnId}`, text: anchorUserText, ...(typeof turnStartedAt === "number" ? { ts: turnStartedAt } : {}) });
			}
			items.push(...landedSteps);
			if (finalText) items.push({ kind: "assistant", id: `detached-assistant-${safeTurnId}`, text: finalText, streaming: false, ts: options.snapshot ? options.snapshot.settledAt : Date.now() });
			// A partial that landed because the turn FAILED (provider error, or
			// an away limit stopped it) must not read as a finished answer to
			// someone opening the room later.
			if (finalText && terminalReason === "failed" && !watched) {
				const id = `detached-partial-${safeTurnId}`;
				items.push(awayLimit ? awayLimitLine(id, awayLimit, true) : { kind: "system", id, text: stopCut ? STOP_CUT_ANSWER_SENTENCE : AWAY_PARTIAL_SENTENCE, level: "error" });
			}
		}
		if (!finalText && terminalReason === "failed" && !watched && !options.handedBack) {
			const id = `detached-failure-${safeTurnId}`;
			items.push(awayLimit ? awayLimitLine(id, awayLimit, landedSteps.some((item) => item.kind === "tool")) : { kind: "system", id, text: stopCut ? STOP_CUT_ANSWER_SENTENCE : AWAY_FAILURE_SENTENCE, level: "error" });
		}
		// A dialog that came up with nobody in the room was answered with a safe
		// default so the turn could keep going. Say that in the transcript
		// itself, deterministically, instead of hoping the answer mentions it.
		// Bookkeeping must never cost the answer: the landed text is the paid
		// result of this turn, the notes are an adornment on top of it.
		try {
			items = autoDeclinedQuestions.appendItems(items, `detached-declined-${safeTurnId}`);
		} catch (error) {
			app.log.warn({ err: error }, "failed to append auto-declined question notes to the detached landing");
		}
		writePersistentAgentThread(persistentAgentIdForSession, persistentConversationId, {
			state: watched ? current.state : "standby",
			origin: current.origin,
			model: current.model,
			items,
		}, {
			// The model already ran and its tokens are spent; this write only
			// lands the paid answer under the thread's existing lock (same
			// reasoning as the scheduled-background landing write).
			allowInactiveProfileModel: true,
			// The person may have moved to another conversation in the instant
			// the answer finished: the answer lands in this one, the room stays
			// on the newer one, and the next message there is not refused.
			keepRuntimeIfMoved: true,
		});
		landedThroughItemId = items.length > ownFrom ? String((items.at(-1) as any)?.id ?? "") || undefined : undefined;
		if (watched) return;
		// Slice 3: nobody was connected to see this landing — record the unseen
		// marker (away-notice shape) so a fresh session's Home can still badge
		// the room. Cleared when a session next binds to the room. Best-effort:
		// the landed answer above must never be lost to marker bookkeeping.
		try {
			recordPersistentAgentUnseenLandedAnswer(persistentAgentIdForSession, {
				threadId: persistentConversationId,
				turnId: safeTurnId,
				terminalReason: terminalReason === "completed" ? "completed" : "failed",
			});
		} catch (error) {
			app.log.warn({ err: error }, "failed to record unseen landed-answer marker");
		}
	};

	/**
	 * A keyed turn's landing, by id (thread-items-by-id.ts), built at its
	 * settle and answered as the write to run: now, or once the page says it
	 * kept a message the room offered back. Every keyed turn lands, watched or
	 * not: its question as the bubble showed it, its parts, steps and taken
	 * messages, its declined notices by the card rule, and its lines only when
	 * nobody watched it end.
	 */
	const keyedLandingOf = (turnId: string, turn: KeyedTurn, terminalReason: PersistentWebTurnTerminalReason, options: { watched: boolean; stopCut: boolean; awayLimit?: AwayLimit }): (() => void) => {
		const { key } = turn;
		const own: ThreadItem[] = [];
		if (turn.editLine) own.push({ kind: "system", id: turn.editLine.id, text: turn.editLine.text, level: "info" });
		const question = turn.shown?.text ?? turn.strippedText;
		const files = turn.shown?.files ?? [];
		if (!turn.continued && (question.trim() || files.length > 0)) own.push({ kind: "user", id: key, text: question, ...(files.length ? { attachments: files } : {}), ...(typeof turn.startedAt === "number" ? { ts: turn.startedAt } : {}) });
		const made: ThreadItem[] = turn.steps.keyedItems().map((item) => ({ ...item }));
		own.push(...made);
		if (terminalReason === "failed" && !options.watched) {
			const answered = made.some((item) => item.kind === "assistant" && String(item.text ?? "").trim());
			const id = answered ? partialLineId(key) : failureLineId(key);
			own.push(options.awayLimit ? awayLimitLine(id, options.awayLimit, answered || made.some((item) => item.kind === "tool")) : { kind: "system", id, text: options.stopCut ? STOP_CUT_ANSWER_SENTENCE : answered ? AWAY_PARTIAL_SENTENCE : AWAY_FAILURE_SENTENCE, level: "error" });
		}
		try {
			own.push(...autoDeclinedQuestions.noticeItems(declinedNoticeIdPrefix(key)));
		} catch (error) {
			app.log.warn({ err: error }, "failed to add auto-declined question notes to the keyed landing");
		}
		const gone = made.flatMap((item) => (item.kind === "assistant" && isEmptyCut(item) ? [String(item.id)] : []));
		return () => {
			const current = getPersistentAgentThread(persistentAgentIdForSession, persistentConversationId);
			if (!current || current.state === "closed") return;
			// A part Stop cut to nothing stays out of later saves too.
			rememberRemovedIds(persistentAgentIdForSession, persistentConversationId, gone);
			const items = landTurnItems(current.items ?? [], own, { key, continued: turn.continued, startAnchorId: turn.startAnchorId, recentKeys: recentTurnKeys(persistentAgentIdForSession, persistentConversationId) }, removedIdsOf(persistentAgentIdForSession, persistentConversationId));
			writePersistentAgentThread(persistentAgentIdForSession, persistentConversationId, {
				state: options.watched ? current.state : "standby",
				origin: current.origin,
				model: current.model,
				items,
			}, { allowInactiveProfileModel: true, keepRuntimeIfMoved: true });
			// The next message of an adopting window starts after the turn's last item.
			const ownIds = new Set(own.map((item) => String(item.id)));
			const last = [...items].reverse().find((item) => ownIds.has(String(item.id ?? "")));
			landedThroughItemId = last ? String(last.id) : undefined;
			if (options.watched) return;
			try {
				recordPersistentAgentUnseenLandedAnswer(persistentAgentIdForSession, {
					threadId: persistentConversationId,
					turnId: turnId.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 96),
					terminalReason: terminalReason === "completed" ? "completed" : "failed",
				});
			} catch (error) {
				app.log.warn({ err: error }, "failed to record unseen landed-answer marker");
			}
		};
	};

	// Expose this live session to lifecycle endpoints (Memento force-close).
	const liveSessionHandle: PersistentRoomLiveSession = {
		connectionId,
		conversationId: persistentConversationId,
		// An adopted cooking turn runs in the DETACHING connection's
		// closure; quiescing this session must stop that turn too, or Memento
		// would dispose an idle session while the room keeps cooking.
		quiesceForBoundary: async () => {
			const cooking = claimedCookingTurn;
			if (cooking && !cooking.settled) { try { await cooking.stop(connectionId); } catch {} }
			await disposeSessionAfterAbortIfNeeded("cancelled");
		},
		notify: (message: string) => { try { socket.send(JSON.stringify({ type: "ui_request", kind: "notify", id: `memento_${Date.now().toString(36)}`, message, level: "info" })); } catch {} },
		closeSocket: () => { try { socket.close(); } catch {} },
		switchModel: async (lock, notice) => {
			if (workspaceRebindInFlight) { try { await workspaceRebindInFlight; } catch {} }
			if (activePersistentWebTurn || autoSummaryRunning || (claimedCookingTurn && !claimedCookingTurn.settled)) {
				throw Object.assign(new Error(SWITCH_WHILE_ANSWERING_MESSAGE), { statusCode: 409, code: "switch_answering" });
			}
			const runtimeCwd = persistentRoomRuntimeCwdForEffectiveWorkspacePolicy(resolvePersistentRoomEffectiveWorkspacePolicy(persistentAgentIdForSession, persistentConversationId), REPO_ROOT);
			let noticeId = "";
			let replaces: string | null = null;
			const rebind = (async () => {
				if (!sessionDisposed) {
					sessionDisposed = true;
					try { (session as any)?.dispose?.(); } catch {}
				}
				session = null;
				const switched = switchPersistentAgentThreadModel(persistentAgentIdForSession, persistentConversationId, lock, { notice, runtimeCwd });
				persistentAgentThreadForSession = switched.thread;
				const last = switched.thread.items[switched.thread.items.length - 1] as { id?: string } | undefined;
				noticeId = String(last?.id ?? "");
				replaces = switched.replaces;
				await bindSession();
			})();
			workspaceRebindInFlight = rebind;
			rebind.catch(reportRebindRefusal).finally(() => {
				if (workspaceRebindInFlight === rebind) workspaceRebindInFlight = null;
			});
			await rebind;
			send({ type: "model_switched", model: modelStatusPayload((session as any)?.model), contextHealth: initialContextHealthForSession(session), effort: roomEffortStatusPayload(persistentAgentIdForSession, persistentConversationId, session), notice: { id: noticeId, text: notice, ...(replaces ? { replaces } : {}) } });
			return { noticeId, replaces };
		},
		measuredContextTokens: () => {
			const usage = typeof (session as any)?.getContextUsage === "function" ? (session as any).getContextUsage() : undefined;
			return typeof usage?.tokens === "number" ? usage.tokens : null;
		},
		toolDefinitionTokens: () => {
			if (!session) return null;
			const tools = typeof (session as any).getAllTools === "function" ? (session as any).getAllTools() : [];
			return estimateTokens(JSON.stringify(tools.map((tool: any) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))));
		},
	};
	persistentRoomLiveSessions.set(persistentAgentIdForSession, liveSessionHandle);
	socket.on("close", () => {
		// A detached cooking turn keeps its handle registered so Memento can
		// still quiesce it; the prompt handler unregisters after landing.
		if (turnKeepsCookingOnClose()) return;
		if (persistentRoomLiveSessions.get(persistentAgentIdForSession) === liveSessionHandle) persistentRoomLiveSessions.delete(persistentAgentIdForSession);
	});
	const nextPromptDiagnosticsTurnId = (conversationId: string): string => {
		promptDiagnosticsTurnOrdinal += 1;
		return `${safeDiagnosticIdPart(conversationId)}:turn-${promptDiagnosticsTurnOrdinal}`;
	};
	const preparePromptDiagnosticsTurn = (promptSource: string): void => {
		if (!promptDiagnosticsEnabledForConnection || !promptDiagnosticsCurrentModel || !session) return;
		const turnId = nextPromptDiagnosticsTurnId(persistentConversationId);
		promptDiagnosticsPendingTurn = {
			turnId,
			turnOrdinal: promptDiagnosticsTurnOrdinal,
			promptSource,
			activeOwner,
			preStartSystemPrompt: typeof session.systemPrompt === "string" ? session.systemPrompt : "",
			model: promptDiagnosticsCurrentModel,
			components: [],
		};
	};
	const recordPromptDiagnosticsTurn = (turn: PromptDiagnosticsPendingTurn): void => {
		recordPromptAssemblyManifest(createPromptAssemblyManifest({
			surface: "persistent-room",
			agentId: persistentAgentIdForSession,
			conversationId: persistentConversationId,
			turnId: turn.turnId,
			relatedManifestId: turn.relatedManifestId,
			processKey: "persistent-room-turn",
			model: turn.model,
			isolation: {
				rawSystemPrompt: true,
				noTools: (session?.getActiveToolNames().length ?? 0) === 0,
				noContextFiles: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
			components: turn.components,
		}));
	};
	const roleOfDiagnosticMessage = (message: unknown): string => String((message as any)?.role ?? "custom");
	const messageStringSize = (value: unknown): { chars: number; bytes: number } => {
		const seen = new Set<object>();
		let chars = 0;
		let bytes = 0;
		const visit = (node: unknown): void => {
			if (typeof node === "string") {
				chars += node.length;
				bytes += Buffer.byteLength(node, "utf-8");
				return;
			}
			if (node == null || typeof node !== "object") return;
			if (seen.has(node)) return;
			seen.add(node);
			if (Array.isArray(node)) {
				for (const item of node) visit(item);
				return;
			}
			for (const child of Object.values(node as Record<string, unknown>)) visit(child);
		};
		visit(value);
		return { chars, bytes };
	};
	const addMessageContextDiagnostics = (turn: PromptDiagnosticsPendingTurn, messages: unknown[]): void => {
		const counts = { user: 0, assistant: 0, toolResult: 0, custom: 0 };
		let aggregateChars = 0;
		let aggregateBytes = 0;
		// Tool results the aging extension replaced with a short note, and how
		// many characters that kept out of this request.
		let agedToolResultCount = 0;
		let agedToolResultCharsSaved = 0;
		for (const message of messages) {
			// The saving is the number the aging step itself computed, not a
			// second guess at it from here: only that one knows the image data it
			// took out as well as the text.
			const agedMarker = readAgedToolResultMarker(message);
			if (agedMarker) {
				agedToolResultCount += 1;
				agedToolResultCharsSaved += agedMarker.charsSaved;
			}
			const role = roleOfDiagnosticMessage(message);
			if (role === "user") counts.user += 1;
			else if (role === "assistant") counts.assistant += 1;
			else if (role === "toolResult") counts.toolResult += 1;
			else counts.custom += 1;
			const size = messageStringSize(message);
			aggregateChars += size.chars;
			aggregateBytes += size.bytes;
		}
		const aggregateEstimatedTokens = estimateTokensFromChars(aggregateChars);
		const safeAggregateText = [
			`messages=${messages.length}`,
			`user=${counts.user}`,
			`assistant=${counts.assistant}`,
			`tool=${counts.toolResult}`,
			`custom=${counts.custom}`,
			`chars=${aggregateChars}`,
			`bytes=${aggregateBytes}`,
			`aged=${agedToolResultCount}`,
			`agedCharsSaved=${agedToolResultCharsSaved}`,
		].join("\n");
		turn.components.push(componentFromText({
			id: `persistent-room:${safeDiagnosticIdPart(turn.turnId)}:message-context`,
			type: "message-context",
			text: safeAggregateText,
			source: { "function": "persistentRoomPromptDiagnosticsExt.context" },
			metadata: {
				phase: "context",
				providerCallIndex: 1,
				messageCount: messages.length,
				userMessageCount: counts.user,
				assistantMessageCount: counts.assistant,
				toolResultMessageCount: counts.toolResult,
				customMessageCount: counts.custom,
				aggregateChars,
				aggregateBytes,
				aggregateEstimatedTokens,
				agedToolResultCount,
				agedToolResultCharsSaved,
			},
		}));
	};
	const persistentRoomPromptDiagnosticsExt = (model: PromptDiagnosticsModel) => (pi: any) => {
		pi.on("before_agent_start", async (event: any, ctx: any) => {
			let pending = promptDiagnosticsPendingTurn;
			try {
				const systemPromptValue = typeof ctx?.getSystemPrompt === "function" ? ctx.getSystemPrompt() : event?.systemPrompt;
				const finalSystemPrompt = typeof systemPromptValue === "string" ? systemPromptValue : "";
				if (!pending) {
					const turnId = nextPromptDiagnosticsTurnId(persistentConversationId);
					pending = {
						turnId,
						turnOrdinal: promptDiagnosticsTurnOrdinal,
						promptSource: "unknown",
						activeOwner,
						preStartSystemPrompt: finalSystemPrompt,
						model,
						components: [],
					};
					promptDiagnosticsPendingTurn = pending;
				}
				const preStartSystemPrompt = pending.preStartSystemPrompt;
				const finalBytes = Buffer.byteLength(finalSystemPrompt, "utf-8");
				const preStartBytes = Buffer.byteLength(preStartSystemPrompt, "utf-8");
				const finalEstimatedTokens = estimateTextTokens(finalSystemPrompt);
				const preStartEstimatedTokens = estimateTextTokens(preStartSystemPrompt);
				pending.components.push(componentFromText({
					id: `persistent-room:${safeDiagnosticIdPart(pending.turnId)}:final-system-prompt`,
					type: "final-system-prompt",
					text: finalSystemPrompt,
					source: { "function": "persistentRoomPromptDiagnosticsExt.before_agent_start" },
					metadata: {
						phase: "before_agent_start_final",
						promptSource: pending.promptSource,
						activeOwner: pending.activeOwner,
						turnOrdinal: pending.turnOrdinal,
						deltaFromPreStartChars: finalSystemPrompt.length - preStartSystemPrompt.length,
						deltaFromPreStartBytes: finalBytes - preStartBytes,
						deltaFromPreStartEstimatedTokens: finalEstimatedTokens - preStartEstimatedTokens,
					},
				}));
			} catch (error) {
				app.log.warn({ err: error }, "failed to record persistent-room final prompt diagnostics");
			}
		});
		pi.on("context", async (event: any) => {
			const pending = promptDiagnosticsPendingTurn;
			if (!pending) return;
			try {
				const messages = Array.isArray(event?.messages) ? event.messages : [];
				addMessageContextDiagnostics(pending, messages);
				recordPromptDiagnosticsTurn(pending);
			} catch (error) {
				app.log.warn({ err: error }, "failed to record persistent-room message context diagnostics");
			} finally {
				if (promptDiagnosticsPendingTurn === pending) promptDiagnosticsPendingTurn = undefined;
			}
		});
	};

	// Every frame that is not a turn frame sends the turn's pending text first,
	// so it never overtakes words written before it.
	const send = (msg: unknown) => {
		turnFrameCoalescer.flush();
		streamTrace.frameOut(msg);
		try { socket.send(JSON.stringify(msg)); } catch {}
	};
	// Every socket traces what it writes, as `send` does; a frame is parsed back only while tracing is on.
	const tracesFrames = isStreamTraceEnabled();
	const sendSerialised = (text: string) => {
		if (tracesFrames) { try { streamTrace.frameOut(JSON.parse(text)); } catch {} }
		try { socket.send(text); } catch {}
	};
	// Delivery-honest variant for frames whose "was the user told?" answer is
	// persisted (away-notice stamping, the specialist sink's `noticed` signal):
	// a closed/closing socket reports false instead of silently swallowing.
	const sendChecked = (msg: unknown): boolean => {
		if (socket.readyState !== socket.OPEN) return false;
		turnFrameCoalescer.flush();
		streamTrace.frameOut(msg);
		try { socket.send(JSON.stringify(msg)); } catch { return false; }
		return true;
	};
	// Whoever watches this connection's turn: the adopter while one is inside, else this socket.
	const sendToWatcher = (msg: unknown) => {
		const sink = cookingTurnSink;
		if (sink) {
			turnFrameCoalescer.flush();
			let text: string;
			try { text = JSON.stringify(msg); } catch { return; }
			try { sink(text); } catch {}
			return;
		}
		send(msg);
	};
	// Turn-scoped frames (the event family, usage, the turn's error
	// frame) go through sendTurnFrame, which merges small ones, and then here
	// so they are recorded for a reattach replay and, while an adopter is
	// inside, forwarded to its socket instead of this one. Each is serialised
	// once: the same string is counted, kept for a replay and written out.
	const deliverTurnFrame = (msg: unknown) => {
		// A turn a server stop ended says so on its end events.
		const turnEvent = (msg as { type?: unknown; event?: { type?: unknown } } | null)?.event;
		if (activePersistentWebTurn?.stoppedByServer && (msg as { type?: unknown }).type === "event" && (turnEvent?.type === "message_end" || turnEvent?.type === "agent_end")) msg = { ...(msg as object), event: { ...turnEvent, stoppedByServer: true } };
		if (activePersistentWebTurn) msg = { ...(msg as object), seq: ++turnFrameSeq };
		let text: string;
		try { text = JSON.stringify(msg); } catch { return; }
		if (activePersistentWebTurn && !turnReplayOverflowed) {
			const frameBytes = text.length;
			turnFrameBufferBytes += frameBytes;
			if (turnFrameBufferBytes > REATTACH_REPLAY_CAP_BYTES) {
				// Replay is off the table for this turn: free what was held and
				// remember why, so a reattach bounces honestly instead of
				// replaying a truncated stream.
				turnReplayOverflowed = true;
				turnFrameBuffer = [];
				app.log.warn({ agentId: persistentAgentIdForSession, capBytes: REATTACH_REPLAY_CAP_BYTES }, "turn exceeded the reattach replay cap; replay disabled for this turn");
			} else {
				turnFrameBuffer.push(text);
			}
			updateReattachBufferProbe();
		}
		const sink = cookingTurnSink;
		if (sink) {
			try { sink(text); } catch {}
			return;
		}
		sendSerialised(text);
	};
	const turnFrameCoalescer = createTurnFrameCoalescer(deliverTurnFrame);
	const sendTurnFrame = (msg: unknown) => turnFrameCoalescer.push(msg);
	// Questions the detached bridge answered for the user. The landing writes
	// them into the transcript: a decline the user never saw must not depend on
	// the answer mentioning it.
	const autoDeclinedQuestions = createPersistentRoomAutoDeclinedQuestionLog();
	// The stop tells the model its own sentence; the away log is for a person who left, before the stop or during it.
	let declinedByStop = false;
	// Questions follow the turn to whoever watches it, so a person who came back answers them.
	const uiContext = createWebUiContext(sendToWatcher, (question) => { if (!declinedByStop) autoDeclinedQuestions.note(question); });
	const LEFT_ROOM_QUESTIONS_SENTENCE = "The user left the room while this response was being written, so interactive questions cannot be answered right now. Proceed with your best judgment and finish the task; anything that strictly needs the user's approval must be left undone and mentioned in your answer.";
	// A server stop (server-stop.ts) tells this connection once, ends its running turn
	// marked as the stop's, and closes it with 1001. Released at the close, or, for a
	// turn that goes on after the close, once that turn has landed.
	const turnRunsForStop = (): boolean => !!(activePersistentWebTurn && !activePersistentWebTurn.promptSettled);
	const releaseLiveConnectionForStop = trackLiveConnection({
		notify: () => {
			send({ type: "server_stopping" });
			if (turnRunsForStop()) {
				// A person who came back is in the room: the stop declines their questions, not their absence.
				if (!detachedFromClient || detachedCookingHandle?.adopterConnectionId) declinedByStop = true;
				uiContext.detach(STOP_QUESTIONS_SENTENCE);
			}
		},
		endTurn: () => {
			if (!turnRunsForStop() || !activePersistentWebTurn) return;
			// An answer that already ended is left to finish while the runtime's post-turn work runs: it is not cut.
			if (answerAlreadyEnded((session as any)?.agent?.state?.messages)) return;
			activePersistentWebTurn.stoppedByServer = true;
			void abortActivePersistentWebTurn("failed");
		},
		close: () => {
			try { socket.close(1001); } catch {}
		},
	});
	// Attached before the first await, so a connection that closes during its bind, or whose bind fails, is released too.
	socket.on("close", () => { if (!turnKeepsCookingOnClose()) releaseLiveConnectionForStop(); });

	const bindSession = async () => {
		// Rooms set the active-agent marker to the room id; the permissions
		// extension reads it to scope tool gating.
		process.env.EXXETA_ACTIVE_AGENT = persistentAgentIdForSession;
		const persistentAgentId = persistentAgentIdForSession;
		// An empty conversation (the one Remember or Forget prepared) boots on
		// the room's conversation model as it is now, and while that cannot run
		// it waits with the room's refusal instead of booting on the lock it was
		// prepared with. Best effort: on a failure to read the pick it boots on
		// its stored lock exactly as before.
		if (persistentAgentThreadForSession?.runtime.kind === "pi-session-jsonl") {
			let waits: RoomModelUnavailableError | null = null;
			try {
				const catalog = createRoomModelCatalog();
				const resolved = resolveRoomModel(persistentAgentId, "conversation", catalog);
				const pick = resolved.effective;
				const refreshed = pick ? refreshEmptyPersistentAgentThreadModel(persistentAgentId, persistentConversationId, pick) : null;
				if (refreshed?.moved) {
					persistentAgentThreadForSession = refreshed.thread;
					app.log.info({ roomId: persistentAgentId, threadId: persistentConversationId, before: `${refreshed.moved.before.provider}/${refreshed.moved.before.model}`, after: `${refreshed.moved.after.provider}/${refreshed.moved.after.model}` }, "an empty conversation boots on the room's current conversation model");
				}
				if (!pick && persistentAgentThreadFollowsConversationPick(persistentAgentId, persistentConversationId)) waits = roomModelRefusal(resolved, "conversation", catalog);
			} catch (error) {
				app.log.warn({ err: (error as Error).message, roomId: persistentAgentId, threadId: persistentConversationId }, "empty conversation model refresh failed");
			}
			if (waits) throw waits;
		}
		const webChatModelRegistry = getWebChatModelRegistry();
		const webChatModel = resolvePersistentAgentBindModel(webChatModelRegistry, params, { agentId: persistentAgentId, conversationId: persistentConversationId });
		if (!webChatModel) throw new Error("persistent-agent model could not be resolved");
		const persistentRoomModel = { provider: webChatModel.provider, model: webChatModel.id, label: webChatModelLabel(webChatModel.provider, webChatModel) };
		promptDiagnosticsCurrentModel = persistentRoomModel;
		const persistentRoomEffectiveWorkspacePolicy = resolvePersistentRoomEffectiveWorkspacePolicy(persistentAgentId, persistentConversationId);
		const persistentRoomCapabilityPolicy = persistentRoomEffectiveWorkspacePolicy?.policy ?? null;
		const persistentRoomWorkspaceToolsEnabled = persistentRoomEffectiveWorkspacePolicy?.workspaceToolsEnabled === true;
		const persistentRoomToolPolicy = getPersistentRoomToolPolicy(persistentAgentId, {
			workspaceToolsEnabled: persistentRoomWorkspaceToolsEnabled,
			workspaceToolNames: persistentRoomEffectiveWorkspacePolicy?.allowedToolNames ?? [],
			workspaceAccessMode: persistentRoomEffectiveWorkspacePolicy?.workspaceAccessMode,
			bashEnabled: persistentRoomEffectiveWorkspacePolicy?.bashEnabled === true,
			bashRuntimeAllowed: true,
		});
		// Full access with the terminal on right now, the pair the bash tool's own
		// gate reads; asked on every call, so turning either off closes the next one.
		const persistentRoomTerminalOn = (): boolean => {
			try {
				const livePolicy = resolvePersistentRoomEffectiveWorkspacePolicy(persistentAgentId, persistentConversationId);
				return livePolicy?.workspaceAccessMode === "localFiles" && livePolicy?.bashEnabled === true;
			} catch {
				return false;
			}
		};
		const persistentRoomCustomTools = persistentRoomWorkspaceToolsEnabled && persistentRoomCapabilityPolicy
			// Full access file tools resolve paths against the same cwd the session
			// itself binds with below.
			? createPersistentRoomWorkspaceTools(persistentRoomCapabilityPolicy, {
				localFilesCwd: persistentRoomRuntimeCwdForEffectiveWorkspacePolicy(persistentRoomEffectiveWorkspacePolicy, REPO_ROOT),
				skillsFolder: () => (persistentRoomTerminalOn() ? agentSkillsDir() : null),
				terminalOn: persistentRoomTerminalOn,
			})
			: [];
		if (persistentRoomWorkspaceToolsEnabled) {
			const allowedToolNames = persistentRoomToolPolicy?.allowedToolNames ?? [];
			const customToolNames = persistentRoomCustomTools.map((tool) => String(tool.name));
			const workspaceToolNames = persistentRoomEffectiveWorkspacePolicy?.allowedToolNames ?? [];
			const customToolSet = new Set(customToolNames);
			if (
				!workspaceToolNames.every((toolName) => allowedToolNames.includes(toolName)) ||
				!customToolNames.every((toolName) => workspaceToolNames.includes(toolName)) ||
				customToolNames.length !== workspaceToolNames.length || !workspaceToolNames.every((toolName) => customToolSet.has(toolName))
			) {
				throw new Error("persistent-room workspace tool policy mismatch");
			}
		}
		const persistentRoomWorkspaceCapability = persistentRoomEffectiveWorkspacePolicy?.capability;
		if (persistentAgentThreadLoadError) throw new Error(`failed to load persistent-agent thread runtime: ${persistentAgentThreadLoadError.message}`);
		// A prepared conversation nobody has spoken in yet boots on the room's
		// memory as it is now, not as it was when Remember or Forget prepared it
		// (Maintain may have run in between). Best effort: on failure the thread
		// boots on its snapshot exactly as before.
		if (persistentAgentThreadForSession?.runtime.kind === "pi-session-jsonl") {
			try {
				const refresh = refreshEmptyPersistentAgentThreadBootSnapshot(persistentAgentId, persistentConversationId);
				if (refresh?.rebuilt) {
					persistentAgentThreadForSession = refresh.thread;
					app.log.info({ roomId: persistentAgentId, threadId: persistentConversationId, l1bFingerprintBefore: refresh.rebuilt.before.value, l1bFingerprintAfter: refresh.rebuilt.after.value }, "rebuilt the boot snapshot of an empty prepared conversation on the current memory");
				}
			} catch (error) {
				app.log.warn({ err: (error as Error).message, roomId: persistentAgentId, threadId: persistentConversationId }, "empty conversation boot snapshot refresh failed");
			}
		}
		const persistentRoomThreadRuntime = persistentAgentThreadForSession?.runtime;
		// Skills MR-5 (spec §5): the room's EFFECTIVE enabled set — hash-pinned and
		// verified by effectiveEnabledSkills, so drifted/deleted skills never reach
		// the session. Resolved FRESH for every turn (the per-turn prompt assembly
		// below calls this), so enabling a skill mid-session lands on the very
		// next message; the read_skill tool re-verifies the live set + hash pin
		// on every call regardless.
		const resolvePersistentRoomEnabledSkillEntries = (): { name: string; description: string }[] => {
			try {
				const skillSettings = readPersistentRoomSkillSettings(persistentAgentId);
				const effective = effectiveEnabledSkills(skillSettings.enabledSkills, skillLibraryFingerprint);
				if (effective.length === 0) return [];
				// Description comes from the SAME manifest the fingerprint pins, so the
				// index can never surface a description whose change was not re-reviewed.
				// A skill whose author disabled model invocation is withheld from the
				// index entirely: the model is never told about it, so it cannot
				// auto-invoke it. (Rooms have no manual trigger yet; when one exists it
				// will reach these by an explicit user path, not this autonomous index.)
				const entries: { name: string; description: string }[] = [];
				for (const skill of effective) {
					const manifest = resolveLibrarySkillManifest(skill.name);
					if (!manifest || manifest.disableModelInvocation) continue;
					entries.push({ name: skill.name, description: manifest.description });
				}
				return entries;
			} catch (error) {
				app.log.warn({ err: error }, "failed to resolve enabled skills for room session");
				return [];
			}
		};
		// read_skill is registered unconditionally: gating registration on the
		// connect-time enabled set meant a room that connected with zero skills
		// had no tool for a skill enabled mid-session — the index now reaches it
		// per turn, so the tool must be there to follow through. The security
		// floor was never registration: the tool itself refuses anything outside
		// the room's LIVE enabled set (hash-verified) on every call.
		const persistentRoomSkillTools = [createReadSkillTool({
			agentId: persistentAgentId,
			// The tool verifies the pinned manifest hash and returns the defanged
			// body; both come from one manifest read, so verified and served bytes
			// can never diverge.
			lookupSkill: (name) => {
				const resolved = resolveLibrarySkillManifest(name);
				return resolved ? { manifest: resolved.manifest, body: resolved.body, description: resolved.description, disableModelInvocation: resolved.disableModelInvocation } : null;
			},
			telemetry: persistentRoomSkillTelemetry,
			// The executable-skills gate chain, re-evaluated on EVERY read, so a
			// gate that closes mid-session closes exposure on the next call. Every
			// check is a hard boolean; any miss serves the body path-free, exactly
			// as before the feature existed.
			resolveExecutionExposure: (name) => {
				// Only a live manual turn — background and scheduled runs never see
				// a path. That holds by construction: this closure is built only in
				// the live WS session (the manual surface); background, scheduled,
				// and specialist sessions never register read_skill at all, matching
				// bash itself (which they also never get). It must NOT be re-derived
				// from EXXETA_PERSISTENT_ROOM_EXECUTION_CONTEXT here: that env var
				// exists only inside the extension-install bracket (set, snapshotted
				// by the permissions extension, restored on install completion), so a
				// live read at tool-call time always saw it unset and the gate could
				// never open.
				if (!persistentRoomTerminalOn()) return null;
				// The room must hold an execution approval for this skill, pinned
				// to the EXACT files on disk right now — a drifted file set is an
				// approval that no longer exists.
				const pinned = readPersistentRoomSkillSettings(persistentAgentId).enabledSkills.find((skill) => skill.name === name);
				if (!pinned?.executeApproval) return null;
				const executable = resolveExecutableSkillFiles(name);
				if (!executable || executable.filesSha256 !== pinned.executeApproval.filesSha256) return null;
				return { skillDir: executable.skillDir, files: executable.files };
			},
		})];
		// The shelf pair (files core slice): default-on for every room, fenced to
		// the room's own files/ folder by the tools themselves — deliberately
		// OUTSIDE the workspace grant plumbing and its mismatch check above.
		const persistentRoomShelfTools = createPersistentRoomShelfTools({ roomId: persistentAgentId });
		// The room's own tools, said in one line each. A tool declares that line
		// itself, as its promptSnippet; the runtime renders those snippets into
		// the default system prompt's tool section, which a room never gets — a
		// room serves a raw prompt of its own, so a tool it HAS was a tool it was
		// never told about in words, only in the schema on the wire. This stanza
		// closes that: the snippet's own words, nothing copied from the tool's
		// description, one line per room tool that carries one. A list where
		// nothing carries a snippet renders nothing at all, heading included.
		const buildRoomToolsSection = (tools: readonly { name: string; promptSnippet?: string }[]): string => {
			const lines = tools
				.filter((tool) => typeof tool?.promptSnippet === "string" && tool.promptSnippet.trim().length > 0)
				.map((tool) => `- ${tool.name}: ${(tool.promptSnippet as string).trim()}`);
			if (lines.length === 0) return "";
			return `

## Room tools

${lines.join("\n")}`;
		};
		// The room's live state rides one hidden room-state message
		// (room-state-message.ts), not the system prompt: the current identity
		// (agent.json is the live name authority; the frozen boot snapshot cannot
		// learn about a rename), the instructions against the ones the thread
		// booted with, the current workspace (the default applies live, so the
		// model never claims a stale one), the enabled skills (read_skill enforces
		// the live set per call) and the Attachments list. Each is read fresh at every
		// message, and a copy is sent only when it says something the latest copy
		// does not, so a change no longer rewrites the whole conversation to the
		// provider's cache. A part that fails to build keeps the latest copy's.
		// The system prompt gains only the room-tools stanza, built once: the
		// room's tools are resolved at bind, so it is the same for every turn of
		// this bind and for a reconnect that binds the same tools.
		const liveRoomStateExtForSession = async (pi: any) => {
			let roomToolsSection = "";
			try {
				roomToolsSection = buildRoomToolsSection([...persistentRoomMemoryTools, ...persistentRoomShelfTools]);
			} catch (error) {
				app.log.warn({ err: (error as Error).message }, "room tools section build failed");
			}
			pi.on("before_agent_start", async (event: { systemPrompt: string }, ctx: { sessionManager: SessionManager }) => {
				// The thread record carries the fingerprint it booted with (a legacy
				// record without it falls back to the marker in the frozen prompt). A
				// connection that built its own boot context at connect (no snapshot-
				// backed record yet) knows what it booted with just as well.
				const bootedFingerprint = persistentRoomThreadRuntime?.kind === "pi-session-jsonl"
					? persistentRoomThreadRuntime.instructionsFingerprint
					: persistentRoomBootContext ? fingerprintPersistentAgentBootContextInstructions(persistentRoomBootContext) : undefined;
				let workspace: string | null = null;
				try {
					workspace = buildPersistentRoomCurrentWorkspaceSection(resolvePersistentRoomEffectiveWorkspacePolicy(persistentAgentId, persistentConversationId));
				} catch (error) {
					app.log.warn({ err: (error as Error).message }, "current workspace section build failed");
				}
				let files: string | null = null;
				try {
					files = buildShelfManifestSection(persistentAgentId);
				} catch (error) {
					app.log.warn({ err: (error as Error).message }, "shelf manifest build failed");
				}
				const message = nextRoomStateMessage({
					identity: buildPersistentAgentCurrentIdentitySection(persistentAgentId),
					instructions: readPersistentRoomInstructionsNow(persistentAgentId, event.systemPrompt, bootedFingerprint !== undefined ? { bootedFingerprint } : {}),
					workspace,
					skills: buildEnabledSkillsIndexSection(resolvePersistentRoomEnabledSkillEntries()),
					files,
				}, ctx.sessionManager);
				return { ...(roomToolsSection ? { systemPrompt: `${event.systemPrompt}${roomToolsSection}` } : {}), ...(message ? { message } : {}) };
			});
		};
		const persistentRoomBootContext = persistentRoomThreadRuntime?.kind !== "pi-session-jsonl"
			? buildPersistentAgentBootContext({
				agentId: persistentAgentId,
				conversationId: persistentConversationId,
				sessionId: null,
				model: persistentRoomModel,
				...(persistentRoomWorkspaceCapability ? { workspaceCapability: persistentRoomWorkspaceCapability } : {}),
			})
			: undefined;
		// The enabled-skills index (skills MR-5, spec §5) used to be appended here
		// at connect; it now rides the per-turn assembly above, so a skill enabled
		// mid-session is listed on the very next message instead of the next open.
		// The installation section is a connect-time append, not part of the
		// frozen boot snapshot, so a conversation reopened after an update names
		// the version now running and links its docs.
		const persistentRoomRawBootPrompt = persistentRoomThreadRuntime?.kind === "pi-session-jsonl"
			? readPersistentAgentBootPromptSnapshot(persistentAgentId, persistentRoomThreadRuntime)
			: persistentRoomBootContext?.systemPrompt;
		const persistentRoomRawSystemPrompt = persistentRoomRawBootPrompt != null
			? `${persistentRoomRawBootPrompt}${PERSISTENT_ROOM_INSTALLATION_SECTION}`
			: persistentRoomRawBootPrompt;
		// Deadlock guard: a room whose memory alone fills this model's window can
		// never recover in chat (compaction cannot shrink the system prompt), so
		// refuse to start here, with the remedy, instead of failing on turn one.
		// What it measures is the boot prompt and the installation section, not all a
		// turn sends: the per-turn hook appends the room-tools stanza, and the
		// room-state message (identity, instructions, workspace, skills and the
		// Attachments list) rides after the person's message. Both ride in the headroom
		// this check leaves, unmeasured by it. The instructions are the one
		// user-sized part: up to the 8,000-character cap when saved through the
		// pane, and whatever a hand-written file holds, since the read takes the
		// file cap or no cap.
		// Every way a room comes alive (new
		// thread, resume, after Remember or Forget) passes through this connect,
		// so this is the single guard point.
		if (persistentRoomRawSystemPrompt != null) {
			assertPersistentAgentBootPromptFitsWindow({
				agentId: persistentAgentId,
				conversationId: persistentConversationId,
				model: persistentRoomModel,
				systemPrompt: persistentRoomRawSystemPrompt,
				window: { contextWindow: webChatModel.contextWindow, maxOutputTokens: webChatModel.maxTokens },
			});
		}
		const persistentRoomRuntimeCwd = persistentRoomRuntimeCwdForEffectiveWorkspacePolicy(persistentRoomEffectiveWorkspacePolicy, REPO_ROOT);
		const persistentRoomSessionManager = persistentRoomThreadRuntime?.kind === "pi-session-jsonl"
			? openPersistentAgentPiSessionManager(persistentAgentId, persistentRoomThreadRuntime, persistentRoomRuntimeCwd)
			: undefined;
		// The room's read of its own memory: default-on beside the shelf pair,
		// fenced to this room's own notes, archive and remembered conversations,
		// and read-only — a pointer line the room cannot follow is just a regret.
		// It is built here rather than up with the shelf pair because it reads a
		// folded conversation's transcript through the session manager, so it
		// needs the SAME working directory the room's own session was opened
		// with, or it would resolve a session file the room never wrote.
		const persistentRoomMemoryTools = [createPersistentRoomMemoryRecallTool({
			roomId: persistentAgentId,
			runtimeCwd: persistentRoomRuntimeCwd,
			// How much of the room's context one recall may spend is a share of
			// the window of the model the room is answering on RIGHT NOW: the live
			// session's own model once it is bound, and the model this connect
			// resolved until then, looked up in the catalogue exactly as the
			// boot-fit and compaction paths look it up. A model nobody can find
			// says null, and the tool falls back to its fixed budget.
			resolveWindow: () => {
				const liveModel = (session as any)?.model;
				const provider = String(liveModel?.provider ?? persistentRoomModel.provider);
				const modelId = String(liveModel?.id ?? persistentRoomModel.model);
				try {
					return modelContextWindow(getWebChatModelRegistry().find(provider, modelId)) ?? null;
				} catch {
					return null;
				}
			},
		})];
		const permissionsExtForSession = async (pi: any) => {
			const previousPersistentRoomSession = process.env.EXXETA_PERSISTENT_ROOM_SESSION;
			const previousPersistentRoomAgent = process.env.EXXETA_PERSISTENT_ROOM_AGENT;
			const previousPersistentRoomWorkspaceAccessMode = process.env.EXXETA_PERSISTENT_ROOM_WORKSPACE_ACCESS_MODE;
			const previousPersistentRoomWorkspaceTools = process.env.EXXETA_PERSISTENT_ROOM_WORKSPACE_TOOLS;
			const previousPersistentRoomBashEnabled = process.env.EXXETA_PERSISTENT_ROOM_BASH_ENABLED;
			const previousPersistentRoomExecutionContext = process.env.EXXETA_PERSISTENT_ROOM_EXECUTION_CONTEXT;
			if (persistentRoomWorkspaceToolsEnabled) {
				process.env.EXXETA_PERSISTENT_ROOM_SESSION = "1";
				process.env.EXXETA_PERSISTENT_ROOM_AGENT = persistentAgentId;
				process.env.EXXETA_PERSISTENT_ROOM_WORKSPACE_ACCESS_MODE = persistentRoomEffectiveWorkspacePolicy?.workspaceAccessMode ?? "bounded";
				process.env.EXXETA_PERSISTENT_ROOM_WORKSPACE_TOOLS = (persistentRoomEffectiveWorkspacePolicy?.allowedToolNames ?? []).join(",");
				process.env.EXXETA_PERSISTENT_ROOM_BASH_ENABLED = persistentRoomEffectiveWorkspacePolicy?.bashEnabled === true ? "1" : "";
				process.env.EXXETA_PERSISTENT_ROOM_EXECUTION_CONTEXT = "manual";
			} else {
				delete process.env.EXXETA_PERSISTENT_ROOM_SESSION;
				delete process.env.EXXETA_PERSISTENT_ROOM_AGENT;
				delete process.env.EXXETA_PERSISTENT_ROOM_WORKSPACE_ACCESS_MODE;
				delete process.env.EXXETA_PERSISTENT_ROOM_WORKSPACE_TOOLS;
				delete process.env.EXXETA_PERSISTENT_ROOM_BASH_ENABLED;
				delete process.env.EXXETA_PERSISTENT_ROOM_EXECUTION_CONTEXT;
			}
			try {
				await (permissionsExt as any)(pi);
			} finally {
				if (previousPersistentRoomSession === undefined) delete process.env.EXXETA_PERSISTENT_ROOM_SESSION;
				else process.env.EXXETA_PERSISTENT_ROOM_SESSION = previousPersistentRoomSession;
				if (previousPersistentRoomAgent === undefined) delete process.env.EXXETA_PERSISTENT_ROOM_AGENT;
				else process.env.EXXETA_PERSISTENT_ROOM_AGENT = previousPersistentRoomAgent;
				if (previousPersistentRoomWorkspaceAccessMode === undefined) delete process.env.EXXETA_PERSISTENT_ROOM_WORKSPACE_ACCESS_MODE;
				else process.env.EXXETA_PERSISTENT_ROOM_WORKSPACE_ACCESS_MODE = previousPersistentRoomWorkspaceAccessMode;
				if (previousPersistentRoomWorkspaceTools === undefined) delete process.env.EXXETA_PERSISTENT_ROOM_WORKSPACE_TOOLS;
				else process.env.EXXETA_PERSISTENT_ROOM_WORKSPACE_TOOLS = previousPersistentRoomWorkspaceTools;
				if (previousPersistentRoomBashEnabled === undefined) delete process.env.EXXETA_PERSISTENT_ROOM_BASH_ENABLED;
				else process.env.EXXETA_PERSISTENT_ROOM_BASH_ENABLED = previousPersistentRoomBashEnabled;
				if (previousPersistentRoomExecutionContext === undefined) delete process.env.EXXETA_PERSISTENT_ROOM_EXECUTION_CONTEXT;
				else process.env.EXXETA_PERSISTENT_ROOM_EXECUTION_CONTEXT = previousPersistentRoomExecutionContext;
			}
		};
		// Per-room MCP: the wrapper reports the grants fingerprint its manifest
		// description was ACTUALLY built from. Recording that same read (rather
		// than reading again after the bind) closes the race where a grant edit
		// between the two reads would leave the manifest stale for the whole
		// connection: any such edit now differs from the captured fingerprint
		// and rebinds before the next turn.
		let mcpGrantsFingerprintAtBind: string | null = null;
		// Read once here and used for both halves of the same decision: which
		// search tool this session registers, and what the prompt path compares
		// against to notice the setting changed under it. Two reads could
		// disagree across a save landing between them, and the two halves
		// disagreeing is exactly the state that sends both tools to a provider
		// that will only accept one.
		const nativeSearchDecisionAtBind = resolveNativeProviderSearchDecision(webChatModel.provider);
		const registerClientWebSearchAtBind = shouldRegisterClientWebSearch(nativeSearchDecisionAtBind);
		const nativeProviderSearchAtBind = nativeSearchDecisionAtBind.active;
		const extensionFactories = [
			contentPolicyExt as any,
			permissionsExtForSession as any,
			// Per-command bash approval (workspace reshape slice e): a live
			// Full-access session pauses every bash call on an approval card in
			// the chat unless the room's auto-approve setting is on. Ordered
			// after the permissions extension so a room that has no bash at all
			// is refused before anyone is asked to approve anything. Built only
			// here, in the live web bind: background, scheduled, and specialist
			// runs never construct the guard (they never get bash either).
			createPersistentRoomBashApprovalExtension(createPersistentRoomBashApprovalGuard({
				// Fresh read on every bash call (like the read_skill exposure
				// gate): flipping the room's auto-approve setting applies to the
				// very next command, no rebind. An unreadable file asks.
				isAutoApproved: () => {
					try {
						return readPersistentRoomBashSettings(persistentAgentId).autoApprove === true;
					} catch {
						return false;
					}
				},
			})) as any,
			// A command that finds no shell (Windows without Git) answers the
			// person and the model with one plain line; the raw text is logged.
			createPersistentRoomShellMissingExtension((raw) => app.log.warn({ detail: raw }, "shell commands: no shell found")) as any,
			artifactsExt as any,
			// Per-room MCP: the session's connector surface goes through the shared
			// room-scope wrapper, keyed to this room.
			createRoomScopedMcpExtension(persistentAgentId, { onBoundGrants: (fingerprint) => { mcpGrantsFingerprintAtBind = fingerprint; } }) as any,
			// The room's own web search and the provider's own are the same name
			// on the wire, so exactly one of them is offered per session. When the
			// model searches for itself the local tool stands down; fetch_url is
			// untouched either way, since opening a page you were handed is a
			// different job from finding one.
			...(registerClientWebSearchAtBind ? [webSearchExt as any] : []),
			// Carries the decision this session bound with, so every round trip of
			// every turn asks for the same thing the tool registry was built for.
			createNativeProviderSearchExtension(nativeSearchDecisionAtBind) as any,
			fetchUrlExt as any,
			liveRoomStateExtForSession as any,
			// Ages the room's own bulky tool results out of the replayed context.
			// Ordered ahead of the diagnostics extension so what diagnostics
			// measures is the message list the provider will actually receive.
			toolResultAgingExt as any,
			...(promptDiagnosticsEnabledForConnection && persistentRoomModel ? [persistentRoomPromptDiagnosticsExt(persistentRoomModel) as any] : []),
		];
		const sessionRuntimeCwd = persistentRoomRuntimeCwd;
		const loader = new DefaultResourceLoader({
			cwd: sessionRuntimeCwd,
			agentDir: getAgentDir(),
			settingsManager: roomLoaderSettings(sessionRuntimeCwd, getAgentDir()),
			noExtensions: true,
			noContextFiles: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			extensionFactories,
			appendSystemPromptOverride: (base) => base,
		});
		await loader.reload();
		const created = await createAgentSession({
			cwd: sessionRuntimeCwd,
			resourceLoader: loader,
			sessionManager: persistentRoomSessionManager ?? SessionManager.inMemory(sessionRuntimeCwd),
			modelRegistry: webChatModelRegistry,
			model: webChatModel,
			cacheRetention: callCacheRetention("chat", webChatModel),
			...(persistentRoomRawSystemPrompt ? { rawSystemPrompt: persistentRoomRawSystemPrompt } : {}),
			// read_skill rides beside the workspace tools: appended
			// AFTER the workspace-policy mismatch check (they are not workspace
			// tools) and added to the allowlist explicitly, since customTools are
			// allowlist-filtered.
			...(persistentRoomToolPolicy ? { tools: [...persistentRoomToolPolicy.allowedToolNames, ...persistentRoomSkillTools.map((tool) => tool.name)] } : {}),
			// Shelf tools and the archived-notes read ride beside skills:
			// appended AFTER the workspace-policy mismatch check (they are not
			// workspace tools); their names are already in the policy allowlist
			// (default-on lane).
			...(persistentRoomCustomTools.length + persistentRoomSkillTools.length + persistentRoomShelfTools.length + persistentRoomMemoryTools.length > 0 ? { customTools: [...persistentRoomCustomTools, ...persistentRoomSkillTools, ...persistentRoomShelfTools, ...persistentRoomMemoryTools] } : {}),
		});
		session = created.session;
		// Steers go in all at once: messages the person sent while one step ran
		// all land after that step, not one per model call. Set on the agent,
		// not through setSteeringMode, which would write the person's settings.json.
		session.agent.steeringMode = "all";
		steerIntake = { runtime: 0, heard: 0 };
		session.agent.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "user") steerIntake.runtime++;
		});
		sessionDisposed = false;
		// Recorded only once the session EXISTS: a rebind that throws above must
		// leave the old fingerprint in place, so the next prompt frame still sees
		// the mismatch and retries instead of prompting a disposed session forever.
		boundWorkspaceFingerprint = persistentRoomEffectiveWorkspacePolicy.fingerprint.value;
		// Prefer the fingerprint of the read the manifest description used; the
		// fresh-read fallback only covers configs where no proxy tool registered.
		boundMcpGrantsFingerprint = mcpGrantsFingerprintAtBind ?? persistentRoomMcpGrantsFingerprint(persistentAgentId);
		boundNativeProviderSearch = nativeProviderSearchAtBind;
		boundSessionProviderId = webChatModel.provider;
		await session.bindExtensions({ uiContext });
		// The blocked list was only ever computed until here; check it against the
		// session's actual registered tools (extensions included, so after bind)
		// so a leaked tool fails the bind instead of quietly riding along.
		if (persistentRoomToolPolicy) {
			const leaked = persistentRoomBlockedToolLeaks(persistentRoomToolPolicy, session.getActiveToolNames());
			if (leaked.length > 0) throw new Error(`persistent-room blocked tool leaked into session: ${leaked[0]}`);
		}
		// The conversation's effort outlives the connection AND the session: a
		// rebind (workspace/MCP settings, adopted turn) rebuilds the session at
		// the runtime default, so its level is re-applied here rather than only
		// on the prompt path. A conversation with messages and no level of its
		// own (one from before levels were kept per conversation) takes the
		// room's default as its own now, or the level its session restored when
		// the room has none, so a later default reaches only new conversations.
		if (!persistentAgentThreadIsEmpty(persistentAgentId, persistentConversationId)) settleConversationEffortChoice(persistentAgentId, persistentConversationId, session.thinkingLevel);
		const boundEffortChoice = effectiveConversationEffortChoice(persistentAgentId, persistentConversationId);
		if (boundEffortChoice) applyRoomEffortToSession(session, boundEffortChoice);
		if (persistentRoomBootContext && persistentRoomModel && promptDiagnosticsEnabledForConnection) {
			try {
				recordPersistentRoomPromptDiagnostics({
					agentId: persistentAgentId,
					conversationId: persistentConversationId,
					bootContext: persistentRoomBootContext,
					model: persistentRoomModel,
					loader,
					session,
				});
			} catch (error) {
				app.log.warn({ err: error }, "failed to record persistent-room prompt diagnostics");
			}
		}
		const projectAgentEventForWebClient = createWebClientEventProjector();
		session.subscribe((event) => {
			if (activePersistentWebTurn && !activePersistentWebTurn.promptSettled) noteTurnProgress(event as { type?: string; toolCallId?: string });
			// A keyed turn's frames name the item each opens, and its step log keeps the answer by stretch.
			const keyedSteps = keyedTurn && activePersistentWebTurn && keyedTurn.steps === turnSteps ? turnSteps : null;
			const frameIds = keyedSteps ? keyedSteps.frame(event) : {};
			const providerTool = event?.type === "message_update" ? (event as any).assistantMessageEvent : undefined;
			if (providerTool?.type === "server_tool_start" && providerTool.id) providerToolsRunning.add(String(providerTool.id));
			else if (providerTool?.type === "server_tool_end") providerToolsRunning.delete(String(providerTool.id));
			else if (event?.type === "message_end" || event?.type === "agent_end") providerToolsRunning.clear();
			if (event?.type === "message_start" && event.message?.role === "user") steerIntake.heard++;
			if (event?.type === "message_start" && event.message?.role === "user" && activePersistentWebTurn && !autoSummaryRunning) {
				const taken = turnPromptMessageSeen ? pendingSteers.shift() : undefined;
				turnPromptMessageSeen = true;
				if (taken) {
					turnSteps.tookMessage(bubbleIdOf(taken.id), taken.text);
					takenSteers.set(answerNoteKey(), [...(takenSteers.get(answerNoteKey()) ?? []), { id: taken.id }].slice(-TAKEN_STEERS_KEPT));
					sendTurnFrame({ type: "steer_taken", id: taken.id, text: taken.text });
				}
			}
			// Turn frames route through the reattach-aware sender, so a
			// session stepping back in can replay them and then receive the rest.
			// A turn refused for a key's credential carries the key's state, so the room names it.
			const ended = event?.type === "message_end" ? (event.message as { stopReason?: string; provider?: string; model?: string; errorMessage?: string; content?: unknown; timestamp?: number }) : undefined;
			// The status and error type the runtime kept beside the words, read where the words name nothing.
			const codes = failureCodesOf(ended ?? (event?.type === "auto_retry_start" ? event : undefined));
			const credential = ended?.stopReason === "error" ? failedTurnCredential(String(ended.provider ?? ""), String(ended.errorMessage ?? ""), codes) : undefined;
			const credentialKey = credential === "signed-out" ? undefined : credential;
			if (ended?.provider && ended.stopReason !== "aborted") noteKeyOutcome(String(ended.provider), ended.stopReason === "error" ? credential : "answered", ended.timestamp);
			// A spent quota will not come back within the runtime's retries: they are stopped once its wait starts, and the usage-limit line stays.
			const quotaStopsRetry = (words: string) => turnFailureOf(words, false, "", false, codes) === "quota";
			if (event?.type === "auto_retry_start" && quotaStopsRetry(String((event as any).errorMessage ?? ""))) {
				stoppedForQuota = true;
				queueMicrotask(() => session?.abortRetry());
				return;
			}
			// Every failed turn and every retry carries its cause, so the room says what happened in plain words.
			const failure = ended && emptyAnswer(ended) ? "empty-answer" : ended?.stopReason === "error" ? turnFailureOf(String(ended.errorMessage ?? ""), ((session as any)?.retryAttempt ?? 0) > 0, String(ended.provider ?? ""), answerStarted(ended.content), codes) : event?.type === "auto_retry_start" ? retryFailureOf(String((event as any).errorMessage ?? ""), codes) : undefined;
			if (ended?.stopReason === "error") logProviderCallFailed({ room: persistentAgentIdForSession, callKind: "chat", provider: String(ended.provider ?? ""), model: ended.model }, failedMessageError(String(ended.errorMessage ?? ""), codes));
			// A gateway's bare "not found": its line is said at once, and worded again once the gateway's model list says why.
			if (failure === "gateway-not-found" && ended) {
				const notFound = { provider: String(ended.provider ?? ""), model: String(ended.model ?? "") };
				void gatewayModelFind(notFound.provider, notFound.model).then((find) => sendTurnFrame({ type: "gateway_not_found", find, model: notFound }));
			}
			// A retry names the model it asks again, so a page that joins mid-retry names it too.
			const retryModel = event?.type === "auto_retry_start" && (session as any)?.model ? { provider: String((session as any).model.provider ?? ""), model: String((session as any).model.id ?? "") } : undefined;
			// A failed attempt the runtime asks again: its end draws no line and its run's end keeps Stop, since the retry announces itself just after.
			// Only the attempt that ends the turn says why; a spent quota's retry is stopped above, so its line stays.
			const lastAttempt = event?.type === "agent_end" ? [...event.messages].reverse().find((message) => message.role === "assistant") : event?.type === "message_end" && ended?.stopReason === "error" ? event.message : undefined;
			const retrying = lastAttempt?.role === "assistant" && session?.retriesAfter(lastAttempt) === true && !(ended && quotaStopsRetry(String(ended.errorMessage ?? "")));
			// Why a turn ended early, in one field, so every page that watched it picks the same line. It rides the frame that ends the
			// turn for the page: the run's end when nothing is asked again, or the end of a retry wait that Stop or a failure cut short.
			const endsTurn = (event?.type === "agent_end" && !retrying) || (event?.type === "auto_retry_end" && !event.success);
			const endedBy = endsTurn ? turnEndedByOf(activePersistentWebTurn) : null;
			if (endsTurn && activePersistentWebTurn && turnWindingDown?.turnId !== activePersistentWebTurn.turnId) {
				let finish = () => {};
				const done = new Promise<void>((resolve) => { finish = resolve; });
				turnWindingDown = { turnId: activePersistentWebTurn.turnId, done, finish };
			}
			const keyedEnd = keyedSteps && event?.type === "message_end" && (event as any).message?.role === "assistant" ? keyedSteps.note((event as any).message, { retrying, shownAtStop: activePersistentWebTurn?.shownAtStop }) : {};
			const projected = withFrameIds(projectAgentEventForWebClient(event), frameIds, keyedEnd.echoOf);
			sendTurnFrame({ type: "event", event: credentialKey || failure || retryModel || retrying || endedBy ? { ...projected, ...(credentialKey ? { credentialKey } : {}), ...(failure ? { failure } : {}), ...(retryModel ? { model: retryModel } : {}), ...(failure === "quota" ? { quotaWay: quotaWayOf(String(ended?.provider ?? ""), String(ended?.errorMessage ?? "")) } : {}), ...(retrying ? { retrying: true } : {}), ...(endedBy ? { endedBy } : {}) } : projected });
			// A failed auto-compaction used to vanish here: the client ignores the
			// event, nothing was logged, and the room quietly paid for the same
			// summary again on every later turn. Say it once per attempt. This is
			// a notify line rather than an error frame: the error frame ends the
			// turn on the client (busy off, stream flushed), and the runtime
			// re-checks compaction at the START of every later prompt, where that
			// would unlock the composer mid-turn.
			if (event.type === "compaction_start" && (event as any).reason === "overflow") {
				overflowRecoveryStopped = false;
				overflowRecovery = new Promise((resolve) => {
					const end = (askAgain: boolean) => resolve(askAgain);
					endOverflowRecovery = end;
					// At the ceiling nobody stopped it, so a failed shortening says so as usual.
					setTimeout(() => { if (endOverflowRecovery === end) stopOverflowRecovery(false); }, OVERFLOW_RECOVERY_CEILING_MS).unref();
				});
			}
			if (event.type === "compaction_end" && (event as any).reason === "overflow") {
				endOverflowRecovery?.(Boolean((event as any).result) && Boolean((event as any).willRetry));
				endOverflowRecovery = undefined;
				const stoppedQuietly = overflowRecoveryStopped;
				overflowRecoveryStopped = false;
				if (stoppedQuietly && ((event as any).aborted || (event as any).errorMessage)) {
					app.log.info({ agentId: persistentAgentIdForSession }, "overflow shortening stopped with its turn");
					return;
				}
			}
			if (event.type === "compaction_end" && (event as any).errorMessage) {
				const compactionError = String((event as any).errorMessage);
				app.log.warn({ agentId: persistentAgentIdForSession, reason: (event as any).reason, err: compactionError }, "auto-compaction failed");
				// The runtime's words stay in the log. A turn may try to condense twice
				// (before and after); the line is said once per turn.
				if (lastCompactionNoticeCause !== undefined) return;
				lastCompactionNoticeCause = compactionError;
				const compactionModel = (session as any)?.model;
				const compactionProvider = String(compactionModel?.provider ?? "");
				// The summary call's own cause: a size problem keeps the room's words, any other cause (a rate limit, a lost connection) the chat's line for it.
				const read = compactionFailureOf(compactionError, compactionProvider);
				sendTurnFrame({
					type: "ui_request",
					kind: "notify",
					id: `compaction_${Date.now().toString(36)}`,
					level: "error",
					// What the page words its failure row from: the cause, the provider's words for Details, and whether a message failed for it (overflow) or an answer had landed (threshold).
					failure: read.failure ?? "could-not-shorten",
					reason: (event as any).reason,
					summaryCut: read.summaryCut,
					...(compactionModel ? { model: { provider: compactionProvider, model: String(compactionModel.id ?? "") } } : {}),
					...(read.words ? { words: read.words } : {}),
					...(read.failure === "quota" ? { quotaWay: quotaWayOf(compactionProvider, read.words ?? "") } : {}),
				});
			}
			if (event.type === "message_end" && (event as any).message?.role === "assistant") {
				const msg = (event as any).message;
				if (!keyedSteps) turnSteps.note(msg);
				// A cut or Stop keeps only the words the page had shown of the message it stopped: a landing never brings back what Stop threw away.
				const shownAtStop = msg.stopReason === "aborted" ? activePersistentWebTurn?.shownAtStop : undefined;
				const text = shownAtStop !== undefined ? shownPart(revealedTextOf(msg.content), shownAtStop) : textFromParts(msg.content);
				const landed = landedTextAfter({ text: turnTrace.finalAssistantText, retryFrom: turnTrace.retryFrom }, text, retrying);
				turnTrace.finalAssistantText = landed.text;
				turnTrace.retryFrom = landed.retryFrom;
				if (turnTrace.sawToolResult && text) turnTrace.sawAssistantAfterToolResult = true;
				if (Array.isArray(msg.content)) {
					for (const part of msg.content) {
						if (part?.type !== "toolCall") continue;
						const id = part.id ?? part.toolCallId;
						const name = String(part.name ?? "?");
						if (id) turnTrace.toolNameById.set(String(id), name);
						if (isRetrievalTool(name)) turnTrace.usedRetrievalTools = true;
						const args = part.arguments ?? part.args ?? {};
						turnTrace.toolCalls.push({ id: id ? String(id) : undefined, name, args });
					}
				}
				const u = msg.usage;
				if (u && !answerlessCallMovedNothing(msg)) {
					const toolsUsed = turnTrace.toolCalls.map((t) => t.name).filter(Boolean);
					const currentModel = (session as any)?.model;
					const modelLabel = currentModel ? webChatModelLabel(currentModel.provider, currentModel) : undefined;
					const turnProvider: string | undefined = currentModel?.provider ?? msg.provider ?? undefined;
					recordUsage({ ts: Date.now(), agent: activeOwner, persona, model: msg.model, modelLabel, provider: turnProvider, authType: resolveUsageAuthType(turnProvider, true), kind: "chat", input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0, ...(u.cacheWrite1h ? { cacheWrite1h: u.cacheWrite1h } : {}), cost: u.cost?.total ?? 0, tools: toolsUsed.length ? toolsUsed : undefined });
					sendTurnFrame({ type: "usage_turn", agent: activeOwner, model: msg.model, modelProvider: msg.provider, modelLabel, input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0, cost: u.cost?.total ?? 0, totalTokens: u.totalTokens ?? 0, contextTokens: u.contextTokens ?? null, contextHealth: contextHealthForSession(session) });
				}
			}
			if (event.type === "message_end" && (event as any).message?.role === "toolResult") {
				const msg = (event as any).message;
				turnSteps.note(msg);
				const toolCallId = msg.toolCallId ? String(msg.toolCallId) : "";
				const name = String(msg.toolName ?? (toolCallId ? turnTrace.toolNameById.get(toolCallId) : undefined) ?? "tool");
				turnTrace.sawToolResult = true;
				if (isRetrievalTool(name)) turnTrace.usedRetrievalTools = true;
				const resultText = textFromParts(msg.content);
				turnTrace.toolResults.push({ name, text: resultText, isError: !!msg.isError });
			}
		});
	};

	const maybeAutoSummarizeToolTurn = async () => {
		// The recovery is a fresh paid turn, and a stopping server's exit would end it.
		if (!session || autoSummaryRunning || serverStopping()) return;
		const turnTerminalReason = activePersistentWebTurn?.terminalReason;
		if (turnTerminalReason && turnTerminalReason !== "completed") {
			app.log.info({ activeOwner, reason: "turn_not_completed", turnTerminalReason }, "tool-turn recovery skipped");
			return;
		}
		// A failed message does not end the turn as failed; asking the failing model again only fails again.
		if (([...session.messages].reverse().find((message) => message.role === "assistant") as { stopReason?: string } | undefined)?.stopReason === "error") {
			app.log.info({ activeOwner, reason: "last_message_failed" }, "tool-turn recovery skipped");
			return;
		}
		if (!turnTrace.sawToolResult) {
			app.log.info({ activeOwner, reason: "no_tool_result" }, "tool-turn recovery skipped");
			return;
		}
		const calls = turnTrace.toolCalls.slice();
		const results = turnTrace.toolResults.slice();
		if (!calls.length && !results.length) {
			app.log.info({ activeOwner, reason: "no_calls_or_results" }, "tool-turn recovery skipped");
			return;
		}

		const usedRetrieval = turnTrace.usedRetrievalTools || calls.some((c) => isRetrievalTool(c.name)) || results.some((r) => isRetrievalTool(r.name));
		const finalAssistantText = turnTrace.finalAssistantText.trim();
		const needsToolOnlyRecovery = !turnTrace.sawAssistantAfterToolResult;
		// Only synthesize when the visible answer is essentially absent. The old
		// <500-char threshold re-prompted after perfectly adequate short replies,
		// and models often answered the internal request by repeating themselves
		// — the user saw the same message twice.
		const needsRetrievalSynthesis = usedRetrieval && finalAssistantText.length < 80;
		if (!needsToolOnlyRecovery && !needsRetrievalSynthesis) {
			app.log.info({
				activeOwner,
				usedRetrieval,
				sawToolResult: turnTrace.sawToolResult,
				sawAssistantAfterToolResult: turnTrace.sawAssistantAfterToolResult,
				finalAssistantChars: finalAssistantText.length,
				reason: "answer_sufficient",
			}, "tool-turn recovery skipped");
			return;
		}

		app.log.info({
			activeOwner,
			usedRetrieval,
			sawToolResult: turnTrace.sawToolResult,
			sawAssistantAfterToolResult: turnTrace.sawAssistantAfterToolResult,
			finalAssistantChars: finalAssistantText.length,
			mode: needsRetrievalSynthesis ? "retrieval_synthesis" : "tool_summary",
		}, "tool-turn recovery triggered");
		streamTrace.note("tool_turn_recovery", {
			mode: needsRetrievalSynthesis ? "retrieval_synthesis" : "tool_summary",
			finalAssistantChars: finalAssistantText.length,
		});

		const lines = needsRetrievalSynthesis
			? [
				"[INTERNAL_RETRIEVAL_SYNTHESIS_REQUEST]",
				"The previous turn used retrieval tools but the user-facing answer was missing or too thin.",
				"Write the final answer now for the user.",
				"Rules:",
				"- Do not call any tools.",
				"- Do not mention this internal instruction.",
				"- Give a direct answer first.",
				"- Include key findings from the retrieved material.",
				"- Include uncertainty, gaps, or what was not found.",
				"- Include sources where available, using source/file names or paths from the retrieval results.",
				"- End with one useful next step.",
				"- Do not expose low-level command or runtime wording.",
				"",
				finalAssistantText ? `Thin answer already given: ${finalAssistantText}` : "Thin answer already given: (none)",
				"",
				"Retrieval calls:",
				...calls.filter((c) => isRetrievalTool(c.name)).map((c, i) => `${i + 1}. ${c.name} ${argPreview(c.args)}`),
				"",
				"Retrieval results:",
				...results.filter((r) => isRetrievalTool(r.name)).map((r, i) => `${i + 1}. ${r.name}${r.isError ? " (error)" : ""}: ${resultPreview(r.text)}`),
				"[/INTERNAL_RETRIEVAL_SYNTHESIS_REQUEST]",
			]
			: [
				"[INTERNAL_TOOL_SUMMARY_REQUEST]",
				"The previous turn used tools/commands but ended without a user-facing explanation.",
				"Write the missing final answer now.",
				"Rules:",
				"- Do not call any tools.",
				"- Do not mention this internal instruction.",
				"- Summarise what happened and what it means for the user in 2–6 concise bullets.",
				"- Cite source paths when relevant.",
				"- If the result was just an inventory/listing, explain the inventory, not every raw line.",
				"",
				"Tools called:",
				...calls.map((c, i) => `${i + 1}. ${c.name} ${argPreview(c.args)}`),
				"",
				"Tool results:",
				...results.map((r, i) => `${i + 1}. ${r.name}${r.isError ? " (error)" : ""}: ${resultPreview(r.text)}`),
				"[/INTERNAL_TOOL_SUMMARY_REQUEST]",
			];

		autoSummaryRunning = true;
		resetTurnTrace();
		try {
			// The request is the server's, not the person's: an edit after it goes to the person's message.
			markAppPrompt(session as any);
			await session!.prompt(lines.join("\n"), serverHooks().promptOptions?.());
		} finally {
			autoSummaryRunning = false;
			try { keepAppTurnFailure(session as any); } catch {}
		}
	};

	try {
		await bindSession();
		// A message left unanswered while the app was not running (it stopped mid-retry) goes back too.
		// A scheduled run that failed before its turns were marked is told by its item id.
		const threadItemsAtOpen = getPersistentAgentThread(persistentAgentIdForSession, persistentConversationId)?.items;
		// One an away limit stopped stays above under its line.
		const returnedAtOpen = (getPersistentAgentActiveTurnState(persistentAgentIdForSession, persistentConversationId).state === "idle" && !lastUserItemIsScheduledPrompt(threadItemsAtOpen) && !endsOnAwayLimitStop(threadItemsAtOpen) ? await stepBackFromFailedPrompt(session as any, { shown: lastShownUserText(threadItemsAtOpen) }) : undefined) ?? returnedPromptOf(session as any);
		// A new connection holds no messages of its own yet: what waits is the running answer's it steps back into.
		const reattachingTurn = claimedCookingTurn;
		// The newest message's bubble, when it cannot be edited: the page shows no pencil on it.
		const notEditable = notEditableMessageId(session as any, threadItemsAtOpen, !!returnedAtOpen || lastUserItemIsScheduledPrompt(threadItemsAtOpen));
		send({ type: "ready", persona, agent: persistentAgentIdForSession, persistentAgentId: persistentAgentIdForSession, conversationId: persistentConversationId, model: modelStatusPayload((session as any)?.model), contextHealth: initialContextHealthForSession(session), effort: roomEffortStatusPayload(persistentAgentIdForSession, persistentConversationId, session), ...(returnedAtOpen ? { returnedPrompt: returnedAtOpen } : {}), ...(notEditable ? { notEditable } : {}), waiting: reattachingTurn?.waiting(connectionId) ?? [], taken: (takenSteers.get(answerNoteKey()) ?? []).map((steer) => steer.id), withdrawn: (takenSteers.get(answerNoteKey()) ?? []).filter((steer) => steer.withdrawn).map((steer) => steer.id), reattaching: reattachingTurn !== null, held: readHeldMessages(persistentAgentIdForSession, persistentConversationId) });
	} catch (e) {
		if (e instanceof PersistentAgentMemoryOverflowError || e instanceof RoomModelUnavailableError || (e as { code?: unknown })?.code === "provider_signed_out") {
			// Named so the client can stand its reconnect loop down: redialing
			// reaches the same memory and the same window, the same signed-out
			// provider, or the same model no longer offered.
			// A signed-out provider is named, so the room can dial again by
			// itself once that provider is signed in.
			const provider = (e as { provider?: unknown }).provider;
			// A key connection's state, so the page names the key without the sign-in list.
			const credentialKey = (e as { code?: unknown }).code === "provider_signed_out" && typeof provider === "string" ? credentialKeyOf("signed-out", provider) : undefined;
			send({ type: "error", code: (e as { code: string }).code, message: (e as Error).message, ...(typeof provider === "string" ? { provider } : {}), ...(credentialKey ? { credentialKey } : {}) });
		} else {
			send({ type: "error", message: `failed to create session: ${(e as Error).message}` });
		}
		socket.close();
		return;
	}

	// This session's agent session was bound while (or right after)
	// an adopted turn was writing to the room's session history, so its context
	// predates the turn's landing. Rebuild it through the same single-rebind
	// gate workspace changes use: frames arriving mid-rebind await it, and the
	// next prompt retries if the rebuild failed.
	// A rebind that fails on the memory guard must reach the client with its
	// code: swallowing it leaves a silently dead room, and the generic
	// "failed to apply" wrapper hides the only sentence that names the exit.
	const reportRebindRefusal = (error: unknown): void => {
		if (!(error instanceof PersistentAgentMemoryOverflowError) && !(error instanceof RoomModelUnavailableError)) {
			// Other rebind failures are retried on the next prompt rather than
			// surfaced to the client; leave a trace so they at least reach the
			// operator log instead of vanishing.
			app.log.warn({ err: error }, "persistent room rebind failed");
			return;
		}
		send({ type: "error", code: error.code, message: error.message, ...(error instanceof RoomModelUnavailableError ? { provider: error.provider } : {}) });
		try { socket.close(); } catch {}
	};

	const scheduleAdoptedSessionRebind = (): void => {
		const rebind = (async () => {
			if (!sessionDisposed) {
				sessionDisposed = true;
				try { (session as any)?.dispose?.(); } catch {}
			}
			session = null;
			await bindSession();
		})();
		workspaceRebindInFlight = rebind;
		rebind.catch(reportRebindRefusal).finally(() => {
			if (workspaceRebindInFlight === rebind) workspaceRebindInFlight = null;
		});
	};

	// Test-only (EXXPERTS_TEST_INTROSPECTION=1, same spirit as the away limits'
	// env overrides): widen the claim-to-adopt window deterministically so the
	// settle-during-bind branch and its lock ordering can be pinned by tests
	// instead of relying on timing luck.
	if (process.env.EXXPERTS_TEST_INTROSPECTION === "1") {
		const testBindDelayMs = Number(params.get("testBindDelayMs") ?? "") || 0;
		if (testBindDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(testBindDelayMs, 10_000)));
	}
	// Test-only, likewise: holds a message between its arrival and its turn's
	// start, as a settings rebind before the turn does, so a page save landing
	// in that window can be pinned by tests.
	const testPromptStartDelayMs = process.env.EXXPERTS_TEST_INTROSPECTION === "1" ? Math.min(Number(params.get("testPromptStartDelayMs") ?? "") || 0, 10_000) : 0;

	// Stepping back into a room: adopt the cooking turn this
	// connection claimed at connect. Adopt + snapshot + replay run in ONE
	// synchronous block, so no frame can slip between the replayed snapshot
	// and the live sink: the seam is gapless and duplicate-free by
	// construction. If the turn settled while this session was binding, the
	// buffer already ends with the turn's terminal frames and the replay alone
	// carries the whole answer; the landing was written exactly once by the
	// settle path either way.
	if (claimedCookingTurn) {
		const cooking = claimedCookingTurn;
		if (cooking.claimantConnectionId !== connectionId) {
			// A newer connection took the claim while this one was binding. The
			// claim-time displacement hook already told this client and closed
			// the socket; finish the story here too (belt for any path where
			// the hook could not run) instead of proceeding as a silent
			// lock-less session during a cooking turn.
			claimedCookingTurn = null;
			send({ type: "error", code: "room_displaced", message: "This room is now open in another window." });
			try { socket.close(); } catch {}
			return;
		} else if (cooking.replayUnavailable()) {
			// The turn overflowed the replay cap between the claim and this
			// adopt (narrow window), still cooking OR already settled: a
			// half-blind adoption would render a gappy stream, and a SETTLED
			// adoption would replay the freed (empty) buffer, superseding the
			// client's partial with nothing so its persist could overwrite the
			// landed answer. Both degrade to the honest bounce, late but safe;
			// the landing carries the whole answer and reopening finds it. The
			// close handler does the right thing either way: a cooking turn
			// re-detaches (this connection is the claimant) keeping the lock
			// held until the settle releases it, a settled one releases now.
			send({ type: "error", code: "room_cooking", message: "This room is currently finishing a response in the background. The answer is saved into the conversation when it is done; open the room again then." });
			try { socket.close(); } catch {}
			return;
		} else {
			const adopted = !cooking.settled && cooking.adopt(connectionId, sendSerialised, {
				onSettled: () => {
					// The adopted turn landed while this session watched: release
					// the handle (its closure, buffer included, becomes
					// collectable) and rebuild the session against the landed
					// history before the next prompt.
					claimedCookingTurn = null;
					try { scheduleAdoptedSessionRebind(); } catch (error) { app.log.warn({ err: error }, "adopted-turn session rebind failed to schedule"); }
				},
				onDisplaced: () => {
					// A newer connection took the turn over: this session stops
					// receiving frames, so it must not sit busy on a spinner that
					// will never resolve. The error frame lands the partial and
					// clears the client's busy state; Stop authority moved with
					// the claim.
					claimedCookingTurn = null;
					send({ type: "error", code: "room_displaced", message: "This room is now open in another window." });
				},
			});
			let reattachAnchorItemId = cooking.anchorItemId;
			try { reattachAnchorItemId = earlierTurnsAnchorItemId(getPersistentAgentThread(persistentAgentIdForSession, persistentConversationId)?.items ?? [], cooking.anchorItemId, cooking.earlierPromptsAfterAnchor); } catch {}
			send({ type: "turn_reattach", turnId: cooking.turnId, conversationId: persistentConversationId, settled: !adopted, ...(cooking.promptId !== undefined ? { promptId: cooking.promptId, promptFiles: cooking.promptFiles ?? [], userText: cooking.userText } : cooking.userText ? { userText: cooking.userText } : {}), ...(reattachAnchorItemId !== undefined ? { anchorItemId: reattachAnchorItemId } : {}), ...(typeof cooking.startedAt === "number" ? { startedAt: cooking.startedAt } : {}), now: Date.now(), waiting: adopted ? cooking.waiting(connectionId) : [] });
			for (const frame of cooking.bufferedTurnFrames()) sendSerialised(frame);
			// Close the replay window before any live frame can follow (this
			// whole block is synchronous, so the agent cannot interleave): the
			// client renders everything between turn_reattach and this marker
			// instantly instead of re-animating the caught-up text at reading
			// pace, and only post-seam live tokens reveal paced.
			send({ type: "turn_reattach_replay_done", turnId: cooking.turnId });
			if (adopted) {
				// After the replay window, so a question asked again shows as a live card.
				cooking.attachQuestions(connectionId, !remoteReadOnlySession);
				app.log.info({ agentId: persistentAgentIdForSession, turnId: cooking.turnId }, "session stepped back into a cooking turn; replayed the stream so far");
			} else {
				// The landing beat this bind: the frames above carried the whole
				// stream to its end, and the settle path recorded the unseen
				// marker before it knew anyone was watching. Clear it again (this
				// session just watched the answer land), and rebuild the session
				// against the landed history.
				claimedCookingTurn = null;
				// The settled replay above was the buffer's last possible use.
				cooking.releaseReplayBuffer();
				// Bind-scoped: this session watched THIS conversation's answer
				// land; a still-unseen scheduled answer in another thread keeps
				// its badge.
				try { clearPersistentAgentUnseenLandedAnswerForBind(persistentAgentIdForSession, persistentConversationId); } catch {}
				scheduleAdoptedSessionRebind();
				app.log.info({ agentId: persistentAgentIdForSession, turnId: cooking.turnId }, "cooking turn settled while the session was binding; replayed the finished stream");
			}
		}
	}

	// Rung 2 (assets contract §2): the connection inherits what the ledger knows
	// about this ROOM — tasks are room-scoped (option 4) and Memento/checkpoint
	// mint a new conversationId, so filtering to the current conversation would
	// silently drop endings from earlier threads. Best-effort — a ledger problem
	// must not block the session.
	try {
		const ledgerRows = listTaskLedgerRecords(persistentAgentIdForSession);
		// Away-notice honesty: terminal rows the client was never told about.
		// Stamp ONLY on confirmed delivery — a socket that died during connect
		// setup must not permanently consume the notice.
		const away = selectTaskLedgerAwayNotices(ledgerRows, 5);
		if (away.allTaskIds.length > 0) {
			const delivered = sendChecked({
				type: "task_away_notice",
				// A refused overwrite that happened while the tab was closed reaches
				// the user ONLY here (taste pass): task frames never replay, so
				// without the conflicts on this notice the user would just find an
				// unexplained collision-named file in Attachments.
				notices: away.notices.map((row) => ({ taskId: row.taskId, title: row.title, outcome: row.outcome, endedAt: row.endedAt ?? null, ...(row.reviseConflicts?.length ? { reviseConflicts: row.reviseConflicts } : {}) })),
				moreCount: away.moreCount,
			});
			if (delivered) markTaskLedgerRecordsAwayNoticed(persistentAgentIdForSession, away.allTaskIds);
		}
	} catch (e) {
		app.log.warn({ err: (e as Error).message }, "task ledger connect reconcile failed");
	}

	// Option 4: become the room's sink. Binding replays task_started + the
	// accumulated tail for every surviving task through the normal event
	// family — the client reducer receives exactly what it would have live,
	// so the rail pulses and the run view fills with zero client changes.
	// The checked sender makes the registry's `noticed` signal honest: a
	// terminal frame sent while this socket is closing reports undelivered.
	bindSpecialistSink(persistentAgentIdForSession, sendChecked);

	const handleSocketMessage = async (raw: Buffer) => {
		let msg: any;
		try { msg = JSON.parse(raw.toString()); } catch { return; }
		streamTrace.frameIn(msg);
		// A read-only device's socket is observe-only: EVERY inbound frame is
		// dropped here (the early listener attached at connection start
		// already answered it with the refusal frame). A capability check,
		// not a frame-type allowlist, so a future frame type cannot slip
		// through it.
		if (remoteReadOnlySession) return;
		// A message's start anchor is the file's last item as it arrives,
		// before any rebind is awaited: the page saves the message itself about
		// half a second later, and a save that landed first would make the
		// message its own anchor and keep this turn's partial. A continued turn
		// adds no message, so its anchor is read when it starts, past whatever
		// the page saved meanwhile.
		let lastItemIdAtArrival: string | null | undefined;
		let earlierPromptsAtArrival = 0;
		// The note after a server stop comes from the file too, before the page saves this message after the cut answer.
		let serverStopNoteAtArrival: AnswerNote | null = null;
		if (msg.type === "prompt") {
			try {
				const priorItems = getPersistentAgentThread(persistentAgentIdForSession, persistentConversationId)?.items ?? [];
				lastItemIdAtArrival = lastThreadItemId(priorItems);
				earlierPromptsAtArrival = earlierPromptsAwaitingSave(priorItems, lastPromptTurnStart);
				const edited = readEditFrame(msg.edit);
				const replaced = edited ? replacedItemIds(priorItems, edited.replaces) : [];
				const at = replaced.length ? priorItems.findIndex((item: any) => String(item?.id ?? "") === replaced[0]) : -1;
				// An edited message gets the note a message typed in its place would get, from the items before the one it replaces:
				// a cut answer after that message goes with it, one before it stays the model's last answer once the edit steps back.
				serverStopNoteAtArrival = !edited ? serverStopNote(priorItems) : at >= 0 ? serverStopNote(priorItems.slice(0, at)) : null;
				// An edited message starts where the message it replaces started.
				if (at >= 0) {
					lastItemIdAtArrival = at > 0 ? String((priorItems[at - 1] as any)?.id ?? "") || null : null;
					earlierPromptsAtArrival = 0;
				}
			} catch {
				lastItemIdAtArrival = undefined;
			}
		}
		// A turn this window adopted and that has not landed yet lands in the closure that runs it, after this arrival.
		const adoptedAtArrival = msg.type === "prompt" && claimedCookingTurn && !claimedCookingTurn.settled && claimedCookingTurn.claimantConnectionId === connectionId ? claimedCookingTurn : null;
		if (testPromptStartDelayMs > 0 && (msg.type === "prompt" || msg.type === "continue")) await new Promise((resolve) => setTimeout(resolve, testPromptStartDelayMs));
		if (msg.type === "ui_response") {
			// A turn this connection took over asked the question, not this connection's own session.
			if (claimedCookingTurn) claimedCookingTurn.answerQuestion(connectionId, msg.id, msg.value);
			else uiContext.resolveResponse(msg.id, msg.value);
			return;
		}
		// A frame that lands while a workspace rebind is in flight waits for that
		// SAME rebind before touching `session`: the old session is disposed and
		// `session` is null for the whole window, so racing past here would drop
		// the frame or, before the null, run it on the disposed session.
		if (workspaceRebindInFlight) {
			try { await workspaceRebindInFlight; } catch {}
		}
		// The composer's effort control, chosen between turns. Kept per
		// conversation: the choice is stored and every following turn in this
		// conversation inherits it, so this frame carries no turn of its own;
		// an explicit pick also becomes the room's default for new
		// conversations (recordConversationEffortChoice). An unknown level is ignored rather
		// than refused, and the echo tells the client what actually took hold
		// once the locked model's capability clamped it.
		//
		// Handled BEFORE the session guard below: storing a preference and
		// answering with it needs no session, and a connection sitting in the
		// window after a failed rebind (session null until the next prompt
		// retries) must still be able to record what the user picked.
		if (msg.type === "effort") {
			if (!isRoomEffortLevel(msg.level)) return;
			recordConversationEffortChoice(persistentAgentIdForSession, persistentConversationId, session, msg.level, msg.explicit === true);
			// A turn finishes under the rules it started with, the same principle
			// the live-settings rebind follows: a choice made while an answer is
			// being written is stored and applies from the next prompt, never
			// mid-answer where half the steps would think at a different depth.
			if (session && !activePersistentWebTurn && !autoSummaryRunning) applyRoomEffortToSession(session, msg.level);
			send({ type: "effort", ...roomEffortStatusPayload(persistentAgentIdForSession, persistentConversationId, session, msg.level) });
			return;
		}
		// Held messages need no session: they are the conversation's, on disk.
		if (msg.type === "hold" || msg.type === "held_drop") {
			try {
				if (msg.type === "hold") holdMessages(persistentAgentIdForSession, persistentConversationId, readHeldMessageList(msg.messages));
				else if (typeof msg.id === "string") dropHeldMessages(persistentAgentIdForSession, persistentConversationId, [msg.id]);
			} catch (error) {
				app.log.warn({ err: error }, "changing the held messages failed");
			}
			return;
		}
		// Stop on a named part reaches the turn that wrote it, also from a window whose session is not bound yet.
		if (msg.type === "stop_reveal" && typeof msg.itemId === "string" && isAnswerPartId(msg.itemId)) {
			const shown = readShownChars(msg.shown);
			if (shown === undefined) return;
			const cooking = claimedCookingTurn;
			if (cooking && !cooking.settled && cooking.claimantConnectionId === connectionId) cooking.stopRevealPart(connectionId, msg.itemId, shown);
			else stopRevealPart(msg.itemId, shown);
			return;
		}
		if (!session && msg.type !== "prompt" && msg.type !== "continue") return;
		// "continue": Try again under a failed answer that stayed on screen. The
		// model answers the conversation's last message again, which is not sent
		// a second time (AgentSession.continueAfterFailure).
		if (msg.type === "prompt" || msg.type === "continue") {
			const continuing = msg.type === "continue";
			// A second run inside the same turn (the recovery prompt) can hold it longer: past the cap the guard below answers as before.
			const windingDown = windingDownForThisWindow();
			if (windingDown) {
				await Promise.race([windingDown, new Promise((resolve) => setTimeout(resolve, TURN_WINDING_DOWN_WAIT_MS))]);
				// The adopted turn's settle rebinds this window's session against the landed history.
				if (workspaceRebindInFlight) {
					try { await workspaceRebindInFlight; } catch {}
				}
				// The connection closed while it waited: its close gave the room up, so nothing starts from it.
				if (socket.readyState !== socket.OPEN || sessionDisposed) return;
			}
			// The adopted turn landed its prompt and answer meanwhile: this message starts right after what that landing wrote.
			// Never after the file's last item: the page may have saved this very message, and it would become its own anchor.
			const adoptedLanding = continuing ? undefined : adoptedAtArrival?.landedItemId();
			if (adoptedLanding) {
				lastItemIdAtArrival = adoptedLanding;
				earlierPromptsAtArrival = 0;
				serverStopNoteAtArrival = null;
			}
			if (serverStopping()) {
				send({ type: "error", code: SERVER_STOPPING_CODE, message: SERVER_STOPPING_SENTENCE });
				return;
			}
			// Workspace settings apply from the next message: when the room's
			// effective workspace policy changed since this session was built
			// (default set/changed/cleared mid-conversation), rebuild the session
			// against the live policy BEFORE the turn begins — tool registry, env
			// gating and runtime cwd are all bind-time, so only a rebind can make
			// them match. Never while a turn or its recovery prompt is running:
			// a turn finishes under the rules it started with (the mutation
			// endpoints refuse in-flight anyway; this guard covers frame races).
			if (!activePersistentWebTurn && !autoSummaryRunning && boundWorkspaceFingerprint !== null) {
				try {
					const liveWorkspacePolicy = resolvePersistentRoomEffectiveWorkspacePolicy(persistentAgentIdForSession, persistentConversationId);
					// Per-room MCP grants ride the same live-settings rebind: call
					// gating is already per-call in the wrapper, but the proxy tool's
					// manifest description is bind-time, so a grant change rebuilds
					// the session before the next turn.
					const liveMcpGrantsFingerprint = persistentRoomMcpGrantsFingerprint(persistentAgentIdForSession);
					// Native provider search rides along for the same reason: the
					// choice of which web_search this room offers is made at bind,
					// so switching it in settings has to rebuild the session before
					// the next message rather than at the next reconnect.
					// A decision the resolver could not actually make is not a change:
					// rebuilding the session on a momentary failure to read a
					// credential store would cost the room its warm cache for a
					// reason that has nothing to do with the setting. Keep what the
					// session bound with until something readable says otherwise.
					const liveNativeSearchDecision = resolveNativeProviderSearchDecision(boundSessionProviderId ?? undefined);
					const liveNativeProviderSearch = liveNativeSearchDecision.indeterminate ? boundNativeProviderSearch : liveNativeSearchDecision.active;
					// An empty conversation follows the room's conversation pick until
					// its first message: a pick made after it was bound (Room settings,
					// Model) rebinds it before that message, and bindSession moves it.
					// Best effort: on a failure to read the pick it stays as bound.
					let emptyConversationMoves = false;
					if (persistentAgentThreadForSession?.runtime.kind === "pi-session-jsonl") {
						try {
							// A room model that cannot run any more is named too: the
							// rebind then refuses with the room's sentence.
							emptyConversationMoves = emptyPersistentAgentThreadModelTarget(persistentAgentIdForSession, persistentConversationId, () => {
								const resolved = resolveRoomModel(persistentAgentIdForSession, "conversation");
								return resolved.effective ?? resolved.chosen;
							}) !== null;
						} catch {
							emptyConversationMoves = false;
						}
					}
					const modelBeforeRebind = promptDiagnosticsCurrentModel;
					// `!session` here means an earlier rebind failed after disposing
					// the old session; retry rather than bricking the connection.
					if (!session || emptyConversationMoves || liveWorkspacePolicy.fingerprint.value !== boundWorkspaceFingerprint || liveMcpGrantsFingerprint !== boundMcpGrantsFingerprint || liveNativeProviderSearch !== boundNativeProviderSearch) {
						if (!workspaceRebindInFlight) {
							const rebind = (async () => {
								if (!sessionDisposed) {
									sessionDisposed = true;
									try { (session as any)?.dispose?.(); } catch {}
								}
								session = null;
								await bindSession();
							})();
							workspaceRebindInFlight = rebind;
							rebind.catch(reportRebindRefusal).finally(() => {
								if (workspaceRebindInFlight === rebind) workspaceRebindInFlight = null;
							});
						}
						await workspaceRebindInFlight;
						// The room shows the model the conversation now runs on: the
						// same frame a switch sends, without a line (nothing was said
						// on the old model, so nothing continues).
						const modelAfterRebind = promptDiagnosticsCurrentModel;
						if (session && modelAfterRebind && (modelAfterRebind.provider !== modelBeforeRebind?.provider || modelAfterRebind.model !== modelBeforeRebind?.model)) {
							send({ type: "model_switched", model: modelStatusPayload((session as any)?.model), contextHealth: initialContextHealthForSession(session), effort: roomEffortStatusPayload(persistentAgentIdForSession, persistentConversationId, session) });
						}
					}
				} catch (e) {
					if (e instanceof PersistentAgentMemoryOverflowError || e instanceof RoomModelUnavailableError) {
						reportRebindRefusal(e);
						return;
					}
					app.log.warn({ err: e }, "persistent room settings rebind failed");
					send({ type: "error", ...persistentRoomSettingsNotAppliedFrame(e, isSharedServer(), requestGetsLocalPaths(req)) });
					return;
				}
			}
			if (!session) return;
			// The rebind awaits, and a stop can begin meanwhile.
			if (serverStopping()) {
				send({ type: "error", code: SERVER_STOPPING_CODE, message: SERVER_STOPPING_SENTENCE });
				return;
			}
			// The conversation moved on from the failed answer (another window, or a step back this page never showed): the page sends the message again instead.
			if (continuing && !session.canContinueAfterFailure()) {
				send({ type: "error", code: "nothing_to_continue" });
				return;
			}
			// An edit steps the conversation back before the turn begins, so a refused edit begins no turn and lands nothing.
			const edit = continuing ? undefined : readEditFrame(msg.edit);
			let editTaken = false;
			let editLine: NotUndoneLine | undefined;
			// The ids the edit takes out of the saved conversation once its turn has begun.
			let editedAwayIds: string[] = [];
			if (edit) {
				// Whatever would refuse the turn (a Remember reading, a running answer) refuses the edit before it changes anything.
				let canBegin = !autoSummaryRunning;
				// A scheduled run's prompt was the app's, not the person's.
				let scheduled = false;
				try {
					if (canBegin) {
						assertPersistentAgentTurnCanBegin(persistentAgentIdForSession, persistentConversationId);
						scheduled = lastUserItemIsScheduledPrompt(getPersistentAgentThread(persistentAgentIdForSession, persistentConversationId)?.items);
					}
				} catch { canBegin = false; }
				// A held message waits to go after the newest one: the edit would go before it.
				const stepped = !canBegin ? { ok: false as const, refused: "running" as const }
					: readHeldMessages(persistentAgentIdForSession, persistentConversationId).length > 0 ? { ok: false as const, refused: "held" as const }
					: scheduled ? { ok: false as const, refused: "not-typed" as const }
					: await stepBackForEdit(session as any, edit.text);
				if (!stepped.ok) {
					send({ type: "edit_refused", replaces: edit.replaces, reason: stepped.refused, held: readHeldMessages(persistentAgentIdForSession, persistentConversationId) });
					return;
				}
				editTaken = true;
				// Named by the message's key, so the page's copy and the landing's are one item; an unkeyed message gets the line live only.
				editLine = notUndoneLine(readTurnKey(msg.id) ?? `edit-${Date.now().toString(36)}`, stepped.ran);
				try { editedAwayIds = replacedItemIds(getPersistentAgentThread(persistentAgentIdForSession, persistentConversationId)?.items ?? [], edit.replaces); } catch {}
				// The replaced answer's Stop or cut note went with it.
				answerNotes.delete(answerNoteKey());
			}
			let persistentTurnId: string | undefined;
			let returnedPrompt: ReturnedPrompt | undefined;
			let leafBeforePrompt: string | null | undefined;
			// The note this message carries, kept for it should the message go back to the box.
			let sentNote: AnswerNote | undefined;
			try {
				const askedKey = readTurnKey(msg.id);
				const turnKey = askedKey && keyFreeInConversation(persistentAgentIdForSession, persistentConversationId, askedKey, continuing) ? askedKey : undefined;
				const startedTurn = beginPersistentAgentTurn(persistentAgentIdForSession, persistentConversationId, { connectionId, key: turnKey });
				if (!startedTurn.turnId) throw new Error("persistent-agent turn id was not created");
				persistentTurnId = startedTurn.turnId;
				// Out of the saved conversation now, and out of every later write, however late an older copy of the page's arrives.
				if (editedAwayIds.length) try { removeEditedAwayItems(persistentAgentIdForSession, persistentConversationId, editedAwayIds); } catch {}
				activePersistentWebTurn = { turnId: persistentTurnId, promptSettled: false, ...(typeof startedTurn.startedAt === "number" ? { startedAt: startedTurn.startedAt } : {}) };
				turnProgress.toolsRunning.clear();
				// The last turn's Stop answered its questions; this turn asks again.
				uiContext.reopen();
				// A new turn owns the anchor from here on: the previous turn's
				// post-stream landing snapshot must not fire against it.
				settledTurnLandingSnapshot = null;
				revealCutAtSettle = undefined;
				partRevealNoteAtSettle = undefined;
				resetTurnTrace();
				turnSteps = createTurnStepLog(turnKey);
				pendingSteers = [];
				takenSteers.delete(answerNoteKey());
				// A continued turn sends no message of its own: its first user message is already a steer.
				turnPromptMessageSeen = continuing;
				// A fresh turn owns a fresh replay buffer, and records the
				// supersede anchor: the last item the thread file held when this
				// message arrived (the client's debounced persist of this prompt
				// lands ~500ms later, so the file still ended on the prior turn
				// then). Best-effort: an unreadable file leaves the anchor
				// unknown and clients fall back to their conservative rule.
				turnFrameBuffer = [];
				turnFrameBufferBytes = 0;
				turnReplayOverflowed = false;
				turnFrameSeq = 0;
				updateReattachBufferProbe();
				if (continuing) {
					try {
						turnStartAnchorItemId = lastThreadItemId(getPersistentAgentThread(persistentAgentIdForSession, persistentConversationId)?.items ?? []);
					} catch {
						turnStartAnchorItemId = undefined;
					}
					turnStartEarlierPrompts = null;
				} else {
					turnStartAnchorItemId = lastItemIdAtArrival;
					turnStartEarlierPrompts = earlierPromptsAtArrival;
					lastPromptTurnStart = { anchorItemId: turnStartAnchorItemId, earlierPromptsAfterAnchor: earlierPromptsAtArrival, promptKept: true };
				}
				keyedTurn = turnKey
					? { key: turnKey, continued: continuing, ...(continuing ? {} : { shown: readShownPrompt(msg.shown) }), strippedText: continuing ? "" : userAuthoredPromptText(String(msg.text ?? "")), startAnchorId: turnStartAnchorItemId, ...(typeof startedTurn.startedAt === "number" ? { startedAt: startedTurn.startedAt } : {}), steps: turnSteps, ...(editLine ? { editLine } : {}) }
					: null;
				const sessionAtPromptStart = session;
				// Reasoning effort for this turn. `effort` on a prompt frame behaves
				// exactly like the effort frame: the raw level is stored for this
				// conversation and the clamped one applies to this turn.
				// This app's own composer never sends it (it would echo back the
				// CLAMPED level it was shown and overwrite the raw preference);
				// it is here for clients that have no second frame to spend.
				//
				// Otherwise the conversation's level is re-applied, because a
				// rebind since the last turn would have rebuilt the session at
				// the machine default. A conversation with no level of its own
				// takes the room's default as its own at this message, its first,
				// or the level the session runs at when the room has none, so a
				// later default reaches only new conversations. A level the echo
				// guard did not store is settled the same way.
				if (isRoomEffortLevel(msg.effort)) {
					recordConversationEffortChoice(persistentAgentIdForSession, persistentConversationId, session, msg.effort, msg.explicit === true);
					settleConversationEffortChoice(persistentAgentIdForSession, persistentConversationId, msg.effort);
					applyRoomEffortToSession(session, msg.effort);
				} else {
					const turnEffortChoice = settleConversationEffortChoice(persistentAgentIdForSession, persistentConversationId, session.thinkingLevel);
					if (turnEffortChoice) applyRoomEffortToSession(session, turnEffortChoice);
				}
				// A continued turn has no new text: no prompt to land, nothing to hand back.
				const userText = continuing ? "" : String(msg.text ?? "");
				// Only what the person typed lands: never the model-written handoff
				// blocks or app-written attachment notes the client prepends.
				currentTurnUserTextForLanding = userAuthoredPromptText(userText);
				// Consult MR-5 hardening: this prompt has consumed any queued handoff
				// blocks (the client prepended them to userText). Clear the persisted
				// queue now, atomically with the consume, so a crash or a reordered
				// client save can never re-queue an already-sent block. Best-effort:
				// never let it break the turn.
				if (!continuing) try { clearPersistentAgentThreadPendingHandoffs(persistentAgentIdForSession, persistentConversationId); } catch (error) { app.log.warn({ err: error }, "failed to clear consult pending-transfer queue on prompt"); }
				preparePromptDiagnosticsTurn("user");
				// The session read the sign-ins when it bound; one made since (after
				// a turn failed on a key that no longer worked) is read now, so this
				// message runs on it. One file read per message.
				try { session!.modelRegistry.authStorage.reload(); } catch (error) { app.log.warn({ err: error }, "reading the sign-ins before the turn failed"); }
				leafBeforePrompt = (session as any).sessionManager?.getLeafId?.();
				if (continuing) await session!.continueAfterFailure();
				else {
					// The note goes only to the model: the consent text above and the bubble keep the person's words.
					// After a server stop, only while the model was told nothing since: its own history still ends on the stopped answer,
					// also after a refused message went back to the box, and after another restart. The file may not hold the last exchange yet.
					const stoppedLast = session!.agent.state.messages.at(-1) as { role?: string; stopReason?: string } | undefined;
					sentNote = answerNotes.get(answerNoteKey()) ?? (stoppedLast?.role === "assistant" && stoppedLast.stopReason === "aborted" ? serverStopNoteAtArrival ?? undefined : undefined);
					answerNotes.delete(answerNoteKey());
					// Before the answer's first frame: the page takes the replaced message and answer out, and says what was not undone.
					if (edit && editTaken) sendTurnFrame({ type: "edit_applied", replaces: edit.replaces, ...(editLine ? { line: editLine } : {}) });
					// What an edit's step back left done, for the edited message and for the same text sent again after a failed attempt.
					await session!.prompt(withPersistentRoomRestoredLiveThreadContext(withAnswerNote(sentNote, withEditNote(continuing ? [] : keptBeforeNextMessage(session as any), userText))), serverHooks().promptOptions?.());
				}
				if (!activePersistentWebTurn?.terminalReason) setActivePersistentWebTurnTerminalReason("completed");
				await flushSessionEvents();
				returnUntakenSteers();
				if (session === sessionAtPromptStart) keepAnswerNote(activePersistentWebTurn?.turnId === persistentTurnId ? activePersistentWebTurn : null);
				// A message the model could not answer goes back to the person (failed-prompt-step-back.ts); after Stop, only one no attempt answered.
				// A message the runtime is about to ask again, once it shortened the conversation, stays where it is.
				const askedAgain = overflowRecovery ? await overflowRecovery : false;
				overflowRecovery = undefined;
				// A turn an away limit stopped, even in a wait to ask again, keeps its message above under the stop's line.
				if (session === sessionAtPromptStart && !askedAgain && !activePersistentWebTurn?.awayLimit) returnedPrompt = await stepBackFromFailedPrompt(session as any, { stopped: activePersistentWebTurn?.terminalReason === "cancelled" || activePersistentWebTurn?.stoppedByServer === true, shown: userText });
				// A message handed back to the box got no answer, and a turn whose last attempt failed did not finish, whatever stayed above:
				// either ends failed, never as a finished response.
				const lastMessage = sessionAtPromptStart?.agent.state.messages.at(-1);
				const endedFailed = stoppedForQuota || (lastMessage?.role === "assistant" && lastMessage.stopReason === "error");
				if ((returnedPrompt || endedFailed) && activePersistentWebTurn?.turnId === persistentTurnId && activePersistentWebTurn.terminalReason === "completed") activePersistentWebTurn.terminalReason = "failed";
				// A detached turn skips the auto-summarize recovery prompt: it is a
				// rescue for a user watching a thin answer, and nobody is watching.
				// A turn that did not finish cleanly skips it too: after Stop, the
				// tool-only shape IS the cancellation, not a missing answer, and the
				// recovery would start a fresh paid turn the user just declined. So
				// does one the runtime asks again itself, which would race it.
				if (!detachedFromClient && !askedAgain && session === sessionAtPromptStart && activePersistentWebTurn?.terminalReason === "completed") {
					await maybeAutoSummarizeToolTurn();
				}
			} catch (e) {
				// The turn was refused after the edit's guard passed: the saved conversation still holds the message and its answer.
				if (edit && !persistentTurnId) {
					send({ type: "edit_refused", replaces: edit.replaces, reason: "running", held: readHeldMessages(persistentAgentIdForSession, persistentConversationId) });
					return;
				}
				// Sent while an answer is still running: only this window hears of it, and the running turn is left alone.
				if ((e as any)?.code === "turn_running" && !persistentTurnId) {
					send({ type: "error", code: "turn_running", message: (e as Error).message });
					return;
				}
				promptDiagnosticsPendingTurn = undefined;
				if (!activePersistentWebTurn?.terminalReason) setActivePersistentWebTurnTerminalReason("failed");
				// A room that can't read its own files says so with its code, so the page can put the message back.
				if ((e as any)?.code === "room_files_unreadable") {
					sendTurnFrame({ type: "error", message: (e as Error).message, code: "room_files_unreadable" });
					return;
				}
				// The turn's failure frame belongs to the turn stream, so a
				// session that stepped back in sees it live (or in the replay).
				// A window the room moved on from: the room keeps the message and offers Reload.
				const credential = failedTurnCredential(String((session as any)?.model?.provider ?? ""), (e as Error).message);
				const credentialKey = credential === "signed-out" ? undefined : credential;
				noteKeyOutcome(String((session as any)?.model?.provider ?? ""), credential, activePersistentWebTurn?.startedAt);
				sendTurnFrame({ type: "error", message: (e as Error).message, ...(credentialKey ? { credentialKey } : {}), ...((e as any)?.code === "conversation_moved" ? { code: "conversation_moved" } : {}) });
				// Refused before the message reached the conversation (no key at all): the room said why, and only typed text goes back in the box.
				const typedOnly = userAuthoredPromptText(String(msg.text ?? ""));
				if ((e as any)?.code !== "conversation_moved" && leafBeforePrompt !== undefined && (session as any)?.sessionManager?.getLeafId?.() === leafBeforePrompt && typedOnly.trim() && typedOnly.trim() === String(msg.text ?? "").trim()) returnedPrompt = { text: typedOnly.trim(), notice: true };
			} finally {
				if (persistentTurnId) {
					returnUntakenSteers();
					const turn = activePersistentWebTurn?.turnId === persistentTurnId ? activePersistentWebTurn : null;
					if (turn) turn.promptSettled = true;
					try { finishPersistentAgentTurn(persistentAgentIdForSession, persistentConversationId, { turnId: persistentTurnId, terminalReason: turn?.terminalReason ?? "failed" }); } catch {}
					if (turnWindingDown?.turnId === persistentTurnId) { turnWindingDown.finish(); turnWindingDown = null; }
					// Handed back unanswered, the message carries its note again when it is sent again.
					if (returnedPrompt && sentNote) answerNotes.set(answerNoteKey(), sentNote);
					// After the finish, so the message it hands back can be sent at once.
					if (returnedPrompt) sendTurnFrame({ type: "prompt_returned", ...returnedPrompt });
					if (returnedPrompt && lastPromptTurnStart) lastPromptTurnStart.promptKept = false;
					// Land the detached outcome right after the turn-state finish:
					// writePersistentAgentThread asserts no turn is in flight (the
					// same order scheduled background execution uses). New
					// connections still cannot slip in between — the acquire path
					// refuses while this room is in detachedCookingRooms, and a
					// reattach binds to the SETTLED handle from here on.
					const cookingHandle = detachedFromClient ? detachedCookingHandle : null;
					// Two different questions. Adopted: a session claimed the cooking
					// turn and is watching it live, so the settle hands it the signal
					// and its lock and the replay buffer follow the adoption rules
					// below; a claimant still mid-bind is NOT adopted yet and needs
					// the buffer kept for its settled replay. Watched: adopted, or a
					// newer session on this very conversation (mid-bind included),
					// which decides only how the answer lands (no parking, no unseen
					// marker for a conversation somebody is inside), or a person who
					// watched the answer end before the stop closed the connection.
					const adoptedByLiveSession = !!(cookingHandle && cookingHandle.adopterConnectionId);
					const watchedByAdopter = adoptedByLiveSession || newerSessionWatchesThisConversation() || leftAfterAnswerEndedInStop;
					if (cookingHandle) {
						// Settle the handle FIRST, synchronously with the landing:
						// a connection consulting the registry after this line binds
						// to a settled thread, never onto a stream about to vanish.
						cookingHandle.settled = true;
						if (detachedCookingTurnHandles.get(persistentAgentIdForSession) === cookingHandle) detachedCookingTurnHandles.delete(persistentAgentIdForSession);
					}
					const keyedSettle = keyedTurn?.steps === turnSteps ? keyedTurn : null;
					if (keyedSettle) {
						// Stop after the model finished: the last message lands as the page showed it.
						if (revealCutAtSettle !== undefined) {
							keyedSettle.steps.cutLastMessage(revealCutAtSettle);
							applyRevealCut(revealCutAtSettle);
						}
						if (partRevealNoteAtSettle) answerNotes.set(answerNoteKey(), { kind: "stop", shown: partRevealNoteAtSettle });
						partRevealNoteAtSettle = undefined;
						try {
							// A message the room offered back lands once the page says it kept it above; one refused before it reached the conversation lands nothing.
							if (returnedPrompt?.id !== undefined) {
								const land = keyedLandingOf(persistentTurnId, keyedSettle, turn?.terminalReason ?? "failed", { watched: true, stopCut: false });
								pendingKeptLandings.set(answerNoteKey(), (kept) => { if (kept) land(); });
							} else if (returnedPrompt === undefined) {
								// A server stop's cut says so in the file, as the close-time landing of an old-style turn does: the page's own line may never be saved.
								const stopCut = turn?.stoppedByServer === true;
								keyedLandingOf(persistentTurnId, keyedSettle, turn?.terminalReason ?? "failed", { watched: (!detachedFromClient && !stopCut) || watchedByAdopter, stopCut, awayLimit: turn?.awayLimit })();
							}
						} catch (error) {
							app.log.warn({ err: error }, "failed to land keyed persistent-room turn");
						}
					} else if (detachedFromClient) {
						// A message the step back handed back says its own line on the way in.
						try { landDetachedTurnOutcome(persistentTurnId, turn?.terminalReason ?? "failed", { watchedByAdopter, handedBack: returnedPrompt?.id !== undefined }); } catch (error) { app.log.warn({ err: error }, "failed to land detached persistent-room turn outcome"); }
					}
					// Post-stream tail: a turn that ran to its COMPLETED end with
					// the client still attached has its answer only client-side
					// until the debounced persist fires. Snapshot what a close-time
					// landing would need; detached turns just landed above, and
					// error/cancel settles keep today's behavior, except a turn a
					// server stop ended, whose partial the page may never save. A
					// message handed back to the box lands nothing: its failed
					// attempts went with it.
					if (!keyedSettle && !detachedFromClient && returnedPrompt === undefined && (turn?.terminalReason === "completed" || (turn?.terminalReason === "failed" && turn.stoppedByServer === true))) {
						const settledFinalText = turnTrace.finalAssistantText.trim();
						settledTurnLandingSnapshot = settledFinalText
							? { turnId: persistentTurnId, finalAssistantText: settledFinalText, anchorItemId: turnStartAnchorItemId, earlierPromptsAfterAnchor: turnStartEarlierPrompts, userText: currentTurnUserTextForLanding, ...(typeof activePersistentWebTurn?.startedAt === "number" ? { startedAt: activePersistentWebTurn.startedAt } : {}), settledAt: Date.now(), stepLog: turnSteps, ...(turn?.terminalReason === "failed" && turn.stoppedByServer === true ? { stoppedByServer: true as const } : {}) }
							: null;
						// The client can leave between the last frame and this settle
						// (the turn already read "completed", so the close handler did
						// not detach it, and it found no snapshot to land). Land now,
						// or the answer would exist nowhere and the conversation would
						// never be parked.
						if (revealCutAtSettle !== undefined) applyRevealCut(revealCutAtSettle);
						if (settledTurnLandingSnapshot && socket.readyState !== socket.OPEN) landSettledTurnIfUnpersisted();
					}
					revealCutAtSettle = undefined;
					if (activePersistentWebTurn?.turnId === persistentTurnId) activePersistentWebTurn = null;
					// Detached settle: this connection's ownership ends here — the
					// away limits, the cooking flag, this closure's own lock record
					// (owner-checked, so inert after an adoption takeover) and the
					// session all wind down. The claimed lock record is released
					// only when nobody is inside; a live adopter keeps it as its
					// ordinary session lock, released by ITS close handler.
					if (detachedFromClient) {
						releaseLiveConnectionForStop();
						clearAwayLimits();
						detachedCookingRooms.delete(persistentAgentIdForSession);
						if (persistentRoomLiveSessions.get(persistentAgentIdForSession) === liveSessionHandle) persistentRoomLiveSessions.delete(persistentAgentIdForSession);
						releaseRoomLockNow();
						if (adoptedByLiveSession) {
							// Hand the adopter the settle signal so it rebinds
							// its session against the landed history.
							try { adopterOnSettled?.(); } catch (error) { app.log.warn({ err: error }, "adopted-turn settle callback failed"); }
						} else if (cookingHandle?.claimantConnectionId) {
							// A claimant is ALIVE mid-bind (redetach clears the
							// claimant when one dies): the lock record it took over
							// is about to be its ordinary session lock, released by
							// its own close handler. Releasing it here would strand
							// that live session lock-less the moment its bind
							// finishes onto the settled thread.
						} else {
							try { adopterReleaseLock?.(); } catch {}
						}
						cookingTurnSink = null;
						adopterOnDisplaced = null;
						if (!sessionDisposed) {
							sessionDisposed = true;
							try { (session as any)?.dispose?.(); } catch {}
						}
					}
					// Buffer lifecycle: the replay buffer dies with
					// the turn, on EVERY connection, attached or detached, so an
					// idle tab never retains its last turn's stream. The one
					// exception is a claimant still alive mid-bind, whose settled
					// replay needs the buffer; its phase two releases it after
					// replaying (and its disconnect drops the closure either way).
					const keepReplayBufferForPendingClaim = !!(cookingHandle && cookingHandle.claimantConnectionId && !adoptedByLiveSession);
					if (!keepReplayBufferForPendingClaim) releaseTurnFrameBuffer();
				}
			}
		} else if (msg.type === "returned_prompt_handled") {
			// The page keeps the message where it was when the box holds other text.
			if (msg.kept === true && lastPromptTurnStart) lastPromptTurnStart.promptKept = true;
			const keptLanding = pendingKeptLandings.get(answerNoteKey());
			if (keptLanding) {
				pendingKeptLandings.delete(answerNoteKey());
				try { keptLanding(msg.kept === true); } catch (error) { app.log.warn({ err: error }, "failed to land the kept persistent-room turn"); }
			}
			if (session && getPersistentAgentActiveTurnState(persistentAgentIdForSession, persistentConversationId).state === "idle") await settleReturnedPrompt(session as any, msg.kept === true);
		} else if (msg.type === "abort") {
			// Stop after a reattach cancels the ADOPTED turn, which runs in
			// the detaching connection's closure, through the same cancelling
			// machinery a never-left session uses. Claimant-checked: a session
			// another window displaced falls through to its own (idle) session,
			// so its Stop can never abort a stream someone else is watching.
			const cooking = claimedCookingTurn;
			const shown = readShownChars(msg.shown);
			if (cooking && !cooking.settled && cooking.claimantConnectionId === connectionId) {
				await cooking.stop(connectionId, shown, msg.forNext === true);
			} else {
				returnUntakenSteers();
				markStop(msg.forNext === true, shown);
				await abortActivePersistentWebTurn("cancelled");
			}
		} else if (msg.type === "steer") {
			// A message sent while the room answers. An adopted answer runs in
			// the detaching connection's closure, so its steer goes through the
			// handle, claimant-checked like its Stop.
			const request = readSteerRequest(msg);
			const cooking = claimedCookingTurn;
			send(cooking && !cooking.settled && cooking.claimantConnectionId === connectionId
				? await cooking.steerTurn(connectionId, request)
				: await routeSteer(request));
		} else if (msg.type === "steer_withdraw") {
			const id = typeof msg.id === "string" ? msg.id : "";
			const cooking = claimedCookingTurn;
			const out = cooking && !cooking.settled && cooking.claimantConnectionId === connectionId
				? await cooking.withdrawSteer(connectionId, id)
				: await withdrawSteer(id);
			send(out ? { type: "steer_withdrawn", id, edit: msg.edit === true } : { type: "steer_withdraw_refused", id });
		} else if (msg.type === "stop_reveal") {
			// Stop after the model finished, while the page still showed the rest: the page's frozen copy is the record.
			stopReveal(readShownChars(msg.shown));
		} else if (msg.type === "consult") {
			const consultId = String(msg.consultId ?? "").trim();
			if (!consultId) return;
			// §8.6: overflow must reach the client as a DISTINGUISHABLE error (a
			// machine-readable `code`), so the card can render the "no longer fits"
			// state without string-matching the message. The stop's refusal carries
			// its own code; other errors carry none.
			const consultError = (message: string, code?: string) => send({ type: "consult_error", consultId, message, ...(code ? { code } : {}) });
			// A consult queued behind the answer is sent the moment it ends: it waits for that turn to wind down, as a message does.
			const windingDown = windingDownForThisWindow();
			if (windingDown) {
				await Promise.race([windingDown, new Promise((resolve) => setTimeout(resolve, TURN_WINDING_DOWN_WAIT_MS))]);
				if (socket.readyState !== socket.OPEN || sessionDisposed) return;
			}
			if (serverStopping()) {
				consultError(SERVER_STOPPING_SENTENCE, SERVER_STOPPING_CODE);
				return;
			}
			// Start gate: a consult may not start while this room is answering.
			// (The reverse is allowed — prompts process normally during a consult.)
			// An adopted cooking turn counts as answering too.
			if (activePersistentWebTurn || (claimedCookingTurn && !claimedCookingTurn.settled)) {
				consultError("This room is answering right now. Wait for the current turn to finish, then consult.");
				return;
			}
			if (activeWebConsult) {
				consultError("A consult is already running. One consult at a time — stop it or wait for it to finish.");
				return;
			}
			const consult: ActiveWebConsult = { consultId, abortController: new AbortController(), stoppedByUser: false };
			activeWebConsult = consult;
			const releaseConsultForStop = trackRunningWork("consult", () => consult.abortController.abort());
			let consulted: { room: string; model: PersistentAgentModelLock } | undefined;
			try {
				const targetStatus = getPersistentAgentStatusForMaintenance(String(msg.targetRoomId ?? "").trim());
				const selection = roomMemoryModelSelection(targetStatus.id, targetStatus.displayName || targetStatus.id);
				consulted = { room: targetStatus.displayName || targetStatus.id, model: selection.modelLock };
				send({ type: "consult_started", consultId, targetRoomId: targetStatus.id, targetDisplayName: targetStatus.displayName ?? targetStatus.id, model: selection.modelLock });
				const response = await buildConsultAnswer(
					// §8.1: the client holds the conversation; `priorExchanges` re-feeds
					// B's own earlier Q/A. The server stays stateless — buildConsultAnswer
					// validates the wire shape + backstop cap (§8.6) before use.
					{ targetAgentId: targetStatus.id, fromRoomId: persistentAgentIdForSession, question: String(msg.question ?? ""), priorExchanges: msg.priorExchanges, targetLifecycleStatus: targetStatus.status },
					selection.modelLock,
					async (prompt, modelLock) => {
						const workerResult = await runIsolatedPersistentAgentWorker({
							workerSystemPrompt: prompt,
							triggerPrompt: CONSULT_TRIGGER_PROMPT,
							modelLock,
							resolveExpectedModel: resolveConsultModel,
							workerLabel: "consult worker",
							callKind: "consult",
							emptyTextError: "consult worker produced no text",
							cwd: REPO_ROOT,
							agentDir: getAgentDir(),
							modelRegistry: getWebChatModelRegistry(),
							signal: consult.abortController.signal,
							onEvent: (event: any) => {
								if (event?.type !== "message_update") return;
								const update = event.assistantMessageEvent;
								if (update?.type === "text_delta" && typeof update.delta === "string") {
									send({ type: "consult_delta", consultId, delta: update.delta });
								}
							},
						});
						// Consult usage bills to this room (room A), not the consulted room.
						recordWorkerUsage(persistentAgentIdForSession, "consult", modelLock, workerResult.usage);
						return workerResult;
					},
					{ resolveModelWindow: consultModelWindow },
				);
				if (consult.abortController.signal.aborted) {
					consultError(consult.stoppedByUser ? "Consult stopped by you." : "The consult was cancelled.");
				} else {
					send({
						type: "consult_end",
						consultId,
						text: response.answerMarkdown,
						l1bFingerprint: response.source.l1bFingerprint,
						generatedAt: response.source.generatedAt,
						...(response.consultUsage ? { usage: response.consultUsage } : {}),
						warnings: response.warnings,
					});
				}
			} catch (e) {
				if (consult.abortController.signal.aborted) {
					consultError(consult.stoppedByUser ? "Consult stopped by you." : "The consult was cancelled.");
				} else if (e instanceof ConsultPromptOverflowError) {
					// §8.6: the stacked conversation no longer fits B's context. Tag the
					// error so the card disables the follow-up input and shows the
					// "no longer fits" state instead of a generic failure.
					consultError((e as Error).message, "prompt_overflow");
				} else {
					// The consulted room's Memory model not on this account, or no longer served: the plain line, the provider's words to the log.
					const refused = consulted && (notOnAccountLine(e, consulted.model, { room: consulted.room }) ?? notOfferedLine(e, consulted.model, { room: consulted.room }));
					if (refused) app.log.warn({ err: failureWords(e) }, "the provider refused the consulted room's Memory model");
					consultError(refused || (e as Error).message);
				}
			} finally {
				releaseConsultForStop();
				if (activeWebConsult === consult) activeWebConsult = null;
			}
		} else if (msg.type === "consult_abort") {
			// Unknown or stale consult ids are ignored — same discipline the
			// client applies to stale consult events.
			const consultId = String(msg.consultId ?? "").trim();
			if (!activeWebConsult || activeWebConsult.consultId !== consultId) return;
			activeWebConsult.stoppedByUser = true;
			activeWebConsult.abortController.abort();
		} else if (msg.type === "task_abort") {
			// Same stale-id discipline. Artifacts already on disk are kept — only
			// the running worker dies. Registry-resolved (option 4): this
			// connection can stop a task an EARLIER connection launched.
			const taskId = String(msg.taskId ?? "").trim();
			if (!taskId) return;
			abortSpecialistTask(persistentAgentIdForSession, taskId);
		} else if (msg.type === "task_iterate") {
			if (serverStopping()) {
				send({ type: "task_iterate_result", ok: false, reason: SERVER_STOPPING_SENTENCE, code: SERVER_STOPPING_CODE });
				return;
			}
			// Specialists are switched off: a page from before still sending a
			// change request is told so, after the stop's own refusal above.
			send({ type: "task_iterate_result", ok: false, reason: SPECIALISTS_OFF_SENTENCE });
		}
	};

	// The listener is live from here, so the hold ends: the queued frames go
	// through the same handler, in the order they arrived and before anything
	// that lands from now on, which makes an early first message merely early
	// rather than lost. A client that overran the bound is told so, because a
	// connection that silently ate some of its frames is worse than one that
	// says it could not keep them.
	socket.off("message", holdFrameUntilListener);
	socket.on("message", handleSocketMessage);
	if (framesBeforeListenerOverflowed) {
		send({ type: "error", message: "too many messages arrived before the room finished opening; reload the room and send that again" });
	}
	if (framesBeforeListener.length > 0) {
		const held = framesBeforeListener.splice(0, framesBeforeListener.length);
		void held.reduce(
			(chain, raw) => chain.then(() => handleSocketMessage(raw)).catch((e) => { app.log.warn({ err: e }, "failed to replay a frame received before the room finished opening"); }),
			Promise.resolve(),
		);
	}

	// Only a newer session on THIS conversation is watching a landing (a
	// reload, a second tab on the same conversation). A newer session on
	// another conversation means the person left this one for another:
	// nobody is looking at it, so the landing parks it as standby and records
	// the unseen marker like any landing nobody watched.
	const newerSessionWatchesThisConversation = (): boolean => {
		const otherLiveSession = persistentRoomLiveSessions.get(persistentAgentIdForSession);
		return !!otherLiveSession && otherLiveSession !== liveSessionHandle && otherLiveSession.conversationId === persistentConversationId;
	};

	// Lands the settled answer the client never persisted: from the close
	// handler when the client dies inside the persist window, and from the
	// settle path itself when the client had already left between the last
	// frame and the settle (the close handler ran before the snapshot
	// existed, so nobody else would land it). Idempotent: a thread that
	// already carries the answer is left alone.
	const landSettledTurnIfUnpersisted = (): void => {
		const closeLandingSnapshot = settledTurnLandingSnapshot;
		settledTurnLandingSnapshot = null;
		if (!closeLandingSnapshot) return;
		try {
			const persisted = getPersistentAgentThread(persistentAgentIdForSession, persistentConversationId);
			// An answer stopped before any of it showed has no text to look for: the turn's prompt says whether the page saved it.
			const unsaved = closeLandingSnapshot.finalAssistantText
				? !threadItemsCarryAssistantText(persisted?.items, closeLandingSnapshot.finalAssistantText)
				: !(persisted?.items ?? []).some((item: any) => item?.kind === "user" && String(item.text ?? "").trim() === closeLandingSnapshot.userText.trim());
			if (persisted && persisted.state !== "closed" && unsaved) {
				// A partial the stop cut lands as cut: the stop's line, parked, marked unseen. Only a newer session inside the conversation watches it.
				const stopCut = closeLandingSnapshot.stoppedByServer === true;
				landDetachedTurnOutcome(closeLandingSnapshot.turnId, stopCut ? "failed" : "completed", { snapshot: closeLandingSnapshot, watchedByAdopter: (!stopCut && serverStopping()) || newerSessionWatchesThisConversation() });
			}
		} catch (error) {
			app.log.warn({ err: error }, "failed to land the settled turn answer on close");
		}
	};

	socket.on("close", () => {
		app.log.info("ws client disconnected");
		// A consult answer that was never transferred is re-derivable: kill the
		// worker and discard silently.
		activeWebConsult?.abortController.abort();
		// A specialist task started before they were switched off survives the
		// connection (it belongs to the room, not to the tab). This connection merely stops being the room's sink;
		// endings nobody hears finalize with noticed:false and arrive as
		// away-notices on the next connect.
		unbindSpecialistSink(persistentAgentIdForSession, sendChecked);
		// A disconnect no longer cancels an in-flight
		// turn. The session keeps cooking with the room lock held; pending and
		// future interactive dialogs reject the way scheduled background work
		// does, and the prompt handler lands the finished answer into the
		// thread file, then releases the lock and disposes the session.
		if (turnKeepsCookingOnClose()) {
			detachedFromClient = true;
			// Still detached, so the lock, the stop's wait and the landing stay with the turn; it lands as watched, as a settled answer closed by the stop does.
			leftAfterAnswerEndedInStop = serverStopping() && answerAlreadyEnded((session as any)?.agent?.state?.messages);
			detachedCookingRooms.add(persistentAgentIdForSession);
			declinedByStop = false;
			uiContext.detach(LEFT_ROOM_QUESTIONS_SENTENCE);
			armAwayLimits();
			// Register the reattach handle, so a session stepping
			// back into the room adopts this cooking turn instead of bouncing.
			// Methods run in THIS closure; the registry entry dies at settle.
			const keyedPrompt = keyedTurn && keyedTurn.steps === turnSteps && !keyedTurn.continued ? keyedTurn : null;
			const handle: DetachedCookingTurnHandle = {
				conversationId: persistentConversationId,
				turnId: activePersistentWebTurn?.turnId ?? "",
				// The turn's own prompt, which a landing restores: the consent text follows the newest taken message.
				// A keyed question goes back as its bubble showed it, by id.
				userText: keyedPrompt ? keyedPrompt.shown?.text ?? keyedPrompt.strippedText : currentTurnUserTextForLanding,
				...(keyedPrompt ? { promptId: keyedPrompt.key, promptFiles: keyedPrompt.shown?.files ?? [] } : {}),
				anchorItemId: turnStartAnchorItemId,
				earlierPromptsAfterAnchor: turnStartEarlierPrompts,
				...(typeof activePersistentWebTurn?.startedAt === "number" ? { startedAt: activePersistentWebTurn.startedAt } : {}),
				settled: false,
				claimantConnectionId: null,
				adopterConnectionId: null,
				bufferedTurnFrames: () => [...turnFrameBuffer],
				replayUnavailable: () => turnReplayOverflowed,
				releaseReplayBuffer: () => releaseTurnFrameBuffer(),
				claim: (claimant, releaseLock, onDisplaced) => {
					if (handle.claimantConnectionId !== claimant) {
						// A previous claimant's lock record was just taken over; its
						// release is owner-checked, so invoking it only stops that
						// connection's now-pointless heartbeat.
						if (adopterReleaseLock) { try { adopterReleaseLock(); } catch {} }
						// Whoever held the claim is displaced: a live ADOPTER stops
						// receiving frames (the new claimant replays the buffer)
						// and is told, so its window never freezes busy; a claimant
						// still MID-BIND is told too (the hook it registered at its
						// own claim), so it never proceeds as a silent lock-less
						// session during a cooking turn.
						const displaced = adopterOnDisplaced;
						// Words already written reach the displaced adopter before it is told.
						turnFrameCoalescer.flush();
						handle.adopterConnectionId = null;
						cookingTurnSink = null;
						adopterOnSettled = null;
						adopterOnDisplaced = null;
						try { displaced?.(); } catch {}
					}
					handle.claimantConnectionId = claimant;
					adopterReleaseLock = releaseLock;
					adopterOnDisplaced = onDisplaced;
				},
				adopt: (claimant, sink, hooks) => {
					if (handle.settled || handle.claimantConnectionId !== claimant) return false;
					handle.adopterConnectionId = claimant;
					cookingTurnSink = sink;
					adopterOnSettled = hooks.onSettled;
					adopterOnDisplaced = hooks.onDisplaced;
					detachedCookingRooms.delete(persistentAgentIdForSession);
					// Somebody is watching again and Stop is reachable: the
					// away limits stand down.
					clearAwayLimits();
					return true;
				},
				redetach: (claimant) => {
					if (handle.settled || handle.claimantConnectionId !== claimant) return;
					handle.adopterConnectionId = null;
					// The claimant is GONE (its close handler is the only caller):
					// clearing it lets the settle path release the lock record it
					// left behind, and distinguishes this from a claimant still
					// alive mid-bind, whose lock the settle must NOT touch.
					handle.claimantConnectionId = null;
					cookingTurnSink = null;
					adopterOnSettled = null;
					adopterOnDisplaced = null;
					// Nobody is inside again; a stop's own words stay, and what it declines from here is noted as away.
					declinedByStop = false;
					if (!serverStopping()) uiContext.detach(LEFT_ROOM_QUESTIONS_SENTENCE);
					detachedCookingRooms.add(persistentAgentIdForSession);
					// Memento must still be able to quiesce the re-detached turn.
					persistentRoomLiveSessions.set(persistentAgentIdForSession, liveSessionHandle);
					armAwayLimits();
				},
				attachQuestions: (claimant, canAnswer) => {
					if (handle.settled || handle.adopterConnectionId !== claimant || serverStopping()) return;
					// Every frame a viewing-only device sends is dropped, so a card there would wait for nobody.
					if (canAnswer) uiContext.attach();
					else uiContext.detach(LEFT_ROOM_QUESTIONS_SENTENCE);
				},
				answerQuestion: (claimant, id, value) => {
					if (handle.adopterConnectionId !== claimant) return;
					uiContext.resolveResponse(id, value);
				},
				stop: (claimant, shown, forNext = false) => {
					// Claimant-checked exactly like adopt/redetach: a displaced
					// connection's Stop must never abort the stream the CURRENT
					// adopter is watching.
					if (handle.settled || handle.claimantConnectionId !== claimant) return Promise.resolve();
					returnUntakenSteers();
					markStop(forNext, shown);
					return abortActivePersistentWebTurn("cancelled");
				},
				stopRevealPart: (claimant, partId, shown) => {
					if (handle.settled || handle.claimantConnectionId !== claimant) return;
					stopRevealPart(partId, shown);
				},
				windingDown: windingDownOfThisTurn,
				landedItemId: () => landedThroughItemId,
				waiting: (claimant) => (handle.settled || handle.claimantConnectionId !== claimant ? [] : waitingSteers()),
				steerTurn: (claimant, request) => {
					if (handle.settled || handle.claimantConnectionId !== claimant) return Promise.resolve({ type: "steer_refused" as const, id: request.id });
					return routeSteer(request);
				},
				withdrawSteer: (claimant, id) => (handle.settled || handle.claimantConnectionId !== claimant ? Promise.resolve(false) : withdrawSteer(id)),
			};
			detachedCookingHandle = handle;
			detachedCookingTurnHandles.set(persistentAgentIdForSession, handle);
			app.log.info({ agentId: persistentAgentIdForSession }, "ws client disconnected mid-turn; finishing the response in the background");
			return;
		}
		// Post-stream tail: the turn settled "completed" while this client
		// watched, but the client-authored persist may never have fired (the
		// debounce rearms on every reveal tick; the first write with the answer
		// lands ~500ms after the last one). If the finished answer is not in
		// the thread file, land it through the same machinery a detached turn
		// uses: supersede-safe write, standby parking, unseen marker. Skipped
		// whenever a client write already carried the answer, so a pagehide
		// keepalive save that won the race makes this a no-op; a save that
		// LOSES the race merges in the PUT handler instead of clobbering. When
		// a newer connection already took the room over (reload), the landing
		// still writes the answer but keeps the room's state and records no
		// marker, exactly like a watched adopter landing. While the server
		// stops, the close is the stop's, or comes in its wait after the page
		// watched the answer end, so the landing counts as watched too; a
		// partial the stop cut does not, since it lands as cut.
		landSettledTurnIfUnpersisted();
		void disposeSessionAfterAbortIfNeeded("disconnect_cancelled").catch((error) => {
			app.log.warn({ err: error }, "persistent-room disconnect cleanup failed");
			if (!sessionDisposed && session) {
				sessionDisposed = true;
				try { (session as any)?.dispose?.(); } catch {}
			}
		});
	});
});
