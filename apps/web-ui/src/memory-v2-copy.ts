// Memorize v2 reads a run, not a finished draft: the server reports numbers
// and outcomes, this module turns them into the sentences a person reads and
// into the two verdicts the flow needs (which screen a run is on, and whether
// automatic maintenance may apply it). Keeping it pure means the copy and the
// gate are checkable without a browser — see
// apps/web-server/scripts/memory-v2-copy-smoke.ts.

import type { AbsorbRun, AbsorbRunChange, AbsorbRunChangeKind, AbsorbRunSession, ArchivedEntryCard, ArchiveRow, EntryCard, EntryKind, MemoryModelStopCause, ReviewDepth, ReviewRun, ReviewRunChange, ReviewRunChangeKind, RunBudget, RunDemotion } from "./types";
import { fmtMemoryDay } from "./memory-surface-copy";
import { modelDisplayName } from "./model-names";
import { knownRemoteClientContext } from "./remote-client-context";
import { GATEWAY_REFUSED_CAUSE, gatewayNotFoundLine, gatewayRefusedWayOn, quotaCause, quotaWayOn, REGION_OR_PLAN_CAUSE, unreachedCause, unreachedWayOn, type GatewayFind, type QuotaWay, type Unreached } from "./turn-failure-line";
import { notOnAccountWhy } from "../../web-server/src/model-not-on-account";
import { credentialGoneOf, credentialGoneWhy, credentialGoneWords, type CredentialKey } from "../../web-server/src/model-not-offered";

/** Token counts are read, not scanned: group them the way the budget line does. */
export function fmtTokenCount(value: number): string {
	return Math.round(value).toLocaleString("en-US");
}

/** Which screen a run belongs on. The three working states share one screen. */
export type AbsorbRunScreen = "running" | "ready" | "approving" | "saved" | "cancelled" | "failed";

export function absorbRunScreen(state: AbsorbRun["state"]): AbsorbRunScreen {
	if (state === "prepass" || state === "folding" || state === "budget") return "running";
	return state;
}

export function absorbRunIsWorking(state: AbsorbRun["state"]): boolean {
	return absorbRunScreen(state) === "running";
}

/**
 * The headline of the working screen. "Folding" is the engine's word for it and
 * never reaches a person: what the user is watching is one remembered session
 * at a time being added to the room's memory, which is what the line says.
 */
export function absorbRunProgressLine(run: AbsorbRun): string {
	if (run.state === "prepass") return "Reading this room's memory…";
	if (run.state === "budget") return "Checking the memory budget…";
	// Every conversation of the run counts, the ones left out and the ones that
	// held nothing included: "4 of 10" is the person's own list, not the engine's.
	const total = run.progress.total;
	const current = run.progress.current;
	// A note kept as one, read again, is not one of the conversations: its line names it alone.
	if (current && (run.rereads ?? []).some((row) => row.id === current.id)) return `Memorizing · ${current.title}`;
	const at = current ? run.sessions.findIndex((session) => session.id === current.id) : -1;
	const position = at >= 0 ? at + 1 : Math.min(run.progress.folded + 1, Math.max(total, 1));
	if (!current) return `Working through ${total} ${total === 1 ? "conversation" : "conversations"}…`;
	return `Memorizing conversation ${position} of ${total} · ${current.title}`;
}

function countsClause(summary: AbsorbRunSession["summary"], history: number): string {
	const parts: string[] = [];
	if (summary && summary.added > 0) parts.push(`${summary.added} added`);
	if (summary && summary.updated > 0) parts.push(`${summary.updated} updated`);
	if (summary && summary.superseded > 0) parts.push(`${summary.superseded} replaced`);
	if (summary && summary.closed > 0) parts.push(`${summary.closed} closed`);
	// A page whose text was all older than memory still did something: it is said, not "no changes".
	if (history > 0) parts.push(history === 1 ? "1 older value kept as history" : `${history} older values kept as history`);
	return parts.length ? parts.join(", ") : "no changes";
}

/** Every waiting case, in one sentence: conversations the next Memorize reads. */
export function waitsForNextMemorizeSentence(count: number): string {
	return count === 1 ? "1 conversation waits for the next Memorize." : `${count} conversations wait for the next Memorize.`;
}

/**
 * One line per session, on the working screen and on the card. A page placed
 * as one note reads like any other; a page that waits says so, with no cause.
 */
export function absorbRunSessionLine(session: AbsorbRunSession): string {
	switch (session.outcome) {
		case "pending": return "Waiting";
		case "folding": return "Reading this conversation now";
		case "folded":
		case "summarized": return `Memorized · ${countsClause(session.summary, session.changes?.filter((change) => change.kind === "history").length ?? 0)}`;
		case "dropped": return `Nothing to keep · ${session.reason || "this conversation held nothing worth remembering"}`;
		case "failed": return "Waits for the next Memorize.";
		case "skipped": return `Left out · ${session.reason || "you asked for this conversation to be left out"}`;
	}
}

/**
 * The card's rows: every conversation while the run works, then only the ones
 * that changed memory, followed by the notes read again, whose rows say they
 * come from a note. A note read again that changed nothing has no row once done.
 */
export function absorbRunRows(run: AbsorbRun, working: boolean): Array<{ session: AbsorbRunSession; line: string; note?: true }> {
	const changed = (session: AbsorbRunSession) => (session.changes?.length ?? 0) > 0;
	const sessions = working ? run.sessions : run.sessions.filter((session) => changed(session) || session.outcome === "dropped" || session.outcome === "summarized" || session.outcome === "failed" || session.outcome === "skipped");
	const rereads = (run.rereads ?? []).filter((row) => (working ? row.outcome === "pending" || row.outcome === "folding" || row.outcome === "folded" : row.outcome === "folded" && changed(row)));
	return [
		...sessions.map((session) => ({ session, line: absorbRunSessionLine(session) })),
		...rereads.map((session) => ({ session, line: absorbRunSessionLine(session), note: true as const })),
	];
}

/** Where a conversation's row shows its date, a row read from a note says so (draft). */
export const ABSORB_REREAD_ROW_LABEL = "From a note in memory";

/** Every row that carries changes: the conversations', then the summary notes read again. */
function changeRowsOf(run: AbsorbRun): AbsorbRunSession[] {
	return [...run.sessions, ...(run.rereads ?? [])];
}

/** Conversations that wait because their run leg did not finish. */
export function absorbRunFailedSessionNote(run: AbsorbRun): string | null {
	const failed = run.sessions.filter((session) => session.outcome === "failed").length;
	return failed === 0 ? null : waitsForNextMemorizeSentence(failed);
}

/** How full memory is after this update, as the percentage a person reads everywhere else. */
export function absorbRunFullPercent(run: AbsorbRun): number {
	if (run.budget.budgetTokens <= 0) return 0;
	return Math.round(((run.budget.after + Math.max(0, run.demotion.overageTokens)) / run.budget.budgetTokens) * 100);
}

/** Conversations the run finished reading, whether they added notes, were kept whole or held nothing. */
export function absorbRunReadCount(run: AbsorbRun): number {
	return run.sessions.filter((session) => session.outcome === "folded" || session.outcome === "dropped" || session.outcome === "summarized").length;
}

/** The two ways out of a Memorize that stopped because its model is not answering. */
export const ABSORB_TRY_AGAIN_LABEL = "Try again";
export const ABSORB_CHOOSE_MODEL_LABEL = "Choose another model";

/** Conversations a stopped run leaves waiting: the ones it did not finish. */
export function absorbRunWaitingCount(run: AbsorbRun): number {
	return run.sessions.filter((session) => session.outcome === "pending" || session.outcome === "folding" || session.outcome === "failed").length;
}

/**
 * A run with nothing a save would record: no conversation folded, dropped or
 * kept as its summary, and no note read again sorted. A save then changes
 * nothing and every conversation stays waiting, so the card says so and Save is off.
 */
export function absorbRunNothingRead(run: AbsorbRun): boolean {
	return !run.sessions.some((row) => row.outcome === "folded" || row.outcome === "dropped" || row.outcome === "summarized")
		&& !(run.rereads ?? []).some((row) => row.outcome === "folded");
}
/** The card moved the budget away from the room's setting: a save makes it the setting, in Memorize and Review alike. */
function runBudgetChanged(run: { budget: RunBudget }): boolean {
	return run.budget.budgetTokens !== run.budget.savedBudgetTokens;
}
/**
 * Save is off only when a save would change nothing: no conversation read, and
 * none of the five things a save still records: a conversation left out (taken
 * off the waiting list), notes leaving for the budget (archived), a limit raised
 * on the card (made the room's setting), a summary note the model read again
 * (marked as tried), or notes sorted out of Unsorted into topics (moved there).
 */
export function absorbRunNothingToSave(run: AbsorbRun): boolean {
	return absorbRunNothingRead(run)
		&& !run.sessions.some((row) => row.outcome === "skipped")
		&& run.demotion.counts.leaving === 0
		&& !runBudgetChanged(run)
		&& !(run.rereads ?? []).some((row) => row.outcome !== "pending" && row.outcome !== "folding")
		&& absorbRunSortedRows(run).length === 0;
}
export const ABSORB_NOTHING_READ_SENTENCE = "No conversation was read yet.";
export const ABSORB_NOTHING_READ_SAVE_TITLE = "Nothing to save yet: no conversation was read.";

/** The signed-out stop's button: Sign in, or Add key or Replace key on a key connection. */
export function memoryModelSignInLabel(key?: CredentialKey): string {
	return credentialGoneWords(credentialGoneOf(key)).button;
}

/** Why a run stopped on its Memory model, as the notice's sentence says it (draft wording). The provider names the account a refusal is about; `key` tells a key connection's missing or refused key from a sign-in; `unreached` says the model could not be reached, as the chat's line does. */
export function memoryModelStopWhy(cause: MemoryModelStopCause, provider?: string, key?: CredentialKey, unreached?: Unreached, quotaWay?: QuotaWay): string {
	if (cause === "not-answering" && unreached) return unreachedCause(unreached);
	switch (cause) {
		case "busy": return "is still busy after several tries";
		case "signed-out": return credentialGoneWhy(credentialGoneOf(key));
		case "quota": return quotaCause(quotaWay);
		case "not-offered": return "is no longer offered";
		case "not-on-account": return notOnAccountWhy(provider);
		case "region-or-plan": return REGION_OR_PLAN_CAUSE;
		case "gateway-refused": return GATEWAY_REFUSED_CAUSE;
		default: return "isn't answering right now";
	}
}

/** The way on a paused card's line ends with, after what is safe; none where the card's buttons are the way on. Choose another model sits below the line, so the line never names it. On a shared server a gateway's key is the admin's, as the chat's line says, and no button replaces it. */
export function memoryModelStopWayOn(cause: MemoryModelStopCause, unreached?: Unreached, quotaWay?: QuotaWay, gatewayFind?: GatewayFind): string {
	const shared = knownRemoteClientContext()?.sharedServer === true;
	if (cause === "quota") return quotaWayOn(quotaWay);
	if (cause === "gateway-refused") return shared ? `${gatewayRefusedWayOn(true)}.` : "";
	if (cause === "gateway-not-found") return gatewayNotFoundLine("", "", gatewayFind, shared).wayOn ?? "";
	return cause === "not-answering" && unreached ? unreachedWayOn(unreached, shared) : "";
}

/**
 * Why a run paused: a gone credential is the provider's state, never "cannot answer because".
 * `gateway`: the company gateway as AI setup names it, from the run's stop; without it the provider is the model's, named without its provider.
 * `gatewayFind`: after a gateway's bare "not found", what its model list said, as the chat's line says it.
 */
function pausedCause(model: string, cause: MemoryModelStopCause, provider?: string, key?: CredentialKey, unreached?: Unreached, quotaWay?: QuotaWay, gateway?: string, gatewayFind?: GatewayFind): string {
	if (cause === "signed-out") {
		const state = credentialGoneWords(credentialGoneOf(key)).state;
		return gateway ? `${gateway} ${state}` : `${model.replace(/\s*\([^()]*\)$/, "")}'s provider ${state}`;
	}
	if (cause === "gateway-not-found") return gatewayNotFoundLine(gateway || provider || "The gateway", model, gatewayFind, false).cause.replace(/\.$/, "");
	return `${model} ${memoryModelStopWhy(cause, provider, key, unreached, quotaWay)}`;
}

/** Why a run paused, after "Memorize paused" or "Review paused": a gone credential follows a colon, never a second "because". */
function pausedFor(model: string, cause: MemoryModelStopCause, provider?: string, key?: CredentialKey, unreached?: Unreached, quotaWay?: QuotaWay, gateway?: string, gatewayFind?: GatewayFind): string {
	return `${cause === "signed-out" ? ":" : " because"} ${pausedCause(model, cause, provider, key, unreached, quotaWay, gateway, gatewayFind)}`;
}

/** Under a card's "paused" headline: the cause alone, nothing lost, then the way on, as the first read's notice says it. */
function pausedCauseSentence(model: string, cause: MemoryModelStopCause, provider?: string, key?: CredentialKey, unreached?: Unreached, quotaWay?: QuotaWay, gateway?: string, gatewayFind?: GatewayFind): string {
	const wayOn = memoryModelStopWayOn(cause, unreached, quotaWay, gatewayFind);
	return `${pausedCause(model, cause, provider, key, unreached, quotaWay, gateway, gatewayFind)}. Nothing was lost.${wayOn ? ` ${wayOn}` : ""}`;
}

/** The one notice of a run that stopped because its Memory model is not answering, or is busy. It names the conversations still waiting, never "0 conversations". */
export function absorbRunOutageSentence(model: string, cause: MemoryModelStopCause, waiting: number, provider?: string, key?: CredentialKey, unreached?: Unreached, quotaWay?: QuotaWay, gateway?: string, nothingRead = false, gatewayFind?: GatewayFind): string {
	if (cause === "restarted" && nothingRead) return `The app restarted. Nothing was lost. Continue reads the ${waiting === 1 ? "waiting conversation" : `${waiting} waiting conversations`}.`;
	const still = waiting === 0 ? "" : waiting === 1 ? " 1 conversation is still waiting." : ` ${waiting} conversations are still waiting.`;
	const wayOn = memoryModelStopWayOn(cause, unreached, quotaWay, gatewayFind);
	return `${cause === "restarted" ? "The app restarted. Finished conversations are on this card. Save keeps them." : `Memorize paused${pausedFor(model, cause, provider, key, unreached, quotaWay, gateway, gatewayFind)}.`}${still}${wayOn ? ` ${wayOn}` : ""}`;
}

/** Memorize's paused card, with nothing to save: its headline says "Memorize paused.", so the line is the cause alone, and after a restart Review's words. */
export function absorbRunPausedSentence(model: string, cause: MemoryModelStopCause, provider?: string, key?: CredentialKey, unreached?: Unreached, quotaWay?: QuotaWay, gateway?: string, gatewayFind?: GatewayFind): string {
	return cause === "restarted" ? "The app restarted. Nothing was lost." : pausedCauseSentence(model, cause, provider, key, unreached, quotaWay, gateway, gatewayFind);
}

/** Review's paused line: the cause, what is safe, then the way on. With nothing tidied the card's headline says "Review paused.", so the line is the cause alone. */
export function reviewRunPausedSentence(model: string, stop: { cause: MemoryModelStopCause; model: { provider: string }; key?: CredentialKey; unreached?: Unreached; quotaWay?: QuotaWay; gateway?: string; gatewayFind?: GatewayFind }, tidied: boolean): string {
	if (!tidied) return pausedCauseSentence(model, stop.cause, stop.model.provider, stop.key, stop.unreached, stop.quotaWay, stop.gateway, stop.gatewayFind);
	const wayOn = memoryModelStopWayOn(stop.cause, stop.unreached, stop.quotaWay, stop.gatewayFind);
	return `Review paused${pausedFor(model, stop.cause, stop.model.provider, stop.key, stop.unreached, stop.quotaWay, stop.gateway, stop.gatewayFind)}. What was tidied can be saved; the rest is unchanged.${wayOn ? ` ${wayOn}` : ""}`;
}

/**
 * The model the outage notice names: the one that stopped, from the run's own
 * stop. The room's Memory model as last read lends its label only when it is
 * that same model; the person may have chosen another since, and the notice
 * must not blame the new one for the old one's silence.
 */
export function absorbRunOutageModelName(stopped: { provider: string; model: string }, memoryModel?: { provider: string; model: string; label?: string } | null): string {
	const label = memoryModel && memoryModel.provider === stopped.provider && memoryModel.model === stopped.model ? memoryModel.label : undefined;
	return modelDisplayName({ provider: stopped.provider, model: stopped.model, ...(label ? { modelLabel: label } : {}) });
}

/** Every conversation this run read was kept whole as its summary: the model sorted none of them into topics. */
export function absorbRunAllSummarized(run: AbsorbRun): boolean {
	const read = run.sessions.filter((session) => session.outcome !== "skipped");
	return read.length > 0 && read.every((session) => session.outcome === "summarized");
}
/** That run's one notice, with Choose another model beside it. */
export function absorbRunAllSummarizedSentence(model: string): string {
	return `${model} could not sort these conversations into topics. Another Memory model may do better.`;
}

/** Notes this update adds, rewrites, replaces or closes, across every conversation and every note read again. */
export function absorbRunNotesChanged(run: AbsorbRun): number {
	return changeRowsOf(run).reduce((sum, session) => sum + (session.summary ? session.summary.added + session.summary.updated + session.summary.superseded + session.summary.closed : 0), 0);
}

/** Notes leaving for the archive if the update is saved as it stands. The server counts; the card reads. */
export function absorbRunArchiveCount(run: AbsorbRun): number {
	return run.demotion.counts.leaving;
}

// ── The budget bar over the archive list ────────────────────────────────────
// One bar on either card says where the budget sits and how much is leaving
// because of it. Tokens appear in exactly one place on the whole card: inside
// the button that raises the budget, where the number is the thing being set.

/** A budget as the raise button names it: "52k", the way the slider in Room settings does. */
export function fmtTokenLimit(tokens: number): string {
	return `${Math.round(tokens / 1000)}k`;
}

/**
 * The highest budget a room can have. A run carries it as `ceilingTokens`; the
 * first read, which runs before any run exists, does not, so the number lives
 * here too and mirrors the server's ceiling.
 */
export const MEMORY_LIMIT_CEILING_TOKENS = 80_000;

/** The next whole thousand at or above a size, which is what a limit is set to. */
export function roundUpToThousand(tokens: number): number {
	return Math.ceil(Math.max(0, tokens) / 1000) * 1000;
}

/** How much the rows leaving weigh, which is what the bar's grey part is drawn from. */
export function archiveLeavingTokens(entries: ArchiveRow[]): number {
	return entries.reduce((sum, row) => sum + (row.leaving ? row.tokens : 0), 0);
}

/**
 * The limit that would keep every note on the list, rounded up to the next
 * thousand: what memory would weigh with nothing leaving and everything kept.
 * Null when nothing leaves and nothing kept pushes past the limit.
 */
export function raiseLimitTarget(input: { budget: RunBudget; demotion: RunDemotion }): number | null {
	const leavingTokens = archiveLeavingTokens(input.demotion.entries);
	const overage = Math.max(0, input.demotion.overageTokens);
	if (leavingTokens <= 0 && overage <= 0) return null;
	return roundUpToThousand(input.budget.after + overage + leavingTokens);
}

/** The bar's kept, leaving and replacement counts on one line; a replacement count of zero is not said. */
export function archiveCountsLine(counts: RunDemotion["counts"]): string {
	if (counts.kept === 0) return "Nothing kept yet";
	const instead = counts.instead === 0 ? null : counts.instead === 1 ? "1 leaves instead of it" : `${counts.instead} leave instead of them`;
	return instead ? `Kept ${counts.kept} · ${instead}` : `Kept ${counts.kept}`;
}

export const MEMORY_LIMIT_BAR_LABEL = "Memory budget";

/** The one sentence under the bar: what the budget does, what Keep does, and where the archive is. */
export const ARCHIVE_EXPLANATION = "Keep holds a note for this update only; another note leaves in its place. The budget decides how many stay. Notes in the archive stay readable in Room settings and can come back any time.";

export interface ArchiveLimitSummary {
	/** How full memory is after saving, kept notes included. */
	percent: number;
	/** Nothing leaves and nothing kept pushes past the limit: the grey part collapses. */
	fits: boolean;
	/** The label on the filled part: "full" while anything is leaving or over, else the percentage. */
	fillLabel: string;
	/** The label on the grey part: how many notes are leaving. */
	overflowLabel: string;
	/** How wide the grey part is, as a share of the filled part; capped at one. */
	overflowRatio: number;
	/** "Kept 4 · Leaving 580 · 6 leave instead of the kept ones" */
	countsLine: string;
	/** Said instead of the counts line when everything fits. */
	fitsSentence: string | null;
	/** The raise button: null when there is nothing to raise for. */
	raise: { target: number; label: string; ceilingSentence: string | null } | null;
}

/**
 * Everything the limit bar shows, from the run's numbers alone. The same bar
 * serves both cards, so the same helper words it.
 */
export function archiveLimitSummary(input: { budget: RunBudget; demotion: RunDemotion }): ArchiveLimitSummary {
	const { budget, demotion } = input;
	const overage = Math.max(0, demotion.overageTokens);
	const leaving = demotion.counts.leaving;
	const leavingTokens = archiveLeavingTokens(demotion.entries);
	const percent = memoryFullPercent(budget.after + overage, budget.budgetTokens);
	const fits = leaving === 0 && overage <= 0;
	const excess = leavingTokens + overage;
	const overflowRatio = fits || budget.budgetTokens <= 0 ? 0 : Math.min(1, excess / budget.budgetTokens);
	const wanted = raiseLimitTarget(input);
	let raise: ArchiveLimitSummary["raise"] = null;
	if (wanted !== null) {
		if (wanted <= budget.ceilingTokens) {
			raise = { target: wanted, label: `Raise the budget to ${fmtTokenLimit(wanted)} to keep them all`, ceilingSentence: null };
		} else {
			raise = {
				target: budget.ceilingTokens,
				label: `Raise the budget to ${fmtTokenLimit(budget.ceilingTokens)}`,
				ceilingSentence: `Keeping them all needs more than the ${fmtTokenLimit(budget.ceilingTokens)} ceiling.`,
			};
		}
		// A run already at the ceiling has nothing left to set; the sentence still says why.
		if (raise.target <= budget.budgetTokens && raise.ceilingSentence === null) raise = null;
	}
	return {
		percent,
		fits,
		fillLabel: fits ? `${percent}% full` : typeof demotion.counts.staying === "number" ? `${demotion.counts.staying} ${demotion.counts.staying === 1 ? "note stays" : "notes stay"}` : "full",
		overflowLabel: leaving > 0 ? `${leaving} ${leaving === 1 ? "note leaves" : "notes leave"}` : "above its budget",
		overflowRatio,
		countsLine: archiveCountsLine(demotion.counts),
		fitsSentence: fits ? `Everything fits. Memory is ${percent}% full after saving.` : null,
		raise,
	};
}

/** The archive section's heading: how many notes leave if this is saved as it stands; none, and it says so. */
export function archiveHeading(leaving: number): string {
	if (leaving === 0) return "Nothing goes to the archive";
	return `${leaving} ${leaving === 1 ? "note" : "notes"} going to the archive`;
}

/** The topic checkbox in the archive list. */
export const KEEP_TOPIC_LABEL = "Keep this topic";
/** The Keep control's hover: a keep is for this update and pins nothing. */
export const KEEP_NOTE_HINT = "Keeps this note for this update only. It is not pinned.";

/** The tags a row can carry: a replacement, and a row that stopped leaving. */
export const ARCHIVE_ROW_TAG_INSTEAD = "leaves instead";
export const ARCHIVE_ROW_TAG_STAYS = "stays";

/** The tag next to a topic the update created. */
export const NEW_TOPIC_TAG = "new topic";

/** The one tag on a new note that may say something different from a note already in memory, pinned or not. */
export const MAY_DISAGREE_TAG = "may disagree";

/** The two answers a tagged note offers: keep it next to the other note, which is what happens if the person does nothing, or put it in that note's place at the save. */
export const KEEP_BOTH_LABEL = "Keep both";
export const REPLACE_PINNED_LABEL = "Replace my pinned note with this";
export const REPLACE_OLDER_LABEL = "Replace the older note with this";

/**
 * What a tagged change row says: its tag, the line under it naming the other
 * note by its first line, and the Replace answer when one is offered (never
 * while either note is going to the archive, when the other note left or is
 * closed by this update, or when this update closes the new note itself).
 */
export function changeBesideTag(change: Pick<AbsorbRunChange, "beside" | "besideLine" | "besideState" | "besideLearned" | "learned" | "choice">): { tag: string; line: string; replaceLabel: string | null } | null {
	if (!change.beside) return null;
	const pinned = change.beside === "pinned";
	const tag = MAY_DISAGREE_TAG;
	const other = pinned ? "The pinned note it may disagree with" : "The note it may disagree with";
	const selfClosed = "This new note is closed later in this update, so it replaces nothing.";
	if (change.besideState === "closed" && change.besideLine === undefined) return { tag, line: `${other} is closed by this update.`, replaceLabel: null };
	if (change.besideLine === undefined) return { tag, line: change.besideState === "self-closed" ? selfClosed : `${other} is no longer in memory.`, replaceLabel: null };
	// A tagged note and the one beside it say the day each was learned, when known, so the newer one shows.
	const dates = [change.besideLearned ? `as of ${fmtMemoryDay(change.besideLearned)}` : "", change.learned ? `new note as of ${fmtMemoryDay(change.learned)}` : ""].filter(Boolean);
	const quoted = `"${entryFirstLine(change.besideLine)}"${dates.length > 0 ? ` (${dates.join("; ")})` : ""}`;
	const line = `${pinned ? "May disagree with your pinned note" : "May disagree with"}: ${quoted}`;
	// A sentence after the days starts once they are closed with a period.
	const lead = line.endsWith(")") ? `${line}.` : line;
	if (change.besideState === "closed") return { tag, line: `${lead} That note is closed by this update.`, replaceLabel: null };
	if (change.besideState === "self-closed") return { tag, line: `${lead} ${selfClosed}`, replaceLabel: null };
	if (change.besideState === "leaving") return { tag, line: `${lead} One of the two is going to the archive, so neither can replace the other here.`, replaceLabel: null };
	// With Replace pressed, the line says what the save will do.
	const chosen = change.choice === "replace" ? `${pinned ? "Replaces your pinned note" : "Replaces the older note"}: ${quoted}` : line;
	return { tag, line: chosen, replaceLabel: pinned ? REPLACE_PINNED_LABEL : REPLACE_OLDER_LABEL };
}

/** What a row says beside its text, or nothing. A kept row is dimmed instead of tagged. */
export function archiveRowTag(row: Pick<ArchiveRow, "leaving" | "kept" | "instead">): string | null {
	if (row.leaving && row.instead) return ARCHIVE_ROW_TAG_INSTEAD;
	if (!row.leaving && !row.kept) return ARCHIVE_ROW_TAG_STAYS;
	return null;
}

/** A topic as the keep set names it: section and title, one string. */
export function archiveTopicKey(section: string, title: string): string {
	return `${section}/${title}`;
}

/** Section and title each trimmed and lowercased, so " Nordwind Integration " and "nordwind integration" are one topic. */
function normalTopicKey(key: string): string {
	const slash = key.indexOf("/");
	if (slash < 0) return key.trim().toLowerCase();
	return `${key.slice(0, slash).trim().toLowerCase()}/${key.slice(slash + 1).trim().toLowerCase()}`;
}

/** Whether a topic is protected, matched the way the server matches it: case-insensitive, trimmed. */
export function topicKept(keepTopics: string[], section: string, title: string): boolean {
	const wanted = normalTopicKey(archiveTopicKey(section, title));
	return keepTopics.some((key) => normalTopicKey(key) === wanted);
}

/** The protected topics after a toggle; order is stable so two equal sets are one request. */
export function nextKeepTopics(current: string[], section: string, title: string, keep: boolean): string[] {
	const key = archiveTopicKey(section, title);
	const wanted = normalTopicKey(key);
	const rest = current.filter((candidate) => normalTopicKey(candidate) !== wanted);
	return keep ? [...rest, key] : rest;
}

// ── The first read of a room already above its budget ───────────────────────
// Before any run exists, the first read says what memorizing now would do
// and offers the two other ways: a higher budget, or a Review first.

export interface OverLimitFirstRead {
	headline: string;
	sentence: string;
	/** Null when the budget is already as high as a raise could set it. */
	raise: { target: number; label: string } | null;
	reviewLabel: string;
}

export const REVIEW_FIRST_LABEL = "Review first";

/**
 * The block above the first read. The target is the room's memory as it
 * stands, rounded up; past the ceiling the button sets the ceiling and the
 * sentence says notes would still move. How many would is not known before a
 * run, so that sentence carries no count.
 */
export function overLimitFirstRead(input: { reviewTargetTokens: number; budgetTokens: number; entriesOverBudget: number; ceilingTokens?: number }): OverLimitFirstRead {
	const ceiling = input.ceilingTokens ?? MEMORY_LIMIT_CEILING_TOKENS;
	const percent = memoryFullPercent(input.reviewTargetTokens, input.budgetTokens);
	const count = input.entriesOverBudget;
	const wanted = roundUpToThousand(input.reviewTargetTokens);
	const pastCeiling = wanted > ceiling;
	const target = pastCeiling ? ceiling : wanted;
	const moves = `Memorizing now moves about ${count} of the least recently touched notes to the archive.`;
	const canRaise = target > input.budgetTokens;
	return {
		headline: `Memory is ${percent}% full.`,
		sentence: pastCeiling && canRaise
			? `${moves} Even at the ${fmtTokenLimit(ceiling)} ceiling some of them would still move. You can also:`
			: `${moves} You can also:`,
		raise: canRaise ? { target, label: pastCeiling ? `Raise the budget to ${fmtTokenLimit(target)}` : `Raise the budget to ${fmtTokenLimit(target)} to keep everything that is there now` } : null,
		reviewLabel: REVIEW_FIRST_LABEL,
	};
}

/** The saved screen's line when the save also wrote a higher budget. The number stays on the button that chose it. */
export const LIMIT_RAISED_ON_SAVE_SENTENCE = "The memory budget was raised with this save.";

/** A Memorize or Review save while the room's open conversation had started (the server says so): that one keeps its start text. */
export const OPEN_CONVERSATION_KEEPS_MEMORY_SENTENCE = "Your open conversation keeps the memory it started with. The changes apply from your next conversation.";

/** An undo took back a save that had raised the budget, and the budget went with it. */
export function LIMIT_LOWERED_ON_UNDO_SENTENCE(tokens: number): string {
	return `The budget is back at ${fmtTokenLimit(tokens)}.`;
}

/** How many of a session's changes are of one kind, from the rows when the run carries them and from the summary's count otherwise. */
function absorbSessionChangeCount(session: AbsorbRunSession, kind: "closed"): number {
	if (session.changes) return session.changes.filter((change) => change.kind === kind).length;
	return session.summary?.[kind] ?? 0;
}

/**
 * Automatic maintenance for a v2 run (the contract's client fast path): apply
 * unless the person has a real decision to make. Anything archived for the
 * budget, any open item a fold closed, any crossing of the budget, any new
 * note beside a pinned one or one it may disagree with, and any conversation
 * the model judged not worth keeping falls to the card with the reason named.
 * An engine warning never does, nor a conversation that did not finish: it
 * waits for the next Memorize. An add, an update and a replace are the fast
 * path's own business. The room setting is checked by the caller; this is
 * the run's own verdict.
 */
/** A run that stopped before it finished is shown, never saved on its own: its notice holds the ways on. */
function stoppedRunBlocker(stop: AbsorbRun["stop"] | ReviewRun["stop"]): string[] {
	if (!stop) return [];
	return [stop.kind === "restart" ? "the app restarted before it finished" : "the Memory model stopped before it finished"];
}

export function absorbRunFastPathBlockers(run: AbsorbRun): string[] {
	const blockers: string[] = stoppedRunBlocker(run.stop);
	const leaving = run.demotion.counts.leaving;
	if (leaving > 0) {
		blockers.push(leaving === 1
			? "1 note would move to the archive to stay within the budget"
			: `${leaving} notes would move to the archive to stay within the budget`);
	}
	if (run.budget.overBudgetAfter) blockers.push("saving would leave memory above its budget");
	const closed = changeRowsOf(run).reduce((sum, session) => sum + absorbSessionChangeCount(session, "closed"), 0);
	if (closed > 0) blockers.push(closed === 1 ? "1 open item would be closed" : `${closed} open items would be closed`);
	const besidePinned = absorbRunBesideCount(run, "pinned");
	if (besidePinned > 0) blockers.push(besidePinned === 1 ? "1 new note may disagree with a pinned note" : `${besidePinned} new notes may disagree with pinned notes`);
	const mayDisagree = absorbRunBesideCount(run, "may-disagree");
	if (mayDisagree > 0) blockers.push(mayDisagree === 1 ? "1 new note may disagree with one already in memory" : `${mayDisagree} new notes may disagree with notes already in memory`);
	const dropped = run.sessions.filter((session) => session.outcome === "dropped").length;
	if (dropped > 0) {
		blockers.push(dropped === 1
			? "1 conversation would be dropped as nothing to keep"
			: `${dropped} conversations would be dropped as nothing to keep`);
	}
	return blockers;
}

/** New notes of the run that carry one `beside` tag. */
function absorbRunBesideCount(run: AbsorbRun, beside: NonNullable<AbsorbRunChange["beside"]>): number {
	return changeRowsOf(run).reduce((sum, session) => sum + (session.changes?.filter((change) => change.kind === "added" && change.beside === beside).length ?? 0), 0);
}

/** The saved screen's headline: what the room now remembers, or what the update did instead. */
export function absorbRunSavedHeadline(result: { foldedSessions?: string[]; notedSessions?: number; archivedForBudget?: number; sortedNotes?: number }, roomName: string): string {
	// Conversations that only had nothing to keep were read, not memorized.
	const folded = result.notedSessions === 0 ? 0 : result.foldedSessions?.length ?? 0;
	if (folded === 0) return (result.archivedForBudget ?? 0) > 0 ? `${roomName} made room in its memory` : (result.sortedNotes ?? 0) > 0 ? `${roomName} sorted its notes into topics` : `Nothing new for ${roomName} to remember`;
	return `${roomName} memorized ${folded} ${folded === 1 ? "conversation" : "conversations"}`;
}

/** Topics this update created, counted across every conversation it read. */
export function absorbRunNewTopics(run: AbsorbRun): number {
	return changeRowsOf(run).reduce((sum, session) => sum + (session.changes?.filter((change) => change.newTopic === true).length ?? 0), 0);
}

/** What the saved screen says once the run is written. */
/**
 * A conversation remembered while a Memorize or Review card was open was never
 * part of that save: the save kept it, and it waits like a conversation that
 * failed. Null when none was.
 */
export function rememberedMeanwhileSentence(rebasedOnto: string[] | undefined): string | null {
	const rebased = rebasedOnto?.length ?? 0;
	return rebased === 0 ? null : waitsForNextMemorizeSentence(rebased);
}

export function absorbRunSavedSentence(result: { foldedSessions?: string[]; notedSessions?: number; nothingToKeep?: number; remainingSessions?: string[]; archivedEntries?: number; archivedForBudget?: number; replacedEntries?: number; historyKept?: number; sortedNotes?: number; newTopics?: number; rebasedOnto?: string[] }): string {
	// The counts the save applied; an older server sent only the read conversations.
	const folded = result.notedSessions ?? result.foldedSessions?.length ?? 0;
	const nothing = result.nothingToKeep ?? 0;
	const remaining = result.remainingSessions?.length ?? 0;
	const archived = result.archivedEntries ?? 0;
	const archivedForBudget = result.archivedForBudget ?? 0;
	const newTopics = result.newTopics ?? 0;
	const sorted = result.sortedNotes ?? 0;
	const meanwhile = rememberedMeanwhileSentence(result.rebasedOnto);
	const parts: string[] = [];
	// A room already at its ceiling can spend a whole update making room and add
	// nothing: "0 sessions were saved into memory" reads as a failure when what
	// actually happened is the work the budget needed.
	if (folded === 0 && nothing === 0 && archivedForBudget > 0) {
		parts.push("No conversation was memorized this time.");
		parts.push(archivedForBudget === 1
			? "1 note moved to the archive to keep memory within its budget."
			: `${archivedForBudget} notes moved to the archive to keep memory within its budget.`);
		if (sorted > 0) parts.push(`${absorbRunSortedTitle(sorted)}.`);
		if (remaining > 0) parts.push(waitsForNextMemorizeSentence(remaining));
		if (meanwhile) parts.push(meanwhile);
		return parts.join(" ");
	}
	// A run that only sorted Unsorted says that, not "0 conversations".
	if (folded > 0 || (nothing === 0 && sorted === 0)) parts.push(folded === 1 ? "1 conversation became lasting notes." : `${folded} conversations became lasting notes.`);
	if (nothing > 0) parts.push(folded > 0 ? `${nothing} had nothing to keep.` : `${nothing === 1 ? "1 conversation" : `${nothing} conversations`} had nothing to keep.`);
	if (sorted > 0) parts.push(`${absorbRunSortedTitle(sorted)}.`);
	if (newTopics > 0) parts.push(newTopics === 1 ? "1 new topic." : `${newTopics} new topics.`);
	if (remaining > 0) parts.push(waitsForNextMemorizeSentence(remaining));
	// A note a newer text replaced did not leave memory: it is said apart from the notes that did.
	const replaced = Math.min(result.replacedEntries ?? 0, archived);
	if (replaced > 0) parts.push(replaced === 1 ? "1 note replaced; the old one is in the archive." : `${replaced} notes replaced; the old ones are in the archive.`);
	const moved = archived - replaced;
	if (moved > 0) parts.push(moved === 1 ? "1 note moved to the archive." : `${moved} notes moved to the archive.`);
	const history = result.historyKept ?? 0;
	if (history > 0) parts.push(history === 1 ? "1 older value kept as history." : `${history} older values kept as history.`);
	if (meanwhile) parts.push(meanwhile);
	return parts.join(" ");
}

const CHANGE_LABELS: Record<AbsorbRunChangeKind, string> = {
	added: "Added",
	updated: "Updated",
	superseded: "Replaced",
	closed: "Closed",
	pinned: "Pinned",
	history: "Older",
};

/** The line under an "Older" row: an older conversation's value, kept as history. It names no newer note, since a Replace on another row may change which one stays. */
export const HISTORY_ROW_LINE = "An older conversation said this. A newer note says otherwise, so this is kept in the archive as history.";

export function changeKindLabel(kind: AbsorbRunChangeKind): string {
	return CHANGE_LABELS[kind] ?? kind;
}

const KIND_LABELS: Record<EntryKind, string> = {
	event: "conversation",
	fact: "fact",
	practice: "practice",
	item: "item",
};

export function entryKindLabel(kind: EntryKind): string {
	return KIND_LABELS[kind] ?? kind;
}

/** The entry's origin, worded as a date rather than the server's session id. */
export function entryOriginSentence(entry: EntryCard): string | null {
	if (!entry.from) return null;
	return `from a conversation saved ${entry.saved}`;
}

// ── A page as the person sees it ───────────────────────────────────────────
// The stored page keeps the format the models read (its section labels and
// the must-keep marker); what the person reads says the same in plain words.
// Display only: nothing here is ever written back, except through
// storedMemoryBody, which gives the editor's "Keep:" back as the marker.

/** The page's labels in plain words (drafts). */
const PLAIN_PAGE_LABELS: Array<[RegExp, string]> = [
	[/\*\*Session arc:\*\*/g, "**What happened:**"],
	[/\*\*Body:\*\*/g, "**What to keep:**"],
	[/\*\*Parked:\*\*/g, "**Still open:**"],
];

/** The must-keep marker taken out of one line's words, as the notes drop it once it has pinned them. */
function withoutMustKeep(text: string): string {
	return text
		.replace(/\*\*must-keep[ \t]*[\u2014\u2013-][ \t]*(?=[^*\r\n]*\*\*)/gi, "**")
		.replace(/[ \t]*\*\*must-keep:?\*\*:?(?=[ \t]*(?:[.,;!?)]|$))/gim, "")
		.replace(/\*\*must-keep:?\*\*:?[ \t]*(?:[\u2014\u2013-][ \t]+)?/gi, "")
		.replace(/\*\*must-keep\b:?[ \t]*(?:[\u2014\u2013-][ \t]+)?/gi, "");
}

/** The other importance words the Remember prompt asks the model to mark in bold. */
const IMPORTANCE = "key|critical|provisional|parked|resolved|fragile|strategic";

/** The importance markers and a quoted remember-trigger ("Note that") taken out, as must-keep is. */
function withoutMarkers(text: string): string {
	return text
		.replace(new RegExp(String.raw`\*\*(?:${IMPORTANCE}):\*\*:?[ 	]*`, "gi"), "")
		.replace(new RegExp(String.raw`^([ 	]*[-*][ 	]+)\*\*(?:${IMPORTANCE})\*\*:?[ 	]*`, "gim"), "$1")
		.replace(new RegExp(String.raw`\*\*(${IMPORTANCE})\*\*`, "gi"), "$1")
		.replace(/[ \t]*\(\s*["\u201c\u2018'](?:note that|remember|keep in mind|don['\u2019]?t forget|please note)[^"\u201d\u2019')]{0,40}["\u201d\u2019']\s*\)/gi, "");
}

/** A page, a note or a whole memory as the person reads it: plain labels and no marker. */
export function plainMemoryText(markdown: string): string {
	return withoutMarkers(PLAIN_PAGE_LABELS.reduce((text, [label, plain]) => text.replace(label, plain), withoutMustKeep(markdown)));
}

/** The budget refusal as Room settings' Memory pane says it: the Model pane is in the same list (draft). */
export function roomSettingsBudgetRefusal(message: string): string {
	return message.replace(/ Choose one in Room settings, Model first\.$/, " Choose a larger Memory model in Model first.");
}

/** The memory file's section names in the app's words, as Memory's legend says them. */
const SECTION_WORDS: Array<[RegExp, string]> = [[/\bActive Items\b/g, "Open items"], [/\bDeep Memory\b/g, "Notes"], [/\bRecent Context\b/g, "Waiting conversations"]];

/** A first read's line as the person reads it: no must-keep marker, bold or plain, stored days in the app's form, and sections by the app's names. */
export function plainFirstReadLine(text: string): string {
	return SECTION_WORDS.reduce((line, [name, words]) => line.replace(name, words), withoutMarkers(withoutMustKeep(text))
		.replace(/\bmust-keep:[ \t]*/gi, "")
		.replace(/\b(\d{4}-\d{2}-\d{2})\b/g, (day) => fmtMemoryDay(day)));
}

const MARKED_LINE = /^([ \t]*[-*][ \t]+)\*\*must-keep:?\*\*:?[ \t]*/gim;
const KEEP_LINE = /^([ \t]*[-*][ \t]+)Keep:[ \t]*/;

/** The Remember editor's body: a line's leading marker reads "Keep:". */
export function editableMemoryBody(body: string): string {
	return body.replace(MARKED_LINE, "$1Keep: ");
}

/**
 * The editor's body as it is saved: "Keep:" at a line's start is the marker
 * again, except on a line the page already held as written: only the person
 * marks a note must-keep, so the quick save and the reviewed one store the same page.
 */
export function storedMemoryBody(body: string, original: string): string {
	const written = new Set(original.split("\n").filter((line) => KEEP_LINE.test(line)));
	return body.split("\n").map((line) => (written.has(line) ? line : line.replace(KEEP_LINE, "$1**must-keep:** "))).join("\n");
}

/** One part of a note as it shows: a plain line, a run of points as one list, or the gap a blank line leaves. */
export type NoteBlock = { line: string } | { points: string[] } | { gap: true };

const POINT_MARKER = /^\s*[-*+\u2022]\s+/;

/**
 * A note as the person wrote it: each line on its own line, in its order. A
 * line that starts with a point marker is a point, without the marker, and
 * points in a row are one list; every other line is plain. Blank lines in a
 * row are one gap. The first line is the note's own, always plain.
 */
export function noteBlocks(text: string): NoteBlock[] {
	const blocks: NoteBlock[] = [];
	for (const raw of plainMemoryText(text).split("\n")) {
		const last = blocks[blocks.length - 1];
		if (!raw.trim()) {
			if (last && !("gap" in last)) blocks.push({ gap: true });
			continue;
		}
		const point = blocks.length > 0 && POINT_MARKER.test(raw);
		const words = (blocks.length === 0 || point ? raw.replace(POINT_MARKER, "") : raw).trim();
		if (!words) continue;
		if (!point) blocks.push({ line: words });
		else if (last && "points" in last) last.points.push(words);
		else blocks.push({ points: [words] });
	}
	if (blocks.length > 0 && "gap" in blocks[blocks.length - 1]) blocks.pop();
	return blocks;
}

/** The first line of an entry, for a row that has no room for the whole text. */
export function entryFirstLine(text: string): string {
	const line = text.split("\n").map((part) => part.replace(/^[\s\-*•]+/, "").trim()).find((part) => part.length > 0) ?? "";
	return line.length > 180 ? `${line.slice(0, 180)}…` : line;
}

const ARCHIVE_REASONS: Record<ArchivedEntryCard["why"], string> = {
	budget: "budget",
	superseded: "replaced",
	done: "finished",
	user: "removed by you",
	stale: "no longer holds",
	duplicate: "already said elsewhere",
	history: "older value",
	sorted: "sorted into topics",
};

/** Whether an archived note can come back: an older value kept as history cannot be made current again, nor a text whose note still stands in memory. */
export function archivedEntryRestorable(entry: Pick<ArchivedEntryCard, "why" | "standing">): boolean {
	return entry.why !== "history" && !entry.standing;
}

export function archiveReasonLabel(why: ArchivedEntryCard["why"]): string {
	return ARCHIVE_REASONS[why] ?? why;
}

/** The reason of a note archived as a duplicate when the run knows where it is already said: the topic holding the other note. */
export function archivedDuplicateReason(topic: string): string {
	return `already said under "${topicLabel(topic)}"`;
}

// ── The archive lists on the card ──────────────────────────────────────────
// A room at the top of its budget archives hundreds of entries at once, and a
// flat list of those is a card 90 screens tall. The lists are therefore read
// the way memory itself is organised: by topic, closed, counted, and opened
// only where the person wants to look.

export interface EntryTopicGroup<T extends EntryCard = EntryCard> {
	section: EntryCard["section"];
	topic: string;
	entries: T[];
	tokens: number;
}

const SECTION_ORDER: EntryCard["section"][] = ["Deep Memory", "Active Items"];

/** Section first, then topic in the order the entries arrive, so the card reads like the memory does. */
export function groupEntriesByTopic<T extends EntryCard>(entries: T[]): EntryTopicGroup<T>[] {
	const groups = new Map<string, EntryTopicGroup<T>>();
	for (const entry of entries) {
		const key = `${entry.section}\u0000${entry.topic}`;
		let group = groups.get(key);
		if (!group) {
			group = { section: entry.section, topic: entry.topic, entries: [], tokens: 0 };
			groups.set(key, group);
		}
		group.entries.push(entry);
		group.tokens += entry.tokens;
	}
	const ordered = [...groups.values()];
	ordered.sort((left, right) => SECTION_ORDER.indexOf(left.section) - SECTION_ORDER.indexOf(right.section));
	return ordered;
}

/** The engine's name for the open-items section, in the words a person reads. */
export function topicLabel(topic: string): string {
	return topic.trim().toLowerCase() === "active items" ? "Open items" : topic;
}

/** The one line a closed group shows: what it is, how much of it there is, and what becomes of it. A kept count of zero is not said. */
export function archiveTopicGroupSummary(group: EntryTopicGroup<ArchiveRow>): string {
	const count = group.entries.length;
	const kept = group.entries.filter((row) => row.kept).length;
	const leaving = group.entries.filter((row) => row.leaving).length;
	const parts = [topicLabel(group.topic), `${count} ${count === 1 ? "note" : "notes"}`];
	if (kept > 0) parts.push(`${kept} kept`);
	parts.push(`${leaving} leaving`);
	return parts.join(" · ");
}

/** The search box above a list: plain text against the entry and its topic. */
export function filterEntriesByText<T extends EntryCard>(entries: T[], query: string): T[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return entries;
	return entries.filter((entry) => entry.text.toLowerCase().includes(needle) || entry.topic.toLowerCase().includes(needle));
}

/** Past this many entries in one list, an opened group shows a first page instead of everything. */
export const ENTRY_LIST_LARGE_THRESHOLD = 200;
/** How many rows an opened group shows first when the list is a large one. */
export const ENTRY_GROUP_PAGE_SIZE = 50;

/** What an opened group renders: the first page, and how many rows it is still holding back. */
export function entryGroupPage<T extends EntryCard>(entries: T[], listTotal: number, showAll: boolean): { visible: T[]; hidden: number } {
	if (showAll || listTotal <= ENTRY_LIST_LARGE_THRESHOLD || entries.length <= ENTRY_GROUP_PAGE_SIZE) {
		return { visible: entries, hidden: 0 };
	}
	return { visible: entries.slice(0, ENTRY_GROUP_PAGE_SIZE), hidden: entries.length - ENTRY_GROUP_PAGE_SIZE };
}

export function showMoreLabel(hidden: number): string {
	return `Show ${fmtTokenCount(hidden)} more`;
}

/** The keep set after a toggle; order is stable so two equal sets are one request. */
export function nextKeepIds(current: string[], entryIds: string[], keep: boolean): string[] {
	const changed = new Set(entryIds);
	const rest = current.filter((id) => !changed.has(id));
	return keep ? [...rest, ...entryIds] : rest;
}

/** How long a burst of keep toggles is collected before one request carries them all. */
export const KEEP_DEBOUNCE_MS = 400;

/**
 * Keep is one request with the whole set, never one per entry: a person ticking
 * twenty rows must not start twenty runs of the server's budget maths. While a
 * request is in flight the next set waits for it, so the last state the person
 * chose is the one the server ends on.
 */
export function keepBatchAction(inFlight: boolean): "send" | "queue" {
	return inFlight ? "queue" : "send";
}

// ── What the person asked for ──────────────────────────────────────────────
// A discussion ends in instructions the run is meant to honour. The card shows
// them back in the person's own terms, so approving is a check of what was
// asked for and not only of what the model did.

export interface AbsorbRunGuidanceSummary {
	pins: string[];
	drops: { text: string; leftOut: boolean }[];
	corrections: string[];
	topics: string[];
	/** The entries this run removed by code before Save, as the person asked: each by its first line. */
	removed: string[];
	/** Removals it could not do: nothing in memory matched the words exactly, or more than one entry did. */
	notDone: Array<{ text: string; several: boolean }>;
	/** The other instructions: what the Memory model was told, not something the run checks. */
	instructions: string[];
}

/** The line for a removal the run could not do (draft). */
export function absorbRunNotDoneSentence(text: string, several = false): string {
	return several
		? `Not done: ${text.trim()} More than one entry in memory matches those words; you can delete the right one on the Memory page.`
		: `Not done: ${text.trim()} Nothing in memory matched it exactly; you can delete the entry on the Memory page.`;
}

function joinList(items: string[]): string {
	if (items.length <= 1) return items[0] ?? "";
	if (items.length === 2) return `${items[0]} and ${items[1]}`;
	return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Ids are the engine's handle on an entry, never a person's: a pinned id is
 * shown as the line it stands for wherever the card holds that entry, and only
 * falls back to the id when the entry is not on this card at all.
 */
export function absorbRunGuidanceSummary(run: AbsorbRun): AbsorbRunGuidanceSummary | null {
	const guidance = run.guidance;
	if (!guidance) return null;
	const known = new Map<string, EntryCard>();
	for (const entry of run.demotion.entries) known.set(entry.id, entry);
	const pins = (guidance.pin ?? []).map((id) => {
		const entry = known.get(id);
		return entry ? entryFirstLine(entry.text) : id;
	});
	const drops = (guidance.drop ?? []).map((drop) => {
		const session = run.sessions.find((candidate) => candidate.id === drop.session);
		const title = session?.title ?? drop.session;
		const reason = (drop.reason ?? "").trim();
		return { text: reason ? `${title} · ${reason}` : title, leftOut: session?.outcome === "skipped" };
	});
	const topics = (guidance.topics ?? []).map((topic) => (
		"create" in topic
			? `Create the topic "${topic.create}"`
			: `Merge ${joinList(topic.merge.map((name) => `"${name}"`))} into "${topic.into}"`
	));
	const summary: AbsorbRunGuidanceSummary = {
		pins,
		drops,
		corrections: guidance.corrections ?? [],
		topics,
		removed: (run.requests ?? []).filter((request) => request.done).map((request) => (request.entry ? entryFirstLine(request.entry) : request.text)),
		notDone: (run.requests ?? []).filter((request) => !request.done).map((request) => ({ text: request.text, several: request.several === true })),
		instructions: (guidance.instructions ?? []).filter((text) => !(run.requests ?? []).some((request) => request.text === text)),
	};
	const empty = summary.pins.length === 0 && summary.drops.length === 0 && summary.corrections.length === 0 && summary.topics.length === 0 && summary.removed.length === 0 && summary.notDone.length === 0 && summary.instructions.length === 0;
	return empty ? null : summary;
}

// ── One name for applying a memory update without a second look ───────────
// The setting, the notes on the card and the saved screen all mean the same
// thing, so they say it in the same words. The stored setting key is older
// than the name and stays as it is.

/** The room setting's label, wherever it is named. */
export const AUTOMATIC_APPLY_SETTING_LABEL = "Memorize without the first read or the card";

/**
 * The Maintain chooser's Memorize card. In a room with the setting on, Start
 * goes straight to the update and a clean one is saved without the card, so
 * the card and the footnote under the cards say that instead of promising a
 * look before the save; Discuss first is the way to the first read there.
 */
export function memorizeChooserText(waiting: number, automatic: boolean): string {
	const conversations = waiting === 1 ? "remembered conversation" : `${waiting} remembered conversations`;
	return automatic
		? `Turn the ${conversations} into lasting notes, with no first read. A clean update is saved without the card; one with anything to weigh waits for you.`
		: `Turn the ${conversations} into lasting notes. You read what will be kept before it is saved; whatever does not fit in the budget goes to the archive.`;
}
/** The card's heading over the notes the one-time sort placed (draft). */
export function absorbRunSortedTitle(count: number): string {
	return count === 1 ? "1 note waiting in Unsorted was sorted into a topic" : `${count} notes waiting in Unsorted were sorted into topics`;
}

/**
 * The notes the one-time sort placed, less any the same run reads again into
 * notes: that row tells its story. A note is left out from the moment it waits
 * to be read, so the count holds from the run to its end; one whose read kept
 * nothing comes back.
 */
export function absorbRunSortedRows(run: AbsorbRun): NonNullable<AbsorbRun["sorted"]> {
	const reread = new Set((run.rereads ?? []).filter((row) => row.outcome === "pending" || row.outcome === "folding" || (row.outcome === "folded" && (row.changes?.length ?? 0) > 0)).map((row) => row.id));
	return (run.sorted ?? []).filter((row) => !reread.has(row.id));
}

/** The Memorize card's text when no conversation waits but notes in Unsorted do. */
export function memorizeNotesText(notes: number): string {
	return notes === 1 ? "1 note in Unsorted can be sorted into a topic." : `${notes} notes in Unsorted can be sorted into topics.`;
}
export function maintainChooserFootnote(automatic: boolean): string {
	return automatic
		? "A clean update is saved as soon as it is ready. The memory budget is set in Room settings."
		: "Nothing is saved until you approve it. The memory budget is set in Room settings.";
}
export const DISCUSS_FIRST_LABEL = "Discuss first";

export const DISCUSS_FIRST_TITLE = "Read the conversations first and talk through what to keep. Nothing is saved yet.";

/** The confirm before leaving a discussion. It is kept beside its first read, so one on a missing first read is not kept at all. */
export function discussionKeptSentence(flow: "Memorize" | "Review", firstReadMissing: boolean): string {
	return firstReadMissing
		? `With no first read, your discussion is not kept: it does not come back when you open ${flow} again.`
		: `Your discussion is kept; it comes back when you open ${flow} again, unless your memory or its Memory model changes first.`;
}

/** The same fact as a clause, for the sentences that build on it. */
export const AUTOMATIC_APPLY_ON_SENTENCE = "This room applies memory updates automatically";

/** Why an update the room would have applied is waiting for a person instead. */
export function automaticApplyNeedsReviewSentence(reasons: string[]): string {
	const because = reasons.length ? reasons.map((reason) => reason.replace(/\.$/, "")).join("; ") : "of the warnings listed above";
	return `${AUTOMATIC_APPLY_ON_SENTENCE}, but this update needs your review because ${because}.`;
}

/**
 * A room whose previous run was left mid-flight (a closed tab, a lost
 * connection) refuses the next update until that one stops. The person did not
 * abandon anything on purpose, so the screen states the fact plainly and hands
 * them the one action that clears it.
 */
export const ABSORB_RUN_ACTIVE_SENTENCE = "This room is still working on a previous memory update.";
export const ABSORB_RUN_ACTIVE_ACTION = "Stop that update";

/** The first-read screen when there is no first read: it failed, was cut, came back too long or could not be asked. Memorize goes on without it. */
export const FIRST_READ_MISSING_SENTENCE = "No first read this time. Read again, or continue without it.";

/** The same fact for a tidy the room never finished. */
export const REVIEW_RUN_ACTIVE_SENTENCE = "This room is still working on a previous tidy of its notes.";
export const REVIEW_RUN_ACTIVE_ACTION = "Stop that tidy";

/** The one sentence a busy room shows instead of its memory editing actions. */
export const MEMORY_EDIT_BLOCKED_SENTENCE = "Memory can be edited once the room finishes its answer.";

/** Lost contact with a run after the poll retries ran out. */
export const RUN_POLL_LOST_SENTENCE = "This screen lost contact with the update, which may still be running. Check your connection, then try again.";

/** How many times a poll may fail before the connection sentence replaces the screen. */
export const RUN_POLL_MAX_RETRIES = 3;

/** How often a working run is polled. */
export const RUN_POLL_INTERVAL_MS = 2000;


// --- Review (tidying the notes) -------------------------------------------------------------
// Review works note by note: it says the same things in fewer words, folds two
// notes that say one thing into one, and — at the deeper setting — moves what is
// finished or stale to the archive. The screens speak of topics, notes, the
// archive and how full memory is; the engine's words never reach them.

/** One change the tidy makes to a note, as the server reports it. */
export type ReviewChange = ReviewRunChange;

export interface ReviewChangeCounts {
	shortened: number;
	merged: number;
	archived: number;
	closed: number;
	moved: number;
	pinned: number;
	/** Topics folded into another; the row's notes count once, as the strip counts rows. */
	topic_folded: number;
	/** Notes whose words this tidy rewrote. */
	tidied: number;
	/** Notes that leave for the archive. */
	leaving: number;
	/** Every note this tidy touches. */
	notes: number;
	/** Topics holding at least one change. */
	topics: number;
}

/** How full the memory is against its limit, as a whole percent; 0 without a limit. */
export function memoryFullPercent(tokens: number, budgetTokens: number): number {
	if (budgetTokens <= 0) return 0;
	return Math.round((tokens / budgetTokens) * 100);
}

export function reviewChangeCounts(changes: ReviewChange[]): ReviewChangeCounts {
	const counts: ReviewChangeCounts = { shortened: 0, merged: 0, archived: 0, closed: 0, moved: 0, pinned: 0, topic_folded: 0, tidied: 0, leaving: 0, notes: 0, topics: 0 };
	const topics = new Set<string>();
	for (const change of changes) {
		counts[change.kind] += 1;
		topics.add(`${change.section} ${change.topic}`);
	}
	counts.tidied = counts.shortened + counts.merged;
	counts.leaving = counts.archived + counts.closed;
	counts.notes = changes.length;
	counts.topics = topics.size;
	return counts;
}

const REVIEW_CHANGE_LABELS: Record<ReviewRunChangeKind, string> = {
	shortened: "Shortened",
	merged: "Merged",
	archived: "Moved to the archive",
	closed: "Closed",
	moved: "Moved",
	pinned: "Pinned",
	topic_folded: "Topic folded",
};

export function reviewChangeKindLabel(kind: ReviewRunChangeKind): string {
	return REVIEW_CHANGE_LABELS[kind] ?? kind;
}

/** The one line of a fold row: which topic went into which, and how many notes went with it. */
export function reviewTopicFoldedLine(change: Pick<ReviewChange, "before" | "after" | "notesMoved">): string {
	const moved = change.notesMoved ?? 0;
	return `"${change.before ?? ""}" folded into "${change.after ?? ""}" — ${moved} ${moved === 1 ? "note" : "notes"} moved`;
}

/** The topic a person reads: the title without the section it sits in. */
export function reviewTopicName(change: Pick<ReviewChange, "topic" | "section">): string {
	const topic = change.topic.replace(/^(Deep Memory|Active Items)\s*\/\s*/, "").trim();
	if (!topic || topic === change.section) return topicLabel(change.section);
	return topicLabel(topic);
}

function plural(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`;
}

/** "3 shortened, 1 merged, 2 moved to the archive" — only the parts that happened. */
export function reviewChangeParts(counts: ReviewChangeCounts): string {
	const parts: string[] = [];
	if (counts.shortened > 0) parts.push(`${counts.shortened} shortened`);
	if (counts.merged > 0) parts.push(`${counts.merged} merged`);
	if (counts.archived > 0) parts.push(`${counts.archived} moved to the archive`);
	if (counts.closed > 0) parts.push(`${counts.closed} closed`);
	if (counts.moved > 0) parts.push(`${counts.moved} filed under another topic`);
	if (counts.pinned > 0) parts.push(`${counts.pinned} pinned`);
	// A fold is a topic, not a note, so it comes last and names itself.
	if (counts.topic_folded > 0) parts.push(`${counts.topic_folded} ${counts.topic_folded === 1 ? "topic" : "topics"} folded`);
	return parts.join(", ");
}

export const REVIEW_NOT_FINISHED_HEADLINE = "Review could not finish.";

/** The run stopped because the Memory model failed the same way twice in a row. */
export const REVIEW_STOPPED_REPEATING_SENTENCE = "The Memory model failed the same way twice, so Review stopped. Nothing was lost. Choose another model, or try again later.";

/** What Save does on a card where nothing was tidied but notes still leave for the budget. */
export function reviewBudgetSaveSentence(leavingForBudget: number): string {
	return `Saving moves ${plural(leavingForBudget, "note", "notes")} to the archive to stay within the budget; nothing else changes.`;
}

/** No note changed and topics were left as they were: the tidy did not get to them, so the notes are not "already tidy". */
function reviewNotFinishedSentence(topicsLeft: string[], leavingForBudget = 0, tryAgain = true): string {
	const left = topicsLeft.length === 1 ? `${topicsLeft[0]} this time, so it was left as it was` : `${topicsLeft.length} topics this time (${reviewTopicNames(topicsLeft)}), so they were left as they were`;
	// Notes still leave for the budget, so the card offers Save: say what it saves.
	if (leavingForBudget > 0) return `The Memory model could not tidy ${left}. ${reviewBudgetSaveSentence(leavingForBudget)}`;
	return `The Memory model could not tidy ${left}. Nothing was lost.${tryAgain ? " Try again; if it repeats, choose another model." : ""}`;
}

/** The topics named in a sentence; a long list names the first three and counts the rest. */
function reviewTopicNames(topics: string[]): string {
	const named = topics.slice(0, 3).join(", ");
	return topics.length > 3 ? `${named} and ${topics.length - 3} more` : named;
}

/** `topicsLeft`: the topics this tidy left as they were (reviewRunTopicsLeft). */
export function reviewCardHeadline(counts: ReviewChangeCounts, topicsLeft: string[] = []): string {
	if (counts.notes === 0) return topicsLeft.length > 0 ? REVIEW_NOT_FINISHED_HEADLINE : "Nothing needed changing.";
	return `${plural(counts.topics, "topic", "topics")} tidied.`;
}

/** `leavingForBudget`: the notes the budget sends to the archive if this is saved. */
export function reviewCardSentence(counts: ReviewChangeCounts, percentAfter: number, overAfter: boolean, topicsLeft: string[] = [], leavingForBudget = 0): string {
	// The percent lives on the strip and the budget line below; the sentence
	// says what happened and what to do, like the Memorize card's.
	if (counts.notes === 0) return topicsLeft.length > 0 ? reviewNotFinishedSentence(topicsLeft, leavingForBudget) : `The notes are already tidy. Memory is ${percentAfter}% full.`;
	const over = overAfter ? ` Memory stays above its budget (${percentAfter}% full).` : "";
	const left = topicsLeft.length > 0 ? ` ${reviewLeftAsIsSentence(topicsLeft)}` : "";
	return `${reviewChangeParts(counts)}. Read the changes, keep any note the room should not let go, then save.${over}${left}`;
}

/** `archivedForBudget`: the notes this save moved to the archive to stay within the budget. */
export function reviewSavedHeadline(roomName: string, counts: ReviewChangeCounts, topicsLeft: string[] = [], archivedForBudget = 0): string {
	if (counts.notes === 0 && archivedForBudget > 0) return `${roomName} made room in its memory.`;
	if (counts.notes === 0) return topicsLeft.length > 0 ? REVIEW_NOT_FINISHED_HEADLINE : `Nothing changed in ${roomName}'s memory.`;
	return `${roomName} tidied its memory.`;
}

/** `tryAgain`: the screen offers Try again for the topics left; without that button no line names it. */
export function reviewSavedSentence(counts: ReviewChangeCounts, percent: number, over: boolean, topicsLeft: string[] = [], archivedForBudget = 0, tryAgain = true): string {
	const memory = over ? `Memory is still above its budget (${percent}% full).` : `Memory is ${percent}% full.`;
	if (counts.notes === 0 && archivedForBudget > 0) {
		const left = topicsLeft.length === 0 ? "" : topicsLeft.length === 1 ? ` The Memory model could not tidy ${topicsLeft[0]} this time; it is unchanged.${tryAgain ? " Try again tidies it; if it repeats, choose another model." : ""}` : ` The Memory model could not tidy ${topicsLeft.length} topics this time (${reviewTopicNames(topicsLeft)}); they are unchanged.${tryAgain ? " Try again tidies them; if it repeats, choose another model." : ""}`;
		return `${reviewSavedArchiveSentence(archivedForBudget)}${left}`;
	}
	if (counts.notes === 0) return topicsLeft.length > 0 ? reviewNotFinishedSentence(topicsLeft, 0, tryAgain) : `The notes were already tidy. ${memory}`;
	const left = topicsLeft.length > 0 ? ` ${reviewLeftAsIsSentence(topicsLeft)}${tryAgain ? " Try again; if it repeats, choose another model." : ""}` : "";
	return `${plural(counts.topics, "topic", "topics")}: ${reviewChangeParts(counts)}. ${memory}${left}`;
}

/** One line for a topic's row on the card: "Incident history · 3 notes shortened, 1 moved to the archive". */
export function reviewTopicGroupSummary(topic: string, changes: ReviewChange[]): string {
	const counts = reviewChangeCounts(changes);
	const parts = reviewChangeParts(counts);
	// The first part gets the word "notes" unless it is a fold, which already names itself as a topic.
	const worded = parts
		? parts.replace(/^(\d+)(?! topics? folded)/, (match) => `${match} ${Number(match) === 1 ? "note" : "notes"}`)
		: plural(counts.notes, "note", "notes");
	return `${topicLabel(topic)} · ${worded}`;
}

export const REVIEW_DEPTH_ORDER: readonly ReviewDepth[] = ["wording", "tidy"];

export const REVIEW_DEPTH_ROWS: Record<ReviewDepth, { title: string; text: string }> = {
	wording: { title: "Tidy the wording", text: "Make the notes shorter and clearer, and merge notes that repeat or disagree." },
	tidy: { title: "Tidy and move what is finished or stale to the archive", text: "Shorter wording, and notes that are finished, stale or said twice move to the archive, where they can be brought back." },
};

/** Why one depth is offered first, in the person's terms: how full the memory is, never tokens. */
/** `firstReadMissing`: nothing was read, so the sentence names nothing a read would have found. */
export function reviewDepthSentence(input: { overBudget: boolean; staleFlagged: boolean; lookAlike?: boolean; disagreeing?: number; firstReadMissing?: boolean; budgetTokens: number; reviewTargetTokens: number }): string {
	if (input.overBudget) return "Memory is above its budget, so moving what is finished or stale to the archive is recommended.";
	if (input.staleFlagged) return "The first read found stale notes, so moving them to the archive is recommended.";
	// `lookAlike`: the same finding the server's recommendation reads, so the sentence never contradicts it.
	if (input.lookAlike) return "Some topics look the same, and only the second option can join them, so it is recommended.";
	// `disagreeing`: the pairs of notes the first read found disagreeing. Both depths settle them the same way, by a merge.
	if ((input.disagreeing ?? 0) === 1) return "Two notes disagree. Either tidy can merge them into one note, and the text it replaces is kept in the archive.";
	if ((input.disagreeing ?? 0) > 1) return "Some notes disagree. Either tidy can merge each pair into one note, and the texts it replaces are kept in the archive.";
	return `Memory is ${memoryFullPercent(input.reviewTargetTokens, input.budgetTokens)}% full${input.firstReadMissing ? "" : " and nothing looks stale"}, so tidying the wording is enough.`;
}

// --- The Review run --------------------------------------------------------

/** Which screen a tidy belongs on. The three working states share one screen. */
export type ReviewRunScreen = "running" | "ready" | "approving" | "saved" | "cancelled" | "failed";

export function reviewRunScreen(state: ReviewRun["state"]): ReviewRunScreen {
	if (state === "prepass" || state === "tidying" || state === "budget") return "running";
	return state;
}

export function reviewRunIsWorking(state: ReviewRun["state"]): boolean {
	return reviewRunScreen(state) === "running";
}

/** The working screen's one line. The server's label is already a topic title. */
export function reviewRunProgressLine(run: ReviewRun): string {
	if (run.state === "prepass") return "Reading this room's notes…";
	if (run.state === "budget") return "Checking the memory budget…";
	const label = (run.progress.label ?? "").trim();
	if (run.progress.groups <= 1) return label ? `Tidying ${topicLabel(label)}…` : "Tidying the notes…";
	const position = Math.min(run.progress.group + 1, run.progress.groups);
	return `Tidying part ${position} of ${run.progress.groups}${label ? ` · ${topicLabel(label)}` : ""}`;
}

/** How full memory is after this tidy, as the percentage a person reads everywhere else. */
export function reviewRunFullPercent(run: ReviewRun): number {
	return memoryFullPercent(run.budget.after + Math.max(0, run.demotion.overageTokens), run.budget.budgetTokens);
}

/** Notes the limit sends to the archive if this is saved as it stands. The tidy's own archive moves are listed under Changes. */
export function reviewRunArchiveCount(run: ReviewRun): number {
	return run.demotion.counts.leaving;
}

/**
 * Automatic maintenance for a tidy: apply only when there is nothing for a
 * person to weigh. Anything leaving for the archive — for the budget, or
 * because the tidy judged it stale, duplicate or finished — any merge, any
 * closed item, any topic folded into another, any crossing of the limit, any
 * topic the tidy could not do, and any warning falls to the card with the
 * reason named. A note worded better, moved or pinned is the fast path's own
 * business: nothing leaves and nothing is judged.
 */
export function reviewRunFastPathBlockers(run: ReviewRun): string[] {
	const blockers: string[] = stoppedRunBlocker(run.stop);
	const leaving = run.demotion.counts.leaving;
	if (leaving > 0) {
		blockers.push(leaving === 1
			? "1 note would move to the archive to stay within the budget"
			: `${leaving} notes would move to the archive to stay within the budget`);
	}
	if (run.budget.overBudgetAfter) blockers.push("saving would leave memory above its budget");
	const counts = reviewChangeCounts(run.changes);
	if (counts.archived > 0) blockers.push(counts.archived === 1 ? "1 note would move to the archive" : `${counts.archived} notes would move to the archive`);
	// A merge row is the note that survives; the notes it took in are the ones a person would want to see go.
	const merged = run.changes.filter((change) => change.kind === "merged").reduce((sum, change) => sum + (change.mergedFrom?.length ?? 2), 0);
	if (merged > 0) blockers.push(merged === 1 ? "1 note would be merged" : `${merged} notes would be merged`);
	if (counts.closed > 0) blockers.push(counts.closed === 1 ? "1 open item would be closed" : `${counts.closed} open items would be closed`);
	if (counts.topic_folded > 0) blockers.push(counts.topic_folded === 1 ? "1 topic would be folded into another" : `${counts.topic_folded} topics would be folded into another`);
	// A topic left as it was asks nothing of the person: it never stops the save.
	return blockers;
}

/** The line for the topics a tidy left as they were, beside what it did tidy; why is for the diagnostics. */
export function reviewLeftAsIsSentence(topics: string[]): string {
	return topics.length === 1 ? `${topics[0]} could not be tidied this time and was left as it was.` : `${topics.length} topics could not be tidied this time (${reviewTopicNames(topics)}) and were left as they were.`;
}

/** The topics a tidy left as they were, by the names a person reads. */
export function reviewRunTopicsLeft(run: Pick<ReviewRun, "leftAsIs">): string[] {
	return run.leftAsIs.flatMap((group) => group.topics.map(topicLabel));
}

/** Topics were left as they were and nothing changed, leaves for the budget or moved the budget: a save would only record a review that tidied nothing. */
export function reviewRunNothingToSave(run: Pick<ReviewRun, "leftAsIs" | "changes" | "demotion" | "budget">): boolean {
	return reviewRunTopicsLeft(run).length > 0 && run.changes.length === 0 && run.demotion.counts.leaving === 0 && !runBudgetChanged(run);
}

/** What the person agreed in the discussion, as the card lists it back. */
export interface ReviewGuidanceSummary {
	keepAsIs: string[];
	shorten: string[];
	remove: string[];
	/** The archive lines this save would not carry out, each as its whole "Not done" sentence. */
	removeNotDone: string[];
	answers: string[];
	instructions: string[];
	topics: string[];
}

/**
 * A sign-off line as the card shows it: the model wrote it for the run, with
 * note ids and the file's section names; the person reads it with neither,
 * and as said to them.
 */
export function reviewGuidanceLine(text: string): string {
	return text
		.replace(/\s*[([]\s*m-\d{3,}(?:\s*[,·;]\s*(?:m-\d{3,}|pinned))*\s*[)\]]/g, "")
		.replace(/\s*\bm-\d{3,}\b/g, "")
		.replace(/\bActive Items\b/g, "Open items")
		.replace(/\b(?:The person|The user) asked\b/g, "You asked")
		.replace(/\b(?:the person|the user) asked\b/g, "you asked")
		.replace(/\s+([.,;:])/g, "$1")
		.trim();
}

/** An archive the person asked for that this save would not make (draft). */
export function reviewRemovalNotDoneSentence(line: string): string {
	const text = reviewGuidanceLine(line);
	return `Not done: ${text}${/[.!?]$/.test(text) ? "" : "."} It is still in memory; you can delete it on the Memory page.`;
}

export function reviewRunGuidanceSummary(run: ReviewRun): ReviewGuidanceSummary | null {
	const guidance = run.guidance;
	if (!guidance) return null;
	const plain = (lines: string[] | undefined) => (lines ?? []).map(reviewGuidanceLine).filter(Boolean);
	const notDone = new Set(run.removeNotDone ?? []);
	const summary: ReviewGuidanceSummary = {
		keepAsIs: plain(guidance.keepAsIs),
		shorten: plain(guidance.shorten),
		remove: plain((guidance.remove ?? []).filter((line) => !notDone.has(line))),
		removeNotDone: (guidance.remove ?? []).filter((line) => notDone.has(line)).map(reviewRemovalNotDoneSentence),
		answers: plain(guidance.answers),
		instructions: plain(guidance.instructions),
		topics: (guidance.topics ?? []).map(topicLabel),
	};
	const empty = Object.values(summary).every((list) => list.length === 0);
	return empty ? null : summary;
}

/** The saved screen's extra line when the budget, not the tidy, sent notes to the archive. */
/** Save's confirm for a review that tidied nothing: only notes leaving for the budget are saved. */
export function reviewBudgetOnlyConfirmBody(leaving: number): string {
	return `${leaving === 1 ? "1 note moves" : `${leaving} notes move`} to the archive to stay within the budget. Nothing else changes.`;
}

export function reviewSavedArchiveSentence(archivedForBudget: number): string | null {
	if (archivedForBudget <= 0) return null;
	return archivedForBudget === 1
		? "1 note moved to the archive to stay within the budget."
		: `${archivedForBudget} notes moved to the archive to stay within the budget.`;
}
