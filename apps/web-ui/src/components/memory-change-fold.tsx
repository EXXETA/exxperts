// "What changed" under one history row, on both memory surfaces: the notes
// before and after that one save, topic by topic, from the stored copies the
// server kept. The row's list decides which fold is open (one at a time); this
// component owns the fetch, the rows and full screen. A read that failed is
// not remembered, so opening the row again tries again.
//
// The server pairs the two copies note by note when both read as notes: then
// each topic lists what was added, updated, moved or archived, and the waiting
// conversations that left or came back close the fold. A copy that does not
// read as notes is compared line by line instead, as it always was.

import { useEffect, useMemo, useRef, useState } from "react";
import { fetchJson } from "../api";
import { coalesceRuns, diffHunks, diffLines, diffWords, plainNoteText, type DiffHunk, type DiffLine } from "../memory-diff";
import {
	archivedLabel,
	CHANGE_CONVERSATIONS_BLOCK,
	CHANGE_NONE,
	CHANGE_READ_ERROR,
	CHANGE_READING,
	changeMetaLine,
	countNoteChanges,
	emptyNoteChangeCounts,
	EXIT_FULL_SCREEN_LABEL,
	FULL_SCREEN_LABEL,
	HIDE_CHANGE_LABEL,
	memoryTopicName,
	movedLabel,
	noteChangeTotals,
	noteFlagLabel,
	READING_FULL_SCREEN_NOTE,
	topicChangeSummary,
	WHAT_CHANGED_LABEL,
	type MemoryHistoryRow,
	type NoteChangeCounts,
	type NoteChangeKind,
} from "../memory-surface-copy";

interface ChangeSection {
	section: string;
	beforeText: string;
	afterText: string;
}

/** One note's change between the two copies. */
interface NoteChange {
	id: string;
	change: NoteChangeKind;
	before?: string;
	after?: string;
	from?: string;
	why?: string;
}

interface ChangeTopic {
	section: string;
	changes: NoteChange[];
}

/** The event-diff route's answer: the notes that changed per topic, or the changed lines when the copies do not read as notes. */
interface EventDiff {
	kind: string;
	eventId: string;
	approvedAt: string;
	notes?: boolean;
	topics?: ChangeTopic[];
	conversations?: { left: string[]; joined: string[] };
	sections?: ChangeSection[];
	afterBasis: string | null;
	afterVerified: boolean | null;
}

type ChangeState = { state: "loading" } | { state: "error" } | { state: "ready"; data: EventDiff };

/** One topic's block in the note view, its rows counted once. */
interface TopicBlock {
	name: string;
	summary: string;
	changes: NoteChange[];
}

interface NoteView {
	totals: string;
	topics: TopicBlock[];
	left: string[];
	joined: string[];
}

function noteViewOf(data: EventDiff): NoteView {
	const counts = emptyNoteChangeCounts();
	const topics: TopicBlock[] = [];
	for (const topic of data.topics ?? []) {
		if (topic.changes.length === 0) continue;
		const own = countNoteChanges(topic.changes);
		countNoteChanges(topic.changes, counts);
		topics.push({ name: memoryTopicName(topic.section), summary: topicChangeSummary(own), changes: topic.changes });
	}
	const left = data.conversations?.left ?? [];
	const joined = data.conversations?.joined ?? [];
	counts.left = left.length;
	counts.joined = joined.length;
	return { totals: noteChangeTotals(counts), topics, left, joined };
}

/** The old text with its removed words struck, or the new text with its added words marked. */
function WordLine({ tokens, side }: { tokens: DiffLine[]; side: "del" | "add" }) {
	const shown = tokens.filter((t) => t.type === "same" || t.type === side);
	return (
		<span className="mem-diff-text">
			{shown.map((t, i) => (
				<span key={i}>
					{i > 0 ? " " : ""}
					{t.type === side ? <span className={`mem-diff-word ${side}`}>{t.text}</span> : t.text}
				</span>
			))}
		</span>
	);
}

function NoteRow({ row }: { row: NoteChange }) {
	const after = plainNoteText(row.after ?? "");
	const before = plainNoteText(row.before ?? "");
	if (row.change === "added") {
		return (
			<div className="mem-diff-line add mem-diff-note-row">
				<span className="mem-diff-mark">+</span>
				<span className="mem-diff-text">{after || " "}</span>
			</div>
		);
	}
	if (row.change === "archived") {
		return (
			<div className="mem-diff-line del mem-diff-note-row">
				<span className="mem-diff-mark">−</span>
				<span className="mem-diff-text">{before || " "}</span>
				<span className="mem-diff-label">{archivedLabel(row.why)}</span>
			</div>
		);
	}
	if (row.change === "updated") {
		const tokens = diffWords(before, after);
		return (
			<>
				<div className="mem-diff-line del mem-diff-note-row">
					<span className="mem-diff-mark">−</span>
					<WordLine tokens={tokens} side="del" />
				</div>
				<div className="mem-diff-line upd mem-diff-note-row">
					<span className="mem-diff-mark"> </span>
					<WordLine tokens={tokens} side="add" />
					{row.from ? <span className="mem-diff-label">{movedLabel(row.from)}</span> : null}
				</div>
			</>
		);
	}
	const label = row.change === "moved" ? movedLabel(row.from ?? "") : noteFlagLabel(row.change);
	return (
		<div className="mem-diff-line upd mem-diff-note-row">
			<span className="mem-diff-mark"> </span>
			<span className="mem-diff-text">{after || before || " "}</span>
			<span className="mem-diff-label">{label}</span>
		</div>
	);
}

/**
 * The button at the row's end and, when open, the fold under it. `quiet` is
 * the surface's own quiet-button class, so the fold reads as part of the list
 * it sits in. Rendered inside the row's flex line: the button takes the end of
 * the line and the fold wraps to a full-width line beneath.
 */
export function MemoryChangeFold({ roomId, row, open, onToggle, quiet }: { roomId: string; row: MemoryHistoryRow; open: boolean; onToggle: () => void; quiet: "rs-quiet" | "mem-close" }) {
	const [change, setChange] = useState<ChangeState | null>(null);
	const [full, setFull] = useState(false);
	// The effect below decides whether to read by what is already held, without
	// re-running every time the answer lands.
	const held = useRef<ChangeState | null>(null);
	held.current = change;

	useEffect(() => {
		if (!open) { setFull(false); return; }
		if (!row.eventId) return;
		if (held.current && held.current.state !== "error") return;
		let cancelled = false;
		setChange({ state: "loading" });
		fetchJson<EventDiff>(`/api/memory/rooms/${encodeURIComponent(roomId)}/event-diff?kind=${encodeURIComponent(row.kind)}&event=${encodeURIComponent(row.eventId)}`)
			.then((data) => { if (!cancelled) setChange({ state: "ready", data }); })
			.catch(() => { if (!cancelled) setChange({ state: "error" }); });
		return () => { cancelled = true; };
	}, [open, roomId, row.kind, row.eventId]);

	useEffect(() => {
		if (!full) return;
		const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFull(false); };
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [full]);

	// Computed once per fetched pair, not per render: the note view counts every
	// topic's rows, the line view walks both texts of every changed topic.
	const view = useMemo<{ notes: NoteView } | { lines: Array<{ name: string; hunks: DiffHunk[] }> } | null>(
		() => {
			if (change?.state !== "ready") return null;
			if (change.data.notes === true) return { notes: noteViewOf(change.data) };
			return { lines: (change.data.sections ?? []).map((sec) => ({ name: memoryTopicName(sec.section), hunks: diffHunks(coalesceRuns(diffLines(sec.beforeText, sec.afterText))) })) };
		},
		[change],
	);

	const button = (
		<button type="button" className={`${quiet} memory-history-toggle`} aria-expanded={open} onClick={onToggle}>
			{open ? HIDE_CHANGE_LABEL : WHAT_CHANGED_LABEL}
		</button>
	);
	if (!open) return button;

	const empty = !view || ("notes" in view ? view.notes.topics.length === 0 && view.notes.left.length === 0 && view.notes.joined.length === 0 : view.lines.length === 0);

	let body: JSX.Element;
	if (!change || change.state === "loading") body = <div className="mem-diff-note">{CHANGE_READING}</div>;
	else if (change.state === "error") body = <div className="mem-diff-note">{CHANGE_READ_ERROR}</div>;
	else if (!view || empty) body = <div className="mem-diff-note">{CHANGE_NONE}</div>;
	else {
		const meta = (
			<div className="mem-diff-meta">
				<span className="mem-diff-note">{changeMetaLine(row.kind, change.data.afterVerified, "notes" in view)}</span>
				<button type="button" className="mem-close" onClick={() => setFull((v) => !v)}>{full ? EXIT_FULL_SCREEN_LABEL : FULL_SCREEN_LABEL}</button>
			</div>
		);
		body = "notes" in view ? (
			<div className="mem-diff">
				{meta}
				{view.notes.totals ? <div className="mem-diff-totals">{view.notes.totals}</div> : null}
				{view.notes.topics.map((topic, k) => (
					<div key={k} className="mem-diff-hunk">
						<div className="mem-diff-sec"><span>{topic.name}</span><span className="mem-diff-sec-sum">{topic.summary}</span></div>
						<div className="mem-diff-lines">
							{topic.changes.map((c) => <NoteRow key={c.id} row={c} />)}
						</div>
					</div>
				))}
				{(view.notes.left.length > 0 || view.notes.joined.length > 0) && (
					<div className="mem-diff-hunk">
						<div className="mem-diff-sec"><span>{CHANGE_CONVERSATIONS_BLOCK}</span></div>
						<div className="mem-diff-lines">
							{view.notes.left.map((title, i) => (
								<div key={`l${i}`} className="mem-diff-line del mem-diff-note-row">
									<span className="mem-diff-mark">−</span>
									<span className="mem-diff-text">{title || " "}</span>
								</div>
							))}
							{view.notes.joined.map((title, i) => (
								<div key={`j${i}`} className="mem-diff-line add mem-diff-note-row">
									<span className="mem-diff-mark">+</span>
									<span className="mem-diff-text">{title || " "}</span>
								</div>
							))}
						</div>
					</div>
				)}
			</div>
		) : (
			<div className="mem-diff">
				{meta}
				{view.lines.map((sec, k) => (
					<div key={k} className="mem-diff-hunk">
						<div className="mem-diff-sec"><span>{sec.name}</span></div>
						<div className="mem-diff-lines">
							{sec.hunks.map((h, hk) => (
								<div key={hk} className="mem-diff-hunk-lines">
									{h.lines.map((l, j) => (
										<div key={j} className={`mem-diff-line ${l.type}`}>
											<span className="mem-diff-mark">{l.type === "add" ? "+" : l.type === "del" ? "−" : " "}</span>
											<span className="mem-diff-text">{l.text || " "}</span>
										</div>
									))}
								</div>
							))}
						</div>
					</div>
				))}
			</div>
		);
	}

	return (
		<>
			{button}
			<div className="memory-history-change">
				{full ? (
					<>
						<div className="mem-diff-note">{READING_FULL_SCREEN_NOTE}</div>
						<div className="mem-fullscreen" role="dialog" aria-modal="true" aria-label="Memory change, full screen">
							<div className="mem-fullscreen-inner chart-block">{body}</div>
						</div>
					</>
				) : body}
			</div>
		</>
	);
}
