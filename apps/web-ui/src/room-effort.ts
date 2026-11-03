

// Reasoning-effort capability as the server reports it. A server that predates
// the control simply omits it, and the composer then shows no pill at all.
//
// `ladder` is the model's own dial: one rung per distinct effort, each carrying
// the provider's name for it. A server that predates the ladder sends only the
// token list, so one is built from it where every rung is its own label.
function readEffortPayload(raw: any): { level: string; ladder: Array<{ level: string; label: string }> } | null {
	if (typeof raw?.level !== "string" || !raw.level) return null;
	const ladder = Array.isArray(raw?.ladder)
		? raw.ladder
				.filter((rung: any) => typeof rung?.level === "string" && rung.level && typeof rung?.label === "string" && rung.label)
				.map((rung: any) => ({ level: String(rung.level), label: String(rung.label) }))
		: Array.isArray(raw?.supported)
			? raw.supported
					.filter((entry: unknown) => typeof entry === "string" && entry)
					.map((entry: string) => ({ level: entry, label: entry }))
			: [];
	if (ladder.length === 0) return null;
	return { level: raw.level, ladder };
}

export { readEffortPayload };
