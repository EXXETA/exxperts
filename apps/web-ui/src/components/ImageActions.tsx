import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { CheckIcon, CopyIcon, useCopiedFlag } from "./CopyButton";
import { copyPng, encodePng } from "../png-picture";

// Same origin: the session cookie rides the fetch as it rides the picture itself.
async function pngBlobOf(src: string): Promise<Blob> {
	const response = await fetch(src);
	if (!response.ok) throw new Error(`fetch ${response.status}`);
	const blob = await response.blob();
	if (blob.type === "image/png") return blob;
	const objectUrl = URL.createObjectURL(blob);
	try {
		return await encodePng(objectUrl);
	} finally {
		URL.revokeObjectURL(objectUrl);
	}
}

// Below this width the two buttons would cover the whole picture, so the
// cluster moves out above it (styles/14-answer-content.css, .is-narrow).
const NARROW_WIDTH = 80;

/**
 * Hover actions on a picture served by the room files route: copy the image
 * and download the file, in a cluster on the picture's top-right corner. Wraps
 * the picture's own control (`children`, the button that opens the viewer) in
 * a positioned host so the corner is the picture's, wherever the picture sits.
 * The action clicks stop at the cluster: they never reach the picture's click
 * or anything the row toggles. `name` is the shelf file name, given to the
 * download so the saved file keeps it.
 */
export function ImageActions({ src, name, children }: { src: string; name: string; children: ReactNode }) {
	const host = useRef<HTMLSpanElement>(null);
	const [narrow, setNarrow] = useState(false);
	const [copied, markCopied] = useCopiedFlag();
	useEffect(() => {
		const element = host.current;
		if (!element || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver((entries) => {
			const width = entries[0]?.contentRect.width ?? 0;
			setNarrow(width > 0 && width < NARROW_WIDTH);
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	const copyImage = useCallback((event: MouseEvent) => {
		event.stopPropagation();
		// No clipboard or a denied write: degrade quietly, as the text copy does.
		void copyPng(() => pngBlobOf(src)).then(markCopied).catch(() => {});
	}, [src, markCopied]);
	const stop = useCallback((event: MouseEvent) => event.stopPropagation(), []);
	// ?download=1 makes the route answer with content-disposition: attachment
	// (the viewer footer's download uses the same shape); the download
	// attribute names the file for a browser that ignores the header.
	const downloadHref = `${src}${src.includes("?") ? "&" : "?"}download=1`;
	return (
		<span ref={host} className={`image-actions-host${narrow ? " is-narrow" : ""}`}>
			{children}
			<span className={`image-actions${copied ? " is-copied" : ""}`}>
				<button
					type="button"
					className="message-copy image-action image-action-copy"
					onClick={copyImage}
					title={copied ? "Copied" : "Copy image"}
					aria-label={copied ? "Copied image" : "Copy image"}
				>
					{copied ? <CheckIcon /> : <CopyIcon />}
				</button>
				<a className="message-copy image-action image-action-download" href={downloadHref} download={name} onClick={stop} title="Download" aria-label="Download image">
					<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
						<path d="M8 2.5v8m0 0l-3-3m3 3l3-3" />
						<path d="M2.5 11v1.5A1.5 1.5 0 0 0 4 14h8a1.5 1.5 0 0 0 1.5-1.5V11" />
					</svg>
				</a>
			</span>
		</span>
	);
}
