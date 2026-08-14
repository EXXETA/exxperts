import fs from "node:fs";
import path from "node:path";
import { productAppStatePath } from "../../../pi-package/product-state-paths.js";

/**
 * Saved OpenAI-compatible gateways (LiteLLM, vLLM, OpenRouter, company
 * proxies), plural.
 *
 * The app used to know exactly one gateway, and its identity was the literal
 * string "openai-compatible" in four places at once: the profile id, the
 * provider id in models.json, the auth.json key, and the {provider, model} lock
 * every room thread stores. Because that lock is validated against the active
 * profile forever, the FIRST gateway must keep both ids exactly as they are.
 * Second and further gateways get freshly minted ids instead, so no existing
 * room, checkpoint or scheduled run is ever stranded.
 *
 * Two files can describe the first gateway:
 *   - the legacy single-gateway policy file, still written by the terminal
 *     setup wizard and by older versions of this app, and
 *   - this plural store, which additionally carries the base URL and the
 *     per-model image/context facts.
 *
 * For the FIRST gateway the legacy file is authoritative on read whenever it
 * exists, and the store's entry for it is the fallback for when it does not.
 * That direction is deliberate and was got wrong once: making the store win
 * meant that the moment anything materialised the first gateway into it, the
 * terminal wizard could still write the legacy file and the app would never
 * look at it again. Since every save from the app writes BOTH files, app edits
 * stay visible either way, and wizard edits become visible again. The one thing
 * the store still supplies for the first gateway is the base URL, which the
 * wizard's file shape has no field for.
 *
 * A file that is missing and a file that cannot be read are different answers
 * and are kept different. Missing means "no gateways here". Unreadable means
 * "the gateways are there and I cannot see them", which must never be rounded
 * down to an empty list: writing that list back would delete every gateway the
 * file still holds, orphan their models.json entries and keys, and strand their
 * rooms. Unreadable therefore surfaces as an error and refuses every write
 * until the file parses again.
 */

export const OPENAI_COMPATIBLE_AI_PROFILE_ID = "openai-compatible";
export const OPENAI_COMPATIBLE_PROVIDER_ID = "openai-compatible";
export const OPENAI_COMPATIBLE_AI_PROFILE_FILE = productAppStatePath("openai-compatible-ai-profile.json");
export const OPENAI_COMPATIBLE_GATEWAYS_FILE = productAppStatePath("openai-compatible-gateways.json");
const GATEWAYS_VERSION = 1;
export const GATEWAY_PROVIDER_ID_PREFIX = "gateway-";
/** What the runtime assumes when a model declares no window of its own. */
export const GATEWAY_DEFAULT_CONTEXT_WINDOW = 128000;
/**
 * Bounds for a hand-entered context window. The number decides what the room's
 * context chip reads and when auto-compaction fires, so a typo has consequences
 * a person would not connect back to a form field: too small and the room
 * compacts itself constantly, too large and the chip sits near zero while the
 * provider rejects every request. These are deliberately wide enough to hold
 * anything a real model claims and narrow enough to catch a slip.
 */
export const GATEWAY_MIN_CONTEXT_WINDOW = 4096;
export const GATEWAY_MAX_CONTEXT_WINDOW = 20000000;

/**
 * A context window as typed. Deliberately stricter than parseInt, which reads
 * "1e9" as 1 and "128000abc" as 128000: only plain digits are a number here.
 */
export function parseGatewayContextWindow(value: unknown): { contextWindow?: number; error?: string } {
	const text = typeof value === "number" ? String(value) : String(value ?? "").trim();
	if (!text) return {};
	if (!/^\d+$/.test(text)) return { error: "Context window must be a whole number of tokens, digits only." };
	const parsed = Number(text);
	if (!Number.isSafeInteger(parsed) || parsed < GATEWAY_MIN_CONTEXT_WINDOW || parsed > GATEWAY_MAX_CONTEXT_WINDOW) {
		return { error: `Context window must be between ${GATEWAY_MIN_CONTEXT_WINDOW} and ${GATEWAY_MAX_CONTEXT_WINDOW} tokens.` };
	}
	return { contextWindow: parsed };
}

export type GatewayRoomModel = {
	modelId: string;
	label?: string;
	/** The person ticked "supports images"; written to models.json as input: ["text","image"]. */
	vision?: boolean;
	/** The person ticked "supports web search"; written to models.json as compat.supportsWebSearch, which is what makes the request ask the gateway to search. */
	webSearch?: boolean;
	/** Token window for this model. Absent means the runtime default applies. */
	contextWindow?: number;
};

export type OpenAiCompatibleGateway = {
	/** Doubles as the AI profile id. */
	id: string;
	/** Doubles as the models.json provider key and the auth.json key. */
	providerId: string;
	label: string;
	/** Absent on gateways migrated from the legacy file, which never stored it. */
	baseUrl?: string;
	roomModels: GatewayRoomModel[];
	maintenanceModel: string;
};

export type OpenAiCompatibleGatewaysReadResult = {
	gateways: OpenAiCompatibleGateway[];
	/**
	 * Provider ids that belonged to a gateway somebody removed. Never minted
	 * again: a new gateway that happened to be given the same name would take
	 * the retired id, and every room lock and stale profile selection still
	 * pointing at it would quietly re-attach to a different endpoint.
	 */
	retiredProviderIds: string[];
	errors: string[];
	/**
	 * The store file exists but could not be read. The gateway list is therefore
	 * incomplete, and writing it back would destroy whatever it still holds, so
	 * every write refuses while this is true.
	 */
	unreadable: boolean;
	path: string;
};

export type GatewayFilePaths = {
	gatewaysPath?: string;
	legacyPolicyPath?: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

function positiveInteger(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	const rounded = Math.floor(value);
	return rounded > 0 ? rounded : undefined;
}

/**
 * roomModels entries are objects in both file shapes. Unknown keys are ignored
 * rather than rejected: the legacy file predates vision and contextWindow, and
 * a future key must not make an existing gateway unreadable.
 */
function parseRoomModels(raw: unknown): { models: GatewayRoomModel[]; error?: string } {
	if (!Array.isArray(raw) || raw.length === 0) return { models: [], error: "must include at least one room model." };
	const models: GatewayRoomModel[] = [];
	const seen = new Set<string>();
	for (const [index, entry] of raw.entries()) {
		if (!isObject(entry)) return { models: [], error: `roomModels[${index}] must be a JSON object.` };
		const modelId = nonEmptyString(entry.modelId);
		if (!modelId) return { models: [], error: `roomModels[${index}].modelId is required.` };
		if (seen.has(modelId)) continue;
		seen.add(modelId);
		const model: GatewayRoomModel = { modelId };
		const label = nonEmptyString(entry.label);
		if (label) model.label = label;
		if (entry.vision === true) model.vision = true;
		if (entry.webSearch === true) model.webSearch = true;
		const contextWindow = positiveInteger(entry.contextWindow);
		if (contextWindow) model.contextWindow = contextWindow;
		models.push(model);
	}
	if (models.length === 0) return { models: [], error: "must include at least one room model." };
	return { models };
}

type JsonFileRead =
	| { state: "absent" }
	| { state: "ok"; data: unknown }
	| { state: "unreadable"; message: string };

// Absent and unreadable are different answers, and every caller here has to
// treat them differently, so they are never collapsed into one undefined.
function readJsonFile(filePath: string): JsonFileRead {
	if (!fs.existsSync(filePath)) return { state: "absent" };
	try {
		return { state: "ok", data: JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown };
	} catch (error) {
		return { state: "unreadable", message: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * The first gateway as described by the legacy single-gateway policy file. Both
 * ids are pinned to the literal because that is what every existing room lock
 * says; a file claiming anything else is not this gateway and is refused.
 */
function readLegacyGateway(legacyPolicyPath: string): { gateway?: OpenAiCompatibleGateway; error?: string } {
	const read = readJsonFile(legacyPolicyPath);
	if (read.state === "absent") return {};
	if (read.state === "unreadable") return { error: `OpenAI-compatible gateway policy could not be read: ${read.message}` };
	const raw = read.data;
	if (!isObject(raw)) return { error: "OpenAI-compatible gateway policy must be a JSON object." };
	if (raw.profileId !== OPENAI_COMPATIBLE_AI_PROFILE_ID) return { error: "OpenAI-compatible gateway policy has the wrong profileId." };
	if (raw.providerId !== OPENAI_COMPATIBLE_PROVIDER_ID) return { error: "OpenAI-compatible gateway policy has the wrong providerId." };
	const maintenanceModel = nonEmptyString(raw.maintenanceModel);
	if (!maintenanceModel) return { error: "OpenAI-compatible gateway policy is missing maintenanceModel." };
	const { models, error } = parseRoomModels(raw.roomModels);
	if (error) return { error: `OpenAI-compatible gateway policy ${error}` };
	return {
		gateway: {
			id: OPENAI_COMPATIBLE_AI_PROFILE_ID,
			providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
			label: nonEmptyString(raw.label) ?? "OpenAI-compatible gateway",
			...(nonEmptyString(raw.baseUrl) ? { baseUrl: nonEmptyString(raw.baseUrl) } : {}),
			roomModels: models,
			maintenanceModel,
		},
	};
}

function parseGatewayEntry(raw: unknown, index: number): { gateway?: OpenAiCompatibleGateway; error?: string } {
	if (!isObject(raw)) return { error: `gateways[${index}] must be a JSON object.` };
	const id = nonEmptyString(raw.id);
	if (!id) return { error: `gateways[${index}].id is required.` };
	const providerId = nonEmptyString(raw.providerId);
	if (!providerId) return { error: `gateways[${index}].providerId is required.` };
	// The first gateway's two ids are load-bearing for every room lock ever
	// written; a store that pairs them differently is corrupt, not creative.
	if ((id === OPENAI_COMPATIBLE_AI_PROFILE_ID) !== (providerId === OPENAI_COMPATIBLE_PROVIDER_ID)) {
		return { error: `gateways[${index}] mixes the default gateway id with a different provider id.` };
	}
	const maintenanceModel = nonEmptyString(raw.maintenanceModel);
	if (!maintenanceModel) return { error: `gateways[${index}].maintenanceModel is required.` };
	const { models, error } = parseRoomModels(raw.roomModels);
	if (error) return { error: `gateways[${index}] ${error}` };
	return {
		gateway: {
			id,
			providerId,
			label: nonEmptyString(raw.label) ?? providerId,
			...(nonEmptyString(raw.baseUrl) ? { baseUrl: nonEmptyString(raw.baseUrl) } : {}),
			roomModels: models,
			maintenanceModel,
		},
	};
}

export function readOpenAiCompatibleGateways(paths: GatewayFilePaths = {}): OpenAiCompatibleGatewaysReadResult {
	const gatewaysPath = paths.gatewaysPath ?? OPENAI_COMPATIBLE_GATEWAYS_FILE;
	const legacyPolicyPath = paths.legacyPolicyPath ?? OPENAI_COMPATIBLE_AI_PROFILE_FILE;
	const result: OpenAiCompatibleGatewaysReadResult = { gateways: [], retiredProviderIds: [], errors: [], unreadable: false, path: gatewaysPath };

	const read = readJsonFile(gatewaysPath);
	if (read.state === "unreadable") {
		// The gateways are in there; we simply cannot see them. Saying "no
		// gateways" here is what would turn a bad parse into a deletion.
		result.errors.push(`Saved gateways file could not be read: ${read.message}`);
		result.unreadable = true;
	} else if (read.state === "ok") {
		const raw = read.data;
		if (!isObject(raw) || raw.version !== GATEWAYS_VERSION || !Array.isArray(raw.gateways)) {
			result.errors.push("Saved gateways file has an unsupported format; ignoring it.");
			result.unreadable = true;
		} else {
			const seenIds = new Set<string>();
			const seenProviders = new Set<string>();
			for (const [index, value] of raw.gateways.entries()) {
				const { gateway, error } = parseGatewayEntry(value, index);
				if (!gateway) {
					if (error) result.errors.push(error);
					continue;
				}
				if (seenIds.has(gateway.id) || seenProviders.has(gateway.providerId)) {
					result.errors.push(`gateways[${index}] repeats gateway "${gateway.id}"; keeping the first entry.`);
					continue;
				}
				seenIds.add(gateway.id);
				seenProviders.add(gateway.providerId);
				result.gateways.push(gateway);
			}
			if (Array.isArray(raw.retiredProviderIds)) {
				for (const value of raw.retiredProviderIds) {
					const providerId = nonEmptyString(value);
					if (providerId && !result.retiredProviderIds.includes(providerId)) result.retiredProviderIds.push(providerId);
				}
			}
		}
	}

	// The legacy file is the first gateway's own voice: the terminal wizard
	// still writes it, and the app writes it too on every save of that gateway.
	// So where it exists it decides, and the store entry beneath it survives
	// only as the source of the base URL, which the wizard's shape cannot carry.
	const legacy = readLegacyGateway(legacyPolicyPath);
	const defaultIndex = result.gateways.findIndex((gateway) => gateway.id === OPENAI_COMPATIBLE_AI_PROFILE_ID);
	if (legacy.gateway) {
		const storedDefault = defaultIndex >= 0 ? result.gateways[defaultIndex] : undefined;
		const merged: OpenAiCompatibleGateway = { ...legacy.gateway };
		const baseUrl = legacy.gateway.baseUrl ?? storedDefault?.baseUrl;
		if (baseUrl) merged.baseUrl = baseUrl;
		if (defaultIndex >= 0) result.gateways[defaultIndex] = merged;
		else result.gateways.unshift(merged);
	} else if (legacy.error) {
		// A broken legacy file is worth reporting even when the store can still
		// describe the gateway; it is the file the wizard is about to write to.
		result.errors.push(legacy.error);
	}
	return result;
}

export function findOpenAiCompatibleGateway(gatewayId: string, paths: GatewayFilePaths = {}): OpenAiCompatibleGateway | undefined {
	return readOpenAiCompatibleGateways(paths).gateways.find((gateway) => gateway.id === gatewayId);
}

export function findOpenAiCompatibleGatewayByProvider(providerId: string, paths: GatewayFilePaths = {}): OpenAiCompatibleGateway | undefined {
	return readOpenAiCompatibleGateways(paths).gateways.find((gateway) => gateway.providerId === providerId);
}

export function isOpenAiCompatibleGatewayProvider(providerId: string, paths: GatewayFilePaths = {}): boolean {
	return findOpenAiCompatibleGatewayByProvider(providerId, paths) !== undefined;
}

function writeJsonAtomically(filePath: string, data: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.${process.pid}.tmp`;
	fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, "\t")}\n`, { mode: 0o600 });
	fs.renameSync(tmpPath, filePath);
}

function writeGatewaysFile(gateways: OpenAiCompatibleGateway[], retiredProviderIds: string[], gatewaysPath: string): void {
	writeJsonAtomically(gatewaysPath, { version: GATEWAYS_VERSION, gateways, retiredProviderIds });
}

/**
 * The legacy file is the first gateway's own record, and the app keeps writing
 * it so the terminal wizard and older builds keep reading the same story the
 * app shows. The base URL rides along as an extra key the wizard ignores, which
 * is what lets the legacy file stay authoritative on read without the app
 * losing the one field the wizard's shape has no room for.
 */
function writeLegacyPolicyFile(gateway: OpenAiCompatibleGateway, legacyPolicyPath: string): void {
	writeJsonAtomically(legacyPolicyPath, {
		profileId: OPENAI_COMPATIBLE_AI_PROFILE_ID,
		providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
		label: gateway.label,
		...(gateway.baseUrl ? { baseUrl: gateway.baseUrl } : {}),
		roomModels: gateway.roomModels.map((model) => ({
			modelId: model.modelId,
			label: model.label ?? model.modelId,
			...(model.vision ? { vision: true } : {}),
			...(model.webSearch ? { webSearch: true } : {}),
			...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
		})),
		maintenanceModel: gateway.maintenanceModel,
	});
}

function slugifyGatewayLabel(label: string): string {
	return label
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		// Trimmed again after the slice: cutting a long label can land straight on
		// a separator, and "gateway-my-very-long-name-" is not an id anyone meant.
		.replace(/-+$/g, "");
}

/**
 * A provider id for a gateway the user is adding now. Never the default
 * gateway's id, never one already spoken for, and never one retired by an
 * earlier deletion: each of those would point a still-existing room lock or a
 * stale profile selection at an endpoint it was never written for.
 */
export function mintGatewayProviderId(label: string, takenProviderIds: Iterable<string>): string {
	const taken = new Set(takenProviderIds);
	taken.add(OPENAI_COMPATIBLE_PROVIDER_ID);
	// A label made entirely of punctuation still has to become an id, and every
	// gateway id must keep the prefix so it is recognisable as one on sight.
	const slug = slugifyGatewayLabel(label) || "unnamed";
	const base = `${GATEWAY_PROVIDER_ID_PREFIX}${slug}`;
	if (!taken.has(base)) return base;
	for (let suffix = 2; suffix < 1000; suffix++) {
		const candidate = `${base}-${suffix}`;
		if (!taken.has(candidate)) return candidate;
	}
	throw new Error("could not choose a free gateway provider id");
}

export class GatewayStoreUnreadableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GatewayStoreUnreadableError";
	}
}

// Every write starts from a full, trustworthy read. When the store cannot be
// parsed we do not know what is in it, and writing our partial picture back is
// how a bad parse becomes a permanent deletion.
function readForWrite(paths: GatewayFilePaths): OpenAiCompatibleGatewaysReadResult {
	const read = readOpenAiCompatibleGateways(paths);
	if (read.unreadable) {
		throw new GatewayStoreUnreadableError(
			`${read.errors[0] ?? "Saved gateways file could not be read."} Refusing to write, because saving now would remove every gateway it still holds. Repair or move ${read.path} and try again.`,
		);
	}
	return read;
}

export function writeOpenAiCompatibleGateway(gateway: OpenAiCompatibleGateway, paths: GatewayFilePaths = {}): OpenAiCompatibleGateway {
	const gatewaysPath = paths.gatewaysPath ?? OPENAI_COMPATIBLE_GATEWAYS_FILE;
	const legacyPolicyPath = paths.legacyPolicyPath ?? OPENAI_COMPATIBLE_AI_PROFILE_FILE;
	if (!gateway.id.trim() || !gateway.providerId.trim()) throw new Error("gateway id and providerId are required");
	if (gateway.roomModels.length === 0) throw new Error("at least one room model is required");
	if (!gateway.maintenanceModel.trim()) throw new Error("maintenanceModel is required");

	const read = readForWrite(paths);
	const next: OpenAiCompatibleGateway[] = [];
	let replaced = false;
	for (const candidate of read.gateways) {
		if (candidate.id === gateway.id) {
			next.push(gateway);
			replaced = true;
			continue;
		}
		if (candidate.providerId === gateway.providerId) throw new Error(`another gateway already uses provider "${gateway.providerId}"`);
		next.push(candidate);
	}
	if (!replaced) next.push(gateway);
	// Saving a gateway under a retired id is the one way an id comes back, and
	// only because this is that same gateway being deliberately set up again.
	const retired = read.retiredProviderIds.filter((providerId) => providerId !== gateway.providerId);
	writeGatewaysFile(next, retired, gatewaysPath);
	if (gateway.id === OPENAI_COMPATIBLE_AI_PROFILE_ID) writeLegacyPolicyFile(gateway, legacyPolicyPath);
	return gateway;
}

export function deleteOpenAiCompatibleGateway(gatewayId: string, paths: GatewayFilePaths = {}): OpenAiCompatibleGateway | undefined {
	const gatewaysPath = paths.gatewaysPath ?? OPENAI_COMPATIBLE_GATEWAYS_FILE;
	const legacyPolicyPath = paths.legacyPolicyPath ?? OPENAI_COMPATIBLE_AI_PROFILE_FILE;
	const read = readForWrite(paths);
	const removed = read.gateways.find((gateway) => gateway.id === gatewayId);
	if (!removed) return undefined;
	const retired = read.retiredProviderIds.includes(removed.providerId) ? read.retiredProviderIds : [...read.retiredProviderIds, removed.providerId];
	writeGatewaysFile(read.gateways.filter((gateway) => gateway.id !== gatewayId), retired, gatewaysPath);
	// The legacy file only ever describes the default gateway, so it goes with
	// it and stays put for every other removal.
	if (gatewayId === OPENAI_COMPATIBLE_AI_PROFILE_ID) {
		try {
			fs.rmSync(legacyPolicyPath, { force: true });
		} catch {}
	}
	return removed;
}
