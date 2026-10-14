// The one token estimate the product speaks in: estimated tokens ≈ chars / 4,
// rounded up. Every meter, budget, prompt-size guard, and proposal metric must
// import these instead of re-deriving the math — the memory budget work (S2)
// compares numbers across surfaces, and two independently rounded estimates
// are two denominators. Dependency-free on purpose so any package can import
// it without dragging server-only modules along.

export function estimateTokensFromChars(chars: number): number {
	return Math.ceil(chars / 4);
}

export function estimateTokens(text: string): number {
	return estimateTokensFromChars(text.length);
}

/**
 * How many real tokens a model counts per estimated one, for the checks that
 * decide whether something fits a window, and only those: Claude's tokenizer
 * counts 1.4 to 1.9 times the estimate on prose (measured, English and
 * German), wherever Claude is served; other models about 1.0. What the person
 * sees and the memory budget stay in estimated tokens.
 */
export const CLAUDE_TOKEN_FACTOR = 1.6;

export function modelTokenFactor(model: { provider?: string; model?: string } | null | undefined): number {
	if (!model) return 1;
	return model.provider === "anthropic" || /(^|[/.:])claude-/i.test(String(model.model ?? "")) ? CLAUDE_TOKEN_FACTOR : 1;
}

/**
 * The prompt budget every fit check reads, in estimated tokens: 85% of the
 * window (the estimate undercounts code-heavy text), less room for the reply
 * (the model's output cap, between 1,000 and 4,000), divided by the model's
 * factor, and never under 1,000. The checkpoint and consult workers, the
 * maintenance guards, the boot gate and minimumMemoryWindow read this one
 * formula.
 */
export const PROMPT_WINDOW_FACTOR = 0.85;
export const PROMPT_OUTPUT_RESERVE_TOKENS = 4_000;
export const PROMPT_MIN_TOKEN_BUDGET = 1_000;

/** The budget in the model's own tokens, before its factor. */
export function promptRealTokenBudget(window: { contextWindow: number; maxOutputTokens: number }): number {
	const outputReserve = Math.min(Math.max(window.maxOutputTokens, 1_000), PROMPT_OUTPUT_RESERVE_TOKENS);
	return Math.floor(window.contextWindow * PROMPT_WINDOW_FACTOR) - outputReserve;
}

export function promptTokenBudget(window: { contextWindow: number; maxOutputTokens: number }, model?: { provider?: string; model?: string } | null): number {
	return Math.max(PROMPT_MIN_TOKEN_BUDGET, Math.floor(promptRealTokenBudget(window) / modelTokenFactor(model)));
}

/**
 * Memorize's fold for a room whose memory stands at its budget: the memory
 * with every note's address and dates (about 15% more on notes of about 55
 * tokens), plus what every fold carries at its largest: the instructions, the
 * first read at its cap and one remembered page at its cap. The yardstick of
 * the smallest Memory model a room can have; memory-model-size-smoke measures
 * it against the real prompts.
 */
const MEMORY_FOLD_ADDRESS_SHARE = 0.15;
const MEMORY_FOLD_FIXED_TOKENS = 11_000;

/** The smallest window whose prompt budget holds that fold on this model: below it, a room's Memory model is too small for its memory. */
export function minimumMemoryWindow(budgetTokens: number, model: { provider?: string; model?: string } | null | undefined): number {
	const need = Math.ceil(budgetTokens * (1 + MEMORY_FOLD_ADDRESS_SHARE)) + MEMORY_FOLD_FIXED_TOKENS;
	let low = 1;
	let high = Math.ceil(((need + 1) * modelTokenFactor(model) + PROMPT_OUTPUT_RESERVE_TOKENS) / PROMPT_WINDOW_FACTOR) + 1;
	while (low < high) {
		const window = Math.floor((low + high) / 2);
		if (promptTokenBudget({ contextWindow: window, maxOutputTokens: PROMPT_OUTPUT_RESERVE_TOKENS }, model) >= need) high = window;
		else low = window + 1;
	}
	return low;
}

/** What a conversation needs to continue on a model: the provider's measured count or the estimate times the model's factor, whichever is larger, with the margin. */
export function switchFitNeededTokens(input: { measured: number | null; estimated: number; model: { provider?: string; model?: string } | null; margin: number }): number {
	return Math.ceil(Math.max(input.measured ?? 0, input.estimated * modelTokenFactor(input.model)) * input.margin);
}
