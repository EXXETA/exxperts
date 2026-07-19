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
}

export interface AssetRowView {
	taskId: string;
	title: string;
	/** Icon-box label, e.g. "SVG" / "HTM" — empty while running (the pulse is the icon). */
	iconLabel: string;
	running: boolean;
	orphan: boolean;
	/** The single status channel: a status word alone, or `filetype · time` on plain done rows. */
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
	/** The live connection's running task, overlaid on (or prepended to) the ledger rows. */
	liveTask?: { taskId: string; title: string; templateId: string } | null;
	/** taskIds of kind:"task" items already in the thread — the "in conversation" fact. */
	threadTaskIds: ReadonlySet<string>;
	/** The live conversation — rows born elsewhere get the viewer origin line. */
	liveConversationId?: string;
	now: Date;
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
	const cleaned = extension.replace(/^\./, "").toUpperCase();
	return cleaned.slice(0, 3) || "TXT";
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

function sublineForRow(row: AssetLedgerRowInput, input: ProjectAssetRowsInput): string {
	// Precedence: the most conversation-relevant fact wins; the subline stays a
	// single channel by design (thumbnails/badges dissolved at the grill).
	// Status words stand alone; only plain done rows carry the file type —
	// "informative, not invasive" (language pass 2026-07-18).
	if (input.threadTaskIds.has(row.taskId)) return "in conversation";
	if ((row.exports?.length ?? 0) > 0) return "in workspace";
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
	const fileType = (row.artifacts?.[0]?.extension ?? "").replace(/^\./, "").toLowerCase();
	return fileType ? (when ? `${fileType} · ${when}` : fileType) : when;
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

/** Newest-first row view-models. The live running task always leads. */
export function projectAssetRows(rows: AssetLedgerRowInput[], input: ProjectAssetRowsInput): AssetRowView[] {
	const liveTaskId = input.liveTask?.taskId ?? null;
	const out: AssetRowView[] = [];
	if (input.liveTask) {
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
	for (const row of sorted) {
		if (row.taskId === liveTaskId) continue;
		// Option 4: a `running` ledger row that is not this connection's live
		// task is a surviving background delegation whose replay hasn't bound
		// yet (the REST fetch can resolve before the WS replay) — show it
		// running. Workers that died with the process are marked orphaned by
		// the boot sweep, never guessed at here.
		const running = row.outcome === "running";
		const orphan = row.outcome === "orphaned";
		out.push({
			taskId: row.taskId,
			title: assetDisplayTitle(row.title || "Specialist task", row.artifacts),
			iconLabel: iconLabelForRow(row.artifacts),
			running,
			orphan,
			subline: running ? "working…" : sublineForRow(row, input),
			unread: !orphan && !running && isUnreadRow(row, input),
			failed: row.outcome === "error",
			inConversation: input.threadTaskIds.has(row.taskId),
			originLine: originLineForRow(row, input),
			templateId: row.templateId,
			templateVersion: typeof row.templateVersion === "number" && row.templateVersion >= 1 ? row.templateVersion : 1,
			summary: row.summary ?? "",
			generatedAt: row.endedAt ?? row.startedAt,
			artifacts: row.artifacts ?? [],
		});
	}
	return out;
}

export const ASSET_PANEL_DEFAULT_VISIBLE = 3;

/** The resting window: newest `ASSET_PANEL_DEFAULT_VISIBLE` rows unless expanded. */
export function windowAssetRows(rows: AssetRowView[], showAll: boolean): { visible: AssetRowView[]; hiddenCount: number } {
	if (showAll || rows.length <= ASSET_PANEL_DEFAULT_VISIBLE) return { visible: rows, hiddenCount: 0 };
	return { visible: rows.slice(0, ASSET_PANEL_DEFAULT_VISIBLE), hiddenCount: rows.length - ASSET_PANEL_DEFAULT_VISIBLE };
}
