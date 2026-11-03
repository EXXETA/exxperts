import { waitEvery } from "./smoke-wait.js";

// The settle wait the room smokes share. agent_end reaches the socket before
// the server has settled the turn, and until then the next conversation's
// window can be turned away as the room still answering (room_cooking), so a
// smoke that goes on in the same room waits here until the room's status
// shows no turn in flight. Each smoke passes its own authed request helper.
export type SmokeRequestJson = (pathname: string) => Promise<{ status: number; body: any }>;

const waitUntil = waitEvery(50);

export async function waitForTurnSettled(requestJson: SmokeRequestJson, agentId: string, label: string, timeoutMs = 20_000): Promise<void> {
	let seen = "none read";
	await waitUntil(async () => {
		const status = await requestJson(`/api/persistent-agents/${encodeURIComponent(agentId)}/status`);
		seen = JSON.stringify(status.body?.activeThread ?? null).slice(0, 400);
		return status.status === 200 && status.body?.activeThread?.inFlight === false;
	}, label, timeoutMs).catch((error: Error) => { throw new Error(`${error.message}; the room's active thread: ${seen}`, { cause: error }); });
}
