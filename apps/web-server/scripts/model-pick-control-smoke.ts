// The message box's model and effort control and its too-long window, run
// as the page draws them, before they are wired into the room: the level
// names, the mark each pair of the read's `fits` and `freshFits` gives a
// model's row, the trigger's words and needle, the panel's two views and its
// keys (Tab, arrows, Home, End, Escape stepping back then closing), a held
// pick's effort from the read, loading, a failed read with Try again, a
// failed refresh keeping the last list, no models, the phone's modal sheet,
// the too-long window's three cases, and the switch route's refusal codes.
//
// Offline: no server, no provider, no network, no port. The page's fetch is
// answered here by URL.
//
// Run: npm run smokes -- model-pick-control   (or tsx this file)

const { JSDOM } = await import("jsdom");
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: "http://page.test/" });
const globals = globalThis as any;
globals.window = dom.window;
globals.document = dom.window.document;
globals.HTMLElement = dom.window.HTMLElement;
// Node 21 and later have a global navigator, which React reads once a window exists; Node 20, which CI runs, has none.
if (!("navigator" in globalThis)) globals.navigator = dom.window.navigator;
// JSDOM lays nothing out, so every element reads as unrendered; the Tab keeper skips those, as it skips hidden controls in a browser.
dom.window.HTMLElement.prototype.getClientRects = function () { return [{}] as unknown as DOMRectList; };

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

type Lock = { provider: string; model: string };
const RUNGS3 = [{ level: "low", label: "low" }, { level: "medium", label: "medium" }, { level: "high", label: "high" }];
const RUNGS2 = [{ level: "low", label: "low" }, { level: "high", label: "high" }];
const ONE_RUNG = [{ level: "off", label: "off" }];
const option = (model: string, label: string, recommended = false) => ({ provider: "acme", model, label, ...(recommended ? { recommended } : {}) });
const PROVIDERS = [{ id: "acme", label: "Acme", ready: true, memory: [], conversation: [option("big", "Big Model", true), option("mid", "Mid Model"), option("short", "Short Model"), option("tiny", "Tiny Model"), option("narrow", "Narrow Model")] }];
// Big fits both ways; Mid fits this conversation (its frozen snapshot) though a new one would not; Short fits only a new
// conversation; Tiny fits neither; Narrow has one rung.
const OPTIONS = [
	{ provider: "acme", model: "big", fits: true, freshFits: true, effort: { level: "medium", ladder: RUNGS3 } },
	{ provider: "acme", model: "mid", fits: true, freshFits: false, effort: { level: "high", ladder: RUNGS2 } },
	{ provider: "acme", model: "short", fits: false, freshFits: true, effort: { level: "medium", ladder: RUNGS3 } },
	{ provider: "acme", model: "tiny", fits: false, freshFits: false, effort: { level: "low", ladder: RUNGS2 } },
	{ provider: "acme", model: "narrow", fits: true, freshFits: true, effort: { level: "off", ladder: ONE_RUNG } },
];

/** How the stubbed server answers the panel's two reads: as it should, with a failure, never, or with no models. */
let answer: "ok" | "fail" | "hang" | "none" = "ok";
const reads: string[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: RequestInfo | URL) => {
	const url = new URL(String(input), "http://page.test/");
	if (url.pathname === "/api/remote/client-context") return json({ remote: false, capability: "full", sharedServer: false });
	reads.push(url.pathname);
	if (answer === "hang") return new Promise<Response>(() => {});
	if (answer === "fail") return json({ error: "The model list could not be read." }, 503);
	if (url.pathname === "/api/persistent-agent-room/model-status") return json({ ready: true, selected: null, recommended: null, models: [], providers: answer === "none" ? [] : PROVIDERS });
	if (url.pathname === "/api/persistent-agents/room-1/threads/conv-1/model-options") return json({ agentId: "room-1", conversationId: "conv-1", models: answer === "none" ? [] : OPTIONS });
	return json({ error: `unexpected read ${url.pathname}` }, 404);
}) as typeof fetch;

const pageRequire = (await import("node:module")).createRequire(new URL("../../web-ui/package.json", import.meta.url));
const { act, createElement, useState } = pageRequire("react");
globals.React = pageRequire("react");
globals.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = pageRequire("react-dom/client");
const effortControl: any = await import(new URL("../../web-ui/src/components/EffortControl.tsx", import.meta.url).href);
const control: any = await import(new URL("../../web-ui/src/components/model-pick-control.tsx", import.meta.url).href);
const switchWindow: any = await import(new URL("../../web-ui/src/components/model-switch-window.tsx", import.meta.url).href);
const modelsApi: any = await import(new URL("../../web-ui/src/room-models-api.ts", import.meta.url).href);
const api: any = await import(new URL("../../web-ui/src/api.ts", import.meta.url).href);

const doc = dom.window.document;
const $ = (selector: string) => doc.querySelector(selector) as HTMLElement | null;
const $$ = (selector: string) => [...doc.querySelectorAll(selector)] as HTMLElement[];
const focused = () => doc.activeElement as HTMLElement | null;
const describeFocus = () => { const el = focused(); return el ? `${el.tagName.toLowerCase()}.${el.className} "${el.getAttribute("aria-label") ?? el.textContent}"` : "nothing"; };

/** Lets React render and the stubbed reads answer until `ready` holds; fails with what is on screen if it never does. */
async function until(ready: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 50 && !ready(); i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
	assert(ready(), `${what}; the page shows: ${doc.body.textContent}`);
}

async function key(target: Element | null, name: string, shiftKey = false): Promise<void> {
	assert(target, `no element to press ${name} on`);
	await act(async () => { target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: name, shiftKey, bubbles: true, cancelable: true })); });
}
/**
 * Tab as a browser presses it on the focused element: the page's handlers
 * first; when they let the key pass, focus moves to the next control in page
 * order (the previous with Shift), which jsdom does not do by itself.
 */
async function tab(shiftKey = false): Promise<void> {
	const from = focused();
	assert(from, "no element to press Tab on");
	let passed = false;
	await act(async () => { passed = from.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true })); });
	if (!passed) return;
	const order = $$("button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]").filter((el) => el.tabIndex >= 0);
	const next = order[order.indexOf(from) + (shiftKey ? -1 : 1)];
	if (next) await act(async () => { next.focus(); });
}
async function click(target: Element | null, what: string): Promise<void> {
	assert(target, `${what}: not on screen`);
	await act(async () => { (target as HTMLElement).click(); });
}

const calls: string[] = [];
let mounted: { unmount: () => void } | null = null;
function unmountControl(): void {
	mounted?.unmount();
	mounted = null;
}
/** The control as the room would hold it: open state in its parent, every callback written down. */
async function mountControl(props: Record<string, unknown> = {}): Promise<void> {
	unmountControl();
	calls.length = 0;
	function Harness() {
		const [open, setOpen] = useState(false);
		return createElement(control.ModelPickControl, {
			placement: "row", agentId: "room-1", conversationId: "conv-1", open, onOpenChange: setOpen,
			current: { provider: "acme", model: "big", label: "acme/big" }, held: null,
			effort: { level: "medium", ladder: RUNGS3 }, effortDisabled: false,
			onPick: (lock: Lock) => calls.push(`pick ${lock.model}`), onEffort: (level: string) => calls.push(`effort ${level}`), onTooLong: (lock: Lock, name: string) => calls.push(`too-long ${lock.model} "${name}"`),
			...props,
		});
	}
	const container = doc.createElement("div");
	doc.body.appendChild(container);
	const root = createRoot(container);
	await act(async () => { root.render(createElement(Harness)); });
	mounted = { unmount: () => { act(() => root.unmount()); container.remove(); } };
}
const trigger = () => $(".model-pick-trigger");
const rowNamed = (name: string) => $$(".model-pick-row").find((row) => row.querySelector(".model-pick-row-name")?.textContent === name) ?? null;
const rowLine = (row: HTMLElement) => `${row.querySelector(".model-pick-row-name")?.textContent}${row.getAttribute("aria-selected") === "true" ? " ✓" : ""}${row.classList.contains("is-greyed") ? " greyed" : ""}${row.getAttribute("aria-disabled") === "true" ? " disabled" : ""}${[...row.querySelectorAll(".room-model-option-tag, .model-pick-row-hint")].map((tag) => ` [${tag.textContent}]`).join("")}${row.title ? ` title="${row.title}"` : ""}`;

try {
	// ---- the level names: one page table, an unknown word in title case ----
	const names = ["off", "none", "minimal", "low", "medium", "high", "xhigh", "max", "HIGH", "ultra_think", "__proto__"].map((word) => `${word}=${effortControl.effortDisplayName(word)}`).join(", ");
	assert(names === "off=Off, none=Off, minimal=Minimal, low=Low, medium=Medium, high=High, xhigh=Extra high, max=Max, HIGH=High, ultra_think=Ultra Think, __proto__=Proto", `level names: ${names}`);

	// ---- the mark each pair from the read gives ----
	const marks = [[true, true], [true, false], [false, true], [false, false]].map(([fits, freshFits]) => `${fits}/${freshFits}=${control.modelMarkOf({ fits, freshFits })}`).join(", ");
	assert(marks === "true/true=none, true/false=none, false/true=new-conversation, false/false=too-small", `marks: ${marks}`);
	assert(control.modelMarkOf(undefined) === "none", "a model the read does not name carries no mark (the switch route checks it)");

	// ---- the needle: one position per rung ----
	const needles = new Set([0, 1, 2, 3, 4].map((index) => {
		const holder = doc.createElement("div");
		const root = createRoot(holder);
		act(() => root.render(createElement(effortControl.SpeedometerIcon, { index, count: 5 })));
		const needle = holder.querySelectorAll("path")[1]?.getAttribute("d");
		act(() => root.unmount());
		return needle;
	}));
	assert(needles.size === 5, `five rungs draw five needle positions, got ${needles.size}`);

	// ---- the trigger: the name, the speedometer, the effort word in its label only ----
	await mountControl();
	await until(() => trigger()?.getAttribute("aria-label") === "Model and effort: Big Model Medium", "the trigger names the model and its effort");
	assert(trigger()?.title === "Model and effort: Big Model Medium", `its title keeps the effort word: ${trigger()?.title}`);
	assert(trigger()?.textContent === "Big Model" && trigger()?.querySelector(".speedometer-icon"), `the row shows the name and the speedometer, no word: "${trigger()?.textContent}"`);
	assert(trigger()?.tagName === "BUTTON" && trigger()?.getAttribute("type") === "button", "the trigger is a button: Enter and Space open it on every system");
	assert(reads.includes("/api/persistent-agents/room-1/threads/conv-1/model-options"), `the control reads the conversation's model options: ${reads.join(", ")}`);

	// ---- the effort view and its keys ----
	await click(trigger(), "the trigger");
	await until(() => $(".model-pick-effort-title")?.textContent === "Medium", "the panel opens on the effort view with the level's name");
	assert($(".model-pick-effort-model")?.textContent === "Big Model", `the model's name sits under it: ${$(".model-pick-effort-model")?.textContent}`);
	assert(focused()?.classList.contains("effort-slider"), `the slider takes the focus on open: ${describeFocus()}`);
	await key(focused(), "ArrowRight");
	await key(focused(), "Home");
	await key(focused(), "End");
	await key(focused(), "ArrowLeft");
	assert(calls.join(", ") === "effort high, effort low, effort high, effort low", `arrows, Home and End move the slider: ${calls.join(", ")}`);
	calls.length = 0;
	await tab();
	assert(focused()?.classList.contains("model-pick-effort-model"), `Tab goes from the slider to the model's name: ${describeFocus()}`);
	await tab(true);
	assert(focused()?.classList.contains("effort-slider"), `Shift+Tab goes back to the slider: ${describeFocus()}`);

	// ---- the models view, its marks and its keys ----
	await click($(".model-pick-effort-model"), "the model's name");
	await until(() => $(".model-pick-list-title")?.textContent === "Models", "the name opens the models view");
	const list = $$(".model-pick-row").map(rowLine).join("\n");
	const expectedList = [
		"Big Model ✓ [Recommended]",
		"Mid Model",
		"Short Model greyed [New conversation]",
		`Tiny Model greyed disabled [Too small] title="${control.TOO_SMALL_REASON}"`,
		"Narrow Model",
	].join("\n");
	assert(list === expectedList, `the models view lists:\n${list}`);
	assert(!doc.body.textContent?.includes(control.TOO_SMALL_REASON), "the too-small reason is hover text only, never a line");
	assert(focused() === rowNamed("Big Model"), `the list opens on the model in use: ${describeFocus()}`);
	await key(focused(), "ArrowDown");
	assert(focused() === rowNamed("Mid Model"), `ArrowDown moves to the next model: ${describeFocus()}`);
	await key(focused(), "End");
	assert(focused() === rowNamed("Narrow Model"), `End moves to the last: ${describeFocus()}`);
	await key(focused(), "Home");
	assert(focused() === rowNamed("Big Model"), `Home moves to the first: ${describeFocus()}`);
	await key(focused(), "ArrowUp");
	assert(focused() === rowNamed("Big Model"), `ArrowUp stops at the first: ${describeFocus()}`);
	// JSDOM has no Tab of its own: only the panel's wraps move the focus here, as they do in a browser.
	await key(focused(), "Tab");
	assert(focused()?.classList.contains("model-pick-back"), `Tab from the list wraps to Back, inside the panel: ${describeFocus()}`);
	await key(focused(), "Tab", true);
	assert(focused() === rowNamed("Big Model"), `Shift+Tab from Back wraps to the list: ${describeFocus()}`);
	await key(focused(), "Escape");
	assert($(".model-pick-effort-title") && focused()?.classList.contains("model-pick-effort-model"), `Escape steps back to the effort view, focus on the name: ${describeFocus()}`);
	await key(focused(), "Escape");
	assert(!$(".model-pick-panel") && focused() === trigger(), `a second Escape closes and gives the focus back to the control: ${describeFocus()}`);

	// ---- picks ----
	await click(trigger(), "the trigger");
	await click($(".model-pick-effort-model"), "the model's name");
	await click(rowNamed("Tiny Model"), "Tiny Model");
	assert(calls.length === 0 && $(".model-pick-list"), `a too-small model is not pickable: ${calls.join(", ")}`);
	await click(rowNamed("Short Model"), "Short Model");
	assert(calls.join(", ") === `too-long short "Short Model"` && !$(".model-pick-panel"), `a model this conversation is too long for opens the window: ${calls.join(", ")}`);
	calls.length = 0;
	await click(trigger(), "the trigger");
	await click($(".model-pick-effort-model"), "the model's name");
	await click(rowNamed("Mid Model"), "Mid Model");
	assert(calls.join(", ") === "pick mid" && $(".model-pick-effort-title"), `a model that fits is picked and the panel returns to the effort view: ${calls.join(", ")}`);
	calls.length = 0;
	await click($(".model-pick-effort-model"), "the model's name");
	await click(rowNamed("Narrow Model"), "Narrow Model");
	assert(calls.join(", ") === "pick narrow" && !$(".model-pick-panel") && focused() === trigger(), `a one-rung pick closes the panel, focus on the control: ${calls.join(", ")} ${describeFocus()}`);

	// ---- a held pick: its effort from the read, the slider working on it ----
	await mountControl({ held: { provider: "acme", model: "mid" } });
	await until(() => trigger()?.getAttribute("aria-label") === "Model and effort: Mid Model High", `a held pick shows the picked model and the read's level for it: ${trigger()?.getAttribute("aria-label")}`);
	await click(trigger(), "the trigger");
	await until(() => $(".effort-slider") !== null, "the held pick's panel shows its dial");
	assert($(".effort-slider")?.getAttribute("aria-disabled") === null && focused() === $(".effort-slider"), `the slider works on the held pick: ${describeFocus()}`);
	await key($(".effort-slider"), "ArrowLeft");
	assert(calls.join(", ") === "effort low", `the slider picks on the held model's ladder: ${calls.join(", ")}`);
	calls.length = 0;
	await click($(".model-pick-effort-model"), "the model's name");
	assert(rowLine(rowNamed("Mid Model")!) === "Mid Model ✓" && rowLine(rowNamed("Big Model")!) === "Big Model [Recommended]", "the list checks the held model; the model in use stays pickable");

	// ---- a level set on a held pick's dial stands on it ----
	await mountControl({ held: { provider: "acme", model: "mid", level: "low" } });
	await until(() => trigger()?.getAttribute("aria-label") === "Model and effort: Mid Model Low", `the held level shows on the control: ${trigger()?.getAttribute("aria-label")}`);

	// ---- a slider that is off: focus on the name, nothing sent ----
	await mountControl({ effortDisabled: true });
	await click(trigger(), "the trigger");
	await until(() => $(".effort-slider") !== null, "the panel shows the dial");
	assert($(".effort-slider")?.getAttribute("aria-disabled") === "true" && focused()?.classList.contains("model-pick-effort-model"), `focus goes to the name while the slider is off: ${describeFocus()}`);
	await key($(".effort-slider"), "ArrowRight");
	assert(calls.length === 0, `a slider that is off sends nothing: ${calls.join(", ")}`);

	// ---- a one-rung model: the models view alone, Escape closes ----
	await mountControl({ current: { provider: "acme", model: "narrow", label: "acme/narrow" }, effort: { level: "off", ladder: ONE_RUNG } });
	await until(() => trigger()?.getAttribute("aria-label") === "Model: Narrow Model", `a one-rung model's control names the model alone: ${trigger()?.getAttribute("aria-label")}`);
	assert(!trigger()?.querySelector(".speedometer-icon"), "a one-rung model has no speedometer");
	await click(trigger(), "the trigger");
	await until(() => $(".model-pick-list-title") !== null, "a one-rung model's panel is the models view");
	assert(!$(".model-pick-back") && !$(".model-pick-effort"), "with no Back and no effort view");
	await key(focused(), "Escape");
	assert(!$(".model-pick-panel") && focused() === trigger(), `Escape closes it: ${describeFocus()}`);

	// ---- loading, a failed read with Try again, a failed refresh keeping the list, no models ----
	answer = "hang";
	await mountControl({ current: { provider: "acme", model: "narrow", label: "acme/narrow" }, effort: null });
	await click(trigger(), "the trigger");
	assert($(".model-pick-list")?.textContent === "Loading models…", `while it reads the list says so: ${$(".model-pick-list")?.textContent}`);
	answer = "fail";
	await mountControl({ current: { provider: "acme", model: "narrow", label: "acme/narrow" }, effort: null });
	await click(trigger(), "the trigger");
	await until(() => $(".model-pick-list [role=alert]") !== null, "a failed read says so");
	assert($(".model-pick-list [role=alert]")?.textContent === "The model list could not be read. Try again", `with the server's sentence and Try again: ${$(".model-pick-list")?.textContent}`);
	answer = "ok";
	await click($(".model-pick-list [role=alert] button"), "Try again");
	await until(() => $$(".model-pick-row").length === 5 && !$(".model-pick-list [role=alert]"), "Try again reads the list");
	await key(focused(), "Escape");
	answer = "fail";
	await click(trigger(), "the trigger");
	await until(() => $(".model-pick-list [role=alert]") !== null, "a failed refresh says so");
	assert($$(".model-pick-row").length === 5, "and keeps the last list");
	answer = "none";
	await mountControl({ current: { provider: "acme", model: "narrow", label: "acme/narrow" }, effort: null });
	await click(trigger(), "the trigger");
	await until(() => $(".model-pick-list-note") !== null && !$(".model-pick-list [role=status]"), "no models says so");
	assert($(".model-pick-list")?.textContent === "Sign in to an AI provider in Settings, AI setup, to choose a model.", `no models: ${$(".model-pick-list")?.textContent}`);
	answer = "ok";

	// ---- the phone: a modal bottom sheet ----
	await mountControl({ placement: "header" });
	await until(() => trigger()?.getAttribute("aria-label") === "Model and effort: Big Model Medium", "the header control names the model");
	await click(trigger(), "the trigger");
	await until(() => $(".model-pick-sheet .model-pick-effort-title") !== null, "the phone's panel is a sheet");
	assert($(".model-pick-sheet")?.getAttribute("aria-modal") === "true" && $(".model-pick-sheet")?.parentElement === doc.body, "the sheet is modal, over the page");
	await tab();
	assert(focused()?.classList.contains("model-pick-effort-model"), `Tab goes from the slider to the model's name: ${describeFocus()}`);
	await tab();
	assert(focused()?.classList.contains("effort-slider"), `Tab stays inside the sheet: ${describeFocus()}`);
	await tab(true);
	assert(focused()?.classList.contains("model-pick-effort-model"), `and Shift+Tab wraps back: ${describeFocus()}`);
	await key(focused(), "Escape");
	assert(!$(".model-pick-sheet") && focused() === trigger(), `Escape closes the sheet, focus on the header control: ${describeFocus()}`);
	unmountControl();

	// ---- the too-long window: switch, while the room answers, a room this save fills ----
	const cases = [null, 0, 18, 19, 20, 23].map((count) => { const shown = switchWindow.modelSwitchWindowCase(count, "Supplier Desk"); return `${count}=${shown.kind}${shown.sentence ? ` "${shown.sentence}"` : ""}`; }).join("\n");
	const expectedCases = [
		"null=switch",
		"0=switch",
		"18=switch",
		`19=remember-only "This save fills Supplier Desk: it will hold 20 conversations, as many as it can. Then Memorize them to start a new conversation."`,
		`20=remember-only "Supplier Desk now holds 20 conversations, as many as it can. Memorize them to start a new conversation."`,
		`23=remember-only "Supplier Desk now holds 23 conversations, as many as it can. Memorize them to start a new conversation."`,
	].join("\n");
	assert(cases === expectedCases, `the window's case by the room's waiting conversations:\n${cases}`);
	const windowCalls: string[] = [];
	async function windowLine(answering: boolean, waitingConversations: number | null): Promise<string> {
		const container = doc.createElement("div");
		doc.body.appendChild(container);
		const root = createRoot(container);
		windowCalls.length = 0;
		await act(async () => { root.render(createElement(switchWindow.ModelSwitchWindow, { modelName: "Short Model", roomName: "Supplier Desk", answering, waitingConversations, onCancel: () => windowCalls.push("cancel"), onSwitch: () => windowCalls.push("switch"), onRemember: () => windowCalls.push("remember") })); });
		const card = container.querySelector(".model-switch-card")!;
		const words = [...card.querySelectorAll("h2, p:not(.card-kicker), [role=status]")].map((node) => node.textContent).join(" | ");
		const buttons = [...card.querySelectorAll("button")].map((button) => `${button.textContent}${button.disabled ? "~" : ""}`).join(", ");
		const focus = focused()?.textContent;
		for (const button of [...card.querySelectorAll("button")].reverse()) await act(async () => { button.click(); });
		await act(async () => { doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
		act(() => root.unmount());
		container.remove();
		return `${words} || ${buttons} || focus ${focus} || ${windowCalls.join(", ")}`;
	}
	const ask = "Switch to Short Model? | This conversation is too long for Short Model. Remember it first, then continue in a new conversation on Short Model.";
	const fills = "Short Model needs a new conversation | This conversation is too long for Short Model. This save fills Supplier Desk: it will hold 20 conversations, as many as it can. Then Memorize them to start a new conversation.";
	const wait = "Stop or wait for the current response before remembering";
	const windows = [await windowLine(false, 3), await windowLine(true, 3), await windowLine(false, 19), await windowLine(true, 19)].join("\n");
	const expectedWindows = [
		`${ask} || Cancel, Remember and switch || focus Remember and switch || switch, cancel, cancel`,
		`${ask} | ${wait} || Cancel, Remember and switch~ || focus Cancel || cancel, cancel`,
		`${fills} || Cancel, Remember || focus Remember || remember, cancel, cancel`,
		`${fills} | ${wait} || Cancel, Remember~ || focus Cancel || cancel, cancel`,
	].join("\n");
	assert(windows === expectedWindows, `the window (words || buttons, ~ disabled || focus || clicks then Escape):\n${windows}`);

	// ---- the switch route's codes: only a coded refusal changed nothing ----
	const refusal = (code?: string) => modelsApi.conversationSwitchRefusal(new api.ApiRequestError("refused", code ? 409 : 500, code));
	const codes = ["switch_answering", "switch_remembering", "switch_too_long", "switch_room_busy", "switch_rebind_failed", undefined].map((code) => `${code}=${refusal(code)}`).join(", ");
	assert(codes === "switch_answering=switch_answering, switch_remembering=switch_remembering, switch_too_long=switch_too_long, switch_room_busy=switch_room_busy, switch_rebind_failed=null, undefined=null", `refusal codes: ${codes}`);
	assert(modelsApi.conversationSwitchRefusal(new TypeError("no answer")) === null, "a lost answer is no refusal: the conversation may have moved");

	console.log("model pick control smoke passed");
	process.exit(0);
} catch (error) {
	console.error((error as Error).message);
	process.exit(1);
}
