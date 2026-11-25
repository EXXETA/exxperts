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

/** The one spinner: a quarter arc turning on a faint track, drawn as SVG. */
export function SpinnerIcon({ size = 14 }: { size?: number } = {}) {
	return (
		<svg className="ui-icon ui-spinner" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden="true" focusable="false">
			<circle cx="8" cy="8" r="6" opacity="0.25" />
			<path d="M8 2a6 6 0 0 1 6 6" />
		</svg>
	);
}


/** Back: a viewer to the Attachments it opened from, the gallery to the panel. */
export function BackArrowIcon({ size = 16 }: { size?: number } = {}) {
	return (
		<svg className="ui-icon" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
			<path d="M13 8H3M7 4 3 8l4 4" />
		</svg>
	);
}

/** Close: dialogs, panes and removable rows. */
export function CloseIcon({ size = 16 }: { size?: number } = {}) {
	return (
		<Icon size={size}>
			<path d="M4 4l8 8" />
			<path d="M12 4l-8 8" />
		</Icon>
	);
}

/** Rename, and edit the newest message. */
export function PencilIcon({ size = 14 }: { size?: number } = {}) {
	return (
		<Icon size={size}>
			<path d="M10.6 2.6l2.8 2.8-7.9 7.9H2.7v-2.8z" />
			<path d="M9.2 4l2.8 2.8" />
		</Icon>
	);
}

/** Download a copy. */
export function DownloadIcon({ size = 14 }: { size?: number } = {}) {
	return (
		<Icon size={size}>
			<path d="M8 2.4v8" />
			<path d="M4.8 7.4L8 10.6l3.2-3.2" />
			<path d="M2.8 13.4h10.4" />
		</Icon>
	);
}

/** Save a copy into a folder the person picks: the save disk, beside Download. */
export function SaveIcon({ size = 14 }: { size?: number } = {}) {
	return (
		<Icon size={size}>
			<path d="M2.8 2.8h8.2l2.2 2.2v8.2H2.8z" />
			<path d="M5.4 2.8v3h4.6v-3" />
			<path d="M5.2 13.2V9.6h5.6v3.6" />
		</Icon>
	);
}

export function FolderIcon({ size = 16 }: { size?: number } = {}) {
	return (
		<Icon size={size}>
			<path d="M2 4.5c0-.83.67-1.5 1.5-1.5h2.6l1.5 1.6h4.9c.83 0 1.5.67 1.5 1.5v5.4c0 .83-.67 1.5-1.5 1.5h-9c-.83 0-1.5-.67-1.5-1.5z" />
		</Icon>
	);
}

export function GlobeIcon({ size = 16 }: { size?: number } = {}) {
	return (
		<Icon size={size}>
			<circle cx="8" cy="8" r="6" />
			<path d="M2 8h12" />
			<path d="M8 2c1.7 1.7 2.5 3.7 2.5 6S9.7 12.3 8 14C6.3 12.3 5.5 10.3 5.5 8S6.3 3.7 8 2z" />
		</Icon>
	);
}

export function PlusIcon({ size = 14 }: { size?: number } = {}) {
	return (
		<Icon size={size}>
			<path d="M8 3v10M3 8h10" />
		</Icon>
	);
}

export function CheckIcon({ size = 14 }: { size?: number } = {}) {
	return (
		<Icon size={size}>
			<path d="M3.5 8.5l3 3 6-7" />
		</Icon>
	);
}

export function ScreenIcon({ size = 16 }: { size?: number } = {}) {
	return (
		<Icon size={size}>
			<rect x="1.8" y="2.5" width="12.4" height="8.5" rx="1.2" />
			<path d="M8 11v2.5M5.5 13.5h5" />
		</Icon>
	);
}

export function SunIcon({ size = 16 }: { size?: number } = {}) {
	return (
		<Icon size={size}>
			<circle cx="8" cy="8" r="2.8" />
			<path d="M8 1.6v1.3M8 13.1v1.3M1.6 8h1.3M13.1 8h1.3M3.5 3.5l.9.9M11.6 11.6l.9.9M3.5 12.5l.9-.9M11.6 4.4l.9-.9" />
		</Icon>
	);
}

export function MoonIcon({ size = 16 }: { size?: number } = {}) {
	return (
		<Icon size={size}>
			<path d="M13.6 9.6A5.9 5.9 0 1 1 6.4 2.4a4.6 4.6 0 0 0 7.2 7.2z" />
		</Icon>
	);
}

/** Information: the mark after a setting's name that opens its explanation. */
export function InfoIcon({ size = 16 }: { size?: number } = {}) {
	return (
		<Icon size={size}>
			<circle cx="8" cy="8" r="6" />
			<path d="M8 7.25V11" />
			<path d="M8 5h.01" />
		</Icon>
	);
}
