import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * WCAG 2.x contrast of the theme tokens in packages/ui globals.css. Text
 * colors must reach AA (4.5:1) on the surfaces they are used on, including
 * the translucent tints components put behind them (composited in sRGB, as
 * browsers do).
 */
const css = readFileSync(
  resolve(import.meta.dirname, "../../../../packages/ui/src/styles/globals.css"),
  "utf8",
);

type Rgb = [number, number, number];

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`missing ${selector}`);
  return css.slice(start, css.indexOf("\n}", start));
}

function token(scope: string, name: string, seen: string[] = []): Rgb {
  const source = block(scope);
  // An alias to another token of the same scope (`--state-loading: var(--muted-foreground)`).
  const aliased = new RegExp(`--${name}:\\s*var\\(--([\\w-]+)\\);`).exec(source);
  if (aliased?.[1] && !seen.includes(name)) return token(scope, aliased[1], [...seen, name]);
  const match = new RegExp(`--${name}:\\s*oklch\\(([\\d.]+) ([\\d.]+) ([\\d.]+)\\)`).exec(source);
  if (!match) throw new Error(`--${name} is not an oklch() literal in ${scope}`);
  return oklchToSrgb(Number(match[1]), Number(match[2]), Number(match[3]));
}

/** The declarations of the unlayered rule whose selector is exactly `selector`. */
function declarations(selector: string): Map<string, string> {
  const start = css.indexOf(`\n${selector} {\n`);
  if (start === -1) throw new Error(`Missing rule ${selector}`);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("\n}", start));
  const withoutComments = body.replace(/\/\*[\s\S]*?\*\//g, "");
  return new Map(
    [...withoutComments.matchAll(/([-\w]+)\s*:\s*([^;]+);/g)].map((m) => [
      m[1] ?? "",
      (m[2] ?? "").trim(),
    ]),
  );
}

/** The token a `var(--name)` value names. */
function alias(value: string | undefined): string | undefined {
  return /^var\(--([\w-]+)\)$/.exec(value ?? "")?.[1];
}

function oklchToSrgb(l: number, c: number, hue: number): Rgb {
  const a = c * Math.cos((hue * Math.PI) / 180);
  const b = c * Math.sin((hue * Math.PI) / 180);
  const lms = [
    (l + 0.3963377774 * a + 0.2158037573 * b) ** 3,
    (l - 0.1055613458 * a - 0.0638541728 * b) ** 3,
    (l - 0.0894841775 * a - 1.291485548 * b) ** 3,
  ] as const;
  const linear = [
    4.0767416621 * lms[0] - 3.3077115913 * lms[1] + 0.2309699292 * lms[2],
    -1.2684380046 * lms[0] + 2.6097574011 * lms[1] - 0.3413193965 * lms[2],
    -0.0041960863 * lms[0] - 0.7034186147 * lms[1] + 1.707614701 * lms[2],
  ];
  const encode = (x: number) => {
    const v = Math.min(1, Math.max(0, x));
    return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  };
  return [encode(linear[0] ?? 0), encode(linear[1] ?? 0), encode(linear[2] ?? 0)];
}

/** `fg` at `alpha` over `bg`, as `bg-x/NN` composites. */
function over(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return [0, 1, 2].map((i) => (fg[i] ?? 0) * alpha + (bg[i] ?? 0) * (1 - alpha)) as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  const decode = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * decode(r) + 0.7152 * decode(g) + 0.0722 * decode(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const AA = 4.5;

const buttonSource = readFileSync(
  resolve(import.meta.dirname, "../../../../packages/ui/src/lib/button-variants.ts"),
  "utf8",
);

/** Alpha of the default button's link hover fill (`<prefix>[a]:hover:bg-primary/NN`). */
function linkHoverAlpha(prefix: "" | "dark:"): number {
  const match = new RegExp(`(?:^|[\\s"])${prefix}\\[a\\]:hover:bg-primary/(\\d+)`).exec(
    buttonSource,
  );
  if (!match) throw new Error(`no ${prefix}[a]:hover:bg-primary/NN in button-variants.ts`);
  return Number(match[1]) / 100;
}

describe("theme token contrast (WCAG AA)", () => {
  it("keeps light-mode destructive text readable on every surface it sits on", () => {
    const destructive = token(":root", "destructive");
    const background = token(":root", "background");
    for (const surface of ["background", "card", "popover", "muted"]) {
      expect(contrast(destructive, token(":root", surface)), surface).toBeGreaterThanOrEqual(AA);
    }
    // The destructive button: `bg-destructive/10 text-destructive`.
    expect(contrast(destructive, over(destructive, 0.1, background))).toBeGreaterThanOrEqual(AA);
  });

  it("keeps dark-mode primary readable as text and under its own foreground", () => {
    const primary = token(".dark", "primary");
    for (const surface of ["background", "card", "popover", "muted"]) {
      expect(contrast(primary, token(".dark", surface)), surface).toBeGreaterThanOrEqual(AA);
    }
    expect(contrast(token(".dark", "primary-foreground"), primary)).toBeGreaterThanOrEqual(AA);
    // Selected options: `bg-primary/10` behind primary text.
    const background = token(".dark", "background");
    expect(contrast(primary, over(primary, 0.1, background))).toBeGreaterThanOrEqual(AA);
  });

  it("keeps the other primary and destructive pairs at AA", () => {
    expect(
      contrast(token(":root", "primary-foreground"), token(":root", "primary")),
    ).toBeGreaterThanOrEqual(AA);
    expect(
      contrast(token(":root", "primary"), token(":root", "background")),
    ).toBeGreaterThanOrEqual(AA);
    const darkDestructive = token(".dark", "destructive");
    const darkBackground = token(".dark", "background");
    expect(contrast(darkDestructive, darkBackground)).toBeGreaterThanOrEqual(AA);
    expect(contrast(darkDestructive, token(".dark", "card"))).toBeGreaterThanOrEqual(AA);
    // Dark destructive button: `dark:bg-destructive/20`.
    expect(
      contrast(darkDestructive, over(darkDestructive, 0.2, darkBackground)),
    ).toBeGreaterThanOrEqual(AA);
  });

  it("keeps the default link-button label readable on its hover fill", () => {
    // `[a]:hover:bg-primary/NN` lets the surface behind the button show through.
    for (const [scope, prefix] of [
      [":root", ""],
      [".dark", "dark:"],
    ] as const) {
      const alpha = linkHoverAlpha(prefix);
      const primary = token(scope, "primary");
      const foreground = token(scope, "primary-foreground");
      for (const surface of ["background", "card", "popover", "muted"]) {
        const fill = over(primary, alpha, token(scope, surface));
        expect(contrast(foreground, fill), `${scope} ${surface}`).toBeGreaterThanOrEqual(AA);
      }
    }
  });

  it.each([":root", ".dark"])(
    "%s state inks reach 4.5:1 on background, card and popover",
    (scope) => {
      // Badges, alerts and toasts write in these colours.
      for (const ink of ["state-success", "state-warning", "state-info", "state-loading"]) {
        for (const surface of ["background", "card", "popover"]) {
          expect(
            contrast(token(scope, ink), token(scope, surface)),
            `${scope} ${ink} on ${surface}`,
          ).toBeGreaterThanOrEqual(AA);
        }
      }
    },
  );

  it.each([":root", ".dark"])("%s toasts are a popover surface with 4.5:1 inks", (scope) => {
    // sileo's own palette inverts the theme; globals.css repaints it from the
    // tokens. Every state ink it maps and its text colour must hold up on the
    // fill it maps. See docs/ui.md § Shell rules
    const fill = alias(
      declarations(":root [data-sileo-viewport] :is([data-sileo-pill], [data-sileo-body])").get(
        "fill",
      ),
    );
    expect(fill).toBe("popover");
    const surface = token(scope, "popover");
    const viewport = declarations(":root [data-sileo-viewport]");
    for (const state of ["success", "loading", "error", "warning", "info", "action"]) {
      const ink = alias(viewport.get(`--sileo-state-${state}`));
      expect(ink, `--sileo-state-${state} maps to a token`).toBeDefined();
      expect(
        contrast(token(scope, ink ?? ""), surface),
        `${scope} toast ${state} (${ink}) on popover`,
      ).toBeGreaterThanOrEqual(AA);
    }
    // The badge ink sits on the pill itself (contrast above), not on a tint.
    expect(
      declarations(":root [data-sileo-viewport] [data-sileo-badge][data-state]").get(
        "--sileo-tone-bg",
      ),
    ).toBe("transparent");
    for (const selector of [
      ":root [data-sileo-viewport] [data-sileo-title][data-state]",
      ":root [data-sileo-viewport] [data-sileo-description]",
    ]) {
      expect(alias(declarations(selector).get("color")), selector).toBe("popover-foreground");
    }
    expect(contrast(token(scope, "popover-foreground"), surface)).toBeGreaterThanOrEqual(AA);
    // The action button: its label on its own tint of that label colour, at rest and hovered.
    const button = declarations(":root [data-sileo-viewport] [data-sileo-button][data-state]");
    expect(alias(button.get("--sileo-btn-color"))).toBe("popover-foreground");
    for (const property of ["--sileo-btn-bg", "--sileo-btn-bg-hover"]) {
      const tint = /^color-mix\(in oklch, var\(--([\w-]+)\) (\d+)%, transparent\)$/.exec(
        button.get(property) ?? "",
      );
      expect(tint?.[1], property).toBe("popover-foreground");
      const label = token(scope, "popover-foreground");
      const fill = over(label, Number(tint?.[2]) / 100, surface);
      expect(contrast(label, fill), `${scope} action label on ${property}`).toBeGreaterThanOrEqual(
        AA,
      );
    }
  });

  it("writes a state -foreground ink only on its own solid state fill", () => {
    // `--state-*-foreground` is the text colour ON a solid `bg-state-*` (white on the light
    // warning since its retune), so as plain text on a page or card it would vanish. Text on a
    // surface uses the state ink itself (`text-state-warning`), which the test above holds to 4.5:1.
    const offenders: string[] = [];
    for (const dir of ["apps/web/src", "packages/ui/src"]) {
      const root = resolve(import.meta.dirname, "../../../..", dir);
      for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile() || !/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name))
          continue;
        const file = join(entry.parentPath, entry.name);
        readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, index) => {
            for (const match of line.matchAll(/text-state-([a-z]+)-foreground/g)) {
              if (!new RegExp(`(?<![\\w-])bg-state-${match[1]}(?![\\w/-])`).test(line))
                offenders.push(`${file}:${index + 1}`);
            }
          });
      }
    }
    expect(offenders).toEqual([]);
  });

  it("measures the old tokens as failing, so the check discriminates", () => {
    const oldLight = oklchToSrgb(0.577, 0.245, 27.325);
    expect(contrast(oldLight, token(":root", "muted"))).toBeLessThan(AA);
    const oldDark = oklchToSrgb(0.437, 0.078, 188.216);
    expect(contrast(oldDark, token(".dark", "background"))).toBeLessThan(AA);
    // The old 80% link hover fill under the new dark primary.
    const darkPrimary = token(".dark", "primary");
    const darkHover = over(darkPrimary, 0.8, token(".dark", "background"));
    expect(contrast(token(".dark", "primary-foreground"), darkHover)).toBeLessThan(AA);
    // The old light warning and info inks (2.2:1 and 4.3:1 on white).
    expect(contrast(oklchToSrgb(0.75, 0.18, 85), token(":root", "popover"))).toBeLessThan(AA);
    expect(contrast(oklchToSrgb(0.58, 0.16, 250), token(":root", "popover"))).toBeLessThan(AA);
  });
});
