import { useState, useEffect, type ReactNode, useRef } from "react";
import { useEscapeKey } from "./use-escape-key";
import { nothingToMaintain, NOTHING_TO_MAINTAIN_SENTENCE, fmtMemoryDay } from "../memory-surface-copy";
import { fmtTokensK } from "./RoomMaintenanceSection";
import { MarkdownRenderer } from "./Markdown";
import { type ModelWait, modelWaitLine, ModelNoticePanel } from "./model-notice";
import { fetchAbsorbStatus } from "../absorb-run-api";
import { memorizeNotesText, memorizeChooserText, DISCUSS_FIRST_TITLE, DISCUSS_FIRST_LABEL, maintainChooserFootnote, reviewChangeCounts, reviewRunFullPercent, reviewRunNothingToSave, reviewRunTopicsLeft, FIRST_READ_MISSING_SENTENCE, REVIEW_RUN_ACTIVE_SENTENCE, REVIEW_RUN_ACTIVE_ACTION, ABSORB_CHOOSE_MODEL_LABEL, AUTOMATIC_APPLY_ON_SENTENCE, absorbRunNothingToSave, absorbRunSavedHeadline, absorbRunSortedRows, absorbRunSavedSentence, absorbRunNewTopics, absorbRunFullPercent, LIMIT_LOWERED_ON_UNDO_SENTENCE, LIMIT_RAISED_ON_SAVE_SENTENCE, OPEN_CONVERSATION_KEEPS_MEMORY_SENTENCE, absorbRunAllSummarized, absorbRunAllSummarizedSentence, absorbRunOutageModelName, absorbRunNotesChanged, ABSORB_RUN_ACTIVE_SENTENCE, ABSORB_RUN_ACTIVE_ACTION, overLimitFirstRead, plainFirstReadLine } from "../memory-v2-copy";
import { type NoteEdit, type SortedMove, placeholderAbsorbRun, AbsorbRunCard, AbsorbRunFailedScreen } from "./absorb-run-screen";
import { type ReviewUndoState, reviewPercent, ReviewRunProgressScreen, ReviewRunFailedScreen, ReviewCard, ReviewSavedScreen, ReviewFirstReadSections, ReviewDepthPicker } from "./review-screen";
import { fetchReviewStatus } from "../review-api";
import type { PersistentAgentStatus, PersistentAgentId, ReviewDepth, AbsorbAssessmentResponse } from "../types";
import type { MaintainTarget } from "../room-thread-items";
import type { AbsorbWorkflowState, ReviewWorkflowState } from "../maintain-workflow-state";
import { absorbUnavailableCopy, ROOM_TURN_WAIT_LINE } from "../maintenance-errors";

// In-flow replacement for the browser confirm at the Maintain flow's sensitive
// moments: same visual language as the rest of the product, Escape cancels.
type MaintainConfirm = { title: string; body: string; confirmLabel: string; cancelLabel: string; onConfirm: () => void };

function MaintainConfirmDialog({ confirm, onClose }: { confirm: MaintainConfirm; onClose: () => void }) {
	useEscapeKey(onClose, true);
	return (
		<div className="checkpoint-preview-backdrop maintain-confirm-backdrop" role="dialog" aria-modal="true" aria-label={confirm.title}>
			<section className="checkpoint-input-card maintain-confirm-card">
				<h2>{confirm.title}</h2>
				<p>{confirm.body}</p>
				<div className="checkpoint-preview-actions">
					<button className="rs-btn" onClick={onClose}>{confirm.cancelLabel}</button>
					<button className="rs-btn rs-btn-primary" autoFocus onClick={() => { onClose(); confirm.onConfirm(); }}>{confirm.confirmLabel}</button>
				</div>
			</section>
		</div>
	);
}

const EVERYTHING_MEMORIZED_SENTENCE = "Everything is memorized.";

function MaintainChooserShell({ target, roomStatus, onAbsorb, onDiscussFirst, onPrune, onReturn, returnLabel }: { target: MaintainTarget; roomStatus: PersistentAgentStatus | null; onAbsorb: () => void; onDiscussFirst: () => void; onPrune: () => void; onReturn: () => void; returnLabel: string }) {
	useEscapeKey(onReturn, true);
	const memoryStatus = roomStatus?.memoryStatus ?? null;
	const memoryBudget = roomStatus?.memoryBudget ?? null;
	const waiting = memoryStatus?.recentContextCount ?? null;
	const sessionBlockCap = roomStatus?.recentContext?.blockCap ?? 20;
	// Notes waiting for a topic, or for their first re-read, keep Memorize open with no conversation waiting.
	const notesToSort = memoryStatus?.notesToSort ?? 0;
	const nothingWaiting = waiting === 0 && notesToSort === 0;
	// Nothing waiting in a room that has remembered or memorized a conversation means it is all memorized; a room never
	// talked to (its memory at most edited by hand) is asked for a conversation first.
	const everythingMemorized = nothingWaiting && Boolean(memoryStatus?.lastCheckpointAt);
	// A room that saves a clean update without the card starts Memorize
	// without a first read; Discuss first is its way to one.
	const automatic = roomStatus?.fastPathSecondApproval === true;
	// The belt for a deep link: the card and maintainBlockedReason already
	// keep Maintain closed on a room whose memory is still its scaffold.
	const nothingToReview = nothingToMaintain(memoryStatus);
	const fullPercent = memoryBudget && memoryBudget.budgetTokens > 0 ? Math.round((memoryBudget.reviewTargetEstimatedTokens / memoryBudget.budgetTokens) * 100) : null;
	const overLimit = fullPercent !== null && fullPercent > 100;
	// One recommendation at a time: waiting conversations come first, because
	// Memorize also makes room; a full room with nothing waiting points at Review.
	const recommended: "memorize" | "review" | null = waiting !== null && waiting > 0 ? "memorize" : overLimit ? "review" : null;
	const waitingWords = waiting === null ? null : waiting === 0 ? "Nothing waiting to be memorized" : <><strong>{waiting}</strong> {waiting === 1 ? "conversation" : "conversations"} waiting to be memorized</>;
	const fullWords = fullPercent === null ? null : overLimit ? <>memory is <strong className="over">above its budget</strong></> : <>memory <strong>{fullPercent}%</strong> full</>;
	const statusTitle = memoryBudget ? `The memory budget is set in Room settings: ${fmtTokensK(memoryBudget.reviewTargetEstimatedTokens)} of ${fmtTokensK(memoryBudget.budgetTokens)} tokens in use. A new conversation needs Memorize once the room holds ${sessionBlockCap}.` : undefined;
	const memorizeCard = (
		<button type="button" className={`maintain-action${recommended === "memorize" ? " recommended" : ""}`} disabled={nothingWaiting} title={everythingMemorized ? EVERYTHING_MEMORIZED_SENTENCE : nothingWaiting ? "Have a conversation with this room first." : undefined} onClick={onAbsorb}>
			<span className="maintain-action-body">
				<span className="maintain-action-head">
					<span className="maintain-action-title">Memorize</span>
					{recommended === "memorize" && <span className="maintain-action-tag">Recommended</span>}
				</span>
				<span className="maintain-action-text">{everythingMemorized
					? EVERYTHING_MEMORIZED_SENTENCE
					: nothingWaiting
					? `Nothing to memorize yet. Have a conversation with ${target.displayName} first.`
					: waiting === 0 ? memorizeNotesText(notesToSort) : memorizeChooserText(waiting ?? 0, automatic)}</span>
			</span>
			<span className="maintain-action-go" aria-hidden="true">Start</span>
		</button>
	);
	return (
		<div className="absorb-workspace maintain-workspace" aria-label="Memory maintenance chooser">
			<header className="absorb-workspace-header">
				<div>
					<p className="card-kicker">{target.displayName}</p>
					<h1>Memory.</h1>
					{(waitingWords || fullWords)
						? <p className="maintain-status" title={statusTitle}>{waitingWords}{waitingWords && fullWords ? " · " : ""}{fullWords}</p>
						: <p>What {target.displayName} remembers, and how to keep it in shape.</p>}
				</div>
				<button className="rs-btn" onClick={onReturn}>{returnLabel}</button>
			</header>
			<main className="absorb-workspace-main maintain-workspace-main">
				<div className="maintain-chooser-column">
					<section className="maintain-actions" aria-label="Memory maintenance workflows">
						{automatic ? (
							// Discuss first sits beside the card, never inside it: the card is one button.
							// The row around them starts Memorize too, as its shading says; a click on a
							// child is that child's own, so nothing fires twice.
							<div className="maintain-action-row" onClick={(event) => { if (event.target === event.currentTarget && !nothingWaiting) onAbsorb(); }}>
								{memorizeCard}
								<button type="button" className="rs-btn maintain-action-aside" disabled={nothingWaiting} title={DISCUSS_FIRST_TITLE} onClick={(event) => { event.stopPropagation(); onDiscussFirst(); }}>{DISCUSS_FIRST_LABEL}</button>
							</div>
						) : memorizeCard}
						<button type="button" className={`maintain-action${recommended === "review" ? " recommended" : ""}`} disabled={nothingToReview} title={nothingToReview ? NOTHING_TO_MAINTAIN_SENTENCE : "Tidy this room's notes"} onClick={onPrune}>
							<span className="maintain-action-body">
								<span className="maintain-action-head">
									<span className="maintain-action-title">Review</span>
									{recommended === "review" && <span className="maintain-action-tag">Recommended</span>}
								</span>
								<span className="maintain-action-text">{nothingToReview
									? NOTHING_TO_MAINTAIN_SENTENCE
									: "Make the notes shorter and clearer, and move what is finished or stale to the archive. You see every change before it is saved and can undo it after."}</span>
							</span>
							<span className="maintain-action-go" aria-hidden="true">Start</span>
						</button>
					</section>
					<p className="maintain-footnote">{maintainChooserFootnote(automatic)}</p>
				</div>
			</main>
		</div>
	);
}

/**
 * The wait of a Memory model call a screen is waiting on as one request (a
 * first read, a discussion turn, a sign-off): the room's status says it, asked
 * every few seconds while the request is open.
 */
function useMemoryCallWait(fetchStatus: ((agentId: PersistentAgentId) => Promise<{ wait?: ModelWait }>), agentId: PersistentAgentId | null): ModelWait | null {
	const [wait, setWait] = useState<ModelWait | null>(null);
	useEffect(() => {
		setWait(null);
		if (!agentId) return;
		let stopped = false;
		const timer = window.setInterval(() => {
			fetchStatus(agentId).then((status) => { if (!stopped) setWait(status.wait ?? null); }, () => {});
		}, 3_000);
		return () => { stopped = true; window.clearInterval(timer); };
	}, [fetchStatus, agentId]);
	return wait;
}

function ReviewWorkflowShell({ state, loadingMessage, waitingMessage, keepIds, turnWait = false, onStopAbandonedRun, onAbort, onDiscuss, onSendDiscussionMessage, onContinueFromDiscussion, onContinueWithoutDiscussion, onContinue, onBackToAssessment, onReassess, onRestart, onSetDepth, onCancelRun, onToggleRunKeep, onToggleRunKeepTopic, onRaiseRunBudget, onEditRunEntry, onSaveRun, onTryTopicsLeft, onCloseEmptyRun, onRunBackToAssessment, onResumeRun, onUndo, onChooseModel, onSignIn, returnLabel }: { state: ReviewWorkflowState; loadingMessage: string; waitingMessage: string; keepIds: string[]; turnWait?: boolean; onStopAbandonedRun: () => void; onAbort: () => void; onDiscuss: () => void; onSendDiscussionMessage: (message: string) => void; onContinueFromDiscussion: () => void; onContinueWithoutDiscussion: () => void; onContinue: () => void; onBackToAssessment: () => void; onReassess: () => void; onRestart: () => void; onSetDepth: (depth: ReviewDepth) => void; onCancelRun: () => void; onToggleRunKeep: (entryIds: string[], next: boolean) => void; onToggleRunKeepTopic: (section: "Deep Memory" | "Active Items", topic: string, next: boolean) => void; onRaiseRunBudget: (budgetTokens: number) => void; onEditRunEntry: NoteEdit; onSaveRun: () => void; onTryTopicsLeft: () => void; onCloseEmptyRun: () => void; onRunBackToAssessment: () => void; onResumeRun: () => void; onUndo: () => void; onChooseModel: () => void; onSignIn: (provider: string) => void; returnLabel: string }) {
	// A first read, a discussion turn or the sign-off waiting out a busy Memory model says so.
	const callWait = useMemoryCallWait(fetchReviewStatus, state.target && (state.step === "assessing" || state.step === "signing_off" || (state.step === "discussing" && state.discussionSending)) ? state.target.agentId : null);
	if (state.step === "closed") return null;
	const loading = state.step === "checking" || state.step === "assessing";
	const availability = state.availability;
	const assessment = state.assessment;
	const run = state.run ?? null;
	const discussionMessages = state.discussionMessages ?? [];
	const discussionBudget = state.discussionTokenBudget;
	const targetLabel = state.target?.displayName ?? "this room";
	const undo: ReviewUndoState = state.undo ?? { busy: false, done: false, error: null };
	const topicCount = availability?.topics ?? 0;
	// A first read that named stale notes is why the deeper tidy is offered
	// first, so the picker says so in the same words the read used.
	const staleFlagged = (assessment?.fields.staleOrContradicts.length ?? 0) > 0;
	const lookAlike = (assessment?.fields.lookAlikeTopics?.length ?? 0) > 0;
	const disagreeing = assessment?.fields.disagree?.length ?? 0;
	// The Memory model could not be reached for the first read: its notice, with Try again, is the way on.
	const unreachableRead = Boolean(state.notice && assessment?.firstReadMissing);
	const savedCounts = reviewChangeCounts(run?.changes ?? []);
	const savedBudget = state.approvalResult?.memoryBudget;
	const savedPercent = savedBudget ? reviewPercent(savedBudget.reviewTargetEstimatedTokens, savedBudget.budgetTokens) : run ? reviewRunFullPercent(run) : 0;
	const savedOver = savedBudget ? savedBudget.overBudget : run?.budget.overBudgetAfter === true;
	const bodyReturns = state.step === "unavailable" || (state.step === "saved" && Boolean(state.approvalResult)) || state.step === "error";
	const stepLine = loading
		? "Reading the notes…"
		: state.step === "assessment" || state.step === "discussing"
			? "Step 1 of 2 · a first read of what the notes need"
			: state.step === "running" || state.step === "run_card" || state.step === "signing_off" || state.step === "run_failed"
				// A card that could not finish changes nothing, so no step names a change.
				? (state.step === "run_card" && run && reviewRunNothingToSave(run) ? null : `Step 2 of 2 · what changes in ${targetLabel}'s memory`)
				: state.step === "approving"
					? (turnWait ? ROOM_TURN_WAIT_LINE : "Saving…")
					: state.step === "saved"
						? (undo.done ? "Undone" : "Saved")
						: `Tidying what ${targetLabel} knows.`;
	return (
		<div className="absorb-workspace maintain-workspace review-workspace" aria-label="Review workflow">
			<header className={`absorb-workspace-header${state.step === "discussing" ? " compact" : ""}`}>
				<div>
					<p className="card-kicker">{targetLabel}</p>
					<h1>Review.</h1>
					{stepLine && <p>{stepLine}</p>}
				</div>
				{state.step === "approving" ? (
					<button className="rs-btn" disabled title="The changes are being saved and cannot be cancelled.">Saving…</button>
				) : bodyReturns || state.step === "assessment" || state.step === "run_card" || state.step === "running" ? null : (
					// The first read, the working screen, the card and every page with its
					// own way back keep a single exit in their own action row.
					<button className="rs-btn" onClick={onAbort}>{state.step === "saved" || state.step === "unavailable" || state.step === "error" ? returnLabel : "Cancel"}</button>
				)}
			</header>
			<main className="absorb-workspace-main">
				<section className="checkpoint-input-card absorb-workflow-card">
				{callWait && <p className="checkpoint-read-note" role="status">{modelWaitLine(callWait)}</p>}
					{loading ? (
						<div className="checkpoint-generating-state absorb-loading-state">
							<h2>{loadingMessage}</h2>
							<span className="spinner spinner-lg" />
							<p>{topicCount > 0 ? `Reading the notes in ${topicCount} ${topicCount === 1 ? "topic" : "topics"}.${callWait ? "" : " This usually takes a minute or two."}` : `Reading the notes.${callWait ? "" : " This usually takes a minute or two."}`}</p>
						</div>
					) : state.step === "unavailable" ? (
						<div className="checkpoint-proposal-page absorb-unavailable-state">
							<div className="checkpoint-input-heading">
								<h2>Review cannot start yet</h2>
								<p>{state.unavailableReason || "This room's notes cannot be tidied right now. Nothing was changed. Try again in a moment."}</p>
							</div>
							<div className="checkpoint-preview-actions">
								<button className="rs-btn" onClick={onAbort}>{returnLabel}</button>
								<button className="rs-btn rs-btn-primary" onClick={onRestart}>Back to Maintain</button>
							</div>
						</div>
					) : state.step === "signing_off" || state.step === "approving" ? (
						<div className="checkpoint-generating-state absorb-loading-state">
							<h2>{state.step === "approving" ? "Saving…" : "Reading the discussion back…"}</h2>
							<span className="spinner spinner-lg" />
							<p>{state.step === "approving" ? "A copy of today's memory is kept, then the tidied notes are saved." : "What you agreed is folded into the tidy."}</p>
							{state.step === "approving" && <p>This step finishes on its own and cannot be cancelled.</p>}
						</div>
					) : state.step === "running" ? (
						run ? (
							<>
								{state.runPollError && <div className="checkpoint-proposal-error" role="alert">{state.runPollError}</div>}
								<ReviewRunProgressScreen run={run} onCancel={onCancelRun} />
							</>
						) : (
							<div className="checkpoint-generating-state absorb-loading-state">
								<h2>{waitingMessage}</h2>
								<span className="spinner spinner-lg" />
								<p>The notes are tidied topic by topic. Every note keeps its date and anything you pinned. Nothing is saved until you approve.</p>
								{state.runPollError && <div className="checkpoint-proposal-error" role="alert">{state.runPollError}</div>}
								<div className="checkpoint-preview-actions">
									<button className="rs-btn" onClick={onCancelRun} title="Stop this tidy and return to the first read. Nothing is saved.">Cancel</button>
								</div>
							</div>
						)
					) : state.step === "run_failed" ? (
						<ReviewRunFailedScreen onBack={onRunBackToAssessment} onRetry={onContinue} />
					) : state.step === "run_card" && run ? (
						<ReviewCard
							run={run}
							roomName={targetLabel}
							keepIds={keepIds}
							busy={state.runBusy === true}
							error={state.error}
							fastPathBlockedReasons={state.fastPathBlockedReasons}
							onToggleKeep={onToggleRunKeep}
							onToggleKeepTopic={onToggleRunKeepTopic}
							onRaiseBudget={onRaiseRunBudget}
							onEditEntry={onEditRunEntry}
							onCancel={onCancelRun}
							onBack={onRunBackToAssessment}
							backLabel="Back"
							onSave={onSaveRun}
							onClose={onCloseEmptyRun}
							onTryAgain={onResumeRun}
							onChooseModel={onChooseModel}
							onSignIn={onSignIn}
						/>
					) : state.step === "saved" && state.approvalResult ? (
						<ReviewSavedScreen
							roomName={targetLabel}
							counts={savedCounts}
							topicsLeft={run ? reviewRunTopicsLeft(run) : []}
							percent={savedPercent}
							over={savedOver}
							archivedEntries={state.approvalResult.archivedEntries}
							archivedForBudget={state.approvalResult.archivedForBudget}
							rebasedOnto={state.approvalResult.rebasedOnto}
							limitRaised={state.approvalResult.budgetRaisedTo !== undefined}
							openConversationKeepsMemory={state.approvalResult.openConversationKeepsMemory === true}
							// Only the plain outcome: the sign-off's and the save's own notes are the engine's, not the person's.
							warnings={state.fastPathApplied ? ["This room saves memory updates on its own, so these changes were saved without a second look."] : []}
							undo={undo}
							onUndo={onUndo}
							onTryAgain={onTryTopicsLeft}
							onChooseModel={onChooseModel}
							stop={run?.stop}
							onReturn={onAbort}
							returnLabel={returnLabel}
						/>
					) : state.step === "error" ? (
						<div className="checkpoint-proposal-page absorb-error-state">
							<div className="checkpoint-input-heading">
								<h2>Review could not start</h2>
								{!/No memory was (?:updated|changed)/.test(state.error ?? "") && <p>No memory was changed. You can open Maintain again right away.</p>}
							</div>
							{state.error && <div className="checkpoint-proposal-error" role="alert">{state.error}</div>}
							{state.notice && <ModelNoticePanel notice={state.notice} onTryAgain={onRestart} onChooseModel={onChooseModel} onSignIn={(provider) => onSignIn(provider ?? "")} />}
							<div className="checkpoint-preview-actions">
								<button className="rs-btn" onClick={onAbort}>{returnLabel}</button>
								{!state.notice && <button className="rs-btn rs-btn-primary" onClick={onRestart}>Start Maintain again</button>}
							</div>
						</div>
					) : state.step === "discussing" && assessment ? (
						<div className="checkpoint-proposal-page absorb-discussion-page review-discussion-page">
							<MaintenanceDiscussion
								assessmentMarkdown={assessment.assessmentMarkdown}
								aside={<ReviewFirstReadSections fields={assessment.fields} compact missing={Boolean(assessment.firstReadMissing)} />}
								outcome="tidy"
								notice={state.notice && <ModelNoticePanel notice={state.notice} onChooseModel={onChooseModel} onSignIn={(provider) => onSignIn(provider ?? "")} />}
								generateLabel="Continue →"
								backLabel="Back"
								messages={discussionMessages}
								budget={discussionBudget}
								warnings={state.discussionWarnings ?? null}
								error={state.error}
								sending={Boolean(state.discussionSending)}
								emptyHint={<p>Tell the room what to keep as it is, what to shorten, and what to move to the archive. The tidy follows what you say here.</p>}
								placeholder="Your answer or instruction…"
								onSend={onSendDiscussionMessage}
								onBack={onBackToAssessment}
								onGenerate={onContinueFromDiscussion}
								onDraftWithoutDiscussion={onContinueWithoutDiscussion}
							/>
						</div>
					) : assessment ? (
						<div className="checkpoint-proposal-page absorb-assessment-page review-assessment-page">
							{/* With the Memory model out of reach the page holds only its notice, so no heading names a read. */}
							{!unreachableRead && (
								<div className="checkpoint-input-heading checkpoint-proposal-heading">
									<h2>What {targetLabel}'s notes need</h2>
									<p>{assessment.firstReadMissing ? FIRST_READ_MISSING_SENTENCE : `A first read${topicCount > 0 ? ` of ${topicCount} ${topicCount === 1 ? "topic" : "topics"}` : ""}.`}</p>
								</div>
							)}
							{state.error && <div className="checkpoint-proposal-error" role="alert">{state.error}</div>}
							{state.notice && <ModelNoticePanel notice={state.notice} onTryAgain={onReassess} onChooseModel={onChooseModel} onSignIn={(provider) => onSignIn(provider ?? "")} />}
							{state.activeRunConflictId && (
								<div className="memory-action-note absorb-run-conflict-note">
									<span>{REVIEW_RUN_ACTIVE_SENTENCE}</span>
									<button className="rs-btn" onClick={onStopAbandonedRun} title="Stop the tidy this room is still holding, then start this one.">{REVIEW_RUN_ACTIVE_ACTION}</button>
								</div>
							)}
							{!unreachableRead && (
								<>
									<div className="absorb-assessment-grid absorb-assessment-flow">
										<ReviewFirstReadSections fields={assessment.fields} missing={Boolean(assessment.firstReadMissing)} />
									</div>
									{availability && (
										<ReviewDepthPicker availability={availability} staleFlagged={staleFlagged} lookAlike={lookAlike} disagreeing={disagreeing} firstReadMissing={Boolean(assessment.firstReadMissing)} chosen={state.depth ?? availability.recommendedDepth} onChoose={onSetDepth} />
									)}
									{assessment.fields.needsYourCall.length > 0 && <p className="absorb-help-note">Answer these in Discuss first, and the tidy follows your answers. Continue lets the room decide on its own.</p>}
								</>
							)}
							<div className="checkpoint-preview-actions">
								<button className="rs-btn" onClick={onAbort}>Cancel</button>
								{!unreachableRead && <button className="rs-btn" onClick={onReassess} title={assessment.firstReadMissing ? "Read the notes again. Nothing is saved." : "Read the notes again, asking the room to fix what this read got wrong. Nothing is saved."}>Read again</button>}
								{assessment.firstReadMissing && !unreachableRead && <button className="rs-btn" onClick={onChooseModel}>{ABSORB_CHOOSE_MODEL_LABEL}</button>}
								{!unreachableRead && <button className={`rs-btn${assessment.fields.needsYourCall.length > 0 ? " rs-btn-primary" : ""}`} onClick={onDiscuss} title="Talk the first read through before anything is tidied. The discussion is not saved to memory.">Discuss first</button>}
								{!unreachableRead && <button className={`rs-btn${assessment.fields.needsYourCall.length > 0 ? "" : " rs-btn-primary"}`} onClick={onContinue} title="Tidy the notes and show every change before saving">Continue →</button>}
							</div>
							{state.fastPathEnabled && <p className="checkpoint-footnote">{AUTOMATIC_APPLY_ON_SENTENCE} · a clean tidy is saved without a second look</p>}
						</div>
					) : null}
				</section>
			</main>
		</div>
	);
}

function AbsorbWorkflowShell({ state, loadingMessage, waitingMessage, keepIds, turnWait = false, onStopAbandonedRun, onAbort, onDiscuss, onSendDiscussionMessage, onGenerateFromDiscussion, onGenerate, onBackToAssessment, onReassess, onDraftWithoutDiscussion, onRestart, onCancelRun, onToggleRunKeep, onToggleRunKeepTopic, onRaiseRunBudget, onRaiseLimitBeforeRun, onReviewFirst, onEditRunEntry, onChooseRunBeside, onMoveRunSorted, onApproveRun, onRunBackToAssessment, onResumeRun, onUndo, onChooseModel, onSignIn, returnLabel }: { state: AbsorbWorkflowState; loadingMessage: string; waitingMessage: string; keepIds: string[]; turnWait?: boolean; onStopAbandonedRun: () => void; onAbort: () => void; onDiscuss: () => void; onSendDiscussionMessage: (message: string) => void; onGenerateFromDiscussion: () => void; onGenerate: () => void; onBackToAssessment: () => void; onReassess: () => void; onDraftWithoutDiscussion: () => void; onRestart: () => void; onCancelRun: () => void; onToggleRunKeep: (entryIds: string[], next: boolean) => void; onToggleRunKeepTopic: (section: "Deep Memory" | "Active Items", topic: string, next: boolean) => void; onRaiseRunBudget: (budgetTokens: number) => void; onRaiseLimitBeforeRun: (budgetTokens: number) => void; onReviewFirst: () => void; onEditRunEntry: NoteEdit; onChooseRunBeside: (entryId: string, choice: "replace" | "keep-both") => Promise<void>; onMoveRunSorted: SortedMove; onApproveRun: () => void; onRunBackToAssessment: () => void; onResumeRun: () => void; onUndo: () => void; onChooseModel: () => void; onSignIn: (provider: string) => void; returnLabel: string }) {
	// A first read, a discussion turn or the sign-off waiting out a busy Memory model says so.
	const callWait = useMemoryCallWait(fetchAbsorbStatus, state.target && (state.step === "assessing" || state.step === "signing_off" || (state.step === "discussing" && state.discussionSending)) ? state.target.agentId : null);
	if (state.step === "closed") return null;
	const loading = state.step === "checking" || state.step === "assessing";
	const availability = state.availability;
	const assessment = state.assessment;
	const discussionMessages = state.discussionMessages ?? [];
	const discussionBudget = state.discussionTokenBudget;
	const targetLabel = state.target?.displayName ?? "this room";
	// The Memory model could not be reached for the first read: its notice, with Try again, is the way on.
	const unreachableRead = Boolean(state.notice && state.assessment?.firstReadMissing);
	// The card shell shown from Continue until the run reports: the first read's
	// conversations, all waiting, so no loading screen sits between the two.
	const shellSessions = state.conversations ?? state.availability?.sessions ?? state.assessment?.availability.sessions ?? null;
	const shellRun = state.target && shellSessions ? placeholderAbsorbRun(state.target.agentId, shellSessions) : null;
	const bodyReturns = (state.step === "unavailable" && Boolean(availability)) || (state.step === "saved" && Boolean(state.approvalResult && state.run)) || state.step === "error";
	const stepLine = loading
		? "Reading the waiting conversations…"
		: state.step === "assessment" || state.step === "discussing"
			? "Step 1 of 2 · a first read of what the waiting conversations hold"
			: state.step === "running" || state.step === "run_card" || state.step === "proposing"
				// A paused card with nothing to save changes nothing, so no step names a change.
				? (state.step === "run_card" && state.run?.stop && absorbRunNothingToSave(state.run) ? null : `Step 2 of 2 · what ${targetLabel} will keep`)
				: state.step === "approving"
					? (turnWait ? ROOM_TURN_WAIT_LINE : "Saving…")
					: state.step === "saved"
						? (state.undo?.done ? "Undone" : "Saved")
						: `What ${targetLabel} keeps from its conversations.`;
	return (
		<div className="absorb-workspace maintain-workspace" aria-label="Memory absorption workflow">
			<header className={`absorb-workspace-header${state.step === "discussing" ? " compact" : ""}`}>
				<div>
					<p className="card-kicker">{targetLabel}</p>
					<h1>Memorize.</h1>
					{stepLine && <p>{stepLine}</p>}
				</div>
				{state.step === "approving" ? (
					<button className="rs-btn" disabled title="The memory update is being written and cannot be cancelled.">Updating memory…</button>
				) : bodyReturns || state.step === "assessment" || state.step === "running" || state.step === "run_card" ? null : (
					// Assessment, the run screens, the proposal and every page with its
					// own way back keep a single exit in their action row.
					<button className="rs-btn" onClick={onAbort}>{state.step === "saved" || state.step === "unavailable" || state.step === "error" ? returnLabel : "Cancel"}</button>
				)}
			</header>
			<main className="absorb-workspace-main">
				<section className="checkpoint-input-card absorb-workflow-card">
				{callWait && <p className="checkpoint-read-note" role="status">{modelWaitLine(callWait)}</p>}
				{loading ? (
					<div className="checkpoint-generating-state absorb-loading-state">
						<h2>{loadingMessage}</h2>
						<span className="spinner spinner-lg" />
						<p>{state.step === "assessing" && availability ? `Reading ${availability.recentContextEntryCount} waiting ${availability.recentContextEntryCount === 1 ? "conversation" : "conversations"}.${callWait ? "" : " This usually takes under a minute."}` : `Reading the waiting conversations.${callWait ? "" : " This usually takes under a minute."}`}</p>
					</div>
				) : state.step === "unavailable" && availability ? (
					(() => {
						const copy = absorbUnavailableCopy(availability);
						return (
							<div className="checkpoint-proposal-page absorb-unavailable-state">
								<div className="checkpoint-input-heading">
									<h2>{copy.heading}</h2>
									<p>{copy.body}</p>
								</div>
								{copy.detail && (
									<details className="absorb-candidate-disclosure absorb-detail-disclosure">
										<summary>Technical detail</summary>
										<p>{copy.detail}</p>
									</details>
								)}
								<div className="checkpoint-preview-actions">
									<button className="rs-btn" onClick={onAbort}>{returnLabel}</button>
									<button className="rs-btn rs-btn-primary" onClick={onRestart}>Back to Maintain</button>
								</div>
							</div>
						);
					})()
								) : (state.step === "proposing" || state.step === "signing_off") && shellRun ? (
					<AbsorbRunCard run={shellRun} roomName={targetLabel} working headline={state.step === "signing_off" ? "Reading the discussion back…" : "Starting…"} keepIds={[]} busy={false} error={null} onToggleKeep={() => {}} onToggleKeepTopic={() => {}} onRaiseBudget={() => {}} onApprove={() => {}} onCancel={onAbort} onBackToAssessment={onAbort} />
				) : state.step === "proposing" || state.step === "approving" || state.step === "signing_off" ? (
					<div className="checkpoint-generating-state absorb-loading-state">
						<h2>{state.step === "approving" ? "Saving to memory…" : state.step === "signing_off" ? "Reading the discussion back…" : "Starting…"}</h2>
						<span className="spinner spinner-lg" />
						<p>{state.step === "approving" ? "A copy of today's memory is kept, then the notes are saved." : state.step === "signing_off" ? "What you agreed becomes instructions for the memorize." : "Each conversation is read on its own and turned into notes."}</p>
						{state.step === "approving" && <p>This step finishes on its own and cannot be cancelled.</p>}
					</div>
				) : state.step === "running" ? (
					state.run ? (
						<>
							{state.runPollError && <div className="checkpoint-proposal-error" role="alert">{state.runPollError}</div>}
							<AbsorbRunCard run={state.run} roomName={targetLabel} working keepIds={keepIds} busy={false} error={null} onToggleKeep={onToggleRunKeep} onToggleKeepTopic={onToggleRunKeepTopic} onRaiseBudget={onRaiseRunBudget} onEditEntry={onEditRunEntry} onApprove={onApproveRun} onCancel={onCancelRun} onBackToAssessment={onRunBackToAssessment} />
						</>
					) : shellRun ? (
						<>
							{state.runPollError && <div className="checkpoint-proposal-error" role="alert">{state.runPollError}</div>}
							<AbsorbRunCard run={shellRun} roomName={targetLabel} working headline="Starting…" keepIds={[]} busy={false} error={null} onToggleKeep={() => {}} onToggleKeepTopic={() => {}} onRaiseBudget={() => {}} onApprove={() => {}} onCancel={onCancelRun} onBackToAssessment={onRunBackToAssessment} />
						</>
					) : (
						<div className="checkpoint-generating-state absorb-loading-state">
							<h2>Starting…</h2>
							<span className="spinner spinner-lg" />
							<p>Each conversation is read on its own and turned into notes.</p>
							{state.runPollError && <div className="checkpoint-proposal-error" role="alert">{state.runPollError}</div>}
							<div className="checkpoint-preview-actions">
								<button className="rs-btn" onClick={onCancelRun} title="Stop this memory update and return to the assessment. Nothing is saved.">Cancel</button>
							</div>
						</div>
					)
				) : state.step === "run_failed" ? (
					<AbsorbRunFailedScreen onBackToAssessment={onRunBackToAssessment} onRetry={onGenerate} />
				) : state.step === "run_card" && state.run ? (
					<AbsorbRunCard
						run={state.run}
						roomName={targetLabel}
						memoryModel={availability?.model}
						fastPathBlockedReasons={state.fastPathBlockedReasons}
						keepIds={keepIds}
						busy={state.runBusy === true}
						error={state.error}
						onToggleKeep={onToggleRunKeep}
						onToggleKeepTopic={onToggleRunKeepTopic}
						onRaiseBudget={onRaiseRunBudget}
						onEditEntry={onEditRunEntry}
						onChooseBeside={onChooseRunBeside}
						onMoveSorted={onMoveRunSorted}
						onApprove={onApproveRun}
						onCancel={onCancelRun}
						onBackToAssessment={onRunBackToAssessment}
						onResume={onResumeRun}
						onChooseModel={onChooseModel}
						onSignIn={onSignIn}
					/>
				) : state.step === "saved" && state.approvalResult && state.run ? (
					<div className="checkpoint-proposal-page checkpoint-saved-page absorb-saved-state">
						<div className="checkpoint-input-heading checkpoint-proposal-heading">
							<h2>{state.undo?.done ? "Undone." : absorbRunSavedHeadline({ ...state.approvalResult, sortedNotes: absorbRunSortedRows(state.run).length }, targetLabel)}</h2>
							<p>{state.undo?.done ? `${targetLabel}'s memory is as it was before this update.` : <>{absorbRunSavedSentence({ ...state.approvalResult, sortedNotes: absorbRunSortedRows(state.run).length, newTopics: state.approvalResult.newTopics ?? absorbRunNewTopics(state.run) })} Memory is {absorbRunFullPercent(state.run)}% full.</>}</p>
							{state.undo?.done && state.undo.limitLoweredTo !== undefined && <p>{LIMIT_LOWERED_ON_UNDO_SENTENCE(state.undo.limitLoweredTo)}</p>}
							{!state.undo?.done && state.approvalResult.budgetRaisedTo !== undefined && <p>{LIMIT_RAISED_ON_SAVE_SENTENCE}</p>}
							{!state.undo?.done && state.approvalResult.openConversationKeepsMemory && <p className="saved-open-conversation-line">{OPEN_CONVERSATION_KEEPS_MEMORY_SENTENCE}</p>}
							{!state.undo?.done && state.fastPathApplied && <p className="absorb-fast-path-note">This room applies memory updates automatically, so this update was saved without a second look.</p>}
						</div>
						{/* Saved without a second look, so the notice the card would have shown is shown here. */}
						{!state.undo?.done && state.fastPathApplied && absorbRunAllSummarized(state.run) && (
							<div className="memory-action-note absorb-run-summaries-note" role="status">
								<p>{absorbRunAllSummarizedSentence(availability?.model ? absorbRunOutageModelName(availability.model, availability.model) : "The Memory model")}</p>
								<div className="absorb-run-note-actions"><button className="rs-btn" onClick={onChooseModel}>{ABSORB_CHOOSE_MODEL_LABEL}</button></div>
							</div>
						)}
						{!state.undo?.done && <div className="absorb-review-strip">
							<div className="absorb-review-status"><span>Conversations</span><strong>{(state.approvalResult.foldedSessions?.length ?? 0)} of {state.run.progress.total}</strong></div>
							<div className="absorb-review-status"><span>Notes</span><strong>{absorbRunNotesChanged(state.run)} added or updated</strong></div>
							{(state.approvalResult.archivedEntries ?? 0) > 0 && <div className="absorb-review-status"><span>Archive</span><strong>{state.approvalResult.archivedEntries} {state.approvalResult.archivedEntries === 1 ? "note" : "notes"}</strong></div>}
							<div className="absorb-review-status"><span>Memory</span><strong>{absorbRunFullPercent(state.run)}% full</strong></div>
						</div>}
						{state.undo?.error && <div className="checkpoint-proposal-error" role="alert">{state.undo.error}</div>}
						{state.approvalResult.warnings.length > 0 && <div className="checkpoint-proposal-warnings">{state.approvalResult.warnings.map((warning) => <div key={warning}>{warning}</div>)}</div>}
						<div className="checkpoint-preview-actions">
							{!state.undo?.done && (absorbRunNotesChanged(state.run) > 0 || (state.approvalResult.archivedEntries ?? 0) > 0 || absorbRunSortedRows(state.run).length > 0) && <button className="rs-btn" disabled={state.undo?.busy} title={`Put ${targetLabel}'s memory back as it was before this update`} onClick={onUndo}>{state.undo?.busy ? "Undoing…" : "Undo"}</button>}
							<button className="rs-btn rs-btn-primary" onClick={onAbort}>{returnLabel}</button>
						</div>
					</div>
				) : state.step === "error" ? (
					<div className="checkpoint-proposal-page absorb-error-state">
						<div className="checkpoint-input-heading">
							<h2>Memorizing could not start</h2>
							<p>No memory was changed. You can open Maintain again right away.</p>
						</div>
						{state.error && <div className="checkpoint-proposal-error" role="alert">{state.error}</div>}
						{state.notice && <ModelNoticePanel notice={state.notice} onTryAgain={onRestart} onChooseModel={onChooseModel} onSignIn={(provider) => onSignIn(provider ?? "")} />}
						<div className="checkpoint-preview-actions">
							<button className="rs-btn" onClick={onAbort}>{returnLabel}</button>
							{!state.notice && <button className="rs-btn rs-btn-primary" onClick={onRestart}>Start Maintain again</button>}
						</div>
					</div>
				) : state.step === "discussing" && assessment ? (
					<div className="checkpoint-proposal-page absorb-discussion-page">
						<MaintenanceDiscussion
							assessmentMarkdown={assessment.assessmentMarkdown}
							aside={<AbsorbFirstReadSections fields={assessment.fields} compact />}
							notice={state.notice && <ModelNoticePanel notice={state.notice} onChooseModel={onChooseModel} onSignIn={(provider) => onSignIn(provider ?? "")} />}
							generateLabel="Continue →"
							backLabel="Back"
							messages={discussionMessages}
							budget={discussionBudget}
							warnings={state.discussionWarnings ?? null}
							error={state.error}
							sending={Boolean(state.discussionSending)}
							emptyHint={<DiscussFirstHint questions={assessment.fields.needsJudgment} />}
							placeholder="Your answer or instruction…"
							openContinue
							onSend={onSendDiscussionMessage}
							onBack={onBackToAssessment}
							onGenerate={onGenerateFromDiscussion}
							onDraftWithoutDiscussion={onDraftWithoutDiscussion}
						/>
					</div>
				) : assessment ? (
					<div className="checkpoint-proposal-page absorb-assessment-page">
						<div className="checkpoint-input-heading checkpoint-proposal-heading">
							<h2>{assessment.availability.recentContextEntryCount === 0 ? "What the notes waiting in Unsorted hold" : assessment.availability.recentContextEntryCount === 1 ? "What this conversation holds" : `What these ${assessment.availability.recentContextEntryCount} conversations hold`}</h2>
							{!unreachableRead && <p>{assessment.firstReadMissing ? FIRST_READ_MISSING_SENTENCE : "A first read."}</p>}
						</div>
						{state.error && <div className="checkpoint-proposal-error" role="alert">{state.error}</div>}
						{state.notice && <ModelNoticePanel notice={state.notice} onTryAgain={onReassess} onChooseModel={onChooseModel} onSignIn={(provider) => onSignIn(provider ?? "")} />}
						{state.activeRunConflictId && (
							<div className="memory-action-note absorb-run-conflict-note">
								<span>{ABSORB_RUN_ACTIVE_SENTENCE}</span>
								<button className="rs-btn" onClick={onStopAbandonedRun} title="Stop the update this room is still holding, then draft this one.">{ABSORB_RUN_ACTIVE_ACTION}</button>
							</div>
						)}
						{availability?.prepass?.demotionRequired && availability.budget && (() => {
							// A room already over its limit is told so before anything runs,
							// with the two other ways out of it: a higher limit, written at
							// once because it is the person's explicit choice, or a Review.
							const over = overLimitFirstRead({ reviewTargetTokens: availability.budget.reviewTargetTokens, budgetTokens: availability.budget.budgetTokens, entriesOverBudget: availability.prepass.entriesOverBudget });
							const raising = state.limitRaising === true;
							return (
								<div className="absorb-over-limit-block" role="status">
									<h3>{over.headline}</h3>
									<p>{over.sentence}</p>
									<div className="absorb-over-limit-actions">
										{over.raise && <button className="rs-btn" disabled={raising} onClick={() => onRaiseLimitBeforeRun(over.raise!.target)} title="Write this budget to Room settings now, then read the room again.">{raising ? "Raising…" : over.raise.label}</button>}
										<button className="rs-btn" disabled={raising} onClick={onReviewFirst} title="Leave this first read and open Review on the same room. Nothing is saved.">{over.reviewLabel}</button>
									</div>
								</div>
							);
						})()}
						{!assessment.firstReadMissing && (
							<div className="absorb-assessment-grid absorb-assessment-flow">
								<AbsorbFirstReadSections fields={assessment.fields} />
							</div>
						)}
						{assessment.firstReadMissing && (assessment.waitingConversations?.length ?? 0) > 0 && (
							<div className="absorb-run-change-groups absorb-first-read-waiting">
								{assessment.waitingConversations!.map((conversation, index) => (
									<div className="absorb-run-change-group absorb-run-conversation plain" key={`${conversation.date}-${conversation.title}-${index}`}>
										<span className="absorb-run-session-head">
											<strong>{conversation.title}</strong>
											{conversation.date && <span className="absorb-run-session-date">{fmtMemoryDay(conversation.date)}</span>}
										</span>
									</div>
								))}
							</div>
						)}
						{assessment.fields.needsJudgment.length > 0 && <p className="absorb-help-note">Answer these in Discuss first, and the update follows your answers. Continue lets the room decide on its own.</p>}
						<div className="checkpoint-preview-actions">
							<button className="rs-btn" onClick={onAbort}>Cancel</button>
							{!unreachableRead && <button className="rs-btn" onClick={onReassess} title={assessment.firstReadMissing ? "Read the conversations again. Nothing is saved." : "Read the conversations again, asking the model to fix what this read got wrong. Nothing is saved."}>Read again</button>}
							{assessment.firstReadMissing && assessment.firstReadMissing !== "skipped" && !unreachableRead && <button className="rs-btn" onClick={onChooseModel}>{ABSORB_CHOOSE_MODEL_LABEL}</button>}
							{/* A first read the client could not ask for has no source, so nothing to discuss. */}
							{assessment.source && !unreachableRead && <button className={`rs-btn${assessment.fields.needsJudgment.length > 0 ? " rs-btn-primary" : ""}`} onClick={onDiscuss} title="Answer the questions and give instructions first; the discussion is not saved to memory">Discuss first</button>}
							{!unreachableRead && <button className={`rs-btn${assessment.fields.needsJudgment.length > 0 ? "" : " rs-btn-primary"}`} onClick={onGenerate} title="Memorize the conversations and show what the room will keep">Continue →</button>}
						</div>
						{state.fastPathEnabled && <p className="checkpoint-footnote">{AUTOMATIC_APPLY_ON_SENTENCE} · a clean update is saved without a second look</p>}
					</div>
				) : null}
				</section>
			</main>
		</div>
	);
}

// Shared discussion surface for the Memorize and Review workflows,
// styled to mirror the in-room chat (user bubbles right, rendered markdown
// left) without coupling to the room components.
// Mirrors the server's request caps on the discussion routes
// (persistent-agent-fold.ts parse*DiscussionMessages): a transcript past these is
// rejected before any worker runs, so the composer shows where it stands
// instead of letting the user find the wall on send.
const DISCUSSION_MAX_MESSAGES = 40;
const DISCUSSION_MAX_TRANSCRIPT_CHARS = 80000;
const DISCUSSION_MAX_MESSAGE_CHARS = 12000;

function compactCount(value: number): string {
	return value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k` : String(value);
}

function MaintenanceDiscussion({ assessmentMarkdown, aside, outcome = "update", generateLabel = "Draft memory update", backLabel = "Back to assessment", messages, budget, warnings, error, notice, sending, emptyHint, placeholder, openContinue = false, onSend, onBack, onGenerate, onDraftWithoutDiscussion }: { assessmentMarkdown: string; aside?: ReactNode; outcome?: "update" | "tidy"; generateLabel?: string; backLabel?: string; messages: Array<{ role: string; content: string }>; budget: { state: string; canContinue: boolean } | null | undefined; warnings: string | null; error: string | null; notice?: ReactNode; sending: boolean; emptyHint: ReactNode; placeholder: string; openContinue?: boolean; onSend: (text: string) => void; onBack: () => void; onGenerate: () => void; onDraftWithoutDiscussion: () => void }) {
	const [input, setInput] = useState("");
	const transcriptRef = useRef<HTMLElement | null>(null);
	const composerRef = useRef<HTMLDivElement | null>(null);
	const transcriptChars = messages.reduce((total, message) => total + message.content.length, 0);
	const transcriptFull = messages.length >= DISCUSSION_MAX_MESSAGES || transcriptChars >= DISCUSSION_MAX_TRANSCRIPT_CHARS;
	const canContinue = (!budget || budget.canContinue) && !transcriptFull;
	const counterTone = transcriptFull ? " full" : messages.length >= DISCUSSION_MAX_MESSAGES * 0.75 || transcriptChars >= DISCUSSION_MAX_TRANSCRIPT_CHARS * 0.75 ? " near" : "";
	// With openContinue no count of messages shows: the limit says itself when it is reached.
	const counter = [
		!openContinue && `${messages.length} of ${DISCUSSION_MAX_MESSAGES} messages`,
		transcriptChars >= DISCUSSION_MAX_TRANSCRIPT_CHARS * 0.75 && `${compactCount(transcriptChars)} of ${compactCount(DISCUSSION_MAX_TRANSCRIPT_CHARS)} characters`,
		input.length >= DISCUSSION_MAX_MESSAGE_CHARS * 0.75 && `this message ${compactCount(input.length)} of ${compactCount(DISCUSSION_MAX_MESSAGE_CHARS)}`,
		transcriptFull && "limit reached: go on or go back",
	].filter(Boolean).join(" · ");
	// openContinue: Continue never waits for a message. With none it goes on from the first read alone; an answer
	// typed but not sent is sent first, and Continue goes on once its reply has landed (never after a refusal).
	const continueWaitsForMessage = !openContinue && messages.length === 0;
	const [continueAfterReply, setContinueAfterReply] = useState(false);
	useEffect(() => {
		const el = transcriptRef.current;
		if (!el) return;
		el.scrollTop = el.scrollHeight;
		// On a phone the first read sits above and the page scrolls as one, so a turn sent while reading its top would
		// land out of sight: bring the newest message up to just above the pinned composer.
		const composer = composerRef.current;
		if ((messages.length === 0 && !sending) || !composer) return;
		if (el.getBoundingClientRect().bottom > composer.getBoundingClientRect().top + 1) {
			el.style.scrollMarginBottom = `${composer.offsetHeight}px`;
			el.scrollIntoView({ block: "end" });
		}
	}, [messages.length, sending]);
	useEffect(() => {
		if (!continueAfterReply || sending) return;
		setContinueAfterReply(false);
		if (!error && !notice) onGenerate();
	}, [continueAfterReply, sending]);
	function send() {
		const text = input.trim();
		if (!text || !canContinue || sending) return;
		setInput("");
		onSend(text);
	}
	function goOn() {
		if (openContinue && input.trim() && canContinue) {
			setContinueAfterReply(true);
			send();
			return;
		}
		if (openContinue && messages.length === 0) onDraftWithoutDiscussion();
		else onGenerate();
	}
	const panel = (
		<div className="absorb-discussion-panel">
			{!aside && <div className="absorb-help-note">Temporary discussion. Discarded if you abort.</div>}
			{!aside && (
				<details className="absorb-candidate-disclosure absorb-detail-disclosure absorb-assessment-summary">
					<summary>Initial assessment</summary>
					<MarkdownPreview body={assessmentMarkdown} />
				</details>
			)}
			{budget?.state === "soft_warning" && <div className="checkpoint-proposal-warnings">This discussion is getting long. Continue to the update soon.</div>}
			{budget?.state === "hard_stop" && <div className="checkpoint-proposal-error" role="alert">This discussion has grown too long to carry on. Continue to the update with what you have agreed so far, or leave the discussion.</div>}
			{warnings && <div className="checkpoint-proposal-warnings">{warnings}</div>}
			{error && <div className="checkpoint-proposal-error" role="alert">{error}</div>}
			{notice}
			{(error || notice || !canContinue) && !sending && (
				// The way out that always exists: the draft from the assessment alone.
				// The discussion stays in memory, so it is still there behind
				// "Back to discussion" on the proposal screen.
				<div className="absorb-discussion-remedy">
					<span>{aside ? "You can still continue without this discussion." : "You can still draft from the assessment alone; this discussion is kept and stays available from the draft."}</span>
					<button className="rs-btn" onClick={onDraftWithoutDiscussion} title={aside ? "Continue from the first read alone, leaving this discussion out. Nothing is saved until you approve." : "Draft the memory update from the initial assessment, leaving this discussion out. Nothing is saved until you approve."}>{aside ? "Continue without the discussion" : "Draft without the discussion"}</button>
				</div>
			)}
			<section className="absorb-discussion-transcript" aria-label="Discussion transcript" ref={transcriptRef}>
				{messages.length === 0 && !sending ? <div className="absorb-discussion-empty">{emptyHint}</div> : <div className="absorb-discussion-messages">
					{messages.map((message, index) => (
						<div className={`absorb-discussion-message ${message.role}`} key={`${index}-${message.role}-${message.content.slice(0, 24)}`}>
							{message.role === "assistant" ? <MarkdownRenderer>{message.content}</MarkdownRenderer> : <p>{message.content}</p>}
						</div>
					))}
					{sending && <div className="absorb-discussion-message assistant pending" aria-live="polite"><span className="spinner" /> Thinking…</div>}
				</div>}
			</section>
			<div className="absorb-discussion-composer" ref={composerRef}>
				<div className="absorb-discussion-box">
					<textarea
						value={input}
						onChange={(e) => setInput(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								send();
							}
						}}
						placeholder={canContinue ? placeholder : "Discussion limit reached"}
						disabled={sending || !canContinue}
						maxLength={DISCUSSION_MAX_MESSAGE_CHARS}
						rows={2}
					/>
					<div className="absorb-discussion-box-bottom">
						<div className={`absorb-discussion-counter${counterTone}`} aria-live="polite">
							{aside ? (openContinue && sending ? "Continue waits for the reply. " : messages.length > 0 ? "When you are done, press Continue →. " : "Nothing here is saved; what you agree goes into the notes. ") : ""}
							{counter}
						</div>
						<button className="absorb-discussion-send" aria-label="Send" title={sending ? "Waiting for the reply…" : "Send"} disabled={!input.trim() || sending || !canContinue} onClick={send}>↑</button>
					</div>
				</div>
				<div className="absorb-discussion-actions">
					<button className="rs-btn" title="Return to the first read. This discussion is not saved anywhere; memory is unchanged." onClick={onBack}>{backLabel}</button>
					<button className="rs-btn rs-btn-primary absorb-discussion-generate" disabled={sending || continueWaitsForMessage} title={continueWaitsForMessage ? "Send at least one message first" : sending ? "Waiting for the reply…" : messages.length === 0 ? "Go on from the first read alone" : "Go on with what you said here"} onClick={goOn}>{generateLabel}</button>
				</div>
			</div>
		</div>
	);
	if (!aside) return panel;
	return (
		<div className="absorb-discussion-split">
			<aside className="absorb-discussion-aside" aria-label="The first read">
				<p className="absorb-discussion-aside-label">The first read, before this discussion. What you agree here goes into the {outcome}, not into this list.</p>
				{aside}
			</aside>
			{panel}
		</div>
	);
}

// Assessment bullets carry inline markdown (e.g. **must-keep** markers) —
// render it instead of showing raw asterisks.
function BulletList({ items }: { items: string[] }) {
	if (items.length === 0) return <p>None</p>;
	return <ul className="absorb-bullet-list">{items.map((item, index) => <li key={`${index}-${item}`}><MarkdownRenderer>{item}</MarkdownRenderer></li>)}</ul>;
}

/** Discuss first before its first message: the first read's open questions when it has any, else what the room can be told. */
function DiscussFirstHint({ questions }: { questions: string[] }) {
	if (questions.length === 0) return <p>Tell the room what to keep, let go or change.</p>;
	return (
		<>
			<p>The first read asks:</p>
			<BulletList items={questions.map(plainFirstReadLine)} />
			<p>Answer here, or tell the room what to keep, let go or change.</p>
		</>
	);
}

/** The first read, as the Memorize screens show it: on its own page and beside the discussion. */
function AbsorbFirstReadSections({ fields, compact = false }: { fields: AbsorbAssessmentResponse["fields"]; compact?: boolean }) {
	// The first read says what is worth keeping and what is not; where each
	// note lands is shown on the card, note by note, once the run has read the
	// conversations, so the model's rough filing plan is not shown twice.
	return (
		<>
			<AssessmentSection title="Worth remembering" items={fields.whatToRemember.map(plainFirstReadLine)} wide={!compact} />
			<AssessmentSection title="Can be let go" items={fields.whatToForget.map(plainFirstReadLine)} wide={!compact} />
			{fields.needsJudgment.length > 0 && <AssessmentSection title="Needs your call" items={fields.needsJudgment.map(plainFirstReadLine)} wide={!compact} />}
		</>
	);
}

function AssessmentSection({ title, items, wide = false }: { title: string; items: string[]; wide?: boolean }) {
	return (
		<section className={`absorb-assessment-section${wide ? " wide" : ""}`}>
			<h3>{title}</h3>
			<BulletList items={items} />
		</section>
	);
}

function MarkdownPreview({ body }: { body: string }) {
	const lines = body.split(/\r?\n/);
	const blocks: JSX.Element[] = [];
	let listItems: string[] = [];
	function flushList(key: string) {
		if (listItems.length === 0) return;
		blocks.push(<ul key={key}>{listItems.map((item, index) => <li key={`${index}-${item}`}>{renderInlineMarkdown(item)}</li>)}</ul>);
		listItems = [];
	}
	lines.forEach((line, index) => {
		const trimmed = line.trim();
		if (!trimmed) {
			flushList(`list-${index}`);
			return;
		}
		const listMatch = trimmed.match(/^[-*]\s+(.+)$/);
		if (listMatch) {
			listItems.push(listMatch[1]);
			return;
		}
		flushList(`list-${index}`);
		const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
		if (headingMatch) {
			const level = Math.min(headingMatch[1].length + 3, 6);
			const Heading = `h${level}` as keyof JSX.IntrinsicElements;
			blocks.push(<Heading key={index}>{headingMatch[2]}</Heading>);
			return;
		}
		blocks.push(<p key={index}>{renderInlineMarkdown(trimmed)}</p>);
	});
	flushList("list-final");
	return <div className="absorb-markdown-preview">{blocks.length ? blocks : <p>None</p>}</div>;
}

function renderInlineMarkdown(text: string) {
	const parts = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
	return parts.map((part, index) => part.startsWith("**") && part.endsWith("**") ? <strong key={index}>{part.slice(2, -2)}</strong> : <span key={index}>{part}</span>);
}

export { AbsorbWorkflowShell, MaintainChooserShell, MaintainConfirmDialog, ReviewWorkflowShell };
export type { MaintainConfirm };
