import { useEscapeKey } from "./use-escape-key";

/**
 * The one-time What's new window after an update. A single centered pane
 * over the same dimmed backdrop treatment as the Settings overlay, holding
 * the running version's changelog entries; every way out (Continue, the X,
 * the backdrop, Escape) means the same thing, "seen", and the caller owns
 * recording that. No nav, no state of its own: the entries arrived ready.
 */

/**
 * A changelog bullet usually opens with a short label before its first
 * colon, "Rooms:" or "Fixed:"; that lead reads as the entry's subject, so it
 * gets the weight. Anything longer than a few plain words before the colon
 * is prose that happens to contain one, and stays untouched.
 */
/**
 * The window shows one line per point, not the whole story: the changelog is
 * written lead-sentence-first on purpose, so the first sentence of a bullet
 * is its honest summary and the full text stays a link away. A boundary is a
 * period followed by whitespace and something that starts sentences here
 * (a capital, a digit, or an opening quote), which keeps "0.9.1 closed" and
 * quoted error walls intact.
 */
function firstSentence(text: string): string {
	const match = /\.\s+(?=[A-Z0-9"])/.exec(text);
	return match ? text.slice(0, match.index + 1) : text;
}

function splitEntryLead(text: string): { lead: string; rest: string } | null {
	const colon = text.indexOf(":");
	if (colon <= 0) return null;
	const lead = text.slice(0, colon);
	if (!/^[A-Za-z][A-Za-z0-9'-]*( [A-Za-z0-9'-]+){0,2}$/.test(lead)) return null;
	return { lead, rest: text.slice(colon + 1).trim() };
}

export function WhatsNewDialog({ version, entries, onClose }: { version: string; entries: string[]; onClose: () => void }) {
	useEscapeKey(onClose);
	return (
		<div className="whats-new-backdrop" onClick={onClose}>
			<div className="whats-new-dialog" role="dialog" aria-modal="true" aria-label={`What's new in ${version}`} onClick={(e) => e.stopPropagation()}>
				<button type="button" className="settings-overlay-close" onClick={onClose} aria-label="Close">✕</button>
				<h1 className="whats-new-title">What's new in {version}</h1>
				<div className="whats-new-entries">
					{entries.map((entry, index) => {
						const split = splitEntryLead(entry);
						return (
							<p key={index} className="whats-new-entry">
								{split ? (
									<>
										<strong>{split.lead}:</strong> {firstSentence(split.rest)}
									</>
								) : (
									firstSentence(entry)
								)}
							</p>
						);
					})}
				</div>
				<div className="whats-new-foot">
					<a className="whats-new-full-link" href="https://github.com/EXXETA/exxperts/blob/main/CHANGELOG.md" target="_blank" rel="noreferrer">Read the full notes</a>
					<button type="button" className="btn-primary" onClick={onClose}>Continue</button>
				</div>
			</div>
		</div>
	);
}
