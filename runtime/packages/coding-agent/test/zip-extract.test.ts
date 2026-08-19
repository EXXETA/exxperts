import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractZipSafe } from "../src/utils/zip-extract.js";

interface FixtureEntry {
	name: string;
	data: string;
	mode: number; // full Unix mode incl. file type bits, e.g. 0o100755 or 0o120777 for a symlink
}

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(buf: Buffer): number {
	let c = 0xffffffff;
	for (const byte of buf) {
		c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
	}
	return (c ^ 0xffffffff) >>> 0;
}

// Build a minimal stored (uncompressed) zip so fixtures need no zip library.
// Version-made-by declares Unix so the entry mode lands in the external attributes.
function buildZip(entries: FixtureEntry[]): Buffer {
	const parts: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;

	for (const entry of entries) {
		const name = Buffer.from(entry.name, "utf-8");
		const data = Buffer.from(entry.data, "utf-8");
		const crc = crc32(data);

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0); // local file header signature
		local.writeUInt16LE(20, 4); // version needed
		local.writeUInt16LE(0, 6); // flags
		local.writeUInt16LE(0, 8); // method: stored
		local.writeUInt32LE(0, 10); // dos time+date
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(data.length, 18); // compressed size
		local.writeUInt32LE(data.length, 22); // uncompressed size
		local.writeUInt16LE(name.length, 26);
		local.writeUInt16LE(0, 28); // extra length

		const cdir = Buffer.alloc(46);
		cdir.writeUInt32LE(0x02014b50, 0); // central directory signature
		cdir.writeUInt16LE((3 << 8) | 20, 4); // version made by: Unix
		cdir.writeUInt16LE(20, 6); // version needed
		cdir.writeUInt16LE(0, 8); // flags
		cdir.writeUInt16LE(0, 10); // method: stored
		cdir.writeUInt32LE(0, 12); // dos time+date
		cdir.writeUInt32LE(crc, 16);
		cdir.writeUInt32LE(data.length, 20);
		cdir.writeUInt32LE(data.length, 24);
		cdir.writeUInt16LE(name.length, 28);
		cdir.writeUInt16LE(0, 30); // extra length
		cdir.writeUInt16LE(0, 32); // comment length
		cdir.writeUInt16LE(0, 34); // disk number
		cdir.writeUInt16LE(0, 36); // internal attributes
		cdir.writeUInt32LE((entry.mode >>> 0) * 0x10000, 38); // external attributes: mode << 16
		cdir.writeUInt32LE(offset, 42); // local header offset

		parts.push(local, name, data);
		central.push(cdir, name);
		offset += local.length + name.length + data.length;
	}

	const centralStart = offset;
	const centralBuf = Buffer.concat(central);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
	eocd.writeUInt16LE(0, 4); // disk number
	eocd.writeUInt16LE(0, 6); // central directory disk
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(centralBuf.length, 12);
	eocd.writeUInt32LE(centralStart, 16);
	eocd.writeUInt16LE(0, 20); // comment length

	return Buffer.concat([...parts, centralBuf, eocd]);
}

describe("extractZipSafe", () => {
	let tempDir: string;
	let extractDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "zip-extract-test-"));
		extractDir = join(tempDir, "out");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function writeFixture(entries: FixtureEntry[]): string {
		const archivePath = join(tempDir, "fixture.zip");
		writeFileSync(archivePath, buildZip(entries));
		return archivePath;
	}

	it("rejects entries that traverse outside the extraction directory", async () => {
		const archive = writeFixture([{ name: "../evil", data: "pwned", mode: 0o100644 }]);
		await expect(extractZipSafe(archive, extractDir)).rejects.toThrow();
		expect(existsSync(join(tempDir, "evil"))).toBe(false);
	});

	it("rejects symlink entries", async () => {
		const archive = writeFixture([{ name: "link", data: "/etc/passwd", mode: 0o120777 }]);
		await expect(extractZipSafe(archive, extractDir)).rejects.toThrow(/symlink/);
		expect(existsSync(join(extractDir, "link"))).toBe(false);
	});

	it("extracts regular files, keeping the executable bit", async () => {
		const archive = writeFixture([
			{ name: "dir/tool", data: "#!/bin/sh\necho ok\n", mode: 0o100755 },
			{ name: "dir/readme.txt", data: "docs", mode: 0o100644 },
		]);
		await extractZipSafe(archive, extractDir);

		const toolPath = join(extractDir, "dir", "tool");
		expect(readFileSync(toolPath, "utf-8")).toBe("#!/bin/sh\necho ok\n");
		expect(readFileSync(join(extractDir, "dir", "readme.txt"), "utf-8")).toBe("docs");

		if (process.platform !== "win32") {
			expect(() => accessSync(toolPath, constants.X_OK)).not.toThrow();
			expect(statSync(join(extractDir, "dir", "readme.txt")).mode & 0o111).toBe(0);
		}
	});

	it("extracts files with no Unix mode as regular files", async () => {
		const archive = writeFixture([{ name: "plain.txt", data: "hello", mode: 0 }]);
		await extractZipSafe(archive, extractDir);
		expect(readFileSync(join(extractDir, "plain.txt"), "utf-8")).toBe("hello");
	});
});
