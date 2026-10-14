// The recall bench's REAL-model setup, without a real model or a real sign-in.
//
// A real-model run of the LongMemEval adapter must reach the person's sign-in
// where it lives: a COPY whose OAuth pair the runtime refreshes during the run
// leaves the original's pair dead. And the provider's sign-in must select the
// product's own profile. This smoke pins, against a synthetic agent dir with
// dummy files and a temp HOME, so nothing here can reach a real record:
//   - the provider's profile id is the product's own (ChatGPT's sign-in is the
//     "chatgpt-codex" profile), and a model spec reads provider/model;
//   - with RECALL_BENCH_AGENT_DIR set, the run's home gets no models.json or
//     auth.json, the workers and the server read the named dir, and its files
//     are left byte for byte as they were;
//   - a real run that names no sign-in is told both ways to name one. Only the
//     answer is checked, never the copy from the home: that path reads the
//     person's real sign-in, so no test here goes near it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { benchProfileIdFor, parseBenchModelSpec, prepareBenchHome, SIGN_IN_FROM_HOME_FLAG, signInSourceProblem, useRealProviderRecords } from "./memory-bench/recall-engine.mjs";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "recall-bench-real-path-"));
process.env.HOME = scratch;
process.env.USERPROFILE = scratch;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// --- 1. The provider's profile id, and a model spec --------------------------------
{
	const { PERSISTENT_AGENT_AI_PROFILES } = await import("../src/persistent-agent-ai-profiles.js");
	for (const profile of Object.values(PERSISTENT_AGENT_AI_PROFILES)) {
		assert(benchProfileIdFor(profile.providerId) === profile.id, `the ${profile.providerId} sign-in belongs to the "${profile.id}" profile, and the bench names "${benchProfileIdFor(profile.providerId)}"`);
	}
	assert(benchProfileIdFor("openai-compatible") === "openai-compatible", "a gateway's profile is its provider id");
	assert(JSON.stringify(parseBenchModelSpec("openai-codex/gpt-6-sol", "x")) === JSON.stringify({ provider: "openai-codex", model: "gpt-6-sol" }), "a spec reads provider/model");
	for (const bad of ["gpt-6-sol", "/gpt", "openai-codex/"]) {
		let threw = false;
		try { parseBenchModelSpec(bad, "RECALL_BENCH_FOLD_MODEL"); } catch { threw = true; }
		assert(threw, `"${bad}" is refused as a model spec`);
	}
	console.log("ok profile ids and model specs");
}

// --- 2. RECALL_BENCH_AGENT_DIR: read in place, never copied -----------------------
{
	const shared = path.join(scratch, "shared-agent");
	fs.mkdirSync(shared, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(shared, "models.json"), "{\"providers\":{}}\n", { mode: 0o600 });
	fs.writeFileSync(path.join(shared, "auth.json"), "{\"dummy\":{\"type\":\"api_key\",\"key\":\"not-a-key\"}}\n", { mode: 0o600 });
	const before = [fs.readFileSync(path.join(shared, "models.json"), "utf-8"), fs.readFileSync(path.join(shared, "auth.json"), "utf-8")];
	process.env.RECALL_BENCH_AGENT_DIR = shared;
	const { home } = prepareBenchHome("real-path-smoke");
	assert(process.env.EXXPERTS_CODING_AGENT_DIR === shared, `the workers read the named agent dir, and EXXPERTS_CODING_AGENT_DIR is ${process.env.EXXPERTS_CODING_AGENT_DIR}`);
	const lock = useRealProviderRecords({ spec: "openai-codex/gpt-6-sol", signInFromHome: false });
	assert(lock.provider === "openai-codex" && lock.model === "gpt-6-sol", `the lock is the spec, got ${JSON.stringify(lock)}`);
	for (const file of ["models.json", "auth.json"]) assert(!fs.existsSync(path.join(home, ".exxperts", "agent", file)), `no ${file} is copied into the run's home`);
	const profile = JSON.parse(fs.readFileSync(path.join(home, ".exxperts", "app", "persistent-agent-ai-profile.json"), "utf-8"));
	assert(profile.profileId === "chatgpt-codex", `the ChatGPT sign-in selects the chatgpt-codex profile, got ${JSON.stringify(profile)}`);
	assert(fs.readFileSync(path.join(shared, "models.json"), "utf-8") === before[0] && fs.readFileSync(path.join(shared, "auth.json"), "utf-8") === before[1], "the named dir's files are left as they were");
	fs.rmSync(home, { recursive: true, force: true });
	console.log("ok RECALL_BENCH_AGENT_DIR is read in place");
}

// --- 3. No sign-in named: the run is told both ways ------------------------------
{
	assert(signInSourceProblem(false) === null, "with RECALL_BENCH_AGENT_DIR set, a run needs no flag");
	delete process.env.RECALL_BENCH_AGENT_DIR;
	const problem = signInSourceProblem(false);
	assert(problem !== null && problem.includes("RECALL_BENCH_AGENT_DIR") && problem.includes(SIGN_IN_FROM_HOME_FLAG) && !problem.includes("\n"), `a run with neither stops with one line naming both, got ${JSON.stringify(problem)}`);
	assert(signInSourceProblem(true) === null, "the flag is the other way to name the sign-in");
	console.log("ok a run that names no sign-in is told both ways");
}

fs.rmSync(scratch, { recursive: true, force: true });
console.log("recall-bench real-path smoke passed");
