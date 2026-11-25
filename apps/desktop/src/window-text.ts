// What the shell's text windows and its log lines show of an address that signs
// in: never the token. Pure and free of electron so a unit test runs it on its
// own (scripts/window-text.test.mjs).

// A value runs to what can't stand inside one in an address: white space, "&",
// a quote or an angle bracket. A "'" can stand in one and is also how electron
// quotes the address it could not load, so only a last one stays.
const TOKEN_VALUE = /(token(?:=|%3D))[^\s&"<>`]+?(?='?(?:[\s&"<>`]|$))/gi;

// The sign-in token as an address carries it, the address itself encoded or
// not. The mark is the one the server's own log uses.
export function maskTokens(text: string): string {
  return text.replace(TOKEN_VALUE, "$1[redacted]");
}
