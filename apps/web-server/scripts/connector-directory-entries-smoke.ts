// The connector directory, driven in the page: its line says each entry
// names what it needs, the cards that need more than a click say so in a note,
// adding Atlassian saves the address the catalogue gives and asks for a
// sign-in, the Google guides shown when a person adds Gmail or Drive read word
// for word, and Asana's card opens the custom form filled in for an app of the
// person's own, with the provider's guide one link away. Then a room's
// Connectors pane keeps the way to the Connectors page once nothing is left
// to enable, except on a remote device, where that page adds nothing. At
// phone width a row with a button, an expired sign-in's Reconnect, keeps
// its name and status whole. Nothing here reaches the providers: adding only writes
// the connector's entry, and the expired sign-in is a synthetic one in the
// connector library's own store. Throwaway HOME.
import fs from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { agentDir, assert, baseUrl, openRoom, requestJson, startRoomStateServer, stopRoomStateServer } from "./room-state-setup.js";
import { SMOKE_AUTH_TOKEN } from "./smoke-server-process.js";
import { closeBrowser, closeContext } from "./smoke-close-context.js";
import { CONNECTOR_WORDS } from "../../web-ui/src/connector-rows.js";

{
	const executable = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!executable || !fs.existsSync(executable)) {
		console.log("connector-directory-entries-smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const googleGuide = (api: string) =>
	`Create an OAuth client in Google Cloud (redirect URL http://localhost:19876/callback), select “Use this client for an AI-powered agent” on it, and enable the ${api} MCP API in the same project, then paste the client ID and secret here. Google currently gates tool calls behind its Workspace Developer Preview Program.`;
const ASANA_GUIDE =
	"Asana has no one-click login here. Go to https://app.asana.com/0/my-apps, create an MCP app, add the redirect URL http://localhost:19876/callback under OAuth, choose your workspaces under Manage distribution, and paste its client ID and secret here.";

// Each card that needs more than a click, by its description, with the note under it.
const CARD_NOTES: Array<[string, string]> = [
	["CRM context: contacts, companies, and deals.", "Needs your own HubSpot app; the form walks you through it."],
	["Coordinate tasks, projects, and goals in Asana.", "Needs your own Asana app; the form walks you through it."],
	["Search, read, and organize files in your Drive.", "Needs your own Google Cloud app; the form walks you through it. Only accounts in Google's preview program can use it."],
	["Search threads, draft replies, and manage labels.", "Needs your own Google Cloud app; the form walks you through it. Only accounts in Google's preview program can use it."],
	["Teams, SharePoint, OneDrive, and Outlook (Work IQ, preview).", "Your organisation's Microsoft 365 admin has to set this up first."],
];
const ROOM = "Connector Room";
const ADD_ELSEWHERE = "Not in this list? Add it on the Connectors page first.";

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
	// With no room yet the page opens on its first-run guide, over the sidebar.
	await openRoom(ROOM);
	browser = await chromium.launch({ headless: true });
	const page = await signedIn(browser);
	await page.locator(".product-sidebar-footer button").first().click();
	await page.locator(".sidebar-config-menu button, .sidebar-config-menu a").filter({ hasText: /Settings/ }).first().click();
	await page.locator(".settings-dialog-nav button").filter({ hasText: "Connectors" }).first().click();

	const directory = page.getByLabel("Connector directory", { exact: true });
	await directory.getByText("Apps you can add. Each one says what it needs to connect.", { exact: true }).waitFor({ timeout: 15_000 });
	for (const [description, note] of CARD_NOTES) {
		const shown = await directory.locator(".connector-dir-row").filter({ hasText: description }).locator(".connector-dir-note").allInnerTexts();
		assert(shown.length === 1 && shown[0] === note, `the card "${description}" should say ${JSON.stringify(note)}, got ${JSON.stringify(shown)}`);
	}
	// A card that takes one click carries no note.
	const notionNotes = await directory.locator(".connector-dir-row").filter({ hasText: "Search and update pages and databases in your Notion workspace." }).locator(".connector-dir-note").count();
	assert(notionNotes === 0, `Notion's card should carry no note, got ${notionNotes}`);

	await page.getByRole("button", { name: "Add Atlassian", exact: true }).click();
	await page.getByText(CONNECTOR_WORDS.addedFromDirectory("Atlassian"), { exact: true }).waitFor({ timeout: 15_000 });
	await page.getByLabel("Atlassian is added").waitFor({ timeout: 15_000 });
	const status = await requestJson("/api/mcp/status");
	const atlassian = status.body.servers.find((server: { name: string }) => server.name === "atlassian");
	assert(atlassian?.target === "https://mcp.atlassian.com/v2/mcp", `a new Atlassian connector should use the new address, got ${atlassian?.target}`);

	for (const [name, api] of [["Gmail", "Gmail"], ["Google Drive", "Drive"]]) {
		await page.getByRole("button", { name: CONNECTOR_WORDS.directoryAdd({ name, kind: "oauth-client" }), exact: true }).click();
		await page.locator(".cli-note").filter({ hasText: googleGuide(api) }).waitFor({ timeout: 15_000 });
	}

	const asanaCard = page.locator(".connector-dir-row").filter({ hasText: "Coordinate tasks, projects, and goals in Asana." });
	const asanaKind = await asanaCard.locator(".connector-dir-kind").innerText();
	assert(asanaKind === CONNECTOR_WORDS.directoryTags["oauth-client"], `Asana's card should say it needs setup, got ${asanaKind}`);
	await page.getByRole("button", { name: CONNECTOR_WORDS.directoryAdd({ name: "Asana", kind: "oauth-client" }), exact: true }).click({ timeout: 15_000 });
	const form = page.getByLabel("Custom connector", { exact: true });
	await form.locator(".cli-note").filter({ hasText: ASANA_GUIDE }).waitFor({ timeout: 15_000 });
	const asanaName = await form.getByLabel("Name", { exact: true }).inputValue();
	assert(asanaName === "Asana", `the form should name the connector Asana, got ${asanaName}`);
	const asanaUrl = await form.getByLabel(CONNECTOR_WORDS.form.address, { exact: true }).inputValue();
	assert(asanaUrl === "https://mcp.asana.com/v2/mcp", `the form should hold Asana's current address, got ${asanaUrl}`);
	await form.getByLabel("Client ID", { exact: true }).waitFor({ timeout: 15_000 });
	const guide = await form.getByRole("link", { name: "Setup guide ↗", exact: true }).getAttribute("href");
	assert(guide === "https://developers.asana.com/docs/integrating-with-asanas-mcp-server", `Asana's form should link its setup guide, got ${guide}`);
	// The blank custom form has no provider, so no guide.
	await page.getByRole("button", { name: "Add a custom connector", exact: true }).click();
	const blank = page.getByLabel("Custom connector", { exact: true });
	await blank.getByLabel("Name", { exact: true }).waitFor({ timeout: 15_000 });
	assert((await blank.getByLabel("Name", { exact: true }).inputValue()) === "", "the custom row should open a blank form");
	assert((await blank.getByRole("link").count()) === 0, "the blank custom form should link no guide");
	await page.locator(".settings-dialog-close").first().click();

	// Atlassian is added but not on in the room: the picker's last line leads to the Connectors page.
	let pane = await openRoomConnectors(page);
	await pane.getByRole("button", { name: "Enable connectors", exact: true }).click();
	const picker = pane.locator(".room-skills-picker");
	await picker.getByText(ADD_ELSEWHERE, { exact: true }).waitFor({ timeout: 15_000 });
	await picker.getByRole("button", { name: "Enable", exact: true }).click();
	await picker.getByText("Every configured connector is already enabled.", { exact: true }).waitFor({ timeout: 15_000 });
	assert(await picker.getByRole("button", { name: "Open connectors", exact: true }).isVisible(), "with every connector enabled the picker should still lead to the Connectors page");
	await picker.getByRole("button", { name: "Close connector picker", exact: true }).click();
	// Nothing is left to enable: the pane's header leads there instead of offering nothing.
	await pane.getByRole("button", { name: "Open connectors", exact: true }).click();
	await page.locator(".rs-shell").waitFor({ state: "detached", timeout: 15_000 });
	await page.getByLabel("Connector directory", { exact: true }).waitFor({ timeout: 15_000 });

	// On a remote device the Connectors page adds nothing, so the pane offers no way there.
	const remote = await signedIn(browser, true);
	pane = await openRoomConnectors(remote);
	await pane.locator(".room-skills-row").filter({ hasText: "Atlassian" }).waitFor({ timeout: 15_000 });
	assert((await pane.getByRole("button", { name: "Open connectors", exact: true }).count()) === 0, "a remote device's pane should not lead to the Connectors page");
	await pane.getByRole("button", { name: "Remove", exact: true }).click();
	await pane.getByRole("button", { name: "Enable connectors", exact: true }).click();
	await pane.locator(".room-skills-picker").getByRole("button", { name: "Enable", exact: true }).waitFor({ timeout: 15_000 });
	assert((await pane.getByText(ADD_ELSEWHERE, { exact: true }).count()) === 0, "a remote device's picker should not lead to the Connectors page");
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
