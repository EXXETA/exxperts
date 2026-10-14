// The big-room run script, proved on its fake model (offline, no money): two
// rooms are built, remembered, memorized and reviewed, and the report counts
// each page's calls by rung. The fake makes one page climb to the pieces and
// one go all the way to the placement, so the report must show the ladder's
// worst case (8 calls) and the run must fail on that page alone.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webServerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "big-room-run-smoke-"));
const out = path.join(outDir, "report.json");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

try {
	const run = spawnSync("npx", ["tsx", "scripts/memory-bench/big-room-run.mts", "--scripted", "--out", out], { cwd: webServerDir, shell: process.platform === "win32", encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 });
	assert(run.status === 1, `the run fails on the page the fake placed whole (exit ${run.status}): ${(run.stdout + run.stderr).slice(-1500)}`);
	const report = JSON.parse(fs.readFileSync(out, "utf-8"));
	assert(report.scripted === true && report.rooms.length === 2, `two scripted rooms are reported, got ${report.rooms?.length}`);
	for (const room of report.rooms) {
		assert(room.pages === 20 && room.remember.final === 1, `each room memorizes 20 pages after one Remember, got ${room.pages} pages and ${room.remember.final} final calls`);
		assert(JSON.stringify(room.problems) === JSON.stringify([room.problems.find((problem: string) => problem.startsWith('page RC-0005 ended "summarized"'))]), `the only problem is the page placed whole, got ${JSON.stringify(room.problems)}`);
		assert(JSON.stringify(room.callsByPage["RC-0005"]) === JSON.stringify({ "rung 1": 1, "rung 2": 1, "rung 3-4": 5, "rung 5": 1 }) && room.worstPage === 8, `the placed page costs the ladder's worst case by rung, got ${JSON.stringify(room.callsByPage["RC-0005"])}`);
		assert(room.callsByPage["RC-0003"]["rung 3-4"] > 0 && room.outcomes["RC-0003"] === "folded", `the page that folds in pieces is counted at rung 3-4, got ${JSON.stringify(room.callsByPage["RC-0003"])}`);
		assert(JSON.stringify(room.callsByPage["RC-0001"]) === JSON.stringify({ "rung 1": 1 }), `an ordinary page costs one call, got ${JSON.stringify(room.callsByPage["RC-0001"])}`);
		assert(room.reviewGroups.length > 0 && room.worstReviewGroup >= 1, `the Review groups are counted, got ${JSON.stringify(room.reviewGroups)}`);
	}
	console.log("big-room run smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	process.exitCode = 1;
} finally {
	fs.rmSync(outDir, { recursive: true, force: true });
}
