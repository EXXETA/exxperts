/**
 * What a gateway is willing to say about its own models.
 *
 * The plain OpenAI /models list is only a list of names: nothing in it says
 * whether a model can look at an image or how much context it has. Some
 * gateways do publish that, in three shapes we know:
 *   - LiteLLM answers GET <baseUrl>/model/info with per-model supports_vision
 *     and token limits,
 *   - LiteLLM ALSO enriches its ordinary /models rows with max_input_tokens
 *     and max_output_tokens,
 *   - OpenRouter puts architecture/modality and context_length straight into
 *     the /models rows.
 *
 * The second of those exists because the first is not always reachable. A
 * restricted LiteLLM virtual key is commonly scoped to the llm_api_routes
 * group, and /model/info is not in it: the gateway answers 403 and tells you
 * so. That is a correctly configured company gateway, not a broken one, and it
 * was already declaring the window on the row we had in our hands. Reading it
 * there is the difference between a million-token model arriving as a million
 * tokens and arriving as the 128k default.
 *
 * Precedence follows how specific the source is: /model/info describes the
 * deployment and wins outright; within a /models row, OpenRouter's own fields
 * come first and max_input_tokens after. Nothing infers vision from the
 * LiteLLM row shape, which carries no such field, so an unprobeable gateway
 * leaves the image question to the person, which is where it belongs.
 *
 * Every probe is best effort. A gateway that says nothing, times out, or
 * answers 403 or 404 is not an error and not a lesser gateway: the form simply
 * opens on the defaults and the person fills it in. Detection pre-fills the
 * form; the person saving it is the authority.
 */

const PROBE_TIMEOUT_MS = 10_000;
// A model list is a few hundred kilobytes at the very worst. The cap is not
// about typical gateways, it is about not letting an endpoint that answers with
// an endless stream fill this process's memory while we wait for the timeout.
const PROBE_MAX_BYTES = 5 * 1024 * 1024;

import { GATEWAY_EFFORT_INTENSITIES, type GatewayEffortIntensity, type GatewayThinkingLevel, type GatewayThinkingLevels } from "./openai-compatible-gateways.js";

export type GatewayModelDetection = {
	id: string;
	/** Present only when the gateway actually said so. */
	vision?: boolean;
	/** Present only when the gateway actually said so. */
	webSearch?: boolean;
	/** Present only when the gateway actually said so. */
	reasoning?: boolean;
	/** Present only when the gateway published a window. */
	contextWindow?: number;
	/** Present only when the gateway published a per-request output cap. */
	maxTokens?: number;
	/** The gateway's declared mode (chat, embedding, image_generation, ...), lowercased. Present only when declared. */
	mode?: string;
	/** Per-rung effort declarations; a rung appears only when the gateway answered it with a boolean. */
	thinkingLevels?: GatewayThinkingLevels;
	/** Present only when the gateway named the hardest thinking the deployment lets through. */
	effortCeiling?: GatewayEffortIntensity;
	/** Present only when the gateway said whether the model picks its own effort. */
	adaptiveThinking?: boolean;
};

export type GatewayDiscovery = {
	models: GatewayModelDetection[];
};

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	const rounded = Math.floor(value);
	return rounded > 0 ? rounded : undefined;
}

/**
 * LiteLLM modes that name a model no chat completion can run on. A room locked
 * to one of these has zero working turns, which is why the discover step keeps
 * them out of the approvable list. Absent and unknown modes stay
 * chat-compatible: dropping a model over a word we do not know would hide
 * models that work.
 */
export const NON_CHAT_GATEWAY_MODES = ["embedding", "image_generation", "audio_transcription", "audio_speech", "rerank", "moderation"] as const;

export function isNonChatGatewayMode(mode: string | null | undefined): boolean {
	return typeof mode === "string" && (NON_CHAT_GATEWAY_MODES as readonly string[]).includes(mode);
}

/** Read the body with a hard ceiling, giving up the moment the cap is passed. */
async function readCappedText(response: Response): Promise<string> {
	if (!response.body) return await response.text();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			size += value.byteLength;
			if (size > PROBE_MAX_BYTES) throw new Error(`response is larger than ${Math.round(PROBE_MAX_BYTES / (1024 * 1024))}MB`);
			chunks.push(value);
		}
	} finally {
		try {
			await reader.cancel();
		} catch {
			// The stream is already finished or already torn down.
		}
	}
	return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf-8");
}

async function fetchJsonWithTimeout(url: string, key: string): Promise<{ ok: true; payload: unknown } | { ok: false; status?: number; message: string; timedOut: boolean }> {
	const abort = new AbortController();
	const timeout = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS);
	try {
		const response = await fetch(url, { headers: { authorization: `Bearer ${key}` }, signal: abort.signal });
		if (!response.ok) return { ok: false, status: response.status, message: `answered ${response.status}`, timedOut: false };
		return { ok: true, payload: JSON.parse(await readCappedText(response)) as unknown };
	} catch (error) {
		return { ok: false, message: abort.signal.aborted ? "timed out" : (error as Error).message, timedOut: abort.signal.aborted };
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * The gateway root the probes hang paths off. A base URL that arrived with a
 * query string or a fragment would otherwise produce "…/v1?x=1/models", which
 * is not a URL anybody's gateway serves, and the failure would read as the
 * gateway's fault rather than the input's.
 */
export function normalizeGatewayBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim();
	try {
		const parsed = new URL(trimmed);
		parsed.search = "";
		parsed.hash = "";
		return parsed.toString().replace(/\/+$/, "");
	} catch {
		return trimmed.replace(/[?#].*$/, "").replace(/\/+$/, "");
	}
}

/**
 * What an ordinary /models row is willing to say for itself.
 *
 * Two dialects share this one payload. OpenRouter's is the richer of them:
 * older payloads spell the modality as a single "text+image->text" string,
 * newer ones as an input_modalities array, and both carry a context_length.
 * LiteLLM's is plainer, a max_input_tokens beside the id and nothing about
 * images, and it is the only thing a key that cannot reach /model/info will
 * ever get to see.
 *
 * OpenRouter's context_length comes first because a gateway that speaks that
 * dialect is describing the model itself; max_input_tokens answers only when
 * it has not already been answered. Vision is never inferred here from the
 * LiteLLM shape, which does not carry it: silence about images stays silence,
 * and so does silence about web search, which only /model/info ever mentions.
 *
 * Reasoning is the one fact the OpenRouter row does answer for itself, in its
 * supported_parameters list: a model that accepts a reasoning parameter is a
 * model the room's effort dial can reach. A row without that list says nothing
 * about reasoning, which is not the same as saying no.
 */
function detectionFromModelsRow(row: Record<string, unknown>): { vision?: boolean; reasoning?: boolean; contextWindow?: number; maxTokens?: number } {
	const detection: { vision?: boolean; reasoning?: boolean; contextWindow?: number; maxTokens?: number } = {};
	const architecture = isObject(row.architecture) ? row.architecture : undefined;
	if (architecture) {
		const inputModalities = architecture.input_modalities;
		if (Array.isArray(inputModalities)) {
			detection.vision = inputModalities.some((value) => value === "image");
		} else if (typeof architecture.modality === "string") {
			detection.vision = architecture.modality.split("->")[0].split("+").includes("image");
		}
	}
	const supportedParameters = row.supported_parameters;
	if (Array.isArray(supportedParameters)) {
		detection.reasoning = supportedParameters.some((value) => value === "reasoning" || value === "include_reasoning");
	}
	const contextWindow = positiveInteger(row.context_length)
		?? positiveInteger(isObject(row.top_provider) ? row.top_provider.context_length : undefined)
		?? positiveInteger(row.max_input_tokens);
	if (contextWindow) detection.contextWindow = contextWindow;
	// The per-request output cap, the same two dialects again: OpenRouter's
	// top_provider speaks for the deployment that will actually answer, and
	// LiteLLM enriches its rows with max_output_tokens for the keys that cannot
	// reach /model/info. Discarding it is what ran every gateway model on the
	// registry's 16384 default.
	const maxTokens = positiveInteger(isObject(row.top_provider) ? row.top_provider.max_completion_tokens : undefined)
		?? positiveInteger(row.max_output_tokens);
	if (maxTokens) detection.maxTokens = maxTokens;
	return detection;
}

/**
 * LiteLLM's per-rung effort flags, one boolean question per level of the
 * thinking dial. Our "off" is LiteLLM's "none". Every key here was seen live
 * on a real LiteLLM /model/info answer except the medium and high pair, which
 * follow the same supports_<level>_reasoning_effort naming and are read so a
 * gateway that does answer them is heard; a gateway that leaves them null is
 * simply not answering, like every other level.
 */
const LITELLM_EFFORT_FLAGS: ReadonlyArray<readonly [string, GatewayThinkingLevel]> = [
	["supports_none_reasoning_effort", "off"],
	["supports_minimal_reasoning_effort", "minimal"],
	["supports_low_reasoning_effort", "low"],
	["supports_medium_reasoning_effort", "medium"],
	["supports_high_reasoning_effort", "high"],
	["supports_xhigh_reasoning_effort", "xhigh"],
	["supports_max_reasoning_effort", "max"],
];

/**
 * LiteLLM's richer endpoint, keyed by the model name the /models list also
 * uses. max_input_tokens is the context window; max_tokens is LiteLLM's older
 * name for the same number, used only when the newer key is absent.
 *
 * The per-level effort flags are typed nullable on LiteLLM's side and are null
 * on most deployments; only a real boolean is a declaration. This endpoint is
 * the only place these levels are ever declared: OpenRouter's /models rows say
 * whether a model takes a reasoning parameter at all (supported_parameters),
 * but nothing per level, so nothing per level is invented for them.
 */
function detectionsFromLiteLlmModelInfo(payload: unknown): Map<string, Omit<GatewayModelDetection, "id">> {
	const byModel = new Map<string, Omit<GatewayModelDetection, "id">>();
	const rows = isObject(payload) && Array.isArray(payload.data) ? payload.data : Array.isArray(payload) ? payload : [];
	for (const row of rows) {
		if (!isObject(row)) continue;
		const modelName = typeof row.model_name === "string" ? row.model_name.trim() : "";
		if (!modelName) continue;
		const info = isObject(row.model_info) ? row.model_info : {};
		const detection: Omit<GatewayModelDetection, "id"> = {};
		if (typeof info.supports_vision === "boolean") detection.vision = info.supports_vision;
		if (typeof info.supports_web_search === "boolean") detection.webSearch = info.supports_web_search;
		if (typeof info.supports_reasoning === "boolean") detection.reasoning = info.supports_reasoning;
		const contextWindow = positiveInteger(info.max_input_tokens) ?? positiveInteger(info.max_tokens);
		if (contextWindow) detection.contextWindow = contextWindow;
		const maxTokens = positiveInteger(info.max_output_tokens);
		if (maxTokens) detection.maxTokens = maxTokens;
		// The declared mode, lowercased so the known non-chat values match however
		// a deployment cases them. Absent stays absent: an undeclared model is not
		// dropped over silence.
		if (typeof info.mode === "string" && info.mode.trim()) detection.mode = info.mode.trim().toLowerCase();
		const levels: GatewayThinkingLevels = {};
		for (const [flag, level] of LITELLM_EFFORT_FLAGS) {
			const value = info[flag];
			if (typeof value === "boolean") levels[level] = value;
		}
		if (Object.keys(levels).length > 0) detection.thinkingLevels = levels;
		// The deployment's own cap, seen live contradicting the flags on the same
		// row (supports_max true beside an xhigh ceiling). Recorded so the ladder
		// can be capped by it; only a known intensity is a cap.
		if (typeof info.bedrock_output_config_effort_ceiling === "string" && (GATEWAY_EFFORT_INTENSITIES as readonly string[]).includes(info.bedrock_output_config_effort_ceiling)) {
			detection.effortCeiling = info.bedrock_output_config_effort_ceiling as GatewayEffortIntensity;
		}
		if (typeof info.supports_adaptive_thinking === "boolean") detection.adaptiveThinking = info.supports_adaptive_thinking;
		if (Object.keys(detection).length > 0) byModel.set(modelName, detection);
	}
	return byModel;
}

export class GatewayDiscoveryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GatewayDiscoveryError";
	}
}

/**
 * The model list a gateway routes, with whatever capability facts it publishes.
 * The /models call is the one that may fail out loud, because without it there
 * is nothing to approve; the capability probe never fails the request.
 */
export async function discoverGatewayModels(baseUrl: string, key: string): Promise<GatewayDiscovery> {
	const root = normalizeGatewayBaseUrl(baseUrl);
	const listed = await fetchJsonWithTimeout(`${root}/models`, key);
	if (!listed.ok) {
		if (listed.status === 401 || listed.status === 403) throw new GatewayDiscoveryError("The gateway rejected the API key.");
		if (listed.status !== undefined) throw new GatewayDiscoveryError(`The gateway answered ${listed.status} for ${root}/models.`);
		throw new GatewayDiscoveryError(`Could not reach ${root}/models: ${listed.message}`);
	}
	const payload = listed.payload;
	const rows = isObject(payload) && Array.isArray(payload.data) ? payload.data : Array.isArray(payload) ? payload : null;
	if (!rows) throw new GatewayDiscoveryError("The gateway response is not an OpenAI-style model list; check the base URL.");

	const detections = new Map<string, GatewayModelDetection>();
	for (const row of rows) {
		if (!isObject(row)) continue;
		const id = typeof row.id === "string" ? row.id.trim() : "";
		if (!id || detections.has(id)) continue;
		detections.set(id, { id, ...detectionFromModelsRow(row) });
	}
	if (detections.size === 0) throw new GatewayDiscoveryError("The gateway lists no models for this key.");

	const info = await fetchJsonWithTimeout(`${root}/model/info`, key);
	if (info.ok) {
		// LiteLLM is the more specific source: it answers about the deployment
		// behind the alias, not about a catalog entry, so it overrides.
		for (const [modelName, detection] of detectionsFromLiteLlmModelInfo(info.payload)) {
			const existing = detections.get(modelName);
			if (!existing) continue;
			if (detection.vision !== undefined) existing.vision = detection.vision;
			if (detection.webSearch !== undefined) existing.webSearch = detection.webSearch;
			if (detection.reasoning !== undefined) existing.reasoning = detection.reasoning;
			if (detection.contextWindow !== undefined) existing.contextWindow = detection.contextWindow;
			if (detection.maxTokens !== undefined) existing.maxTokens = detection.maxTokens;
			if (detection.mode !== undefined) existing.mode = detection.mode;
			if (detection.thinkingLevels !== undefined) existing.thinkingLevels = detection.thinkingLevels;
			if (detection.effortCeiling !== undefined) existing.effortCeiling = detection.effortCeiling;
			if (detection.adaptiveThinking !== undefined) existing.adaptiveThinking = detection.adaptiveThinking;
		}
	}

	return { models: [...detections.values()].sort((a, b) => a.id.localeCompare(b.id)) };
}
