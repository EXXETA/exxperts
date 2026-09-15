// Fold quality bench — the fixtures and the answer key (memory v2, stream F).
//
// The size bench next door asks whether a Memorize run FITS. This one asks
// whether a fold is RIGHT: one remembered session folded into core memory as a
// short list of operations, scored against things that were planted on purpose.
//
// Nothing here talks to a model, a route or the disk. It builds two values:
//   - a small core memory in the v2 storage format (topics, entries with their
//     `<!-- e: ... -->` metadata line, an id counter, Active Items, and a
//     Recent Context section that names the run's sessions without repeating
//     their bodies) — the real format, so the bench parses it with the product's
//     own parser rather than a fixture-shaped imitation;
//   - the run's sessions in the real Recent Context entry format, each PLANTING
//     known things, and an answer key saying, for every planted thing, the
//     operation it should become, the entry or topic it should land on, and the
//     marker token the scorer looks for in the resulting memory.
//
// MARKERS. Every planted thing carries a reference code — `CORE-03` for a core
// entry, `REF-F01` for something a session plants, `NOISE-02` for a line that
// must never become an entry. The codes are written INSIDE the sentence, the
// way a room's memory carries ticket references, so a model that folds the
// sentence carries the marker with it and the scorer can find the outcome in
// the resulting memory text. A marker is never a scoring instruction: it says
// which planted thing an entry came from, nothing about whether the fold was
// right.
//
// DIRECTIVES. Each planted line is preceded, in the ANNOTATED render, by a
// `<!-- plant: ... -->` comment naming the operation the fold should emit. It
// exists for the scripted responder of the offline run, which reads the session
// the way a model would and answers from what it finds there. The PLAIN render
// strips those comments and is what a real model is given: the markers survive,
// the answers do not.
//
// Seeded: the same seed is the same fixture, byte for byte. Different seeds
// draw different sentences from the pools and move the plants' targets; what
// each session plants, and the shape of the answer key, never changes.

// --- The seeded draw ---------------------------------------------------------

/** mulberry32 — the small deterministic generator the fixture tooling uses. */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function shuffled<T>(items: readonly T[], rand: () => number): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

function pick<T>(items: readonly T[], rand: () => number): T {
	return items[Math.floor(rand() * items.length)];
}

// --- The answer key ----------------------------------------------------------

export type PlantKind =
	/** A new fact the session brings; it belongs under a named topic. */
	| "fact"
	/** The session reverses an entry of core memory; the newer state wins. */
	| "reversal"
	/** The session finished an open item. */
	| "completion"
	/** A must-keep line: it lands pinned and exact, or the fold failed. */
	| "mustkeep"
	/** The whole session is chatter; it is dropped, with a reason. */
	| "chatter"
	/** The first half of a cross-session correction: a fact whose value changes later. */
	| "correction-old"
	/** The later half: the corrected value, which must win. */
	| "correction-new"
	/** The session records the user asking for an entry to be pinned. */
	| "pin"
	/** A line that must not become an entry. */
	| "noise";

/** The operation kinds a plant expects; "none" is a line that must produce nothing. */
export type PlantedOp = "add" | "update" | "supersede" | "close" | "pin" | "unpin" | "drop" | "none";

export interface Plant {
	/** Short id inside the fixture, e.g. "F01". */
	id: string;
	kind: PlantKind;
	/** The Recent Context id of the session that plants it. */
	session: string;
	/** The reference code the scorer looks for in the resulting memory, e.g. "REF-F01". */
	marker: string;
	/** The line as it appears in the session body, without its directive. */
	line: string;
	/** The operation this plant should become. */
	expectedOp: PlantedOp;
	/** For an add: the topic the entry belongs under. */
	expectedTopic?: string;
	/** For an operation against an existing entry: the entry's id, when it exists before the run. */
	expectedTargetId?: string;
	/** For an operation against an entry an earlier session added: that entry's marker. */
	expectedTargetMarker?: string;
	/** A marker that must be GONE from core afterwards (the reversed or corrected text). */
	supersedesMarker?: string;
	/** Must-keep plants: the sentence that has to survive word for word. */
	exactText?: string;
	/** Pin plants: the line of the session the operation has to quote. */
	quote?: string;
}

export interface FoldSession {
	id: string;
	status: "OPEN" | "CLOSED";
	date: string;
	title: string;
	/** The session with its `<!-- plant: ... -->` directives — what the scripted responder reads. */
	annotatedText: string;
	/** The same session without them — what a real model is given. */
	plainText: string;
}

export interface CoreEntrySeed {
	id: string;
	marker: string;
	topic: string;
	section: "Deep Memory" | "Active Items";
	kind: "fact" | "practice" | "item";
	pinned: boolean;
	status?: "open" | "done";
	saved: string;
	text: string;
}

export interface FoldFixture {
	seed: number;
	/** `L1b/current.md` in the v2 storage format. */
	memoryMarkdown: string;
	coreEntries: CoreEntrySeed[];
	sessions: FoldSession[];
	answerKey: Plant[];
	/** Topic titles of the core, in document order. */
	topics: string[];
}

// --- The world ---------------------------------------------------------------

const TOPIC_POOLS: ReadonlyArray<{ title: string; kind: "fact" | "practice"; take: number; pool: readonly string[] }> = [
	{
		title: "Commercial terms",
		kind: "fact",
		take: 5,
		pool: [
			"The Nordwind contract renews annually and legal signs it off before June.",
			"The Berlin pilot is billed as a flat 12k per quarter until the pilot closes.",
			"A discount above 15 percent needs the steering committee, whatever the deal size.",
			"Invoices go out on the first working day of the month, never earlier.",
			"The 2026 budget line for tooling is 84k and is not reopened this year.",
			"Renewals are negotiated three months out, so the notice window never decides the price.",
			"The partner rebate is settled once a year against the audited numbers.",
			"Travel for pilot workshops is billed at cost, without a markup.",
		],
	},
	{
		title: "Working style and preferences",
		kind: "practice",
		take: 4,
		pool: [
			"Commercial summaries are one page, numbers first, prose after.",
			"Meeting notes are shared the same day and in the room, never by mail.",
			"Long drafts are read in the morning; decisions land after lunch.",
			"A recommendation comes with the option that was rejected and why.",
			"Status is told as what changed, not as what was worked on.",
			"Numbers are given with their date, because a figure without one is a rumour.",
		],
	},
	{
		title: "Product decisions",
		kind: "fact",
		take: 5,
		pool: [
			"The CRM migration goes ahead with the in-house adapter rather than the vendor's connector.",
			"The partner portal ships behind a feature flag and is opened account by account.",
			"The retention policy keeps raw events for 90 days and aggregates after that.",
			"The onboarding flow drops its second confirmation step.",
			"The release cadence is every second Thursday, freeze on the Tuesday before.",
			"Rate limits are enforced per account, not per key.",
			"The design tokens are owned by one repository and copied nowhere.",
		],
	},
	{
		title: "People and roles",
		kind: "fact",
		take: 4,
		pool: [
			"The vendor relationship is owned by the commercial lead, not by the project.",
			"The compliance audit is run by the risk team with a monthly checkpoint.",
			"The customer success lead carries the Berlin pilot end to end.",
			"The quarterly deck is signed off by the division head before it is sent.",
			"The support escalation path ends with the on-call engineer, not with the account manager.",
			"Hiring for the Q4 plan is paused until the budget review.",
		],
	},
];

const ACTIVE_ITEM_POOL: readonly string[] = [
	"Reconcile the March invoices against the vendor statement.",
	"Draft the data-retention note the audit asked for.",
	"Collect the pilot feedback into one page before the steering committee.",
	"Decide whether the partner portal opens to the second account this quarter.",
];

const SAVED_DATES = ["2026-06-02", "2026-06-19", "2026-07-08", "2026-07-23", "2026-08-05", "2026-08-21"] as const;

const NOISE_LINES: readonly string[] = [
	"Spent twenty minutes fighting the VPN before the call started (NOISE-01).",
	"Re-ran the export twice because the first one was sorted the wrong way (NOISE-02).",
	"Agreed the weather was better than last week (NOISE-03).",
	"Fixed a typo in the slide title and moved on (NOISE-04).",
	"Confirmed the call link still works (NOISE-05).",
	"Restarted the laptop once, the fans were loud (NOISE-06).",
	"Looked for the old deck in the wrong folder for a while (NOISE-07).",
	"Said goodbye and agreed to pick it up next week (NOISE-08).",
];

// --- The core memory ---------------------------------------------------------

function coreEntries(rand: () => number): CoreEntrySeed[] {
	const entries: CoreEntrySeed[] = [];
	let n = 1;
	const nextId = () => `m-${String(n++).padStart(4, "0")}`;
	for (const topic of TOPIC_POOLS) {
		for (const sentence of shuffled(topic.pool, rand).slice(0, topic.take)) {
			const marker = `CORE-${String(entries.length + 1).padStart(2, "0")}`;
			entries.push({
				id: nextId(),
				marker,
				topic: topic.title,
				section: "Deep Memory",
				kind: topic.kind,
				pinned: false,
				saved: pick(SAVED_DATES, rand),
				text: `- ${sentence} (ref ${marker})`,
			});
		}
	}
	for (const sentence of shuffled(ACTIVE_ITEM_POOL, rand).slice(0, 2)) {
		const marker = `CORE-${String(entries.length + 1).padStart(2, "0")}`;
		entries.push({
			id: nextId(),
			marker,
			topic: "Active Items",
			section: "Active Items",
			kind: "item",
			pinned: false,
			status: "open",
			saved: pick(SAVED_DATES, rand),
			text: `- ${sentence} (ref ${marker})`,
		});
	}
	return entries;
}

/**
 * The one pinned practice of the core: the user's own standing instruction,
 * carrying the must-keep marker that migration reads as a pin. A fold may add
 * beside it and nothing else, which is one of the things the bench scores.
 */
function pinnedPractice(entries: CoreEntrySeed[], rand: () => number): CoreEntrySeed {
	const practices = entries.filter((entry) => entry.kind === "practice");
	const chosen = pick(practices, rand);
	chosen.pinned = true;
	chosen.text = `- **must-keep** ${chosen.text.replace(/^-\s+/, "")}`;
	return chosen;
}

function chronosSection(): string {
	return [
		"<!-- exxeta:l1b schema_version=1 -->",
		"",
		"## Chronos",
		"",
		"- Current scaffold timestamp: 2026-06-01T09:00:00.000Z",
		"- Persistent agent id: fold-bench-room",
		"- Agent display name: Fold Bench Room",
		"- Lifecycle state: ready",
		"- Last checkpoint: cp_20260830T101010Z_bench",
		"- Last consolidation: absorb_20260805T090000Z_bench",
		"- Last approved session: s_20260830T101010Z_bench",
		"",
	].join("\n");
}

function renderCoreMemory(entries: CoreEntrySeed[], sessions: FoldSession[]): string {
	const meta = (entry: CoreEntrySeed) => {
		const fields = [`id=${entry.id}`, `kind=${entry.kind}`, `saved=${entry.saved}`, "from=RC-0000"];
		if (entry.pinned) fields.push("pinned=true");
		if (entry.status) fields.push(`status=${entry.status}`);
		return `<!-- e: ${fields.join(" ")} -->`;
	};
	const next = entries.length + 1;
	const lines: string[] = [chronosSection(), "## Deep Memory", "", `<!-- entries: next=${next} -->`, ""];
	let topic = "";
	for (const entry of entries.filter((e) => e.section === "Deep Memory")) {
		if (entry.topic !== topic) {
			topic = entry.topic;
			lines.push(`### ${topic}`, "");
		}
		lines.push(meta(entry), entry.text, "");
	}
	lines.push("## Active Items", "");
	for (const entry of entries.filter((e) => e.section === "Active Items")) lines.push(meta(entry), entry.text, "");
	lines.push("## Recent Context", "");
	lines.push("The sessions of this run are folded one at a time and are not repeated here.", "");
	for (const session of sessions) lines.push(`- ${session.id} | ${session.status} | ${session.date} | ${session.title}`);
	lines.push("");
	return lines.join("\n");
}

// --- Sessions ----------------------------------------------------------------

interface PlantSpec {
	plant: Plant;
	/** The directive the annotated render writes above the plant's line. */
	directive: string;
}

interface SessionSpec {
	id: string;
	status: "OPEN" | "CLOSED";
	date: string;
	title: string;
	arc: string;
	/** Body lines in order; a plant contributes its directive and its line. */
	body: Array<string | PlantSpec>;
	parked: string;
}

function directive(fields: Record<string, string | undefined>): string {
	const parts = Object.entries(fields)
		.filter(([, value]) => value !== undefined && value !== "")
		.map(([key, value]) => (/[\s"]/.test(String(value)) ? `${key}="${String(value).replace(/"/g, "'")}"` : `${key}=${value}`));
	return `<!-- plant: ${parts.join(" ")} -->`;
}

function renderSession(spec: SessionSpec, annotated: boolean): string {
	const body: string[] = [];
	for (const item of spec.body) {
		if (typeof item === "string") {
			body.push(`- ${item}`);
			continue;
		}
		if (annotated) body.push(item.directive);
		body.push(item.plant.line);
	}
	const num = spec.id.replace(/\D/g, "");
	return [
		`### ${spec.id} | ${spec.status} | ${spec.date} | ${spec.title}`,
		"",
		`<!-- rc_metadata: checkpoint_id=cp_${spec.date.replace(/-/g, "")}T100000Z_s${num}; session_id=s_${spec.date.replace(/-/g, "")}T100000Z_s${num}; conversation_id=c_${num}; density=standard; model=openai-compatible/room-model; approved_at=${spec.date}T10:00:00.000Z -->`,
		"",
		`**Session arc:** ${spec.arc}`,
		"",
		"**Body:**",
		...body,
		"",
		"**Parked:**",
		spec.parked,
		"",
	].join("\n");
}

/** A plant whose line is a bullet of the session body. */
function plantLine(text: string): string {
	return `- ${text}`;
}

interface SessionPlan {
	specs: SessionSpec[];
	answerKey: Plant[];
}

function planSessions(entries: CoreEntrySeed[], rand: () => number): SessionPlan {
	const deepFacts = entries.filter((e) => e.section === "Deep Memory" && e.kind === "fact" && !e.pinned);
	const unpinnedPractices = entries.filter((e) => e.kind === "practice" && !e.pinned);
	const openItems = entries.filter((e) => e.kind === "item");
	const reversalTarget = pick(deepFacts, rand);
	const closeTarget = pick(openItems, rand);
	const pinTarget = pick(unpinnedPractices.length > 0 ? unpinnedPractices : deepFacts, rand);
	const noise = shuffled(NOISE_LINES, rand);
	let noiseAt = 0;
	const answerKey: Plant[] = [];

	const noisePlant = (session: string): PlantSpec => {
		const line = noise[noiseAt++ % noise.length];
		const marker = /\((NOISE-\d+)\)/.exec(line)![1];
		const plant: Plant = { id: marker, kind: "noise", session, marker, line: plantLine(line), expectedOp: "none" };
		answerKey.push(plant);
		return { plant, directive: directive({ id: marker, op: "none" }) };
	};

	const factPlant = (session: string, id: string, topic: string, sentence: string, entryKind: "fact" | "practice" = "fact"): PlantSpec => {
		const marker = `REF-${id}`;
		const plant: Plant = {
			id,
			kind: "fact",
			session,
			marker,
			line: plantLine(`${sentence} (ref ${marker})`),
			expectedOp: "add",
			expectedTopic: topic,
		};
		answerKey.push(plant);
		return { plant, directive: directive({ id, op: "add", kind: entryKind, topic }) };
	};

	const specs: SessionSpec[] = [];

	// RC-0001 — two new facts among ordinary working noise.
	specs.push({
		id: "RC-0001",
		status: "CLOSED",
		date: "2026-09-01",
		title: "Session 1 — renewal window and the portal rollout",
		arc: "Worked through the renewal calendar and then through the portal's rollout order. Two things were settled that outlive the session.",
		body: [
			noisePlant("RC-0001"),
			factPlant("RC-0001", "F01", "Commercial terms", "The Nordwind renewal window closes 60 days before the anniversary, so the notice goes out in April"),
			noisePlant("RC-0001"),
			factPlant("RC-0001", "F02", "Product decisions", "The portal opens to the second account only after a full week without a flagged error"),
		],
		parked: "None",
	});

	// RC-0002 — a reversal of an existing entry, plus one new fact.
	const reversalMarker = "REF-R01";
	const reversalPlant: PlantSpec = {
		plant: {
			id: "R01",
			kind: "reversal",
			session: "RC-0002",
			marker: reversalMarker,
			line: plantLine(`That is now reversed: ${reversalSentence(reversalTarget)} (ref ${reversalMarker})`),
			expectedOp: "supersede",
			expectedTargetId: reversalTarget.id,
			supersedesMarker: reversalTarget.marker,
		},
		directive: directive({ id: "R01", op: "supersede", target: reversalTarget.id }),
	};
	answerKey.push(reversalPlant.plant);
	specs.push({
		id: "RC-0002",
		status: "CLOSED",
		date: "2026-09-02",
		title: "Session 2 — the rule that no longer holds",
		arc: "Revisited a standing rule and replaced it, and picked up one new commitment on the way.",
		body: [
			noisePlant("RC-0002"),
			`Read back the entry that says: ${strip(reversalTarget.text)}`,
			reversalPlant,
			factPlant("RC-0002", "F03", "Commercial terms", "The pilot's flat quarterly fee is held for one more quarter after the pilot closes"),
		],
		parked: "None",
	});

	// RC-0003 — a finished item and a must-keep line.
	const closeMarker = "REF-X01";
	const closePlant: PlantSpec = {
		plant: {
			id: "X01",
			kind: "completion",
			session: "RC-0003",
			marker: closeMarker,
			line: plantLine(`Done: ${strip(closeTarget.text)} — finished and checked (ref ${closeMarker})`),
			expectedOp: "close",
			expectedTargetId: closeTarget.id,
		},
		directive: directive({ id: "X01", op: "close", target: closeTarget.id }),
	};
	answerKey.push(closePlant.plant);
	const mustKeepSentence = "**must-keep** The Berlin pilot invoice for Q3 is 41,250 EUR and is due on 2026-10-15 (ref REF-K01).";
	const mustKeepPlant: PlantSpec = {
		plant: {
			id: "K01",
			kind: "mustkeep",
			session: "RC-0003",
			marker: "REF-K01",
			line: plantLine(mustKeepSentence),
			expectedOp: "add",
			expectedTopic: "Commercial terms",
			exactText: mustKeepSentence,
		},
		directive: directive({ id: "K01", op: "add", kind: "fact", topic: "Commercial terms", mustkeep: "true" }),
	};
	answerKey.push(mustKeepPlant.plant);
	specs.push({
		id: "RC-0003",
		status: "CLOSED",
		date: "2026-09-03",
		title: "Session 3 — one loop closed, one number to keep",
		arc: "Closed an open loop and wrote down a number the user asked to keep exactly as it stands.",
		body: [noisePlant("RC-0003"), closePlant, mustKeepPlant, noisePlant("RC-0003")],
		parked: "None",
	});

	// RC-0004 — chatter.
	const dropReason = "the session is tool trouble and small talk; nothing in it outlives the sitting";
	const dropPlant: PlantSpec = {
		plant: {
			id: "D01",
			kind: "chatter",
			session: "RC-0004",
			marker: "REF-D01",
			line: plantLine("Agreed to look at it again when the export finishes (ref REF-D01)."),
			expectedOp: "drop",
		},
		directive: directive({ id: "D01", op: "drop", reason: dropReason }),
	};
	answerKey.push(dropPlant.plant);
	specs.push({
		id: "RC-0004",
		status: "CLOSED",
		date: "2026-09-04",
		title: "Session 4 — export trouble",
		arc: "An export refused to finish and most of the sitting went on it. Nothing was decided.",
		body: [noisePlant("RC-0004"), noisePlant("RC-0004"), dropPlant, noisePlant("RC-0004")],
		parked: "None",
	});

	// RC-0005 — the first half of the cross-session correction.
	const oldValue = "The audit checkpoint is monthly, on the first Tuesday";
	const correctionOld: PlantSpec = {
		plant: {
			id: "C01",
			kind: "correction-old",
			session: "RC-0005",
			marker: "REF-C01",
			line: plantLine(`${oldValue} (ref REF-C01, VALUE-OLD-C01).`),
			expectedOp: "add",
			expectedTopic: "People and roles",
		},
		directive: directive({ id: "C01", op: "add", kind: "fact", topic: "People and roles" }),
	};
	answerKey.push(correctionOld.plant);
	specs.push({
		id: "RC-0005",
		status: "CLOSED",
		date: "2026-09-05",
		title: "Session 5 — the audit rhythm",
		arc: "Settled how often the audit checkpoint runs and who is in the room for it.",
		body: [noisePlant("RC-0005"), correctionOld, noisePlant("RC-0005")],
		parked: "None",
	});

	// RC-0006 — the user asks for an entry to be pinned, plus one new fact.
	const quote = "please pin that one, I do not want it rewritten";
	const pinPlant: PlantSpec = {
		plant: {
			id: "P01",
			kind: "pin",
			session: "RC-0006",
			marker: "REF-P01",
			line: plantLine(`The user said: "${quote}" about the entry that reads "${strip(pinTarget.text)}" (ref REF-P01).`),
			expectedOp: "pin",
			expectedTargetId: pinTarget.id,
			quote,
		},
		directive: directive({ id: "P01", op: "pin", target: pinTarget.id, quote }),
	};
	answerKey.push(pinPlant.plant);
	specs.push({
		id: "RC-0006",
		status: "CLOSED",
		date: "2026-09-06",
		title: "Session 6 — one entry the user wants left alone",
		arc: "Went through the working-style entries and the user asked for one of them to be left exactly as it is.",
		body: [
			noisePlant("RC-0006"),
			pinPlant,
			factPlant("RC-0006", "F04", "Working style and preferences", "A number in a summary is given with the date it was measured", "practice"),
		],
		parked: "None",
	});

	// RC-0007 — the correction: the later value wins.
	const newValue = "The audit checkpoint moved to fortnightly after the first findings";
	const correctionNew: PlantSpec = {
		plant: {
			id: "C02",
			kind: "correction-new",
			session: "RC-0007",
			marker: "REF-C02",
			line: plantLine(`Correction to what was said on ${specs[4].date}: ${newValue} (ref REF-C02, VALUE-NEW-C02).`),
			expectedOp: "supersede",
			expectedTargetMarker: "REF-C01",
			supersedesMarker: "VALUE-OLD-C01",
		},
		directive: directive({ id: "C02", op: "supersede", target: "@REF-C01" }),
	};
	answerKey.push(correctionNew.plant);
	specs.push({
		id: "RC-0007",
		status: "CLOSED",
		date: "2026-09-07",
		title: "Session 7 — the audit rhythm, corrected",
		arc: "The rhythm agreed two sessions ago did not survive the first findings, and the newer arrangement replaces it.",
		body: [noisePlant("RC-0007"), correctionNew, noisePlant("RC-0007")],
		parked: "None",
	});

	// RC-0008 — chatter again, so a run never scores a lucky single drop.
	const dropReason2 = "the session repeats what memory already holds and settles nothing new";
	const dropPlant2: PlantSpec = {
		plant: {
			id: "D02",
			kind: "chatter",
			session: "RC-0008",
			marker: "REF-D02",
			line: plantLine("Walked through the same renewal dates once more, no change (ref REF-D02)."),
			expectedOp: "drop",
		},
		directive: directive({ id: "D02", op: "drop", reason: dropReason2 }),
	};
	answerKey.push(dropPlant2.plant);
	specs.push({
		id: "RC-0008",
		status: "OPEN",
		date: "2026-09-08",
		title: "Session 8 — a walk through what is already known",
		arc: "Re-read the renewal dates and the portal plan without changing either.",
		body: [noisePlant("RC-0008"), dropPlant2, noisePlant("RC-0008")],
		parked: "None",
	});

	return { specs, answerKey };
}

/** An entry's text as one quotable sentence: no bullet, no marker, no must-keep. */
function strip(text: string): string {
	return text.replace(/^-\s+/, "").replace(/\*\*must-keep\*\*\s*/i, "").replace(/\s*\(ref [A-Z]+-\d+\)/, "").trim().replace(/\.$/, "");
}

/** The reversal a session records against an existing entry, in the entry's own subject. */
function reversalSentence(target: CoreEntrySeed): string {
	return `${strip(target.text)} no longer holds, and the opposite is now the rule`;
}

// --- The fixture -------------------------------------------------------------

export const FOLD_FIXTURE_DEFAULT_SEED = 20260912;

export function buildFoldFixture(opts: { seed?: number } = {}): FoldFixture {
	const seed = opts.seed ?? FOLD_FIXTURE_DEFAULT_SEED;
	const rand = mulberry32(seed);
	const entries = coreEntries(rand);
	pinnedPractice(entries, rand);
	const { specs, answerKey } = planSessions(entries, rand);
	const sessions: FoldSession[] = specs.map((spec) => ({
		id: spec.id,
		status: spec.status,
		date: spec.date,
		title: spec.title,
		annotatedText: renderSession(spec, true),
		plainText: renderSession(spec, false),
	}));
	return {
		seed,
		memoryMarkdown: renderCoreMemory(entries, sessions),
		coreEntries: entries,
		sessions,
		answerKey,
		topics: [...new Set(entries.map((entry) => entry.topic))],
	};
}

// --- Reading the directives (the scripted responder's eyes) ------------------

export interface PlantDirective {
	id: string;
	op: PlantedOp;
	kind?: string;
	topic?: string;
	target?: string;
	quote?: string;
	reason?: string;
	mustkeep?: string;
	/** The session line the directive introduces, without its leading "- ". */
	line: string;
}

const DIRECTIVE_LINE = /^\s*<!--\s*plant:\s*([\s\S]*?)\s*-->\s*$/;
const DIRECTIVE_FIELD = /([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|(\S+))/g;

/**
 * Every `<!-- plant: ... -->` of a session, each with the line it introduces.
 * A session rendered plain yields none, which is exactly what a real model run
 * needs: the scripted responder cannot answer a session it was not told about.
 */
export function readPlantDirectives(sessionText: string): PlantDirective[] {
	const lines = sessionText.split(/\r\n?|\n/);
	const out: PlantDirective[] = [];
	for (let i = 0; i < lines.length; i++) {
		const match = DIRECTIVE_LINE.exec(lines[i]);
		if (!match) continue;
		const fields: Record<string, string> = {};
		for (const field of match[1].matchAll(DIRECTIVE_FIELD)) fields[field[1]] = field[2] ?? field[3] ?? "";
		let line = "";
		for (let j = i + 1; j < lines.length; j++) {
			if (!lines[j].trim() || DIRECTIVE_LINE.test(lines[j])) continue;
			line = lines[j].replace(/^\s*[-*+]\s+/, "").trim();
			break;
		}
		out.push({
			id: fields.id ?? "",
			op: (fields.op ?? "none") as PlantedOp,
			...(fields.kind ? { kind: fields.kind } : {}),
			...(fields.topic ? { topic: fields.topic } : {}),
			...(fields.target ? { target: fields.target } : {}),
			...(fields.quote ? { quote: fields.quote } : {}),
			...(fields.reason ? { reason: fields.reason } : {}),
			...(fields.mustkeep ? { mustkeep: fields.mustkeep } : {}),
			line,
		});
	}
	return out;
}

// --- Standalone use ----------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
	const seedArg = process.argv.indexOf("--seed");
	const fixture = buildFoldFixture({ seed: seedArg > -1 ? Number(process.argv[seedArg + 1]) : undefined });
	const what = process.argv.includes("--sessions") ? "sessions" : process.argv.includes("--key") ? "key" : "memory";
	if (what === "memory") process.stdout.write(fixture.memoryMarkdown);
	else if (what === "sessions") process.stdout.write(fixture.sessions.map((s) => (process.argv.includes("--plain") ? s.plainText : s.annotatedText)).join("\n"));
	else process.stdout.write(`${JSON.stringify(fixture.answerKey, null, 2)}\n`);
}
