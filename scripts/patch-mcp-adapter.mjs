#!/usr/bin/env node
// Patch pi-mcp-adapter after install (postinstall).
//
// Patches against the exactly-pinned 2.10.0 sources. The cosmetic ones warn
// instead of failing if a future version changes the surrounding code, so
// installs never break; patch 6 (a room's startup config read) fails the
// install instead, because a room depends on it:
//
// 1. Rebrand the OAuth callback pages. The adapter serves hard-coded
//    Pi-branded pages from its OAuth loopback server with no customization
//    hook. The page design mirrors the provider-login page in
//    runtime/packages/ai/src/utils/oauth/oauth-page.ts — keep them in sync.
//
// 2. Fit the /mcp panel to short terminals. The panel windows its list to a
//    fixed 12 rows but has ~14 more lines of chrome, so on a default 80x24
//    terminal an expanded server renders taller than the screen; the overlay
//    then overflows and every keypress garbles the whole TUI. The list window
//    now shrinks with the terminal, and the overlays declare maxHeight so
//    pi-tui clips instead of overflowing.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));

let adapterDir;
try {
	adapterDir = path.dirname(require.resolve("pi-mcp-adapter/package.json"));
} catch {
	console.warn("patch-mcp-adapter: pi-mcp-adapter not installed yet — skipping");
	process.exit(0);
}
const target = path.join(adapterDir, "mcp-callback-server.ts");

// Inline the exxperts wordmark (negative variant — the page is dark) when
// available (repo clone or packaged install). Text fallback otherwise.
let logoBase64 = null;
for (const candidate of [
	path.join(root, "apps/web-ui/public/brand/exxperts-logo-negative.png"),
	path.join(root, "apps/web-ui/dist/brand/exxperts-logo-negative.png"),
]) {
	try {
		logoBase64 = fs.readFileSync(candidate).toString("base64");
		break;
	} catch {}
}
const brand = logoBase64
	? `<img class="brand-logo" src="data:image/png;base64,${logoBase64}" alt="exxperts" />`
	: `<div class="brand-text">exxperts</div>`;

function page({ title, heading, ok, body, extra = "" }) {
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; }
    html { color-scheme: dark; }
    body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; background: radial-gradient(680px 340px at 50% 0%, rgba(140, 165, 255, 0.12), transparent 70%), #1e1e1e; color: #fafafa; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; text-align: center; }
    main { width: 100%; max-width: 460px; display: flex; flex-direction: column; align-items: center; }
    .brand-logo { height: 36px; width: auto; display: block; margin-bottom: 40px; }
    .brand-text { font-size: 30px; font-weight: 700; letter-spacing: 1px; margin-bottom: 40px; }
    .badge { width: 60px; height: 60px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 26px; font-weight: 700; margin-bottom: 24px; ${
			ok
				? "background: #8ca5ff; color: #1c1c1c; box-shadow: 0 8px 44px rgba(140, 165, 255, 0.35);"
				: "background: #e85858; color: #fff; box-shadow: 0 8px 44px rgba(232, 88, 88, 0.35);"
		} }
    h1 { margin: 0 0 10px; font-size: 24px; line-height: 1.15; font-weight: 650; }
    p { margin: 0; line-height: 1.7; color: #a9a9a9; font-size: 15px; }
    .details { margin-top: 18px; padding: 12px 14px; border: 1px solid rgba(232, 88, 88, 0.4); border-radius: 8px; background: rgba(232, 88, 88, 0.08); font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 13px; color: #d4a0a0; white-space: pre-wrap; word-break: break-word; max-width: 100%; }
  </style>
</head>
<body>
  <main>
    ${brand}
    <div class="badge">${ok ? "✓" : "✕"}</div>
    <h1>${heading}</h1>
    ${body}
  </main>
${extra}</body>
</html>`;
}

const successHtml = page({
	title: "exxperts — Authorization successful",
	heading: "Authorization successful",
	ok: true,
	body: "<p>You can close this window and return to exxperts.</p>",
	extra: "  <script>setTimeout(() => window.close(), 3000);</script>\n",
});

// ${escapeHtml(error)} is left as a literal interpolation for the adapter's
// HTML_ERROR template function.
// eslint-disable-next-line no-template-curly-in-string
const errorHtml = page({
	title: "exxperts — Authorization failed",
	heading: "Authorization failed",
	ok: false,
	// eslint-disable-next-line no-template-curly-in-string
	body: '<p>An error occurred during authorization.</p>\n    <div class="details">${escapeHtml(error)}</div>',
});

try {
	const original = fs.readFileSync(target, "utf-8");
	// Exact-containment check: any change to the templates above (or an older
	// patched design still in place) re-applies, since the patterns below also
	// match previously-patched output.
	if (original.includes(successHtml) && original.includes(errorHtml)) {
		console.log("patch-mcp-adapter: callback pages already patched");
	} else {
		const successPattern = /const HTML_SUCCESS = `<!DOCTYPE html>[\s\S]*?<\/html>`/;
		const errorPattern = /const HTML_ERROR = \(error: string\) => `<!DOCTYPE html>[\s\S]*?<\/html>`/;
		if (!successPattern.test(original) || !errorPattern.test(original)) {
			console.warn("patch-mcp-adapter: templates not found (adapter changed?) — skipping rebrand");
		} else {
			const patched = original
				.replace(successPattern, `const HTML_SUCCESS = \`${successHtml}\``)
				.replace(errorPattern, `const HTML_ERROR = (error: string) => \`${errorHtml}\``);
			fs.writeFileSync(target, patched);
			console.log(`patch-mcp-adapter: rebranded OAuth callback pages${logoBase64 ? "" : " (wordmark image not found — using text fallback)"}`);
		}
	}
} catch (e) {
	console.warn(`patch-mcp-adapter: rebrand skipped (${e.message})`);
}

// --- Patch 2: fit the /mcp panel to short terminals -----------------------

try {
	const panelPath = path.join(adapterDir, "mcp-panel.ts");
	let panel = fs.readFileSync(panelPath, "utf-8");
	if (panel.includes("process.stdout.rows")) {
		console.log("patch-mcp-adapter: panel height already patched");
	} else if (!panel.includes("const maxVis = McpPanel.MAX_VISIBLE;")) {
		console.warn("patch-mcp-adapter: panel window line not found (adapter changed?) — skipping height fix");
	} else {
		panel = panel.replace(
			"const maxVis = McpPanel.MAX_VISIBLE;",
			"const maxVis = Math.max(3, Math.min(McpPanel.MAX_VISIBLE, (process.stdout.rows ?? 24) - 18));",
		);
		fs.writeFileSync(panelPath, panel);
		console.log("patch-mcp-adapter: panel list window now follows terminal height");
	}

	// Multi-line tool descriptions (Canva's start with "\n        ") render as
	// extra physical lines inside the one-line overlay row; the frame grows
	// taller than the renderer expects and every redraw ghosts stale frames.
	// Collapse whitespace runs (newlines, tabs) at ingestion.
	if (panel.includes('(tool.description ?? "").replace')) {
		console.log("patch-mcp-adapter: description whitespace already patched");
	} else if (!panel.includes('description: tool.description ?? "",')) {
		console.warn("patch-mcp-adapter: description lines not found (adapter changed?) — skipping whitespace fix");
	} else {
		panel = panel
			.replaceAll(
				'description: tool.description ?? "",',
				'description: (tool.description ?? "").replace(/\\s+/g, " ").trim(),',
			)
			.replaceAll(
				"description: resource.description ?? `Read resource: ${resource.uri}`,",
				'description: (resource.description ?? `Read resource: ${resource.uri}`).replace(/\\s+/g, " ").trim(),',
			);
		fs.writeFileSync(panelPath, panel);
		console.log("patch-mcp-adapter: panel descriptions collapsed to one line");
	}

	const commandsPath = path.join(adapterDir, "commands.ts");
	const commands = fs.readFileSync(commandsPath, "utf-8");
	if (commands.includes("maxHeight")) {
		console.log("patch-mcp-adapter: overlay maxHeight already patched");
	} else if (!commands.includes('overlayOptions: { anchor: "center", width: 82 }')) {
		console.warn("patch-mcp-adapter: overlay options not found (adapter changed?) — skipping maxHeight fix");
	} else {
		fs.writeFileSync(
			commandsPath,
			commands
				.replaceAll('overlayOptions: { anchor: "center", width: 82 }', 'overlayOptions: { anchor: "center", width: 82, maxHeight: "95%" }')
				.replaceAll('overlayOptions: { anchor: "center", width: 92 }', 'overlayOptions: { anchor: "center", width: 92, maxHeight: "95%" }'),
		);
		console.log("patch-mcp-adapter: panel overlays clip to the terminal via maxHeight");
	}
} catch (e) {
	console.warn(`patch-mcp-adapter: panel fit skipped (${e.message})`);
}

// --- Patch 3: exxeta palette for the /mcp panels ---------------------------
// The panels hard-code generic ANSI colors (cyan selection, green success,
// rainbow progress dots) and ignore the TUI theme. Recolor with the exxeta
// CLI palette (pi-package/themes/exxeta.json): lila accent/success, yellow
// warnings, red errors, grays for chrome. Truecolor, like the launcher banner.

const LILA = "38;2;140;165;255";
const LILA_DIM = "38;2;111;134;216";
const LILA_BRIGHT = "38;2;195;208;255";
const YELLOW = "38;2;235;255;89";
const RED = "38;2;232;88;88";
const GRAY1 = "38;2;154;154;154";
const GRAY2 = "38;2;106;106;106";

try {
	const panelPath = path.join(adapterDir, "mcp-panel.ts");
	let panel = fs.readFileSync(panelPath, "utf-8");
	if (panel.includes(LILA)) {
		console.log("patch-mcp-adapter: panel palette already patched");
	} else if (!panel.includes('selected: "36",')) {
		console.warn("patch-mcp-adapter: panel theme not found (adapter changed?) — skipping palette");
	} else {
		panel = panel
			.replace(
				/const DEFAULT_THEME: PanelTheme = \{[\s\S]*?\};/,
				`const DEFAULT_THEME: PanelTheme = {
  border: "${GRAY2}",
  title: "${GRAY1}",
  selected: "${LILA}",
  direct: "${LILA}",
  needsAuth: "${YELLOW}",
  placeholder: "${GRAY2};3",
  description: "${GRAY2}",
  hint: "${GRAY2}",
  confirm: "${LILA}",
  cancel: "${RED}",
};`,
			)
			.replace(
				/const RAINBOW_COLORS = \[[\s\S]*?\];/,
				`const RAINBOW_COLORS = [
  "${LILA_DIM}",
  "${LILA}",
  "${LILA_BRIGHT}",
];`,
			);
		fs.writeFileSync(panelPath, panel);
		console.log("patch-mcp-adapter: /mcp panel recolored to the exxeta palette");
	}

	const setupPath = path.join(adapterDir, "mcp-setup-panel.ts");
	let setup = fs.readFileSync(setupPath, "utf-8");
	if (setup.includes(LILA)) {
		console.log("patch-mcp-adapter: setup panel palette already patched");
	} else if (!setup.includes('title: "36",')) {
		console.warn("patch-mcp-adapter: setup theme not found (adapter changed?) — skipping palette");
	} else {
		setup = setup.replace(
			/const DEFAULT_THEME: SetupTheme = \{[\s\S]*?\};/,
			`const DEFAULT_THEME: SetupTheme = {
  border: "${GRAY2}",
  title: "${GRAY1}",
  selected: "${LILA}",
  hint: "${GRAY2}",
  success: "${LILA}",
  warning: "${YELLOW}",
  muted: "${GRAY2};3",
};`,
		);
		fs.writeFileSync(setupPath, setup);
		console.log("patch-mcp-adapter: /mcp setup panel recolored to the exxeta palette");
	}
} catch (e) {
	console.warn(`patch-mcp-adapter: palette skipped (${e.message})`);
}

// --- Patch 4: product wording in the setup/auth panels ----------------------
// The adapter's setup panel copy speaks in Pi terms ("Pi-owned", "reload Pi").
// Rebrand the user-visible strings; behavior is untouched.

try {
	const targets = ["mcp-setup-panel.ts", "commands.ts"];
	for (const file of targets) {
		const filePath = path.join(adapterDir, file);
		const source = fs.readFileSync(filePath, "utf-8");
		if (source.includes("exxperts-owned") || !/\bPi\b/.test(source.replace(/pi-mcp-adapter|pi-tui|PanelKeybindings/g, ""))) {
			continue;
		}
		const rebranded = source
			.replaceAll("Pi-owned", "exxperts-owned")
			.replaceAll("reload Pi.", "reload exxperts.")
			.replaceAll("Pi will reload", "exxperts will reload")
			.replaceAll("Pi should import", "exxperts should import")
			.replaceAll("where Pi writes", "where exxperts writes")
			.replaceAll("that Pi discovered", "that exxperts discovered")
			.replaceAll("Adopt them into Pi", "Adopt them into exxperts")
			.replaceAll("the Pi agent dir config", "the exxperts agent dir config")
			.replaceAll("Pi found MCP-related setup options, but none are active in Pi yet.", "MCP-related setup options were found, but none are active yet.")
			.replaceAll("Pi only writes compatibility imports", "exxperts only writes compatibility imports");
		if (rebranded !== source) {
			fs.writeFileSync(filePath, rebranded);
			console.log(`patch-mcp-adapter: product wording in ${file}`);
		}
	}
} catch (e) {
	console.warn(`patch-mcp-adapter: wording skipped (${e.message})`);
}

// --- Patch 5: list never-connected servers in the mcp tool description -----
// buildProxyDescription skips servers with no cached tools, so a freshly
// added connector is invisible to the model until its first connection.
// List it as "not connected yet" instead — the model can then connect it.

try {
	const directPath = path.join(adapterDir, "direct-tools.ts");
	const direct = fs.readFileSync(directPath, "utf-8");
	if (direct.includes("not connected yet")) {
		console.log("patch-mcp-adapter: proxy description already patched");
	} else if (!direct.includes("    if (totalItems === 0) continue;")) {
		console.warn("patch-mcp-adapter: proxy description anchor not found (adapter changed?) — skipping");
	} else {
		fs.writeFileSync(
			directPath,
			direct.replace(
				"    if (totalItems === 0) continue;",
				'    if (totalItems === 0) {\n      serverSummaries.push(`${serverName} (not connected yet)`);\n      continue;\n    }',
			),
		);
		console.log("patch-mcp-adapter: proxy description lists never-connected servers");
	}
} catch (e) {
	console.warn(`patch-mcp-adapter: proxy description skipped (${e.message})`);
}

// --- Patch 6: a room's startup config read uses the room connector folder ---
// The adapter's factory reads its config once at startup (direct-tool
// registration and settings such as toolPrefix and disableProxyTool) against
// the process's working folder. The room wrapper (pi-package/extensions/mcp)
// hands it the room connector folder on the extension API, so a room's tools
// come from the person's own settings only. This one must apply: when it
// cannot, the install fails instead of shipping without it.

try {
	const indexPath = path.join(adapterDir, "index.ts");
	const index = fs.readFileSync(indexPath, "utf-8");
	const anchor = "  const earlyConfig = loadMcpConfig(earlyConfigPath);";
	if (index.includes("exxpertsConnectorConfigCwd")) {
		console.log("patch-mcp-adapter: startup config read already patched");
	} else if (!index.includes(anchor)) {
		console.error("patch-mcp-adapter: ERROR startup config read not found (adapter changed?); a room's startup read cannot be pointed at the room connector folder");
		process.exitCode = 1;
	} else {
		fs.writeFileSync(
			indexPath,
			index.replace(
				anchor,
				"  const earlyConfig = loadMcpConfig(earlyConfigPath, (pi as { exxpertsConnectorConfigCwd?: string }).exxpertsConnectorConfigCwd);",
			),
		);
		console.log("patch-mcp-adapter: a room's startup config read uses the room connector folder");
	}
} catch (e) {
	console.error(`patch-mcp-adapter: ERROR startup config read patch failed (${e.message})`);
	process.exitCode = 1;
}
