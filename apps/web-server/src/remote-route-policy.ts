// Remote route policy: every HTTP route carries an explicit class for
// requests from enrolled remote devices. There is no default: an
// unclassified route FAILS CLOSED at the enforcement hook, and the
// classification smoke walks the live route table and fails when any route
// ships without an entry, so a new route cannot silently become remotely
// reachable (or silently writable from a read-only device).
//
// Classes:
// - "read":  reachable by every enrolled device, including read-only ones.
//            Method shape is NOT the criterion; this is an explicit list.
// - "write": reachable by full-capability devices only. Room interaction in
//            the widest sense: prompting, approvals, files, lifecycle.
// - "local": never reachable remotely, any capability. The computer's own
//            surface: provider credentials, connectors, skills install,
//            capability/exposure flags (a phone must never widen its own
//            access), host resources, and remote administration itself.

export type RemoteRouteClass = "read" | "write" | "local";

const POLICY: Record<string, RemoteRouteClass> = {
	// Infrastructure and static app surface.
	"GET /": "read",
	"GET /assets/*": "read",
	"GET /brand/*": "read",
	"GET /fonts/*": "read",
	"GET /manifest.webmanifest": "read",
	"GET /healthz": "read",
	"GET /ws": "read",
	// Unreachable on the tunnel (the guard's branch 404s it before routing);
	// classified local so the table is total.
	"GET /auth/session": "local",
	// The tunnel's pre-auth enrollment surface (self-gating handlers).
	"GET /remote/enroll": "read",
	"GET /remote/enroll.js": "read",
	"GET /remote/enroll/status": "read",
	"POST /remote/enroll/exchange": "read",

	// Client-kind probe for the web-ui's affordance hiding (cosmetic; the
	// server enforces regardless of what the client renders).
	"GET /api/remote/client-context": "read",

	// Remote administration: loopback only, always.
	"GET /api/remote/status": "local",
	"POST /api/remote/enable": "local",
	"POST /api/remote/disable": "local",
	"POST /api/remote/keep-awake": "local",
	"GET /api/remote/devices": "local",
	"POST /api/remote/devices/revoke": "local",
	"POST /api/remote/devices/capability": "local",
	"POST /api/remote/enroll-code": "local",
	"GET /api/remote/enroll-pending": "local",
	"POST /api/remote/enroll-approve": "local",
	"POST /api/remote/enroll-deny": "local",
	"GET /api/remote/rooms": "local",
	"POST /api/remote/rooms/exposure": "local",
	"POST /api/remote/test/drop-listener": "local",
	"POST /api/remote/test/recheck": "local",
	"GET /api/remote/test/routes": "local",

	// Provider auth and credentials: the computer's own keys.
	"GET /api/auth/providers": "read",
	"GET /api/auth/status": "read",
	"GET /api/auth/login/status": "local",
	"POST /api/auth/login": "local",
	"POST /api/auth/login/cancel": "local",
	"POST /api/auth/logout": "local",
	"POST /api/auth/api-key": "local",

	// AI profiles and gateways: configuration stays local, but switching
	// among already-configured profiles is room use, not configuration.
	// Without it, rooms whose model lives in a standby profile are dead
	// ends from a full-access device.
	"GET /api/persistent-agent-ai-profile": "read",
	"PUT /api/persistent-agent-ai-profile": "write",
	"PUT /api/persistent-agent-ai-profiles/custom": "local",
	"DELETE /api/persistent-agent-ai-profiles/custom/:profileId": "local",
	"GET /api/persistent-agent-ai-profiles/gateways": "read",
	"POST /api/persistent-agent-ai-profiles/gateways": "local",
	"GET /api/persistent-agent-ai-profiles/gateways/:gatewayId": "read",
	"PUT /api/persistent-agent-ai-profiles/gateways/:gatewayId": "local",
	"DELETE /api/persistent-agent-ai-profiles/gateways/:gatewayId": "local",
	"POST /api/persistent-agent-ai-profiles/gateways/:gatewayId/discover": "local",
	"POST /api/persistent-agent-ai-profiles/gateways/discover": "local",
	"GET /api/persistent-agent-ai-profiles/model-catalog": "read",
	"GET /api/persistent-agent-ai-profiles/openai-compatible": "read",
	"PUT /api/persistent-agent-ai-profiles/openai-compatible": "local",
	"DELETE /api/persistent-agent-ai-profiles/openai-compatible": "local",
	"POST /api/persistent-agent-ai-profiles/openai-compatible/discover": "local",

	// Model choice: room interaction, not credentials.
	"GET /api/persistent-agent-modes": "read",
	"GET /api/persistent-agent-room/model-status": "read",
	"POST /api/persistent-agent-room/model-selection": "write",
	"GET /api/web-chat/model-status": "read",
	"POST /api/web-chat/model-selection": "write",

	// MCP connectors: credentials and host-side admin.
	"GET /api/mcp/status": "read",
	"POST /api/mcp/servers": "local",
	"DELETE /api/mcp/servers/:name": "local",
	"GET /api/mcp/servers/:name/login": "local",
	"POST /api/mcp/servers/:name/login": "local",
	"DELETE /api/mcp/servers/:name/login": "local",
	"POST /api/mcp/servers/:name/logout": "local",
	"POST /api/mcp/servers/:name/test": "local",

	// Memory surfaces. Reads (aggregations are additionally filtered for
	// hidden rooms at the route); ask runs the model, so it is interaction.
	"GET /api/memory/overview": "read",
	"GET /api/memory/room-memory": "read",
	"GET /api/memory/digest": "read",
	"GET /api/memory/search": "read",
	"POST /api/memory/ask": "write",
	"GET /api/memory/rooms/:id": "read",
	"GET /api/memory/rooms/:id/area": "read",
	"GET /api/memory/rooms/:id/conversation": "read",
	"GET /api/memory/rooms/:id/event-diff": "read",
	"GET /api/memory/rooms/:id/snapshot": "read",

	// Rooms: listing and per-room reads.
	"GET /api/persistent-agents": "read",
	"GET /api/persistent-agents/archived": "read",
	"GET /api/persistent-agents/:id/status": "read",
	"GET /api/persistent-agents/:id/runtime": "read",
	"GET /api/persistent-agents/:id/lifecycle-counts": "read",
	"GET /api/persistent-agents/:id/background-runs": "read",
	"GET /api/persistent-agents/:id/reattach-buffer-stats": "read",
	"GET /api/persistent-agents/:id/absorb/status": "read",
	"GET /api/persistent-agents/:id/structural-review/status": "read",
	"GET /api/persistent-agents/:id/files": "read",
	"GET /api/persistent-agents/:id/files/:name": "read",
	"GET /api/persistent-agents/:id/tasks": "read",
	"GET /api/persistent-agents/:id/threads/:threadId": "read",
	"GET /api/persistent-agents/:id/schedules": "read",
	"GET /api/persistent-agents/:id/maintenance-settings": "read",
	"GET /api/persistent-agents/:id/preferred-model": "read",
	"GET /api/persistent-agents/:id/mcp-connectors": "read",
	"GET /api/persistent-agents/:id/skill-settings": "read",
	"GET /api/persistent-agents/:id/workspace-default": "read",
	"GET /api/persistent-agents/:id/workspace-policy": "read",
	"GET /api/persistent-agents/:id/prompt-diagnostics": "local",

	// Rooms: interaction (full-capability devices).
	"POST /api/persistent-agents": "write",
	"POST /api/persistent-agents/:id/rename": "write",
	"POST /api/persistent-agents/:id/archive": "write",
	"POST /api/persistent-agents/:id/restore": "write",
	"POST /api/persistent-agents/:id/purge": "write",
	"POST /api/persistent-agents/:id/memento": "write",
	"POST /api/persistent-agents/:targetId/consult": "write",
	"POST /api/persistent-agents/:id/absorb/approve": "write",
	"POST /api/persistent-agents/:id/absorb/assess": "write",
	"POST /api/persistent-agents/:id/absorb/discuss": "write",
	"POST /api/persistent-agents/:id/absorb/discuss/signoff": "write",
	"POST /api/persistent-agents/:id/absorb/propose": "write",
	"POST /api/persistent-agents/:id/checkpoint/approve": "write",
	"POST /api/persistent-agents/:id/checkpoint/propose": "write",
	"POST /api/persistent-agents/:id/structural-review/approve": "write",
	"POST /api/persistent-agents/:id/structural-review/assess": "write",
	"POST /api/persistent-agents/:id/structural-review/discuss": "write",
	"POST /api/persistent-agents/:id/structural-review/discuss/signoff": "write",
	"POST /api/persistent-agents/:id/structural-review/propose": "write",
	"POST /api/persistent-agents/:id/files": "write",
	"POST /api/persistent-agents/:id/files/:name/delete": "write",
	"POST /api/persistent-agents/:id/files/:name/delete/commit": "write",
	"POST /api/persistent-agents/:id/files/:name/delete/undo": "write",
	"POST /api/persistent-agents/:id/files/:name/rename": "write",
	"POST /api/persistent-agents/:id/files/:name/save": "write",
	"PATCH /api/persistent-agents/:id/runtime": "write",
	"POST /api/persistent-agents/:id/runtime/discard-empty-prepared-boundary": "write",
	"POST /api/persistent-agents/:id/schedules": "write",
	"PATCH /api/persistent-agents/:id/schedules/:jobId": "write",
	"DELETE /api/persistent-agents/:id/schedules/:jobId": "write",
	"DELETE /api/persistent-agents/:id/tasks/:taskId": "write",
	"POST /api/persistent-agents/:id/tasks/:taskId/removed": "write",
	"DELETE /api/persistent-agents/:id/tasks/:taskId/removed": "write",
	"POST /api/persistent-agents/:id/tasks/:taskId/viewed": "write",
	"PUT /api/persistent-agents/:id/threads/:threadId": "write",
	"PUT /api/persistent-agents/:id/preferred-model": "write",
	"DELETE /api/persistent-agents/:id/threads/:threadId": "write",

	// Rooms: capability-widening settings. Loopback only: a phone must never
	// change a room's tool surface, workspace access, or connector grants.
	"PUT /api/persistent-agents/:id/maintenance-settings": "local",
	"PUT /api/persistent-agents/:id/mcp-connectors": "local",
	"PUT /api/persistent-agents/:id/skill-settings": "local",
	"PUT /api/persistent-agents/:id/workspace-default": "local",
	"DELETE /api/persistent-agents/:id/workspace-default": "local",
	"DELETE /api/persistent-agents/:id/workspace-policy": "local",
	"POST /api/persistent-agents/:id/workspace/validate": "local",

	// Task artifacts: read by URL; export writes into the host workspace.
	"GET /api/artifacts/:taskId/*": "read",
	"POST /api/artifacts/:taskId/export": "local",

	// Skills: installing or editing skills widens what rooms can do.
	"GET /api/skills": "read",
	"GET /api/skills/:id": "read",
	"GET /api/skills/featured": "read",
	"POST /api/skills": "local",
	"PUT /api/skills/:id": "local",
	"DELETE /api/skills/:id": "local",
	"POST /api/skills/accept": "local",
	"POST /api/skills/upload": "local",
	"POST /api/skills/repo/candidate": "local",
	"POST /api/skills/repo/import": "local",
	"POST /api/skills/repo/scan": "local",

	// Knowledge (notes-vault bridge): reading is fine; connecting folders,
	// editing vault files, and reindexing touch the host filesystem.
	"GET /api/knowledge/bases": "read",
	"GET /api/knowledge/tree": "read",
	"GET /api/knowledge/note": "read",
	"GET /api/knowledge/search": "read",
	"POST /api/knowledge/connect-preflight": "local",
	"POST /api/knowledge/connect": "local",
	"POST /api/knowledge/disconnect": "local",
	"POST /api/knowledge/file": "local",
	"PUT /api/knowledge/file": "local",
	"DELETE /api/knowledge/file": "local",
	"POST /api/knowledge/index": "local",

	// Usage reporting.
	"GET /api/usage": "read",
	"GET /api/usage/export.csv": "read",

	// Host-side settings and resources.
	"GET /api/settings/web-search": "read",
	"PUT /api/settings/web-search": "local",
	"GET /api/web-search/searxng/setup": "read",
	"POST /api/web-search/searxng/setup": "local",
	// The what's-new window. Reading it is informative on any device, but
	// the seen record is the computer's: a remote dismissal classified
	// "write" would acknowledge the version machine-wide and the person at
	// the desktop would never see their window. Remote devices suppress a
	// dismissed window per device via localStorage; only the computer
	// records durably.
	"GET /api/whats-new": "read",
	"POST /api/whats-new/seen": "local",
	"GET /api/task-store/gc": "read",
	"POST /api/task-store/gc": "local",
	"POST /api/system/choose-folder": "local",
};

export function classifyRemoteRoute(method: string, routeUrl: string): RemoteRouteClass | null {
	const normalizedMethod = method === "HEAD" ? "GET" : method;
	return POLICY[`${normalizedMethod} ${routeUrl}`] ?? null;
}

/** For the coverage check: the exact keys the policy knows. */
export function remoteRoutePolicyKeys(): string[] {
	return Object.keys(POLICY);
}
