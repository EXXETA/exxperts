import fs from "node:fs";
import path from "node:path";
import { app, WEB_UI_DIST } from "./server-app.js";
import { staticSecurityHeadersFor } from "./request-checks.js";
import { servedFile } from "./static-route-path.js";

function contentType(file: string): string {
	if (file.endsWith(".html")) return "text/html; charset=utf-8";
	if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
	if (file.endsWith(".css")) return "text/css; charset=utf-8";
	if (file.endsWith(".json")) return "application/json; charset=utf-8";
	if (file.endsWith(".webmanifest")) return "application/manifest+json; charset=utf-8";
	if (file.endsWith(".png")) return "image/png";
	if (file.endsWith(".jpg") || file.endsWith(".jpeg")) return "image/jpeg";
	if (file.endsWith(".svg")) return "image/svg+xml";
	if (file.endsWith(".woff")) return "font/woff";
	if (file.endsWith(".woff2")) return "font/woff2";
	if (file.endsWith(".ttf")) return "font/ttf";
	if (file.endsWith(".otf")) return "font/otf";
	return "application/octet-stream";
}

// The entry points must revalidate on every load: with no caching headers
// at all, a heuristically cached index.html silently pins a phone to an old
// build (and made a whole round of field tests unreliable). The hashed
// assets index.html references are immutable by construction - vite renames
// them on every content change - so they may cache forever. Everything else
// keeps its previous no-header behavior.
function staticCacheControl(file: string): string | null {
	if (file.endsWith("index.html") || file.endsWith(".webmanifest")) return "no-cache";
	if (file.includes(`${path.sep}assets${path.sep}`)) return "public, max-age=31536000, immutable";
	// Brand images and fonts change rarely but are not content-hashed: a
	// day's cache, never immutable.
	if (file.includes(`${path.sep}brand${path.sep}`) || file.includes(`${path.sep}fonts${path.sep}`)) return "public, max-age=86400";
	return null;
}

// Each route names the one folder it serves and hands over the rest of the
// path as the request sent it, the query cut off: a path that leaves that
// folder, or a file that isn't there, answers 404, never another file and
// never index.html (the page keeps its place in the address's hash, so no
// address needs index.html in place of a file).
function sendFile(req: { raw: { url?: string; socket?: unknown } }, reply: any, folder: string, rest: string, missingPage: string) {
	reply.headers(staticSecurityHeadersFor(req));
	if (!fs.existsSync(WEB_UI_DIST)) return reply.code(404).send({ error: missingPage });
	const file = servedFile(folder, rest);
	if (!file) return reply.code(404).send({ error: "not found" });
	const cache = staticCacheControl(file);
	if (cache) reply.header("cache-control", cache);
	return reply.type(contentType(file)).send(fs.createReadStream(file));
}

app.get("/", async (req, reply) => sendFile(req, reply, WEB_UI_DIST, "index.html", "web UI dist not found; run npm run build --workspace @exxeta/pi-web-ui"));

// The rest of the raw path after `/<folder>/`; a request the router matched
// some other way gives an empty rest, which servedFile refuses.
function sendFromFolder(folder: string) {
	const prefix = `/${folder}/`;
	return async (req: { raw: { url?: string; socket?: unknown } }, reply: any) => {
		const rawPath = (req.raw.url ?? "").split("?")[0];
		const rest = rawPath.startsWith(prefix) ? rawPath.slice(prefix.length) : "";
		return sendFile(req, reply, path.join(WEB_UI_DIST, folder), rest, "web UI dist not found");
	};
}

app.get("/assets/*", sendFromFolder("assets"));

app.get("/brand/*", sendFromFolder("brand"));

app.get("/fonts/*", sendFromFolder("fonts"));

app.get("/manifest.webmanifest", async (req, reply) => sendFile(req, reply, WEB_UI_DIST, "manifest.webmanifest", "web UI dist not found"));
