// The bench gives up on a refusal at once. A refusal is the content's answer,
// not the provider's mood: waiting it out on the schedule only costs the
// schedule (a gate once waited about 111 minutes for one). The instance is
// marked failed and the run carries on; an overload is still waited out.
//
// Offline: no server, no provider, no network.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "recall-bench-fail-fast-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
// One long wait: a refusal that waited would miss the deadline below.
process.env.RECALL_BENCH_RETRY_SCHEDULE_MS = "60000";

const { ProviderGaveUpError, startProviderRetryUnit, withProviderRetry } = await import("./memory-bench/recall-engine.mjs");
const { IsolatedPersistentAgentWorkerTurnError } = await import("../src/persistent-agent-worker-runtime.js");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
const within = <T>(ms: number, promise: Promise<T>) => Promise.race([promise, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms))]);

try {
	startProviderRetryUnit();
	let calls = 0;
	const refused = await within(5_000, withProviderRetry("the Remember of a session", async () => {
		calls += 1;
		throw new IsolatedPersistentAgentWorkerTurnError("remember worker", "error", "The model refused to answer this request.");
	}).then(() => null, (error: unknown) => error));
	assert(refused instanceof ProviderGaveUpError && refused.attempts === 1 && calls === 1, `a refusal gives up at its first attempt and marks the instance, got ${refused instanceof Error ? refused.message : String(refused)} after ${calls} calls`);
	assert(/refused/i.test(refused.lastMessage), `the failure names the refusal, got ${refused.lastMessage}`);

	// An overload is still waited out on the schedule.
	process.env.RECALL_BENCH_RETRY_SCHEDULE_MS = "10";
	startProviderRetryUnit();
	let tries = 0;
	const answered = await within(5_000, withProviderRetry("a fold", async () => {
		tries += 1;
		if (tries === 1) throw new IsolatedPersistentAgentWorkerTurnError("memorize fold worker", "error", "529 overloaded_error: Overloaded");
		return "answered";
	}));
	assert(answered === "answered" && tries === 2, `an overload is tried again, got ${answered} after ${tries} tries`);
	console.log("recall bench fail-fast smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	process.exitCode = 1;
} finally {
	fs.rmSync(tempHome, { recursive: true, force: true });
}
