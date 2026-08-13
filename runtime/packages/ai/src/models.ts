import { MODELS } from "./models.generated.js";
import type { Api, KnownProvider, Model, ModelThinkingLevel, Usage } from "./types.js";

const modelRegistry: Map<string, Map<string, Model<Api>>> = new Map();

// Initialize registry from MODELS on module load
for (const [provider, models] of Object.entries(MODELS)) {
	const providerModels = new Map<string, Model<Api>>();
	for (const [id, model] of Object.entries(models)) {
		providerModels.set(id, model as Model<Api>);
	}
	modelRegistry.set(provider, providerModels);
}

type ModelApi<
	TProvider extends KnownProvider,
	TModelId extends keyof (typeof MODELS)[TProvider],
> = (typeof MODELS)[TProvider][TModelId] extends { api: infer TApi } ? (TApi extends Api ? TApi : never) : never;

export function getModel<TProvider extends KnownProvider, TModelId extends keyof (typeof MODELS)[TProvider]>(
	provider: TProvider,
	modelId: TModelId,
): Model<ModelApi<TProvider, TModelId>> {
	const providerModels = modelRegistry.get(provider);
	return providerModels?.get(modelId as string) as Model<ModelApi<TProvider, TModelId>>;
}

export function getProviders(): KnownProvider[] {
	return Array.from(modelRegistry.keys()) as KnownProvider[];
}

export function getModels<TProvider extends KnownProvider>(
	provider: TProvider,
): Model<ModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[] {
	const models = modelRegistry.get(provider);
	return models ? (Array.from(models.values()) as Model<ModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[]) : [];
}

export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
	usage.cost.input = (model.cost.input / 1000000) * usage.input;
	usage.cost.output = (model.cost.output / 1000000) * usage.output;
	usage.cost.cacheRead = (model.cost.cacheRead / 1000000) * usage.cacheRead;
	usage.cost.cacheWrite = (model.cost.cacheWrite / 1000000) * usage.cacheWrite;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}

const EXTENDED_THINKING_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Tiers above "high" exist only where a model says so. They are not a general
 * capability: asking for one on a model that never mapped it would send an
 * effort value the provider does not accept.
 */
const EXPLICIT_ONLY_THINKING_LEVELS: ModelThinkingLevel[] = ["xhigh", "max"];

export function getSupportedThinkingLevels<TApi extends Api>(model: Model<TApi>): ModelThinkingLevel[] {
	if (!model.reasoning) return ["off"];

	return EXTENDED_THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (EXPLICIT_ONLY_THINKING_LEVELS.includes(level)) return mapped !== undefined;
		return true;
	});
}

/**
 * Reduce a level to one this model can actually do.
 *
 * A level the model cannot reach settles DOWNWARD first, onto the nearest rung
 * below it, and only climbs when there is nothing below. Asking for more
 * thinking than a model offers must not buy more than was asked for: on a
 * model whose ladder skips a tier, walking up would silently promote a request
 * to the most expensive rung the model has, which is somebody's money.
 *
 * "off" is the exception in both directions. It is a request to STOP, so it is
 * never something a lower rung can satisfy, and a model that cannot stop
 * thinking answers it with its cheapest thinking rung. Equally, no other
 * request may fall all the way to "off": asking for less thinking is never
 * asking for none.
 */
export function clampThinkingLevel<TApi extends Api>(
	model: Model<TApi>,
	level: ModelThinkingLevel,
): ModelThinkingLevel {
	const availableLevels = getSupportedThinkingLevels(model);
	if (availableLevels.includes(level)) return level;

	const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
	if (requestedIndex === -1) return availableLevels[0] ?? "off";

	const candidates = level === "off" ? availableLevels : availableLevels.filter((candidate) => candidate !== "off");
	if (candidates.length === 0) return availableLevels[0] ?? "off";

	if (level !== "off") {
		for (let i = requestedIndex - 1; i >= 0; i--) {
			const candidate = EXTENDED_THINKING_LEVELS[i];
			if (candidates.includes(candidate)) return candidate;
		}
	}
	for (let i = requestedIndex + 1; i < EXTENDED_THINKING_LEVELS.length; i++) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (candidates.includes(candidate)) return candidate;
	}
	return candidates[0];
}

/**
 * Whether a model negotiated a tier above "high" as a real effort value.
 *
 * This is the honest test for adaptive thinking: a model that names an effort
 * for its top tier is a model that takes efforts. Anything else falls to
 * budget-based thinking, where every tier above "medium" spends the same
 * budget and the top tiers would be indistinguishable from "high".
 */
export function hasExplicitTopTierEffort<TApi extends Api>(model: Model<TApi>): boolean {
	return EXPLICIT_ONLY_THINKING_LEVELS.some((level) => typeof model.thinkingLevelMap?.[level] === "string");
}

/**
 * One rung of a model's reasoning dial as a person should see it.
 *
 * `level` is the internal token every API in this repo speaks. `label` is the
 * name the PROVIDER uses for the effort that token actually produces, which is
 * what makes the dial honest: a Claude model has no "minimal", it has "low"
 * twice over, and showing both would be two rungs that do the same thing.
 */
export interface ThinkingLevelRung {
	level: ModelThinkingLevel;
	label: string;
}

/**
 * The effort name a model produces for a level when nothing maps it.
 *
 * This mirrors the fallback each adapter applies when `thinkingLevelMap` has no
 * entry (see mapThinkingLevelToEffort in the Anthropic and Bedrock adapters,
 * and getThinkingLevel in the Google ones). It is deliberately a mirror rather
 * than a call into the adapters: this module is imported by them, and the
 * display ladder must resolve without any provider being registered.
 *
 * The Google case covers that family's GENERAL mapping only, which is a plain
 * upper-casing. Gemini 3 Pro and Gemma 4 additionally fold pairs of levels onto
 * one name, and this mirror does not reproduce that, because the predicates
 * selecting those models live in the Google adapter and copying them here is
 * the hand-maintained table this design exists to avoid. It is safe only
 * because the registry pins the folded-away levels to null for exactly those
 * models, so they never reach a ladder at all. An entry that stopped pinning
 * them would show two rungs under wrong names, so the pinning and this comment
 * belong together.
 */
function defaultEffortName(model: Model<Api>, level: ModelThinkingLevel): string {
	if (level === "off") return "off";
	switch (model.api) {
		case "anthropic-messages":
		case "bedrock-converse-stream":
			// Anthropic effort has no rung below "low", so "minimal" lands on it.
			return level === "minimal" ? "low" : level;
		case "google-generative-ai":
		case "google-vertex":
			// Google names its levels in upper case.
			return level.toUpperCase();
		default:
			// OpenAI-family and everything else pass the token through unchanged.
			return level;
	}
}

/**
 * The effort a model actually produces for a level: what it mapped, or the
 * name its adapter falls back to. This is the value two levels have to share
 * for them to be one rung of the dial.
 */
export function thinkingEffortName<TApi extends Api>(model: Model<TApi>, level: ModelThinkingLevel): string {
	const mapped = model.thinkingLevelMap?.[level];
	return typeof mapped === "string" ? mapped : defaultEffortName(model as Model<Api>, level);
}

/**
 * A model's reasoning dial as it should be displayed: one rung per DISTINCT
 * effort the model can actually produce, in ascending order.
 *
 * Levels that collapse onto the same provider effort are folded into a single
 * rung, keeping the token whose own name matches that effort (so Anthropic's
 * "minimal" and "low" become one rung called "low", labelled and selected as
 * "low"). Where no token matches, the lowest one wins, since folding upward
 * would silently promise more thinking than the rung delivers.
 */
export function getThinkingLevelLadder<TApi extends Api>(model: Model<TApi>): ThinkingLevelRung[] {
	const rungs: ThinkingLevelRung[] = [];
	for (const level of getSupportedThinkingLevels(model)) {
		const label = thinkingEffortName(model, level);
		const existing = rungs.find((rung) => rung.label === label);
		if (!existing) {
			rungs.push({ level, label });
			continue;
		}
		// A later token may be the canonical name for this effort; the earlier
		// one only holds the rung until the matching name shows up.
		if (existing.level !== existing.label && level === label) existing.level = level;
	}
	return rungs;
}

/**
 * The rung of the dial a level should be SHOWN on.
 *
 * A stored level may not be a rung of its own: it may have been folded into
 * another, and the fold is often IMPLICIT, decided by the adapter's fallback
 * rather than by any map entry. Matching on the effort each produces is what
 * catches that, and it is why this cannot be done by looking the level up in
 * the map. Anything still unresolved settles onto the nearest rung BELOW it,
 * never onto the bottom of the dial by accident: a room thinking at "low" that
 * displayed "off" would invite the user to confirm a setting nobody chose, and
 * genuinely stop the thinking.
 */
export function resolveThinkingLevelRung<TApi extends Api>(
	model: Model<TApi>,
	level: ModelThinkingLevel,
): ThinkingLevelRung | undefined {
	const ladder = getThinkingLevelLadder(model);
	if (ladder.length === 0) return undefined;

	const exact = ladder.find((rung) => rung.level === level);
	if (exact) return exact;

	const effort = thinkingEffortName(model, level);
	const folded = ladder.find((rung) => rung.label === effort);
	if (folded) return folded;

	const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
	for (let i = requestedIndex - 1; i >= 0; i--) {
		const lower = ladder.find((rung) => rung.level === EXTENDED_THINKING_LEVELS[i]);
		if (lower) return lower;
	}
	// Nothing below it exists, so the lowest rung IS the nearest one.
	return ladder[0];
}

/**
 * Check if two models are equal by comparing both their id and provider.
 * Returns false if either model is null or undefined.
 */
export function modelsAreEqual<TApi extends Api>(
	a: Model<TApi> | null | undefined,
	b: Model<TApi> | null | undefined,
): boolean {
	if (!a || !b) return false;
	return a.id === b.id && a.provider === b.provider;
}
