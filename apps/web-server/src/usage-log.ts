/**
 * Local usage ledger — one JSONL row per LLM turn, shared by every spend path
 * (room chat, memory upkeep workers, HiveMind, scheduled runs) so the Wallet
 * can account for all of them. Rows are append-only and never rewritten;
 * enrichment fields are optional because historical rows predate them.
 */

import type { MemoryCallKind } from "./memory-call-cache.js";
import fs from "node:fs";
import { AuthStorage } from "@exxeta/exxperts-runtime";
import { serverHooks } from "./server-hooks.js";
import { productAppStatePath, productAppStateRoot } from "../../../pi-package/product-state-paths.js";

export type UsageAuthType = "oauth" | "api_key";
export type UsageKind = "chat" | "upkeep" | "scheduled" | "hivemind" | "cli" | "consult" | "task";

export type UsageCall = Pick<UsageRow, "input" | "output" | "cacheRead">;

export interface UsageRow {
	ts: number;
	agent: string;
	persona: string;
	model?: string;
	modelLabel?: string;
	/** Provider id that served the turn (e.g. "openai-codex"). Absent on older rows. */
	provider?: string;
	/** How the provider was authenticated: subscription OAuth vs pay-per-token API key. */
	authType?: UsageAuthType;
	/** What ran the turn. Absent on rows written before kinds existed (all chat). */
	kind?: UsageKind;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** How many of cacheWrite were one-hour writes, priced higher. Absent on older rows and when none were. */
	cacheWrite1h?: number;
	cost: number;
	tools?: string[];
	/** Background-run id for runs billed via appendUsageOnce. Absent on older rows. */
	runId?: string;
	/** The model calls a scheduled row sums, each as its session message holds it, so the start-up import can match them. Absent on other rows and on older rows. */
	calls?: UsageCall[];
	/** Which Memory model call it was (memory-call-cache.ts), so cache settings can be compared. Absent on older rows. */
	callKind?: MemoryCallKind;
	/** On a shared server, who spent and their space, as opaque ids. Absent on the desktop and on older rows. */
	person?: string;
	space?: string;
}

const USAGE_DIR = productAppStateRoot();
const USAGE_FILE = productAppStatePath("usage.jsonl");
const NEWLINE = 0x0a;

/** A call that moved no tokens and cost nothing. A failed or stopped one was no turn, so it writes no row. */
export function usageMovedNothing(usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: number }): boolean {
	return !usage.input && !usage.output && !usage.cacheRead && !usage.cacheWrite && !usage.cost;
}

type AssistantCall = { stopReason?: string; content?: unknown; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } };

/** A finished answer with nothing in it: no text, no tool call and no output tokens, such as a proxy's HTML page sent with status 200. */
export function emptyAnswer(message: AssistantCall): boolean {
	if (message.stopReason !== "stop" || message.usage?.output) return false;
	const parts = Array.isArray(message.content) ? message.content : [];
	return !parts.some((part: any) => part?.type === "toolCall" || (part?.type === "text" && String(part.text ?? "").trim()));
}

/** A call that brought no answer (failed, stopped or empty) and moved nothing: no row, live or when the start-up import reads the session files. */
export function answerlessCallMovedNothing(message: AssistantCall): boolean {
	const u = message.usage;
	return !!u && (message.stopReason === "error" || message.stopReason === "aborted" || emptyAnswer(message)) && usageMovedNothing({ input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, cost: u.cost?.total });
}

/**
 * What a model call says about whose it is: the person its usage row names, as
 * our own id, from the same lookup appendUsage stamps the row with (or the `who`
 * a call that names no room passes for its row). Nothing when no person is known,
 * as on the desktop.
 */
export function modelCallMetadata(roomId: string, kind: UsageKind, who?: { person: string }): { user_id: string } | undefined {
	const person = who ? who.person : serverHooks().usageOwner?.(roomId, kind)?.person;
	return person ? { user_id: person } : undefined;
}

export function appendUsage(row: UsageRow, warn?: (message: string) => void): void {
	const stamped = row.person ? row : { ...row, ...serverHooks().usageOwner?.(row.agent, row.kind) };
	try {
		fs.mkdirSync(USAGE_DIR, { recursive: true, mode: 0o700 });
		fs.appendFileSync(USAGE_FILE, JSON.stringify(stamped) + "\n", { mode: 0o600 });
	} catch (e) {
		warn?.(`failed to append usage row: ${(e as Error).message}`);
	}
}

/** A kill mid-append leaves a line with no end, and the next row would join it and be lost with it. Runs at the start, before any row is written. */
export function closeTornUsageLine(warn?: (message: string) => void): void {
	try {
		const { size } = fs.statSync(USAGE_FILE);
		if (size === 0) return;
		const fd = fs.openSync(USAGE_FILE, "r");
		const last = Buffer.alloc(1);
		try {
			fs.readSync(fd, last, 0, 1, size - 1);
		} finally {
			fs.closeSync(fd);
		}
		if (last[0] !== NEWLINE) fs.appendFileSync(USAGE_FILE, "\n");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") warn?.(`failed to close a torn usage line: ${(e as Error).message}`);
	}
}

/**
 * Appends a usage row at most once per (kind, runId): lease recovery can re-execute a background
 * run that crashed after billing, and the retry must never bill the same run's tokens twice.
 */
export function appendUsageOnce(row: UsageRow & { runId: string }, warn?: (message: string) => void): void {
	if (loadUsage().some((existing) => existing.runId === row.runId && existing.kind === row.kind)) {
		warn?.(`usage row already recorded for ${row.kind ?? "unknown"} run ${row.runId}; skipped duplicate append`);
		return;
	}
	appendUsage(row, warn);
}

export function loadUsage(): UsageRow[] {
	let raw: string;
	try {
		raw = fs.readFileSync(USAGE_FILE, "utf-8");
	} catch {
		return [];
	}
	const rows: UsageRow[] = [];
	// Parse per line: a single truncated append (crash mid-write) must cost
	// one row, not blank the whole ledger.
	for (const line of raw.split("\n")) {
		if (!line) continue;
		try {
			const row = JSON.parse(line) as UsageRow;
			if (row && typeof row.ts === "number") rows.push(row);
		} catch {
			// skip the damaged line
		}
	}
	// Reconciled historical rows are appended after newer live rows, so
	// consumers get chronological order restored here.
	return rows.sort((a, b) => a.ts - b.ts);
}

/**
 * Best-effort auth classification for a provider at the time a turn is
 * recorded. A stored credential knows its own type; anything else that still
 * works must be an API key from the environment. Never guesses for
 * unconfigured providers.
 */
export function resolveUsageAuthType(provider: string | undefined, providerConfigured: boolean): UsageAuthType | undefined {
	if (!provider) return undefined;
	try {
		const credential = AuthStorage.create().get(provider);
		if (credential?.type === "oauth") return "oauth";
		if (credential?.type === "api_key") return "api_key";
	} catch {
		// Fall through to the configured check below.
	}
	return providerConfigured ? "api_key" : undefined;
}
