/**
 * Cross-session memory — a runtime primitive.
 *
 * Provides durable fact storage across sessions with:
 * - Append-only JSONL storage at ~/.exxperts/app/memory.jsonl
 * - Auto-injection of relevant memories into system prompt on session start
 * - Approval-gated writes (all model-initiated writes require user approval)
 * - Read-only access in delegated subprocesses by default
 * - Session-end summarisation with user approval
 *
 * Moved from pi-package/extensions/memory to the runtime so every agent and
 * every mode (CLI, web, delegate) has memory access without extension wiring.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExtensionUIContext } from "./extensions/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Memory {
	id: string;
	ts: number;
	text: string;
	tags?: string[];
	/** Source: "user" for /remember, "agent" for memory_note, "session" for session-end summary */
	source?: "user" | "agent" | "session";
}

export interface MemoryStoreOptions {
	/** Override the memory file path (default: ~/.exxperts/app/memory.jsonl) */
	filePath?: string;
	/** Read-only mode — rejects writes (used in delegated subprocesses) */
	readOnly?: boolean;
}

export interface MemoryRecallOptions {
	query: string;
	limit?: number;
	tags?: string[];
}

export interface SessionSummary {
	/** Key facts/decisions from the session */
	facts: string[];
	/** Tags for the summary entries */
	tags?: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// The exxperts state tree lives under EXXPERTS_STATE_HOME when a data profile
// is loaded or the data folder was moved, and under the login home otherwise.
// Read per call: the variable is set before the process starts, but a test or
// an embedder can change it between stores.
function defaultMemoryFile(): string {
	const stateHome = process.env.EXXPERTS_STATE_HOME?.trim();
	return join(stateHome ? resolve(stateHome) : homedir(), ".exxperts", "app", "memory.jsonl");
}
const MEMORY_MARKER = "<!-- exxeta:memory -->";
const MAX_DUMP_ALL = 200; // inject all if below this count

// ---------------------------------------------------------------------------
// MemoryStore — the core primitive
// ---------------------------------------------------------------------------

export class MemoryStore {
	private readonly filePath: string;
	private readonly readOnly: boolean;

	constructor(options?: MemoryStoreOptions) {
		this.filePath = options?.filePath ?? defaultMemoryFile();
		this.readOnly = options?.readOnly ?? false;
	}

	/** Load all memories from disk. */
	load(): Memory[] {
		if (!existsSync(this.filePath)) return [];
		try {
			return readFileSync(this.filePath, "utf-8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Memory)
				.filter((m) => m && typeof m.text === "string");
		} catch {
			return [];
		}
	}

	/** Append a single memory. Throws in read-only mode. */
	append(memory: Memory): void {
		if (this.readOnly) {
			throw new Error("Memory store is read-only in this context (delegated subprocess).");
		}
		mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
		appendFileSync(this.filePath, JSON.stringify(memory) + "\n", { mode: 0o600 });
	}

	/** Rewrite the entire store (used for deletion). Throws in read-only mode. */
	rewrite(memories: Memory[]): void {
		if (this.readOnly) {
			throw new Error("Memory store is read-only in this context (delegated subprocess).");
		}
		mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
		const body = memories.map((m) => JSON.stringify(m)).join("\n");
		writeFileSync(this.filePath, memories.length ? body + "\n" : "", { mode: 0o600 });
	}

	/** Search memories by substring (case-insensitive), matching text and tags. */
	recall(options: MemoryRecallOptions): Memory[] {
		const q = options.query.toLowerCase();
		const limit = options.limit ?? 20;
		return this.load()
			.filter(
				(m) =>
					m.text.toLowerCase().includes(q) ||
					(m.tags ?? []).some((t) => t.toLowerCase().includes(q)),
			)
			.slice(-limit);
	}

	/** Delete a memory by id. */
	delete(id: string): boolean {
		const memories = this.load();
		const idx = memories.findIndex((m) => m.id === id);
		if (idx < 0) return false;
		this.rewrite(memories.filter((_, i) => i !== idx));
		return true;
	}

	/** Count of stored memories. */
	count(): number {
		return this.load().length;
	}

	/** Whether this store is in read-only mode. */
	get isReadOnly(): boolean {
		return this.readOnly;
	}

	/** Path to the memory file. */
	get path(): string {
		return this.filePath;
	}

	// -----------------------------------------------------------------------
	// System prompt injection
	// -----------------------------------------------------------------------

	/**
	 * Build the memory block for system prompt injection.
	 * Returns empty string if no memories exist.
	 */
	buildPromptBlock(): string {
		const memories = this.load();
		if (memories.length === 0) return "";
		// dump-all strategy for < MAX_DUMP_ALL entries
		const items = memories.length <= MAX_DUMP_ALL ? memories : memories.slice(-MAX_DUMP_ALL);
		return [
			MEMORY_MARKER,
			"## Known facts about this user (long-term memory)",
			"Apply these silently. Do not parrot them back unless explicitly asked.",
			"If the user contradicts a fact, prefer the user's latest statement.",
			"",
			...items.map(
				(m) => `- ${m.text}${m.tags?.length ? ` _(${m.tags.join(", ")})_` : ""}`,
			),
		].join("\n");
	}

	/** Check if a system prompt already has memory injected. */
	static hasMemoryBlock(systemPrompt: string): boolean {
		return systemPrompt.includes(MEMORY_MARKER);
	}

	/**
	 * Inject memories into a system prompt if not already present.
	 * Returns the (possibly modified) system prompt.
	 */
	injectIntoPrompt(systemPrompt: string): string {
		if (MemoryStore.hasMemoryBlock(systemPrompt)) return systemPrompt;
		const block = this.buildPromptBlock();
		if (!block) return systemPrompt;
		return `${systemPrompt}\n\n${block}`;
	}

	// -----------------------------------------------------------------------
	// Approval-gated write
	// -----------------------------------------------------------------------

	/**
	 * Propose a memory note with user approval via UI context.
	 * Returns the saved memory, or null if the user declined.
	 */
	async proposeNote(
		fact: string,
		tags: string[] | undefined,
		ui: ExtensionUIContext,
		hasUI: boolean,
	): Promise<{ saved: boolean; memory?: Memory; reason?: string }> {
		if (this.readOnly) {
			return { saved: false, reason: "read-only" };
		}
		if (!hasUI) {
			return { saved: false, reason: "no-ui" };
		}

		const tagStr = tags?.length ? `\n\nTags: ${tags.join(", ")}` : "";
		const choice = await ui.select(
			"Save this to long-term memory?",
			["Approve", "Edit", "No"],
			{ detail: `Proposed fact:\n\n  ${fact}${tagStr}` } as any,
		);

		if (choice === "No" || !choice) {
			return { saved: false, reason: "denied" };
		}

		let finalFact = fact;
		if (choice === "Edit") {
			const edited = await ui.input(
				"Edit the fact",
				"Revise the wording or leave as-is and press Enter.",
			);
			if (edited === undefined) {
				return { saved: false, reason: "cancelled" };
			}
			if (edited.trim()) finalFact = edited.trim();
		}

		const memory: Memory = {
			id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
			ts: Date.now(),
			text: finalFact,
			tags,
			source: "agent",
		};
		this.append(memory);
		ui.notify(`Saved: ${finalFact}`, "info");
		return { saved: true, memory };
	}

	// -----------------------------------------------------------------------
	// Session-end summarisation
	// -----------------------------------------------------------------------

	/**
	 * Save session-end summary facts after user approval.
	 * Each approved fact is stored as a separate memory entry.
	 */
	async saveSessionSummary(
		summary: SessionSummary,
		ui: ExtensionUIContext,
		hasUI: boolean,
	): Promise<{ saved: number; total: number }> {
		if (this.readOnly || !hasUI || summary.facts.length === 0) {
			return { saved: 0, total: summary.facts.length };
		}

		const factsPreview = summary.facts.map((f, i) => `${i + 1}. ${f}`).join("\n");
		const choice = await ui.select(
			`Save ${summary.facts.length} fact(s) from this session to long-term memory?`,
			["Save all", "Review each", "Skip all"],
			{ detail: factsPreview } as any,
		);

		if (choice === "Skip all" || !choice) {
			return { saved: 0, total: summary.facts.length };
		}

		let saved = 0;
		if (choice === "Save all") {
			for (const fact of summary.facts) {
				const memory: Memory = {
					id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
					ts: Date.now(),
					text: fact,
					tags: summary.tags,
					source: "session",
				};
				this.append(memory);
				saved++;
			}
			ui.notify(`Saved ${saved} fact(s) to memory.`, "info");
		} else {
			// Review each
			for (const fact of summary.facts) {
				const keep = await ui.confirm("Save to memory?", fact);
				if (keep) {
					const memory: Memory = {
						id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
						ts: Date.now(),
						text: fact,
						tags: summary.tags,
						source: "session",
					};
					this.append(memory);
					saved++;
				}
			}
			ui.notify(`Saved ${saved} of ${summary.facts.length} fact(s).`, "info");
		}

		return { saved, total: summary.facts.length };
	}

	// -----------------------------------------------------------------------
	// Helpers
	// -----------------------------------------------------------------------

	/** Generate a unique memory ID. */
	static generateId(): string {
		return `m_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
	}

	/** Format a timestamp for display. */
	static formatDate(ts: number): string {
		return new Date(ts).toISOString().slice(0, 10);
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a MemoryStore with standard options. */
export function createMemoryStore(options?: MemoryStoreOptions): MemoryStore {
	return new MemoryStore(options);
}

/**
 * Create a read-only MemoryStore suitable for delegated subprocesses.
 * Reads from the same file but rejects all writes.
 */
export function createReadOnlyMemoryStore(filePath?: string): MemoryStore {
	return new MemoryStore({ filePath, readOnly: true });
}
