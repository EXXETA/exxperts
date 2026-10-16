import { classifyReferencePath, validateReferenceBuffer, validatedReferenceText, type ReferenceKind } from "./skills-file-policy.js";

export interface SkillFilePreviewData {
	path: string;
	kind: ReferenceKind;
	size: number;
	text?: string;
	mimeType?: string;
	base64?: string;
}

/** Human-only preview data. Creating it neither imports files nor exposes them to a room. */
export async function skillFilePreview(filePath: string, bytes: Buffer): Promise<SkillFilePreviewData> {
	const kind = classifyReferencePath(filePath);
	if (!kind) return { path: filePath, kind: "text", text: validatedReferenceText(bytes), size: bytes.length };
	const checked = await validateReferenceBuffer(filePath, bytes, { designRepo: true, allowedTypes: [kind], skillRoot: "", referenceRoots: [] });
	return { path: filePath, kind, size: bytes.length, ...(checked.preview !== undefined ? { text: checked.preview } : ["images", "pdf"].includes(kind) ? { mimeType: checked.mimeType, base64: bytes.toString("base64") } : {}) };
}
