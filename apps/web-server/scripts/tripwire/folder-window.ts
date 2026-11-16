// The computer's folder window, stood in for while a room asks for a folder:
// the window is a program a person answers (osascript on a Mac), so here it
// answers at once with the next folder the drive names, as a person's pick would.
// Every other program starts as before, through the recorder's wrapper.
import childProcess from "node:child_process";
import module from "node:module";

const FOLDER_WINDOW = "/usr/bin/osascript";

/** Until the returned stop is called, the folder window picks `folders` in turn. Returns how many times it opened, and the stop. */
export function standInFolderWindow(...folders: string[]): { opened: () => number; stop: () => void } {
	const real = childProcess.execFile;
	let opened = 0;
	childProcess.execFile = new Proxy(real, {
		apply(target, self, args: any[]) {
			if (args[0] !== FOLDER_WINDOW) return Reflect.apply(target, self, args);
			opened += 1;
			// Each opening picks the next folder, the last one again once they run out.
			const folder = folders[Math.min(opened, folders.length) - 1];
			// The picker's call ends with its callback.
			const done = args.at(-1);
			// The window's script prints the pick as JSON.
			setImmediate(() => done(null, `${JSON.stringify(folder)}\n`, ""));
			return undefined;
		},
	});
	// The picker's named import follows the module's own export only after this.
	module.syncBuiltinESMExports();
	return {
		opened: () => opened,
		stop() {
			childProcess.execFile = real;
			module.syncBuiltinESMExports();
		},
	};
}
