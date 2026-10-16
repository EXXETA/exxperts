import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { withRepositoryProgress, reportRepositoryProgress, readRepositoryProgress } from "../src/skills-repository-progress.js";
import { classifyRemoteRoute } from "../src/remote-route-policy.js";

const originalHome = process.env.EXXPERTS_STATE_HOME;
const originalNow = Date.now;
try {
	assert.equal(classifyRemoteRoute("GET", "/api/skills/repo/progress/:id"), "local");
	await assert.rejects(withRepositoryProgress("../invalid", async () => assert.fail("invalid ID cannot start work")), /Invalid/);
	const id = randomUUID();
	let release!: () => void;
	const pending = withRepositoryProgress(id, async () => {
		reportRepositoryProgress("Reading selected references", 2, 5);
		await new Promise<void>((resolve) => { release = resolve; });
		reportRepositoryProgress("Reading selected references", 5, 5);
		return "unchanged operation result";
	});
	assert.deepEqual(readRepositoryProgress(id)?.completed, 2);
	assert.equal(readRepositoryProgress(id)?.status, "running");
	await assert.rejects(withRepositoryProgress(id, async () => assert.fail("same ID cannot replace an active operation")), /already in use/);
	const other = randomUUID();
	await withRepositoryProgress(other, async () => { reportRepositoryProgress("Another request", 1, 1); });
	assert.equal(readRepositoryProgress(id)?.completed, 2, "concurrent request counters remain independent");
	const before = readRepositoryProgress(id)!;
	before.message = "Caller altered a copy";
	assert.equal(readRepositoryProgress(id)?.message, "Reading selected references");
	process.env.EXXPERTS_STATE_HOME = `${originalHome ?? "C:/Synthetic"}-other-profile`;
	assert.equal(readRepositoryProgress(id), null, "another profile cannot read these counters");
	if (originalHome === undefined) delete process.env.EXXPERTS_STATE_HOME; else process.env.EXXPERTS_STATE_HOME = originalHome;
	release();
	assert.equal(await pending, "unchanged operation result");
	assert.equal(readRepositoryProgress(id)?.completed, 5);
	assert.equal(readRepositoryProgress(id)?.status, "complete");
	const failed = randomUUID();
	await assert.rejects(withRepositoryProgress(failed, async () => { throw new Error("Synthetic fetch failure"); }), /Synthetic fetch failure/);
	assert.equal(readRepositoryProgress(failed)?.status, "failed");
	assert.equal(await withRepositoryProgress(undefined, async () => "legacy"), "legacy");
	const releases: Array<() => void> = [];
	const activeIds = Array.from({ length: 128 }, () => randomUUID());
	const active = activeIds.map((activeId) => withRepositoryProgress(activeId, () => new Promise<void>((resolve) => releases.push(resolve))));
	await assert.rejects(withRepositoryProgress(randomUUID(), async () => assert.fail("a full progress store cannot start more work")), /Too many/);
	assert.equal(readRepositoryProgress(activeIds[0])?.status, "running", "bounded storage preserves active operations");
	releases.forEach((resolve) => resolve());
	await Promise.all(active);
	Date.now = () => originalNow() + 16 * 60_000;
	assert.equal(readRepositoryProgress(activeIds[0]), null, "old progress expires");
	console.log("skills-repository-progress-smoke: OK");
} finally {
	Date.now = originalNow;
	if (originalHome === undefined) delete process.env.EXXPERTS_STATE_HOME; else process.env.EXXPERTS_STATE_HOME = originalHome;
}
