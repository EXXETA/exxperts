// The detection behind the restart holders lists: which module-level names in
// a set of sources hold state a restart loses, and what is wrong between those
// and a list. No side effects, so each list's smoke imports the one detection.
//
// A holder is a module-level `let`, a Map or Set that starts empty or is changed,
// another object made with `new`, an array or object that is changed, and a
// `create...` or `make...` call, which may keep state in its closure. "Changed"
// counts the file itself and any file that imports the name. A state held inside
// a function that no module-level name keeps is that function's, not a holder.
import ts from "typescript";
import type { RestartHolder } from "./restart-holders-list.js";

const CHANGING_METHODS = new Set(["add", "clear", "copyWithin", "delete", "fill", "pop", "push", "reverse", "set", "shift", "sort", "splice", "unshift"]);
const COLLECTIONS = new Set(["Map", "Set", "WeakMap", "WeakSet"]);
/** Made with `new`, and holding nothing a request changes. */
const STATELESS_CLASSES = /^(Date|Error|Intl\.\w+|RegExp|TextDecoder|TextEncoder|URL)$/;
const FACTORY_CALL = /^(create|make)[A-Z]/;

type Sources = ReadonlyMap<string, string>;

function unwrapped(node: ts.Expression | undefined): ts.Expression | undefined {
	let current = node;
	while (current && (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current))) current = current.expression;
	return current;
}

function rootName(node: ts.Expression): string | undefined {
	let current = node;
	while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) current = current.expression;
	return ts.isIdentifier(current) ? current.text : undefined;
}

/** The names a file changes in place, whoever declared them. */
function namesChanged(file: ts.SourceFile): Set<string> {
	const changed = new Set<string>();
	const note = (target: ts.Expression) => {
		const name = rootName(target);
		if (name) changed.add(name);
	};
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && CHANGING_METHODS.has(node.expression.name.text)) note(node.expression.expression);
		if (ts.isCallExpression(node) && node.expression.getText(file) === "Object.assign" && node.arguments[0]) note(node.arguments[0]);
		if (ts.isDeleteExpression(node)) note(node.expression);
		if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))) note(node.left);
		ts.forEachChild(node, visit);
	};
	visit(file);
	return changed;
}

function namesImported(file: ts.SourceFile): Set<string> {
	const names = new Set<string>();
	for (const statement of file.statements) {
		const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : undefined;
		if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) names.add((element.propertyName ?? element.name).text);
	}
	return names;
}

/** Each holder in the sources, as "file:name". */
export function findHolders(sources: Sources): Set<string> {
	const parsed = [...sources].map(([name, text]) => ({ name, file: ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true) }));
	const seen = parsed.map(({ name, file }) => ({ name, file, changed: namesChanged(file), imported: namesImported(file) }));
	const changedAnywhere = (owner: string, name: string) => seen.some((other) => other.changed.has(name) && (other.name === owner || other.imported.has(name)));
	const holders = new Set<string>();
	for (const { name: fileName, file } of seen) {
		for (const statement of file.statements) {
			if (!ts.isVariableStatement(statement)) continue;
			const isLet = (statement.declarationList.flags & ts.NodeFlags.BlockScoped) === ts.NodeFlags.Let || (statement.declarationList.flags & ts.NodeFlags.BlockScoped) === 0;
			for (const declaration of statement.declarationList.declarations) {
				if (!ts.isIdentifier(declaration.name)) continue;
				const name = declaration.name.text;
				const value = unwrapped(declaration.initializer);
				const changed = changedAnywhere(fileName, name);
				let holds = isLet;
				if (value && ts.isNewExpression(value)) {
					const made = value.expression.getText(file);
					holds ||= COLLECTIONS.has(made) ? !value.arguments?.length || changed : !STATELESS_CLASSES.test(made);
				} else if (value && (ts.isArrayLiteralExpression(value) || ts.isObjectLiteralExpression(value))) holds ||= changed;
				else if (value && ts.isCallExpression(value) && ts.isIdentifier(value.expression)) holds ||= FACTORY_CALL.test(value.expression.text);
				if (holds) holders.add(`${fileName}:${name}`);
			}
		}
	}
	return holders;
}

/** The files a list's problems point to: the list, and its known cases' file, or none where the list may hold no gap. */
export type ListFiles = { list: string; knownCases: string | null };

/** What is wrong between the holders found and the list. */
export function listProblems(found: ReadonlySet<string>, lines: readonly RestartHolder[], knownCaseIds: ReadonlySet<string>, files: ListFiles): string[] {
	const problems: string[] = [];
	const listed = new Set(lines.map((line) => line.holder));
	if (listed.size !== lines.length) problems.push("a holder is listed twice");
	for (const holder of found) if (!listed.has(holder)) problems.push(`${holder} is not on the list: add it to ${files.list} with what a restart does to it`);
	for (const line of lines) {
		if (!found.has(line.holder)) problems.push(`${line.holder} is on the list but no such holder exists: take its line off`);
		if (line.fate !== "gap") continue;
		if (files.knownCases === null) problems.push(`${line.holder} is a gap, and ${files.list} takes no gap until it has a known cases list of its own`);
		else if (!knownCaseIds.has(line.knownCase)) problems.push(`${line.holder} is a gap, and its known case ${line.knownCase} is not in ${files.knownCases}`);
	}
	return problems;
}
