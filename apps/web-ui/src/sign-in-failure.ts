// A turn that failed because the provider's sign-in cannot be used: the key
// is gone, the provider refused it (401), or an OAuth refresh failed. The
// catalog may still count the provider as signed in (a stored credential that
// can no longer be refreshed), so the failure only shows at request time. The
// room then says what the person can do (sign in, or choose another model),
// not the raw error.
//
// Left out on purpose, because they do not always mean a lapsed sign-in: 403
// and "permission" or "forbidden" (a key without access to one model), 402 and
// quota or billing errors, and rate limits. They keep the ordinary error line.

const SIGN_IN_FAILURE_PATTERNS: readonly RegExp[] = [
	// The runtime's own words when it has no usable credential.
	/\bNo API key (?:for provider|found for)\b/i,
	/\bAuthentication failed for "/,
	/\btoken refresh (?:request )?failed\b/i,
	/\bFailed to refresh OAuth token\b/i,
	// A provider that refused the credential: a 401 where a status stands (the
	// SDKs lead with it, the Codex refresh puts it in brackets), never a count.
	/(?:^|\bstatus(?: code)?:? ?|\(|\bHTTP )401\b/i,
	/\bauthentication_error\b/i,
	/\binvalid[ _-]?(?:x-)?api[ _-]?key\b/i,
	/\bincorrect api key\b/i,
];

export function isSignInFailure(detail: string): boolean {
	return SIGN_IN_FAILURE_PATTERNS.some((pattern) => pattern.test(detail));
}
