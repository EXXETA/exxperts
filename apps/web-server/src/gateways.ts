import { AuthStorage } from "@exxeta/exxperts-runtime";
import { saveProviderApiKey } from "./provider-auth.js";
import { OPENAI_COMPATIBLE_AI_PROFILE_ID, OPENAI_COMPATIBLE_PROVIDER_ID } from "./persistent-agent-ai-profiles.js";
import { type GatewayRoomModel, effectiveGatewayModel, type OpenAiCompatibleGateway, parseGatewayContextWindow, parseGatewayDetectedSnapshot, GATEWAY_DEFAULT_CONTEXT_WINDOW, writeOpenAiCompatibleGateway, findOpenAiCompatibleGateway, type GatewayModelDetected, readOpenAiCompatibleGateways, mintGatewayProviderId, GatewayStoreUnreadableError, deleteOpenAiCompatibleGateway } from "./openai-compatible-gateways.js";
import { readGatewayProviderBaseUrl, writeGatewayProviderEntry, removeGatewayProviderEntry, readCatalogProviderIds, ModelCatalogUnreadableError } from "./openai-compatible-gateway-catalog.js";
import { forgetGatewayModelFind } from "./gateway-model-find.js";
import { normalizeGatewayBaseUrl, discoverGatewayModels, isNonChatGatewayMode, GatewayDiscoveryError } from "./openai-compatible-gateway-detect.js";
import { readSavedPersistentAgentAiProfileId, clearSavedPersistentAgentAiProfileState } from "./persistent-agent-ai-profile-state.js";
import { forgetKeyRefusal } from "./model-call-causes.js";
import { providerDisplayNameCache } from "./ai-models.js";
import { buildPersistentAgentAiProfileSelectionStatus } from "./ai-profile-models.js";

// Saved OpenAI-compatible gateways (LiteLLM, vLLM, OpenRouter, company
// proxies), plural: each one is its own AI profile with its own base URL, key
// and approved models, and switches like any other profile. The first gateway
// keeps the profile and provider ids it has always had, so rooms already locked
// to it never notice that the store learned to hold more than one.
function gatewayModelPayload(model: GatewayRoomModel) {
	const effective = effectiveGatewayModel(model);
	return {
		modelId: model.modelId,
		label: model.label ?? model.modelId,
		// The four facts exactly as a room will experience them: override over
		// detection over default, resolved by the same function every other
		// consumer reads, so nothing downstream has to know the halves exist.
		vision: effective.vision,
		webSearch: effective.webSearch,
		reasoning: effective.reasoning,
		contextWindow: effective.contextWindow,
		// Present only when somebody declared one; nothing here means the
		// runtime registry's own default is in charge.
		...(effective.maxTokens ? { maxTokens: effective.maxTokens } : {}),
		// The raw halves, for the form: which fields the person pinned, and what
		// the gateway last declared. Sparse and nullable respectively, so the
		// form can tell "chosen off" from "never spoken about".
		overrides: {
			...(model.vision !== undefined ? { vision: model.vision } : {}),
			...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
			...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
			...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
		},
		detected: {
			vision: model.detected?.vision ?? null,
			webSearch: model.detected?.webSearch ?? null,
			reasoning: model.detected?.reasoning ?? null,
			contextWindow: model.detected?.contextWindow ?? null,
			maxTokens: model.detected?.maxTokens ?? null,
			mode: model.detected?.mode ?? null,
			thinkingLevels: model.detected?.thinkingLevels ?? null,
			effortCeiling: model.detected?.effortCeiling ?? null,
			adaptiveThinking: model.detected?.adaptiveThinking ?? null,
			promptCaching: model.detected?.promptCaching ?? null,
			cost: model.detected?.cost ?? null,
		},
	};
}

function gatewayPayload(gateway: OpenAiCompatibleGateway) {
	return {
		id: gateway.id,
		providerId: gateway.providerId,
		label: gateway.label,
		// Gateways carried over from the legacy policy file never stored a base
		// URL; models.json has been holding it for them all along.
		baseUrl: gateway.baseUrl || readGatewayProviderBaseUrl(gateway.providerId),
		roomModels: gateway.roomModels.map(gatewayModelPayload),
		maintenanceModel: gateway.maintenanceModel,
		isDefault: gateway.id === OPENAI_COMPATIBLE_AI_PROFILE_ID,
	};
}

/** A body value that should be a JSON object, or nothing. */
function gatewayBodyObject(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** A body value that should be a positive safe integer, or nothing. */
function gatewayBodyPositiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * Room models as the approve step sends them. The form sends the sparse shape,
 * per-field overrides plus the gateway's detection snapshot; older clients and
 * scripts send the dense one, and plain string ids are still accepted so
 * anything scripted against the single-gateway route keeps working.
 */
function parseGatewayRoomModels(raw: unknown): { models: GatewayRoomModel[]; error?: string } {
	if (!Array.isArray(raw)) return { models: [] };
	const models: GatewayRoomModel[] = [];
	const seen = new Set<string>();
	for (const entry of raw) {
		const source = typeof entry === "string" ? { modelId: entry } : (entry ?? {}) as Record<string, unknown>;
		const modelId = String(source.modelId ?? "").trim();
		if (!modelId || seen.has(modelId)) continue;
		seen.add(modelId);
		const model: GatewayRoomModel = { modelId };
		const label = String(source.label ?? "").trim();
		if (label && label !== modelId) model.label = label;
		if (source.webSearch === true) model.webSearch = true;
		const overrides = gatewayBodyObject(source.overrides);
		const detected = gatewayBodyObject(source.detected);
		if (overrides || detected) {
			// The form speaks the sparse shape: overrides carry only the fields
			// the person actually set, and the detection snapshot rides along so
			// the store remembers what the gateway said between reloads.
			if (typeof overrides?.vision === "boolean") model.vision = overrides.vision;
			if (typeof overrides?.reasoning === "boolean") model.reasoning = overrides.reasoning;
			// Validated rather than coerced. A window is not a cosmetic field: it
			// decides what the room's context chip reads and when the conversation
			// compacts itself, so a value nobody could have meant is refused out
			// loud instead of being rounded into something plausible.
			const { contextWindow, error } = parseGatewayContextWindow(overrides?.contextWindow);
			if (error) return { models: [], error: `${modelId}: ${error}` };
			// Stored even at the default: pinning 128000 against a detection that
			// says a million is a choice, and dropping it would undo that choice.
			if (contextWindow) model.contextWindow = contextWindow;
			// The cap override has no form field yet, so it only ever arrives from
			// a script; a well-typed positive integer is the whole contract.
			const overrideMaxTokens = gatewayBodyPositiveInteger(overrides?.maxTokens);
			if (overrideMaxTokens) model.maxTokens = overrideMaxTokens;
			model.detected = parseGatewayDetectedSnapshot(detected);
		} else {
			// The dense shape older clients and scripts send: every field stated,
			// nothing known about detection. Everything stated is an override,
			// which is exactly what it always effectively was.
			if (source.vision === true) model.vision = true;
			if (source.reasoning === true) model.reasoning = true;
			const { contextWindow, error } = parseGatewayContextWindow(source.contextWindow);
			if (error) return { models: [], error: `${modelId}: ${error}` };
			// The default is not worth storing: absent and 128000 read back the
			// same for an entry that carries no detection to fall through to.
			if (contextWindow && contextWindow !== GATEWAY_DEFAULT_CONTEXT_WINDOW) model.contextWindow = contextWindow;
		}
		models.push(model);
	}
	return { models };
}

/**
 * A gateway's name is cached per provider id for the label lookups that run on
 * every model row; renaming one is a routine edit now, so the cache entry goes
 * the moment its gateway is saved or removed rather than at the next restart.
 */
function forgetGatewayProviderLabel(providerId: string): void {
	providerDisplayNameCache.delete(providerId);
}

/**
 * Write order carries the failure story.
 *
 * The runtime catalog has to know a provider before a key can be filed under
 * it, so the catalog entry always goes first. For a gateway that did not exist
 * a moment ago, a key that cannot be stored means the whole thing is rolled
 * back: half a gateway, registered but keyless and invisible in the store, is
 * worse than no gateway, and it would leave the client retrying into a second
 * gateway with the same name. For a gateway that already exists the model
 * changes are kept and the key failure is reported on its own, because the
 * gateway had a working key before this save and still does.
 */
function saveGatewayEverywhere(gateway: OpenAiCompatibleGateway, key: string, isNew: boolean): void {
	writeGatewayProviderEntry(gateway);
	if (isNew && key) {
		try {
			saveProviderApiKey(gateway.providerId, key);
		} catch (e) {
			try {
				removeGatewayProviderEntry(gateway.providerId);
			} catch {
				// The rollback is best effort; the store write below never happened,
				// so nothing is offered to the user either way.
			}
			throw e;
		}
	}
	writeOpenAiCompatibleGateway(gateway);
	if (!isNew && key) saveProviderApiKey(gateway.providerId, key);
	if (key) forgetKeyRefusal(gateway.providerId);
	forgetGatewayProviderLabel(gateway.providerId);
	forgetGatewayModelFind(gateway.providerId);
}

/** The code a refusal carries when a new address needs its own key: the edit form says it at the key field. */
const GATEWAY_KEY_FOR_NEW_ADDRESS = "gateway_key_for_new_address";

/**
 * Whether two gateway addresses name the same server: scheme, host and port,
 * nothing else. The path is deliberately not part of it, because correcting
 * /v1 to / on the edit form is the ordinary reason to re-probe a saved
 * gateway. Anything that does not parse as a URL is nobody's server.
 */
function sameGatewayOrigin(a: string, b: string): boolean {
	try {
		return new URL(a).origin === new URL(b).origin;
	} catch {
		return false;
	}
}

async function gatewayDiscoverHandler(req: any, reply: any, gatewayIdFromRoute = "") {
	const body = (req.body ?? {}) as any;
	const gatewayId = (gatewayIdFromRoute || String((req.params as any)?.gatewayId ?? body.gatewayId ?? "")).trim();
	const gateway = gatewayId ? findOpenAiCompatibleGateway(gatewayId) : undefined;
	const storedBaseUrl = gateway ? normalizeGatewayBaseUrl(gateway.baseUrl || readGatewayProviderBaseUrl(gateway.providerId)) : "";
	const baseUrl = normalizeGatewayBaseUrl(String(body.baseUrl ?? "").trim() || storedBaseUrl);
	if (!/^https?:\/\//.test(baseUrl)) return reply.code(400).send({ error: "baseUrl must start with http:// or https://" });
	let key = typeof body.key === "string" ? body.key.trim() : "";
	// Editing an already-connected gateway means the person should not have to
	// retype a key the machine already has. That courtesy stops at the server
	// the key belongs to: a probe of some other address with no key of its own
	// would otherwise carry the stored secret to whoever answers there, and the
	// bearer header is readable by any host that receives it. A different origin
	// gets asked for its key like any new gateway would be.
	if (!key && gateway) {
		if (!sameGatewayOrigin(baseUrl, storedBaseUrl)) {
			return reply.code(400).send({ error: "Enter the gateway API key to load models from a new address.", code: GATEWAY_KEY_FOR_NEW_ADDRESS });
		}
		key = (await AuthStorage.create().getApiKey(gateway.providerId)) ?? "";
	}
	if (!key) return reply.code(400).send({ error: "Enter the gateway API key to load its models." });
	try {
		const discovery = await discoverGatewayModels(baseUrl, key);
		// A model whose declared mode is a known non-chat value (an embedding or
		// image model) never enters the approvable list: a room locked to one has
		// zero working turns. Only a KNOWN non-chat declaration excludes; absent
		// and unknown modes stay in. The detection list still carries every row,
		// so a model somebody already saved that the gateway now calls non-chat
		// keeps its row and learns why it is broken instead of being dropped
		// behind their back.
		const excludedNonChat = discovery.models.filter((model) => isNonChatGatewayMode(model.mode));
		return {
			// The bare id list the single-gateway route always returned, kept so
			// nothing that reads `models` has to change.
			models: discovery.models.filter((model) => !isNonChatGatewayMode(model.mode)).map((model) => model.id),
			detected: discovery.models.map((model) => ({
				id: model.id,
				vision: model.vision ?? null,
				webSearch: model.webSearch ?? null,
				reasoning: model.reasoning ?? null,
				contextWindow: model.contextWindow ?? null,
				maxTokens: model.maxTokens ?? null,
				mode: model.mode ?? null,
				thinkingLevels: model.thinkingLevels ?? null,
				effortCeiling: model.effortCeiling ?? null,
				adaptiveThinking: model.adaptiveThinking ?? null,
				promptCaching: model.promptCaching ?? null,
				cost: model.cost ?? null,
			})),
			excludedNonChat: excludedNonChat.map((model) => ({ id: model.id, mode: model.mode ?? "" })),
		};
	} catch (e) {
		if (e instanceof GatewayDiscoveryError) return reply.code(502).send({ error: e.message });
		return reply.code(502).send({ error: `Could not load models from ${baseUrl}: ${(e as Error).message}` });
	}
}

/** Create or update one gateway. `gatewayId` is empty when a new one is being added. */
async function gatewaySaveHandler(req: any, reply: any, gatewayIdFromRoute: string | null) {
	const body = (req.body ?? {}) as any;
	const label = String(body.label ?? body.displayName ?? "").trim();
	const submittedBaseUrl = String(body.baseUrl ?? "").trim();
	const { models: roomModels, error: roomModelsError } = parseGatewayRoomModels(body.roomModels);
	if (roomModelsError) return reply.code(400).send({ error: roomModelsError });
	const maintenanceModel = String(body.maintenanceModel ?? "").trim() || roomModels[0]?.modelId || "";
	const key = typeof body.key === "string" ? body.key.trim() : "";
	if (roomModels.length === 0) return reply.code(400).send({ error: "at least one room model id is required" });
	if (submittedBaseUrl && !/^https?:\/\//.test(submittedBaseUrl)) return reply.code(400).send({ error: "baseUrl must start with http:// or https://" });

	const gatewayId = gatewayIdFromRoute?.trim() || "";
	const existing = gatewayId ? findOpenAiCompatibleGateway(gatewayId) : undefined;
	if (gatewayId && !existing && gatewayId !== OPENAI_COMPATIBLE_AI_PROFILE_ID) {
		return reply.code(404).send({ error: `gateway not found: ${gatewayId}` });
	}
	// Approve-models edits the model set and nothing else, so it sends no base
	// URL. Demanding one there would refuse the save over a field that screen
	// does not even show; the address the gateway already has is the answer.
	const knownBaseUrl = existing ? existing.baseUrl || readGatewayProviderBaseUrl(existing.providerId) : "";
	const baseUrl = submittedBaseUrl || knownBaseUrl;
	if (!existing && !baseUrl) return reply.code(400).send({ error: "baseUrl is required" });
	// The stored key belongs to the server it was entered for, as in discovery:
	// a save that moves the gateway to another server needs that server's key,
	// or the next calls would carry the stored one there.
	if (existing && !key && submittedBaseUrl && !sameGatewayOrigin(normalizeGatewayBaseUrl(submittedBaseUrl), normalizeGatewayBaseUrl(knownBaseUrl))) {
		return reply.code(400).send({ error: "Enter the gateway API key to save a new address.", code: GATEWAY_KEY_FOR_NEW_ADDRESS });
	}

	// The maintenance model is usually also a room model, and then its own row's
	// snapshot speaks for it in the catalog. When it is not, whatever detection
	// the client sent for it is kept on the config, so Memorize and Review are
	// not registered blind; an edit that keeps the same maintenance model keeps
	// the detection it already had.
	let maintenanceModelDetected: GatewayModelDetected | undefined;
	if (maintenanceModel && !roomModels.some((model) => model.modelId === maintenanceModel)) {
		const submitted = gatewayBodyObject(body.maintenanceModelDetected);
		if (submitted) {
			const snapshot = parseGatewayDetectedSnapshot(submitted);
			if (Object.keys(snapshot).length > 0) maintenanceModelDetected = snapshot;
		} else if (existing && existing.maintenanceModel === maintenanceModel) {
			maintenanceModelDetected = existing.maintenanceModelDetected;
		}
	}

	let gateway: OpenAiCompatibleGateway;
	if (existing) {
		// Ids never move under an existing gateway: every room thread locked to
		// it stores the provider id, and renaming it would strand them all.
		gateway = { ...existing, label: label || existing.label, ...(baseUrl ? { baseUrl } : {}), roomModels, maintenanceModel };
	} else if (gatewayId === OPENAI_COMPATIBLE_AI_PROFILE_ID) {
		gateway = { id: OPENAI_COMPATIBLE_AI_PROFILE_ID, providerId: OPENAI_COMPATIBLE_PROVIDER_ID, label: label || "OpenAI-compatible gateway", baseUrl, roomModels, maintenanceModel };
	} else {
		let providerId: string;
		try {
			// Everything already spoken for: provider keys straight out of
			// models.json (a provider configured with no models yet is invisible
			// to the registry but very much taken), every saved gateway, and every
			// id a deletion retired.
			const read = readOpenAiCompatibleGateways();
			const takenProviderIds = new Set<string>(readCatalogProviderIds());
			for (const candidate of read.gateways) takenProviderIds.add(candidate.providerId);
			for (const retired of read.retiredProviderIds) takenProviderIds.add(retired);
			providerId = mintGatewayProviderId(label || "gateway", takenProviderIds);
		} catch (e) {
			return reply.code(400).send({ error: (e as Error).message });
		}
		gateway = { id: providerId, providerId, label: label || providerId, baseUrl, roomModels, maintenanceModel };
	}
	// Set fresh on every save: the spread of an existing gateway above may carry
	// a stale snapshot for a maintenance model this save just changed.
	delete gateway.maintenanceModelDetected;
	if (maintenanceModelDetected) gateway.maintenanceModelDetected = maintenanceModelDetected;
	try {
		saveGatewayEverywhere(gateway, key, !existing);
	} catch (e) {
		const status = e instanceof ModelCatalogUnreadableError || e instanceof GatewayStoreUnreadableError ? 500 : 400;
		// The id travels with the failure so a client that retries edits the
		// gateway it just made instead of minting a second one beside it.
		return reply.code(status).send({ error: (e as Error).message, gateway: findOpenAiCompatibleGateway(gateway.id) ? gatewayPayload(gateway) : null });
	}
	return { ...buildPersistentAgentAiProfileSelectionStatus(), gateway: gatewayPayload(gateway) };
}

/**
 * Removal order is the reverse of the save's, for the same reason: the store
 * entry is what makes the gateway exist, so it goes LAST. A catalog write that
 * fails halfway through therefore leaves a gateway that is still listed and can
 * simply be deleted again, instead of a vanished gateway whose provider entry
 * and key nothing can reach any more.
 */
function gatewayDeleteHandler(gatewayId: string, reply: any) {
	const gateway = findOpenAiCompatibleGateway(gatewayId);
	if (!gateway) return reply.code(404).send({ error: `gateway not found: ${gatewayId}` });
	try {
		removeGatewayProviderEntry(gateway.providerId);
	} catch (e) {
		return reply.code(500).send({ error: `Could not remove the gateway from the model catalog: ${(e as Error).message}` });
	}
	try {
		AuthStorage.create().logout(gateway.providerId);
	} catch {
		// No stored credential to drop; the gateway goes either way.
	}
	try {
		deleteOpenAiCompatibleGateway(gatewayId);
	} catch (e) {
		return reply.code(500).send({ error: (e as Error).message });
	}
	forgetGatewayProviderLabel(gateway.providerId);
	forgetKeyRefusal(gateway.providerId);
	forgetGatewayModelFind(gateway.providerId);
	// The explicit choice pointed at this gateway: drop it, so the state follows
	// the signed-in provider instead of reporting an unknown profile forever.
	if (readSavedPersistentAgentAiProfileId() === gatewayId) clearSavedPersistentAgentAiProfileState();
	return buildPersistentAgentAiProfileSelectionStatus();
}

export { gatewayDeleteHandler, gatewayDiscoverHandler, gatewayPayload, gatewaySaveHandler, saveGatewayEverywhere };
