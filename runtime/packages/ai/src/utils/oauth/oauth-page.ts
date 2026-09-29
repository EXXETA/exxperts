import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Inline the exxperts wordmark (negative variant — the page is dark).
// Falls back to a plain-text wordmark if the asset isn't found.
let logoBase64: string | null = null;
try {
	const __dirname = dirname(fileURLToPath(import.meta.url));
	// The install root first: the launchers and the desktop app name it in
	// EXXETA_HOME, and inside the bundled web server this file's folder is
	// apps/web-server/dist, where the walk up below overshoots it.
	const home = process.env.EXXETA_HOME;
	const homePaths = home
		? [
				resolve(home, "apps/web-ui/public/brand/exxperts-logo-negative.png"),
				resolve(home, "apps/web-ui/dist/brand/exxperts-logo-negative.png"),
			]
		: [];
	// Walk up from runtime/packages/ai/dist/utils/oauth/ to repo root, then into web-ui
	const logoPaths = [
		...homePaths,
		resolve(__dirname, "../../../../../..", "apps/web-ui/public/brand/exxperts-logo-negative.png"),
		resolve(__dirname, "../../../../../../..", "apps/web-ui/public/brand/exxperts-logo-negative.png"),
		resolve(__dirname, "../../../../../..", "apps/web-ui/dist/brand/exxperts-logo-negative.png"),
		resolve(__dirname, "../../../../../../..", "apps/web-ui/dist/brand/exxperts-logo-negative.png"),
	];
	for (const fp of logoPaths) {
		try {
			logoBase64 = readFileSync(fp).toString("base64");
			break;
		} catch {}
	}
} catch {}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function renderPage(options: { title: string; heading: string; message: string; details?: string; variant: "success" | "error" }): string {
	const title = escapeHtml(options.title);
	const heading = escapeHtml(options.heading);
	const message = escapeHtml(options.message);
	const details = options.details ? escapeHtml(options.details) : undefined;
	const ok = options.variant === "success";

	const brand = logoBase64
		? `<img class="brand-logo" src="data:image/png;base64,${logoBase64}" alt="exxperts" />`
		: `<div class="brand-text">exxperts</div>`;

	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; }
    html { color-scheme: dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: radial-gradient(680px 340px at 50% 0%, rgba(140, 165, 255, 0.12), transparent 70%), #1e1e1e;
      color: #fafafa;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      text-align: center;
    }
    main {
      width: 100%;
      max-width: 460px;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .brand-logo { height: 36px; width: auto; display: block; margin-bottom: 40px; }
    .brand-text { font-size: 30px; font-weight: 700; letter-spacing: 1px; margin-bottom: 40px; }
    .badge {
      width: 60px;
      height: 60px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 26px;
      font-weight: 700;
      margin-bottom: 24px;
      ${ok
				? "background: #8ca5ff; color: #1c1c1c; box-shadow: 0 8px 44px rgba(140, 165, 255, 0.35);"
				: "background: #e85858; color: #fff; box-shadow: 0 8px 44px rgba(232, 88, 88, 0.35);"}
    }
    h1 {
      margin: 0 0 10px;
      font-size: 24px;
      line-height: 1.15;
      font-weight: 650;
    }
    p {
      margin: 0;
      line-height: 1.7;
      color: #a9a9a9;
      font-size: 15px;
    }
    .details {
      margin-top: 18px;
      padding: 12px 14px;
      border: 1px solid rgba(232, 88, 88, 0.4);
      border-radius: 8px;
      background: rgba(232, 88, 88, 0.08);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 13px;
      color: #d4a0a0;
      white-space: pre-wrap;
      word-break: break-word;
      max-width: 100%;
    }
  </style>
</head>
<body>
  <main>
    ${brand}
    <div class="badge">${ok ? "✓" : "✕"}</div>
    <h1>${heading}</h1>
    <p>${message}</p>
    ${details ? `<div class="details">${details}</div>` : ""}
  </main>
</body>
</html>`;
}

export function oauthSuccessHtml(message: string): string {
	return renderPage({
		title: "exxperts — Authentication successful",
		heading: "Authentication successful",
		message,
		variant: "success",
	});
}

export function oauthErrorHtml(message: string, details?: string): string {
	return renderPage({
		title: "exxperts — Authentication failed",
		heading: "Authentication failed",
		message,
		details,
		variant: "error",
	});
}
