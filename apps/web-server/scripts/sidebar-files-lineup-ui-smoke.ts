// The room's sidebar: "Attachments" is one row under Home, in the page against
// a real server. On a wide screen, in the browser and in the mac app's look,
// light and dark: the wordmark, Home and the entry's word start on
// --sidebar-text-left, the entry reads as Home reads, its count sits at the
// right in plain muted digits, and no per-file list is left. A room with no
// files shows the entry without a number. Rows step 36px in the browser and
// 32px in the mac app, in the room and on Home, and the logo is 22 in both.
// At phone width the entry sits under Home in the drawer. Offline: a synthetic
// model. Throwaway HOME.
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
const EMPTY_ROOM = "Quiet Plot";
const FILES = ["watering.md", "bed-layout.md", "seed-order.md"];
const STEP = { browser: 36, mac: 32 };
const LOGO_HEIGHT = 22;

interface Sidebar {
	edge: number;
	logoLeft: number;
	logoHeight: number;
	homeWord: number;
	homeBox: { left: number; top: number; right: number; bottom: number };
	entryWord: number;
	entryBox: { left: number; top: number; right: number; bottom: number };
	home: { fontSize: string; fontWeight: string; color: string };
	entry: { fontSize: string; fontWeight: string; color: string };
	count: { text: string; color: string; right: number; background: string } | null;
	muted: string;
	fileRows: number;
}

// The page's edges, read in one evaluate. No named function inside it: tsx
// wraps those in a helper the page does not have.
async function sidebar(page: Page): Promise<Sidebar> {
	return page.evaluate(() => {
		const home = [...document.querySelectorAll(".sidebar-primary-nav .list-btn")].find((button) => (button.textContent ?? "").trim() === "Home")!;
		const entry = document.querySelector(".attachments-entry")!;
		const [homeWord, entryWord] = [home, entry.firstElementChild!].map((element) => {
			const range = document.createRange();
			range.selectNodeContents(element);
			return range.getClientRects()[0]?.left ?? Number.NaN;
		});
		const [homeBox, entryBox] = [home, entry].map((element) => {
			const { left, top, right, bottom } = element.getBoundingClientRect();
			return { left, top, right, bottom };
		});
		const [homeType, entryType] = [home, entry].map((element) => {
			const { fontSize, fontWeight, color } = getComputedStyle(element);
			return { fontSize, fontWeight, color };
		});
		const count = entry.querySelector(".attachments-entry-count");
		const probe = document.createElement("span");
		probe.style.color = "var(--muted)";
		entry.append(probe);
		const muted = getComputedStyle(probe).color;
		probe.remove();
		const logo = document.querySelector(".sidebar-header .brand img.logo")?.getBoundingClientRect();
		return {
			edge: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sidebar-text-left")),
			logoLeft: logo?.left ?? Number.NaN,
			logoHeight: logo?.height ?? Number.NaN,
			homeWord,
			homeBox: homeBox!,
			entryWord,
			entryBox: entryBox!,
			home: homeType!,
			entry: entryType!,
			count: count ? { text: (count.textContent ?? "").trim(), color: getComputedStyle(count).color, right: count.getBoundingClientRect().right, background: getComputedStyle(count).backgroundColor } : null,
			muted,
			fileRows: document.querySelectorAll(".sidebar .assets-row, .sidebar .sidebar-assets").length,
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
	await openRoom(EMPTY_ROOM);
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
	const enter = (room: string) => page.locator(".persistent-agent-card").filter({ hasText: room }).getByRole("button", { name: /^(Enter|Resume)$/ }).click();
	const macLook = (on: boolean) => page.evaluate((mac) => document.documentElement.classList.toggle("desktop-app-mac", mac), on);

	// Home's list takes the same step before any room opens.
	for (const mac of [false, true]) {
		await macLook(mac);
		const tops = await page.evaluate(() => [...document.querySelectorAll(".product-nav .list-btn")].map((row) => row.getBoundingClientRect().top));
		const steps = tops.slice(1).map((top, index) => top - tops[index]!);
		const step = STEP[mac ? "mac" : "browser"];
		check(steps.length >= 2 && steps.every((each) => near(each, step)), `Home's rows in the ${mac ? "mac app" : "browser"} step ${JSON.stringify(steps)}, not ${step}`);
	}
	await macLook(false);

	await enter(EMPTY_ROOM);
	await page.locator(".attachments-entry").waitFor({ timeout: 15_000 });
	const empty = await sidebar(page);
	check(empty.count === null && (await page.locator(".attachments-entry").innerText()).trim() === "Attachments", `at 0 the entry reads ${JSON.stringify(await page.locator(".attachments-entry").innerText())}, with no number`);
	await page.locator(".sidebar-home-btn").click();
	await enter(ROOM);
	await waitUntil(async () => (await page.locator(".attachments-entry-count").count()) === 1, "the entry counts the room's files", 15_000);

	for (const mac of [false, true]) {
		await macLook(mac);
		for (const scheme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme: scheme });
			const look = `1280 wide, ${mac ? "mac app" : "browser"}, ${scheme}`;
			const at = await sidebar(page);
			check(at.edge === (mac ? 27 : 41), `${look}: the sidebar's text edge is ${at.edge}`);
			check(near(at.logoLeft, at.edge), `${look}: the wordmark starts at ${at.logoLeft}, the edge is ${at.edge}`);
			check(near(at.logoHeight, LOGO_HEIGHT), `${look}: the logo is ${at.logoHeight} high, not ${LOGO_HEIGHT}`);
			check(near(at.homeWord, at.edge), `${look}: Home starts at ${at.homeWord}, the edge is ${at.edge}`);
			check(near(at.entryWord, at.edge), `${look}: the entry's word starts at ${at.entryWord}, the edge is ${at.edge}`);
			check(near(at.entryBox.left, at.homeBox.left) && near(at.entryBox.right, at.homeBox.right), `${look}: the entry's box runs ${at.entryBox.left} to ${at.entryBox.right}, Home's ${at.homeBox.left} to ${at.homeBox.right}`);
			check(near(at.entryBox.top - at.homeBox.top, STEP[mac ? "mac" : "browser"]), `${look}: the entry sits ${at.entryBox.top - at.homeBox.top}px under Home, the list's step is ${STEP[mac ? "mac" : "browser"]}`);
			check(JSON.stringify(at.entry) === JSON.stringify(at.home), `${look}: the entry reads ${JSON.stringify(at.entry)}, Home ${JSON.stringify(at.home)}`);
			check(at.count?.text === String(FILES.length) && at.count.color === at.muted && at.count.background === "rgba(0, 0, 0, 0)" && at.entryBox.right - at.count.right <= 14, `${look}: the count is ${JSON.stringify(at.count)}, plain muted digits at the right, the muted colour ${at.muted}`);
			check(at.fileRows === 0, `${look}: ${at.fileRows} per-file rows are left in the sidebar`);
		}
	}
	await macLook(false);
	await page.emulateMedia({ colorScheme: "light" });

	const entry = page.locator(".attachments-entry");
	check(await page.getByRole("button", { name: `Attachments ${FILES.length}`, exact: true }).count() === 1, `the entry's accessible name is "Attachments ${FILES.length}"`);
	await entry.focus();
	await page.keyboard.press("Enter");
	await waitUntil(async () => (await entry.getAttribute("aria-expanded")) === "true", "Enter opens the Attachments", 3_000);
	await page.keyboard.press("Space");
	await waitUntil(async () => (await entry.getAttribute("aria-expanded")) === "false", "Space closes the Attachments", 3_000);

	// Narrowing to phone width closes the drawer (sidebar-collapse.tsx), on the
	// media query's change event; the smoke waits for that, then opens it as a
	// person does and waits for its slide to end.
	await page.setViewportSize({ width: 390, height: 844 });
	await waitUntil(() => page.evaluate(() => document.documentElement.classList.contains("sidebar-collapsed")), "the phone's drawer starts closed", 5_000);
	await page.getByRole("button", { name: "Show sidebar" }).first().click();
	await entry.waitFor({ state: "visible", timeout: 10_000 });
	await waitUntil(async () => near((await sidebar(page)).homeBox.left, 12), "the phone's drawer has opened", 5_000);
	const phone = await sidebar(page);
	// The drawer's rows are tap-sized, so the gap is what carries over.
	check(near(phone.entryBox.left, phone.homeBox.left) && near(phone.entryBox.top - phone.homeBox.bottom, 4), `at phone width the entry starts at ${phone.entryBox.left}, ${phone.entryBox.top - phone.homeBox.bottom}px under Home`);
	check(phone.count?.text === String(FILES.length), `at phone width the count reads ${JSON.stringify(phone.count)}`);
	check(phone.fileRows === 0, `at phone width ${phone.fileRows} per-file rows are left in the drawer`);

	assert(failures.length === 0, `the sidebar's Attachments entry:\n  ${failures.join("\n  ")}`);
	console.log("  ok at 1280 wide, browser and mac look, light and dark: the wordmark, Home and the entry start on the sidebar's text edge, the entry reads as Home reads, the count is plain muted digits at the right, and no per-file row is left");
	console.log(`  ok rows step ${STEP.browser}px in the browser and ${STEP.mac}px in the mac app, in a room and on Home, and the logo is ${LOGO_HEIGHT} in both`);
	console.log("  ok a room with no files shows the entry with no number; Enter and Space work it from the keyboard");
	console.log("  ok at phone width the entry sits under Home in the drawer");
	console.log(`sidebar-files-lineup-ui-smoke: ${passes} checks passed`);
} catch (caught) {
	error = caught;
	console.error(`sidebar-files-lineup-ui-smoke FAILED: ${(caught as Error).message}`);
	if (failures.length > 0 && !(caught as Error).message.includes(failures[0]!)) console.error(`  before that:\n  ${failures.join("\n  ")}`);
	process.exitCode = 1;
} finally {
	if (browser) await closeBrowser(browser).catch(() => {});
	await stopRoomStateServer(error);
}
