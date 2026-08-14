// Smoke for the gateway store and the three per-model facts it now carries.
//
// Gateway models used to be registered text-only with a silent 128k window, so
// an attached image degraded to a placeholder and the room context chip counted
// against a number nobody had chosen. Web search is the third fact: a model
// that can search through the gateway has to say so, or the request never asks
// it to. This proves the whole path in process: the store round-trips all
// three, the legacy single-gateway file is read as the first gateway without
// being rewritten, minted provider ids never collide with the one the existing
// rooms are locked to, and the runtime model registry reads back exactly what
// was written.
//
// Run: node scripts/run-smokes.mjs openai-compatible-gateway-capabilities

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-gateway-capabilities-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = path.join(tempHome, ".exxperts", "agent");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

try {
	const gateways = await import("../src/openai-compatible-gateways.js");
	const catalog = await import("../src/openai-compatible-gateway-catalog.js");
	const profiles = await import("../src/persistent-agent-ai-profiles.js");
	const customProfiles = await import("../src/custom-ai-profiles.js");

	const appDir = path.join(tempHome, ".exxperts", "app");
	const legacyPath = path.join(appDir, "openai-compatible-ai-profile.json");
	const storePath = path.join(appDir, "openai-compatible-gateways.json");
	const modelsPath = path.join(tempHome, ".exxperts", "agent", "models.json");

	// ---- nothing configured -------------------------------------------------
	assert(gateways.readOpenAiCompatibleGateways().gateways.length === 0, "no gateway exists before anything is written");
	assert(!profiles.isPersistentAgentAiProfileId("openai-compatible"), "the gateway profile should not exist before a gateway does");

	// ---- a legacy setup is the first gateway, unrewritten -------------------
	fs.mkdirSync(appDir, { recursive: true, mode: 0o700 });
	fs.writeFileSync(legacyPath, JSON.stringify({
		profileId: "openai-compatible",
		providerId: "openai-compatible",
		label: "Company gateway",
		roomModels: [{ modelId: "legacy-primary" }, { modelId: "legacy-secondary" }],
		maintenanceModel: "legacy-maintenance",
	}), { mode: 0o600 });

	const migrated = gateways.readOpenAiCompatibleGateways().gateways;
	assert(migrated.length === 1, `the legacy file should read as one gateway, got ${JSON.stringify(migrated)}`);
	assert(migrated[0].id === "openai-compatible" && migrated[0].providerId === "openai-compatible", "the first gateway keeps both of its ids");
	assert(migrated[0].label === "Company gateway", "the first gateway keeps the name it was given");
	assert(!fs.existsSync(storePath), "reading a legacy setup must not write anything");
	assert(profiles.isPersistentAgentAiProfileId("openai-compatible"), "the legacy gateway is a selectable profile");
	assert(profiles.isPersistentRoomModelForProfile("openai-compatible", "openai-compatible", "legacy-primary"), "an existing room lock still validates against the migrated gateway");
	assert(!profiles.isPersistentRoomModelForProfile("openai-compatible", "openai-compatible", "legacy-maintenance"), "the maintenance model is still not a room model");

	// ---- minted ids never take the one rooms are locked to ------------------
	const minted = gateways.mintGatewayProviderId("Project gateway", ["openai-compatible"]);
	assert(minted === "gateway-project-gateway", `a label should become a readable provider id, got ${minted}`);
	assert(gateways.mintGatewayProviderId("OpenAI compatible", []) !== "openai-compatible", "minting must never hand back the first gateway's id");
	assert(gateways.mintGatewayProviderId("Project gateway", [minted]) === "gateway-project-gateway-2", "a taken id is stepped past, not reused");
	assert(gateways.mintGatewayProviderId("!!!", []) === "gateway-unnamed", "a label with nothing to slugify still yields a usable prefixed id");

	// ---- a second gateway carrying both capability facts --------------------
	const second = gateways.writeOpenAiCompatibleGateway({
		id: minted,
		providerId: minted,
		label: "Project gateway",
		baseUrl: "https://gateway.example.invalid/v1",
		roomModels: [
			{ modelId: "sees-images", vision: true, contextWindow: 200000 },
			{ modelId: "text-only" },
			{ modelId: "searches-web", webSearch: true },
		],
		maintenanceModel: "text-only",
	});
	catalog.writeGatewayProviderEntry(second, modelsPath);

	const both = gateways.readOpenAiCompatibleGateways().gateways;
	assert(both.length === 2, `both gateways should be saved, got ${JSON.stringify(both.map((gateway) => gateway.id))}`);
	assert(both[0].id === "openai-compatible", "the first gateway stays first, so auto-follow order does not shuffle");
	const savedSecond = both.find((gateway) => gateway.id === minted)!;
	assert(savedSecond.roomModels[0].vision === true && savedSecond.roomModels[0].contextWindow === 200000, `the store should round-trip both facts, got ${JSON.stringify(savedSecond.roomModels[0])}`);
	assert(savedSecond.roomModels[1].vision === undefined, "a model nobody marked stays unmarked rather than being marked false");
	assert(savedSecond.roomModels[2].webSearch === true, `the store should round-trip the web-search flag, got ${JSON.stringify(savedSecond.roomModels[2])}`);
	assert(savedSecond.roomModels[0].webSearch === undefined, "a model nobody marked for web search stays unmarked");

	// Writing the second gateway must not have touched the first one's file.
	const legacyAfterWrite = JSON.parse(fs.readFileSync(legacyPath, "utf-8"));
	assert(legacyAfterWrite.label === "Company gateway", "the legacy file is untouched by another gateway's write");

	// ---- the runtime registry reads back what was written -------------------
	const { AuthStorage, ModelRegistry } = await import("@exxeta/exxperts-runtime");
	const registry = ModelRegistry.create(AuthStorage.create());
	const visionModel = registry.find(minted, "sees-images");
	const textModel = registry.find(minted, "text-only");
	assert(visionModel, `the registry should know the gateway's models, got ${JSON.stringify(registry.getAll().map((model) => `${model.provider}/${model.id}`))}`);
	assert(visionModel!.input.includes("image"), `an approved image model must report image input, got ${JSON.stringify(visionModel!.input)}`);
	assert(visionModel!.contextWindow === 200000, `the chosen context window must reach the registry, got ${visionModel!.contextWindow}`);
	assert(!textModel!.input.includes("image"), "a model nobody marked stays text-only");
	assert(textModel!.contextWindow === gateways.GATEWAY_DEFAULT_CONTEXT_WINDOW, `an unset window falls back to the documented default, got ${textModel!.contextWindow}`);
	// The last link before the request layer: the flag has to survive as compat
	// on the model the registry hands out, because that is the only thing the
	// provider reads when it decides whether to ask the gateway to search.
	const searchModel = registry.find(minted, "searches-web");
	assert((searchModel!.compat as any)?.supportsWebSearch === true, `a model marked for web search must reach the registry saying so, got ${JSON.stringify(searchModel!.compat)}`);
	assert((textModel!.compat as any)?.supportsWebSearch === undefined, `a model nobody marked must stay silent about web search, got ${JSON.stringify(textModel!.compat)}`);

	// Unticking the box has to remove the key, not leave it saying true forever.
	const untickedWebSearch = gateways.writeOpenAiCompatibleGateway({ ...second, roomModels: second.roomModels.map((model) => (model.modelId === "searches-web" ? { modelId: model.modelId } : model)) });
	catalog.writeGatewayProviderEntry(untickedWebSearch, modelsPath);
	const afterUntick = JSON.parse(fs.readFileSync(modelsPath, "utf-8")).providers[minted].models.find((model: any) => model.id === "searches-web");
	assert(afterUntick.compat?.supportsWebSearch === undefined, `unticking web search must clear the key, got ${JSON.stringify(afterUntick)}`);
	assert(!("compat" in afterUntick), `a model whose only compat key was ours must not keep an empty compat block, got ${JSON.stringify(afterUntick)}`);
	// The maintenance model has no row in the approve list, so nothing here ever
	// spoke for it: a hand-set flag on it must survive a save, not be cleared by
	// a checkbox that was never shown.
	const modelsNow = JSON.parse(fs.readFileSync(modelsPath, "utf-8"));
	modelsNow.providers[minted].models.find((model: any) => model.id === "text-only").compat = { supportsWebSearch: true };
	fs.writeFileSync(modelsPath, JSON.stringify(modelsNow, null, "\t"), { mode: 0o600 });
	catalog.writeGatewayProviderEntry({ ...second, roomModels: [{ modelId: "sees-images", vision: true, contextWindow: 200000 }], maintenanceModel: "text-only" }, modelsPath);
	const maintenanceAfter = JSON.parse(fs.readFileSync(modelsPath, "utf-8")).providers[minted].models.find((model: any) => model.id === "text-only");
	assert(maintenanceAfter.compat?.supportsWebSearch === true, `a flag on the maintenance model must survive a save, got ${JSON.stringify(maintenanceAfter)}`);
	// Put it back, so the rest of this smoke sees the gateway it was written with.
	catalog.writeGatewayProviderEntry(gateways.writeOpenAiCompatibleGateway(second), modelsPath);

	// ---- models.json belongs to the person, not to this writer --------------
	// A hand-annotated catalog: comments and a trailing comma, which the file
	// format officially allows, plus another provider and keys nothing here
	// understands. One Save used to be able to erase all of it.
	const annotatedPath = path.join(tempHome, "annotated-models.json");
	fs.writeFileSync(annotatedPath, `{
	// The company proxy, do not touch
	"providers": {
		"house-proxy": {
			"name": "House proxy",
			"baseUrl": "https://house.invalid/v1",
			"api": "openai-completions",
			"apiKey": "HOUSE_PROXY_KEY",
			"models": [{ "id": "house-model", "name": "House Model" }],
		},
		"${minted}": {
			"name": "Project gateway",
			"baseUrl": "https://gateway.example.invalid/v1",
			"api": "openai-completions",
			"headers": { "x-team": "platform" },
			"models": [
				{ "id": "sees-images", "name": "Sees Images", "reasoning": "medium", "compat": { "supportsStrictMode": false } },
			],
		},
	},
	"defaults": { "somethingElse": true },
}
`, { mode: 0o600 });
	catalog.writeGatewayProviderEntry({
		id: minted,
		providerId: minted,
		label: "Project gateway",
		baseUrl: "https://gateway.example.invalid/v1",
		roomModels: [{ modelId: "sees-images", vision: true, webSearch: true, contextWindow: 200000 }],
		maintenanceModel: "sees-images",
	}, annotatedPath);
	const annotated = JSON.parse(fs.readFileSync(annotatedPath, "utf-8"));
	assert(annotated.providers["house-proxy"]?.apiKey === "HOUSE_PROXY_KEY", `another provider must survive untouched, got ${JSON.stringify(annotated.providers)}`);
	assert(annotated.defaults?.somethingElse === true, "unknown root keys must survive");
	assert(annotated.providers[minted]?.headers?.["x-team"] === "platform", `unknown provider keys must survive, got ${JSON.stringify(annotated.providers[minted])}`);
	assert(annotated.providers[minted].models[0].reasoning === "medium", `unknown per-model keys must survive, got ${JSON.stringify(annotated.providers[minted].models[0])}`);
	assert(JSON.stringify(annotated.providers[minted].models[0].input) === JSON.stringify(["text", "image"]), "the keys this writer owns are still written");
	// Compat is where somebody hand-tunes a stubborn deployment. This writer sets
	// one key inside it and must leave the rest of the block alone.
	assert(annotated.providers[minted].models[0].compat?.supportsStrictMode === false, `a hand-tuned compat key must survive, got ${JSON.stringify(annotated.providers[minted].models[0].compat)}`);
	assert(annotated.providers[minted].models[0].compat?.supportsWebSearch === true, `the one compat key this writer owns is still written, got ${JSON.stringify(annotated.providers[minted].models[0].compat)}`);
	// Comments cannot survive a re-serialisation, so the version that had them
	// has to survive somewhere else.
	const backups = fs.readdirSync(tempHome).filter((name) => name.startsWith("annotated-models.json.bak-"));
	assert(backups.length === 1, `every mutation leaves one backup, got ${JSON.stringify(backups)}`);
	assert(fs.readFileSync(path.join(tempHome, backups[0]), "utf-8").includes("do not touch"), "the backup holds the file as it was, comments included");

	// A file that exists and cannot be understood stops the write dead. Treating
	// it as empty is how one Save deletes every provider in it.
	const brokenCatalogPath = path.join(tempHome, "broken-models.json");
	fs.writeFileSync(brokenCatalogPath, `{ "providers": { "house-proxy": { "name": "House" } `, { mode: 0o600 });
	let refusedCatalog = "";
	try {
		catalog.writeGatewayProviderEntry({ id: minted, providerId: minted, label: "x", baseUrl: "https://x.invalid/v1", roomModels: [{ modelId: "m" }], maintenanceModel: "m" }, brokenCatalogPath);
	} catch (e) {
		refusedCatalog = (e as Error).message;
	}
	assert(/Refusing to write/.test(refusedCatalog), `an unreadable model catalog must refuse the write, got ${JSON.stringify(refusedCatalog)}`);
	assert(fs.readFileSync(brokenCatalogPath, "utf-8").includes("house-proxy"), "a refused write leaves the catalog exactly as it was");
	// The same protection covers removal, which is just as destructive.
	let refusedRemoval = "";
	try {
		catalog.removeGatewayProviderEntry(minted, brokenCatalogPath);
	} catch (e) {
		refusedRemoval = (e as Error).message;
	}
	assert(/Refusing to write/.test(refusedRemoval), `an unreadable model catalog must refuse a removal too, got ${JSON.stringify(refusedRemoval)}`);

	// A provider configured with no models at all is invisible to the registry
	// but very much taken; minting must see it.
	assert(catalog.readCatalogProviderIds(annotatedPath).includes("house-proxy"), "catalog provider ids come from the file, not from model rows");

	// ---- both gateways are profiles, and neither is claimable as custom -----
	const available = profiles.getAvailablePersistentAgentAiProfiles();
	assert(available.some((profile) => profile.id === "openai-compatible") && available.some((profile) => profile.id === minted), "both gateways appear as profiles");
	assert(customProfiles.isReservedCustomProfileProvider(minted), "a saved gateway's provider cannot be claimed by a custom profile");
	assert(customProfiles.isReservedCustomProfileProvider("openai-compatible"), "the first gateway's provider stays reserved");
	const secondProfile = profiles.getPersistentAgentAiProfile(minted);
	assert(secondProfile.providerId === minted && secondProfile.processes.absorb.model === "text-only", `the second gateway's policy should be its own, got ${JSON.stringify(secondProfile.processes.absorb)}`);

	// ---- deleting one gateway leaves the other whole ------------------------
	const removed = gateways.deleteOpenAiCompatibleGateway(minted);
	catalog.removeGatewayProviderEntry(removed!.providerId, modelsPath);
	const remaining = gateways.readOpenAiCompatibleGateways().gateways;
	assert(remaining.length === 1 && remaining[0].id === "openai-compatible", `only the first gateway should remain, got ${JSON.stringify(remaining)}`);
	assert(fs.existsSync(legacyPath), "deleting another gateway must not remove the first one's file");
	const modelsAfterDelete = JSON.parse(fs.readFileSync(modelsPath, "utf-8"));
	assert(!modelsAfterDelete.providers[minted], "the removed gateway leaves the model catalog");

	// ---- a retired provider id is never handed out again --------------------
	// Same label, different endpoint: without the tombstone this mints the id the
	// deleted gateway had, and every room lock still naming it silently
	// re-attaches to somebody else's server.
	const afterDelete = gateways.readOpenAiCompatibleGateways();
	assert(afterDelete.retiredProviderIds.includes(minted), `deleting a gateway should retire its provider id, got ${JSON.stringify(afterDelete.retiredProviderIds)}`);
	const reminted = gateways.mintGatewayProviderId("Project gateway", [...afterDelete.gateways.map((gateway) => gateway.providerId), ...afterDelete.retiredProviderIds]);
	assert(reminted !== minted, `a retired provider id must never be minted again, got ${reminted}`);

	// ---- the first gateway's own file still speaks for it -------------------
	// The store now holds an entry for the default gateway, which is exactly the
	// state in which the store used to start overriding the legacy file and the
	// terminal wizard went quiet.
	gateways.writeOpenAiCompatibleGateway({ ...remaining[0], baseUrl: "https://company.example.invalid/v1" });
	const storeNow = JSON.parse(fs.readFileSync(storePath, "utf-8"));
	assert(storeNow.gateways.some((gateway: any) => gateway.id === "openai-compatible"), "the default gateway is materialised in the store");
	assert(JSON.parse(fs.readFileSync(legacyPath, "utf-8")).label === "Company gateway", "saving the first gateway keeps the legacy file a faithful mirror");
	// A wizard-style edit: the legacy file, rewritten by hand, with no baseUrl
	// field because the wizard's shape has none.
	fs.writeFileSync(legacyPath, JSON.stringify({
		profileId: "openai-compatible",
		providerId: "openai-compatible",
		label: "Renamed by the wizard",
		roomModels: [{ modelId: "wizard-model" }],
		maintenanceModel: "wizard-model",
	}), { mode: 0o600 });
	const afterWizardEdit = gateways.readOpenAiCompatibleGateways().gateways.find((gateway) => gateway.id === "openai-compatible")!;
	assert(afterWizardEdit.label === "Renamed by the wizard", `the wizard's edit must be visible, got ${JSON.stringify(afterWizardEdit)}`);
	assert(afterWizardEdit.roomModels[0].modelId === "wizard-model", `the wizard's model list must be visible, got ${JSON.stringify(afterWizardEdit.roomModels)}`);
	assert(afterWizardEdit.baseUrl === "https://company.example.invalid/v1", `the store still supplies the base URL the wizard cannot store, got ${JSON.stringify(afterWizardEdit)}`);

	// ---- an unreadable store is not an empty one ----------------------------
	const storeBackup = fs.readFileSync(storePath, "utf-8");
	fs.writeFileSync(storePath, "{ this is not json", { mode: 0o600 });
	const brokenRead = gateways.readOpenAiCompatibleGateways();
	assert(brokenRead.unreadable, "a store that cannot be parsed must say so");
	assert(brokenRead.errors.length > 0, "an unreadable store must surface an error, not pass silently");
	let refusedWrite = "";
	try {
		gateways.writeOpenAiCompatibleGateway({ id: "gateway-new", providerId: "gateway-new", label: "New", baseUrl: "https://x.invalid/v1", roomModels: [{ modelId: "m" }], maintenanceModel: "m" });
	} catch (e) {
		refusedWrite = (e as Error).message;
	}
	assert(/Refusing to write/.test(refusedWrite), `writing over an unreadable store must be refused, got ${JSON.stringify(refusedWrite)}`);
	let refusedDelete = "";
	try {
		gateways.deleteOpenAiCompatibleGateway("openai-compatible");
	} catch (e) {
		refusedDelete = (e as Error).message;
	}
	assert(/Refusing to write/.test(refusedDelete), `deleting against an unreadable store must be refused, got ${JSON.stringify(refusedDelete)}`);
	assert(fs.readFileSync(storePath, "utf-8") === "{ this is not json", "a refused write leaves the file exactly as it was");
	fs.writeFileSync(storePath, storeBackup, { mode: 0o600 });

	// ---- deleting the first gateway takes its legacy file with it -----------
	gateways.deleteOpenAiCompatibleGateway("openai-compatible");
	assert(!fs.existsSync(legacyPath), "removing the first gateway removes the file that described it");
	assert(gateways.readOpenAiCompatibleGateways().gateways.length === 0, "no gateway is left");

	fs.rmSync(tempHome, { recursive: true, force: true });
	console.log("openai-compatible gateway capabilities smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp HOME preserved for inspection: ${tempHome}`);
	process.exitCode = 1;
}
