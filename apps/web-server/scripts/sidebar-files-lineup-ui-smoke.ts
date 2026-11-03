// The room's sidebar lines its Files block up on the sidebar's one left edge,
// in the page against a real server. On a wide screen, in the browser and in
// the mac app's look, light and dark: the wordmark, Home, the "Files" word and
// every file's tile start on --sidebar-text-left; the selected and the hovered
// file card's box starts where Home's highlight does; the header is a small
// muted label with the count on the right and no arrow, and it folds and
// unfolds on a click and from the keyboard, a folded list showing the header
// and count only. At phone width the block keeps its look: the arrow before
// the word, the word, the cards and the tiles where they were. Offline: a
// synthetic model. Throwaway HOME.
import fs from "node:fs";
import { chromium, type Page } from "playwright";
import { assert, baseUrl, openRoom, requestJson, startRoomStateServer, stopRoomStateServer, waitUntil } from "./room-state-setup.js";
import { SMOKE_AUTH_TOKEN } from "./smoke-server-process.js";
import { closeBrowser } from "./smoke-close-context.js";

{
	const executable = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!executable || !fs.existsSync(executable)) {
		console.log("sidebar-files-lineup-ui-smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const ROOM = "Garden Plans";
const FILES = ["watering.md", "bed-layout.md", "seed-order.md"];
const SELECTED = "bed layout";
const HOVERED = "watering";
const TRANSPARENT = "rgba(0, 0, 0, 0)";
// The phone's block as it reads on main: the card's box on the list's 12px,
// the tile inside its 1px border and 6px padding, and the word after the
// header's 4px padding, the arrow's 10px and the 6px gap.
const PHONE = { cardLeft: 12, tileLeft: 19, wordLeft: 32, fontSize: "11px", fontWeight: "700" };

interface Edges {
	edge: number;
	wordmark: number;
	home: number;
	homeBox: number;
	word: number;
	tiles: number[];
	cards: Array<{ name: string; left: number; background: string }>;
	head: { fontSize: string; fontWeight: string; color: string; muted: string; arrow: string; count: string; countRight: number; headRight: number };
	caret: number;
}

// The page's edges, read in one evaluate. No named function inside it: tsx
// wraps those in a helper the page does not have.
async function edges(page: Page): Promise<Edges> {
	return page.evaluate(() => {
		const home = [...document.querySelectorAll(".sidebar-primary-nav .list-btn")].find((button) => (button.textContent ?? "").trim() === "Home") ?? null;
		const [homeText, word] = [home, document.querySelector(".assets-head-label")].map((element) => {
			if (!element) return Number.NaN;
			const range = document.createRange();
			range.selectNodeContents(element);
			return range.getClientRects()[0]?.left ?? Number.NaN;
		});
		const head = document.querySelector(".assets-head")!;
		const headStyle = getComputedStyle(head);
		const probe = document.createElement("span");
		probe.style.color = "var(--muted)";
		head.append(probe);
		const muted = getComputedStyle(probe).color;
		probe.remove();
		const count = document.querySelector(".assets-count")!;
		return {
			edge: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sidebar-text-left")),
			wordmark: document.querySelector(".sidebar-header .brand img.logo")?.getBoundingClientRect().left ?? Number.NaN,
			home: homeText,
			homeBox: home?.getBoundingClientRect().left ?? Number.NaN,
			word,
			tiles: [...document.querySelectorAll(".assets-row .assets-icon")].map((tile) => tile.getBoundingClientRect().left),
			cards: [...document.querySelectorAll(".assets-row")].map((card) => ({ name: (card.querySelector(".assets-row-title")?.textContent ?? "").trim(), left: card.getBoundingClientRect().left, background: getComputedStyle(card).backgroundColor })),
			head: { fontSize: headStyle.fontSize, fontWeight: headStyle.fontWeight, color: headStyle.color, muted, arrow: `${document.querySelector(".assets-caret")?.textContent ?? ""}${getComputedStyle(head, "::before").content.replace(/^none$/, "")}`, count: (count.textContent ?? "").trim(), countRight: count.getBoundingClientRect().right, headRight: head.getBoundingClientRect().right },
			caret: document.querySelectorAll(".assets-caret").length,
		};
	});
}

const near = (a: number, b: number) => Math.abs(a - b) <= 1;
const failures: string[] = [];
let passes = 0;
const check = (ok: boolean, message: string) => {
	if (ok) passes += 1;
	else failures.push(message);
};

let error: unknown;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
	await startRoomStateServer();
	const { roomId } = await openRoom(ROOM);
	for (const file of FILES) {
		const uploaded = await requestJson(`/api/persistent-agents/${roomId}/files`, { method: "POST", body: JSON.stringify({ filename: file, contentBase64: Buffer.from(`# ${file}\n`).toString("base64") }) });
		assert(uploaded.status === 200 || uploaded.status === 201, `${file} reaches the room's shelf, got ${uploaded.status} ${JSON.stringify(uploaded.body)}`);
	}

	browser = await chromium.launch();
	const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
	await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
	await page.waitForLoadState("networkidle");
	if (await page.locator(".whats-new-close").count()) await page.locator(".whats-new-close").click();
	await page.locator(".persistent-agent-card").filter({ hasText: ROOM }).getByRole("button", { name: /^(Enter|Resume)$/ }).click();
	const card = (name: string) => page.locator(".assets-row").filter({ hasText: name }).first();
	await waitUntil(async () => (await page.locator(".assets-row").count()) === FILES.length, "the sidebar lists the room's three files", 15_000);
	await card(SELECTED).click();
	await page.locator(".assets-row.sel").waitFor({ timeout: 10_000 });
	const head = page.locator(".assets-head");

	// Wide: the edges, the card boxes, the header's look, in both looks and both themes.
	for (const mac of [false, true]) {
		await page.evaluate((on) => document.documentElement.classList.toggle("desktop-app-mac", on), mac);
		for (const scheme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme: scheme });
			const look = `1280 wide, ${mac ? "mac app" : "browser"}, ${scheme}`;
			await card(HOVERED).hover();
			await waitUntil(async () => (await card(HOVERED).evaluate((element) => getComputedStyle(element).backgroundColor)) !== TRANSPARENT, `${look}: the hovered card shows its box`, 3_000).catch(() => {});
			const at = await edges(page);
			check(at.edge === (mac ? 27 : 41), `${look}: the sidebar's text edge is ${at.edge}`);
			check(near(at.wordmark, at.edge), `${look}: the wordmark starts at ${at.wordmark}, the edge is ${at.edge}`);
			check(near(at.home, at.edge), `${look}: Home starts at ${at.home}, the edge is ${at.edge}`);
			check(near(at.word, at.edge), `${look}: the "Files" word starts at ${at.word}, the edge is ${at.edge}`);
			check(at.tiles.length === FILES.length && at.tiles.every((left) => near(left, at.edge)), `${look}: the file tiles start at ${JSON.stringify(at.tiles)}, the edge is ${at.edge}`);
			for (const [name, why] of [[SELECTED, "selected"], [HOVERED, "hovered"]]) {
				const box = at.cards.find((each) => each.name.includes(name));
				check(!!box && box.background !== TRANSPARENT && near(box.left, at.homeBox), `${look}: the ${why} card's box ${box ? `starts at ${box.left} (${box.background})` : "is missing"}, Home's highlight at ${at.homeBox}`);
			}
			check(at.head.fontSize === "12px" && at.head.fontWeight === "500" && at.head.color === at.head.muted, `${look}: the header reads ${at.head.fontSize} / ${at.head.fontWeight} in ${at.head.color}, the muted colour is ${at.head.muted}`);
			check(at.caret === 0 && at.head.arrow === "", `${look}: the header draws an arrow (${at.caret} in the markup, ${JSON.stringify(at.head.arrow)} in all)`);
			check(at.head.count === String(FILES.length) && at.head.headRight - at.head.countRight <= 6, `${look}: the count reads ${JSON.stringify(at.head.count)} and ends ${at.head.headRight - at.head.countRight}px short of the header's right`);
		}
	}
	await page.evaluate(() => document.documentElement.classList.remove("desktop-app-mac"));
	await page.emulateMedia({ colorScheme: "light" });

	// The header's name and its folding: a click folds, Enter unfolds, Space folds, a click unfolds.
	const named = page.getByRole("button", { name: `Files ${FILES.length}`, exact: true });
	check(await named.count() === 1, `the header's accessible name is "Files ${FILES.length}" (${await head.evaluate((element) => element.textContent)})`);
	const folded = async () => ({ expanded: await head.getAttribute("aria-expanded"), rows: await page.locator(".assets-rows").count(), shown: (await page.locator(".sidebar-assets").innerText()).replace(/\s+/g, " ").trim() });
	const steps: Array<[string, () => Promise<void>, boolean]> = [
		["a click", () => head.click(), true],
		["Enter", async () => { await head.focus(); await page.keyboard.press("Enter"); }, false],
		["Space", async () => { await head.focus(); await page.keyboard.press("Space"); }, true],
		["a click", () => head.click(), false],
	];
	for (const [how, act, fold] of steps) {
		await act();
		await waitUntil(async () => (await head.getAttribute("aria-expanded")) === String(!fold), `${how} ${fold ? "folds" : "unfolds"} the list`, 3_000).catch(() => {});
		const state = await folded();
		if (fold) check(state.expanded === "false" && state.rows === 0 && state.shown === `Files ${FILES.length}`, `${how} folds to the header and count only, got ${JSON.stringify(state)}`);
		else check(state.expanded === "true" && state.rows === 1 && (await page.locator(".assets-row").count()) === FILES.length, `${how} unfolds the list, got ${JSON.stringify(state)}`);
	}

	// The phone keeps its block: the arrow before the word, the word and the cards where they were.
	// Narrowing to phone width closes the drawer (sidebar-collapse.tsx), on the
	// media query's change event; the smoke waits for that, then opens it as a
	// person does and waits for its slide to end.
	await page.setViewportSize({ width: 390, height: 844 });
	await waitUntil(() => page.evaluate(() => document.documentElement.classList.contains("sidebar-collapsed")), "the phone's drawer starts closed", 5_000);
	await page.getByRole("button", { name: "Show sidebar" }).first().click();
	await head.waitFor({ state: "visible", timeout: 10_000 });
	await waitUntil(async () => near((await edges(page)).cards[0]?.left ?? -1, PHONE.cardLeft), "the phone's drawer has opened", 5_000).catch(() => {});
	const phone = await edges(page);
	check(phone.cards.length === FILES.length && phone.cards.every((each) => near(each.left, PHONE.cardLeft)), `at phone width the cards start at ${JSON.stringify(phone.cards.map((each) => each.left))}, on main ${PHONE.cardLeft}`);
	check(phone.tiles.every((left) => near(left, PHONE.tileLeft)), `at phone width the tiles start at ${JSON.stringify(phone.tiles)}, on main ${PHONE.tileLeft}`);
	check(near(phone.word, PHONE.wordLeft) && phone.head.fontSize === PHONE.fontSize && phone.head.fontWeight === PHONE.fontWeight, `at phone width the word starts at ${phone.word} in ${phone.head.fontSize} / ${phone.head.fontWeight}, on main ${PHONE.wordLeft} in ${PHONE.fontSize} / ${PHONE.fontWeight}`);
	check(phone.head.arrow.includes("▾"), `at phone width the open list's arrow reads ${phone.head.arrow}`);
	await head.click();
	await waitUntil(async () => (await head.getAttribute("aria-expanded")) === "false", "the phone's list folds", 3_000);
	const phoneFolded = await edges(page);
	check(phoneFolded.head.arrow.includes("▸") && near(phoneFolded.word, PHONE.wordLeft), `at phone width the folded list's arrow reads ${phoneFolded.head.arrow}, its word starts at ${phoneFolded.word}`);
	check(await named.count() === 1, "at phone width the arrow stays out of the header's accessible name");

	assert(failures.length === 0, `the sidebar's Files block:\n  ${failures.join("\n  ")}`);
	console.log("  ok at 1280 wide, browser and mac look, light and dark: the wordmark, Home, the \"Files\" word and every tile start on the sidebar's text edge, and the selected and hovered cards' boxes start where Home's highlight does");
	console.log("  ok the header reads 12px / 500 in the muted colour with the count on the right and no arrow; a click, Enter and Space fold and unfold it, a folded list shows the header and count only, and its name reads \"Files 3\"");
	console.log("  ok at phone width the block keeps its look: the arrow before the word, the word, the cards and the tiles where they were");
	console.log(`sidebar-files-lineup-ui-smoke: ${passes} checks passed`);
} catch (caught) {
	error = caught;
	console.error(`sidebar-files-lineup-ui-smoke FAILED: ${(caught as Error).message}`);
	if (failures.length > 0 && !(caught as Error).message.includes(failures[0])) console.error(`  before that:\n  ${failures.join("\n  ")}`);
	process.exitCode = 1;
} finally {
	if (browser) await closeBrowser(browser).catch(() => {});
	await stopRoomStateServer(error);
}
