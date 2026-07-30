/**
 * The two-writers notice — the ONE sentence the app uses when a revise run's
 * target changed underneath it, so the revision landed beside the file instead
 * of over it.
 *
 * Deliberately pure (no node imports, sibling of specialist-handoff.ts) so the
 * web UI imports this source directly and the sentence the user reads is
 * byte-identical to the one the room's context receives. Before this the
 * server and the client each wrote their own wording for the same event; two
 * strings for one fact drift, and the taste pass found them already drifted
 * ("was saved as" vs "is in Files as").
 *
 * The visible path is the STRUCTURED one: the `reviseConflicts` field on
 * `task_end` (live) and on the away notice (tab closed). The same sentence is
 * also appended to the specialist's summary so the room's own context carries
 * it — but never rely on that copy for the user's eyes, because the summary is
 * trimmed from the end and a long narration can push the sentence out.
 */

export interface ReviseConflictNotice {
	/** The canonical shelf file that was NOT overwritten. */
	name: string;
	/** The collision name the revision landed under instead, when it landed at all. */
	savedAs?: string;
}

/** One conflict, one sentence: what changed, what was refused, where the work went. */
export function reviseConflictSentence(conflict: ReviseConflictNotice): string {
	const name = String(conflict?.name ?? "").trim() || "The file";
	const savedAs = String(conflict?.savedAs ?? "").trim();
	return savedAs
		? `“${name}” changed while the specialist worked, so it was not overwritten — the revision is in Files as “${savedAs}”.`
		: `“${name}” changed while the specialist worked, so it was not overwritten.`;
}

/** Every conflict of one run, one sentence per line. */
export function reviseConflictNotice(conflicts: readonly ReviseConflictNotice[]): string {
	return conflicts.map(reviseConflictSentence).join("\n");
}

/**
 * Tolerant read for wire/stored data (a frame field, a ledger row): drops junk
 * rather than throwing, because a malformed record must never cost the user
 * the notice for the well-formed ones beside it.
 */
export function readReviseConflicts(raw: unknown): ReviseConflictNotice[] {
	if (!Array.isArray(raw)) return [];
	const out: ReviseConflictNotice[] = [];
	for (const entry of raw) {
		const name = String((entry as { name?: unknown })?.name ?? "").trim();
		if (!name) continue;
		const savedAs = String((entry as { savedAs?: unknown })?.savedAs ?? "").trim();
		out.push(savedAs ? { name, savedAs } : { name });
	}
	return out;
}
