import fs from "node:fs";
import path from "node:path";
import { getModelsPath, stripJsonComments } from "@exxeta/exxperts-runtime";
import { effectiveGatewayModel, GATEWAY_EFFORT_INTENSITIES, type EffectiveGatewayModel, type GatewayEffortIntensity, type GatewayThinkingLevels, type OpenAiCompatibleGateway } from "./openai-compatible-gateways.js";

/**
 * The runtime half of a saved gateway: its entry in models.json, one provider
 * key per gateway.
 *
 * models.json is not ours. It is a hand-editable file that belongs to the
 * person using the app: it holds every provider they have configured, their
 * API-key references, compatibility flags, and it officially supports `//`
 * comments and trailing commas. This module therefore reads it exactly the way
 * the model registry does, and follows two rules that the terminal setup wizard
 * has always followed and the app must not be sloppier about.
 *
 * First, a file that exists but cannot be understood stops the write. Treating
 * an unreadable file as an empty one and renaming a single-provider document
 * over it would delete every other provider in one Save, over a transient
 * permission error or a stray character.
 *
 * Second, the write owns only the keys it is responsible for. Other providers
 * are passed through untouched, unknown keys at the root and on this gateway's
 * own provider entry are preserved, and per-model keys nobody here understands
 * survive on the model they belong to. What this module owns is the provider's
 * name, baseUrl and api, and each model's id, name, input, contextWindow,
 * maxTokens, reasoning and thinkingLevelMap, plus one key inside compat: supportsWebSearch. Compat as a whole is not ours
 * to own, because a model's compat block is where somebody hand-tunes a
 * stubborn deployment, so that block is edited in place rather than replaced.
 *
 * The one thing a rewrite cannot preserve is the comments, because the file is
 * re-serialised from parsed values. That is why every mutation takes a
 * timestamped backup first, the same protection the wizard offers.
 */

const OPENAI_COMPATIBLE_API = "openai-completions";
const MODEL_KEYS_THIS_WRITER_OWNS = ["id", "name", "input", "contextWindow", "maxTokens", "reasoning", "thinkingLevelMap"] as const;
/** The only key inside a model's `compat` block this writer decides. Everything else in there is somebody else's. */
const COMPAT_KEY_THIS_WRITER_OWNS = "supportsWebSearch";

type JsonObject = Record<string, unknown>;

export class ModelCatalogUnreadableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ModelCatalogUnreadableError";
	}
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

type CatalogRead =
	| { state: "absent" }
	| { state: "ok"; data: JsonObject; raw: string }
	| { state: "unreadable"; message: string };

function readModelsJson(modelsPath: string): CatalogRead {
	if (!fs.existsSync(modelsPath)) return { state: "absent" };
	let raw: string;
	try {
		raw = fs.readFileSync(modelsPath, "utf-8");
	} catch (error) {
		return { state: "unreadable", message: `could not be read (${error instanceof Error ? error.message : String(error)})` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripJsonComments(raw)) as unknown;
	} catch (error) {
		return { state: "unreadable", message: `is not valid JSON (${error instanceof Error ? error.message : String(error)})` };
	}
	// An array or a bare value is a models.json we do not recognise. Overwriting
	// it would be a guess about what the person meant, made with their data.
	if (!isObject(parsed)) return { state: "unreadable", message: "does not contain a JSON object at the top level" };
	return { state: "ok", data: parsed, raw };
}

/** Read for callers that only want to look; an unreadable file simply says nothing. */
function readModelsJsonLeniently(modelsPath: string): JsonObject {
	const read = readModelsJson(modelsPath);
	return read.state === "ok" ? read.data : {};
}

function requireReadableModelsJson(modelsPath: string): { root: JsonObject; existed: boolean } {
	const read = readModelsJson(modelsPath);
	if (read.state === "absent") return { root: {}, existed: false };
	if (read.state === "unreadable") {
		throw new ModelCatalogUnreadableError(
			`The model catalog at ${modelsPath} ${read.message}. Refusing to write, because saving now would replace every provider it still holds. Repair the file and try again.`,
		);
	}
	return { root: read.data, existed: true };
}

function makeTimestamp(): string {
	const date = new Date();
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * A copy of the file as it was, kept before every mutation. Re-serialising
 * drops the comments a person may have written, so the version with them in it
 * has to survive somewhere.
 */
function backupModelsJson(modelsPath: string): void {
	const base = `${modelsPath}.bak-${makeTimestamp()}`;
	let target = base;
	for (let index = 1; fs.existsSync(target) && index < 1000; index++) target = `${base}-${index}`;
	fs.copyFileSync(modelsPath, target);
	try {
		fs.chmodSync(target, 0o600);
	} catch {
		// Filesystems without POSIX modes still get the backup.
	}
}

function writeModelsJson(modelsPath: string, data: JsonObject, existed: boolean): void {
	fs.mkdirSync(path.dirname(modelsPath), { recursive: true, mode: 0o700 });
	if (existed) backupModelsJson(modelsPath);
	const tmpPath = `${modelsPath}.tmp-${process.pid}-${Date.now()}`;
	fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, "\t")}\n`, { mode: 0o600 });
	fs.renameSync(tmpPath, modelsPath);
}

function providersOf(root: JsonObject): JsonObject {
	return isObject(root.providers) ? root.providers : {};
}

/**
 * One model entry, rebuilt from what this writer decides plus whatever the file
 * already said about that model and this writer does not understand.
 */
function mergeModelEntry(existing: unknown, next: JsonObject, webSearch: boolean | undefined): JsonObject {
	const existingCompat = isObject(existing) && isObject(existing.compat) ? existing.compat : undefined;
	// The compat block, rebuilt as whatever was already there with our one key
	// set or cleared. Unticking the box removes the key rather than writing
	// false, so a model that never had a compat block does not grow an empty one
	// and a model that had one keeps everything else in it. `undefined` means no
	// checkbox spoke for this model at all, so even our own key is left alone.
	const compat: JsonObject = { ...existingCompat };
	if (webSearch === true) compat[COMPAT_KEY_THIS_WRITER_OWNS] = true;
	else if (webSearch === false) delete compat[COMPAT_KEY_THIS_WRITER_OWNS];
	const withCompat = Object.keys(compat).length > 0 ? { ...next, compat } : next;
	if (!isObject(existing)) return withCompat;
	const preserved: JsonObject = {};
	for (const [key, value] of Object.entries(existing)) {
		if (key === "compat") continue;
		if (!MODEL_KEYS_THIS_WRITER_OWNS.includes(key as (typeof MODEL_KEYS_THIS_WRITER_OWNS)[number])) preserved[key] = value;
	}
	return { ...preserved, ...withCompat };
}

/**
 * The runtime's thinkingLevelMap, derived from the gateway's per-level effort
 * declarations and its ceiling. The runtime's ladder rules are the contract
 * here: xhigh and max exist only where a model maps them explicitly, so a
 * declared-true top tier is written as its own effort name; every other level
 * is in the generic ladder already and needs no entry when declared true. A
 * declared false pins the level to null, which is the runtime's word for "this
 * rung does not exist". Undeclared levels are left unwritten, so a gateway that
 * says nothing changes nothing.
 *
 * Three edges of the live data shape this:
 *
 * The ceiling caps the flags. Real rows declare supports_max true and an xhigh
 * ceiling in the same breath; the ceiling is the deployment speaking about
 * itself, so every intensity above it is pinned null however its flag reads.
 *
 * The flags declare, they do not promise rejection: a route has been seen
 * accepting an effort its flag declared false and quietly coercing it. The
 * ladder still drops a declared-false level, because offering a rung that
 * silently becomes a different one is the dishonest option.
 *
 * "off" follows what the wire does. On this API the off level sends no effort
 * parameter unless the map names one, and a provider whose reasoning is
 * always-on then applies its own default, which is thinking the person turned
 * off. So a declared-true "none" becomes off: "none", the wire value that
 * genuinely stops; a declared-false "none" pins off to null, because the model
 * cannot stop and the dial must not claim it can; and an undeclared "none"
 * writes nothing, keeping today's no-parameter behavior, which in front of an
 * opt-in-thinking provider is a real off. Every always-on family observed so
 * far declares the flag one way or the other, so the silent case is the one
 * where silence already works.
 */
function thinkingLevelMapFromDeclaration(levels: GatewayThinkingLevels, ceiling: GatewayEffortIntensity | undefined): JsonObject | undefined {
	const map: JsonObject = {};
	if (levels.off === true) map.off = "none";
	else if (levels.off === false) map.off = null;
	const ceilingIndex = ceiling ? GATEWAY_EFFORT_INTENSITIES.indexOf(ceiling) : -1;
	for (const [index, level] of GATEWAY_EFFORT_INTENSITIES.entries()) {
		const declared = levels[level];
		if (ceilingIndex >= 0 && index > ceilingIndex) map[level] = null;
		else if (declared === false) map[level] = null;
		else if (declared === true && (level === "xhigh" || level === "max")) map[level] = level;
	}
	return Object.keys(map).length > 0 ? map : undefined;
}

/**
 * One catalog entry from one resolved capability set. Room models and the
 * maintenance model both come through here, so what a fact becomes in the file
 * cannot differ by which list the model sat in.
 */
function catalogEntryFromEffective(id: string, name: string, effective: EffectiveGatewayModel): JsonObject {
	const entry: JsonObject = { id, name };
	// Saying "text" only is what makes the provider layer swap an attached
	// image for a placeholder; saying both is what lets it through.
	if (effective.vision) entry.input = ["text", "image"];
	// The one thing that makes the provider layer attach the room's effort to
	// the request; a model without it is asked for nothing, which is what keeps
	// a gateway that rejects the parameter from seeing it at all.
	if (effective.reasoning) entry.reasoning = true;
	// The declared thinking ladder, when the gateway spoke one. Emitted only
	// beside reasoning: true, because effectiveGatewayModel already drops the
	// levels when reasoning is off, and read back by the runtime's
	// getSupportedThinkingLevels exactly as written.
	if (effective.reasoning && (effective.thinkingLevels || effective.effortCeiling)) {
		const thinkingLevelMap = thinkingLevelMapFromDeclaration(effective.thinkingLevels ?? {}, effective.effortCeiling);
		if (thinkingLevelMap) entry.thinkingLevelMap = thinkingLevelMap;
	}
	entry.contextWindow = effective.contextWindow;
	// The per-request output cap, written only where somebody declared one.
	// Nothing declared writes nothing, which leaves the runtime registry's own
	// default in charge, exactly as before this key existed.
	if (effective.maxTokens) entry.maxTokens = effective.maxTokens;
	return entry;
}

/** Every model the gateway needs registered: its room models plus the one that runs Memorize and Review. */
function gatewayCatalogModels(gateway: OpenAiCompatibleGateway, existingModels: unknown): JsonObject[] {
	const existingById = new Map<string, unknown>();
	if (Array.isArray(existingModels)) {
		for (const model of existingModels) {
			if (isObject(model) && typeof model.id === "string") existingById.set(model.id, model);
		}
	}
	const models: JsonObject[] = [];
	const seen = new Set<string>();
	for (const roomModel of gateway.roomModels) {
		if (seen.has(roomModel.modelId)) continue;
		seen.add(roomModel.modelId);
		// What the file gets is the effective capability set, override over
		// detection over default, resolved by the one function every consumer
		// shares. This file is what the runtime reads, so this is the line where
		// a detected fact becomes a working one.
		const effective = effectiveGatewayModel(roomModel);
		const entry = catalogEntryFromEffective(roomModel.modelId, roomModel.label ?? roomModel.modelId, effective);
		models.push(mergeModelEntry(existingById.get(roomModel.modelId), entry, effective.webSearch));
	}
	if (gateway.maintenanceModel && !seen.has(gateway.maintenanceModel)) {
		// A maintenance model that is also a room model was written above with
		// that row's full resolution. This branch is the one with no row of its
		// own, and it used to be written bare, which ran Memorize and Review on
		// the registry defaults whatever the model's real facts were. It now goes
		// through the same resolution as everything else, from the detection the
		// config kept for it; a config that kept none resolves to the same
		// defaults the bare entry meant.
		const effective = effectiveGatewayModel({ modelId: gateway.maintenanceModel, detected: gateway.maintenanceModelDetected ?? {} });
		const entry = catalogEntryFromEffective(gateway.maintenanceModel, gateway.maintenanceModel, effective);
		// The approve list has no row for the maintenance model, so nothing here
		// ever ticked or unticked web search for it. Whatever the file says about
		// it stays said.
		models.push(mergeModelEntry(existingById.get(gateway.maintenanceModel), entry, undefined));
	}
	return models;
}

export function writeGatewayProviderEntry(gateway: OpenAiCompatibleGateway, modelsPath = getModelsPath()): void {
	const { root, existed } = requireReadableModelsJson(modelsPath);
	const providers = { ...providersOf(root) };
	const existingProvider = isObject(providers[gateway.providerId]) ? (providers[gateway.providerId] as JsonObject) : {};
	// Spread first, then overwrite: transport details somebody added by hand
	// (headers, extra options, an apiKey reference) outlive our save.
	providers[gateway.providerId] = {
		...existingProvider,
		name: gateway.label,
		baseUrl: gateway.baseUrl ?? existingProvider.baseUrl ?? "",
		api: OPENAI_COMPATIBLE_API,
		models: gatewayCatalogModels(gateway, existingProvider.models),
	};
	writeModelsJson(modelsPath, { ...root, providers }, existed);
}

/** Removing one gateway must leave every other gateway's entry exactly where it was. */
export function removeGatewayProviderEntry(providerId: string, modelsPath = getModelsPath()): void {
	const read = readModelsJson(modelsPath);
	if (read.state === "absent") return;
	const { root, existed } = requireReadableModelsJson(modelsPath);
	const providers = providersOf(root);
	if (!(providerId in providers)) return;
	const next = { ...providers };
	delete next[providerId];
	writeModelsJson(modelsPath, { ...root, providers: next }, existed);
}

/** The base URL models.json already holds, for gateways migrated from the legacy policy file, which never stored one. */
export function readGatewayProviderBaseUrl(providerId: string, modelsPath = getModelsPath()): string {
	const provider = providersOf(readModelsJsonLeniently(modelsPath))[providerId];
	if (!isObject(provider) || typeof provider.baseUrl !== "string") return "";
	return provider.baseUrl;
}

/**
 * Every provider key the catalog holds. Read straight from the file rather than
 * from the registry's model list, because a provider someone configured with no
 * models yet has no models to be derived from and would otherwise look free to
 * take.
 */
export function readCatalogProviderIds(modelsPath = getModelsPath()): string[] {
	return Object.keys(providersOf(readModelsJsonLeniently(modelsPath)));
}
