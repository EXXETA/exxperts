/**
 * The Review screens a person reads: a first read of what the notes need with
 * the depth to tidy at, the working screen while the tidy runs, the card that
 * shows every change before it is saved, and the saved screen with Undo. The
 * engine's vocabulary (areas, operations, tokens, passes) never reaches these
 * screens: the copy speaks of topics, notes, the archive, and how full memory
 * is.
 */
import { useState } from "react";
import type { ArchiveRow, ReviewAssessmentFields, ReviewAvailability, ReviewDepth, ReviewRun } from "../types";
import { MarkdownRenderer } from "./Markdown";
import { ArchiveSection, NoteEditor } from "./absorb-run-screen";
import { meaningfulMaintenanceWarnings } from "../maintenance-warnings";
import {
	archivedDuplicateReason,
	archiveReasonLabel,
	automaticApplyNeedsReviewSentence,
	entryFirstLine,
	isEntryIdMigrationNotice,
	LIMIT_LOWERED_ON_UNDO_SENTENCE,
	LIMIT_RAISED_ON_SAVE_SENTENCE,
	memoryFullPercent,
	REVIEW_DEPTH_ORDER,
	REVIEW_DEPTH_ROWS,
	reviewCardHeadline,
	reviewCardSentence,
	reviewChangeCounts,
	reviewChangeKindLabel,
	reviewDepthSentence,
	rememberedMeanwhileSentence,
	reviewRunFullPercent,
	reviewRunGuidanceSummary,
	reviewRunProgressLine,
	reviewSavedArchiveSentence,
	reviewSavedHeadline,
	reviewSavedSentence,
	reviewTopicFoldedLine,
	reviewTopicGroupSummary,
	reviewTopicName,
	topicLabel,
	type ReviewChange,
	type ReviewChangeCounts,
} from "../memory-v2-copy";

function Bullets({ items }: { items: string[] }) {
	if (items.length === 0) return <p>None</p>;
	return <ul className="absorb-bullet-list">{items.map((item, index) => <li key={`${index}-${item}`}><MarkdownRenderer>{item}</MarkdownRenderer></li>)}</ul>;
}

function ReadSection({ title, items, wide }: { title: string; items: string[]; wide: boolean }) {
	return (
		<section className={`absorb-assessment-section${wide ? " wide" : ""}`}>
			<h3>{title}</h3>
			<Bullets items={items} />
		</section>
	);
}

/**
 * The first read: what could be shorter, what looks stale, what says the same
 * twice, which topics look like one, and what the room cannot decide alone.
 * The two machine-found lists are absent on an older server, and absent reads
 * as empty.
 */
export function ReviewFirstReadSections({ fields, compact = false }: { fields: ReviewAssessmentFields; compact?: boolean }) {
	const saysTheSameTwice = fields.saysTheSameTwice ?? [];
	const disagree = fields.disagree ?? [];
	const topicsThatLookTheSame = fields.topicsThatLookTheSame ?? [];
	return (
		<>
			<ReadSection title="Could be shorter" items={fields.couldBeShorter} wide={!compact} />
			<ReadSection title="Looks stale or contradicts itself" items={fields.staleOrContradicts} wide={!compact} />
			{saysTheSameTwice.length > 0 && <ReadSection title="Says the same twice" items={saysTheSameTwice} wide={!compact} />}
			{disagree.length > 0 && <ReadSection title="Disagrees with itself" items={disagree} wide={!compact} />}
			{topicsThatLookTheSame.length > 0 && <ReadSection title="Topics that look the same" items={topicsThatLookTheSame} wide={!compact} />}
			{fields.needsYourCall.length > 0 && <ReadSection title="Needs your call" items={fields.needsYourCall} wide={!compact} />}
		</>
	);
}

/** How much to tidy: two rows in the chooser's shape, one of them the room's own recommendation. */
export function ReviewDepthPicker({ availability, staleFlagged, chosen, onChoose }: { availability: ReviewAvailability; staleFlagged: boolean; chosen: ReviewDepth; onChoose: (depth: ReviewDepth) => void }) {
	const sentence = reviewDepthSentence({
		overBudget: availability.overBudget,
		staleFlagged,
		budgetTokens: availability.budgetTokens,
		reviewTargetTokens: availability.reviewTargetTokens,
	});
	return (
		<section className="absorb-assessment-section wide review-depth-section">
			<h3>How much to tidy</h3>
			<p>{sentence}</p>
			<div role="radiogroup" aria-label="How much to tidy" className="maintain-actions review-depth-picker">
				{REVIEW_DEPTH_ORDER.map((depth) => {
					const row = REVIEW_DEPTH_ROWS[depth];
					const recommended = depth === availability.recommendedDepth;
					const selected = depth === chosen;
					return (
						<button key={depth} type="button" role="radio" aria-checked={selected} className={`maintain-action review-depth-option${recommended ? " recommended" : ""}${selected ? " selected" : ""}`} onClick={() => onChoose(depth)}>
							<span className="maintain-action-body">
								<span className="maintain-action-head">
									<span className="maintain-action-title">{row.title}</span>
									{recommended && <span className="maintain-action-tag">Recommended</span>}
								</span>
								<span className="maintain-action-text">{row.text}</span>
							</span>
							<span className="maintain-action-go review-depth-check" aria-hidden="true">{selected ? "✓" : ""}</span>
						</button>
					);
				})}
			</div>
		</section>
	);
}

/** While the tidy works: the one progress line, the topics it is walking, and one way out. */
export function ReviewRunProgressScreen({ run, onCancel }: { run: ReviewRun; onCancel: () => void }) {
	const touched = new Set(run.changes.map((change) => change.topic));
	return (
		<div className="checkpoint-generating-state absorb-loading-state absorb-run-progress review-run-progress">
			<h2>{reviewRunProgressLine(run)}</h2>
			<span className="spinner spinner-lg" />
			<p>The notes are tidied topic by topic. Every note keeps its date and anything you pinned. Nothing is saved until you approve.</p>
			{run.topics.length > 0 && (
				<ul className="absorb-run-sessions review-run-topics">
					{run.topics.map((topic) => (
						<li className={`absorb-run-session ${touched.has(topic) ? "folded" : "pending"}`} key={topic}>
							<div className="absorb-run-session-head"><strong>{topicLabel(topic)}</strong></div>
							<span className="absorb-run-session-state">{touched.has(topic) ? "Tidied" : "Waiting"}</span>
						</li>
					))}
				</ul>
			)}
			<div className="checkpoint-preview-actions">
				<button className="landing-action secondary" onClick={onCancel} title="Stop this tidy and return to the first read. Nothing is saved.">Cancel</button>
			</div>
		</div>
	);
}

/** The reason an archived note carries, in the person's words. */
function archiveReasonWord(why: string | undefined): string {
	if (!why) return "no longer needed";
	return archiveReasonLabel(why as "budget" | "superseded" | "done" | "user" | "stale" | "duplicate");
}

function ChangeRow({ change, busy, onEditEntry }: { change: ReviewChange; busy: boolean; onEditEntry?: (entryId: string, text: string) => Promise<void> }) {
	const [editing, setEditing] = useState(false);
	const [saving, setSaving] = useState(false);
	const [editError, setEditError] = useState<string | null>(null);
	const label = reviewChangeKindLabel(change.kind);
	const editable = Boolean(onEditEntry) && (change.kind === "shortened" || change.kind === "merged");
	async function save(text: string): Promise<void> {
		if (!onEditEntry) return;
		setSaving(true);
		setEditError(null);
		try {
			await onEditEntry(change.id, text);
			setEditing(false);
		} catch (e) {
			setEditError((e as Error).message);
		} finally {
			setSaving(false);
		}
	}
	if (change.kind === "shortened" || change.kind === "merged") {
		return (
			<div className={`absorb-run-change review-change review-change-${change.kind}`}>
				<div className="absorb-run-change-diff">
					<div className="absorb-run-change-side">
						<span className="absorb-run-change-side-label">Before</span>
						<MarkdownRenderer>{change.before || "Not recorded."}</MarkdownRenderer>
					</div>
					<div className="absorb-run-change-side">
						<span className="absorb-run-change-side-label">After</span>
						{editing
							? <NoteEditor text={change.after ?? ""} busy={saving} onSave={(text) => void save(text)} onCancel={() => { setEditing(false); setEditError(null); }} />
							: <MarkdownRenderer>{change.after || "Not recorded."}</MarkdownRenderer>}
						{editable && !editing && <button type="button" className="rs-quiet absorb-run-change-edit" disabled={busy} onClick={() => setEditing(true)}>Edit</button>}
						{editError && <p className="checkpoint-proposal-error" role="alert">{editError}</p>}
					</div>
				</div>
				{change.kind === "merged" && (change.mergedFrom?.length ?? 0) > 1 && (
					<p className="review-change-note">{change.mergedFrom!.length} notes became this one.</p>
				)}
				{change.kind === "merged" && change.reason && (
					<p className="review-change-note review-change-reason-line">{change.reason}</p>
				)}
			</div>
		);
	}
	if (change.kind === "archived" || change.kind === "closed") {
		return (
			<div className={`absorb-run-change review-change review-change-${change.kind}`}>
				<span className="absorb-run-change-label">{label}</span>
				<span className="review-change-reason">{change.duplicateOf ? archivedDuplicateReason(change.duplicateOf.topic) : archiveReasonWord(change.why)}</span>
				<div className="absorb-run-change-text review-change-leaving"><MarkdownRenderer>{change.before || "Not recorded."}</MarkdownRenderer></div>
			</div>
		);
	}
	if (change.kind === "moved") {
		return (
			<div className="absorb-run-change compact review-change review-change-moved">
				<span className="absorb-run-change-label">{label}</span>
				<span className="absorb-run-change-line">moved from {topicLabel(change.before || "its topic")} to {topicLabel(change.after || "another topic")}</span>
			</div>
		);
	}
	if (change.kind === "topic_folded") {
		return (
			<div className="absorb-run-change compact review-change review-change-topic-folded">
				<span className="absorb-run-change-label">{label}</span>
				<span className="absorb-run-change-line">{reviewTopicFoldedLine(change)}</span>
			</div>
		);
	}
	return (
		<div className="absorb-run-change compact review-change review-change-pinned">
			<span className="absorb-run-change-label">{label}</span>
			<span className="absorb-run-change-line">{entryFirstLine(change.after || change.before || "")}</span>
		</div>
	);
}

/** The changes of one topic, closed until the person opens it. */
function TopicChangeGroup({ topic, changes, busy, onEditEntry }: { topic: string; changes: ReviewChange[]; busy: boolean; onEditEntry?: (entryId: string, text: string) => Promise<void> }) {
	return (
		<details className="absorb-run-change-group absorb-run-conversation review-topic-group">
			<summary>
				<span className="absorb-run-session-head"><strong>{topicLabel(topic)}</strong></span>
				<span className="absorb-run-session-state">{reviewTopicGroupSummary(topic, changes).slice(topicLabel(topic).length + 3)}</span>
			</summary>
			<div className="absorb-run-conversation-body">
				{changes.map((change, index) => <ChangeRow key={`${change.id}-${index}`} change={change} busy={busy} onEditEntry={onEditEntry} />)}
			</div>
		</details>
	);
}

/** Section first, then topic in the order the changes arrive, so the card reads like the memory does. */
function groupChangesByTopic(changes: ReviewChange[]): { key: string; topic: string; changes: ReviewChange[] }[] {
	const groups = new Map<string, { key: string; topic: string; changes: ReviewChange[] }>();
	for (const change of changes) {
		const key = `${change.section} ${change.topic}`;
		let group = groups.get(key);
		if (!group) {
			group = { key, topic: reviewTopicName(change), changes: [] };
			groups.set(key, group);
		}
		group.changes.push(change);
	}
	return [...groups.values()];
}

function GuidanceBlock({ title, items }: { title: string; items: string[] }) {
	if (items.length === 0) return null;
	return (
		<div className="absorb-run-guidance-block">
			<strong>{title}</strong>
			<ul>{items.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul>
		</div>
	);
}

/**
 * The card: every change this tidy makes, what would leave for the archive, and
 * where that leaves the limit. Save is the only thing on this screen that writes.
 */
export function ReviewCard({ run, roomName, keepIds, busy, error, fastPathBlockedReasons, onToggleKeep, onToggleKeepTopic, onRaiseBudget, onEditEntry, onCancel, onBack, backLabel, onSave }: {
	run: ReviewRun;
	roomName: string;
	/** The keep set as the person left it: the card answers a toggle before the server does. */
	keepIds: string[];
	busy: boolean;
	error: string | null;
	fastPathBlockedReasons?: string[];
	onToggleKeep: (entryIds: string[], next: boolean) => void;
	onToggleKeepTopic: (section: ArchiveRow["section"], topic: string, next: boolean) => void;
	onRaiseBudget: (budgetTokens: number) => void;
	/** The person's words for a note this tidy rewrote; resolves with the run refreshed. */
	onEditEntry?: (entryId: string, text: string) => Promise<void>;
	onCancel: () => void;
	onBack: () => void;
	backLabel: string;
	onSave: () => void;
}) {
	// Giving notes their ids is bookkeeping a person never needs to weigh, so
	// the server's note about it is not shown on the card at all.
	const warnings = meaningfulMaintenanceWarnings(run.warnings.filter((warning) => !isEntryIdMigrationNotice(warning)));
	const counts = reviewChangeCounts(run.changes);
	const groups = groupChangesByTopic(run.changes);
	const guidance = reviewRunGuidanceSummary(run);
	const overBudget = run.demotion.overageTokens > 0;
	const fullPercent = reviewRunFullPercent(run);
	const leftAsIsTopics = run.leftAsIs.reduce((sum, group) => sum + group.topics.length, 0);
	return (
		<div className="checkpoint-proposal-page absorb-proposal-page absorb-run-card review-card">
			<div className="checkpoint-input-heading checkpoint-proposal-heading">
				<h2>{reviewCardHeadline(counts)}</h2>
				<p>{reviewCardSentence(counts, fullPercent, run.budget.overBudgetAfter)}</p>
			</div>
			<div className="absorb-review-strip">
				<div className="absorb-review-status"><span>Topics</span><strong>{counts.topics} tidied</strong></div>
				<div className="absorb-review-status"><span>Notes</span><strong>{counts.notes} changed</strong></div>
			</div>
			{error && <div className="checkpoint-proposal-error" role="alert">{error}</div>}
			{warnings.length > 0 && <div className="checkpoint-proposal-warnings absorb-warning-list">{warnings.map((warning) => <div key={warning}>{warning}</div>)}</div>}
			{(fastPathBlockedReasons?.length ?? 0) > 0 && (
				<div className="absorb-help-note fast-path-blocked-note">{automaticApplyNeedsReviewSentence(fastPathBlockedReasons!)}</div>
			)}
			<div className="absorb-proposal-sections">
				{guidance && (
					<section className="absorb-proposal-section absorb-run-guidance">
						<h3>What you asked for</h3>
						<GuidanceBlock title="Keep as they are" items={guidance.keepAsIs} />
						<GuidanceBlock title="Make shorter" items={guidance.shorten} />
						<GuidanceBlock title="Move to the archive" items={guidance.remove} />
						<GuidanceBlock title="Topics to go through" items={guidance.topics} />
						<GuidanceBlock title="Your answers" items={guidance.answers} />
						<GuidanceBlock title="Other instructions" items={guidance.instructions} />
					</section>
				)}
				<section className="absorb-proposal-section">
					<h3>Changes</h3>
					{groups.length === 0 ? <p>Nothing in these notes needed changing.</p> : (
						<div className="absorb-run-change-groups">
							{groups.map((group) => <TopicChangeGroup key={group.key} topic={group.topic} changes={group.changes} busy={busy} onEditEntry={onEditEntry} />)}
						</div>
					)}
				</section>
				<ArchiveSection budget={run.budget} demotion={run.demotion} keepIds={keepIds} keepTopics={run.demotion.keepTopics} busy={busy} onToggleKeep={onToggleKeep} onToggleKeepTopic={onToggleKeepTopic} onRaiseBudget={onRaiseBudget} />
				{leftAsIsTopics > 0 && (
					<details className="absorb-proposal-section absorb-run-archive review-left-as-is">
						<summary>
							<h3>{leftAsIsTopics} {leftAsIsTopics === 1 ? "topic" : "topics"} left as {leftAsIsTopics === 1 ? "it was" : "they were"}</h3>
							<span className="absorb-run-archive-toggle">Show</span>
						</summary>
						{run.leftAsIs.map((group, index) => (
							<p key={`${index}-${group.reason}`}><strong>{group.topics.map(topicLabel).join(", ")}</strong> — {group.reason}</p>
						))}
					</details>
				)}
			</div>
			<div className="checkpoint-preview-actions">
				<button className="landing-action secondary" disabled={busy} onClick={onCancel} title="Stop this tidy. Nothing is saved.">Cancel</button>
				<button className="landing-action secondary" disabled={busy} onClick={onBack} title="Return to the first read. This tidy is dropped and nothing is saved.">{backLabel}</button>
				<button className="landing-action" disabled={busy} onClick={onSave} title={overBudget || run.budget.overBudgetAfter ? "Save these changes and leave memory above its budget" : "Save these changes to memory"}>
					{overBudget || run.budget.overBudgetAfter ? "Save over the budget" : "Save to memory"}
				</button>
			</div>
			<p className="checkpoint-footnote">Saving keeps a copy of today's memory, so this tidy can be undone.</p>
		</div>
	);
}

/** A tidy that stopped on its own: the server's sentence, and two ways on. */
export function ReviewRunFailedScreen({ error, onBack, onRetry }: { error: string; onBack: () => void; onRetry: () => void }) {
	return (
		<div className="checkpoint-proposal-page absorb-error-state">
			<div className="checkpoint-input-heading">
				<h2>The tidy stopped</h2>
				<p>Nothing was saved. The notes are as they were.</p>
			</div>
			<div className="checkpoint-proposal-error" role="alert">{error}</div>
			<div className="checkpoint-preview-actions">
				<button className="landing-action secondary" onClick={onBack}>Back</button>
				<button className="landing-action" onClick={onRetry}>Try again</button>
			</div>
		</div>
	);
}

export interface ReviewUndoState {
	busy: boolean;
	done: boolean;
	error: string | null;
	/** The undone save had raised the limit and the undo put it back to this. */
	limitLoweredTo?: number;
}

export function ReviewSavedScreen({ roomName, counts, percent, over, archivedEntries, archivedForBudget, limitRaised = false, rebasedOnto, warnings, undo, onUndo, onReturn, returnLabel }: {
	roomName: string;
	counts: ReviewChangeCounts;
	percent: number;
	over: boolean;
	archivedEntries: number;
	archivedForBudget: number;
	/** The card raised the limit and this save wrote it to the room. */
	limitRaised?: boolean;
	/** Conversations remembered while the card was open; the save kept them waiting. */
	rebasedOnto?: string[];
	warnings: string[];
	undo: ReviewUndoState;
	onUndo: () => void;
	onReturn: () => void;
	returnLabel: string;
}) {
	const budgetLine = reviewSavedArchiveSentence(archivedForBudget);
	const meanwhileLine = rememberedMeanwhileSentence(rebasedOnto);
	return (
		<div className="checkpoint-proposal-page checkpoint-saved-page absorb-saved-state review-saved">
			<div className="checkpoint-input-heading">
				<p className="card-kicker">{undo.done ? "Undone" : "Saved"}</p>
				<h2>{undo.done ? "Undone." : reviewSavedHeadline(roomName, counts)}</h2>
				<p>{undo.done ? `${roomName}'s memory is as it was before this tidy.` : reviewSavedSentence(counts, percent, over)}</p>
				{undo.done && undo.limitLoweredTo !== undefined && <p>{LIMIT_LOWERED_ON_UNDO_SENTENCE(undo.limitLoweredTo)}</p>}
				{!undo.done && budgetLine && <p>{budgetLine}</p>}
				{!undo.done && limitRaised && <p>{LIMIT_RAISED_ON_SAVE_SENTENCE}</p>}
				{!undo.done && meanwhileLine && <p>{meanwhileLine}</p>}
			</div>
			{!undo.done && (
				<div className="absorb-review-strip">
					<div className="absorb-review-status"><span>Topics</span><strong>{counts.topics} tidied</strong></div>
					<div className="absorb-review-status"><span>Notes</span><strong>{counts.notes} changed</strong></div>
					{archivedEntries > 0 && <div className="absorb-review-status"><span>Archive</span><strong>{archivedEntries} {archivedEntries === 1 ? "note" : "notes"}</strong></div>}
					<div className="absorb-review-status"><span>Memory</span><strong>{percent}% full</strong></div>
				</div>
			)}
			{over && !undo.done && <div className="absorb-help-note memory-budget-nudge" role="status">Memory is still above its budget. Running Review again tidies more, and the budget can be raised in Room settings.</div>}
			{undo.error && <div className="checkpoint-proposal-error" role="alert">{undo.error}</div>}
			{warnings.length > 0 && <div className="checkpoint-proposal-warnings">{warnings.map((warning) => <div key={warning}>{warning}</div>)}</div>}
			<div className="checkpoint-preview-actions">
				{!undo.done && (counts.notes > 0 || archivedEntries > 0) && <button className="landing-action secondary" disabled={undo.busy} title={`Put ${roomName}'s memory back as it was before this tidy`} onClick={onUndo}>{undo.busy ? "Undoing…" : "Undo"}</button>}
				<button className="landing-action" onClick={onReturn}>{returnLabel}</button>
			</div>
			{!undo.done && <p className="checkpoint-footnote">The previous memory is kept, so this can also be undone later from Room settings → Memory.</p>}
		</div>
	);
}

export function reviewPercent(tokens: number | undefined, budget: number | undefined): number {
	return memoryFullPercent(tokens ?? 0, budget ?? 0);
}
