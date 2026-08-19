// Smoke for gateway capability precedence: override over detection over
// default, resolved by one server-side function, and the migration that keeps
// every pre-detection gateway behaving exactly as it did.
//
// The store now keeps two halves per model: the person's sparse overrides and
// the gateway's detection snapshot. This proves the resolution order field by
// field, that a reload refreshes the snapshot without touching an override,
// that web search is never turned on by detection alone, and, most load-bearing
// of all, that a config file saved before detection existed reads back with
// identical effective values whatever a later detection claims.
//
// Run: node scripts/run-smokes.mjs gateway-capability-precedence

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-gateway-precedence-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = path.join(tempHome, ".exxperts", "agent");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

try {
	const gateways = await import("../src/openai-compatible-gateways.js");
	const catalog = await import("../src/openai-compatible-gateway-catalog.js");
	const { effectiveGatewayModel, GATEWAY_DEFAULT_CONTEXT_WINDOW } = gateways;

	const appDir = path.join(tempHome, ".exxperts", "app");
	const storePath = path.join(appDir, "openai-compatible-gateways.json");
	const modelsPath = path.join(tempHome, ".exxperts", "agent", "models.json");

	// ---- the resolution order, field by field -------------------------------
	// Nothing anywhere: the documented defaults.
	const bare = effectiveGatewayModel({ modelId: "m", detected: {} });
	assert(bare.vision === false && bare.reasoning === false && bare.webSearch === false, `defaults should be off, got ${JSON.stringify(bare)}`);
	assert(bare.contextWindow === GATEWAY_DEFAULT_CONTEXT_WINDOW, `the default window should apply, got ${bare.contextWindow}`);

	// Detection alone decides where the person has not spoken.
	const detectedOnly = effectiveGatewayModel({ modelId: "m", detected: { vision: true, reasoning: true, contextWindow: 1000000 } });
	assert(detectedOnly.vision === true && detectedOnly.reasoning === true, "a detected capability should be effective without an override");
	assert(detectedOnly.contextWindow === 1000000, `a detected window should be effective, got ${detectedOnly.contextWindow}`);

	// An override beats detection, an explicit false included.
	const overridden = effectiveGatewayModel({ modelId: "m", vision: false, contextWindow: 128000, detected: { vision: true, reasoning: false, contextWindow: 1000000 } });
	assert(overridden.vision === false, "an explicit false override must beat a detected true");
	assert(overridden.contextWindow === 128000, `a window override must beat a detected window, got ${overridden.contextWindow}`);
	assert(overridden.reasoning === false, "with no override, a detected false stays off");
	const overriddenOn = effectiveGatewayModel({ modelId: "m", reasoning: true, detected: { reasoning: false } });
	assert(overriddenOn.reasoning === true, "an explicit true override must beat a detected false");

	// Web search is the exception: it can bill per use, so detection never
	// turns it on. Only the tick does.
	const searchDeclared = effectiveGatewayModel({ modelId: "m", detected: { webSearch: true } });
	assert(searchDeclared.webSearch === false, "a gateway declaring web search must never switch it on by itself");
	const searchTicked = effectiveGatewayModel({ modelId: "m", webSearch: true, detected: { webSearch: false } });
	assert(searchTicked.webSearch === true, "the person's tick is the only thing that turns web search on");

	// ---- migration: a pre-detection file keeps its exact behavior -----------
	// A store written by the previous release: capability keys only where true,
	// no detection snapshot anywhere, the default window unstated.
	fs.mkdirSync(appDir, { recursive: true, mode: 0o700 });
	fs.writeFileSync(storePath, JSON.stringify({
		version: 1,
		gateways: [{
			id: "gateway-legacy",
			providerId: "gateway-legacy",
			label: "Legacy gateway",
			baseUrl: "https://legacy.example.invalid/v1",
			roomModels: [
				{ modelId: "plain" },
				{ modelId: "capable", vision: true, webSearch: true, reasoning: true, contextWindow: 200000 },
			],
			maintenanceModel: "plain",
		}],
		retiredProviderIds: [],
	}), { mode: 0o600 });

	const legacy = gateways.readOpenAiCompatibleGateways().gateways.find((gateway) => gateway.id === "gateway-legacy")!;
	assert(legacy, "the legacy store should read back");
	const plain = legacy.roomModels.find((model) => model.modelId === "plain")!;
	const capable = legacy.roomModels.find((model) => model.modelId === "capable")!;
	// Every field it saved, including by omission, is now a pinned override.
	assert(plain.vision === false && plain.reasoning === false, `a legacy model's omissions read back as pinned falses, got ${JSON.stringify(plain)}`);
	assert(plain.contextWindow === GATEWAY_DEFAULT_CONTEXT_WINDOW, `a legacy model's unstated window reads back pinned to the default, got ${plain.contextWindow}`);
	assert(capable.vision === true && capable.webSearch === true && capable.reasoning === true && capable.contextWindow === 200000, "a legacy model's saved values read back as overrides");

	// The effective values are byte-identical to what the previous release did.
	const plainEffective = effectiveGatewayModel(plain);
	assert(JSON.stringify(plainEffective) === JSON.stringify({ vision: false, webSearch: false, reasoning: false, contextWindow: GATEWAY_DEFAULT_CONTEXT_WINDOW }), `legacy effective drifted: ${JSON.stringify(plainEffective)}`);

	// And they stay identical even when a detection later claims otherwise:
	// that is what the pinning is for.
	const plainDetected = { ...plain, detected: { vision: true, reasoning: true, contextWindow: 1000000, webSearch: true } };
	const pinnedEffective = effectiveGatewayModel(plainDetected);
	assert(JSON.stringify(pinnedEffective) === JSON.stringify(plainEffective), `a detection changed a migrated model's behavior: ${JSON.stringify(pinnedEffective)}`);

	// ---- reload refreshes detection, never overrides ------------------------
	// The new-format store: sparse overrides plus a snapshot, as a save from the
	// form writes it.
	const saved = gateways.writeOpenAiCompatibleGateway({
		id: "gateway-declared",
		providerId: "gateway-declared",
		label: "Declared gateway",
		baseUrl: "https://declared.example.invalid/v1",
		roomModels: [
			// One override against the detection, the rest following it.
			{ modelId: "follows", detected: { vision: true, contextWindow: 500000 } },
			{ modelId: "pinned", vision: false, detected: { vision: true, contextWindow: 500000 } },
		],
		maintenanceModel: "follows",
	});
	const savedBack = gateways.readOpenAiCompatibleGateways().gateways.find((gateway) => gateway.id === "gateway-declared")!;
	const follows = savedBack.roomModels.find((model) => model.modelId === "follows")!;
	const pinnedModel = savedBack.roomModels.find((model) => model.modelId === "pinned")!;
	assert(follows.vision === undefined && follows.detected?.vision === true, `sparse overrides and the snapshot must round-trip, got ${JSON.stringify(follows)}`);
	assert(pinnedModel.vision === false, "an explicit false override must round-trip");
	assert(effectiveGatewayModel(follows).vision === true && effectiveGatewayModel(pinnedModel).vision === false, "round-tripped halves must resolve the same way");

	// A reload hands back new detections; the write keeps overrides untouched.
	const reloaded = gateways.writeOpenAiCompatibleGateway({
		...saved,
		roomModels: saved.roomModels.map((model) => ({ ...model, detected: { vision: false, contextWindow: 900000 } })),
	});
	const reloadedBack = gateways.readOpenAiCompatibleGateways().gateways.find((gateway) => gateway.id === "gateway-declared")!;
	const followsAfter = reloadedBack.roomModels.find((model) => model.modelId === "follows")!;
	const pinnedAfter = reloadedBack.roomModels.find((model) => model.modelId === "pinned")!;
	assert(followsAfter.detected?.vision === false && followsAfter.detected?.contextWindow === 900000, "the reload should refresh the snapshot");
	assert(followsAfter.vision === undefined, "the reload must not invent an override");
	assert(effectiveGatewayModel(followsAfter).vision === false, "an unpinned field follows the fresh detection");
	assert(pinnedAfter.vision === false && effectiveGatewayModel(pinnedAfter).vision === false, "an override survives every reload");

	// ---- the catalog writes effective values --------------------------------
	catalog.writeGatewayProviderEntry(reloaded, modelsPath);
	const written = JSON.parse(fs.readFileSync(modelsPath, "utf-8")).providers["gateway-declared"];
	const followsEntry = written.models.find((model: any) => model.id === "follows");
	const pinnedEntry = written.models.find((model: any) => model.id === "pinned");
	assert(followsEntry.input === undefined, `models.json should carry the effective vision, got ${JSON.stringify(followsEntry)}`);
	assert(followsEntry.contextWindow === 900000, `models.json should carry the effective window, got ${followsEntry.contextWindow}`);
	assert(pinnedEntry.input === undefined, "a pinned false stays text-only in models.json");

	// ---- the declared thinking ladder ----------------------------------------
	// Levels are pure detection: they ride only on an effective reasoning that is
	// on, and the person's one lever against them stays the reasoning override.
	const ladderOn = effectiveGatewayModel({ modelId: "m", detected: { reasoning: true, thinkingLevels: { xhigh: true, max: true, minimal: false } } });
	assert(JSON.stringify(ladderOn.thinkingLevels) === JSON.stringify({ xhigh: true, max: true, minimal: false }), `declared levels should be effective beside reasoning on, got ${JSON.stringify(ladderOn)}`);
	const ladderOffByOverride = effectiveGatewayModel({ modelId: "m", reasoning: false, detected: { reasoning: true, thinkingLevels: { xhigh: true } } });
	assert(ladderOffByOverride.thinkingLevels === undefined, "reasoning overridden off must take the ladder with it");
	const ladderUndeclared = effectiveGatewayModel({ modelId: "m", detected: { reasoning: true } });
	assert(ladderUndeclared.thinkingLevels === undefined, "no declaration means no ladder, today's generic behavior");

	// Only well-typed booleans under known level names survive the read; a null,
	// a string or an invented level is not a declaration.
	fs.writeFileSync(storePath, JSON.stringify({
		version: 1,
		gateways: [{
			id: "gateway-ladder",
			providerId: "gateway-ladder",
			label: "Ladder gateway",
			baseUrl: "https://ladder.example.invalid/v1",
			roomModels: [
				{ modelId: "declares", detected: { reasoning: true, thinkingLevels: { xhigh: true, max: true, minimal: false, off: null, low: "yes", bogus: true }, adaptiveThinking: true } },
				{ modelId: "generic", detected: { reasoning: true } },
				{ modelId: "silenced", reasoning: false, detected: { reasoning: true, thinkingLevels: { max: true } } },
			],
			maintenanceModel: "declares",
		}],
		retiredProviderIds: [],
	}), { mode: 0o600 });
	const ladderGateway = gateways.readOpenAiCompatibleGateways().gateways.find((gateway) => gateway.id === "gateway-ladder")!;
	const declares = ladderGateway.roomModels.find((model) => model.modelId === "declares")!;
	assert(JSON.stringify(declares.detected?.thinkingLevels) === JSON.stringify({ minimal: false, xhigh: true, max: true }), `only real booleans under known levels survive, got ${JSON.stringify(declares.detected)}`);
	assert(declares.detected?.adaptiveThinking === true, "the adaptive-thinking declaration round-trips");

	// And they survive a save/reload cycle through the store's own writer.
	const ladderSaved = gateways.writeOpenAiCompatibleGateway(ladderGateway);
	const ladderBack = gateways.readOpenAiCompatibleGateways().gateways.find((gateway) => gateway.id === "gateway-ladder")!;
	assert(JSON.stringify(ladderBack.roomModels.find((model) => model.modelId === "declares")!.detected) === JSON.stringify(declares.detected), "the ladder snapshot survives save and reload");

	// The catalog turns the declaration into the runtime's thinkingLevelMap:
	// declared-true top tiers become explicit efforts, declared falses pin the
	// level to null, undeclared levels are not spoken for, and a model without a
	// declaration or with reasoning off gets no map at all.
	catalog.writeGatewayProviderEntry(ladderSaved, modelsPath);
	const ladderCatalog = JSON.parse(fs.readFileSync(modelsPath, "utf-8")).providers["gateway-ladder"];
	const declaresEntry = ladderCatalog.models.find((model: any) => model.id === "declares");
	const genericEntry = ladderCatalog.models.find((model: any) => model.id === "generic");
	const silencedEntry = ladderCatalog.models.find((model: any) => model.id === "silenced");
	assert(JSON.stringify(declaresEntry.thinkingLevelMap) === JSON.stringify({ minimal: null, xhigh: "xhigh", max: "max" }), `the declared ladder becomes the runtime map, got ${JSON.stringify(declaresEntry.thinkingLevelMap)}`);
	assert(genericEntry.reasoning === true && genericEntry.thinkingLevelMap === undefined, `no declaration means no map, got ${JSON.stringify(genericEntry)}`);
	assert(silencedEntry.reasoning === undefined && silencedEntry.thinkingLevelMap === undefined, `reasoning overridden off writes neither the flag nor the map, got ${JSON.stringify(silencedEntry)}`);

	// A ladder the gateway stopped declaring is cleared on the next save; the map
	// is one of the keys this writer owns, never a leftover.
	catalog.writeGatewayProviderEntry(gateways.writeOpenAiCompatibleGateway({
		...ladderSaved,
		roomModels: ladderSaved.roomModels.map((model) => (model.modelId === "declares" ? { ...model, detected: { reasoning: true } } : model)),
	}), modelsPath);
	const clearedEntry = JSON.parse(fs.readFileSync(modelsPath, "utf-8")).providers["gateway-ladder"].models.find((model: any) => model.id === "declares");
	assert(clearedEntry.thinkingLevelMap === undefined && clearedEntry.reasoning === true, `a withdrawn declaration must clear the map, got ${JSON.stringify(clearedEntry)}`);

	// A config saved by a build that never heard of levels keeps today's exact
	// behavior: the legacy gateway written earlier carries no declaration, and
	// its catalog entries carry no map.
	catalog.writeGatewayProviderEntry(legacy, modelsPath);
	const legacyCatalog = JSON.parse(fs.readFileSync(modelsPath, "utf-8")).providers["gateway-legacy"];
	assert(legacyCatalog.models.every((model: any) => model.thinkingLevelMap === undefined), `legacy entries must stay map-free, got ${JSON.stringify(legacyCatalog.models)}`);

	// ---- the ceiling, the off rung, and null against false -------------------
	// Live rows contradict themselves: a max flag beside an xhigh ceiling. The
	// ceiling caps the flags. And the off rung follows what the wire does: a
	// declared "none" support becomes the wire value that genuinely stops, a
	// declared refusal removes the rung, silence writes nothing.
	const shapes = gateways.writeOpenAiCompatibleGateway({
		id: "gateway-shapes",
		providerId: "gateway-shapes",
		label: "Shapes gateway",
		baseUrl: "https://shapes.example.invalid/v1",
		roomModels: [
			// sonnet-5 live shape: xhigh+max true, ceiling xhigh.
			{ modelId: "capped", detected: { reasoning: true, thinkingLevels: { xhigh: true, max: true }, effortCeiling: "xhigh" } },
			// opus-4.5 live shape: no flags at all, ceiling high.
			{ modelId: "ceiling-only", detected: { reasoning: true, effortCeiling: "high" } },
			// gpt-5.4 live shape: none true, minimal false, xhigh true.
			{ modelId: "stops", detected: { reasoning: true, thinkingLevels: { off: true, minimal: false, xhigh: true } } },
			// gpt-5-mini live shape: none false, minimal true, xhigh false.
			{ modelId: "cannot-stop", detected: { reasoning: true, thinkingLevels: { off: false, minimal: true, xhigh: false } } },
			// opus-5 live shape: only the top tiers declared, everything else null.
			// Null is not false: the base rungs must stay generic, unpinned.
			{ modelId: "top-only", detected: { reasoning: true, thinkingLevels: { xhigh: true, max: true }, adaptiveThinking: true } },
		],
		maintenanceModel: "capped",
	});
	const shapesBack = gateways.readOpenAiCompatibleGateways().gateways.find((gateway) => gateway.id === "gateway-shapes")!;
	assert(shapesBack.roomModels.find((model) => model.modelId === "capped")!.detected?.effortCeiling === "xhigh", "the ceiling round-trips through the store");
	catalog.writeGatewayProviderEntry(shapes, modelsPath);
	const shapesCatalog = JSON.parse(fs.readFileSync(modelsPath, "utf-8")).providers["gateway-shapes"];
	const entryOf = (id: string) => shapesCatalog.models.find((model: any) => model.id === id);
	assert(JSON.stringify(entryOf("capped").thinkingLevelMap) === JSON.stringify({ xhigh: "xhigh", max: null }), `the ceiling must cap a declared-true flag, got ${JSON.stringify(entryOf("capped").thinkingLevelMap)}`);
	assert(JSON.stringify(entryOf("ceiling-only").thinkingLevelMap) === JSON.stringify({ xhigh: null, max: null }), `a ceiling with no flags still caps, got ${JSON.stringify(entryOf("ceiling-only").thinkingLevelMap)}`);
	assert(JSON.stringify(entryOf("stops").thinkingLevelMap) === JSON.stringify({ off: "none", minimal: null, xhigh: "xhigh" }), `a declared none support becomes the wire value that stops, got ${JSON.stringify(entryOf("stops").thinkingLevelMap)}`);
	assert(JSON.stringify(entryOf("cannot-stop").thinkingLevelMap) === JSON.stringify({ off: null, xhigh: null }), `a declared refusal of none removes the off rung, got ${JSON.stringify(entryOf("cannot-stop").thinkingLevelMap)}`);
	const topOnlyMap = entryOf("top-only").thinkingLevelMap;
	assert(JSON.stringify(topOnlyMap) === JSON.stringify({ xhigh: "xhigh", max: "max" }), `undeclared levels must stay unwritten, null is not false, got ${JSON.stringify(topOnlyMap)}`);
	assert(!("off" in topOnlyMap) && !("minimal" in topOnlyMap), "silence about none and minimal writes nothing");


	// ---- the declared output cap ---------------------------------------------
	// maxTokens has no default of its own: when neither an override nor a
	// detection speaks, the effective set says nothing at all, which leaves the
	// runtime registry's default in charge, exactly as before the field existed.
	assert(!("maxTokens" in effectiveGatewayModel({ modelId: "m", detected: {} })), "no declaration and no override must emit no cap at all");
	assert(effectiveGatewayModel({ modelId: "m", detected: { maxTokens: 64000 } }).maxTokens === 64000, "a detected cap is effective without an override");
	assert(effectiveGatewayModel({ modelId: "m", maxTokens: 32000, detected: { maxTokens: 64000 } }).maxTokens === 32000, "a cap override beats the detected cap");

	// The cap survives the store, reaches models.json, and clears when withdrawn.
	const capped = gateways.writeOpenAiCompatibleGateway({
		id: "gateway-caps",
		providerId: "gateway-caps",
		label: "Caps gateway",
		baseUrl: "https://caps.example.invalid/v1",
		roomModels: [
			{ modelId: "declared-cap", detected: { contextWindow: 400000, maxTokens: 64000 } },
			{ modelId: "pinned-cap", maxTokens: 9000, detected: { maxTokens: 64000 } },
			{ modelId: "no-cap", detected: { contextWindow: 400000 } },
		],
		maintenanceModel: "declared-cap",
	});
	const capsBack = gateways.readOpenAiCompatibleGateways().gateways.find((gateway) => gateway.id === "gateway-caps")!;
	assert(capsBack.roomModels.find((model) => model.modelId === "declared-cap")!.detected?.maxTokens === 64000, "a detected cap round-trips through the store");
	assert(capsBack.roomModels.find((model) => model.modelId === "pinned-cap")!.maxTokens === 9000, "a cap override round-trips through the store");
	catalog.writeGatewayProviderEntry(capped, modelsPath);
	const capsCatalog = JSON.parse(fs.readFileSync(modelsPath, "utf-8")).providers["gateway-caps"];
	const capsEntry = (id: string) => capsCatalog.models.find((model: any) => model.id === id);
	assert(capsEntry("declared-cap").maxTokens === 64000, `a declared cap must reach models.json, got ${JSON.stringify(capsEntry("declared-cap"))}`);
	assert(capsEntry("pinned-cap").maxTokens === 9000, `a cap override must reach models.json, got ${JSON.stringify(capsEntry("pinned-cap"))}`);
	assert(capsEntry("no-cap").maxTokens === undefined, `no declaration must write no cap, so the registry default stays, got ${JSON.stringify(capsEntry("no-cap"))}`);
	// A withdrawn declaration is cleared on the next save: the key is owned.
	catalog.writeGatewayProviderEntry(gateways.writeOpenAiCompatibleGateway({
		...capped,
		roomModels: capped.roomModels.map((model) => (model.modelId === "declared-cap" ? { modelId: model.modelId, detected: { contextWindow: 400000 } } : model)),
	}), modelsPath);
	assert(JSON.parse(fs.readFileSync(modelsPath, "utf-8")).providers["gateway-caps"].models.find((model: any) => model.id === "declared-cap").maxTokens === undefined, "a withdrawn cap declaration must clear the key");
	// The owned-keys mechanism is per gateway model: a hand-set maxTokens on a
	// model of ANOTHER provider is untouched by this gateway's save.
	const withOther = JSON.parse(fs.readFileSync(modelsPath, "utf-8"));
	withOther.providers["hand-proxy"] = { name: "Hand proxy", baseUrl: "https://hand.invalid/v1", api: "openai-completions", models: [{ id: "hand-model", maxTokens: 4096 }] };
	fs.writeFileSync(modelsPath, JSON.stringify(withOther, null, "\t"), { mode: 0o600 });
	catalog.writeGatewayProviderEntry(capped, modelsPath);
	assert(JSON.parse(fs.readFileSync(modelsPath, "utf-8")).providers["hand-proxy"].models[0].maxTokens === 4096, "a hand-set cap on a non-gateway model is untouched");

	// ---- the declared mode survives the store, and a saved approval survives it
	const moded = gateways.writeOpenAiCompatibleGateway({
		...capped,
		roomModels: [...capped.roomModels, { modelId: "left-behind", detected: { mode: "embedding" } }],
	});
	assert(gateways.readOpenAiCompatibleGateways().gateways.find((gateway) => gateway.id === "gateway-caps")!.roomModels.find((model) => model.modelId === "left-behind")!.detected?.mode === "embedding", "a declared mode round-trips through the store");
	// A saved approval is never dropped by the writer, whatever its mode: the
	// row keeps its catalog entry, and the panel is where the warning lives.
	catalog.writeGatewayProviderEntry(moded, modelsPath);
	assert(JSON.parse(fs.readFileSync(modelsPath, "utf-8")).providers["gateway-caps"].models.some((model: any) => model.id === "left-behind"), "a saved non-chat model keeps its entry");

	// ---- the maintenance model carries resolved facts -------------------------
	// Not a room model, but its detection was kept on the config, so its entry
	// carries the same resolved facts a room model's would instead of being
	// registered bare on the 128k/16384 defaults.
	const maint = gateways.writeOpenAiCompatibleGateway({
		id: "gateway-maint",
		providerId: "gateway-maint",
		label: "Maint gateway",
		baseUrl: "https://maint.example.invalid/v1",
		roomModels: [{ modelId: "roomy", detected: {} }],
		maintenanceModel: "maintainer",
		maintenanceModelDetected: { contextWindow: 400000, maxTokens: 64000, reasoning: true, thinkingLevels: { xhigh: true, max: true }, effortCeiling: "xhigh" },
	});
	const maintBack = gateways.readOpenAiCompatibleGateways().gateways.find((gateway) => gateway.id === "gateway-maint")!;
	assert(maintBack.maintenanceModelDetected?.maxTokens === 64000 && maintBack.maintenanceModelDetected?.effortCeiling === "xhigh", `the maintenance detection round-trips through the store, got ${JSON.stringify(maintBack.maintenanceModelDetected)}`);
	catalog.writeGatewayProviderEntry(maint, modelsPath);
	const maintEntry = JSON.parse(fs.readFileSync(modelsPath, "utf-8")).providers["gateway-maint"].models.find((model: any) => model.id === "maintainer");
	assert(maintEntry.contextWindow === 400000 && maintEntry.maxTokens === 64000 && maintEntry.reasoning === true, `the maintenance entry must carry its resolved facts, got ${JSON.stringify(maintEntry)}`);
	assert(JSON.stringify(maintEntry.thinkingLevelMap) === JSON.stringify({ xhigh: "xhigh", max: null }), `the maintenance entry gets the same ladder rules, got ${JSON.stringify(maintEntry.thinkingLevelMap)}`);
	// A maintenance model that IS a room model is that row, written once with
	// the row's own resolution.
	const maintAsRoom = gateways.writeOpenAiCompatibleGateway({
		id: "gateway-maint",
		providerId: "gateway-maint",
		label: "Maint gateway",
		baseUrl: "https://maint.example.invalid/v1",
		roomModels: [{ modelId: "maintainer", detected: { contextWindow: 500000 } }],
		maintenanceModel: "maintainer",
	});
	catalog.writeGatewayProviderEntry(maintAsRoom, modelsPath);
	const maintRows = JSON.parse(fs.readFileSync(modelsPath, "utf-8")).providers["gateway-maint"].models.filter((model: any) => model.id === "maintainer");
	assert(maintRows.length === 1 && maintRows[0].contextWindow === 500000, `a maintenance model that is a room model is written once, from its row, got ${JSON.stringify(maintRows)}`);
	// A config from before the detection existed registers its maintenance model
	// on the same defaults the bare entry always meant: no cap, no reasoning,
	// the default window.
	const bareMaint = gateways.writeOpenAiCompatibleGateway({
		id: "gateway-bare-maint",
		providerId: "gateway-bare-maint",
		label: "Bare maint",
		baseUrl: "https://bare.example.invalid/v1",
		roomModels: [{ modelId: "roomy", detected: {} }],
		maintenanceModel: "quiet-maintainer",
	});
	catalog.writeGatewayProviderEntry(bareMaint, modelsPath);
	const bareEntry = JSON.parse(fs.readFileSync(modelsPath, "utf-8")).providers["gateway-bare-maint"].models.find((model: any) => model.id === "quiet-maintainer");
	assert(bareEntry.maxTokens === undefined && bareEntry.reasoning === undefined && bareEntry.contextWindow === GATEWAY_DEFAULT_CONTEXT_WINDOW, `a maintenance model with no kept detection registers on the defaults, got ${JSON.stringify(bareEntry)}`);

	console.log("gateway-capability-precedence smoke: all checks passed");
} finally {
	fs.rmSync(tempHome, { recursive: true, force: true });
}
