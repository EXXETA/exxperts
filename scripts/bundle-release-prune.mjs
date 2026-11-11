// Trims the staged app/node_modules tree of files the app never reads at run
// time, before bundle-release.mjs archives it. The count matters more than the
// bytes: an installer writes every file, and a virus scanner checks each new
// file on its own, so a Windows install or update slows down with every file
// shipped. Only app/node_modules is trimmed; app/ outside it holds the
// TypeScript sources the server and the extensions run through tsx and jiti.
//
// Removed: source maps (*.map), declaration files (*.d.ts, *.d.mts, *.d.cts),
// third-party TypeScript sources (*.ts, *.mts, *.cts) and markdown (*.md,
// *.markdown). Tested by scripts/bundle-release.test.mjs.
import fs from "node:fs";
import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
import path from "node:path";
import ts from "typescript";

// Packages the prune never touches, as path prefixes relative to
// app/node_modules. Everything inside them ships as installed.
export const PROTECTED_PACKAGES = [
	// Our own runtime packages. The runtime reads its own README, CHANGELOG,
	// docs and examples at run time (getPackageDir in
	// runtime/packages/coding-agent/src/config.ts).
	"@exxeta/",
	// The MCP extension is a pi package whose TypeScript sources the runtime
	// imports by name at run time.
	"pi-mcp-adapter/",
];

// We redistribute these packages, so their licence and notice files must
// travel with every copy, whatever their case or extension.
const LICENCE_FILE = /^(licen[cs]e|notice|copying)/i;

const JS_FILE = /\.[cm]?js$/;
const DECLARATION_FILE = /\.d\.[cm]?ts$/i;

// A relative import, dynamic import, require or re-export whose specifier
// names a TypeScript file.
const RELATIVE_TS_SPECIFIER =
	/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"'\n]+?\.[cm]?ts)\1/g;

function pruneKind(name) {
	if (LICENCE_FILE.test(name)) return null;
	const lower = name.toLowerCase();
	if (lower.endsWith(".map")) return "maps";
	if (DECLARATION_FILE.test(lower)) return "declarations";
	if (/\.[cm]?ts$/.test(lower)) return "typescript";
	if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
	return null;
}

function isProtected(rel) {
	return PROTECTED_PACKAGES.some((prefix) => `${rel}/`.startsWith(prefix));
}

// Calls visit(fullPath, relPosixPath, name) for every file under dir.
function walkFiles(dir, visit, rel = "") {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		const childRel = rel ? `${rel}/${entry.name}` : entry.name;
		if (entry.isDirectory()) walkFiles(full, visit, childRel);
		else visit(full, childRel, entry.name);
	}
}


function resolvePackageDir(app, from, name) {
	for (let dir = from; ; dir = path.dirname(dir)) {
		const candidate = path.join(dir, "node_modules", ...name.split("/"));
		if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
		if (dir === app || path.dirname(dir) === dir) return null;
	}
}

// Resolve the installed package graph the same way Node resolves dependencies.
function packageClosure(app, roots) {
	const seen = new Set();
	const queue = roots.map((name) => ({ name, from: app, optional: false }));
	while (queue.length) {
		const { name, from, optional } = queue.shift();
		const found = resolvePackageDir(app, from, name);
		if (!found) { if (!optional) throw new Error(`missing required package ${name} from ${from}`); continue; }
		if (seen.has(found)) continue;
		seen.add(found);
		const pkg = JSON.parse(fs.readFileSync(path.join(found, "package.json"), "utf8"));
		const optionalNames = new Set(Object.keys({ ...pkg.optionalDependencies, ...pkg.peerDependencies }));
		for (const name of new Set([...Object.keys(pkg.dependencies || {}), ...optionalNames])) {
			const required = Object.hasOwn(pkg.dependencies || {}, name) && !Object.hasOwn(pkg.optionalDependencies || {}, name);
			queue.push({ name, from: found, optional: !required });
		}
	}
	return seen;
}

function workerOnlyPackages(app, nodeModulesDir) {
	const manifestPath = path.join(app, "package.json");
	if (!fs.existsSync(manifestPath)) return [];
	const pkg = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	if (!pkg.dependencies?.exceljs) return [];
	const roots = Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies }).filter((name) =>
		!Object.hasOwn(pkg.optionalDependencies || {}, name) || resolvePackageDir(app, app, name),
	);
	// any-promise can select either of these installed implementations.
	const selectors = ["bluebird", "lie"].filter((name) => fs.existsSync(path.join(nodeModulesDir, name, "package.json")));
	const kept = packageClosure(app, [...roots.filter((name) => name !== "exceljs"), ...selectors]);
	const omitted = [...packageClosure(app, roots)].filter((dir) => !kept.has(dir));
	if (!omitted.length) return omitted;
	const omittedDirs = new Set(omitted);
	// Computed product imports are pinned to reviewed source bytes; a change
	// requires a fresh review before dependencies can be removed.
	const reviewed = [
		{ file: "apps/web-server/src/persistent-agent-store.ts", hash: "60542efcc3eb2e1370fe1eab7e5c4c9fa05eb2942daa53f1fd9457b4e67de7c7" },
		{ file: "apps/web-server/src/server-install-root.ts", hash: "4b9b6729aba6b9ef57602129578b838d08b8fcbd77242f7ddefb4eb316817862" },
		{ file: "apps/web-server/src/scheduled-prompt-background-execution.ts", hash: "4c1a97c6bcc071f0803de7d8f5de1e315fa7e3cb2b20acb3a0fa3822998b2da0" },
		{ file: "scripts/doctor.mjs", hash: "0f80abd5e2efa8db4eac27b5f3944de598b7fd823589cb05d7e2d6bb1146c84e" },
		{ file: "apps/web-server/src/mcp-admin.ts", hash: "5da82c76e4f18e3caa0efa5447f25ca757084dbfe6e3c919417e83e01d6e3192" },
		{ file: "apps/web-server/src/mcp-status.ts", hash: "53060b0ba9063c5fbddd0fefc8167745515514a5a9dc5ab21bbd34f7920cc8c8" },
		{ file: "pi-package/extensions/mcp/room-scope.ts", hash: "4a9d933a9a9ceb5805c40e8fe668297da7ce2a3fc6340c7c37de1900ef38617a" },
		{ file: "pi-package/extensions/mcp/index.ts", hash: "281391d255821cfdc3dee05b1b26ff7ddfb2bc6153339af3eba0959c8b8f1962" },
		{ file: "runtime/packages/ai/dist/env-api-keys.js", hash: "b09853d5e91b01cec5397a585205427c040eec332f1a1c659b255a01ad27d948" },
		{ file: "runtime/packages/ai/dist/providers/openai-codex-responses.js", hash: "2f257a176ae10bd80328e50f52f7c08d354334595884374c428f65d30fe36579" },
		{ file: "runtime/packages/ai/dist/providers/register-builtins.js", hash: "2a30aae71359bd3b05989f2d0dfd4e029fc5c8d76dcbde9e60d81153445ce21b" },
		{ file: "runtime/packages/coding-agent/dist/core/extensions/loader.js", hash: "33750f5a1f93c0aac6c8cc0a67a4c7847b8b05e4b4be6104b99fbf4e48b280bf" },
	];
	const dynamic = /\b(?:import|require(?:\.resolve)?)\s*(?:(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*)\s*)*\(\s*(?:(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*)\s*)*(?!["'])([A-Za-z_$][\w$]*|`|\()/g;
	// Computed loads in the installed dependency tree, reviewed at this lock.
	const reviewedDependencies = new Map([
		["qrcode-terminal/lib/main.js", "fa88a331a51dd411f8f0f068cfb8d88280cafa65554fb18bf8aee1f4325ef699"],
		["recheck/lib/main.js", "c5b742b670ccc64c77edeaeaf92e995d48098d8bacc80e7d391d8ddd90d88b1d"],
		["pi-mcp-adapter/glimpse-ui.ts", "0bbc94fd4218426b227a499e8f245b3fccfacb4593a90855d8c9466a84c55779"],
		["any-promise/register.js", "003a1f7a8075b4d6e3f84adb9c1f0a1c3c41d133c03bd7e24ab6d0d336f612a9"],
		["esbuild/install.js", "612294e278914443bdcf81cb17f54afec34dbdd2ebd999a6ee187912320cc315"],
		["require-directory/index.js", "65eaf8b7b519d6ae7be7ea20382d91a117d9c689897897ce4c2ee798e128a2d3"],
		["real-require/src/index.js", "63c3d644a48e2e32e8f3d5aaf326db87760239b3dd6bf639a98c052ae67e2c80"],
		["express/lib/view.js", "74f4171b66263e22481820bc5975708f7dd8a61484f570aac7c5b4ab77ecbd79"],
		["tsx/dist/register-DlUHyDDv.cjs", "2a99a324c621aca9ce0a79be75a3dc9d06a0d90a4337ec3ffd48fe45460bfe10"],
		["tsx/dist/register-BoI6-WNn.cjs", "d5c797ac4b8ba97563fc89bccfeae62041535459491eb44c2a199892fb6e1ae9"],
		["tsx/dist/register-zZ7SWseA.mjs", "85d8140756ef963f827ba126edee211bb6fbdf1d0e7ee200d3f250d0357067e9"],
		["tsx/dist/require-awuW45Q3.mjs", "56ededacf63862b95c629809db91b44252528e2eff361aa57f62848f53da8b1f"],
		["tsx/dist/require-C7ivLNeu.cjs", "26e82ba7a48ec3b12607534c4d3b2b3be3d85ac22b00c055ff758f869aff9f65"],
		["tsx/dist/esm/api/index.cjs", "cc384bfa8b9fb4378964a85711507b6fe0901891dfbf131cff16a8e905e0e7e3"],
		["tsx/dist/esm/api/index.mjs", "4c549bb86a9057e16dcfe6b8a310cf05d3e66a8e97fbff8d4db05e2aed0b4a2b"],
		["protobufjs/dist/protobuf.js", "1a3afcbeede7d2b5a37a8669b3fadfb796ad7f57129767c076e483fbdad301d3"],
		["protobufjs/scripts/postinstall.js", "5af8463b97ee8e309b4a2111f9479bacdf0c180de0ca0155527679b1fc6d9e6c"],
		["protobufjs/dist/minimal/protobuf.js", "8c2628a81f04d7198e2d511f5abbee0b49aa427f7662e0fee4ca909d6294c4b8"],
		["protobufjs/dist/light/protobuf.js", "06404e359e163697e594fb4cddc76f35368548abff440e05e99084463ea062df"],
		["hono/dist/utils/color.js", "0db35994db8e2830b3de5660e2f98df439b1dcc32ea0207e9f306d58de749c2f"],
		["hono/dist/cjs/utils/color.js", "e041c5dc59be4af1fec395c96f6e7df7171cf9b3c2a674f58f3e0749a51c41e7"],
		["@napi-rs/canvas/js-binding.js", "be59c8d4888630cf88656f65b63dd150e60bdb1d5eab0ba5b47c0a6cb389533e"],
		["esbuild/lib/main.js", "8331fe1d8b3a07381f33cc425fcfaa94776e263113653f80ec3ba433e9657e73"],
		["@earendil-works/pi-ai/dist/env-api-keys.js", "f218724dd1b3a7b90fd93c5889621d4885b08811469df0184e92de60fadd6f7e"],
		["@earendil-works/pi-ai/dist/providers/openai-codex-responses.js", "1d55fd9f9b952cf3773ffd435101eebc1e19229e2e207b1f7c0475800c249958"],
		["@earendil-works/pi-ai/dist/providers/register-builtins.js", "2a30aae71359bd3b05989f2d0dfd4e029fc5c8d76dcbde9e60d81153445ce21b"],
		["marked/bin/main.js", "88b4b0eac09204ac6fcd343fe41d54329aff351bac71472716a0227dc7eacd46"],
		["yaml/dist/cli.mjs", "0ad1d42d88c0648fb6fbd158b21dcc2b4daa2e34e4d4df7aa949d6978d343d4d"],
		["playwright/lib/util.js", "f7734786062157d60ed0388f1f9fcf3507d811327fb3b287576dfdfd9670f083"],
		["playwright/lib/package.js", "544a18417ea51dd4c8a9f3dbc4e2b47e46c80f452e0cd23d55e9b3680bc6241e"],
		["playwright/lib/transform/babelBundle.js", "9201df11ae9c9ee1febd587c5013c4f862aa7e9981b92b86ccbbbd37e71f9124"],
		["playwright/lib/transform/esmLoader.js", "4e08f072635ccd32497256c28fd92663ca89e585ee93335f32d4cbc02d68b0c3"],
		["playwright/lib/cli/testActions.js", "b1fc25798995a3a0bce45e5da7f1158c076b807099dc35fdbb559acb75623b95"],
		["playwright/lib/cli/reportActions.js", "1ea9e8660db28045b853a54c24493b08029e148d9a0ee6e88027e409b497e3f1"],
		["playwright/lib/common/index.js", "3d90db5e5823c18827bce6bb5e05531511d6e0a31efe8c0188eeb07900539cfe"],
		["escodegen/bin/esgenerate.js", "5747d64dfa8e01c788c437c3738a6df39a85a6e5991c1d98d105bf2bc1641100"],
		["escodegen/bin/escodegen.js", "228010416405befd8b405a26d1afb191c5c28aa81587ea1dd74784f422bdc5e5"],
		["yargs-parser/build/index.cjs", "64c4a6d61e0a85e7f68b519935f53187eca56d5bc829df2ab3e259823febdeb0"],
		["yargs-parser/build/lib/yargs-parser.js", "65a525897873c3de47f769831d2d902e090e044d55365939f42ca79d558f5bcb"],
		["yargs-parser/build/lib/index.js", "3908256d216a8849acbb53ad838a34c8c315d682771f4d3b68d5ea7327e4ebf5"],
		["@exxeta/exxperts-runtime/dist/core/extensions/loader.js", "33750f5a1f93c0aac6c8cc0a67a4c7847b8b05e4b4be6104b99fbf4e48b280bf"],
		["@exxeta/exxperts-ai/dist/env-api-keys.js", "b09853d5e91b01cec5397a585205427c040eec332f1a1c659b255a01ad27d948"],
		["@exxeta/exxperts-ai/dist/providers/openai-codex-responses.js", "2f257a176ae10bd80328e50f52f7c08d354334595884374c428f65d30fe36579"],
		["@exxeta/exxperts-ai/dist/providers/register-builtins.js", "2a30aae71359bd3b05989f2d0dfd4e029fc5c8d76dcbde9e60d81153445ce21b"],
		["@silvia-odwyer/photon-node/photon_rs.js", "d60656705f0d59baa79e36b0381eb023f1864eeb57e92956cf21dcd9fb8f879f"],
		["playwright-core/lib/coreBundle.js", "f74353fcb8e406756a70a6af0dfc4a5069acd577e35ec9d923ccf36ac009c2f5"],
		["playwright-core/lib/package.js", "9f938e1d44a0dd231b1660ca62f7dae964859b79cbdc370b8542c5d375ca3c05"],
		["playwright-core/lib/serverRegistry.js", "b7173eb632bdbf34a6aa137b55e50fbdc95acda4851480423afe6caa86cc48b7"],
		["playwright-core/lib/utilsBundle.js", "5c42363c10d2f2f5bc91e07feaa9fa5f417a1a55e6559448d0c20d66f73db9e0"],
		["playwright-core/lib/tools/cli-client/program.js", "0aa50a2f2c2a2b2b12c6b08baa2ed358aa748ac713966b9982e585dcb9e19d3f"],
		["jiti/dist/babel.cjs", "b3bc89a8dc40860fb6a7a78512bdfe5976c6253e6ded74b7d96ece803cac8701"],
		["jiti/dist/jiti.cjs", "a0b3b8d5e06a0519c66b62179e29200533057920f6f11370546e979dacd24c49"],
		["jiti/lib/jiti-native.mjs", "041dbe425c05afb43cbc4d3058dc1d74e420660d1b33d415a190e7480ef11587"],
		["jiti/lib/jiti.mjs", "48a7909df16a2a93e814d2c7a6f105eea7b291ae6bcb968fb2ca21a37cb61b1e"],
		["jiti/lib/jiti-cli.mjs", "8829aad7e953f97ef9e25782c99eafa013efa0c36db7c2ffebcc140bd8eeaf54"],
		["jiti/lib/jiti.cjs", "a80e7f04d21d4ef5c540287e41d6ab36dbff73132620e1894cd83425bb1e62a7"],
		["jiti/lib/jiti-static.mjs", "0d873b8be0c9e08e1136ea428175de8cf8a200c67b6b83283a009b3f46ff4a3a"],
		["pdfjs-dist/build/pdf.worker.mjs", "cee92175925a2a7a43f3450a99e583fcbecc2685509e1dc270a03a186861592f"],
		["pdfjs-dist/build/pdf.worker.min.mjs", "d308bfa143e6d54df7c705ac6001890049debcd8c1d11bab53f80f4247f8e5dd"],
		["pdfjs-dist/build/pdf.mjs", "b33deb12e2f6c0c8dfb1e30c87f1f9a3f03dc4c56d330264dbb86edc21fac905"],
		["pdfjs-dist/build/pdf.min.mjs", "32b886286af97ee76f8eb5b655f9799cc774e36ab08c0323ee509c738e9f1f8c"],
		["pdfjs-dist/web/pdf_viewer.mjs", "0a93880b4e1af8d9e3b70195cf93ccb5c666840b76a7895fa6b902234b6e212f"],
		["pdfjs-dist/image_decoders/pdf.image_decoders.min.mjs", "9868058e71427a582efc97f5e79442c84cbe840a4bd056b246918705361d7b78"],
		["pdfjs-dist/image_decoders/pdf.image_decoders.mjs", "4a3c3a1864ebda86e86787aaef528b600455ae688000a3d92da8103e994b0004"],
		["pdfjs-dist/legacy/build/pdf.worker.mjs", "04eda54d0a5246361374b2b5327132dcbc44b757c6dd168dddb5299bd64bab58"],
		["pdfjs-dist/legacy/build/pdf.worker.min.mjs", "2cbba88314e2190adcf33ec17cbc92c9994057cd8aff29a06b514015b45f270a"],
		["pdfjs-dist/legacy/build/pdf.mjs", "4cfa5d40e6ea3b974f82d274f8c7ca4db8299b74c2e617baedb0892da4f9b8cb"],
		["pdfjs-dist/legacy/build/pdf.min.mjs", "d2242a429cffd2a60d0bd24aaec1016d4421e889cd2fac8ebd8180d46eb0730f"],
		["pdfjs-dist/legacy/web/pdf_viewer.mjs", "fd78841827dabbf868236379dfa2a6c42b68ce85471a7ec4a8bbcf62aad0a758"],
		["pdfjs-dist/legacy/image_decoders/pdf.image_decoders.min.mjs", "112f905d057dd5885c5102852ed85c7dc478dc20102535cdc7a9c29810147b8c"],
		["pdfjs-dist/legacy/image_decoders/pdf.image_decoders.mjs", "8793aff265b01472217248c88738dba3fd0e10b3b9a6e2f381819dd351062e87"],
		["yargs/build/index.cjs", "0b21eea4fac143517326d23b3962bd6aa3095f274c0cb804d2866e8b5f40745b"],
		["yargs/build/lib/utils/apply-extends.js", "64640dce92669705abead3bdbe2c46c8318c8623843a55e4726fb3c55ff9dd1d"],
		["koffi/src/cnoke/src/builder.js", "53a48af14d00256f3f60d6265d8bc637fe1fe50e0cbebb3ecc610bd9cc46b199"],
	]);
	// Parse module loads so escaped specifiers are resolved as JavaScript sees
	// them. Existing computed sites are pinned to their reviewed source bytes.
	function inspect(full, dependency = false) {
		if (!/\.[cm]?[jt]s$/.test(full) || DECLARATION_FILE.test(full) || full.endsWith("shelf-parse-worker.mjs")) return;
		const text = fs.readFileSync(full, "utf8");
		const relative = path.relative(app, full).split(path.sep).join("/");
		const source = ts.createSourceFile(full, text, ts.ScriptTarget.Latest, true);
		if (source.parseDiagnostics.length) {
			const knownOctal = dependency && path.relative(nodeModulesDir, full).split(path.sep).join("/") === "qrcode-terminal/lib/main.js" && source.parseDiagnostics.every((item) => item.code === 1487) && createHash("sha256").update(text.replaceAll("\r\n", "\n")).digest("hex") === reviewedDependencies.get("qrcode-terminal/lib/main.js");
			if (!knownOctal) throw new Error(`${relative} could not be parsed for imports`);
		}
		const aliases = new Set(["require"]);
		const factories = new Set(["createRequire"]);
		const nodes = [source];
		for (let i = 0; i < nodes.length; i++) ts.forEachChild(nodes[i], (child) => { nodes.push(child); });
		for (const node of nodes) {
			if ((ts.isBindingElement(node) || ts.isImportSpecifier(node)) && ts.isIdentifier(node.name)) {
				const original = node.propertyName && (ts.isIdentifier(node.propertyName) || ts.isStringLiteralLike(node.propertyName)) ? node.propertyName.text : node.name.text;
				if (original === "createRequire") factories.add(node.name.text);
				if (original === "require") aliases.add(node.name.text);
			}
		}
		for (const node of nodes) {
			if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) continue;
			const value = node.initializer;
			if ((ts.isIdentifier(value) && value.text === "require") ||
				(ts.isPropertyAccessExpression(value) && value.name.text === "require" && value.expression.getText(source) === "module") ||
				(ts.isElementAccessExpression(value) && ts.isStringLiteralLike(value.argumentExpression) && value.argumentExpression.text === "require" && value.expression.getText(source) === "module") ||
				(ts.isCallExpression(value) && ts.isIdentifier(value.expression) && factories.has(value.expression.text)) ||
				(ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression) && value.expression.name.text === "bind" && value.expression.expression.getText(source) === "module.require")) aliases.add(node.name.text);
		}
		let checkedDynamic = false;
		function load(argument) {
			// Generated browser bundles use numeric local module IDs.
			if (argument && ts.isNumericLiteral(argument)) return;
			if (argument && ts.isStringLiteralLike(argument)) {
				const specifier = argument.text;
				const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
				if (!builtinModules.includes(name) && !name.startsWith("node:") && omittedDirs.has(resolvePackageDir(app, path.dirname(full), name))) throw new Error(`${relative} imports worker-only package ${name}${ts.isNoSubstitutionTemplateLiteral(argument) ? " in a computed import" : ""}`);
				return;
			}
			if (checkedDynamic) return;
			checkedDynamic = true;
			const hash = createHash("sha256").update(text.replaceAll("\r\n", "\n")).digest("hex");
			const known = dependency ? reviewedDependencies.get(path.relative(nodeModulesDir, full).split(path.sep).join("/")) : reviewed.find((item) => item.file === relative)?.hash;
			if (known !== hash) throw new Error(`${relative} has an unreviewed computed import`);
		}
		for (const node of nodes) {
			if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) load(node.moduleSpecifier);
			else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) load(node.moduleReference.expression);
			else if (ts.isCallExpression(node)) {
				const callee = node.expression;
				const direct = callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && aliases.has(callee.text)) || (ts.isCallExpression(callee) && ts.isIdentifier(callee.expression) && factories.has(callee.expression.text));
				const property = ts.isPropertyAccessExpression(callee) && (callee.name.text === "import" || callee.name.text === "require" || (callee.name.text === "resolve" && ts.isIdentifier(callee.expression) && aliases.has(callee.expression.text)));
				const element = ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression) && (callee.argumentExpression.text === "require" || callee.argumentExpression.text === "import");
				if (direct || property || element) load(node.arguments[0]);
			}
		}
	}
	for (const rel of ["bin", "pi-package", "runtime/packages", "apps/web-server/src", "scripts/doctor.mjs", "scripts/searxng.mjs"]) {
		const file = path.join(app, ...rel.split("/"));
		if (!fs.existsSync(file)) continue;
		if (fs.statSync(file).isDirectory()) walkFiles(file, (full) => inspect(full));
		else inspect(file);
	}
	for (const dir of kept) {
		walkFiles(dir, (full, rel) => {
			if (rel.split("/").includes("node_modules") || /(?:^|\/)(?:test|tests|__tests__|examples?)(?:\/|\.|$)/i.test(rel) || (dir.endsWith(`${path.sep}fastq`) && rel === "bench.js") || (dir.endsWith(`${path.sep}node-domexception`) && rel.startsWith(".history/"))) return;
			const packageRel = path.relative(nodeModulesDir, full).split(path.sep).join("/");
			if (!isProtected(packageRel) && pruneKind(path.basename(full)) === "typescript") return;
			inspect(full, true);
		});
	}
	return omitted;
}

export function pruneNodeModules(nodeModulesDir) {
	const workerOnly = workerOnlyPackages(path.dirname(nodeModulesDir), nodeModulesDir);
	if (workerOnly.length) {
		const app = path.dirname(nodeModulesDir);
		fs.copyFileSync(path.join(app, "apps/web-server/dist/shelf-parse-worker.mjs"), path.join(app, "apps/web-server/src/shelf-parse-worker.mjs"));
	}
	const removed = new Set();
	const counts = { maps: 0, declarations: 0, typescript: 0, markdown: 0 };
	let filesBefore = 0;
	walkFiles(nodeModulesDir, (full, rel, name) => {
		filesBefore++;
		if (isProtected(rel)) return;
		const kind = pruneKind(name);
		if (!kind) return;
		fs.rmSync(full);
		removed.add(full);
		counts[kind]++;
	});
	counts.workerOnly = 0;
	for (const dir of workerOnly) {
		const rel = path.relative(nodeModulesDir, dir).split(path.sep).join("/");
		if (isProtected(rel)) throw new Error(`protected package ${rel} cannot be pruned`);
		walkFiles(dir, (full, childRel, name) => {
			if (childRel.split("/").includes("node_modules") || LICENCE_FILE.test(name)) return;
			fs.rmSync(full);
			removed.add(full);
			counts.workerOnly++;
		});
	}
	return { filesBefore, filesAfter: filesBefore - removed.size, removed, counts };
}

// The static gate: every remaining JavaScript file that imports or requires a
// TypeScript file the prune removed, as { file, specifier }. Empty when the
// trimmed tree is safe to ship. A declaration file holds no run-time code, so
// a reference to one is a type annotation (JSDoc such as
// `@type {import('./list.d.ts').X}`, seen in undici and side-channel-list)
// and never fails the gate.
export function findPrunedTypeScriptImports(nodeModulesDir, removed) {
	const broken = new Map();
	walkFiles(nodeModulesDir, (full) => {
		if (!JS_FILE.test(full)) return;
		const text = fs.readFileSync(full, "utf8");
		for (const match of text.matchAll(RELATIVE_TS_SPECIFIER)) {
			const specifier = match[2];
			if (DECLARATION_FILE.test(specifier)) continue;
			if (removed.has(path.resolve(path.dirname(full), specifier))) broken.set(`${full}\0${specifier}`, { file: full, specifier });
		}
	});
	return [...broken.values()];
}
