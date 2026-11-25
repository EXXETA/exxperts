import fs from "node:fs";
import path from "node:path";
import { agentSkillsDir, isSkillId, writeSkillProvenance, sha256, localSkillProvenance, isNotPlainOrAbsent, installedSkillFilesSha256, readSkillFileText, readSkillIdentity, writeSkillFileText, reserveSkillIdentity, readSkillProvenance, removeManagedSkillDir, replaceSkillDir, restoreCutReplaces, SKILL_PROVENANCE_FILENAME, type SkillProvenance } from "./skills-store.js";
import { keptFileMode, scanInvisibleUnicode, skillOverLimit, SkillTooBigError } from "./skills-import.js";
import { repositoryFailedLine, SKILL_CHANGED_SINCE_REVIEW, SKILL_NAME_TAKEN, SKILL_REPLACE_FAILED_LINE, SKILL_TOO_BIG, SKILL_UPLOAD_GONE, SKILL_UPLOAD_MAX_BYTES, skillChangedSinceReviewLine, skillNameTakenLine, type SkillTooBig } from "../../web-ui/src/skill-source-copy.js";
import { getCheckout, removeCheckout, parseSkillFrontmatter as parseFrontmatter, installCheckoutCleanup, resolveRepoSource, fetchRepoCheckout, fitSkillName, offeredRepoSkills, registerCheckout, repoFailureOf, scanRepoSkills, readRepoCandidate, repoSkillFiles, fileModeAndHead, vendorRepoSkill, resolveFeaturedSources, loadFeaturedSource, skillVersion, type RepoOrigin } from "./skills-repo-fetch.js";
import { checkSkillLibrary, checkSkillUpdates, closeSkillUpdateNotices, setSkillAutoUpdate, skillUpdatesReader, SKILLS_ALLOW_LOCAL_REPO, updateSkill, type SkillNoticeShown, type SkillUpdateRequest } from "./skill-updates.js";
import { app } from "./server-app.js";
import { viewerOf } from "./persistent-agent-status.js";
import { buildSkillCandidateFromUpload, buildUserSkillMarkdown, frontmatterFlagTrue, getUserSkillFile, librarySkillFiles, librarySkillFilesReader, librarySkillView, listSkills, skillExistsAnySource, skillRoomsByName, validateSkillWritePayload } from "./skills-library.js";

app.get("/api/skills", async (req) => {
	const roomsByName = skillRoomsByName(await viewerOf(req), req);
	const filesOf = librarySkillFilesReader();
	const updatesOf = skillUpdatesReader();
	return listSkills().map((skill) => librarySkillView(skill, roomsByName, filesOf(skill.name), updatesOf));
});

app.get("/api/skills/:id", async (req, reply) => {
	// The name exactly as the list gives it: a skill listed under its written name,
	// whose fitted name another holds, opens as itself, never as that other skill.
	const id = String((req.params as any).id ?? "");
	const skill = listSkills().find((s) => s.name === id);
	if (!skill) return reply.code(404).send({ error: `skill not found: ${id}` });
	// The detail view IS the review screen: attach the same trust-moment data an upload
	// candidate carries. Its files are the ones a room where it is on can open, so a
	// skill whose folder never opens to a room (see librarySkillFolderView) lists none.
	const read = librarySkillFiles(skill.name);
	return reply.send({ ...librarySkillView(skill, skillRoomsByName(await viewerOf(req), req), read), scanFindings: scanInvisibleUnicode(`${skill.body}\n${skill.description ?? ""}`).findings, files: read.files });
});

/** A skill past the size limit: a code and its real numbers, for the page's words. */
function tooBigAnswer(refusal: SkillTooBig) {
	return { error: new SkillTooBigError(refusal).message, code: SKILL_TOO_BIG, details: refusal };
}

/**
 * Which version of the person's skill `id` a review showed: its identity and its
 * files, so a skill changed or deleted and added again since then reads as another
 * version, even with the same files. Null when either can't be read.
 */
function skillVersionShown(id: string): string | null {
	const dir = path.join(agentSkillsDir(), id);
	const identity = readSkillIdentity(dir);
	const files = installedSkillFilesSha256(dir);
	return identity === "unreadable" || files === null ? null : `${identity ?? "none"}:${files}`;
}

/** A Replace whose review showed another version than the one there now (`skillVersionShown`): it would replace a skill the person didn't see. */
function replacesAnotherVersion(id: string, shown: unknown): boolean {
	return typeof shown === "string" && shown !== skillVersionShown(id);
}

function changedSinceReviewAnswer(id: string) {
	return { error: skillChangedSinceReviewLine(id), code: SKILL_CHANGED_SINCE_REVIEW, details: { name: id } };
}

/**
 * What the review of an incoming skill says of a skill of the person's own under
 * its name: that adding it replaces that one, which version of it (sent back with
 * Replace), and, when the two are written under different names (none written is
 * the "/" name), that it is a different skill, by the name that one is shown under.
 * Nothing when there is none.
 */
function replacesAnswer(id: string, incomingWritten: string | undefined): { replaces: true; replacesVersion?: string; replacesName?: string } | Record<string, never> {
	const found = getUserSkillFile(id);
	if (!found) return {};
	const existingWritten = found.manifest === null ? undefined : parseFrontmatter(found.manifest).fm.name?.trim();
	const existing = listSkills().find((skill) => skill.name === id);
	const existingName = (existingWritten || id) !== (incomingWritten?.trim() || id) ? existing?.displayName || existing?.name : undefined;
	const version = skillVersionShown(id);
	return { replaces: true, ...(version ? { replacesVersion: version } : {}), ...(existingName ? { replacesName: existingName } : {}) };
}

/** A name the library already holds where this way in can't replace it. */
function nameTakenAnswer(name: string) {
	return { error: skillNameTakenLine(name), code: SKILL_NAME_TAKEN, details: { name } };
}

// The file travels as base64 (4 bytes for every 3) inside a small JSON body.
app.post("/api/skills/upload", { bodyLimit: Math.ceil((SKILL_UPLOAD_MAX_BYTES * 4) / 3) + 64 * 1024 }, async (req, reply) => {
	const raw = (req.body ?? {}) as { filename?: unknown; contentBase64?: unknown };
	const filename = typeof raw.filename === "string" ? raw.filename : "";
	const contentBase64 = typeof raw.contentBase64 === "string" ? raw.contentBase64 : "";
	if (!contentBase64) return reply.code(400).send({ error: "no file content" });
	const buffer = Buffer.from(contentBase64, "base64");
	if (buffer.byteLength === 0) return reply.code(400).send({ error: "the file is empty or not valid base64" });
	let candidate: Awaited<ReturnType<typeof buildSkillCandidateFromUpload>>;
	try {
		candidate = await buildSkillCandidateFromUpload(filename, buffer);
	} catch (e) {
		if (e instanceof SkillTooBigError) return reply.code(413).send(tooBigAnswer(e.refusal));
		return reply.code(400).send({ error: (e as Error).message });
	}
	// A name the library holds: a skill of the person's own is replaced only after
	// they say so at the review; one exxperts does not own can't be, so it is
	// refused now, before the review.
	if (getUserSkillFile(candidate.id)) return reply.send({ ...candidate, ...replacesAnswer(candidate.id, candidate.writtenName) });
	if (skillExistsAnySource(candidate.id)) {
		if (candidate.token) removeCheckout(candidate.token);
		return reply.code(409).send(nameTakenAnswer(candidate.id));
	}
	return reply.send(candidate);
});

app.post("/api/skills/accept", async (req, reply) => {
	// Write a reviewed candidate to the library. Reuses the write validation, but records
	// the candidate's own provenance (source/license) instead of forcing "local". With
	// `replace`, a skill of that name in the person's own store is replaced whole,
	// keeping its identity, so the rooms that have it on keep it on.
	const raw = (req.body ?? {}) as Record<string, unknown>;
	const validation = validateSkillWritePayload(raw);
	if (!validation.ok) return reply.code(validation.code).send({ error: validation.error });
	const value = validation.value;
	const source = typeof raw.source === "string" && raw.source.trim() ? raw.source.trim() : "upload";
	const license = typeof raw.license === "string" && raw.license.trim() ? raw.license.trim() : null;
	const version = typeof raw.version === "string" ? raw.version : null;
	// An upload's written name goes back in its name line as it came, when it fits onto the id (`buildUserSkillMarkdown`).
	const writtenName = typeof raw.writtenName === "string" ? raw.writtenName : undefined;
	const acceptedManifest = buildUserSkillMarkdown({ ...value, writtenName, disableModelInvocation: raw.disableModelInvocation === true, version });
	const skillDir = path.join(agentSkillsDir(), value.id);
	const replacing = raw.replace === true ? getUserSkillFile(value.id) : null;
	if (!replacing && skillExistsAnySource(value.id)) return reply.code(409).send(nameTakenAnswer(value.id));
	// A zip upload retained its bundled files under a checkout token (see
	// buildSkillCandidateFromUpload): they are written beside the accepted SKILL.md.
	// Flow-bound: only a token minted by the UPLOAD endpoint vendors files here. A
	// repo/featured checkout token also resolves in the shared cache but points at a
	// whole repository clone; pairing one with a reviewed upload manifest would vendor
	// a tree the review screen never showed. A token that no longer names an upload
	// (expired, a restart, or spent by an accept whose answer was lost) is refused
	// before anything is written: the manifest alone would drop the files the person
	// reviewed, and as a Replace it would swap a whole skill for its SKILL.md.
	const uploadToken = typeof raw.token === "string" ? raw.token : "";
	const checkout = uploadToken ? getCheckout(uploadToken) : null;
	if (uploadToken && checkout?.source !== "upload") return reply.code(410).send({ error: "the uploaded file has expired; upload it again", code: SKILL_UPLOAD_GONE });
	const bundledFrom = checkout ? checkout.dir : null;
	// The limit holds for what is written: the SKILL.md rebuilt from the review (whose
	// description may have grown there) and the files the upload kept.
	const bundled = bundledFrom ? bundledTreeSize(bundledFrom) : { files: 0, bytes: 0 };
	const overLimit = skillOverLimit(1 + bundled.files, Buffer.byteLength(acceptedManifest) + bundled.bytes);
	if (overLimit) return reply.code(413).send(tooBigAnswer(overLimit));
	let bundledCopied = 0;
	const fill = (dir: string): void => {
		fs.writeFileSync(path.join(dir, "SKILL.md"), acceptedManifest, { mode: 0o600, flag: "wx" });
		if (bundledFrom) bundledCopied = copyBundledTree(bundledFrom, dir);
	};
	const provenance = (identity: string | null): SkillProvenance => ({ source, importedAt: new Date().toISOString(), license, sha256: sha256(acceptedManifest), ...(identity ? { identity } : {}) });
	if (replacing) {
		const identity = readSkillIdentity(skillDir);
		if (identity === "unreadable") return reply.code(409).send({ error: "the skill's import record can't be read", code: "skill-unreadable" });
		// Checked with nothing awaited before the write, so no other request can change the skill in between.
		if (replacesAnotherVersion(value.id, raw.replacesVersion)) return reply.code(409).send(changedSinceReviewAnswer(value.id));
		try {
			replaceSkillDir(value.id, (dir) => {
				fill(dir);
				writeSkillProvenance(dir, provenance(identity));
			});
		} catch (error) {
			// Rarely the old folder can't be put back either: it then waits beside the library for the next start, so the answer promises neither.
			req.log.warn({ err: error }, "replacing a skill failed");
			return reply.code(500).send({ error: SKILL_REPLACE_FAILED_LINE });
		}
	} else {
		const identity = reserveSkillIdentity(skillDir);
		fill(skillDir);
		// sha256 records the whole accepted SKILL.md (frontmatter + body).
		writeSkillProvenance(skillDir, provenance(identity));
	}
	// Consumed: an accept is the token's one purpose; a token that kept resolving
	// for its 15-minute TTL could vendor into later accepts.
	if (bundledFrom) removeCheckout(uploadToken);
	const created = listSkills().find((skill) => skill.name === value.id);
	const payload = created ? librarySkillView(created, skillRoomsByName(await viewerOf(req), req)) : { name: value.id, displayName: value.displayName, description: value.description, body: value.instructions, source: "user", protected: false, rooms: [], fileCount: 0, provenance: { source, license, importedAt: new Date().toISOString() }, license };
	return reply.code(replacing ? 200 : 201).send({ ...payload, bundledCopied });
});

/** Each plain file an upload retained, with its path below `fromDir`: the one walk the accept both measures and copies. */
function walkBundledTree(fromDir: string, visit: (from: string, rel: string) => void, rel = ""): void {
	for (const entry of fs.readdirSync(fromDir, { withFileTypes: true })) {
		if (entry.isSymbolicLink()) continue;
		const from = path.join(fromDir, entry.name);
		const childRel = rel ? path.join(rel, entry.name) : entry.name;
		if (entry.isDirectory()) walkBundledTree(from, visit, childRel);
		else if (entry.isFile()) visit(from, childRel);
	}
}

/** The count and bytes of an upload's retained files, as `copyBundledTree` would write them. */
function bundledTreeSize(fromDir: string): { files: number; bytes: number } {
	let files = 0;
	let bytes = 0;
	walkBundledTree(fromDir, (from) => {
		files += 1;
		bytes += fs.lstatSync(from).size;
	});
	return { files, bytes };
}

/** Copies an upload's retained files into a skill's folder, as plain files of their own, a script runnable as the upload marked it (`keptFileMode`); returns how many. */
function copyBundledTree(fromDir: string, toDir: string): number {
	let copied = 0;
	walkBundledTree(fromDir, (from, rel) => {
		const to = path.join(toDir, rel);
		fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
		fs.copyFileSync(from, to);
		const source = fileModeAndHead(from);
		fs.chmodSync(to, source ? keptFileMode(rel.split(path.sep).join("/"), source.mode, source.head) : 0o600);
		copied += 1;
	});
	return copied;
}

app.post("/api/skills", async (req, reply) => {
	const validation = validateSkillWritePayload(req.body ?? {});
	if (!validation.ok) return reply.code(validation.code).send({ error: validation.error });
	const value = validation.value;
	if (skillExistsAnySource(value.id)) return reply.code(409).send(nameTakenAnswer(value.id));

	const skillDir = path.join(agentSkillsDir(), value.id);
	const file = path.join(skillDir, "SKILL.md");
	const identity = reserveSkillIdentity(skillDir);
	const markdown = buildUserSkillMarkdown(value);
	fs.writeFileSync(file, markdown, { mode: 0o600, flag: "wx" });
	// Provenance sidecar: hand-written skills are source "local"; sha256 records the
	// whole SKILL.md.
	writeSkillProvenance(skillDir, { ...localSkillProvenance(markdown), identity });
	const created = listSkills().find((skill) => skill.name === value.id);
	return reply.code(201).send(created ? librarySkillView(created, skillRoomsByName(await viewerOf(req), req)) : { name: value.id, displayName: value.displayName, description: value.description, body: value.instructions, source: "user", protected: false, rooms: [], fileCount: 0, provenance: { source: "local", license: null, importedAt: new Date().toISOString() }, license: null });
});

app.put("/api/skills/:id", async (req, reply) => {
	// One of the person's own, by its folder: another spelling of that name finds it too.
	const id = fitSkillName(String((req.params as any).id ?? ""));
	const found = getUserSkillFile(id);
	if (!found || found.manifest === null) return reply.code(404).send({ error: `editable user skill not found: ${id}` });
	const { file } = found;
	// Grandfather the stored description: a body-only edit of a pre-existing skill whose
	// description already exceeds ≤1024 must not be blocked by that rule (spec fix). The
	// limit is still enforced the moment the description actually changes.
	const stored = parseFrontmatter(found.manifest).fm;
	const validation = validateSkillWritePayload(req.body ?? {}, id, { grandfatheredDescription: (stored.description || "").trim() });
	if (!validation.ok) return reply.code(validation.code).send({ error: validation.error });
	const value = validation.value;
	// The mark and the version are the author's: an edit keeps what the stored file says, whatever the body sends.
	const editedManifest = buildUserSkillMarkdown({ ...value, disableModelInvocation: frontmatterFlagTrue(stored["disable-model-invocation"]), version: skillVersion(found.manifest) });
	// Never through a link put there since the read above (`writeSkillFileText`);
	// any other failure, such as a read-only SKILL.md, is the real error.
	try {
		writeSkillFileText(path.dirname(file), "SKILL.md", editedManifest);
	} catch (error) {
		if (isNotPlainOrAbsent(error)) return reply.code(404).send({ error: `editable user skill not found: ${id}` });
		throw error;
	}
	// Refresh the sha256 over the whole SKILL.md. Origin (source/license/importedAt)
	// survives: a local edit of an imported skill must not erase where it came from.
	// So does its identity, so the rooms that have it on keep it on. A record
	// that can't be read stays as it is: a fresh one would give the skill another
	// identity, or none, and take it out of the wrong rooms.
	const identity = readSkillIdentity(path.dirname(file));
	if (identity !== "unreadable") {
		const existingProvenance = readSkillProvenance(path.dirname(file));
		writeSkillProvenance(path.dirname(file), { ...(existingProvenance ?? localSkillProvenance(editedManifest)), sha256: sha256(editedManifest), ...(identity ? { identity } : {}) });
	}
	const updated = listSkills().find((skill) => skill.name === id);
	return reply.send(updated ? librarySkillView(updated, skillRoomsByName(await viewerOf(req), req)) : { name: id, displayName: value.displayName, description: value.description, body: value.instructions, source: "user", protected: false, rooms: [], fileCount: 0, provenance: null, license: null });
});

app.delete("/api/skills/:id", async (req, reply) => {
	const id = fitSkillName(String((req.params as any).id ?? ""));
	const file = getUserSkillFile(id)?.file;
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
// Smokes need them, so they are gated behind an explicit env flag the smokes set
// (SKILLS_ALLOW_LOCAL_REPO, which the update check shares), rather than always-on.
// Default deny keeps the production endpoint URL-only.

installCheckoutCleanup();
// A Replace the last run stopped between its two renames: its skill goes back
// before any request can take that name for a new skill.
restoreCutReplaces(0);

app.post("/api/skills/repo/scan", async (req, reply) => {
	const source = String((req.body as any)?.source ?? "");
	const resolved = resolveRepoSource(source, { allowLocal: SKILLS_ALLOW_LOCAL_REPO });
	if (!resolved.ok) return reply.code(400).send({ error: resolved.error });
	let fetched: Awaited<ReturnType<typeof fetchRepoCheckout>>;
	try {
		fetched = await fetchRepoCheckout(resolved.value);
	} catch (err) {
		// One plain sentence for its cause; git's own text, which can name a temporary folder, stays in the log.
		const failure = repoFailureOf(err);
		req.log.warn(`could not fetch ${resolved.value.display}: ${failure.message}`);
		return reply.code(502).send({ error: repositoryFailedLine(failure, resolved.value.ref, "pasted") });
	}
	const token = registerCheckout(fetched.dir, resolved.value.display, fetched.origin);
	return reply.send({ token, source: resolved.value.display, skills: offeredRepoSkills(scanRepoSkills(fetched.dir, resolved.value.display)) });
});

app.post("/api/skills/repo/candidate", async (req, reply) => {
	const body = (req.body as any) ?? {};
	const checkout = getCheckout(String(body.token ?? ""));
	if (!checkout) return reply.code(404).send({ error: "repository checkout expired — rescan the URL" });
	let candidate: ReturnType<typeof readRepoCandidate>;
	try {
		candidate = readRepoCandidate(checkout.dir, String(body.path ?? ""), checkout.source);
	} catch (error) {
		if (error instanceof SkillTooBigError) return reply.code(413).send(tooBigAnswer(error.refusal));
		throw error;
	}
	if (!candidate) return reply.code(404).send({ error: "skill not found in the fetched repository" });
	// A skill of the person's own under that name: the review asks to replace it, as an upload's does.
	return reply.send({ ...candidate, ...replacesAnswer(candidate.id, candidate.writtenName) });
});

app.post("/api/skills/repo/import", async (req, reply) => {
	const body = (req.body as any) ?? {};
	const checkout = getCheckout(String(body.token ?? ""));
	if (!checkout) return reply.code(404).send({ error: "repository checkout expired — rescan the URL" });
	const skillPath = String(body.path ?? "");
	let candidate: ReturnType<typeof readRepoCandidate>;
	try {
		candidate = readRepoCandidate(checkout.dir, skillPath, checkout.source);
	} catch (error) {
		if (error instanceof SkillTooBigError) return reply.code(413).send(tooBigAnswer(error.refusal));
		throw error;
	}
	if (!candidate) return reply.code(404).send({ error: "skill not found in the fetched repository" });
	// The store folder is the written name fitted (`candidate.id`): the library names
	// a skill of the person's own by its folder, so delete, edit, switching on and an
	// update all find it there, while its files, SKILL.md included, are copied as they
	// came and the pages show its written name.
	const id = candidate.id;
	// A skill of the person's own under that name is replaced only once they said so
	// at the review (`replaces`), keeping its identity, so the rooms that have it on
	// keep it on; one exxperts does not own is refused, as before.
	const replacing = skillExistsAnySource(id) && body.replace === true && getUserSkillFile(id) !== null;
	if (skillExistsAnySource(id) && !replacing) return reply.code(409).send(nameTakenAnswer(id));
	const skillDir = path.join(agentSkillsDir(), id);
	// Replaced from the same repository, a skill keeps its Update automatically.
	const before = replacing ? readSkillProvenance(skillDir) : null;
	const keepsAutoUpdate = before?.autoUpdate === true && before.repository?.address === checkout.origin?.address;
	const folder = repoSkillFiles(checkout.dir, skillPath);
	if (!folder) return reply.code(404).send({ error: "skill not found in the fetched repository" });
	const repositoryPath = path.relative(checkout.dir, folder.dir).split(path.sep).join("/");
	let vendored: ReturnType<typeof vendorRepoSkill> | undefined;
	let provenance: SkillProvenance | undefined;
	// The record: the repository is the source; sha256 records the whole SKILL.md that
	// actually landed on disk, and the repository part the files that did.
	const fill = (dir: string, identity: string | null): void => {
		vendored = vendorRepoSkill(checkout.dir, skillPath, dir);
		const repository = repositoryRecord(checkout.origin, repositoryPath, dir);
		provenance = { source: checkout.source, importedAt: new Date().toISOString(), license: vendored.license, sha256: sha256(readSkillFileText(dir, "SKILL.md")), ...(identity ? { identity } : {}), ...repository, ...(keepsAutoUpdate && repository.repository && repository.repository.refKind !== "commit" ? { autoUpdate: true as const } : {}) };
		writeSkillProvenance(dir, provenance);
	};
	if (replacing) {
		const identity = readSkillIdentity(skillDir);
		if (identity === "unreadable") return reply.code(409).send({ error: "the skill's import record can't be read", code: "skill-unreadable" });
		if (replacesAnotherVersion(id, body.replacesVersion)) return reply.code(409).send(changedSinceReviewAnswer(id));
		try {
			replaceSkillDir(id, (dir) => fill(dir, identity));
		} catch (error) {
			if (error instanceof SkillTooBigError) return reply.code(413).send(tooBigAnswer(error.refusal));
			req.log.warn({ err: error }, "replacing a skill from its repository failed");
			return reply.code(500).send({ error: SKILL_REPLACE_FAILED_LINE });
		}
	} else {
		// Only clean up a dir THIS import created: never delete a pre-existing one on
		// a vendor failure (skillExistsAnySource gates on SKILL.md, so a bare leftover
		// dir could otherwise be removed out from under the user).
		const skillDirPreexisted = fs.existsSync(skillDir);
		try {
			fill(skillDir, reserveSkillIdentity(skillDir));
		} catch (err) {
			if (!skillDirPreexisted) fs.rmSync(skillDir, { recursive: true, force: true });
			if (err instanceof SkillTooBigError) return reply.code(413).send(tooBigAnswer(err.refusal));
			return reply.code(400).send({ error: `could not import skill: ${err instanceof Error ? err.message : String(err)}` });
		}
	}
	const created = listSkills().find((s) => s.name === id) ?? null;
	return reply.code(replacing ? 200 : 201).send({ skill: created ? librarySkillView(created, skillRoomsByName(await viewerOf(req), req)) : null, provenance, bundledCopied: vendored?.bundledCopied ?? 0 });
});

/** The repository part of a skill's record, from the checkout it was added from; none when the checkout's version is unknown. */
function repositoryRecord(origin: RepoOrigin | undefined, repositoryPath: string, skillDir: string): Pick<SkillProvenance, "repository"> {
	const filesSha256 = installedSkillFilesSha256(skillDir);
	if (!origin || !filesSha256) return {};
	return { repository: { address: origin.address, ...(origin.ref ? { ref: origin.ref } : {}), refKind: origin.refKind, path: repositoryPath, commit: origin.commit, filesSha256 } };
}

// --- Updates from a skill's repository (skill-updates.ts) ---------------------

app.post("/api/skills/updates/check", async (req, reply) => {
	// `quiet` is the page's own check, as it opens: without it, and without names, it is the person's check of the whole library.
	const raw = (req.body ?? {}) as { names?: unknown; quiet?: unknown };
	const quiet = raw.quiet === true;
	if (raw.quiet !== undefined && (typeof raw.quiet !== "boolean" || raw.names !== undefined)) return reply.code(400).send({ error: "quiet must be true or false, and goes without names" });
	const own = listSkills().filter((skill) => skill.source === "user" && !skill.unreadable).map((skill) => skill.name);
	if (raw.names !== undefined) {
		if (!Array.isArray(raw.names) || raw.names.some((name) => typeof name !== "string")) return reply.code(400).send({ error: "names must be a list of skill names" });
		const unknown = (raw.names as string[]).filter((name) => !own.includes(name));
		if (unknown.length > 0) return reply.code(400).send({ error: `unknown skill: ${unknown.join(", ")}`, code: "unknown-skill" });
		return reply.send(await checkSkillUpdates(raw.names as string[], { allowLocal: SKILLS_ALLOW_LOCAL_REPO }));
	}
	return reply.send(await checkSkillLibrary(own, { allowLocal: SKILLS_ALLOW_LOCAL_REPO, for: quiet ? "page" : "person" }));
});

type SkillUpdateParams = { id?: string };

app.post("/api/skills/:id/update", async (req, reply) => {
	const params = req.params as SkillUpdateParams;
	const id = fitSkillName(String(params.id ?? ""));
	const raw = (req.body ?? {}) as Record<string, unknown>;
	if (!getUserSkillFile(id)) return reply.code(404).send({ error: `skill not found: ${id}` });
	if (typeof raw.candidate !== "string" || typeof raw.installedFilesSha256 !== "string") return reply.code(400).send({ error: "candidate and installedFilesSha256 are required" });
	const confirm = raw.confirm && typeof raw.confirm === "object" ? (raw.confirm as Record<string, unknown>) : {};
	const request: SkillUpdateRequest = { candidate: raw.candidate, installedFilesSha256: raw.installedFilesSha256, confirm: { hiddenCharacters: confirm.hiddenCharacters === true, replaceMyChanges: confirm.replaceMyChanges === true } };
	// The viewer is asked before the update: from the checks of each try to its swap, nothing waits.
	const roomsByName = skillRoomsByName(await viewerOf(req), req);
	const outcome = await updateSkill(id, request, { allowLocal: SKILLS_ALLOW_LOCAL_REPO });
	if (!outcome.ok) {
		if (outcome.status === 413) return reply.code(413).send(tooBigAnswer(outcome.refusal));
		return reply.code(outcome.status).send({ error: outcome.error, ...("code" in outcome ? { code: outcome.code } : {}), ...("failure" in outcome ? { details: outcome.failure } : {}) });
	}
	const updated = listSkills().find((skill) => skill.name === id);
	return reply.send(updated ? librarySkillView(updated, roomsByName) : { name: id });
});

app.put("/api/skills/:id/auto-update", async (req, reply) => {
	const params = req.params as SkillUpdateParams;
	const id = fitSkillName(String(params.id ?? ""));
	const raw = (req.body ?? {}) as { on?: unknown };
	if (!getUserSkillFile(id)) return reply.code(404).send({ error: `skill not found: ${id}` });
	if (typeof raw.on !== "boolean") return reply.code(400).send({ error: "on must be true or false" });
	if (setSkillAutoUpdate(id, raw.on) === "unavailable") return reply.code(409).send({ error: "only a skill that follows a branch or a tag of its repository can update automatically", code: "auto-update-unavailable" });
	const saved = listSkills().find((skill) => skill.name === id);
	return reply.send(saved ? librarySkillView(saved, skillRoomsByName(await viewerOf(req), req)) : { name: id });
});

// The notice on Settings, Skills is closed for what it showed: each skill's name with the update's time and the left version's files' hash, so what came after it showed stays named.
app.post("/api/skills/updates/seen", async (req, reply) => {
	const raw = (req.body ?? {}) as { notices?: unknown };
	const optionalText = (value: unknown) => value === undefined || typeof value === "string";
	const valid = Array.isArray(raw.notices) && raw.notices.every((notice) => notice && typeof notice === "object" && typeof (notice as SkillNoticeShown).name === "string" && optionalText((notice as SkillNoticeShown).updatedAt) && optionalText((notice as SkillNoticeShown).skippedVersion));
	if (!valid) return reply.code(400).send({ error: "notices must be a list of { name, updatedAt?, skippedVersion? }" });
	closeSkillUpdateNotices((raw.notices as SkillNoticeShown[]).filter((notice) => isSkillId(notice.name)).map(({ name, updatedAt, skippedVersion }) => ({ name, updatedAt, skippedVersion })));
	return reply.send({ ok: true });
});

app.get("/api/skills/featured", async () => {
	const sources = resolveFeaturedSources();
	const results = await Promise.all(sources.map((entry) => loadFeaturedSource(entry)));
	return { sources: results };
});
