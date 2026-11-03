#!/usr/bin/env node
// Patch pi-mcp-adapter after install (postinstall).
//
// Patches against the exactly-pinned 2.10.0 sources. The cosmetic ones warn
// instead of failing if a future version changes the surrounding code, so
// installs never break; patches 6, 7 and 9 (a room's startup config read, the
// sign-in binding, a shared server's connectors) fail the install instead,
// because rooms, sign-ins and a shared server depend on them:
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
// palette: lila accent/success, yellow warnings, red errors, grays for
// chrome. Truecolor.

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

// --- Patch 7: connector sign-ins stay with the server that issued them -----
// The MCP SDK stamps every sign-in it saves with the authorization server
// that issued it, and a stamp for another server reads back as absent: a
// refresh token or a client secret is then never posted there. The adapter's
// store dropped the stamp, so the binding never took effect. The stored
// shapes now keep `issuer` and hand it back, and a stored client also hands
// back its dates and redirect URIs, so the SDK's one-time re-save of a sign-in
// from 0.14.2 keeps the whole record. A client from the connector's settings
// is bound too: it carries the stamp of the server it first signed in at, and
// the store keeps only its ID and the stamp, never the configured secret. When
// discovery names another server, it is refused with a plain message before
// any registration, sign-in or token request there (the provider remembers
// the server each run discovered, in memory only, so discovery stays
// uncached); a save that could only be a registration at another server is
// refused too. This one must apply: when it cannot, the install fails.

const bindingPatches = [
	[
		"mcp-auth.ts",
		[
			["  scope?: string;\n}", "  scope?: string;\n  issuer?: string;\n}"],
			["  redirectUris?: string[];\n}", "  redirectUris?: string[];\n  issuer?: string;\n}"],
		],
	],
	[
		"mcp-oauth-provider.ts",
		[
			[
				"export class McpOAuthProvider implements OAuthClientProvider {\n  private readonly redirectUrlSnapshot: string | undefined\n",
				"// Compared as the SDK compares stamps: parsed URLs, one trailing slash tolerated.\nfunction sameIssuer(a: string, b: string): boolean {\n  let [x, y] = [a, b]\n  try {\n    [x, y] = [new URL(a).href, new URL(b).href]\n  } catch {}\n  return x === y || (x.endsWith(\"/\") && x.slice(0, -1) === y) || (y.endsWith(\"/\") && y.slice(0, -1) === x)\n}\n\nfunction signInServerChanged(serverName: string): Error {\n  return new Error(`The sign-in server for connector \"${serverName}\" has changed. If you expect this, sign out of the connector and sign in again.`)\n}\n\nexport class McpOAuthProvider implements OAuthClientProvider {\n  private readonly redirectUrlSnapshot: string | undefined\n  private discoveredIssuer: string | undefined\n",
			],
			[
				"  private get usesClientCredentials(): boolean {",
				"  // The SDK reports the authorization server it discovered before it reads\n  // the client; kept in memory only, so discovery is never skipped.\n  async saveDiscoveryState(state: { authorizationServerUrl: string }): Promise<void> {\n    this.discoveredIssuer = state.authorizationServerUrl\n  }\n\n  private get usesClientCredentials(): boolean {",
			],
			[
				"      return {\n        client_id: this.config.clientId,\n        client_secret: this.config.clientSecret,\n      }",
				"      const stored = (await getAuthForUrl(this.serverName, this.serverUrl))?.clientInfo\n      const issuer = stored?.clientId === this.config.clientId ? stored.issuer : undefined\n      if (issuer && this.discoveredIssuer && !sameIssuer(issuer, this.discoveredIssuer)) {\n        throw signInServerChanged(this.serverName)\n      }\n      return {\n        client_id: this.config.clientId,\n        client_secret: this.config.clientSecret,\n        ...(issuer ? { issuer } : {}),\n      }",
			],
			[
				"        client_id: entry.clientInfo.clientId,\n        client_secret: entry.clientInfo.clientSecret,\n      }",
				"        client_id: entry.clientInfo.clientId,\n        client_secret: entry.clientInfo.clientSecret,\n        client_id_issued_at: entry.clientInfo.clientIdIssuedAt,\n        client_secret_expires_at: entry.clientInfo.clientSecretExpiresAt,\n        redirect_uris: entry.clientInfo.redirectUris,\n        issuer: entry.clientInfo.issuer,\n      }",
			],
			[
				"  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {\n    const redirectUris",
				"  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {\n    if (this.config.clientId) {\n      const stored = (await getAuthForUrl(this.serverName, this.serverUrl))?.clientInfo\n      if (info.client_id !== this.config.clientId || (stored?.clientId === this.config.clientId && stored.issuer)) {\n        throw signInServerChanged(this.serverName)\n      }\n      updateClientInfo(this.serverName, { clientId: info.client_id, issuer: info.issuer }, this.serverUrl)\n      return\n    }\n    const redirectUris",
			],
			["      redirectUris,\n    }\n    updateClientInfo", "      redirectUris,\n      issuer: info.issuer,\n    }\n    updateClientInfo"],
			["      scope: entry.tokens.scope,\n    }", "      scope: entry.tokens.scope,\n      issuer: entry.tokens.issuer,\n    }"],
			["      scope: tokens.scope,\n    }\n    updateTokens", "      scope: tokens.scope,\n      issuer: tokens.issuer,\n    }\n    updateTokens"],
		],
	],
];

for (const [file, replacements] of bindingPatches) {
	try {
		const filePath = path.join(adapterDir, file);
		const source = fs.readFileSync(filePath, "utf-8");
		if (replacements.every(([, to]) => source.includes(to))) {
			console.log(`patch-mcp-adapter: sign-in binding in ${file} already patched`);
		} else if (!replacements.every(([from]) => source.split(from).length === 2)) {
			console.error(`patch-mcp-adapter: ERROR sign-in binding anchors not found in ${file} (adapter changed, or partly patched?); connector sign-ins would not stay with their server`);
			process.exitCode = 1;
		} else {
			fs.writeFileSync(filePath, replacements.reduce((text, [from, to]) => text.replace(from, () => to), source));
			console.log(`patch-mcp-adapter: connector sign-ins in ${file} stay with the server that issued them`);
		}
	} catch (e) {
		console.error(`patch-mcp-adapter: ERROR sign-in binding patch failed for ${file} (${e.message})`);
		process.exitCode = 1;
	}
}

// --- Patch 8: the name we register with ------------------------------------
// Dynamic client registration names the app "Pi Coding Agent" with the
// adapter's GitHub page, and a provider can show that name on its sign-in
// screen. Register as exxperts with its own address instead; a clientName or
// clientUri in the connector's settings still wins.

try {
	const providerPath = path.join(adapterDir, "mcp-oauth-provider.ts");
	const provider = fs.readFileSync(providerPath, "utf-8");
	const names = [
		['this.config.clientName ?? "Pi Coding Agent"', 'this.config.clientName ?? "exxperts"'],
		['this.config.clientUri ?? "https://github.com/nicobailon/pi-mcp-adapter"', 'this.config.clientUri ?? "https://github.com/EXXETA/exxperts"'],
	];
	if (names.every(([from, to]) => !provider.includes(from) && provider.includes(to))) {
		console.log("patch-mcp-adapter: registration name already patched");
	} else if (!names.every(([from]) => provider.split(from).length === 3)) {
		console.warn("patch-mcp-adapter: registration name defaults not found (adapter changed?); skipping");
	} else {
		fs.writeFileSync(providerPath, names.reduce((text, [from, to]) => text.replaceAll(from, () => to), provider));
		console.log("patch-mcp-adapter: connectors register as exxperts");
	}
} catch (e) {
	console.warn(`patch-mcp-adapter: registration name skipped (${e.message})`);
}

// --- Patch 9: a shared server's connectors ---------------------------------
// With EXXPERTS_MCP_SHARED_SERVER=1 (read at each call; any other value or
// none changes nothing) connectors are reached by web address only, and none
// signs in: one stored sign-in would serve every person given the connector.
// A program entry is left out where every reader gets its config and refused
// where every connect starts, before the npm lookup; supportsOAuth answers
// false, so every caller refuses a sign-in in its own words; startAuth and the
// sign-in provider refuse beneath them; and a connector that would ask for a
// sign-in says so instead of the SSE fallback's error, and the call path's
// two back-off answers and its failed connect carry that refusal, so every
// answer about such a connector reads as the sign-in it is. The nine places
// apply together or not at all, and this one must apply: when it cannot, the
// install fails.

const SHARED_SERVER_IS_ON = 'process.env.EXXPERTS_MCP_SHARED_SERVER === "1"';
const sharedServerPatches = [
	[
		"config.ts",
		[
			[
				"    config = mergeConfigs(config, expandImports(loaded, cwd));\n  }\n\n  return config;\n}\n",
				`    config = mergeConfigs(config, expandImports(loaded, cwd));\n  }\n\n  if (${SHARED_SERVER_IS_ON}) return withoutLocalProgramEntries(config);\n  return config;\n}\n\n// On a shared server connectors are reached by web address only. Every reader\n// gets its config here, so an entry that names a local program, or that is no\n// object at all, is left out before anything lists, describes or connects it.\n// The kept entries are built into a new map as own keys, so a connector named\n// __proto__ stays listed, as it is without this filter.\nfunction withoutLocalProgramEntries(config: McpConfig): McpConfig {\n  const kept = Object.entries(config.mcpServers).filter(\n    ([, entry]) => entry !== null && typeof entry === "object" && !Array.isArray(entry) && !entry.command,\n  );\n  return { ...config, mcpServers: Object.fromEntries(kept) };\n}\n`,
			],
		],
	],
	[
		"server-manager.ts",
		[
			[
				'import { extractOAuthConfig, supportsOAuth } from "./mcp-auth-flow.ts";\n',
				'import { extractOAuthConfig, supportsOAuth, supportsOAuthWithoutSwitch } from "./mcp-auth-flow.ts";\n',
			],
			[
				"    // Dedupe concurrent connection attempts\n",
				`    // A shared server reaches connectors by web address only: a definition\n    // that names a local program starts nothing, the npm lookup included.\n    if (${SHARED_SERVER_IS_ON} && definition.command) {\n      throw new Error(\`Connector "\${name}" is a local program, and this server runs connectors by web address only.\`);\n    }\n\n    // Dedupe concurrent connection attempts\n`,
			],
			[
				"      if (error instanceof UnauthorizedError) {\n        throw error;\n      }\n",
				`      if (error instanceof UnauthorizedError) {\n        throw error;\n      }\n\n      // A shared server keeps no connector sign-in: a connector that would ask\n      // for one says so, in place of the SSE fallback's own refusal. One that\n      // carries a bearer token or any header keeps that error, since every\n      // header counts as a possible key: a key in a header the add does not\n      // recognise looks like any other header, and a refused key is no\n      // sign-in. The sentence holds "requires OAuth authentication", the words\n      // a sign-in refusal is recognised by, and is kept on this manager for\n      // the call path's later answers about the connector.\n      const status = (error as { code?: unknown } | null)?.code;\n      const carriesKey = Object.keys(definition.headers ?? {}).length > 0 || Boolean(definition.bearerToken) || Boolean(definition.bearerTokenEnv);\n      if (${SHARED_SERVER_IS_ON} && (status === 401 || status === 403) && !carriesKey && supportsOAuthWithoutSwitch(definition)) {\n        const refusal = \`Connector "\${serverName}" requires OAuth authentication, and connector sign-ins are off on this server.\`;\n        ((this as unknown as { signInRefusals?: Map<string, string> }).signInRefusals ??= new Map()).set(serverName, refusal);\n        throw new Error(refusal);\n      }\n`,
			],
		],
	],
	[
		"mcp-auth-flow.ts",
		[
			[
				"export function supportsOAuth(definition: ServerEntry): boolean {\n  // OAuth requires a URL\n",
				`export function supportsOAuth(definition: ServerEntry): boolean {\n  // A shared server keeps no connector sign-in, so no caller starts one there.\n  if (${SHARED_SERVER_IS_ON}) return false\n  return supportsOAuthWithoutSwitch(definition)\n}\n\n// What supportsOAuth answers where connector sign-ins are allowed.\nexport function supportsOAuthWithoutSwitch(definition: ServerEntry): boolean {\n  // OAuth requires a URL\n`,
			],
			[
				"): Promise<{ authorizationUrl: string }> {\n  const config = definition ? extractOAuthConfig(definition) : {}\n",
				`): Promise<{ authorizationUrl: string }> {\n  // Beneath supportsOAuth: no flow, callback listener or browser on a shared server.\n  if (${SHARED_SERVER_IS_ON}) throw new Error("Connector sign-ins are off on this server.")\n  const config = definition ? extractOAuthConfig(definition) : {}\n`,
			],
		],
	],
	[
		"mcp-oauth-provider.ts",
		[
			[
				"  ) {\n    this.redirectUrlSnapshot = config.grantType === \"client_credentials\"\n",
				`  ) {\n    // Every registration, token request and refresh passes this constructor,\n    // so on a shared server none starts.\n    if (${SHARED_SERVER_IS_ON}) throw new Error("Connector sign-ins are off on this server.")\n    this.redirectUrlSnapshot = config.grantType === "client_credentials"\n`,
			],
		],
	],
	[
		"proxy-modes.ts",
		[
			[
				'          return {\n            content: [{ type: "text" as const, text: `Server "${serverName}" not available (last failed ${failedAgo}s ago)` }],\n',
				`          // Once the connector has asked this session for a sign-in, which a\n          // shared server never gives, every back-off for it carries that\n          // refusal, so whoever reads it sees the sign-in, not a server that is\n          // down. The refusal is kept on this session's own manager, so another\n          // session's tries change nothing here.\n          const remembered = ${SHARED_SERVER_IS_ON} && (state.manager as unknown as { signInRefusals?: Map<string, string> }).signInRefusals?.get(serverName);\n          return {\n            content: [{ type: "text" as const, text: \`Server "\${serverName}" not available (last failed \${failedAgo}s ago)\${remembered ? \`: \${remembered}\` : ""}\` }],\n`,
			],
			[
				// The line alone is the tail of the one above, so the line before it is taken too.
				'      return {\n        content: [{ type: "text" as const, text: `Server "${serverName}" not available (last failed ${failedAgo}s ago)` }],\n',
				`      // As in the back-off above: a refused sign-in, carried.\n      const remembered = ${SHARED_SERVER_IS_ON} && (state.manager as unknown as { signInRefusals?: Map<string, string> }).signInRefusals?.get(serverName);\n      return {\n        content: [{ type: "text" as const, text: \`Server "\${serverName}" not available (last failed \${failedAgo}s ago)\${remembered ? \`: \${remembered}\` : ""}\` }],\n`,
			],
			[
				'        details: { mode: "call", error: "connect_failed", message },\n',
				`        // As in the back-off above: a failed connect that is the refused sign-in names its connector.\n        details: { mode: "call", error: "connect_failed", message, ...(${SHARED_SERVER_IS_ON} && message === (state.manager as unknown as { signInRefusals?: Map<string, string> }).signInRefusals?.get(serverName) ? { server: serverName } : {}) },\n`,
			],
		],
	],
];

try {
	const files = sharedServerPatches.map(([file, replacements]) => {
		const filePath = path.join(adapterDir, file);
		return { file, filePath, replacements, source: fs.readFileSync(filePath, "utf-8") };
	});
	if (files.every(({ source, replacements }) => replacements.every(([, to]) => source.includes(to)))) {
		console.log("patch-mcp-adapter: shared-server connectors already patched");
	} else {
		// Each file named by what its anchors are (a file can be named twice):
		// not found once, not yet patched beside patched ones, already patched.
		const filesWhere = (test) => [...new Set(files.filter(({ source, replacements }) => replacements.some(([from, to]) => test(source, from, to))).map(({ file }) => file))];
		const patched = filesWhere((source, from, to) => source.includes(to));
		const notFound = filesWhere((source, from, to) => !source.includes(to) && source.split(from).length !== 2);
		const pending = patched.length > 0 ? filesWhere((source, from, to) => !source.includes(to) && source.split(from).length === 2) : [];
		if (patched.length > 0 || notFound.length > 0) {
			const named = [
				[notFound, "not found once in"],
				[pending, "not yet patched in"],
				[patched, "already patched in"],
			].filter(([list]) => list.length > 0).map(([list, words]) => `${words} ${list.join(", ")}`);
			console.error(`patch-mcp-adapter: ERROR shared-server connector anchors ${named.join("; ")} (adapter changed, or partly patched?); a shared server would run program connectors and sign-ins`);
			process.exitCode = 1;
		} else {
			for (const { filePath, source, replacements } of files) {
				fs.writeFileSync(filePath, replacements.reduce((text, [from, to]) => text.replace(from, () => to), source));
			}
			console.log("patch-mcp-adapter: a shared server's connectors are reached by web address only, with no sign-in");
		}
	}
} catch (e) {
	console.error(`patch-mcp-adapter: ERROR shared-server connector patch failed (${e.message})`);
	process.exitCode = 1;
}
