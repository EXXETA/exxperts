import { useCallback } from "react";
import { CheckIcon, CopyIcon, useCopiedFlag } from "./CopyButton";
import { copyPng, svgPng } from "../png-picture";

// The tools a drawn figure in an answer carries (a diagram, a chart): small
// labelled buttons in the figure card's corner.

const icon = { viewBox: "0 0 16 16", width: 15, height: 15, fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

export function CodeIcon() {
	return <svg {...icon}><path d="M6 4.5L2.5 8 6 11.5M10 4.5L13.5 8 10 11.5" /></svg>;
}

export function ExpandIcon() {
	return <svg {...icon}><path d="M9.5 2.5h4v4M13.5 2.5L9 7M6.5 13.5h-4v-4M2.5 13.5L7 9" /></svg>;
}

export function BarsIcon() {
	return <svg {...icon}><path d="M2.5 13.5h11M4.5 11V8M8 11V4M11.5 11V6.5" /></svg>;
}

export function TableIcon() {
	return <svg {...icon}><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M2.5 6.5h11M2.5 10h11M7 6.5V13" /></svg>;
}

/** Copy image: the figure's SVG as a PNG on the card's own colour. `svg` finds it at the moment of the click. */
export function CopyImageButton({ svg }: { svg: () => SVGSVGElement | null | undefined }) {
	const [copied, markCopied] = useCopiedFlag();
	const onCopy = useCallback(() => {
		const element = svg();
		if (!element) return;
		const card = element.closest(".figure-card") ?? element;
		// No clipboard or a denied write: the button just does not flip.
		void copyPng(() => svgPng(element, getComputedStyle(card).backgroundColor)).then(markCopied).catch(() => {});
	}, [svg, markCopied]);
	return (
		<button type="button" className="figure-tool" onClick={onCopy} aria-label={copied ? "Copied image" : "Copy image"}>
			{copied ? <CheckIcon /> : <CopyIcon />}
			<span>{copied ? "Copied" : "Copy image"}</span>
		</button>
	);
}
