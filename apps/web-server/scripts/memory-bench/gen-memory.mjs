// Deterministic synthetic room memory (L1b/current.md) at a chosen size.
// Usage: node gen-memory.mjs <targetTokens> <rcEntries> > current.md
// Shape mirrors real files: Chronos, Deep Memory (### subsections), Active Items,
// Recent Context with `### RC-NNNN | STATUS | date | title` entries + rc_metadata.
const targetTokens = Number(process.argv[2] || 60000);
const rcEntries = Number(process.argv[3] || 10);
let seed = 42;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const subjects = ["the onboarding flow", "the pricing model", "the Berlin pilot", "the data-retention policy", "the vendor contract with Nordwind", "the quarterly review deck", "the API rate limits", "the customer advisory board", "the migration to the new CRM", "the hiring plan for Q4", "the compliance audit", "the partner portal", "the invoice reconciliation script", "the design system tokens", "the release cadence", "the support escalation path"];
const verbs = ["was decided on", "still depends on", "was postponed until", "is owned by", "conflicts with", "was validated against", "needs sign-off from", "is documented in", "was renamed to", "must be reconciled with", "was rejected in favour of", "is tracked under"];
const objects = ["the legal team", "Mara's proposal", "the March numbers", "the shared drive folder", "the steering committee", "the second vendor quote", "the German subsidiary", "the risk register", "the 2026 budget line", "the customer success lead", "the internal wiki page", "the board summary"];
const dates = ["2026-05-14", "2026-06-02", "2026-06-19", "2026-07-08", "2026-07-23", "2026-08-05", "2026-08-21", "2026-09-03"];
function sentence() {
	const s = `${pick(subjects)} ${pick(verbs)} ${pick(objects)}`;
	return s.charAt(0).toUpperCase() + s.slice(1) + (rnd() < 0.35 ? ` (saved ${pick(dates)})` : "") + ".";
}
function bullets(n) { return Array.from({ length: n }, () => `- ${sentence()} ${rnd() < 0.4 ? sentence() : ""}`.trimEnd()).join("\n"); }
function paragraph(n) { return Array.from({ length: n }, sentence).join(" "); }
const tokens = (t) => Math.ceil(t.length / 4);

const chronos = `<!-- exxeta:l1b schema_version=1 -->

## Chronos




- Current scaffold timestamp: 2026-03-02T09:14:11.000Z
- Persistent agent id: synthetic-60k
- Agent display name: Synthetic Sixty
- Lifecycle state: ready
- Last checkpoint: cp_20260903T101010Z_abc123
- Last consolidation: absorb_20260805T090000Z_xyz789
- Last checkpoint at: 2026-09-03T10:10:10.000Z
- Last approved session: s_20260903T101010Z_abc123
`;

// Recent Context: rcEntries entries of ~1.2k tokens each.
const rc = [];
for (let i = 1; i <= rcEntries; i += 1) {
	const id = String(i).padStart(4, "0");
	const date = dates[i % dates.length];
	rc.push(`### RC-${id} | ${i % 3 === 0 ? "CLOSED" : "OPEN"} | ${date} | Session ${i}: ${pick(subjects)} and ${pick(subjects)}

<!-- rc_metadata: checkpoint_id=cp_2026${id}T100000Z_s${id}; session_id=s_2026${id}T100000Z_s${id}; conversation_id=c_${id}; density=standard; model=openai-compatible/room-model; approved_at=${date}T10:00:00.000Z -->

**Session arc:** ${paragraph(2)}

**Body:**
${bullets(30)}

**Parked:**
${i % 3 === 0 ? "None" : bullets(2)}
`);
}
const recentContext = `## Recent Context




${rc.join("\n")}`;

const activeItems = `## Active Items

${bullets(22)}
`;

// Deep Memory fills the remainder up to the target.
const fixed = tokens(chronos) + tokens(recentContext) + tokens(activeItems) + 40;
const deepTarget = Math.max(2000, targetTokens - fixed);
const topics = ["Company context", "People and roles", "Working style and preferences", "Product decisions", "Commercial terms", "Open risks", "Tooling and environments", "Vendor landscape", "Customer accounts", "Processes and rituals", "Numbers that matter", "Lessons learned"];
let deep = "## Deep Memory\n\nDurable understanding consolidated across sessions. Newest saved-on stamps win on conflict.\n\n";
let i = 0;
while (tokens(deep) < deepTarget) {
	const title = topics[i % topics.length] + (i >= topics.length ? ` (${Math.floor(i / topics.length) + 1})` : "");
	deep += `### ${title}\n\n${paragraph(3)}\n\n${bullets(18)}\n\n`;
	i += 1;
}
const l1b = `${chronos}\n${deep}${activeItems}\n${recentContext}`;
process.stdout.write(l1b);
process.stderr.write(`tokens total=${tokens(l1b)} chronos=${tokens(chronos)} deep=${tokens(deep)} active=${tokens(activeItems)} rc=${tokens(recentContext)} rcEntries=${rcEntries} deepSubsections=${i}\n`);
