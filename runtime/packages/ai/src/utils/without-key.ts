// A key this long is cut wherever it stands; a shorter one only where it
// stands alone, since a one-letter key cut from inside words would break the
// error's text that is read next ("context length exceeded" for an overflow).
const KEY_CUT_EVERYWHERE_FROM = 8;

/**
 * The text with the request's own key replaced by `replacement`. A gateway may
 * echo the key it was sent in its refusal ("Incorrect API key provided: ..."),
 * and that text is shown to the person and saved, so the key is cut before it
 * leaves. A key of 8 or more characters is cut everywhere; a shorter one only
 * where no letter or digit touches it on either side. The key is cut as written
 * and as it reads inside JSON text, where a quote or backslash in it is
 * escaped: a body or a client's message may be written out as JSON first.
 * There, a letter or digit that ends an escape before the key (the `n` of a
 * newline's `\n`, a `\u0001`) belongs to the escape, not to a word.
 */
export function withoutKey(text: string, apiKey: string, replacement: string): string {
	if (!apiKey) return text;
	const forms = [JSON.stringify(apiKey).slice(1, -1), apiKey].filter((form, index, all) => all.indexOf(form) === index);
	const key = `(?:${forms.map((form) => form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`;
	const alone = `(?:(?<![\\p{L}\\p{N}])|(?<=\\\\[bfnrt]|\\\\u[0-9A-Fa-f]{4}))${key}(?![\\p{L}\\p{N}])`;
	const pattern = [...apiKey].length >= KEY_CUT_EVERYWHERE_FROM ? key : alone;
	// A function, so a `$` in the replacement is never read as a back-reference.
	return text.replace(new RegExp(pattern, "gu"), () => replacement);
}
