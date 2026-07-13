/**
 * Local usage ledger — one JSONL row per LLM turn, shared by every spend path
 * (room chat, memory upkeep workers, HiveMind, scheduled runs) so the Wallet
 * can account for all of them. Rows are append-only and never rewritten;
 * enrichment fields are optional because historical rows predate them.
 */

import fs from "node:fs";
import { AuthStorage } from "@exxeta/exxperts-runtime";
import { productAppStatePath, productAppStateRoot } from "../../../pi-package/product-state-paths.js";

export type UsageAuthType = "oauth" | "api_key";
export type UsageKind = "chat" | "upkeep" | "scheduled" | "hivemind" | "cli" | "consult" | "task";

export interface UsageRow {
	ts: number;
	agent: string;
	persona: string;
	model?: string;
	modelLabel?: string;
	/** Provider id that served the turn (e.g. "openai-codex"). Recorded since Jul 2026. */
	provider?: string;
	/** How the provider was authenticated: subscription OAuth vs pay-per-token API key. */
	authType?: UsageAuthType;
	/** What ran the turn. Absent on rows written before kinds existed (all chat). */
	kind?: UsageKind;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	tools?: string[];
	/** Background-run id for runs billed via appendUsageOnce. Recorded since Jul 2026. */
	runId?: string;
}

const USAGE_DIR = productAppStateRoot();
const USAGE_FILE = productAppStatePath("usage.jsonl");

export function usageFilePath(): string {
	return USAGE_FILE;
}

export function appendUsage(row: UsageRow, warn?: (message: string) => void): void {
	try {
		fs.mkdirSync(USAGE_DIR, { recursive: true, mode: 0o700 });
		fs.appendFileSync(USAGE_FILE, JSON.stringify(row) + "\n", { mode: 0o600 });
	} catch (e) {
		warn?.(`failed to append usage row: ${(e as Error).message}`);
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
