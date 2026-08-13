/**
 * Monochrome line icons for the room chrome.
 *
 * One family, one geometry: a 16 unit box, 1.5 stroke in currentColor, no
 * fill, round caps and joins. They inherit color from the button they sit in,
 * so hover and disabled states need no icon-specific rules, and they keep the
 * same optical weight beside each other in the top bar and the composer.
 */
import type { ReactNode } from "react";

function Icon({ size = 16, children }: { size?: number; children: ReactNode }) {
	return (
		<svg
			className="ui-icon"
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.5}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			focusable="false"
		>{children}</svg>
	);
}

export function TrashIcon({ size }: { size?: number } = {}) {
	return (
		<Icon size={size}>
			<path d="M2.6 4.4h10.8" />
			<path d="M6.2 4.4V3.2c0-.44.36-.8.8-.8h2c.44 0 .8.36.8.8v1.2" />
			<path d="M4.2 4.4l.55 8.5c.03.5.44.9.95.9h4.6c.51 0 .92-.4.95-.9l.55-8.5" />
			<path d="M6.7 7v4.3" />
			<path d="M9.3 7v4.3" />
		</Icon>
	);
}

export function GearIcon({ size }: { size?: number } = {}) {
	return (
		<Icon size={size}>
			<circle cx="8" cy="8" r="5.3" />
			<circle cx="8" cy="8" r="1.9" />
			<path d="M13.3 8h1.7" />
			<path d="M1 8h1.7" />
			<path d="M8 13.3V15" />
			<path d="M8 1v1.7" />
			<path d="M11.75 11.75l1.2 1.2" />
			<path d="M3.05 3.05l1.2 1.2" />
			<path d="M4.25 11.75l-1.2 1.2" />
			<path d="M12.95 3.05l-1.2 1.2" />
		</Icon>
	);
}

export function PaperclipIcon({ size }: { size?: number } = {}) {
	return (
		<Icon size={size}>
			<path d="M14.29 7.37l-6.13 6.13a4 4 0 0 1-5.66-5.66l6.13-6.13a2.67 2.67 0 0 1 3.77 3.77l-6.13 6.13a1.33 1.33 0 0 1-1.89-1.89l5.65-5.65" />
		</Icon>
	);
}

/**
 * The effort pill's glyph: a speedometer with its needle toward "more".
 *
 * It has to FILL the box like its siblings do. The earlier half-arc drew
 * across barely five of the sixteen units, so at pill size the glyph was a
 * four-pixel scratch that read as something clipped rather than as a dial.
 * This is a near-complete ring left open at the bottom, spanning about eleven
 * units, with a needle and a round-capped pivot dot at its centre.
 */
export function GaugeIcon({ size = 14 }: { size?: number } = {}) {
	return (
		<Icon size={size}>
			<path d="M3.4 13.1a6.5 6.5 0 1 1 9.2 0" />
			<path d="M8 8.5l3-3" />
			<path d="M8 8.5h0" />
		</Icon>
	);
}

/** Opens the menu beside a split button. */
export function ChevronDownIcon({ size = 14 }: { size?: number } = {}) {
	return (
		<Icon size={size}>
			<path d="M4.2 6.4L8 10.2l3.8-3.8" />
		</Icon>
	);
}
