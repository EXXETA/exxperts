import { useEffect, useRef, useState } from "react";
import { useEscapeKey } from "./use-escape-key";

/** Every way out means seen; the caller records it. */

export type WhatsNewRelease = { version: string; date: string | null; entries: string[] };
export type WhatsNewSections = { major: WhatsNewRelease[]; minor: WhatsNewRelease[] };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function releaseDay(date: string): string {
	const [year, month, day] = date.split("-").map(Number);
	const name = MONTHS[month - 1];
	return name && day ? `${day} ${name} ${year}` : date;
}

function versionParts(version: string): number[] | null {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	return match ? match.slice(1).map(Number) : null;
}

function newer(a: number[], b: number[]): boolean {
	const index = a.findIndex((part, i) => part !== b[i]);
	return index >= 0 && a[index] > b[index];
}

/**
 * A shared server's record never moves on dismissal, so there this browser's
 * seen mark decides what is new to it; with no mark, the newest line speaks.
 */
export function sharedServerReleases(sections: WhatsNewSections, seenMark: string | null): WhatsNewSections {
	const all = [...sections.major, ...sections.minor].map((release) => versionParts(release.version)).filter((parts): parts is number[] => parts !== null);
	const newest = all.reduce<number[] | null>((best, parts) => (best === null || newer(parts, best) ? parts : best), null);
	const mark = versionParts(seenMark ?? "");
	const keep = (release: WhatsNewRelease): boolean => {
		const parts = versionParts(release.version);
		if (!parts) return false;
		return mark ? newer(parts, mark) : newest !== null && parts[0] === newest[0] && parts[1] === newest[1];
	};
	return { major: sections.major.filter(keep), minor: sections.minor.filter(keep) };
}

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

/**
 * A changelog bullet usually opens with a short label before its first
 * colon, "Rooms:" or "Fixed:"; that lead reads as the entry's subject, so it
 * gets the weight. Anything longer than a few plain words before the colon
 * is prose that happens to contain one, and stays untouched.
 */
function splitEntryLead(text: string): { lead: string; rest: string } | null {
	const colon = text.indexOf(":");
	if (colon <= 0) return null;
	const lead = text.slice(0, colon);
	if (!/^[A-Za-z][A-Za-z0-9'-]*( [A-Za-z0-9'-]+){0,2}$/.test(lead)) return null;
	return { lead, rest: text.slice(colon + 1).trim() };
}

/** What a release touches, read off its entries' labels, each once. */
function releaseLabels(release: WhatsNewRelease): string[] {
	const labels: string[] = [];
	for (const entry of release.entries) {
		const lead = splitEntryLead(entry)?.lead;
		if (lead && !labels.includes(lead)) labels.push(lead);
	}
	return labels;
}

function ReleaseLines({ release }: { release: WhatsNewRelease }) {
	return (
		<>
			{release.entries.map((entry, index) => {
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
		</>
	);
}

function MajorRelease({ release }: { release: WhatsNewRelease }) {
	return (
		<section className="whats-new-release">
			<h3 className="whats-new-release-head whats-new-release-head-first">
				<span className="whats-new-release-version">{release.version}</span>
				{release.date && <span className="whats-new-release-date">{releaseDay(release.date)}</span>}
			</h3>
			<ReleaseLines release={release} />
		</section>
	);
}

function MinorRow({ release, open, onToggle }: { release: WhatsNewRelease; open: boolean; onToggle: () => void }) {
	const linesId = `whats-new-lines-${release.version}`;
	const labels = releaseLabels(release);
	return (
		<section className="whats-new-row">
			<h3 className="whats-new-row-head">
				<button type="button" className="whats-new-row-toggle" aria-expanded={open} aria-controls={linesId} onClick={onToggle}>
					<span className="disclosure-chevron" aria-hidden="true" />
					<span className="whats-new-release-version">{release.version}</span>
					{release.date && <span className="whats-new-release-date">{releaseDay(release.date)}</span>}
					{labels.length > 0 && <span className="whats-new-row-labels">{labels.join(" · ")}</span>}
				</button>
			</h3>
			<div id={linesId} className="whats-new-row-lines" hidden={!open}>
				<ReleaseLines release={release} />
			</div>
		</section>
	);
}

export function WhatsNewDialog({ sections, onClose }: { sections: WhatsNewSections; onClose: () => void }) {
	useEscapeKey(onClose);
	// The keyboard starts on the window itself, so no ring shows until the first Tab.
	const dialogRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => dialogRef.current?.focus(), []);
	// With no big release to read first, what just changed starts open.
	const [open, setOpen] = useState<string[]>(() => (sections.major.length === 0 && sections.minor[0] ? [sections.minor[0].version] : []));
	const toggle = (version: string): void => setOpen((current) => (current.includes(version) ? current.filter((v) => v !== version) : [...current, version]));
	return (
		<div className="whats-new-backdrop" onClick={onClose}>
			<div ref={dialogRef} tabIndex={-1} className="whats-new-dialog" role="dialog" aria-modal="true" aria-label="What's new" onClick={(e) => e.stopPropagation()}>
				<button type="button" className="whats-new-close" onClick={onClose} aria-label="Close">✕</button>
				<h1 className="whats-new-title">What's new</h1>
				<div className="whats-new-entries">
					{sections.major.length > 0 && (
						<section className="whats-new-section">
							<h2 className="whats-new-section-head">Major releases</h2>
							{sections.major.map((release) => <MajorRelease key={release.version} release={release} />)}
						</section>
					)}
					{sections.minor.length > 0 && (
						<section className="whats-new-section">
							<h2 className="whats-new-section-head">Minor releases</h2>
							<div className="whats-new-rows">
								{sections.minor.map((release) => (
									<MinorRow key={release.version} release={release} open={open.includes(release.version)} onToggle={() => toggle(release.version)} />
								))}
							</div>
						</section>
					)}
				</div>
				<div className="whats-new-foot">
					<a className="whats-new-full-link" href="https://github.com/EXXETA/exxperts/blob/main/CHANGELOG.md" target="_blank" rel="noreferrer">Read the full notes</a>
				</div>
			</div>
		</div>
	);
}
