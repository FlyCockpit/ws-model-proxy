import { describe, expect, it } from "vitest";
import {
  hasUntrustedStructure,
  MESSAGE_REDACTED_MARKER,
  resolveAuthLogCall,
} from "./auth-logger-bridge";

/**
 * L19 (bridge choke point, pass 10 — TERMINAL policy v3.1,
 * CHARACTER-ONLY MAXIMAL trigger set, user ruling):
 * - non-string first args emit ONLY `[auth] <level> (<ctor|typeof>)` — no
 *   message, no stringification (bucket test 1/4),
 * - string first args containing ANY trigger character (`:` `=` `@` `{`
 *   `}` `"` `'` `` ` `` `%` `\` `/` `?` `#`, control chars) emit EXACTLY
 *   `[auth] <level> [message-redacted: untrusted structure]` — the
 *   original message NEVER appears, not even a prefix,
 * - clean static messages (NO trigger character) pass VERBATIM
 *   (`[auth] <message>`, 200-char final-safety truncation) — no word
 *   list; static diagnostics like "authorization code replay cleanup
 *   failed" qualify by grammar,
 * - the `(Error: <ctor>)` rest-arg markers apply at error/warn only,
 * - info drops all rest args; debug is dropped; the user-input
 *   error→warn downgrade survives for string firsts only.
 */

const STACK = "Error: SECRET-boom\n    at introspect (introspect-CbhhXT0E.mjs:2542:15)";

/** Every R29–R33 bypass shape as one inventory (label + full message). */
const UNTRUSTED_SHAPES: ReadonlyArray<[label: string, message: string]> = [
  // --- R29/R30 encoded-key shapes ---
  ["encoded key %73tate", "signed query %73tate=SECRET-value&%73ig=SECRET-value tail"],
  ["double-encoded key %2573tate", "refer %2573tate=SECRET-value tail"],
  ["encoded mixed-case ACCESS%5FTOKEN", "leak ACCESS%5FTOKEN=SECRET-value tail"],
  ["literal 12-key pair family", "state=S&sig=S&oauth_query=S&code=S&code_verifier=S"],
  // --- R31/R32 terminator/scheme/userinfo shapes ---
  ["apostrophe terminator", "Invalid origin: https://evil.example/cb?state='SECRET-v"],
  ["double-quote terminator", 'Invalid origin: https://evil.example/cb?state="SECRET-v'],
  ["less-than terminator", "Invalid origin: https://evil.example/cb?state=<SECRET-v"],
  ["greater-than terminator", "Invalid origin: https://evil.example/cb?state=>SECRET-v"],
  ["space-separated value", "Invalid origin: https://evil.example/cb?state= SECRET-v"],
  ["uppercase scheme with query", "Invalid origin: HTTPS://evil.example/cb?other=SECRET-v"],
  ["mixed-case scheme, fragment only", "Invalid origin: hTtPs://evil.example/cb#SECRET-v"],
  ["userinfo credentials", "Invalid origin: https://user:SECRET-v@evil.example/cb?state=x"],
  // --- R33 shapes (renewal evidence: 20 failing shapes) ---
  ["protocol-relative query", "Invalid origin: //evil.example/cb?scope=SECRET-v"],
  ["protocol-relative credentials", "Invalid origin: //user:SECRET-v@evil.example/cb?state=x"],
  ["protocol-relative fragment", "Invalid origin: //evil.example/cb#SECRET-v"],
  ["backslash scheme query", "Invalid origin: https:\\\\evil.example/cb?scope=SECRET-v"],
  [
    "backslash scheme credentials",
    "Invalid origin: https:\\\\user:SECRET-v@evil.example/cb?state=x",
  ],
  ["backslash scheme fragment", "Invalid origin: https:\\\\evil.example/cb#SECRET-v"],
  ["tab within known key", "Invalid origin: https://evil.example/cb?sta\tte=SECRET-v"],
  ["tab within scheme", "Invalid origin: ht\ttps://evil.example/cb?scope=SECRET-v"],
  ["nonempty state then space", "Invalid origin: https://evil.example/cb?state=public SECRET-v"],
  ["nonempty state then tab", "Invalid origin: https://evil.example/cb?state=public\tSECRET-v"],
  ["quoted state then space", "Invalid origin: https://evil.example/cb?state=' SECRET-v"],
  ["fragment then space", "Invalid origin: https://evil.example/cb# SECRET-v"],
  ["state with two words", "Invalid origin: https://evil.example/cb?state= public SECRET-v"],
  ["userinfo with space", "Invalid origin: https://user: SECRET-v@evil.example/cb?state=x"],
  [
    "nested marker plus whitespace",
    "Invalid origin: https://evil.example/cb?state=[query-redacted][fragment-redacted] SECRET-v",
  ],
  [
    "orphan URL reentry past fragment marker",
    "Invalid origin: https://evil.example/cb?state=#f https://value.example/SECRET-v",
  ],
  [
    "orphan URL with query reentry",
    "Invalid origin: https://evil.example/cb?state=#f https://value.example/SECRET-v?state=x",
  ],
  [
    "CR within key (JSON callback shape)",
    "Invalid origin: https://evil.example/cb?sta\rte=SECRET-v",
  ],
  [
    "LF within key (JSON callback shape)",
    "Invalid origin: https://evil.example/cb?sta\nte=SECRET-v",
  ],
  ["bare URL, no query", "go to https://evil.example/cb now"],
  ["bare equals pair, unknown key", "callback url ?foo=SECRET-v done"],
  // --- R35/R36 shapes (pass-10 renewal evidence) ---
  ["no-slash scheme with userinfo credentials", "https:user:SECRET-v@evil.example/cb"],
  ["single-slash scheme with userinfo credentials", "https:/user:SECRET-v@evil.example/cb"],
  ["authorization header", "Authorization: Bearer SECRET-v"],
  ["JSON body with token key", '{"access_token":"SECRET-v"}'],
  ["percent-encoded full URL", "redirect https%3A%2F%2Fevil.example%2Fcb%3Fstate%3DSECRET-v"],
  ["percent-encoded query key", "leak %73tate=SECRET-v done"],
  ["percent-encoded header prefix", "Authorization%3A Bearer SECRET-v"],
  ["JSON single-quoted variant", "{'refresh_token': 'SECRET-v'}"],
  ["backtick-quoted value", "token `SECRET-v` rejected"],
];

describe("resolveAuthLogCall — A1/rest-arg/level policy (unchanged by v3)", () => {
  it("bucket 1 — error level, raw Error FIRST arg: ctor-name label only, message/stack never emitted", () => {
    const secret = new Error(
      "SECRET-internal-message relation failure SELECT token='*********************'",
    );
    secret.stack = STACK;
    const call = resolveAuthLogCall("error", secret, []);
    expect(call).toEqual({ method: "error", args: ["[auth] error (Error)"] });
    const line = call?.args[0] ?? "";
    expect(line).not.toContain("SECRET");
    expect(line).not.toContain("relation failure");
    expect(line).not.toContain("at ");
  });

  it("bucket 4 — non-Error non-string first arg (plain object): typeof label only, no JSON leak", () => {
    const call = resolveAuthLogCall("error", { secret: "SECRET-json" }, ["also dropped"]);
    expect(call).toEqual({ method: "error", args: ["[auth] error (object)"] });
  });

  it("string first + Error-typed rest args at error/warn: (Error: <ctor>) markers; strings/objects dropped", () => {
    const secret = new Error("SECRET-internal-message");
    secret.stack = STACK;
    const call = resolveAuthLogCall("error", "oauth error", [
      secret, // raw Error object arg
      secret.message, // plain string message arg (installed call shape)
      STACK, // plain string stack arg (installed call shape)
    ]);
    expect(call).toEqual({ method: "error", args: ["[auth] oauth error (Error: Error)"] });
  });

  it("redacted string first keeps the safe (Error: <ctor>) markers at error level", () => {
    const call = resolveAuthLogCall("error", "Invalid origin: https://evil.example/?state=S", [
      new Error("SECRET-internal"),
    ]);
    expect(call).toEqual({
      method: "error",
      args: [`[auth] error ${MESSAGE_REDACTED_MARKER} (Error: Error)`],
    });
  });

  it("multiple Error rest args each contribute only their constructor name", () => {
    const call = resolveAuthLogCall("warn", "two errors", [
      new RangeError("SECRET-a"),
      new SyntaxError("SECRET-b"),
    ]);
    expect(call).toEqual({
      method: "warn",
      args: ["[auth] two errors (Error: RangeError) (Error: SyntaxError)"],
    });
  });

  it("warn level, raw Error FIRST arg: same ctor-only label as error level", () => {
    const call = resolveAuthLogCall("warn", new TypeError("SECRET-warn"), []);
    expect(call).toEqual({ method: "warn", args: ["[auth] warn (TypeError)"] });
  });

  it("recognized user-input error STRING downgrades error→warn (non-string firsts never downgrade)", () => {
    expect(resolveAuthLogCall("error", "Invalid password", [new Error("SECRET")])).toEqual({
      method: "warn",
      args: ["[auth] Invalid password (Error: Error)"],
    });
    expect(resolveAuthLogCall("error", new Error("Invalid password"), [])).toEqual({
      method: "error",
      args: ["[auth] error (Error)"],
    });
  });

  it("debug level: nothing logged (unchanged pre-bridge behavior)", () => {
    expect(resolveAuthLogCall("debug", "noop", ["x"])).toBeNull();
    expect(resolveAuthLogCall("debug", new Error("SECRET"), [])).toBeNull();
  });

  it("success (never dispatched by the installed logger) maps to info behavior defensively", () => {
    expect(resolveAuthLogCall("success", "signed in", ["dropped"])).toEqual({
      method: "info",
      args: ["[auth] signed in"],
    });
    expect(resolveAuthLogCall("success", new Error("SECRET"), [])).toEqual({
      method: "info",
      args: ["[auth] info (Error)"],
    });
  });

  it("non-Error non-string firsts degrade to typeof labels (number, null, undefined)", () => {
    expect(resolveAuthLogCall("warn", 42, [])).toEqual({
      method: "warn",
      args: ["[auth] warn (number)"],
    });
    expect(resolveAuthLogCall("error", null, [])).toEqual({
      method: "error",
      args: ["[auth] error (object)"],
    });
    expect(resolveAuthLogCall("warn", undefined, [])).toEqual({
      method: "warn",
      args: ["[auth] warn (undefined)"],
    });
  });
});

describe("TERMINAL POLICY v3.1 — trigger-character enumeration (character-only maximal set)", () => {
  it.each([
    ["any colon : (scheme/header separator)", "https:user:SECRET@evil.example/cb"],
    ["any equals =", "state=SECRET"],
    ["any at-sign @ (userinfo credentials)", "user:SECRET@evil.example"],
    ["any open brace {", "payload {access_token"],
    ["any close brace }", "payload access_token}"],
    ['any double quote "', 'token "SECRET"'],
    ["any single quote '", "token 'SECRET'"],
    ["any backtick `", "token `SECRET`"],
    ["any percent % (percent-encoding carrier)", "https%3A%2F%2Fevil.example"],
    ["any backslash \\", "https:\\evil.example"],
    ["any slash / (path-carried credentials)", "/api/auth/reset-password/R40SECRET"],
    ["any double slash //", "//evil.example/cb"],
    ["tab \\t", "sta\tte=SECRET"],
    ["line feed \\n", "sta\nte=SECRET"],
    ["carriage return \\r", "sta\rte=SECRET"],
    ["NUL \\x00", "state=\x00SECRET"],
    ["DEL \\x7f", "state=\x7fSECRET"],
  ])("trigger %s redacts the WHOLE message", (label, message) => {
    expect(hasUntrustedStructure(message), label).toBe(true);
    const line = resolveAuthLogCall("error", `Invalid origin: ${message}`, [])?.args[0] ?? "";
    expect(line).toBe(`[auth] error ${MESSAGE_REDACTED_MARKER}`);
    expect(line).not.toContain("SECRET");
    expect(line).not.toContain("evil.example");
  });

  it("each trigger is detectable anywhere in the message, not only at the start", () => {
    for (const trigger of [
      ":",
      "=",
      "@",
      "{",
      "}",
      '"',
      "'",
      "`",
      "%",
      "\\",
      "/",
      "//",
      "\t",
      "\n",
      "\r",
      "\x00",
      "\x7f",
    ]) {
      expect(hasUntrustedStructure(`prose prefix ${trigger} prose suffix`)).toBe(true);
    }
  });

  it("a lone forward slash IS a trigger (pass-12 revision: path-carried credentials)", () => {
    expect(hasUntrustedStructure("user/john signed in")).toBe(true);
    expect(resolveAuthLogCall("warn", "user/john signed in", [])).toEqual({
      method: "warn",
      args: [`[auth] warn ${MESSAGE_REDACTED_MARKER}`],
    });
  });

  it("a single colon IS a trigger (pass-10 revision: header/scheme syntax)", () => {
    expect(hasUntrustedStructure("Failed to query fallback join for model user:")).toBe(true);
    expect(resolveAuthLogCall("warn", "Failed to query fallback join for model user:", [])).toEqual(
      { method: "warn", args: [`[auth] warn ${MESSAGE_REDACTED_MARKER}`] },
    );
  });
});

describe("TERMINAL POLICY v3.2 — pass-11 relative-reference carriers ? and # (R37/R38)", () => {
  it.each([
    ["query carrier /callback?SECRET", "/callback?R37-QUERY-SECRET"],
    ["fragment carrier /cb#SECRET", "/cb#R37-FRAGMENT-SECRET"],
    ["bare question mark", "what? SECRET-v"],
    ["bare hash", "value# SECRET-v"],
  ])("trigger %s redacts the WHOLE message", (label, message) => {
    expect(hasUntrustedStructure(message), label).toBe(true);
    const line = resolveAuthLogCall("error", message, [])?.args[0] ?? "";
    expect(line).toBe(`[auth] error ${MESSAGE_REDACTED_MARKER}`);
    expect(line).not.toContain("SECRET");
    expect(line).not.toContain("callback");
    expect(line).not.toContain("/cb");
  });

  it("each of ? and # is detectable anywhere in the message", () => {
    expect(hasUntrustedStructure("prose prefix ? prose suffix")).toBe(true);
    expect(hasUntrustedStructure("prose prefix # prose suffix")).toBe(true);
  });
});

describe("TERMINAL POLICY v3.3 — pass-12 slash trigger (R40 path-carried credentials)", () => {
  it.each([
    ["R40 reset-password path credential", "/api/auth/reset-password/R40SECRET"],
    ["bare callback path", "/callback"],
    ["single mid-prose slash", "signed user/john in"],
  ])("path shape %s redacts the WHOLE message", (label, message) => {
    expect(hasUntrustedStructure(message), label).toBe(true);
    for (const level of ["error", "warn", "info"] as const) {
      const line = resolveAuthLogCall(level, message, [])?.args[0] ?? "";
      expect(line).toBe(`[auth] ${level} ${MESSAGE_REDACTED_MARKER}`);
      expect(line).not.toContain("R40SECRET");
      expect(line).not.toContain("reset-password");
      expect(line).not.toContain("callback");
    }
  });

  it("a single slash anywhere in the message triggers (not only at the start)", () => {
    expect(hasUntrustedStructure("prose prefix / prose suffix")).toBe(true);
  });

  it("static diagnostics carry no slashes and still pass verbatim (re-checked)", () => {
    for (const message of [
      "authorization code replay cleanup failed",
      "user creation failed",
      "Invalid password",
      "user not found",
    ]) {
      expect(message.includes("/"), message).toBe(false);
      expect(hasUntrustedStructure(message), message).toBe(false);
      expect(resolveAuthLogCall("warn", message, [])).toEqual({
        method: "warn",
        args: [`[auth] ${message}`],
      });
    }
  });
});

describe("TERMINAL POLICY v3.2 — pass-11 AUTH-SCHEME WORD trigger (R37/R38)", () => {
  it.each([
    ["Bearer with structured secret", "Bearer R37-STRUCTURED-SECRET"],
    ["Basic unpadded base64 credentials", "Basic aWQ6U0VDUkVU"],
    ["DPoP proof secret", "DPoP SECRET-v"],
    ["lowercase bearer", "bearer SECRET-v"],
    ["lowercase basic", "basic aWQ6U0VDUkVU"],
    ["mixed-case dPoP", "dPoP SECRET-v"],
    ["scheme word mid-sentence", "request carried Bearer SECRET-v material"],
    ["scheme word after newline", "header\nBearer SECRET-v"],
    ["scheme word with equals delimiter", "token bearer=SECRET-v"],
    ["scheme word with hyphen delimiter", "token basic-SECRET-v"],
    ["leading-whitespace Bearer", " Bearer SECRET-v"],
  ])("scheme-word shape %s redacts the WHOLE message at every level", (label, message) => {
    expect(hasUntrustedStructure(message), label).toBe(true);
    for (const level of ["error", "warn", "info"] as const) {
      const line = resolveAuthLogCall(level, message, [])?.args[0] ?? "";
      expect(line).toBe(`[auth] ${level} ${MESSAGE_REDACTED_MARKER}`);
      expect(line).not.toContain("SECRET");
      expect(line).not.toContain("Bearer");
      expect(line).not.toContain("basic");
      expect(line).not.toContain("aWQ6U0VDUkVU");
    }
  });

  it("the scheme words alone (no remainder) do not trigger", () => {
    expect(hasUntrustedStructure("Bearer")).toBe(false);
    expect(hasUntrustedStructure("basic")).toBe(false);
    expect(hasUntrustedStructure("DPoP")).toBe(false);
  });

  it("scheme-word substrings inside other words do not trigger", () => {
    expect(hasUntrustedStructure("beamers and basics abound")).toBe(false);
    expect(hasUntrustedStructure("cardboardrop")).toBe(false);
  });

  it("static diagnostics without scheme words still pass verbatim", () => {
    const message = "authorization code replay cleanup failed";
    expect(hasUntrustedStructure(message)).toBe(false);
    expect(resolveAuthLogCall("warn", message, [])).toEqual({
      method: "warn",
      args: [`[auth] ${message}`],
    });
  });
});

describe("TERMINAL POLICY v3.1 — every R29–R36 shape fully redacted", () => {
  it.each(UNTRUSTED_SHAPES)(
    "shape %s: exact redaction marker, sentinel absent, no fragments",
    (_label, message) => {
      expect(hasUntrustedStructure(message)).toBe(true);
      for (const level of ["error", "warn", "info", "success"] as const) {
        const call = resolveAuthLogCall(level, message, [new Error("SECRET-err")]);
        const line = call?.args[0] ?? "";
        const label = level === "success" ? "info" : level;
        // Whole-message redaction: exact marker line (the Error marker
        // survives at error/warn only — constructor names carry nothing).
        if (level === "error" || level === "warn") {
          expect(line).toBe(`[auth] ${label} ${MESSAGE_REDACTED_MARKER} (Error: Error)`);
        } else {
          expect(line).toBe(`[auth] ${label} ${MESSAGE_REDACTED_MARKER}`);
        }
        expect(line).not.toContain("SECRET");
        expect(line).not.toContain("evil.example");
        expect(line).not.toContain("state");
        expect(line).not.toContain("Invalid origin");
      }
    },
  );

  it("the original message NEVER appears even as a prefix (no partial emission)", () => {
    const message = "Invalid origin: https://evil.example/cb?state=SECRET-v";
    const line = resolveAuthLogCall("error", message, [])?.args[0] ?? "";
    expect(line.startsWith("[auth] error [")).toBe(true);
    expect(line).not.toContain("Invalid");
    expect(line).not.toContain("origin");
    expect(line.length).toBe(`[auth] error `.length + MESSAGE_REDACTED_MARKER.length);
  });
});

describe("TERMINAL POLICY v3.1 — static messages with NO trigger character pass verbatim", () => {
  it.each([
    "authorization code replay cleanup failed",
    "user creation failed",
    "Invalid password",
    "user not found",
    "user slash john signed in",
  ])("static provider message %s passes verbatim (no triggers)", (message) => {
    expect(hasUntrustedStructure(message)).toBe(false);
    expect(resolveAuthLogCall("warn", message, [])).toEqual({
      method: "warn",
      args: [`[auth] ${message}`],
    });
    expect(resolveAuthLogCall("info", message, [])).toEqual({
      method: "info",
      args: [`[auth] ${message}`],
    });
  });

  it("verbatim messages are still truncated to 200 chars as a final safety", () => {
    // 220 x's push the sentinel past the 200-char truncation point.
    const long = `${"x".repeat(220)}SECRET-tail`;
    const line = resolveAuthLogCall("error", long, [])?.args[0] ?? "";
    expect(line).toBe(`[auth] ${"x".repeat(200)}`);
    expect(line).not.toContain("SECRET");
  });

  it("redaction marker line is fixed-length and never truncatable", () => {
    const long = `${"https://evil.example/".repeat(50)}?state=SECRET`;
    const line = resolveAuthLogCall("error", long, [])?.args[0] ?? "";
    expect(line).toBe(`[auth] error ${MESSAGE_REDACTED_MARKER}`);
    expect(line).not.toContain("SECRET");
  });
});
