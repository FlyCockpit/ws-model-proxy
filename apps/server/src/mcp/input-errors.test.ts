import { describe, expect, it, vi } from "vitest";

// input-errors.ts -> redaction.ts reads env at module scope.
vi.mock("@ws-model-proxy/env/server", () => ({
  env: { BETTER_AUTH_SECRET: "test-better-auth-secret", NODE_ENV: "test" },
}));
vi.mock("@ws-model-proxy/env/shared", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-better-auth-secret",
    DATABASE_URL: "postgresql://input-errors-test",
    NODE_ENV: "test",
  },
}));

const {
  fieldsFromValidationIssues,
  formatValidationIssues,
  MAX_ISSUES,
  MAX_MESSAGE_LENGTH,
  MAX_PATH_SEGMENTS,
  collectSchemaPropertyNames,
  sanitizeArgumentMessage,
  sanitizeDeclaredFields,
  sanitizeValidationIssues,
} = await import("./input-errors");

const SECRET = "wsmp_model_SUPERSECRETVALUE0123456789";
const PLAIN_SECRET = "hunter2-plain-secret-value";

const KNOWN = new Set([
  "a",
  "x",
  "poolId",
  "items",
  "name",
  "headers",
  "__proto__",
  "constructor",
  "prototype",
  "k0",
  "k1",
  "k2",
  "k3",
  "k4",
  "k5",
  "k6",
  "k7",
  "k8",
  "k9",
  "k10",
  "k11",
  "k12",
  "k13",
  "k14",
  "k15",
  "k16",
  "k17",
  "k18",
  "k19",
  "k20",
  "k21",
  "k22",
  "k23",
  "aaa",
]);

function sanitize(issues: unknown[], known: ReadonlySet<string> = KNOWN) {
  return sanitizeValidationIssues({ issues }, known);
}

describe("sanitizeValidationIssues", () => {
  it("keeps path, allowlisted code and schema-built message", () => {
    expect(
      sanitize([
        {
          code: "invalid_type",
          path: ["poolId"],
          message: "Invalid input: expected string, received undefined",
        },
      ]),
    ).toEqual([
      {
        path: ["poolId"],
        code: "invalid_type",
        message: "Invalid input: expected string, received undefined",
      },
    ]);
  });

  it.each([
    ["not an object", "x"],
    ["null", null],
    ["no issues key", {}],
    ["issues not an array", { issues: "boom" }],
    ["empty issues", { issues: [] }],
    ["only junk entries", { issues: [null, 3, "x"] }],
  ])("returns null for %s (caller keeps the plain error)", (_label, data) => {
    expect(sanitizeValidationIssues(data, KNOWN)).toBeNull();
  });

  it("does not read inherited data or issues", () => {
    expect(
      sanitizeValidationIssues(Object.create({ issues: [{ code: "custom" }] }), KNOWN),
    ).toBeNull();
  });

  // Table: a secret hiding in every field an issue can carry.
  it.each([
    ["message of a custom issue", { code: "custom", path: ["a"], message: `bad ${PLAIN_SECRET}` }],
    [
      "message of unrecognized_keys",
      {
        code: "unrecognized_keys",
        path: [],
        message: `Unrecognized key: "${PLAIN_SECRET}"`,
        keys: [PLAIN_SECRET],
      },
    ],
    ["unknown code message", { code: "made_up", path: [], message: PLAIN_SECRET }],
    ["no code", { path: [], message: PLAIN_SECRET }],
    ["code that embeds input", { code: PLAIN_SECRET, path: [], message: PLAIN_SECRET }],
    ["input field", { code: "invalid_type", path: ["a"], message: "m", input: PLAIN_SECRET }],
    ["received field", { code: "invalid_type", path: ["a"], message: "m", received: PLAIN_SECRET }],
    ["values field", { code: "invalid_value", path: ["a"], message: "m", values: [PLAIN_SECRET] }],
    [
      "nested union errors",
      {
        code: "invalid_union",
        path: ["a"],
        message: "Invalid input",
        errors: [[{ code: "custom", message: PLAIN_SECRET, path: [PLAIN_SECRET] }]],
      },
    ],
    ["free-text path segment", { code: "invalid_type", path: [PLAIN_SECRET], message: "m" }],
    [
      "path segment with spaces",
      { code: "invalid_type", path: [`a ${PLAIN_SECRET}`], message: "m" },
    ],
    [
      "symbol-like path segment",
      { code: "invalid_type", path: [{ key: PLAIN_SECRET }], message: "m" },
    ],
    [
      "object path segment",
      { code: "invalid_type", path: [{ toString: (): string => PLAIN_SECRET }], message: "m" },
    ],
  ])("never echoes a secret carried in: %s", (_label, issue) => {
    const issues = sanitize([issue]);
    // #200 names an identifier-shaped unrecognized key. The zod message that
    // quotes it stays the fixed text, and every other channel stays silent.
    if ("code" in issue && issue.code === "unrecognized_keys") {
      expect(issues?.[0]?.message).toBe("Unrecognized field");
      expect(issues?.[0]?.message).not.toContain(PLAIN_SECRET);
      expect(issues?.[0]?.unknownKeyCount).toBe(1);
      expect(issues?.[0]?.suggestions).toBeUndefined();
      expect(JSON.stringify(issues)).not.toContain(PLAIN_SECRET);
      return;
    }
    expect(JSON.stringify(issues)).not.toContain(PLAIN_SECRET);
  });

  it("only declared property names reach the path; caller-invented keys become '?'", () => {
    // A record key the caller chose (identifier-shaped, so shape alone cannot
    // tell it from a field name) is not a declared property.
    const issues = sanitize([
      { code: "invalid_type", path: ["headers", PLAIN_SECRET, "name"], message: "m" },
    ]);
    expect(issues?.[0]?.path).toEqual(["headers", "?", "name"]);
    expect(
      sanitize([{ code: "invalid_type", path: ["a"], message: "m" }], new Set())?.[0]?.path,
    ).toEqual(["?"]);
  });

  it("declared but non-identifier or over-long names are still masked", () => {
    const long = "a".repeat(65);
    const known = new Set(["a b", "1abc", long, "ok"]);
    const issues = sanitize(
      [{ code: "invalid_type", path: ["a b", "1abc", long, "ok"], message: "m" }],
      known,
    );
    expect(issues?.[0]?.path).toEqual(["?", "?", "?", "ok"]);
  });

  it("collects declared property names at every depth, including unions", () => {
    const names = collectSchemaPropertyNames({
      type: "object",
      properties: {
        a: { type: "object", properties: { deep: {} } },
        u: {
          oneOf: [{ properties: { viaUnion: {} } }, { items: { properties: { inItems: {} } } }],
        },
      },
    });
    expect([...names].sort()).toEqual(["a", "deep", "inItems", "u", "viaUnion"]);
    // Values are never names.
    expect(
      collectSchemaPropertyNames({ properties: { a: { const: "SECRETVALUE" } } }).has(
        "SECRETVALUE",
      ),
    ).toBe(false);
  });

  it("redacts wsmp credentials that look like an identifier path key", () => {
    const issues = sanitize(
      [{ code: "invalid_type", path: ["headers", SECRET], message: "m" }],
      new Set(["headers", SECRET]),
    );
    expect(JSON.stringify(issues)).not.toContain("SUPERSECRETVALUE");
  });

  it("replaces unrecognized_keys and custom messages with fixed text", () => {
    expect(
      sanitize([
        { code: "unrecognized_keys", path: ["x"], message: 'Unrecognized key: "k"' },
        { code: "custom", path: [], message: "anything" },
      ]),
    ).toEqual([
      { path: ["x"], code: "unrecognized_keys", message: "Unrecognized field" },
      { path: [], code: "custom", message: "Invalid value" },
    ]);
  });

  it("passes developer-written refinement messages when they echo no caller text", () => {
    const caller = { a: "LIMITED", poolId: "pool-1", headers: { Authorization: PLAIN_SECRET } };
    expect(
      sanitizeValidationIssues(
        {
          issues: [
            { code: "custom", path: ["a"], message: "Limited mode requires a limit" },
            { code: "custom", path: ["x"], message: `Unknown pool pool-1.` },
            { code: "custom", path: ["x"], message: `bad ${PLAIN_SECRET}` },
            { code: "custom", path: ["x"], message: "header Authorization is wrong" },
            { code: "custom", path: ["x"], message: "poolId and headers conflict" },
            { code: "custom", path: ["x"], message: "line\nbreak" },
            { code: "custom", path: ["x"], message: `leaked ${SECRET}` },
          ],
        },
        KNOWN,
        caller,
      )?.map((issue) => issue.message),
    ).toEqual([
      "Limited mode requires a limit",
      // Echoes a caller value or key: fixed text.
      "Invalid value",
      "Invalid value",
      "Invalid value",
      // Declared property names are schema text, not caller text.
      "poolId and headers conflict",
      // Control character: fixed text.
      "Invalid value",
      // Credential shape the caller never sent: fixed text.
      "Invalid value",
    ]);
  });

  it("does not echo unrecognized keys and suggests the nearest declared names", () => {
    const issues = sanitize(
      [
        {
          code: "unrecognized_keys",
          path: [],
          keys: ["capacityConcurrencyLimit", "not a key", SECRET, "k".repeat(65), 3],
          message: `Unrecognized key: "${PLAIN_SECRET}"`,
        },
      ],
      new Set(),
    );
    expect(issues).toEqual([
      {
        path: [],
        code: "unrecognized_keys",
        message: "Unrecognized field",
        unknownKeyCount: 5,
      },
    ]);
    expect(JSON.stringify(issues)).not.toContain(PLAIN_SECRET);
    expect(JSON.stringify(issues)).not.toContain("SUPERSECRETVALUE");
    expect(JSON.stringify(issues)).not.toContain("capacityConcurrencyLimit");
    expect(fieldsFromValidationIssues(issues ?? [])).toEqual([]);

    const suggested = sanitize(
      [
        {
          code: "unrecognized_keys",
          path: [],
          keys: ["poolid", "fallbackEnabledX"],
          message: 'Unrecognized key: "poolid"',
        },
      ],
      new Set(["poolId", "fallbackEnabled", "weight"]),
    );
    expect(suggested).toEqual([
      {
        path: [],
        code: "unrecognized_keys",
        message: "Unrecognized field",
        unknownKeyCount: 2,
        suggestions: ["fallbackEnabled", "poolId"],
      },
    ]);
    expect(fieldsFromValidationIssues(suggested ?? [])).toEqual([]);
  });

  it("suggests declared names for an unknown key nested inside an object", () => {
    const issues = sanitize(
      [
        {
          code: "unrecognized_keys",
          path: ["rules", 0],
          keys: ["treshold", PLAIN_SECRET],
          message: `Unrecognized keys: "treshold", "${PLAIN_SECRET}"`,
        },
      ],
      new Set(["rules", "threshold", "poolId"]),
    );
    expect(issues).toEqual([
      {
        path: ["rules", 0],
        code: "unrecognized_keys",
        message: "Unrecognized field",
        unknownKeyCount: 2,
        suggestions: ["threshold"],
      },
    ]);
    expect(JSON.stringify(issues)).not.toContain(PLAIN_SECRET);
    expect(JSON.stringify(issues)).not.toContain("treshold");
    // The failing object is named by its own path; suggestions never enter fields.
    expect(fieldsFromValidationIssues(issues ?? [])).toEqual(["rules.0"]);
    expect(formatValidationIssues(issues ?? [])).not.toContain(PLAIN_SECRET);
  });

  it("bounds unrecognized-key suggestion work", () => {
    const known = new Set(Array.from({ length: 400 }, (_, index) => `field_${index}`));
    const keys = Array.from({ length: 400 }, (_, index) => `zield_${index}`);
    const started = Date.now();
    const issues = sanitizeValidationIssues(
      { issues: [{ code: "unrecognized_keys", path: [], keys, message: "Unrecognized keys" }] },
      known,
    );
    expect(Date.now() - started).toBeLessThan(250);
    expect(issues?.[0]?.unknownKeyCount).toBe(400);
    expect((issues?.[0]?.suggestions ?? []).length).toBeLessThanOrEqual(5);
  });

  it("names nested issues as dotted paths", () => {
    const issues = sanitize(
      [
        {
          code: "too_small",
          path: ["rules", 0, "threshold"],
          message: "Number must be greater than 0",
        },
      ],
      new Set(["rules", "threshold", "poolId"]),
    );
    expect(issues?.[0]?.path).toEqual(["rules", 0, "threshold"]);
    expect(fieldsFromValidationIssues(issues ?? [])).toEqual(["rules.0.threshold"]);
  });

  it("keeps only declared data.fields and a static message", () => {
    expect(
      sanitizeDeclaredFields(
        { fields: ["capacityConcurrencyLimit", "notAField", "pool id", 1] },
        new Set(["capacityConcurrencyLimit", "poolId"]),
      ),
    ).toEqual(["capacityConcurrencyLimit"]);
    expect(sanitizeDeclaredFields(Object.create({ fields: ["poolId"] }), KNOWN)).toBeNull();
    expect(
      sanitizeDeclaredFields(
        {
          fields: [
            "advanced.contextMargin",
            "memberContextCeiling",
            "rules.0.threshold",
            "not.a.field",
            "0.leading",
            "advanced.",
            "pool id",
          ],
        },
        new Set(["advanced", "contextMargin", "memberContextCeiling", "rules", "threshold"]),
      ),
    ).toEqual(["advanced.contextMargin", "memberContextCeiling", "rules.0.threshold"]);
    expect(
      sanitizeArgumentMessage("  Effective concurrency limit exceeds physical capacity.  "),
    ).toBe("Effective concurrency limit exceeds physical capacity.");
    expect(sanitizeArgumentMessage(SECRET)).toBe("[redacted]");
    expect(sanitizeArgumentMessage("line\nbreak")).toBeNull();
    // Invisible format characters could make a copied message read differently.
    for (const hidden of ["\u202e", "\u200b", "\ufeff", "\u2066"])
      expect(sanitizeArgumentMessage(`Limit ${hidden}exceeded`)).toBeNull();
  });

  it("maps an unknown code to 'invalid' with a fixed message", () => {
    expect(sanitize([{ code: "surprise", path: ["a"], message: "m" }])).toEqual([
      { path: ["a"], code: "invalid", message: "Invalid value" },
    ]);
  });

  it("accepts standard-schema path segments ({ key }) and numeric indexes", () => {
    expect(
      sanitize([{ code: "invalid_type", path: ["items", 3, { key: "name" }], message: "m" }]),
    ).toEqual([{ path: ["items", 3, "name"], code: "invalid_type", message: "m" }]);
  });

  it("rejects negative, fractional and non-finite numeric segments", () => {
    const issues = sanitize([
      { code: "invalid_type", path: [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY], message: "m" },
    ]);
    expect(issues?.[0]?.path).toEqual(["?", "?", "?", "?"]);
  });

  it("neutralizes prototype-key paths without touching the prototype", () => {
    const issues = sanitize([
      { code: "invalid_type", path: ["__proto__", "constructor", "prototype"], message: "m" },
    ]);
    expect(issues?.[0]?.path).toEqual(["__proto__", "constructor", "prototype"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(issues?.[0] ?? {})).toBe(Object.prototype);
  });

  it("caps the number of issues, path segments and message length", () => {
    const many = Array.from({ length: MAX_ISSUES * 5 }, (_, index) => ({
      code: "invalid_type",
      path: Array.from({ length: MAX_PATH_SEGMENTS * 3 }, (_, i) => `k${i}`),
      message: `${"m".repeat(MAX_MESSAGE_LENGTH * 4)}${index}`,
    }));
    const issues = sanitize(many)!;
    expect(issues).toHaveLength(MAX_ISSUES);
    for (const issue of issues) {
      expect(issue.path).toHaveLength(MAX_PATH_SEGMENTS);
      expect(issue.message.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH + 3);
    }
    expect(JSON.stringify(issues).length).toBeLessThan(20_000);
  });

  it("keeps the message cap exact: 200 chars intact, 201 truncated", () => {
    const at = sanitize([
      { code: "invalid_type", path: [], message: "m".repeat(MAX_MESSAGE_LENGTH) },
    ]);
    expect(at?.[0]?.message).toHaveLength(MAX_MESSAGE_LENGTH);
    const over = sanitize([
      { code: "invalid_type", path: [], message: "m".repeat(MAX_MESSAGE_LENGTH + 1) },
    ]);
    expect(over?.[0]?.message).toBe(`${"m".repeat(MAX_MESSAGE_LENGTH)}...`);
  });

  it("caps an over-long path segment", () => {
    const issues = sanitize([{ code: "invalid_type", path: ["a".repeat(500)], message: "m" }]);
    expect(issues?.[0]?.path).toEqual(["?"]);
  });

  it("reads accessor-defined issue fields", () => {
    const hostile = {
      get code(): string {
        return "invalid_type";
      },
      path: ["a"],
      message: "m",
    };
    expect(sanitize([hostile])?.[0]?.code).toBe("invalid_type");
  });

  it("formats a readable one-liner", () => {
    expect(
      formatValidationIssues([
        { path: ["poolId"], code: "invalid_type", message: "Required" },
        { path: [], code: "custom", message: "Invalid value" },
        { path: ["a", 0, "b"], code: "too_small", message: "Too small" },
        {
          path: [],
          code: "unrecognized_keys",
          message: "Unrecognized field",
          unknownKeyCount: 1,
          suggestions: ["capacityConcurrencyLimit"],
        },
      ]),
    ).toBe(
      "poolId: Required; (input): Invalid value; a.0.b: Too small; (input): Unrecognized field (1); try capacityConcurrencyLimit",
    );
  });
});
