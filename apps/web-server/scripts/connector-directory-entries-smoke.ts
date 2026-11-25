// The connector directory, driven in the page: its line says each entry
// names what it needs, it offers only apps added with a click, a sign-in or a
// key (none that needs the person's own sign-in app or an admin's setup, and
// a search finds none of those), and adding Atlassian saves the address the
// catalogue gives and asks for a sign-in. A HubSpot connector already in the
// connector file keeps its name, icon, description and sign-in state, and now
// reads as a custom one, since the directory can't add it back: its address
// shows and can change, and Remove says the address is needed again. Then a room's
// Connectors pane keeps the way to the Connectors page once nothing is left
// to enable, except on a remote device, where that page adds nothing. At
// phone width a row with a button, an expired sign-in's Reconnect, keeps
// its name and status whole. Nothing here reaches the providers: adding only writes
// the connector's entry, and the expired sign-in is a synthetic one in the
// connector library's own store. Throwaway HOME.
import fs from "node:fs";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { agentDir, assert, baseUrl, openRoom, requestJson, startRoomStateServer, stopRoomStateServer } from "./room-state-setup.js";
import { SMOKE_AUTH_TOKEN } from "./smoke-server-process.js";
import { closeBrowser, closeContext } from "./smoke-close-context.js";
import { CONNECTOR_WORDS } from "../../web-ui/src/connector-rows.js";
import { CONNECTOR_ICONS } from "../../web-ui/src/connector-icons.js";

{
	const executable = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!executable || !fs.existsSync(executable)) {
		console.log("connector-directory-entries-smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

// The directory's rows, in order.
const OFFERED = ["GitHub", "Notion", "Atlassian", "Linear", "Context7", "Hugging Face", "DeepWiki", "Canva", "Sentry", "Stripe", "Cloudflare Docs"];
const ROOM = "Connector Room";

/** A signed-in page on Home; with `remote`, the page takes itself for a remote device. */
async function signedIn(browser: Browser, remote = false, phone = false): Promise<Page> {
	const context = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width: 1280, height: 900 } });
	if (remote) await context.route("**/api/remote/client-context", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ remote: true, capability: "full", sharedServer: false }) }));
	const page = await context.newPage();
	await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
	await page.waitForLoadState("networkidle");
	if (await page.locator(".whats-new-close").count()) await page.locator(".whats-new-close").click();
	return page;
}

async function openRoomConnectors(page: Page) {
	await page.locator(".persistent-agent-card").filter({ hasText: ROOM }).locator(".card-gear-btn").click();
	await page.locator(".settings-dialog-nav-item").filter({ hasText: /^Connectors$/ }).first().click();
	const pane = page.locator(".room-connectors-section");
	await pane.waitFor({ timeout: 15_000 });
	await pane.getByText("Loading connectors…").waitFor({ state: "detached", timeout: 15_000 });
	return pane;
}

let browser: Browser | null = null;
let failure: unknown;
try {
	await startRoomStateServer();
	// Added from the directory's old HubSpot card, which filled in the custom form with the person's own sign-in app.
	const hubspot = await requestJson("/api/mcp/servers", { method: "POST", body: JSON.stringify({ name: "HubSpot", url: "https://mcp.hubspot.com", oauth: { clientId: "synthetic-client", clientSecret: "synthetic-secret" } }) });
	assert(hubspot.status === 200 || hubspot.status === 201, `hubspot should add, got ${hubspot.status} ${JSON.stringify(hubspot.body)}`);
	// With no room yet the page opens on its first-run guide, over the sidebar.
	await openRoom(ROOM);
	browser = await chromium.launch({ headless: true });
	const page = await signedIn(browser);
	await page.locator(".product-sidebar-footer button").first().click();
	await page.locator(".sidebar-config-menu button, .sidebar-config-menu a").filter({ hasText: /Settings/ }).first().click();
	await page.locator(".settings-dialog-nav button").filter({ hasText: "Connectors" }).first().click();

	const directory = page.getByLabel("Connector directory", { exact: true });
	await directory.getByText("Apps you can add. Each one says what it needs to connect.", { exact: true }).waitFor({ timeout: 15_000 });
	const rowNames = () => directory.locator(".connector-dir-row .settings-row-label").evaluateAll((els) => els.map((el) => el.firstChild?.textContent ?? ""));
	const listed = await rowNames();
	assert(JSON.stringify(listed) === JSON.stringify(OFFERED), `the directory should offer ${JSON.stringify(OFFERED)}, got ${JSON.stringify(listed)}`);
	assert((await directory.getByText("Needs setup").count()) === 0, "no card should say it needs setup");
	assert((await directory.locator(".connector-dir-note").count()) === 0, "no card should carry a note");
	// A search finds none of the apps that left it: the ordinary no-results line.
	const search = directory.getByLabel("Search connectors", { exact: true });
	await search.fill("gmail");
	await directory.getByText(CONNECTOR_WORDS.directoryNoMatch, { exact: true }).waitFor({ timeout: 15_000 });
	const found = await rowNames();
	assert(found.length === 0, `searching gmail should find nothing, got ${JSON.stringify(found)}`);
	await search.fill("");
	await directory.getByRole("button", { name: "Add Notion", exact: true }).waitFor({ timeout: 15_000 });

	// The HubSpot connector added before keeps its name and icon, waiting for its sign-in, and is now a custom one.
	const list = page.getByLabel(CONNECTOR_WORDS.listTitle, { exact: true });
	const hubspotRow = list.locator(".connector-item").filter({ has: page.locator(".connector-item-name-text", { hasText: /^HubSpot$/ }) });
	await hubspotRow.getByRole("button", { name: CONNECTOR_WORDS.button.connect, exact: true }).waitFor({ timeout: 15_000 });
	const glyph = await hubspotRow.locator(".connector-avatar path").getAttribute("d");
	assert(glyph === CONNECTOR_ICONS.hubspot, `the HubSpot connector should keep its icon, got ${glyph?.slice(0, 20)}`);
	const tags = await hubspotRow.locator(".connector-dir-kind").allInnerTexts();
	assert(JSON.stringify(tags) === JSON.stringify([CONNECTOR_WORDS.tagCustom]), `the HubSpot connector should be tagged custom, got ${JSON.stringify(tags)}`);
	assert((await hubspotRow.locator(".connector-item-status").innerText()) === `${CONNECTOR_WORDS.status.notConnected} · ${CONNECTOR_WORDS.roomsInLine(0)}`, "the HubSpot connector should wait for its sign-in, with how many rooms it is on in");
	// Its own page is HubSpot's, by name and icon (its description stays in the Directory), and shows its address with
	// Change address, and Remove says the address is needed again.
	await hubspotRow.locator(".connector-item-hit").click();
	const hubspotPage = page.locator(".connector-page");
	await hubspotPage.locator(".connector-page-head h2").getByText("HubSpot", { exact: true }).waitFor({ timeout: 15_000 });
	const pageGlyph = await hubspotPage.locator(".connector-page-head .connector-avatar path").getAttribute("d");
	assert(pageGlyph === CONNECTOR_ICONS.hubspot, `the HubSpot connector's page should show its icon, got ${pageGlyph?.slice(0, 20)}`);
	const address = hubspotPage.locator(".connector-fact").filter({ has: page.locator(".settings-row-label", { hasText: new RegExp(`^${CONNECTOR_WORDS.details.address}$`) }) });
	await address.getByText("https://mcp.hubspot.com", { exact: true }).waitFor({ timeout: 15_000 });
	assert((await address.getByRole("button", { name: CONNECTOR_WORDS.button.changeAddress, exact: true }).count()) === 1, "the HubSpot connector's address should offer Change address");
	await hubspotPage.locator(".connector-remove-group").getByRole("button", { name: CONNECTOR_WORDS.button.remove, exact: true }).click();
	const dialog = page.locator(".confirm-dialog-backdrop");
	const ask = [await dialog.locator("h2").innerText(), await dialog.locator("p").innerText()];
	const expectedAsk = [CONNECTOR_WORDS.removeQuestion("HubSpot"), CONNECTOR_WORDS.removeCustomUnused];
	assert(JSON.stringify(ask) === JSON.stringify(expectedAsk), `removing HubSpot should ask ${JSON.stringify(expectedAsk)}, got ${JSON.stringify(ask)}`);
	await dialog.getByRole("button", { name: CONNECTOR_WORDS.button.remove, exact: true }).click();
	await hubspotPage.waitFor({ state: "detached", timeout: 15_000 });
	await list.getByText(CONNECTOR_WORDS.noneYet, { exact: false }).waitFor({ timeout: 15_000 });
	const afterRemove = await requestJson("/api/mcp/status");
	assert(!afterRemove.body.servers.some((server: { name: string }) => server.name === "hubspot"), "the HubSpot connector should be removed");

	// Add goes on to Atlassian's sign-in at once; the sign-in is answered here, so nothing reaches the service.
	const signInsAsked: string[] = [];
	await page.route("**/api/mcp/servers/*/login", (route) => {
		const method = route.request().method();
		signInsAsked.push(`${method} ${new URL(route.request().url()).pathname}`);
		return route.fulfill({ json: method === "POST" ? { started: true } : method === "DELETE" ? { cancelled: true } : { pending: true } });
	});
	await page.getByRole("button", { name: "Add Atlassian", exact: true }).click();
	await page.locator(".connector-item").filter({ hasText: "Atlassian" }).locator(".connector-item-status").getByText(`${CONNECTOR_WORDS.status.signingIn} · ${CONNECTOR_WORDS.roomsInLine(0)}`, { exact: true }).waitFor({ timeout: 15_000 });
	assert(signInsAsked.filter((one) => one === "POST /api/mcp/servers/atlassian/login").length === 1, `adding Atlassian should ask for its sign-in once, got ${JSON.stringify(signInsAsked)}`);
	await page.getByLabel("Atlassian is added").waitFor({ timeout: 15_000 });
	const status = await requestJson("/api/mcp/status");
	const atlassian = status.body.servers.find((server: { name: string }) => server.name === "atlassian");
	assert(atlassian?.target === "https://mcp.atlassian.com/v2/mcp", `a new Atlassian connector should use the new address, got ${atlassian?.target}`);

	// The web address form, from the Add connector menu, links no guide.
	await page.locator(".pane-head-actions").getByRole("button", { name: CONNECTOR_WORDS.addConnector, exact: true }).click();
	await page.getByRole("menuitem", { name: CONNECTOR_WORDS.addWays.web, exact: true }).click();
	const blank = page.getByLabel(CONNECTOR_WORDS.form.webTitle, { exact: true });
	await blank.getByLabel("Name", { exact: true }).waitFor({ timeout: 15_000 });
	assert((await blank.getByLabel("Name", { exact: true }).inputValue()) === "", "By web address should open a blank form");
	assert((await blank.getByRole("link").count()) === 0, "the web address form should link no guide");
	await page.locator(".settings-dialog-close").first().click();

	// Atlassian is added but not on in the room: its row is there, off, and the pane's lead links to the Connectors page.
	let pane = await openRoomConnectors(page);
	const atlassianRow = (on: Locator) => on.locator(".room-skills-row").filter({ hasText: "Atlassian" });
	await atlassianRow(pane).locator("input[role=switch]:not(:checked)").waitFor({ timeout: 15_000 });
	assert(await pane.locator(".pane-lead").getByRole("button", { name: CONNECTOR_WORDS.room.manage, exact: true }).isVisible(), "with a connector off the pane should lead to the Connectors page");
	await pane.getByRole("switch", { name: "Atlassian", exact: true }).click();
	await atlassianRow(pane).locator("input[role=switch]:checked:enabled").waitFor({ timeout: 15_000 });
	// Every connector on, the pane's lead still links there.
	await pane.locator(".pane-lead").getByRole("button", { name: CONNECTOR_WORDS.room.manage, exact: true }).click();
	await page.locator(".rs-shell").waitFor({ state: "detached", timeout: 15_000 });
	await page.getByLabel("Connector directory", { exact: true }).waitFor({ timeout: 15_000 });

	// On a remote device the Connectors page adds nothing, so the pane offers no way there; its switch still turns a connector off and on.
	const remote = await signedIn(browser, true);
	pane = await openRoomConnectors(remote);
	await atlassianRow(pane).waitFor({ timeout: 15_000 });
	assert((await pane.getByRole("button", { name: CONNECTOR_WORDS.room.manage, exact: true }).count()) === 0, "a remote device's pane should not lead to the Connectors page");
	await pane.getByRole("switch", { name: "Atlassian", exact: true }).click();
	await atlassianRow(pane).locator("input[role=switch]:not(:checked):enabled").waitFor({ timeout: 15_000 });
	assert((await pane.getByRole("button", { name: CONNECTOR_WORDS.room.manage, exact: true }).count()) === 0, "with a connector off a remote device's pane should still not lead to the Connectors page");
	await closeContext(remote.context());

	// Notion's sign-in expired with nothing to renew it: its row offers Reconnect.
	const notionUrl = "https://mcp.notion.com/mcp";
	const added = await requestJson("/api/mcp/servers", { method: "POST", body: JSON.stringify({ name: "notion", url: notionUrl }) });
	assert(added.status === 200 || added.status === 201, `notion should add, got ${added.status} ${JSON.stringify(added.body)}`);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const authStore = await import("pi-mcp-adapter/mcp-auth.ts" as string);
	authStore.updateTokens("notion", { accessToken: "synthetic-expired", expiresAt: Math.floor(Date.now() / 1000) - 3600 }, notionUrl);
	const phone = await signedIn(browser, false, true);
	await phone.locator(".product-sidebar-footer button, .home-gear, button[aria-label='Settings']").first().click();
	await phone.locator(".sidebar-config-menu button, .sidebar-config-menu a").filter({ hasText: /Settings/ }).first().click();
	await phone.locator(".settings-dialog-nav-item").filter({ hasText: /^Connectors$/ }).first().click();
	const row = (name: string) => phone.locator(".connector-item").filter({ has: phone.locator(".connector-item-name-text", { hasText: new RegExp(`^${name}$`) }) });
	await row("Notion").getByRole("button", { name: CONNECTOR_WORDS.button.reconnect, exact: true }).waitFor({ timeout: 15_000 });
	for (const name of ["Atlassian", "Notion"]) {
		const cells = await row(name).locator(".connector-item-name-text, .connector-item-status")
			.evaluateAll((els) => els.map((el) => ({ text: el.textContent, cut: el.scrollWidth > el.clientWidth })));
		assert(cells.length === 2 && cells.every((cell) => !cell.cut), `at phone width ${name}'s name and status should show whole, got ${JSON.stringify(cells)}`);
	}
	await closeContext(phone.context());

	console.log("connector-directory-entries-smoke: OK");
} catch (error) {
	failure = error;
} finally {
	if (browser) await closeBrowser(browser);
	await stopRoomStateServer(failure);
}
if (failure) throw failure;
