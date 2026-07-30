import { apiFetch, fetchJson } from "./api";

/**
 * Room files API (files UI slice) — the shelf's HTTP face for the panel and
 * the composer. Uploads ride base64 JSON like the skills upload (no multipart
 * anywhere in the app).
 */

export interface RoomShelfFile {
	name: string;
	bytes: number;
	mtimeMs: number;
	origin: "room" | "user";
	madeAt?: string;
	pages: number | null;
	extension: string;
}

export interface RoomFileUploadResult {
	name: string;
	bytes: number;
	kind: "text" | "pdf" | "docx" | "image";
	extension: string;
	pages?: number;
	parseNote?: string;
}

export async function listRoomFiles(roomId: string): Promise<RoomShelfFile[]> {
	const data = await fetchJson<{ files: RoomShelfFile[] }>(`/api/persistent-agents/${encodeURIComponent(roomId)}/files`);
	return data.files;
}

export function uploadRoomFile(roomId: string, filename: string, contentBase64: string): Promise<RoomFileUploadResult> {
	return fetchJson<RoomFileUploadResult>(`/api/persistent-agents/${encodeURIComponent(roomId)}/files`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ filename, contentBase64 }),
	});
}

// Unified delete (files-management slice): ONE delete path with one semantics.
// Stage opens the undo window (the file leaves shelf, panel, and manifest at
// once); undo brings it back (the server may return a collision-rule name if
// the old one was retaken); commit makes the bytes and reading cache go — the
// toast expiry calls it, the staging chip's ✕ calls it immediately.
export async function stageRoomFileDelete(roomId: string, name: string): Promise<string> {
	const data = await fetchJson<{ ok: true; token: string }>(`/api/persistent-agents/${encodeURIComponent(roomId)}/files/${encodeURIComponent(name)}/delete`, { method: "POST" });
	return data.token;
}

export async function undoRoomFileDelete(roomId: string, name: string, token: string): Promise<string> {
	const data = await fetchJson<{ name: string }>(`/api/persistent-agents/${encodeURIComponent(roomId)}/files/${encodeURIComponent(name)}/delete/undo`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ token }),
	});
	return data.name;
}

export async function commitRoomFileDelete(roomId: string, name: string, token: string): Promise<void> {
	await fetchJson<{ ok: true }>(`/api/persistent-agents/${encodeURIComponent(roomId)}/files/${encodeURIComponent(name)}/delete/commit`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ token }),
	});
}

/** Inline rename: returns the final shelf name (the collision rule may have stepped in) and whether it did. */
export async function renameRoomFile(roomId: string, name: string, newName: string): Promise<{ name: string; collided: boolean; unchanged: boolean }> {
	return fetchJson<{ name: string; collided: boolean; unchanged: boolean }>(`/api/persistent-agents/${encodeURIComponent(roomId)}/files/${encodeURIComponent(name)}/rename`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ newName }),
	});
}

export function roomFileUrl(roomId: string, name: string, options: { download?: boolean } = {}): string {
	return `/api/persistent-agents/${encodeURIComponent(roomId)}/files/${encodeURIComponent(name)}${options.download ? "?download=1" : ""}`;
}

/** 💾 Save… — export a snapshot into the folder the native chooser returned, under the name the user chose in the dialog. 409 with code "exists" signals the collision dialog. */
export async function saveRoomFileToFolder(roomId: string, name: string, targetDir: string, resolution?: "overwrite" | "rename", saveAs?: string): Promise<{ savedTo: string } | { conflict: true }> {
	const res = await apiFetch(`/api/persistent-agents/${encodeURIComponent(roomId)}/files/${encodeURIComponent(name)}/save`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-Exxperts-Local-Action": "save-file" },
		body: JSON.stringify({
			targetDir,
			...(saveAs ? { saveAs } : {}),
			...(resolution === "overwrite" ? { overwrite: true } : {}),
			...(resolution === "rename" ? { rename: true } : {}),
		}),
	});
	const data = (await res.json().catch(() => ({}))) as { savedTo?: string; error?: string; code?: string };
	if (res.status === 409 && data?.code === "exists") return { conflict: true };
	if (!res.ok || !data.savedTo) throw new Error(data?.error || `Save failed (${res.status})`);
	return { savedTo: data.savedTo };
}

/** Chunked base64 reader (skills-api pattern — String.fromCharCode over the whole buffer overflows the arg limit). */
export async function fileToBase64(file: File): Promise<string> {
	const bytes = new Uint8Array(await file.arrayBuffer());
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}
