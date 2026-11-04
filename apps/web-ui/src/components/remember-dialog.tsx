import { useState, useEffect } from "react";
import { useEscapeKey } from "./use-escape-key";
import { confirmDialog } from "./confirm-dialog";
import { useRemoteClientContext } from "../remote-client-context";
import { MarkdownRenderer } from "./Markdown";
import { editorLimitLine } from "../memory-save-answer";
import { rememberPageFromParts, memoryTextHasWords, memoryTypedText, MEMORY_PAGE_MAX_CHARS } from "../../../web-server/src/memory-typed-text";
import { type ModelWait, type ModelNotice, modelWaitLine, ModelNoticePanel } from "./model-notice";
import { type RememberReadEstimate, fetchRememberReadEstimate, rememberFillsRoomHeadsUp, rememberProgressSentence, recentSessionsHeadsUp, rememberRefusedWholeSentence, rememberEstimateSentence, isRememberOutcome, REMEMBER_DAMAGED_SENTENCE } from "../remember-read";
import { editableMemoryBody, storedMemoryBody, plainMemoryText } from "../memory-v2-copy";
import type { CheckpointProposalResponse, CheckpointApprovalResponse } from "../types";
import { ChevronDownIcon } from "./icons";
import type { PersistentChatConfig } from "../room-thread-items";
import { CHECKPOINT_DENSITY_OPTIONS, CHECKPOINT_REMEMBER_MAX_CHARS, type CheckpointDensity } from "../maintain-workflow-state";
import { roomFilledBy } from "../maintenance-errors";

/** Why Remember waits while the room answers; the model switch window says the same. */
export const REMEMBER_WAIT_SENTENCE = "Stop or wait for the current response before remembering";

type CheckpointApprovalEditFields = { sessionArc: string; body: string; parked: string };

/** The editor's fields for a proposal, as the Memory model wrote them. */
function sameCheckpointFields(a: CheckpointApprovalEditFields, b: CheckpointApprovalEditFields): boolean {
	return a.sessionArc === b.sessionArc && a.body === b.body && a.parked === b.parked;
}

function checkpointFieldsOf(proposal: CheckpointProposalResponse): CheckpointApprovalEditFields {
	return {
		sessionArc: proposal.fields.sessionArc,
		// The editor shows a line's must-keep marker as "Keep:"; the save gives it back.
		body: editableMemoryBody(proposal.fields.body),
		// Nothing open shows as an empty field; an empty one saves as None.
		parked: /^none\.?$/i.test(proposal.fields.parked?.trim() ?? "") ? "" : proposal.fields.parked?.trim() ?? "",
	};
}

/** Which proposal a set of edits belongs to: edits outlive the dialog, never their proposal. */
function checkpointEditsKey(proposal: CheckpointProposalResponse): string {
	return `${proposal.agentId}\n${proposal.conversationId}\n${proposal.proposedRecentContext}`;
}

function CheckpointPreviewShell({ chat, itemCount, rememberText, density, proposal, loading, progress, onCancelGenerate, error, notice, onChooseModel, onSignIn, approvalLoading, approvalError, approvalResult, quickRequested, skipsPreview, quickBlockedReasons, consultRunning, taskRunning, pendingConsultHandoffCount, pendingTaskHandoffCount, approvedFields, onFieldsChange, onRememberTextChange, onDensityChange, onGenerate, onApprove, onDiscard, onContinueAfterCheckpoint, onRestAfterCheckpoint, onMemorizeAfterCheckpoint, onClose }: { chat: NonNullable<PersistentChatConfig>; itemCount: number; rememberText: string; density: CheckpointDensity; proposal: CheckpointProposalResponse | null; loading: boolean; progress: { read: number; of: number; wait?: ModelWait } | null; onCancelGenerate: () => void; error: string | null; notice: ModelNotice | null; onChooseModel: () => void; onSignIn: (provider: string | undefined) => void; approvalLoading: boolean; approvalError: string | null; approvalResult: CheckpointApprovalResponse | null; quickRequested: boolean; skipsPreview: boolean; quickBlockedReasons: string[] | null; consultRunning: boolean; taskRunning: boolean; pendingConsultHandoffCount: number; pendingTaskHandoffCount: number; approvedFields: CheckpointApprovalEditFields; onFieldsChange: (fields: CheckpointApprovalEditFields) => void; onRememberTextChange: (text: string) => void; onDensityChange: (density: CheckpointDensity) => void; onGenerate: () => void; onApprove: (approvedFields: CheckpointApprovalEditFields) => void; onDiscard: () => void; onContinueAfterCheckpoint: () => void; onRestAfterCheckpoint: () => void; onMemorizeAfterCheckpoint: () => void; onClose: () => void }) {
	const roomFilled = roomFilledBy(approvalResult);
	const [editing, setEditing] = useState(false);
	// A read-only device may not send Cancel, Save or Discard: it closes the dialog, and the Remember goes on.
	const readOnly = useRemoteClientContext().capability === "read-only";
	// One pass or N parts, said before anything is generated. Asked once when
	// the dialog opens; a failed estimate just leaves the line out.
	const [readEstimate, setReadEstimate] = useState<RememberReadEstimate | null>(null);
	// Saving moves the room to the fresh, empty conversation it creates, which has nothing to estimate.
	const saving = approvalLoading || !!approvalResult;
	useEffect(() => {
		if (saving) return;
		let cancelled = false;
		setReadEstimate(null);
		fetchRememberReadEstimate(chat.agentId, chat.conversationId).then((estimate) => { if (!cancelled) setReadEstimate(estimate); }, () => {});
		return () => { cancelled = true; };
	}, [chat.agentId, chat.conversationId, saving]);
	// While the proposal generates, Escape does not close the dialog: Cancel
	// does, and says what it does. Closing would leave a paid request running.
	useEscapeKey(() => {
		if (editing) setEditing(false);
		else onClose();
	}, !approvalLoading && !loading);
	useEffect(() => {
		setEditing(false);
	}, [proposal]);
	// What Save sends: the parts, with the editor's "Keep:" given back as the marker.
	const savedFields = proposal ? { ...approvedFields, body: storedMemoryBody(approvedFields.body, proposal.fields.body) } : approvedFields;
	// Counted as the server counts the page it builds from these parts (L2).
	const pageLength = proposal ? rememberPageFromParts(proposal.proposedRecentContext.split(/\r?\n/, 1)[0] ?? "", savedFields).length : 0;
	const keepsWords = memoryTextHasWords(memoryTypedText(savedFields.body));
	const pageLimit = editorLimitLine(pageLength, MEMORY_PAGE_MAX_CHARS, keepsWords);
	// Before Save: the room's count after this save, when it nears the cap (the proposal counts before it).
	const fillsHeadsUp = proposal ? rememberFillsRoomHeadsUp(proposal.compressionTelemetry?.recentContextEntryCount, chat.displayName) : null;
	const quickSaves = quickRequested && skipsPreview;
	// Save needs only what to keep, within the page's limit; when it cannot save, one line says what to do.
	const approvalReady = pageLimit.canSave;
	const approvalBlockedLine = !proposal ? null : !keepsWords ? (proposal.fields.body.trim() ? "Write what to keep before saving." : "The Memory model returned nothing to keep. Generate again, or Edit to write it.") : pageLimit.line;
	// A line that asks to Generate again comes with the button for it.
	const asksGenerateAgain = (line: string | null | undefined) => Boolean(line && /\bGenerate again\b/.test(line));
	const generateAgain = !readOnly && (asksGenerateAgain(approvalError) || asksGenerateAgain(approvalBlockedLine));
	// A conversation that changed after Remember read it cannot be saved as read: Generate again leads, Save goes.
	// A Save lost on the way keeps Save first: saving again finds it saved.
	const mustGenerateAgain = generateAgain && /changed after Remember read it|The Memory model changed after this entry was written/.test(approvalError ?? "");
	// Nothing here can be saved, so an editor left open closes; the edits stay on the entry, and Generate again asks before it replaces them.
	useEffect(() => {
		if (mustGenerateAgain) setEditing(false);
	}, [mustGenerateAgain]);
	function updateApprovedField(field: keyof CheckpointApprovalEditFields, value: string) {
		onFieldsChange({ ...approvedFields, [field]: value });
	}
	async function confirmDiscard() {
		const ok = await confirmDialog({
			title: "Discard this memory proposal?",
			body: "It has not been saved. If you discard it, you go back to the conversation and the proposal is lost.",
			confirmLabel: "Discard",
			danger: true,
		});
		if (ok) onDiscard();
	}
	// Consult MR-5 checkpoint-time honesty (§2.3): one-line notices, NOT gates —
	// they never block the checkpoint, they just tell the truth about consults.
	const consultHonestyNotices: string[] = [];
	if (consultRunning) consultHonestyNotices.push("A consult is still running; remembering will discard it.");
	// Task parity (visuals V6): unlike a discarded consult, a task's files persist —
	// the honest copy says what is and is not lost. The consult line below is the
	// §2.3 locked verbatim string; the queue holds both block kinds, so each kind
	// gets its own line.
	if (taskRunning) consultHonestyNotices.push("A specialist task is still running; its result won't be part of what you remember (artifacts already written stay on disk).");
	if (pendingConsultHandoffCount > 0) consultHonestyNotices.push("A transferred consult hasn't entered memory yet. Send a message before you save, so it is part of this conversation.");
	if (pendingTaskHandoffCount > 0) consultHonestyNotices.push("A transferred task result hasn't entered memory yet. Send a message before you save, so it is part of this conversation.");
	const honestyNoticesNode = consultHonestyNotices.length > 0 ? (
		<div className="checkpoint-consult-notices" role="status">
			{consultHonestyNotices.map((notice) => <div key={notice}>{notice}</div>)}
		</div>
	) : null;
	return (
		<div className="checkpoint-preview-backdrop" role="dialog" aria-modal="true" aria-label="Remember this conversation">
			<section className={`checkpoint-input-card${proposal && !loading && !approvalResult ? " checkpoint-review-card" : ""}`}>
				{loading ? (
					<div className="checkpoint-generating-state">
						<span className="spinner" />
						<p className="card-kicker">Remember</p>
						{/* Remember without the preview saves when the read ends: it says so from the start (decision 39). */}
						<h2>{quickSaves ? "Saving memory…" : "Remembering…"}</h2>
						<p>{quickSaves ? `Saving to ${chat.displayName}’s memory…` : `${rememberProgressSentence(progress)} Nothing is saved yet.`}</p>
						{progress?.wait && <p className="checkpoint-read-note" role="status">{modelWaitLine(progress.wait)}</p>}
						<div className="checkpoint-preview-actions">
							{readOnly ? <button className="rs-btn" onClick={onClose}>Close</button> : <button className="rs-btn" onClick={onCancelGenerate}>Cancel</button>}
						</div>
					</div>
				) : quickRequested && !quickBlockedReasons?.length && approvalLoading && !approvalResult ? (
					<div className="checkpoint-generating-state">
						<span className="spinner" />
						<p className="card-kicker">Remember</p>
						<h2>Saving memory…</h2>
						<p>Saving to {chat.displayName}’s memory…</p>
					</div>
				) : approvalResult ? (
					<div className="checkpoint-proposal-page checkpoint-saved-page">
						<div className="checkpoint-input-heading">
							<p className="card-kicker">Remembered</p>
							<h2>Memory updated</h2>
							<p>{roomFilled ? recentSessionsHeadsUp(approvalResult.recentContextEntryCount, chat.displayName) : (proposal && rememberRefusedWholeSentence(proposal)) || `This conversation is now part of ${chat.displayName}’s memory. Keep chatting starts a new conversation that knows it.`}</p>
						</div>
						{!roomFilled && !fillsHeadsUp && recentSessionsHeadsUp(approvalResult.recentContextEntryCount) && <div className="checkpoint-proposal-warnings checkpoint-sessions-headsup" role="status">{recentSessionsHeadsUp(approvalResult.recentContextEntryCount)}</div>}
						{approvalResult.warnings.length > 0 && <div className="checkpoint-proposal-warnings">{approvalResult.warnings.map((warning) => <div key={warning}>{warning}</div>)}</div>}
						{/* A full room has no Keep chatting: its next conversation waits for Memorize. */}
						<div className="checkpoint-preview-actions">
							{!roomFilled && <button className="rs-btn rs-btn-primary" onClick={onContinueAfterCheckpoint} title="Stay in this room with a new conversation">Keep chatting</button>}
							<button className="rs-btn" onClick={onRestAfterCheckpoint}>Return Home</button>
							{roomFilled && <button className="rs-btn rs-btn-primary" onClick={onMemorizeAfterCheckpoint}>Memorize</button>}
						</div>
					</div>
				) : proposal ? (
					<div className="checkpoint-proposal-page">
						<div className="checkpoint-input-heading checkpoint-proposal-heading">
							<p className="card-kicker">Memory proposal · not saved</p>
							<h2>Review what {chat.displayName} will remember</h2>
						</div>
						<div className="checkpoint-proposal-result standalone">
							{editing ? (
								<div className="checkpoint-edit-field checkpoint-structured-editor">
									<span className="checkpoint-field-label">Edit the entry before saving</span>
									<label>
										<span>What happened</span>
										<textarea value={approvedFields.sessionArc} onChange={(e) => updateApprovedField("sessionArc", e.target.value)} rows={4} />
									</label>
									<label>
										<span>What to keep</span>
										<textarea value={approvedFields.body} onChange={(e) => updateApprovedField("body", e.target.value)} rows={14} />
									</label>
									<label>
										<span>Still open</span>
										<textarea value={approvedFields.parked} onChange={(e) => updateApprovedField("parked", e.target.value)} rows={5} />
									</label>
									<button className="rs-btn" onClick={() => setEditing(false)}>Done editing</button>
								</div>
							) : (
								// The whole entry that will be saved, under the editor's section names; a part the model left empty is left out.
								<div className="checkpoint-proposal-summary checkpoint-whole-entry">
									{proposal.fields.title.trim() && <h3 className="checkpoint-entry-title">{plainMemoryText(proposal.fields.title.trim())}</h3>}
									{approvedFields.sessionArc.trim() && (
										<section>
											<h4>What happened</h4>
											<MarkdownRenderer>{plainMemoryText(approvedFields.sessionArc.trim())}</MarkdownRenderer>
										</section>
									)}
									{approvedFields.body.trim() && (
										<section>
											<h4>What to keep</h4>
											<MarkdownRenderer>{plainMemoryText(storedMemoryBody(approvedFields.body, proposal.fields.body).trim())}</MarkdownRenderer>
										</section>
									)}
									{approvedFields.parked.trim() && !/^none\.?$/i.test(approvedFields.parked.trim()) && (
										<section>
											<h4>Still open</h4>
											<MarkdownRenderer>{plainMemoryText(approvedFields.parked.trim())}</MarkdownRenderer>
										</section>
									)}
								</div>
							)}
						</div>
						{honestyNoticesNode}
						{approvalError && <div className="checkpoint-proposal-error" role="alert">{approvalError}</div>}
						{fillsHeadsUp && <div className="checkpoint-proposal-warnings checkpoint-sessions-headsup" role="status">{fillsHeadsUp}</div>}
						<div className="checkpoint-preview-actions">
							{!readOnly && approvalBlockedLine && <span className="proposal-approve-blocked-reason" role="status">{approvalBlockedLine}</span>}
							{readOnly ? <button className="rs-btn" onClick={onClose}>Close</button> : !mustGenerateAgain && <button className="rs-btn rs-btn-primary" disabled={approvalLoading || !approvalReady} onClick={() => onApprove(savedFields)}>{approvalLoading ? "Saving…" : "Save to memory"}</button>}
							{generateAgain && <button className={mustGenerateAgain ? "rs-btn rs-btn-primary" : "rs-btn"} disabled={approvalLoading} onClick={onGenerate}>Generate again</button>}
							{!readOnly && !editing && !mustGenerateAgain && <button className="rs-btn" disabled={approvalLoading} onClick={() => setEditing(true)} title="Edit the entry before saving">Edit</button>}
							{!readOnly && <button className="rs-btn" disabled={approvalLoading} onClick={() => void confirmDiscard()} title="Throw away this draft. Nothing is saved">Discard</button>}
						</div>
					</div>
				) : notice ? (
					// One notice with its ways out: the options form gives way to it.
					<>
						<div className="checkpoint-input-heading">
							<p className="card-kicker">Remember</p>
						</div>
						<ModelNoticePanel notice={notice} onTryAgain={itemCount === 0 ? undefined : onGenerate} onChooseModel={onChooseModel} onSignIn={onSignIn} onClose={onClose} />
					</>
				) : (
					<>
						<div className="checkpoint-input-heading">
							<p className="card-kicker">Remember</p>
							<h2>What should carry forward?</h2>
							<p>Choose how much to keep, and add anything specific you want this room to remember from this conversation.</p>
						</div>
						<div className="checkpoint-density-group" aria-label="How much should this room keep?">
							<div className="checkpoint-field-label">How much should this room keep?</div>
							<div className="checkpoint-density-options">
								{CHECKPOINT_DENSITY_OPTIONS.map((option) => (
									<button key={option.id} className={`checkpoint-density-option ${density === option.id ? "selected" : ""}`} onClick={() => onDensityChange(option.id)}>
										<strong>{option.label}</strong>
										<span>{option.budget}</span>
									</button>
								))}
							</div>
						</div>
						<label className="checkpoint-remember-field">
							<div className="checkpoint-field-row">
								<span className="checkpoint-field-label">What do you want to remember?</span>
								<em>{rememberText.length}/{CHECKPOINT_REMEMBER_MAX_CHARS}</em>
							</div>
							<textarea
								value={rememberText}
								maxLength={CHECKPOINT_REMEMBER_MAX_CHARS}
								onChange={(e) => onRememberTextChange(e.target.value.slice(0, CHECKPOINT_REMEMBER_MAX_CHARS))}
								placeholder="Optional. Add the key nuance, decision, or detail that should not be lost."
								rows={4}
							/>
						</label>
						{readEstimate && rememberEstimateSentence(readEstimate) && <p className="checkpoint-read-note">{rememberEstimateSentence(readEstimate)}</p>}
						{error && (isRememberOutcome(error) ? <p className="checkpoint-read-note" role="status">{error}</p> : <div className="checkpoint-proposal-error" role="alert">{error}</div>)}
						{honestyNoticesNode}
						<div className="checkpoint-preview-actions">
							<button className="rs-btn" onClick={onClose}>Close</button>
							{/* A Remember that did not finish can be let go without a new read. */}
							{!readOnly && asksGenerateAgain(error) && <button className="rs-btn" onClick={onDiscard} title="Let this Remember go. Nothing is saved">Discard</button>}
							{/* A damaged memory file meets every generate the same way: Close is the way out. */}
							{error !== REMEMBER_DAMAGED_SENTENCE && <button className="rs-btn rs-btn-primary" disabled={itemCount === 0} onClick={onGenerate}>{asksGenerateAgain(error) ? "Generate again" : "Generate memory proposal"}</button>}
						</div>
					</>
				)}
			</section>
		</div>
	);
}

const CHOOSE_WHAT_TO_KEEP = "Choose what to keep…";

// The main half runs Remember; the arrow opens the options form straight away.
// Both halves are off together, while Remember runs and before any message, and say why.
function CheckpointSplitButton({ hasUserInput, inFlight, skipsPreview, onQuickCheckpoint, onOpenFullCheckpoint }: { hasUserInput: boolean; inFlight: boolean; skipsPreview: boolean; onQuickCheckpoint: () => void; onOpenFullCheckpoint: () => void }) {
	const offReason = inFlight ? REMEMBER_WAIT_SENTENCE : hasUserInput ? null : "Send a message before remembering";
	const checkpointTitle = offReason ?? (skipsPreview ? "Saves without the preview unless something needs your review" : "Proposes what to remember from this conversation, for you to review");
	return (
		<div className="checkpoint-split">
			<button className="icon-btn checkpoint-split-main" title={checkpointTitle} disabled={offReason !== null} onClick={onQuickCheckpoint}>Remember</button>
			<button className="icon-btn checkpoint-split-toggle" title={offReason ?? CHOOSE_WHAT_TO_KEEP} aria-label={CHOOSE_WHAT_TO_KEEP} disabled={offReason !== null} onClick={onOpenFullCheckpoint}><ChevronDownIcon /></button>
		</div>
	);
}

export { CheckpointPreviewShell, CheckpointSplitButton, checkpointEditsKey, checkpointFieldsOf, sameCheckpointFields };
export type { CheckpointApprovalEditFields };
