/**
 * Curated connector directory. Every endpoint here was live-verified against
 * the actual server (an MCP endpoint answers an initialize POST with 200, or
 * 401 when it wants OAuth/token auth) — keep it that way when adding entries.
 *
 * Order is the display order of the directory on the Connectors page: most
 * popular / highest value-add first, entries that need manual setup last, so
 * they sit next to the custom-connector card.
 *
 * kind:
 * - "open"         — works immediately, no login
 * - "oauth"        — one-click login (dynamic client registration verified
 *                    live, path-aware .well-known discovery)
 * - "token"        — needs an API token pasted once
 * - "oauth-client" — OAuth without dynamic registration: needs a
 *                    pre-registered app (client ID/secret) created in the
 *                    provider's developer settings; card opens the custom
 *                    form with the Custom OAuth client section
 * - "guided"       — needs own credentials/tenant setup; card links the guide
 */

export interface ConnectorCatalogEntry {
	id: string;
	name: string;
	description: string;
	kind: "open" | "oauth" | "token" | "oauth-client" | "guided";
	url?: string;
	tokenHint?: string;
	docsUrl?: string;
	/** Shown on the directory card under its description: what it needs to connect, two short sentences at most. */
	shortNote?: string;
	/** Full setup instructions, shown in the add form. */
	guideNote?: string;
}

export const CONNECTOR_CATALOG: ConnectorCatalogEntry[] = [
	{
		id: "github",
		name: "GitHub",
		description: "Repositories, issues, pull requests, and code search.",
		kind: "token",
		url: "https://api.githubcopilot.com/mcp/",
		tokenHint: "Personal access token",
		docsUrl: "https://github.com/github/github-mcp-server",
	},
	{
		id: "notion",
		name: "Notion",
		description: "Search and update pages and databases in your Notion workspace.",
		kind: "oauth",
		url: "https://mcp.notion.com/mcp",
	},
	{
		id: "atlassian",
		name: "Atlassian",
		description: "Jira issues and Confluence pages from your Atlassian sites.",
		kind: "oauth",
		url: "https://mcp.atlassian.com/v2/mcp",
	},
	{
		id: "linear",
		name: "Linear",
		description: "Manage issues, projects, and cycles in Linear.",
		kind: "oauth",
		url: "https://mcp.linear.app/mcp",
	},
	{
		id: "context7",
		name: "Context7",
		description: "Up-to-date documentation for programming libraries.",
		kind: "open",
		url: "https://mcp.context7.com/mcp",
	},
	{
		id: "huggingface",
		name: "Hugging Face",
		description: "Search models, datasets, and papers.",
		kind: "open",
		url: "https://huggingface.co/mcp",
	},
	{
		id: "deepwiki",
		name: "DeepWiki",
		description: "Ask questions about any public GitHub repository.",
		kind: "open",
		url: "https://mcp.deepwiki.com/mcp",
	},
	{
		id: "canva",
		name: "Canva",
		description: "Search, create, and export Canva designs.",
		kind: "oauth",
		url: "https://mcp.canva.com/mcp",
	},
	{
		id: "sentry",
		name: "Sentry",
		description: "Query errors and performance issues from Sentry.",
		kind: "oauth",
		url: "https://mcp.sentry.dev/mcp",
	},
	{
		id: "stripe",
		name: "Stripe",
		description: "Query customers, payments, and subscriptions in Stripe.",
		kind: "oauth",
		url: "https://mcp.stripe.com",
	},
	{
		id: "hubspot",
		name: "HubSpot",
		description: "CRM context: contacts, companies, and deals.",
		kind: "oauth-client",
		url: "https://mcp.hubspot.com",
		shortNote: "Needs your own HubSpot app; the form walks you through it.",
		guideNote:
			"HubSpot has no automatic client registration. In HubSpot, go to Development, then MCP Auth Apps, create an app with redirect URL http://localhost:19876/callback, and paste its client ID and secret here. Grant the CRM read scopes on the consent screen when you log in.",
		docsUrl: "https://developers.hubspot.com/mcp",
	},
	{
		id: "cloudflare-docs",
		name: "Cloudflare Docs",
		description: "Search Cloudflare's developer documentation.",
		kind: "open",
		url: "https://docs.mcp.cloudflare.com/mcp",
	},
	// Guided — need own credentials/tenant setup; kept last, next to Custom.
	{
		id: "asana",
		name: "Asana",
		description: "Coordinate tasks, projects, and goals in Asana.",
		kind: "oauth-client",
		url: "https://mcp.asana.com/v2/mcp",
		shortNote: "Needs your own Asana app; the form walks you through it.",
		guideNote:
			"Asana has no one-click login here. Go to https://app.asana.com/0/my-apps, create an MCP app, add the redirect URL http://localhost:19876/callback under OAuth, choose your workspaces under Manage distribution, and paste its client ID and secret here.",
		docsUrl: "https://developers.asana.com/docs/integrating-with-asanas-mcp-server",
	},
	{
		id: "google-drive",
		name: "Google Drive",
		description: "Search, read, and organize files in your Drive.",
		kind: "oauth-client",
		url: "https://drivemcp.googleapis.com/mcp/v1",
		shortNote: "Needs your own Google Cloud app; the form walks you through it. Only accounts in Google's preview program can use it.",
		guideNote:
			"Create an OAuth client in Google Cloud (redirect URL http://localhost:19876/callback), select “Use this client for an AI-powered agent” on it, and enable the Drive MCP API in the same project, then paste the client ID and secret here. Google currently gates tool calls behind its Workspace Developer Preview Program.",
		docsUrl: "https://developers.google.com/workspace/drive/api/guides/configure-mcp-server",
	},
	{
		id: "gmail",
		name: "Gmail",
		description: "Search threads, draft replies, and manage labels.",
		kind: "oauth-client",
		url: "https://gmailmcp.googleapis.com/mcp/v1",
		shortNote: "Needs your own Google Cloud app; the form walks you through it. Only accounts in Google's preview program can use it.",
		guideNote:
			"Create an OAuth client in Google Cloud (redirect URL http://localhost:19876/callback), select “Use this client for an AI-powered agent” on it, and enable the Gmail MCP API in the same project, then paste the client ID and secret here. Google currently gates tool calls behind its Workspace Developer Preview Program.",
		docsUrl: "https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server",
	},
	{
		id: "microsoft-365",
		name: "Microsoft 365",
		description: "Teams, SharePoint, OneDrive, and Outlook (Work IQ, preview).",
		kind: "guided",
		shortNote: "Your organisation's Microsoft 365 admin has to set this up first.",
		guideNote: "Per-tenant: needs Entra setup by your admin. See the guide, then add it as a custom connector.",
		docsUrl: "https://learn.microsoft.com/en-us/microsoft-agent-365/tooling-servers-overview",
	},
];
