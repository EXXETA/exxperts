// The battery runs no vitest suite, so this runs the runtime's pause_turn
// tests and checks that both guarded cases ran and passed.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const aiPackageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "runtime", "packages", "ai");
// The runtime's test setup makes a temp home it never removes; it lands in this folder.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-pause-turn-smoke-"));
const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", TMPDIR: tempDir, TEMP: tempDir, TMP: tempDir };
delete env.EXXPERTS_LIVE_TESTS;
const run = spawnSync("npx", ["vitest", "--run", "--reporter=verbose", "test/anthropic-pause-turn.test.ts"], {
	cwd: aiPackageDir,
	encoding: "utf8",
	shell: process.platform === "win32",
	env,
	timeout: 240_000,
});
fs.rmSync(tempDir, { recursive: true, force: true });
const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
assert(run.status === 0, `the pause_turn tests must pass, vitest exited ${run.status}:\n${output.slice(-3000)}`);
for (const name of ["refuses to publish a continuation that returned nothing at all", "still publishes a first response that never named a stop reason"]) {
	const line = output.split("\n").find((candidate) => candidate.includes(name));
	assert(line && /✓/.test(line), `the pause_turn case "${name}" must run and pass, got: ${line ?? "no such case"}`);
}

console.log("runtime pause turn smoke ok");
