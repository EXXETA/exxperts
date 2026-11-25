/**
 * Curated connector directory. Every endpoint here was live-verified against
 * the actual server (an MCP endpoint answers an initialize POST with 200, or
 * 401 when it wants OAuth/token auth) — keep it that way when adding entries.
 *
 * It offers only apps a person adds with a click, a sign-in or a key. Order is
 * the display order of the directory on the Connectors page: most popular /
 * highest value-add first.
 *
 * kind:
 * - "open": works immediately, no login
 * - "oauth": one-click login (dynamic client registration verified live,
 *   path-aware .well-known discovery)
 * - "token": needs an API token pasted once
 */

/** An app exxperts knows by name: a connector added from it shows its name, icon and description. */
export interface ConnectorCatalogEntry {
	id: string;
	name: string;
	description: string;
	url?: string;
}

export interface ConnectorDirectoryEntry extends ConnectorCatalogEntry {
	kind: "open" | "oauth" | "token";
	url: string;
	tokenHint?: string;
	docsUrl?: string;
}

export const CONNECTOR_DIRECTORY: ConnectorDirectoryEntry[] = [
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
		id: "cloudflare-docs",
		name: "Cloudflare Docs",
		description: "Search Cloudflare's developer documentation.",
		kind: "open",
		url: "https://docs.mcp.cloudflare.com/mcp",
	},
];

/**
 * Apps the directory offered before, which a person couldn't add with a
 * click, a sign-in or a key: they needed their own sign-in app, or their
 * organisation's admin. A connector added from one keeps its name, icon and
 * description.
 */
const LEFT_THE_DIRECTORY: ConnectorCatalogEntry[] = [
	{ id: "hubspot", name: "HubSpot", description: "CRM context: contacts, companies, and deals.", url: "https://mcp.hubspot.com" },
	{ id: "asana", name: "Asana", description: "Coordinate tasks, projects, and goals in Asana.", url: "https://mcp.asana.com/v2/mcp" },
	{ id: "google-drive", name: "Google Drive", description: "Search, read, and organize files in your Drive.", url: "https://drivemcp.googleapis.com/mcp/v1" },
	{ id: "gmail", name: "Gmail", description: "Search threads, draft replies, and manage labels.", url: "https://gmailmcp.googleapis.com/mcp/v1" },
	{ id: "microsoft-365", name: "Microsoft 365", description: "Teams, SharePoint, OneDrive, and Outlook (Work IQ, preview)." },
];

/** Every app known by name: the directory's, then those that left it. */
export const CONNECTOR_CATALOG: readonly ConnectorCatalogEntry[] = [...CONNECTOR_DIRECTORY, ...LEFT_THE_DIRECTORY];
