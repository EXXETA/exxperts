// The Memorize v2 screens: the room reads its conversations one at a time and
// reports each outcome as it lands, then the card states exactly what the room
// will remember, what would move to the archive, and where that leaves the
// memory limit. Nothing on either screen is computed here: the run carries the
// numbers, this file words them.

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { AbsorbRun, AbsorbRunSession, ArchiveRow, RunBudget, RunDemotion } from "../types";
import { MarkdownRenderer } from "./Markdown";
import { meaningfulMaintenanceWarnings } from "../maintenance-warnings";
import { ARCHIVE_EXPLANATION, absorbRunFailedSessionNote, absorbRunGuidanceSummary, absorbRunNotesChanged, absorbRunProgressLine, absorbRunReadCount, absorbRunSessionLine, archiveHeading, archiveLimitSummary, archiveRowTag, archiveTopicGroupSummary, automaticApplyNeedsReviewSentence, changeKindLabel, entryFirstLine, entryGroupPage, entryKindLabel, entryOriginSentence, filterEntriesByText, groupEntriesByTopic, isEntryIdMigrationNotice, KEEP_TOPIC_LABEL, MEMORY_LIMIT_BAR_LABEL, NEW_TOPIC_TAG, showMoreLabel, topicKept, topicLabel } from "../memory-v2-copy";

/** The words of a note, editable in place: the textarea holds the text without its bullet marker. */
export function NoteEditor({ text, busy, onSave, onCancel }: { text: string; busy: boolean; onSave: (text: string) => void; onCancel: () => void }) {
	const [draft, setDraft] = useState(text.replace(/^[-*]\s+/, ""));
	return (
		<div className="absorb-run-note-editor">
			<textarea value={draft} rows={4} autoFocus aria-label="Note text" onChange={(event) => setDraft(event.target.value)} />
			<div className="memory-entry-actions">
				<button className="rs-btn" type="button" disabled={busy || !draft.trim()} onClick={() => onSave(draft.trim())}>{busy ? "Saving…" : "Save"}</button>
				<button className="rs-quiet" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
			</div>
		</div>
	);
}

function ChangeRow({ change, onEdit }: { change: NonNullable<AbsorbRunSession["changes"]>[number]; onEdit?: (entryId: string, text: string) => Promise<void> }) {
	const label = changeKindLabel(change.kind);
	const [editing, setEditing] = useState(false);
	const [saving, setSaving] = useState(false);
	const [editError, setEditError] = useState<string | null>(null);
	const editable = Boolean(onEdit) && (change.kind === "added" || change.kind === "updated" || change.kind === "superseded");
	async function save(text: string): Promise<void> {
		if (!onEdit) return;
		setSaving(true);
		setEditError(null);
		try {
			await onEdit(change.id, text);
			setEditing(false);
		} catch (e) {
			setEditError((e as Error).message);
		} finally {
			setSaving(false);
		}
	}
	const editControls = editable && !editing && <button type="button" className="rs-quiet absorb-run-change-edit" onClick={() => setEditing(true)}>Edit</button>;
	const editor = editing && <NoteEditor text={change.after ?? ""} busy={saving} onSave={(text) => void save(text)} onCancel={() => { setEditing(false); setEditError(null); }} />;
	const errorLine = editError && <p className="checkpoint-proposal-error" role="alert">{editError}</p>;
	// A topic this update created is said next to its name, so a new heading in
	// memory is never a surprise on the saved screen.
	const newTopicTag = change.newTopic && <span className="absorb-run-change-tag">{NEW_TOPIC_TAG}</span>;
	if (change.kind === "updated" || change.kind === "superseded") {
		return (
			<details className="absorb-run-change absorb-candidate-disclosure absorb-detail-disclosure">
				<summary>{label} · {topicLabel(change.topic)}</summary>
				<div className="absorb-run-change-diff">
					<div className="absorb-run-change-side">
						<span className="absorb-run-change-side-label">Before</span>
						<MarkdownRenderer>{change.before || "Not recorded."}</MarkdownRenderer>
					</div>
					<div className="absorb-run-change-side">
						<span className="absorb-run-change-side-label">After</span>
						{editing ? editor : <MarkdownRenderer>{change.after || "Not recorded."}</MarkdownRenderer>}
						{editControls}
						{errorLine}
					</div>
				</div>
			</details>
		);
	}
	if (change.kind === "pinned" || change.kind === "closed") {
		return (
			<div className="absorb-run-change compact">
				<span className="absorb-run-change-label">{label}</span>
				<span className="absorb-run-change-topic">{topicLabel(change.topic)}</span>
				{(change.after || change.before) && <span className="absorb-run-change-line">{entryFirstLine(change.after || change.before || "")}</span>}
			</div>
		);
	}
	return (
		<div className="absorb-run-change">
			<span className="absorb-run-change-label">{label}</span>
			<span className="absorb-run-change-topic">{topicLabel(change.topic)}{newTopicTag}</span>
			{editing ? editor : change.after && <div className="absorb-run-change-text"><MarkdownRenderer>{change.after}</MarkdownRenderer></div>}
			{editControls}
			{errorLine}
		</div>
	);
}

/**
 * One row of the archive list. Its text opens to the whole note on a click;
 * the checkbox stays where it is. A kept row is dimmed, a replacement carries
 * its tag, and a row that stopped leaving says so and offers no checkbox.
 */
function EntryRow({ row, keptById, keptByTopic, onToggleKeep }: { row: ArchiveRow; keptById: boolean; keptByTopic: boolean; onToggleKeep: (next: boolean) => void }) {
	const [open, setOpen] = useState(false);
	const origin = entryOriginSentence(row);
	const kept = keptById || keptByTopic;
	const tag = kept ? null : archiveRowTag({ leaving: row.leaving, kept, instead: row.instead });
	const keepable = kept || row.leaving;
	return (
		<li className={`absorb-run-entry${kept ? " kept" : ""}${open ? " open" : ""}`}>
			<div className="absorb-run-entry-main">
				<button type="button" className="absorb-run-entry-open" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
					<span className="absorb-run-entry-meta">
						<span className="memory-entry-kind">{entryKindLabel(row.kind)}</span>
						<span className="absorb-run-entry-date">{origin ?? `saved ${row.saved}`}</span>
						{tag && <span className="absorb-run-entry-tag">{tag}</span>}
					</span>
					{!open && <span className="absorb-run-entry-line">{entryFirstLine(row.text)}</span>}
				</button>
				{open && <div className="absorb-run-entry-full"><MarkdownRenderer>{row.text}</MarkdownRenderer></div>}
			</div>
			{keepable && (
				<label className="absorb-run-entry-keep" title={keptByTopic && !keptById ? "Kept with its topic" : undefined}>
					<input type="checkbox" checked={kept} disabled={keptByTopic && !keptById} onChange={(event) => onToggleKeep(event.target.checked)} />
					<span>Keep</span>
				</label>
			)}
		</li>
	);
}

/**
 * The archive list. A room at its limit archives hundreds of notes at once,
 * so the list opens as its topics: each closed, counted, and keepable whole.
 * A search box reaches a single note without opening anything, and a topic in
 * a very long list hands out its rows a page at a time. The list is the run's
 * stable one: rows are never dropped from it, only re-tagged.
 */
export function EntryList({ entries, keepIds, keepTopics, listId, busy, onToggleKeep, onToggleKeepTopic }: {
	entries: ArchiveRow[];
	/** The keep set as the person left it: the rows answer a toggle before the server does. */
	keepIds: string[];
	/** Topics protected for this run, as the run reports them; never derived from the rows. */
	keepTopics: string[];
	listId: string;
	busy: boolean;
	onToggleKeep: (entryIds: string[], next: boolean) => void;
	onToggleKeepTopic: (section: ArchiveRow["section"], topic: string, next: boolean) => void;
}) {
	const [query, setQuery] = useState("");
	const [opened, setOpened] = useState<Record<string, boolean>>({});
	const [showAll, setShowAll] = useState<Record<string, boolean>>({});
	// A topic keep answers at once on screen and follows the server's answer when it lands.
	const [pendingTopics, setPendingTopics] = useState<Record<string, boolean>>({});
	useEffect(() => setPendingTopics({}), [keepTopics]);
	const searching = query.trim().length > 0;
	const matches = useMemo(() => filterEntriesByText(entries, query), [entries, query]);
	const groups = useMemo(() => groupEntriesByTopic(matches), [matches]);
	return (
		<div className="absorb-run-entry-list">
			<input
				className="create-room-input absorb-run-entry-search"
				type="search"
				value={query}
				placeholder="Search these notes"
				aria-label={`Search these notes (${listId})`}
				onChange={(event) => setQuery(event.target.value)}
			/>
			{searching && groups.length === 0 && <p className="absorb-help-note">No note here matches that.</p>}
			{groups.map((group) => {
				const key = `${group.section} ${group.topic}`;
				// A search is a question about single rows: the topics that answer
				// it open themselves, so nothing has to be hunted for twice.
				const isOpen = searching || opened[key] === true;
				const page = entryGroupPage(group.entries, matches.length, showAll[key] === true);
				const topicIsKept = pendingTopics[key] ?? topicKept(keepTopics, group.section, group.topic);
				return (
					<section className="absorb-run-entry-group" key={key}>
						<div className="absorb-run-entry-group-head">
							<button
								type="button"
								className="absorb-run-entry-group-toggle"
								aria-expanded={isOpen}
								onClick={() => setOpened((current) => ({ ...current, [key]: !isOpen }))}
							>
								<span className="absorb-run-entry-group-caret">{isOpen ? "Hide" : "Show"}</span>
								<span>{archiveTopicGroupSummary(group)}</span>
							</button>
							<label className="absorb-run-entry-keep">
								<input type="checkbox" checked={topicIsKept} disabled={busy} onChange={(event) => { setPendingTopics((current) => ({ ...current, [key]: event.target.checked })); onToggleKeepTopic(group.section, group.topic, event.target.checked); }} />
								<span>{KEEP_TOPIC_LABEL}</span>
							</label>
						</div>
						{isOpen && (
							<>
								<ul className="absorb-run-entries">
									{page.visible.map((row) => (
										<EntryRow key={row.id} row={row} keptById={keepIds.includes(row.id)} keptByTopic={topicIsKept} onToggleKeep={(next) => onToggleKeep([row.id], next)} />
									))}
								</ul>
								{page.hidden > 0 && (
									<button type="button" className="rs-quiet absorb-run-entry-more" onClick={() => setShowAll((current) => ({ ...current, [key]: true }))}>
										{showMoreLabel(page.hidden)}
									</button>
								)}
							</>
						)}
					</section>
				);
			})}
		</div>
	);
}

/**
 * The limit bar: the filled part is the limit, the grey part is what leaves
 * because of it, drawn to the same scale and capped at the limit's own width.
 * The only meter on either card, and the only place tokens are written: inside
 * the button that sets them.
 */
export function ArchiveLimitBar({ budget, demotion, busy, onRaiseBudget }: { budget: RunBudget; demotion: RunDemotion; busy: boolean; onRaiseBudget: (budgetTokens: number) => void }) {
	const summary = archiveLimitSummary({ budget, demotion });
	const raise = summary.raise;
	return (
		<div className={`archive-limit-bar${summary.fits ? " fits" : ""}`}>
			<span className="archive-limit-bar-label">{MEMORY_LIMIT_BAR_LABEL}</span>
			<div
				className="archive-limit-bar-track"
				role="img"
				aria-label={summary.fits ? `${MEMORY_LIMIT_BAR_LABEL}: ${summary.fillLabel}` : `${MEMORY_LIMIT_BAR_LABEL}: ${summary.fillLabel}, ${summary.overflowLabel}`}
				style={{ "--archive-over": summary.overflowRatio, "--archive-level": Math.min(100, Math.max(0, summary.percent)) } as CSSProperties}
			>
				<div className="archive-limit-bar-fill">
					<span className="archive-limit-bar-level" aria-hidden="true" />
					<span className="archive-limit-bar-text">{summary.fillLabel}</span>
				</div>
				{!summary.fits && (
					<div className="archive-limit-bar-over">
						<span className="archive-limit-bar-text">{summary.overflowLabel}</span>
					</div>
				)}
			</div>
			<p className="archive-limit-bar-counts">{summary.fitsSentence ?? summary.countsLine}</p>
			{raise && (
				<div className="absorb-run-budget-actions">
					{raise.ceilingSentence && <span className="archive-limit-bar-ceiling">{raise.ceilingSentence}</span>}
					<button className="landing-action secondary" disabled={busy || raise.target <= budget.budgetTokens} onClick={() => onRaiseBudget(raise.target)}>
						{raise.label}
					</button>
				</div>
			)}
		</div>
	);
}

/**
 * The archive section both cards share: the heading, the limit bar, one
 * explanation, the search box and the topics. Closed by default; its one line
 * of counts shows on the closed summary and moves into the bar when opened.
 */
export function ArchiveSection({ budget, demotion, keepIds, keepTopics, busy, onToggleKeep, onToggleKeepTopic, onRaiseBudget }: {
	budget: RunBudget;
	demotion: RunDemotion;
	keepIds: string[];
	keepTopics: string[];
	busy: boolean;
	onToggleKeep: (entryIds: string[], next: boolean) => void;
	onToggleKeepTopic: (section: ArchiveRow["section"], topic: string, next: boolean) => void;
	onRaiseBudget: (budgetTokens: number) => void;
}) {
	if (demotion.entries.length === 0) return null;
	const summary = archiveLimitSummary({ budget, demotion });
	// Nothing leaves and nothing kept pushes past the limit: the heading says
	// so, the bar shows where the limit sits, and the rows that would all read
	// "stays" are not listed. A kept row stays kept on the server, harmlessly.
	const nothingLeaves = demotion.counts.leaving === 0 && demotion.overageTokens <= 0;
	return (
		<details className="absorb-proposal-section absorb-run-archive">
			<summary>
				<h3>{archiveHeading(demotion.counts.leaving)}</h3>
				<span className="absorb-run-archive-toggle">Show</span>
				<span className="absorb-run-archive-summary-line">{summary.fitsSentence ?? summary.countsLine}</span>
			</summary>
			<ArchiveLimitBar budget={budget} demotion={demotion} busy={busy} onRaiseBudget={onRaiseBudget} />
			{!nothingLeaves && <p className="absorb-run-archive-explanation">{ARCHIVE_EXPLANATION}</p>}
			{!nothingLeaves && <EntryList entries={demotion.entries} keepIds={keepIds} keepTopics={keepTopics} listId="going to the archive" busy={busy} onToggleKeep={onToggleKeep} onToggleKeepTopic={onToggleKeepTopic} />}
		</details>
	);
}

/**
 * The card before the run exists: the conversations the first read listed, all
 * waiting, under a headline for the step in hand ("Reading the discussion
 * back…", "Starting…"). One screen from Continue to Save, no loading screen in
 * between.
 */
export function placeholderAbsorbRun(agentId: AbsorbRun["agentId"], sessions: { id: string; title: string; date: string }[]): AbsorbRun {
	const now = new Date().toISOString();
	return {
		runId: "",
		agentId,
		state: "prepass",
		startedAt: now,
		updatedAt: now,
		progress: { folded: 0, total: sessions.length },
		sessions: sessions.map((session) => ({ id: session.id, title: session.title, date: session.date, outcome: "pending" as const, attempts: 0 })),
		prepass: { demoted: [] },
		budget: { before: 0, after: 0, budgetTokens: 0, savedBudgetTokens: 0, overBudgetAfter: false, ceilingTokens: 0 },
		demotion: { entries: [], keepIds: [], keepTopics: [], overageTokens: 0, counts: { leaving: 0, kept: 0, instead: 0 } },
		candidate: null,
		guidance: null,
		migration: null,
		warnings: [],
	};
}

/**
 * The card: what the room will remember, conversation by conversation, then
 * what would leave for the archive and where the limit lands. Save is the only
 * thing on this screen that writes.
 */
export function AbsorbRunCard({ run, roomName, working = false, headline, fastPathBlockedReasons, keepIds, busy, error, onToggleKeep, onToggleKeepTopic, onRaiseBudget, onEditEntry, onApprove, onCancel, onBackToAssessment }: {
	run: AbsorbRun;
	roomName: string;
	/** The run is still reading conversations: the card fills in as they land and cannot be saved yet. */
	working?: boolean;
	/** Working only: the headline for a step before the run reports progress. */
	headline?: string;
	/** The person's words for a note this update adds or rewrites; resolves with the run refreshed. */
	onEditEntry?: (entryId: string, text: string) => Promise<void>;
	fastPathBlockedReasons?: string[];
	/** The keep set as the person left it: the card answers a toggle before the server does. */
	keepIds: string[];
	busy: boolean;
	error: string | null;
	onToggleKeep: (entryIds: string[], next: boolean) => void;
	onToggleKeepTopic: (section: ArchiveRow["section"], topic: string, next: boolean) => void;
	onRaiseBudget: (budgetTokens: number) => void;
	onApprove: () => void;
	onCancel: () => void;
	onBackToAssessment: () => void;
}) {
	// Giving notes their ids is bookkeeping a person never needs to weigh, so
	// the server's note about it is not shown on the card at all.
	const warnings = meaningfulMaintenanceWarnings(run.warnings.filter((warning) => !isEntryIdMigrationNotice(warning)));
	const overBudget = run.demotion.overageTokens > 0;
	const failedNote = absorbRunFailedSessionNote(run);
	const guidance = absorbRunGuidanceSummary(run);
	// While the run works every conversation has a row, so the list fills in as
	// they are read; once it is done only the ones that changed memory stay.
	const changedSessions = working ? run.sessions : run.sessions.filter((session) => (session.changes?.length ?? 0) > 0 || session.outcome === "dropped" || session.outcome === "failed" || session.outcome === "skipped");
	const total = run.progress.total;
	const notesChanged = absorbRunNotesChanged(run);
	const readCount = absorbRunReadCount(run);
	return (
		<div className="checkpoint-proposal-page absorb-proposal-page absorb-run-card">
			<div className="checkpoint-input-heading checkpoint-proposal-heading">
				{working ? (
					<h2 className="absorb-run-card-working"><span className="spinner" aria-hidden="true" /> {headline ?? absorbRunProgressLine(run)}</h2>
				) : (
					<h2>What {roomName} will keep</h2>
				)}
				<p>{working
					? "Each conversation is read on its own and turned into notes. The rows below fill in as they are read."
					: `From ${total} ${total === 1 ? "conversation" : "conversations"}. Read it, keep anything the room should not let go, then save.`}</p>
			</div>
			<div className="absorb-review-strip">
				<div className="absorb-review-status"><span>Conversations</span><strong>{readCount} of {total} read</strong></div>
				<div className="absorb-review-status"><span>Notes</span><strong>{notesChanged} added or updated</strong></div>
			</div>
			{error && <div className="checkpoint-proposal-error" role="alert">{error}</div>}
			{warnings.length > 0 && <div className="checkpoint-proposal-warnings absorb-warning-list">{warnings.map((warning) => <div key={warning}>{warning}</div>)}</div>}
			{(fastPathBlockedReasons?.length ?? 0) > 0 && (
				<div className="absorb-help-note fast-path-blocked-note">
					{automaticApplyNeedsReviewSentence(fastPathBlockedReasons!)}
				</div>
			)}
			<div className="absorb-proposal-sections">
				{guidance && (
					<section className="absorb-proposal-section absorb-run-guidance">
						<h3>What you asked for</h3>
						{guidance.pins.length > 0 && (
							<div className="absorb-run-guidance-block">
								<strong>Keep these</strong>
								<ul>{guidance.pins.map((pin) => <li key={pin}>{pin}</li>)}</ul>
							</div>
						)}
						{guidance.drops.length > 0 && (
							<div className="absorb-run-guidance-block">
								<strong>Conversations to leave out</strong>
								<ul>{guidance.drops.map((drop) => (
									<li key={drop.text}>
										{drop.text}
										{drop.leftOut && <span className="absorb-run-guidance-tag">left out</span>}
									</li>
								))}</ul>
							</div>
						)}
						{guidance.corrections.length > 0 && (
							<div className="absorb-run-guidance-block">
								<strong>Corrections</strong>
								<ul>{guidance.corrections.map((correction) => <li key={correction}>{correction}</li>)}</ul>
							</div>
						)}
						{guidance.topics.length > 0 && (
							<div className="absorb-run-guidance-block">
								<strong>Topics</strong>
								<ul>{guidance.topics.map((topic) => <li key={topic}>{topic}</li>)}</ul>
							</div>
						)}
						{guidance.instructions.length > 0 && (
							<div className="absorb-run-guidance-block">
								<strong>Other instructions</strong>
								<ul>{guidance.instructions.map((instruction) => <li key={instruction}>{instruction}</li>)}</ul>
							</div>
						)}
					</section>
				)}
				<section className="absorb-proposal-section">
					<h3>New in memory</h3>
					{changedSessions.length === 0 ? <p>Nothing in these conversations changed memory.</p> : (
						<div className="absorb-run-change-groups">
							{changedSessions.map((session) => (
								(session.changes?.length ?? 0) > 0 ? (
									<details className="absorb-run-change-group absorb-run-conversation" key={session.id}>
										<summary>
											<span className="absorb-run-session-head">
												<strong>{session.title}</strong>
												<span className="absorb-run-session-date">{session.date}</span>
											</span>
											<span className="absorb-run-session-state">{absorbRunSessionLine(session)}</span>
										</summary>
										<div className="absorb-run-conversation-body">
											{session.changes?.map((change, index) => <ChangeRow key={`${change.id}-${index}`} change={change} onEdit={onEditEntry} />)}
										</div>
									</details>
								) : (
									<div className="absorb-run-change-group absorb-run-conversation plain" key={session.id}>
										<span className="absorb-run-session-head">
											<strong>{session.title}</strong>
											<span className="absorb-run-session-date">{session.date}</span>
										</span>
										<span className="absorb-run-session-state">{absorbRunSessionLine(session)}</span>
									</div>
								)
							))}
						</div>
					)}
					{failedNote && <p className="absorb-help-note">{failedNote}</p>}
				</section>
				{!working && (
					<ArchiveSection budget={run.budget} demotion={run.demotion} keepIds={keepIds} keepTopics={run.demotion.keepTopics} busy={busy} onToggleKeep={onToggleKeep} onToggleKeepTopic={onToggleKeepTopic} onRaiseBudget={onRaiseBudget} />
				)}
			</div>
			<div className="checkpoint-preview-actions">
				<button className="landing-action secondary" disabled={busy} onClick={onCancel} title="Stop this update. Nothing is saved.">Cancel</button>
				{!working && <button className="landing-action secondary" disabled={busy} onClick={onBackToAssessment} title="Return to the first read. This update is dropped and nothing is saved.">Back</button>}
				<button className="landing-action" disabled={busy || working} onClick={onApprove} title={working ? "Save turns on once every conversation has been read" : overBudget ? "Save this update and leave memory above its budget" : "Save this update to memory"}>
					{overBudget && !working ? "Save over the budget" : "Save to memory"}
				</button>
			</div>
			<p className="checkpoint-footnote">{working ? "Nothing is saved until you press Save to memory." : "Saving keeps a copy of today's memory, so this update can be undone from Room settings."}</p>
		</div>
	);
}

/** A run that stopped on its own: the server's sentence, and two ways on. */
export function AbsorbRunFailedScreen({ error, onBackToAssessment, onRetry }: { error: string; onBackToAssessment: () => void; onRetry: () => void }) {
	return (
		<div className="checkpoint-proposal-page absorb-error-state">
			<div className="checkpoint-input-heading">
				<h2>The update stopped</h2>
				<p>Nothing was saved. Your conversations are still waiting.</p>
			</div>
			<div className="checkpoint-proposal-error" role="alert">{error}</div>
			<div className="checkpoint-preview-actions">
				<button className="landing-action secondary" onClick={onBackToAssessment}>Back</button>
				<button className="landing-action" onClick={onRetry}>Try again</button>
			</div>
		</div>
	);
}
