// The refusal-proof script, proved on its fake model (offline, no money): the
// find remembers each session of a synthetic question alone and names the one
// the fake refuses; the proof remembers it again through the product's layers
// (a refused single pass goes to parts, a refused part is read in halves at a
// high level) and the verdict is a pass: a page with no unread stretch and no
// engine text; a page with engine text in it fails.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webServerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "refusal-proof-smoke-"));
const out = path.join(outDir, "report.json");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

try {
	const run = spawnSync("npx", ["tsx", "scripts/memory-bench/refusal-proof.mts", "--scripted", "--out", out], { cwd: webServerDir, shell: process.platform === "win32", encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 });
	assert(run.status === 0, `the scripted proof passes (exit ${run.status}): ${(run.stdout + run.stderr).slice(-1500)}`);
	const report = JSON.parse(fs.readFileSync(out, "utf-8"));
	assert(JSON.stringify(report.suspects) === JSON.stringify(["S03"]) && report.found.length === 4, `the find names the one refused session of four, got ${JSON.stringify(report.suspects)} of ${report.found.length}`);
	const [proof] = report.proofs;
	const calls = proof.calls.map((call: { kind: string; highLevel: boolean; refused: boolean }) => `${call.kind}${call.highLevel ? "+high-level" : ""}${call.refused ? ":refused" : ""}`);
	assert(calls[0] === "remember-single:refused" && calls.includes("remember-part:refused") && calls.includes("remember-part+high-level") && calls.at(-1) === "remember-final", `the product's layers run in order, got ${calls.join(" ")}`);
	assert(report.verdict === "pass" && proof.pageCameOut && proof.unreadStretches === 0 && proof.engineLines === 0 && !proof.builtByCode, `the verdict is a pass with a page, no unread stretch and no engine line, got ${report.verdict} ${JSON.stringify({ unreadStretches: proof.unreadStretches, engineLines: proof.engineLines })}`);

	// A page that holds engine text (the fake writes "Messages 3 to 5 were not
	// read." into the entry) fails the proof, counted as engine lines.
	const engineOut = path.join(outDir, "engine.json");
	const engine = spawnSync("npx", ["tsx", "scripts/memory-bench/refusal-proof.mts", "--scripted", "--scripted-engine-line", "--out", engineOut], { cwd: webServerDir, shell: process.platform === "win32", encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 });
	const engineReport = fs.existsSync(engineOut) ? JSON.parse(fs.readFileSync(engineOut, "utf-8")) : null;
	assert(engine.status === 1 && engineReport?.verdict === "engine text in the page" && engineReport.proofs[0].engineLines === 1, `engine text in the saved page fails the proof, got exit ${engine.status} ${JSON.stringify({ verdict: engineReport?.verdict, engineLines: engineReport?.proofs?.[0]?.engineLines })}`);
	console.log("refusal proof smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	process.exitCode = 1;
} finally {
	fs.rmSync(outDir, { recursive: true, force: true });
}
