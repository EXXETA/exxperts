/**
 * Assets panel projection (assets contract §2, rung 3 — mockup v2).
 *
 * Pure logic for the in-room rail's Artifacts section: the room's ledger rows
 * (room-scoped history, 2026-07-18 — rows survive Memento/checkpoint) + the
 * live task state + the thread's transferred task ids → compact row view-models.
 * The subline is the SINGLE status channel (no state badges); running shows
 * as a pulsing icon, orphaned as a dashed icon + muted title. Kept free of
 * React so the smoke suite can pin every state and the precedence order.
 */

export interface AssetLedgerRowInput {
	taskId: string;
	/** The conversation the task was born in — origin disclosure, viewer-only. */
	conversationId?: string;
	templateId: string;
	templateVersion?: number;
	title: string;
	startedAt: string;
	endedAt?: string;
	outcome: "running" | "ok" | "error" | "aborted" | "orphaned";
	summary?: string;
	artifacts?: { relativePath: string; bytes: number; extension: string }[];
	exports?: { relativePath: string; savedTo: string; at: string }[];
	/** First-open stamp — unset on a done row means the green unread dot. */
	viewedAt?: string;
	/** The task this run revised (task_iterate) — the origin-story chain link. */
	iterateParentTaskId?: string;
}

/** A user-added shelf file (files UI slice) — the panel's second row source, from GET /api/persistent-agents/:id/files. */
export interface ShelfFileRowInput {
	name: string;
	bytes: number;
	mtimeMs: number;
	origin: "room" | "user";
	madeAt?: string;
	extension: string;
}

export interface AssetRowView {
	taskId: string;
	/** Set on user-added rows (files UI slice): the shelf filename the viewer serves via the room-files route. Task rows leave it unset. */
	userFileName?: string;
	title: string;
	/** Icon-box label, e.g. "SVG" / "HTML" — empty while running (the pulse is the icon). */
	iconLabel: string;
	running: boolean;
	orphan: boolean;
	/** The single status channel: a status word alone, or the time on plain done rows. */
	subline: string;
	/**
	 * Status grammar (2026-07-18): done-and-never-opened — the steady green dot
	 * plus a "ready · time" subline. Decays to the plain row on first open.
	 */
	unread: boolean;
	/** "didn't finish" rows — the steady danger dot beside the shipped subline. */
	failed: boolean;
	inConversation: boolean;
	/**
	 * Origin disclosure for rows born in another conversation (room-scoped
	 * history, 2026-07-18): "From an earlier thread · Jul 12". Empty for rows
	 * of the live conversation — the rail subline never carries origin; the
	 * viewer header is its only surface.
	 */
	originLine: string;
	templateId: string;
	templateVersion: number;
	summary: string;
	generatedAt: string;
	artifacts: { relativePath: string; bytes: number; extension: string }[];
}

export interface ProjectAssetRowsInput {
	/**
	 * The live connection's running task, overlaid on (or prepended to) the
	 * ledger rows. `reviseTargetNames` (taste pass) names the shelf files a
	 * revise run is rewriting IN PLACE: those rows carry the working state
	 * themselves and no separate row is added, because an Ask-for-changes
	 * produces no new file and a second row said otherwise for as long as the
	 * run lived. A run that makes new files leaves it empty and keeps the
	 * working row.
	 */
	liveTask?: { taskId: string; title: string; templateId: string; reviseTargetNames?: readonly string[] } | null;
	/** taskIds of kind:"task" items already in the thread — the "in conversation" fact. */
	threadTaskIds: ReadonlySet<string>;
	/** The live conversation — rows born elsewhere get the viewer origin line. */
	liveConversationId?: string;
	/**
	 * The shelf's live truth (files-management slice): the set of names that
	 * actually exist on the shelf right now. When provided, task-row artifacts
	 * pointing at deleted shelf files drop, and a row whose every file is gone
	 * disappears — Delete really deletes, and the panel agrees with the folder
	 * instantly. Omit (undefined) while the shelf listing has not loaded yet,
	 * so a slow fetch never blanks the panel.
	 */
	shelfTruth?: ReadonlySet<string>;
	now: Date;
}

/**
 * The projection's shelfTruth claim for the current room — or undefined while
 * the loaded listing is not known-good for EXACTLY this room, so the
 * projection makes no shelf claims and file rows stay put. The known-for id
 * must reset together with the listing on every room change (App's room-change
 * effect; critical-fixes regression): a knownFor left standing across leave +
 * re-enter turns the just-emptied listing into an authoritative "the shelf is
 * empty" claim, and every file row vanishes until (unless) the refetch lands.
 */
export function shelfTruthForRoom(agentId: string | null | undefined, knownForAgentId: string | null, fileNames: readonly string[]): ReadonlySet<string> | undefined {
	if (!agentId || knownForAgentId !== agentId) return undefined;
	return new Set(fileNames);
}

/** "diagram-svg" → "diagram": the subline wants the family, not the registry id. */
export function assetTemplateShortName(templateId: string): string {
	const id = String(templateId ?? "").trim();
	return id.includes("-") ? id.slice(0, id.indexOf("-")) : id;
}

/**
 * Row titles name the THING, not the instruction (2026-07-18 live test: every
 * document task in a room shared the brief's "Create a polished…" prefix).
 * Prettified primary-artifact filename — extension dropped, dashes/underscores
 * to spaces. Rows without files keep the task title: nothing to name them yet.
 */
export function assetDisplayTitle(taskTitle: string, artifacts: AssetLedgerRowInput["artifacts"]): string {
	const name = artifacts?.[0]?.relativePath?.split("/").pop() ?? "";
	const stem = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
	const pretty = stem.replace(/[-_]+/g, " ").trim();
	return pretty || taskTitle;
}

function iconLabelForRow(artifacts: AssetLedgerRowInput["artifacts"]): string {
	const extension = artifacts?.[0]?.extension ?? "";
	// Four characters cover the real registry outputs (HTML, PPTX, XLSX, SVG);
	// a 3-char cap rendered HTML as a truncated-looking "HTM".
	const cleaned = extension.replace(/^\./, "").toUpperCase();
	return cleaned.slice(0, 4) || "TXT";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shortTime(iso: string | undefined, now: Date): string {
	if (!iso) return "";
	const when = new Date(iso);
	if (Number.isNaN(when.getTime())) return "";
	const sameDay = when.getFullYear() === now.getFullYear() && when.getMonth() === now.getMonth() && when.getDate() === now.getDate();
	if (sameDay) return `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
	return `${MONTHS[when.getMonth()]} ${when.getDate()}`;
}

/**
 * Unread = done, has files, never opened, never acted on. Attach and export
 * imply the user has seen the result, so their sublines stand and the green
 * dot never appears over them.
 */
function isUnreadRow(row: AssetLedgerRowInput, input: ProjectAssetRowsInput): boolean {
	if (row.outcome !== "ok" || (row.artifacts?.length ?? 0) === 0) return false;
	if (row.viewedAt) return false;
	if (input.threadTaskIds.has(row.taskId)) return false;
	if ((row.exports?.length ?? 0) > 0) return false;
	return true;
}

function withTime(word: string, row: AssetLedgerRowInput, input: ProjectAssetRowsInput): string {
	const when = shortTime(row.endedAt ?? row.startedAt, input.now);
	return when ? `${word} · ${when}` : word;
}

function sublineForRow(row: AssetLedgerRowInput, input: ProjectAssetRowsInput): string {
	// Precedence: the most conversation-relevant fact wins; the subline stays a
	// single channel by design (thumbnails/badges dissolved at the grill).
	// Status words stand alone (language pass 2026-07-18). "in workspace" is
	// GONE entirely (files-management slice): snapshot destinations are not
	// file state — an export changes nothing about the file on the shelf.
	if (input.threadTaskIds.has(row.taskId)) return withTime("in conversation", row, input);
	// Plain "stopped": under option 4 the only way a task aborts is the user
	// pressing Stop — leaving a room no longer kills tasks, so the old
	// "stopped when you left" claim would be wrong for the normal case.
	if (row.outcome === "aborted") return "stopped";
	if (row.outcome === "orphaned") {
		const dated = shortTime(row.endedAt ?? row.startedAt, input.now);
		return dated ? `${dated} · past session` : "past session";
	}
	if (row.outcome === "error") return "didn't finish";
	const when = shortTime(row.endedAt ?? row.startedAt, input.now);
	// Unread rows lead with the ready word (status grammar, 2026-07-18): the
	// green dot says "news", the subline says what kind. Decays on first open.
	if (isUnreadRow(row, input)) return when ? `ready · ${when}` : "ready";
	// Resting rows read verb + moment, one grammar for the whole list (taste
	// pass): "created · Jul 23" beside "attached · 17:14". The bare date the
	// row grammar used to rest on made room-made files the only rows whose
	// subline named no act at all — two formats in one list, and the quieter
	// one belonged to the files the room itself wrote.
	return when ? `created · ${when}` : "created";
}

/**
 * "From an earlier thread · Jul 12" — only for rows whose birth conversation
 * is known and differs from the live one. Both ids unknown → no claim made.
 */
function originLineForRow(row: AssetLedgerRowInput, input: ProjectAssetRowsInput): string {
	const born = String(row.conversationId ?? "").trim();
	const live = String(input.liveConversationId ?? "").trim();
	if (!born || !live || born === live) return "";
	const when = shortTime(row.endedAt ?? row.startedAt, input.now);
	return when ? `From an earlier thread · ${when}` : "From an earlier thread";
}

/**
 * The row's origin story, compressed to one viewer line (revise-in-place:
 * rows are files, runs accumulate INSIDE the row): walk the iterate chain to
 * the run that first made the file. "Created Jul 21 · revised Jul 27", with a
 * count once there is more than one revision. A chain whose root the ledger
 * no longer shows still tells the honest part: "Revised Jul 27".
 */
function reviseStoryForRow(row: AssetLedgerRowInput, rowsById: ReadonlyMap<string, AssetLedgerRowInput>, input: ProjectAssetRowsInput): string {
	if (!row.iterateParentTaskId) return "";
	const seen = new Set<string>([row.taskId]);
	let cursor: AssetLedgerRowInput = row;
	let revisions = 0;
	while (cursor.iterateParentTaskId) {
		const parent = rowsById.get(cursor.iterateParentTaskId);
		revisions += 1;
		if (!parent || seen.has(parent.taskId)) {
			// Root fell off the ledger (or a cyclic record — never loop): claim
			// only what is known.
			const revised = shortTime(row.endedAt ?? row.startedAt, input.now);
			return revised ? `Revised ${revised}` : "";
		}
		seen.add(parent.taskId);
		cursor = parent;
	}
	const created = shortTime(cursor.endedAt ?? cursor.startedAt, input.now);
	const revised = shortTime(row.endedAt ?? row.startedAt, input.now);
	if (!created || !revised) return revised ? `Revised ${revised}` : "";
	return revisions > 1 ? `Created ${created} · revised ${revisions} times, last ${revised}` : `Created ${created} · revised ${revised}`;
}

function shortDate(ms: number, now: Date): string {
	return shortTime(new Date(ms).toISOString(), now);
}

/**
 * User-added shelf files as rows (files UI slice): origin === "user" only —
 * room-made shelf files are already represented by their task rows. The
 * synthetic taskId (`file:<name>`) keys the list and the viewer selection;
 * `userFileName` routes the viewer to the room-files endpoint.
 */
function projectUserFileRows(shelfFiles: ShelfFileRowInput[], input: ProjectAssetRowsInput, revisingNames: ReadonlySet<string>): AssetRowView[] {
	return shelfFiles
		.filter((file) => file.origin === "user")
		.map((file) => {
			const stem = file.name.includes(".") ? file.name.slice(0, file.name.lastIndexOf(".")) : file.name;
			const when = shortDate(file.mtimeMs, input.now);
			const updating = revisingNames.has(file.name);
			return {
				taskId: `file:${file.name}`,
				userFileName: file.name,
				title: stem.replace(/[-_]+/g, " ").trim() || file.name,
				iconLabel: file.extension.replace(/^\./, "").toUpperCase().slice(0, 4) || "TXT",
				running: updating,
				orphan: false,
				subline: updating ? "updating…" : when ? `attached · ${when}` : "attached",
				unread: false,
				failed: false,
				inConversation: false,
				originLine: "",
				templateId: "",
				templateVersion: 1,
				summary: "",
				generatedAt: new Date(file.mtimeMs).toISOString(),
				artifacts: [{ relativePath: `files/${file.name}`, bytes: file.bytes, extension: file.extension }],
			};
		});
}

/** Newest-first row view-models. The live running task always leads; task rows and user-added files interleave by recency. */
export function projectAssetRows(rows: AssetLedgerRowInput[], input: ProjectAssetRowsInput, shelfFiles: ShelfFileRowInput[] = []): AssetRowView[] {
	const liveTaskId = input.liveTask?.taskId ?? null;
	const out: AssetRowView[] = [];
	// A revise run rewrites files that already have rows, so it gets no row of
	// its own: the targets carry "updating…" until it lands (taste pass). Only
	// names that actually match a row count — if a target's row is gone (deleted
	// mid-run), the run would otherwise become invisible, so the working row
	// stands in.
	const reviseTargets = new Set(input.liveTask?.reviseTargetNames ?? []);
	const revisingNames = reviseTargets.size > 0
		? new Set(
			[
				...rows.flatMap((row) => (row.artifacts ?? []).map((artifact) => artifact.relativePath)),
				...shelfFiles.map((file) => `files/${file.name}`),
			]
				.filter((relativePath) => relativePath.startsWith("files/"))
				.map((relativePath) => relativePath.slice("files/".length))
				.filter((name) => reviseTargets.has(name)),
		)
		: new Set<string>();
	const revising = revisingNames.size > 0;
	/** The row stands for a file this live revise run is rewriting. */
	const isReviseTargetRow = (artifacts: { relativePath: string }[]): boolean =>
		revising && artifacts.some((artifact) => artifact.relativePath.startsWith("files/") && revisingNames.has(artifact.relativePath.slice("files/".length)));
	if (input.liveTask && !revising) {
		out.push({
			taskId: input.liveTask.taskId,
			title: input.liveTask.title || "Specialist task",
			iconLabel: "",
			running: true,
			orphan: false,
			subline: "working…",
			unread: false,
			failed: false,
			inConversation: false,
			originLine: "",
			templateId: input.liveTask.templateId,
			templateVersion: 1,
			summary: "",
			generatedAt: "",
			artifacts: [],
		});
	}
	const sorted = [...rows].sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
	const rowsById = new Map(rows.map((row) => [row.taskId, row]));
	// Rows are files (revise-in-place): a shelf file shows exactly one row —
	// the newest run that owns it. Walking newest-first, each files/ path is
	// claimed once; an older run whose files are ALL claimed by newer runs
	// folds into their origin story instead of piling up as a near-identical
	// row. Runs with tasks/ paths (legacy, in-flight) or any unclaimed file
	// keep their row — folding never hides work that has no other row.
	const claimedShelfPaths = new Set<string>();
	for (const row of sorted) {
		if (row.taskId === liveTaskId) continue;
		// Shelf truth first: a deleted file's artifact drops, and a row that
		// listed only deleted files drops with it (rows are files; the file is
		// gone). Rows that never had artifacts (errors, running) are untouched.
		let rowArtifacts = row.artifacts ?? [];
		if (input.shelfTruth && rowArtifacts.length > 0) {
			const kept = rowArtifacts.filter((artifact) => !artifact.relativePath.startsWith("files/") || input.shelfTruth!.has(artifact.relativePath.slice("files/".length)));
			if (kept.length === 0) continue;
			rowArtifacts = kept;
		}
		const shelfPaths = rowArtifacts.map((artifact) => artifact.relativePath).filter((relativePath) => relativePath.startsWith("files/"));
		const folded = shelfPaths.length > 0 && shelfPaths.length === rowArtifacts.length && shelfPaths.every((relativePath) => claimedShelfPaths.has(relativePath));
		if (folded) continue;
		for (const relativePath of shelfPaths) claimedShelfPaths.add(relativePath);
		// Option 4: a `running` ledger row that is not this connection's live
		// task is a surviving background delegation whose replay hasn't bound
		// yet (the REST fetch can resolve before the WS replay) — show it
		// running. Workers that died with the process are marked orphaned by
		// the boot sweep, never guessed at here.
		const updating = isReviseTargetRow(rowArtifacts);
		const running = row.outcome === "running" || updating;
		const orphan = !updating && row.outcome === "orphaned";
		out.push({
			taskId: row.taskId,
			title: assetDisplayTitle(row.title || "Specialist task", rowArtifacts),
			iconLabel: iconLabelForRow(rowArtifacts),
			running,
			orphan,
			// "updating…" and not "working…": the file already exists and is being
			// changed in place, which is a different promise than a run that will
			// leave something new behind.
			subline: updating ? "updating…" : running ? "working…" : sublineForRow(row, input),
			unread: !orphan && !running && isUnreadRow(row, input),
			failed: row.outcome === "error",
			inConversation: input.threadTaskIds.has(row.taskId),
			// The revise origin story wins the one viewer line when present (a
			// revised row's history IS its origin); plain rows keep the
			// earlier-thread disclosure.
			originLine: reviseStoryForRow(row, rowsById, input) || originLineForRow(row, input),
			templateId: row.templateId,
			templateVersion: typeof row.templateVersion === "number" && row.templateVersion >= 1 ? row.templateVersion : 1,
			summary: row.summary ?? "",
			generatedAt: row.endedAt ?? row.startedAt,
			artifacts: rowArtifacts,
		});
	}
	const userRows = projectUserFileRows(shelfFiles, input, revisingNames);
	if (userRows.length === 0) return out;
	// Interleave by recency below the live row: one list, ordered by when each
	// file arrived on the shelf, whoever put it there.
	const lead = input.liveTask ? out.slice(0, 1) : [];
	const rest = input.liveTask ? out.slice(1) : out;
	const merged = [...rest, ...userRows].sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : a.generatedAt > b.generatedAt ? -1 : 0));
	return [...lead, ...merged];
}

/**
 * The one shelf file a row stands for, when it stands for exactly one: user
 * rows always; done task rows whose single artifact is a shelf file. These are
 * the "file rows" that get the real Delete and the inline rename — a
 * multi-file or legacy tasks/ row is a run, not a file, and keeps the run
 * affordances (remove-from-list; the viewer's orphan Delete).
 */
export function rowShelfFileName(row: AssetRowView): string | null {
	if (row.userFileName) return row.userFileName;
	if (row.running || row.orphan) return null;
	if (row.artifacts.length !== 1) return null;
	const relativePath = row.artifacts[0]!.relativePath;
	return relativePath.startsWith("files/") ? relativePath.slice("files/".length) : null;
}

export const ASSET_PANEL_DEFAULT_VISIBLE = 3;

/**
 * The resting window: newest rows up to `visibleCount` unless expanded. The
 * component passes a height-derived count (files-management slice: the panel
 * shows as many rows as the sidebar fits, 8–10 typical, before "Show all");
 * the constant stays the conservative fallback for callers without a height.
 */
export function windowAssetRows(rows: AssetRowView[], showAll: boolean, visibleCount: number = ASSET_PANEL_DEFAULT_VISIBLE): { visible: AssetRowView[]; hiddenCount: number } {
	const count = Number.isFinite(visibleCount) && visibleCount >= 1 ? Math.floor(visibleCount) : ASSET_PANEL_DEFAULT_VISIBLE;
	if (showAll || rows.length <= count) return { visible: rows, hiddenCount: 0 };
	return { visible: rows.slice(0, count), hiddenCount: rows.length - count };
}
