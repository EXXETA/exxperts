// The parts the settings look's smokes share: a signed-in page with the look on
// (nothing set, as a person has it), turned back to the old look, or with
// storage that refuses to be read, a window and a page opened in it, the page's
// requests waited for, the colour tools, and the reader of style rules outside
// the look's roots. Importing it does nothing: each smoke starts its own server
// and passes its address and its room's name to `lookPages`.
import type { Browser, BrowserContextOptions, Locator, Page, Request } from "playwright";
import { authedFetch, SMOKE_AUTH_TOKEN } from "./smoke-server-process.js";
import { waitEvery } from "./smoke-wait.js";
import { SETTINGS_LOOK_KEY, SETTINGS_LOOK_OLD } from "../../web-ui/src/settings-look.js";

const waitUntil = waitEvery(100);

export function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
export function same(actual: unknown, expected: unknown, what: string): void {
	assert(JSON.stringify(actual) === JSON.stringify(expected), `${what}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}
/** The contrast of two #rrggbb colours, as WCAG has it. */
export function contrast(one: string, other: string): number {
	const luminance = (hex: string) => {
		const [r, g, b] = [1, 3, 5].map((at) => { const c = parseInt(hex.slice(at, at + 2), 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
		return 0.2126 * r + 0.7152 * g + 0.0722 * b;
	};
	const [hi, lo] = [luminance(one), luminance(other)].sort((a, b) => b - a);
	return (hi + 0.05) / (lo + 0.05);
}
/** Two #rrggbb colours within one step per channel: a mix's rounding. */
export function nearColour(actual: string, expected: string, what: string): void {
	const channels = (hex: string) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
	const [a, b] = [channels(actual), channels(expected)];
	assert(/^#[0-9a-f]{6}$/.test(actual) && a.every((value, i) => Math.abs(value - b[i]) <= 1), `${what}: got ${actual}, expected ${expected}`);
}

export const SWITCH_CLASS = ".settings-dialog.settings-look-next";
export const LOOK_FILE = "44-settings-look.css";
export const SETTINGS_ORDER = ["AI setup", "Instructions", "Skills", "Connectors", "Web search", "Appearance", "Remote access", "Profiles"];
export const ROOM_ORDER = ["Model", "Memory", "Instructions", "Folder", "Skills", "Connectors", "Scheduled tasks", "Conversation", "Archive or delete"];
export const LIGHT = "light";
export const DARK = "dark";
export type Theme = typeof LIGHT | typeof DARK;
export type Window = "settings" | "room";

/** The style files the page loads after the look's first file that are not one of its page files
 * (`<number>-settings-look-<pages>.css`), from styles.css's imports in order; the first file missing is one too. */
export function notLookPageFilesAfterLook(imports: string[]): string[] {
	const at = imports.indexOf(LOOK_FILE);
	if (at < 0) return [LOOK_FILE];
	return imports.slice(at + 1).filter((file) => !/^\d+-settings-look-[a-z]+(-[a-z]+)*\.css$/.test(file));
}

export const desktop = (width = 1440, height = 900, colorScheme: Theme = LIGHT): BrowserContextOptions => ({ viewport: { width, height }, colorScheme });
export const phone = (colorScheme: Theme = LIGHT): BrowserContextOptions => ({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme });
export const isPhone = (page: Page): boolean => (page.viewportSize()?.width ?? 1280) <= 760;

/** The requests to the server made since the settings window opened that are still out. The app's own requests
 * from before (such as marking what's new as seen) are not the window's. */
const apiPending = new WeakMap<Page, () => string[]>();
const windowOpenedAt = new WeakMap<Page, number>();

/** From now on `answered` waits only for the page's requests made from here: a window opened, or a part outside it. */
export function requestsFromNow(page: Page): void {
	windowOpenedAt.set(page, Date.now());
}

/** Waits until none of the page's requests to the server is out, twice in a row: the open page has filled in. */
export async function answered(page: Page, what: string): Promise<void> {
	let idle = 0;
	await waitUntil(() => { idle = apiPending.get(page)!().length === 0 ? idle + 1 : 0; return idle >= 2; }, `${what}: the page's requests are answered`, 30000)
		.catch((error) => { throw new Error(`${(error as Error).message}; still out: ${apiPending.get(page)!().join(", ")}`); });
}

export async function closeWindow(page: Page): Promise<void> {
	await page.locator(".settings-dialog-close").first().click();
	await page.locator(".settings-dialog").first().waitFor({ state: "detached", timeout: 5000 });
}

export const navItem = (page: Page, label: string) => page.locator(".settings-dialog-nav-item").filter({ hasText: new RegExp(`^${label}$`) }).first();

export async function goToPage(page: Page, label: string): Promise<void> {
	const back = page.locator(".settings-dialog-back");
	if (isPhone(page) && await back.isVisible()) await back.click();
	await navItem(page, label).click();
	await waitUntil(async () => (await page.locator(".settings-dialog-nav-item.active").first().innerText()).trim() === label, `the page ${label} is open`);
	// A page fills in from its own request; its header, with its name as the title, is there first. A phone hides the title and keeps its page.
	await waitUntil(() => page.evaluate((name) => [...document.querySelectorAll(".settings-dialog-pane .pane-head")].some((head) => {
		let holder = head.parentElement!;
		while (getComputedStyle(holder).display === "contents") holder = holder.parentElement!;
		return head.querySelector("h2")?.textContent?.trim() === name && holder.getClientRects().length > 0;
	}), label), `the page ${label} shows its header`, 10000);
}

export const pagesOf = (which: Window) => which === "settings" ? SETTINGS_ORDER : ROOM_ORDER;

/** Opening pages on the server at `baseUrl`; the room's window is the one of the room named `room`. */
export function lookPages({ baseUrl, room }: { baseUrl: string; room: string }) {
	/** A signed-in page in its own context: "on" sets nothing, "off" names the old look in the switch's key, and
	 * "unreadable" sets nothing but makes reading the key throw. */
	async function openPage(browser: Browser, options: BrowserContextOptions, look: "on" | "off" | "unreadable"): Promise<Page> {
		// What's new seen before the page opens: shown late, its window would be closed, and its request sent, while a settings window waits for its own.
		const seen = await authedFetch(`${baseUrl}/api/whats-new/seen`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
		assert(seen.ok, `marking what's new as seen: ${seen.status}`);
		const context = await browser.newContext(options);
		// tsx wraps named functions in a helper the page does not have.
		await context.addInitScript("globalThis.__name = (target) => target");
		if (look === "off") await context.addInitScript(([key, old]) => localStorage.setItem(key, old), [SETTINGS_LOOK_KEY, SETTINGS_LOOK_OLD]);
		// Storage that refuses to be read: reading the key throws.
		if (look === "unreadable") {
			await context.addInitScript((key) => {
				const read = Storage.prototype.getItem;
				Storage.prototype.getItem = function (this: Storage, name: string) {
					if (name === key) throw new Error("storage refused");
					return read.call(this, name);
				};
			}, SETTINGS_LOOK_KEY);
		}
		const page = await context.newPage();
		// Settings, Skills' own check as it opens is answered with nothing: what a page shows changes only by what its smoke does.
		await page.route("**/api/skills/updates/check", (route) => JSON.parse(route.request().postData() ?? "{}").quiet === true ? route.fulfill({ contentType: "application/json", body: JSON.stringify({ checkedAt: new Date().toISOString(), results: [] }) }) : route.fallback());
		const pending = new Map<Request, number>();
		page.on("request", (request) => { if (request.url().includes("/api/")) pending.set(request, Date.now()); });
		page.on("requestfinished", (request) => { pending.delete(request); });
		page.on("requestfailed", (request) => { pending.delete(request); });
		apiPending.set(page, () => [...pending].filter(([, at]) => at >= (windowOpenedAt.get(page) ?? 0)).map(([request]) => new URL(request.url()).pathname));
		await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await page.locator(".persistent-agent-card").first().waitFor({ timeout: 15000 });
		return page;
	}

	async function openWindow(page: Page, which: Window): Promise<void> {
		requestsFromNow(page);
		if (which === "settings") {
			await page.locator(".product-sidebar-footer button, .home-gear, button[aria-label='Settings']").first().click();
			await page.locator(".sidebar-config-menu button, .sidebar-config-menu a").filter({ hasText: /Settings/ }).first().click();
			await page.waitForSelector(".settings-overlay", { timeout: 10000 });
		} else {
			await page.locator(".persistent-agent-card").filter({ hasText: room }).locator(".card-gear-btn").click();
			await page.waitForSelector(".rs-shell", { timeout: 10000 });
		}
	}

	/** Each page of both windows, in order, with the page open. */
	async function everyPage(page: Page, visit: (which: Window, label: string) => Promise<void>): Promise<void> {
		for (const which of ["settings", "room"] as const) {
			await openWindow(page, which);
			for (const label of pagesOf(which)) {
				await goToPage(page, label);
				await visit(which, label);
			}
			await closeWindow(page);
		}
	}

	return { openPage, openWindow, everyPage };
}

// What a sighted person gets: a colour flattened to sRGB through a canvas, and
// a colour over everything painted behind it.
export async function installColourTools(page: Page): Promise<void> {
	await page.evaluate(() => {
		type Rgba = [number, number, number, number];
		const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
		const rgba = (colour: string): Rgba => {
			context.clearRect(0, 0, 1, 1);
			context.fillStyle = colour;
			context.fillRect(0, 0, 1, 1);
			const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
			return [r, g, b, a / 255];
		};
		const over = (top: Rgba, under: Rgba): Rgba => [0, 1, 2].map((i) => Math.round(top[i] * top[3] + under[i] * (1 - top[3]))).concat(1) as Rgba;
		const behind = (element: Element): Rgba => {
			const layers: Rgba[] = [];
			for (let at: Element | null = element; at; at = at.parentElement) layers.push(rgba(getComputedStyle(at).backgroundColor));
			return layers.reduceRight<Rgba>((under, top) => over(top, under), [255, 255, 255, 1]);
		};
		const luminance = (colour: Rgba): number => {
			const [r, g, b] = colour.slice(0, 3).map((value) => {
				const c = value / 255;
				return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
			});
			return 0.2126 * r + 0.7152 * g + 0.0722 * b;
		};
		const ratio = (a: Rgba, b: Rgba): number => {
			const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
			return (hi + 0.05) / (lo + 0.05);
		};
		const hex = (colour: Rgba) => `#${colour.slice(0, 3).map((value) => value.toString(16).padStart(2, "0")).join("")}`;
		const w = window as any;
		/** The fill a person sees behind an element, as #rrggbb. */
		w.__fill = (element: Element) => hex(behind(element));
		/** A colour (a word's, an edge's) over what is behind the element, as #rrggbb. */
		w.__seen = (element: Element, colour: string) => hex(over(rgba(colour), behind(element)));
		/** A word's contrast against what is behind it. */
		w.__contrast = (element: Element) => { const back = behind(element); return ratio(over(rgba(getComputedStyle(element).color), back), back); };
		/** An edge's contrast against what is behind its element's parent. */
		w.__edgeContrast = (element: Element, colour: string) => { const back = behind(element.parentElement!); return ratio(over(rgba(colour), behind(element)), back); };
		/** A colour's contrast over what is behind an element (a placeholder over its field). */
		w.__colourContrast = (element: Element, colour: string) => { const back = behind(element); return ratio(over(rgba(colour), back), back); };
		/** Whether a colour paints at all. */
		w.__painted = (colour: string) => rgba(colour)[3] > 0;
	});
}

/** Whether each field's edge is the window's red, after its fade: a field a pressed button found empty, also while it has the focus. */
export async function redEdges(fields: Locator): Promise<boolean[]> {
	return fields.evaluateAll(async (all) => {
		await Promise.all(all.flatMap((field) => field.getAnimations().map((fade) => fade.finished.catch(() => {}))));
		return all.map((field) => {
			const probe = document.createElement("i");
			probe.style.color = "var(--error)";
			field.parentElement!.append(probe);
			const red = getComputedStyle(probe).color;
			probe.remove();
			return getComputedStyle(field).borderTopColor === red;
		});
	});
}

/** A target's height for a finger, as `__reach` in the page: its box, or the wider hit area its ::after draws round it
 * (a link in the lead, a count in a status line). */
export async function installReach(page: Page): Promise<void> {
	await page.evaluate(() => {
		(window as any).__reach = (target: Element): number => {
			const after = getComputedStyle(target, "::after");
			const box = target.getBoundingClientRect().height;
			return after.content !== "none" && after.position === "absolute" ? Math.max(box, box - parseFloat(after.top) - parseFloat(after.bottom)) : box;
		};
	});
}

/** Each style rule's selectors that do not start with one of `roots`, read by the browser's own CSS parser. */
export async function rulesOutsideRoots(page: Page, css: string, roots: string[]): Promise<string[]> {
	return page.evaluate(({ text, prefixes }) => {
		const sheet = new CSSStyleSheet();
		sheet.replaceSync(text);
		const splitTop = (selectors: string) => {
			const parts = [""];
			let depth = 0;
			for (const c of selectors) {
				if (c === "(") depth++;
				else if (c === ")") depth--;
				if (depth === 0 && c === ",") parts.push("");
				else parts[parts.length - 1] += c;
			}
			return parts.map((part) => part.trim());
		};
		const outside: string[] = [];
		const walk = (rules: CSSRuleList) => {
			for (const rule of rules) {
				if (rule instanceof CSSStyleRule) {
					for (const selector of splitTop(rule.selectorText)) {
						const prefix = prefixes.find((root) => selector.startsWith(root));
						const rest = prefix === undefined ? null : selector.slice(prefix.length);
						// The class may go on with more of the window's own state (.show-list, :has()), never with another element's name.
						if (rest === null || /^[\w-]/.test(rest)) outside.push(selector);
					}
					if (rule.cssRules.length) walk(rule.cssRules);
				} else if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule) walk(rule.cssRules);
				else outside.push(rule.cssText.slice(0, 60));
			}
		};
		walk(sheet.cssRules);
		return outside;
	}, { text: css, prefixes: roots });
}
