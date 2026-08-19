import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-skill-exec-"));
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const {
	readPersistentRoomSkillSettings,
	enablePersistentRoomSkill,
	approvePersistentRoomSkillExecution,
	revokePersistentRoomSkillExecution,
	computeSkillStatuses,
} = await import("../src/persistent-room-skill-settings.js");
const { computeSkillFilesDigest } = await import("../src/skills-store.js");
const { createReadSkillTool } = await import("../src/persistent-room-skill-tool.js");

const agentId = "skill-exec-smoke-room";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// A real on-disk skill dir, so the digest walks actual bytes.
const skillDir = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-skill-exec-dir-"));
const manifest = "---\nname: convert-docs\ndescription: Convert documents\n---\n\nRun the bundled script.\n";
fs.writeFileSync(path.join(skillDir, "SKILL.md"), manifest);
fs.mkdirSync(path.join(skillDir, "scripts"));
fs.writeFileSync(path.join(skillDir, "scripts", "convert.py"), "print('convert')\n");
// The provenance sidecar must NOT count toward the digest (it is bookkeeping).
fs.writeFileSync(path.join(skillDir, "provenance.json"), "{}\n");

const library = new Map<string, string>([["convert-docs", manifest]]);
const resolveBody = (name: string): string | null => library.get(name) ?? null;
const currentDigest = (): string | null => computeSkillFilesDigest(skillDir)?.filesSha256 ?? null;

try {
	// --- Digest semantics -----------------------------------------------------
	const digest = computeSkillFilesDigest(skillDir);
	assert(digest, "a dir with a SKILL.md must digest");
	assert(digest.files.map((f) => f.path).join(",") === "SKILL.md,scripts/convert.py", "digest walks exactly the content files, sorted, provenance excluded");
	const before = digest.filesSha256;
	fs.appendFileSync(path.join(skillDir, "scripts", "convert.py"), "# changed\n");
	assert(currentDigest() !== before, "editing a bundled file must change the whole-content digest");
	fs.writeFileSync(path.join(skillDir, "scripts", "extra.sh"), "echo extra\n");
	const withExtra = currentDigest();
	fs.rmSync(path.join(skillDir, "scripts", "extra.sh"));
	assert(withExtra !== currentDigest(), "adding/removing a file must change the digest");
	assert(computeSkillFilesDigest(path.join(skillDir, "scripts")) === null, "a dir without SKILL.md must not digest");

	// --- Approval requires enablement, pins server-side, survives re-pin ------
	const early = approvePersistentRoomSkillExecution(agentId, "convert-docs", currentDigest);
	assert(!early.ok && early.reason === "not-enabled", "approval before enablement must be refused");

	assert(enablePersistentRoomSkill(agentId, "convert-docs", resolveBody).ok, "enable should succeed");
	const noFiles = approvePersistentRoomSkillExecution(agentId, "convert-docs", () => null);
	assert(!noFiles.ok && noFiles.reason === "no-files", "a non-executable skill must not approve");

	const approved = approvePersistentRoomSkillExecution(agentId, "convert-docs", currentDigest);
	assert(approved.ok, "approval of an enabled executable skill should succeed");
	const pinned = approved.ok ? approved.settings.enabledSkills[0].executeApproval : undefined;
	assert(pinned && pinned.filesSha256 === currentDigest(), "approval pins the current server-computed digest");

	// Survives a settings read/write cycle (sanitize keeps well-formed approvals)...
	const reread = readPersistentRoomSkillSettings(agentId);
	assert(reread.enabledSkills[0].executeApproval?.filesSha256 === pinned!.filesSha256, "approval must survive the read path");
	// ...and a re-enable re-pin (the digest pin is its own guard).
	assert(enablePersistentRoomSkill(agentId, "convert-docs", resolveBody).ok, "re-enable should succeed");
	assert(readPersistentRoomSkillSettings(agentId).enabledSkills[0].executeApproval, "re-enabling must not drop the approval");
	// A mangled approval on disk degrades to never-approved, not a crash.
	const settingsFile = path.join(root, agentId, "runtime", "skill-settings.json");
	const rawSettings = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
	rawSettings.enabledSkills[0].executeApproval = { filesSha256: "not-a-hash", approvedAt: 42 };
	fs.writeFileSync(settingsFile, JSON.stringify(rawSettings));
	assert(!readPersistentRoomSkillSettings(agentId).enabledSkills[0].executeApproval, "a mangled approval must degrade to none");
	assert(approvePersistentRoomSkillExecution(agentId, "convert-docs", currentDigest).ok, "re-approving after the mangle should succeed");

	// --- Status view: approved vs drifted -------------------------------------
	let statuses = computeSkillStatuses(readPersistentRoomSkillSettings(agentId).enabledSkills, resolveBody, currentDigest);
	assert(statuses[0].executeState === "approved", "matching digest must read approved");
	fs.appendFileSync(path.join(skillDir, "scripts", "convert.py"), "# drifted\n");
	statuses = computeSkillStatuses(readPersistentRoomSkillSettings(agentId).enabledSkills, resolveBody, currentDigest);
	assert(statuses[0].executeState === "drifted", "a changed file set must read drifted");
	statuses = computeSkillStatuses(readPersistentRoomSkillSettings(agentId).enabledSkills, resolveBody);
	assert(statuses[0].executeState === undefined, "without a digest resolver the status view stays as before");

	// --- read_skill exposure: only through the resolver, path-free otherwise --
	// Same cast the sibling skill-tool smoke uses: the tool's full execute
	// signature carries harness-only parameters this smoke never exercises.
	const readTool = (resolver?: (name: string) => { skillDir: string; files: string[] } | null) =>
		createReadSkillTool({
			agentId,
			lookupSkill: (name) => (library.has(name) ? { manifest, body: "Run the bundled script.", description: "Convert documents" } : null),
			...(resolver ? { resolveExecutionExposure: resolver } : {}),
		}) as unknown as {
			execute(toolCallId: string, params: { name: string }): Promise<{ content: Array<{ text: string }>; details?: { outcome?: string; executionExposed?: boolean } }>;
		};
	const bare = await readTool().execute("t1", { name: "convert-docs" });
	assert(!bare.content[0].text.includes(skillDir), "without a resolver the body must never carry a path");
	const closed = await readTool(() => null).execute("t2", { name: "convert-docs" });
	assert(!closed.content[0].text.includes(skillDir), "a closed gate chain must serve the body path-free");
	assert(closed.details?.executionExposed === undefined, "a closed gate chain must not flag exposure");
	const open = await readTool((name) => (name === "convert-docs" ? { skillDir, files: ["scripts/convert.py"] } : null)).execute("t3", { name: "convert-docs" });
	assert(open.content[0].text.includes(skillDir), "an open gate chain must name the skill dir");
	assert(open.content[0].text.includes("scripts/convert.py"), "an open gate chain must list the bundled files");
	assert(open.details?.executionExposed === true, "exposure must be flagged in the details");

	// --- Revoke: idempotent, skill stays enabled ------------------------------
	const revoked = revokePersistentRoomSkillExecution(agentId, "convert-docs");
	assert(revoked.ok && !revoked.settings.enabledSkills[0].executeApproval, "revoke must clear the approval");
	assert(revoked.ok && revoked.settings.enabledSkills.length === 1, "revoke must keep the skill enabled");
	assert(revokePersistentRoomSkillExecution(agentId, "convert-docs").ok, "revoking twice is a no-op, not an error");

	console.log("skills-execution-approval-smoke: OK");
} finally {
	fs.rmSync(root, { recursive: true, force: true });
	fs.rmSync(skillDir, { recursive: true, force: true });
}
