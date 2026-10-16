import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertRepositoryBudget, disposeAllCheckouts, RepositoryBudgetError, withRepositoryBudget } from "../src/skills-repo-fetch.js";
import { checkSkillLibrary, readSkillLibraries, saveSkillLibrary } from "../src/skills-libraries.js";

const realNow = Date.now;
let clock = 10_000;
let completedOperations = 0;
try {
	Date.now = () => clock;
	await assert.rejects(withRepositoryBudget(async () => {
		await withRepositoryBudget(async () => {
			clock += 45;
			assertRepositoryBudget();
			completedOperations += 1;
		});
		// The nested call's generous default cannot extend the earlier parent deadline.
		await withRepositoryBudget(async () => { clock += 45; completedOperations += 1; });
	}, 60), RepositoryBudgetError);
	assert.equal(completedOperations, 2, "sequential scan and candidate scopes cannot reset the preparation's cumulative budget");
	assert.equal(await withRepositoryBudget(async () => "independent operation"), "independent operation", "an expired request cannot poison another request's scope");
} finally { Date.now = realNow; }

const work = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-repository-budget-"));
const previousState = process.env.EXXPERTS_STATE_HOME;
const previousLocal = process.env.EXXETA_SKILLS_ALLOW_LOCAL_REPO;
process.env.EXXPERTS_STATE_HOME = path.join(work, "profile");
process.env.EXXETA_SKILLS_ALLOW_LOCAL_REPO = "1";
try {
	const repo = path.join(work, "repo");
	fs.mkdirSync(repo);
	fs.writeFileSync(path.join(repo, "SKILL.md"), "---\nname: budget-skill\n---\nBudget fixture.\n");
	const git = (args: string[]) => {
		const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
	};
	git(["init", "-q", "-b", "main"]);
	git(["config", "uploadpack.allowFilter", "true"]);
	git(["add", "-A"]);
	git(["-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-qm", "fixture"]);
	const first = saveSkillLibrary({ name: "Expired source", source: repo });
	const second = saveSkillLibrary({ name: "Continuing source", source: repo });
	clock = realNow();
	Date.now = () => clock;
	try {
		await assert.rejects(withRepositoryBudget(() => {
			const pending = checkSkillLibrary(first.id);
			clock += 1000;
			return pending;
		}, 100), RepositoryBudgetError);
	} finally { Date.now = realNow; }
	assert.equal(readSkillLibraries().find((source) => source.id === first.id)?.status, "error", "expired source records its error");
	const next = await checkSkillLibrary(second.id);
	assert.equal(next.status, "current", "another source continues after the expired source releases its slot; unselected new skills do not create an installed-update badge");
	assert.equal(next.updates?.[0]?.status, "new", "new skills remain discoverable without being treated as updates to installed content");
	console.log("skills-repository-budget-smoke: OK");
} finally {
	disposeAllCheckouts();
	if (previousState === undefined) delete process.env.EXXPERTS_STATE_HOME; else process.env.EXXPERTS_STATE_HOME = previousState;
	if (previousLocal === undefined) delete process.env.EXXETA_SKILLS_ALLOW_LOCAL_REPO; else process.env.EXXETA_SKILLS_ALLOW_LOCAL_REPO = previousLocal;
	fs.rmSync(work, { recursive: true, force: true });
}
