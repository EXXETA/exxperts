// The ways on of every memory screen that stops on its Memory model, pinned
// as a table: the first read's notice, Memorize's card (its stop note and its
// paused row), Review's card (the same two) and Review's saved screen. For
// each cause (a spent quota, a key or sign-in that is gone, a gateway's 403,
// a model not reached, a busy one, one not on the account, a restart, the
// same failure twice) the table holds the buttons in order, which one leads,
// what each button calls, and the buttons left after it. The same table holds
// on this computer and on a paired phone; on a shared server only a gateway's
// 403 differs, as the chat's line does. Each context runs in its own process,
// as the page reads its context once.
//
// Offline: no server, no provider, no network, no port.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CONTEXTS = {
	computer: { remote: false, capability: "full", sharedServer: false },
	phone: { remote: true, capability: "full", sharedServer: false },
	shared: { remote: false, capability: "full", sharedServer: true },
} as const;
type ContextName = keyof typeof CONTEXTS;

const contextName = process.env.MEMORY_WAYS_ON_CONTEXT as ContextName | undefined;

if (!contextName) {
	const failed: string[] = [];
	for (const name of Object.keys(CONTEXTS) as ContextName[]) {
		const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], { env: { ...process.env, MEMORY_WAYS_ON_CONTEXT: name }, encoding: "utf8" });
		process.stdout.write(child.stdout ?? "");
		process.stderr.write(child.stderr ?? "");
		if (child.status !== 0) failed.push(name);
	}
	if (failed.length) {
		console.error(`memory ways-on smoke failed in: ${failed.join(", ")}`);
		process.exit(1);
	}
	console.log("memory ways-on smoke passed");
	process.exit(0);
}

const context = CONTEXTS[contextName];
const { JSDOM } = await import("jsdom");
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
const globals = globalThis as any;
globals.window = dom.window;
globals.document = dom.window.document;
// Node 21 and later have a global navigator, which React reads once a window exists; Node 20, which CI runs, has none.
if (!("navigator" in globalThis)) globals.navigator = dom.window.navigator;
globalThis.fetch = (async () => new Response(JSON.stringify(context), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

const pageRequire = (await import("node:module")).createRequire(new URL("../../web-ui/package.json", import.meta.url));
const { createElement } = pageRequire("react");
globals.React = pageRequire("react");
globals.IS_REACT_ACT_ENVIRONMENT = false;
const { createRoot } = pageRequire("react-dom/client");
const remoteContext: any = await import(new URL("../../web-ui/src/remote-client-context.ts", import.meta.url).href);
await remoteContext.fetchRemoteClientContext();
const notice: any = await import(new URL("../../web-ui/src/components/model-notice.tsx", import.meta.url).href);
const memorize: any = await import(new URL("../../web-ui/src/components/absorb-run-screen.tsx", import.meta.url).href);
const review: any = await import(new URL("../../web-ui/src/components/review-screen.tsx", import.meta.url).href);

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const MODEL = { provider: "acme-gw", model: "acme-model" };
const PASSED = new Date(Date.now() - 5 * 60_000).toISOString();

/** Each cause as a card's stop carries it, and as the first read's notice carries it. */
const CAUSES: Record<string, { stop: Record<string, unknown>; detail?: string; notice?: Record<string, unknown> }> = {
	"quota-key": { stop: { cause: "quota", quotaWay: { kind: "key", provider: "OpenAI" } }, detail: "quota" },
	"quota-plan-unknown-reset": { stop: { cause: "quota", quotaWay: { kind: "sign-in", provider: "ChatGPT" } }, detail: "quota" },
	"quota-plan-reset-passed": { stop: { cause: "quota", quotaWay: { kind: "sign-in", provider: "ChatGPT", resetsAt: PASSED } }, detail: "quota" },
	"quota-gateway": { stop: { cause: "quota", quotaWay: { kind: "gateway", provider: "Acme Gateway" }, gateway: "Acme Gateway" }, detail: "quota" },
	"key-refused": { stop: { cause: "signed-out", key: "refused" }, detail: "signed-out" },
	"key-missing": { stop: { cause: "signed-out", key: "missing" }, detail: "signed-out" },
	"signed-out": { stop: { cause: "signed-out" }, detail: "signed-out" },
	"gateway-403": { stop: { cause: "gateway-refused", key: "refused", gateway: "Acme Gateway" }, detail: "gateway-refused" },
	"not-reached": { stop: { cause: "not-answering", unreached: "connection" }, detail: "not-answering" },
	"busy": { stop: { cause: "busy" }, detail: "still-busy" },
	"not-on-account": { stop: { cause: "not-on-account" }, detail: "not-on-account" },
	"restarted": { stop: { cause: "restarted" } },
	"repeated": { stop: { cause: "repeated" } },
};

function stopOf(name: string): Record<string, unknown> {
	const { stop } = CAUSES[name];
	const kind = stop.cause === "restarted" ? "restart" : stop.cause === "repeated" ? "failing" : "outage";
	return { kind, model: MODEL, ...stop };
}

const session = (id: string, outcome: string) => ({ id, title: `Call ${id}`, date: "2026-09-12", outcome, attempts: 1, ...(outcome === "folded" ? { summary: { added: 1, updated: 0, superseded: 0, closed: 0 } } : {}) });
const budget = { before: 1_000, after: 1_200, budgetTokens: 20_000, savedBudgetTokens: 20_000, overBudgetAfter: false, ceilingTokens: 80_000 };
const demotion = { entries: [], keepIds: [], keepTopics: [], overageTokens: 0, protectedOpenItems: 0, counts: { leaving: 0, kept: 0, instead: 0 } };
const absorbRun = (stop: unknown, nothingRead: boolean) => ({
	runId: "a1", agentId: "room-1", state: "ready", startedAt: "2026-09-14T09:00:00.000Z", updatedAt: "2026-09-14T09:00:00.000Z",
	progress: { folded: nothingRead ? 0 : 1, total: 2 },
	sessions: nothingRead ? [session("RC-0001", "pending"), session("RC-0002", "pending")] : [session("RC-0001", "folded"), session("RC-0002", "pending")],
	prepass: { demoted: [] }, budget, demotion, candidate: null, guidance: null, migration: null, warnings: [], stop,
});
const change = { id: "m-0031", section: "Deep Memory", topic: "Hiring", kind: "shortened", before: "- The long note about hiring.", after: "- Hiring note." };
const reviewRun = (stop: unknown, nothingTidied: boolean) => ({
	runId: "r1", agentId: "room-1", state: "ready", depth: "tidy", startedAt: "2026-09-14T09:00:00.000Z", updatedAt: "2026-09-14T09:00:00.000Z",
	progress: { group: 2, groups: 2 }, topics: ["Hiring", "Payments"], changes: nothingTidied ? [] : [change],
	leftAsIs: [{ topics: ["Payments"], reason: "The Memory model could not be reached, so these notes were not tidied." }],
	budget, demotion, candidate: null, guidance: null, migration: null, warnings: [], stop,
});
const noneCounts = { tidied: 0, leaving: 0, notes: 0, topics: 0, shortened: 0, merged: 0, archived: 0, closed: 0, moved: 0, rewritten: 0 };
const someCounts = { ...noneCounts, tidied: 1, notes: 1, topics: 1, shortened: 1 };

/** One place a cause is shown, with the handlers it is given. */
type Place = { name: string; causes: string[]; element: (cause: string, handlers: Record<string, (...args: unknown[]) => void>) => unknown };
const NOTICE_CAUSES = Object.keys(CAUSES).filter((name) => CAUSES[name].detail);
const CARD_CAUSES = Object.keys(CAUSES).filter((name) => name !== "repeated");
const REVIEW_CAUSES = Object.keys(CAUSES);
const cardHandlers = (h: Record<string, (...args: unknown[]) => void>) => ({ keepIds: [], busy: false, error: null, onToggleKeep: h.toggleKeep, onToggleKeepTopic: h.toggleKeepTopic, onRaiseBudget: h.raiseBudget });
const PLACES: Place[] = [
	{
		name: "notice",
		causes: NOTICE_CAUSES,
		element: (cause, h) => {
			const { stop, detail } = CAUSES[cause];
			const quotaWay = stop.quotaWay as { kind: string } | undefined;
			const value = { detail, sentence: "The notice.", provider: MODEL.provider, ...(stop.key ? { key: stop.key } : {}), ...(quotaWay ? { quotaWay, modelName: "Acme Model" } : {}) };
			return createElement(notice.ModelNoticePanel, { notice: value, onTryAgain: h.tryAgain, onChooseModel: h.chooseModel, onSignIn: h.signIn, onClose: h.close });
		},
	},
	...[false, true].map((nothingRead): Place => ({
		name: nothingRead ? "memorize-paused" : "memorize-note",
		causes: CARD_CAUSES,
		element: (cause, h) => createElement(memorize.AbsorbRunCard, { run: absorbRun(stopOf(cause), nothingRead), roomName: "Supplier Desk", memoryModel: { ...MODEL, label: "Acme Model" }, ...cardHandlers(h), onApprove: h.approve, onCancel: h.cancel, onBackToAssessment: h.back, onResume: h.resume, onChooseModel: h.chooseModel, onSignIn: h.signIn }),
	})),
	...[false, true].map((nothingTidied): Place => ({
		name: nothingTidied ? "review-paused" : "review-note",
		causes: REVIEW_CAUSES,
		element: (cause, h) => createElement(review.ReviewCard, { run: reviewRun(stopOf(cause), nothingTidied), roomName: "Supplier Desk", ...cardHandlers(h), onCancel: h.cancel, onBack: h.back, backLabel: "Back", onSave: h.save, onClose: h.close, onTryAgain: h.tryAgain, onChooseModel: h.chooseModel, onSignIn: h.signIn }),
	})),
	...[false, true].map((tidiedSome): Place => ({
		name: tidiedSome ? "review-saved-some" : "review-saved-none",
		causes: REVIEW_CAUSES,
		element: (cause, h) => createElement(review.ReviewSavedScreen, { roomName: "Supplier Desk", counts: tidiedSome ? someCounts : noneCounts, topicsLeft: ["Payments"], percent: 40, over: false, archivedEntries: 0, archivedForBudget: 0, warnings: [], undo: { busy: false, done: false, error: null }, onUndo: h.undo, onTryAgain: h.tryAgain, onChooseModel: h.chooseModel, onReturn: h.done, returnLabel: "Done", stop: stopOf(cause) }),
	})),
];

/** The buttons of the ways-on rows, in order: "label", with "*" when it leads and "~" when it is disabled. */
function rowButtons(container: Element): Element[] {
	return [...container.querySelectorAll(".absorb-run-note-actions button, .checkpoint-preview-actions button")];
}
function describe(button: Element): string {
	return `${button.textContent}${button.className.includes("rs-btn-primary") ? "*" : ""}${(button as HTMLButtonElement).disabled ? "~" : ""}`;
}

async function mount(place: Place, cause: string, calls: string[]): Promise<{ container: Element; unmount: () => void }> {
	const handler = (name: string) => (...args: unknown[]) => { calls.push(args.length && typeof args[0] === "string" ? `${name}(${args[0]})` : name); };
	const handlers = new Proxy({}, { get: (_target, name) => handler(String(name)) }) as Record<string, (...args: unknown[]) => void>;
	const container = dom.window.document.createElement("div");
	dom.window.document.body.appendChild(container);
	const root = createRoot(container);
	root.render(place.element(cause, handlers));
	await settle();
	return { container, unmount: () => { root.unmount(); container.remove(); } };
}

/** One line of the table: the buttons, then for each, what it calls and the buttons after it. */
async function line(place: Place, cause: string): Promise<string> {
	const calls: string[] = [];
	const first = await mount(place, cause, calls);
	const shown = rowButtons(first.container).map(describe);
	first.unmount();
	const clicks: string[] = [];
	for (let index = 0; index < shown.length; index++) {
		const clickCalls: string[] = [];
		const again = await mount(place, cause, clickCalls);
		(rowButtons(again.container)[index] as HTMLButtonElement).click();
		await settle();
		const after = rowButtons(again.container).map(describe).join("|");
		again.unmount();
		clicks.push(`${shown[index]}>${clickCalls.join("+") || "-"}${after === shown.join("|") ? "" : ` => ${after}`}`);
	}
	return `${place.name} ${cause}: ${shown.join("|") || "-"}${clicks.length ? ` ; ${clicks.join(" ; ")}` : ""}`;
}

const table: string[] = [];
for (const place of PLACES) {
	for (const cause of place.causes) table.push(await line(place, cause));
}

if (process.env.MEMORY_WAYS_ON_PRINT) {
	console.log(table.join("\n"));
	process.exit(0);
}

// The table as the screens show it on this computer; a shared server differs only where SHARED says.
const EXPECTED = `
notice quota-key: Try again|Choose another model|Close ; Try again>tryAgain ; Choose another model>chooseModel ; Close>close
notice quota-plan-unknown-reset: Choose another model|Close ; Choose another model>chooseModel => Try again|Choose another model|Close ; Close>close
notice quota-plan-reset-passed: Try again|Choose another model|Close ; Try again>tryAgain ; Choose another model>chooseModel ; Close>close
notice quota-gateway: Try again|Choose another model|Close ; Try again>tryAgain ; Choose another model>chooseModel ; Close>close
notice key-refused: Replace key*|Choose another model|Close ; Replace key*>signIn(acme-gw) => Replace key*|Try again|Choose another model|Close ; Choose another model>chooseModel => Replace key*|Try again|Choose another model|Close ; Close>close
notice key-missing: Add key*|Choose another model|Close ; Add key*>signIn(acme-gw) => Add key*|Try again|Choose another model|Close ; Choose another model>chooseModel => Add key*|Try again|Choose another model|Close ; Close>close
notice signed-out: Sign in*|Choose another model|Close ; Sign in*>signIn(acme-gw) => Sign in*|Try again|Choose another model|Close ; Choose another model>chooseModel => Sign in*|Try again|Choose another model|Close ; Close>close
notice gateway-403: Replace key*|Choose another model|Close ; Replace key*>signIn(acme-gw) => Replace key*|Try again|Choose another model|Close ; Choose another model>chooseModel => Replace key*|Try again|Choose another model|Close ; Close>close
notice not-reached: Try again|Choose another model|Close ; Try again>tryAgain ; Choose another model>chooseModel ; Close>close
notice busy: Try again|Choose another model|Close ; Try again>tryAgain ; Choose another model>chooseModel ; Close>close
notice not-on-account: Choose another model|Close ; Choose another model>chooseModel => Try again|Choose another model|Close ; Close>close
memorize-note quota-key: Try again|Choose another model|Cancel|Back|Save to memory* ; Try again>resume ; Choose another model>chooseModel ; Cancel>cancel ; Back>back ; Save to memory*>approve
memorize-note quota-plan-unknown-reset: Choose another model|Cancel|Back|Save to memory* ; Choose another model>chooseModel => Try again|Choose another model|Cancel|Back|Save to memory* ; Cancel>cancel ; Back>back ; Save to memory*>approve
memorize-note quota-plan-reset-passed: Try again|Choose another model|Cancel|Back|Save to memory* ; Try again>resume ; Choose another model>chooseModel ; Cancel>cancel ; Back>back ; Save to memory*>approve
memorize-note quota-gateway: Try again|Choose another model|Cancel|Back|Save to memory* ; Try again>resume ; Choose another model>chooseModel ; Cancel>cancel ; Back>back ; Save to memory*>approve
memorize-note key-refused: Replace key*|Choose another model|Cancel|Back|Save to memory* ; Replace key*>signIn(acme-gw) => Replace key*|Try again|Choose another model|Cancel|Back|Save to memory* ; Choose another model>chooseModel => Replace key*|Try again|Choose another model|Cancel|Back|Save to memory* ; Cancel>cancel ; Back>back ; Save to memory*>approve
memorize-note key-missing: Add key*|Choose another model|Cancel|Back|Save to memory* ; Add key*>signIn(acme-gw) => Add key*|Try again|Choose another model|Cancel|Back|Save to memory* ; Choose another model>chooseModel => Add key*|Try again|Choose another model|Cancel|Back|Save to memory* ; Cancel>cancel ; Back>back ; Save to memory*>approve
memorize-note signed-out: Sign in*|Choose another model|Cancel|Back|Save to memory* ; Sign in*>signIn(acme-gw) => Sign in*|Try again|Choose another model|Cancel|Back|Save to memory* ; Choose another model>chooseModel => Sign in*|Try again|Choose another model|Cancel|Back|Save to memory* ; Cancel>cancel ; Back>back ; Save to memory*>approve
memorize-note gateway-403: Replace key*|Choose another model|Cancel|Back|Save to memory* ; Replace key*>signIn(acme-gw) => Replace key*|Try again|Choose another model|Cancel|Back|Save to memory* ; Choose another model>chooseModel => Replace key*|Try again|Choose another model|Cancel|Back|Save to memory* ; Cancel>cancel ; Back>back ; Save to memory*>approve
memorize-note not-reached: Try again|Choose another model|Cancel|Back|Save to memory* ; Try again>resume ; Choose another model>chooseModel ; Cancel>cancel ; Back>back ; Save to memory*>approve
memorize-note busy: Try again|Choose another model|Cancel|Back|Save to memory* ; Try again>resume ; Choose another model>chooseModel ; Cancel>cancel ; Back>back ; Save to memory*>approve
memorize-note not-on-account: Choose another model|Cancel|Back|Save to memory* ; Choose another model>chooseModel => Try again|Choose another model|Cancel|Back|Save to memory* ; Cancel>cancel ; Back>back ; Save to memory*>approve
memorize-note restarted: Continue|Cancel|Back|Save to memory* ; Continue>resume ; Cancel>cancel ; Back>back ; Save to memory*>approve
memorize-paused quota-key: Cancel|Choose another model|Try again* ; Cancel>cancel ; Choose another model>chooseModel ; Try again*>resume
memorize-paused quota-plan-unknown-reset: Cancel|Choose another model* ; Cancel>cancel ; Choose another model*>chooseModel => Cancel|Choose another model|Try again*
memorize-paused quota-plan-reset-passed: Cancel|Choose another model|Try again* ; Cancel>cancel ; Choose another model>chooseModel ; Try again*>resume
memorize-paused quota-gateway: Cancel|Choose another model|Try again* ; Cancel>cancel ; Choose another model>chooseModel ; Try again*>resume
memorize-paused key-refused: Cancel|Replace key*|Choose another model ; Cancel>cancel ; Replace key*>signIn(acme-gw) => Cancel|Replace key*|Choose another model|Try again ; Choose another model>chooseModel => Cancel|Replace key*|Choose another model|Try again
memorize-paused key-missing: Cancel|Add key*|Choose another model ; Cancel>cancel ; Add key*>signIn(acme-gw) => Cancel|Add key*|Choose another model|Try again ; Choose another model>chooseModel => Cancel|Add key*|Choose another model|Try again
memorize-paused signed-out: Cancel|Sign in*|Choose another model ; Cancel>cancel ; Sign in*>signIn(acme-gw) => Cancel|Sign in*|Choose another model|Try again ; Choose another model>chooseModel => Cancel|Sign in*|Choose another model|Try again
memorize-paused gateway-403: Cancel|Replace key*|Choose another model ; Cancel>cancel ; Replace key*>signIn(acme-gw) => Cancel|Replace key*|Choose another model|Try again ; Choose another model>chooseModel => Cancel|Replace key*|Choose another model|Try again
memorize-paused not-reached: Cancel|Choose another model|Try again* ; Cancel>cancel ; Choose another model>chooseModel ; Try again*>resume
memorize-paused busy: Cancel|Choose another model|Try again* ; Cancel>cancel ; Choose another model>chooseModel ; Try again*>resume
memorize-paused not-on-account: Cancel|Choose another model* ; Cancel>cancel ; Choose another model*>chooseModel => Cancel|Choose another model|Try again*
memorize-paused restarted: Cancel|Continue* ; Cancel>cancel ; Continue*>resume
review-note quota-key: Try again|Choose another model|Cancel|Back|Save to memory* ; Try again>tryAgain ; Choose another model>chooseModel ; Cancel>cancel ; Back>back ; Save to memory*>save
review-note quota-plan-unknown-reset: Choose another model|Cancel|Back|Save to memory* ; Choose another model>chooseModel => Try again|Choose another model|Cancel|Back|Save to memory* ; Cancel>cancel ; Back>back ; Save to memory*>save
review-note quota-plan-reset-passed: Try again|Choose another model|Cancel|Back|Save to memory* ; Try again>tryAgain ; Choose another model>chooseModel ; Cancel>cancel ; Back>back ; Save to memory*>save
review-note quota-gateway: Try again|Choose another model|Cancel|Back|Save to memory* ; Try again>tryAgain ; Choose another model>chooseModel ; Cancel>cancel ; Back>back ; Save to memory*>save
review-note key-refused: Replace key*|Choose another model|Cancel|Back|Save to memory* ; Replace key*>signIn(acme-gw) => Replace key*|Try again|Choose another model|Cancel|Back|Save to memory* ; Choose another model>chooseModel => Replace key*|Try again|Choose another model|Cancel|Back|Save to memory* ; Cancel>cancel ; Back>back ; Save to memory*>save
review-note key-missing: Add key*|Choose another model|Cancel|Back|Save to memory* ; Add key*>signIn(acme-gw) => Add key*|Try again|Choose another model|Cancel|Back|Save to memory* ; Choose another model>chooseModel => Add key*|Try again|Choose another model|Cancel|Back|Save to memory* ; Cancel>cancel ; Back>back ; Save to memory*>save
review-note signed-out: Sign in*|Choose another model|Cancel|Back|Save to memory* ; Sign in*>signIn(acme-gw) => Sign in*|Try again|Choose another model|Cancel|Back|Save to memory* ; Choose another model>chooseModel => Sign in*|Try again|Choose another model|Cancel|Back|Save to memory* ; Cancel>cancel ; Back>back ; Save to memory*>save
review-note gateway-403: Replace key*|Choose another model|Cancel|Back|Save to memory* ; Replace key*>signIn(acme-gw) => Replace key*|Try again|Choose another model|Cancel|Back|Save to memory* ; Choose another model>chooseModel => Replace key*|Try again|Choose another model|Cancel|Back|Save to memory* ; Cancel>cancel ; Back>back ; Save to memory*>save
review-note not-reached: Try again|Choose another model|Cancel|Back|Save to memory* ; Try again>tryAgain ; Choose another model>chooseModel ; Cancel>cancel ; Back>back ; Save to memory*>save
review-note busy: Try again|Choose another model|Cancel|Back|Save to memory* ; Try again>tryAgain ; Choose another model>chooseModel ; Cancel>cancel ; Back>back ; Save to memory*>save
review-note not-on-account: Choose another model|Cancel|Back|Save to memory* ; Choose another model>chooseModel => Try again|Choose another model|Cancel|Back|Save to memory* ; Cancel>cancel ; Back>back ; Save to memory*>save
review-note restarted: Continue|Cancel|Back|Save to memory* ; Continue>tryAgain ; Cancel>cancel ; Back>back ; Save to memory*>save
review-note repeated: Try again|Choose another model|Cancel|Back|Save to memory* ; Try again>tryAgain ; Choose another model>chooseModel ; Cancel>cancel ; Back>back ; Save to memory*>save
review-paused quota-key: Close|Choose another model|Try again* ; Close>close ; Choose another model>chooseModel ; Try again*>tryAgain
review-paused quota-plan-unknown-reset: Close|Choose another model* ; Close>close ; Choose another model*>chooseModel => Close|Choose another model|Try again*
review-paused quota-plan-reset-passed: Close|Choose another model|Try again* ; Close>close ; Choose another model>chooseModel ; Try again*>tryAgain
review-paused quota-gateway: Close|Choose another model|Try again* ; Close>close ; Choose another model>chooseModel ; Try again*>tryAgain
review-paused key-refused: Close|Replace key*|Choose another model ; Close>close ; Replace key*>signIn(acme-gw) => Close|Replace key*|Choose another model|Try again ; Choose another model>chooseModel => Close|Replace key*|Choose another model|Try again
review-paused key-missing: Close|Add key*|Choose another model ; Close>close ; Add key*>signIn(acme-gw) => Close|Add key*|Choose another model|Try again ; Choose another model>chooseModel => Close|Add key*|Choose another model|Try again
review-paused signed-out: Close|Sign in*|Choose another model ; Close>close ; Sign in*>signIn(acme-gw) => Close|Sign in*|Choose another model|Try again ; Choose another model>chooseModel => Close|Sign in*|Choose another model|Try again
review-paused gateway-403: Close|Replace key*|Choose another model ; Close>close ; Replace key*>signIn(acme-gw) => Close|Replace key*|Choose another model|Try again ; Choose another model>chooseModel => Close|Replace key*|Choose another model|Try again
review-paused not-reached: Close|Choose another model|Try again* ; Close>close ; Choose another model>chooseModel ; Try again*>tryAgain
review-paused busy: Close|Choose another model|Try again* ; Close>close ; Choose another model>chooseModel ; Try again*>tryAgain
review-paused not-on-account: Close|Choose another model* ; Close>close ; Choose another model*>chooseModel => Close|Choose another model|Try again*
review-paused restarted: Close|Continue* ; Close>close ; Continue*>tryAgain
review-paused repeated: Close|Choose another model*|Try again ; Close>close ; Choose another model*>chooseModel ; Try again>tryAgain
review-saved-none quota-key: Done|Choose another model|Try again* ; Done>done ; Choose another model>chooseModel ; Try again*>tryAgain
review-saved-none quota-plan-unknown-reset: Done|Choose another model* ; Done>done ; Choose another model*>chooseModel => Done|Choose another model*|Try again
review-saved-none quota-plan-reset-passed: Done|Choose another model|Try again* ; Done>done ; Choose another model>chooseModel ; Try again*>tryAgain
review-saved-none quota-gateway: Done|Choose another model|Try again* ; Done>done ; Choose another model>chooseModel ; Try again*>tryAgain
review-saved-none key-refused: Done|Choose another model* ; Done>done ; Choose another model*>chooseModel => Done|Choose another model*|Try again
review-saved-none key-missing: Done|Choose another model* ; Done>done ; Choose another model*>chooseModel => Done|Choose another model*|Try again
review-saved-none signed-out: Done|Choose another model* ; Done>done ; Choose another model*>chooseModel => Done|Choose another model*|Try again
review-saved-none gateway-403: Done|Choose another model* ; Done>done ; Choose another model*>chooseModel => Done|Choose another model*|Try again
review-saved-none not-reached: Done|Choose another model|Try again* ; Done>done ; Choose another model>chooseModel ; Try again*>tryAgain
review-saved-none busy: Done|Choose another model|Try again* ; Done>done ; Choose another model>chooseModel ; Try again*>tryAgain
review-saved-none not-on-account: Done|Choose another model* ; Done>done ; Choose another model*>chooseModel => Done|Choose another model*|Try again
review-saved-none restarted: Done|Choose another model|Try again* ; Done>done ; Choose another model>chooseModel ; Try again*>tryAgain
review-saved-none repeated: Done|Choose another model|Try again* ; Done>done ; Choose another model>chooseModel ; Try again*>tryAgain
review-saved-some quota-key: Undo|Done*|Choose another model|Try again ; Undo>undo ; Done*>done ; Choose another model>chooseModel ; Try again>tryAgain
review-saved-some quota-plan-unknown-reset: Undo|Done*|Choose another model ; Undo>undo ; Done*>done ; Choose another model>chooseModel => Undo|Done*|Choose another model|Try again
review-saved-some quota-plan-reset-passed: Undo|Done*|Choose another model|Try again ; Undo>undo ; Done*>done ; Choose another model>chooseModel ; Try again>tryAgain
review-saved-some quota-gateway: Undo|Done*|Choose another model|Try again ; Undo>undo ; Done*>done ; Choose another model>chooseModel ; Try again>tryAgain
review-saved-some key-refused: Undo|Done*|Choose another model ; Undo>undo ; Done*>done ; Choose another model>chooseModel => Undo|Done*|Choose another model|Try again
review-saved-some key-missing: Undo|Done*|Choose another model ; Undo>undo ; Done*>done ; Choose another model>chooseModel => Undo|Done*|Choose another model|Try again
review-saved-some signed-out: Undo|Done*|Choose another model ; Undo>undo ; Done*>done ; Choose another model>chooseModel => Undo|Done*|Choose another model|Try again
review-saved-some gateway-403: Undo|Done*|Choose another model ; Undo>undo ; Done*>done ; Choose another model>chooseModel => Undo|Done*|Choose another model|Try again
review-saved-some not-reached: Undo|Done*|Choose another model|Try again ; Undo>undo ; Done*>done ; Choose another model>chooseModel ; Try again>tryAgain
review-saved-some busy: Undo|Done*|Choose another model|Try again ; Undo>undo ; Done*>done ; Choose another model>chooseModel ; Try again>tryAgain
review-saved-some not-on-account: Undo|Done*|Choose another model ; Undo>undo ; Done*>done ; Choose another model>chooseModel => Undo|Done*|Choose another model|Try again
review-saved-some restarted: Undo|Done*|Choose another model|Try again ; Undo>undo ; Done*>done ; Choose another model>chooseModel ; Try again>tryAgain
review-saved-some repeated: Undo|Done*|Choose another model|Try again ; Undo>undo ; Done*>done ; Choose another model>chooseModel ; Try again>tryAgain
`.trim().split("\n");
const SHARED: Record<string, string> = {
	"notice gateway-403": "Choose another model|Close ; Choose another model>chooseModel => Try again|Choose another model|Close ; Close>close",
	"memorize-note gateway-403": "Choose another model|Cancel|Back|Save to memory* ; Choose another model>chooseModel => Try again|Choose another model|Cancel|Back|Save to memory* ; Cancel>cancel ; Back>back ; Save to memory*>approve",
	"memorize-paused gateway-403": "Cancel|Choose another model* ; Cancel>cancel ; Choose another model*>chooseModel => Cancel|Choose another model|Try again*",
	"review-note gateway-403": "Choose another model|Cancel|Back|Save to memory* ; Choose another model>chooseModel => Try again|Choose another model|Cancel|Back|Save to memory* ; Cancel>cancel ; Back>back ; Save to memory*>save",
	"review-paused gateway-403": "Close|Choose another model* ; Close>close ; Choose another model*>chooseModel => Close|Choose another model|Try again*",
};

const expected = EXPECTED.map((row) => {
	const key = row.slice(0, row.indexOf(":"));
	return contextName === "shared" && SHARED[key] !== undefined ? `${key}: ${SHARED[key]}` : row;
});
const failures: string[] = [];
for (let index = 0; index < Math.max(expected.length, table.length); index++) {
	if (expected[index] !== table[index]) failures.push(`  expected: ${expected[index] ?? "(nothing)"}\n  got:      ${table[index] ?? "(nothing)"}`);
}
if (failures.length) {
	console.error(`${contextName}: ${failures.length} row(s) differ:\n${failures.join("\n")}`);
	process.exit(1);
}
console.log(`  ok  ${contextName}: ${table.length} rows`);
process.exit(0);
