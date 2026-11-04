import { memo, useEffect, useRef, useSyncExternalStore } from "react";
import { CopyTextTool, FigureStrip, FigureTools } from "./figure-tools";

type Katex = typeof import("katex").default;

// KaTeX and its stylesheet are one lazy chunk of our own build, loaded when
// the first formula is drawn; the browser then fetches only the font faces
// the formulas use, from our own server. A load that fails (a dropped
// connection, a new version deployed under an open page) leaves every
// formula as written, and the next formula drawn tries again.
type Load = { state: "idle" | "loading" | "failed" } | { state: "ready"; katex: Katex };
let load: Load = { state: "idle" };
let pending: Promise<void> = Promise.resolve();
let version = 0;
const listeners = new Set<() => void>();

function settle(next: Load): void {
	load = next;
	version++;
	for (const listener of listeners) listener();
}

/** Starts loading KaTeX, unless it is loading or loaded; resolves once formulas can be typeset or the load has failed. */
export function loadMaths(): Promise<void> {
	if (load.state === "loading" || load.state === "ready") return pending;
	load = { state: "loading" };
	// The stylesheet's import is a module only in the page's build: Node, running the page's code in a smoke, refuses the file type, and only that refusal is passed over.
	const stylesheet = import("katex/dist/katex.min.css").catch((error: { code?: string }) => {
		if (error?.code !== "ERR_UNKNOWN_FILE_EXTENSION") throw error;
	});
	pending = Promise.all([import("katex"), stylesheet]).then(
		([mod]) => settle({ state: "ready", katex: mod.default }),
		() => settle({ state: "failed" }),
	);
	return pending;
}

const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};
const loadedVersion = () => version;

const CACHE_SIZE = 512;
// Typeset formulas by display and TeX; null for one that does not parse.
const typeset = new Map<string, string | null>();

/** The formula as HTML (with hidden MathML for screen readers), null when it does not parse, undefined until KaTeX has loaded. */
function typesetNow(tex: string, display: boolean): string | null | undefined {
	if (load.state !== "ready") return undefined;
	const { katex } = load;
	const key = `${display ? "D" : "I"}${tex}`;
	let html = typeset.get(key);
	if (html === undefined) {
		try {
			html = katex.renderToString(tex, { displayMode: display, throwOnError: true, trust: false, strict: "ignore", maxSize: 50, maxExpand: 1000, output: "htmlAndMathml" });
		} catch {
			html = null;
		}
		typeset.set(key, html);
		if (typeset.size > CACHE_SIZE) typeset.delete(typeset.keys().next().value!);
	}
	return html;
}

/**
 * One formula, typeset by KaTeX: inline, or `display` as a centred block that
 * scrolls sideways when wider than the answer.
 *
 * `writing`: a display formula whose closing line has not arrived. While it
 * is written it keeps its last good picture whenever the TeX so far does not
 * parse (`\frac{a}{`), and before the first one it is a quiet box one line
 * high, never raw TeX. A finished formula that does not parse shows as it was
 * written, in the answer's own text, never KaTeX's red error.
 *
 * `copy`: a display formula carries a Copy of its LaTeX in a strip above it.
 */
export const Maths = memo(function Maths({ tex, display, written, writing = false, copy = false }: { tex: string; display: boolean; written: string; writing?: boolean; copy?: boolean }) {
	useSyncExternalStore(subscribe, loadedVersion, loadedVersion);
	useEffect(() => {
		void loadMaths();
	}, []);
	const lastGood = useRef<string | undefined>(undefined);
	const html = tex.trim() ? typesetNow(tex, display) : null;
	if (html) lastGood.current = html;
	const shown = html ?? (writing ? lastGood.current : undefined);
	const className = display ? "maths maths-display" : "maths";
	if (shown && display && copy) {
		return (
			<span className="figure-maths">
				<FigureStrip className="figure-strip-plain"><FigureTools copy={<CopyTextTool text={tex.trim()} what="formula" />} /></FigureStrip>
				<span className={className} dangerouslySetInnerHTML={{ __html: shown }} />
			</span>
		);
	}
	if (shown) return <span className={className} dangerouslySetInnerHTML={{ __html: shown }} />;
	if (load.state === "failed") return <span className="maths-as-written">{written}</span>;
	if (writing || (html === undefined && display)) return <span className={`${className} maths-pending`} aria-label="Formula" />;
	// An inline formula shows as written, muted, for the moment KaTeX takes to load.
	return <span className={html === undefined ? "maths-as-written maths-loading" : "maths-as-written"}>{written}</span>;
});
