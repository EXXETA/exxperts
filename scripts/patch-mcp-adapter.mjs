#!/usr/bin/env node
// Patch pi-mcp-adapter after install (postinstall).
//
// Patches against the exactly-pinned 2.10.0 sources. The cosmetic ones warn
// instead of failing if a future version changes the surrounding code, so
// installs never break; patches 6, 7, 9 to 22, 26, 27 and 29 (a room's
// startup config read, the sign-in binding, a shared server's connectors,
// its connector values, the AI library copy's sign-in test, the gate before
// a connector call, a connector program's start and where it is looked for,
// a connector call's stop and limits, a tool's marks in the saved tool list,
// the gate on a connector page's calls, a shared server's sealed connector
// values, no sign-in helper without a stored sign-in, sign-ins kept across a
// room's start and end, the managers' registry, calls kept by connector, a
// conversation's end ending its connectors' starts, the links the adapter
// opens, and no model offered to a connector) fail the install instead,
// because rooms, sign-ins, a shared server, the room box, connector programs,
// the Connectors page and what the person's model costs depend on them:
//
// 1. Rebrand the OAuth callback pages. The adapter serves hard-coded
//    Pi-branded pages from its OAuth loopback server with no customization
//    hook. The page design mirrors the provider-login page in
//    runtime/packages/ai/src/utils/oauth/oauth-page.ts — keep them in sync.
//    A sign-in the service refused also carries the service's code on its
//    error, as `signInRefusal`, so the Connectors page can tell a person's own
//    No from a refusal; the error's words and the page stay as they were.
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

// --adapter-dir <folder> patches that folder instead of the installed adapter,
// so a test can run this script on a scratch copy.
const adapterDirFlag = process.argv.indexOf("--adapter-dir");
let adapterDir;
if (adapterDirFlag !== -1) {
	adapterDir = path.resolve(process.argv[adapterDirFlag + 1] ?? "");
	if (!fs.existsSync(path.join(adapterDir, "package.json"))) {
		console.error("patch-mcp-adapter: ERROR --adapter-dir names no adapter folder");
		process.exit(1);
	}
} else {
	try {
		adapterDir = path.dirname(require.resolve("pi-mcp-adapter/package.json"));
	} catch {
		console.warn("patch-mcp-adapter: pi-mcp-adapter not installed yet: skipping");
		process.exit(0);
	}
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
	title: "Signed in · exxperts",
	heading: "Signed in",
	ok: true,
	body: "<p>You can close this tab and go back to exxperts.</p>",
	extra: "  <script>setTimeout(() => window.close(), 3000);</script>\n",
});

// ${escapeHtml(error)} is left as a literal interpolation for the adapter's
// HTML_ERROR template function.
// eslint-disable-next-line no-template-curly-in-string
const errorHtml = page({
	title: "Sign-in didn't finish · exxperts",
	heading: "Sign-in didn't finish",
	ok: false,
	// eslint-disable-next-line no-template-curly-in-string
	body: '<p>Go back to exxperts to see why.</p>\n    <div class="details">${escapeHtml(error)}</div>',
});

// The refusal's code on its error, beside the words it already has.
const refusalWithDescription = "setTimeout(() => pending.reject(new Error(errorMsg)), 0)";
const refusalWithCode = "setTimeout(() => pending.reject(Object.assign(new Error(errorMsg), { signInRefusal: error })), 0)";

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
try {
	const original = fs.readFileSync(target, "utf-8");
	if (original.includes(refusalWithCode)) {
		console.log("patch-mcp-adapter: a refused sign-in's code already kept");
	} else if (!original.includes(refusalWithDescription)) {
		console.warn("patch-mcp-adapter: the sign-in refusal line not found (adapter changed?): its code is not kept");
	} else {
		fs.writeFileSync(target, original.replace(refusalWithDescription, refusalWithCode));
		console.log("patch-mcp-adapter: a refused sign-in keeps its code");
	}
} catch (e) {
	console.warn(`patch-mcp-adapter: keeping a refused sign-in's code skipped (${e.message})`);
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
// With EXXPERTS_SHARED_SERVER=1 (read at each call; any other value or
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

const SHARED_SERVER_IS_ON = 'process.env.EXXPERTS_SHARED_SERVER === "1"';
// The switch's earlier name, as an adapter patched before the rename holds it.
// Such an adapter has neither the anchors nor the text above, so it would fail
// the install as "not found once": its places are renamed first, and it then
// reads as already patched. Kept whole so a search for the old name finds it.
const SHARED_SERVER_WAS_ON = 'process.env.EXXPERTS_MCP_SHARED_SERVER === "1"';
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
	const migrated = [];
	let migratedPlaces = 0;
	for (const [file] of sharedServerPatches) {
		const filePath = path.join(adapterDir, file);
		const source = fs.readFileSync(filePath, "utf-8");
		const places = source.split(SHARED_SERVER_WAS_ON).length - 1;
		if (places > 0) {
			fs.writeFileSync(filePath, source.replaceAll(SHARED_SERVER_WAS_ON, () => SHARED_SERVER_IS_ON));
			migrated.push(file);
			migratedPlaces += places;
		}
	}
	if (migratedPlaces > 0) {
		console.log(`patch-mcp-adapter: shared-server switch renamed in ${migratedPlaces} places (${migrated.join(", ")}), patched before the rename`);
	}
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

// One patch that must apply: all its places or none, and when it cannot, the
// install fails with one line. An anchor not found once, or a file patched in
// some places only, is that failure. A file an earlier version of this script
// patched reads the same way, so the line names both causes and the way out.
// `warnOnly`: a patch rooms work without, as before it: the same all or none,
// but one that cannot apply warns and the install goes on. `builtOnBy`: the
// replacements of later patches that rewrite some of this one's lines, so a
// line reads as patched in its own form or in theirs. Returns whether the file
// holds the patch afterwards.
function applyRequiredPatch(name, filePath, replacements, consequence, done, { warnOnly = false, builtOnBy = [] } = {}) {
	const forms = (to) => [to, ...builtOnBy.map((later) => later.reduce((text, [from, next]) => text.split(from).join(next), to))];
	const refuse = (line) => {
		if (warnOnly) {
			console.warn(`patch-mcp-adapter: ${line}; skipping`);
			return;
		}
		console.error(`patch-mcp-adapter: ERROR ${line}`);
		process.exitCode = 1;
	};
	try {
		const source = fs.readFileSync(filePath, "utf-8");
		const isPatched = ([, to]) => forms(to).some((form) => source.includes(form));
		const patched = replacements.filter(isPatched);
		if (patched.length === replacements.length) {
			console.log(`patch-mcp-adapter: ${name} already patched`);
			return true;
		}
		const notFound = replacements.filter((replacement) => !isPatched(replacement) && source.split(replacement[0]).length !== 2);
		if (patched.length > 0 || notFound.length > 0) {
			refuse(`${name} ${notFound.length > 0 ? "anchors not found once" : "partly patched"} in ${path.basename(filePath)} (the package changed, or an earlier version of this script patched it: run npm ci to install it afresh); ${consequence}`);
			return false;
		}
		fs.writeFileSync(filePath, replacements.reduce((text, [from, to]) => text.replace(from, () => to), source));
		console.log(`patch-mcp-adapter: ${done}`);
		return true;
	} catch (e) {
		refuse(`${name} failed (${e.message})`);
		return false;
	}
}

// --- Patch 10: a shared server takes a connector's values as typed -----------
// With EXXPERTS_SHARED_SERVER=1 (read at each call; any other value or none
// changes nothing) `${VAR}` and `$env:VAR` stay as written and bearerTokenEnv
// gives no token: the admin's add stores such a value in a bearer token or a
// header, and it would otherwise send a server setting to the connector's
// address. A block of its own, so an adapter patched before it is not read as
// partly patched by patch 9.
applyRequiredPatch(
	"patch 10 (a connector's values)",
	path.join(adapterDir, "utils.ts"),
	[
		[
			"export function interpolateEnvVars(value: string): string {\n  return value\n",
			`// A shared server takes a connector's values as typed: no environment lookup.\nfunction sharedServerTakesConnectorValuesAsTyped(): boolean {\n  return ${SHARED_SERVER_IS_ON};\n}\n\nexport function interpolateEnvVars(value: string): string {\n  if (sharedServerTakesConnectorValuesAsTyped()) return value;\n  return value\n`,
		],
		[
			"  return definition.bearerTokenEnv ? process.env[definition.bearerTokenEnv] : undefined;\n",
			"  if (sharedServerTakesConnectorValuesAsTyped()) return undefined;\n  return definition.bearerTokenEnv ? process.env[definition.bearerTokenEnv] : undefined;\n",
		],
	],
	"a shared server would send server settings to connectors",
	"a shared server takes a connector's values as typed",
);

// --- Patch 11: no sign-in through the adapter's own AI library ----------------
// MCP sampling calls the adapter's copy of @earendil-works/pi-ai, with its own
// token test, so the runtime's reader misses it. With EXXPERTS_SHARED_SERVER=1
// that test answers false, and a token-shaped key goes out as an ordinary key.
// The copy exports no package.json, so require.resolve cannot find it: the
// folders are walked up from the adapter, the way node looks. The root
// package.json pins the copy's version, since a global install ignores the
// lockfile; a bump rechecks this patch.
function adapterCopyOfAi() {
	for (let dir = adapterDir; ; dir = path.dirname(dir)) {
		const candidate = path.join(dir, "node_modules", "@earendil-works", "pi-ai");
		if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
		if (path.dirname(dir) === dir) return null;
	}
}
const aiCopy = adapterCopyOfAi();
if (aiCopy === null) {
	console.error("patch-mcp-adapter: ERROR patch 11 (the AI library copy's sign-in test) found no @earendil-works/pi-ai beside the adapter; a shared server would send a sign-in through MCP sampling");
	process.exitCode = 1;
} else {
	applyRequiredPatch(
		"patch 11 (the AI library copy's sign-in test)",
		path.join(aiCopy, "dist", "providers", "anthropic.js"),
		[
			[
				'function isOAuthToken(apiKey) {\n    return apiKey.includes("sk-ant-oat");\n}\n',
				`// A shared server serves no subscription: a token-shaped key goes out as an ordinary key.\nfunction sharedServerSendsNoSignInToken() {\n    return typeof process !== "undefined" && ${SHARED_SERVER_IS_ON};\n}\nfunction isOAuthToken(apiKey) {\n    if (sharedServerSendsNoSignInToken()) return false;\n    return apiKey.includes("sk-ant-oat");\n}\n`,
			],
		],
		"a shared server would send a sign-in through MCP sampling",
		"a shared server sends no sign-in through the AI library copy",
	);
}

// --- Patch 12: a room's gate stands right before every connector call --------
// The saved tool list is shared (a Test connection or another room can rewrite
// it) and one saved before patch 16 has no marks (read-only, destructive). So
// the marks are read from the connection itself, at the two places that
// reach a connector, after it is connected and the tool is resolved. The room's
// wrapper hands the gate in as the execute's fifth argument, which the adapter
// never read; pi-package/extensions/mcp/room-scope.ts is the gate. A call waiting
// on its card counts as in flight, so idling out does not close its connection.
// Each registered tool says it has the gate: a room does not take one that
// doesn't, so an install that skipped this script offers no connectors. The mcp
// tool also hands the turn's signal on to its call, for patch 15.
const GATE_CONSEQUENCE = "a room's connector calls would run without asking";
const gateCall = (indent, server, toolName, resourceUri, args) => [
	`await beforeConnectorCall({`,
	`  server: ${server},`,
	`  toolName: ${toolName},`,
	`  liveTool: connection.tools?.find((tool) => tool.name === ${toolName}),`,
	`  resourceRead: Boolean(${resourceUri}),`,
	`  args: ${args},`,
	`});`,
].map((line, at) => (at === 0 ? line : `${indent}${line}`)).join("\n");
applyRequiredPatch(
	"patch 12 (the gate in the mcp tool)",
	path.join(adapterDir, "index.ts"),
	[
		[
			"      execute: createDirectToolExecutor(() => state, () => initPromise, spec),\n",
			"      execute: createDirectToolExecutor(() => state, () => initPromise, spec),\n      asksBeforeConnectorCalls: true,\n",
		],
		[
			"      renderCall: renderMcpProxyToolCall,\n",
			"      renderCall: renderMcpProxyToolCall,\n      asksBeforeConnectorCalls: true,\n",
		],
		[
			"      }, _signal, _onUpdate, _ctx) {\n",
			"      }, _signal, _onUpdate, beforeConnectorCall) {\n",
		],
		[
			"          return executeCall(state, params.tool, parsedArgs, params.server, getPiTools);\n",
			"          return executeCall(state, params.tool, parsedArgs, params.server, getPiTools, beforeConnectorCall, _signal);\n",
		],
	],
	GATE_CONSEQUENCE,
	"the mcp tool hands its calls to the room's gate",
);
applyRequiredPatch(
	"patch 12 (the gate on a proxied call)",
	path.join(adapterDir, "proxy-modes.ts"),
	[
		[
			"  getPiTools?: () => ToolInfo[],\n): Promise<ProxyToolResult> {\n  let serverName: string | undefined = serverOverride;\n",
			"  getPiTools?: () => ToolInfo[],\n  beforeConnectorCall?: (call: Record<string, unknown>) => Promise<ProxyToolResult | undefined>,\n  signal?: AbortSignal,\n): Promise<ProxyToolResult> {\n  let serverName: string | undefined = serverOverride;\n",
		],
		[
			"    state.manager.incrementInFlight(serverName);\n\n    if (toolMeta.resourceUri) {\n",
			`    state.manager.incrementInFlight(serverName);\n\n    const refused = ${gateCall("    ", "serverName", "toolMeta.originalName", "toolMeta.resourceUri", "args")}\n    if (refused) return refused;\n\n    if (toolMeta.resourceUri) {\n`,
		],
	],
	GATE_CONSEQUENCE,
	"a proxied connector call stops at the room's gate",
);
applyRequiredPatch(
	"patch 12 (the gate on a direct tool)",
	path.join(adapterDir, "direct-tools.ts"),
	[
		[
			"  return async function execute(_toolCallId, params) {\n",
			"  return async function execute(_toolCallId, params, _signal, _onUpdate, beforeConnectorCall) {\n",
		],
		[
			"      state.manager.incrementInFlight(spec.serverName);\n\n      if (spec.resourceUri) {\n",
			`      state.manager.incrementInFlight(spec.serverName);\n\n      const refused = ${gateCall("      ", "spec.serverName", "spec.originalName", "spec.resourceUri", "params")}\n      if (refused) return refused;\n\n      if (spec.resourceUri) {\n`,
		],
	],
	GATE_CONSEQUENCE,
	"a direct connector tool stops at the room's gate",
);

// --- Patch 17: a connector's page calls its tools through the room's gate -----
// A tool can carry its own page (MCP Apps). The adapter serves that page on
// this computer and lets it call its connector's tools (ui-server.ts,
// /proxy/tools/call). Every such call passes the gate the room handed in with
// the call that opened the page, marked `fromPage`, as patch 12's two call
// sites do, while it counts as in flight; the gate also keeps the page to the
// tools it may call. A refusal goes back to the page as the tool's error. A
// page opened with no gate calls nothing.
const PAGE_GATE_CONSEQUENCE = "a connector's page could call its tools without asking";
applyRequiredPatch(
	"patch 17 (the gate handed to a page from a proxied call)",
	path.join(adapterDir, "proxy-modes.ts"),
	[[
		"          streamMode: toolMeta.uiStreamMode,\n        })\n",
		"          streamMode: toolMeta.uiStreamMode,\n          beforeConnectorCall,\n        })\n",
	]],
	PAGE_GATE_CONSEQUENCE,
	"a page opened by a proxied call gets the room's gate",
);
applyRequiredPatch(
	"patch 17 (the gate handed to a page from a direct tool)",
	path.join(adapterDir, "direct-tools.ts"),
	[[
		"            streamMode: spec.uiStreamMode,\n          })\n",
		"            streamMode: spec.uiStreamMode,\n            beforeConnectorCall,\n          })\n",
	]],
	PAGE_GATE_CONSEQUENCE,
	"a page opened by a direct tool gets the room's gate",
);
applyRequiredPatch(
	"patch 17 (the gate carried to the page)",
	path.join(adapterDir, "ui-session.ts"),
	[
		[
			"  streamMode?: UiStreamMode;\n}\n",
			"  streamMode?: UiStreamMode;\n  beforeConnectorCall?: (call: Record<string, unknown>) => Promise<{ content?: unknown } | undefined>;\n}\n",
		],
		[
			"      consentManager: state.consentManager,\n",
			"      consentManager: state.consentManager,\n      beforeConnectorCall: request.beforeConnectorCall,\n",
		],
	],
	PAGE_GATE_CONSEQUENCE,
	"the page's session carries the room's gate",
);
applyRequiredPatch(
	"patch 17 (the gate on a page's call)",
	path.join(adapterDir, "ui-server.ts"),
	[
		[
			"  onComplete?: (reason: string) => void;\n}\n",
			"  onComplete?: (reason: string) => void;\n  beforeConnectorCall?: (call: Record<string, unknown>) => Promise<{ content?: unknown } | undefined>;\n}\n",
		],
		[
			[
				"        try {",
				"          options.manager.touch(options.serverName);",
				"          options.manager.incrementInFlight(options.serverName);",
				"          const result = await connection.client.callTool({",
				"            name: callParams.name,",
				"            arguments:",
				"              callParams.arguments && typeof callParams.arguments === \"object\" && !Array.isArray(callParams.arguments)",
				"                ? callParams.arguments",
				"                : {},",
				"          });",
				"",
			].join("\n"),
			[
				"        const args = callParams.arguments && typeof callParams.arguments === \"object\" && !Array.isArray(callParams.arguments)",
				"          ? callParams.arguments",
				"          : {};",
				"        try {",
				"          options.manager.touch(options.serverName);",
				"          options.manager.incrementInFlight(options.serverName);",
				"          const refused = options.beforeConnectorCall",
				"            ? await options.beforeConnectorCall({",
				"                server: options.serverName,",
				"                toolName: callParams.name,",
				"                liveTool: connection.tools?.find((tool) => tool.name === callParams.name),",
				"                resourceRead: false,",
				"                args,",
				"                fromPage: true,",
				"              })",
				"            : { content: [{ type: \"text\", text: \"This page can't use its connector's tools here.\" }] };",
				"          if (refused) {",
				"            sendJson(res, 200, { ok: true, result: { content: refused.content, isError: true } });",
				"            return;",
				"          }",
				"          const result = await connection.client.callTool({",
				"            name: callParams.name,",
				"            arguments: args,",
				"          });",
				"",
			].join("\n"),
		],
	],
	PAGE_GATE_CONSEQUENCE,
	"a connector's page calls its tools through the room's gate",
);

// --- Patch 13: a connector program's start ------------------------------------
// A local connector program starts outside the room box. Two things change
// where the adapter starts one. Its environment is a short list of what
// programs need to run, plus the connector's own declared env: never the
// app's token, a provider key or the app's own settings, unless the connector
// names them. And right before the start, after the npx lookup, the adapter
// asks the check apps/web-server/src/connector-start-check.ts puts on
// globalThis, which refuses a program, package or working folder that a room
// can change files in. A process that never put the check there (a script
// that drives the adapter alone) starts the program as before. This one must
// apply: when it cannot, the install fails.
const CONNECTOR_ENVIRONMENT = [
	// What the MCP library's own default passes, on each system.
	"HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER",
	"APPDATA", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "PROCESSOR_ARCHITECTURE", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "USERNAME", "USERPROFILE", "PROGRAMFILES",
	// Language, temporary files and the clock.
	"LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TMPDIR", "TMP", "TZ",
	// Windows' own programs and file types, so a .cmd shim and npx start.
	"COMSPEC", "PATHEXT", "WINDIR",
	// A company network's proxy and certificates.
	"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
	// npm's cache folder, so npx runs from the folder the start check looked at.
	"npm_config_cache", "NPM_CONFIG_CACHE",
];
applyRequiredPatch(
	"patch 13 (a connector program's start)",
	path.join(adapterDir, "server-manager.ts"),
	[
		[
			"      transport = new StdioClientTransport({\n        command,\n        args,\n        env: resolveEnv(definition.env),\n        cwd: resolveConfigPath(definition.cwd),\n",
			[
				"      const env = resolveEnv(definition.env);",
				"      const cwd = resolveConfigPath(definition.cwd);",
				"      // A program a room can change files around doesn't start (scripts/patch-mcp-adapter.mjs, patch 13).",
				"      const startCheck = (globalThis as { exxpertsConnectorStartCheck?: (start: Record<string, unknown>) => Promise<void> }).exxpertsConnectorStartCheck;",
				"      await startCheck?.({ name, command, args, cwd, configuredCommand: definition.command, environment: interpolateEnvRecord(definition.env) });",
				"      transport = new StdioClientTransport({",
				"        command,",
				"        args,",
				"        env,",
				"        cwd,",
				"",
			].join("\n"),
		],
		[
			"function resolveEnv(env?: Record<string, string>): Record<string, string> {\n  // Copy process.env, filtering out undefined values\n  const resolved: Record<string, string> = {};\n  for (const [key, value] of Object.entries(process.env)) {\n    if (value !== undefined) {\n",
			[
				"// What a connector program gets from this process's environment: what programs",
				"// need to run, never the app's token or a provider key (scripts/patch-mcp-adapter.mjs, patch 13).",
				`const CONNECTOR_ENVIRONMENT = new Set(${JSON.stringify(CONNECTOR_ENVIRONMENT)});`,
				"",
				"function resolveEnv(env?: Record<string, string>): Record<string, string> {",
				"  // Copy the listed names only; Windows reads names without case.",
				"  const resolved: Record<string, string> = {};",
				"  for (const [key, value] of Object.entries(process.env)) {",
				'    if (value !== undefined && CONNECTOR_ENVIRONMENT.has(process.platform === "win32" ? key.toUpperCase() : key)) {',
				"",
			].join("\n"),
		],
	],
	"a connector program would start with the app's token and keys, from folders a room can change",
	"a connector program starts with a short environment, after the room folder check",
);

// --- Patch 14: a connector program starts as it does in a terminal ------------
// On top of patch 13's text, which stays as it is. An app opened from the Dock
// has a short PATH, so the program and npx's npm are looked for along the PATH
// apps/web-server/src/connector-search-path.ts gives (put on globalThis by
// installConnectorStartCheck, which the start check reads too). The npx lookup
// and its first-run install get the connector's short environment, not this
// process's whole one, and the install may take a few minutes. They run npm,
// node and a package's install scripts along the connector's own PATH, so the
// start check judges the lookup as a start first (every folder on that PATH
// counts for npx); npm's cache folder is read per connector. A caller may
// give a start a time limit and a way to stop it, which reach the program's
// first answer and the install. The program's error output is kept, its last
// lines with whether it wrote anything that isn't the connector protocol,
// on the error a failed start throws, so the Connectors page can say why. A
// process that never put the search path there (a script that drives the
// adapter alone) looks along its own PATH as before. This one must apply: when
// it cannot, the install fails.
const START_CONSEQUENCE = "a connector program would not be found from an app opened from the Dock, its install would get the app's token and keys, and its failures would read alike";
applyRequiredPatch(
	"patch 14 (a connector program's search path and its own words)",
	path.join(adapterDir, "server-manager.ts"),
	[
		[
			"  async connect(name: string, definition: ServerDefinition): Promise<ServerConnection> {\n",
			"  async connect(name: string, definition: ServerDefinition, start?: ConnectorStartOptions): Promise<ServerConnection> {\n",
		],
		[
			"    const promise = this.createConnection(name, definition);\n",
			"    const promise = this.createConnection(name, definition, start);\n",
		],
		[
			"  private async createConnection(\n    name: string,\n    definition: ServerDefinition\n  ): Promise<ServerConnection> {\n",
			"  private async createConnection(\n    name: string,\n    definition: ServerDefinition,\n    start?: ConnectorStartOptions\n  ): Promise<ServerConnection> {\n",
		],
		["    let transport: Transport;\n", "    let transport: Transport;\n    let program: ConnectorProgramWatch | undefined;\n"],
		[
			"        const resolved = await resolveNpxBinary(command, args);\n",
			[
				"        // The lookup may run npm, node and a package's install scripts along the connector's own PATH, from this process's folder: checked as a start first.",
				"        const lookupCheck = (globalThis as { exxpertsConnectorStartCheck?: (start: Record<string, unknown>) => Promise<void> }).exxpertsConnectorStartCheck;",
				"        await lookupCheck?.({ name, command, args, configuredCommand: command, environment: interpolateEnvRecord(definition.env) });",
				"        const resolved = await resolveNpxBinary(command, args, resolveEnv(definition.env), start?.signal);",
				"",
			].join("\n"),
		],
		[
			'        stderr: definition.debug ? "inherit" : "ignore",\n      });\n',
			'        stderr: definition.debug ? "inherit" : "pipe",\n      });\n      program = watchConnectorProgram(transport as StdioClientTransport);\n',
		],
		["      await client.connect(transport);\n", "      await client.connect(transport, start);\n"],
		[
			"      // Clean up both client and transport on any error\n      await client.close().catch(() => {});\n      await transport.close().catch(() => {});\n      throw error;\n",
			"      // Clean up both client and transport on any error\n      await client.close().catch(() => {});\n      await transport.close().catch(() => {});\n      throw program && error instanceof Error ? Object.assign(error, { connectorProgram: program }) : error;\n",
		],
		[
			"  if (!env) return resolved;\n",
			[
				"  // Where the program is looked for: the server's PATH and the usual install folders (scripts/patch-mcp-adapter.mjs, patch 14).",
				"  const searchPath = (globalThis as { exxpertsConnectorSearchPath?: () => string | undefined }).exxpertsConnectorSearchPath?.();",
				"  if (searchPath !== undefined) resolved.PATH = searchPath;",
				"",
				"  if (!env) return resolved;",
				"",
			].join("\n"),
		],
		[
			"/**\n * Resolve headers with environment variable interpolation.\n */\n",
			[
				"/** A time limit for a program's first answer, and a way to stop its start (scripts/patch-mcp-adapter.mjs, patch 14). */",
				"export interface ConnectorStartOptions {",
				"  timeout?: number;",
				"  signal?: AbortSignal;",
				"}",
				"",
				"/** What a connector program said beside the protocol: its error output's last lines, and whether its output held anything else. */",
				"export interface ConnectorProgramWatch {",
				"  output: string[];",
				"  otherOutput: boolean;",
				"}",
				"",
				"const PROGRAM_OUTPUT_LINES = 20;",
				"const PROGRAM_LINE_LENGTH = 500;",
				"",
				"function watchConnectorProgram(transport: StdioClientTransport): ConnectorProgramWatch {",
				"  const watch: ConnectorProgramWatch = { output: [], otherOutput: false };",
				"  const keep = (line: string) => {",
				"    if (!line.trim()) return;",
				"    watch.output.push(line.slice(0, PROGRAM_LINE_LENGTH));",
				"    if (watch.output.length > PROGRAM_OUTPUT_LINES) watch.output.shift();",
				"  };",
				"  let partial = \"\";",
				"  // Read all the while it runs: a pipe nobody reads would stop the program once it fills.",
				"  transport.stderr?.on(\"data\", (chunk: Buffer) => {",
				"    const lines = (partial + chunk.toString(\"utf8\")).split(/\\r?\\n/);",
				"    partial = (lines.pop() ?? \"\").slice(-PROGRAM_LINE_LENGTH);",
				"    lines.forEach(keep);",
				"  });",
				"  transport.stderr?.on(\"end\", () => keep(partial));",
				"  // A line that is no JSON, or no protocol message: the program wrote something else where its answers go.",
				"  transport.onerror = (error) => {",
				"    if (error instanceof SyntaxError || Array.isArray((error as { issues?: unknown }).issues)) watch.otherOutput = true;",
				"  };",
				"  return watch;",
				"}",
				"",
				"/**",
				" * Resolve headers with environment variable interpolation.",
				" */",
				"",
			].join("\n"),
		],
	],
	START_CONSEQUENCE,
	"a connector program is looked for along the usual install folders and says why it didn't start",
);
applyRequiredPatch(
	"patch 14 (the npx lookup's environment and its first-run install)",
	path.join(adapterDir, "npx-resolver.ts"),
	[
		[
			"export async function resolveNpxBinary(\n  command: string,\n  args: string[]\n): Promise<NpxResolution | null> {\n",
			"export async function resolveNpxBinary(\n  command: string,\n  args: string[],\n  env?: Record<string, string>,\n  signal?: AbortSignal\n): Promise<NpxResolution | null> {\n",
		],
		[
			"  const cacheKey = JSON.stringify([command, ...args]);\n",
			"  // One package may sit in each connector's own npm cache.\n  const cacheKey = JSON.stringify([getNpmCacheDir(env), command, ...args]);\n",
		],
		[
			"  const resolved = resolveFromNpmCache(parsed.packageSpec, parsed.binName);\n",
			"  const resolved = resolveFromNpmCache(parsed.packageSpec, parsed.binName, env);\n",
		],
		[
			"  await forceNpxCache(parsed.packageSpec);\n  const resolvedAfterInstall = resolveFromNpmCache(parsed.packageSpec, parsed.binName);\n",
			"  await forceNpxCache(parsed.packageSpec, env, signal);\n  // A start stopped while it installed starts nothing.\n  signal?.throwIfAborted();\n  const resolvedAfterInstall = resolveFromNpmCache(parsed.packageSpec, parsed.binName, env);\n",
		],
		[
			"function resolveFromNpmCache(packageSpec: string, binName?: string): NpxCacheEntry | null {\n  const cacheDir = getNpmCacheDir();\n",
			"function resolveFromNpmCache(packageSpec: string, binName?: string, env?: Record<string, string>): NpxCacheEntry | null {\n  const cacheDir = getNpmCacheDir(env);\n",
		],
		[
			"const FORCE_CACHE_TIMEOUT_MS = 30_000;\n\nasync function forceNpxCache(packageSpec: string): Promise<void> {\n",
			"// A first run downloads the package, which can take a few minutes (scripts/patch-mcp-adapter.mjs, patch 14).\nconst FORCE_CACHE_TIMEOUT_MS = 5 * 60_000;\n\nasync function forceNpxCache(packageSpec: string, env?: Record<string, string>, signal?: AbortSignal): Promise<void> {\n",
		],
		[
			'        { stdio: "ignore" }\n',
			'        { stdio: "ignore", env, signal }\n',
		],
		[
			"let npmCacheDirCached: string | null | undefined;\n\nfunction getNpmCacheDir(): string | null {\n  if (npmCacheDirCached !== undefined) return npmCacheDirCached;\n  if (process.env.NPM_CONFIG_CACHE) {\n    npmCacheDirCached = process.env.NPM_CONFIG_CACHE;\n    return npmCacheDirCached;\n  }\n  try {\n    const result = spawnSync(\"npm\", [\"config\", \"get\", \"cache\"], { encoding: \"utf-8\" });\n    if (result.status === 0) {\n      const path = String(result.stdout).trim();\n      npmCacheDirCached = path || null;\n      return npmCacheDirCached;\n    }\n  } catch {\n    npmCacheDirCached = null;\n    return null;\n  }\n  npmCacheDirCached = null;\n  return null;\n}\n",
			[
				"// npm's answer for each home, PATH and npm setting a connector has; a connector's own cache setting wins over it, as for npm itself.",
				"const npmCacheDirs = new Map<string, string | null>();",
				"",
				"function getNpmCacheDir(env?: Record<string, string>): string | null {",
				"  const variables = env ?? process.env;",
				"  const configured = variables.npm_config_cache || variables.NPM_CONFIG_CACHE;",
				"  if (configured) return configured;",
				"  const npmSettings = Object.entries(variables).filter(([name]) => name.toLowerCase().startsWith(\"npm_config_\")).sort();",
				"  const key = JSON.stringify([variables.HOME, variables.USERPROFILE, variables.PATH, npmSettings]);",
				"  if (!npmCacheDirs.has(key)) {",
				"    let found: string | null = null;",
				"    try {",
				"      const result = spawnSync(\"npm\", [\"config\", \"get\", \"cache\"], { encoding: \"utf-8\", env });",
				"      if (result.status === 0) found = String(result.stdout).trim() || null;",
				"    } catch {",
				"      found = null;",
				"    }",
				"    npmCacheDirs.set(key, found);",
				"  }",
				"  return npmCacheDirs.get(key) ?? null;",
				"}",
				"",
			].join("\n"),
		],
	],
	START_CONSEQUENCE,
	"the npx lookup and its first-run install run with the connector's environment, for up to a few minutes",
);

// --- Patch 15: a connector's call ends when the answer stops, and not at 60 s --
// The library's own default ended every call after 60 s, whatever the
// connector reported, and nothing passed it the turn's signal, so Stop reached
// the connector only at that limit; patch 12 now hands the signal on. Each call now gets
// a signal of its own, ended by the turn's signal, by 5 minutes with no sign of
// life (each progress report starts the count again; asking for progress is
// what makes a connector send it) and by 60 minutes in all. Ending it sends the
// connector the cancel and ends the call at once, even when the connector goes
// on. A call one of these ended answers with `details.error` "stopped",
// "no_answer" or "too_long": apps/web-server/src/connector-call-ends.ts holds
// the words, and names these limits; change the two together. The library's
// own limit stays behind ours. A smoke's preload alone shortens them, on
// globalThis (smoke-connector-call-limits-preload.mjs). This one must apply:
// when it cannot, the install fails.
const CALL_CONSEQUENCE = "Stop would not reach a connector's call, and every call would end after 60 seconds";
const CONNECTOR_CALL_LIMITS = [
	"/** How a call one of ours ended (scripts/patch-mcp-adapter.mjs, patch 15). */",
	"export type ConnectorCallEnd = \"stopped\" | \"no_answer\" | \"too_long\";",
	"",
	"const CONNECTOR_CALL_SILENCE_MS = 5 * 60_000;",
	"const CONNECTOR_CALL_TOTAL_MS = 60 * 60_000;",
	"// What the connector is told when its call is cancelled.",
	"const CONNECTOR_CALL_CANCEL_REASONS: Record<ConnectorCallEnd, string> = {",
	"  stopped: \"The answer that made this call was stopped.\",",
	"  no_answer: \"Nothing came back for too long.\",",
	"  too_long: \"The call ran too long.\",",
	"};",
	"",
	"/**",
	" * One connector call's limits: the turn's signal, no sign of life for 5",
	" * minutes, 60 minutes in all. `start` as the call is sent gives the library's",
	" * request options; `ended` says which of ours ended the call; `done` once",
	" * it is over.",
	" */",
	"export function connectorCallLimits(signal?: AbortSignal) {",
	"  // Only a smoke's preload sets shorter ones.",
	"  const limits = (globalThis as { exxpertsConnectorCallLimits?: { silenceMs?: number; totalMs?: number } }).exxpertsConnectorCallLimits;",
	"  const silenceMs = limits?.silenceMs ?? CONNECTOR_CALL_SILENCE_MS;",
	"  const totalMs = limits?.totalMs ?? CONNECTOR_CALL_TOTAL_MS;",
	"  const controller = new AbortController();",
	"  let ended: ConnectorCallEnd | undefined;",
	"  let silence: ReturnType<typeof setTimeout> | undefined;",
	"  let total: ReturnType<typeof setTimeout> | undefined;",
	"  const end = (why: ConnectorCallEnd) => {",
	"    if (ended) return;",
	"    ended = why;",
	"    controller.abort(CONNECTOR_CALL_CANCEL_REASONS[why]);",
	"  };",
	"  const stop = () => end(\"stopped\");",
	"  const quiet = () => {",
	"    clearTimeout(silence);",
	"    silence = setTimeout(() => end(\"no_answer\"), silenceMs);",
	"  };",
	"  return {",
	"    start() {",
	"      if (signal?.aborted) end(\"stopped\");",
	"      else signal?.addEventListener(\"abort\", stop, { once: true });",
	"      quiet();",
	"      total = setTimeout(() => end(\"too_long\"), totalMs);",
	"      return { signal: controller.signal, onprogress: quiet, timeout: totalMs + 60_000 };",
	"    },",
	"    ended: () => ended,",
	"    done() {",
	"      clearTimeout(silence);",
	"      clearTimeout(total);",
	"      signal?.removeEventListener(\"abort\", stop);",
	"    },",
	"  };",
	"}",
	"",
	"",
].join("\n");
const callToolWith = (indent, nameExpr, argsExpr) => [
	[
		`${indent}const resultPromise = connection.client.callTool({\n${indent}  name: ${nameExpr},\n${indent}  arguments: ${argsExpr} ?? {},\n${indent}  _meta: uiSession?.requestMeta,\n${indent}});\n`,
		`${indent}const resultPromise = connection.client.callTool({\n${indent}  name: ${nameExpr},\n${indent}  arguments: ${argsExpr} ?? {},\n${indent}  _meta: uiSession?.requestMeta,\n${indent}}, undefined, connectorCall.start());\n`,
	],
];
// Patch 22 (below) builds on these lines of patch 15, which reads as patched in either form.
const PROXIED_CALLS_BY_CONNECTOR = [
		[
			'export type ConnectorCallEnd = "stopped" | "no_answer" | "too_long";\n',
			[
				'export type ConnectorCallEnd = "stopped" | "no_answer" | "too_long" | "removed";',
				"",
				"/** The calls running now, by connector, each with the end its connector's removal gives it (scripts/patch-mcp-adapter.mjs, patch 22). */",
				"function runningConnectorCalls(): Map<string, Set<() => void>> {",
				"  const holder = globalThis as { exxpertsConnectorCalls?: Map<string, Set<() => void>> };",
				"  return (holder.exxpertsConnectorCalls ??= new Map());",
				"}",
				"",
			].join("\n"),
		],
		[
			'  too_long: "The call ran too long.",\n',
			'  too_long: "The call ran too long.",\n  removed: "The connector was removed.",\n',
		],
		[
			"export function connectorCallLimits(signal?: AbortSignal) {\n",
			"export function connectorCallLimits(signal?: AbortSignal, server?: string) {\n",
		],
		[
			'  const stop = () => end("stopped");\n',
			'  const stop = () => end("stopped");\n  const removed = () => end("removed");\n',
		],
		[
			'      total = setTimeout(() => end("too_long"), totalMs);\n',
			[
				'      total = setTimeout(() => end("too_long"), totalMs);',
				"      if (server !== undefined) {",
				"        const calls = runningConnectorCalls();",
				"        calls.set(server, (calls.get(server) ?? new Set()).add(removed));",
				"      }",
				"",
			].join("\n"),
		],
		[
			'      signal?.removeEventListener("abort", stop);\n',
			[
				'      signal?.removeEventListener("abort", stop);',
				"      const calls = server === undefined ? undefined : runningConnectorCalls().get(server);",
				"      calls?.delete(removed);",
				"      if (calls?.size === 0) runningConnectorCalls().delete(server!);",
				"",
			].join("\n"),
		],
		[
			"  const connectorCall = connectorCallLimits(signal);\n",
			"  const connectorCall = connectorCallLimits(signal, serverName);\n",
		],
	];
const DIRECT_CALLS_BY_CONNECTOR = [[
		"    const connectorCall = connectorCallLimits(_signal);\n",
		"    const connectorCall = connectorCallLimits(_signal, spec.serverName);\n",
	]];
applyRequiredPatch(
	"patch 15 (a proxied call's stop and limits)",
	path.join(adapterDir, "proxy-modes.ts"),
	[
		["export async function executeCall(\n", `${CONNECTOR_CALL_LIMITS}export async function executeCall(\n`],
		[
			"  let uiSession: UiSessionRuntime | null = null;\n\n  try {\n    state.manager.touch(serverName);\n",
			"  let uiSession: UiSessionRuntime | null = null;\n  const connectorCall = connectorCallLimits(signal);\n\n  try {\n    state.manager.touch(serverName);\n",
		],
		...callToolWith("    ", "toolMeta.originalName", "args"),
		[
			"    const message = error instanceof Error ? error.message : String(error);\n    uiSession?.sendToolCancelled(message);\n\n    let errorWithSchema = ",
			"    const message = error instanceof Error ? error.message : String(error);\n    uiSession?.sendToolCancelled(message);\n    const ended = connectorCall.ended();\n    if (ended) {\n      return {\n        content: [{ type: \"text\" as const, text: `Failed to call tool: ${message}` }],\n        details: { mode: \"call\", error: ended, server: serverName, tool: toolMeta.originalName },\n      };\n    }\n\n    let errorWithSchema = ",
		],
		["    state.manager.decrementInFlight(serverName);\n", "    connectorCall.done();\n    state.manager.decrementInFlight(serverName);\n"],
	],
	CALL_CONSEQUENCE,
	"a proxied connector call ends when the answer stops, after 5 minutes with no sign of life, or after 60 minutes",
	{ builtOnBy: [PROXIED_CALLS_BY_CONNECTOR] },
);
applyRequiredPatch(
	"patch 15 (a direct tool's stop and limits)",
	path.join(adapterDir, "direct-tools.ts"),
	[
		["import { formatSchema } from \"./tool-metadata.ts\";\n", "import { formatSchema } from \"./tool-metadata.ts\";\nimport { connectorCallLimits } from \"./proxy-modes.ts\";\n"],
		[
			"    let uiSession: UiSessionRuntime | null = null;\n\n    try {\n      state.manager.touch(spec.serverName);\n",
			"    let uiSession: UiSessionRuntime | null = null;\n    const connectorCall = connectorCallLimits(_signal);\n\n    try {\n      state.manager.touch(spec.serverName);\n",
		],
		...callToolWith("      ", "spec.originalName", "params"),
		[
			"      const message = error instanceof Error ? error.message : String(error);\n      uiSession?.sendToolCancelled(message);\n      let errorText = ",
			"      const message = error instanceof Error ? error.message : String(error);\n      uiSession?.sendToolCancelled(message);\n      const ended = connectorCall.ended();\n      if (ended) {\n        return {\n          content: [{ type: \"text\" as const, text: `Failed to call tool: ${message}` }],\n          details: { error: ended, server: spec.serverName, tool: spec.originalName },\n        };\n      }\n      let errorText = ",
		],
		["      state.manager.decrementInFlight(spec.serverName);\n", "      connectorCall.done();\n      state.manager.decrementInFlight(spec.serverName);\n"],
	],
	CALL_CONSEQUENCE,
	"a direct connector tool's call ends when the answer stops, after 5 minutes with no sign of life, or after 60 minutes",
	{ builtOnBy: [DIRECT_CALLS_BY_CONNECTOR] },
);

// --- Patch 16: the saved tool list keeps each tool's title and marks ---------
// The adapter saved a tool's name, description and inputs only, and every
// connect, reconnect and session end rewrites a connector's whole entry, so the
// Connectors page lost each tool's own title and its read-only group once a
// room used it. Each saved tool now also keeps its title and its marks
// (`annotations`, read-only and destructive among them) as the connector gave
// them; the adapter reads saved tools by field name, so it reads nothing new.
// pi-package/extensions/mcp/tool-marks.ts reads them for the page.
applyRequiredPatch(
	"patch 16 (a saved tool's title and marks)",
	path.join(adapterDir, "metadata-cache.ts"),
	[
		[
			"      uiStreamMode: extractToolUiStreamMode(t._meta),\n    }));\n}\n",
			"      uiStreamMode: extractToolUiStreamMode(t._meta),\n      title: t.title,\n      annotations: (t as { annotations?: unknown }).annotations,\n    }));\n}\n",
		],
	],
	"the Connectors page would lose a tool's title and read-only group once a room used its connector",
	"a saved tool keeps its title and marks",
);

// --- Patch 18: a shared server's connector values open right before it connects --
// A shared server stores a connector's address, token and header values sealed
// with its storage key (apps/web-server/src/stored-values.ts). The adapter
// reads them only here, where it builds the web connection; the server's start
// sets globalThis.exxpertsOpenConnectorEntry, which gives the entry with every
// value opened, and throws for one that does not open. Without it, as on the
// desktop, nothing changes. Its own writes need nothing: it writes the entry
// it is given and passes the others through as stored. This one must apply:
// when it cannot, the install fails.
applyRequiredPatch(
	"patch 18 (a shared server's sealed connector values)",
	path.join(adapterDir, "server-manager.ts"),
	[
		[
			"  private async createHttpTransport(\n    definition: ServerDefinition,\n    serverName: string\n  ): Promise<Transport> {\n    const url = new URL(definition.url!);\n",
			"  private async createHttpTransport(\n    stored: ServerDefinition,\n    serverName: string\n  ): Promise<Transport> {\n    // A shared server stores a connector's address, token and header values\n    // sealed: they open here, right before the connection, and nowhere else.\n    const open = (globalThis as { exxpertsOpenConnectorEntry?: (name: string, entry: ServerDefinition) => ServerDefinition }).exxpertsOpenConnectorEntry;\n    const definition = open ? open(serverName, stored) : stored;\n    const url = new URL(definition.url!);\n",
		],
	],
	"a shared server's connectors would not open their address, token and headers, so none would connect",
	"a shared server's connector values open right before it connects",
);

// --- Patch 19: no sign-in helper without a stored sign-in -----------------------
// The adapter gave every web connection that may sign in a sign-in helper, so a
// 401 made the library find the service's sign-in server and register exxperts
// there in the background, from a Connectors page check, a room's start or its
// warm-up, though nobody started a sign-in. Now a connection gets the helper only
// where a sign-in is stored for its address, or where the connector carries its
// own client for a sign-in without a browser; without it a 401 ends the
// connection as needing a sign-in, as the helper's failed attempt did, with
// nothing registered. A registration happens only where a sign-in is started:
// Connect on the page, or the room's own sign-in start, which make a helper of
// their own. This one must apply: when it cannot, the install fails.
const SIGN_IN_CONSEQUENCE = "a connection with no stored sign-in would register exxperts at the service in the background";
applyRequiredPatch(
	"patch 19 (no sign-in helper without a stored sign-in)",
	path.join(adapterDir, "server-manager.ts"),
	[
		[
			'import { McpOAuthProvider } from "./mcp-oauth-provider.ts";\n',
			'import { McpOAuthProvider } from "./mcp-oauth-provider.ts";\nimport { getAuthForUrl } from "./mcp-auth.ts";\n',
		],
		[
			"    let authProvider: McpOAuthProvider | undefined;\n    if (supportsOAuth(definition)) {\n",
			[
				"    let authProvider: McpOAuthProvider | undefined;",
				"    // A sign-in helper only where a sign-in is stored for this address, or the connector carries its own client",
				"    // for a sign-in without a browser: otherwise a 401 would register at the service in the background",
				"    // (scripts/patch-mcp-adapter.mjs, patch 19). Connect starts a sign-in with a helper of its own.",
				"    const ownClient = definition.oauth ? definition.oauth.grantType === \"client_credentials\" && Boolean(definition.oauth.clientId) : false;",
				"    const signInLeftToPerson = supportsOAuth(definition) && !getAuthForUrl(serverName, definition.url!)?.tokens && !ownClient;",
				"    if (supportsOAuth(definition) && !signInLeftToPerson) {",
				"",
			].join("\n"),
		],
		[
			"      // SSE is the legacy transport\n",
			[
				"      // With no helper, a 401 is a sign-in to make, in the words the helper's attempt ended with, with nothing registered.",
				"      if (signInLeftToPerson && (error as { code?: unknown } | null)?.code === 401) {",
				"        throw new UnauthorizedError(`Re-authentication required for MCP server: ${serverName}`);",
				"      }",
				"",
				"      // SSE is the legacy transport",
				"",
			].join("\n"),
		],
	],
	SIGN_IN_CONSEQUENCE,
	"a connection with no stored sign-in registers nothing at the service",
);

// --- Patch 20: a room's start and end keep every sign-in ----------------------
// The adapter's session start and end each called shutdownOAuth(), which drops
// every sign-in waiting for the browser and stops the sign-in page's listener
// for the whole process. A room's conversation starts and ends often, and a
// sign-in begun on the Connectors page is no room's to cancel. The process's
// own end still stops everything. This one must apply: when it cannot, the
// install fails.
applyRequiredPatch(
	"patch 20 (a room's start and end keep every sign-in)",
	path.join(adapterDir, "index.ts"),
	[
		[
			'        shutdownState(previousState, "session_restart"),\n        shutdownOAuth(),\n',
			'        shutdownState(previousState, "session_restart"),\n        // A sign-in waiting on the Connectors page is no conversation\'s to cancel (scripts/patch-mcp-adapter.mjs, patch 20).\n',
		],
		[
			'        shutdownState(currentState, "session_shutdown"),\n        shutdownOAuth(),\n',
			'        shutdownState(currentState, "session_shutdown"),\n        // A sign-in waiting on the Connectors page is no conversation\'s to cancel (scripts/patch-mcp-adapter.mjs, patch 20).\n',
		],
	],
	"ending a conversation would cancel a sign-in waiting on the Connectors page",
	"a room's start and end keep every sign-in",
);

// --- Patch 21: every connection manager can be reached to end a connector -----
// A removed connector must stop in every conversation at once, but each
// conversation's connections live in its own manager. Each manager now puts
// itself in a set on globalThis as it is made and as it connects, and takes
// itself out in closeAll; apps/web-server/src/connector-close-all.ts reads the
// set. Its new endConnector ends a start under way wherever it has got to,
// its handshake or its first tool list (its program exits, as when a start
// fails), closes the connector's connection, and refuses to connect that name
// again, so a keep-alive check or a late call starts nothing. A start's caller
// that gives it a signal ends it the same way, a warm-up's limit included.
// This one must apply: when it cannot, the install fails.
applyRequiredPatch(
	"patch 21 (the connection managers' registry)",
	path.join(adapterDir, "server-manager.ts"),
	[
		[
			"export class McpServerManager {\n  private connections = new Map<string, ServerConnection>();\n",
			[
				"/** The connection managers alive in this process, for exxperts' removal of a connector (scripts/patch-mcp-adapter.mjs, patch 21). */",
				"function connectorManagers(): Set<McpServerManager> {",
				"  const holder = globalThis as { exxpertsConnectorManagers?: Set<McpServerManager> };",
				"  return (holder.exxpertsConnectorManagers ??= new Set());",
				"}",
				"",
				"export class McpServerManager {",
				"  private connections = new Map<string, ServerConnection>();",
				"  // Connectors removed while this manager lived: none connects again here.",
				"  private endedConnectors = new Set<string>();",
				"  // Each start under way, so a removal can end it.",
				"  private startsUnderWay = new Map<string, AbortController>();",
				"",
				"  constructor() {",
				"    connectorManagers().add(this);",
				"  }",
				"",
				"  /** Ends this connector here: a start under way is ended, its connection closes, and none starts again. */",
				"  async endConnector(name: string): Promise<void> {",
				"    this.endedConnectors.add(name);",
				"    this.startsUnderWay.get(name)?.abort(new Error(`Connector \"${name}\" was removed.`));",
				"    // A start that completes all the same closes once it has.",
				"    const starting = this.connectPromises.get(name);",
				"    if (starting) void starting.then(() => this.close(name), () => {});",
				"    await this.close(name);",
				"  }",
				"",
			].join("\n"),
		],
		[
			"    // Dedupe concurrent connection attempts\n    if (this.connectPromises.has(name)) {\n",
			"    // Dedupe concurrent connection attempts\n    if (this.endedConnectors.has(name)) throw new Error(`Connector \"${name}\" was removed.`);\n    if (this.connectPromises.has(name)) {\n",
		],
		[
			"    const client = this.createClient(name);\n",
			[
				"    // A removal ends this start while it is under way (endConnector), and so does its caller's own end.",
				"    const underWay = new AbortController();",
				"    this.startsUnderWay.set(name, underWay);",
				"    const callerEnd = start?.signal;",
				"    callerEnd?.addEventListener(\"abort\", () => { if (this.startsUnderWay.get(name) === underWay) underWay.abort(callerEnd.reason); }, { once: true });",
				"    start = { ...start, signal: callerEnd ? AbortSignal.any([callerEnd, underWay.signal]) : underWay.signal };",
				"    const client = this.createClient(name);",
				"    // Past its handshake, a start still listing its tools ends too: closing the client closes its program.",
				"    underWay.signal.addEventListener(\"abort\", () => void client.close().catch(() => {}), { once: true });",
				"",
			].join("\n"),
		],
		[
			"      const connection = await promise;\n      this.connections.set(name, connection);\n",
			"      const connection = await promise;\n      this.connections.set(name, connection);\n      connectorManagers().add(this);\n",
		],
		[
			"    } finally {\n      this.connectPromises.delete(name);\n",
			"    } finally {\n      this.connectPromises.delete(name);\n      this.startsUnderWay.delete(name);\n",
		],
		[
			"  async closeAll(): Promise<void> {\n",
			"  async closeAll(): Promise<void> {\n    connectorManagers().delete(this);\n",
		],
	],
	"removing a connector would leave its programs running in open conversations",
	"every connection manager can be reached to end a connector",
);

// --- Patch 22: a connector's running calls are kept by connector --------------
// On top of patch 15's text. Each call patch 15 tracks is now also kept by its
// connector, in a map on globalThis, with a new end, "removed", which
// apps/web-server/src/connector-close-all.ts gives every running call of a
// removed connector: the connector is told to cancel and the call ends at once,
// as for the other ends. apps/web-server/src/connector-call-ends.ts holds its
// words. This one must apply: when it cannot, the install fails.
const BY_CONNECTOR_CONSEQUENCE = "removing a connector would leave its running calls going";
applyRequiredPatch(
	"patch 22 (a proxied call kept by its connector)",
	path.join(adapterDir, "proxy-modes.ts"),
	PROXIED_CALLS_BY_CONNECTOR,
	BY_CONNECTOR_CONSEQUENCE,
	"a proxied connector call is kept by its connector, so its removal ends it",
);
applyRequiredPatch(
	"patch 22 (a direct tool's call kept by its connector)",
	path.join(adapterDir, "direct-tools.ts"),
	DIRECT_CALLS_BY_CONNECTOR,
	BY_CONNECTOR_CONSEQUENCE,
	"a direct connector tool's call is kept by its connector, so its removal ends it",
);

// --- Patch 23: a connector's changed tool list is read again -------------------
// The adapter ignored a connector's notice that its tools or documents changed,
// so a tool added mid-conversation was "not found". On either notice the
// manager lists both again, at once for the first notice and once more after
// that listing has answered and the quiet time is over (LIST_CHANGED_QUIET_MS:
// a connector that sends notices in a loop is listed at most twice a second,
// and one connection's listings never overlap), and the session takes the new list
// into its tools and the saved list, as after a reconnect. A listing that fails
// keeps the old list, as Claude Code does. A new tool passes the room's gate
// like any other: the gate reads the live tool at each call. Rooms work without
// it, as before, so it warns instead of failing the install.
const LIST_CONSEQUENCE = "a tool a connector adds mid-conversation would stay unknown";
applyRequiredPatch(
	"patch 23 (a changed tool list is read again)",
	path.join(adapterDir, "server-manager.ts"),
	[
		[
			"  ElicitationCompleteNotificationSchema,\n  type ReadResourceResult,\n",
			"  ElicitationCompleteNotificationSchema,\n  ResourceListChangedNotificationSchema,\n  ToolListChangedNotificationSchema,\n  type ReadResourceResult,\n",
		],
		[
			"  private attachAdapterNotificationHandlers(serverName: string, client: Client): void {\n",
			[
				"  /** Told once a connector's tools and documents were listed again after its notice, with the new lists on its connection. */",
				"  onListChanged?: (serverName: string) => void;",
				"  private listingAgain = new WeakMap<Client, { again: boolean }>();",
				"",
				"  // The first notice lists at once; more before that listing has answered and the quiet time is over list once more",
				"  // after both, so one connection's listings never overlap and an older answer never lands last (scripts/patch-mcp-adapter.mjs, patch 23).",
				"  private listAgainSoon(serverName: string, client: Client): void {",
				"    const burst = this.listingAgain.get(client);",
				"    if (burst) {",
				"      burst.again = true;",
				"      return;",
				"    }",
				"    const started = { again: false };",
				"    this.listingAgain.set(client, started);",
				"    const quiet = new Promise<void>((resolve) => {",
				"      setTimeout(resolve, LIST_CHANGED_QUIET_MS).unref?.();",
				"    });",
				"    void Promise.all([this.listAgain(serverName, client), quiet]).then(() => {",
				"      this.listingAgain.delete(client);",
				"      if (started.again) this.listAgainSoon(serverName, client);",
				"    });",
				"  }",
				"",
				"  private async listAgain(serverName: string, client: Client): Promise<void> {",
				"    try {",
				"      const [tools, resources] = await Promise.all([this.fetchAllTools(client), this.fetchAllResources(client)]);",
				"      const connection = this.connections.get(serverName);",
				"      // A connection closed or replaced meanwhile keeps what it has.",
				"      if (connection?.client !== client || connection.status !== \"connected\") return;",
				"      connection.tools = tools;",
				"      connection.resources = resources;",
				"      this.onListChanged?.(serverName);",
				"    } catch {",
				"      // The old list stays.",
				"    }",
				"  }",
				"",
				"  private attachAdapterNotificationHandlers(serverName: string, client: Client): void {",
				"    client.setNotificationHandler(ToolListChangedNotificationSchema, () => this.listAgainSoon(serverName, client));",
				"    client.setNotificationHandler(ResourceListChangedNotificationSchema, () => this.listAgainSoon(serverName, client));",
				"",
			].join("\n"),
		],
		[
			"type UiStreamListener = ",
			"// How long after a list notice more notices count as the same burst (scripts/patch-mcp-adapter.mjs, patch 23).\nconst LIST_CHANGED_QUIET_MS = 500;\n\ntype UiStreamListener = ",
		],
	],
	LIST_CONSEQUENCE,
	"a connector's changed tool list is listed again",
	{ warnOnly: true },
);
applyRequiredPatch(
	"patch 23 (a session takes a connector's changed list)",
	path.join(adapterDir, "init.ts"),
	[[
		"  lifecycle.setReconnectCallback((serverName) => {\n",
		[
			"  // A connector's changed tools and documents reach this session and the saved list (scripts/patch-mcp-adapter.mjs, patch 23).",
			"  manager.onListChanged = (serverName) => {",
			"    updateServerMetadata(state, serverName);",
			"    updateMetadataCache(state, serverName);",
			"  };",
			"",
			"  lifecycle.setReconnectCallback((serverName) => {",
			"",
		].join("\n"),
	]],
	LIST_CONSEQUENCE,
	"a session takes a connector's changed tool list into its tools and the saved list",
	{ warnOnly: true },
);

// --- Patch 24: a connector's own instructions reach the assistant --------------
// A connector may give instructions for its use as it connects; the adapter
// never read them. The connection now keeps them, cut at 4,096 characters as
// Claude Code cuts them ("" for a connector that gives none, so none and not
// yet read differ), the saved list keeps them with the tools, and the mcp
// tool's description gives each connector's under its name. A room's
// description passes only the room's connectors, so only theirs reach it
// (pi-package/extensions/mcp/room-scope.ts, whose warm-up saves them too).
// Rooms work without it, as before, so it warns instead of failing the install.
const INSTRUCTIONS_CONSEQUENCE = "a connector's own instructions would not reach the assistant";
const INSTRUCTIONS_MAX = 4096;
applyRequiredPatch(
	"patch 24 (a connection keeps its connector's instructions)",
	path.join(adapterDir, "server-manager.ts"),
	[
		[
			'  status: "connected" | "closed" | "needs-auth";\n}\n',
			`  status: "connected" | "closed" | "needs-auth";\n  /** The connector's own instructions, cut at ${INSTRUCTIONS_MAX} characters; "" when it gives none (scripts/patch-mcp-adapter.mjs, patch 24). */\n  instructions?: string;\n}\n`,
		],
		[
			'        lastUsedAt: Date.now(),\n        inFlight: 0,\n        status: "connected",\n',
			`        lastUsedAt: Date.now(),\n        inFlight: 0,\n        status: "connected",\n        instructions: (client.getInstructions() ?? "").slice(0, ${INSTRUCTIONS_MAX}),\n`,
		],
	],
	INSTRUCTIONS_CONSEQUENCE,
	"a connection keeps its connector's instructions",
	{ warnOnly: true },
);
applyRequiredPatch(
	"patch 24 (the saved list keeps a connector's instructions)",
	path.join(adapterDir, "metadata-cache.ts"),
	[[
		"  resources: CachedResource[];\n  cachedAt: number;\n}\n",
		"  resources: CachedResource[];\n  cachedAt: number;\n  /** The connector's own instructions; \"\" when it gives none, absent when not read yet (scripts/patch-mcp-adapter.mjs, patch 24). */\n  instructions?: string;\n}\n",
	]],
	INSTRUCTIONS_CONSEQUENCE,
	"the saved list keeps a connector's instructions",
	{ warnOnly: true },
);
applyRequiredPatch(
	"patch 24 (a session saves a connector's instructions)",
	path.join(adapterDir, "init.ts"),
	[[
		"  const entry: ServerCacheEntry = {\n    configHash,\n    tools,\n    resources,\n    cachedAt: Date.now(),\n  };\n",
		"  const entry: ServerCacheEntry = {\n    configHash,\n    tools,\n    resources,\n    cachedAt: Date.now(),\n    ...(connection.instructions === undefined ? {} : { instructions: connection.instructions }),\n  };\n",
	]],
	INSTRUCTIONS_CONSEQUENCE,
	"a session saves a connector's instructions with its tools",
	{ warnOnly: true },
);
applyRequiredPatch(
	"patch 24 (the description gives each connector's instructions)",
	path.join(adapterDir, "direct-tools.ts"),
	[[
		"  if (serverSummaries.length > 0) {\n    desc += `\\nServers: ${serverSummaries.join(\", \")}\\n`;\n  }\n",
		[
			"  if (serverSummaries.length > 0) {",
			"    desc += `\\nServers: ${serverSummaries.join(\", \")}\\n`;",
			"  }",
			"",
			"  // Each connector's own instructions, under its name, from an entry for its address now (scripts/patch-mcp-adapter.mjs, patch 24).",
			"  for (const serverName of Object.keys(config.mcpServers)) {",
			"    const entry = cache?.servers?.[serverName];",
			"    const instructions = entry && isServerCacheValid(entry, config.mcpServers[serverName]) ? entry.instructions : undefined;",
			`    if (typeof instructions === "string" && instructions.trim()) desc += \`\\nInstructions from the connector \${serverName}:\\n\${instructions.slice(0, ${INSTRUCTIONS_MAX})}\\n\`;`,
			"  }",
			"",
		].join("\n"),
	]],
	INSTRUCTIONS_CONSEQUENCE,
	"the mcp tool's description gives each connector's instructions",
	{ warnOnly: true },
);

// --- Patch 25: a call the service refused keeps its status --------------------
// A connector that connects and lists its tools may still refuse one call with
// a 401 or 403. The library keeps that status only on its transport error's
// `code`, and the adapter's failed call kept the message alone, the service's
// own words. The failed call's details now keep `httpStatus` when the
// transport's own error carried a 401 or 403: never the body or a header, and
// never a status a connector writes in its answer.
// pi-package/extensions/mcp/room-scope.ts reads it through
// apps/web-server/src/connector-call-failures.ts, so the step says what the
// refusal means for the person. Without it the step reads as a connector's
// error, as before, so it warns instead of failing the install.
const STATUS_CONSEQUENCE = "a call the service refused would read as the connector's own error";
const proxiedRefusalKept = applyRequiredPatch(
	"patch 25 (a proxied call keeps the service's refusal)",
	path.join(adapterDir, "proxy-modes.ts"),
	[
		[
			'import { UrlElicitationRequiredError } from "@modelcontextprotocol/sdk/types.js";\n',
			'import { UrlElicitationRequiredError } from "@modelcontextprotocol/sdk/types.js";\nimport { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";\nimport { SseError } from "@modelcontextprotocol/sdk/client/sse.js";\n',
		],
		[
			"/** How a call one of ours ended (scripts/patch-mcp-adapter.mjs, patch 15). */\n",
			[
				"/** A 401 or 403 the transport's own error carried, for a failed call's details; never its body (scripts/patch-mcp-adapter.mjs, patch 25). */",
				"export function transportRefusalStatus(error: unknown): { httpStatus?: 401 | 403 } {",
				"  if (!(error instanceof StreamableHTTPError) && !(error instanceof SseError)) return {};",
				"  return error.code === 401 || error.code === 403 ? { httpStatus: error.code } : {};",
				"}",
				"",
				"/** How a call one of ours ended (scripts/patch-mcp-adapter.mjs, patch 15). */",
				"",
			].join("\n"),
		],
		[
			'      details: { mode: "call", error: "call_failed", message },\n',
			'      details: { mode: "call", error: "call_failed", message, ...transportRefusalStatus(error) },\n',
		],
	],
	STATUS_CONSEQUENCE,
	"a proxied call the service refused keeps its status",
	{ warnOnly: true },
);
// The direct half reads the proxied half's helper: without it, it stays out too.
if (!proxiedRefusalKept) console.warn("patch-mcp-adapter: patch 25 (a direct tool's call keeps the service's refusal) needs the proxied half; skipping");
else applyRequiredPatch(
	"patch 25 (a direct tool's call keeps the service's refusal)",
	path.join(adapterDir, "direct-tools.ts"),
	[
		[
			'import { formatSchema } from "./tool-metadata.ts";\n',
			'import { transportRefusalStatus } from "./proxy-modes.ts";\nimport { formatSchema } from "./tool-metadata.ts";\n',
		],
		[
			'        details: { error: "call_failed", server: spec.serverName },\n',
			'        details: { error: "call_failed", server: spec.serverName, ...transportRefusalStatus(error) },\n',
		],
	],
	STATUS_CONSEQUENCE,
	"a direct tool's call the service refused keeps its status",
	{ warnOnly: true },
);

// --- Patch 26: a conversation's end ends its connectors' starts ----------------
// A session starts its eager connectors in the background, and a scheduled run
// or a conversation closed at once can end before they have. The adapter's end
// found no state yet, so it closed nothing; the start then failed on the
// ended session's context, and a failed start's manager is held by nobody, so
// a connector that had connected ran on until the server stopped. Now the end
// waits for the start under way, whose own close of a start that is no longer
// the newest then runs (room-session-end.ts bounds the wait), and a start that
// fails closes what it had connected, a start slower than that wait included.
// This one must apply: when it cannot, the install fails.
const START_END_CONSEQUENCE = "a connector still starting when its conversation ends would run on after it";
applyRequiredPatch(
	"patch 26 (a conversation's end waits for its connectors' start)",
	path.join(adapterDir, "index.ts"),
	[
		[
			"  let initPromise: Promise<McpExtensionState> | null = null;\n",
			"  let initPromise: Promise<McpExtensionState> | null = null;\n  // The newest start, until its state is kept or, no longer the newest, closed (scripts/patch-mcp-adapter.mjs, patch 26).\n  let startSettling: Promise<void> | null = null;\n",
		],
		[
			"    promise.then(async (nextState) => {\n",
			"    startSettling = promise.then(async (nextState) => {\n",
		],
		[
			"    ++lifecycleGeneration;\n    const currentState = state;\n",
			"    ++lifecycleGeneration;\n    const currentState = state;\n    const settling = startSettling;\n    startSettling = null;\n",
		],
		[
			"patch 20).\n      ]);\n    } catch (error) {\n      console.error(\"MCP: session shutdown cleanup failed\", error);\n",
			"patch 20).\n        // A start under way settles, and closes, as this session's (scripts/patch-mcp-adapter.mjs, patch 26).\n        settling,\n      ]);\n    } catch (error) {\n      console.error(\"MCP: session shutdown cleanup failed\", error);\n",
		],
	],
	START_END_CONSEQUENCE,
	"a conversation's end waits for its connectors' start",
);
applyRequiredPatch(
	"patch 26 (a failed start closes what it connected)",
	path.join(adapterDir, "init.ts"),
	[
		[
			"export async function initializeMcp(\n  pi: ExtensionAPI,\n  ctx: ExtensionContext\n): Promise<McpExtensionState> {\n",
			[
				"export async function initializeMcp(",
				"  pi: ExtensionAPI,",
				"  ctx: ExtensionContext",
				"): Promise<McpExtensionState> {",
				"  // A start that fails, its session ended under it among other causes, closes what it had connected:",
				"  // nobody else holds its manager (scripts/patch-mcp-adapter.mjs, patch 26).",
				"  const started: { manager?: McpServerManager } = {};",
				"  try {",
				"    return await startMcp(pi, ctx, started);",
				"  } catch (error) {",
				"    await started.manager?.closeAll().catch(() => {});",
				"    throw error;",
				"  }",
				"}",
				"",
				"async function startMcp(",
				"  pi: ExtensionAPI,",
				"  ctx: ExtensionContext,",
				"  started: { manager?: McpServerManager },",
				"): Promise<McpExtensionState> {",
				"",
			].join("\n"),
		],
		[
			"  const manager = new McpServerManager();\n",
			"  const manager = new McpServerManager();\n  started.manager = manager;\n",
		],
	],
	START_END_CONSEQUENCE,
	"a failed start closes what it connected",
);

// --- Patch 27: a link the adapter opens is a web link, and no shell reads it --
// The adapter handed links to the system's opener in three places: a
// connector's sign-in address, which its own server names; a connector's
// request to open a link; and the browser for a connector's own page. The
// first two went through the `open` package, which on Windows puts the link
// inside a PowerShell command (so `$(...)` in a sign-in address ran), the last
// through `cmd /c start`; on a Mac a file:, smb: or custom address opened that
// app or share. Now all three open through `openWebLink`, in a file of the
// adapter's own that this patch writes (web-link.ts): it parses the link,
// refuses anything but http and https and a host name with characters no web
// address has (the one part where the parser leaves a quote), and hands the parsed link to the
// system's opener as one argument, with no shell (on Windows rundll32 by its
// full path). A sign-in whose address is refused ends at once with the error,
// before its callback waits, instead of waiting for one. utils.ts's openUrl
// hands its link to the same helper, so no URL reaches `cmd /c start` there;
// openPath, for a file the terminal panel lists, keeps it. This one must
// apply: when it cannot, the install fails. Its utils.ts part only warns: a
// smoke writes its own utils.ts, with no openUrl, and runs this script on it;
// nothing in the adapter calls openUrl since init.ts is pointed at the helper.
const LINK_CONSEQUENCE = "a connector's sign-in address could run a command on Windows, or open a local app on a Mac";
const WEB_LINK_FILE = [
	"// Written by scripts/patch-mcp-adapter.mjs, patch 27.",
	"import { spawn } from \"node:child_process\";",
	"import { win32 } from \"node:path\";",
	"",
	"/**",
	" * A link the browser may open: an http or https address, parsed, whose host",
	" * name is letters, digits, dots, hyphens and underscores (an international",
	" * name arrives as punycode) or a bracketed IPv6 address. The host is the",
	" * one part where the parser leaves a quote, so this keeps one out of the",
	" * whole link. The words name nothing the link chose. Any other throws.",
	" */",
	"export function webLinkOf(link: string): URL {",
	"  const url = new URL(link);",
	"  if (url.protocol !== \"http:\" && url.protocol !== \"https:\") {",
	"    throw new Error(\"Not opened: this is not a web address\");",
	"  }",
	"  if (!/^(\\[[0-9a-f:.]+\\]|[a-z0-9._-]+)$/.test(url.hostname)) {",
	"    throw new Error(\"Not opened: this address's host name has characters a web address can't have\");",
	"  }",
	"  return url;",
	"}",
	"",
	"/**",
	" * Opens a web link in the person's browser. The parsed link goes to the",
	" * system's opener as one argument and no shell reads it: on Windows",
	" * rundll32, by its full path, never cmd or PowerShell. Refuses anything but",
	" * http and https; resolves once the opener has started.",
	" */",
	"export async function openWebLink(link: string): Promise<void> {",
	"  const href = webLinkOf(link).href;",
	"  const [program, args]: [string, string[]] =",
	"    process.platform === \"win32\"",
	"      ? [win32.join(process.env.SystemRoot || \"C:\\\\Windows\", \"System32\", \"rundll32.exe\"), [\"url.dll,FileProtocolHandler\", href]]",
	"      : process.platform === \"darwin\"",
	"        ? [\"open\", [href]]",
	"        : [\"xdg-open\", [href]];",
	"  await new Promise<void>((resolve, reject) => {",
	"    const opener = spawn(program, args, { stdio: \"ignore\", detached: true });",
	"    opener.once(\"error\", reject);",
	"    opener.once(\"spawn\", () => {",
	"      opener.unref();",
	"      resolve();",
	"    });",
	"  });",
	"}",
	"",
].join("\n");
try {
	const webLinkPath = path.join(adapterDir, "web-link.ts");
	if (fs.existsSync(webLinkPath) && fs.readFileSync(webLinkPath, "utf-8") === WEB_LINK_FILE) {
		console.log("patch-mcp-adapter: patch 27 (the link opener) already patched");
	} else {
		fs.writeFileSync(webLinkPath, WEB_LINK_FILE);
		console.log("patch-mcp-adapter: the adapter opens a link only as a web link, with no shell");
	}
} catch (e) {
	console.error(`patch-mcp-adapter: ERROR patch 27 (the link opener) failed (${e.message}); ${LINK_CONSEQUENCE}`);
	process.exitCode = 1;
}
applyRequiredPatch(
	"patch 27 (the sign-in address)",
	path.join(adapterDir, "mcp-auth-flow.ts"),
	[
		["import open from \"open\"\n", "import { openWebLink, webLinkOf } from \"./web-link.ts\"\n"],
		[
			"      console.log(`MCP Auth: Open this URL to authenticate ${serverName}:\\n${authorizationUrl}`)\n      try {\n        await open(authorizationUrl)\n",
			"      console.log(`MCP Auth: Open this URL to authenticate ${serverName}:\\n${webLink}`)\n      try {\n        await openWebLink(webLink)\n",
		],
		[
			"    // Register the callback BEFORE opening the browser\n    const callbackPromise = waitForCallback(oauthState)\n",
			"    // Anything but a web link ends the sign-in here, before its callback waits (patch 27).\n    let webLink: string\n    try {\n      webLink = webLinkOf(authorizationUrl).href\n    } catch (error) {\n      await clearPendingAuth(serverName, oauthState)\n      throw error\n    }\n\n    // Register the callback BEFORE opening the browser\n    const callbackPromise = waitForCallback(oauthState)\n",
		],
	],
	LINK_CONSEQUENCE,
	"a connector's sign-in address opens only as a web link",
);
applyRequiredPatch(
	"patch 27 (a connector's link request)",
	path.join(adapterDir, "elicitation-handler.ts"),
	[
		["import open from \"open\";\n", "import { openWebLink } from \"./web-link.ts\";\n"],
		["    await open(params.url);\n", "    await openWebLink(parsed.href);\n"],
	],
	"a connector's link request would open the link as sent, not as checked",
	"a connector's link request opens the checked link only",
);
applyRequiredPatch(
	"patch 27 (a connector page's browser)",
	path.join(adapterDir, "init.ts"),
	[
		["import { openUrl, parallelLimit } from \"./utils.ts\";\n", "import { parallelLimit } from \"./utils.ts\";\nimport { openWebLink } from \"./web-link.ts\";\n"],
		["    openBrowser: (url: string) => openUrl(pi, url, process.env.BROWSER),\n", "    // A web link only, with no shell; the BROWSER setting is not followed (patch 27).\n    openBrowser: (url: string) => openWebLink(url),\n"],
	],
	"a connector's own page would open through cmd on Windows",
	"a connector's own page opens only as a web link",
);
// utils.ts's openUrl: warns, never fails (see above).
const OPEN_URL_PLACES = [
	["import type { McpConfig, ServerEntry } from \"./types.ts\";\n", "import type { McpConfig, ServerEntry } from \"./types.ts\";\nimport { openWebLink } from \"./web-link.ts\";\n"],
	[
		"  const result = await execOpen(pi, url, browser);\n  if (result.code !== 0) {\n    throw new Error(result.stderr || `Failed to open browser (exit code ${result.code})`);\n  }\n",
		"  // A web link only, with no shell; `browser` is not followed (patch 27).\n  await openWebLink(url);\n",
	],
];
try {
	const utilsPath = path.join(adapterDir, "utils.ts");
	const source = fs.readFileSync(utilsPath, "utf-8");
	if (OPEN_URL_PLACES.every(([, to]) => source.includes(to))) {
		console.log("patch-mcp-adapter: patch 27 (openUrl) already patched");
	} else if (!OPEN_URL_PLACES.every(([from]) => source.split(from).length === 2)) {
		console.warn("patch-mcp-adapter: patch 27 (openUrl) places not found once in utils.ts (adapter changed?): its openUrl is not pointed at the web link opener");
	} else {
		fs.writeFileSync(utilsPath, OPEN_URL_PLACES.reduce((text, [from, to]) => text.replace(from, () => to), source));
		console.log("patch-mcp-adapter: utils.ts's openUrl opens only a web link, with no shell");
	}
} catch (e) {
	console.warn(`patch-mcp-adapter: patch 27 (openUrl) skipped (${e.message})`);
}

// --- Patch 28: a connector's form is one card in a room ----------------------
// The adapter asks a connector's form one card per field, then a review. A UI
// that has `askForm` (a room's, apps/web-server/src/web-ui-context.ts, through
// pi-package/extensions/mcp/room-scope.ts) gets the whole form at once, with
// the adapter's own check of an answer and the signal that ends when the
// connector stops waiting; without it, as in the terminal or a scheduled run,
// the cards stay. When it can't apply, the install goes on and a room asks
// card by card, as before.
const FORM_ASK = [
	"  // A UI that draws a whole form gets it at once, checked by this file's own rule (exxperts' scripts/patch-mcp-adapter.mjs, patch 28).",
	"  const askForm = (options.ui as { askForm?: (form: { server: string; params: ElicitRequestFormParams; check: typeof coerceAndValidateFormValues }, signal?: AbortSignal) => Promise<ElicitResult> }).askForm;",
	"  if (typeof askForm === \"function\") return askForm.call(options.ui, { server: options.serverName, params, check: coerceAndValidateFormValues }, signal);",
	"",
].join("\n");
const formReplacements = [
	[
		"  client.setRequestHandler(ElicitRequestSchema, (request) =>\n    handleElicitationRequest(options, request));\n",
		"  client.setRequestHandler(ElicitRequestSchema, (request, extra) =>\n    handleElicitationRequest(options, request, extra.signal));\n",
	],
	[
		"  request: ElicitRequest,\n): Promise<ElicitResult> {\n  return request.params.mode === \"url\"\n    ? handleUrlElicitation(options, request.params)\n    : handleFormElicitation(options, request.params);\n",
		"  request: ElicitRequest,\n  signal?: AbortSignal,\n): Promise<ElicitResult> {\n  return request.params.mode === \"url\"\n    ? handleUrlElicitation(options, request.params)\n    : handleFormElicitation(options, request.params, signal);\n",
	],
	[
		"  params: ElicitRequestFormParams,\n): Promise<ElicitResult> {\n  const decision = await options.ui.select(\n",
		`  params: ElicitRequestFormParams,\n  signal?: AbortSignal,\n): Promise<ElicitResult> {\n${FORM_ASK}  const decision = await options.ui.select(\n`,
	],
];
try {
	const formFile = path.join(adapterDir, "elicitation-handler.ts");
	const source = fs.readFileSync(formFile, "utf-8");
	const patched = formReplacements.filter(([, to]) => source.includes(to));
	if (patched.length === formReplacements.length) {
		console.log("patch-mcp-adapter: patch 28 (a connector's form as one card) already patched");
	} else if (patched.length > 0 || formReplacements.some(([from]) => source.split(from).length !== 2)) {
		console.warn("patch-mcp-adapter: patch 28 (a connector's form as one card) not applied (adapter changed?): a room asks a connector's form card by card");
	} else {
		fs.writeFileSync(formFile, formReplacements.reduce((text, [from, to]) => text.replace(from, () => to), source));
		console.log("patch-mcp-adapter: a room asks a connector's form as one card");
	}
} catch (e) {
	console.warn(`patch-mcp-adapter: patch 28 (a connector's form as one card) skipped (${e.message}): a room asks a connector's form card by card`);
}

// --- Patch 29: no connector is offered the person's model ---------------------
// A connector can ask the app to run a text on the person's model (MCP
// sampling). exxperts offers it to none: the connection manager keeps no
// sampling config, whoever sets one (the adapter's init.ts in a room, the
// Connectors page's check) and whatever the connector settings say, so no
// connection declares it and no handler answers it: a connector that asks
// anyway gets the protocol's refusal, and no model is called. This one must
// apply: when it cannot, the install fails.
applyRequiredPatch(
	"patch 29 (no model offered to a connector)",
	path.join(adapterDir, "server-manager.ts"),
	[
		[
			"  setSamplingConfig(config: ServerSamplingConfig | undefined): void {\n    this.samplingConfig = config;\n  }\n",
			"  // exxperts offers no connector the person's model (scripts/patch-mcp-adapter.mjs, patch 29): no config is kept.\n  setSamplingConfig(_config: ServerSamplingConfig | undefined): void {\n    this.samplingConfig = undefined;\n  }\n",
		],
	],
	"a connector could run texts on the person's model, on their account",
	"no connector is offered the person's model",
);
