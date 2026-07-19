/**
 * L1a constitution upgrade runner.
 *
 * UNLIKE the *-smoke.ts scripts in this directory, this operates on the REAL
 * product state under ~/.exxperts. It re-renders each room's constitution
 * (L1a.md) from the current template, archiving the previous file and writing
 * a fingerprinted event record. Durable memory (L1b) is never touched.
 *
 * Usage:
 *   npx tsx apps/web-server/scripts/upgrade-l1a-constitution.ts --dry-run --all
 *   npx tsx apps/web-server/scripts/upgrade-l1a-constitution.ts --all
 *   npx tsx apps/web-server/scripts/upgrade-l1a-constitution.ts <agent-id> [<agent-id> ...]
 */

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const all = args.includes("--all");
const requestedIds = args.filter((arg) => !arg.startsWith("--"));

const {
	listPersistentAgents,
	planPersistentAgentConstitutionUpgrade,
	upgradePersistentAgentConstitution,
} = await import("../src/persistent-agents.js");

function usage(): void {
	console.log("usage: npx tsx apps/web-server/scripts/upgrade-l1a-constitution.ts [--dry-run] (--all | <agent-id> [<agent-id> ...])");
}

if (!all && requestedIds.length === 0) {
	usage();
	process.exit(1);
}
if (all && requestedIds.length > 0) {
	console.error("Pass either --all or explicit agent ids, not both.");
	process.exit(1);
}

const targetIds = all ? listPersistentAgents().map((status: any) => String(status.id)) : requestedIds;
if (targetIds.length === 0) {
	console.log("No rooms found.");
	process.exit(0);
}

let upgraded = 0;
let upToDate = 0;
let failed = 0;

for (const agentId of targetIds) {
	try {
		const plan = planPersistentAgentConstitutionUpgrade(agentId);
		if (plan.action === "up_to_date") {
			upToDate += 1;
			console.log(`- ${agentId}: already at template v${plan.toTemplateVersion} — nothing to do`);
			continue;
		}
		if (dryRun) {
			upgraded += 1;
			console.log(`- ${agentId}: WOULD upgrade constitution v${plan.fromTemplateVersion} -> v${plan.toTemplateVersion} (mode: ${plan.mode}, ~${plan.currentL1aEstimatedTokens} -> ~${plan.candidateL1aEstimatedTokens} est. tokens) [dry-run, nothing written]`);
			continue;
		}
		const result = upgradePersistentAgentConstitution(agentId);
		upgraded += 1;
		console.log(`- ${agentId}: upgraded constitution v${result.plan.fromTemplateVersion} -> v${result.plan.toTemplateVersion} (mode: ${result.plan.mode})`);
		console.log(`    previous constitution archived at: ${result.archivedL1aRelPath}`);
		console.log(`    event record: ${result.eventRecordRelPath}`);
	} catch (error) {
		failed += 1;
		console.error(`- ${agentId}: FAILED — ${error instanceof Error ? error.message : String(error)}`);
	}
}

console.log("");
console.log(`${dryRun ? "Dry-run summary" : "Summary"}: ${upgraded} ${dryRun ? "would upgrade" : "upgraded"}, ${upToDate} already up to date, ${failed} failed.`);
if (failed > 0) process.exitCode = 1;

export {};
