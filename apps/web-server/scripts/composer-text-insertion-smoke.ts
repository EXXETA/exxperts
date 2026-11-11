// A workspace path dropped on the composer replaces the selection and leaves the caret behind it.
import { insertTextAtSelection, WORKSPACE_PATH_DRAG_TYPE } from "../../web-ui/src/composer-text-insertion.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const path = "docs/guide.md";

const replaced = insertTextAtSelection("Ask this file", path, 4, 8);
assert(replaced.value === "Ask docs/guide.md file", "a selection should be replaced by the path");
assert(replaced.caret === 4 + path.length, "the caret should sit behind the path");

const atCaret = insertTextAtSelection("Read ", path, 5, 5);
assert(atCaret.value === "Read docs/guide.md", "without a selection the path goes in at the caret");

const outOfRange = insertTextAtSelection("short", path, 99, 120);
assert(outOfRange.value === "shortdocs/guide.md", "a selection past the end should clamp to the end");
assert(outOfRange.caret === outOfRange.value.length, "a clamped caret should sit behind the path");

const inverted = insertTextAtSelection("abcdef", path, 4, 2);
assert(inverted.value === "abcddocs/guide.mdef", "an inverted selection should not remove text");

assert(WORKSPACE_PATH_DRAG_TYPE === "application/x-exxperts-workspace-path", "tree and composer should share one drag type");

console.log("composer-text-insertion smoke passed");
