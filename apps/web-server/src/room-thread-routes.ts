import { estimateTokens, switchFitNeededTokens } from "./token-estimate.js";
import { SettingsManager, getAgentDir } from "@exxeta/exxperts-runtime";
import { getPersistentAgentThread, markPersistentAgentThreadModelChosen, openPersistentAgentPiSessionManager, writePersistentAgentThread, createPersistentAgentPiSessionJsonlThreadRuntime, getPersistentAgentActiveTurnState, getRememberGeneration, SWITCH_WHILE_REMEMBERING_MESSAGE, switchPersistentAgentThreadModel, estimatePersistentAgentThreadContext, buildPersistentAgentBootContext, deletePersistentAgentThread, assertPersistentRoomNotHeldByAnotherProcess, getPersistentAgentRuntimeState, finishPersistentAgentTurn, writePersistentAgentMementoBoundary } from "./persistent-agents.js";
import { getPersistentRoomToolPolicy } from "./persistent-room-tool-policy.js";
import { latestTurnKey, rememberRemovedIds, removedIdsOf } from "./persistent-agent-turns.js";
import { isShared, legacyInsertIndex, mergeSaveById, readRemovedIds } from "./thread-items-by-id.js";
import { isModelSwitchLine } from "./persistent-agent-conversation-model.js";
import { resolvePersistentRoomEffectiveWorkspacePolicy, resolvePersistentRoomNewConversationWorkspacePolicy, persistentRoomRuntimeCwdForEffectiveWorkspacePolicy, type PersistentRoomEffectiveWorkspacePolicy } from "./persistent-room-workspace-policy.js";
import { rememberSentenceModelName } from "./checkpoint-compression.js";
import { createRoomModelCatalog, type RoomModelCatalog } from "./room-models.js";
import { checkpointPromptTokenBudget } from "./persistent-agent-boot.js";
import { effectiveConversationEffortChoice, isRoomEffortLevel, type RoomEffortLevel } from "./persistent-room-effort-settings.js";
import type { PersistentAgentModelLock } from "./persistent-agent-ai-profiles.js";
import type { PersistentAgentThreadRecord } from "./persistent-agent-types.js";
import { persistentAgentModelLocksEqual } from "./persistent-agent-ai-profiles.js";
import { withRoomSaveLock } from "./memory-commit.js";
import { activeRoomLock, REPO_ROOT, roomLockBusyStatus } from "./server-install-root.js";
import { type PersistentRoomLiveSession, persistentRoomLiveSessions, SWITCH_WHILE_ANSWERING_MESSAGE } from "./room-live-sessions.js";
import { app } from "./server-app.js";
import { browserSafeMementoBoundaryResponse, getUsablePersistentAgentStatusForNormalUse, persistentAgentNormalUseErrorReply } from "./room-status.js";
import { effortOnModel, parseRoomModelPatch, type RegistryModel, roomModelLockPayload, roomModelsPayload, webChatProviderLabel } from "./ai-models.js";
import { resolveBoundaryFreshThreadModel, roomConversationModelForNewThread } from "./ai-profile-models.js";

// Post-stream landing: thread answers are client-
// authored, and the client's debounced persist fires ~500ms after the LAST
// reveal tick, so a settled turn has a window where the finished answer exists
// only client-side. These helpers guard both directions of the double-write:
// the close-handler landing skips when a client write already carried the
// answer, and a stale client PUT that raced the landing merges instead of
// clobbering the landed answer back out of the file.
function normalizedThreadAnswerText(text: unknown): string {
	return String(text ?? "").replace(/\s+/g, " ").trim();
}

// Whitespace-insensitive containment over the joined assistant texts: the
// client's persisted copy of an answer differs from the server's turn trace
// only in whitespace and item slicing, never in words, so strict equality
// would be fragile and per-item equality would miss multi-part answers.
function threadItemsCarryAssistantText(items: unknown, finalText: string): boolean {
	const wanted = normalizedThreadAnswerText(finalText);
	if (!wanted) return true;
	const joined = normalizedThreadAnswerText(
		(Array.isArray(items) ? items : [])
			.filter((item: any) => item?.kind === "assistant" && typeof item.text === "string")
			.map((item: any) => item.text)
			.join("\n"),
	);
	return joined.includes(wanted);
}

// A landed answer must survive a stale client save. The detached/post-stream
// landing writes the finished answer under detached-* item ids; a client PUT
// that was already in flight when the socket died can arrive afterwards with
// an item list from before the landing, and a wholesale items overwrite would
// clobber the paid answer back out of the file. Merge instead: any landed
// assistant item the incoming list carries neither by id nor by text is
// re-appended (with its landed prompt sibling), and a stale partial reveal of
// that same answer is dropped so the merge never leaves a duplicate fragment
// in front of the full text. An incoming list that DOES carry the answer (the
// pagehide keepalive save's own copy, or the landed items a resume loaded) is
// left untouched. In a thread that also holds shared items
// (thread-items-by-id.ts) it never removes one, and what it brings back goes
// no later than the first shared item the file holds after it.
function mergeLandedAnswerTailIntoClientItems(existingItems: any[], incoming: unknown[]): unknown[] {
	const insertAt = (list: unknown[], items: unknown[], legacyId: string, todayIndex: number): unknown[] => {
		const at = legacyInsertIndex(list, existingItems, legacyId, todayIndex);
		return [...list.slice(0, at), ...items, ...list.slice(at)];
	};
	const landedAssistants = existingItems.filter((item: any) => item?.kind === "assistant" && String(item?.id ?? "").startsWith("detached-assistant-"));
	if (landedAssistants.length === 0 && !existingItems.some((item: any) => String(item?.id ?? "").startsWith("detached-step-"))) return incoming;
	const incomingIds = new Set(incoming.map((item: any) => String(item?.id ?? "")));
	let merged: any[] = [...incoming];
	for (const landed of landedAssistants) {
		const landedId = String((landed as any).id ?? "");
		if (incomingIds.has(landedId)) continue;
		const landedText = String((landed as any).text ?? "");
		if (threadItemsCarryAssistantText(merged, landedText)) continue;
		// Drop a stale partial reveal of THIS answer: assistant items after the
		// list's last user item whose whole text is a fragment of the landed
		// text. Anything else after that user item (a previous turn's answer
		// has different words) is deliberately kept.
		const wanted = normalizedThreadAnswerText(landedText);
		let lastUserIndex = -1;
		for (let i = merged.length - 1; i >= 0; i--) { if ((merged[i] as any)?.kind === "user") { lastUserIndex = i; break; } }
		merged = merged.filter((item: any, index: number) => {
			if (index <= lastUserIndex || item?.kind !== "assistant" || isShared(item)) return true;
			const fragment = normalizedThreadAnswerText(item?.text);
			return !(fragment && wanted.includes(fragment));
		});
		const userSiblingId = `detached-user-${landedId.slice("detached-assistant-".length)}`;
		if (!incomingIds.has(userSiblingId)) {
			const userSibling = existingItems.find((item: any) => String(item?.id ?? "") === userSiblingId);
			if (userSibling && !merged.some((item: any) => item?.kind === "user" && normalizedThreadAnswerText(item?.text) === normalizedThreadAnswerText((userSibling as any).text))) {
				merged = insertAt(merged, [userSibling], userSiblingId, merged.length);
			}
		}
		// The landed turn's steps come back with it, finished, in place of the page's own copies after its last prompt.
		const lastUser = merged.map((item: any) => item?.kind).lastIndexOf("user");
		const landedSteps = existingItems.filter((item: any) => String(item?.id ?? "").startsWith(`detached-step-${landedId.slice("detached-assistant-".length)}-`));
		if (landedSteps.length > 0) {
			const kept = merged.filter((item: any, index: number) => index <= lastUser || item?.kind !== "tool" || isShared(item));
			merged = insertAt(kept, landedSteps, String(landedSteps[0].id), kept.length);
		}
		merged = insertAt(merged, [landed], landedId, merged.length);
	}
	// A landing with steps and no answer is landed content too: its steps come back the same way, after their prompt.
	const stepTurnOf = (item: any) => String(item?.id ?? "").replace(/-\d+$/, "");
	for (const stepTurn of new Set(existingItems.filter((item: any) => String(item?.id ?? "").startsWith("detached-step-")).map(stepTurnOf))) {
		const landedSteps = existingItems.filter((item: any) => stepTurnOf(item) === stepTurn);
		if (landedAssistants.some((landed: any) => String(landed.id) === `detached-assistant-${stepTurn.slice("detached-step-".length)}`) || landedSteps.some((step: any) => incomingIds.has(String(step.id)))) continue;
		const before = existingItems.slice(0, existingItems.indexOf(landedSteps[0]));
		const prompt = [...before].reverse().find((item: any) => item?.kind === "user");
		// With no prompt before them, the steps go after the newest message, as they always did.
		if (!prompt) {
			const lastUser = merged.map((item: any) => item?.kind).lastIndexOf("user");
			const kept = merged.filter((item: any, index: number) => index <= lastUser || item?.kind !== "tool" || isShared(item));
			merged = insertAt(kept, landedSteps, String(landedSteps[0].id), kept.length);
			continue;
		}
		// Anchored on the turn's own prompt (by id, else the same text as often as before it), so a later message never takes its steps.
		const sameText = (item: any) => item?.kind === "user" && normalizedThreadAnswerText(item?.text) === normalizedThreadAnswerText((prompt as any).text);
		const byText = merged.filter(sameText)[before.filter(sameText).length - 1];
		let anchor = merged.findIndex((item: any) => item?.kind === "user" && String(item?.id ?? "") === String((prompt as any).id ?? ""));
		if (anchor < 0 && byText) anchor = merged.indexOf(byText);
		if (anchor < 0) {
			merged = insertAt(merged, [prompt], String((prompt as any).id ?? ""), merged.length);
			anchor = merged.indexOf(prompt);
		}
		let end = merged.findIndex((item: any, index: number) => index > anchor && item?.kind === "user");
		if (end < 0) end = merged.length;
		const stretch = merged.slice(anchor + 1, end);
		// The page's own finished copies of these steps already stand for them; a running or stopped copy never does.
		if (landedSteps.every((step: any) => stretch.some((item: any) => item?.kind === "tool" && item.status !== "running" && item.status !== "stopped" && item.name === step.name && JSON.stringify(item.args ?? {}) === JSON.stringify(step.args ?? {})))) continue;
		const keptStretch = stretch.filter((item: any) => item?.kind !== "tool" || isShared(item));
		merged = insertAt([...merged.slice(0, anchor + 1), ...keptStretch, ...merged.slice(end)], landedSteps, String(landedSteps[0].id), anchor + 1 + keptStretch.length);
	}
	return merged;
}

/**
 * The merged save with the switch lines the file ends with and the save
 * lacks, at its end: the switch wrote them after the page built the save, so
 * they come after all of it, where the page draws them, and the next switch
 * still finds its line last. They take the place of the switch lines the save
 * ends with that the file no longer holds: lines those switches replaced. A
 * line the page removed on purpose stays out.
 */
function withLateSwitchLines(file: readonly unknown[], merged: unknown[], removed: ReadonlySet<string>): unknown[] {
	const idOf = (item: unknown) => String((item as any)?.id ?? "");
	const trailingLines = (items: readonly unknown[]) => {
		let tail = items.length;
		while (tail > 0 && isModelSwitchLine(items[tail - 1])) tail--;
		return tail;
	};
	const inMerged = new Set(merged.map(idOf));
	let lastSaved = -1;
	file.forEach((item, index) => { if (inMerged.has(idOf(item))) lastSaved = index; });
	const late = file.slice(Math.max(trailingLines(file), lastSaved + 1)).filter((item) => !removed.has(idOf(item)));
	if (late.length === 0) return merged;
	const inFile = new Set(file.map(idOf));
	const replaced = merged.slice(trailingLines(merged)).filter((item) => !inFile.has(idOf(item)));
	return [...merged.filter((item) => !replaced.includes(item)), ...late];
}

/**
 * A page save against the file: by id first (thread-items-by-id.ts), for a
 * thread that holds shared items or a save that names removals, then the old
 * merge for old landings. `removed` is remembered for the conversation, so
 * an older save that arrives later does not bring those ids back.
 */
function mergeThreadSave(agentId: string, threadId: string, incoming: unknown, removedNow: string[]): unknown[] | undefined {
	if (!Array.isArray(incoming)) return undefined;
	let existingItems: any[];
	try { existingItems = getPersistentAgentThread(agentId, threadId)?.items ?? []; } catch { return incoming; }
	rememberRemovedIds(agentId, threadId, removedNow);
	// The memory keeps only the newest removals; this save's own all count.
	const removed = new Set([...removedIdsOf(agentId, threadId), ...removedNow]);
	const byId = removed.size > 0 || existingItems.some(isShared) || incoming.some((item: any) => item && typeof item === "object" && "landed" in item);
	const merged = byId ? mergeSaveById(existingItems, incoming, removed, (key) => latestTurnKey(agentId, threadId) === key) : incoming;
	// The old merge brings back old landings, never one the page removed.
	const kept = removed.size > 0 ? existingItems.filter((item: any) => !removed.has(String(item?.id ?? ""))) : existingItems;
	// Last, so a line goes after every landing a merge brought back.
	return withLateSwitchLines(existingItems, mergeLandedAnswerTailIntoClientItems(kept, merged), removed);
}

// The save carries every chat item of the open conversation, and opening a
// room re-saves the thread it read, so a save the server refuses keeps the
// room shut. Items are text (attachments are metadata; files go through the
// shelf route) and each tool result is cut near 50 KB by the runtime, so 64
// MB holds over a thousand full tool results, far past the default 1 MiB a
// long conversation reaches.
app.put("/api/persistent-agents/:id/threads/:threadId", { bodyLimit: 64 * 1024 * 1024 }, async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	const threadId = String((req.params as any).threadId ?? "").trim();
	try {
		const status = getUsablePersistentAgentStatusForNormalUse(idRaw);
		const body = (req.body ?? {}) as any;
		const effectiveWorkspacePolicy = resolvePersistentRoomEffectiveWorkspacePolicy(status.id, threadId);
		const runtimeCwd = persistentRoomRuntimeCwdForEffectiveWorkspacePolicy(effectiveWorkspacePolicy, REPO_ROOT);
		// A save that raced a server-side landing merges the landed items in
		// instead of overwriting them away (mergeThreadSave).
		const items = mergeThreadSave(status.id, threadId, body.items, readRemovedIds(body.removed));
		// The server decides the lock: a saved conversation keeps its own, a new
		// one starts on the room's conversation model. A model the client names
		// is not a choice (choices are made in Room settings, Model).
		const existing = getPersistentAgentThread(status.id, threadId);
		const model = existing?.model ?? roomConversationModelForNewThread(status.id);
		return writePersistentAgentThread(status.id, threadId, { state: body.state, origin: body.origin, model, items, pendingHandoffs: body.pendingHandoffs }, {
			createRuntime: ({ model }) => createPersistentAgentPiSessionJsonlThreadRuntime({
				agentId: status.id,
				threadId,
				model,
				cwd: runtimeCwd,
			}),
			// An active save is how a conversation is switched to and moves the
			// pointer; a standby save parks a conversation (the room-exit save,
			// a late debounced persist) and must never steal the pointer from a
			// newer one.
			...(body.state === "standby" ? { keepRuntimeIfMoved: true } : {}),
		});
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

// The switch: an open conversation continues on another model between turns.
// Refused while the room answers or a Remember reads the conversation, and
// when the conversation would not fit the new model: the fit is the larger of
// what the provider last measured and the one estimator over every message,
// the system prompt and the tool definitions, with a 15 percent margin, under
// the new window minus the compaction reserve. A null measurement never
// refuses (it only means no answer since the last compaction; the estimate
// always exists). The switch changes only this conversation: the room's pick
// stays the default for new ones. A refusal before anything was written
// carries a code (switch_room_busy, switch_answering, switch_remembering,
// switch_too_long); a failure after the conversation moved answers with the
// model it is stored on now.
app.post("/api/persistent-agents/:id/threads/:threadId/switch-model", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	const threadId = String((req.params as any).threadId ?? "").trim();
	try {
		const status = getUsablePersistentAgentStatusForNormalUse(idRaw);
		const catalog = createRoomModelCatalog();
		const lock = parseRoomModelPatch({ conversation: req.body ?? {} }, catalog, { allowClear: false }).conversation!;
		const thread = getPersistentAgentThread(status.id, threadId);
		if (!thread || thread.state === "closed") return reply.code(404).send({ error: "That conversation is not open." });
		// A scheduled run is working this room: its session file has one
		// writer, so the switch waits, as memory undo does. The
		// room's own web session is not in the way: the switch rebinds it.
		const roomLockState = activeRoomLock(status.id);
		if (roomLockState?.surface === "scheduler") {
			return reply.code(409).send({ error: `This room is ${roomLockBusyStatus(roomLockState)}. Wait for it to finish, then switch the model.`, code: "switch_room_busy" });
		}
		if (getPersistentAgentActiveTurnState(status.id, threadId).state !== "idle") return reply.code(409).send({ error: SWITCH_WHILE_ANSWERING_MESSAGE, code: "switch_answering" });
		if (getRememberGeneration(status.id, threadId)) return reply.code(409).send({ error: SWITCH_WHILE_REMEMBERING_MESSAGE, code: "switch_remembering" });
		const registry = catalog.registry;
		const target = registry.find(lock.provider, lock.model);
		if (!target) return reply.code(400).send({ error: `${lock.model} is not offered for rooms by ${webChatProviderLabel(lock.provider)}.` });
		const runtimeCwd = persistentRoomRuntimeCwdForEffectiveWorkspacePolicy(resolvePersistentRoomEffectiveWorkspacePolicy(status.id, threadId), REPO_ROOT);
		const live = persistentRoomLiveSessions.get(status.id);
		const liveHere = live && live.conversationId === threadId ? live : null;
		const fit = conversationSwitchFit(status.id, threadId, target, runtimeCwd, liveHere);
		// The name the app shows, as in every other sentence (a gateway's raw id tidied).
		const name = rememberSentenceModelName(roomModelLockPayload(lock, registry, catalog)!);
		if (!fit.fits) {
			return reply.code(409).send({
				error: `This conversation is too long for ${name} to read. It stays on its current model. To continue on ${name}, Remember it and start a new conversation.`,
				code: "switch_too_long",
				fit,
			});
		}
		const notice = `Continued on ${name}`;
		// The line the switch wrote, with its id, so a client that did not hear
		// the socket's frame adds this line and not a second one of its own.
		// `replaces`: the line a switch right after another took the place of.
		let written: { id: string; text: string; replaces?: string } | null = null;
		if (!persistentAgentModelLocksEqual(thread.model, lock)) {
			try {
				if (liveHere) {
					const { noticeId, replaces } = await liveHere.switchModel(lock, notice);
					written = { id: noticeId, text: notice, ...(replaces ? { replaces } : {}) };
				} else {
					const switched = switchPersistentAgentThreadModel(status.id, threadId, lock, { notice, runtimeCwd });
					const last = switched.thread.items[switched.thread.items.length - 1] as { id?: string } | undefined;
					written = { id: String(last?.id ?? ""), text: notice, ...(switched.replaces ? { replaces: switched.replaces } : {}) };
				}
			} catch (error) {
				// The live rebind can fail after the conversation moved on disk
				// (the new model's boot refused): the answer names the model the
				// conversation is stored on, so the page shows the truth.
				const stored = getPersistentAgentThread(status.id, threadId)?.model;
				if (!stored || persistentAgentModelLocksEqual(stored, thread.model)) throw error;
				const code = typeof (error as any)?.code === "string" ? (error as any).code : "switch_rebind_failed";
				return reply.code((error as any)?.statusCode ?? 500).send({ error: (error as Error).message, code, model: roomModelLockPayload(stored, registry, catalog) });
			}
		} else {
			markPersistentAgentThreadModelChosen(status.id, threadId);
		}
		return { agentId: status.id, conversationId: threadId, model: roomModelLockPayload(lock, registry, catalog), notice: written, fit, models: roomModelsPayload(status.id, createRoomModelCatalog()) };
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

/** What one tool definition counts for in the switch's fit when no session is bound to measure the real ones. */
const SWITCH_FIT_TOOL_TOKENS = 350;

/** The switch's margin on the estimate, the same the probe measured against (real/estimate 1.084). */
const SWITCH_FIT_MARGIN = 1.15;

/** What one conversation needs from any model it would switch to, measured once: compared per model by switchFitOn. */
function conversationSwitchNeeds(agentId: string, threadId: string, runtimeCwd: string, live: PersistentRoomLiveSession | null): SwitchNeeds {
	const estimate = estimatePersistentAgentThreadContext(agentId, threadId, runtimeCwd);
	const liveTools = live?.toolDefinitionTokens() ?? null;
	return {
		measured: live?.measuredContextTokens() ?? null,
		estimated: {
			messages: estimate.messagesTokens,
			systemPrompt: estimate.systemPromptTokens,
			...(liveTools != null ? { tools: liveTools, toolsFrom: "session" as const } : { tools: roomToolListTokens(agentId, resolvePersistentRoomEffectiveWorkspacePolicy(agentId, threadId)), toolsFrom: "room tool list" as const }),
		},
		reserve: SettingsManager.create(runtimeCwd, getAgentDir()).getCompactionSettings().reserveTokens,
	};
}

type SwitchNeeds = {
	measured: number | null;
	estimated: { messages: number; systemPrompt: number; tools: number; toolsFrom: "session" | "room tool list" };
	reserve: number;
};

/** The room's tool list under these workspace settings, by the allowance per tool, for a conversation with no bound session to measure. */
function roomToolListTokens(agentId: string, policy: PersistentRoomEffectiveWorkspacePolicy): number {
	const toolPolicy = getPersistentRoomToolPolicy(agentId, {
		workspaceToolsEnabled: policy?.workspaceToolsEnabled === true,
		workspaceToolNames: policy?.allowedToolNames ?? [],
		workspaceAccessMode: policy?.workspaceAccessMode,
		bashEnabled: policy?.bashEnabled === true,
		bashRuntimeAllowed: true,
	});
	return (toolPolicy?.allowedToolNames.length ?? 0) * SWITCH_FIT_TOOL_TOKENS;
}

/** The numbers the switch's fit is decided on, returned with the answer so a refusal can say them. */
function switchFitOn(needs: SwitchNeeds, target: RegistryModel) {
	const estimated = needs.estimated.messages + needs.estimated.systemPrompt + needs.estimated.tools;
	// The measured count is real already; the estimate is counted the way the target model counts.
	const needed = switchFitNeededTokens({ measured: needs.measured, estimated, model: { provider: target.provider, model: target.id }, margin: SWITCH_FIT_MARGIN });
	const window = typeof target.contextWindow === "number" ? target.contextWindow : 0;
	const available = window - needs.reserve;
	return {
		fits: window > 0 && needed <= available,
		needed,
		available,
		window,
		reserve: needs.reserve,
		margin: SWITCH_FIT_MARGIN,
		measured: needs.measured,
		estimated: needs.estimated,
	};
}

function conversationSwitchFit(agentId: string, threadId: string, target: RegistryModel, runtimeCwd: string, live: PersistentRoomLiveSession | null) {
	return switchFitOn(conversationSwitchNeeds(agentId, threadId, runtimeCwd, live), target);
}

type FreshNeeds = { bootTokens: number; tools: number; reserve: number };

/**
 * What a new conversation of this room needs from a model before anything is
 * said: the boot prompt it would start on (the room's memory as it is now,
 * plus `extraTokens` a save is about to add) and the room's tool list, both
 * under the room's workspace settings, which a new conversation starts on
 * whatever `threadId` keeps for itself. Built once, compared per model by
 * freshFitOn.
 */
function freshConversationNeeds(agentId: string, threadId: string, model: PersistentAgentModelLock, extraTokens = 0): FreshNeeds {
	const policy = resolvePersistentRoomNewConversationWorkspacePolicy(agentId, threadId);
	const workspaceCapability = policy.capability;
	const runtimeCwd = persistentRoomRuntimeCwdForEffectiveWorkspacePolicy(policy, REPO_ROOT);
	const boot = buildPersistentAgentBootContext({ agentId, conversationId: threadId, sessionId: null, model, ...(workspaceCapability ? { workspaceCapability } : {}) });
	return {
		bootTokens: estimateTokens(boot.systemPrompt) + extraTokens,
		tools: roomToolListTokens(agentId, policy),
		reserve: SettingsManager.create(runtimeCwd, getAgentDir()).getCompactionSettings().reserveTokens,
	};
}

/**
 * Whether a new conversation can start on this model: the boot gate's own
 * budget (persistent-agent-boot.ts, the last guard), and the switch's fit of
 * that boot prompt and the tools, so a model offered for a new conversation
 * is never one the boot then refuses. The Remember route asks the same.
 */
function freshFitOn(needs: FreshNeeds, target: RegistryModel): boolean {
	const lock = { provider: target.provider, model: target.id };
	const window = typeof target.contextWindow === "number" ? target.contextWindow : 0;
	const bootFits = !Number.isFinite(target.maxTokens) || needs.bootTokens <= checkpointPromptTokenBudget({ contextWindow: window, maxOutputTokens: target.maxTokens }, lock);
	const fits = switchFitOn({ measured: null, estimated: { messages: 0, systemPrompt: needs.bootTokens, tools: needs.tools, toolsFrom: "room tool list" }, reserve: needs.reserve }, target).fits;
	return bootFits && fits;
}

/** Whether a new conversation of this room could start on `lock` now, counting `extraTokens` a save adds to the memory. */
function freshConversationFits(agentId: string, threadId: string, lock: PersistentAgentModelLock, catalog: RoomModelCatalog, extraTokens = 0): boolean {
	const target = catalog.registry.find(lock.provider, lock.model);
	return Boolean(target) && freshFitOn(freshConversationNeeds(agentId, threadId, lock, extraTokens), target!);
}

/**
 * The level the runtime restores when it resumes this conversation's session:
 * the last one it saved, once the session holds a message (an empty session
 * starts again at the machine's default). Null when there is none to restore.
 */
function sessionRestoredEffort(agentId: string, thread: PersistentAgentThreadRecord, runtimeCwd: string): RoomEffortLevel | null {
	if (thread.runtime.kind !== "pi-session-jsonl") return null;
	try {
		const branch = openPersistentAgentPiSessionManager(agentId, thread.runtime, runtimeCwd).getBranch();
		if (!branch.some((entry) => entry.type === "message")) return null;
		const saved = branch.filter((entry) => entry.type === "thinking_level_change").at(-1) as { thinkingLevel?: unknown } | undefined;
		return isRoomEffortLevel(saved?.thinkingLevel) ? saved.thinkingLevel : null;
	} catch {
		return null;
	}
}

// The message box's model panel, in one read: for every model the room
// offers, whether this conversation switches to it in place (`fits`, the
// switch's own check), whether a new conversation could start on it
// (`freshFits`, the Remember route's check), and the conversation's effort as
// that model would run it (always one of its ladder's rungs). The estimate is
// made once for all models; nothing is written.
app.get("/api/persistent-agents/:id/threads/:threadId/model-options", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	const threadId = String((req.params as any).threadId ?? "").trim();
	try {
		const status = getUsablePersistentAgentStatusForNormalUse(idRaw);
		const thread = getPersistentAgentThread(status.id, threadId);
		if (!thread || thread.state === "closed") return reply.code(404).send({ error: "That conversation is not open." });
		const catalog = createRoomModelCatalog();
		const runtimeCwd = persistentRoomRuntimeCwdForEffectiveWorkspacePolicy(resolvePersistentRoomEffectiveWorkspacePolicy(status.id, threadId), REPO_ROOT);
		const live = persistentRoomLiveSessions.get(status.id);
		const liveHere = live && live.conversationId === threadId ? live : null;
		// An older conversation that is not Pi-backed cannot switch at all.
		const switchNeeds = thread.runtime.kind === "pi-session-jsonl" ? conversationSwitchNeeds(status.id, threadId, runtimeCwd, liveHere) : null;
		const freshNeeds = freshConversationNeeds(status.id, threadId, thread.model);
		// With no level chosen anywhere a conversation runs at the level its
		// session restores, else at the machine's default, else the runtime's
		// own (medium).
		const chosen = effectiveConversationEffortChoice(status.id, threadId) ?? sessionRestoredEffort(status.id, thread, runtimeCwd) ?? SettingsManager.create(runtimeCwd, getAgentDir()).getDefaultThinkingLevel() ?? "medium";
		const models = catalog.providers.flatMap((provider) => provider.conversation.flatMap((lock) => {
			if (!catalog.availability(lock, "conversation").ok) return [];
			const target = catalog.registry.find(lock.provider, lock.model);
			if (!target) return [];
			return [{ provider: lock.provider, model: lock.model, fits: switchNeeds ? switchFitOn(switchNeeds, target).fits : false, freshFits: freshFitOn(freshNeeds, target), effort: effortOnModel(target, chosen) }];
		}));
		return { agentId: status.id, conversationId: threadId, models };
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

app.delete("/api/persistent-agents/:id/threads/:threadId", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	const threadId = String((req.params as any).threadId ?? "").trim();
	try {
		const status = getUsablePersistentAgentStatusForNormalUse(idRaw);
		return deletePersistentAgentThread(status.id, threadId);
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

app.post("/api/persistent-agents/:id/memento", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		// Memento is a force operation: when the user clicks it, the thread
		// closes. It works on ready and needs_absorb rooms alike (it never
		// writes memory, so a room that is due for Memorize can still be reset).
		const status = getUsablePersistentAgentStatusForNormalUse(idRaw);
		// A scheduled background run is actively writing this room's thread;
		// closing it under its feet silently loses its output.
		// The room's own live web session is fine: it is quiesced below.
		assertPersistentRoomNotHeldByAnotherProcess(status.id, "forget this conversation");
		const body = (req.body ?? {}) as any;
		const requestedConversationId = String(body.conversationId ?? "").trim();
		// A stale conversationId from an old status snapshot must not make the
		// click fail: Memento always targets the room's CURRENT activeThread.
		const runtime = getPersistentAgentRuntimeState(status.id);
		const conversationId = runtime.state !== "idle" && runtime.activeThreadId ? runtime.activeThreadId : requestedConversationId;
		// Retargeting is only harmless when the current thread holds nothing the
		// requester has not seen (an empty prepared boundary). A conversation
		// with real turns that the requester never looked at must not be
		// discarded off a stale snapshot.
		if (requestedConversationId && conversationId !== requestedConversationId && status.activeThread?.hasUserVisibleTurns) {
			const error = new Error("This conversation is stale: the room has moved to a newer one. Refresh and try again.");
			(error as any).statusCode = 409;
			throw error;
		}
		// Quiesce any live web session for this room first: abort the in-flight
		// turn and dispose the session (the same path the WS "abort" frame and
		// disconnect cleanup use), so nothing keeps streaming into the thread we
		// are about to close. A hung provider must not hold Memento hostage,
		// hence the timeout; the forced finish below covers that case.
		const live = persistentRoomLiveSessions.get(status.id);
		if (live) {
			await Promise.race([
				live.quiesceForBoundary().catch((error) => { app.log.warn({ err: error }, "memento: live session quiesce failed"); }),
				new Promise<void>((resolve) => setTimeout(resolve, 5000)),
			]);
		}
		// Clear a dangling in-memory turn flag (killed provider, crashed client):
		// the turn can never complete coherently and Memento closes its thread
		// anyway. This only touches the old thread's key, never the fresh one.
		try {
			const turnState = getPersistentAgentActiveTurnState(status.id, conversationId);
			if (turnState.state !== "idle") finishPersistentAgentTurn(status.id, conversationId, { terminalReason: "cancelled" });
		} catch (error) {
			app.log.warn({ err: error }, "memento: failed to clear dangling turn state");
		}
		const effectiveWorkspacePolicy = resolvePersistentRoomEffectiveWorkspacePolicy(status.id, conversationId);
		const runtimeCwd = persistentRoomRuntimeCwdForEffectiveWorkspacePolicy(effectiveWorkspacePolicy, REPO_ROOT);
		// After a Memento the room must be usable again. When the old thread's
		// model lock is no longer provided by the active AI profile, start the
		// fresh thread on a currently-available room model instead (saved room
		// selection first, then the profile's models, preferring configured
		// auth). When nothing is available the fresh thread inherits the old
		// lock — Memento itself never invokes a model, so it still succeeds.
		const freshModel = resolveBoundaryFreshThreadModel(status.id, conversationId);
		let result;
		try {
			result = await withRoomSaveLock(status.id, () => writePersistentAgentMementoBoundary(status.id, conversationId, new Date(), { runtimeCwd, ...(freshModel ? { freshModel } : {}) }));
		} catch (error) {
			// The live session was already disposed by the quiesce above; a client
			// left holding the socket would silently dead-end on its next prompt.
			if (live && persistentRoomLiveSessions.get(status.id) === live) {
				live.notify("This conversation could not be forgotten and the session was interrupted. Reopen the room to continue.");
				live.closeSocket();
			}
			throw error;
		}
		// Tell a still-connected live client its thread is gone, then close the
		// socket so it stops writing to the closed thread and the room lock is
		// released. The client lands in its normal disconnected state.
		if (live && persistentRoomLiveSessions.get(status.id) === live) {
			live.notify("This conversation was forgotten. It is closed and the room starts fresh on next open.");
			live.closeSocket();
		}
		return browserSafeMementoBoundaryResponse(result);
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

export { freshConversationFits, threadItemsCarryAssistantText };
