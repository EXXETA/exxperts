// A stop, a restart or a kill mid-work loses nothing a person needs. A real server
// on a scratch home, with a turn in flight, goes through each way of ending, on
// the desktop and on a shared server, and a second server starts on the same disk:
// the rooms, the conversation, the notes, the attachments and the settings the
// person was told are saved are there, and the first turn works at once.
//
// - a clean stop: a stop signal, and the person comes back later on a new page.
// - a restart: the same signal, a new server the moment the old one exits, and the
//   open window reconnecting by itself and sending on that connection.
// - a kill: SIGKILL, nothing runs after it.
//
// Beside those: every case in restart-known-cases.ts. The locks a kill can leave
// are in restart-lock-rows-smoke.ts and restart-lock-rows-shared-smoke.ts, since
// the runner stops any smoke at its time limit. RESTART_ONLY=<part of a row's name>
// runs some.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENT, EDITIONS, THREAD, answerIsHeld, endChild, exited, firstTurnProblems, lanes, lastMessagesHeard, pool, readJsonAnswer, releaseAnswer, roomProblems, roomUrl, runRestartParts, runStep, sendTurn, startServer, templateCopy, traceSave, waitReady, wanted, type Answer, type Child, type Run, type Save, type TraceStep } from "./kill-at-write-harness.js";
import { KNOWN_CASES, PIECE_WRITES, SETTLED_CASES, type KnownCase, type SettledCase } from "./restart-known-cases.js";
import { STOP_CUT_ANSWER_SENTENCE } from "../src/turn-ended-by.js";
import { authedFetch, freePort, SMOKE_AUTH_HEADERS, putRunWithoutAsking } from "./smoke-server-process.js";
import { waitEvery, type WaitCondition } from "./smoke-wait.js";

if (os.platform() === "win32") {
	console.log("SKIPPED: not yet on a real Windows PC: it ran past 300 seconds there");
	process.exit(0);
}

const WebSocketImpl: any = (await import("ws")).default;
const waitUntil = waitEvery(20);

const WAYS = ["clean stop", "restart", "kill"] as const;
type Way = (typeof WAYS)[number];

const json = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const threadItems = async (run: Run): Promise<any[]> => (await readJsonAnswer(roomUrl(run, `/threads/${THREAD}`))).body?.thread?.items ?? [];
const roomIdle = (run: Run, what: string) => waitUntil(async () => (await readJsonAnswer(roomUrl(run, "/status"))).body?.activeThread?.inFlight === false, `${what}: the room is idle`);

interface RoomWindow {
	frames: any[];
	send(frame: unknown): void;
	ready: Promise<any>;
	closed(): boolean;
	close(): Promise<void>;
}

/** The page's live connection. Its `ready` rejects when the connection never opens. */
function openWindow(run: Run): RoomWindow {
	const frames: any[] = [];
	const socket = new WebSocketImpl(`${run.base.replace("http", "ws")}/ws?persistentAgentId=${AGENT}&conversationId=${THREAD}`, { headers: { ...SMOKE_AUTH_HEADERS } });
	let isClosed = false;
	const closed = new Promise<void>((resolve) => socket.on("close", () => { isClosed = true; resolve(); }));
	const ready = new Promise<any>((resolve, reject) => {
		socket.on("error", reject);
		socket.on("close", () => reject(new Error("the connection closed before it was ready")));
		socket.on("message", (data: unknown) => {
			const frame = JSON.parse(String(data));
			frames.push(frame);
			if (frame.type === "ready") resolve(frame);
		});
	});
	ready.catch(() => undefined);
	return { frames, send: (frame) => socket.send(JSON.stringify(frame)), ready, closed: () => isClosed, close: () => { socket.close(); return closed; } };
}

/** Waits a moment for a change a known case may never make, so a case that gets fixed cannot be read before its change lands. */
const within = (changed: WaitCondition) => waitUntil(changed, "the change", 1_500).catch(() => undefined);

const turnEnded = (window: RoomWindow, from = 0) => window.frames.slice(from).some((frame) => frame.event?.type === "agent_end");

/** One finished turn: a conversation's first request ends on a context message, not on the person's words, and the fake model reads the last message. */
async function firstExchange(run: Run): Promise<void> {
	const answer = await sendTurn(run, "A first question.");
	if (answer.status >= 300) throw new Error(`a turn failed before any stop: ${answer.status}`);
	await roomIdle(run, "the first exchange");
}

/** A turn sent as the page sends it, held by the fake model until released. */
async function heldTurn(run: Run, hold: string, id: string): Promise<RoomWindow> {
	await firstExchange(run);
	const window = openWindow(run);
	await window.ready;
	window.send({ type: "prompt", text: `Please ${hold} now.`, id, shown: `Please ${hold} now.` });
	await waitUntil(() => answerIsHeld(hold), `the fake model holds ${hold}`);
	return window;
}

/** The page's save of what it shows: the saved conversation and these items after it. */
async function savePage(run: Run, ...added: object[]): Promise<void> {
	const { thread } = (await readJsonAnswer(roomUrl(run, `/threads/${THREAD}`))).body;
	const saved = await authedFetch(roomUrl(run, `/threads/${THREAD}`), json("PUT", { state: thread.state, origin: thread.origin, items: [...thread.items, ...added] }));
	if (saved.status >= 300) throw new Error(`the page's save was refused: ${saved.status} ${await saved.text()}`);
}

const saveBubble = (run: Run, id: string, text: string) => savePage(run, { kind: "user", id, text });

/** A server on a fresh copy of the prepared data folder, and how to end it and start the next one on the same disk. */
async function onServer<T>(name: string, edition: Pick<Save, "sharedServer">, work: (run: Run, first: Child, restart: (way?: Way) => Promise<void>) => Promise<T>): Promise<T> {
	const folder = templateCopy(name.replace(/\W+/g, "-"));
	const home = path.join(folder, "home");
	const port = await freePort();
	const run: Run = { home, base: `http://127.0.0.1:${port}` };
	const children: Child[] = [startServer(edition, home, port)];
	const latest = () => children[children.length - 1];
	const restart = async (way: Way = "clean stop") => {
		latest().process.kill(way === "kill" ? "SIGKILL" : "SIGTERM");
		await exited(latest());
		children.push(startServer(edition, home, port));
		if (way !== "restart") await waitReady(latest(), run);
	};
	try {
		await waitReady(latest(), run);
		return await work(run, latest(), restart);
	} finally {
		for (const child of children) await endChild(child);
		fs.rmSync(folder, { recursive: true, force: true, maxRetries: 5 });
	}
}

// --- What the person was told is saved ------------------------------------------

const TEST_INSTRUCTIONS = "Always answer in short sentences.";
const ROOM_INSTRUCTIONS = "Keep each answer to one paragraph.";

interface KeptThing { name: string; save(run: Run): Promise<void>; problems(run: Run): Promise<string[]> }

/** Each thing a person saves through its route, and what must still be there after any end. */
function keptThings(all: Save[], edition: Pick<Save, "sharedServer">): KeptThing[] {
	const bySave = (name: string): KeptThing => {
		const save = all.find((entry) => entry.name === name)!;
		return {
			name,
			save: async (run) => {
				const answer = await save.send(run);
				if (answer.status >= 300) throw new Error(`${name} was refused before any stop: ${answer.status}`);
			},
			problems: (run) => save.afterRetry(run, { status: 200 }),
		};
	};
	return [
		bySave("add"),
		bySave("upload"),
		bySave("create"),
		// A shared server serves no command settings, so its room setting is the room's instructions.
		edition.sharedServer ? {
			name: "a room setting",
			save: async (run) => {
				const saved = await authedFetch(roomUrl(run, "/instructions"), json("PUT", { text: ROOM_INSTRUCTIONS }));
				if (saved.status >= 300) throw new Error(`the room's instructions were refused before any stop: ${saved.status}`);
			},
			problems: async (run) => (await readJsonAnswer(roomUrl(run, "/instructions"))).body?.instructions?.text?.includes(ROOM_INSTRUCTIONS) ? [] : ["the room's instructions are gone"],
		} : {
			name: "a room setting",
			save: async (run) => void await putRunWithoutAsking(roomUrl(run, "/bash-settings"), true),
			problems: async (run) => (await readJsonAnswer(roomUrl(run, "/bash-settings"))).body?.settings?.autoApprove === true ? [] : ["the room setting is gone"],
		},
		{
			name: "a setting of the app",
			save: async (run) => void await authedFetch(`${run.base}/api/settings/instructions`, json("PUT", { text: TEST_INSTRUCTIONS })),
			problems: async (run) => JSON.stringify((await readJsonAnswer(`${run.base}/api/settings/instructions`)).body?.instructions ?? "").includes(TEST_INSTRUCTIONS) ? [] : ["the app's instructions are gone"],
		},
		{
			name: "a finished turn",
			save: async (run) => {
				const answer = await sendTurn(run, "A finished question.");
				if (answer.status >= 300) throw new Error(`a turn failed before any stop: ${answer.status}`);
				await roomIdle(run, "the finished turn");
			},
			problems: async (run) => {
				const items = await threadItems(run);
				return items.some((item) => item.text === "A finished question.") && items.some((item) => item.text === "A fresh answer.") ? [] : ["the finished conversation is gone"];
			},
		},
	];
}

/** The open window of a restart: it asks until the new server answers, then sends on that connection. */
async function reconnected(run: Run): Promise<RoomWindow> {
	let window: RoomWindow | undefined;
	await waitUntil(async () => {
		const next = openWindow(run);
		try {
			await next.ready;
			window = next;
			return true;
		} catch {
			return false;
		}
	}, "the window reconnected");
	return window!;
}

async function turnOnWindow(window: RoomWindow): Promise<Answer> {
	const from = window.frames.length;
	window.send({ type: "prompt", text: "The first question after.", id: "first_after", shown: "The first question after." });
	await waitUntil(() => turnEnded(window, from) || window.frames.slice(from).some((frame) => frame.type === "error"), "the first turn ended");
	const heard = JSON.stringify(window.frames.slice(from));
	return { status: heard.includes("A fresh answer.") ? 200 : 500 };
}

async function wayRow(edition: (typeof EDITIONS)[number], way: Way, all: Save[]): Promise<string[]> {
	const kept = keptThings(all, edition);
	const hold = `hold-answer-${edition.sharedServer ? "shared" : "desktop"}-${way.replace(" ", "-")}`;
	const bubble = `held_${edition.sharedServer ? "shared" : "desktop"}_${way.replace(" ", "_")}`;
	return onServer(`row-${hold}`, edition, async (run, _first, restart) => {
		for (const thing of kept) await thing.save(run);
		const window = await heldTurn(run, hold, bubble);
		await saveBubble(run, bubble, `Please ${hold} now.`);
		await restart(way);
		const problems: string[] = [];
		let turn: () => Promise<Answer> = () => sendTurn(run, "The first question after.");
		if (way === "restart") {
			const back = await reconnected(run);
			turn = () => turnOnWindow(back);
		}
		problems.push(...await firstTurnProblems(run, turn));
		await roomIdle(run, "the first turn");
		problems.push(...await roomProblems(run));
		for (const thing of kept) problems.push(...(await thing.problems(run)).map((problem) => `${thing.name}: ${problem}`));
		const items = await threadItems(run);
		if (items.filter((item) => item.id === bubble).length !== 1) problems.push(`the message in flight is there ${items.filter((item) => item.id === bubble).length} times`);
		const lines = items.filter((item) => String(item.id).startsWith(bubble) && item.kind === "system" && item.text === STOP_CUT_ANSWER_SENTENCE).length;
		if (lines !== 1) problems.push(`the line that says the answer stopped is there ${lines} times`);
		await window.close();
		return problems;
	});
}

// --- The known cases -------------------------------------------------------------------

const STOPPED_LINE = "stopped by the person";

type Edition = (typeof EDITIONS)[number];
/** One piece on one edition across one end: whether the piece is lost. */
type EndProbe = (way: Way, edition: Edition, tag: string) => Promise<boolean>;

/** A word for one edition and end, for the fake model's hold and refuse words and the server's folder: probes run side by side. */
const tagOf = (way: Way, edition: Edition) => `${edition.sharedServer ? "shared" : "desktop"}-${way.replace(" ", "-")}`;
const keyOf = (tag: string) => tag.replaceAll("-", "_");

/** Runs a piece's probe across these ends on both editions: it fails when any does, and says which. */
function acrossEnds(ways: readonly Way[], probe: EndProbe): () => Promise<boolean> {
	return async () => {
		const lost: string[] = [];
		await pool(EDITIONS.flatMap((edition) => ways.map((way) => ({ edition, way }))), 2, async ({ edition, way }) => {
			if (await probe(way, edition, tagOf(way, edition))) lost.push(`${edition.name} ${way}`);
		});
		if (lost.length) console.log(`  lost across: ${lost.join(", ")}`);
		return lost.length > 0;
	};
}

/** The window's ready frame, and the window closed. */
async function readyOf(window: RoomWindow): Promise<any> {
	const ready = await window.ready;
	await window.close();
	return ready;
}

/** What a window that comes back after the end is told: the new server's first answer. */
const toldAfter = async (run: Run) => readyOf(await reconnected(run));

/** A message sent into a held answer, taken in at the answer's end: its id. */
async function takenSteer(run: Run, tag: string): Promise<string> {
	const hold = `hold-answer-taken-${tag}`;
	const id = `steer_${keyOf(tag)}`;
	const window = await heldTurn(run, hold, `held_taken_${keyOf(tag)}`);
	window.send({ type: "steer", id, text: "And one more thing.", shown: 0 });
	await waitUntil(() => window.frames.some((frame) => frame.type === "steer_waiting"), "the message waits for the step");
	releaseAnswer(hold);
	await waitUntil(() => window.frames.some((frame) => frame.type === "steer_taken"), "the turn took the message");
	await waitUntil(() => turnEnded(window), "the turn ended");
	await roomIdle(run, "the taken turn");
	await window.close();
	if (!(await readyOf(openWindow(run))).taken.includes(id)) throw new Error("without an end a new window is not told the taken message");
	return id;
}

/** A Stop on a held answer after its first words, then the next question after `between`: whether the model heard the note. */
async function stopThenAsk(run: Run, hold: string, word: string, between: () => Promise<void>): Promise<boolean> {
	const window = await heldTurn(run, hold, hold.replaceAll("-", "_"));
	await waitUntil(() => JSON.stringify(window.frames).includes("A held answer begins."), "the first words reached the window");
	window.send({ type: "abort", shown: 6 });
	await waitUntil(() => turnEnded(window), "the Stop ended the turn");
	await roomIdle(run, "the stopped turn");
	await window.close();
	await between();
	const answer = await sendTurn(run, `The next question ${word}.`);
	if (answer.status >= 300) throw new Error(`the next turn failed: ${answer.status}`);
	await roomIdle(run, "the next turn");
	return heardNote(word);
}

const heardNote = (word: string) => lastMessagesHeard.filter((message) => message.includes(word)).some((message) => message.includes(STOPPED_LINE));

/** A message the room offers back: the fake model refuses it. */
async function offeredBack(run: Run, word: string, id: string): Promise<void> {
	const window = openWindow(run);
	await window.ready;
	window.send({ type: "prompt", text: `Please ${word} now.`, id, shown: `Please ${word} now.` });
	await waitUntil(() => window.frames.some((frame) => frame.type === "prompt_returned"), "the room offers the message back");
	await roomIdle(run, "the refused turn");
	await window.close();
}

/** The page's answer to the offer, from a window that comes back after the end: whether the attempt landed. */
async function answerOffer(run: Run, id: string, kept: boolean): Promise<boolean> {
	const window = await reconnected(run);
	window.send({ type: "returned_prompt_handled", kept });
	const landed = async () => (await threadItems(run)).some((item) => String(item.id).startsWith(id));
	await within(landed);
	await window.close();
	return landed();
}

/** A keyed turn sent as the page sends it, answered and landed. */
async function keyedTurnOnWindow(run: Run, key: string, text = "A question to answer."): Promise<void> {
	const window = openWindow(run);
	await window.ready;
	window.send({ type: "prompt", text, id: key, shown: text });
	await waitUntil(() => turnEnded(window), "the keyed turn ended");
	await roomIdle(run, "the keyed turn");
	await window.close();
}

const stopLines = (items: any[], key: string) => items.filter((item) => item.kind === "system" && String(item.id).startsWith(`${key}-`) && item.text === STOP_CUT_ANSWER_SENTENCE);

/**
 * A turn held mid-answer and the server killed: the items the next server
 * reads. The page saves half a second after its last change, so while an
 * answer streams it has saved nothing of the turn, its message included.
 */
async function killedMidAnswer(run: Run, restart: (way?: Way) => Promise<void>, hold: string, key: string): Promise<any[]> {
	await heldTurn(run, hold, key);
	await restart("kill");
	return threadItems(run);
}

/** The save of a window that held the conversation before the kill and closed before it read it again: without these lines, and nothing in it marked. */
async function staleSave(run: Run, items: any[], lines: any[]): Promise<void> {
	const stale = await authedFetch(roomUrl(run, `/threads/${THREAD}`), json("PUT", { state: "active", origin: "unknown", items: items.filter((item) => !lines.includes(item)).map(({ landed: _mark, ...item }) => item) }));
	if (stale.status >= 300) throw new Error(`the stale save was refused: ${stale.status}`);
}

/** The cases: each answers whether it fails today, after showing its allowed neighbour holds on a server that did not end. */
const PROBES: Record<string, (all: Save[]) => Promise<boolean>> = {
	"killed-turn-says-nothing": acrossEnds(["kill"], (_way, edition, tag) => onServer(`case-killed-${tag}`, edition, async (run, _first, restart) => {
		const key = `held_killed_${keyOf(tag)}`;
		const items = await killedMidAnswer(run, restart, `hold-answer-killed-${tag}`, key);
		const lines = stopLines(items, key);
		// The message once, as the bubble showed it, and the line right under it: nothing of the answer was saved.
		const message = items.filter((item) => item.id === key && item.kind === "user" && item.text === `Please hold-answer-killed-${tag} now.`);
		if (lines.length !== 1 || message.length !== 1 || items.indexOf(lines[0]) !== items.indexOf(message[0]) + 1) return true;
		// A window closed as the server came back saves the copy it had, without the line: the line stays.
		await staleSave(run, items, lines);
		return stopLines(await threadItems(run), key).length !== 1;
	})),
	"taken-message-sent-again": acrossEnds(WAYS, (way, edition, tag) => onServer(`case-taken-${tag}`, edition, async (run, _first, restart) => {
		const id = await takenSteer(run, tag);
		await restart(way);
		return !(await toldAfter(run)).taken.includes(id);
	})),
	"stop-note-lost": acrossEnds(WAYS, (way, edition, tag) => onServer(`case-note-${tag}`, edition, async (run, _first, restart) => {
		if (!await stopThenAsk(run, `hold-answer-note-one-${tag}`, `note-word-one-${tag}`, async () => undefined)) throw new Error("without an end the next message carries no note");
		return !await stopThenAsk(run, `hold-answer-note-two-${tag}`, `note-word-two-${tag}`, async () => { await restart(way); await (await reconnected(run)).close(); });
	})),
	"stopped-words-come-back": () => onServer("case-cut", {}, async (run, _first, restart) => {
		const part = await landedPart(run, "case_cut");
		const whole = await threadItems(run);
		await cutPart(run, part);
		const save = () => authedFetch(roomUrl(run, `/threads/${THREAD}`), json("PUT", { state: "active", origin: "home", items: whole }));
		await save();
		if (await partWords(run, part) !== "A fre") throw new Error(`without a restart a later save reads ${await partWords(run, part)}`);
		await restart();
		await save();
		return await partWords(run, part) === "A fresh answer.";
	}),
	"late-stop-cuts-nothing": acrossEnds(WAYS, (way, edition, tag) => onServer(`case-late-${tag}`, edition, async (run, _first, restart) => {
		const part = await landedPart(run, `late_${keyOf(tag)}`);
		await restart(way);
		await cutPart(run, part);
		return await partWords(run, part) === "A fresh answer.";
	})),
	"kept-message-lands-nothing": acrossEnds(WAYS, (way, edition, tag) => onServer(`case-kept-${tag}`, edition, async (run, _first, restart) => {
		await firstExchange(run);
		await offeredBack(run, `refuse-answer-kept-one-${tag}`, "kept_one");
		if (!await answerOffer(run, "kept_one", true)) throw new Error("without an end the kept message lands nothing");
		await offeredBack(run, `refuse-answer-kept-two-${tag}`, "kept_two");
		await restart(way);
		return !await answerOffer(run, "kept_two", true);
	})),

	// Each piece ends when its reason ends, and a restart does not bring it back.
	"killed-turn-line-once": () => onServer("ends-killed", {}, async (run, _first, restart) => {
		const first = await killedMidAnswer(run, restart, "hold-answer-ends-killed", "ends_killed");
		if (stopLines(first, "ends_killed").length !== 1) throw new Error("the killed turn has no line to begin with");
		// A later turn finishes, and the server is killed after it: that turn ended, so nothing is said under it.
		await keyedTurnOnWindow(run, "ends_later", "A later question.");
		await restart("kill");
		const items = await threadItems(run);
		return stopLines(items, "ends_killed").length !== 1 || items.some((item) => item.kind === "system" && String(item.id).startsWith("ends_later-"));
	}),
	// A Try again has no message of its own: its line goes under the item it continued.
	"killed-try-again-line": () => onServer("ends-try-again", {}, async (run, _first, restart) => {
		await firstExchange(run);
		const window = openWindow(run);
		await window.ready;
		// A message with a file stays above when its answer fails, and Try again continues it.
		const question = "Please refuse-once-answer-try-again now.";
		window.send({ type: "prompt", text: `[FILE ATTACHED: notes.md]\n${question}`, id: "try_failed", shown: { text: question, files: [{ name: "notes.md", bytes: 12, extension: "md" }] } });
		await waitUntil(() => turnEnded(window), "the refused turn ended");
		await roomIdle(run, "the refused turn");
		const before = await threadItems(run);
		window.send({ type: "continue", id: "try_again" });
		await waitUntil(() => answerIsHeld("refuse-once-answer-try-again"), "the fake model holds the Try again");
		await restart("kill");
		const items = await threadItems(run);
		const lines = stopLines(items, "try_again");
		return lines.length !== 1 || items.at(-1) !== lines[0] || items.length !== before.length + 1;
	}),
	// A window open across the kill keeps its own copy of an item of its turn the server did not mark landed
	// (apps/web-ui/src/room-thread-items.ts `withShownTurn`): the part the page saved stays unmarked, so that window keeps
	// the longer copy it shows. The line is marked, so a window closed before it read the line saves without it and the line stays.
	"killed-line-keeps-page-copy": () => onServer("ends-copy", {}, async (run, _first, restart) => {
		await heldTurn(run, "hold-answer-ends-copy", "ends_copy");
		await savePage(run, { kind: "user", id: "ends_copy", text: "Please hold-answer-ends-copy now." }, { kind: "assistant", id: "ends_copy-a1", text: "A held" });
		await restart("kill");
		const items = await threadItems(run);
		const lines = stopLines(items, "ends_copy");
		const part = items.findIndex((item) => item.id === "ends_copy-a1");
		const question = items.find((item) => item.id === "ends_copy");
		if (lines.length !== 1 || items.indexOf(lines[0]) !== part + 1 || question?.landed !== true || items[part]?.landed === true) return true;
		await staleSave(run, items, lines);
		return stopLines(await threadItems(run), "ends_copy").length !== 1;
	}),
	"taken-message-ends": () => onServer("ends-taken", {}, async (run, _first, restart) => {
		const id = await takenSteer(run, "ends");
		// The next turn settles the last one's messages: none is told again.
		const answer = await sendTurn(run, "A later question.");
		if (answer.status >= 300) throw new Error(`the later turn failed: ${answer.status}`);
		await roomIdle(run, "the later turn");
		await restart();
		return (await toldAfter(run)).taken.includes(id);
	}),
	"stop-note-ends": () => onServer("ends-note", {}, async (run, _first, restart) => {
		// The message that carries the note is killed mid-answer, before its turn settles: the note went with it.
		const window = await heldTurn(run, "hold-answer-ends-note", "ends_note_stopped");
		await waitUntil(() => JSON.stringify(window.frames).includes("A held answer begins."), "the first words reached the window");
		window.send({ type: "abort", shown: 6 });
		await waitUntil(() => turnEnded(window), "the Stop ended the turn");
		await roomIdle(run, "the stopped turn");
		window.send({ type: "prompt", text: "Please hold-answer-ends-note-carried now.", id: "ends_note_carried", shown: "Please hold-answer-ends-note-carried now." });
		await waitUntil(() => answerIsHeld("hold-answer-ends-note-carried"), "the fake model holds the next answer");
		if (!heardNote("hold-answer-ends-note-carried")) throw new Error("the next message carries no note to begin with");
		await restart("kill");
		const answer = await sendTurn(run, "The next question ends-note-after.");
		if (answer.status >= 300) throw new Error(`the turn after failed: ${answer.status}`);
		return heardNote("ends-note-after");
	}),
	"late-stop-only-newest": () => onServer("ends-late", {}, async (run, _first, restart) => {
		const older = await landedPart(run, "ends_older");
		const newer = await landedPart(run, "ends_newer");
		await restart();
		await cutPart(run, older);
		await cutPart(run, newer);
		if (await partWords(run, newer) !== "A fre") throw new Error(`a Stop on the newest answer reads ${await partWords(run, newer)}`);
		return await partWords(run, older) !== "A fresh answer.";
	}),
	"kept-landing-ends": () => onServer("ends-kept", {}, async (run, _first, restart) => {
		await firstExchange(run);
		// Answered "not kept": a later "kept", after a restart, lands nothing.
		await offeredBack(run, "refuse-answer-ends-handed", "ends_handed");
		if (await answerOffer(run, "ends_handed", false)) throw new Error("a message not kept landed its attempt");
		await restart();
		if (await answerOffer(run, "ends_handed", true)) return true;
		// Never answered, and the person sent another message: the offer ended with it.
		await offeredBack(run, "refuse-answer-ends-later", "ends_later");
		const answer = await sendTurn(run, "A later question.");
		if (answer.status >= 300) throw new Error(`the later turn failed: ${answer.status}`);
		await roomIdle(run, "the later turn");
		await restart();
		return answerOffer(run, "ends_later", true);
	}),
};

async function landedPart(run: Run, key: string): Promise<string> {
	await keyedTurnOnWindow(run, key);
	const part = (await threadItems(run)).find((item) => String(item.id).startsWith(`${key}-a`));
	if (!part) throw new Error("the keyed turn landed no part");
	return part.id;
}

/** A Stop on a landed part, from a window that comes back after any end. */
async function cutPart(run: Run, part: string): Promise<void> {
	const window = await reconnected(run);
	const before = await partWords(run, part);
	window.send({ type: "stop_reveal", itemId: part, shown: 5 });
	await within(async () => await partWords(run, part) !== before);
	await window.close();
}

const partWords = async (run: Run, part: string) => (await threadItems(run)).find((item) => item.id === part)?.text;

// --- Each piece's own write, cut by a kill ---------------------------------------------

/** What the next turn needs after any kill: the turn works at once and the room is whole. */
async function nextTurnProblems(run: Run, answer: Answer): Promise<string[]> {
	return [...(answer.status < 300 ? [] : [`the same again failed: ${answer.status}`]), ...await firstTurnProblems(run, () => sendTurn(run, "The first question after.")), ...await roomProblems(run)];
}

/** Fails fast once the window's connection is gone: a save the kill cuts must not wait out the deadline. */
const onWindow = (window: RoomWindow, holds: () => boolean, what: string) => waitUntil(() => {
	if (window.closed()) throw new Error("the connection closed");
	return holds();
}, what);

/** Counts the words and ids the saves make, so a save sent again uses fresh ones. */
let holdsMade = 0;
const pieceSave = (name: string, send: Save["send"]): Save => ({ name, send, alwaysAgain: true, afterRestart: roomProblems, afterRetry: nextTurnProblems });

/** The saves that write each piece, for the kill-at-write harness; PIECE_WRITES in restart-known-cases.ts names the write each is cut at. */
const PIECE_SAVES: Save[] = [
	pieceSave("keyed-turn", async (run) => {
		const window = openWindow(run);
		await window.ready;
		window.send({ type: "prompt", text: "A keyed question.", id: "kill_keyed", shown: "A keyed question." });
		await onWindow(window, () => turnEnded(window), "the keyed turn ended");
		await roomIdle(run, "the keyed turn");
		await window.close();
		return { status: 200 };
	}),
	pieceSave("taken-message", async (run) => {
		await firstExchange(run);
		const window = openWindow(run);
		await window.ready;
		// A word of its own each time: the fake model keeps a released hold, and the try again must wait for its own.
		const hold = `hold-answer-kill-taken-${++holdsMade}`;
		window.send({ type: "prompt", text: `Please ${hold} now.`, id: "kill_taken", shown: `Please ${hold} now.` });
		await onWindow(window, () => answerIsHeld(hold), "the fake model holds the answer");
		window.send({ type: "steer", id: "kill_steer", text: "And one more thing.", shown: 0 });
		await onWindow(window, () => window.frames.some((frame) => frame.type === "steer_waiting"), "the message waits for the step");
		releaseAnswer(hold);
		await onWindow(window, () => turnEnded(window), "the turn ended");
		await roomIdle(run, "the taken turn");
		await window.close();
		return { status: 200 };
	}),
	pieceSave("stop-note", async (run) => {
		await firstExchange(run);
		const window = openWindow(run);
		await window.ready;
		window.send({ type: "prompt", text: "Please hold-answer-kill-note now.", id: "kill_note", shown: "Please hold-answer-kill-note now." });
		await onWindow(window, () => JSON.stringify(window.frames).includes("A held answer begins."), "the first words reached the window");
		window.send({ type: "abort", shown: 6 });
		await onWindow(window, () => turnEnded(window), "the Stop ended the turn");
		await roomIdle(run, "the stopped turn");
		await window.close();
		return { status: 200 };
	}),
	pieceSave("kept-landing", async (run) => {
		await firstExchange(run);
		const window = openWindow(run);
		await window.ready;
		// An id of its own each time, as the page gives every message: a key a conversation used once is used up, a restart or not.
		const id = `kill_kept_${++holdsMade}`;
		window.send({ type: "prompt", text: "Please refuse-answer-kill-kept now.", id, shown: "Please refuse-answer-kill-kept now." });
		await onWindow(window, () => window.frames.some((frame) => frame.type === "prompt_returned"), "the room offers the message back");
		await roomIdle(run, "the refused turn");
		window.send({ type: "returned_prompt_handled", kept: true });
		await waitUntil(async () => (await threadItems(run)).some((item) => String(item.id).startsWith(id)), "the kept attempt landed");
		await window.close();
		return { status: 200 };
	}),
];

/** What is wrong between the probes' results and the list. */
function caseProblems(results: ReadonlyMap<string, boolean>, listed: readonly Pick<KnownCase, "id">[]): string[] {
	const ids = new Set(listed.map((known) => known.id));
	const problems: string[] = [];
	for (const [id, fails] of results) {
		if (fails && !ids.has(id)) problems.push(`${id} still fails and has no line in restart-known-cases.ts: put its line back, or fix it`);
		if (!fails && ids.has(id)) problems.push(`${id} no longer fails: take its line off restart-known-cases.ts`);
	}
	return problems;
}

function caseListRows(): string[] {
	const line = [{ id: "a-case" }];
	const rows: Array<[string, boolean]> = [
		["a listed case that fails is fine", caseProblems(new Map([["a-case", true]]), line).length === 0],
		["a listed case that no longer fails is refused", caseProblems(new Map([["a-case", false]]), line).some((problem) => problem.includes("no longer fails"))],
		["a case taken off while it fails is refused", caseProblems(new Map([["a-case", true]]), []).some((problem) => problem.includes("has no line"))],
		["a passing case with no line is fine", caseProblems(new Map([["a-case", false]]), []).length === 0],
	];
	return rows.filter(([, held]) => !held).map(([name]) => `the case check: ${name}`);
}

async function caseRows(all: Save[]): Promise<string[]> {
	const problems = [...caseListRows()];
	const unprobed = KNOWN_CASES.filter((known) => !PROBES[known.id]);
	problems.push(...unprobed.map((known) => `${known.id} has no probe in restart-rows-smoke.ts`));
	const results = new Map<string, boolean>();
	const ids = Object.keys(PROBES).filter(wanted);
	await pool(ids, lanes, async (id) => {
		const started = Date.now();
		try {
			const fails = await PROBES[id](all);
			results.set(id, fails);
			console.log(`case ${id}: ${fails ? "fails" : "passes"} (${Math.round((Date.now() - started) / 1000)}s)`);
		} catch (error) {
			problems.push(`case ${id} could not be checked: ${(error as Error).message}`);
		}
	});
	return [...problems, ...caseProblems(results, KNOWN_CASES.filter((known) => results.has(known.id)))];
}

async function settledRows(harnessSaves: Save[]): Promise<string[]> {
	const problems: string[] = [];
	const all = [...harnessSaves, ...PIECE_SAVES];
	const cases = [...SETTLED_CASES, ...PIECE_WRITES].filter((entry) => wanted(entry.id));
	const saveOf = (entry: SettledCase): Save => ({ ...all.find((candidate) => candidate.name === entry.save)!, sharedServer: entry.sharedServer });
	const traces = new Map<string, TraceStep[]>();
	for (const entry of cases) {
		const key = `${entry.save} ${entry.sharedServer ?? false}`;
		if (!traces.has(key)) traces.set(key, await traceSave({ ...saveOf(entry), kills: undefined }));
	}
	await pool(cases, lanes, async (entry, lane) => {
		const step = traces.get(`${entry.save} ${entry.sharedServer ?? false}`)!.find((candidate) => candidate.op === entry.op && entry.target.test(candidate.target));
		if (!step) {
			problems.push(`${entry.id}: no ${entry.op} on ${entry.target} in today's trace, so its line says nothing: find its step again`);
			return;
		}
		const line = `KILL_ONLY=${entry.save}:${step.step}:${entry.how}${entry.killSmoke ? ` ${entry.killSmoke}` : ""}`;
		const result = await runStep(saveOf(entry), step.step, entry.how, lane);
		if (!result.landed) problems.push(`${entry.id}: the kill never came`);
		problems.push(...result.problems.map((problem) => `${entry.id} (${line}): ${problem}`));
		console.log(`settled ${entry.id}: ${line}: ${result.problems.length ? "fails" : "passes"}`);
	});
	return problems;
}

await runRestartParts("restart rows", async (part, all) => {
	const rows = EDITIONS.flatMap((edition) => WAYS.map((way) => ({ edition, way })));
	await pool(rows, Math.min(lanes, 3), async ({ edition, way }) => part(`row ${edition.name} ${way}`, () => wayRow(edition, way, all)));
	await part("known cases", () => caseRows(all), Object.keys(PROBES).some(wanted));
	await part("settled cases and piece writes", () => settledRows(all), [...SETTLED_CASES, ...PIECE_WRITES].some((entry) => wanted(entry.id)));
});
