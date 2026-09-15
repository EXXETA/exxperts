// Measures the Memorize pipeline on a synthetic memory, using the real server
// functions with scripted model replies. Numbers only; no provider needed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BENCH = path.dirname(new URL(import.meta.url).pathname);
const MEMORY_FILE = process.env.MEMORY_FILE || path.join(BENCH, "synthetic-66k.md"); // node gen-memory.mjs 66000 10 > synthetic-66k.md
const REPO = path.resolve(BENCH, "../../../..");
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "memorize-bench-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const appDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(appDir, { recursive: true });
fs.writeFileSync(path.join(appDir, "openai-compatible-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Bench", roomModels: [{ modelId: "gpt-5.5" }], maintenanceModel: "gpt-5.5" }));
fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "memorize-bench-root-"));
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const pa = await import(`${REPO}/apps/web-server/src/persistent-agents.ts`);
const ac = await import(`${REPO}/apps/web-server/src/absorb-consolidation.ts`);
const ms = await import(`${REPO}/apps/web-server/src/persistent-room-maintenance-settings.ts`);
const { estimateTokens } = await import(`${REPO}/apps/web-server/src/token-estimate.ts`);
const { getAbsorbModelLock } = await import(`${REPO}/apps/web-server/src/persistent-agent-ai-profiles.ts`);

const MODEL = getAbsorbModelLock("openai-compatible");
const agentId = "bench-room";
pa.createPersistentAgentFromScaffoldInput({ displayName: "Bench Room", userName: "Bench User", preferredUserAddress: "Bench" });
const l1bPath = path.join(root, agentId, "L1b", "current.md");
const l1b = fs.readFileSync(MEMORY_FILE, "utf-8");
fs.writeFileSync(l1bPath, l1b);

const budget = ms.readPersistentRoomMaintenanceSettings(agentId).memoryBudgetTokens;
const metrics = ac.absorbRecentContextMetrics(l1b);
const reviewTarget = pa.reviewTargetEstimatedTokensFromL1b(l1b);
const status = pa.getPersistentAgentStatus(agentId);
console.log("== A. Sizes (estimated tokens = chars/4)");
console.log({ l1bTokens: estimateTokens(l1b), stableTokens: Math.ceil(metrics.stableL1bChars / 4), recentContextTokens: Math.ceil(metrics.recentContextChars / 4), rcEntries: metrics.recentContextEntryCount, reviewTargetTokens: reviewTarget, budgetTokens: budget, overBudget: ms.overMemoryBudget(reviewTarget, budget), status: status.status, memoryStatus: status.memoryStatus?.recentContextLevel });

const assessmentFixture = `## Absorb assessment\n\nI found 10 Recent Context entries. Here is the proposed direction.\n\n### What to remember\n- Durable decisions.\n\n### What to forget\n- Chatter.\n\n### What changes in stable memory\n- Deep Memory: merge the new decisions.\n- Active Items: refresh open items.\n- Recent Context: all entries are expected to be cleared after approval.\n\n### Needs your judgment\n- None\n`;

const sectionRegistry = {};
const assess = ac.buildAbsorbAssessmentPrompt({ agentId, l1b, model: MODEL, sectionPurposeMap: ac.buildSectionPurposeMap(sectionRegistry) });
const propose = ac.buildAbsorbProposalPrompt({ agentId, l1b, model: MODEL, sectionPurposeMap: ac.buildSectionPurposeMap(sectionRegistry), assessmentMarkdown: assessmentFixture, memoryBudgetTokens: budget });
console.log("== B. Prompt sizes");
console.log({ assessmentPromptTokens: assess.telemetry.promptEstimatedTokens, proposalPromptTokens: propose.telemetry.promptEstimatedTokens, proposalPromptChars: propose.telemetry.promptChars });

// Required output: the proposal = bookkeeping + complete Candidate L1b.
const recent = ac.extractRecentContextForAbsorb(l1b);
const bookkeeping = `## Memory Absorption Proposal\n\n### Mode\nRC_CONSOLIDATION\n\n### Primacy Map\n${"The ten sessions traced the pilot, the vendor contract and the CRM migration; later entries superseded earlier decisions. ".repeat(3)}\n\n### Section-Level Change Log\n| Section | Prior Words | Candidate Words | Action | Rationale |\n|---|---:|---:|---|---|\n${["Chronos", "Deep Memory", "Active Items", "Recent Context"].map((s) => `| ${s} | 1000 | 1000 | update | Folded the durable material from the sessions into the existing entries. |`).join("\n")}\n\n### Entry-Level Detail\n| Entry / Block | Operation | Target Section | Rationale |\n|---|---|---|---|\n${recent.entryIds.map((id: string) => `| ${id} | merge | Deep Memory | Durable decisions merged into the matching subsection; chatter dropped. |`).join("\n")}\n\n### Compression Metrics\n- RC input words: 7000\n- RC removed words: 6000\n- RC removed percent: 85%\n- Stable memory words before: 40000\n- Stable memory words after: 40500\n- Stable memory delta: +500\n- Compression ratio: 12:1\n\n### Warnings\nNone.\n\n### Candidate L1b\n`;
const emptyRc = `## Recent Context\n\n${ac.ABSORB_EMPTY_RECENT_CONTEXT_PLACEHOLDER}\n`;
const faithfulCandidate = `${recent.before}${emptyRc}${recent.after}`;
const faithfulProposal = bookkeeping + faithfulCandidate;
// A budget-fit candidate: stable memory compressed to exactly the budget.
const deepStart = recent.before.indexOf("## Deep Memory");
const activeStart = recent.before.indexOf("## Active Items");
const chronosPart = recent.before.slice(0, deepStart);
const activePart = recent.before.slice(activeStart);
const deepPart = recent.before.slice(deepStart, activeStart);
const deepBudgetChars = (budget - Math.ceil(activePart.length / 4)) * 4;
const compressedDeep = deepPart.slice(0, deepBudgetChars).replace(/\n[^\n]*$/, "\n") + "\n";
const budgetFitCandidate = `${chronosPart}${compressedDeep}${activePart}${emptyRc}`;
const budgetFitProposal = bookkeeping + budgetFitCandidate;
console.log("== C. Required output size vs output caps");
const caps = { "gateway default (no published cap)": 16384, "chat clamp / many gateway rows": 32000, "typical 64k row": 64000, "Anthropic Opus/Sonnet via subscription": 128000 };
const speeds = [40, 80, 150];
function fits(tokens: number) { return Object.fromEntries(Object.entries(caps).map(([k, cap]) => [k, tokens <= cap ? "fits" : `NO (${tokens - cap} over)`])); }
function minutes(tokens: number) { return Object.fromEntries(speeds.map((s) => [`${s} tok/s`, `${(tokens / s / 60).toFixed(1)} min`])); }
console.log({ bookkeepingTokens: estimateTokens(bookkeeping), faithfulProposalTokens: estimateTokens(faithfulProposal), budgetFitProposalTokens: estimateTokens(budgetFitProposal) });
console.log("faithful (denser-not-larger) output:", fits(estimateTokens(faithfulProposal)), minutes(estimateTokens(faithfulProposal)));
console.log("budget-fit (exactly 20k) output:", fits(estimateTokens(budgetFitProposal)), minutes(estimateTokens(budgetFitProposal)));

// D. Prompt-window guard
console.log("== D. Prompt window guard on the proposal prompt");
for (const window of [{ contextWindow: 128000, maxOutputTokens: 16384 }, { contextWindow: 200000, maxOutputTokens: 32000 }, { contextWindow: 64000, maxOutputTokens: 16384 }, { contextWindow: 100000, maxOutputTokens: 16384 }]) {
	try {
		await pa.buildAbsorbProposal({ agentId, assessmentMarkdown: assessmentFixture }, MODEL, async () => ({ text: faithfulProposal }), { resolveModelWindow: () => window });
		console.log(window, "-> prompt accepted");
	} catch (e) { console.log(window, "-> REFUSED:", (e as Error).message.slice(0, 160)); }
}

// E. Validator verdicts per reply shape
console.log("== E. Validator verdicts per reply shape");
async function run(label: string, reply: { text: string; truncated?: boolean; usage?: any; modelMaxOutputTokens?: number }) {
	try {
		const r = await pa.buildAbsorbProposal({ agentId, assessmentMarkdown: assessmentFixture }, MODEL, async () => reply);
		const issues = [...(r.candidateValidation.valid ? [] : r.candidateValidation.errors), ...r.warnings.filter((w: string) => w.startsWith("proposal "))];
		console.log(`--- ${label}: valid=${r.candidateValidation.valid} approveBlockedIssues=${issues.length} overBudgetAfter=${r.memoryBudgetImpact.overBudgetAfter} after=${r.memoryBudgetImpact.reviewTargetEstimatedTokensAfter}`);
		for (const i of issues) console.log("    ·", i);
		return r;
	} catch (e) { console.log(`--- ${label}: REFUSED: ${(e as Error).message.slice(0, 260)}`); return null; }
}
const faithful = await run("faithful complete draft", { text: faithfulProposal });
const cut16k = faithfulProposal.slice(0, 16384 * 4);
await run("draft cut at 16,384 tokens, provider did NOT flag length", { text: cut16k });
await run("draft cut at 16,384 tokens, provider flagged length", { text: cut16k, truncated: true, usage: { output: 16384 }, modelMaxOutputTokens: 16384 });
await run("draft cut at 32,000 tokens, flagged", { text: faithfulProposal.slice(0, 32000 * 4), truncated: true, usage: { output: 32000 }, modelMaxOutputTokens: 32000 });
const decorated = faithfulProposal.replace(/^### (Mode|Primacy Map|Section-Level Change Log|Entry-Level Detail|Compression Metrics|Warnings|Candidate L1b)$/gm, "### **$1**");
await run("complete draft, model bolded the proposal headings (### **Mode**)", { text: decorated });
const numbered = faithfulProposal.replace(/^### (Mode|Primacy Map|Section-Level Change Log|Entry-Level Detail|Compression Metrics|Warnings|Candidate L1b)$/gm, (_m, h, off, s) => `### ${["Mode", "Primacy Map", "Section-Level Change Log", "Entry-Level Detail", "Compression Metrics", "Warnings", "Candidate L1b"].indexOf(h) + 1}. ${h}`);
await run("complete draft, model numbered the headings (### 1. Mode)", { text: numbered });
const fenced = bookkeeping + "```markdown\n" + faithfulCandidate + "\n```\n";
await run("complete draft, candidate wrapped in a ```markdown fence", { text: fenced });
const level2 = faithfulProposal.replace(/^### (Mode|Primacy Map|Section-Level Change Log|Entry-Level Detail|Compression Metrics|Warnings|Candidate L1b)$/gm, "## $1");
await run("complete draft, proposal headings at level 2 (## Mode)", { text: level2 });
const chronosEdited = faithfulProposal.replace("- Last consolidation: absorb_20260805T090000Z_xyz789", "- Last consolidation: (this consolidation)");
await run("complete draft, model updated one Chronos line", { text: chronosEdited });
const chronosReflow = faithfulProposal.replace("## Chronos\n\n\n\n\n", "## Chronos\n\n");
await run("complete draft, model collapsed Chronos blank lines", { text: chronosReflow });
const noPlaceholder = bookkeeping + `${recent.before}## Recent Context\n${recent.after}`;
await run("complete draft, Recent Context cleared without the placeholder", { text: noPlaceholder });
const budgetFit = await run("budget-fit draft (stable memory compressed to 20k)", { text: budgetFitProposal });

// F. Does approval enforce the budget? Approve the faithful (over-budget) draft.
console.log("== F. Approval write with an over-budget candidate");
if (faithful) {
	const parsed = pa.parseAbsorbApprovalRequest({ proposal: faithful }, agentId);
	const res = pa.writeApprovedAbsorb(parsed.request, parsed.warnings);
	console.log({ absorbId: res.absorbId, recentContextEntryCount: res.recentContextEntryCount, memoryBudgetAfter: res.memoryBudget, writtenBytes: fs.statSync(l1bPath).size, writtenTokens: estimateTokens(fs.readFileSync(l1bPath, "utf-8")) });
}
fs.rmSync(tempHome, { recursive: true, force: true });
fs.rmSync(root, { recursive: true, force: true });
fs.writeFileSync(path.join(BENCH, "faithful-proposal.md"), faithfulProposal);
fs.writeFileSync(path.join(BENCH, "budgetfit-proposal.md"), budgetFitProposal);
fs.writeFileSync(path.join(BENCH, "assessment.md"), assessmentFixture);
