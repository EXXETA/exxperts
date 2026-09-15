// The room's memory, note by note, inside Room settings. Everything here is a
// direct write: no model, no draft, no approval. Each action is one request and
// the answer carries the limit the server recomputed, so the line above and
// this list never disagree. While the room is in a conversation the pane reads
// but does not write, because the server refuses those writes too.
//
// A room with hundreds of notes is read the way its memory is organised: two
// groups, topics closed with their counts, and a search box over the lot.
// Below them, the archive; below that, everything that has ever changed this
// room's memory, with Undo on the newest Memorize or Review.

import { useEffect, useMemo, useState } from "react";
import type { ArchivedEntryCard, BudgetState, EntryCard, EntryKind, MemoryEntriesTopicGroup, MemoryUndoResponse, PersistentAgentStatus } from "../types";
import { createMemoryEntry, deleteArchivedMemoryEntry, deleteMemoryEntry, fetchMemoryArchive, fetchMemoryEntries, fetchMemoryHistory, restoreMemoryEntry, undoMemorySave, updateMemoryEntry } from "../memory-entries-api";
import { entryKindLabel, LIMIT_LOWERED_ON_UNDO_SENTENCE, MEMORY_EDIT_BLOCKED_SENTENCE } from "../memory-v2-copy";
import { MemoryChangeFold } from "./memory-change-fold";
import {
	ADD_NOTE_LABEL,
	archiveRowMeta,
	archiveSummaryLine,
	DELETE_NOTE_QUESTION,
	fmtMemoryMoment,
	HISTORY_EMPTY_SENTENCE,
	HISTORY_SUB,
	HISTORY_UNDO_LABEL,
	HISTORY_UNDONE_MARK,
	memoryHistoryRows,
	memoryTopicName,
	noteOriginTitle,
	noteRowMeta,
	NOTES_EMPTY_SENTENCE,
	NOTES_LOADING_SENTENCE,
	NOTES_NO_MATCH_SENTENCE,
	NOTES_SEARCH_PLACEHOLDER,
	notesSummaryLine,
	topicRowLine,
	undoableHistoryRow,
	type MemoryHistoryRow,
	type MemorySaveEvent,
} from "../memory-surface-copy";

const KIND_OPTIONS: EntryKind[] = ["fact", "practice", "item"];
const NEW_TOPIC = "__new-topic__";
/** The two groups, in the order memory itself is written. */
const SECTIONS: { section: MemoryEntriesTopicGroup["section"]; title: string }[] = [
	{ section: "Deep Memory", title: "Notes" },
	{ section: "Active Items", title: "Open items" },
];

/**
 * A room that is mid-conversation cannot be edited: the server refuses the
 * write, so the pane says so first. Only a running turn counts, the same rule
 * the server applies (memoryRoomBusy): a room merely open in a chat tab holds
 * its lock but is not busy, and its memory can be edited.
 */
export function memoryEditingBlocked(status: PersistentAgentStatus): boolean {
	const thread = status.activeThread;
	// The turn state is an object even at rest ({ state: "idle" }): only a turn
	// that is running or being cancelled counts.
	const turn = thread?.activeTurn?.state;
	return turn === "running" || turn === "cancelling" || thread?.inFlight === true || thread?.working === true;
}

type TopicGroup = { section: MemoryEntriesTopicGroup["section"]; title: string; entries: EntryCard[] };

function groupByTopic(entries: EntryCard[], order: { section: MemoryEntriesTopicGroup["section"]; title: string }[]): TopicGroup[] {
	const groups = new Map<string, TopicGroup>();
	for (const topic of order) {
		if (!groups.has(topic.title)) groups.set(topic.title, { section: topic.section, title: topic.title, entries: [] });
	}
	for (const entry of entries) {
		let group = groups.get(entry.topic);
		if (!group) {
			group = { section: entry.section, title: entry.topic, entries: [] };
			groups.set(entry.topic, group);
		}
		group.entries.push(entry);
	}
	return [...groups.values()].filter((group) => group.entries.length > 0);
}

// Delete for good: the one action here nothing brings back, so it asks first
// and says exactly that. The sentences live here, beside the button that says them.
const DELETE_ARCHIVED_NOTE_TITLE = "Delete this archived note for good?";
const DELETE_ARCHIVED_NOTE_BODY = "It leaves the archive and cannot be brought back or undone.";
const DELETE_FOR_GOOD_LABEL = "Delete for good";
const KEEP_IT_LABEL = "Keep it";

/** The search box reads what a person can see: the note's words and its topic. */
function matchesQuery(entry: EntryCard, query: string): boolean {
	const needle = query.trim().toLowerCase();
	if (!needle) return true;
	return entry.text.toLowerCase().includes(needle) || memoryTopicName(entry.topic).toLowerCase().includes(needle);
}

export function RoomMemoryEntriesSection({ status, onMemoryTokens, onArchiveDeleted }: { status: PersistentAgentStatus; onMemoryTokens?: (tokens: number | null) => void; onArchiveDeleted?: () => void }) {
	const [entries, setEntries] = useState<EntryCard[] | null>(null);
	const [topicOrder, setTopicOrder] = useState<{ section: MemoryEntriesTopicGroup["section"]; title: string }[]>([]);
	const [budget, setBudget] = useState<BudgetState | null>(null);
	const [archiveCount, setArchiveCount] = useState(0);
	const [archive, setArchive] = useState<ArchivedEntryCard[] | null>(null);
	const [archiveNext, setArchiveNext] = useState<string | undefined>(undefined);
	const [archiveBusy, setArchiveBusy] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	// A server without the entries routes has no notes view to show; the pane
	// keeps its limit line and toggles rather than wearing a red error.
	const [unavailable, setUnavailable] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	// The server's own verdict on this room, and the sentence it sent with it.
	// A room in a conversation still answers with its memory, so the pane shows
	// everything and simply offers nothing that would write.
	const [serverReadOnly, setServerReadOnly] = useState(false);
	const [serverReadOnlyReason, setServerReadOnlyReason] = useState<string | null>(null);
	const [busyId, setBusyId] = useState<string | null>(null);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editText, setEditText] = useState("");
	const [movingId, setMovingId] = useState<string | null>(null);
	const [moveTopic, setMoveTopic] = useState("");
	const [moveNewTopic, setMoveNewTopic] = useState("");
	const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
	const [confirmArchiveDeleteId, setConfirmArchiveDeleteId] = useState<string | null>(null);
	const [adding, setAdding] = useState(false);
	const [addTopic, setAddTopic] = useState("");
	const [addNewTopic, setAddNewTopic] = useState("");
	const [addKind, setAddKind] = useState<EntryKind>("fact");
	const [addText, setAddText] = useState("");
	const [query, setQuery] = useState("");
	// Topics start closed: 42 of them open at once is not a list, it is a wall.
	const [openTopics, setOpenTopics] = useState<Set<string>>(new Set());

	// Either side may know first: the room status this app polls, or the entries
	// response itself. Both mean the same thing, and the guard sentence is said
	// once, in the server's words when it sent them.
	const readOnly = memoryEditingBlocked(status) || serverReadOnly;
	const readOnlySentence = serverReadOnlyReason ?? MEMORY_EDIT_BLOCKED_SENTENCE;

	useEffect(() => {
		let cancelled = false;
		setEntries(null);
		setBudget(null);
		setArchive(null);
		setArchiveNext(undefined);
		setLoadError(null);
		setActionError(null);
		setUnavailable(false);
		setServerReadOnly(false);
		setServerReadOnlyReason(null);
		setQuery("");
		setOpenTopics(new Set());
		fetchMemoryEntries(status.id)
			.then((response) => {
				if (cancelled) return;
				setServerReadOnly(response.readOnly === true);
				setServerReadOnlyReason(response.readOnly === true && response.reason ? response.reason : null);
				setEntries(response.topics.flatMap((topic) => topic.entries));
				setTopicOrder(response.topics.map((topic) => ({ section: topic.section, title: topic.title })));
				setBudget(response.budget);
				setArchiveCount(response.archive.count);
			})
			.catch((e) => {
				if (cancelled) return;
				const message = (e as Error).message;
				if (/\(404\)/.test(message)) setUnavailable(true);
				else setLoadError(message);
			});
		return () => { cancelled = true; };
	}, [status.id]);

	// The limit line above this pane reads what this pane last measured: one
	// file, one number, however the file was changed.
	useEffect(() => {
		onMemoryTokens?.(budget ? budget.reviewTargetTokens : null);
	}, [budget, onMemoryTokens]);

	const groups = useMemo(() => groupByTopic(entries ?? [], topicOrder), [entries, topicOrder]);
	const filtered = useMemo(
		() => groups
			.map((group) => ({ ...group, entries: group.entries.filter((entry) => matchesQuery(entry, query)) }))
			.filter((group) => group.entries.length > 0),
		[groups, query],
	);
	const topicNames = useMemo(() => [...new Set([...topicOrder.map((topic) => topic.title), ...(entries ?? []).map((entry) => entry.topic)])], [topicOrder, entries]);
	const noteCount = entries?.length ?? 0;
	const topicCount = groups.length;

	function toggleTopic(title: string): void {
		setOpenTopics((current) => {
			const next = new Set(current);
			if (next.has(title)) next.delete(title);
			else next.add(title);
			return next;
		});
	}

	function applyEntry(entry: EntryCard, nextBudget: BudgetState): void {
		setEntries((current) => {
			const list = current ?? [];
			return list.some((existing) => existing.id === entry.id)
				? list.map((existing) => (existing.id === entry.id ? entry : existing))
				: [...list, entry];
		});
		setBudget(nextBudget);
	}

	async function run(entryId: string, action: () => Promise<void>): Promise<void> {
		if (readOnly || busyId) return;
		setBusyId(entryId);
		setActionError(null);
		try {
			await action();
		} catch (e) {
			setActionError((e as Error).message);
		} finally {
			setBusyId(null);
		}
	}

	function startEdit(entry: EntryCard): void {
		setEditingId(entry.id);
		setEditText(entry.text);
		setMovingId(null);
		setConfirmDeleteId(null);
	}

	function startMove(entry: EntryCard): void {
		setMovingId(entry.id);
		setMoveTopic(entry.topic);
		setMoveNewTopic("");
		setEditingId(null);
		setConfirmDeleteId(null);
	}

	async function saveEdit(entry: EntryCard): Promise<void> {
		const text = editText.trim();
		if (!text || text === entry.text) { setEditingId(null); return; }
		await run(entry.id, async () => {
			const response = await updateMemoryEntry(status.id, entry.id, { text });
			applyEntry(response.entry, response.budget);
			setEditingId(null);
		});
	}

	async function togglePin(entry: EntryCard): Promise<void> {
		await run(entry.id, async () => {
			const response = await updateMemoryEntry(status.id, entry.id, { pinned: !entry.pinned });
			applyEntry(response.entry, response.budget);
		});
	}

	async function saveMove(entry: EntryCard): Promise<void> {
		const topic = (moveTopic === NEW_TOPIC ? moveNewTopic : moveTopic).trim();
		if (!topic || topic === entry.topic) { setMovingId(null); return; }
		await run(entry.id, async () => {
			const response = await updateMemoryEntry(status.id, entry.id, { topic });
			applyEntry(response.entry, response.budget);
			setMovingId(null);
		});
	}

	async function confirmDelete(entry: EntryCard): Promise<void> {
		await run(entry.id, async () => {
			const response = await deleteMemoryEntry(status.id, entry.id);
			setEntries((current) => (current ?? []).filter((existing) => existing.id !== entry.id));
			setBudget(response.budget);
			setArchiveCount((count) => count + 1);
			setArchive((current) => (current === null ? current : [response.archived, ...current]));
			setConfirmDeleteId(null);
		});
	}

	async function addEntry(): Promise<void> {
		const topic = (addTopic === NEW_TOPIC || !addTopic ? addNewTopic : addTopic).trim();
		const text = addText.trim();
		if (!topic || !text) return;
		await run("new-entry", async () => {
			const response = await createMemoryEntry(status.id, { topic, kind: addKind, text });
			applyEntry(response.entry, response.budget);
			setOpenTopics((current) => new Set(current).add(topic));
			setAdding(false);
			setAddTopic("");
			setAddNewTopic("");
			setAddKind("fact");
			setAddText("");
		});
	}

	async function loadArchive(before?: string): Promise<void> {
		if (archiveBusy) return;
		setArchiveBusy(true);
		setActionError(null);
		try {
			const response = await fetchMemoryArchive(status.id, before ? { before } : undefined);
			setArchive((current) => (before && current ? [...current, ...response.entries] : response.entries));
			setArchiveNext(response.next);
		} catch (e) {
			setActionError((e as Error).message);
		} finally {
			setArchiveBusy(false);
		}
	}

	async function restore(entry: ArchivedEntryCard): Promise<void> {
		await run(entry.id, async () => {
			const response = await restoreMemoryEntry(status.id, entry.id);
			applyEntry(response.entry, response.budget);
			setArchive((current) => (current ?? []).filter((existing) => existing.id !== entry.id));
			setArchiveCount((count) => Math.max(0, count - 1));
			setConfirmArchiveDeleteId(null);
		});
	}

	async function deleteForGood(entry: ArchivedEntryCard): Promise<void> {
		await run(entry.id, async () => {
			const response = await deleteArchivedMemoryEntry(status.id, entry.id);
			setArchive((current) => (current ?? []).filter((existing) => existing.id !== entry.id));
			setArchiveCount(response.archive.count);
			setConfirmArchiveDeleteId(null);
			onArchiveDeleted?.();
		});
	}

	function renderEntry(entry: EntryCard) {
		const busy = busyId === entry.id;
		return (
			<li className="memory-entry" key={entry.id}>
				<div className="memory-entry-meta" title={noteOriginTitle(entry)}>
					{noteRowMeta({ kind: entryKindLabel(entry.kind), saved: entry.saved, pinned: entry.pinned, status: entry.status })}
				</div>
				{editingId === entry.id ? (
					<div className="memory-entry-edit">
						<textarea value={editText} rows={4} onChange={(event) => setEditText(event.target.value)} aria-label="Note text" />
						<div className="memory-entry-actions">
							<button className="rs-btn" type="button" disabled={busy} onClick={() => void saveEdit(entry)}>{busy ? "Saving…" : "Save"}</button>
							<button className="rs-quiet" type="button" disabled={busy} onClick={() => setEditingId(null)}>Cancel</button>
						</div>
					</div>
				) : (
					<p className="memory-entry-text">{entry.text}</p>
				)}
				{movingId === entry.id && (
					<div className="memory-entry-move">
						<select value={moveTopic} aria-label="Move to topic" onChange={(event) => setMoveTopic(event.target.value)}>
							{topicNames.map((name) => <option key={name} value={name}>{memoryTopicName(name)}</option>)}
							<option value={NEW_TOPIC}>new topic…</option>
						</select>
						{moveTopic === NEW_TOPIC && (
							<input className="create-room-input" type="text" value={moveNewTopic} placeholder="Topic name" aria-label="New topic name" onChange={(event) => setMoveNewTopic(event.target.value)} />
						)}
						<button className="rs-btn" type="button" disabled={busy} onClick={() => void saveMove(entry)}>{busy ? "Moving…" : "Move"}</button>
						<button className="rs-quiet" type="button" disabled={busy} onClick={() => setMovingId(null)}>Cancel</button>
					</div>
				)}
				{confirmDeleteId === entry.id ? (
					<div className="memory-entry-confirm">
						<span>{DELETE_NOTE_QUESTION}</span>
						<button className="rs-btn" type="button" disabled={busy} onClick={() => void confirmDelete(entry)}>{busy ? "Deleting…" : "Delete"}</button>
						<button className="rs-quiet" type="button" disabled={busy} onClick={() => setConfirmDeleteId(null)}>Keep it</button>
					</div>
				) : (
					!readOnly && editingId !== entry.id && movingId !== entry.id && (
						<div className="memory-entry-actions">
							<button className="rs-quiet" type="button" disabled={busy} onClick={() => startEdit(entry)}>Edit</button>
							<button className="rs-quiet" type="button" disabled={busy} onClick={() => void togglePin(entry)}>{entry.pinned ? "Unpin" : "Pin"}</button>
							<button className="rs-quiet" type="button" disabled={busy} onClick={() => startMove(entry)}>Move</button>
							<button className="rs-quiet" type="button" disabled={busy} onClick={() => setConfirmDeleteId(entry.id)}>Delete</button>
						</div>
					)
				)}
			</li>
		);
	}

	function renderTopic(group: TopicGroup) {
		// A search narrows to what matched, so its topics open with it: hiding
		// the matches behind a second click is a search that found nothing.
		const open = openTopics.has(group.title) || query.trim().length > 0;
		return (
			<section className="memory-topic" key={`${group.section}-${group.title}`}>
				<button className="memory-topic-head" type="button" aria-expanded={open} onClick={() => toggleTopic(group.title)}>
					<span className="memory-topic-caret">{open ? "▾" : "▸"}</span>
					<span className="memory-topic-title">{topicRowLine(memoryTopicName(group.title), group.entries.length)}</span>
				</button>
				{open && <ul className="memory-entries">{group.entries.map(renderEntry)}</ul>}
			</section>
		);
	}

	// Every hook above has run; below this line the pane simply stands down.
	if (unavailable) return null;

	return (
		<div className="room-memory-entries">
			<header className="rs-pane-head">
				<h3>Notes</h3>
			</header>
			<p className="rs-pane-sub">{notesSummaryLine(noteCount, topicCount)}</p>
			{readOnly && <p className="rs-row-footnote">{readOnlySentence}</p>}
			{loadError && <div className="room-maintenance-error">{loadError}</div>}
			{actionError && <div className="room-maintenance-error">{actionError}</div>}
			{entries === null && !loadError && <p className="rs-row-hint">{NOTES_LOADING_SENTENCE}</p>}
			{entries !== null && groups.length === 0 && <p className="rs-row-hint">{NOTES_EMPTY_SENTENCE}</p>}
			{entries !== null && groups.length > 0 && (
				<input
					className="create-room-input memory-notes-search"
					type="search"
					value={query}
					placeholder={NOTES_SEARCH_PLACEHOLDER}
					aria-label={NOTES_SEARCH_PLACEHOLDER}
					onChange={(event) => setQuery(event.target.value)}
				/>
			)}
			{entries !== null && groups.length > 0 && filtered.length === 0 && <p className="rs-row-hint">{NOTES_NO_MATCH_SENTENCE}</p>}
			{SECTIONS.map((section) => {
				const sectionGroups = filtered.filter((group) => group.section === section.section);
				if (sectionGroups.length === 0) return null;
				return (
					<div className="memory-note-group" key={section.section}>
						<h4 className="memory-note-group-head">{section.title}</h4>
						{sectionGroups.map(renderTopic)}
					</div>
				);
			})}
			{!readOnly && entries !== null && (
				adding ? (
					<div className="memory-entry-add">
						<label className="rs-row-hint" htmlFor="memory-add-topic">Topic</label>
						<select id="memory-add-topic" value={addTopic} onChange={(event) => setAddTopic(event.target.value)}>
							<option value="">Choose a topic</option>
							{topicNames.map((name) => <option key={name} value={name}>{memoryTopicName(name)}</option>)}
							<option value={NEW_TOPIC}>new topic…</option>
						</select>
						{(addTopic === NEW_TOPIC || addTopic === "") && (
							<input className="create-room-input" type="text" value={addNewTopic} placeholder="Topic name" aria-label="New topic name" onChange={(event) => setAddNewTopic(event.target.value)} />
						)}
						<label className="rs-row-hint" htmlFor="memory-add-kind">Kind</label>
						<select id="memory-add-kind" value={addKind} onChange={(event) => setAddKind(event.target.value as EntryKind)}>
							{KIND_OPTIONS.map((kind) => <option key={kind} value={kind}>{entryKindLabel(kind)}</option>)}
						</select>
						<textarea value={addText} rows={3} placeholder="What should this room remember?" aria-label="Note text" onChange={(event) => setAddText(event.target.value)} />
						<div className="memory-entry-actions">
							<button className="rs-btn" type="button" disabled={busyId === "new-entry"} onClick={() => void addEntry()}>{busyId === "new-entry" ? "Saving…" : "Save note"}</button>
							<button className="rs-quiet" type="button" disabled={busyId === "new-entry"} onClick={() => setAdding(false)}>Cancel</button>
						</div>
					</div>
				) : (
					<button className="rs-btn" type="button" onClick={() => setAdding(true)}>{ADD_NOTE_LABEL}</button>
				)
			)}
			<header className="rs-pane-head memory-archive-head">
				<h3>Archive</h3>
			</header>
			<p className="rs-pane-sub">{archiveSummaryLine(archiveCount)}</p>
			{archive === null ? (
				<button className="rs-btn" type="button" disabled={archiveBusy} onClick={() => void loadArchive()}>
					{archiveBusy ? "Reading…" : "Show the archive"}
				</button>
			) : archive.length === 0 ? (
				<>
					<p className="rs-row-hint">The archive is empty.</p>
					<button className="rs-quiet" type="button" onClick={() => setArchive(null)}>Close</button>
				</>
			) : (
				<>
					<ul className="memory-entries memory-archive-entries">
						{archive.map((entry) => (
							<li className="memory-entry" key={entry.id}>
								<div className="memory-entry-meta">
									<span className="memory-entry-topic">{memoryTopicName(entry.topic)}</span>
									<span className="memory-entry-saved">{archiveRowMeta(entry.archived, entry.why)}</span>
								</div>
								<p className="memory-entry-text">{entry.text}</p>
								{!readOnly && confirmArchiveDeleteId === entry.id ? (
									<div className="memory-entry-confirm">
										<span>{DELETE_ARCHIVED_NOTE_TITLE} {DELETE_ARCHIVED_NOTE_BODY}</span>
										<button className="rs-btn" type="button" disabled={busyId === entry.id} onClick={() => void deleteForGood(entry)}>{busyId === entry.id ? "Deleting…" : DELETE_FOR_GOOD_LABEL}</button>
										<button className="rs-quiet" type="button" disabled={busyId === entry.id} onClick={() => setConfirmArchiveDeleteId(null)}>{KEEP_IT_LABEL}</button>
									</div>
								) : !readOnly && (
									<div className="memory-entry-actions">
										<button className="rs-quiet" type="button" disabled={busyId === entry.id} onClick={() => void restore(entry)}>{busyId === entry.id ? "Restoring…" : "Restore"}</button>
										<button className="rs-quiet rs-quiet-danger" type="button" disabled={busyId === entry.id} onClick={() => setConfirmArchiveDeleteId(entry.id)}>{DELETE_FOR_GOOD_LABEL}</button>
									</div>
								)}
							</li>
						))}
					</ul>
					<div className="memory-entry-actions">
						{archiveNext && (
							<button className="rs-btn" type="button" disabled={archiveBusy} onClick={() => void loadArchive(archiveNext)}>{archiveBusy ? "Reading…" : "Load more"}</button>
						)}
						<button className="rs-quiet" type="button" disabled={archiveBusy} onClick={() => setArchive(null)}>Close</button>
					</div>
				</>
			)}
		</div>
	);
}

/**
 * Everything that has ever changed this room's memory, newest first, and Undo
 * on the newest Memorize or Review while it is still the newest change. The
 * server refuses an undo it can no longer honour with its own sentence, which
 * is shown here rather than replaced by a guess.
 */
export function RoomMemoryHistorySection({ status, onUndone, reloadKey }: { status: PersistentAgentStatus; onUndone?: (response: MemoryUndoResponse) => void; reloadKey?: number }) {
	const [events, setEvents] = useState<MemorySaveEvent[] | null>(null);
	const [unavailable, setUnavailable] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [undoError, setUndoError] = useState<string | null>(null);
	// An undo that took a raised limit back with it says so, in the error's place.
	const [limitLoweredTo, setLimitLoweredTo] = useState<number | null>(null);
	const [undoing, setUndoing] = useState(false);
	// One "What changed" open at a time, by row key.
	const [changeOpen, setChangeOpen] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setEvents(null);
		setChangeOpen(null);
		setUnavailable(false);
		setLoadError(null);
		setUndoError(null);
		setLimitLoweredTo(null);
		fetchMemoryHistory(status.id)
			.then((response) => { if (!cancelled) setEvents(response.history ?? []); })
			.catch((e) => {
				if (cancelled) return;
				const message = (e as Error).message;
				if (/\(404\)/.test(message)) setUnavailable(true);
				else setLoadError(message);
			});
		return () => { cancelled = true; };
	}, [status.id, reloadKey]);

	const rows = useMemo(() => memoryHistoryRows(events ?? []), [events]);
	const undoable = useMemo(() => undoableHistoryRow(rows), [rows]);
	const blocked = memoryEditingBlocked(status);

	async function undo(row: MemoryHistoryRow): Promise<void> {
		if (!row.saveId || undoing) return;
		setUndoing(true);
		setUndoError(null);
		setLimitLoweredTo(null);
		try {
			const undone = await undoMemorySave(status.id, row.saveId);
			const response = await fetchMemoryHistory(status.id);
			setEvents(response.history ?? []);
			setLimitLoweredTo(undone.limitLoweredTo ?? null);
			onUndone?.(undone);
		} catch (e) {
			setUndoError((e as Error).message);
		} finally {
			setUndoing(false);
		}
	}

	if (unavailable) return null;

	return (
		<div className="room-memory-history">
			<header className="rs-pane-head">
				<h3>History</h3>
			</header>
			<p className="rs-pane-sub">{HISTORY_SUB}</p>
			{loadError && <div className="room-maintenance-error">{loadError}</div>}
			{undoError && <div className="room-maintenance-error">{undoError}</div>}
			{events === null && !loadError && <p className="rs-row-hint">Reading this room's history…</p>}
			{events !== null && rows.length === 0 && <p className="rs-row-hint">{HISTORY_EMPTY_SENTENCE}</p>}
			<ul className="memory-history-rows">
				{rows.map((row) => (
					<li className="memory-history-row" key={row.key}>
						<span className="memory-history-when">{fmtMemoryMoment(row.ts)}</span>
						<span className="memory-history-what">{row.words}</span>
						{row.undone && <span className="memory-history-undone">{HISTORY_UNDONE_MARK}</span>}
						{undoable && undoable.key === row.key && !blocked && (
							<button className="rs-quiet" type="button" disabled={undoing} onClick={() => void undo(row)}>{undoing ? "Undoing…" : HISTORY_UNDO_LABEL}</button>
						)}
						{row.diffable && (
							<MemoryChangeFold roomId={status.id} row={row} quiet="rs-quiet" open={changeOpen === row.key} onToggle={() => setChangeOpen((open) => (open === row.key ? null : row.key))} />
						)}
					</li>
				))}
			</ul>
			{limitLoweredTo !== null && <p className="memory-history-status" role="status">{LIMIT_LOWERED_ON_UNDO_SENTENCE(limitLoweredTo)}</p>}
		</div>
	);
}
