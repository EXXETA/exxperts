// Memorize never gets stuck: the page failure records.
//
// A conversation whose fold call failed while the Memory model was answering
// (the probe said so) carries a record into the next run: if it fails that way
// again, it is filed as its summary instead of waiting forever. The records
// live in a small sidecar in the room's own runtime state, keyed by the
// Remember's checkpoint id (or, for a block written by hand, a hash of its
// text), and hold no room text: the date, the model and a failure code.
// The run reads them once at its start and writes them once when its fold
// loop ends (absorb-run-pages.ts).

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PageFailureCode, PageFailureRecord, PageFailureState } from "./absorb-run-pages.js";

export const MEMORIZE_PAGE_FAILURES_FILE = "memorize-page-failures.json";

const CODES: readonly PageFailureCode[] = ["timed-out", "provider-error", "worker-failed"];

export function pageFailuresPath(runtimeDir: string): string {
	return path.join(runtimeDir, MEMORIZE_PAGE_FAILURES_FILE);
}

/** A page's record key: the Remember that wrote it, or a hash of a hand-written block's text. */
export function pageFailureKey(page: { checkpointId?: string; text: string }): string {
	return page.checkpointId ? page.checkpointId : `text:${createHash("sha256").update(page.text).digest("hex").slice(0, 16)}`;
}

/** The records and throttle notes on disk. A missing, unreadable or foreign file reads as none: they are hints, never a reason to stop a run. */
export function readPageFailures(runtimeDir: string): PageFailureState {
	const state: PageFailureState = { records: new Map(), throttled: new Map() };
	let raw: any;
	try {
		raw = JSON.parse(fs.readFileSync(pageFailuresPath(runtimeDir), "utf8"));
	} catch {
		return state;
	}
	if (!raw || typeof raw !== "object" || raw.schemaVersion !== 1) return state;
	for (const [key, value] of Object.entries((raw.records ?? {}) as Record<string, any>)) {
		if (!value || typeof value !== "object") continue;
		if (typeof value.at !== "string" || typeof value.provider !== "string" || typeof value.model !== "string" || !CODES.includes(value.code)) continue;
		state.records.set(key, { at: value.at, provider: value.provider, model: value.model, code: value.code });
	}
	for (const [key, value] of Object.entries((raw.throttled ?? {}) as Record<string, any>)) {
		if (value && typeof value === "object" && typeof value.at === "string") state.throttled.set(key, { at: value.at });
	}
	return state;
}

/** Writes the state atomically: a temporary file renamed over the old one. Nothing to keep, no file. */
export function writePageFailures(runtimeDir: string, state: PageFailureState): void {
	const file = pageFailuresPath(runtimeDir);
	if (state.records.size === 0 && state.throttled.size === 0) {
		fs.rmSync(file, { force: true });
		return;
	}
	fs.mkdirSync(runtimeDir, { recursive: true });
	const temp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
	fs.writeFileSync(temp, `${JSON.stringify({ schemaVersion: 1, records: Object.fromEntries(state.records), throttled: Object.fromEntries(state.throttled) }, null, 2)}\n`);
	fs.renameSync(temp, file);
}
