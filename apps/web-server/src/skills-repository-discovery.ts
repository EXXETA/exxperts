import path from "node:path";
import { reportRepositoryProgress } from "./skills-repository-progress.js";
import { REFERENCE_KINDS, REFERENCE_PACKAGE_MAX_FILES, normalizeRepoPath, referencePathPermission, type ReferenceKind } from "./skills-file-policy.js";
import { repositoryTextReferences } from "./skills-markdown-references.js";
import { assertRepositoryBudget, fetchRepoCandidate, readRepositoryMaterial, repositoryScanFromToken, RepositoryBudgetError, RepositoryFetchError, withRepositoryBudget, type RepositoryFileEntry } from "./skills-repo-fetch.js";

export interface RepositoryMaterialSuggestion extends RepositoryFileEntry {
	skillPaths: string[];
	selected: boolean;
}

export interface RepositoryMaterialDiscovery {
	token: string;
	source: string;
	revision: string;
	referenced: RepositoryMaterialSuggestion[];
	additional: RepositoryMaterialSuggestion[];
	formats: Array<{ kind: ReferenceKind; total: number; referenced: number; additional: number; enabled: boolean }>;
	missing: Array<{ path: string; from: string; skillPath: string }>;
	excludedCounts: Record<string, number>;
	warnings: string[];
	incomplete: boolean;
}

const TEXT_DEPENDENCIES = new Set<ReferenceKind>(["markdown", "text", "styles", "html", "svg"]);
const MAX_INSPECTED_FILES = 2000;
const MAX_INSPECTED_BYTES = 128 * 1024 * 1024;

/** Proposals only: discovery never imports files, broadens policy, or enables room access. */
export function discoverRepositoryMaterials(token: string, selectedSkillPaths: string[]): Promise<RepositoryMaterialDiscovery> {
	return withRepositoryBudget(async () => {
		const scan = repositoryScanFromToken(token);
		if (!Array.isArray(selectedSkillPaths) || selectedSkillPaths.length > 500 || new Set(selectedSkillPaths).size !== selectedSkillPaths.length) throw new Error("invalid discovery skill selection");
		const selected = selectedSkillPaths.map((entry) => normalizeRepoPath(entry, true));
		if (selected.some((entry) => !scan.skills.some((skill) => skill.path === entry))) throw new Error("selected skill is not in this repository snapshot");
		const files = new Map(scan.files.map((file) => [file.path, file]));
		const repositoryPaths = new Set(files.keys());
		const folders = new Map<string, RepositoryFileEntry[]>();
		const available = new Map<string, RepositoryFileEntry>();
		for (const file of scan.files) {
			let directory = path.posix.dirname(file.path);
			while (directory !== ".") {
				const children = folders.get(directory) ?? [];
				children.push(file);
				folders.set(directory, children);
				directory = path.posix.dirname(directory);
			}
			const permission = referencePathPermission(file.path, { designRepo: true, allowedTypes: [...REFERENCE_KINDS], skillRoot: "", referenceRoots: [""] });
			if (permission.allowed && file.reason !== "symlink, submodule or special entry" && file.path.split("/").at(-1)?.toLowerCase() !== "skill.md") available.set(file.path, file);
		}
		const referenced = new Map<string, { file: RepositoryFileEntry; skillPaths: Set<string> }>();
		const missing = new Map<string, { path: string; from: string; skillPath: string }>();
		const queue: Array<{ path: string; skillPath: string }> = [];
		const visited = new Set<string>();
		const parsed = new Map<string, string[]>();
		const warnings = new Set<string>();
		let inspectedFiles = 0;
		let inspectedBytes = 0;
		let incomplete = false;

		function addFile(file: RepositoryFileEntry, skillPath: string): void {
			let entry = referenced.get(file.path);
			if (!entry) {
				const reason = file.path.split("/").at(-1)?.toLowerCase() === "skill.md" ? "skill manifests are separate instructions" : !available.has(file.path) ? file.reason ?? "program, archive or unsupported file type" : file.reason;
				entry = { file: { ...file, allowed: file.allowed && available.has(file.path), ...(reason ? { reason } : {}) }, skillPaths: new Set() };
				referenced.set(file.path, entry);
			}
			if (entry.skillPaths.has(skillPath)) return;
			entry.skillPaths.add(skillPath);
			if (entry.file.allowed && entry.file.kind && TEXT_DEPENDENCIES.has(entry.file.kind)) queue.push({ path: file.path, skillPath });
		}

		function addTarget(target: string, from: string, skillPath: string): void {
			const file = files.get(target);
			if (file) addFile(file, skillPath);
			else if (folders.has(target)) for (const child of folders.get(target)!) addFile(child, skillPath);
			else missing.set(`${skillPath}\0${from}\0${target}`, { path: target, from, skillPath });
		}

		for (const skillPath of selected) {
			reportRepositoryProgress("Inspecting skill links", selected.indexOf(skillPath), selected.length);
			const candidate = await fetchRepoCandidate(token, skillPath, []);
			const from = skillPath ? `${skillPath}/SKILL.md` : "SKILL.md";
			for (const target of repositoryTextReferences(candidate.manifest, from, "markdown", repositoryPaths)) addTarget(target, from, skillPath);
		}
		for (let offset = 0; offset < queue.length; offset += 1) {
			reportRepositoryProgress("Checking discovered reference links", offset, queue.length);
			assertRepositoryBudget();
			const item = queue[offset];
			const visit = `${item.skillPath}\0${item.path}`;
			if (visited.has(visit)) continue;
			visited.add(visit);
			let links = parsed.get(item.path);
			if (!links) {
				if (inspectedFiles >= MAX_INSPECTED_FILES || inspectedBytes >= MAX_INSPECTED_BYTES) {
					incomplete = true;
					warnings.add("Reference discovery reached its 2,000-file or 128 MiB inspection limit. Narrow the selection to inspect further dependencies.");
					continue;
				}
				try {
					const material = await readRepositoryMaterial(token, item.path);
					inspectedFiles += 1;
					inspectedBytes += material.bytes.length;
					if (inspectedBytes > MAX_INSPECTED_BYTES) {
						incomplete = true;
						warnings.add("Reference discovery reached its 128 MiB inspection limit. Narrow the selection to inspect further dependencies.");
						continue;
					}
					links = repositoryTextReferences(material.preview ?? "", item.path, material.kind, repositoryPaths);
					parsed.set(item.path, links);
				} catch (error) {
					if (error instanceof RepositoryBudgetError || error instanceof RepositoryFetchError || (error as { code?: string }).code === "REPOSITORY_SNAPSHOT_EXPIRED") throw error;
					const reason = error instanceof Error ? error.message : String(error);
					const entry = referenced.get(item.path)!;
					entry.file = { ...entry.file, allowed: false, reason };
					parsed.set(item.path, []);
					warnings.add(`Could not inspect ${item.path}: ${reason}`);
					incomplete = true;
					continue;
				}
			}
			for (const target of links) addTarget(target, item.path, item.skillPath);
		}
		if (referenced.size > MAX_INSPECTED_FILES) warnings.add(`${referenced.size} referenced paths were found. A source material version can contain at most 2,000 files; narrow the selection before importing.`);
		reportRepositoryProgress("Linked references checked", queue.length, queue.length);
		const primary = [...referenced.values()].map(({ file, skillPaths }) => ({ ...file, skillPaths: [...skillPaths].sort(), selected: file.allowed })).sort((a, b) => a.path.localeCompare(b.path));
		for (const skillPath of selected) {
			const count = primary.filter((file) => file.allowed && file.skillPaths.includes(skillPath)).length;
			if (count >= REFERENCE_PACKAGE_MAX_FILES) warnings.add(`${count} references are associated with ${skillPath || "the root skill"}. A skill package can include at most 499 references; adjust its selection or keep extra files as source materials only.`);
		}
		const additional = [...available.values()].filter((file) => !referenced.has(file.path)).map((file) => ({ ...file, skillPaths: [], selected: false })).sort((a, b) => a.path.localeCompare(b.path));
		const formats = REFERENCE_KINDS.map((kind) => ({ kind, total: [...available.values()].filter((file) => file.kind === kind).length, referenced: primary.filter((file) => available.has(file.path) && file.kind === kind).length, additional: additional.filter((file) => file.kind === kind).length, enabled: scan.policy.allowedTypes.includes(kind) })).filter((format) => format.total > 0);
		const excludedCounts: Record<string, number> = {};
		for (const file of scan.files) {
			const reference = referenced.get(file.path)?.file;
			if (reference?.allowed || (file.allowed && available.has(file.path))) continue;
			const reason = reference?.reason ?? (file.path.split("/").at(-1)?.toLowerCase() === "skill.md" ? "skill manifests are separate instructions" : file.reason ?? "program, archive or unsupported file type");
			excludedCounts[reason] = (excludedCounts[reason] ?? 0) + 1;
		}
		return { token, source: scan.source, revision: scan.revision, referenced: primary, additional, formats, missing: [...missing.values()].sort((a, b) => a.path.localeCompare(b.path)), excludedCounts, warnings: [...warnings], incomplete };
	});
}
