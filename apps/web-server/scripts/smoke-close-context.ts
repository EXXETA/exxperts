// How a browser smoke closes its pages. Not a smoke itself: the smokes import it.
import type { Browser, BrowserContext } from "playwright";

/**
 * The one way a smoke closes a browser context. Its route handlers stop first, the pages' and the context's own:
 * a handler still awaiting route.fetch() when the context goes would throw (the request context disposed, the
 * page closed), and that error would end the smoke in place of the check that failed.
 */
export async function closeContext(context: BrowserContext): Promise<void> {
	for (const page of context.pages()) await page.unrouteAll({ behavior: "ignoreErrors" });
	await context.unrouteAll({ behavior: "ignoreErrors" });
	await context.close();
}

/** For a smoke's outer finally: every context still open closes through closeContext, then the browser. */
export async function closeBrowser(browser: Browser): Promise<void> {
	try {
		for (const context of browser.contexts()) await closeContext(context);
	} finally {
		await browser.close();
	}
}
