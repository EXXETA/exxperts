

// A composer-staged attachment (files UI slice): already uploaded to the shelf
// and parsed, waiting to ride the next message. The chip is the visible proof
// the drop worked and carries the HONEST parse state before the user commits.
type StagedAttachment = {
	/** The allocated shelf name (collision rule already applied). Empty while uploading. */
	name: string;
	/** Chip key while the upload is in flight (the name is not known yet). */
	stageId: string;
	bytes: number;
	extension: string;
	status: "uploading" | "ready" | "failed";
	/** "34 pages" · "image · stored…" · a parse-failure reason. */
	parseNote: string;
	pages?: number;
	/**
	 * A local object URL of the picture, set only for images: the composer
	 * shows a staged picture AS a picture, before the upload has even landed.
	 * Owned by the entry — every path that drops the entry revokes it
	 * (releaseStaged), or the blob stays pinned in memory for the page's life.
	 * A picture back in the box after a refusal shows the room's own copy.
	 */
	previewUrl?: string;
};

// The extensions the composer previews as a thumbnail tile (the same set the
// bubble thumbnails use), for a file whose mime type the browser left blank.
const STAGED_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
// Files whose bytes are the text the model reads, for the estimate of a message's size.
const TEXT_FILE_EXTENSIONS: ReadonlySet<string> = new Set([".txt", ".md", ".csv", ".tsv", ".json", ".jsonl", ".log", ".xml", ".html", ".htm", ".yaml", ".yml"]);
/** A sent message as the failure line weighs it: the typed text and the files it carried. */
type SentMessage = { text: string; attachments?: ReadonlyArray<{ bytes: number; extension: string }> };

/** Free the preview object URLs of entries leaving the staged row. */
function releaseStaged(entries: readonly StagedAttachment[]): void {
	for (const entry of entries) if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
}

export { STAGED_IMAGE_EXTENSIONS, TEXT_FILE_EXTENSIONS, releaseStaged };
export type { SentMessage, StagedAttachment };
