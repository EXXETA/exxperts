// Loaded with --import into a server connector-call-stop-smoke.ts starts: a
// connector's call limits, shortened so a smoke can watch them end a call.
// The adapter reads them at each call (scripts/patch-mcp-adapter.mjs, patch 15);
// nothing a person sets reaches them.
export const SMOKE_CALL_LIMITS = { silenceMs: 1_500, totalMs: 6_000 };

globalThis.exxpertsConnectorCallLimits = SMOKE_CALL_LIMITS;
