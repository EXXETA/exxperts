// A room's Skills page, in the page against a real server: one row per library
// skill, each with a switch, in one list under how many are on, the ones on
// first; a switch saves on its click
// and the room keeps it through a reload; a switch the server refuses goes back
// and says so in one line; the search field filters by name and description; a
// skill marked to start only by hand carries its tag; a skill whose files can't
// be opened says so where its description is, and can be switched off but not
// on; a row is plain text but for a skill rooms can't use, and the lead's link
// opens Settings, Skills; a switch the server
// saved stays saved when the read after it fails; a search that finds nothing
// says so, and an empty library says so with the way to add one; a read that
// comes back after a later save never undoes it; a tapped switch leaves its row
// in place; a skill rooms can't use opens its page from one 44 px
// target; a by-hand skill that is on shows its description, as when it is
// off, then how to use it ("/" and its name in the message box), which no
// other row says. Under the lead, one line says what the room's skills can't
// do with their files, where a skill that is on has some: without a folder,
// or with Commands off; nothing with Commands on or on a shared server, the
// first sentence alone on a remote device, and read again when the page is
// shown after the Folder page. A skill from the folder shared with other
// tools counts in that line when its files open; one whose files rooms can't
// open says why under its description; one whose name another skill has says
// so and has no switch. Offline.
// Throwaway HOME.
import fs from "node:fs";
import path from "node:path";
import { chromium, type Locator, type Page } from "playwright";
import { agentDir, assert, baseUrl, requestJson, startRoomStateServer, stopRoomStateServer, tempHome, waitUntil } from "./room-state-setup.js";
import * as cardText from "../src/room-box/card-text.js";
import { SMOKE_AUTH_TOKEN } from "./smoke-server-process.js";
import { sha256, writeSkillProvenance } from "../src/skills-store.js";
import * as skillCopy from "../../web-ui/src/skill-source-copy.js";
import { OPEN_SKILL, ROOM_SKILLS_EMPTY_LIBRARY, ROOM_SKILLS_LEAD, ROOM_SKILLS_MANAGE, roomListOnCount, ROOM_SKILL_UNREADABLE_LINE, SKILL_BY_HAND_TAG, roomSkillsNoMatch, roomSkillSwitchFailedLine, roomSkillSwitchName, skillNameTakenByOtherLine, skillPickHowLine } from "../../web-ui/src/skill-source-copy.js";
import { closeBrowser } from "./smoke-close-context.js";

{
	const executable = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!executable || !fs.existsSync(executable)) {
		console.log("room-skills-page-ui-smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const skillsDir = path.join(agentDir, "skills");
function writeSkill(name: string, description: string, extra: string[] = []): string {
	const dir = path.join(skillsDir, name);
	fs.mkdirSync(dir, { recursive: true });
	const manifest = ["---", `name: ${name}`, `description: ${description}`, ...extra, "---", "", `The ${name} instructions.`, ""].join("\n");
	fs.writeFileSync(path.join(dir, "SKILL.md"), manifest);
	writeSkillProvenance(dir, { source: "local", importedAt: new Date().toISOString(), license: null, sha256: sha256(manifest) });
	return dir;
}
// A SKILL.md that shares its file with another name (a hard link, which Windows
// makes without the right a symbolic link needs) is one the app won't open.
function breakSkill(dir: string): void {
	fs.linkSync(path.join(dir, "SKILL.md"), path.join(dir, "elsewhere.md"));
}

writeSkill("alpha-notes", "Keeps the alpha notes tidy.");
writeSkill("beta-report", "Builds the beta report.");
writeSkill("by-hand", "Drafts the quarterly letter.", ["disable-model-invocation: true"]);
const brokenOn = writeSkill("broken-on", "Was readable when it was switched on.");
breakSkill(writeSkill("broken-off", "Never readable here."));
const ALL = ["alpha-notes", "beta-report", "broken-off", "broken-on", "by-hand"];

/** One turn of the page's own work (a frame, then its queued tasks), so an answer it has received is handled before a "nothing changed" check. */
async function pageTurn(page: Page): Promise<void> {
	await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))));
}

async function createRoom(displayName: string): Promise<string> {
	const created = await requestJson("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	assert(created.status === 201, `${displayName} is created, got ${created.status}`);
	return String(created.body?.agent?.id ?? "");
}
const settingsOf = (roomId: string) => `/api/persistent-agents/${encodeURIComponent(roomId)}/skill-settings`;
async function onInRoom(roomId: string): Promise<string[]> {
	const read = await requestJson(settingsOf(roomId));
	assert(read.status === 200, `the room's skills read, got ${read.status}`);
	return (read.body.skills as { name: string }[]).map((skill) => skill.name).sort();
}
async function switchInRoom(roomId: string, action: "enable" | "disable", name: string): Promise<void> {
	const put = await requestJson(settingsOf(roomId), { method: "PUT", body: JSON.stringify({ action, name }) });
	assert(put.status === 200, `${action} ${name}, got ${put.status} ${JSON.stringify(put.body)}`);
}

async function openSkillsPane(page: Page, roomName: string, ready: (pane: Locator) => Locator = (pane) => pane.getByRole("switch").first()): Promise<Locator> {
	const card = page.locator(".persistent-agent-card").filter({ hasText: roomName });
	await card.waitFor({ timeout: 10_000 });
	await card.locator(".card-gear-btn").click();
	await page.waitForSelector(".settings-dialog", { timeout: 10_000 });
	await page.locator(".settings-dialog-nav-item").filter({ hasText: /^Skills/ }).first().click();
	const pane = page.locator(".room-settings-section:not([hidden]) .room-skills-section");
	await ready(pane).waitFor({ timeout: 10_000 });
	return pane;
}
async function closeSettings(page: Page): Promise<void> {
	await page.keyboard.press("Escape");
	await page.locator(".settings-dialog").first().waitFor({ state: "detached", timeout: 10_000 });
}
async function reopen(page: Page, roomName: string): Promise<Locator> {
	await page.reload();
	await page.waitForLoadState("networkidle");
	return openSkillsPane(page, roomName);
}
const switchOf = (pane: Locator, name: string) => pane.getByRole("switch", { name: roomSkillSwitchName(name), exact: true });
const rowOf = (pane: Locator, name: string) => pane.locator(".room-skill").filter({ has: pane.page().getByRole("switch", { name: roomSkillSwitchName(name), exact: true }) });
/** How many are on, beside the title; the list itself carries no heading. */
const counts = (pane: Locator) => pane.locator(".pane-head-beside, .settings-group-kicker").allTextContents();
async function namesIn(pane: Locator, group?: string): Promise<string[]> {
	const scope = group ? pane.locator(".room-skills-group").filter({ has: pane.page().locator(".settings-group-kicker", { hasText: group }) }) : pane;
	return (await scope.locator(".room-skill .room-skill-name").allTextContents()).map((text) => text.trim());
}

// ROOM_SKILLS_ROW=<n> runs one numbered row alone, to show it red or green by itself.
const only = process.env.ROOM_SKILLS_ROW;
const wants = (row: number) => !only || only === String(row);

let failure: unknown;
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
try {
	await startRoomStateServer();
	await createRoom("Empty Desk");
	const busy = await createRoom("Busy Desk");
	await switchInRoom(busy, "enable", "alpha-notes");
	await switchInRoom(busy, "enable", "broken-on");
	breakSkill(brokenOn);

	browser = await chromium.launch();
	const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
	const page = await context.newPage();
	await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
	await page.waitForLoadState("networkidle");
	if (await page.locator(".whats-new-close").count()) await page.locator(".whats-new-close").click();

	// 1. Nothing on: the lead, a switch for every library skill, all off, one count of how many are on and no extra sentence.
	if (wants(1)) {
		const pane = await openSkillsPane(page, "Empty Desk");
		const lead = (await pane.locator(".pane-lead").innerText()).trim();
		assert(lead === `${ROOM_SKILLS_LEAD} ${ROOM_SKILLS_MANAGE}`, `the lead, then the one way to Settings, Skills at its end, got ${JSON.stringify(lead)}`);
		assert((await namesIn(pane)).sort().join() === ALL.join(), `a row for every library skill, got ${JSON.stringify(await namesIn(pane))}`);
		for (const name of ALL) assert(!(await switchOf(pane, name).isChecked()), `${name} is off in a room with nothing on`);
		// One list in the new look, and how many of them are on beside the title.
		assert(JSON.stringify(await counts(pane)) === JSON.stringify([roomListOnCount(0, ALL.length)]), `one count, how many are on, got ${JSON.stringify(await counts(pane))}`);
		const text = await pane.innerText();
		for (const gone of ["enabled", "Enable skills", "Remove", "No skill"]) assert(!text.includes(gone), `the pane still says "${gone}": ${text}`);
		assert(await pane.getByRole("searchbox").isVisible(), "the search field shows");
		await closeSettings(page);
		console.log("  ok  nothing on: every library skill with its switch off, one count of how many are on, no extra sentence");
	}

	// 2. One list, the ones on first.
	if (wants(2)) {
		const pane = await openSkillsPane(page, "Busy Desk");
		assert(JSON.stringify(await counts(pane)) === JSON.stringify([roomListOnCount(2, ALL.length)]), `one count, 2 of ${ALL.length} on, got ${JSON.stringify(await counts(pane))}`);
		assert((await namesIn(pane)).join() === "alpha-notes,broken-on,beta-report,broken-off,by-hand", `the ones on first, then the rest, got ${JSON.stringify(await namesIn(pane))}`);
		assert(await switchOf(pane, "alpha-notes").isChecked() && !(await switchOf(pane, "beta-report").isChecked()), "an on skill's switch is on and an off skill's is off");
		await closeSettings(page);
		console.log("  ok  one list under how many are on, the ones on first");
	}

	// 3. A switch saves on its click, on and off, and a reload keeps it.
	if (wants(3)) {
		let pane = await openSkillsPane(page, "Busy Desk");
		await switchOf(pane, "beta-report").click();
		await waitUntil(async () => (await onInRoom(busy)).includes("beta-report"), "switching beta-report on reached the room");
		pane = await reopen(page, "Busy Desk");
		assert(await switchOf(pane, "beta-report").isChecked() && (await namesIn(pane)).slice(0, 3).includes("beta-report"), "after a reload beta-report is on, among the first");
		await switchOf(pane, "beta-report").click();
		await waitUntil(async () => !(await onInRoom(busy)).includes("beta-report"), "switching beta-report off reached the room");
		pane = await reopen(page, "Busy Desk");
		assert(!(await switchOf(pane, "beta-report").isChecked()) && !(await namesIn(pane)).slice(0, 2).includes("beta-report"), "after a reload beta-report is off, after the ones on");
		await closeSettings(page);
		console.log("  ok  a switch saves on its click and a reload keeps it");
	}

	// 4. A switch the server refuses goes back and says so in one line.
	if (wants(4)) {
		const pane = await openSkillsPane(page, "Busy Desk");
		await page.route("**/api/persistent-agents/*/skill-settings", (route) => route.request().method() === "PUT" ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "refused by the smoke" }) }) : route.continue());
		await switchOf(pane, "alpha-notes").click();
		const line = pane.getByRole("alert");
		await line.waitFor({ timeout: 10_000 });
		assert((await line.innerText()).trim() === roomSkillSwitchFailedLine("alpha-notes", false), `one plain line, got ${JSON.stringify(await line.innerText())}`);
		assert(await switchOf(pane, "alpha-notes").isChecked(), "the refused switch went back to on");
		assert((await onInRoom(busy)).includes("alpha-notes"), "the room still has alpha-notes on");
		await page.unroute("**/api/persistent-agents/*/skill-settings");
		await closeSettings(page);
		// On a remote device the server refuses the save: the line is its own sentence, which says why.
		const remoteLine = "This action is only available on the computer running Exxperts.";
		await page.route("**/api/remote/client-context", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ remote: true, capability: "full", sharedServer: false }) }));
		await page.route("**/api/persistent-agents/*/skill-settings", (route) => route.request().method() === "PUT" ? route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: remoteLine, code: "remote_local_only" }) }) : route.continue());
		await page.reload();
		const remotePane = await openSkillsPane(page, "Busy Desk");
		await switchOf(remotePane, "alpha-notes").click();
		await waitUntil(async () => (await remotePane.getByRole("alert").innerText().catch(() => "")).trim() === remoteLine, "a remote device's refusal shows the server's sentence");
		assert(await switchOf(remotePane, "alpha-notes").isChecked(), "the remote device's switch went back to on");
		assert((await onInRoom(busy)).includes("alpha-notes"), "the room still has alpha-notes on after the remote refusal");
		// The same device and a server fault: the plain line, never the fault's own words.
		await page.unroute("**/api/persistent-agents/*/skill-settings");
		await page.route("**/api/persistent-agents/*/skill-settings", (route) => route.request().method() === "PUT" ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "refused by the smoke" }) }) : route.continue());
		await switchOf(remotePane, "alpha-notes").click();
		await waitUntil(async () => (await remotePane.getByRole("alert").innerText().catch(() => "")).trim() === roomSkillSwitchFailedLine("alpha-notes", false), "a remote device's server fault shows the plain line");
		await page.unroute("**/api/persistent-agents/*/skill-settings");
		await page.unroute("**/api/remote/client-context");
		await closeSettings(page);
		await page.reload();
		console.log("  ok  a refused switch goes back and says so in one line; a remote device's says why");
	}

	// 5. Search filters by name and by description; the count beside the title stays the room's.
	if (wants(5)) {
		const pane = await openSkillsPane(page, "Busy Desk");
		const search = pane.getByRole("searchbox");
		await search.fill("quarterly");
		await waitUntil(async () => (await namesIn(pane)).join() === "by-hand", "a description's word finds its skill");
		// The count is the room's, whatever the search shows.
		assert(JSON.stringify(await counts(pane)) === JSON.stringify([roomListOnCount(2, ALL.length)]), `the title still says how many are on, got ${JSON.stringify(await counts(pane))}`);
		await search.fill("ALPHA");
		await waitUntil(async () => (await namesIn(pane)).join() === "alpha-notes", "a name finds its skill, whatever the case");
		await search.fill("nothing like this");
		await pane.getByText(roomSkillsNoMatch("nothing like this"), { exact: true }).waitFor({ timeout: 10_000 });
		assert((await pane.getByRole("switch").count()) === 0 && JSON.stringify(await counts(pane)) === JSON.stringify([roomListOnCount(2, ALL.length)]), "a search that finds nothing shows no row, and the room's count stays beside the title");
		await search.fill("");
		await waitUntil(async () => (await namesIn(pane)).length === ALL.length, "an empty search shows every skill");
		await closeSettings(page);
		console.log("  ok  search filters by name and description, and says when nothing matches");
	}

	// 6. A skill marked to start only by hand carries the tag, and no line under its row.
	if (wants(6)) {
		const pane = await openSkillsPane(page, "Busy Desk");
		const tags = await pane.locator(".skill-tag").allTextContents();
		assert(JSON.stringify(tags) === JSON.stringify([SKILL_BY_HAND_TAG]), `one tag, got ${JSON.stringify(tags)}`);
		assert((await rowOf(pane, "by-hand").locator(".skill-tag").count()) === 1, "the tag is on by-hand's row");
		assert(JSON.stringify(await rowOf(pane, "by-hand").locator(".settings-row-sub").allTextContents()) === JSON.stringify(["Drafts the quarterly letter."]), "under by-hand's name, its description alone");
		assert(!/manual use only/.test(await pane.innerText()), "no manual-use line");
		await closeSettings(page);
		console.log("  ok  the by-hand skill carries its tag and no extra line");
	}

	// 7. A skill whose files can't be opened: the line where the description is; on, its switch switches it off; off, its switch is off and can't be used.
	if (wants(7)) {
		let pane = await openSkillsPane(page, "Busy Desk");
		for (const name of ["broken-on", "broken-off"]) {
			const subs = await rowOf(pane, name).locator(".settings-row-sub").allTextContents();
			// The name and its line open the skill's page, and the line ends saying so.
			assert(JSON.stringify(subs) === JSON.stringify([`${ROOM_SKILL_UNREADABLE_LINE} ${OPEN_SKILL}`]), `${name} says only that its files can't be opened, and Open skill, got ${JSON.stringify(subs)}`);
		}
		assert(!(await switchOf(pane, "broken-off").isChecked()) && await switchOf(pane, "broken-off").isDisabled(), "an off skill that can't be opened can't be switched on");
		assert(await switchOf(pane, "broken-on").isChecked() && await switchOf(pane, "broken-on").isEnabled(), "an on skill that can't be opened can be switched off");
		assert((await pane.getByRole("button", { name: /Try again/ }).count()) === 0, "no Try again");
		await switchOf(pane, "broken-on").focus();
		await page.keyboard.press("Space");
		await waitUntil(async () => !(await onInRoom(busy)).includes("broken-on"), "switching broken-on off reached the room");
		const brokenName = rowOf(pane, "broken-on").getByRole("button", { name: "broken-on", exact: true });
		await waitUntil(async () => brokenName.evaluate((el) => el === document.activeElement), "switched off, the keyboard's place goes to its name, since its switch can't be used");
		pane = await reopen(page, "Busy Desk");
		assert(!(await switchOf(pane, "broken-on").isChecked()) && await switchOf(pane, "broken-on").isDisabled(), "switched off, it can't be switched on again");
		await closeSettings(page);
		console.log("  ok  a skill that can't be opened: its line, off only");
	}

	// 8. A skill rooms can use is plain text in its row; the one way to Settings, Skills is at the end of the lead.
	if (wants(8)) {
		const pane = await openSkillsPane(page, "Busy Desk");
		const row = rowOf(pane, "beta-report");
		assert((await row.getByRole("button").count()) === 0, "a skill that works is no button");
		assert((await row.locator(".room-skill-name").innerText()).trim() === "beta-report", "and its name is text");
		await pane.locator(".pane-lead-link").click();
		await page.locator(".settings-overlay .settings-dialog-nav-item[aria-current=page]").filter({ hasText: /^Skills/ }).waitFor({ timeout: 10_000 });
		assert((await page.locator(".settings-dialog .room-skills-section").count()) === 0, "Room settings closed");
		await page.locator(".settings-overlay .settings-dialog-close").click();
		await page.locator(".settings-overlay").waitFor({ state: "detached", timeout: 10_000 });
		console.log("  ok  a row is plain text and the lead's link opens Settings, Skills");
	}

	// 9. A switch the server saved stays where it was moved, though the read after it fails, and keeps the keyboard's place.
	if (wants(9)) {
		const pane = await openSkillsPane(page, "Busy Desk");
		let saved = false;
		await page.route("**/api/persistent-agents/*/skill-settings", async (route) => {
			if (route.request().method() === "PUT") {
				const answer = await route.fetch();
				saved = answer.ok();
				return route.fulfill({ response: answer });
			}
			return saved ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "refused by the smoke" }) }) : route.continue();
		});
		await switchOf(pane, "beta-report").focus();
		await page.keyboard.press("Space");
		await waitUntil(async () => (await onInRoom(busy)).includes("beta-report"), "switching beta-report on reached the room");
		await waitUntil(async () => (await switchOf(pane, "beta-report").isEnabled()), "the save finished");
		assert(await switchOf(pane, "beta-report").isChecked(), "the saved switch stays on");
		assert((await pane.getByRole("alert").count()) === 0, `no line says it failed, got ${JSON.stringify(await pane.getByRole("alert").allTextContents())}`);
		assert(await switchOf(pane, "beta-report").evaluate((el) => el === document.activeElement), "the keyboard's place stays on the switch");
		await page.unroute("**/api/persistent-agents/*/skill-settings");
		await switchInRoom(busy, "disable", "beta-report");
		await closeSettings(page);
		console.log("  ok  a saved switch stays saved when the read after it fails, and keeps the keyboard's place");
	}

	// 11. A read the page asked for after one save, answered only after a later save, doesn't undo that later save.
	if (wants(11)) {
		const pane = await openSkillsPane(page, "Busy Desk");
		let hold = true;
		let held: Promise<void> | null = null;
		let release: () => void = () => {};
		const released = new Promise<void>((resolve) => { release = resolve; });
		await page.route("**/api/persistent-agents/*/skill-settings", async (route) => {
			if (route.request().method() !== "GET" || !hold) return route.continue();
			hold = false;
			const answer = await route.fetch();
			held = released.then(() => route.fulfill({ response: answer }));
			await held;
		});
		await switchOf(pane, "alpha-notes").click();
		await waitUntil(async () => !(await onInRoom(busy)).includes("alpha-notes"), "switching alpha-notes off reached the room");
		await waitUntil(async () => held !== null && await switchOf(pane, "alpha-notes").isEnabled(), "the read after it is held");
		await switchOf(pane, "alpha-notes").click();
		await waitUntil(async () => (await onInRoom(busy)).includes("alpha-notes"), "switching alpha-notes on again reached the room");
		await waitUntil(async () => await switchOf(pane, "alpha-notes").isEnabled() && await switchOf(pane, "alpha-notes").isChecked(), "the later save shows");
		// Only an answer after the release can be the held one, not the later save's own read.
		let afterRelease = false;
		const lateRead = page.waitForResponse((response) => afterRelease && response.request().method() === "GET" && /\/skill-settings$/.test(new URL(response.url()).pathname));
		afterRelease = true;
		release();
		await held;
		await (await lateRead).finished();
		await pageTurn(page);
		assert(await switchOf(pane, "alpha-notes").isChecked(), "the late read of the earlier save leaves alpha-notes on");
		await page.unroute("**/api/persistent-agents/*/skill-settings");
		await closeSettings(page);
		console.log("  ok  a late read never undoes a later save");
	}

	// 12. A tapped switch leaves its row where it is, in the one list, until the search changes or the page opens again.
	if (wants(12)) {
		const orderOf = async (pane: Locator) => (await namesIn(pane)).join();
		let pane = await openSkillsPane(page, "Busy Desk");
		const was = await orderOf(pane);
		assert(was.endsWith("by-hand"), `the off ones are last, got ${was}`);
		const readAfterSave = page.waitForResponse((response) => response.request().method() === "GET" && /\/skill-settings$/.test(new URL(response.url()).pathname));
		await switchOf(pane, "by-hand").click();
		await waitUntil(async () => (await onInRoom(busy)).includes("by-hand"), "switching by-hand on reached the room");
		await waitUntil(async () => await switchOf(pane, "by-hand").isEnabled(), "the save finished");
		await (await readAfterSave).finished();
		await pageTurn(page);
		assert(await switchOf(pane, "by-hand").isChecked(), "the switch shows on at once");
		assert((await orderOf(pane)) === was, `the row stays where it is, got ${await orderOf(pane)}`);
		// The title counts what is on, so it is true at once.
		const nowOn = (await onInRoom(busy)).length;
		assert(JSON.stringify(await counts(pane)) === JSON.stringify([roomListOnCount(nowOn, ALL.length)]), `the title counts it, got ${JSON.stringify(await counts(pane))}`);
		const search = pane.getByRole("searchbox");
		await search.fill("quarterly");
		await waitUntil(async () => (await namesIn(pane)).join() === "by-hand", "the search finds it");
		await search.fill("");
		await waitUntil(async () => (await namesIn(pane)).length === ALL.length, "an empty search shows every skill");
		assert((await namesIn(pane)).indexOf("by-hand") < nowOn, `a changed search puts it among the ones on, got ${await orderOf(pane)}`);
		await closeSettings(page);
		pane = await openSkillsPane(page, "Busy Desk");
		const opened = await orderOf(pane);
		await switchOf(pane, "by-hand").click();
		await waitUntil(async () => !(await onInRoom(busy)).includes("by-hand"), "switching by-hand off reached the room");
		await waitUntil(async () => await switchOf(pane, "by-hand").isEnabled(), "the save finished");
		assert((await orderOf(pane)) === opened, "switched off, it stays among the on ones until the page opens again");
		await closeSettings(page);
		pane = await openSkillsPane(page, "Busy Desk");
		assert((await orderOf(pane)) === was, "opened again, it is last, among the off ones");
		await closeSettings(page);
		console.log("  ok  a tapped switch leaves its row in place until the search changes or the page opens again");
	}

	// 13. A skill rooms can't use keeps its one way to its page: its name and description are one target of 44 px or more.
	if (wants(13)) {
		const pane = await openSkillsPane(page, "Busy Desk");
		const open = rowOf(pane, "broken-off").getByRole("button", { name: "broken-off", exact: true });
		const box = await open.boundingBox();
		assert(box && box.height >= 44, `the target is at least 44 px tall, got ${JSON.stringify(box)}`);
		const described = await open.evaluate((el) => (el.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim());
		assert(described.includes(ROOM_SKILL_UNREADABLE_LINE), `the target is described by why, got ${JSON.stringify(described)}`);
		await open.getByText(ROOM_SKILL_UNREADABLE_LINE).click();
		const detail = page.locator(".settings-overlay .skill-detail");
		await detail.waitFor({ timeout: 10_000 });
		assert((await detail.locator("h2").innerText()).trim() === "broken-off", "the row's words open the skill's page");
		await page.locator(".settings-overlay .settings-dialog-close").click();
		await page.locator(".settings-overlay").waitFor({ state: "detached", timeout: 10_000 });
		console.log("  ok  a skill rooms can't use opens its page from one 44 px target");
	}

	// 14. A by-hand skill that is on shows its description, as when it is off, then how to use it; the tag stays. A skill the room uses by itself has no such line.
	if (wants(14)) {
		await switchInRoom(busy, "enable", "by-hand");
		try {
			const pane = await openSkillsPane(page, "Busy Desk");
			const line = rowOf(pane, "by-hand").locator(".settings-row-sub");
			const parts = [await line.locator(".settings-row-clamp").allTextContents(), await line.locator(".room-skill-how").allTextContents()];
			assert(JSON.stringify(parts) === JSON.stringify([["Drafts the quarterly letter."], [skillPickHowLine("by-hand")]]), `its description, then how to use it, got ${JSON.stringify(parts)}`);
			assert((await pane.locator(".room-skill-how").count()) === 1, "no other row says how to use it (alpha-notes is on, by itself)");
			assert((await rowOf(pane, "by-hand").locator(".skill-tag").count()) === 1, "the tag stays");
			await closeSettings(page);
		} finally {
			await switchInRoom(busy, "disable", "by-hand");
		}
		console.log("  ok  a by-hand skill that is on shows its description, how to use it and its tag");
	}

	// 15. A save that reached the room but whose answer was lost: the switch shows what the room has, with no failure line.
	if (wants(15)) {
		const pane = await openSkillsPane(page, "Busy Desk");
		let aborted = false;
		await page.route("**/api/persistent-agents/*/skill-settings", async (route) => {
			if (route.request().method() !== "PUT") return route.continue();
			await route.fetch();
			await route.abort();
			aborted = true;
		});
		// The read after the lost answer, waited for, so the row judges the pane after it and not the switch's first flip.
		const reread = page.waitForResponse((response) => response.request().method() === "GET" && /\/skill-settings$/.test(new URL(response.url()).pathname) && aborted);
		await switchOf(pane, "beta-report").click();
		await waitUntil(async () => (await onInRoom(busy)).includes("beta-report"), "the save reached the room");
		await reread;
		await waitUntil(async () => (await switchOf(pane, "beta-report").isChecked()) && (await pane.getByRole("alert").count()) === 0, "the switch shows the room's own state and no failure line");
		await page.unroute("**/api/persistent-agents/*/skill-settings");
		await closeSettings(page);
		await switchInRoom(busy, "disable", "beta-report");
		console.log("  ok  a save whose answer was lost shows what the room has");
	}

	// 10. An empty library: one line, and on this computer the way to add a skill, which opens Settings, Skills.
	if (wants(10)) {
		const aside = `${skillsDir}-aside`;
		fs.renameSync(skillsDir, aside);
		try {
			const pane = await openSkillsPane(page, "Empty Desk", (found) => found.locator(".settings-empty"));
			const empty = (await pane.locator(".settings-empty").innerText()).trim();
			assert(empty === ROOM_SKILLS_EMPTY_LIBRARY.line, `the empty library's line alone, got ${JSON.stringify(empty)}`);
			assert((await pane.getByRole("switch").count()) === 0, "no switch in an empty library");
			// The way to Settings, Skills is at the end of the lead, as on every page.
			await pane.locator(".pane-lead-link").click();
			await page.locator(".settings-overlay .settings-dialog-nav-item[aria-current=page]").filter({ hasText: /^Skills/ }).waitFor({ timeout: 10_000 });
			assert((await page.locator(".settings-dialog .room-skills-section").count()) === 0, "Room settings closed");
			await page.locator(".settings-overlay .settings-dialog-close").click();
			await page.locator(".settings-overlay").waitFor({ state: "detached", timeout: 10_000 });
			// A shared server's member: the company's line, and no way to add one.
			await page.route("**/api/remote/client-context", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ remote: false, capability: "full", sharedServer: true, person: { id: "11111111-1111-4111-8111-111111111111", name: "Sample Member", admin: false } }) }));
			await page.reload();
			const memberPane = await openSkillsPane(page, "Empty Desk", (found) => found.locator(".settings-empty"));
			const memberEmpty = (await memberPane.locator(".settings-empty").innerText()).trim();
			assert(memberEmpty === ROOM_SKILLS_EMPTY_LIBRARY.company, `a member's empty library line, got ${JSON.stringify(memberEmpty)}`);
			assert((await memberPane.locator(".pane-lead-link").count()) === 0, "a member has no way to add a skill");
			await page.unroute("**/api/remote/client-context");
			await closeSettings(page);
			await page.reload();
		} finally {
			fs.renameSync(aside, skillsDir);
		}
		console.log("  ok  an empty library says so, with the way to add a skill on this computer and the company's line for a member");
	}

	// 16. The files line under the lead: what a room's skills can't do with their files, read again each time the page is shown.
	if (wants(16)) {
		const filesSkill = writeSkill("files-skill", "Uses its own files.");
		fs.mkdirSync(path.join(filesSkill, "scripts"), { recursive: true });
		fs.writeFileSync(path.join(filesSkill, "scripts", "run.sh"), "echo ran\n");
		const desk = await createRoom("Files Desk");
		const folder = path.join(tempHome, "files-desk");
		fs.mkdirSync(folder, { recursive: true });
		const setFolder = async (bashEnabled: boolean) => {
			const put = await requestJson(`/api/persistent-agents/${encodeURIComponent(desk)}/workspace-default`, { method: "PUT", body: JSON.stringify({ root: folder, displayLabel: "Files Desk", workspaceAccessMode: "localFiles", bashEnabled }) });
			assert(put.status === 200 && put.body?.policy?.bashEnabled === bashEnabled, `the desk's folder with commands ${bashEnabled ? "on" : "off"}, got ${put.status}`);
		};
		const filesLine = (pane: Locator) => pane.locator(".room-skills-files");
		const lineOf = async (roomName: string): Promise<string | null> => {
			const pane = await openSkillsPane(page, roomName);
			// The line comes with the page's first read, which the switches show.
			await pageTurn(page);
			const text = (await filesLine(pane).count()) ? (await filesLine(pane).innerText()).trim() : null;
			await closeSettings(page);
			return text;
		};
		// Read through the module, so a commit without the lines still runs every row.
		const { none, read } = cardText.ROOM_SKILL_FILES_LINES ?? { none: { what: "(no line)", how: "" }, read: { what: "(no line)", how: "" } };
		// Every row runs, so one run names each answer that is wrong.
		const rowFailed: string[] = [];
		const check = (condition: unknown, message: string): void => {
			if (!condition) rowFailed.push(message);
		};
		try {
			await switchInRoom(desk, "enable", "files-skill");
			// The room and the skill came after the page opened.
			await page.reload();
			await page.waitForLoadState("networkidle");
			const noFolder = await lineOf("Files Desk");
			check(noFolder === `${none.what} ${none.how}`, `without a folder: reading and running, and how, got ${JSON.stringify(noFolder)}`);
			const wholeLead = (await (await openSkillsPane(page, "Files Desk")).locator(".pane-lead").innerText()).trim();
			check(wholeLead === `${ROOM_SKILLS_LEAD} ${ROOM_SKILLS_MANAGE} ${none.what} ${none.how}`, `the lead, its way to Settings and the files line are one paragraph, got ${JSON.stringify(wholeLead)}`);
			await closeSettings(page);
			// A room whose skills that are on have SKILL.md alone says nothing of files.
			check(await lineOf("Busy Desk") === null, "nothing for skills with SKILL.md alone");
			// A remote device: what can't happen, and no way on it can't take.
			await page.route("**/api/remote/client-context", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ remote: true, capability: "full", sharedServer: false }) }));
			await page.reload();
			const fromPhone = await lineOf("Files Desk");
			check(fromPhone === none.what, `from a remote device, the first sentence alone, got ${JSON.stringify(fromPhone)}`);
			await page.unroute("**/api/remote/client-context");
			// A shared server's member: nothing.
			await page.route("**/api/remote/client-context", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ remote: false, capability: "full", sharedServer: true, person: { id: "11111111-1111-4111-8111-111111111111", name: "Sample Member", admin: false } }) }));
			await page.reload();
			check(await lineOf("Files Desk") === null, "nothing on a shared server");
			await page.unroute("**/api/remote/client-context");
			await page.reload();
			await page.waitForLoadState("networkidle");
			// A folder with Commands off: reading works, running doesn't.
			await setFolder(false);
			const pane = await openSkillsPane(page, "Files Desk");
			// Read without waiting for the line, so a line that is gone reads as gone.
			const commandsOff = async () => JSON.stringify((await filesLine(pane).allInnerTexts()).map((text) => text.trim())) === JSON.stringify([`${read.what} ${read.how}`]);
			await waitUntil(commandsOff, "with Commands off: the line says scripts can't run, and how to run them").catch((error: Error) => check(false, error.message));
			// The line showed with Commands off, so the row below judges a line that went away.
			check(await commandsOff(), "the line showed with Commands off before the Folder page");
			// Commands on from the Folder page, Room settings left open: back on Skills, the line is gone.
			await page.locator(".settings-dialog-nav-item").filter({ hasText: /^Folder/ }).first().click();
			const commands = page.locator(".room-settings-section:not([hidden])").getByRole("switch", { name: "Commands", exact: true });
			await commands.click();
			// Saved: the switch is on and can move again.
			await waitUntil(async () => (await commands.isChecked()) && (await commands.isEnabled()), "Commands on was saved");
			await page.locator(".settings-dialog-nav-item").filter({ hasText: /^Skills/ }).first().click();
			await waitUntil(async () => (await filesLine(pane).count()) === 0, "after Commands went on in the Folder page, the line is gone without closing Room settings").catch((error: Error) => check(false, error.message));
			await closeSettings(page);
			check(await lineOf("Files Desk") === null, "nothing with Commands on");
			// The first read, answered with Commands off, lands only after Commands went on from the Folder page: the line stays gone.
			await setFolder(false);
			await page.reload();
			await page.waitForLoadState("networkidle");
			let release = (): void => {};
			const released = new Promise<void>((resolve) => { release = resolve; });
			let reads = 0;
			let firstHeld = false;
			await page.route("**/api/persistent-agents/*/skill-settings", async (route) => {
				if (route.request().method() !== "GET" || reads++ > 0) return route.continue();
				const response = await route.fetch();
				firstHeld = true;
				await released;
				await route.fulfill({ response });
			});
			const card = page.locator(".persistent-agent-card").filter({ hasText: "Files Desk" });
			await card.locator(".card-gear-btn").click();
			await page.waitForSelector(".settings-dialog", { timeout: 10_000 });
			await waitUntil(async () => firstHeld, "the first read was answered with Commands off and held");
			await page.locator(".settings-dialog-nav-item").filter({ hasText: /^Folder/ }).first().click();
			const commandsLate = page.locator(".room-settings-section:not([hidden])").getByRole("switch", { name: "Commands", exact: true });
			await commandsLate.click();
			await waitUntil(async () => (await commandsLate.isChecked()) && (await commandsLate.isEnabled()), "Commands on was saved, with the first read held");
			// The held first read has no answer yet, so the first answer seen is the Skills page's second read.
			const secondAnswered = page.waitForResponse((response) => response.url().includes("/skill-settings") && response.request().method() === "GET", { timeout: 10_000 });
			await page.locator(".settings-dialog-nav-item").filter({ hasText: /^Skills/ }).first().click();
			// Its body read whole, so the page has its answer before the first one lands.
			await (await secondAnswered.catch(() => null))?.finished();
			check(reads >= 2, "the Skills page read again");
			await pageTurn(page);
			release();
			const latePane = page.locator(".room-settings-section:not([hidden]) .room-skills-section");
			await latePane.getByRole("switch").first().waitFor({ timeout: 10_000 });
			await pageTurn(page);
			check((await filesLine(latePane).count()) === 0, "a first read that lands after the Folder change doesn't bring the old line back");
			await page.unroute("**/api/persistent-agents/*/skill-settings");
			await closeSettings(page);
			assert(rowFailed.length === 0, rowFailed.join("\n"));
		} finally {
			await page.unroute("**/api/remote/client-context");
			await switchInRoom(desk, "disable", "files-skill");
			fs.rmSync(filesSkill, { recursive: true, force: true });
		}
		console.log("  ok  the files line: no folder, Commands off, a remote device's first sentence, nothing with Commands on or on a shared server, and it follows the Folder page, even when the first read lands late");
	}

	// 17. Skills from the folder shared with other tools: one whose files open counts in the files line; one linked
	// outside ~/.agents opens too and says where its files are under its description; one whose files rooms can't open
	// says why there and counts in no line; one whose name another has says so, with no switch.
	if (wants(17)) {
		const shared = path.join(tempHome, ".agents", "skills");
		const plantShared = (dir: string, name: string, withFiles = true): string => {
			fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
			fs.writeFileSync(path.join(dir, "SKILL.md"), ["---", `name: ${name}`, `description: Shared ${name} skill.`, "---", "", `The ${name} instructions.`, ""].join("\n"));
			if (withFiles) fs.writeFileSync(path.join(dir, "scripts", "run.sh"), "echo ran\n");
			return dir;
		};
		plantShared(path.join(shared, "shared-open"), "shared-open");
		const away = plantShared(path.join(tempHome, "away", "shared-away"), "shared-away");
		fs.symlinkSync(away, path.join(shared, "shared-away"), process.platform === "win32" ? "junction" : "dir");
		// A link to the home folder: rooms use only its instructions.
		const homeManifest = path.join(tempHome, "SKILL.md");
		fs.writeFileSync(homeManifest, ["---", "name: shared-home", "description: Shared shared-home skill.", "---", "", "The shared-home instructions.", ""].join("\n"));
		fs.symlinkSync(tempHome, path.join(shared, "shared-home"), process.platform === "win32" ? "junction" : "dir");
		// Its written name fits onto alpha-notes, which the person's own skill has.
		plantShared(path.join(shared, "alpha_notes"), "Alpha Notes", false);
		const { none } = cardText.ROOM_SKILL_FILES_LINES ?? { none: { what: "(no line)", how: "" } };
		const homeLine = (skillCopy as Record<string, any>).SKILL_INSTRUCTIONS_ONLY_LINES?.home ?? "(no home line)";
		const awayLine = (skillCopy as Record<string, any>).skillFilesAtLine?.("~/away/shared-away") ?? "(no files-at line)";
		const rowFailed: string[] = [];
		const check = (condition: unknown, message: string): void => {
			if (!condition) rowFailed.push(message);
		};
		const openDesk = await createRoom("Shared Open Desk");
		const awayDesk = await createRoom("Shared Away Desk");
		const homeDesk = await createRoom("Shared Home Desk");
		try {
			await switchInRoom(openDesk, "enable", "shared-open");
			await switchInRoom(awayDesk, "enable", "shared-away");
			await switchInRoom(homeDesk, "enable", "shared-home");
			await page.reload();
			await page.waitForLoadState("networkidle");
			const openPane = await openSkillsPane(page, "Shared Open Desk");
			await pageTurn(page);
			const openLine = (await openPane.locator(".room-skills-files").count()) ? (await openPane.locator(".room-skills-files").innerText()).trim() : null;
			check(openLine === `${none.what} ${none.how}`, `a shared-folder skill whose files open counts in the files line, got ${JSON.stringify(openLine)}`);
			await closeSettings(page);
			const awayPane = await openSkillsPane(page, "Shared Away Desk");
			await pageTurn(page);
			const awayFiles = (await awayPane.locator(".room-skills-files").count()) ? (await awayPane.locator(".room-skills-files").innerText()).trim() : null;
			check(awayFiles === `${none.what} ${none.how}`, `a shared-folder skill linked outside ~/.agents counts in the files line, got ${JSON.stringify(awayFiles)}`);
			const awayRow = rowOf(awayPane, "shared-away");
			const awayText = (await awayRow.innerText()).trim();
			check(awayText.includes("Shared shared-away skill.") && awayText.includes(awayLine), `a shared-folder skill linked outside ~/.agents shows its description, then where its files are, got ${JSON.stringify(awayText)}`);
			check((await awayRow.locator(".room-skill-how").allInnerTexts()).map((text) => text.trim()).includes(awayLine), "where its files are stands on its own line, as the by-hand line does");
			check((await awayRow.locator(".room-skill-how").allInnerTexts()).length === 1, "with no Windows protection in the way, nothing more is said under it of where its scripts run");
			await closeSettings(page);
			// On a Windows computer whose rooms run commands in their protection, a skill whose folder holds a link (the
			// answer's scriptsReadOnly, which skills-room-folders-smoke pins on the server) says under it where its scripts run.
			const readOnlyLine = (skillCopy as Record<string, any>).SKILL_SCRIPTS_READ_ONLY_LINE ?? "(no read-only line)";
			const listRoute = /\/api\/skills(\?|$)/;
			await page.route(listRoute, async (route) => {
				const response = await route.fetch();
				const items = await response.json();
				await route.fulfill({ response, json: Array.isArray(items) ? items.map((item: { name: string }) => (item.name === "shared-away" ? { ...item, scriptsReadOnly: true } : item)) : items });
			});
			await page.reload();
			await page.waitForLoadState("networkidle");
			const readOnlyPane = await openSkillsPane(page, "Shared Away Desk");
			await pageTurn(page);
			const readOnlyLines = (await rowOf(readOnlyPane, "shared-away").locator(".room-skill-how").allInnerTexts()).map((text) => text.trim());
			check(readOnlyLines.includes(readOnlyLine) && readOnlyLines.includes(awayLine), `a skill whose scripts run only from a folder the room already opens on this Windows computer says so under it, beside where its files are, got ${JSON.stringify(readOnlyLines)}`);
			await closeSettings(page);
			await page.unroute(listRoute);
			await page.reload();
			await page.waitForLoadState("networkidle");
			const homePane = await openSkillsPane(page, "Shared Home Desk");
			await pageTurn(page);
			check(await homePane.locator(".room-skills-files").count() === 0, "a shared-folder skill whose files rooms can't open counts in no files line");
			const homeRow = rowOf(homePane, "shared-home");
			const homeText = (await homeRow.innerText()).trim();
			check(homeText.includes("Shared shared-home skill.") && homeText.includes(homeLine), `a shared-folder skill linked to the home folder shows its description, then why rooms use only its instructions, got ${JSON.stringify(homeText)}`);
			check((await homeRow.locator(".room-skill-how").allInnerTexts()).map((text) => text.trim()).includes(homeLine), "the reason stands on its own line, as the by-hand line does");
			const takenRow = homePane.locator(".room-skill").filter({ has: page.locator(".room-skill-name", { hasText: /^Alpha Notes$/ }) });
			check(await takenRow.count() === 1, `the shared skill whose name another has is listed, got ${await takenRow.count()}`);
			if (await takenRow.count() === 1) {
				const takenText = (await takenRow.innerText()).trim();
				check(takenText.includes(skillNameTakenByOtherLine("alpha-notes")), `it says another skill has its name, got ${JSON.stringify(takenText)}`);
				check(await takenRow.getByRole("switch").count() === 0, "it has no switch");
			}
			await closeSettings(page);
			assert(rowFailed.length === 0, rowFailed.join("\n"));
		} finally {
			fs.rmSync(path.join(tempHome, ".agents"), { recursive: true, force: true });
			fs.rmSync(path.join(tempHome, "away"), { recursive: true, force: true });
			fs.rmSync(homeManifest, { force: true });
		}
		console.log("  ok  shared-folder skills: one whose files open counts in the files line, one linked outside ~/.agents says where its files are, one kept to its instructions says why, one whose name another has says so with no switch");
	}

	console.log("room-skills-page-ui-smoke: OK");
} catch (error) {
	failure = error;
} finally {
	if (browser) await closeBrowser(browser);
	await stopRoomStateServer(failure);
}
if (failure) throw failure;
