import fs from "node:fs";
import { estimateTokens } from "./token-estimate.js";
import { reviewTargetTokens, parseMemoryDocument } from "./memory-entries.js";
import { rememberPartsOfPage, memoryTextHasWords, rememberPartsTyped, rememberPageFromParts } from "./memory-typed-text.js";
import { countRecentContextEntries } from "./recent-context-entries.js";
import path from "node:path";
import { CHECKPOINT_PAGE_MAX_CHARS } from "./checkpoint-compression.js";
import { rememberLocalDay } from "./remember-two-stage.js";
import { type CheckpointDensity, fingerprintL1bSource, type NormalizedPersistentAgentScaffoldInput, type PersistentAgentId, type PersistentAgentMemoryStatusLevel, type PersistentAgentPromptBudgetState, type PersistentAgentStatus, STABLE_DURABLE_L1B_SECTIONS, type StableDurableL1bSection } from "./persistent-agent-types.js";
import type { CheckpointApprovalAcceptedRequest, CheckpointEventRecord, L1bEventSectionMetric, L1bEventStateMetrics, L1bMutationEventPaths, L1bMutationSectionDelta, SanitizedUsageMetrics, StableMemoryEventMetrics } from "./persistent-agent-memory-types.js";
import { type AgentJson, agentRootRelativePath, createPersistentAgentInstance, type PersistentAgentPathContext, RECENT_CONTEXT_HARD_CAP, RECENT_CONTEXT_SOFT_CAP, validatePersistentAgentId } from "./persistent-agent-store.js";

function topLevelL1bSections(l1b: string): L1bEventSectionMetric[] {
	const matches = Array.from(l1b.matchAll(/^##\s+(.+?)\s*$/gm));
	return matches.map((match, index) => {
		const start = match.index ?? 0;
		const end = index + 1 < matches.length ? matches[index + 1].index ?? l1b.length : l1b.length;
		const body = l1b.slice(start, end).trimEnd() + "\n";
		return {
			title: match[1].trim(),
			bytes: Buffer.byteLength(body, "utf-8"),
			estimatedTokens: estimateTokens(body),
			fingerprint: fingerprintL1bSource(body),
		};
	});
}

/**
 * The state block every memory event record carries. Exported so a reader can
 * measure a file the SAME way the record measured it — an undo compares the
 * file on disk with the fingerprint its save recorded, and a second arithmetic
 * would make that comparison a guess.
 */
export function l1bStateMetrics(l1b: string): L1bEventStateMetrics {
	const normalized = l1b.trimEnd() + "\n";
	const topLevel = topLevelL1bSections(normalized);
	const recentContext = topLevel.find((section) => section.title === "Recent Context") ?? {
		title: "Recent Context",
		bytes: 0,
		estimatedTokens: 0,
		fingerprint: fingerprintL1bSource(""),
	};
	const nonRecentContextText = topLevel
		.filter((section) => section.title !== "Recent Context")
		.map((section) => `${section.title}\u0000${section.fingerprint.value}\u0000${section.bytes}\u0000${section.estimatedTokens}`)
		.join("\n");
	return {
		l1bFingerprint: fingerprintL1bSource(normalized),
		recentContextEntryCount: countRecentContextEntries(normalized),
		estimatedTokens: estimateTokens(normalized),
		bytes: Buffer.byteLength(normalized, "utf-8"),
		sections: {
			topLevel,
			recentContext: { ...recentContext, entryCount: countRecentContextEntries(normalized) },
			nonRecentContext: {
				title: "__non_recent_context__",
				bytes: topLevel.filter((section) => section.title !== "Recent Context").reduce((sum, section) => sum + section.bytes, 0),
				estimatedTokens: topLevel.filter((section) => section.title !== "Recent Context").reduce((sum, section) => sum + section.estimatedTokens, 0),
				fingerprint: fingerprintL1bSource(nonRecentContextText),
			},
		},
	};
}

function deriveL1bMutationSections(source: L1bEventStateMetrics, result: L1bEventStateMetrics): L1bMutationSectionDelta {
	const sourceSections = new Map(source.sections.topLevel.map((section) => [section.title, section]));
	const resultSections = new Map(result.sections.topLevel.map((section) => [section.title, section]));
	const affected = new Set<string>();
	const preserved: string[] = [];
	for (const section of source.sections.topLevel) {
		const resultSection = resultSections.get(section.title);
		if (resultSection && resultSection.fingerprint.value === section.fingerprint.value) {
			preserved.push(section.title);
		} else {
			affected.add(section.title);
		}
	}
	for (const section of result.sections.topLevel) {
		const sourceSection = sourceSections.get(section.title);
		if (!sourceSection || sourceSection.fingerprint.value !== section.fingerprint.value) affected.add(section.title);
	}
	return { sectionsAffected: Array.from(affected), sectionsPreserved: preserved };
}

function buildL1bMutationEventPaths(root: PersistentAgentPathContext, archivedL1bPath: string, updatedL1bPath: string, eventRecordPath: string): L1bMutationEventPaths {
	return {
		archivedL1bRelPath: agentRootRelativePath(root, archivedL1bPath),
		updatedL1bRelPath: agentRootRelativePath(root, updatedL1bPath),
		eventRelPath: agentRootRelativePath(root, eventRecordPath),
	};
}

function sanitizeNumericUsage(rawUsage: unknown): SanitizedUsageMetrics | undefined {
	const source = rawUsage as Partial<Record<keyof SanitizedUsageMetrics, unknown>> | null | undefined;
	const sanitized: SanitizedUsageMetrics = {};
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"] as const) {
		const value = source?.[key];
		if (typeof value === "number" && Number.isFinite(value)) sanitized[key] = value;
	}
	return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function stableMemoryAggregateMetrics(state: L1bEventStateMetrics, sectionTitles: StableDurableL1bSection[] = [...STABLE_DURABLE_L1B_SECTIONS]): StableMemoryEventMetrics {
	const included = sectionTitles.map((title) => state.sections.topLevel.find((section) => section.title === title)).filter((section): section is L1bEventSectionMetric => Boolean(section));
	const fingerprintInput = included.map((section) => `${section.title}\u0000${section.fingerprint.value}\u0000${section.bytes}\u0000${section.estimatedTokens}`).join("\n");
	return {
		sectionTitles,
		bytes: included.reduce((sum, section) => sum + section.bytes, 0),
		estimatedTokens: included.reduce((sum, section) => sum + section.estimatedTokens, 0),
		fingerprint: fingerprintL1bSource(fingerprintInput),
	};
}

// The ONE review-target numerator: Deep Memory + Active Items, selected by
// section title (tolerant of extra or reordered sections — unlike the review
// topology extractor, which is a different job). The status block and the
// memory-page breakdown must agree to the token, so both compute through here;
// a second extraction path is a second denominator, which is banned.
//
// It measures the CONTEXT render — what the room actually pays for its durable
// memory on every turn — not the bytes on disk. On a migrated room those differ
// by the ~15 tokens an entry's metadata comment costs in storage and never
// costs the model, and a budget that counted them would charge a room for its
// own bookkeeping. renderMemoryContext is the identity on a file that has never
// been migrated, so for every v1 room this is the same number it always was.
export function reviewTargetEstimatedTokensFromL1b(l1b: string): number {
	// The one number every surface and the limit rule share: the notes and open
	// items as the model reads them, measured the way the engine measures them
	// when it decides what fits. Two arithmetics here would show a person two
	// different "% full" for one memory.
	return reviewTargetTokens(parseMemoryDocument(l1b));
}

export function readPersistentAgentReviewTargetEstimatedTokens(agentIdRaw: string): number | null {
	const instance = createPersistentAgentInstance(validatePersistentAgentId(agentIdRaw));
	const l1bPath = path.join(instance.rootDir, "L1b", "current.md");
	if (!fs.existsSync(l1bPath)) return null;
	return reviewTargetEstimatedTokensFromL1b(fs.readFileSync(l1bPath, "utf-8"));
}

function isCheckpointDensity(value: string): value is CheckpointDensity {
	return value === "compact" || value === "standard" || value === "rich";
}

function extractApprovedRecentContextField(markdown: string, label: "Session arc" | "Body" | "Parked", nextLabels: Array<"Session arc" | "Body" | "Parked">): string | null {
	const startPattern = new RegExp(`\\*\\*${label}:\\*\\*`, "i");
	const startMatch = startPattern.exec(markdown);
	if (!startMatch || startMatch.index == null) return null;
	const start = startMatch.index + startMatch[0].length;
	let end = markdown.length;
	for (const next of nextLabels) {
		const nextPattern = new RegExp(`\\*\\*${next}:\\*\\*`, "i");
		const nextMatch = nextPattern.exec(markdown.slice(start));
		if (nextMatch && nextMatch.index != null) end = Math.min(end, start + nextMatch.index);
	}
	return markdown.slice(start, end).trim();
}

/** What a page sent as one string may not hold (the backstop: Save sends the parts, and the rule makes them plain). */
const REMEMBER_ENTRY_MARKUP_MESSAGE = "A heading line or an HTML comment can't be saved in an entry. Remove it and save again.";

/** Save with nothing to keep, as the editor says it. */
const REMEMBER_ENTRY_NOTHING_TO_KEEP_MESSAGE = "Write what to keep before saving.";

/** A page sent as one string whose parts cannot be told apart: only an older page sends that form (draft). */
const REMEMBER_PAGE_FORM_MESSAGE = "This window is out of date. Reload the page, then save again.";

/** An entry with an empty What to keep or Still open, or a part's label typed inside another part (draft). */
const REMEMBER_ENTRY_PARTS_MESSAGE = "Part of this entry can't be read: What to keep and Still open each need their own words. Check the entry and save again.";

const REMEMBER_ENTRY_TOO_LONG_MESSAGE = `This entry is too long to save (at most ${CHECKPOINT_PAGE_MAX_CHARS.toLocaleString("en-US")} characters). Shorten it and save again.`;

const REMEMBER_ENTRY_IDENTITY_MESSAGE = "A line saying checkpoint_id or session_id is none can't be saved in an entry. Remove it and save again.";

export function validateApprovedRecentContextDraft(markdown: string): void {
	const trimmed = markdown.trim();
	if (!trimmed) throw new Error("approvedRecentContext is required");
	if (trimmed.length > CHECKPOINT_PAGE_MAX_CHARS) throw new Error(REMEMBER_ENTRY_TOO_LONG_MESSAGE);
	if (/^##\s+/m.test(trimmed)) throw new Error(REMEMBER_ENTRY_MARKUP_MESSAGE);
	if (!/^###\s+RC-(?:DRAFT|[A-Za-z0-9_-]+)/.test(trimmed)) throw new Error("approvedRecentContext must start with a Recent Context entry heading");
	// One entry per approval. A second "### " heading in the body would split
	// into a separate Recent Context entry after the write — a smuggled entry
	// the reviewer never approved as its own memory.
	if ((trimmed.match(/^###\s+/gm) ?? []).length > 1) throw new Error(REMEMBER_ENTRY_MARKUP_MESSAGE);
	// Provenance metadata is written by the gate, never accepted from the
	// draft: an embedded rc_metadata comment carrying a real checkpoint id
	// would earn a forged receipt, and HTML comments are invisible in the
	// rendered approval view, so nothing hidden gets into approved memory.
	if (/<!--/.test(trimmed)) throw new Error(REMEMBER_ENTRY_MARKUP_MESSAGE);
	// "What happened" may be absent; what to keep and what is still open may not.
	if (!extractApprovedRecentContextField(trimmed, "Body", ["Parked"])) throw new Error(REMEMBER_ENTRY_PARTS_MESSAGE);
	if (!extractApprovedRecentContextField(trimmed, "Parked", [])) throw new Error(REMEMBER_ENTRY_PARTS_MESSAGE);
	// The heading is the page's identity; the person's words are never read as one.
	if (/checkpoint_id\s*=\s*(?:null|none)|session_id\s*=\s*(?:null|none)/i.test(trimmed.split(/\r?\n/, 1)[0] ?? "")) throw new Error(REMEMBER_ENTRY_IDENTITY_MESSAGE);
}

/**
 * The page Save writes. Save sends Remember's three parts, and the server
 * builds the page from the proposal's heading with each part under the one
 * rule (memory-typed-text.ts), so a part marker or a heading typed into a part
 * stays that part's words. The one-string form is kept for a caller that still
 * sends it.
 */
function approvedRecentContextFrom(raw: any, proposal: any): string {
	const fields = raw?.approvedFields;
	let heading = String(proposal?.proposedRecentContext ?? "").split(/\r?\n/, 1)[0] ?? "";
	let parts: { sessionArc: string; body: string; parked: string };
	if (fields && typeof fields === "object") {
		parts = { sessionArc: String(fields.sessionArc ?? ""), body: String(fields.body ?? ""), parked: String(fields.parked ?? "") };
	} else {
		// The older one-string form: taken only when its parts can be told apart, and then saved as parts too.
		const page = String(raw?.approvedRecentContext ?? "").trim();
		if (!page) throw new Error("approvedRecentContext is required");
		const read = rememberPartsOfPage(page);
		if (!read) throw new Error(REMEMBER_PAGE_FORM_MESSAGE);
		({ heading, parts } = read);
	}
	if (!memoryTextHasWords(rememberPartsTyped(parts).body)) throw new Error(REMEMBER_ENTRY_NOTHING_TO_KEEP_MESSAGE);
	return rememberPageFromParts(heading, parts);
}

function replaceOrAppendChronosLine(chronosBody: string, label: string, value: string): string {
	const line = `- ${label}: ${value}`;
	const pattern = new RegExp(`^- ${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:.*$`, "m");
	if (pattern.test(chronosBody)) return chronosBody.replace(pattern, line);
	return `${chronosBody.trimEnd()}\n${line}\n`;
}

function updateChronosForCheckpoint(l1b: string, checkpointId: string, sessionId: string, now: Date): string {
	const match = /^##[ \t]+Chronos[ \t]*$/m.exec(l1b);
	if (!match || match.index == null) throw new Error("L1b missing mandatory section: Chronos");
	const start = match.index + match[0].length;
	const rest = l1b.slice(start);
	const next = /^##\s+/m.exec(rest);
	const end = next?.index == null ? l1b.length : start + next.index;
	let chronosBody = l1b.slice(start, end);
	chronosBody = replaceOrAppendChronosLine(chronosBody, "Lifecycle state", "ready");
	chronosBody = replaceOrAppendChronosLine(chronosBody, "Last checkpoint", checkpointId);
	chronosBody = replaceOrAppendChronosLine(chronosBody, "Last checkpoint at", now.toISOString());
	chronosBody = replaceOrAppendChronosLine(chronosBody, "Last approved session", sessionId);
	return `${l1b.slice(0, start)}\n\n${chronosBody.trim()}\n\n${l1b.slice(end).replace(/^\n+/, "")}`;
}

// Chronos is system-managed: no worker writes it, so the consolidation stamp
// is written here at apply time, the mirror of updateChronosForCheckpoint.
//
// The heading match is `[ \t]`, never `\s`: `\s*$` under /m happily eats the
// blank line under the heading and hands it back, so every stamp left one more
// blank line than it found and the section grew by a line per write for the
// life of the room. The three stamps and the reader all match the same way.
export function updateChronosForAbsorb(l1b: string, absorbId: string, now: Date): string {
	const match = /^##[ \t]+Chronos[ \t]*$/m.exec(l1b);
	if (!match || match.index == null) throw new Error("L1b missing mandatory section: Chronos");
	const start = match.index + match[0].length;
	const rest = l1b.slice(start);
	const next = /^##\s+/m.exec(rest);
	const end = next?.index == null ? l1b.length : start + next.index;
	let chronosBody = l1b.slice(start, end);
	chronosBody = replaceOrAppendChronosLine(chronosBody, "Last consolidation", absorbId);
	chronosBody = replaceOrAppendChronosLine(chronosBody, "Last consolidation at", now.toISOString());
	return `${l1b.slice(0, start)}\n\n${chronosBody.trim()}\n\n${l1b.slice(end).replace(/^\n+/, "")}`;
}

/**
 * Review's Chronos stamp, the same shape as the consolidation one: an approved
 * review dates itself in the room's own system-managed field, and touches only
 * its own two lines — "Last checkpoint" and "Last consolidation" belong to the
 * other two workflows.
 */
export function updateChronosForReview(l1b: string, reviewId: string, now: Date): string {
	const match = /^##[ \t]+Chronos[ \t]*$/m.exec(l1b);
	if (!match || match.index == null) throw new Error("L1b missing mandatory section: Chronos");
	const start = match.index + match[0].length;
	const rest = l1b.slice(start);
	const next = /^##\s+/m.exec(rest);
	const end = next?.index == null ? l1b.length : start + next.index;
	let chronosBody = l1b.slice(start, end);
	chronosBody = replaceOrAppendChronosLine(chronosBody, "Last review", reviewId);
	chronosBody = replaceOrAppendChronosLine(chronosBody, "Last review at", now.toISOString());
	return `${l1b.slice(0, start)}\n\n${chronosBody.trim()}\n\n${l1b.slice(end).replace(/^\n+/, "")}`;
}

/**
 * The entry store's Chronos stamp, the third of the same shape: an edit made in
 * the Memory pane (or the migration that gives the file its ids) is a normal
 * memory write, so it dates itself in the room's own system-managed field.
 * ONLY this line is touched — "Last checkpoint" and "Last consolidation" belong
 * to the maintenance workflows and a user edit must never move them. Returns
 * the L1b unchanged when it has no Chronos section: a malformed file is the
 * absorb/checkpoint validators' problem, never a reason to lose an edit.
 */
export function updateChronosForMemoryEdit(l1b: string, now: Date): string {
	const match = /^##[ \t]+Chronos[ \t]*$/m.exec(l1b);
	if (!match || match.index == null) return l1b;
	const start = match.index + match[0].length;
	const rest = l1b.slice(start);
	const next = /^##\s+/m.exec(rest);
	const end = next?.index == null ? l1b.length : start + next.index;
	const chronosBody = replaceOrAppendChronosLine(l1b.slice(start, end), "Last edit at", now.toISOString());
	return `${l1b.slice(0, start)}\n\n${chronosBody.trim()}\n\n${l1b.slice(end).replace(/^\n+/, "")}`;
}

function stableRecentContextEntry(approvedMarkdown: string, rcId: string, checkpointId: string, sessionId: string, request: CheckpointApprovalAcceptedRequest, now: Date): string {
	const trimmed = approvedMarkdown.trim();
	const lines = trimmed.split(/\r?\n/);
	const heading = lines.shift() ?? "";
	const parts = heading.replace(/^###\s+/, "").split("|").map((part) => part.trim()).filter(Boolean);
	const statusCandidate = parts.find((part) => /^(OPEN|CLOSED)$/i.test(part));
	const status = statusCandidate ? statusCandidate.toUpperCase() : /\*\*Parked:\*\*\s*\n\s*None\.?\s*$/i.test(trimmed) ? "CLOSED" : "OPEN";
	const title = (parts[parts.length - 1] && !/^RC-/i.test(parts[parts.length - 1]) && !/^\d{4}-\d{2}-\d{2}$/.test(parts[parts.length - 1]) && !/^(OPEN|CLOSED)$/i.test(parts[parts.length - 1]))
		? parts[parts.length - 1]
		: "Approved checkpoint";
	const body = lines.join("\n").trim();
	return [
		`### ${rcId} | ${status} | ${rememberLocalDay(now)} | ${title}`,
		`<!-- rc_metadata: checkpoint_id=${checkpointId}; session_id=${sessionId}; conversation_id=${request.conversationId}; density=${request.density}; model=${request.model.provider}/${request.model.model}; approved_at=${now.toISOString()} -->`,
		body,
	].join("\n\n") + "\n";
}

function recentContextEntryEventMetrics(entry: string): CheckpointEventRecord["checkpoint"]["approvedEntry"] {
	const normalized = entry.trimEnd() + "\n";
	const heading = normalized.split(/\r?\n/, 1)[0] ?? "";
	const statusMatch = heading.match(/\|\s*(OPEN|CLOSED)\s*\|/i);
	// The heading's trailing cell is the conversation's title. The record keeps
	// it, because once the entry is memorized the heading is gone from the
	// file and the record is the only place left that can name the conversation.
	const cells = heading.replace(/^#+\s*/, "").split("|").map((cell) => cell.trim()).filter(Boolean);
	const title = cells.length >= 4 ? cells.slice(3).join(" | ") : "";
	return {
		chars: normalized.length,
		bytes: Buffer.byteLength(normalized, "utf-8"),
		estimatedTokens: estimateTokens(normalized),
		hash: fingerprintL1bSource(normalized),
		status: statusMatch ? statusMatch[1].toUpperCase() as "OPEN" | "CLOSED" : "unknown",
		...(title ? { title } : {}),
	};
}

function proposedRecentContextEventMetrics(entry: string): NonNullable<CheckpointEventRecord["checkpoint"]["proposedEntry"]> {
	const normalized = entry.trimEnd() + "\n";
	return {
		chars: normalized.length,
		bytes: Buffer.byteLength(normalized, "utf-8"),
		estimatedTokens: estimateTokens(normalized),
		hash: fingerprintL1bSource(normalized),
	};
}

function appendRecentContextEntry(l1b: string, entry: string): string {
	const match = /^##\s+Recent Context\s*$/m.exec(l1b);
	if (!match || match.index == null) throw new Error("L1b missing mandatory section: Recent Context");
	const start = match.index + match[0].length;
	const rest = l1b.slice(start);
	const next = /^##\s+/m.exec(rest);
	const end = next?.index == null ? l1b.length : start + next.index;
	let body = l1b.slice(start, end).trim();
	if (/^No checkpointed sessions yet\.?$/i.test(body)) body = "";
	const newBody = `${body ? `${body}\n\n` : ""}${entry.trim()}\n`;
	const after = l1b.slice(end).replace(/^\n+/, "");
	return `${l1b.slice(0, start)}\n\n${newBody}${after ? `\n${after}` : ""}`;
}

function budgetState(tokens: number): PersistentAgentPromptBudgetState {
	if (tokens >= 20000) return "hard";
	if (tokens >= 18000) return "pressure";
	if (tokens >= 15000) return "warning";
	return "healthy";
}

function extractMarkdownSections(markdown: string): string[] {
	const sections = new Set<string>();
	for (const line of markdown.split(/\r?\n/)) {
		const m = line.match(/^##\s+(.+?)\s*$/);
		if (m) sections.add(m[1].trim());
	}
	return [...sections];
}

function recentContextLevel(count: number, softCap: number, hardCap: number): PersistentAgentMemoryStatusLevel {
	if (count <= 0) return "empty";
	if (count >= hardCap) return "hard_cap";
	if (count >= softCap) return "at_soft_cap";
	if (count >= Math.max(1, softCap - 1)) return "approaching_soft_cap";
	return "ok";
}

function extractChronosLine(markdown: string, label: string): string | null {
	const match = /^##[ \t]+Chronos[ \t]*$/m.exec(markdown);
	if (!match || match.index == null) return null;
	const start = match.index + match[0].length;
	const rest = markdown.slice(start);
	const next = /^##\s+/m.exec(rest);
	const end = next?.index == null ? markdown.length : start + next.index;
	const body = markdown.slice(start, end);
	const pattern = new RegExp(`^- ${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*(.+?)\\s*$`, "m");
	const line = pattern.exec(body)?.[1]?.trim() ?? null;
	return line && !/^none$/i.test(line) ? line : null;
}

function buildMemoryStatus(count: number, softCap: number, hardCap: number, lastCheckpointId: string | null, lastCheckpointAt: string | null, lastMemoryWriteAt: string | null, notesToSort = 0): PersistentAgentStatus["memoryStatus"] {
	return {
		recentContextCount: count,
		recentContextSoftCap: softCap,
		recentContextHardCap: hardCap,
		recentContextLevel: recentContextLevel(count, softCap, hardCap),
		lastCheckpointId,
		lastCheckpointAt,
		lastMemoryWriteAt,
		notesToSort,
	};
}

function baseAgentJson(input: { agentId: PersistentAgentId; displayName: string; description?: string; role: string; templateId?: string; mode?: string; user?: AgentJson["user"]; now: number }): AgentJson {
	return {
		schemaVersion: 1,
		id: input.agentId,
		agentId: input.agentId,
		displayName: input.displayName,
		description: input.description ?? "",
		role: input.role,
		...(input.templateId ? { templateId: input.templateId } : {}),
		...(input.mode ? { mode: input.mode } : {}),
		...(input.user ? { user: input.user } : {}),
		status: "ready",
		createdAt: input.now,
		updatedAt: input.now,
		l1aPath: "L1a.md",
		l1bCurrentPath: "L1b/current.md",
		l1bArchiveDir: "L1b/archive",
		sectionRegistryPath: "section_registry.json",
		currentSessionId: null,
		lastCheckpointId: null,
		recentContextSoftCap: RECENT_CONTEXT_SOFT_CAP,
		recentContextHardCap: RECENT_CONTEXT_HARD_CAP,
		memoryTokenBudget: 12000,
	};
}

function roleLabel(role: string): string {
	return role.replace(/[-_]+/g, " ");
}

function genericPersistentAgentJson(agentId: PersistentAgentId, input: NormalizedPersistentAgentScaffoldInput, now: number): AgentJson {
	return baseAgentJson({
		agentId,
		displayName: input.displayName,
		description: input.description,
		role: input.role,
		templateId: input.templateId,
		mode: input.mode,
		user: input.user,
		now,
	});
}

export { appendRecentContextEntry, approvedRecentContextFrom, budgetState, buildL1bMutationEventPaths, buildMemoryStatus, deriveL1bMutationSections, extractChronosLine, extractMarkdownSections, genericPersistentAgentJson, isCheckpointDensity, proposedRecentContextEventMetrics, recentContextEntryEventMetrics, roleLabel, sanitizeNumericUsage, stableMemoryAggregateMetrics, stableRecentContextEntry, updateChronosForCheckpoint };
