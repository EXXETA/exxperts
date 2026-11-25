// The team room smoke's rows in the browser, two pages on one shared server's
// room (and the desktop's two windows), run apart from its other rows so each
// smoke stays well inside the runner's time limit. The rows and their helpers
// are in team-room-session-smoke.ts; TEAM_ROOM_ONLY works here as there.
process.env.TEAM_ROOM_PART = "pages";
await import("./team-room-session-smoke.js");

export {};
