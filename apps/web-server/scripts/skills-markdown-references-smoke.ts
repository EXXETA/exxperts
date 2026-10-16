import assert from "node:assert/strict";
import { parse } from "yaml";
import { skillMarkdownReferences } from "../src/skills-markdown-references.js";
import { normalizedRepositorySkill, parseSkillFrontmatter } from "../src/skills-repo-fetch.js";
const files = new Set(["skills/brand/references/rules.md", "assets/logo.svg", "docs/design.md", "skills/other/SKILL.md", "skills/brand/helper.ts"]);
const markdown = `[Rules](references/rules.md#colors) ![Logo](../../assets/logo.svg)
[Design][design]
[design]: ../../docs/design.md
Canonical source: \`docs/design.md\`. Also <../../assets/logo.svg>.
<img src="../../assets/logo.svg"> [Other skill](../other/SKILL.md)
[Program](helper.ts) [Missing](missing.md)
[External](https://example.invalid/private.md) [Escape](../../../outside.md)
[Absolute](/etc/passwd) [Windows](C:/private.md) [Self](SKILL.md)
\`\`\`md
[Example](never-read.md)
\`\`\``;
assert.deepEqual(skillMarkdownReferences(markdown, "skills/brand", files), ["assets/logo.svg", "docs/design.md", "skills/brand/helper.ts", "skills/brand/missing.md", "skills/brand/references/rules.md", "skills/other/SKILL.md"]);
assert.deepEqual(skillMarkdownReferences("[Encoded](../../docs/%64esign.md)", "skills/brand", files), ["docs/design.md"]);
assert.deepEqual(skillMarkdownReferences("[Bad](%E0%A4%A) [Encoded absolute](%2Fprivate.md)", "skills/brand", files), []);
const original = "---\nname: Design_Base_Skill\ndescription: |\n  Design instructions\ndependencies: [brand-core]\n---\n# Keep the instructions\n";
const normalized = normalizedRepositorySkill(original, "skills/design_base_skill");
assert.equal(normalized.name, "design-base-skill");
assert.equal(normalized.originalName, "Design_Base_Skill");
assert.equal(parseSkillFrontmatter(normalized.manifest).fm.name, normalized.name);
assert.equal(parseSkillFrontmatter(normalized.manifest).body, parseSkillFrontmatter(original).body);
assert.deepEqual(parse(normalized.manifest.split("---")[1]).dependencies, ["brand-core"]);
assert.equal(normalizedRepositorySkill(normalized.manifest, "skills/design_base_skill").manifest, normalized.manifest);
assert.equal(normalizedRepositorySkill("# No frontmatter", "skills/design_base_skill").name, "design-base-skill");
assert.equal(normalizedRepositorySkill("# Unchanged", "skills/brand-a").manifest, "# Unchanged");
assert.equal(normalizedRepositorySkill("# Truncated", `skills/${"a".repeat(47)}__suffix`).name, "a".repeat(47));
console.log("skills-markdown-references-smoke: OK");
