// A skill its author marked `disable-model-invocation: true` stays manual-only
// whichever way it comes in and after an edit, and a skill with no mark comes
// out of each way unchanged. Uploads are driven in the page, whose accept call
// names the fields it sends; a Git import runs against a fixture repository,
// whose scan in the page lists each skill by name and description, with the
// tag on a by-hand one. The page also asks "Replace <name>?" for a name in the
// library and swaps its folder, and refuses a skill past the size limit with
// the server's numbers or, past the upload cap, before sending it.
// read_skill runs on the real library. In both looks of the settings window, a
// skill from the folder shared with other tools whose files open lists them on
// its page with the Scripts line; one whose files rooms can't open says why in
// its Files row and lists none; one whose name another skill has says so on
// the Skills page and its page. Offline. Throwaway HOME.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { chromium, type Page } from "playwright";
import { agentDir, assert, baseUrl, openRoom, requestJson, startRoomStateServer, stopRoomStateServer, tempHome } from "./room-state-setup.js";
import { SMOKE_AUTH_TOKEN } from "./smoke-server-process.js";
import * as skillCopy from "../../web-ui/src/skill-source-copy.js";
import { ADD_SKILL_WAYS, ADD_TO_LIBRARY, REPLACE_SKILL, replaceSkillQuestion, replacesOtherSkillLine, SKILL_BY_HAND_TAG, skillChangedSinceReviewLine, SKILL_FILES_LINES, skillNameTakenByOtherLine, SKILL_PAGE_BACK_NAME, skillPickNameLine, skillScriptsCount, skillTooBigLine } from "../../web-ui/src/skill-source-copy.js";
import { SETTINGS_LOOK_KEY, SETTINGS_LOOK_OLD } from "../../web-ui/src/settings-look.js";
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
fs.mkdirSync(path.join(fixtureDir, "git-marked-files"), { recursive: true });
fs.writeFileSync(path.join(fixtureDir, "git-marked-files", "SKILL.md"), manifest("git-marked-files", "Git marked files body.", [MARK]));
fs.writeFileSync(path.join(fixtureDir, "git-marked-files", "run.sh"), "echo bundled\n");
// Two skills of one name, each in its own folder, and one past the size limit.
for (const folder of ["twin-one", "twin-two"]) {
	fs.mkdirSync(path.join(fixtureDir, folder), { recursive: true });
	fs.writeFileSync(path.join(fixtureDir, folder, "SKILL.md"), manifest("twin-skill", `Twin body from ${folder}.`));
}
const BIG_DATA_BYTES = 8.5 * 1024 * 1024;
fs.mkdirSync(path.join(fixtureDir, "big-one"), { recursive: true });
fs.writeFileSync(path.join(fixtureDir, "big-one", "SKILL.md"), manifest("big-one", "Big body."));
fs.writeFileSync(path.join(fixtureDir, "big-one", "data.txt"), "0".repeat(BIG_DATA_BYTES));
git(["init", "-q", "-b", "main"]);
git(["add", "-A"]);
git(["commit", "-q", "-m", "fixture"]);

async function zipOf(name: string, text: string): Promise<Buffer> {
	const zip = new JSZip();
	zip.file(`${name}/SKILL.md`, text);
	zip.file(`${name}/notes.txt`, "bundled\n");
	zip.file(`${name}/scripts/run.sh`, "echo ran\n");
	return zip.generateAsync({ type: "nodebuffer" });
}

async function uploadInPage(page: Page, filename: string, content: Buffer, id: string): Promise<void> {
	await page.getByRole("button", { name: "Add skill" }).click();
	await page.getByRole("menuitem", { name: ADD_SKILL_WAYS.upload }).click();
	await page.locator(".skill-upload-input").setInputFiles({ name: filename, mimeType: "application/octet-stream", buffer: content });
	// A zip here carries one script beside SKILL.md: on the computer itself the review says the assistant can run it,
	// one its author marked for picking by hand included, whose folder opens while it is on.
	if (filename.endsWith(".zip")) {
		await page.locator(".skill-file-kind-head").filter({ hasText: /^Scripts\s*1$/ }).waitFor({ timeout: 15_000 });
		const line = await page.locator(".skill-review-scripts-text").allTextContents();
		assert(JSON.stringify(line) === JSON.stringify([`${skillScriptsCount(1)} ${SKILL_FILES_LINES.run.one}`]), `the review of ${filename} should say its script can run, got ${JSON.stringify(line)}`);
	}
	await page.getByRole("button", { name: ADD_TO_LIBRARY }).click();
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
	// Browse lists the same fixture repository.
	process.env.EXXPERTS_SKILLS_FEATURED_SOURCES = JSON.stringify([{ source: fixtureDir, author: "Smoke" }]);
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
	// A repository's candidate carries the author's mark for the review's tag; as for a zip, its script is listed as one that can run.
	const repoScan = await requestJson("/api/skills/repo/scan", { method: "POST", body: JSON.stringify({ source: fixtureDir }) });
	assert(repoScan.status === 200, `the fixture repository should scan, got ${repoScan.status}`);
	for (const [name, marked] of [["git-marked-files", true], ["git-files", false]] as const) {
		const candidate = await requestJson("/api/skills/repo/candidate", { method: "POST", body: JSON.stringify({ token: repoScan.body.token, path: name }) });
		assert(candidate.status === 200 && candidate.body.files.filter((file: { kind: string }) => file.kind === "scripts").length === 1 && candidate.body.disableModelInvocation === marked, `${name}'s candidate should carry one script and the mark ${marked}, got ${candidate.status} ${JSON.stringify(candidate.body)}`);
	}
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

	// An upload of a name already in the library asks to replace it, and Replace swaps the skill's files.
	await uploadInPage(page, "zip-swap.zip", await zipOf("zip-swap", manifest("zip-swap", "First swap body.")), "zip-swap");
	const swapZip = new JSZip();
	swapZip.file("zip-swap/SKILL.md", manifest("zip-swap", "Second swap body."));
	await page.getByRole("button", { name: "Add skill" }).click();
	await page.getByRole("menuitem", { name: ADD_SKILL_WAYS.upload }).click();
	await page.locator(".skill-upload-input").setInputFiles({ name: "zip-swap.zip", mimeType: "application/octet-stream", buffer: await swapZip.generateAsync({ type: "nodebuffer" }) });
	await page.getByText(replaceSkillQuestion("zip-swap"), { exact: true }).waitFor({ timeout: 15_000 });
	assert((await page.getByRole("button", { name: ADD_TO_LIBRARY }).count()) === 0, "the review of a name in the library offers Replace, not Add to library");
	await page.getByRole("button", { name: REPLACE_SKILL, exact: true }).click();
	await page.getByText("Replaced “zip-swap” in your library.").waitFor({ timeout: 15_000 });
	assert(storedManifest("zip-swap").includes("Second swap body.") && !fs.existsSync(path.join(agentDir, "skills", "zip-swap", "notes.txt")), `Replace leaves the new skill alone in its folder, got ${storedManifest("zip-swap")}`);

	// A skill past the limit is refused on the page in one sentence with its size: one the server measured,
	// in a zip small enough to send, and a file too big to send at all.
	const pickUpload = async (filename: string, content: Buffer) => {
		await page.getByRole("button", { name: "Add skill" }).click();
		await page.getByRole("menuitem", { name: ADD_SKILL_WAYS.upload }).click();
		await page.locator(".skill-upload-input").setInputFiles({ name: filename, mimeType: "application/octet-stream", buffer: content });
	};
	const bigSkill = new JSZip();
	const bigManifest = manifest("too-big", "Too big body.");
	const bigData = "0".repeat(8.5 * 1024 * 1024);
	bigSkill.file("too-big/SKILL.md", bigManifest);
	bigSkill.file("too-big/data.txt", bigData);
	const bigZip = await bigSkill.generateAsync({ type: "nodebuffer", compression: "STORE" });
	assert(bigZip.length < 9 * 1024 * 1024, `the too-big zip is small enough to send, got ${bigZip.length}`);
	await pickUpload("too-big.zip", bigZip);
	const measured = skillTooBigLine({ bytes: Buffer.byteLength(bigManifest) + bigData.length });
	await page.locator(".checkpoint-proposal-error").filter({ hasText: measured }).waitFor({ timeout: 30_000 });
	assert(!fs.existsSync(path.join(agentDir, "skills", "too-big")), "a refused skill writes nothing");
	await pickUpload("huge.zip", Buffer.alloc(9 * 1024 * 1024 + 1, 7));
	await page.locator(".checkpoint-proposal-error").filter({ hasText: skillTooBigLine({ bytes: 9 * 1024 * 1024, over: true }) }).waitFor({ timeout: 15_000 });

	// A written name the standard doesn't allow: the review names the "/" name, the
	// skill is added under it, and a room's "/" pick finds it there.
	const QR = "Quarterly_Report Helper";
	const QR_ID = "quarterly-report-helper";
	await pickUpload("qr.md", Buffer.from(manifest(QR, "Quarterly body.")));
	await page.getByText(skillPickNameLine(QR_ID), { exact: true }).waitFor({ timeout: 15_000 });
	await page.getByRole("button", { name: ADD_TO_LIBRARY }).click();
	await page.getByText(`Added “${QR}” to your library.`).waitFor({ timeout: 15_000 });
	assert(/^name: Quarterly_Report Helper$/m.test(storedManifest(QR_ID)), `its name line is the written name, got ${storedManifest(QR_ID)}`);
	enablePersistentRoomSkill(roomId, QR_ID, skillLibraryFingerprint);
	const { resolveSkillPick } = await import("../src/skill-pick.js");
	const picked = resolveSkillPick(roomId, `/${QR_ID} make the report`, resolveLibrarySkillManifest);
	assert(picked?.outcome === "loaded" && picked.instructions.includes("Quarterly body."), `a "/" pick finds it, got ${JSON.stringify(picked)}`);
	// Another written name on the same "/" name: the review says the skill there is a different one.
	await pickUpload("other.md", Buffer.from(manifest("quarterly report helper", "Another body.")));
	await page.getByText(replaceSkillQuestion(QR_ID), { exact: true }).waitFor({ timeout: 15_000 });
	await page.getByText(replacesOtherSkillLine(QR, QR_ID), { exact: true }).waitFor({ timeout: 15_000 });
	await page.getByRole("button", { name: REPLACE_SKILL, exact: true }).click();
	await page.getByText("Replaced “quarterly report helper” in your library.").waitFor({ timeout: 15_000 });
	assert(storedManifest(QR_ID).includes("Another body."), "Replace puts the other skill in its place");
	// The skill changes while a Replace review is open: Replace is refused in one sentence, and only Cancel is left.
	await pickUpload("again.md", Buffer.from(manifest("quarterly report helper", "Third body.")));
	await page.getByText(replaceSkillQuestion(QR_ID), { exact: true }).waitFor({ timeout: 15_000 });
	const changed = await requestJson(`/api/skills/${QR_ID}`, { method: "PUT", body: JSON.stringify({ id: QR_ID, displayName: "quarterly report helper", description: "changed elsewhere", instructions: "Changed elsewhere." }) });
	assert(changed.status === 200, `the skill is changed elsewhere, got ${changed.status}`);
	await page.getByRole("button", { name: REPLACE_SKILL, exact: true }).click();
	await page.getByText(skillChangedSinceReviewLine(QR_ID), { exact: true }).waitFor({ timeout: 15_000 });
	assert((await page.getByRole("button", { name: REPLACE_SKILL, exact: true }).count()) === 0, "after the refusal the review offers no Replace");
	assert(storedManifest(QR_ID).includes("Changed elsewhere."), `the refused Replace leaves the changed skill, got ${storedManifest(QR_ID)}`);
	await page.locator(".skill-review-actions").getByRole("button", { name: "Cancel" }).click();

	// Each skill the scan found shows its name and description only, whether it has files of its own or not:
	// whether they run is the room's, not the import's.
	await page.getByRole("button", { name: "Add skill" }).click();
	await page.getByRole("menuitem", { name: ADD_SKILL_WAYS.repository }).click();
	await page.locator(".skill-import-url").fill(fixtureDir);
	await page.getByRole("button", { name: "Scan", exact: true }).click();
	const option = async (name: string) => (await page.locator(".skill-import-option").filter({ has: page.locator(".skill-import-option-name", { hasText: new RegExp(`^${name}$`) }) }).innerText()).replace(/\s+/g, " ").trim();
	await page.locator(".skill-import-option-name").filter({ hasText: "git-files" }).waitFor({ timeout: 15_000 });
	for (const name of ["git-files", "git-plain"]) {
		const shown = await option(name);
		assert(shown === `${name} About ${name}`, `${name} should show its name and description only, got ${JSON.stringify(shown)}`);
	}
	const markedName = page.locator(".skill-import-option-name").filter({ hasText: /^git-marked-files/ });
	const markedTags = await markedName.locator(".skill-tag").allInnerTexts();
	assert(JSON.stringify(markedTags) === JSON.stringify([SKILL_BY_HAND_TAG]), `the marked skill carries the by-hand tag after its name, got ${JSON.stringify(markedTags)}`);
	const plainTags = await page.locator(".skill-import-option-name").filter({ hasText: /^git-files/ }).locator(".skill-tag").count();
	assert(plainTags === 0, `an unmarked skill carries no tag, got ${plainTags}`);

	// Two skills of one name each show their folder; adding one leaves the other pickable.
	// One past the size limit says so where its description is, and can't be picked.
	const scanRow = (folder: string) => page.locator(".skill-import-option").filter({ has: page.locator(".skill-import-option-desc", { hasText: new RegExp(`^${folder}$`) }) });
	for (const folder of ["twin-one", "twin-two"]) assert((await scanRow(folder).count()) === 1, `the scan's twin in ${folder} shows its folder`);
	const bigRow = page.locator(".skill-import-option").filter({ has: page.locator(".skill-import-option-name", { hasText: /^big-one$/ }) });
	const bigLine = skillTooBigLine({ bytes: Buffer.byteLength(manifest("big-one", "Big body.")) + BIG_DATA_BYTES });
	// A row that can be picked is a button that opens its review.
	const pickable = (row: ReturnType<Page["locator"]>) => row.evaluate((element) => element.matches("button:enabled"));
	assert((await bigRow.innerText()).includes(bigLine) && !(await pickable(bigRow)), `the scan's too-big row says so and can't be picked, got ${JSON.stringify(await bigRow.innerText())}`);
	await scanRow("twin-one").click();
	await page.getByRole("button", { name: ADD_TO_LIBRARY }).click();
	await scanRow("twin-one").filter({ hasText: "✓ Added" }).waitFor({ timeout: 15_000 });
	assert(!(await pickable(scanRow("twin-one"))), "the added twin can't be picked again");
	assert(await pickable(scanRow("twin-two")), "the other twin can still be picked");

	// Browse, from the same repository: the same folders and the same too-big row.
	await page.getByRole("button", { name: SKILL_PAGE_BACK_NAME, exact: true }).click();
	await page.getByRole("button", { name: "Add skill" }).click();
	await page.getByRole("menuitem", { name: ADD_SKILL_WAYS.featured, exact: true }).click();
	const browseRow = (folder: string) => page.locator(".skill-browse-directory .settings-row").filter({ has: page.locator(".settings-row-sub", { hasText: new RegExp(`^${folder}$`) }) });
	await browseRow("twin-one").waitFor({ timeout: 30_000 });
	assert((await browseRow("twin-two").count()) === 1, "Browse's twin in twin-two shows its folder");
	const browseBig = page.locator(".skill-browse-directory .settings-row").filter({ has: page.locator(".settings-row-label", { hasText: /^big-one$/ }) });
	assert((await browseBig.innerText()).includes(bigLine) && (await browseBig.getByRole("button").count()) === 0, `Browse's too-big row says so and can't be added, got ${JSON.stringify(await browseBig.innerText())}`);
	// The twin added by the scan is in the library, so adding the other asks to replace it.
	await browseRow("twin-two").getByRole("button", { name: "Review and add twin-skill" }).click();
	await page.getByText(replaceSkillQuestion("twin-skill"), { exact: true }).waitFor({ timeout: 15_000 });
	await page.getByRole("button", { name: REPLACE_SKILL, exact: true }).click();
	await browseRow("twin-two").getByText("Added", { exact: true }).waitFor({ timeout: 15_000 });
	assert(await browseRow("twin-one").getByRole("button", { name: "Review and add twin-skill" }).isEnabled(), "Browse's other twin can still be added");
	assert(storedManifest("twin-skill").includes("Twin body from twin-two."), `Replace put the other twin in its place, got ${storedManifest("twin-skill")}`);

	// Skills from the folder shared with other tools, on their pages in both looks.
	const sharedDir = path.join(tempHome, ".agents", "skills");
	const plantShared = (dir: string, name: string, files: Record<string, string>): string => {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "SKILL.md"), manifest(name, `${name} body.`));
		for (const [file, text] of Object.entries(files)) {
			fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
			fs.writeFileSync(path.join(dir, file), text, { mode: file.endsWith(".sh") ? 0o755 : 0o644 });
		}
		return dir;
	};
	const linkShared = (target: string, name: string): void => fs.symlinkSync(target, path.join(sharedDir, name), process.platform === "win32" ? "junction" : "dir");
	plantShared(path.join(sharedDir, "shared-open"), "shared-open", { "scripts/run.sh": "echo ran\n", "reference.md": "notes\n" });
	linkShared(plantShared(path.join(tempHome, "away", "shared-away"), "shared-away", { "scripts/run.sh": "echo ran\n" }), "shared-away");
	linkShared(plantShared(path.join(tempHome, "away", "shared-away-notes"), "shared-away-notes", { "reference.md": "notes\n" }), "shared-away-notes");
	// A link to the home folder: rooms use only its instructions.
	linkShared(plantShared(tempHome, "shared-home", {}), "shared-home");
	// A real folder whose path holds a zero-width space: rooms can't open it.
	linkShared(plantShared(path.join(tempHome, ".agents", "kept", "zero\u200bwidth"), "shared-closed", { "scripts/run.sh": "echo ran\n" }), "shared-closed");
	// Its written name fits onto file-manual, which the person's own skill has.
	plantShared(path.join(sharedDir, "file_manual"), "File Manual", {});
	const keptLines = ((skillCopy as Record<string, any>).SKILL_INSTRUCTIONS_ONLY_LINES ?? {}) as Record<string, string>;
	const filesAtLine = (place: string): string => (skillCopy as Record<string, any>).skillFilesAtLine?.(place) ?? "(no files-at line)";
	const takenLine = skillNameTakenByOtherLine("file-manual");
	const lookFailed: string[] = [];
	const check = (condition: unknown, message: string): void => {
		if (!condition) lookFailed.push(message);
	};
	for (const look of ["old", "new"] as const) {
		const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		if (look === "old") await context.addInitScript(([key, old]) => localStorage.setItem(key, old), [SETTINGS_LOOK_KEY, SETTINGS_LOOK_OLD]);
		const lookPage = await context.newPage();
		await lookPage.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await lookPage.waitForLoadState("networkidle");
		if (await lookPage.locator(".whats-new-close").count()) await lookPage.locator(".whats-new-close").click();
		await lookPage.locator(".product-sidebar-footer button").first().click();
		await lookPage.locator(".sidebar-config-menu button, .sidebar-config-menu a").filter({ hasText: /Settings/ }).first().click();
		await lookPage.locator(".settings-dialog-nav button").filter({ hasText: "Skills" }).first().click();
		const rowNamed = (name: string) => lookPage.locator(".skill-table-row").filter({ has: lookPage.locator(".skill-table-name-text", { hasText: new RegExp(`^${name}$`) }) });
		await rowNamed("shared-open").waitFor({ timeout: 15_000 });
		check((await rowNamed("File Manual").innerText()).includes(takenLine), `${look} look: the Skills page says another skill has the name, got ${JSON.stringify(await rowNamed("File Manual").innerText())}`);
		/** Opens a skill's page, hands it to `read`, and goes back to the list. */
		const onPage = async (name: string, read: (detail: ReturnType<Page["locator"]>) => Promise<void>): Promise<void> => {
			await rowNamed(name).click();
			const detail = lookPage.locator(".skill-detail");
			await detail.waitFor({ timeout: 15_000 });
			await read(detail);
			await detail.locator(look === "new" ? ".pane-head-back" : ".skill-detail-back").click();
			await rowNamed(name).waitFor({ timeout: 15_000 });
		};
		const filesRowLine = async (detail: ReturnType<Page["locator"]>): Promise<string | null> => {
			const row = detail.locator(".settings-row").filter({ has: lookPage.locator(".settings-row-label", { hasText: /^Files$/ }) }).locator(".settings-row-sub");
			return (await row.count()) ? (await row.innerText()).trim() : null;
		};
		// The Files row's line reads like its neighbours' facts: "Files" styled as "From" is, the line given more
		// than half the row, not squeezed into the label's column (which broke a path at its hyphens), and close under its count.
		// No named function inside the page's code: tsx would wrap it in a helper the page lacks.
		const filesRowShape = async (detail: ReturnType<Page["locator"]>): Promise<string> => detail.evaluate((pane) => {
			const labels = [...pane.querySelectorAll(".settings-row > .settings-row-label")];
			const files = labels.find((label) => label.textContent === "Files");
			const from = labels.find((label) => label.textContent === "From");
			const line = files?.parentElement?.querySelector(":scope > .skill-fact-line");
			if (!files || !from || !line) return "no Files label, From label or line, each a child of its row";
			const [filesStyle, fromStyle] = [files, from].map((label) => [getComputedStyle(label).color, getComputedStyle(label).fontWeight, getComputedStyle(label).fontSize].join(" "));
			if (filesStyle !== fromStyle) return `"Files" is ${filesStyle}, "From" is ${fromStyle}`;
			const share = line.getBoundingClientRect().width / files.parentElement!.getBoundingClientRect().width;
			if (share <= 0.5) return `the line has ${Math.round(share * 100)}% of the row`;
			// Under a count, the line follows it as the next line of the same fact, not a row's gap below.
			const count = files.parentElement!.querySelector(":scope > .skill-fact-value");
			const below = count ? Math.round(line.getBoundingClientRect().top - count.getBoundingClientRect().bottom) : 0;
			return below <= 8 ? "ok" : `the line starts ${below} px under the count`;
		});
		await onPage("shared-open", async (detail) => {
			// Each kind folds its names away; its head says the kind and how many, in either look.
			const heads = (await detail.locator(".skill-file-kind-head").allInnerTexts()).map((text) => text.replace(/[\s()▸▾]+/g, ""));
			const scripts = detail.locator(".skill-file-kind").filter({ has: lookPage.locator(".skill-file-kind-head", { hasText: "Scripts" }) });
			check(JSON.stringify(heads) === JSON.stringify(["Instructions1", "Documents1", "Scripts1"]), `${look} look: an open shared-folder skill's page lists its script and its other file by kind, got ${JSON.stringify(heads)}`);
			check(JSON.stringify(await scripts.locator(".skill-file-kind-line").allTextContents()) === JSON.stringify([SKILL_FILES_LINES.run.one]), `${look} look: with today's Scripts line, got ${JSON.stringify(await scripts.locator(".skill-file-kind-line").allTextContents())}`);
			check(await filesRowLine(detail) === null, `${look} look: and no reason`);
			check((await detail.innerText()).includes("It lives in ~/.agents/skills, which other tools manage. Delete it there to remove it."), `${look} look: the Delete row's line stays`);
		});
		// A skill whose scripts a protected room on this Windows computer reads but can't run (the answer's scriptsReadOnly,
		// which skills-room-folders-smoke pins on the server): its Scripts line says so in place of "can run".
		const oneSkill = /\/api\/skills\/shared-open(\?|$)/;
		await lookPage.route(oneSkill, async (route) => {
			const response = await route.fetch();
			await route.fulfill({ response, json: { ...(await response.json()), scriptsReadOnly: true } });
		});
		await onPage("shared-open", async (detail) => {
			const scripts = detail.locator(".skill-file-kind").filter({ has: lookPage.locator(".skill-file-kind-head", { hasText: "Scripts" }) });
			const lines = await scripts.locator(".skill-file-kind-line").allTextContents();
			check(JSON.stringify(lines) === JSON.stringify([(SKILL_FILES_LINES as Record<string, { one: string }>).readOnly?.one ?? "(no read-only line)"]), `${look} look: a skill whose scripts can't run here says so, got ${JSON.stringify(lines)}`);
		});
		await lookPage.unroute(oneSkill);
		for (const [name, files] of [["shared-away", ["Instructions1", "Scripts1"]], ["shared-away-notes", ["Instructions1", "Documents1"]]] as const) {
			await onPage(name, async (detail) => {
				const heads = (await detail.locator(".skill-file-kind-head").allInnerTexts()).map((text) => text.replace(/[\s()▸▾]+/g, ""));
				check(JSON.stringify(heads) === JSON.stringify(files), `${look} look: ${name}, linked outside ~/.agents, lists its files by kind, got ${JSON.stringify(heads)}`);
				check(await filesRowLine(detail) === filesAtLine(`~/away/${name}`), `${look} look: ${name}'s Files row says where its files are, got ${JSON.stringify(await filesRowLine(detail))}`);
				check(await filesRowShape(detail) === "ok", `${look} look: ${name}'s Files row reads like its neighbours, got ${await filesRowShape(detail)}`);
				// Squeezed to nine characters, the path still breaks only after a "/": no folder's name is cut at its hyphen.
				const path = await detail.locator(".skill-fact-line").first().evaluate((line) => {
					(line as HTMLElement).style.maxWidth = "9ch";
					const parts = [...line.querySelectorAll(".skill-path-part")];
					const cut = parts.filter((part) => part.getClientRects().length > 1).map((part) => part.textContent);
					(line as HTMLElement).style.maxWidth = "";
					return { whole: parts.map((part) => part.textContent).join("/"), cut };
				});
				check(path.whole === `~/away/${name}` && path.cut.length === 0, `${look} look: ${name}'s path breaks only after a "/", got ${JSON.stringify(path)}`);
			});
		}
		// A Windows computer's answer writes the path with "\\" (faked here): it breaks after each one, inside the row.
		const windowsPlace = "~\\Documents\\company-team\\department-tools\\monthly-reports\\slides-helper";
		const awaySkill = /\/api\/skills\/shared-away(\?|$)/;
		await lookPage.route(awaySkill, async (route) => {
			const response = await route.fetch();
			await route.fulfill({ response, json: { ...(await response.json()), filesAt: windowsPlace } });
		});
		await onPage("shared-away", async (detail) => {
			const line = detail.locator(".skill-fact-line").first();
			const fits = await line.evaluate((element) => {
				(element as HTMLElement).style.maxWidth = "24ch";
				const parts = [...element.querySelectorAll(".skill-path-part")];
				const result = { lines: new Set([...element.getClientRects()].map((rect) => Math.round(rect.top))).size, cut: parts.filter((part) => part.getClientRects().length > 1).map((part) => part.textContent), overflow: element.scrollWidth > element.clientWidth + 1 };
				(element as HTMLElement).style.maxWidth = "";
				return result;
			});
			check((await line.innerText()).trim() === filesAtLine(windowsPlace), `${look} look: a Windows path shows as written, got ${JSON.stringify(await line.innerText())}`);
			check(fits.cut.length === 0 && !fits.overflow, `${look} look: a Windows path breaks after its "\\", inside the row, got ${JSON.stringify(fits)}`);
		});
		await lookPage.unroute(awaySkill);
		for (const [name, reason] of [["shared-home", "home"], ["shared-closed", "cant-open"]] as const) {
			await onPage(name, async (detail) => {
				check(await filesRowLine(detail) === (keptLines[reason] ?? "(no line)"), `${look} look: ${name}'s Files row says why rooms use only its instructions, got ${JSON.stringify(await filesRowLine(detail))}`);
				check(await filesRowShape(detail) === "ok", `${look} look: ${name}'s Files row reads like its neighbours, got ${await filesRowShape(detail)}`);
				check(await detail.locator(".skill-file-kind").count() === 0, `${look} look: ${name}'s page lists no files`);
			});
		}
		await onPage("File Manual", async (detail) => {
			check((await detail.locator(".skill-detail-problem").allInnerTexts()).map((text) => text.trim()).includes(takenLine), `${look} look: the page of a skill whose name another has says so where its description would be`);
			// It wraps at this width; each of its lines starts under the first line's words, never under the red dot.
			const starts = await detail.locator(".skill-detail-problem").first().evaluate((line) => {
				const range = document.createRange();
				range.selectNodeContents(line);
				const lefts = new Map<number, number>();
				for (const rect of range.getClientRects()) if (rect.width > 0) lefts.set(Math.round(rect.top), Math.min(lefts.get(Math.round(rect.top)) ?? Infinity, rect.left));
				return [...lefts.values()].map(Math.round);
			});
			check(starts.length > 1 && starts.every((left) => Math.abs(left - starts[0]!) <= 1), `${look} look: the name-taken line's wrapped lines start under its words, got the lines' left edges ${JSON.stringify(starts)}`);
		});
		await context.close();
	}
	assert(lookFailed.length === 0, lookFailed.join("\n"));

	console.log("skills-manual-only-paths-smoke: OK");
} catch (error) {
	failure = error;
} finally {
	if (browser) await closeBrowser(browser);
	fs.rmSync(fixtureDir, { recursive: true, force: true });
	await stopRoomStateServer(failure);
}
if (failure) throw failure;
