import fs from "node:fs";
import path from "node:path";
import { agentSkillsDir, writeSkillProvenance, sha256, localSkillProvenance, readSkillProvenance, removeManagedSkillDir, SKILL_PROVENANCE_FILENAME, type SkillProvenance } from "./skills-store.js";
import { scanInvisibleUnicode } from "./skills-import.js";
import { getCheckout, removeCheckout, parseSkillFrontmatter as parseFrontmatter, installCheckoutCleanup, resolveRepoSource, fetchRepoCheckout, isMissingToolMessage, registerCheckout, scanRepoSkills, readRepoCandidate, vendorRepoSkill, resolveFeaturedSources, loadFeaturedSource } from "./skills-repo-fetch.js";
import { app } from "./server-app.js";
import { buildSkillCandidateFromUpload, buildUserSkillMarkdown, getUserSkillFile, librarySkillView, listSkills, MAX_SKILL_UPLOAD_BYTES, resolveExecutableSkillFiles, skillExistsAnySource, skillRoomsByName, slugifySkillId, validateSkillWritePayload } from "./skills-library.js";

app.get("/api/skills", async (req) => {
	const roomsByName = skillRoomsByName(req);
	return listSkills().map((skill) => librarySkillView(skill, roomsByName));
});

app.get("/api/skills/:id", async (req, reply) => {
	const id = slugifySkillId(String((req.params as any).id ?? ""));
	const skill = listSkills().find((s) => s.name === id);
	if (!skill) return reply.code(404).send({ error: `skill not found: ${id}` });
	// The detail view IS the review screen: attach the same trust-moment data an upload
	// candidate carries. Its files are the ones a room can be allowed to run, so a
	// skill that can never run files (see resolveExecutableSkillFiles) lists none.
	const files = resolveExecutableSkillFiles(skill.name)?.files ?? [];
	return reply.send({ ...librarySkillView(skill, skillRoomsByName(req), files), scanFindings: scanInvisibleUnicode(`${skill.body}\n${skill.description ?? ""}`).findings, bundledScripts: files });
});

app.post("/api/skills/upload", { bodyLimit: 12 * 1024 * 1024 }, async (req, reply) => {
	const raw = (req.body ?? {}) as { filename?: unknown; contentBase64?: unknown };
	const filename = typeof raw.filename === "string" ? raw.filename : "";
	const contentBase64 = typeof raw.contentBase64 === "string" ? raw.contentBase64 : "";
	if (!contentBase64) return reply.code(400).send({ error: "no file content" });
	const buffer = Buffer.from(contentBase64, "base64");
	if (buffer.byteLength === 0) return reply.code(400).send({ error: "the file is empty or not valid base64" });
	if (buffer.byteLength > MAX_SKILL_UPLOAD_BYTES) return reply.code(413).send({ error: `file too large (max ${Math.floor(MAX_SKILL_UPLOAD_BYTES / (1024 * 1024))} MB)` });
	try {
		return reply.send(await buildSkillCandidateFromUpload(filename, buffer));
	} catch (e) {
		return reply.code(400).send({ error: (e as Error).message });
	}
});

app.post("/api/skills/accept", async (req, reply) => {
	// Write a reviewed candidate to the library. Reuses the write validation, but records
	// the candidate's own provenance (source/license) instead of forcing "local".
	const raw = (req.body ?? {}) as Record<string, unknown>;
	const validation = validateSkillWritePayload(raw);
	if (!validation.ok) return reply.code(validation.code).send({ error: validation.error });
	const value = validation.value;
	if (skillExistsAnySource(value.id)) return reply.code(409).send({ error: `skill id already exists: ${value.id}` });
	const source = typeof raw.source === "string" && raw.source.trim() ? raw.source.trim() : "upload";
	const license = typeof raw.license === "string" && raw.license.trim() ? raw.license.trim() : null;
	const skillDir = path.join(agentSkillsDir(), value.id);
	fs.mkdirSync(skillDir, { recursive: true, mode: 0o700 });
	const acceptedManifest = buildUserSkillMarkdown(value);
	fs.writeFileSync(path.join(skillDir, "SKILL.md"), acceptedManifest, { mode: 0o600, flag: "wx" });
	// A zip upload retained its bundled files under a checkout token (see
	// buildSkillCandidateFromUpload): vendor them beside the accepted SKILL.md
	// as inert files, exactly like repo import. An expired/absent token accepts
	// the manifest alone — same outcome as the pre-retention behavior.
	const uploadToken = typeof raw.token === "string" ? raw.token : "";
	let bundledCopied = 0;
	if (uploadToken) {
		const checkout = getCheckout(uploadToken);
		// Flow-bound: only a token minted by the UPLOAD endpoint vendors files
		// here. A repo/featured checkout token also resolves in the shared cache
		// but points at a whole repository clone; pairing one with a reviewed
		// upload manifest would vendor a tree the review screen never showed.
		if (checkout && checkout.source === "upload") {
			const copyTree = (fromDir: string, toDir: string): void => {
				for (const entry of fs.readdirSync(fromDir, { withFileTypes: true })) {
					if (entry.isSymbolicLink()) continue;
					const from = path.join(fromDir, entry.name);
					const to = path.join(toDir, entry.name);
					if (entry.isDirectory()) {
						fs.mkdirSync(to, { recursive: true, mode: 0o700 });
						copyTree(from, to);
					} else if (entry.isFile() && entry.name !== "SKILL.md") {
						fs.copyFileSync(from, to);
						fs.chmodSync(to, 0o600);
						bundledCopied += 1;
					}
				}
			};
			copyTree(checkout.dir, skillDir);
			// Consumed: an accept is the token's one purpose; a token that kept
			// resolving for its 15-minute TTL could vendor into later accepts.
			removeCheckout(uploadToken);
		}
	}
	// sha256 pins the whole accepted SKILL.md (frontmatter + body), so any later
	// edit — description included — forces re-review (spec §7 must 2). Written
	// AFTER the bundled files so the stamped files digest covers them.
	writeSkillProvenance(skillDir, { source, importedAt: new Date().toISOString(), license, sha256: sha256(acceptedManifest) });
	const created = listSkills().find((skill) => skill.name === value.id);
	const payload = created ? librarySkillView(created, skillRoomsByName(req)) : { name: value.id, displayName: value.displayName, description: value.description, body: value.instructions, source: "user", protected: false, rooms: [], fileCount: 0, provenance: { source, license, importedAt: new Date().toISOString() }, license };
	return reply.code(201).send({ ...payload, bundledCopied });
});

app.post("/api/skills", async (req, reply) => {
	const validation = validateSkillWritePayload(req.body ?? {});
	if (!validation.ok) return reply.code(validation.code).send({ error: validation.error });
	const value = validation.value;
	if (skillExistsAnySource(value.id)) return reply.code(409).send({ error: `skill id already exists: ${value.id}` });

	const skillDir = path.join(agentSkillsDir(), value.id);
	const file = path.join(skillDir, "SKILL.md");
	fs.mkdirSync(skillDir, { recursive: true, mode: 0o700 });
	const markdown = buildUserSkillMarkdown(value);
	fs.writeFileSync(file, markdown, { mode: 0o600, flag: "wx" });
	// Provenance sidecar: hand-written skills are source "local"; sha256 pins the
	// whole SKILL.md, so a later description/body edit forces re-review.
	writeSkillProvenance(skillDir, localSkillProvenance(markdown));
	const created = listSkills().find((skill) => skill.name === value.id);
	return reply.code(201).send(created ? librarySkillView(created, skillRoomsByName(req)) : { name: value.id, displayName: value.displayName, description: value.description, body: value.instructions, source: "user", protected: false, rooms: [], fileCount: 0, provenance: { source: "local", license: null, importedAt: new Date().toISOString() }, license: null });
});

app.put("/api/skills/:id", async (req, reply) => {
	const id = slugifySkillId(String((req.params as any).id ?? ""));
	const file = getUserSkillFile(id);
	if (!file) return reply.code(404).send({ error: `editable user skill not found: ${id}` });
	// Grandfather the stored description: a body-only edit of a pre-existing skill whose
	// description already exceeds ≤1024 must not be blocked by that rule (spec fix). The
	// limit is still enforced the moment the description actually changes.
	const storedDescription = (parseFrontmatter(fs.readFileSync(file, "utf-8")).fm.description || "").trim();
	const validation = validateSkillWritePayload(req.body ?? {}, id, { grandfatheredDescription: storedDescription });
	if (!validation.ok) return reply.code(validation.code).send({ error: validation.error });
	const value = validation.value;
	const editedManifest = buildUserSkillMarkdown(value);
	fs.writeFileSync(file, editedManifest, { mode: 0o600, flag: "w" });
	// Refresh the sha256 over the whole SKILL.md — a description-only edit must
	// trip re-review just like a body edit. Origin (source/license/importedAt)
	// survives: a local edit of an imported skill must not erase where it came from.
	const existingProvenance = readSkillProvenance(path.dirname(file));
	writeSkillProvenance(path.dirname(file), existingProvenance ? { ...existingProvenance, sha256: sha256(editedManifest) } : localSkillProvenance(editedManifest));
	const updated = listSkills().find((skill) => skill.name === id);
	return reply.send(updated ? librarySkillView(updated, skillRoomsByName(req)) : { name: id, displayName: value.displayName, description: value.description, body: value.instructions, source: "user", protected: false, rooms: [], fileCount: 0, provenance: null, license: null });
});

app.delete("/api/skills/:id", async (req, reply) => {
	const id = slugifySkillId(String((req.params as any).id ?? ""));
	const file = getUserSkillFile(id);
	if (!file) return reply.code(404).send({ error: `deletable user skill not found: ${id}` });
	// Repo-imported skills (MR-4) can bundle asset files next to SKILL.md, so a
	// bare unlink+rmdir would leave a non-empty dir behind. removeManagedSkillDir
	// removes the whole dir recursively, but only after re-checking it is a real
	// `<store>/<id>` skill dir under the canonical store (never a path outside it).
	if (!removeManagedSkillDir(path.dirname(file))) {
		// Guard tripped (should not happen for a getUserSkillFile hit): fall back to
		// the minimal unlink so a single-file skill still deletes.
		fs.unlinkSync(file);
		try { fs.unlinkSync(path.join(path.dirname(file), SKILL_PROVENANCE_FILENAME)); } catch {}
		try { fs.rmdirSync(path.dirname(file)); } catch {}
	}
	return reply.send({ ok: true, deleted: id });
});

// --- Import from repo + featured Browse (spec §3 path 3 + Browse, MR-4) -------
//
// A pasted git/GitHub URL (or a featured source) is SHALLOW-cloned server-side
// into a temp checkout (clone/read only — never executed), scanned for its true
// SKILL.md skills, and turned into review-screen candidates. The scan hands back
// a token; review + accept reuse that same checkout so the accepted body is
// byte-identical to the reviewed one. Nothing enters the library before accept.
// Local repo paths (file://, absolute paths) are OFF by default — enabling them
// turns repo-scan into a local-file-read primitive if the server is ever fronted.
// Smokes need them, so they are gated behind an explicit env flag the smokes set,
// rather than always-on. Default deny keeps the production endpoint URL-only.
const SKILLS_ALLOW_LOCAL_REPO = process.env.EXXETA_SKILLS_ALLOW_LOCAL_REPO === "1";

installCheckoutCleanup();

app.post("/api/skills/repo/scan", async (req, reply) => {
	const source = String((req.body as any)?.source ?? "");
	const resolved = resolveRepoSource(source, { allowLocal: SKILLS_ALLOW_LOCAL_REPO });
	if (!resolved.ok) return reply.code(400).send({ error: resolved.error });
	let dir: string;
	try {
		dir = await fetchRepoCheckout(resolved.value);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		// A missing tool is a whole sentence of its own; the prefix would blame the repository.
		return reply.code(502).send({ error: isMissingToolMessage(message) ? message : `could not fetch repository: ${message}` });
	}
	const token = registerCheckout(dir, resolved.value.display);
	return reply.send({ token, source: resolved.value.display, skills: scanRepoSkills(dir) });
});

app.post("/api/skills/repo/candidate", async (req, reply) => {
	const body = (req.body as any) ?? {};
	const checkout = getCheckout(String(body.token ?? ""));
	if (!checkout) return reply.code(404).send({ error: "repository checkout expired — rescan the URL" });
	const candidate = readRepoCandidate(checkout.dir, String(body.path ?? ""), checkout.source);
	if (!candidate) return reply.code(404).send({ error: "skill not found in the fetched repository" });
	return reply.send(candidate);
});

app.post("/api/skills/repo/import", async (req, reply) => {
	const body = (req.body as any) ?? {};
	const checkout = getCheckout(String(body.token ?? ""));
	if (!checkout) return reply.code(404).send({ error: "repository checkout expired — rescan the URL" });
	const skillPath = String(body.path ?? "");
	const candidate = readRepoCandidate(checkout.dir, skillPath, checkout.source);
	if (!candidate) return reply.code(404).send({ error: "skill not found in the fetched repository" });
	// The store id MUST be the FRONTMATTER name the skill will be listed under, not the
	// repo DIRECTORY name: listSkills keys on `fm.name`, and delete/edit/enable all
	// resolve `<store>/<id>` where id must equal that listed name — so a dir named after
	// the directory instead would strand a library entry that can't be deleted, edited or
	// enabled. Vendoring is verbatim (the reviewed body/sha256 is untouched), so the name
	// must already be a canonical skill id (the same rule every other write enforces); a
	// non-canonical name can't round-trip, so reject THIS skill's import naming the file.
	const manifestRel = skillPath ? `${skillPath.replace(/\\/g, "/").replace(/\/+$/, "")}/SKILL.md` : "SKILL.md";
	const rawName = candidate.name.trim();
	const id = slugifySkillId(String(body.id ?? rawName));
	if (!id || id !== rawName || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
		return reply.code(400).send({ error: `could not import ${manifestRel}: skill name "${candidate.name}" is not a valid skill id (expected lowercase letters, numbers and hyphens)` });
	}
	if (skillExistsAnySource(id)) return reply.code(409).send({ error: `skill id already exists: ${id}` });
	const skillDir = path.join(agentSkillsDir(), id);
	// Only clean up a dir THIS import created — never delete a pre-existing one on
	// a vendor failure (skillExistsAnySource gates on SKILL.md, so a bare leftover
	// dir could otherwise be removed out from under the user).
	const skillDirPreexisted = fs.existsSync(skillDir);
	let vendored: ReturnType<typeof vendorRepoSkill>;
	try {
		vendored = vendorRepoSkill(checkout.dir, skillPath, skillDir);
	} catch (err) {
		if (!skillDirPreexisted) fs.rmSync(skillDir, { recursive: true, force: true });
		return reply.code(400).send({ error: `could not import skill: ${err instanceof Error ? err.message : String(err)}` });
	}
	// Provenance via MR-1 machinery: source is the repo, sha256 pins the whole
	// SKILL.md that actually landed on disk — exactly what enablement/re-review
	// re-derive (spec §0/§2/§7).
	const vendoredManifest = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf-8");
	const provenance: SkillProvenance = { source: checkout.source, importedAt: new Date().toISOString(), license: vendored.license, sha256: sha256(vendoredManifest) };
	writeSkillProvenance(skillDir, provenance);
	const created = listSkills().find((s) => s.name === candidate.name) ?? listSkills().find((s) => s.name === id) ?? null;
	return reply.code(201).send({ skill: created ? librarySkillView(created, skillRoomsByName(req)) : null, provenance, bundledCopied: vendored.bundledCopied });
});

app.get("/api/skills/featured", async () => {
	const sources = resolveFeaturedSources();
	const results = await Promise.all(sources.map((entry) => loadFeaturedSource(entry)));
	return { sources: results };
});
