// The "/" list in a room's message box, in the page against a real server and
// a synthetic model that keeps every request it was sent:
// - "/" at the start of the box opens "Skills on in this room": the skills on
//   in the room, a by-hand one with its tag, each on one line, its description
//   cut where the row ends; not one that is off, and not one whose files can't
//   be opened; a "/" later in the text opens nothing;
// - typing filters it; nothing fits: no list, and Enter sends the text as typed;
// - Up and Down move, Enter and Tab pick, Esc closes and typing opens it again,
//   a tap picks; a pick makes the first word "/name " and keeps the rest;
// - the picked message shows as typed, and the model gets the skill's
//   instructions with it;
// - under a room's "Asking" label it never opens;
// - a skill switched on through the room's settings is in the list at its next
//   opening, without a reload;
// - while the room's skills load, or after the lookup failed, there is no list
//   and Enter sends as typed; the next opening recovers;
// - an answer for a room the person has left is dropped, and a late answer
//   from an earlier opening never replaces a newer one;
// - at phone width the list fits the screen, a description has its own line
//   under the name and tag, the folder line above the box hides while the list
//   is open, and a tap picks.
// Offline. Throwaway HOME.
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page, type Route } from "playwright";
import { agentDir, assert, baseUrl, personsNewest, requestJson, requests, startRoomStateServer, stopRoomStateServer, waitUntil } from "./room-state-setup.js";
import { SMOKE_AUTH_TOKEN } from "./smoke-server-process.js";
import { sha256, writeSkillProvenance } from "../src/skills-store.js";
import { SKILL_PICKED_OPEN } from "../src/skill-pick.js";
import { SKILL_BY_HAND_TAG, SKILL_PICK_HEADING } from "../../web-ui/src/skill-source-copy.js";
import { closeBrowser, closeContext } from "./smoke-close-context.js";

{
	const executable = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!executable || !fs.existsSync(executable)) {
		console.log("skill-pick-ui-smoke skipped (Chromium not installed)");
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

const LONG = "Fills in PDF forms from the facts in this room, field by field, and checks every page of the form before it says it is done with it.";
writeSkill("pdf-fill", LONG);
writeSkill("letters", "Drafts the quarterly letter.", ["disable-model-invocation: true"]);
writeSkill("off-skill", "Off in the pick room.");
writeSkill("later-on", "Switched on while the page is open.");
const broken = writeSkill("broken", "Was readable when it was switched on.");

async function createRoom(displayName: string): Promise<string> {
	const created = await requestJson("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	assert(created.status === 201, `${displayName} is created, got ${created.status}`);
	return String(created.body?.agent?.id ?? "");
}
const settingsOf = (roomId: string) => `/api/persistent-agents/${encodeURIComponent(roomId)}/skill-settings`;
async function switchInRoom(roomId: string, action: "enable" | "disable", name: string): Promise<void> {
	const put = await requestJson(settingsOf(roomId), { method: "PUT", body: JSON.stringify({ action, name }) });
	assert(put.status === 200, `${action} ${name}, got ${put.status} ${JSON.stringify(put.body)}`);
}

const PICK = "Pick Desk";
const OTHER = "Other Desk";
const list = (page: Page) => page.locator(".composer-box .skill-pick-pop");
const box = (page: Page) => page.locator(".composer-box textarea").first();
async function rowNames(page: Page): Promise<string[]> {
	return (await list(page).locator(".skill-pick-name").allTextContents()).map((text) => text.trim());
}
async function selected(page: Page): Promise<string> {
	return (await list(page).locator('[role="option"][aria-selected="true"] .skill-pick-name').innerText()).trim();
}
async function enterRoom(page: Page, room: string): Promise<void> {
	await page.locator(".persistent-agent-card").filter({ hasText: room }).getByRole("button", { name: /^(Enter|Resume)$/ }).click();
	await box(page).waitFor({ timeout: 15_000 });
}
async function goHome(page: Page): Promise<void> {
	await page.getByRole("button", { name: "Rooms", exact: true }).first().click();
	await page.locator(".persistent-agent-card").first().waitFor({ timeout: 10_000 });
}
/** Clears the box and types `text` key by key, as a person does. */
async function typeFresh(page: Page, text: string): Promise<void> {
	await box(page).fill("");
	await box(page).pressSequentially(text);
}
/** Sends with Enter and waits until the model has the message and the turn has ended; the model's copy of it. */
async function sendAndWait(page: Page, typed: string): Promise<string> {
	const before = requests.length;
	await box(page).press("Enter");
	await waitUntil(async () => requests.slice(before).some((request) => personsNewest(request).includes(typed)), `the model gets ${JSON.stringify(typed)}`);
	await page.locator(".messages .bubble-row.user:not(.queued)").filter({ hasText: typed }).first().waitFor({ timeout: 10_000 });
	await waitUntil(async () => (await page.locator(".composer-box .stop-btn").count()) === 0, "the turn has ended");
	return personsNewest(requests.slice(before).find((request) => personsNewest(request).includes(typed))!);
}
/** One turn of the page's own work (a frame, then its queued tasks), so an answer it has received is handled before a "nothing changed" check. */
async function pageTurn(page: Page): Promise<void> {
	await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))));
}

/**
 * Holds the room settings reads of `roomId`: each is answered by the server
 * when it is asked, and that answer reaches the page only on `release`, so a
 * released answer is as old as the moment it was asked. `release` and `fail`
 * settle once the page has the held answers, or their failure. `letThrough`:
 * later reads pass at once, the held ones stay held. `asked`: a read was sent,
 * before the server answers it.
 */
function holdSettings(page: Page, roomId: string): { release: () => Promise<void>; fail: () => Promise<void>; letThrough: () => void; seen: () => boolean; asked: () => boolean; done: Promise<unknown> } {
	const held: { route: Route; response: Awaited<ReturnType<Route["fetch"]>> }[] = [];
	let mode: "hold" | "pass" | "fail" = "hold";
	let asked = false;
	// Read through a call: release or fail may change it while a read is out.
	const modeNow = () => mode;
	const pattern = `**${settingsOf(roomId)}`;
	const handler = async (route: Route) => {
		if (route.request().method() !== "GET") return route.continue();
		asked = true;
		if (mode === "fail") return route.abort();
		if (mode === "pass") return route.continue();
		let response: Awaited<ReturnType<Route["fetch"]>>;
		try {
			response = await route.fetch();
		} catch {
			return; // The page closed while the read was out.
		}
		// A read that comes back after release or fail goes the way the others went.
		if (modeNow() === "pass") return route.fulfill({ response }).catch(() => {});
		if (modeNow() === "fail") return route.abort().catch(() => {});
		held.push({ route, response });
	};
	const done = page.route(pattern, handler);
	return {
		done,
		seen: () => held.length > 0,
		asked: () => asked,
		letThrough: () => {
			mode = "pass";
		},
		release: async () => {
			mode = "pass";
			const released = held.splice(0);
			await Promise.all(released.map(({ route, response }) => route.fulfill({ response })));
			await Promise.all(released.map(async ({ route }) => (await route.request().response())?.finished()));
			await page.unroute(pattern, handler);
		},
		fail: async () => {
			mode = "fail";
			await Promise.all(held.splice(0).map(({ route }) => route.abort()));
		},
	};
}

/** Types `text` and shows the list was never wanted: two turns of the page's work, and no read of the room's skills asked. */
async function typeAndNoListAsked(page: Page, roomId: string, text: string, typeIt: (page: Page, text: string) => Promise<void>, what: string): Promise<void> {
	const hold = holdSettings(page, roomId);
	await hold.done;
	await typeIt(page, text);
	await pageTurn(page);
	await pageTurn(page);
	const asked = hold.asked();
	await hold.release();
	assert(!asked && (await list(page).count()) === 0, `${what}: the room's skills are never asked for and no list opens`);
}

// SKILL_PICK_ROW=<n> runs one numbered row alone, to show it red or green by itself.
const only = process.env.SKILL_PICK_ROW;
const wants = (row: number) => !only || only === String(row);

let failure: unknown;
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
try {
	await startRoomStateServer();
	const pickRoom = await createRoom(PICK);
	const otherRoom = await createRoom(OTHER);
	for (const name of ["pdf-fill", "letters", "broken"]) await switchInRoom(pickRoom, "enable", name);
	await switchInRoom(otherRoom, "enable", "off-skill");
	// A SKILL.md that shares its file with another name is one the app won't open.
	fs.linkSync(path.join(broken, "SKILL.md"), path.join(broken, "elsewhere.md"));

	browser = await chromium.launch();
	const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
	const page = await context.newPage();
	await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
	await page.waitForLoadState("networkidle");
	if (await page.locator(".whats-new-close").count()) await page.locator(".whats-new-close").click();
	await enterRoom(page, PICK);

	// 1. "/" opens the skills on in this room: heading, one line each, the tag on the by-hand one; none off, none unreadable.
	if (wants(1)) {
		await typeFresh(page, "/");
		await list(page).waitFor({ timeout: 10_000 });
		assert((await list(page).locator(".pop-kicker").innerText()).trim() === SKILL_PICK_HEADING, "the heading");
		assert((await list(page).getAttribute("role")) === "listbox" && (await list(page).getAttribute("aria-label")) === SKILL_PICK_HEADING, "a list box named by its heading");
		assert(JSON.stringify(await rowNames(page)) === JSON.stringify(["/letters", "/pdf-fill"]), `the skills on and readable, got ${JSON.stringify(await rowNames(page))}`);
		const letters = list(page).locator('[role="option"]').filter({ hasText: "/letters" });
		assert((await letters.locator(".skill-tag").innerText()).trim() === SKILL_BY_HAND_TAG, "the by-hand skill carries its tag");
		assert((await list(page).locator('[role="option"]').filter({ hasText: "/pdf-fill" }).locator(".skill-tag").count()) === 0, "no tag on the other");
		const pdf = list(page).locator('[role="option"]').filter({ hasText: "/pdf-fill" });
		const description = pdf.locator(".skill-pick-description");
		assert((await description.textContent()) === LONG, "the description, whole in the page");
		const cut = await description.evaluate((el) => ({ cut: el.scrollWidth > el.clientWidth, ellipsis: getComputedStyle(el).textOverflow, name: el.previousElementSibling!.getBoundingClientRect(), self: el.getBoundingClientRect() }));
		assert(cut.cut && cut.ellipsis === "ellipsis", `a long description is cut with "…", got ${JSON.stringify(cut)}`);
		assert(Math.abs(cut.name.top + cut.name.height / 2 - (cut.self.top + cut.self.height / 2)) < 4, `name and description on one line, got ${JSON.stringify(cut)}`);
		assert((await list(page).locator(".pop-foot").count()) === 0, "no footer of keyboard hints");
		await typeFresh(page, "please read /pdf-fill");
		await list(page).waitFor({ state: "detached", timeout: 5_000 });
		await typeAndNoListAsked(page, pickRoom, " /", typeFresh, "a '/' after a space opens nothing");
		await box(page).fill("");
		console.log("  ok  '/' at the start opens the skills on in this room, one line each, the by-hand one tagged");
	}

	// 2. Typing filters; nothing fits: no list, and Enter sends the text as typed.
	if (wants(2)) {
		await typeFresh(page, "/LET");
		await waitUntil(async () => JSON.stringify(await rowNames(page)) === JSON.stringify(["/letters"]), "'/LET' leaves letters, ignoring case");
		await typeFresh(page, "/fill");
		await waitUntil(async () => JSON.stringify(await rowNames(page)) === JSON.stringify(["/pdf-fill"]), "a name that holds the text");
		const zzz = holdSettings(page, pickRoom);
		await zzz.done;
		await typeFresh(page, "/zzz");
		await waitUntil(async () => zzz.seen(), "the room's skills are asked for");
		await zzz.release();
		await pageTurn(page);
		assert((await list(page).count()) === 0, "nothing fits: no list");
		await box(page).pressSequentially(" as typed");
		const sent = await sendAndWait(page, "/zzz as typed");
		assert(sent === "/zzz as typed", `the model gets the text as typed, got ${JSON.stringify(sent)}`);
		console.log("  ok  typing filters; with nothing to fit, Enter sends as typed");
	}

	// 3. Keys and a click: Down and Up move, Enter and Tab pick, Esc closes and typing reopens; a pick keeps the rest.
	if (wants(3)) {
		await typeFresh(page, "/");
		await list(page).waitFor({ timeout: 10_000 });
		assert((await selected(page)) === "/letters", "the first is selected");
		await box(page).press("ArrowDown");
		assert((await selected(page)) === "/pdf-fill", "Down moves");
		await box(page).press("ArrowDown");
		assert((await selected(page)) === "/letters", "Down wraps");
		await box(page).press("ArrowUp");
		assert((await selected(page)) === "/pdf-fill", "Up moves back");
		await box(page).press("Enter");
		await list(page).waitFor({ state: "detached", timeout: 5_000 });
		assert((await box(page).inputValue()) === "/pdf-fill ", `Enter picks, got ${JSON.stringify(await box(page).inputValue())}`);
		assert((await page.locator(".messages .bubble-row.user").filter({ hasText: "/pdf-fill" }).count()) === 0, "Enter on the list sends nothing");
		await typeFresh(page, "/le");
		await list(page).waitFor({ timeout: 10_000 });
		await box(page).press("Tab");
		assert((await box(page).inputValue()) === "/letters ", `Tab picks, got ${JSON.stringify(await box(page).inputValue())}`);
		await typeFresh(page, "/");
		await list(page).waitFor({ timeout: 10_000 });
		await box(page).press("Escape");
		await list(page).waitFor({ state: "detached", timeout: 5_000 });
		assert((await box(page).inputValue()) === "/", "Esc closes the list and keeps the text");
		await box(page).pressSequentially("p");
		await list(page).waitFor({ timeout: 10_000 });
		// The caret back in the first word of a longer message: a click picks, and the rest stays.
		await box(page).fill("/p fill the form");
		await box(page).press("Home");
		await box(page).press("ArrowRight");
		await box(page).press("ArrowRight");
		await list(page).waitFor({ timeout: 10_000 });
		await list(page).locator('[role="option"]').filter({ hasText: "/pdf-fill" }).click();
		assert((await box(page).inputValue()) === "/pdf-fill fill the form", `a click picks and keeps the rest, got ${JSON.stringify(await box(page).inputValue())}`);
		assert(await box(page).evaluate((el: HTMLTextAreaElement) => el === document.activeElement && el.selectionStart === "/pdf-fill ".length), "the box keeps the focus, the caret after the name");
		await box(page).fill("");
		console.log("  ok  Down, Up, Enter, Tab, Esc and a click work as in the '@' list");
	}

	// 4. A picked message shows as typed, and the model gets the skill's instructions with it.
	if (wants(4)) {
		await typeFresh(page, "/let");
		await list(page).waitFor({ timeout: 10_000 });
		await box(page).press("Enter");
		await box(page).pressSequentially("draft the note");
		const sent = await sendAndWait(page, "/letters draft the note");
		assert(sent.startsWith(`${SKILL_PICKED_OPEN}\n`) && sent.includes("The letters instructions.") && sent.endsWith("/letters draft the note"), `the model gets the instructions in front of the words, got ${JSON.stringify(sent)}`);
		const bubble = (await page.locator(".messages .bubble-row.user:not(.queued) .bubble").last().innerText()).trim();
		assert(bubble === "/letters draft the note", `the message shows as typed, got ${JSON.stringify(bubble)}`);
		console.log("  ok  a picked message shows as typed and brings the skill's instructions");
	}

	// 5. Under a room's "Asking" label the list never opens.
	if (wants(5)) {
		await typeFresh(page, `@${OTHER.split(" ")[0]} `);
		await page.locator(".composer-asking-name").waitFor({ timeout: 10_000 });
		const pressOn = (page: Page, text: string) => box(page).pressSequentially(text);
		await typeAndNoListAsked(page, pickRoom, "/", pressOn, "no list under the label");
		await typeAndNoListAsked(page, pickRoom, "pd", pressOn, "still none");
		assert((await box(page).inputValue()) === "/pd", "the text as typed");
		await page.getByRole("button", { name: `Don't ask ${OTHER}` }).click();
		await box(page).fill("");
		console.log("  ok  never under an 'Asking' label");
	}

	// 6. A skill switched on while the page is open is in the list at its next opening, after the "/" is left and after Esc.
	if (wants(6)) {
		await typeFresh(page, "/");
		await list(page).waitFor({ timeout: 10_000 });
		assert(!(await rowNames(page)).includes("/later-on"), "not on yet");
		await box(page).fill("");
		await list(page).waitFor({ state: "detached", timeout: 5_000 });
		await switchInRoom(pickRoom, "enable", "later-on");
		try {
			await typeFresh(page, "/");
			await waitUntil(async () => (await rowNames(page)).includes("/later-on"), "the skill switched on is there, without a reload");
		} finally {
			await switchInRoom(pickRoom, "disable", "later-on");
		}
		await box(page).fill("");
		// Esc closes the list as leaving the "/" does: typing after it asks again.
		await typeFresh(page, "/");
		await list(page).waitFor({ timeout: 10_000 });
		await box(page).press("Escape");
		await list(page).waitFor({ state: "detached", timeout: 5_000 });
		await switchInRoom(pickRoom, "enable", "later-on");
		try {
			await box(page).press("l");
			await waitUntil(async () => (await rowNames(page)).includes("/later-on"), "after Esc, the skill switched on is there when typing reopens the list");
		} finally {
			await switchInRoom(pickRoom, "disable", "later-on");
		}
		await box(page).fill("");
		console.log("  ok  a skill switched on a moment ago is in the list at its next opening, after Esc too");
	}

	// 7. While the skills load, and after a failed lookup: no list, Enter sends as typed; the next opening recovers.
	if (wants(7)) {
		const hold = holdSettings(page, pickRoom);
		await hold.done;
		await typeFresh(page, "/pdf-fill");
		await waitUntil(async () => hold.seen(), "the room's skills are asked for");
		assert((await list(page).count()) === 0, "no list while they load");
		await hold.fail();
		await pageTurn(page);
		assert((await list(page).count()) === 0, "no list after a failed lookup");
		await box(page).pressSequentially(" while it failed");
		const sent = await sendAndWait(page, "/pdf-fill while it failed");
		assert(sent.startsWith(`${SKILL_PICKED_OPEN}\n`) && sent.includes("The pdf-fill instructions."), `the server reads the pick all the same, got ${JSON.stringify(sent.slice(0, 200))}`);
		await hold.release();
		await typeFresh(page, "/");
		await waitUntil(async () => JSON.stringify(await rowNames(page)) === JSON.stringify(["/letters", "/pdf-fill"]), "the next opening recovers");
		await box(page).fill("");
		console.log("  ok  no list while loading or after a failure, Enter sends as typed, and the next opening recovers");
	}

	// 8. An answer for a room the person has left is dropped.
	if (wants(8)) {
		const holdPick = holdSettings(page, pickRoom);
		await holdPick.done;
		await typeFresh(page, "/");
		await waitUntil(async () => holdPick.seen(), "the pick room's skills are asked for");
		await goHome(page);
		await enterRoom(page, OTHER);
		const holdOther = holdSettings(page, otherRoom);
		await holdOther.done;
		await typeFresh(page, "/");
		await waitUntil(async () => holdOther.seen(), "the other room's skills are asked for");
		await holdPick.release();
		await pageTurn(page);
		assert((await list(page).count()) === 0, `the left room's answer draws no list, got ${JSON.stringify(await rowNames(page).catch(() => []))}`);
		await holdOther.release();
		await waitUntil(async () => JSON.stringify(await rowNames(page)) === JSON.stringify(["/off-skill"]), "this room's own skills");
		await box(page).fill("");
		await goHome(page);
		await enterRoom(page, PICK);
		console.log("  ok  an answer for a room the person has left is dropped");
	}

	// 9. An answer from an earlier opening that comes late never replaces the newer one.
	if (wants(9)) {
		const hold = holdSettings(page, pickRoom);
		await hold.done;
		await typeFresh(page, "/");
		await waitUntil(async () => hold.seen(), "the first opening's read is answered and held");
		await box(page).fill("");
		await switchInRoom(pickRoom, "enable", "later-on");
		try {
			hold.letThrough();
			await typeFresh(page, "/");
			await waitUntil(async () => (await rowNames(page)).includes("/later-on"), "the newer opening shows the skill switched on");
			await hold.release();
			await pageTurn(page);
			assert((await rowNames(page)).includes("/later-on"), `the older answer, from before the switch, never replaces it, got ${JSON.stringify(await rowNames(page))}`);
		} finally {
			await switchInRoom(pickRoom, "disable", "later-on");
		}
		await box(page).fill("");
		console.log("  ok  a late answer from an earlier opening never replaces the newer one");
	}

	// 10. At phone width the list fits the screen, a description has its own line, the folder line above the box hides while the list is open, and a tap picks.
	if (wants(10)) {
		// One window holds a room at a time: the desktop one closes first.
		await closeContext(context);
		const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
		const tap = await phone.newPage();
		await tap.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await tap.waitForLoadState("networkidle");
		if (await tap.locator(".whats-new-close").count()) await tap.locator(".whats-new-close").click();
		await enterRoom(tap, PICK);
		await box(tap).tap();
		await box(tap).pressSequentially("/");
		await list(tap).waitFor({ timeout: 10_000 });
		const fits = await list(tap).evaluate((el) => {
			const rect = el.getBoundingClientRect();
			return { left: rect.left, right: rect.right, width: window.innerWidth, scroll: document.documentElement.scrollWidth };
		});
		assert(fits.left >= 0 && fits.right <= fits.width && fits.scroll <= fits.width, `the list fits the phone's screen, got ${JSON.stringify(fits)}`);
		// The by-hand row's description has a line of its own under the name and the tag, as wide as the row, and the row is a 44 px target.
		const byHand = await list(tap).locator('[role="option"]').filter({ hasText: "/letters" }).evaluate((row) => {
			const [name, tag, description] = [".skill-pick-name", ".skill-tag", ".skill-pick-description"].map((sel) => row.querySelector(sel)!.getBoundingClientRect());
			const inner = row.getBoundingClientRect().width - parseFloat(getComputedStyle(row).paddingLeft) - parseFloat(getComputedStyle(row).paddingRight);
			return { name, tag, description, inner, height: row.getBoundingClientRect().height };
		});
		assert(byHand.description.top >= Math.max(byHand.name.bottom, byHand.tag.bottom) - 1 && byHand.description.width >= byHand.inner - 1, `the description under the name and tag, full width, got ${JSON.stringify(byHand)}`);
		assert(byHand.height >= 44, `a 44 px row, got ${byHand.height}`);
		// The folder line above the box stands taller than a short list: hidden while the list is open, back once it closes.
		const folderLine = tap.locator(".room-workspace-nudge");
		assert((await folderLine.count()) === 1 && !(await folderLine.isVisible()), "the folder line is hidden while the list is open");
		await list(tap).locator('[role="option"]').filter({ hasText: "/pdf-fill" }).tap();
		assert((await box(tap).inputValue()) === "/pdf-fill ", `a tap picks, got ${JSON.stringify(await box(tap).inputValue())}`);
		await folderLine.waitFor({ state: "visible", timeout: 5_000 });
		await closeContext(phone);
		console.log("  ok  at phone width the list fits, a description has its own line, the folder line hides while it is open, and a tap picks");
	}
	console.log("skill-pick-ui-smoke: OK");
} catch (error) {
	failure = error;
} finally {
	if (browser) await closeBrowser(browser);
	await stopRoomStateServer(failure);
}
if (failure) throw failure;
