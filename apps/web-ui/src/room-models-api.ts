// The model per room, from the client's side: the lists the pickers offer,
// a room's two rows, the defaults for new rooms, the open conversation's
// options and its switch. The server decides and
// validates; these only ask and read.

import { apiErrorCode, fetchJson } from "./api";
import type { CredentialGone } from "../../web-server/src/model-not-offered";
import type { AiDefaultsView, ChatItem, PersistentAgentAiProfileSelectionStatus, PersistentAgentAiProfileStatus, RoomModelLock, RoomModelLockView, RoomModelProviderView, RoomModelsView, RoomModelTask, WebChatModelStatus } from "./types";

export async function fetchRoomModelProviders(): Promise<RoomModelProviderView[]> {
	const status = await fetchJson<WebChatModelStatus>("/api/persistent-agent-room/model-status");
	return status.providers ?? [];
}

/** How a provider's saved credential failed at its last call: the key refused, a key outside a workspace, or a sign-in gone. */
export type KeyRefusal = NonNullable<PersistentAgentAiProfileStatus["provider"]["keyRefused"]>;

/**
 * The providers whose last call was refused for the saved credential, by
 * provider id, as AI setup's profiles carry it. A picker's provider ids are the
 * profiles' own (a gateway's too), so they key both. The server keeps these
 * per process: a restart, a key saved again or an answered call clears one.
 */
export async function fetchKeyRefusals(): Promise<Map<string, KeyRefusal>> {
	const status = await fetchJson<PersistentAgentAiProfileSelectionStatus>("/api/persistent-agent-ai-profile");
	return new Map(status.profiles.flatMap((profile) => (profile.provider.keyRefused ? [[profile.provider.id, profile.provider.keyRefused] as const] : [])));
}

/** A refusal in the credential words of model-not-offered.ts. */
export function keyRefusalGone(refusal: KeyRefusal): CredentialGone {
	return refusal === "refused" ? "key-refused" : refusal === "no-workspace" ? "key-no-workspace" : "signed-out";
}

/** The mark a picker shows on each model of a provider with a refusal (draft). */
export function keyRefusalMark(refusal: KeyRefusal): string {
	return refusal === "signed-out" ? "Signed out" : "Key refused";
}

/** Each refused provider's mark, for a picker's providerMarks. */
export function keyRefusalMarks(refusals: Map<string, KeyRefusal>): Map<string, string> {
	return new Map([...refusals].map(([provider, refusal]) => [provider, keyRefusalMark(refusal)]));
}

/** Sets a row (a lock), clears it back to the default (null), or leaves it (absent). */
export async function putRoomModels(agentId: string, patch: Partial<Record<RoomModelTask, RoomModelLock | null>>): Promise<RoomModelsView> {
	return (await fetchJson<{ models: RoomModelsView }>(`/api/persistent-agents/${encodeURIComponent(agentId)}/models`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(patch),
	})).models;
}

/** One rung of a model's own effort dial: the level that travels, the provider's word for it. */
export type EffortRung = { level: string; label: string };

/**
 * One offered model as the open conversation stands against it: `fits`, the
 * switch moves this conversation onto it in place; `freshFits`, a new
 * conversation of this room could start on it; `effort`, the conversation's
 * effort as that model would run it, always one of its ladder's rungs.
 */
export type ConversationModelOption = RoomModelLock & { fits: boolean; freshFits: boolean; effort: { level: string; ladder: EffortRung[] } };

/** The open conversation's options, one per model the room offers; nothing is written. */
export async function fetchConversationModelOptions(agentId: string, conversationId: string): Promise<ConversationModelOption[]> {
	return (await fetchJson<{ models: ConversationModelOption[] }>(`/api/persistent-agents/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(conversationId)}/model-options`)).models ?? [];
}

export async function fetchAiDefaults(): Promise<AiDefaultsView> {
	return (await fetchJson<{ defaults: AiDefaultsView }>("/api/ai/defaults")).defaults;
}

export async function putAiDefaults(patch: Partial<Record<RoomModelTask, RoomModelLock>>): Promise<AiDefaultsView> {
	return (await fetchJson<{ defaults: AiDefaultsView }>("/api/ai/defaults", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(patch),
	})).defaults;
}

/**
 * The "Continued on" line a switch wrote into the conversation, with its id.
 * `replaces`: the id of the line it took the place of, when nothing was said
 * since the switch before, so the page drops that line rather than saving it back.
 */
export type ConversationSwitchNotice = { id: string; text: string; replaces?: string } | null;

/**
 * The conversation's lines with a switch's "Continued on" line in: once, and
 * in place of the line it replaces, so back-to-back switches leave one line,
 * the last.
 */
export function withSwitchLine(items: ChatItem[], notice: { id: string; text: string; replaces?: string }): ChatItem[] {
	const kept = notice.replaces ? items.filter((item) => item.id !== notice.replaces) : items;
	if (kept.some((item) => item.id === notice.id)) return kept.length === items.length ? items : kept;
	return [...kept, { kind: "system", id: notice.id, text: notice.text, level: "info" }];
}

// The ids a switch's line carries; they must match persistent-agent-conversation-model.ts's modelSwitchLineItem.
const MODEL_SWITCH_LINE_ID_PREFIX = "model_switch_";
const isSwitchLine = (item: unknown): item is ChatItem & { kind: "system" } => {
	const line = item as { kind?: unknown; id?: unknown; text?: unknown } | null;
	return line?.kind === "system" && typeof line.id === "string" && line.id.startsWith(MODEL_SWITCH_LINE_ID_PREFIX) && typeof line.text === "string";
};

/**
 * The conversation's lines with its switch lines as stored: for a switch
 * whose answer was lost, so the page drops the line the switch replaced and
 * shows the one it wrote, and its next save keeps them so.
 */
export function withStoredSwitchLines(items: ChatItem[], stored: readonly unknown[]): ChatItem[] {
	const storedIds = new Set(stored.filter(isSwitchLine).map((item) => item.id));
	const kept = items.filter((item) => !isSwitchLine(item) || storedIds.has(item.id));
	const shown = new Set(kept.map((item) => item.id));
	const added = stored.filter((item): item is ChatItem => isSwitchLine(item) && !shown.has(item.id));
	return added.length === 0 && kept.length === items.length ? items : [...kept, ...added];
}

/** Why the switch route refused before anything was written: only `switch_answering` is worth trying again once the answer ends. */
export type ConversationSwitchRefusal = "switch_room_busy" | "switch_answering" | "switch_remembering" | "switch_too_long";
const SWITCH_REFUSALS: readonly string[] = ["switch_room_busy", "switch_answering", "switch_remembering", "switch_too_long"] satisfies readonly ConversationSwitchRefusal[];

/** The refusal code of a failed switch, or null when the failure may have moved the conversation (a failed rebind, a lost answer). */
export function conversationSwitchRefusal(error: unknown): ConversationSwitchRefusal | null {
	const code = apiErrorCode(error);
	return code && SWITCH_REFUSALS.includes(code) ? code as ConversationSwitchRefusal : null;
}

/**
 * Moves the open conversation to another model; the room's default stays.
 * Resolves with the model it continues on, the line it wrote into the
 * conversation (none when the conversation already ran on that model) and
 * the room's rows after the switch; rejects with the server's own sentence,
 * and a code when it refused before writing (conversationSwitchRefusal).
 */
export async function switchConversationModel(agentId: string, conversationId: string, lock: RoomModelLock): Promise<{ model: RoomModelLockView; notice?: ConversationSwitchNotice; models: RoomModelsView }> {
	return await fetchJson<{ model: RoomModelLockView; notice?: ConversationSwitchNotice; models: RoomModelsView }>(`/api/persistent-agents/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(conversationId)}/switch-model`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(lock),
	});
}
