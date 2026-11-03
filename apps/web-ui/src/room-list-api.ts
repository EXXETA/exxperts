import { fetchJson } from "./api";
import type { PersistentAgentStatus, PersistentAgentCreateRequest, PersistentAgentCreateResponse } from "./types";

function fetchPersistentAgentStatuses(): Promise<PersistentAgentStatus[]> {
	return fetchJson<PersistentAgentStatus[]>("/api/persistent-agents");
}

function createPersistentAgent(request: PersistentAgentCreateRequest): Promise<PersistentAgentCreateResponse> {
	return fetchJson<PersistentAgentCreateResponse>("/api/persistent-agents", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(request),
	});
}

export { createPersistentAgent, fetchPersistentAgentStatuses };
