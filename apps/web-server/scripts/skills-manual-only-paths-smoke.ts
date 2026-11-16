// A skill its author marked `disable-model-invocation: true` stays manual-only
// whichever way it comes in and after an edit, and a skill with no mark comes
// out of each way unchanged. Uploads are driven in the page, whose accept call
// names the fields it sends; a Git import runs against a fixture repository,
// whose scan in the page says which skill comes with files of its own.
// read_skill runs on the real library. Offline. Throwaway HOME.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { chromium, type Page } from "playwright";
import { agentDir, assert, baseUrl, openRoom, requestJson, startRoomStateServer, stopRoomStateServer, tempHome } from "./room-state-setup.js";
import { SMOKE_AUTH_TOKEN } from "./smoke-server-process.js";
import { closeBrowser } from "./smoke-close-context.js";

{
	const executable = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!executable || !fs.existsSync(executable)) {
		console.log("skills-manual-only-paths-smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const MARK = "disable-model-invocation: true";
const manifest = (name: string, body: string, extra: string[] = []) => ["---", `name: ${name}`, `description: About ${name}`, ...extra, "---", "", body, ""].join("\n");
const storedManifest = (name: string) => fs.readFileSync(path.join(agentDir, "skills", name, "SKILL.md"), "utf-8");
// What the app writes for an added skill, by hand: three fields, then the body.
const written = (name: string, body: string, extra: string[] = []) => ["---", `name: ${name}`, `displayName: ${name}`, `description: About ${name}`, ...extra, "---", "", body, ""].join("\n");

const fixtureDir = path.join(tempHome, "fixture-repo");
function git(args: string[]): void {
	const run = spawnSync("git", ["-c", "user.email=smoke@test", "-c", "user.name=Smoke", ...args], { cwd: fixtureDir, encoding: "utf-8" });
	if (run.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${run.stderr}`);
}
const REPO_MARKED = manifest("git-manual", "Git manual body.", [MARK]);
const REPO_PLAIN = manifest("git-plain", "Git plain body.");
for (const [name, text] of [["git-manual", REPO_MARKED], ["git-plain", REPO_PLAIN]]) {
	fs.mkdirSync(path.join(fixtureDir, name), { recursive: true });
	fs.writeFileSync(path.join(fixtureDir, name, "SKILL.md"), text);
}
fs.mkdirSync(path.join(fixtureDir, "git-files"), { recursive: true });
fs.writeFileSync(path.join(fixtureDir, "git-files", "SKILL.md"), manifest("git-files", "Git files body."));
fs.writeFileSync(path.join(fixtureDir, "git-files", "run.sh"), "echo bundled\n");
git(["init", "-q", "-b", "main"]);
git(["add", "-A"]);
git(["commit", "-q", "-m", "fixture"]);

async function zipOf(name: string, text: string): Promise<Buffer> {
	const zip = new JSZip();
	zip.file(`${name}/SKILL.md`, text);
	zip.file(`${name}/notes.txt`, "bundled\n");
	return zip.generateAsync({ type: "nodebuffer" });
}

async function uploadInPage(page: Page, filename: string, content: Buffer, id: string): Promise<void> {
	await page.getByRole("button", { name: "Add skill" }).click();
	await page.getByRole("menuitem", { name: "Upload" }).click();
	await page.locator(".skill-upload-input").setInputFiles({ name: filename, mimeType: "application/octet-stream", buffer: content });
	await page.getByRole("button", { name: "Accept and add to library" }).click();
	await page.getByText(`Added “${id}” to your library.`).waitFor({ timeout: 15_000 });
}

async function importFromGit(name: string): Promise<void> {
	const scan = await requestJson("/api/skills/repo/scan", { method: "POST", body: JSON.stringify({ source: fixtureDir }) });
	assert(scan.status === 200, `the fixture repository should scan, got ${scan.status} ${JSON.stringify(scan.body)}`);
	const imported = await requestJson("/api/skills/repo/import", { method: "POST", body: JSON.stringify({ token: scan.body.token, path: name }) });
	assert(imported.status === 201, `${name} should import, got ${imported.status} ${JSON.stringify(imported.body)}`);
}

async function edit(name: string, body: string, extra: Record<string, unknown> = {}): Promise<void> {
	const saved = await requestJson(`/api/skills/${name}`, { method: "PUT", body: JSON.stringify({ displayName: name, description: `About ${name}`, instructions: body, ...extra }) });
	assert(saved.status === 200, `${name} should save, got ${saved.status} ${JSON.stringify(saved.body)}`);
}

let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
let failure: unknown;
try {
	// The Git rows read a local path, which the server allows only under this setting.
	process.env.EXXETA_SKILLS_ALLOW_LOCAL_REPO = "1";
	await startRoomStateServer();
	const { resolveLibrarySkillManifest, skillLibraryFingerprint } = await import("../src/skills-library.js");
	const { enablePersistentRoomSkill } = await import("../src/persistent-room-skill-settings.js");
	const { createReadSkillTool } = await import("../src/persistent-room-skill-tool.js");
	const { roomId } = await openRoom("Manual Skills");
	const readSkill = createReadSkillTool({ agentId: roomId, lookupSkill: resolveLibrarySkillManifest }) as unknown as {
		execute(toolCallId: string, params: { name: string }): Promise<{ content: Array<{ text: string }>; details?: { outcome?: string } }>;
	};
	const readOutcome = async (name: string, body: string): Promise<string> => {
		enablePersistentRoomSkill(roomId, name, skillLibraryFingerprint);
		const read = await readSkill.execute(`read-${name}`, { name });
		const outcome = String(read.details?.outcome);
		assert(read.content[0].text.includes(body) === (outcome === "ok"), `${name}: its body is served only when read_skill allows it, got ${outcome}`);
		return outcome;
	};
	const staysManual = async (way: string, name: string, body: string) => {
		assert(storedManifest(name).includes(`\n${MARK}\n`), `${way}: the mark should be in the stored SKILL.md, got ${storedManifest(name)}`);
		const detail = await requestJson(`/api/skills/${name}`);
		assert(detail.body.disableModelInvocation === true, `${way}: the library should read it as manual-only`);
		const outcome = await readOutcome(name, body);
		assert(outcome === "manual-only", `${way}: read_skill should refuse it as manual-only, got ${outcome}`);
	};
	const staysPlain = async (way: string, name: string, body: string, expected: string) => {
		assert(storedManifest(name) === expected, `${way}: the stored SKILL.md should be as before, got ${storedManifest(name)}`);
		const outcome = await readOutcome(name, body);
		assert(outcome === "ok", `${way}: read_skill should serve it, got ${outcome}`);
	};

	browser = await chromium.launch({ headless: true });
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
	await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
	await page.waitForLoadState("networkidle");
	if (await page.locator(".whats-new-close").count()) await page.locator(".whats-new-close").click();
	await page.locator(".product-sidebar-footer button").first().click();
	await page.locator(".sidebar-config-menu button, .sidebar-config-menu a").filter({ hasText: /Settings/ }).first().click();
	await page.locator(".settings-dialog-nav button").filter({ hasText: "Skills" }).first().click();

	await uploadInPage(page, "file-manual.md", Buffer.from(manifest("file-manual", "File manual body.", [MARK])), "file-manual");
	await staysManual("a single-file upload", "file-manual", "File manual body.");
	await uploadInPage(page, "zip-manual.zip", await zipOf("zip-manual", manifest("zip-manual", "Zip manual body.", [MARK])), "zip-manual");
	await staysManual("a zip upload", "zip-manual", "Zip manual body.");
	assert(fs.existsSync(path.join(agentDir, "skills", "zip-manual", "notes.txt")), "a zip upload keeps its bundled file");
	await importFromGit("git-manual");
	assert(storedManifest("git-manual") === REPO_MARKED, "a Git import keeps the SKILL.md it reviewed");
	await staysManual("a Git import", "git-manual", "Git manual body.");

	await uploadInPage(page, "file-plain.md", Buffer.from(manifest("file-plain", "File plain body.")), "file-plain");
	await staysPlain("an unmarked single-file upload", "file-plain", "File plain body.", written("file-plain", "File plain body."));
	await uploadInPage(page, "zip-plain.zip", await zipOf("zip-plain", manifest("zip-plain", "Zip plain body.")), "zip-plain");
	await staysPlain("an unmarked zip upload", "zip-plain", "Zip plain body.", written("zip-plain", "Zip plain body."));
	await importFromGit("git-plain");
	await staysPlain("an unmarked Git import", "git-plain", "Git plain body.", REPO_PLAIN);

	for (const name of ["file-manual", "zip-manual", "git-manual"]) {
		await edit(name, `Edited ${name}.`);
		assert(storedManifest(name).includes(`Edited ${name}.`), `${name}: the edit should land`);
		await staysManual(`an edit of ${name}`, name, `Edited ${name}.`);
	}
	await edit("file-manual", "Edited again.", { disableModelInvocation: false });
	await staysManual("an edit that asks to drop the mark", "file-manual", "Edited again.");
	await edit("file-plain", "Edited plain.");
	await staysPlain("an edit of an unmarked skill", "file-plain", "Edited plain.", written("file-plain", "Edited plain."));
	await edit("zip-plain", "Edited zip.", { disableModelInvocation: true });
	await staysPlain("an edit that asks to add a mark", "zip-plain", "Edited zip.", written("zip-plain", "Edited zip."));

	// The scan's list says which skill comes with files that could run, in words true even for one that never may.
	await page.getByRole("button", { name: "Add skill" }).click();
	await page.getByRole("menuitem", { name: "Import from repo" }).click();
	await page.locator(".skill-import-url").fill(fixtureDir);
	await page.getByRole("button", { name: "Scan", exact: true }).click();
	const meta = async (name: string) => (await page.locator(".skill-import-option").filter({ has: page.locator(".skill-import-option-name", { hasText: name }) }).locator(".skill-import-option-meta").innerText()).trim();
	await page.locator(".skill-import-option-name").filter({ hasText: "git-files" }).waitFor({ timeout: 15_000 });
	const withFiles = await meta("git-files");
	assert(withFiles.endsWith(" · comes with files that run only if you allow them"), `a skill with a file of its own should say so, got ${JSON.stringify(withFiles)}`);
	const plain = await meta("git-plain");
	assert(!plain.includes(" · "), `a skill with only its SKILL.md should say nothing of files, got ${JSON.stringify(plain)}`);

	console.log("skills-manual-only-paths-smoke: OK");
} catch (error) {
	failure = error;
} finally {
	if (browser) await closeBrowser(browser);
	fs.rmSync(fixtureDir, { recursive: true, force: true });
	await stopRoomStateServer(failure);
}
if (failure) throw failure;
