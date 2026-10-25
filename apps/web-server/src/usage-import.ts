/**
 * Boot-time reconciliation of turns that spent tokens without reaching the
 * usage ledger: CLI-attach turns (written by a separate process straight into
 * the room's pi-session files) and chat turns that raced a disconnect. The
 * per-thread session files keep each assistant message's usage on disk, so
 * every server start folds whatever the ledger missed back in.
 *
 * Double-count safety: usage.jsonl already has most of these turns (the live
 * websocket logged them, and earlier reconciliations imported the rest), so
 * every session message is first matched against the room's existing rows by
 * its exact (input, output, cacheRead) token triple, consuming one ledger row
 * per match. Only unmatched messages are appended — running this repeatedly
 * is a no-op by construction, and a failed run simply retries next boot.
 */

import fs from "node:fs";
import path from "node:path";
import { answerlessCallMovedNothing, appendUsage, loadUsage } from "./usage-log.js";
import type { UsageKind, UsageRow } from "./usage-log.js";

interface ImportSummary {
	rows: number;
	cost: number;
}

function threadKindFromFileName(fileName: string): UsageKind {
	// cli_* threads are CLI-attach turns; c_ / postmem_ / postcp_ are all the
	// room's chat thread (postmem/postcp are its post-memento/post-checkpoint
	// continuations).
	return fileName.startsWith("cli_") ? "cli" : "chat";
}

function matchKey(input: number, output: number, cacheRead: number): string {
	return `${input}|${output}|${cacheRead}`;
}

export function importHistoricalSessionUsage(agentsRoot: string, warn: (message: string) => void): ImportSummary | null {
	if (!fs.existsSync(agentsRoot)) return null;

	const existing = loadUsage();
	const candidates: UsageRow[] = [];

	for (const room of fs.readdirSync(agentsRoot)) {
		const sessionsDir = path.join(agentsRoot, room, "runtime", "pi-sessions");
		let files: string[];
		try {
			files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
		} catch {
			continue;
		}
		// Multiset of the room's already-recorded token triples; each session
		// message that matches consumes one so repeats stay balanced.
		const recorded = new Map<string, number>();
		for (const row of existing) {
			if (row.agent !== room) continue;
			const key = matchKey(row.input, row.output, row.cacheRead);
			recorded.set(key, (recorded.get(key) ?? 0) + 1);
		}

		for (const file of files) {
			const kind = threadKindFromFileName(file);
			let lines: string[];
			try {
				lines = fs.readFileSync(path.join(sessionsDir, file), "utf-8").split("\n");
			} catch {
				continue;
			}
			let provider: string | undefined;
			let modelId: string | undefined;
			for (const line of lines) {
				if (!line) continue;
				let entry: any;
				try {
					entry = JSON.parse(line);
				} catch {
					continue;
				}
				if (entry?.type === "model_change") {
					provider = typeof entry.provider === "string" ? entry.provider : provider;
					modelId = typeof entry.modelId === "string" ? entry.modelId : modelId;
					continue;
				}
				const message = entry?.message;
				const usage = message?.usage;
				if (message?.role !== "assistant" || !usage || answerlessCallMovedNothing(message)) continue;
				const input = usage.input ?? 0;
				const output = usage.output ?? 0;
				const cacheRead = usage.cacheRead ?? 0;
				const key = matchKey(input, output, cacheRead);
				const already = recorded.get(key) ?? 0;
				if (already > 0) {
					recorded.set(key, already - 1);
					continue;
				}
				const ts = Date.parse(entry.timestamp ?? "") || Date.parse(message.timestamp ?? "") || 0;
				if (!ts) continue;
				candidates.push({
					ts,
					agent: room,
					persona: "business",
					model: modelId ?? message.model,
					provider,
					kind,
					input,
					output,
					cacheRead,
					cacheWrite: usage.cacheWrite ?? 0,
					cost: usage.cost?.total ?? 0,
				});
			}
		}
	}

	candidates.sort((a, b) => a.ts - b.ts);
	for (const row of candidates) appendUsage(row, warn);

	return {
		rows: candidates.length,
		cost: candidates.reduce((sum, row) => sum + row.cost, 0),
	};
}
