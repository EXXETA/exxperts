// Hooks a shared-server entry file registers before it starts this server.
//
// The desktop app and the launcher start index.ts directly and register
// nothing, so every hook stays empty and the server behaves exactly as
// without them. An entry that registers must do so before it imports
// index.ts: index.ts reads the hooks once, while it loads.
//
// This file holds only the slots and the flag. Shared code never imports an
// entry file: a release packs the server by following imports.
import type { FastifyReply, FastifyRequest } from "fastify";

export type EdgeTools = {
	// True when the candidate is the server's token. The token itself is never handed out.
	readonly tokenMatches: (candidate: string) => boolean;
};

export type ServerHooks = {
	// The folder the web page is served from, given the app root; without it,
	// apps/web-ui/dist under the app root.
	webUiDist?: (appRoot: string) => string;
	// Runs at the top of the server's own onRequest hook for every request
	// that reaches the server's hooks, the /ws upgrade included (only the
	// websocket plugin's own onRequest hook, which marks an upgrade, runs
	// before it), and decides instead of the server's own proxy, loopback and
	// token checks, which then do not run. It refuses by sending a reply and
	// returning it; returning without a reply lets the request on, to the
	// request guard and the handler. A request no route matches, and OPTIONS,
	// arrive with req.routeOptions.url undefined, as for the guard.
	edgeRequest?: (req: FastifyRequest, reply: FastifyReply, tools: EdgeTools) => unknown | Promise<unknown>;
	// The server's token, asked once while index.ts loads. When it is
	// registered, it is the token: the EXXPERTS_AUTH_TOKEN variable and the
	// token file are not read, and no token is minted or written.
	authToken?: () => string;
	// The security headers for the page and its files on the loopback
	// listener, given the server's own; asked once while index.ts loads.
	pageSecurityHeaders?: (base: Readonly<Record<string, string>>) => Record<string, string>;
	// Runs after the loopback and token checks, or after the edge when one is
	// registered, and before any handler, the /ws upgrade included. It may
	// only refuse: send a reply and return it.
	// Returning without a reply lets the request through. A route is known by
	// req.routeOptions.url, except for requests no route matches (answered
	// 404) and OPTIONS requests, where it is undefined; a HEAD request carries
	// its GET route's url with req.method "HEAD", except on /ws, which has no
	// HEAD route. Decide those explicitly.
	guardRequest?: (req: FastifyRequest, reply: FastifyReply) => unknown | Promise<unknown>;
	// Asked for every client-context request that phone mode's branch does not
	// answer, given the server's own answer as base; it may add to the answer
	// and set the reply's headers, and what it returns is the answer.
	clientContext?: (req: FastifyRequest, reply: FastifyReply, base: Readonly<Record<string, unknown>>) => Record<string, unknown>;
	// How long a stop waits for running work, in seconds, asked when a stop
	// begins (server-stop.ts); without it, or when it gives nothing, two seconds.
	stopWaitSeconds?: () => number | undefined;
};

let registered: Readonly<ServerHooks> | null = null;

// Called once, by an entry file, before it imports index.ts.
export function registerServerHooks(hooks: ServerHooks): void {
	if (registered) throw new Error("server hooks are already registered");
	registered = Object.freeze({ ...hooks });
}

// The registered hooks; empty when no entry registered.
export function serverHooks(): Readonly<ServerHooks> {
	return registered ?? {};
}

// True only once an entry has registered: this process is a shared server.
export function isSharedServer(): boolean {
	return registered !== null;
}
