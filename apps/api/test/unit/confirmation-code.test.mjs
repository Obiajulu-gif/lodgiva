import test from "node:test";
import assert from "node:assert/strict";
import {
  CODE_ALPHABET,
  generateConfirmationCode,
  isValidConfirmationCode,
  normaliseConfirmationCode,
} from "../../dist/common/confirmation-code.js";

test("codes match the grouped LDG-XXXX-XXXX shape", () => {
  for (let i = 0; i < 200; i++) {
    assert.match(generateConfirmationCode(), /^LDG-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  }
});

test("codes never contain transcription-ambiguous characters", () => {
  // Each pair has a canonical member that IS used (8, Q, W, 2) and excluded
  // twins that are folded onto it, so only the twins are banned here.
  const banned = ["O", "0", "I", "1", "L", "S", "5", "B", "U", "V", "Z"];
  for (let i = 0; i < 500; i++) {
    const body = generateConfirmationCode().replace(/^LDG-/, "").replace("-", "");
    for (const ch of body) {
      assert.ok(CODE_ALPHABET.includes(ch), `unexpected character ${ch}`);
      assert.ok(!banned.includes(ch), `ambiguous character ${ch} leaked into a code`);
    }
  }
});

test("generation is driven by the injected source of randomness", () => {
  // Always picking index 0 must yield the first alphabet character throughout,
  // proving no hidden entropy is mixed in.
  const first = CODE_ALPHABET[0];
  assert.equal(
    generateConfirmationCode(() => 0),
    `LDG-${first.repeat(4)}-${first.repeat(4)}`
  );
});

test("the generator draws across the whole alphabet", () => {
  const seen = new Set();
  for (let i = 0; i < 4000; i++) {
    for (const ch of generateConfirmationCode().replace(/^LDG-/, "").replace("-", "")) {
      seen.add(ch);
    }
  }
  assert.equal(seen.size, CODE_ALPHABET.length, "every alphabet character should be reachable");
});

test("codes are not sequential and do not leak booking volume", () => {
  // 500 consecutive codes should be essentially all distinct; a counter-based
  // scheme would produce a predictable ascending run.
  const codes = Array.from({ length: 500 }, () => generateConfirmationCode());
  assert.ok(new Set(codes).size > 495, "codes must not repeat in a short run");

  const bodies = codes.map((c) => c.replace(/^LDG-/, "").replace("-", ""));
  const ascending = bodies.filter((b, i) => i > 0 && b > bodies[i - 1]).length;
  // A sequential scheme would be ~100% ascending; random should sit near half.
  assert.ok(ascending > 150 && ascending < 350, `codes look sequential (${ascending}/499 ascending)`);
});

test("lookup tolerates how guests actually type codes", () => {
  const code = generateConfirmationCode();
  const body = code.replace(/^LDG-/, "").replace("-", "");
  for (const variant of [
    code,
    code.toLowerCase(),
    code.replace(/-/g, ""),
    code.replace(/-/g, " "),
    `  ${code}  `.toLowerCase(),
    body,
    body.toLowerCase(),
  ]) {
    assert.equal(normaliseConfirmationCode(variant), code, `failed on "${variant}"`);
  }
});

test("confusable characters are folded onto their intended counterparts", () => {
  assert.equal(normaliseConfirmationCode("LDG-OOOO-0000"), "LDG-QQQQ-QQQQ");
  assert.equal(normaliseConfirmationCode("LDG-BBBB-ZZZZ"), "LDG-8888-2222");
  assert.equal(normaliseConfirmationCode("LDG-UUUU-VVVV"), "LDG-WWWW-WWWW");
});

test("folding never rewrites a character a real code can contain", () => {
  // Regression: an earlier fold chain mapped 8→9, corrupting every code that
  // legitimately contained an 8.
  for (const ch of CODE_ALPHABET) {
    const code = `LDG-${ch.repeat(4)}-${ch.repeat(4)}`;
    assert.equal(normaliseConfirmationCode(code), code, `fold corrupted "${ch}"`);
  }
});

test("characters with no unambiguous target are rejected, not guessed", () => {
  // I/L/1 and S/5 look like each other but like nothing in our alphabet, so
  // sending the guest to a wrong booking is worse than asking them to re-read.
  for (const bad of ["LDG-IIII-IIII", "LDG-LLLL-LLLL", "LDG-1111-1111", "LDG-SSSS-SSSS"]) {
    assert.equal(normaliseConfirmationCode(bad), null, `should reject "${bad}"`);
  }
});

test("malformed input is rejected rather than guessed at", () => {
  for (const bad of ["", "LDG", "LDG-123", "LDG-AAAA-AAAAA", "!!!!-!!!!", "LDG-AAAA-AAA"]) {
    assert.equal(normaliseConfirmationCode(bad), null, `should reject "${bad}"`);
    assert.equal(isValidConfirmationCode(bad), false);
  }
});

test("every generated code round-trips through normalisation", () => {
  for (let i = 0; i < 300; i++) {
    const code = generateConfirmationCode();
    assert.equal(normaliseConfirmationCode(code), code);
    assert.ok(isValidConfirmationCode(code));
  }
});
