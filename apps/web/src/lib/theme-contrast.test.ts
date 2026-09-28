import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

function token(scope: string, name: string): Rgb {
  const match = new RegExp(`--${name}:\\s*oklch\\(([\\d.]+) ([\\d.]+) ([\\d.]+)\\)`).exec(
    block(scope),
  );
  if (!match) throw new Error(`--${name} is not an oklch() literal in ${scope}`);
  return oklchToSrgb(Number(match[1]), Number(match[2]), Number(match[3]));
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

  it("measures the old tokens as failing, so the check discriminates", () => {
    const oldLight = oklchToSrgb(0.577, 0.245, 27.325);
    expect(contrast(oldLight, token(":root", "muted"))).toBeLessThan(AA);
    const oldDark = oklchToSrgb(0.437, 0.078, 188.216);
    expect(contrast(oldDark, token(".dark", "background"))).toBeLessThan(AA);
  });
});
