// A page's room connection in a browser smoke, passed through to the real
// server, with a way to hand the page a frame of the smoke's own (a question
// the room asks, say) and a count of the server's ready frames. Route it
// before the page opens its connection.
import type { Page } from "playwright";

export interface PageSocket {
	/** Hands the page a frame as if the server had sent it. */
	send(frame: unknown): void;
	/** How many ready frames the server has sent the page. */
	readies(): number;
}

export async function routePageSocket(page: Page): Promise<PageSocket> {
	let pageSocket: { send(message: string): void } | undefined;
	let readies = 0;
	await page.routeWebSocket(/\/ws\?/, (ws) => {
		pageSocket = ws;
		const upstream = ws.connectToServer();
		ws.onMessage((message) => upstream.send(message));
		upstream.onMessage((message) => {
			if (String(message).includes('"type":"ready"')) readies += 1;
			ws.send(message);
		});
		upstream.onClose((code, reason) => ws.close({ code, reason }));
		ws.onClose(() => upstream.close());
	});
	return { send: (frame) => pageSocket?.send(JSON.stringify(frame)), readies: () => readies };
}
