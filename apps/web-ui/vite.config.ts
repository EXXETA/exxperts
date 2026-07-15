import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The app version shown in the UI comes from the root package.json, so a
// release bump propagates without touching component code.
const rootPackage = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"));

export default defineConfig({
	plugins: [react()],
	define: {
		__APP_VERSION__: JSON.stringify(rootPackage.version ?? "unknown"),
	},
	build: {
		rollupOptions: {
			input: {
				app: fileURLToPath(new URL("./index.html", import.meta.url)),
				fixtures: fileURLToPath(new URL("./fixtures.html", import.meta.url)),
			},
		},
	},
	server: {
		port: 5173,
		proxy: {
			"/ws": { target: "ws://localhost:8787", ws: true },
			"/healthz": "http://localhost:8787",
			"/api": "http://localhost:8787",
		},
	},
});
