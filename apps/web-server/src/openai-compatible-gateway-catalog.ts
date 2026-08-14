import fs from "node:fs";
import path from "node:path";
import { getModelsPath, stripJsonComments } from "@exxeta/exxperts-runtime";
import type { OpenAiCompatibleGateway } from "./openai-compatible-gateways.js";

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
 * name, baseUrl and api, and each model's id, name, input and contextWindow,
 * plus one key inside compat: supportsWebSearch. Compat as a whole is not ours
 * to own, because a model's compat block is where somebody hand-tunes a
 * stubborn deployment, so that block is edited in place rather than replaced.
 *
 * The one thing a rewrite cannot preserve is the comments, because the file is
 * re-serialised from parsed values. That is why every mutation takes a
 * timestamped backup first, the same protection the wizard offers.
 */

const OPENAI_COMPATIBLE_API = "openai-completions";
const MODEL_KEYS_THIS_WRITER_OWNS = ["id", "name", "input", "contextWindow"] as const;
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
		const entry: JsonObject = { id: roomModel.modelId, name: roomModel.label ?? roomModel.modelId };
		// Saying "text" only is what makes the provider layer swap an attached
		// image for a placeholder; saying both is what lets it through.
		if (roomModel.vision) entry.input = ["text", "image"];
		if (roomModel.contextWindow) entry.contextWindow = roomModel.contextWindow;
		models.push(mergeModelEntry(existingById.get(roomModel.modelId), entry, roomModel.webSearch === true));
	}
	if (gateway.maintenanceModel && !seen.has(gateway.maintenanceModel)) {
		// The approve list has no row for the maintenance model, so nothing here
		// ever ticked or unticked web search for it. Whatever the file says about
		// it stays said.
		models.push(mergeModelEntry(existingById.get(gateway.maintenanceModel), { id: gateway.maintenanceModel, name: gateway.maintenanceModel }, undefined));
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
