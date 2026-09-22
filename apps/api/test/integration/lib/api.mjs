/**
 * Shared plumbing for the integration suites.
 *
 * Each suite keeps its own small `call()` helper; these two functions are
 * what those helpers have in common with how the API actually behaves.
 */

/**
 * Money arrives as decimal strings.
 *
 * The API serialises BigInt minor units (every `…Minor` field) as strings so
 * that no kobo is lost past Number.MAX_SAFE_INTEGER - see app-factory.ts.
 * The suites do arithmetic on these values (sums, negations, comparisons),
 * and `+` on strings concatenates. Every fixture amount is far below 2^53, so
 * reading them back as Numbers is exact here. Nothing else is converted.
 */
export function parseApiJson(text) {
  return JSON.parse(text, (key, value) =>
    typeof value === "string" && /Minor$/.test(key) && /^-?\d+$/.test(value)
      ? Number(value)
      : value
  );
}

/**
 * Sign-in is rate limited per IP, and every suite shares one IP.
 *
 * A 429 on /auth/login means the control is working, not that the test
 * failed, so it is waited out - the same rule hardening.test.mjs follows. A
 * suite that switched off a production control to pass would be testing a
 * system nobody ships. Only /auth/login is retried; any other 429 is a real
 * result the test should see.
 */
export async function fetchWithLoginBackoff(url, init) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch(url, init);
    if (res.status !== 429 || !String(url).includes("/auth/login")) return res;
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new Error("login stayed rate limited for 80 seconds");
}
