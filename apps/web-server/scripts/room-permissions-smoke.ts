import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-room-permissions-"));
const previousRoot = process.env.EXXETA_PERSISTENT_AGENTS_ROOT;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = tempRoot;

try {
	const perms = await import("../src/persistent-room-permissions.js");
	const routePolicy = await import("../src/remote-route-policy.js");
	assert(routePolicy.classifyRemoteRoute("GET", "/api/persistent-agents/:id/permissions") === "read", "GET permissions is readable");
	assert(routePolicy.classifyRemoteRoute("PUT", "/api/persistent-agents/:id/permissions") === "local", "PUT permissions is loopback-only");
	const moduleSource = fs.readFileSync(new URL("../src/persistent-room-permissions.ts", import.meta.url), "utf-8");
	assert(!/\b(?:from\s*["']typescript["']|import\s*\(\s*["']typescript["']\s*\)|require\s*\(\s*["']typescript["']\s*\))/.test(moduleSource), "permission store must not import dev-only typescript at runtime");
	fs.mkdirSync(path.join(tempRoot, "room1", "runtime"), { recursive: true });
	const missing = perms.readRoomPermissions("room1");
	const rules = await import("../../web-ui/src/bash-rules.js");
	const responseText = '{"exists":true,"document":{"permission":{"skill":{"*":"deny","0":"allow"},"bash":{"*":"deny","0":"allow"}}},"error":null}';
	const parsed = rules.parsePermissionsResponse(responseText);
	assert(JSON.stringify(parsed.bashRows) === JSON.stringify([{ pattern: "*", action: "deny" }, { pattern: "0", action: "allow" }]), "GET keeps numeric Bash key in source order");
	assert(rules.serializeDocumentWithBashRows(parsed, [{ pattern: "0", action: "deny" }, { pattern: "*", action: "allow" }]) === '{"permission":{"skill":{"*":"deny","0":"allow"},"bash":{"0":"deny","*":"allow"}}}', "PUT keeps skill and moved numeric Bash order");
	assert(rules.serializeDocumentWithBashRows(parsed, []) === '{"permission":{"skill":{"*":"deny","0":"allow"}}}', "removing Bash leaves skill order intact");
	const stringPermission = rules.parsePermissionsResponse('{"exists":true,"document":{"permission":"ask"},"error":null}');
	assert(JSON.stringify(stringPermission.bashRows) === JSON.stringify([{ pattern: "*", action: "ask" }]), "whole-document action shows Bash row");
	assert(rules.serializeDocumentWithBashRows(stringPermission, [{ pattern: "*", action: "deny" }]) === '{"permission":{"skill":"ask","bash":{"*":"deny"}}}', "whole-document action keeps skill meaning");
	assert(rules.serializeDocumentWithBashRows(stringPermission, []) === '{"permission":{"skill":"ask"}}', "empty Bash keeps whole-document skill meaning");
	assert(rules.bashRowsError([{ pattern: " ", action: "ask" }]) === "A rule needs a pattern.", "empty pattern");
	assert(rules.bashRowsError([{ pattern: "a", action: "ask" }, { pattern: "a", action: "deny" }]) === 'Pattern "a" is used twice.', "duplicate pattern");
	assert(rules.bashRowsError([{ pattern: " a ", action: "ask" }]) === null, "meaningful whitespace remains valid");
	const missingResponse = rules.parsePermissionsResponse('{"exists":false,"document":null,"error":null}');
	assert(missingResponse.bashRows.length === 0 && rules.serializeDocumentWithBashRows(missingResponse, [{ pattern: "*", action: "ask" }]) === '{"permission":{"bash":{"*":"ask"}}}', "new file contains Bash only");
	const skillOnly = rules.parsePermissionsResponse('{"exists":true,"document":{"permission":{"skill":{"0":"deny","*":"allow"}}},"error":null}');
	assert(rules.serializeDocumentWithBashRows(skillOnly, [{ pattern: "*", action: "ask" }]) === '{"permission":{"skill":{"0":"deny","*":"allow"},"bash":{"*":"ask"}}}', "skill-first numeric rule order survives");
	const escapedKeys = rules.parsePermissionsResponse('{"exists":true,"document":{"permission":{"skill":{"\\u0030":"ask","*":"deny","0":"allow"},"bash":{"\\u0030":"ask","*":"deny","0":"allow"}}},"error":null}');
	assert(escapedKeys.bashRows.map((row: { pattern: string }) => row.pattern).join(",") === "0,*", "duplicate decoded key keeps first position");
	assert(rules.serializeDocumentWithBashRows(escapedKeys, escapedKeys.bashRows).includes('"skill":{"0":"allow","*":"deny"}'), "duplicate skill key uses final value in original position");
	const categoryOrder = rules.parsePermissionsResponse('{"exists":true,"document":{"permission":{"bash":{"*":"ask","0":"deny"},"skill":{"*":"deny","0":"allow"}}},"error":null}');
	assert(rules.serializeDocumentWithBashRows(categoryOrder, categoryOrder.bashRows) === '{"permission":{"bash":{"*":"ask","0":"deny"},"skill":{"*":"deny","0":"allow"}}}', "unchanged category and pattern order survives GET and PUT");
	const duplicateCategory = rules.parsePermissionsResponse('{"exists":true,"document":{"permission":{"bash":{"*":"ask"},"skill":"deny","bash":{"*":"deny","0":"allow"}}},"error":null}');
	assert(duplicateCategory.bashRows.length === 2 && rules.serializeDocumentWithBashRows(duplicateCategory, duplicateCategory.bashRows) === '{"permission":{"bash":{"*":"deny","0":"allow"},"skill":"deny"}}', "duplicate category keeps first position and final map");
	const quotedPattern = rules.parsePermissionsResponse('{"exists":true,"document":{"permission":{"skill":{"quote\\\"slash\\\\":"ask"},"bash":{"line\\nnext":"deny"}}},"error":null}');
	assert(quotedPattern.bashRows[0].pattern === "line\nnext" && rules.serializeDocumentWithBashRows(quotedPattern, quotedPattern.bashRows) === '{"permission":{"skill":{"quote\\\"slash\\\\":"ask"},"bash":{"line\\nnext":"deny"}}}', "escaped string keys round-trip");
	const escapedSkill = rules.parsePermissionsResponse('{"exists":true,"document":{"permission":{"bash":{"*":"ask"},"skill":{"*":"deny","\\u0030":"allow"}}},"error":null}');
	const escapedSaved = rules.serializeDocumentWithBashRows(escapedSkill, [{ pattern: "git *", action: "deny" }]);
	assert(escapedSaved === '{"permission":{"bash":{"git *":"deny"},"skill":{"*":"deny","0":"allow"}}}', "escaped numeric skill key retains value, precedence and category position");
	const escapedSavedView = perms.parseRoomPermissionsInput(escapedSaved);
	assert(perms.resolveRoomPermission({ exists: true, error: null, document: escapedSavedView }, "skill", "0")?.action === "allow", "saved escaped skill rule keeps effective last-match action");
	assert(missing.exists === false && missing.document === null && missing.error === null, "missing file view");
	assert(perms.resolveRoomPermission(missing, "bash", "ls") === null, "missing file has no match");
	assert(!fs.existsSync(perms.roomPermissionsPath("room1")), "read does not create a file");

	const doc = { permission: { bash: { "*": "ask", "git *": "allow", "git push *": "deny" }, skill: "ask" } };
	perms.writeRoomPermissions("room1", doc);
	const view = perms.readRoomPermissions("room1");
	assert(JSON.stringify(view.document) === JSON.stringify(doc), "round-trip keeps order");
	assert(perms.resolveRoomPermission(view, "bash", "git push origin")?.action === "deny", "last match wins (deny)");
	assert(perms.resolveRoomPermission(view, "bash", "git status")?.action === "allow", "last match wins (allow)");
	assert(perms.resolveRoomPermission(view, "bash", "ls")?.action === "ask", "* matches anything");
	assert(perms.resolveRoomPermission(view, "skill", "x")?.action === "ask", "string category");
	assert(perms.resolveRoomPermission(view, "bash", "git status")?.pattern === "git *", "match reports pattern");
	assert(perms.resolveRoomPermission(view, "skill", "x")?.pattern === null, "string rule has no pattern");

	const glob = { exists: true, error: null, document: { permission: { bash: { "a?c": "allow", "1+1 (x)": "deny" } } } } as const;
	assert(perms.resolveRoomPermission(glob as any, "bash", "abc")?.action === "allow", "? matches one char");
	assert(perms.resolveRoomPermission(glob as any, "bash", "ac") === null, "? needs exactly one char");
	assert(perms.resolveRoomPermission(glob as any, "bash", "1+1 (x)")?.action === "deny", "regex chars are literal");
	assert(perms.resolveRoomPermission(glob as any, "bash", "11 x") === null, "+ and () are not regex");
	assert(perms.resolveRoomPermission(glob as any, "skill", "abc") === null, "omitted category has no match");
	const wildcard = { exists: true, error: null, document: { permission: { bash: { "a**?c": "allow", "*?": "ask" } } } } as const;
	assert(perms.resolveRoomPermission(wildcard as any, "bash", "a\nc")?.action === "ask", "* and ? match across newlines");
	assert(perms.resolveRoomPermission(wildcard as any, "bash", "") === null, "? requires exactly one character");
	const adversarial = { exists: true, error: null, document: { permission: { bash: { [`${"*".repeat(24)}z`]: "deny" } } } } as const;
	const started = performance.now();
	assert(perms.resolveRoomPermission(adversarial as any, "bash", "a".repeat(10_000)) === null, "repeated stars must not match a missing suffix");
	assert(performance.now() - started < 5_000, "repeated stars must not cause catastrophic backtracking");
	const literals = { exists: true, error: null, document: { permission: { bash: { "[": "allow", "]": "deny", "\\": "ask", "line\nnext": "allow" } } } } as const;
	assert(perms.resolveRoomPermission(literals as any, "bash", "[")?.action === "allow", "opening bracket is literal");
	assert(perms.resolveRoomPermission(literals as any, "bash", "]")?.action === "deny", "closing bracket is literal");
	assert(perms.resolveRoomPermission(literals as any, "bash", "\\")?.action === "ask", "backslash is literal");
	assert(perms.resolveRoomPermission(literals as any, "bash", "line\nnext")?.action === "allow", "literal newline matches");
	const all = { exists: true, error: null, document: { permission: "deny" } } as const;
	assert(perms.resolveRoomPermission(all as any, "skill", "s")?.action === "deny", "string document applies to skill");
	assert(perms.resolveRoomPermission(all as any, "bash", "ls")?.action === "deny", "string document applies to bash");
	const orderedRaw = '{"permission":{"bash":{"*":"deny","0":"allow"}}}';
	fs.mkdirSync(path.join(tempRoot, "ordered", "runtime"), { recursive: true });
	fs.writeFileSync(path.join(tempRoot, "ordered", "runtime", "permissions.json"), orderedRaw);
	const orderedView = perms.readRoomPermissions("ordered");
	assert(orderedView.error === null, "integer-like pattern is valid");
	assert(perms.resolveRoomPermission(orderedView, "bash", "0")?.action === "allow", "last rule follows source JSON order");
	perms.writeRoomPermissions("ordered", orderedRaw);
	assert(perms.resolveRoomPermission(perms.readRoomPermissions("ordered"), "bash", "0")?.action === "allow", "PUT preserves integer-like pattern source order");
	assert(perms.resolveRoomPermission(orderedView, "bash", "0")?.pattern === "0", "source-order match reports last pattern");
	assert(JSON.stringify(orderedView.document?.permission) === '{"bash":{"*":"deny","0":"allow"}}', "read view preserves source pattern order for GET and UI");
	assert(Object.keys((orderedView.document?.permission as any).bash).join(",") === "*,0", "UI enumeration preserves source pattern order");
	perms.writeRoomPermissions("ordered", orderedView.document);
	assert(perms.resolveRoomPermission(perms.readRoomPermissions("ordered"), "bash", "0")?.action === "allow", "GET/PUT round-trip preserves rule precedence");
	const duplicateRaw = '{"permission":{"bash":{"*":"deny","0":"ask","0":"allow"}}}';
	fs.writeFileSync(perms.roomPermissionsPath("ordered"), duplicateRaw);
	const duplicateView = perms.readRoomPermissions("ordered");
	assert(duplicateView.error === null && (duplicateView.document?.permission as any).bash["0"] === "allow", "duplicate keys keep JSON.parse last-value semantics");
	assert(perms.resolveRoomPermission(duplicateView, "bash", "0")?.action === "allow", "duplicate matching key uses last JSON value");
	const duplicatePositionRaw = '{"permission":{"bash":{"0":"ask","*":"deny","0":"allow"}}}';
	fs.writeFileSync(perms.roomPermissionsPath("ordered"), duplicatePositionRaw);
	const duplicatePositionView = perms.readRoomPermissions("ordered");
	assert(perms.resolveRoomPermission(duplicatePositionView, "bash", "0")?.action === "deny", "duplicate key keeps first property position and last JSON value");
	const duplicateCategoryRaw = '{"permission":{"bash":{"*":"ask"},"bash":{"*":"deny","0":"allow"}}}';
	fs.writeFileSync(perms.roomPermissionsPath("ordered"), duplicateCategoryRaw);
	const duplicateCategoryView = perms.readRoomPermissions("ordered");
	assert(duplicateCategoryView.error === null, "duplicate category keeps JSON.parse last-value semantics");
	assert(perms.resolveRoomPermission(duplicateCategoryView, "bash", "0")?.action === "allow", "duplicate category uses last pattern object and its source order");
	const escapedRaw = '{"permission":{"bash":{"*":"deny","\\u0030":"allow"}}}';
	fs.writeFileSync(perms.roomPermissionsPath("ordered"), escapedRaw);
	const escapedView = perms.readRoomPermissions("ordered");
	assert(perms.resolveRoomPermission(escapedView, "bash", "0")?.action === "allow", "escaped integer-like JSON key preserves source order");
	const escapedDuplicateRaw = '{"permission":{"bash":{"\\u0030":"ask","*":"deny","0":"allow"}}}';
	fs.writeFileSync(perms.roomPermissionsPath("ordered"), escapedDuplicateRaw);
	const escapedDuplicateView = perms.readRoomPermissions("ordered");
	assert(perms.resolveRoomPermission(escapedDuplicateView, "bash", "0")?.action === "deny", "escaped duplicate key keeps first position and last JSON.parse value");
	const nestedRaw = '{"permission":{"bash":{"[{}]":"ask","*":"deny","0":"allow"},"skill":{"\\\"}":["deny"]}}';
	fs.writeFileSync(perms.roomPermissionsPath("ordered"), nestedRaw);
	const invalidNested = perms.readRoomPermissions("ordered");
	assert(invalidNested.error !== null && invalidNested.document === null, "nested invalid JSON shape still fails closed");
	fs.mkdirSync(path.join(tempRoot, "missing-runtime"));
	const missingRuntime = perms.readRoomPermissions("missing-runtime");
	assert(missingRuntime.error !== null && missingRuntime.document === null, "missing runtime directory reports error");
	assert(perms.resolveRoomPermission(missingRuntime, "bash", "ls")?.action === "deny", "missing runtime directory denies bash");
	assert(perms.resolveRoomPermission(missingRuntime, "skill", "x")?.action === "deny", "missing runtime directory denies skill");
	fs.mkdirSync(path.join(tempRoot, "dangling-runtime"));
	fs.symlinkSync(path.join(tempRoot, "gone"), path.join(tempRoot, "dangling-runtime", "runtime"));
	const danglingRuntime = perms.readRoomPermissions("dangling-runtime");
	assert(danglingRuntime.error !== null && danglingRuntime.document === null, "dangling runtime symlink reports error");
	assert(perms.resolveRoomPermission(danglingRuntime, "bash", "ls")?.action === "deny", "dangling runtime symlink denies bash");
	assert(perms.resolveRoomPermission(danglingRuntime, "skill", "x")?.action === "deny", "dangling runtime symlink denies skill");
	fs.mkdirSync(path.join(tempRoot, "blocked-runtime"));
	fs.writeFileSync(path.join(tempRoot, "blocked-runtime", "runtime"), "not a directory");
	const blockedRuntime = perms.readRoomPermissions("blocked-runtime");
	assert(blockedRuntime.error !== null && blockedRuntime.document === null, "inaccessible runtime parent reports error");
	assert(perms.resolveRoomPermission(blockedRuntime, "bash", "ls")?.action === "deny", "inaccessible runtime parent denies bash");
	assert(perms.resolveRoomPermission(blockedRuntime, "skill", "x")?.action === "deny", "inaccessible runtime parent denies skill");
	fs.mkdirSync(path.join(tempRoot, "removed-runtime", "runtime"), { recursive: true });
	fs.symlinkSync(path.join(tempRoot, "gone"), path.join(tempRoot, "removed-runtime", "runtime", "permissions.json"));
	const inaccessible = perms.readRoomPermissions("removed-runtime");
	assert(inaccessible.error !== null && inaccessible.document === null, "dangling permissions file is not treated as absent");
	assert(perms.resolveRoomPermission(inaccessible, "bash", "ls")?.action === "deny", "dangling permissions file fails closed");

	const file = perms.roomPermissionsPath("room1");
	assert(file === path.join(tempRoot, "room1", "runtime", "permissions.json"), "room runtime path");
	const before = fs.readFileSync(file, "utf-8");
	for (const bad of [
		{ permission: { bash: "maybe" } },
		{ permission: { edit: "allow" } },
		{ permission: { bash: { "": "allow" } } },
		{ permission: { bash: { "*": "maybe" } } },
		{ permission: [] },
		{ nope: 1 },
		{ permission: "allow", extra: true },
		null,
	]) {
		let threw = false;
		try { perms.writeRoomPermissions("room1", bad); } catch { threw = true; }
		assert(threw, `invalid document must be rejected: ${JSON.stringify(bad)}`);
	}
	assert(fs.readFileSync(file, "utf-8") === before, "failed write keeps old bytes");
	if (process.platform !== "win32") assert((fs.statSync(file).mode & 0o777) === 0o600, "file mode 0600");
	for (const id of ["../escape", "", "a/b"]) {
		let threw = false;
		try { perms.roomPermissionsPath(id); } catch { threw = true; }
		assert(threw, `invalid room id must be rejected: ${JSON.stringify(id)}`);
	}

	fs.writeFileSync(file, "{ not json");
	let corrupt = perms.readRoomPermissions("room1");
	assert(corrupt.exists && corrupt.error !== null && corrupt.document === null, "corrupt JSON reports error");
	assert(perms.resolveRoomPermission(corrupt, "bash", "ls")?.action === "deny", "corrupt JSON denies bash");
	assert(perms.resolveRoomPermission(corrupt, "skill", "x")?.action === "deny", "corrupt JSON denies skill");
	fs.writeFileSync(file, JSON.stringify({ permission: { edit: "allow" } }));
	corrupt = perms.readRoomPermissions("room1");
	assert(corrupt.error !== null && corrupt.document === null, "invalid stored shape reports error");
	assert(perms.resolveRoomPermission(corrupt, "bash", "ls")?.action === "deny", "invalid stored shape denies bash");
	assert(perms.resolveRoomPermission(corrupt, "skill", "x")?.action === "deny", "invalid stored shape denies skill");

	const approval = await import("../src/persistent-room-bash-approval.js");
	const skillTool = await import("../src/persistent-room-skill-tool.js");
	const skillSettings = await import("../src/persistent-room-skill-settings.js");
	function ctxWith(answer: boolean | null) {
		const asked: string[] = [];
		return { asked, ctx: answer === null ? { hasUI: false } : { hasUI: true, ui: { async confirm(title: string) { asked.push(title); return answer; } } } };
	}

	for (const [match, autoApprove, answer, allow, asks] of [
		[{ action: "deny", pattern: "rm *" }, true, true, false, 0],
		[{ action: "allow", pattern: "git *" }, false, null, true, 0],
		[{ action: "ask", pattern: "*" }, true, true, true, 1],
		[{ action: "ask", pattern: "*" }, true, null, false, 0],
		[null, true, null, true, 0],
		[null, false, false, false, 1],
	] as const) {
		const { ctx, asked } = ctxWith(answer);
		const guard = approval.createPersistentRoomBashApprovalGuard({ isAutoApproved: () => autoApprove, resolvePermission: () => match });
		const decision = await guard.beforeBashCall("cmd", ctx);
		assert(decision.allow === allow, `bash ${JSON.stringify(match)} auto=${autoApprove} allow=${allow}`);
		assert(asked.length === asks, `bash ${JSON.stringify(match)} asks ${asks}`);
		if (match?.action === "deny") assert(!decision.allow && decision.reason.includes("rm *"), "deny names the pattern");
	}
	perms.writeRoomPermissions("bash-live", { permission: { bash: { "*": "deny", "git *": "allow" } } });
	const liveGuard = approval.createPersistentRoomBashApprovalGuard({
		isAutoApproved: () => true,
		resolvePermission: (command: string) => perms.resolveRoomPermission(perms.readRoomPermissions("bash-live"), "bash", command),
	});
	assert((await liveGuard.beforeBashCall("git status", { hasUI: false })).allow, "live bash allow rule applies");
	fs.writeFileSync(perms.roomPermissionsPath("bash-live"), "{ not json");
	const corruptBashDecision = await liveGuard.beforeBashCall("git status", { hasUI: false });
	assert(!corruptBashDecision.allow && corruptBashDecision.reason.includes("permissions.json"), "corrupt bash rules deny with file name even under autoApprove");
	for (const [label, replacement, expectedAllow] of [
		["deny", { permission: { bash: "deny" } }, false],
		["corrupt", "{ not json", false],
		["still ask", { permission: { bash: "ask" } }, true],
		["allow", { permission: { bash: "allow" } }, true],
		["no rule", { permission: { skill: "ask" } }, true],
	] as const) {
		perms.writeRoomPermissions("bash-live", { permission: { bash: "ask" } });
		let resolveConfirm!: (approved: boolean) => void;
		let asks = 0;
		const pending = liveGuard.beforeBashCall("git status", {
			hasUI: true,
			ui: { confirm: async () => { asks++; return new Promise<boolean>((resolve) => { resolveConfirm = resolve; }); } },
		});
		assert(asks === 1, `bash ${label} starts one ASK card`);
		if (typeof replacement === "string") fs.writeFileSync(perms.roomPermissionsPath("bash-live"), replacement);
		else perms.writeRoomPermissions("bash-live", replacement);
		resolveConfirm(true);
		const decision = await pending;
		assert(decision.allow === expectedAllow, `bash ${label} after confirming ASK must ${expectedAllow ? "allow" : "deny"}`);
		assert(asks === 1, `bash ${label} must not ask twice`);
		if (!expectedAllow) assert(!decision.allow && decision.reason.includes("permission rules") && (label !== "corrupt" || decision.reason.includes("permissions.json")), `bash ${label} uses permission denial reason`);
	}

	const skillRoom = "skill-permission-room";
	const body = "Secret skill instructions for this room.";
	const manifest = `---\nname: cite-sources\ndescription: Cite sources\n---\n\n${body}`;
	const library = { manifest, body, description: "Cite sources" };
	assert(skillSettings.enablePersistentRoomSkill(skillRoom, "cite-sources", () => manifest).ok, "skill fixture is enabled with matching hash pin");
	let checks = 0;
	let match: { action: "ask" | "allow" | "deny"; pattern: string | null } | null = null;
	const tool = skillTool.createReadSkillTool({
		agentId: skillRoom,
		lookupSkill: () => library,
		checkPermission: () => { checks++; return match; },
	});
	const textOf = (result: { content: Array<{ type: string; text?: string }> }) => result.content[0].text ?? "";
	const readSkill = (name: string, ctx: object) => tool.execute("permission-test", { name }, undefined, undefined, ctx as any);
	match = { action: "deny", pattern: "cite-*" };
	let result = await readSkill("cite-sources", ctxWith(true).ctx);
	assert(result.details?.outcome === "permission-denied" && !textOf(result).includes(body), "deny does not return skill body");
	assert(textOf(result).includes("cite-*"), "skill deny names the pattern");
	match = { action: "ask", pattern: null };
	for (const answer of [false, null] as const) {
		const { ctx, asked } = ctxWith(answer);
		result = await readSkill("cite-sources", ctx);
		assert(result.details?.outcome === "permission-declined" && !textOf(result).includes(body), "declined skill does not return body");
		assert(asked.length === (answer === null ? 0 : 1), "skill asks only when UI is available");
	}
	for (const action of ["allow", null] as const) {
		match = action ? { action, pattern: null } : null;
		const { ctx, asked } = ctxWith(false);
		result = await readSkill("cite-sources", ctx);
		assert(result.details?.outcome === "ok" && textOf(result).includes(body), "allow or no rule returns skill body");
		assert(asked.length === 0, "allow or no rule does not ask");
	}
	match = { action: "allow", pattern: null };
	checks = 0;
	result = await readSkill("not-enabled", ctxWith(true).ctx);
	assert(result.details?.outcome === "not-enabled" && checks === 0, "allow cannot bypass enabled gate");
	library.manifest = `${manifest}\nChanged after enablement.`;
	result = await readSkill("cite-sources", ctxWith(true).ctx);
	assert(result.details?.outcome === "hash-mismatch" && checks === 0, "allow cannot bypass hash pin");
	library.manifest = manifest;
	const fileBackedTool = skillTool.createReadSkillTool({
		agentId: skillRoom,
		lookupSkill: () => library,
		checkPermission: (name: string) => perms.resolveRoomPermission(perms.readRoomPermissions(skillRoom), "skill", name),
	});
	perms.writeRoomPermissions(skillRoom, { permission: { skill: "allow" } });
	assert((await fileBackedTool.execute("live", { name: "cite-sources" }, undefined, undefined, { hasUI: false } as any)).details?.outcome === "ok", "live skill allow rule applies");
	fs.writeFileSync(perms.roomPermissionsPath(skillRoom), "{ not json");
	result = await fileBackedTool.execute("corrupt", { name: "cite-sources" }, undefined, undefined, { hasUI: false } as any);
	assert(result.details?.outcome === "permission-denied" && !textOf(result).includes(body) && textOf(result).includes("permissions.json"), "corrupt skill rules fail closed and name file");
	for (const [label, replacement, expectedOutcome] of [
		["deny", { permission: { skill: "deny" } }, "permission-denied"],
		["corrupt", "{ not json", "permission-denied"],
		["still ask", { permission: { skill: "ask" } }, "ok"],
		["allow", { permission: { skill: "allow" } }, "ok"],
		["no rule", { permission: { bash: "deny" } }, "ok"],
	] as const) {
		perms.writeRoomPermissions(skillRoom, { permission: { skill: "ask" } });
		let resolveConfirm!: (approved: boolean) => void;
		let asks = 0;
		const pending = fileBackedTool.execute("deferred", { name: "cite-sources" }, undefined, undefined, {
			hasUI: true,
			ui: { confirm: async () => { asks++; return new Promise<boolean>((resolve) => { resolveConfirm = resolve; }); } },
		} as any);
		assert(asks === 1, `skill ${label} starts one ASK card`);
		if (typeof replacement === "string") fs.writeFileSync(perms.roomPermissionsPath(skillRoom), replacement);
		else perms.writeRoomPermissions(skillRoom, replacement);
		resolveConfirm(true);
		const resumed = await pending;
		assert(resumed.details?.outcome === expectedOutcome, `skill ${label} after confirming ASK has ${expectedOutcome} outcome`);
		assert(asks === 1, `skill ${label} must not ask twice`);
		assert(expectedOutcome === "ok" ? textOf(resumed).includes(body) : !textOf(resumed).includes(body), `skill ${label} body visibility`);
		if (label === "corrupt") assert(textOf(resumed).includes("permissions.json"), "corrupt skill rules deny with file name after ASK");
	}

	console.log("room-permissions smoke: ok");
} finally {
	fs.rmSync(tempRoot, { recursive: true, force: true });
	if (previousRoot === undefined) delete process.env.EXXETA_PERSISTENT_AGENTS_ROOT;
	else process.env.EXXETA_PERSISTENT_AGENTS_ROOT = previousRoot;
}
