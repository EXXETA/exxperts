import { createRequire } from "node:module";

// QR module matrix for the pairing URL, rendered by the Settings page as an
// SVG. The generator is the one qrcode-terminal (the CLI's QR dependency,
// lockfile-pinned) ships in its vendor directory; reaching for it directly
// means the in-app QR and the terminal QR encode with the same code and the
// dependency list does not grow for a second copy of the same algorithm.
// qrcode-terminal predates package "exports", so the deep path is reachable,
// and the lockfile pin keeps it stable.
//
// Best-effort on purpose, like the CLI's own QR: the require is lazy and any
// failure (vendor path gone after a dep update, encoder throwing) returns
// null instead of ever surfacing. The pairing URL is the mechanism; the QR
// is a convenience, and a convenience must not be able to break enrollment,
// let alone the boot.

interface VendoredQrCode {
	addData(text: string): void;
	make(): void;
	getModuleCount(): number;
	modules: boolean[][];
}

type QrConstructor = new (typeNumber: number, errorCorrectLevel: number) => VendoredQrCode;

let vendored: { QRCode: QrConstructor; level: number } | null | undefined;

function loadVendoredEncoder(): { QRCode: QrConstructor; level: number } | null {
	if (vendored !== undefined) return vendored;
	try {
		const require = createRequire(import.meta.url);
		const QRCode = require("qrcode-terminal/vendor/QRCode") as QrConstructor;
		const QRErrorCorrectLevel = require("qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel") as { L: number };
		// Error-correction level L, matching the CLI's QR for the same URL:
		// screen rendering is crisp, and the lower level keeps the module
		// count (the on-screen size a camera must resolve) down.
		vendored = { QRCode, level: QRErrorCorrectLevel.L };
	} catch {
		vendored = null;
	}
	return vendored;
}

export function qrMatrixFor(text: string): boolean[][] | null {
	const encoder = loadVendoredEncoder();
	if (!encoder) return null;
	try {
		const qr = new encoder.QRCode(-1, encoder.level);
		qr.addData(text);
		qr.make();
		const count = qr.getModuleCount();
		const rows: boolean[][] = [];
		for (let row = 0; row < count; row++) {
			rows.push(qr.modules[row].slice(0, count).map(Boolean));
		}
		return rows;
	} catch {
		return null;
	}
}
