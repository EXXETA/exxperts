import crypto from "node:crypto";
import path from "node:path";
import { fileTypeFromBuffer } from "file-type";
import JSZip from "jszip";

export const REFERENCE_KINDS = ["markdown", "text", "styles", "html", "svg", "pdf", "word", "excel", "images", "fonts"] as const;
export type ReferenceKind = typeof REFERENCE_KINDS[number];
export interface RepositoryFilePolicy {
	designRepo: boolean;
	allowedTypes: ReferenceKind[];
	skillRoot: string;
	referenceRoots: string[];
}
export interface RepoReference {
	path: string;
	localPath: string;
	kind: ReferenceKind;
	size: number;
	sha256: string;
}
export const REFERENCE_TEXT_MAX_BYTES = 512 * 1024;
export const REFERENCE_ASSET_MAX_BYTES = 25 * 1024 * 1024;
export const REFERENCE_PACKAGE_MAX_BYTES = 64 * 1024 * 1024;
export const REFERENCE_PACKAGE_MAX_FILES = 500;
export const SHARED_REFERENCES_DIR = ".skill-references";

const EXTENSIONS: Record<string, ReferenceKind> = {
	".md": "markdown", ".txt": "text", ".json": "text", ".css": "styles", ".scss": "styles", ".html": "html", ".htm": "html", ".svg": "svg",
	".pdf": "pdf", ".docx": "word", ".xlsx": "excel", ".png": "images", ".jpg": "images", ".jpeg": "images", ".gif": "images", ".webp": "images",
	".woff": "fonts", ".woff2": "fonts", ".ttf": "fonts", ".otf": "fonts",
};
const TEXT_KINDS = new Set<ReferenceKind>(["markdown", "text", "styles", "html", "svg"]);

/** Paths are portable package names, never host filesystem paths. */
export function normalizeRepoPath(raw: unknown, allowEmpty = false): string {
	if (typeof raw !== "string") throw new Error("repository path must be text");
	if (allowEmpty && (raw === "" || raw === ".")) return "";
	if (!raw || raw.startsWith("/") || raw.includes("\\") || /[\x00-\x1f\x7f<>:"|?*]/.test(raw)) throw new Error("invalid repository path");
	const parts = raw.replace(/\/+$/, "").split("/");
	if (parts.some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || part.toLowerCase() === ".git")) {
		throw new Error("repository path is unsafe on supported platforms");
	}
	return parts.join("/");
}

export function normalizeRepositoryFilePolicy(raw: unknown = {}): RepositoryFilePolicy {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid repository file policy");
	const value = raw as Record<string, unknown>;
	if (value.designRepo !== undefined && typeof value.designRepo !== "boolean") throw new Error("designRepo must be a boolean");
	const designRepo = value.designRepo === true;
	const kinds = value.allowedTypes ?? ["markdown"];
	if (!Array.isArray(kinds) || kinds.some((kind) => !REFERENCE_KINDS.includes(kind as ReferenceKind))) throw new Error("unsupported reference type");
	if (!designRepo && kinds.some((kind) => kind !== "markdown")) throw new Error("additional reference types require a design repository");
	const roots = value.referenceRoots ?? [];
	if (!Array.isArray(roots) || roots.length > 50) throw new Error("invalid reference directories");
	return {
		designRepo,
		allowedTypes: REFERENCE_KINDS.filter((kind) => kinds.includes(kind)),
		skillRoot: normalizeRepoPath(value.skillRoot ?? "", true),
		referenceRoots: Array.from(new Set(roots.map((root) => normalizeRepoPath(root, true)))).sort(),
	};
}

export function classifyReferencePath(repoPath: string): ReferenceKind | null {
	return EXTENSIONS[path.posix.extname(repoPath).toLowerCase()] ?? null;
}

export function referencePathPermission(repoPath: string, policy: RepositoryFilePolicy): { kind: ReferenceKind | null; allowed: boolean; reason?: string } {
	const kind = classifyReferencePath(repoPath);
	try { normalizeRepoPath(repoPath); } catch { return { kind, allowed: false, reason: "unsafe repository path" }; }
	if (repoPath.split("/").some((part) => part.toLowerCase() === "provenance.json" || part.toLowerCase() === SHARED_REFERENCES_DIR)) return { kind, allowed: false, reason: "reserved package path" };
	if (!kind) return { kind, allowed: false, reason: "program, archive or unsupported file type" };
	if (!policy.allowedTypes.includes(kind) || (kind !== "markdown" && !policy.designRepo)) return { kind, allowed: false, reason: "file type was not enabled for this repository" };
	return { kind, allowed: true };
}

export function repositoryPathWithin(repoPath: string, root: string): boolean {
	return root === "" || repoPath.startsWith(`${root}/`);
}

export function referenceLocalPath(repoPath: string, skillPath: string): string {
	return repositoryPathWithin(repoPath, skillPath) ? (skillPath ? repoPath.slice(skillPath.length + 1) : repoPath) : `${SHARED_REFERENCES_DIR}/${repoPath}`;
}

export function referenceBytesSha256(bytes: Buffer): string {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function validatedReferenceText(bytes: Buffer): string {
	if (bytes.length > REFERENCE_TEXT_MAX_BYTES) throw new Error("text reference exceeds the 512 KiB limit");
	let text: string;
	try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new Error("reference is not valid UTF-8 text"); }
	if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw new Error("reference contains binary or control bytes");
	if (/^version https:\/\/git-lfs.github.com\/spec\/v1(?:\r?\n|$)/.test(text)) throw new Error("Git LFS references are not downloaded; use a normal committed file");
	if (/^%PDF-|^PK\x03\x04|^MZ/.test(text)) throw new Error("binary file does not match its text extension");
	return text;
}

/** Count actual decompressed bytes, keeping only the small content-type table. */
function inspectOfficeEntry(entry: JSZip.JSZipObject, maxBytes: number, keepBytes: boolean): Promise<{ size: number; bytes: Buffer }> {
	return new Promise((resolve, reject) => {
		let size = 0;
		let aborted = false;
		const chunks: Buffer[] = [];
		const stream = entry.nodeStream();
		stream.on("data", (chunk: Buffer) => {
			if (aborted) return;
			size += chunk.length;
			if (size > maxBytes) {
				aborted = true;
				stream.pause();
				(stream as unknown as { destroy?: () => void }).destroy?.();
				reject(new Error("Office reference exceeds its decompressed document limit"));
				return;
			}
			if (keepBytes) chunks.push(chunk);
		});
		stream.on("error", (error: Error) => { if (!aborted) reject(new Error(`Office archive could not be validated: ${error.message}`)); });
		stream.on("end", () => { if (!aborted) resolve({ size, bytes: Buffer.concat(chunks) }); });
	});
}

/** Validate bytes as inert data; no URLs, scripts, font installation or rendering are followed. */
export async function validateReferenceBuffer(repoPath: string, bytes: Buffer, policy: RepositoryFilePolicy): Promise<{ kind: ReferenceKind; mimeType: string; preview?: string }> {
	const permission = referencePathPermission(repoPath, policy);
	if (!permission.allowed || !permission.kind) throw new Error(permission.reason ?? "reference type is not permitted");
	const kind = permission.kind;
	if (TEXT_KINDS.has(kind)) {
		const text = validatedReferenceText(bytes);
		if (path.posix.extname(repoPath).toLowerCase() === ".json") {
			try { JSON.parse(text); } catch { throw new Error("JSON reference is not valid JSON data"); }
		}
		if (kind === "svg" && !/<svg(?:\s|>)/i.test(text)) throw new Error("SVG reference has no SVG root");
		return { kind, mimeType: kind === "svg" ? "image/svg+xml" : "text/plain", preview: text };
	}
	if (bytes.length > REFERENCE_ASSET_MAX_BYTES) throw new Error("design asset exceeds the 25 MiB limit");
	const ext = path.posix.extname(repoPath).toLowerCase();
	if (kind === "word" || kind === "excel") {
		let zip: JSZip;
		try { zip = await JSZip.loadAsync(bytes); } catch { throw new Error("Office reference is not a valid document archive"); }
		const files = Object.values(zip.files);
		const required = kind === "word" ? "word/document.xml" : "xl/workbook.xml";
		if (!zip.file(required) || !zip.file("[Content_Types].xml")) throw new Error("Office reference does not match its file type");
		if (files.length > 5000 || files.some((file) => /vba|(?:^|\/)embeddings\/|\.(?:exe|dll|js|ts|ps1|bat|cmd|sh|py)$/i.test(file.name))) throw new Error("Office reference contains macros, embedded programs or too many entries");
		let expanded = 0;
		let typesXml = "";
		for (const file of files) {
			if (file.dir) continue;
			const isTypes = file.name === "[Content_Types].xml";
			const result = await inspectOfficeEntry(file, Math.min(REFERENCE_PACKAGE_MAX_BYTES - expanded, isTypes ? REFERENCE_TEXT_MAX_BYTES : REFERENCE_PACKAGE_MAX_BYTES), isTypes);
			expanded += result.size;
			if (isTypes) typesXml = validatedReferenceText(result.bytes);
		}
		for (const declaration of typesXml.matchAll(/<(?:\w+:)?(?:Override|Default)\b[^>]*>/gi)) {
			const part = declaration[0].match(/\bPartName\s*=\s*['"]([^'"]+)['"]/i)?.[1];
			const extension = declaration[0].match(/\bExtension\s*=\s*['"]([^'"]+)['"]/i)?.[1];
			const contentType = declaration[0].match(/\bContentType\s*=\s*['"]([^'"]+)['"]/i)?.[1] ?? "";
			const applies = part ? !!zip.file(part.replace(/^\//, "")) : !!extension && files.some((file) => file.name.toLowerCase().endsWith(`.${extension.toLowerCase()}`));
			if (applies && /macroEnabled|vbaProject/i.test(contentType)) throw new Error("macro-enabled Office documents are not permitted");
		}
		return { kind, mimeType: kind === "word" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
	}
	const expected: Record<string, string[]> = {
		".pdf": ["application/pdf"], ".png": ["image/png"], ".jpg": ["image/jpeg"], ".jpeg": ["image/jpeg"], ".gif": ["image/gif"], ".webp": ["image/webp"],
		".woff": ["font/woff", "application/font-woff"], ".woff2": ["font/woff2"], ".ttf": ["font/ttf", "application/x-font-ttf"], ".otf": ["font/otf", "application/x-font-opentype"],
	};
	let detected;
	try { detected = await fileTypeFromBuffer(bytes); } catch { throw new Error("design asset has an invalid signature"); }
	if (!detected || !expected[ext]?.includes(detected.mime)) throw new Error("design asset bytes do not match its file extension");
	return { kind, mimeType: detected.mime };
}
