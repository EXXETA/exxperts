import fs from "node:fs";
import path from "node:path";
import { app, WEB_UI_DIST } from "./server-app.js";
import { staticSecurityHeadersFor } from "./request-checks.js";

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

function safeStaticPath(urlPath: string): string | null {
	if (!fs.existsSync(WEB_UI_DIST)) return null;
	const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
	const resolved = path.resolve(WEB_UI_DIST, rel);
	if (!resolved.startsWith(WEB_UI_DIST + path.sep) && resolved !== WEB_UI_DIST) return null;
	return fs.existsSync(resolved) && fs.statSync(resolved).isFile() ? resolved : path.join(WEB_UI_DIST, "index.html");
}

app.get("/", async (req, reply) => {
	reply.headers(staticSecurityHeadersFor(req));
	const file = safeStaticPath("/");
	if (!file) return reply.code(404).send({ error: "web UI dist not found; run npm run build --workspace @exxeta/pi-web-ui" });
	const cache = staticCacheControl(file);
	if (cache) reply.header("cache-control", cache);
	return reply.type(contentType(file)).send(fs.createReadStream(file));
});

async function sendStatic(req: { raw: { url?: string; socket?: unknown } }, reply: any) {
	reply.headers(staticSecurityHeadersFor(req));
	const file = safeStaticPath((req.raw.url ?? "/").split("?")[0]);
	if (!file) return reply.code(404).send({ error: "web UI dist not found" });
	const cache = staticCacheControl(file);
	if (cache) reply.header("cache-control", cache);
	return reply.type(contentType(file)).send(fs.createReadStream(file));
}

app.get("/assets/*", sendStatic);

app.get("/brand/*", sendStatic);

app.get("/fonts/*", sendStatic);

app.get("/manifest.webmanifest", sendStatic);
