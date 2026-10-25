// The stop's door, read without a server: a stopping server refuses every
// request that starts work, Memorize's and Review's resumes among them, and
// lets the neighbours that start none through.
//
// Run: node --import tsx/esm apps/web-server/scripts/server-stop-door-smoke.ts
import { stopRefuses } from "../src/server-stop.js";

const refused: Array<[string, string]> = [
	["GET", "/ws"],
	["POST", "/api/persistent-agents/:id/absorb/propose"],
	["POST", "/api/persistent-agents/:id/absorb/runs/:runId/resume"],
	["POST", "/api/persistent-agents/:id/review/runs/:runId/resume"],
];
const passing: Array<[string, string | undefined]> = [
	["HEAD", "/ws"],
	["GET", "/api/persistent-agents/:id/threads/:threadId"],
	["POST", "/api/persistent-agents/:id/review/runs/:runId/cancel"],
	["GET", undefined],
];
const wrong = [
	...refused.filter(([method, url]) => !stopRefuses(method, url)).map(([method, url]) => `lets ${method} ${url} through`),
	...passing.filter(([method, url]) => stopRefuses(method, url)).map(([method, url]) => `refuses ${method} ${url}`),
];
if (wrong.length > 0) throw new Error(`the stop's door ${wrong.join("; ")}`);
console.log(`server-stop-door smoke: ok (the door refuses ${refused.length} requests that start work, Memorize's resume among them, and lets ${passing.length} neighbours through)`);
