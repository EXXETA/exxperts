// The condition wait the smokes share: poll a predicate until it holds, or
// throw "timed out waiting until <label>" once the deadline has passed. Each
// smoke fixes its poll once, as `const waitUntil = waitEvery(150)`, and its
// default deadline with a second argument when 25 s does not fit it
// (`waitEvery(100, 15_000)`); a call can still give its own deadline.
import type { Page } from "playwright";

export type WaitCondition = () => Promise<boolean> | boolean;
export type WaitUntil = (predicate: WaitCondition, label: string, timeoutMs?: number) => Promise<void>;

export function waitEvery(pollMs: number, defaultTimeoutMs = 25_000): WaitUntil {
	return async (predicate, label, timeoutMs = defaultTimeoutMs) => {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (await predicate()) return;
			await new Promise((resolve) => setTimeout(resolve, pollMs));
		}
		throw new Error(`timed out waiting until ${label}`);
	};
}

// Sends what is in the box the way a person does: Enter, once Send is lit.
// Enter does nothing while Send is grey, and only Send knows: a room's first
// socket can be ready and replaced, and a model switch can still be settling,
// with every other sign of a ready room already on screen. Call this with the
// text in the box: on an empty box, a running answer's Stop passes the wait.
export async function sendFromBox(page: Page): Promise<void> {
	await page.locator(".send-btn:enabled").first().waitFor({ timeout: 15000 });
	await page.locator("textarea").first().press("Enter");
}
