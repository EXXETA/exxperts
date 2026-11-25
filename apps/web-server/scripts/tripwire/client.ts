// The tripwire's way into its server: requests as the person's own browser
// makes them, and a room's conversation over a live connection.
import { authedFetch, SMOKE_AUTH_HEADERS, type AuthedFetchInit } from "../smoke-server-process.js";
import { waitForTurnSettled } from "../smoke-turn-settle.js";
import { waitEvery } from "../smoke-wait.js";
import { ANSWER_FLOOR_MS } from "../../src/room-box/card-text.js";
import { type Gateway, type Leg, MODEL } from "./model.js";

export const waitUntil = waitEvery(25, 30_000);

export function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

export type Answer = { status: number; body: any };

/** What the person at the computer answers each kind of card with. */
const CARD_ANSWERS: Readonly<Record<string, unknown>> = { outside: true, run: true, site: "decline", commands: true, folder: "choose" };

export function client(port: number, gateway: Gateway) {
	const base = `http://127.0.0.1:${port}`;
	async function request(pathname: string, init: AuthedFetchInit = {}): Promise<Answer> {
		const response = await authedFetch(`${base}${pathname}`, { ...init, headers: { ...(typeof init.body === "string" ? { "content-type": "application/json" } : {}), ...init.headers } });
		const text = await response.text();
		let body: any = text;
		try {
			body = text ? JSON.parse(text) : null;
		} catch {}
		return { status: response.status, body };
	}
	const send = (method: string, pathname: string, body?: unknown) => request(pathname, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
	/** A request that must succeed (a 2xx answer). */
	async function must(method: string, pathname: string, body?: unknown): Promise<any> {
		const answer = await send(method, pathname, body);
		assert(answer.status >= 200 && answer.status < 300, `${method} ${pathname} answered ${answer.status}: ${JSON.stringify(answer.body).slice(0, 300)}`);
		return answer.body;
	}

	let conversations = 0;
	// A room with no conversation yet has no turn to settle.
	const opened = new Set<string>();
	/** A conversation in a room over a live connection, as the computer's own window opens it. */
	async function openWindow(room: string) {
		if (opened.has(room)) await waitForTurnSettled(request, room, `${room}'s turn before has settled`);
		opened.add(room);
		const conversation = `conversation-${++conversations}`;
		await must("PUT", `/api/persistent-agents/${encodeURIComponent(room)}/threads/${conversation}`, { state: "active", origin: "launcher", model: MODEL, items: [] });
		const WebSocketImpl: any = (await import("ws")).default;
		const ws = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${encodeURIComponent(room)}&conversationId=${conversation}&modelProvider=${MODEL.provider}&model=${MODEL.model}&reattach=1`, { headers: { ...SMOKE_AUTH_HEADERS } });
		const frames: any[] = [];
		ws.addEventListener("message", (event: any) => {
			let frame: any;
			try {
				frame = JSON.parse(String(event.data));
			} catch {
				return;
			}
			frames.push(frame);
			// The person at the computer says yes to running a command outside (the way out), to a command in a room on Ask, to turning on commands and to changes in a folder the room can only read,
			// no to a site, and presses Choose a folder… on a folder card. After the floor, as a person reads first: a yes sooner is asked again.
			const answer = frame.type === "ui_request" ? CARD_ANSWERS[frame.kind] : undefined;
			if (answer !== undefined) setTimeout(() => ws.send(JSON.stringify({ type: "ui_response", id: frame.id, value: answer })), ANSWER_FLOOR_MS + 50);
		});
		await new Promise<void>((resolve, reject) => {
			ws.addEventListener("open", () => resolve());
			ws.addEventListener("error", () => reject(new Error("the live connection failed")));
		});
		const seen = (match: (frame: any) => boolean, label: string) => waitUntil(() => frames.some(match), `${label}; frames ${frames.map((frame) => frame.type).join(",")}`);
		await seen((frame) => frame.type === "ready", `${conversation} is ready`);
		const ends = () => frames.filter((frame) => frame.type === "event" && frame.event?.type === "agent_end").length;
		return {
			conversation,
			frames,
			/** A whole turn whose legs make these calls: what each call gave the model back, in order. */
			async turn(legs: Leg[]): Promise<string[]> {
				const before = ends();
				gateway.script(legs);
				ws.send(JSON.stringify({ type: "prompt", text: "Work in the folder." }));
				await seen(() => ends() > before, "the turn ended");
				const results = [...gateway.results()];
				await waitForTurnSettled(request, room, "the turn has settled");
				return results;
			},
			send: (message: unknown) => ws.send(JSON.stringify(message)),
			close: () => ws.close(),
		};
	}

	return { base, request, send, must, openWindow };
}
export type Client = ReturnType<typeof client>;
