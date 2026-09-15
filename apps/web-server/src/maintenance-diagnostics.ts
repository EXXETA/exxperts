import fs from "node:fs";
import path from "node:path";

import { estimateTokens } from "./token-estimate.js";

/**
 * The numbers behind a maintenance run, and nothing else.
 *
 * When a Memorize or Review run fails in the field, the two explanations look
 * identical from the outside: a reply cut at the model's output ceiling, and a
 * complete reply whose headings deviated from the template. Telling them apart
 * needs the sizes, the stop reason and which expected headings the reply
 * actually carried — and none of that is anything a user should have to paste
 * their memory into a report to show.
 *
 * So every worker call writes one record here: sizes, timings, stop reason,
 * which expected markers were found, how the validator judged it, and how the
 * step ended. Never a prompt, never a reply, never a line of the room's memory.
 * The export is a single JSON document a user can attach to a report without
 * reading it first.
 */

export const MAINTENANCE_DIAGNOSTICS_DIRNAME = "maintenance-diagnostics";
/** Newest records kept on disk per room; older ones are pruned as new ones land. */
export const MAINTENANCE_DIAGNOSTICS_KEEP = 200;
/** Default page size of the reader and the route. */
export const MAINTENANCE_DIAGNOSTICS_DEFAULT_LIMIT = 50;

export const MAINTENANCE_DIAGNOSTICS_PROCESSES = [
	"memorize-assessment",
	"memorize-discussion",
	"memorize-discussion-signoff",
	"memorize-proposal",
	"memorize-fold",
	// The four Review names below belong to records written before Review
	// became a run: no call writes them any more, and they stay on the list so
	// a room's older records still read. A run writes "review-tidy".
	"review-assessment",
	"review-discussion",
	"review-discussion-signoff",
	"review-proposal",
	"review-tidy",
	"remember-compression",
	"consult",
] as const;
export type MaintenanceDiagnosticsProcess = (typeof MAINTENANCE_DIAGNOSTICS_PROCESSES)[number];

/**
 * The markers each reply is supposed to carry. They are the product's own
 * template text, written here as a closed list precisely so nothing the model
 * wrote is ever copied into a record: a marker is reported as found or missing,
 * never quoted back from the reply.
 */
export const MEMORIZE_PROPOSAL_MARKERS = ["Mode", "Primacy Map", "Section-Level Change Log", "Entry-Level Detail", "Compression Metrics", "Warnings", "Candidate L1b"] as const;
export const REVIEW_OPS_PROPOSAL_MARKERS = ["Summary", "Staleness Flags", "Warnings", "Operations"] as const;
export const MEMORIZE_ASSESSMENT_MARKERS = ["What to remember", "What to forget", "What changes in stable memory", "Needs your judgment"] as const;
export const REVIEW_ASSESSMENT_MARKERS = ["Memory map", "Looks healthy", "Stale or drift-prone", "Could be denser", "Structure opportunities", "Proposed direction"] as const;
export const REMEMBER_MARKERS = ["TITLE", "SESSION_ARC", "BODY", "PARKED"] as const;

const DEFAULT_MARKERS: Readonly<Record<MaintenanceDiagnosticsProcess, readonly string[]>> = {
	"memorize-assessment": MEMORIZE_ASSESSMENT_MARKERS,
	"memorize-discussion": [],
	"memorize-discussion-signoff": [],
	"memorize-proposal": MEMORIZE_PROPOSAL_MARKERS,
	// A fold answers with a narrative and one ```json fence, not with headings:
	// its parse signature is the fence's state, which the recorder reads on
	// every reply whatever the marker list says.
	"memorize-fold": [],
	"review-assessment": REVIEW_ASSESSMENT_MARKERS,
	"review-discussion": [],
	"review-discussion-signoff": [],
	"review-proposal": REVIEW_OPS_PROPOSAL_MARKERS,
	// A tidy answers with a narrative and one ```json fence, not with headings:
	// its parse signature is the fence's state, which the recorder reads on
	// every reply whatever the marker list says.
	"review-tidy": [],
	"remember-compression": REMEMBER_MARKERS,
	consult: [],
};

export type MaintenanceDiagnosticsMarkerState = "exact" | "deviating" | "missing";
export type MaintenanceDiagnosticsFenceState = "absent" | "unterminated" | "complete";
export type MaintenanceDiagnosticsOutcome = "accepted" | "refused" | "retried" | "error";

export interface MaintenanceDiagnosticsParseSignature {
	/** One entry per marker the template asked for; the name is the template's, never the reply's. */
	markers: Array<{ marker: string; state: MaintenanceDiagnosticsMarkerState }>;
	/** How many `###` headings the reply carried that the template did not ask for — counted, never quoted. */
	unexpectedHeadings: number;
	/** State of the reply's ```json fence, when the process asks for one. */
	jsonFence: MaintenanceDiagnosticsFenceState;
}

export interface MaintenanceDiagnosticsRecord {
	schemaVersion: 1;
	agentId: string;
	process: MaintenanceDiagnosticsProcess;
	at: string;
	attempt: number;
	provider: string;
	model: string;
	promptChars: number;
	promptEstimatedTokens: number;
	replyChars: number;
	inputTokens?: number;
	outputTokens?: number;
	stopReason?: string;
	truncated: boolean;
	modelMaxOutputTokens?: number;
	wallTimeMs: number;
	parseSignature: MaintenanceDiagnosticsParseSignature;
	validatorErrors: string[];
	validatorWarnings: string[];
	outcome: MaintenanceDiagnosticsOutcome;
	/** The review group this call worked on, when the run handed the areas out in groups. */
	group?: { index: number; count: number };
	/** The class of a failure (the error's own name). */
	errorClass?: string;
	/**
	 * The failure's own sentence — a provider's HTTP error, a dropped stream, a
	 * worker that ran past its ceiling — redacted like every other sentence here.
	 * The user is told what a failure MEANS for their memory; this is where the
	 * technical cause survives, so a report can name it without the card doing so.
	 */
	errorSentence?: string;
}

export function maintenanceDiagnosticsDir(roomRootDir: string): string {
	return path.join(roomRootDir, "events", MAINTENANCE_DIAGNOSTICS_DIRNAME);
}

// --- Signatures ---------------------------------------------------------------

/** Everything a marker can be dressed up in and still be that marker. */
function normalizeMarker(line: string): string {
	return line
		.replace(/^#+\s*/, "")
		.replace(/^\d+[.)]\s*/, "")
		.replace(/[*_`]/g, "")
		.replace(/:\s*$/, "")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

/**
 * Which of the expected markers the reply carried, in what shape, plus how many
 * headings it invented and what its json fence did. This is the field evidence
 * that separates "the reply was cut" from "the reply was complete but its
 * headings deviated" — the two failures that reach the user as the same screen.
 */
export function maintenanceDiagnosticsParseSignature(reply: string, markers: readonly string[]): MaintenanceDiagnosticsParseSignature {
	const lines = reply.split(/\r?\n/);
	const headingLines = lines.filter((line) => /^#{2,6}\s+\S/.test(line));
	const exact = new Set<string>();
	const deviating = new Set<string>();
	for (const marker of markers) {
		const heading = new RegExp(`^###\\s+${marker.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\s*$`, "m");
		const labelled = new RegExp(`^${marker.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}:\\s*$`, "m");
		if (heading.test(reply) || labelled.test(reply)) { exact.add(marker); continue; }
		const wanted = normalizeMarker(marker);
		if (lines.some((line) => normalizeMarker(line) === wanted)) deviating.add(marker);
	}
	const markerStates = markers.map((marker) => ({
		marker,
		state: (exact.has(marker) ? "exact" : deviating.has(marker) ? "deviating" : "missing") as MaintenanceDiagnosticsMarkerState,
	}));
	const wantedSet = new Set(markers.map(normalizeMarker));
	const unexpectedHeadings = headingLines.filter((line) => !wantedSet.has(normalizeMarker(line))).length;
	const fences = reply.match(/```/g)?.length ?? 0;
	const jsonFence: MaintenanceDiagnosticsFenceState = !/```json/i.test(reply) ? "absent" : fences % 2 === 0 ? "complete" : "unterminated";
	return { markers: markerStates, unexpectedHeadings, jsonFence };
}

/**
 * A validator sentence, with everything it quoted back taken out.
 *
 * Validator messages are written for the user, so they name what went wrong by
 * quoting it — an area title, a line that could not be found, an entry that
 * lost its date. Those quotes are the room's own memory. The product puts them
 * inside quotes, backticks or parentheses, so those spans go; and whatever
 * survives is checked against the room's own text as a backstop, because a
 * sentence that still shares a long run with the memory is not a product
 * sentence however it looks. A redacted-away message costs a little detail in a
 * report; a leaked one costs the promise that the export is safe to send.
 */
export function redactMaintenanceDiagnosticsSentence(sentence: string, roomText?: string, normalizedRoomText?: string): string {
	let redacted = sentence
		.replace(/"[^"]*"/g, '"…"')
		.replace(/`[^`]*`/g, "`…`")
		.replace(/\([^)]*\)/g, "(…)")
		.replace(/\s+/g, " ")
		.trim();
	if (redacted.length > 300) redacted = `${redacted.slice(0, 300)}…`;
	const haystack = normalizedRoomText ?? (roomText === undefined ? undefined : normalizeForComparison(roomText));
	if (haystack && sharesLongRunWith(redacted, haystack)) return "[redacted: this message quoted the room]";
	return redacted;
}

const SHARED_RUN_LENGTH = 12;

function normalizeForComparison(text: string): string {
	return text.replace(/\s+/g, " ").toLowerCase();
}

function sharesLongRunWith(sentence: string, haystack: string): boolean {
	const needle = normalizeForComparison(sentence);
	if (needle.length < SHARED_RUN_LENGTH) return false;
	for (let i = 0; i + SHARED_RUN_LENGTH <= needle.length; i++) {
		const window = needle.slice(i, i + SHARED_RUN_LENGTH);
		if (window.includes("…")) continue;
		if (haystack.includes(window)) return true;
	}
	return false;
}

// --- Writing and reading -------------------------------------------------------

function stampForFilename(at: Date): string {
	const iso = at.toISOString();
	return iso.replace(/[:.]/g, "-").replace(/Z$/, "");
}

function recordFilePath(dir: string, at: Date, process: MaintenanceDiagnosticsProcess): string {
	const base = `${stampForFilename(at)}-${process}`;
	let file = path.join(dir, `${base}.json`);
	// Two calls inside one millisecond (a retry against a scripted model) must
	// not overwrite each other's record.
	for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${base}-${n}.json`);
	return file;
}

function pruneMaintenanceDiagnostics(dir: string): void {
	try {
		const files = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
		for (const name of files.slice(0, Math.max(0, files.length - MAINTENANCE_DIAGNOSTICS_KEEP))) {
			try { fs.unlinkSync(path.join(dir, name)); } catch {}
		}
	} catch {}
}

/**
 * Write (or rewrite) one record. Diagnostics must never be the reason a
 * maintenance step fails, so every failure here is swallowed and reported as a
 * missing record rather than thrown at the user mid-run.
 */
export function writeMaintenanceDiagnosticsRecord(roomRootDir: string, record: MaintenanceDiagnosticsRecord, file?: string): string | null {
	try {
		const dir = maintenanceDiagnosticsDir(roomRootDir);
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const target = file ?? recordFilePath(dir, new Date(record.at), record.process);
		fs.writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
		if (!file) pruneMaintenanceDiagnostics(dir);
		return target;
	} catch {
		return null;
	}
}

/** The room's records, newest first, capped. A room with no records reads as an empty list, never an error. */
export function listMaintenanceDiagnostics(roomRootDir: string, limit = MAINTENANCE_DIAGNOSTICS_DEFAULT_LIMIT): MaintenanceDiagnosticsRecord[] {
	const dir = maintenanceDiagnosticsDir(roomRootDir);
	let names: string[];
	try {
		names = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort().reverse().slice(0, MAINTENANCE_DIAGNOSTICS_KEEP);
	} catch {
		return [];
	}
	const records: MaintenanceDiagnosticsRecord[] = [];
	for (const name of names) {
		try {
			records.push(JSON.parse(fs.readFileSync(path.join(dir, name), "utf-8")) as MaintenanceDiagnosticsRecord);
		} catch {
			// A half-written record is skipped, never fatal to the listing.
		}
	}
	// Ordered by what the records say, not by what they are called: a retry can
	// land in the same millisecond as the call it retried, and then the second
	// file's name sorts before the first's. Newest first, and within one
	// millisecond the later attempt first.
	records.sort((a, b) => (a.at === b.at ? (b.attempt ?? 0) - (a.attempt ?? 0) : a.at < b.at ? 1 : -1));
	return records.slice(0, Math.max(1, limit));
}

export interface MaintenanceDiagnosticsExport {
	schemaVersion: 1;
	agentId: string;
	exportedAt: string;
	recordCount: number;
	records: MaintenanceDiagnosticsRecord[];
}

/** Every record the room still holds, as one document a user can attach to a report. */
export function exportMaintenanceDiagnostics(roomRootDir: string, agentId: string, now = new Date()): MaintenanceDiagnosticsExport {
	const records = listMaintenanceDiagnostics(roomRootDir, MAINTENANCE_DIAGNOSTICS_KEEP);
	return { schemaVersion: 1, agentId, exportedAt: now.toISOString(), recordCount: records.length, records };
}

// --- Instrumentation ------------------------------------------------------------

/** The shape every maintenance worker result shares; only the numbers are read. */
interface MaintenanceWorkerGenerated {
	text: string;
	usage?: { input?: number; output?: number } | undefined;
	truncated?: boolean;
	modelMaxOutputTokens?: number;
	stopReason?: string;
}

export interface MaintenanceDiagnosticsInput {
	roomRootDir: string;
	agentId: string;
	process: MaintenanceDiagnosticsProcess;
	/** Overrides the process default, for a process whose reply shape depends on how it was asked. */
	markers?: readonly string[];
	/**
	 * The room's own text, used ONLY to check that no validator sentence quoted
	 * it. It is never written and never leaves this module.
	 */
	roomText?: string;
	now?: () => Date;
}

export interface MaintenanceDiagnosticsRecorder<TModel, TResult> {
	/** Drop-in replacement for the worker's generate function; records one file per call. */
	generate: (prompt: string, model: TModel) => Promise<TResult>;
	/** Final judgement of the most recent call, once the caller knows it. */
	annotate: (update: { outcome?: MaintenanceDiagnosticsOutcome; validatorErrors?: readonly string[]; validatorWarnings?: readonly string[]; group?: { index: number; count: number } }) => void;
	/** Paths written so far, oldest first — for callers that want to name them. */
	recordPaths: () => string[];
}

/**
 * Wrap a worker's generate function so every call it makes leaves a record.
 *
 * The wrapper alone already tells most of the story: a call that throws is an
 * error with its class, a reply the provider cut is a refusal, and a call
 * followed by another call on the same worker was a retry. The caller only has
 * to say how the last one ended.
 */
export function recordMaintenanceWorkerCalls<TModel extends { provider: string; model: string }, TResult extends MaintenanceWorkerGenerated>(
	input: MaintenanceDiagnosticsInput,
	generate: (prompt: string, model: TModel) => Promise<TResult>,
): MaintenanceDiagnosticsRecorder<TModel, TResult> {
	const markers = input.markers ?? DEFAULT_MARKERS[input.process];
	const now = input.now ?? (() => new Date());
	const normalizedRoomText = input.roomText === undefined ? undefined : normalizeForComparison(input.roomText);
	const written: Array<{ file: string; record: MaintenanceDiagnosticsRecord }> = [];
	let attempt = 0;

	const put = (record: MaintenanceDiagnosticsRecord, existing?: string): void => {
		const file = writeMaintenanceDiagnosticsRecord(input.roomRootDir, record, existing);
		if (!file) return;
		if (existing) {
			const slot = written.find((entry) => entry.file === existing);
			if (slot) slot.record = record;
			return;
		}
		written.push({ file, record });
	};

	return {
		generate: async (prompt, model) => {
			attempt += 1;
			// A call that follows another on the same worker means the first was
			// retried, whatever it looked like on its own.
			const previous = written[written.length - 1];
			if (previous && previous.record.outcome === "accepted") put({ ...previous.record, outcome: "retried" }, previous.file);
			const startedAt = Date.now();
			const base = {
				schemaVersion: 1 as const,
				agentId: input.agentId,
				process: input.process,
				at: now().toISOString(),
				attempt,
				provider: model.provider,
				model: model.model,
				promptChars: prompt.length,
				promptEstimatedTokens: estimateTokens(prompt),
				validatorErrors: [] as string[],
				validatorWarnings: [] as string[],
			};
			try {
				const result = await generate(prompt, model);
				put({
					...base,
					replyChars: result.text?.length ?? 0,
					...(typeof result.usage?.input === "number" ? { inputTokens: result.usage.input } : {}),
					...(typeof result.usage?.output === "number" ? { outputTokens: result.usage.output } : {}),
					...(result.stopReason ? { stopReason: result.stopReason } : {}),
					truncated: result.truncated === true,
					...(typeof result.modelMaxOutputTokens === "number" ? { modelMaxOutputTokens: result.modelMaxOutputTokens } : {}),
					wallTimeMs: Date.now() - startedAt,
					parseSignature: maintenanceDiagnosticsParseSignature(result.text ?? "", markers),
					// A reply the provider cut is refused before anything reads it;
					// the caller never gets the chance to say so.
					outcome: result.truncated === true ? "refused" : "accepted",
				});
				return result;
			} catch (error) {
				put({
					...base,
					replyChars: 0,
					truncated: false,
					wallTimeMs: Date.now() - startedAt,
					parseSignature: maintenanceDiagnosticsParseSignature("", markers),
					outcome: "error",
					errorClass: (error as Error)?.name || "Error",
					...((error as Error)?.message?.trim() ? { errorSentence: redactMaintenanceDiagnosticsSentence((error as Error).message, undefined, normalizedRoomText) } : {}),
				});
				throw error;
			}
		},
		annotate: (update) => {
			const slot = written[written.length - 1];
			if (!slot) return;
			put({
				...slot.record,
				...(update.outcome ? { outcome: update.outcome } : {}),
				...(update.group ? { group: update.group } : {}),
				...(update.validatorErrors ? { validatorErrors: update.validatorErrors.map((message) => redactMaintenanceDiagnosticsSentence(message, undefined, normalizedRoomText)) } : {}),
				...(update.validatorWarnings ? { validatorWarnings: update.validatorWarnings.map((message) => redactMaintenanceDiagnosticsSentence(message, undefined, normalizedRoomText)) } : {}),
			}, slot.file);
		},
		recordPaths: () => written.map((entry) => entry.file),
	};
}
