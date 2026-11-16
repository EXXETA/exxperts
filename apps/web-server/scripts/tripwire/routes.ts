// The routes and tools the tripwire never calls, each with its reason, and the
// sweep: the routes the drive doesn't reach on purpose, each called once. A
// route on neither list and never reached fails the run, so a new route is
// driven, swept or named before it merges.
import type { Client } from "./client.js";

/** A route the run never calls: one that takes no path, folder or room, or that ends the server. */
export const NAMED_ROUTES: Readonly<Record<string, string>> = {
	"POST /api/system/choose-folder": "opens the system's folder picker, a window only a person answers; it takes no folder and hands one back to Room settings, which the drive sets",
	"POST /api/settings/state-profile/switch": "ends the server process to start another profile; it takes no path, folder or room",
	"POST /api/auth/login": "starts a sign-in with a model provider over the internet; it takes no path, folder or room",
	"POST /api/web-search/searxng/setup": "starts the search engine's container; it takes no path, folder or room",
	"POST /api/remote/enable": "binds the server to the computer's tailnet address and may keep the computer awake; it takes no path, folder or room",
	"POST /api/remote/enroll-code": "opens a phone's enrolment over the computer's tailnet address; it takes no path, folder or room",
	"POST /api/remote/keep-awake": "keeps the computer awake; it takes no path, folder or room",
	"POST /api/auth/api-key": "checks the key with its model provider over the internet; it takes no path, folder or room",
	"POST /api/persistent-agent-ai-profiles/gateways": "checks the gateway by calling its address; it takes no path, folder or room",
	"PUT /api/persistent-agent-ai-profiles/gateways/:gatewayId": "checks the gateway by calling its address; it takes no path, folder or room",
	"POST /api/persistent-agent-ai-profiles/gateways/:gatewayId/discover": "asks the gateway's address for its models; it takes no path, folder or room",
	"POST /api/persistent-agent-ai-profiles/gateways/discover": "asks the address it is given for its models; it takes no path, folder or room",
	"POST /api/persistent-agent-ai-profiles/openai-compatible/discover": "asks the address it is given for its models; it takes no path, folder or room",
	"PUT /api/persistent-agent-ai-profiles/openai-compatible": "checks the endpoint by calling its address; it takes no path, folder or room",
};

/** A tool a session offers that the run never calls, with its reason. */
export const NAMED_TOOLS: Readonly<Record<string, string>> = {};

/** What the Windows design's tripwire drives that main has no code for yet. */
export const NOT_ON_MAIN = [
	"a room on a network folder (the stand-in mapping answer, design 5 and 5.1 row 24)",
	"the portable install and its stand-in Programs (R10D-F2)",
	"two servers on one state home, the second accepting the first's upload (R10D-F3)",
	"the override run's Windows parts: the moved places denied in every request and refused as a room's folder (R11D-F1)",
	"a room refused at, inside or above another tool's connector folder (R11D-F3)",
];

/**
 * The routes the sweep calls: each takes a room, a path or a folder at most as
 * the drive's values fill it, and reads or changes the app's own data (memory,
 * models and profiles, the remote devices, schedules, settings), or answers
 * 4xx to an empty body after its checks have run.
 */
export const SWEPT_ROUTES: readonly string[] = [
	"DELETE /api/persistent-agent-ai-profiles/custom/:profileId",
	"DELETE /api/persistent-agent-ai-profiles/gateways/:gatewayId",
	"DELETE /api/persistent-agent-ai-profiles/openai-compatible",
	"DELETE /api/persistent-agents/:id/memory/archive/:entryId",
	"DELETE /api/persistent-agents/:id/memory/entries/:entryId",
	"DELETE /api/persistent-agents/:id/schedules/:jobId",
	"DELETE /api/persistent-agents/:id/tasks/:taskId",
	"DELETE /api/persistent-agents/:id/tasks/:taskId/removed",
	"DELETE /api/persistent-agents/:id/threads/:threadId",
	"GET /",
	"GET /api/ai/defaults",
	"GET /api/auth/login/status",
	"GET /api/auth/providers",
	"GET /api/auth/status",
	"GET /api/memory/digest",
	"GET /api/memory/overview",
	"GET /api/memory/room-memory",
	"GET /api/memory/rooms/:id",
	"GET /api/memory/rooms/:id/area",
	"GET /api/memory/rooms/:id/conversation",
	"GET /api/memory/rooms/:id/conversations",
	"GET /api/memory/rooms/:id/event-diff",
	"GET /api/memory/rooms/:id/snapshot",
	"GET /api/memory/search",
	"GET /api/persistent-agent-ai-profile",
	"GET /api/persistent-agent-ai-profiles/gateways",
	"GET /api/persistent-agent-ai-profiles/gateways/:gatewayId",
	"GET /api/persistent-agent-ai-profiles/model-catalog",
	"GET /api/persistent-agent-ai-profiles/openai-compatible",
	"GET /api/persistent-agent-modes",
	"GET /api/persistent-agent-room/model-status",
	"GET /api/persistent-agents",
	"GET /api/persistent-agents/:id/absorb/runs/:runId",
	"GET /api/persistent-agents/:id/absorb/status",
	"GET /api/persistent-agents/:id/instructions",
	"GET /api/persistent-agents/:id/lifecycle-counts",
	"GET /api/persistent-agents/:id/maintenance-diagnostics",
	"GET /api/persistent-agents/:id/maintenance-diagnostics/export",
	"GET /api/persistent-agents/:id/maintenance-settings",
	"GET /api/persistent-agents/:id/memory/archive",
	"GET /api/persistent-agents/:id/memory/entries",
	"GET /api/persistent-agents/:id/memory/history",
	"GET /api/persistent-agents/:id/models",
	"GET /api/persistent-agents/:id/prompt-diagnostics",
	"GET /api/persistent-agents/:id/reattach-buffer-stats",
	"GET /api/persistent-agents/:id/review/runs/:runId",
	"GET /api/persistent-agents/:id/review/status",
	"GET /api/persistent-agents/:id/runtime",
	"GET /api/persistent-agents/:id/tasks",
	"GET /api/persistent-agents/archived",
	"GET /api/remote/client-context",
	"GET /api/remote/devices",
	"GET /api/remote/enroll-pending",
	"GET /api/remote/rooms",
	"GET /api/remote/status",
	"GET /api/remote/test/routes",
	"GET /api/settings/instructions",
	"GET /api/settings/room-order",
	"GET /api/settings/state-profile",
	"GET /api/settings/web-search",
	"GET /api/task-store/gc",
	"GET /api/usage",
	"GET /api/usage/export.csv",
	"GET /api/web-chat/model-status",
	"GET /api/web-search/searxng/setup",
	"GET /api/whats-new",
	"GET /assets/*",
	"GET /auth/session",
	"GET /brand/*",
	"GET /fonts/*",
	"GET /manifest.webmanifest",
	"GET /remote/enroll",
	"GET /remote/enroll.js",
	"GET /remote/enroll/status",
	"PATCH /api/persistent-agents/:id/runtime",
	"PATCH /api/persistent-agents/:id/schedules/:jobId",
	"POST /api/auth/login/cancel",
	"POST /api/auth/logout",
	"POST /api/memory/ask",
	"POST /api/persistent-agents/:id/absorb/approve",
	"POST /api/persistent-agents/:id/absorb/assess",
	"POST /api/persistent-agents/:id/absorb/discuss",
	"POST /api/persistent-agents/:id/absorb/discuss/signoff",
	"POST /api/persistent-agents/:id/absorb/propose",
	"POST /api/persistent-agents/:id/absorb/runs/:runId/beside-choice",
	"POST /api/persistent-agents/:id/absorb/runs/:runId/budget",
	"POST /api/persistent-agents/:id/absorb/runs/:runId/cancel",
	"POST /api/persistent-agents/:id/absorb/runs/:runId/edit",
	"POST /api/persistent-agents/:id/absorb/runs/:runId/keep",
	"POST /api/persistent-agents/:id/absorb/runs/:runId/move",
	"POST /api/persistent-agents/:id/absorb/runs/:runId/resume",
	"POST /api/persistent-agents/:id/checkpoint/approve",
	"POST /api/persistent-agents/:id/checkpoint/cancel",
	"POST /api/persistent-agents/:id/memento",
	"POST /api/persistent-agents/:id/memory/archive/:entryId/restore",
	"POST /api/persistent-agents/:id/memory/entries",
	"POST /api/persistent-agents/:id/memory/undo",
	"POST /api/persistent-agents/:id/rename",
	"POST /api/persistent-agents/:id/review/assess",
	"POST /api/persistent-agents/:id/review/discuss",
	"POST /api/persistent-agents/:id/review/discuss/signoff",
	"POST /api/persistent-agents/:id/review/runs",
	"POST /api/persistent-agents/:id/review/runs/:runId/approve",
	"POST /api/persistent-agents/:id/review/runs/:runId/budget",
	"POST /api/persistent-agents/:id/review/runs/:runId/cancel",
	"POST /api/persistent-agents/:id/review/runs/:runId/edit",
	"POST /api/persistent-agents/:id/review/runs/:runId/keep",
	"POST /api/persistent-agents/:id/review/runs/:runId/resume",
	"POST /api/persistent-agents/:id/runtime/discard-empty-prepared-boundary",
	"POST /api/persistent-agents/:id/tasks/:taskId/removed",
	"POST /api/persistent-agents/:id/tasks/:taskId/viewed",
	"POST /api/persistent-agents/:targetId/consult",
	"POST /api/remote/devices/capability",
	"POST /api/remote/devices/revoke",
	"POST /api/remote/disable",
	"POST /api/remote/enroll-approve",
	"POST /api/remote/enroll-deny",
	"POST /api/remote/rooms/exposure",
	"POST /api/remote/test/drop-listener",
	"POST /api/remote/test/recheck",
	"POST /api/settings/state-profile/create",
	"POST /api/settings/state-profile/delete",
	"POST /api/task-store/gc",
	"POST /api/whats-new/seen",
	"POST /remote/enroll/exchange",
	"PUT /api/ai/defaults",
	"PUT /api/persistent-agent-ai-profile",
	"PUT /api/persistent-agent-ai-profiles/custom",
	"PUT /api/persistent-agents/:id/instructions",
	"PUT /api/persistent-agents/:id/instructions/global",
	"PUT /api/persistent-agents/:id/maintenance-settings",
	"PUT /api/persistent-agents/:id/memory/entries/:entryId",
	"PUT /api/persistent-agents/:id/models",
	"PUT /api/persistent-agents/:id/protection",
	"PUT /api/settings/instructions",
	"PUT /api/settings/room-order",
	"PUT /api/settings/web-search",
];

/**
 * Calls each route once, its parameters filled from what the drive made, a
 * write with an empty body. Reads first, removals last. Returns each route
 * with its answer.
 */
export async function sweep(api: Client, routes: string[], params: Record<string, string>): Promise<string[]> {
	const order = (route: string) => (route.startsWith("GET ") ? 0 : route.startsWith("DELETE ") ? 2 : 1);
	const called: string[] = [];
	for (const route of [...routes].sort((a, b) => order(a) - order(b))) {
		const [method, url] = route.split(" ");
		const filled = url.replace(/:(\w+)/g, (_, name: string) => encodeURIComponent(params[name] ?? "none")).replace(/\*$/, "none.md");
		const answer = await api.send(method, filled, method === "GET" || method === "HEAD" ? undefined : {});
		called.push(`${route} ${answer.status}`);
	}
	return called;
}
