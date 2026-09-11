import { useCallback, useEffect, useRef, useState } from "react";

// The copied acknowledgement every copy control shares: on for two seconds
// after markCopied, then off; a second copy restarts the clock and the timer
// dies with the component. Shared with the picture actions (ImageActions.tsx)
// so a copied picture is acknowledged exactly like copied text.
export function useCopiedFlag(): [copied: boolean, markCopied: () => void] {
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const markCopied = useCallback(() => {
		setCopied(true);
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(() => setCopied(false), 2000);
	}, []);
	useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
	return [copied, markCopied];
}

// Inline SVG rather than a font glyph: the unicode clipboard/check
// characters render as empty boxes in fonts that lack them.
export function CheckIcon() {
	return (
		<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<path d="M3.5 8.5l3 3 6-6.5" />
		</svg>
	);
}

export function CopyIcon() {
	return (
		<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
			<path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
		</svg>
	);
}

// Copy a piece of text to the clipboard. The button flips to a checkmark for
// a moment so the click is acknowledged without a toast. One control for the
// message action rows (Message.tsx) and the code-block corner (Markdown.tsx):
// the `.message-copy` class carries the shared ghost look, `className` the
// placement, `what` the noun the screen reader hears ("message", "code").
export function CopyButton({ text, className, what = "message" }: { text: string; className?: string; what?: string }) {
	const [copied, markCopied] = useCopiedFlag();
	const onCopy = useCallback(() => {
		// Optional chaining + catch: navigator.clipboard is undefined over plain
		// http on a LAN IP (not localhost), and a write can be denied; degrade
		// quietly (the button just does not flip) rather than throw.
		void navigator.clipboard?.writeText(text).then(markCopied).catch(() => {});
	}, [text, markCopied]);
	return (
		<button
			type="button"
			className={`message-copy${className ? ` ${className}` : ""}${copied ? " is-copied" : ""}`}
			onClick={onCopy}
			title={copied ? "Copied" : "Copy"}
			aria-label={copied ? "Copied to clipboard" : `Copy ${what}`}
		>
			{copied ? <CheckIcon /> : <CopyIcon />}
		</button>
	);
}
