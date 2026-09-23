// The time-left wording of the update panel, from the transfer's own recent
// rate. Pure and free of electron so a unit smoke can compile and run it on
// its own (scripts/time-left-smoke.mjs).
//
// The caller passes the bytes moved and the seconds elapsed over a short
// sliding window of progress samples (main.ts keeps the last few seconds),
// plus the bytes still to come. Under three seconds of data or with no
// movement in the window the answer is null: the panel then shows nothing
// rather than a guess, so a stall reads as a stall and a slow line as slow.
export type TimeLeftInput = { movedBytes: number; seconds: number; remainingBytes: number };

export function timeLeftText(input: TimeLeftInput): string | null {
  const { movedBytes, seconds, remainingBytes } = input;
  if (![movedBytes, seconds, remainingBytes].every((n) => Number.isFinite(n))) return null;
  if (remainingBytes < 0 || seconds < 3 || movedBytes <= 0) return null;
  const left = remainingBytes / (movedBytes / seconds);
  if (left < 10) return "less than 10 seconds left";
  // Seconds go to the nearest multiple of five (12 reads "about 10", 13
  // "about 15"); a value that would round up to 60 is a minute already.
  const fives = Math.round(left / 5) * 5;
  if (fives < 60) return `about ${fives} seconds left`;
  const minutes = Math.round(left / 60);
  if (minutes < 60) return minutes === 1 ? "about 1 minute left" : `about ${minutes} minutes left`;
  const hours = Math.max(1, Math.round(left / 3600));
  return hours === 1 ? "about 1 hour left" : `about ${hours} hours left`;
}
