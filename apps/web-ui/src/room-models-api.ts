// The model per room, from the client's side: the lists the pickers offer,
// a room's two rows, the defaults for new rooms, and the switch of an open
// conversation. The server decides and validates; these only ask and read.

import { fetchJson } from "./api";
import type { AiDefaultsView, RoomModelLock, RoomModelLockView, RoomModelProviderView, RoomModelsView, RoomModelTask, WebChatModelStatus } from "./types";

export async function fetchRoomModelProviders(): Promise<RoomModelProviderView[]> {
	const status = await fetchJson<WebChatModelStatus>("/api/persistent-agent-room/model-status");
	return status.providers ?? [];
}

export async function fetchRoomModels(agentId: string): Promise<RoomModelsView> {
	return (await fetchJson<{ models: RoomModelsView }>(`/api/persistent-agents/${encodeURIComponent(agentId)}/models`)).models;
}

/** Sets a row (a lock), clears it back to the default (null), or leaves it (absent). */
export async function putRoomModels(agentId: string, patch: Partial<Record<RoomModelTask, RoomModelLock | null>>): Promise<RoomModelsView> {
	return (await fetchJson<{ models: RoomModelsView }>(`/api/persistent-agents/${encodeURIComponent(agentId)}/models`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(patch),
	})).models;
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
 * Why the open conversation cannot switch while another process works the
 * room, in the words the server refuses with; null when nothing is in the
 * way (the room's own web session never is).
 */
export function switchRoomBusySentence(lock: { surface: string } | null | undefined): string | null {
	if (lock?.surface === "scheduler") return "This room is working on a scheduled background task. Wait for it to finish, then switch the model.";
	if (lock?.surface === "cli") return "This room is open in the CLI. Close it there, then switch the model.";
	return null;
}

/** The "Continued on" line a switch wrote into the conversation, with its id. */
export type ConversationSwitchNotice = { id: string; text: string } | null;

/**
 * Moves the open conversation to another model. Resolves with the model it
 * continues on, the line it wrote into the conversation (none when the
 * conversation already ran on that model) and the room's rows after the
 * switch; rejects with the server's own sentence when it refuses (answering,
 * remembering, too long for the model).
 */
export async function switchConversationModel(agentId: string, conversationId: string, lock: RoomModelLock): Promise<{ model: RoomModelLockView; notice?: ConversationSwitchNotice; models: RoomModelsView }> {
	return await fetchJson<{ model: RoomModelLockView; notice?: ConversationSwitchNotice; models: RoomModelsView }>(`/api/persistent-agents/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(conversationId)}/switch-model`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(lock),
	});
}
