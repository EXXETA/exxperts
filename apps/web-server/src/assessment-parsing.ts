// Tolerant readers for the Memorize and Review assessment markdown.
//
// The assessment is model-written text the user reads; its parsed fields
// only feed summaries and warnings. The strict proposal parsers stay strict
// (their output is memory and must match the contract exactly), but an
// assessment that says `- **Deep Memory:** …` or `#### Deep Memory` followed
// by bullets carries the same content as `- Deep Memory: …`, and reading it
// as "missing" discarded the model's work and told the user "Deep Memory:
// None" plus two engine-vocabulary warnings. These readers accept the common
// markdown variants: heading levels 2–4, bold/colon decoration on headings
// and labels, em/en dash separators, and nested bullets under a label line.

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Body of the section under a `##`–`####` heading whose text matches
 * `heading` (case-insensitive, optional bold wrap, optional trailing colon).
 * `##` and `###` both count as section level (models mix them), so the
 * section ends at the next `##`/`###` heading; `####` and deeper stay in the
 * body (e.g. `#### Deep Memory` under "What changes in stable memory").
 */
export function extractAssessmentSection(raw: string, heading: string): string {
	const pattern = new RegExp(`^(#{2,4})\\s+(?:\\*\\*|__)?${escapeRegExp(heading)}:?(?:\\*\\*|__)?:?\\s*$`, "im");
	const match = pattern.exec(raw);
	if (!match || match.index == null) return "";
	const boundary = Math.max(match[1].length, 3);
	const after = raw.slice(match.index + match[0].length);
	const next = after.search(new RegExp(`^#{1,${boundary}}\\s+`, "m"));
	return (next >= 0 ? after.slice(0, next) : after).trim();
}

const BULLET = /^[-*•]\s+/;
// A colon may hug the label ("Deep Memory:"); a dash must stand alone with
// spaces ("Deep Memory - …"), otherwise "Deep Memory-related notes" would read
// as a label.
const SEPARATOR = "(?::|\\s[—–-]\\s)";

function labelLinePattern(label: string): RegExp {
	// Two shapes, never mixed: a bold-wrapped label ("**Deep Memory:**" or
	// "**Deep Memory**:") or a plain one ("Deep Memory:"). Keeping the bold
	// close tied to a bold open is what stops it from eating the first "**"
	// of an emphasised value. Groups: 1/2 = separators of the bold shape,
	// 3 = separator of the plain shape, 4 = rest of line.
	const name = escapeRegExp(label);
	return new RegExp(`^(?:[-*•]\\s+|#{3,5}\\s+)?(?:(?:\\*\\*|__)${name}(${SEPARATOR})?(?:\\*\\*|__)(${SEPARATOR})?|${name}(${SEPARATOR})?)\\s*(.*)$`, "i");
}

function matchLabelLine(line: string, label: string): { rest: string } | null {
	const match = labelLinePattern(label).exec(line);
	if (!match) return null;
	const separator = match[1] || match[2] || match[3];
	const rest = (match[4] ?? "").trim();
	// Without any separator the line must be the bare label (heading style);
	// otherwise "Deep Memory work continues" would read as a label.
	if (!separator && rest) return null;
	return { rest };
}

function stripWrappingEmphasis(value: string): string {
	// Only a value wrapped as a whole ("**all of it**") loses its markers;
	// inline emphasis inside a value ("**a** and **b**") is content.
	const match = /^(\*\*|__)(.+)\1$/.exec(value);
	return match ? match[2].trim() : value;
}

function splitItems(value: string): string[] {
	return value.split(/;\s+/).map((item) => item.trim()).filter(Boolean);
}

/**
 * Items attributed to `label` inside `section`. Accepts `- Label: a; b`,
 * `- **Label:** a`, `- **Label**: a`, `- Label — a`, and a bare label line
 * (`**Label:**`, `#### Label`, `- Label:`) followed by bullets, which are
 * collected until the next line that names one of `allLabels` or a heading.
 */
export function extractLabeledBullets(section: string, label: string, allLabels: readonly string[]): string[] {
	const lines = section.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	const items: string[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const match = matchLabelLine(lines[index], label);
		if (!match) continue;
		if (match.rest) {
			items.push(...splitItems(stripWrappingEmphasis(match.rest)));
			continue;
		}
		for (let inner = index + 1; inner < lines.length; inner += 1) {
			const line = lines[inner];
			if (/^#{1,6}\s+/.test(line)) break;
			if (allLabels.some((other) => matchLabelLine(line, other))) break;
			if (!BULLET.test(line)) break;
			const value = stripWrappingEmphasis(line.replace(BULLET, "").trim());
			if (value) items.push(...splitItems(value));
		}
	}
	return items;
}
