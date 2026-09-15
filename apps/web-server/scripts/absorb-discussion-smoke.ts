import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-absorb-discussion-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const smokeAppDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(smokeAppDir, { recursive: true });
fs.writeFileSync(
	path.join(smokeAppDir, "openai-compatible-ai-profile.json"),
	JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }, { modelId: "claude-opus-4.6" }], maintenanceModel: "claude-opus-4.6" }, null, 2),
);
fs.writeFileSync(path.join(smokeAppDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-absorb-discussion-"));
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const {
	createPersistentAgentFromScaffoldInput,
	buildAbsorbDiscussionSignoff,
	buildAbsorbDiscussionTurn,
	buildAbsorbProposal,
	fingerprintL1bSource,
	getAbsorbAvailability,
} = await import("../src/persistent-agents.js");
const { getAbsorbModelLock } = await import("../src/persistent-agent-ai-profiles.js");
const { ABSORB_HANDOFF_SHED_ORDER, describeHandoffTrim, DISCUSSION_HANDOFF_MAX_CHARS, DISCUSSION_HANDOFF_TRIM_MARKER, DISCUSSION_TRANSCRIPT_TRIM_MARKER, fitDiscussionHandoff } = await import("../src/discussion-handoff.js");
const ABSORB_MODEL = getAbsorbModelLock("openai-compatible");

const agentId = "absorb-discussion-smoke-room";
const {
	ABSORB_EMPTY_RECENT_CONTEXT_PLACEHOLDER,
	buildAbsorbDiscussionPrompt,
	buildSectionPurposeMap,
	extractTopLevelSectionBody,
} = await import("../src/absorb-consolidation.js");

const agentRoot = path.join(root, agentId);
const l1bPath = path.join(agentRoot, "L1b", "current.md");
const registryPath = path.join(agentRoot, "section_registry.json");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function readL1b(): string {
	return fs.readFileSync(l1bPath, "utf-8");
}

function rcEntry(index: number, extraBody = ""): string {
	return `### RC-${String(index).padStart(4, "0")} | OPEN | 2026-05-20 | Absorb discussion smoke ${index}\n\n**Session arc:** Smoke session ${index} produced durable absorb-discussion signal.\n\n**Body:**\n- Durable discussion understanding ${index} should be considered for Deep Memory.\n- Active follow-up ${index} should be considered for Active Items.\n${extraBody}\n\n**Parked:**\nFollow-up ${index} remains open.\n`;
}

function setRecentContextEntries(count: number, extraBody = ""): void {
	const base = readL1b();
	const match = /^##\s+Recent Context\s*$/m.exec(base);
	assert(match?.index != null, "scaffold L1b should include Recent Context");
	const start = match.index + match[0].length;
	const entries = Array.from({ length: count }, (_, i) => rcEntry(i + 1, extraBody)).join("\n");
	const updated = `${base.slice(0, start)}\n\n${entries || ABSORB_EMPTY_RECENT_CONTEXT_PLACEHOLDER}\n`;
	fs.writeFileSync(l1bPath, updated, "utf-8");
}

const assessmentMarkdown = `## Absorb assessment\n\nI found 5 Recent Context entries. Here is the proposed direction.\n\n### What to remember\n- The discussion path should preserve user guidance before proposal generation.\n- Absorb discussion must remain non-mutating.\n\n### What to forget\n- Repeated smoke-test chatter.\n- Completed mechanical details.\n\n### What changes in stable memory\n- Deep Memory: preserve durable discussion workflow decisions.\n- Active Items: track backend discussion implementation as current work.\n- Recent Context: all entries are expected to be cleared after approval.\n\n### Needs your judgment\n- None\n`;

const discussionReply = "The durable signal is the discussion workflow boundary; repeated smoke details can be cleared.";

// Memory v2: the sign-off is structured, because every fold call carries it.
const signoffMarkdown = `## Memorize discussion signoff\n\n### Pin\n- m-0007\n\n### Drop\n- RC-0003 — the user asked to forget the tooling detour\n\n### Corrections\n- Preserve the backend-only discussion operator boundary.\n\n### Topics\n- create: Operator boundaries\n\n### Instructions\n- Keep discussion and proposal operators separate.\n`;

// The handoff TRIMMER is section-aware and its shed order names the prose
// sections a sign-off used to carry. A v2 sign-off is a bounded list and never
// reaches the cap, so the trim family below drives the trimmer with a
// prose-shaped handoff on purpose: it is the shape the shed order is written
// for, and the step accepts whatever a worker returns.
const legacySignoffMarkdown = `## Absorb discussion signoff\n\n### User guidance\n- Preserve the backend-only discussion operator boundary.\n\n### Learn / memorize\n- Discussion signoff should hand off to a separate proposal operator.\n\n### Clear / forget\n- Repeated smoke-test details can be cleared.\n\n### Update existing memory\n- Sharpen absorb workflow state around deliberative discussion.\n\n### Needs judgment\n- None\n\n### Transcript summary\nThe discussion confirmed that signoff should produce a bounded handoff, not a Candidate L1b.\n`;

function candidateL1b(): string {
	// Chronos is system-managed: a faithful candidate carries the source's
	// Chronos through unchanged, so the fixture splices it from the live L1b.
	const chronos = extractTopLevelSectionBody(readL1b(), "Chronos");
	if (chronos == null) throw new Error("source L1b should have a Chronos section");
	return `<!-- exxeta:l1b schema_version=1 -->\n\n## Chronos\n\n${chronos.trim()}\n\n## Deep Memory\n\n- Synthetic user is validating persistence-native personalized agents inside exxperts.\n- Absorb discussion smoke durable understanding has been consolidated into stable memory.\n\n## Active Items\n\n### High Priority\n\n- Continue absorb discussion backend implementation.\n\n### Medium Priority\n\n- Keep discussion and proposal operators separate.\n\n### Low Priority\n\n- Add frontend discussion UX in a later MR.\n\n## Recent Context\n\n${ABSORB_EMPTY_RECENT_CONTEXT_PLACEHOLDER}\n`;
}

function proposalFixture(candidate = candidateL1b()): string {
	return `## Memory Absorption Proposal\n\n### Mode\nRC_CONSOLIDATION\n\n### Primacy Map\nThe RC chain captures absorb discussion backend implementation and operator-boundary decisions.\n\n### Section-Level Change Log\n| Section | Prior Words | Candidate Words | Action | Rationale |\n|---|---:|---:|---|---|\n| Deep Memory | 20 | 28 | sharpen | Preserve durable discussion architecture direction. |\n| Active Items | 20 | 26 | update | Preserve live implementation thread. |\n| Recent Context | 200 | 4 | clear | Strict absorb clears RC entries. |\n\n### Entry-Level Detail\n| Entry / Block | Operation | Target Section | Rationale |\n|---|---|---|---|\n| RC-0001..RC-0005 | consolidate | Deep Memory / Active Items | Durable signal survives outside RC. |\n\n### Compression Metrics\n- RC input words: 200\n- RC removed words: 200\n- RC removed percent: 100%\n- Stable memory words before: 80\n- Stable memory words after: 90\n- Stable memory delta: +10\n- Compression ratio: 2.2\n\n### Warnings\nNone\n\n### Candidate L1b\n${candidate}`;
}

async function expectThrowsAsync(fn: () => Promise<unknown>, expected: RegExp, label: string): Promise<void> {
	try {
		await fn();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		assert(expected.test(message), `${label}: expected ${expected}, got ${message}`);
		return;
	}
	throw new Error(`${label}: expected error`);
}

try {
	createPersistentAgentFromScaffoldInput({
		displayName: "Absorb Discussion Smoke Room",
		userName: "Synthetic User",
		preferredUserAddress: "Synthetic User",
	});
	assert(fs.existsSync(l1bPath), "scaffold should create L1b/current.md");
	setRecentContextEntries(5);
	assert(getAbsorbAvailability(agentId).available, "5 RC entries should make absorb available");

	const sourceL1b = readL1b();
	const sourceFingerprint = fingerprintL1bSource(sourceL1b);
	const registry = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
	const promptAssembly = buildAbsorbDiscussionPrompt({
		agentId: agentId,
		l1b: sourceL1b,
		model: ABSORB_MODEL,
		sectionPurposeMap: buildSectionPurposeMap(registry),
		assessmentMarkdown,
		messages: [],
		userMessage: "Can we preserve the operator-boundary decision?",
		sourceFingerprint,
		mode: "turn",
	});
	assert(promptAssembly.prompt.includes("absorb discussion operator"), "discussion prompt should identify discussion operator");
	assert(promptAssembly.prompt.includes("No Candidate L1b generation as the official proposal"), "discussion prompt should forbid official Candidate L1b generation");
	assert(!promptAssembly.prompt.includes("# Absorb Discussion Smoke Room Constitution"), "discussion prompt should not inject L1a constitution text");
	assert(promptAssembly.tokenBudget.state === "ok", "normal discussion prompt should be within budget");

	let turnGeneratorCalled = false;
	const turnResponse = await buildAbsorbDiscussionTurn({
		agentId,
		source: { l1bFingerprint: sourceFingerprint },
		assessmentMarkdown,
		messages: [],
		userMessage: "Can we preserve the operator-boundary decision?",
	}, ABSORB_MODEL, async (prompt, model) => {
		turnGeneratorCalled = true;
		assert(prompt.includes("## Task: Absorb Discussion Turn"), "turn builder should pass turn task to generator");
		assert(model.provider === ABSORB_MODEL.provider && model.model === ABSORB_MODEL.model, "discussion turn should use system-selected absorb model");
		return { text: discussionReply, usage: { input: 10, output: 5, totalTokens: 15, cost: 0 } };
	});
	assert(turnGeneratorCalled, "discussion turn should call generator");
	assert(turnResponse.writesMemory === false, "discussion turn should be non-mutating");
	assert(turnResponse.process.type === "absorb-discussion-worker", "discussion turn should identify discussion worker");
	assert(turnResponse.message.role === "assistant", "discussion turn should return assistant message");
	assert(turnResponse.message.content === discussionReply, "discussion turn should return generated whole message");
	assert(readL1b() === sourceL1b, "discussion turn must not mutate L1b");

	let signoffGeneratorCalled = false;
	const signoffResponse = await buildAbsorbDiscussionSignoff({
		agentId,
		source: { l1bFingerprint: sourceFingerprint },
		assessmentMarkdown,
		messages: [
			{ role: "user", content: "Preserve the operator-boundary decision." },
			{ role: "assistant", content: discussionReply },
		],
	}, ABSORB_MODEL, async (prompt, model) => {
		signoffGeneratorCalled = true;
		assert(prompt.includes("## Task: Memorize Discussion Signoff"), "signoff builder should pass the structured signoff task to generator");
		assert(prompt.includes("### Pin") && prompt.includes("### Drop") && prompt.includes("### Corrections"), "signoff prompt should ask for the structured sections the fold reads");
		assert(model.provider === ABSORB_MODEL.provider && model.model === ABSORB_MODEL.model, "discussion signoff should use system-selected absorb model");
		return { text: signoffMarkdown, usage: { input: 20, output: 15, totalTokens: 35, cost: 0 } };
	});
	assert(signoffGeneratorCalled, "discussion signoff should call generator");
	assert(signoffResponse.writesMemory === false, "discussion signoff should be non-mutating");
	assert(signoffResponse.assessmentHandoff.source === "discussion_signoff", "signoff should return discussion_signoff handoff source");
	assert(signoffResponse.assessmentHandoff.text.includes("## Memorize discussion signoff"), "signoff should return handoff markdown");
	// The same sign-off read as the fields every fold call honours.
	assert(signoffResponse.guidance.pin.join(",") === "m-0007", `signoff should return the pins the user asked for, got ${JSON.stringify(signoffResponse.guidance.pin)}`);
	assert(signoffResponse.guidance.drop.length === 1 && signoffResponse.guidance.drop[0].session === "RC-0003" && /tooling detour/.test(signoffResponse.guidance.drop[0].reason), `signoff should return the dropped session with its reason, got ${JSON.stringify(signoffResponse.guidance.drop)}`);
	assert(JSON.stringify(signoffResponse.guidance.topics) === JSON.stringify([{ create: "Operator boundaries" }]), `signoff should return topic changes in the wire shape, got ${JSON.stringify(signoffResponse.guidance.topics)}`);
	assert(signoffResponse.guidance.corrections.length === 1 && signoffResponse.guidance.instructions.length === 1, `signoff should return corrections and instructions, got ${JSON.stringify(signoffResponse.guidance)}`);
	assert(readL1b() === sourceL1b, "discussion signoff must not mutate L1b");

	const proposalResponse = await buildAbsorbProposal({
		agentId,
		assessmentMarkdown,
		assessmentHandoff: signoffResponse.assessmentHandoff,
		source: { l1bFingerprint: sourceFingerprint },
	}, ABSORB_MODEL, async (prompt, model) => {
		assert(prompt.includes("Source: discussion_signoff"), "proposal prompt should include discussion signoff handoff source");
		assert(prompt.includes("Preserve the backend-only discussion operator boundary"), "proposal prompt should include handoff text");
		assert(model.provider === ABSORB_MODEL.provider && model.model === ABSORB_MODEL.model, "proposal should use system-selected absorb model");
		return { text: proposalFixture(), usage: { input: 30, output: 40, totalTokens: 70, cost: 0 } };
	});
	assert(proposalResponse.writesMemory === false, "proposal from discussion signoff should be non-mutating");
	assert(proposalResponse.candidateValidation.valid, "proposal from discussion signoff should validate candidate");
	assert(readL1b() === sourceL1b, "proposal generation must not mutate L1b");

	// --- Trap family: the server never rejects its own signoff output ---------

	// 1. An oversized handoff is trimmed section-aware (Transcript summary
	// first, Needs judgment never) and disclosed, and /propose accepts it.
	const oversizedSignoff = legacySignoffMarkdown.replace(
		"The discussion confirmed that signoff should produce a bounded handoff, not a Candidate L1b.",
		`The discussion ran long. ${"Every turn restated the same operator-boundary point in new words. ".repeat(160)}`,
	).replace("### Needs judgment\n- None", "### Needs judgment\n- NEEDS_JUDGMENT_SENTINEL: should stale follow-ups be cleared or kept?");
	assert(oversizedSignoff.length > DISCUSSION_HANDOFF_MAX_CHARS, "oversized signoff fixture should exceed the handoff cap");
	const trimmedSignoff = await buildAbsorbDiscussionSignoff({
		agentId,
		source: { l1bFingerprint: sourceFingerprint },
		assessmentMarkdown,
		messages: [{ role: "user", content: "Preserve the operator-boundary decision." }, { role: "assistant", content: discussionReply }],
	}, ABSORB_MODEL, async () => ({ text: oversizedSignoff, usage: { input: 20, output: 15, totalTokens: 35, cost: 0 } }));
	assert(trimmedSignoff.assessmentHandoff.text.length <= DISCUSSION_HANDOFF_MAX_CHARS, "oversized handoff should be trimmed under the cap");
	assert(trimmedSignoff.assessmentHandoff.text.includes(`### Transcript summary\n\n${DISCUSSION_HANDOFF_TRIM_MARKER}`), "Transcript summary should be shed first with a disclosed marker");
	assert(trimmedSignoff.assessmentHandoff.text.includes("NEEDS_JUDGMENT_SENTINEL"), "Needs judgment must survive the trim");
	assert(trimmedSignoff.assessmentHandoff.text.includes("Preserve the backend-only discussion operator boundary"), "User guidance should survive when shedding the summary is enough");
	assert(trimmedSignoff.warnings.some((warning) => /discussion summary handed to the draft ran past its 8000-character limit/.test(warning) && /"Transcript summary"/.test(warning)), "trimmed handoff should be disclosed in warnings");
	let trimmedProposalPrompt = "";
	await buildAbsorbProposal({
		agentId,
		assessmentMarkdown,
		assessmentHandoff: trimmedSignoff.assessmentHandoff,
		source: { l1bFingerprint: sourceFingerprint },
	}, ABSORB_MODEL, async (prompt) => {
		trimmedProposalPrompt = prompt;
		return { text: proposalFixture(), usage: { input: 30, output: 40, totalTokens: 70, cost: 0 } };
	});
	assert(trimmedProposalPrompt.includes(DISCUSSION_HANDOFF_TRIM_MARKER), "proposal step should accept the trimmed handoff and see the marker");

	// 2. The real shed order: past the summary it continues through the list,
	// never touching User guidance or Needs judgment; the tail cut is the last
	// resort, stays under the cap, and the disclosure says what survived.
	const longBullets = (label: string) => `- ${label}: ${"detail ".repeat(700)}`;
	const deepTrim = fitDiscussionHandoff(`## Absorb discussion signoff\n\n### User guidance\n${longBullets("guidance")}\n\n### Learn / memorize\n${longBullets("learn")}\n\n### Clear / forget\n- clear\n\n### Update existing memory\n${longBullets("update")}\n\n### Needs judgment\n- NEEDS_JUDGMENT_SENTINEL\n\n### Transcript summary\n${longBullets("summary")}\n`, ABSORB_HANDOFF_SHED_ORDER);
	assert(deepTrim.text.length <= DISCUSSION_HANDOFF_MAX_CHARS && !deepTrim.tailCut, "shedding sections in order should fit without a tail cut");
	assert(deepTrim.trimmedSections.join("|") === "Transcript summary|Update existing memory|Clear / forget|Learn / memorize", `shed order should follow the real constant and stop as soon as it fits (got ${deepTrim.trimmedSections.join("|")})`);
	assert(deepTrim.text.includes("NEEDS_JUDGMENT_SENTINEL") && deepTrim.text.includes("- guidance:"), "protected sections must keep their bodies");
	assert(deepTrim.keptProtectedSections.join("|") === "User guidance|Needs judgment" && /your guidance and open questions were kept/.test(describeHandoffTrim(deepTrim) ?? ""), "disclosure may claim guidance and questions were kept only when both are intact");
	assert(!(ABSORB_HANDOFF_SHED_ORDER as readonly string[]).includes("User guidance"), "User guidance must never be on the shed list");
	// 2b. Model wrote ## headings: sections are still recognised and the shed
	// order still applies (no blind tail cut), levels preserved in the output.
	const h2 = fitDiscussionHandoff(`## Absorb discussion signoff\n\n## User guidance\n- keep X\n\n## Needs judgment\n- NEEDS_JUDGMENT_SENTINEL\n\n## Transcript summary\n${"recap ".repeat(1600)}\n`, ABSORB_HANDOFF_SHED_ORDER);
	assert(!h2.tailCut && h2.trimmedSections.join("|") === "Transcript summary" && h2.text.includes("## Transcript summary") && h2.text.includes("NEEDS_JUDGMENT_SENTINEL"), `## headings should be section-aware (got tailCut=${h2.tailCut} sections=${h2.trimmedSections.join("|")})`);
	// 2c. CRLF input is handled like LF.
	const crlf = fitDiscussionHandoff(`## Absorb discussion signoff\r\n\r\n### Needs judgment\r\n- NEEDS_JUDGMENT_SENTINEL\r\n\r\n### Transcript summary\r\n${"recap ".repeat(1600)}\r\n`, ABSORB_HANDOFF_SHED_ORDER);
	assert(!crlf.tailCut && crlf.trimmedSections.join("|") === "Transcript summary", "CRLF handoffs should still be section-aware");
	// 2d. Unsheddable overflow → tail cut under the cap, code fences balanced,
	// and the disclosure stops claiming the open questions were kept.
	const tailCut = fitDiscussionHandoff(`## Absorb discussion signoff\n\n### User guidance\n- keep X\n\n### Needs judgment\n- q\n\n\`\`\`md\n${"code line\n".repeat(900)}\`\`\`\n`, ABSORB_HANDOFF_SHED_ORDER);
	assert(tailCut.tailCut && tailCut.text.length <= DISCUSSION_HANDOFF_MAX_CHARS && tailCut.text.endsWith(DISCUSSION_HANDOFF_TRIM_MARKER), "unsheddable overflow should fall back to a disclosed tail cut under the cap");
	assert(((tailCut.text.match(/^\s*```/gm) ?? []).length) % 2 === 0, "a tail cut inside a code fence should be closed");
	const tailDisclosure = describeHandoffTrim(tailCut) ?? "";
	assert(/its end was cut off/.test(tailDisclosure) && /open questions may be incomplete/.test(tailDisclosure) && !/open questions were kept/.test(tailDisclosure), `tail-cut disclosure must be honest about what survived (got ${tailDisclosure})`);
	// 2e. A heading quoted inside a code fence is content, not a boundary:
	// shedding the section that quotes it must remove the whole fenced block
	// instead of shearing the fence and stranding its tail as a phantom section.
	const fenced = fitDiscussionHandoff(`## Absorb discussion signoff\n\n### User guidance\n- keep X\n\n### Needs judgment\n- q\n\n### Transcript summary\nIntro line.\n\n\`\`\`md\n## Quoted heading inside fence\n${"fence line\n".repeat(700)}\`\`\`\n\nAfter-fence recap. ${"recap ".repeat(200)}\n`, ABSORB_HANDOFF_SHED_ORDER);
	assert(!fenced.tailCut && fenced.trimmedSections.join("|") === "Transcript summary", `a fence-quoted heading must not split the section it lives in (trimmed ${JSON.stringify(fenced.trimmedSections)}, tailCut ${fenced.tailCut})`);
	assert(!fenced.text.includes("Quoted heading inside fence"), "shedding the summary must take its fenced quote along");
	assert(((fenced.text.match(/^\s*```/gm) ?? []).length) % 2 === 0, "a fence-aware shed must never strand an orphan fence");
	// 2f. A protected section the signoff never wrote is nothing lost: the
	// disclosure must not warn that it may be incomplete.
	const noJudgment = fitDiscussionHandoff(`## Absorb discussion signoff\n\n### User guidance\n- keep X\n\n### Transcript summary\n${"recap ".repeat(1600)}\n`, ABSORB_HANDOFF_SHED_ORDER);
	assert(noJudgment.trimmedSections.join("|") === "Transcript summary" && noJudgment.keptProtectedSections.includes("Needs judgment") && noJudgment.keptProtectedSections.includes("User guidance"), `a protected section missing before and after counts as kept (got ${JSON.stringify(noJudgment.keptProtectedSections)})`);
	assert(/your guidance and open questions were kept/.test(describeHandoffTrim(noJudgment) ?? ""), `the disclosure must not cry wolf about a section that was never written (got ${describeHandoffTrim(noJudgment)})`);
	// 2g. An unclosed fence means the input was never well-fenced: trusting it
	// would swallow every later section into the fence-opening one, and shedding
	// that section would delete the user's guidance while the disclosure calls
	// it kept. The splitter must fall back to fence-blind splitting instead.
	const unclosed = fitDiscussionHandoff(`## Absorb discussion signoff\n\n### Learn / memorize\nA code sample:\n\`\`\`\nconst x = 1;\n${"filler line\n".repeat(30)}\n### User guidance\n- keep MUNICH_SENTINEL\n\n### Needs judgment\n- NEEDS_JUDGMENT_SENTINEL\n\n### Transcript summary\n${"recap ".repeat(1600)}\n`, ABSORB_HANDOFF_SHED_ORDER);
	assert(unclosed.text.includes("MUNICH_SENTINEL") && unclosed.text.includes("NEEDS_JUDGMENT_SENTINEL"), `an unclosed fence must not let a shed swallow the protected sections (kept ${JSON.stringify(unclosed.keptProtectedSections)}, trimmed ${JSON.stringify(unclosed.trimmedSections)})`);
	assert(unclosed.trimmedSections[0] === "Transcript summary", `an unclosed fence must not hide sections from the shed order (trimmed ${JSON.stringify(unclosed.trimmedSections)})`);
	assert(unclosed.keptProtectedSections.join("|") === "User guidance|Needs judgment" && /your guidance and open questions were kept/.test(describeHandoffTrim(unclosed) ?? ""), "with both protected sections intact the disclosure may say kept — and must be telling the truth");
	// 2h. ~~~ is CommonMark's other fence: a heading quoted inside it is content,
	// and shedding the section that quotes it must take the whole tilde block
	// along instead of stranding an orphan ~~~ in the proposal prompt.
	const tildes = fitDiscussionHandoff(`## Absorb discussion signoff\n\n### User guidance\n- keep X\n\n### Needs judgment\n- q\n\n### Transcript summary\nIntro.\n\n~~~\n## Quoted heading inside tilde fence\n${"fence line\n".repeat(700)}~~~\n\nAfter. ${"recap ".repeat(200)}\n`, ABSORB_HANDOFF_SHED_ORDER);
	assert(!tildes.tailCut && tildes.trimmedSections.join("|") === "Transcript summary", `a tilde-fence-quoted heading must not split the section it lives in (trimmed ${JSON.stringify(tildes.trimmedSections)}, tailCut ${tildes.tailCut})`);
	assert(!tildes.text.includes("Quoted heading inside tilde fence"), "shedding the summary must take its tilde-fenced quote along");
	assert(((tildes.text.match(/^\s*~~~/gm) ?? []).length) % 2 === 0, "a fence-aware shed must never strand an orphan tilde fence");
	// 2i. A tail cut inside a longer-than-usual fence still closes it with a
	// matching closer AND stays under the cap (the closer is longer than the
	// room reserved for it, so the cut must give ground).
	const longFence = fitDiscussionHandoff(`## Absorb discussion signoff\n\n### User guidance\n- keep X\n\n### Needs judgment\n- q\n\n~~~~md\n${"tilde line\n".repeat(900)}~~~~\n`, ABSORB_HANDOFF_SHED_ORDER);
	assert(longFence.tailCut && longFence.text.length <= DISCUSSION_HANDOFF_MAX_CHARS, `a tail cut with a long fence closer must stay under the cap (got ${longFence.text.length})`);
	assert(((longFence.text.match(/^\s*~~~~/gm) ?? []).length) % 2 === 0, "a tail cut inside a 4-tilde fence should be closed with a matching closer");

	// 3. Signoff prompt ladder: a long transcript on a small-window model is
	// trimmed oldest-first (last 4 messages whole) instead of failing at the provider.
	const ladderMessages = Array.from({ length: 20 }, (_, index) => ({
		role: (index % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
		content: index === 19 ? `LAST_MESSAGE_SENTINEL ${"closing point ".repeat(277).trim()}` : `Turn ${index + 1}: ${"long discussion turn ".repeat(185).trim()}`,
	}));
	assert(ladderMessages.every((message) => message.content.length < 4000 && message.content.length > 3800), "ladder fixture messages should sit between the stage-1 and stage-2 caps");
	let ladderPrompt = "";
	const ladderSignoff = await buildAbsorbDiscussionSignoff({
		agentId,
		source: { l1bFingerprint: sourceFingerprint },
		assessmentMarkdown,
		messages: ladderMessages,
	}, ABSORB_MODEL, async (prompt) => {
		ladderPrompt = prompt;
		return { text: signoffMarkdown, usage: { input: 20, output: 15, totalTokens: 35, cost: 0 } };
	}, { resolveModelWindow: () => ({ contextWindow: 24000, maxOutputTokens: 1000 }) });
	assert(ladderPrompt.includes(DISCUSSION_TRANSCRIPT_TRIM_MARKER), "ladder should trim long older messages in the signoff prompt");
	assert(ladderPrompt.includes(ladderMessages[19].content), "ladder must keep the latest messages whole");
	assert(ladderPrompt.includes("Turn 1: long discussion turn") && !ladderPrompt.includes(ladderMessages[0].content), "ladder should shorten, not drop, older messages at this stage");
	assert(ladderSignoff.tokenBudget.promptEstimatedTokens <= 19400, `laddered signoff prompt should fit the window budget (got ${ladderSignoff.tokenBudget.promptEstimatedTokens})`);
	assert(ladderSignoff.warnings.some((warning) => /discussion was trimmed so the model could read it back/.test(warning) && /16 long messages were shortened/.test(warning) && /last 4 turns were kept in full/.test(warning)), `ladder should be disclosed in warnings (got ${JSON.stringify(ladderSignoff.warnings)})`);
	let unladderedPrompt = "";
	await buildAbsorbDiscussionSignoff({
		agentId,
		source: { l1bFingerprint: sourceFingerprint },
		assessmentMarkdown,
		messages: ladderMessages,
	}, ABSORB_MODEL, async (prompt) => {
		unladderedPrompt = prompt;
		return { text: signoffMarkdown, usage: { input: 20, output: 15, totalTokens: 35, cost: 0 } };
	});
	assert(!unladderedPrompt.includes(DISCUSSION_TRANSCRIPT_TRIM_MARKER), "without a window budget and under the hard stop, the transcript stays whole");

	// 3b. The ladder runs on discussion turns too: a turn that would overflow the
	// window is shortened the same way instead of refusing where signoff succeeds.
	let ladderTurnPrompt = "";
	const ladderTurn = await buildAbsorbDiscussionTurn({
		agentId,
		source: { l1bFingerprint: sourceFingerprint },
		assessmentMarkdown,
		messages: ladderMessages,
		userMessage: "One more point before we wrap up.",
	}, ABSORB_MODEL, async (prompt) => {
		ladderTurnPrompt = prompt;
		return { text: discussionReply };
	}, { resolveModelWindow: () => ({ contextWindow: 24000, maxOutputTokens: 1000 }) });
	assert(ladderTurnPrompt.includes(DISCUSSION_TRANSCRIPT_TRIM_MARKER) && ladderTurnPrompt.includes(ladderMessages[19].content), "a discussion turn on a small window should be laddered, keeping the latest messages whole");
	assert(ladderTurn.warnings.some((warning) => /discussion was trimmed so the model could read it back/.test(warning)), `turn ladder should be disclosed (got ${JSON.stringify(ladderTurn.warnings)})`);

	// 3c. Stage skipping compares transcripts, not trim counts: messages just
	// over the stage-1 cap are trimmed by stage 1 (same count as stage 2) but
	// barely shortened — stage 2 must still run, so the oldest messages are
	// shortened where the old count-compare skipped to stage 3 and dropped them.
	const stageSkipMessages = Array.from({ length: 23 }, (_, index) => ({
		role: (index % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
		content: index >= 19 ? `Closing turn ${index + 1}: brief wrap-up.` : `Turn ${index + 1}: ${"long discussion turn ".repeat(193).trim()}`,
	}));
	assert(stageSkipMessages.slice(0, 19).every((message) => message.content.length > 4000 && message.content.length < 4100), "stage-skip fixture messages must sit just over the stage-1 cap");
	assert(stageSkipMessages.reduce((total, message) => total + message.content.length, 0) <= 80000, "stage-skip fixture must fit the request transcript cap");
	let stageSkipPrompt = "";
	const stageSkipSignoff = await buildAbsorbDiscussionSignoff({
		agentId,
		source: { l1bFingerprint: sourceFingerprint },
		assessmentMarkdown,
		messages: stageSkipMessages,
	}, ABSORB_MODEL, async (prompt) => {
		stageSkipPrompt = prompt;
		return { text: signoffMarkdown, usage: { input: 20, output: 15, totalTokens: 35, cost: 0 } };
	}, { resolveModelWindow: () => ({ contextWindow: 24000, maxOutputTokens: 1000 }) });
	assert(stageSkipPrompt.includes("Turn 1: long discussion turn"), "stage 2 must run when stage 1 trimmed the same messages less: the oldest message is shortened, never dropped");
	assert(stageSkipSignoff.warnings.some((warning) => /long messages were shortened/.test(warning) && !/left out/.test(warning)), `the stage-2 ladder should shorten without dropping (got ${JSON.stringify(stageSkipSignoff.warnings)})`);
	assert(stageSkipSignoff.tokenBudget.promptEstimatedTokens <= 19400, `the stage-2 prompt should fit the window budget (got ${stageSkipSignoff.tokenBudget.promptEstimatedTokens})`);

	// 3d. The hard stop binds on large windows too: it is a quality bound (a
	// discussion prompt past ~100k tokens degrades the model that reads it
	// back), not a fit bound. A big-memory room whose prompt sits in the
	// 100k-to-window band — reachable only through the memory, since the
	// request caps the transcript itself — must be laddered toward the hard
	// stop instead of passing untrimmed and dying on the budget check.
	const bigMemoryExtra = `- ${"durable memory detail ".repeat(3050).trim()}\n`;
	setRecentContextEntries(5, bigMemoryExtra);
	const bigMemoryL1b = readL1b();
	assert(bigMemoryL1b.length > 320000 && bigMemoryL1b.length < 380000, `big-memory fixture should land the prompt in the hard-stop band (L1b is ${bigMemoryL1b.length} chars)`);
	const bigMemoryFingerprint = fingerprintL1bSource(bigMemoryL1b);
	let bigMemoryPrompt = "";
	const bigMemorySignoff = await buildAbsorbDiscussionSignoff({
		agentId,
		source: { l1bFingerprint: bigMemoryFingerprint },
		assessmentMarkdown,
		messages: ladderMessages,
	}, ABSORB_MODEL, async (prompt) => {
		bigMemoryPrompt = prompt;
		return { text: signoffMarkdown, usage: { input: 20, output: 15, totalTokens: 35, cost: 0 } };
	}, { resolveModelWindow: () => ({ contextWindow: 200000, maxOutputTokens: 8000 }) });
	assert(bigMemoryPrompt.includes(DISCUSSION_TRANSCRIPT_TRIM_MARKER), "a 100k+ prompt on a 200k model should still be laddered at the hard stop");
	assert(bigMemoryPrompt.includes(ladderMessages[19].content), "the large-window ladder must keep the latest messages whole");
	assert(bigMemorySignoff.tokenBudget.promptEstimatedTokens < 100000, `the laddered prompt should sit under the discussion hard stop (got ${bigMemorySignoff.tokenBudget.promptEstimatedTokens})`);
	fs.writeFileSync(l1bPath, sourceL1b, "utf-8");
	assert(fingerprintL1bSource(readL1b()).value === sourceFingerprint.value, "big-memory fixture must restore the source L1b for the trap-family checks");

	// 4. When even the tightest ladder stage cannot fit the window, signoff and
	// turn refuse honestly (413, named process) before calling the provider.
	let refusedSignoffGeneratorCalled = false;
	try {
		await buildAbsorbDiscussionSignoff({
			agentId,
			source: { l1bFingerprint: sourceFingerprint },
			assessmentMarkdown,
			messages: ladderMessages,
		}, ABSORB_MODEL, async () => {
			refusedSignoffGeneratorCalled = true;
			return { text: signoffMarkdown };
		}, { resolveModelWindow: () => ({ contextWindow: 2000, maxOutputTokens: 1000 }) });
		throw new Error("oversized signoff prompt should refuse");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		assert(/the Memorize discussion summary prompt for .* is too large for the locked model/.test(message), `signoff overflow should refuse with the named process (got ${message})`);
		assert((error as any).statusCode === 413, "signoff overflow refusal should carry 413");
		assert(/No memory has been written/.test(message), "signoff overflow refusal should state memory is untouched");
	}
	assert(!refusedSignoffGeneratorCalled, "refused signoff must not call the provider");
	let refusedTurnGeneratorCalled = false;
	try {
		await buildAbsorbDiscussionTurn({
			agentId,
			source: { l1bFingerprint: sourceFingerprint },
			assessmentMarkdown,
			messages: [],
			userMessage: "Please continue.",
		}, ABSORB_MODEL, async () => {
			refusedTurnGeneratorCalled = true;
			return { text: "should not run" };
		}, { resolveModelWindow: () => ({ contextWindow: 2000, maxOutputTokens: 1000 }) });
		throw new Error("oversized discussion turn prompt should refuse");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		assert(/the Memorize discussion prompt for .* is too large/.test(message) && (error as any).statusCode === 413, `turn overflow should refuse with 413 and the named process (got ${message})`);
	}
	assert(!refusedTurnGeneratorCalled, "refused discussion turn must not call the provider");
	assert(readL1b() === sourceL1b, "trap-family checks must not mutate L1b");

	setRecentContextEntries(5);
	const staleFingerprint = sourceFingerprint;
	const changedL1b = readL1b().replace("Durable discussion understanding 3", "Durable discussion understanding 3 changed after discussion");
	fs.writeFileSync(l1bPath, changedL1b, "utf-8");
	let staleGeneratorCalled = false;
	await expectThrowsAsync(
		() => buildAbsorbDiscussionTurn({
			agentId,
			source: { l1bFingerprint: staleFingerprint },
			assessmentMarkdown,
			messages: [],
			userMessage: "Please continue.",
		}, ABSORB_MODEL, async () => {
			staleGeneratorCalled = true;
			return { text: "should not run" };
		}),
		/source L1b fingerprint changed/,
		"stale discussion source should be rejected before generator",
	);
	assert(!staleGeneratorCalled, "stale discussion source should not call generator");

	const freshFingerprint = fingerprintL1bSource(readL1b());
	let staleProposalGeneratorCalled = false;
	await expectThrowsAsync(
		() => buildAbsorbProposal({
			agentId,
			assessmentMarkdown,
			assessmentHandoff: signoffResponse.assessmentHandoff,
			source: { l1bFingerprint: staleFingerprint },
		}, ABSORB_MODEL, async () => {
			staleProposalGeneratorCalled = true;
			return { text: proposalFixture() };
		}),
		/source L1b fingerprint changed/,
		"stale discussion signoff proposal source should be rejected before generator",
	);
	assert(!staleProposalGeneratorCalled, "stale discussion signoff proposal source should not call generator");

	const hugeBody = `- ${"budget pressure ".repeat(34000)}`;
	setRecentContextEntries(5, hugeBody);
	const hugeFingerprint = fingerprintL1bSource(readL1b());
	let budgetGeneratorCalled = false;
	await expectThrowsAsync(
		() => buildAbsorbDiscussionTurn({
			agentId,
			source: { l1bFingerprint: hugeFingerprint },
			assessmentMarkdown,
			messages: [],
			userMessage: "Please continue despite the large source.",
		}, ABSORB_MODEL, async () => {
			budgetGeneratorCalled = true;
			return { text: "should not run" };
		}),
		/token budget exceeded/,
		"over-budget discussion turn should be rejected before generator",
	);
	assert(!budgetGeneratorCalled, "over-budget discussion turn should not call generator");
	assert(freshFingerprint.value !== hugeFingerprint.value, "huge source should update fingerprint for budget test");

	fs.rmSync(root, { recursive: true, force: true });
	console.log("absorb discussion smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp root preserved for inspection: ${root}`);
	process.exitCode = 1;
}
