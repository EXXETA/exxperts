// The battery runs no vitest suite, so this runs the runtime's tests of a
// request refused for its size, of what is left out then, and of a Stop during
// a shortening, and checks that a case of each file ran and passed.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const packagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "runtime", "packages");
// The runtime's test setup makes a temp home it never removes; it lands in this folder.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-request-size-smoke-"));
const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", TMPDIR: tempDir, TEMP: tempDir, TMP: tempDir };
delete env.EXXPERTS_LIVE_TESTS;

function runTests(packageName: string, files: string[], cases: string[]): void {
	const cwd = path.join(packagesDir, packageName);
	const vitest = path.join(path.dirname(createRequire(path.join(cwd, "package.json")).resolve("vitest/package.json")), "vitest.mjs");
	const run = spawnSync(process.execPath, [vitest, "--run", "--reporter=verbose", ...files], {
		cwd,
		encoding: "utf8",
		env,
		timeout: 240_000,
	});
	const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
	assert(run.status === 0, `${files.join(" and ")} must pass, vitest exited ${run.status}:\n${output.slice(-3000)}`);
	for (const name of cases) {
		const line = output.split("\n").find((candidate) => candidate.includes(name));
		assert(line && /✓/.test(line), `the case "${name}" must run and pass, got: ${line ?? "no such case"}`);
	}
}

try {
	runTests("coding-agent", ["test/request-image-budget.test.ts", "test/request-too-large.test.ts"], [
		"never leaves out a picture that came since the person's last message",
		"take out the same in a session that sent nothing yet as in one that sent every message",
		"never take out a picture since the person's last message, nor move while its answer goes on",
		"is sent without the oldest from its first request on, in every request of the message, and stays whole itself",
		"is sent again twice and no more, and fails once",
		"in Anthropic's words, with nothing left to leave out, fails once and starts no shortening",
		"in LiteLLM's words, which leave size or tokens open, shortens once for a message that reads pictures",
		"in Bedrock's words shortens as often as its window fills where no picture came since the message",
		"in words that name tokens shortens as often as its window fills",
		"keeps the pictures of the person's message when the app's own prompt after it is refused",
		"during the shortening before a send ends it, and the message goes nowhere",
	]);
	runTests("ai", ["test/overflow.test.ts"], ["reads only a failed answer"]);
} finally {
	fs.rmSync(tempDir, { recursive: true, force: true });
}
console.log("runtime request size smoke ok");
