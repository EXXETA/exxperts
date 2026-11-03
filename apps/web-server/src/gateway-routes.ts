import { AuthStorage } from "@exxeta/exxperts-runtime";
import { isCustomAiProfileId, readCustomAiProfiles, deleteCustomAiProfile } from "./custom-ai-profiles.js";
import { OPENAI_COMPATIBLE_AI_PROFILE_ID } from "./persistent-agent-ai-profiles.js";
import { readOpenAiCompatibleGateways, GATEWAY_DEFAULT_CONTEXT_WINDOW, GATEWAY_MIN_CONTEXT_WINDOW, GATEWAY_MAX_CONTEXT_WINDOW, findOpenAiCompatibleGateway } from "./openai-compatible-gateways.js";
import { readSavedPersistentAgentAiProfileId, clearSavedPersistentAgentAiProfileState } from "./persistent-agent-ai-profile-state.js";
import { app } from "./server-app.js";
import { buildPersistentAgentAiProfileSelectionStatus } from "./ai-profile-models.js";
import { gatewayDeleteHandler, gatewayDiscoverHandler, gatewayPayload, gatewaySaveHandler } from "./gateways.js";

app.get("/api/persistent-agent-ai-profiles/gateways", async () => {
	const read = readOpenAiCompatibleGateways();
	return {
		gateways: read.gateways.map(gatewayPayload),
		errors: read.errors,
		// A store nobody can read is not an empty one, and the client must not
		// draw it as "no gateways yet".
		unreadable: read.unreadable,
		defaultContextWindow: GATEWAY_DEFAULT_CONTEXT_WINDOW,
		minContextWindow: GATEWAY_MIN_CONTEXT_WINDOW,
		maxContextWindow: GATEWAY_MAX_CONTEXT_WINDOW,
	};
});

app.get("/api/persistent-agent-ai-profiles/gateways/:gatewayId", async (req, reply) => {
	const gatewayId = String((req.params as any).gatewayId ?? "").trim();
	const gateway = findOpenAiCompatibleGateway(gatewayId);
	if (!gateway) return reply.code(404).send({ error: `gateway not found: ${gatewayId}` });
	return { configured: true, ...gatewayPayload(gateway) };
});

app.post("/api/persistent-agent-ai-profiles/gateways/discover", async (req, reply) => gatewayDiscoverHandler(req, reply));

app.post("/api/persistent-agent-ai-profiles/gateways/:gatewayId/discover", async (req, reply) => gatewayDiscoverHandler(req, reply, String((req.params as any).gatewayId ?? "")));

app.post("/api/persistent-agent-ai-profiles/gateways", async (req, reply) => gatewaySaveHandler(req, reply, null));

app.put("/api/persistent-agent-ai-profiles/gateways/:gatewayId", async (req, reply) => gatewaySaveHandler(req, reply, String((req.params as any).gatewayId ?? "")));

app.delete("/api/persistent-agent-ai-profiles/gateways/:gatewayId", async (req, reply) => gatewayDeleteHandler(String((req.params as any).gatewayId ?? "").trim(), reply));

// The single-gateway routes, kept pointing at the first gateway. Anything
// scripted against them still describes the gateway it always described.
app.get("/api/persistent-agent-ai-profiles/openai-compatible", async () => {
	const gateway = findOpenAiCompatibleGateway(OPENAI_COMPATIBLE_AI_PROFILE_ID);
	if (!gateway) return { configured: false };
	const payload = gatewayPayload(gateway);
	return {
		configured: true,
		displayName: payload.label,
		baseUrl: payload.baseUrl,
		roomModels: gateway.roomModels.map((model) => model.modelId),
		maintenanceModel: payload.maintenanceModel,
	};
});

app.post("/api/persistent-agent-ai-profiles/openai-compatible/discover", async (req, reply) => gatewayDiscoverHandler(req, reply, OPENAI_COMPATIBLE_AI_PROFILE_ID));

app.put("/api/persistent-agent-ai-profiles/openai-compatible", async (req, reply) => gatewaySaveHandler(req, reply, OPENAI_COMPATIBLE_AI_PROFILE_ID));

app.delete("/api/persistent-agent-ai-profiles/custom/:profileId", async (req, reply) => {
	const profileId = String((req.params as any).profileId ?? "").trim();
	if (!isCustomAiProfileId(profileId)) return reply.code(400).send({ error: `not a custom profile: ${profileId}` });
	const entry = readCustomAiProfiles().entries.find((candidate) => candidate.id === profileId);
	if (!entry || !deleteCustomAiProfile(profileId)) return reply.code(404).send({ error: `custom profile not found: ${profileId}` });
	// Removing a provider means disconnecting it: drop the stored credential too.
	try {
		AuthStorage.create().logout(entry.providerId);
	} catch {}
	// The explicit choice pointed at this profile: drop it, so the state follows
	// the signed-in provider instead of reporting an unknown profile forever.
	if (readSavedPersistentAgentAiProfileId() === profileId) clearSavedPersistentAgentAiProfileState();
	return buildPersistentAgentAiProfileSelectionStatus();
});

// Remove the OpenAI-compatible gateway: reverses the setup writes (app policy
// file + models.json provider entry) and drops the stored key.
app.delete("/api/persistent-agent-ai-profiles/openai-compatible", async (_req, reply) => gatewayDeleteHandler(OPENAI_COMPATIBLE_AI_PROFILE_ID, reply));
