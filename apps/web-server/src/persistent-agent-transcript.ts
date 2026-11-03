import { ROOM_STATE_CUSTOM_TYPE } from "@exxeta/exxperts-runtime";
import { buildConsultHandoffBlockFromStack, type ConsultHandoffExchange, buildConsultHandoffBlock } from "./consult-handoff.js";
import { buildSpecialistHandoffBlock } from "./specialist-handoff.js";
import { readSessionPathMessages } from "./session-path-reader.js";
import { type CheckpointTranscriptItem, type CheckpointTranscriptSourceResult, fingerprintL1bSource } from "./persistent-agent-types.js";
import type { L1bSourceFingerprint } from "./persistent-agent-memory-types.js";
import { assertPersistentAgentThreadNotInFlight, createPersistentAgentInstance, getPersistentAgentRuntimeState, safeRuntimeThreadId, validatePersistentAgentId } from "./persistent-agent-store.js";
import { getPersistentAgentThread } from "./persistent-agent-threads.js";
import { openPersistentAgentPiSessionManager, readPersistentAgentBootPromptSnapshot } from "./persistent-agent-conversation-model.js";

// Tool output is the one kind of transcript text that is bounded here: it is
// the room's machinery rather than its words, and the prompt caps it far lower
// anyway. What the person and the room SAID is never cut: a pasted document or
// a long answer reaches Remember whole, and a conversation too long for one
// pass is read in parts instead (checkpoint-compression.ts).
const CHECKPOINT_CANONICAL_TOOL_OUTPUT_CAP = 12_000;

function normalizedCheckpointTranscriptText(raw: unknown): string {
	return String(raw ?? "").replace(/\r\n/g, "\n").trim();
}

function boundedCheckpointToolOutput(raw: unknown): string {
	const text = normalizedCheckpointTranscriptText(raw);
	if (text.length <= CHECKPOINT_CANONICAL_TOOL_OUTPUT_CAP) return text;
	return `${text.slice(0, CHECKPOINT_CANONICAL_TOOL_OUTPUT_CAP)}\n\n[checkpoint transcript item truncated to ${CHECKPOINT_CANONICAL_TOOL_OUTPUT_CAP} characters]`;
}

function checkpointContentText(raw: unknown): string {
	if (typeof raw === "string") return raw;
	if (!Array.isArray(raw)) return "";
	const parts: string[] = [];
	for (const part of raw) {
		if (part?.type === "text") parts.push(String(part.text ?? ""));
	}
	return parts.join("\n");
}

function checkpointTextFromContent(raw: unknown): string {
	return normalizedCheckpointTranscriptText(checkpointContentText(raw));
}

function checkpointAssistantTextFromContent(raw: unknown): string {
	if (!Array.isArray(raw)) return checkpointTextFromContent(raw);
	const parts: string[] = [];
	for (const part of raw) {
		if (part?.type === "text") parts.push(String(part.text ?? ""));
		if (part?.type === "toolCall") parts.push(`[tool call requested: ${String(part.name ?? "tool").trim() || "tool"}]`);
	}
	return normalizedCheckpointTranscriptText(parts.join("\n"));
}

function normalizeLegacyCheckpointTranscriptItems(rawItems: unknown[]): CheckpointTranscriptItem[] {
	return rawItems
		.map((item: any): CheckpointTranscriptItem | null => {
			const kind = String(item?.kind ?? "").trim();
			const id = item?.id == null ? undefined : String(item.id).trim().slice(0, 200) || undefined;
			if (kind === "user" || kind === "assistant" || kind === "system") {
				const text = normalizedCheckpointTranscriptText(item?.text);
				return text ? { kind, ...(id ? { id } : {}), text } : null;
			}
			if (kind === "consult") {
				// Legacy (transcript-recap-v1) compression source: a transferred
				// consult must reach the compressor with its provenance header, the
				// same way it enters modern threads via the prompt. Rebuild the
				// canonical handoff block from the display item and fold it in as a
				// system line. (Modern pi-session-jsonl threads carry the block
				// through the prompt and never hit this path.)
				const targetRoomId = String(item?.targetRoomId ?? "").trim();
				const targetDisplayName = String(item?.targetDisplayName ?? "").trim() || targetRoomId || "the room";
				const parseFingerprint = (raw: unknown) => {
					const value = String(raw ?? "").trim();
					const sep = value.indexOf(":");
					return sep >= 0 ? { algorithm: value.slice(0, sep), value: value.slice(sep + 1) } : { algorithm: "sha256", value };
				};
				const toIso = (ms: unknown) => (Number.isFinite(ms) && (ms as number) > 0 ? new Date(Math.floor(ms as number)).toISOString() : new Date().toISOString());
				// §8.4: a stacked item carries the whole conversation in `exchanges[]`;
				// render the numbered §8.8 form. A legacy single-exchange item (no
				// `exchanges`) renders the byte-identical §2.1 block from the flat fields.
				const stackedExchanges: unknown[] = Array.isArray(item?.exchanges) ? item.exchanges : [];
				const block = stackedExchanges.length > 0
					? buildConsultHandoffBlockFromStack({
						slug: targetRoomId || targetDisplayName,
						displayName: targetDisplayName,
						agentId: targetRoomId,
						exchanges: stackedExchanges.map((exchange: any): ConsultHandoffExchange => {
							const asOf = toIso(exchange?.consultedAt);
							return { question: String(exchange?.question ?? ""), answerMarkdown: String(exchange?.answer ?? ""), fingerprint: parseFingerprint(exchange?.l1bFingerprint), asOf, requestedAt: asOf };
						}),
					})
					: buildConsultHandoffBlock({
						slug: targetRoomId || targetDisplayName,
						displayName: targetDisplayName,
						agentId: targetRoomId,
						requestedAt: toIso(item?.consultedAt),
						question: String(item?.question ?? ""),
						fingerprint: parseFingerprint(item?.l1bFingerprint),
						answerMarkdown: String(item?.answer ?? ""),
					});
				const text = normalizedCheckpointTranscriptText(block);
				return text ? { kind: "system", ...(id ? { id } : {}), text } : null;
			}
			if (kind === "task") {
				// Mirror of the consult branch above: a transferred specialist task
				// must reach the compressor with its §2.2 provenance block, the same
				// way it enters modern threads via the prompt. (Legacy
				// transcript-recap-v1 rooms only; the builder defangs + caps.)
				const templateVersion = Number(item?.templateVersion);
				const block = buildSpecialistHandoffBlock({
					templateId: String(item?.template ?? ""),
					templateVersion: Number.isFinite(templateVersion) && templateVersion >= 1 ? Math.floor(templateVersion) : 1,
					taskTitle: String(item?.title ?? ""),
					ranAtIso: String(item?.generatedAt ?? "").trim() || new Date().toISOString(),
					artifactCount: Array.isArray(item?.artifacts) ? item.artifacts.length : 0,
					summary: String(item?.summary ?? ""),
				});
				const text = normalizedCheckpointTranscriptText(block);
				return text ? { kind: "system", ...(id ? { id } : {}), text } : null;
			}
			if (kind === "tool") {
				return {
					kind: "tool",
					...(id ? { id } : {}),
					name: String(item?.name ?? "tool").trim().slice(0, 200) || "tool",
					status: String(item?.status ?? "unknown").trim().slice(0, 80) || "unknown",
				};
			}
			return null;
		})
		.filter((item): item is CheckpointTranscriptItem => Boolean(item));
}

function checkpointTranscriptItemFromAgentMessage(message: any, index: number): CheckpointTranscriptItem | null {
	const id = `ctx_${String(index + 1).padStart(4, "0")}`;
	if (message?.role === "user") {
		const text = checkpointTextFromContent(message.content);
		return text ? { kind: "user", id, text } : null;
	}
	if (message?.role === "assistant") {
		const text = checkpointAssistantTextFromContent(message.content);
		return text ? { kind: "assistant", id, text } : null;
	}
	if (message?.role === "toolResult") {
		const text = boundedCheckpointToolOutput(checkpointContentText(message.content));
		return {
			kind: "toolResult",
			id,
			name: String(message.toolName ?? "tool").trim().slice(0, 200) || "tool",
			status: message.isError ? "error" : "success",
			...(text ? { text } : {}),
		};
	}
	if (message?.role === "branchSummary") {
		const text = normalizedCheckpointTranscriptText(`Branch summary:\n${String(message.summary ?? "").trim()}`);
		return text ? { kind: "system", id, text } : null;
	}
	if (message?.role === "custom") {
		// The room's live state the app sends the model, never the person's words.
		if (message.customType === ROOM_STATE_CUSTOM_TYPE) return null;
		const text = checkpointTextFromContent(message.content);
		return text ? { kind: "user", id, text } : null;
	}
	if (message?.role === "bashExecution") {
		if (message.excludeFromContext) return null;
		const output = String(message.output ?? "").trim();
		const text = boundedCheckpointToolOutput(`Ran command: ${String(message.command ?? "").trim()}\n${output ? `Output:\n${output}` : "(no output)"}`);
		return text ? { kind: "toolResult", id, name: "bash", status: message.exitCode === 0 ? "success" : "error", text } : null;
	}
	return null;
}

function fingerprintCheckpointTranscriptItems(items: CheckpointTranscriptItem[]): L1bSourceFingerprint {
	return fingerprintL1bSource(JSON.stringify(items));
}

export function buildPersistentAgentCheckpointTranscriptSource(input: {
	agentId?: string;
	conversationId: string;
	l1b: string;
	legacyItems?: unknown[];
	runtimeCwd?: string;
}): CheckpointTranscriptSourceResult {
	const instance = createPersistentAgentInstance(validatePersistentAgentId(input.agentId));
	const conversationId = safeRuntimeThreadId(input.conversationId);
	if (!conversationId) throw new Error("invalid persistent-agent checkpoint conversation id");
	const runtime = getPersistentAgentRuntimeState(instance.agentId);
	if ((runtime.state !== "active" && runtime.state !== "standby") || runtime.activeThreadId !== conversationId) {
		throw new Error("checkpoint proposal requires the current persistent-room activeThread");
	}
	const thread = getPersistentAgentThread(instance.agentId, conversationId);
	if (!thread) throw new Error(`persistent-agent activeThread not found: ${conversationId}`);
	assertPersistentAgentThreadNotInFlight(instance.agentId, conversationId);
	const l1bFingerprint = fingerprintL1bSource(input.l1b);
	if (thread.runtime.kind === "pi-session-jsonl") {
		readPersistentAgentBootPromptSnapshot(instance.agentId, thread.runtime);
		const sessionManager = openPersistentAgentPiSessionManager(instance.agentId, thread.runtime, input.runtimeCwd || process.cwd());
		// The whole session path, pre-compaction messages included and the
		// compaction summaries left out: the same reader the search index uses.
		const items = readSessionPathMessages(sessionManager)
			.map(checkpointTranscriptItemFromAgentMessage)
			.filter((item): item is CheckpointTranscriptItem => Boolean(item));
		if (items.length === 0) throw new Error("persistent-agent Pi session has no checkpointable transcript content");
		return {
			items,
			source: {
				activeThreadId: thread.threadId,
				runtimeKind: "pi-session-jsonl",
				l1bFingerprint,
				transcriptFingerprint: fingerprintCheckpointTranscriptItems(items),
				transcriptItemCount: items.length,
				sessionId: thread.runtime.sessionId,
				sessionFileRelPath: thread.runtime.sessionFileRelPath,
				bootPromptSnapshotRelPath: thread.runtime.bootPromptSnapshotRelPath,
				bootPromptSha256: thread.runtime.bootPromptSha256,
				leafId: sessionManager.getLeafId(),
				runtimeL1bFingerprint: thread.runtime.l1bFingerprint,
			},
		};
	}
	const items = normalizeLegacyCheckpointTranscriptItems(Array.isArray(input.legacyItems) ? input.legacyItems : thread.items ?? []);
	if (items.length === 0) throw new Error("transcript items are required");
	return {
		items,
		source: {
			activeThreadId: thread.threadId,
			runtimeKind: "transcript-recap-v1",
			l1bFingerprint,
			transcriptFingerprint: fingerprintCheckpointTranscriptItems(items),
			transcriptItemCount: items.length,
		},
	};
}
