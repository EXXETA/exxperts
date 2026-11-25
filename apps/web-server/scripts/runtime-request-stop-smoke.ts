// The battery runs no vitest suite, so this runs the runtime's rows for a stop
// during a model library's wait, and for the longest wait a server may ask for,
// and checks that the guarded rows ran and passed.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const aiPackageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "runtime", "packages", "ai");
const vitest = path.join(path.dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs");
// The runtime's test setup makes a temp home it never removes; it lands in this folder.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-request-stop-smoke-"));
const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", TMPDIR: tempDir, TEMP: tempDir, TMP: tempDir };
delete env.EXXPERTS_LIVE_TESTS;
const run = spawnSync(process.execPath, [vitest, "--run", "--reporter=verbose", "test/request-stop.test.ts"], { cwd: aiPackageDir, encoding: "utf8", env, timeout: 240_000 });
fs.rmSync(tempDir, { recursive: true, force: true });
const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
assert(run.status === 0, `the request stop rows must pass, vitest exited ${run.status}:\n${output.slice(-3000)}`);
const providers = ["openai-completions", "openai-responses", "azure-openai-responses", "anthropic", "images/openrouter"];
const guarded = providers.flatMap((provider) => [
	`${provider}: the server's wait in seconds, as a date and in milliseconds`,
	`${provider}: the library's own wait after a dropped connection`,
	`${provider}: a response that comes after the stop is let go`,
	`${provider}: longer than a minute fails at once`,
	`${provider}: two seconds are waited for and answered`,
]);
for (const name of guarded) {
	const line = output.split("\n").find((candidate) => candidate.includes(` > ${name}`));
	assert(line && /✓/.test(line), `the row "${name}" must run and pass, got: ${line ?? "no such row"}`);
}

console.log("runtime request stop smoke ok");
