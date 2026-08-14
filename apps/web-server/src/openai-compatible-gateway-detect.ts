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

export type GatewayModelDetection = {
	id: string;
	/** Present only when the gateway actually said so. */
	vision?: boolean;
	/** Present only when the gateway actually said so. */
	webSearch?: boolean;
	/** Present only when the gateway published a window. */
	contextWindow?: number;
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
 */
function detectionFromModelsRow(row: Record<string, unknown>): { vision?: boolean; contextWindow?: number } {
	const detection: { vision?: boolean; contextWindow?: number } = {};
	const architecture = isObject(row.architecture) ? row.architecture : undefined;
	if (architecture) {
		const inputModalities = architecture.input_modalities;
		if (Array.isArray(inputModalities)) {
			detection.vision = inputModalities.some((value) => value === "image");
		} else if (typeof architecture.modality === "string") {
			detection.vision = architecture.modality.split("->")[0].split("+").includes("image");
		}
	}
	const contextWindow = positiveInteger(row.context_length)
		?? positiveInteger(isObject(row.top_provider) ? row.top_provider.context_length : undefined)
		?? positiveInteger(row.max_input_tokens);
	if (contextWindow) detection.contextWindow = contextWindow;
	return detection;
}

/**
 * LiteLLM's richer endpoint, keyed by the model name the /models list also
 * uses. max_input_tokens is the context window; max_tokens is LiteLLM's older
 * name for the same number, used only when the newer key is absent.
 */
function detectionsFromLiteLlmModelInfo(payload: unknown): Map<string, { vision?: boolean; webSearch?: boolean; contextWindow?: number }> {
	const byModel = new Map<string, { vision?: boolean; webSearch?: boolean; contextWindow?: number }>();
	const rows = isObject(payload) && Array.isArray(payload.data) ? payload.data : Array.isArray(payload) ? payload : [];
	for (const row of rows) {
		if (!isObject(row)) continue;
		const modelName = typeof row.model_name === "string" ? row.model_name.trim() : "";
		if (!modelName) continue;
		const info = isObject(row.model_info) ? row.model_info : {};
		const detection: { vision?: boolean; webSearch?: boolean; contextWindow?: number } = {};
		if (typeof info.supports_vision === "boolean") detection.vision = info.supports_vision;
		if (typeof info.supports_web_search === "boolean") detection.webSearch = info.supports_web_search;
		const contextWindow = positiveInteger(info.max_input_tokens) ?? positiveInteger(info.max_tokens);
		if (contextWindow) detection.contextWindow = contextWindow;
		if (detection.vision !== undefined || detection.webSearch !== undefined || detection.contextWindow !== undefined) byModel.set(modelName, detection);
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
			if (detection.contextWindow !== undefined) existing.contextWindow = detection.contextWindow;
		}
	}

	return { models: [...detections.values()].sort((a, b) => a.id.localeCompare(b.id)) };
}
