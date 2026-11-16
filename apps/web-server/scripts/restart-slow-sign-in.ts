// Loaded before a restart smoke's server: the fake model's provider becomes a
// sign-in, so a turn refreshes its token with auth.json locked, across a call
// as slow as the smoke likes. RESTART_REFRESH_SEEN gets one line per refresh
// begun; with RESTART_REFRESH_GO set, the refresh then waits for that file.
import fs from "node:fs";
import { registerOAuthProvider } from "@exxeta/exxperts-ai/oauth";

const seen = process.env.RESTART_REFRESH_SEEN;
const go = process.env.RESTART_REFRESH_GO;

registerOAuthProvider({
	id: "fake-gpt",
	name: "Fake GPT",
	async login() {
		throw new Error("this provider is only ever refreshed");
	},
	async refreshToken(credentials) {
		if (seen) fs.appendFileSync(seen, `${process.pid}\n`);
		while (go && !fs.existsSync(go)) await new Promise((resolve) => setTimeout(resolve, 20));
		return { ...credentials, access: "refreshed-token", expires: Date.now() + 3_600_000 };
	},
	getApiKey: (credentials) => credentials.access,
});
