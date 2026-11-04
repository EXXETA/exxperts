// The file types a room's Attachments preview as plain text. The server serves them
// as text/plain; charset=utf-8 under the artifact headers (nosniff, a
// sandboxed frame), so the bytes show as inert source and never become a page,
// a script or a picture; the viewer shows the same set in its text frame. One
// list for both, so the viewer never offers a preview the server refuses. It
// lives beside the server, whose source the release package carries whole;
// the page imports it from here.
// Never add .html, .htm, .xhtml or .svg here: those have their own handling.
export const PLAIN_TEXT_PREVIEW_EXTENSIONS: ReadonlySet<string> = new Set([
	// Text and data
	".txt", ".csv", ".tsv", ".json", ".jsonl", ".log", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".xml", ".sql", ".tex",
	// Source code
	".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".sh", ".bash", ".zsh", ".ps1", ".bat", ".css", ".scss",
	".rb", ".go", ".rs", ".java", ".kt", ".swift", ".c", ".h", ".cpp", ".hpp", ".cs", ".php", ".r", ".lua", ".pl",
]);
