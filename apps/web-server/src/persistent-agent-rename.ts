import fs from "node:fs";
import path from "node:path";
import type { PersistentAgentId } from "./persistent-agent-types.js";
import { type AgentJson, assertPersistentRoomNotHeldByAnotherProcess, createPersistentAgentInstance, ensureDir, isPersistentAgentArchived, shortRandomId, slugTimestamp, writeFileAtomic } from "./persistent-agent-store.js";
import { assertPersistentAgentDisplayNameAvailable, collapseHumanWhitespace, normalizePersistentAgentDisplayName } from "./persistent-agent-create.js";

export interface PersistentAgentRenameMemoryMention {
	line: number;
	text: string;
}

export interface PersistentAgentRenameResult {
	agentId: PersistentAgentId;
	displayName: string;
	previousDisplayName: string;
	updatedAt: number;
	dryRun: boolean;
	/** True only when both constitution anchors (heading + Identity line) matched the old name and were rewritten. */
	constitutionUpdated: boolean;
	constitutionAnchors: { heading: boolean; identity: boolean };
	/** Word-boundary exact mentions of the old name in L1b/current.md (the learned memory). */
	memoryMentions: { count: number; lines: PersistentAgentRenameMemoryMention[] };
	/** True when L1b was rewritten (apply mode with at least one mention). */
	memoryUpdated: boolean;
	/** Agent-root-relative path of the pre-rename L1b archive copy, when memory was rewritten. */
	archivedL1b: string | null;
}

/**
 * Whole-word/phrase boundary: the character adjacent to a match must not be a
 * Unicode letter or digit (start/end of text counts as a boundary). This keeps
 * "Test Room" from matching inside "Test Roomy" while still matching next to
 * punctuation, markdown emphasis, and non-ASCII text.
 */
function isNameMentionBoundary(char: string | undefined): boolean {
	if (char === undefined) return true;
	return !/[\p{L}\p{N}]/u.test(char);
}

function findWholeNameMentionIndexes(text: string, name: string): number[] {
	const indexes: number[] = [];
	if (!name) return indexes;
	let from = 0;
	while (true) {
		const at = text.indexOf(name, from);
		if (at < 0) break;
		if (isNameMentionBoundary(text[at - 1]) && isNameMentionBoundary(text[at + name.length])) indexes.push(at);
		from = at + name.length;
	}
	return indexes;
}

const RENAME_MENTION_LINE_PREVIEW_MAX_CHARS = 300;

function nameMentionLinePreviews(text: string, indexes: number[]): PersistentAgentRenameMemoryMention[] {
	return indexes.map((at) => {
		const lineStart = text.lastIndexOf("\n", at - 1) + 1;
		const lineEndRaw = text.indexOf("\n", at);
		const lineEnd = lineEndRaw < 0 ? text.length : lineEndRaw;
		const line = text.slice(0, at).split("\n").length;
		return { line, text: text.slice(lineStart, lineEnd).trim().slice(0, RENAME_MENTION_LINE_PREVIEW_MAX_CHARS) };
	});
}

function replaceNameMentions(text: string, indexes: number[], oldName: string, newName: string): string {
	let out = "";
	let prev = 0;
	for (const at of indexes) {
		out += text.slice(prev, at) + newName;
		prev = at + oldName.length;
	}
	return out + text.slice(prev);
}

/**
 * Renames a room's display name. The agent id never changes (everything on
 * disk keys on id). The L1a constitution is updated only at two deterministic
 * anchors matched against the CURRENT stored displayName: the line-1 heading
 * `# <name> Constitution` and the first `You are **<name>**` occurrence inside
 * the Identity section. Anchors that do not match (user-customized
 * constitution) are left untouched and reported via constitutionUpdated.
 *
 * The learned memory (L1b/current.md) is the other live prompt input, so
 * word-boundary exact mentions of the old name there are replaced too, but
 * never blind: `dryRun: true` returns the exact matched lines for the user to
 * review, and an apply archives the previous L1b to the room's l1bArchiveDir
 * (same convention as checkpoint/structural review) before writing. Events and
 * thread files are historical records and are never touched; L0/L2 and layer
 * titles are generated from agent.json at session boot, and
 * section_registry.json carries only fixed system section descriptions.
 */
export function renamePersistentAgent(agentIdRaw: string, displayNameRaw: unknown, options: { dryRun?: boolean } = {}): PersistentAgentRenameResult {
	const instance = createPersistentAgentInstance(agentIdRaw);
	if (!fs.existsSync(instance.rootDir)) {
		const error = new Error(`persistent agent not found: ${instance.agentId}`);
		(error as any).statusCode = 404;
		throw error;
	}
	const meta = instance.readAgentJson();
	if (!meta) {
		const error = new Error("agent.json is missing or invalid JSON");
		(error as any).statusCode = 409;
		throw error;
	}
	if (meta.id && meta.id !== instance.agentId) {
		const error = new Error(`agent.json id mismatch: ${meta.id}`);
		(error as any).statusCode = 409;
		throw error;
	}
	if (isPersistentAgentArchived(meta)) {
		const error = new Error(`cannot rename an archived room: ${instance.agentId}`);
		(error as any).statusCode = 409;
		throw error;
	}
	let displayName: string;
	try {
		displayName = normalizePersistentAgentDisplayName(displayNameRaw);
	} catch (error) {
		// Validation is the client's fault; without a statusCode the route reports a 500.
		(error as any).statusCode = 400;
		throw error;
	}
	// A rename rewrites every whole-name mention in the memory file: a name that
	// starts like a heading or a comment could stand alone on a line as one.
	if (/^(?:#|<!--)/.test(displayName)) {
		const error = new Error("A room name can't start with # or <!--. Choose another name.");
		(error as any).statusCode = 400;
		throw error;
	}
	const previousDisplayName = typeof meta.displayName === "string" ? collapseHumanWhitespace(meta.displayName) : "";
	if (displayName === previousDisplayName) {
		const error = new Error(`the room is already named ${displayName}`);
		(error as any).statusCode = 400;
		throw error;
	}
	assertPersistentAgentDisplayNameAvailable(displayName, { excludeAgentId: instance.agentId });
	// A display rename is harmless while the room is open in the web app (the frozen boot
	// snapshot keeps the old name, but the per-turn current-identity stanza reads agent.json
	// fresh, so the very next message already carries the new one) and web writers share this
	// process, so they cannot interleave with the synchronous apply below.
	assertPersistentRoomNotHeldByAnotherProcess(instance.agentId, "rename it");

	const dryRun = options.dryRun === true;

	// L1a: compute the anchored rewrite (nothing written yet).
	let headingUpdated = false;
	let identityUpdated = false;
	let nextL1a: string | null = null;
	if (previousDisplayName) {
		let l1a: string | null = null;
		try {
			l1a = instance.readL1a(meta);
		} catch {
			l1a = null;
		}
		if (l1a !== null) {
			let next = l1a;
			// Anchor 1: the line-1 constitution heading.
			const lines = next.split("\n");
			const firstLineHadCr = lines[0]?.endsWith("\r") ?? false;
			const firstLine = firstLineHadCr ? lines[0].slice(0, -1) : (lines[0] ?? "");
			if (firstLine === `# ${previousDisplayName} Constitution`) {
				lines[0] = `# ${displayName} Constitution${firstLineHadCr ? "\r" : ""}`;
				next = lines.join("\n");
				headingUpdated = true;
			} else if (firstLine === `# ${displayName} Constitution`) {
				// Already carries the new name (a prior partially-applied rename); report it as
				// current so a retry does not claim "constitution not updated" when it was.
				headingUpdated = true;
			}
			// Anchor 2: the first "You are **<oldName>**" inside the Identity section only.
			const identityHeading = /^##[ \t]+Identity[ \t]*\r?$/m.exec(next);
			if (identityHeading && identityHeading.index != null) {
				const sectionStart = identityHeading.index + identityHeading[0].length;
				const rest = next.slice(sectionStart);
				const nextHeading = /^##\s+/m.exec(rest);
				const sectionEnd = nextHeading?.index == null ? next.length : sectionStart + nextHeading.index;
				const section = next.slice(sectionStart, sectionEnd);
				const anchor = `You are **${previousDisplayName}**`;
				const at = section.indexOf(anchor);
				if (at >= 0) {
					const rewritten = section.slice(0, at) + `You are **${displayName}**` + section.slice(at + anchor.length);
					next = next.slice(0, sectionStart) + rewritten + next.slice(sectionEnd);
					identityUpdated = true;
				} else if (section.includes(`You are **${displayName}**`)) {
					// Same as the heading: a prior partially-applied rename already rewrote it.
					identityUpdated = true;
				}
			}
			if (headingUpdated || identityUpdated) nextL1a = next;
		}
	}

	// L1b: find word-boundary exact mentions of the old name (nothing written yet).
	let currentL1b: string | null = null;
	if (previousDisplayName) {
		try {
			currentL1b = instance.readL1b(meta);
		} catch {
			currentL1b = null;
		}
	}
	const mentionIndexes = currentL1b !== null ? findWholeNameMentionIndexes(currentL1b, previousDisplayName) : [];
	const memoryMentions = {
		count: mentionIndexes.length,
		lines: currentL1b !== null ? nameMentionLinePreviews(currentL1b, mentionIndexes) : [],
	};

	const updatedAt = Date.now();
	if (dryRun) {
		return {
			agentId: instance.agentId,
			displayName,
			previousDisplayName,
			updatedAt,
			dryRun: true,
			constitutionUpdated: headingUpdated && identityUpdated,
			constitutionAnchors: { heading: headingUpdated, identity: identityUpdated },
			memoryMentions,
			memoryUpdated: false,
			archivedL1b: null,
		};
	}

	// Apply. Re-read L1b immediately before the read-modify-write: a memory write that landed
	// after the preview scan above (a checkpoint approval, Memorize) must be renamed too, never
	// silently reverted to the stale snapshot — and the archive must capture the fresh content so
	// it never predates a just-learned memory. Archive convention follows checkpoint/structural
	// review: <archiveDir>/<stamp>-before-<id>.md.
	let archivedL1bRelPath: string | null = null;
	let memoryUpdated = false;
	let appliedMemoryMentions = memoryMentions;
	if (previousDisplayName) {
		let freshL1b: string | null = null;
		try {
			freshL1b = instance.readL1b(meta);
		} catch {
			freshL1b = null;
		}
		const freshIndexes = freshL1b !== null ? findWholeNameMentionIndexes(freshL1b, previousDisplayName) : [];
		appliedMemoryMentions = {
			count: freshIndexes.length,
			lines: freshL1b !== null ? nameMentionLinePreviews(freshL1b, freshIndexes) : [],
		};
		if (freshL1b !== null && freshIndexes.length > 0) {
			const archiveDir = instance.l1bArchiveDir(meta);
			ensureDir(archiveDir);
			const stamp = slugTimestamp(new Date(updatedAt));
			const renameId = `rename_${stamp}_${shortRandomId()}`;
			const archivedL1bPath = path.join(archiveDir, `${stamp}-before-${renameId}.md`);
			fs.writeFileSync(archivedL1bPath, freshL1b, { mode: 0o600, flag: "wx" });
			archivedL1bRelPath = path.relative(instance.rootDir, archivedL1bPath);
			const nextL1b = replaceNameMentions(freshL1b, freshIndexes, previousDisplayName, displayName);
			writeFileAtomic(instance.l1bCurrentPath(meta), nextL1b);
			memoryUpdated = true;
		}
	}
	if (nextL1a !== null) writeFileAtomic(instance.l1aPath(meta), nextL1a);

	const updatedMeta: AgentJson = {
		...(meta as AgentJson),
		displayName,
		updatedAt,
	};
	writeFileAtomic(instance.agentJsonPath(), JSON.stringify(updatedMeta, null, 2) + "\n");
	return {
		agentId: instance.agentId,
		displayName,
		previousDisplayName,
		updatedAt,
		dryRun: false,
		constitutionUpdated: headingUpdated && identityUpdated,
		constitutionAnchors: { heading: headingUpdated, identity: identityUpdated },
		memoryMentions: appliedMemoryMentions,
		memoryUpdated,
		archivedL1b: archivedL1bRelPath,
	};
}
