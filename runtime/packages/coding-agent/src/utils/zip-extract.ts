import { createWriteStream, mkdirSync } from "fs";
import { dirname, resolve, sep } from "path";
import { pipeline } from "stream/promises";
import yauzl from "yauzl";

// Zip entries carry a Unix mode in the upper 16 bits of the external file
// attributes (when the archive was created on a Unix-y system; zero otherwise).
const S_IFMT = 0xf000;
const S_IFREG = 0x8000;
const S_IFLNK = 0xa000;

// Extract a zip archive while refusing anything that could write outside the
// target directory: entries whose resolved path escapes it, symlinks, and any
// other non-regular-file entry. Regular files keep their executable bit.
export async function extractZipSafe(archivePath: string, extractDir: string): Promise<void> {
	const root = resolve(extractDir);

	const zipFile = await new Promise<yauzl.ZipFile>((resolveOpen, rejectOpen) => {
		yauzl.open(archivePath, { lazyEntries: true, autoClose: true }, (err, zf) => {
			if (err || !zf) rejectOpen(err ?? new Error("Failed to open zip archive"));
			else resolveOpen(zf);
		});
	});

	await new Promise<void>((resolveDone, rejectDone) => {
		let settled = false;

		const fail = (err: unknown) => {
			if (settled) return;
			settled = true;
			zipFile.close();
			rejectDone(err instanceof Error ? err : new Error(String(err)));
		};

		const extractEntry = async (entry: yauzl.Entry): Promise<void> => {
			const dest = resolve(root, entry.fileName);
			if (dest !== root && !dest.startsWith(root + sep)) {
				throw new Error(`Zip entry escapes extraction directory: ${entry.fileName}`);
			}

			if (entry.fileName.endsWith("/")) {
				mkdirSync(dest, { recursive: true });
				return;
			}

			const mode = entry.externalFileAttributes >>> 16;
			const fileType = mode & S_IFMT;
			if (fileType === S_IFLNK) {
				throw new Error(`Zip entry is a symlink, refusing to extract: ${entry.fileName}`);
			}
			// fileType 0 means the archive carries no Unix mode; treat as a regular file.
			if (fileType !== 0 && fileType !== S_IFREG) {
				throw new Error(`Zip entry is not a regular file, refusing to extract: ${entry.fileName}`);
			}

			const readStream = await new Promise<NodeJS.ReadableStream>((resolveStream, rejectStream) => {
				zipFile.openReadStream(entry, (err, stream) => {
					if (err || !stream) rejectStream(err ?? new Error(`Failed to read zip entry: ${entry.fileName}`));
					else resolveStream(stream);
				});
			});

			mkdirSync(dirname(dest), { recursive: true });
			const fileMode = (mode & 0o111) !== 0 ? 0o755 : 0o644;
			await pipeline(readStream, createWriteStream(dest, { mode: fileMode }));
		};

		zipFile.on("error", fail);
		zipFile.on("end", () => {
			if (!settled) {
				settled = true;
				resolveDone();
			}
		});
		zipFile.on("entry", (entry: yauzl.Entry) => {
			extractEntry(entry).then(() => {
				if (!settled) zipFile.readEntry();
			}, fail);
		});

		zipFile.readEntry();
	});
}
