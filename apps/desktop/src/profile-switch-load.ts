// Signing the window in after a profile switch, beside a page that navigates
// by itself: the page follows the same restart (state-profile-section.tsx), and
// its navigation ends the shell's load. Pure and free of electron so a unit
// test runs it on its own (scripts/profile-switch-load.test.mjs).

// More than two: the page that arrives can navigate once more by itself (one
// that is not signed in goes to the sign-in page).
export const SIGN_IN_LOAD_TRIES = 3;

// How electron's loadURL rejects when another navigation took the window over.
export function isTakenOver(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ERR_ABORTED";
}

// Asks the load again while a page's navigation takes it over. Being on the
// app's own address is no proof of the sign-in: the address stays the old page's
// until the new one arrives, and the page's own way can be "/", which signs
// nothing in. So only a load of the shell's that finished counts. `settled`
// waits for the page's navigation to end: a load asked during it is dropped
// with it.
export async function loadPastTakeovers(load: () => Promise<void>, settled: () => Promise<void>): Promise<void> {
  for (let tries = 1; ; tries++) {
    try {
      await load();
      return;
    } catch (error) {
      if (!isTakenOver(error) || tries >= SIGN_IN_LOAD_TRIES) throw error;
      await settled();
    }
  }
}
