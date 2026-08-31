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
