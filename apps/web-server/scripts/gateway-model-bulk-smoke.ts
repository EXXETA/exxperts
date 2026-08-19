// Smoke for the gateway model approval list's bulk edits and its two-halves
// draft model (apps/web-ui/src/gateway-model-bulk.ts).
//
// The list this backs is the one a company LiteLLM key opens: fifty-four models
// in one scroller. So the drafts here are fifty-four too, not three, because
// the properties that matter at this size are the ones a three-row fixture
// cannot see: that a bulk edit reaches every approved model and stops at the
// unapproved ones, that it leaves the fields it was not asked about alone, and
// that it never mutates the array it was handed. On top of that, the draft now
// carries capabilities as override plus detection, so this also proves the
// display resolution (override over detection over default) and that trusting
// detection clears exactly the overrides the gateway can speak for.
//
// Run: node scripts/run-smokes.mjs gateway-model-bulk   (or tsx this file)

import { applyToApproved, approvedCount, detectionAnswers, draftEffective, setAllApproved, trustDetected, type BulkDetection, type BulkDraftFields } from "../../web-ui/src/gateway-model-bulk.js";

type Draft = BulkDraftFields & { id: string; label?: string };

let failures = 0;
function fail(message: string) {
	failures += 1;
	console.error(`FAIL: ${message}`);
}
function check(condition: unknown, message: string) {
	if (!condition) fail(message);
}

const DEFAULT_WINDOW = 128000;
const MODEL_COUNT = 54;
function syntheticDrafts(): Draft[] {
	return Array.from({ length: MODEL_COUNT }, (_, index) => ({
		id: `gateway/model-${String(index).padStart(2, "0")}`,
		// Every third model starts unapproved, so "approved only" has something
		// to fail on in both directions.
		approved: index % 3 !== 0,
		webSearch: false,
		detected: null,
		...(index === 7 ? { label: "A migrated gateway's saved name" } : {}),
	}));
}

const drafts = syntheticDrafts();
check(drafts.length === MODEL_COUNT, `the fixture should carry ${MODEL_COUNT} models, has ${drafts.length}`);
const startingApproved = approvedCount(drafts);
check(startingApproved === 36, `the fixture should start with 36 approved models, has ${startingApproved}`);

// Approve all, then none: the toggle has to reach every row, both ways.
const allOn = setAllApproved(drafts, true);
check(approvedCount(allOn) === MODEL_COUNT, `approve all left ${approvedCount(allOn)} of ${MODEL_COUNT} approved`);
const allOff = setAllApproved(drafts, false);
check(approvedCount(allOff) === 0, `approve none left ${approvedCount(allOff)} approved`);
check(approvedCount(drafts) === startingApproved, "a bulk toggle mutated the drafts it was handed");
check(allOn.length === MODEL_COUNT && allOff.length === MODEL_COUNT, "a bulk toggle changed how many models are on screen");

// With no override and no detection, a draft resolves to the documented
// defaults: no images, no reasoning, the default window as text.
const restingEffective = draftEffective(drafts[0]!, DEFAULT_WINDOW);
check(!restingEffective.vision && !restingEffective.reasoning, "an untouched draft resolved to a capability being on");
check(restingEffective.contextWindow === String(DEFAULT_WINDOW), `an untouched draft resolved its window to ${restingEffective.contextWindow}`);

// Images on for every approved model, and nowhere else. An unapproved model is
// not being saved, so rewriting it would only be a surprise later.
const visionOn = applyToApproved(drafts, { vision: true });
for (let index = 0; index < MODEL_COUNT; index += 1) {
	const before = drafts[index]!;
	const after = visionOn[index]!;
	check(after.vision === (before.approved ? true : undefined), `${after.id}: vision is ${after.vision} but approved is ${before.approved}`);
	check(after.approved === before.approved, `${after.id}: an images edit changed whether it is approved`);
	check(after.webSearch === false && after.reasoning === undefined, `${after.id}: an images edit touched another capability`);
	check(after.contextWindow === undefined, `${after.id}: an images edit touched the context window`);
	check(after.id === before.id, `row ${index}: a bulk edit reordered or renamed the models`);
}
check(drafts.every((draft) => draft.vision === undefined), "applying images mutated the drafts it was handed");
check(visionOn[7]!.label === "A migrated gateway's saved name", "a bulk edit dropped a saved display name");

// Web search and reasoning stack on top of images rather than replacing it,
// which is how somebody actually uses these: one column at a time.
const stacked = applyToApproved(applyToApproved(visionOn, { webSearch: true }), { reasoning: true });
const approvedRows = stacked.filter((draft) => draft.approved);
check(approvedRows.length === startingApproved, `stacking bulk edits changed the approved count to ${approvedRows.length}`);
check(approvedRows.every((draft) => draft.vision && draft.webSearch && draft.reasoning), "stacking bulk edits lost an earlier column");
check(stacked.filter((draft) => !draft.approved).every((draft) => !draft.vision && !draft.webSearch && !draft.reasoning), "a bulk edit reached an unapproved model");

// Turning a column back off is the same control, and must not take the others
// with it. Off is an override too, not a return to "unspoken".
const searchOff = applyToApproved(stacked, { webSearch: false });
check(searchOff.filter((draft) => draft.approved).every((draft) => draft.vision && !draft.webSearch && draft.reasoning), "turning web search off took another column with it");
const visionOffAgain = applyToApproved(stacked, { vision: false });
check(visionOffAgain.filter((draft) => draft.approved).every((draft) => draft.vision === false), "bulk off should record an explicit false, not clear the choice");

// ---- bulk on respects an explicit denial ----------------------------------
// Turning images or reasoning on for the whole list skips a model whose
// gateway declaration is an explicit false for that field: a list-wide switch
// must not force a capability onto a model the gateway ruled out. Only a
// declared false counts; null is "not answered" and a declared true obviously
// welcomes it. Off reaches everything, and web search ignores declarations in
// both directions.
const declared: Draft[] = [
	{ id: "g/denied-both", approved: true, webSearch: false, detected: { vision: false, webSearch: false, reasoning: false, contextWindow: null } },
	{ id: "g/welcomes-both", approved: true, webSearch: false, detected: { vision: true, webSearch: true, reasoning: true, contextWindow: null } },
	{ id: "g/unanswered", approved: true, webSearch: false, detected: { vision: null, webSearch: null, reasoning: null, contextWindow: null } },
	{ id: "g/never-probed", approved: true, webSearch: false, detected: null },
	{ id: "g/denied-unapproved", approved: false, webSearch: false, detected: { vision: false, webSearch: false, reasoning: false, contextWindow: null } },
];
const declaredVisionOn = applyToApproved(declared, { vision: true });
check(declaredVisionOn[0]!.vision === undefined, "images on wrote an override onto a model whose gateway declared no images");
check(declaredVisionOn[0] === declared[0], "a fully skipped row should come back untouched, not rebuilt");
check(declaredVisionOn[1]!.vision === true && declaredVisionOn[2]!.vision === true && declaredVisionOn[3]!.vision === true, "images on should reach declared-true, unanswered and never-probed models alike");
check(declaredVisionOn[4]!.vision === undefined, "images on reached an unapproved model");
const declaredReasoningOn = applyToApproved(declared, { reasoning: true });
check(declaredReasoningOn[0]!.reasoning === undefined, "reasoning on wrote an override onto a model whose gateway declared no reasoning");
check(declaredReasoningOn[1]!.reasoning === true && declaredReasoningOn[2]!.reasoning === true && declaredReasoningOn[3]!.reasoning === true, "reasoning on should reach declared-true, unanswered and never-probed models alike");
const declaredBothOff = applyToApproved(applyToApproved(declared, { vision: false }), { reasoning: false });
check(declaredBothOff.filter((draft) => draft.approved).every((draft) => draft.vision === false && draft.reasoning === false), "off must reach every approved model, declarations included");
const declaredSearchOn = applyToApproved(declared, { webSearch: true });
check(declaredSearchOn.filter((draft) => draft.approved).every((draft) => draft.webSearch === true), "web search on must ignore declarations, a declared false included");
check(declaredSearchOn[4]!.webSearch === false, "web search on reached an unapproved model");
check(applyToApproved(declaredSearchOn, { webSearch: false }).filter((draft) => draft.approved).every((draft) => draft.webSearch === false), "web search off must reach every approved model");
check(declared.every((draft) => draft.vision === undefined && draft.reasoning === undefined && draft.webSearch === false), "the declaration checks mutated the drafts they were handed");

// The context window applies as the typed string, so the row shows exactly what
// was typed and the existing per-row validation reads the same value.
const windowed = applyToApproved(stacked, { contextWindow: "200000" });
check(windowed.filter((draft) => draft.approved).every((draft) => draft.contextWindow === "200000"), "the context window did not reach every approved model");
check(windowed.filter((draft) => !draft.approved).every((draft) => draft.contextWindow === undefined), "the context window reached an unapproved model");

// Approving the rest afterwards leaves the newly approved rows on their own
// defaults: the bulk controls apply at the moment they are pressed, and saying
// otherwise would be the silent-defaults problem again.
const thenAllApproved = setAllApproved(windowed, true);
check(approvedCount(thenAllApproved) === MODEL_COUNT, "approving the rest after a bulk edit did not approve them");
check(thenAllApproved.filter((draft) => draft.contextWindow === undefined).length === MODEL_COUNT - startingApproved, "approving the rest rewrote windows it should have left alone");

// ---- override over detection over default ---------------------------------
const detectedRow: Draft = { id: "g/detected", approved: true, webSearch: false, detected: { vision: true, webSearch: true, reasoning: false, contextWindow: 1000000 } };
const detectedEffective = draftEffective(detectedRow, DEFAULT_WINDOW);
check(detectedEffective.vision === true, "a detected capability should show without any override");
check(detectedEffective.reasoning === false, "a detected false should show as off");
check(detectedEffective.contextWindow === "1000000", `a detected window should show, got ${detectedEffective.contextWindow}`);
// The tick is the exception: a gateway declaring web search never turns it on.
check(detectedRow.webSearch === false, "a detection must never pre-tick web search");
const overriddenRow: Draft = { ...detectedRow, vision: false, contextWindow: "128000" };
const overriddenEffective = draftEffective(overriddenRow, DEFAULT_WINDOW);
check(overriddenEffective.vision === false, "an explicit false override must beat a detected true");
check(overriddenEffective.contextWindow === "128000", "a window override must beat a detected window");
check(detectionAnswers(detectedRow.detected) && !detectionAnswers(null), "detectionAnswers should see answers and their absence");
check(!detectionAnswers({ vision: null, webSearch: null, reasoning: null, contextWindow: null }), "an all-null detection answers nothing");

// ---- trusting detection ----------------------------------------------------
// The state a migrated gateway leaves behind: every field pinned as an
// override, detection freshly loaded beside it. Trusting detection clears the
// overrides the gateway answers for, adopts the tick it declares, and leaves
// everything else exactly as it was.
const answered: BulkDetection = { vision: true, webSearch: true, reasoning: true, contextWindow: 200000 };
const pinned: Draft[] = [
	// Fully pinned, fully answered: every override goes, the tick adopts.
	{ id: "g/full", approved: true, webSearch: false, vision: false, reasoning: false, contextWindow: "128000", detected: answered },
	// Unapproved, to prove trusting reaches past the approved set.
	{ id: "g/unapproved", approved: false, webSearch: false, vision: false, reasoning: false, contextWindow: "128000", detected: { vision: true, webSearch: null, reasoning: true, contextWindow: null } },
	// Answered about images only: the other overrides are not the gateway's to
	// clear, because clearing them would land on the default, not a detection.
	{ id: "g/partial", approved: true, webSearch: false, vision: false, reasoning: false, contextWindow: "64000", detected: { vision: true, webSearch: null, reasoning: null, contextWindow: null } },
	// Answered about nothing at all, which must be the same as saying nothing.
	{ id: "g/silent", approved: true, webSearch: false, vision: false, detected: { vision: null, webSearch: null, reasoning: null, contextWindow: null } },
	// Never probed at all.
	{ id: "g/unprobed", approved: true, webSearch: false, vision: false, detected: null },
];
const trusted = trustDetected(pinned);
check(trusted.length === pinned.length, "trusting detection changed how many models are on screen");
check(pinned[0]!.vision === false && pinned[0]!.contextWindow === "128000", "trusting detection mutated the drafts it was handed");

const full = trusted[0]!;
check(full.vision === undefined && full.reasoning === undefined && full.contextWindow === undefined, `${full.id}: trusting detection should clear answered overrides, got ${JSON.stringify(full)}`);
check(full.webSearch === true, `${full.id}: the explicit click should adopt the declared tick`);
check(full.approved === pinned[0]!.approved, `${full.id}: trusting detection changed whether it is approved`);
const fullEffective = draftEffective(full, DEFAULT_WINDOW);
check(fullEffective.vision === true && fullEffective.contextWindow === "200000", `${full.id}: after trusting, the row should read as detected`);

const unapproved = trusted[1]!;
check(unapproved.vision === undefined && unapproved.reasoning === undefined, `${unapproved.id}: trusting detection stopped at an unapproved model`);
check(unapproved.contextWindow === "128000", `${unapproved.id}: an unanswered window override was cleared`);

const partial = trusted[2]!;
check(partial.vision === undefined, `${partial.id}: the one answered override was not cleared`);
check(partial.reasoning === false && partial.contextWindow === "64000", `${partial.id}: an unanswered override was cleared`);
check(partial.webSearch === false, `${partial.id}: an unanswered tick was rewritten`);

check(trusted[3] === pinned[3], "a detection that answered nothing still replaced the row");
check(trusted[4] === pinned[4], "a row that was never probed was rewritten");

// Trusting twice is the same as trusting once, and a hand-edit made after
// trusting is a fresh override the next press clears again by design.
const twice = trustDetected(trusted);
check(twice[0]!.vision === undefined && twice[0]!.webSearch === true, "trusting detection twice changed the outcome");

check(trustDetected([]).length === 0, "trusting detection invented a model");

// An empty list must not pretend everything in it is approved.
check(approvedCount([]) === 0, "an empty list reported approved models");
check(setAllApproved([], true).length === 0, "approve all invented a model");

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("gateway-model-bulk smoke: all checks passed");
