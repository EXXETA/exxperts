// GitHub Copilot's sign-in at a company's own GitHub.
//
// Against a real spawned server, with GitHub stood in for by
// copilot-company-address-preload.mjs (nothing leaves the machine; the sign-ins
// that complete are stand-ins, stored in the smoke's own home):
//
// - a company address typed with the sign-in reaches the runtime's question as
//   the domain: the sign-in starts at that address, written as a full web
//   address or as a bare one; an empty one, or none, still starts at github.com,
//   and so does github.com typed out, as the same sign-in as the empty field;
// - another provider's optional question still gets a blank answer, with an
//   address sent beside it;
// - an address the runtime refuses starts nothing and ends in a plain line;
// - a sign-in that fails at the company's address ends in a plain line, with
//   none of the runtime's words: nothing there or not a GitHub (before the code
//   page), the person declining (after it), and Copilot refusing the account
//   (after it, the one case that names a GitHub admin);
// - the Copilot model list is the account's own: a company sign-in's token
//   names no address, so the list is asked at the sign-in's company address; a
//   personal one's names its own; both show the account's models with the
//   same line under them, and a list that fails shows the whole catalogue and
//   logs its status, with no token;
// - Copilot suggests the first of Claude Sonnet 5.5, Claude Opus 5.5 and
//   GPT-6.1 Sol its list holds, else the list's first; another provider still
//   suggests its own default;
// - in the page, AI setup's Copilot sign-in sends the typed address and shows
//   the failure's line beside the field.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { authedFetch, freePort, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, waitForServer } from "./smoke-server-process.js";
import { closeBrowser } from "./smoke-close-context.js";
import { waitEvery } from "./smoke-wait.js";
import { COMPANY_ADDRESS_REFUSED, COMPANY_SIGN_IN_FAILED, COPILOT_ACCOUNT_MODELS_NOTE } from "../src/provider-auth.js";

const waitUntil = waitEvery(100);

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function pass(label: string): void {
	console.log(`  ok  ${label}`);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-copilot-company-address-"));
const tempHome = path.join(tempRoot, "home");
const agentDir = path.join(tempHome, ".exxperts", "agent");
fs.mkdirSync(tempHome, { recursive: true, mode: 0o700 });
const askedFile = path.join(tempRoot, "asked.txt");
const answersFile = path.join(tempRoot, "answers.txt");
const heldFile = path.join(tempRoot, "held.txt");
const modelsFile = path.join(tempRoot, "models.txt");
const personalFile = path.join(tempRoot, "personal");
const listFile = path.join(tempRoot, "list.json");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const serverOutput: string[] = [];
let server: ChildProcessWithoutNullStreams | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

const lines = (file: string): string[] => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : []);

async function post(pathname: string, body?: unknown): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, {
		method: "POST",
		...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
	});
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** Starts a sign-in and returns its answer with the hosts the stand-in GitHub was asked at for it. */
async function startSignIn(body: Record<string, unknown>): Promise<{ status: number; body: any; asked: string[] }> {
	const before = lines(askedFile).length;
	const started = await post("/api/auth/login", body);
	return { ...started, asked: lines(askedFile).slice(before) };
}

/** Waits until the sign-in in flight has ended, and returns its error line. */
async function endedWith(): Promise<string | null> {
	let state: any = null;
	await waitUntil(async () => {
		state = await (await authedFetch(`${baseUrl}/api/auth/login/status`)).json();
		return state.pending === false;
	}, "the sign-in ends");
	return state.error ?? null;
}

/** Signs in at the stand-in GitHub and waits until the sign-in has ended, stored. */
async function signIn(body: Record<string, unknown>): Promise<void> {
	const started = await post("/api/auth/login", body);
	assert(started.status === 200, `${JSON.stringify(body)} starts, got ${started.status}: ${JSON.stringify(started.body)}`);
	assert((await endedWith()) === null, `${JSON.stringify(body)} completes`);
}

async function signOut(): Promise<void> {
	assert((await post("/api/auth/logout", { provider: "github-copilot" })).status === 200, "the stand-in sign-in is signed out");
}

/** AI setup's Copilot model list, with the hosts the stand-in was asked for the account's list. */
async function copilotCatalog(): Promise<{ body: any; asked: string[] }> {
	const before = lines(modelsFile).length;
	const response = await authedFetch(`${baseUrl}/api/persistent-agent-ai-profiles/model-catalog?provider=github-copilot`);
	assert(response.status === 200, `the Copilot model list answers, got ${response.status}`);
	return { body: await response.json(), asked: lines(modelsFile).slice(before) };
}

const listed = (body: any): string[] => body.models.map((model: { id: string }) => model.id).sort();

const RUNTIME_WORDS = /fetch failed|404|403|Not Found|Forbidden|access_denied|Device flow|Invalid GitHub Enterprise/;

try {
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, {
			PORT: String(port),
			...SMOKE_SERVER_AUTH_ENV,
			EXXPERTS_CODING_AGENT_DIR: agentDir,
			SMOKE_COPILOT_ASKED: askedFile,
			SMOKE_PROMPT_ANSWERS: answersFile,
			SMOKE_COPILOT_HELD: heldFile,
			SMOKE_COPILOT_MODELS: modelsFile,
			SMOKE_COPILOT_PERSONAL: personalFile,
			SMOKE_COPILOT_LIST: listFile,
			// Copilot also signs in from these: the smoke's server holds the stand-in's sign-ins alone.
			COPILOT_GITHUB_TOKEN: undefined,
			GH_TOKEN: undefined,
			GITHUB_TOKEN: undefined,
			NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(path.join(scriptDir, "copilot-company-address-preload.mjs")).href}`.trim(),
		}) as NodeJS.ProcessEnv,
	}) as ChildProcessWithoutNullStreams;
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server, baseUrl, 20000).catch((error: Error) => {
		throw new Error(`${error.message}: ${serverOutput.join("")}`);
	});

	// --- the address reaches the runtime's question -----------------------------
	for (const [typed, host] of [["  https://yourcompany.ghe.com/some/page ", "yourcompany.ghe.com"], ["Example-Co.ghe.com", "example-co.ghe.com"]] as const) {
		const started = await startSignIn({ provider: "github-copilot", companyAddress: typed });
		assert(started.status === 200 && started.body?.url === `https://${host}/login/device`, `"${typed}" starts the sign-in at ${host}, got ${started.status}: ${JSON.stringify(started.body)}`);
		assert(started.asked.length === 1 && started.asked[0] === host, `"${typed}" is asked at ${host} alone, got ${JSON.stringify(started.asked)}`);
		assert((await post("/api/auth/login/cancel")).body?.cancelled === true, "the sign-in in flight is cancelled");
	}
	pass("a typed company address is the domain the sign-in starts at");

	for (const body of [{ provider: "github-copilot", companyAddress: "" }, { provider: "github-copilot", companyAddress: "   " }, { provider: "github-copilot" }]) {
		const started = await startSignIn(body);
		assert(started.status === 200 && started.body?.url === "https://github.com/login/device", `${JSON.stringify(body)} starts at github.com, got ${started.status}: ${JSON.stringify(started.body)}`);
		assert(started.asked.length === 1 && started.asked[0] === "github.com", `${JSON.stringify(body)} is asked at github.com alone, got ${JSON.stringify(started.asked)}`);
		assert((await post("/api/auth/login/cancel")).body?.cancelled === true, "the sign-in in flight is cancelled");
	}
	pass("an empty address, or none, still signs in at github.com");

	{
		// github.com typed out is no company address: the sign-in in flight for the empty field is that same sign-in, and the reverse.
		const empty = await startSignIn({ provider: "github-copilot" });
		assert(empty.status === 200 && empty.body?.url === "https://github.com/login/device", `the empty field starts at github.com, got ${empty.status}: ${JSON.stringify(empty.body)}`);
		for (const typed of ["github.com", " GitHub.com ", "www.github.com", "https://github.com/name"]) {
			const again = await startSignIn({ provider: "github-copilot", companyAddress: typed });
			assert(again.status === 200 && again.body?.url === empty.body.url && again.asked.length === 0, `"${typed}" hands back the empty field's sign-in, got ${again.status}: ${JSON.stringify(again.body)}, asked ${JSON.stringify(again.asked)}`);
		}
		assert((await post("/api/auth/login/cancel")).body?.cancelled === true, "the sign-in in flight is cancelled");
		const typed = await startSignIn({ provider: "github-copilot", companyAddress: "github.com" });
		assert(typed.status === 200 && typed.body?.url === "https://github.com/login/device" && JSON.stringify(typed.asked) === JSON.stringify(["github.com"]), `typed github.com starts at github.com, got ${typed.status}: ${JSON.stringify(typed.body)}, asked ${JSON.stringify(typed.asked)}`);
		const blank = await startSignIn({ provider: "github-copilot", companyAddress: "" });
		assert(blank.status === 200 && blank.body?.url === typed.body.url && blank.asked.length === 0, `the empty field hands back typed github.com's sign-in, got ${blank.status}: ${JSON.stringify(blank.body)}, asked ${JSON.stringify(blank.asked)}`);
		assert((await post("/api/auth/login/cancel")).body?.cancelled === true, "the sign-in in flight is cancelled");
	}
	pass("github.com typed out signs in as the empty field does");

	{
		const first = await startSignIn({ provider: "github-copilot", companyAddress: "yourcompany.ghe.com" });
		assert(first.status === 200 && first.body?.url === "https://yourcompany.ghe.com/login/device", `the first start, got ${first.status}: ${JSON.stringify(first.body)}`);
		const again = await startSignIn({ provider: "github-copilot", companyAddress: "yourcompany.ghe.com" });
		assert(again.status === 200 && again.body?.url === first.body.url && again.asked.length === 0, `the same address again hands back its code page, got ${again.status}: ${JSON.stringify(again.body)}, asked ${JSON.stringify(again.asked)}`);
		const other = await startSignIn({ provider: "github-copilot", companyAddress: "example-co.ghe.com" });
		assert(other.status === 200 && other.body?.url === "https://example-co.ghe.com/login/device" && JSON.stringify(other.asked) === JSON.stringify(["example-co.ghe.com"]), `another address starts again there, got ${other.status}: ${JSON.stringify(other.body)}, asked ${JSON.stringify(other.asked)}`);
		const blank = await startSignIn({ provider: "github-copilot" });
		assert(blank.status === 200 && blank.body?.url === "https://github.com/login/device" && JSON.stringify(blank.asked) === JSON.stringify(["github.com"]), `no address starts again at github.com, got ${blank.status}: ${JSON.stringify(blank.body)}, asked ${JSON.stringify(blank.asked)}`);
		assert((await post("/api/auth/login/cancel")).body?.cancelled === true, "the sign-in in flight is cancelled");
	}
	pass("a Copilot sign-in in flight hands back its code page for the same address, and starts again for another");

	{
		const started = await startSignIn({ provider: "smoke-prompt", companyAddress: "yourcompany.ghe.com" });
		assert(started.status === 200 && started.body?.url === "https://sign-in.invalid/smoke", `another provider's sign-in starts, got ${started.status}: ${JSON.stringify(started.body)}`);
		assert(started.asked.length === 0, `another provider's sign-in asks no GitHub, got ${JSON.stringify(started.asked)}`);
		assert(JSON.stringify(lines(answersFile)) === JSON.stringify(['""']), `another provider's optional question is answered blank, got ${JSON.stringify(lines(answersFile))}`);
		assert((await post("/api/auth/login/cancel")).body?.cancelled === true, "the other provider's sign-in is cancelled");
	}
	pass("another provider's optional question still gets a blank answer");

	// --- failures end in a plain line ----------------------------------------------
	for (const typed of ["your company", "https://"]) {
		const started = await startSignIn({ provider: "github-copilot", companyAddress: typed });
		assert(started.status === 400 && started.body?.error === COMPANY_ADDRESS_REFUSED, `"${typed}" is refused with the plain line, got ${started.status}: ${JSON.stringify(started.body)}`);
		assert(started.asked.length === 0, `a refused address starts no sign-in, got ${JSON.stringify(started.asked)}`);
	}
	pass("an address the runtime refuses starts nothing and reads the plain line");

	for (const host of ["nothing.ghe.com", "notgithub.ghe.com"]) {
		const started = await startSignIn({ provider: "github-copilot", companyAddress: host });
		const line = COMPANY_SIGN_IN_FAILED["not-started"](host);
		assert(started.status !== 200 && started.body?.error === line, `${host} fails with "${line}", got ${started.status}: ${JSON.stringify(started.body)}`);
		assert(started.asked.length === 1 && started.asked[0] === host, `${host} was asked, got ${JSON.stringify(started.asked)}`);
		assert(!RUNTIME_WORDS.test(started.body.error), `no runtime words in "${started.body.error}"`);
		assert((await endedWith()) === line, "the status read says the same line");
	}
	pass("an address with nothing there, or no GitHub there, reads one plain line");

	{
		// The server waits 15 seconds for the code page before it gives up.
		const started = await startSignIn({ provider: "github-copilot", companyAddress: "stall.ghe.com" });
		const line = COMPANY_SIGN_IN_FAILED["not-started"]("stall.ghe.com");
		assert(started.status !== 200 && started.body?.error === line, `an address that never answers fails with "${line}", got ${started.status}: ${JSON.stringify(started.body)}`);
		assert((await endedWith()) === line, "the status read says the same line");
		const next = await startSignIn({ provider: "github-copilot", companyAddress: "yourcompany.ghe.com" });
		assert(next.status === 200 && next.body?.url === "https://yourcompany.ghe.com/login/device", `the next start is not held up by it, got ${next.status}: ${JSON.stringify(next.body)}`);
		assert((await post("/api/auth/login/cancel")).body?.cancelled === true, "the sign-in in flight is cancelled");
	}
	pass("an address that never answers reads the same line, and the next start goes ahead");

	// A refusal while waiting for the person and one from the Copilot token request read the same: nothing tells them apart.
	for (const [host, failure] of [["declined.ghe.com", "unfinished"], ["pollrefused.ghe.com", "refused"], ["refused.ghe.com", "refused"]] as const) {
		const started = await startSignIn({ provider: "github-copilot", companyAddress: host });
		assert(started.status === 200 && started.body?.url === `https://${host}/login/device`, `${host} hands back its code page, got ${started.status}: ${JSON.stringify(started.body)}`);
		const error = await endedWith();
		assert(error === COMPANY_SIGN_IN_FAILED[failure](host), `${host} ends in the ${failure} line, got "${error}"`);
		assert(!RUNTIME_WORDS.test(error ?? ""), `no runtime words in "${error}"`);
	}
	assert(COMPANY_SIGN_IN_FAILED.refused("x").includes("admin") && !COMPANY_SIGN_IN_FAILED.unfinished("x").includes("admin") && !COMPANY_SIGN_IN_FAILED["not-started"]("x").includes("admin"), "only a refusal at the company's address names the admin");
	pass("a sign-in declined, or refused at the company's address, reads its plain line");

	{
		// The person approved the sign-in at one address, then started again at
		// another before Copilot answered the first: the second one is kept.
		const first = await startSignIn({ provider: "github-copilot", companyAddress: "late.ghe.com" });
		assert(first.status === 200, `the first sign-in starts, got ${first.status}: ${JSON.stringify(first.body)}`);
		await waitUntil(() => fs.existsSync(heldFile), "the first sign-in's Copilot token request is on its way");
		const second = await startSignIn({ provider: "github-copilot", companyAddress: "ok.ghe.com" });
		assert(second.status === 200 && second.body?.url === "https://ok.ghe.com/login/device", `the second address starts, got ${second.status}: ${JSON.stringify(second.body)}`);
		assert((await endedWith()) === null, "the second sign-in completes");
		fs.writeFileSync(`${heldFile}.go`, "");
		// The first one's answer arrives; its sign-in was replaced, so it ends unseen.
		await waitUntil(() => fs.existsSync(`${heldFile}.answered`), "the first sign-in's answer arrives");
		const catalog = await authedFetch(`${baseUrl}/api/persistent-agent-ai-profiles/model-catalog?provider=github-copilot`);
		assert(catalog.status === 200, `the Copilot model list answers, got ${catalog.status}`);
		const asked = lines(modelsFile);
		assert(asked.at(-1) === "copilot-api.ok.ghe.com", `the app holds the second address's sign-in, its model list asked ${JSON.stringify(asked)}`);
		await signOut();
	}
	pass("a sign-in replaced by another address does not overwrite the one that replaced it");

	// --- the model list is the account's own ----------------------------------------
	// The stand-in's list, as the app offers it: the catalogue's chat models with no policy or an enabled one.
	const ACCOUNT_MODELS = ["claude-haiku-4.5", "claude-opus-5", "claude-sonnet-5.5", "gpt-5.3-codex", "gpt-6-sol"];
	const whole = await copilotCatalog();
	assert(whole.asked.length === 0 && whole.body.note === undefined && listed(whole.body).length > ACCOUNT_MODELS.length, `signed out, the whole catalogue shows with no line, got ${whole.body.models.length} models, note ${JSON.stringify(whole.body.note)}, asked ${JSON.stringify(whole.asked)}`);
	assert(whole.body.suggested === "claude-sonnet-5.5", `signed out, the whole catalogue suggests Claude Sonnet 5.5, got ${whole.body.suggested}`);

	{
		await signIn({ provider: "github-copilot", companyAddress: "ok.ghe.com" });
		const { body, asked } = await copilotCatalog();
		assert(JSON.stringify(asked) === JSON.stringify(["copilot-api.ok.ghe.com"]), `a company sign-in's list is asked at its company address, got ${JSON.stringify(asked)}`);
		assert(JSON.stringify(listed(body)) === JSON.stringify(ACCOUNT_MODELS), `a company sign-in offers its account's models, got ${JSON.stringify(listed(body))}`);
		assert(body.note === COPILOT_ACCOUNT_MODELS_NOTE, `the line under the list, got ${JSON.stringify(body.note)}`);
		assert(body.models[0].id !== "claude-sonnet-5.5" && body.suggested === "claude-sonnet-5.5", `the list's first is another model, and Claude Sonnet 5.5 is suggested, got first ${body.models[0].id}, suggested ${body.suggested}`);
		assert(body.models.filter((model: any) => model.suggestedDefault).map((model: any) => model.id).join() === "claude-sonnet-5.5", "Claude Sonnet 5.5 alone is marked suggested");
	}
	pass("a company sign-in, whose token names no address, offers its account's models with the line, and suggests Claude Sonnet 5.5");

	{
		// Still signed in at ok.ghe.com: each list below is the account's whole list.
		for (const [list, expected] of [
			[["claude-haiku-4.5", "claude-opus-5.5", "gpt-6.1-sol"], "claude-opus-5.5"],
			[["claude-haiku-4.5", "gpt-6-sol", "gpt-6.1-sol"], "gpt-6.1-sol"],
			[["claude-haiku-4.5", "gpt-5.4", "gpt-6-sol"], "claude-haiku-4.5"],
		] as const) {
			fs.writeFileSync(listFile, JSON.stringify(list));
			const { body } = await copilotCatalog();
			assert(JSON.stringify(listed(body)) === JSON.stringify([...list].sort()), `the account's list is ${JSON.stringify(list)}, got ${JSON.stringify(listed(body))}`);
			assert(body.suggested === expected, `a list of ${JSON.stringify(list)} suggests ${expected}, got ${body.suggested}`);
		}
		fs.rmSync(listFile);
		await signOut();
	}
	pass("without Claude Sonnet 5.5, Copilot suggests Claude Opus 5.5, then GPT-6.1 Sol, then the list's first");

	{
		const response = await authedFetch(`${baseUrl}/api/persistent-agent-ai-profiles/model-catalog?provider=openai`);
		const body = await response.json();
		assert(response.status === 200 && body.suggested === "gpt-5.4", `OpenAI still suggests its own default, got ${response.status} ${body.suggested}`);
	}
	pass("another provider still suggests its own default");

	{
		fs.writeFileSync(personalFile, "");
		await signIn({ provider: "github-copilot" });
		fs.rmSync(personalFile);
		const { body, asked } = await copilotCatalog();
		assert(JSON.stringify(asked) === JSON.stringify(["api.individual.smoke.invalid"]), `a personal sign-in's list is asked at its token's address, got ${JSON.stringify(asked)}`);
		assert(JSON.stringify(listed(body)) === JSON.stringify(ACCOUNT_MODELS), `a personal sign-in offers its account's models, got ${JSON.stringify(listed(body))}`);
		assert(body.note === COPILOT_ACCOUNT_MODELS_NOTE, `the line under the list, got ${JSON.stringify(body.note)}`);
		await signOut();
	}
	pass("a personal sign-in offers its account's models with the same line");

	{
		await signIn({ provider: "github-copilot", companyAddress: "listfails.ghe.com" });
		const outputBefore = serverOutput.join("").length;
		const { body, asked } = await copilotCatalog();
		assert(JSON.stringify(asked) === JSON.stringify(["copilot-api.listfails.ghe.com"]), `the failing list was asked at its company address, got ${JSON.stringify(asked)}`);
		assert(JSON.stringify(listed(body)) === JSON.stringify(listed(whole.body)) && body.note === undefined, `a failed list shows the whole catalogue with no line, got ${body.models.length} models, note ${JSON.stringify(body.note)}`);
		assert(body.suggested === "claude-sonnet-5.5", `a failed list suggests Claude Sonnet 5.5, got ${body.suggested}`);
		const logged = () => serverOutput.join("").slice(outputBefore).split("\n").filter((line) => line.includes("provider call failed"));
		await waitUntil(() => logged().length > 0, "the failed list is logged");
		const [line, ...more] = logged();
		const fields = JSON.parse(line);
		assert(more.length === 0 && fields.callKind === "model-list" && fields.provider === "github-copilot" && fields.status === 503, `one log line with the provider and the status, got ${JSON.stringify(logged())}`);
		assert(!/tid=|smoke-github-token|bearer|authorization/i.test(line), `no token and no header in the log line, got ${JSON.stringify(line)}`);
		// Signed out again, so the page below finds Copilot's Sign in.
		await signOut();
	}
	pass("a list that fails shows the whole catalogue, with one log line and no token in it");

	// --- the page ---------------------------------------------------------------------
	const chromiumPath = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!chromiumPath || !fs.existsSync(chromiumPath)) {
		console.log("  skip AI setup's Copilot sign-in in the page (Chromium not installed)");
	} else {
		browser = await chromium.launch();
		const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
		await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await page.waitForLoadState("networkidle");
		const dismiss = page.locator(".whats-new-close");
		if (await dismiss.count()) await dismiss.click();
		// With no room yet the page opens on its first-run guide, over the sidebar.
		const guide = page.getByRole("dialog", { name: "How exxperts works" });
		if (await guide.count()) {
			await guide.getByRole("button", { name: "Close" }).click();
			await guide.waitFor({ state: "detached" });
		}
		await page.locator(".product-sidebar-footer button").first().click();
		await page.locator(".sidebar-config-menu button, .sidebar-config-menu a").filter({ hasText: /Settings/ }).first().click();
		await page.waitForSelector(".settings-overlay", { timeout: 10_000 });
		await page.locator(".settings-dialog-nav button").filter({ hasText: "AI setup" }).first().click();
		await page.locator(".add-provider-toggle").click();
		const row = page.locator(".add-provider-row-group").filter({ has: page.locator(".settings-row-label", { hasText: /^GitHub Copilot$/ }) });
		await row.getByRole("button", { name: "Sign in", exact: true }).click();
		const field = row.getByLabel("GitHub address", { exact: true });
		await field.fill("nothing.ghe.com");
		const before = lines(askedFile).length;
		await row.locator(".copilot-signin-form").getByRole("button", { name: "Sign in", exact: true }).click();
		const alert = row.locator(".copilot-signin-form [role=alert]");
		await alert.waitFor({ timeout: 10_000 });
		const shown = (await alert.innerText()).trim();
		assert(shown === COMPANY_SIGN_IN_FAILED["not-started"]("nothing.ghe.com"), `the line beside the field reads the plain line, got "${shown}"`);
		assert(JSON.stringify(lines(askedFile).slice(before)) === JSON.stringify(["nothing.ghe.com"]), `the page sent the typed address, got ${JSON.stringify(lines(askedFile).slice(before))}`);
		assert(await page.locator(".add-provider-block > .checkpoint-proposal-error").count() === 0, "the line shows beside the field, not again above the list");
		assert(await field.inputValue() === "nothing.ghe.com", "the typed address stays in the field to correct");
		pass("in the page, the typed address is sent and its failure reads beside the field");

		// Cancel while the start is still on its way: the late answer opens nothing.
		const opened: string[] = [];
		page.context().on("page", (popup) => opened.push(popup.url()));
		await field.fill("slow.ghe.com");
		const startAnswered = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/auth/login", { timeout: 20_000 });
		// A failed assertion before it is awaited closes the browser under it: that is not the failure to report.
		startAnswered.catch(() => {});
		await row.locator(".copilot-signin-form").getByRole("button", { name: "Sign in", exact: true }).click();
		assert(await row.locator(".copilot-signin-form").count() === 0, "the form steps aside while the sign-in starts: no field to change, no second Sign in");
		await row.getByRole("button", { name: "Cancel", exact: true }).click();
		await startAnswered;
		await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
		assert(opened.length === 0, `a start cancelled on its way opens no page, got ${JSON.stringify(opened)}`);
		assert(await row.locator(".add-provider-instructions").count() === 0, "a start cancelled on its way shows no code");
		assert(await row.getByRole("button", { name: "Cancel", exact: true }).count() === 1 && (await field.inputValue()) === "slow.ghe.com", "the form is back with its address, ready for another try");
		pass("in the page, a sign-in cancelled while it starts opens nothing");

		{
			// A company profile saved while the whole catalogue showed keeps a Memory model the account can't use.
			await page.context().close();
			await signIn({ provider: "github-copilot", companyAddress: "ok.ghe.com" });
			const saved = await authedFetch(`${baseUrl}/api/persistent-agent-ai-profiles/custom`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerId: "github-copilot", roomModels: ["gpt-5.4"], learnModel: "gpt-5.4" }) });
			assert(saved.status === 200, `the earlier profile is saved, got ${saved.status}`);
			const memoryModel = async (): Promise<string | undefined> => {
				const status = await (await authedFetch(`${baseUrl}/api/persistent-agent-ai-profile`)).json();
				const profile = status.profiles.find((entry: any) => entry.kind === "custom" && entry.provider.id === "github-copilot");
				return profile?.requiredModels.find((model: any) => String(model.purpose ?? "").split("/").includes("absorb"))?.model;
			};
			assert((await memoryModel()) === "gpt-5.4", "the earlier profile's Memory model is gpt-5.4");
			const edit = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
			await edit.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
			await edit.waitForLoadState("networkidle");
			const whatsNew = edit.locator(".whats-new-close");
			if (await whatsNew.count()) await whatsNew.click();
			const firstRun = edit.getByRole("dialog", { name: "How exxperts works" });
			if (await firstRun.count()) {
				await firstRun.getByRole("button", { name: "Close" }).click();
				await firstRun.waitFor({ state: "detached" });
			}
			await edit.locator(".product-sidebar-footer button").first().click();
			await edit.locator(".sidebar-config-menu button, .sidebar-config-menu a").filter({ hasText: /Settings/ }).first().click();
			await edit.waitForSelector(".settings-overlay", { timeout: 10_000 });
			await edit.locator(".settings-dialog-nav button").filter({ hasText: "AI setup" }).first().click();
			await edit.locator(".ai-profile-menu-btn[aria-label^='Manage github-copilot']").first().click();
			await edit.getByRole("menuitem", { name: "Approve models" }).click();
			const dialog = edit.getByRole("dialog", { name: /^Configure .* models$/ });
			const memory = dialog.getByLabel("Memory model", { exact: true });
			await memory.waitFor({ timeout: 20_000 });
			const shown = await memory.inputValue();
			assert(shown === "claude-sonnet-5.5", `the Memory model shown is the suggested Claude Sonnet 5.5, got ${JSON.stringify(shown)}`);
			await dialog.getByRole("group", { name: "Room models" }).getByRole("checkbox").first().check();
			await dialog.getByRole("button", { name: "Save profile" }).click();
			await dialog.waitFor({ state: "detached", timeout: 10_000 });
			assert((await memoryModel()) === shown, `the Memory model saved is the one shown, ${shown}, got ${await memoryModel()}`);
			await edit.context().close();
		}
		pass("in the page, editing a profile whose Memory model the account can't use saves the one shown");
	}

	console.log("copilot company address smoke passed");
} finally {
	if (browser) await closeBrowser(browser);
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
