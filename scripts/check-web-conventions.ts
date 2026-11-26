/**
 * Fast, syntax-only shell and theme contracts (docs/ui.md § Shell rules).
 * `pnpm policy:web-conventions` (part of `pnpm check:ci`); no app imports or I/O beyond source reads.
 * Fixtures: scripts/check-web-conventions.test.ts (`pnpm policy:web-conventions:test`, also in check:ci).
 *
 *   G8: <main> reserves no scrollbar gutter, and no route renders a site <footer>.
 *   G9: no literal colour or prefers-color-scheme query outside packages/ui/src/styles/globals.css.
 *   G10: text scales and stays at least 12px: no px font size in any class list in web source
 *        (className, cva() variants, constants, other *ClassName props), which does not follow the
 *        root viewport scale, no rem size below 0.75, no em size below 1, and no other size
 *        (vw, cqi, pt, expressions) without a 0.75rem floor (max()/clamp()) or with a px term.
 *        docs/ui.md § Viewport scale
 *   G11: route files reach the session only through resolveRouteSession() (lib/route-session.ts),
 *        which checks the document's identity: no reference to getRouteSession or to the
 *        server/auth-session module (an import under any name, a namespace or dynamic import, a
 *        re-export). docs/ui.md § Query cache follows identity
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, posix } from "node:path";

const { parse } = createRequire(import.meta.url)("@babel/parser") as typeof import("@babel/parser");

type Node = { type: string; [key: string]: unknown };
type Binding = {
  value?: Node | undefined;
  ancestors: Node[];
  source?: string | undefined;
  imported?: string;
};
export type Finding = { file: string; line: number; rule: string; message: string };

function node(value: unknown): Node | undefined {
  return value !== null && typeof value === "object" && "type" in value
    ? (value as Node)
    : undefined;
}
function name(value: unknown): string | undefined {
  const n = node(value);
  return n?.type === "Identifier" || n?.type === "JSXIdentifier"
    ? String(n.name)
    : n?.type === "StringLiteral"
      ? String(n.value)
      : undefined;
}
function children(value: unknown): Node[] {
  return Array.isArray(value) ? value.flatMap((item) => node(item) ?? []) : [];
}
function walk(n: Node, ancestors: Node[], visit: (n: Node, ancestors: Node[]) => void): void {
  visit(n, ancestors);
  for (const [key, value] of Object.entries(n)) {
    if (["loc", "tokens", "comments"].includes(key) || key.endsWith("Comments")) continue;
    for (const child of Array.isArray(value) ? children(value) : [node(value)]) {
      if (child) walk(child, [...ancestors, n], visit);
    }
  }
}
function line(n: Node): number {
  return (n.loc as { start: { line: number } } | undefined)?.start.line ?? 1;
}
function offsetLine(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}
function unwrap(n: Node | undefined): Node | undefined {
  while (
    n &&
    [
      "TSAsExpression",
      "TSSatisfiesExpression",
      "TSNonNullExpression",
      "ParenthesizedExpression",
    ].includes(n.type)
  )
    n = node(n.expression);
  return n;
}
function property(n: Node | undefined): string | undefined {
  return n && (!n.computed || node(n.property)?.type === "StringLiteral")
    ? name(n.property)
    : undefined;
}
function isScope(n: Node): boolean {
  return [
    "Program",
    "BlockStatement",
    "ArrowFunctionExpression",
    "FunctionExpression",
    "FunctionDeclaration",
    "CatchClause",
  ].includes(n.type);
}

/** Local binding provenance prevents aliased imports bypassing rules and shadowed names triggering them. */
function bindings(ast: Node) {
  const scopes = new WeakMap<Node, Map<string, Binding>>();
  function put(scope: Node | undefined, id: unknown, binding: Binding): void {
    if (!scope) return;
    const n = node(id);
    if (n?.type === "Identifier") {
      if (!scopes.has(scope)) scopes.set(scope, new Map());
      scopes.get(scope)?.set(String(n.name), binding);
    } else if (n?.type === "ObjectPattern" || n?.type === "ArrayPattern") {
      for (const part of children(n.properties ?? n.elements))
        put(scope, part.type === "ObjectProperty" ? part.value : part, {
          ancestors: binding.ancestors,
        });
    } else if (n?.type === "AssignmentPattern") put(scope, n.left, binding);
    else if (n?.type === "RestElement") put(scope, n.argument, binding);
  }
  walk(ast, [], (n, ancestors) => {
    const scope = [...ancestors].reverse().find(isScope);
    if (n.type === "VariableDeclarator") {
      const declaration = ancestors.at(-1);
      const owner =
        declaration?.kind === "var"
          ? [...ancestors].reverse().find((item) => isScope(item) && item.type !== "BlockStatement")
          : scope;
      put(owner, n.id, { value: node(n.init), ancestors });
    }
    if (n.type === "FunctionDeclaration") put(scope, n.id, { value: n, ancestors });
    if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(n.type)) {
      for (const param of children(n.params)) put(n, param, { ancestors: [...ancestors, n] });
    }
    if (n.type === "CatchClause") put(n, n.param, { ancestors: [...ancestors, n] });
    if (n.type === "ImportDeclaration" && n.importKind !== "type") {
      for (const spec of children(n.specifiers)) {
        if (spec.importKind !== "type")
          put(scope, spec.local, {
            ancestors,
            source: name(n.source),
            imported:
              spec.type === "ImportNamespaceSpecifier" ? "*" : (name(spec.imported) ?? "default"),
          });
      }
    }
  });
  function lookup(id: string, ancestors: Node[]): Binding | undefined {
    for (const ancestor of [...ancestors].reverse()) {
      const found = scopes.get(ancestor)?.get(id);
      if (found) return found;
    }
    return undefined;
  }
  function resolve(
    n: Node | undefined,
    ancestors: Node[],
    seen = new Set<Node>(),
  ): { value?: Node | undefined; ancestors: Node[] } {
    n = unwrap(n);
    if (n?.type !== "Identifier" || seen.has(n)) return { value: n, ancestors };
    seen.add(n);
    const binding = lookup(String(n.name), ancestors);
    return binding?.value
      ? resolve(binding.value, binding.ancestors, seen)
      : { value: n, ancestors };
  }
  function imported(
    n: Node | undefined,
    ancestors: Node[],
    source: string,
    symbol: string,
  ): boolean {
    const resolved = resolve(n, ancestors);
    n = resolved.value;
    if (n?.type === "Identifier") {
      const binding = lookup(String(n.name), resolved.ancestors);
      return binding?.source === source && binding.imported === symbol;
    }
    if (
      ["MemberExpression", "OptionalMemberExpression"].includes(n?.type ?? "") &&
      property(n) === symbol
    ) {
      const binding = lookup(name(n?.object) ?? "", resolved.ancestors);
      return binding?.source === source && binding.imported === "*";
    }
    return false;
  }
  return { lookup, resolve, imported };
}

type Context = ReturnType<typeof bindings>;
/** A style object's entries (key, static text, property node), following bindings and spreads. */
function styleEntries(
  n: Node | undefined,
  ancestors: Node[],
  context: Context,
  depth = 0,
): Array<{ key: string; text: string; at: Node }> {
  if (depth > 20) return [];
  const resolved = context.resolve(n, ancestors);
  if (resolved.value?.type !== "ObjectExpression") return [];
  return children(resolved.value.properties).flatMap((prop) => {
    if (prop.type === "SpreadElement")
      return styleEntries(node(prop.argument), resolved.ancestors, context, depth + 1);
    if (prop.type !== "ObjectProperty") return [];
    const value = context.resolve(node(prop.value), resolved.ancestors).value;
    const text =
      value?.type === "StringLiteral"
        ? String(value.value)
        : value?.type === "TemplateLiteral"
          ? children(value.quasis)
              .map((q) => String((q.value as { raw?: string })?.raw))
              .join(" ")
          : "";
    const key = prop.computed
      ? name(context.resolve(node(prop.key), resolved.ancestors).value)
      : name(prop.key);
    // Reported at the property, so a theme-exempt comment above a multiline style's entry applies.
    return [{ key: key ?? "", text, at: prop }];
  });
}

type ClassSet = { tokens: string[]; when: Map<string, boolean> };
const classSet = (tokens: string[] = []): ClassSet => ({ tokens, when: new Map() });
function combine(left: ClassSet[], right: ClassSet[]): ClassSet[] {
  const result: ClassSet[] = [];
  for (const a of left)
    for (const b of right) {
      if ([...b.when].some(([key, value]) => a.when.has(key) && a.when.get(key) !== value))
        continue;
      result.push({ tokens: [...a.tokens, ...b.tokens], when: new Map([...a.when, ...b.when]) });
      if (result.length > 128)
        throw new Error(
          "Too many static class branches. Fix: split the conditional classes into fewer branches.",
        );
    }
  return result;
}
/** Preserve exclusive branches and correlate repeated simple conditions within cn/arrays/templates. */
function classSets(root: Node | undefined, rootAncestors: Node[], context: Context): ClassSet[] {
  const conditionIds = new Map<Binding | string, number>();
  function condition(n: Node | undefined, ancestors: Node[], truthy: boolean): ClassSet[] {
    n = unwrap(n);
    if (n?.type === "UnaryExpression" && n.operator === "!")
      return condition(node(n.argument), ancestors, !truthy);
    const resolved = context.resolve(n, ancestors).value;
    if (resolved?.type === "BooleanLiteral") return resolved.value === truthy ? [classSet()] : [];
    if (n?.type !== "Identifier") return [classSet()]; // complex expressions are not assumed equivalent
    const binding = context.lookup(String(n.name), ancestors) ?? String(n.name);
    if (!conditionIds.has(binding)) conditionIds.set(binding, conditionIds.size);
    return [{ tokens: [], when: new Map([[String(conditionIds.get(binding)), truthy]]) }];
  }
  function collect(n: Node | undefined, ancestors: Node[], depth: number): ClassSet[] {
    if (!n || depth > 20) return [classSet()];
    const resolved = context.resolve(n, ancestors);
    n = resolved.value;
    ancestors = resolved.ancestors;
    const recur = (value: unknown) => collect(node(value), ancestors, depth + 1);
    const branch = (test: unknown, truthy: boolean, choices: ClassSet[]) =>
      combine(condition(node(test), ancestors, truthy), choices);
    if (!n) return [classSet()];
    if (n.type === "JSXExpressionContainer") return recur(n.expression);
    if (n.type === "StringLiteral") return [classSet(String(n.value).split(/\s+/).filter(Boolean))];
    if (n.type === "TemplateLiteral") {
      // Literal portions only; dynamically constructed utility names are outside this finite proof.
      return children(n.quasis).reduce(
        (sets, quasi, index) => {
          const raw = (quasi.value as { raw: string }).raw;
          const parts = [classSet(raw.split(/\s+/).filter(Boolean))];
          return combine(combine(sets, parts), recur(children(n?.expressions)[index]));
        },
        [classSet()],
      );
    }
    if (n.type === "ConditionalExpression")
      return [
        ...branch(n.test, true, recur(n.consequent)),
        ...branch(n.test, false, recur(n.alternate)),
      ];
    if (n.type === "LogicalExpression") {
      if (n.operator === "&&")
        return [...branch(n.left, false, [classSet()]), ...branch(n.left, true, recur(n.right))];
      return [...branch(n.left, true, recur(n.left)), ...branch(n.left, false, recur(n.right))];
    }
    if (n.type === "BinaryExpression" && n.operator === "+")
      return combine(recur(n.left), recur(n.right));
    if (n.type === "ArrayExpression")
      return children(n.elements).reduce((sets, item) => combine(sets, recur(item)), [classSet()]);
    if (
      n.type === "CallExpression" &&
      (["cn", "clsx", "classnames"].includes(name(n.callee) ?? "") ||
        context.imported(node(n.callee), ancestors, "@ws-model-proxy/ui/lib/utils", "cn"))
    ) {
      return children(n.arguments).reduce((sets, item) => combine(sets, recur(item)), [classSet()]);
    }
    if (n.type === "ObjectExpression")
      return children(n.properties).reduce(
        (sets, prop) => {
          if (prop.type === "SpreadElement") return combine(sets, recur(prop.argument));
          if (prop.type !== "ObjectProperty" || prop.computed) return sets;
          const tokens = (name(prop.key) ?? "").split(/\s+/).filter(Boolean);
          return combine(sets, [
            ...branch(prop.value, false, [classSet()]),
            ...branch(prop.value, true, [classSet(tokens)]),
          ]);
        },
        [classSet()],
      );
    return [classSet()];
  }
  return collect(root, rootAncestors, 0);
}

/** Split only outside arbitrary Tailwind variants such as [&:hover]:. */
function utility(token: string): { prefix: string; base: string } {
  let bracketDepth = 0;
  let boundary = -1;
  for (let i = 0; i < token.length; i++) {
    if (token[i] === "[") bracketDepth++;
    else if (token[i] === "]") bracketDepth--;
    else if (token[i] === ":" && bracketDepth === 0) boundary = i;
  }
  return {
    prefix: token.slice(0, boundary + 1),
    base: token.slice(boundary + 1).replace(/^!|!$/g, ""),
  };
}
/**
 * Elements whose <footer> is that element's own (author line, citation, card
 * actions), not site chrome: HTML's sectioning content and sectioning roots.
 */
const SECTION_TAGS = new Set([
  "article",
  "aside",
  "nav",
  "section",
  "blockquote",
  "details",
  "dialog",
  "fieldset",
  "figure",
  "td",
]);
/** `text` split at `separator` characters that sit outside every (…) and […]. */
function splitTopLevel(text: string, separator: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] ?? "";
    if (char === "(" || char === "[") depth++;
    else if (char === ")" || char === "]") depth--;
    else if (depth === 0 && separator.test(char)) {
      parts.push(text.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(text.slice(from));
  return parts.map((part) => part.trim()).filter(Boolean);
}
/**
 * Whether a selector list styles `<main>` / `#main-content` itself: some selector's last compound
 * names it, directly or through one of the alternatives of `:is()`, `:where()` or `:matches()`
 * (`:is(main, #main-content)`). `:not()` and `:has()` arguments never name the styled element.
 */
function targetsMain(selectorList: string, depth = 0): boolean {
  if (depth > 10) return false;
  return splitTopLevel(selectorList, /,/).some((selector) => {
    const target = splitTopLevel(selector, /[\s>+~]/).at(-1) ?? "";
    const alternatives: string[] = [];
    let own = "";
    for (let i = 0; i < target.length; i++) {
      const open = /^:(is|where|matches|not|has)\(/i.exec(target.slice(i));
      if (!open) {
        own += target[i];
        continue;
      }
      let level = 0;
      let close = i + open[0].length - 1;
      for (; close < target.length; close++) {
        if (target[close] === "(") level++;
        else if (target[close] === ")" && --level === 0) break;
      }
      const name = open[1]?.toLowerCase();
      if (name !== "not" && name !== "has")
        alternatives.push(target.slice(i + open[0].length, close));
      i = close;
    }
    return (
      /^main(?![\w-])|#main-content(?![\w-])/.test(own) ||
      alternatives.some((list) => targetsMain(list, depth + 1))
    );
  });
}
/** The theme's token file: the one place literal colours and color-scheme queries belong. */
const THEME_TOKENS = "packages/ui/src/styles/globals.css";
const LITERAL_COLOR = /#[0-9a-f]{3,8}(?![\w-])|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;
/**
 * A CSS `url(…)` value: `url(#fade)`, `url(/shapes.svg#fade)`, `url("data:…")`. Its `#…` is an element
 * reference (clip path, mask, gradient), not a colour, so the whole value is dropped before the check;
 * a colour next to it (`url(#grad) #fff`) still counts.
 */
const CSS_URL = /\burl\(\s*(?:"[^"]*"|'[^']*'|[^)"']*)\s*\)/gi;
/**
 * The CSS named colours (all 148 of CSS Color 4), checked only in the values of colour-bearing
 * properties (`color`, `background`, `border-color`, `fill`…) and colour utilities (`bg-[white]`),
 * so a word like "red" in a font name or content is not one. `transparent` and `currentColor`
 * follow the theme, so they are not listed.
 */
const NAMED_COLORS = new Set(
  `
  aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet
  brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan
  darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen
  darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey
  darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite
  forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew
  hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue
  lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon
  lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime
  limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple
  mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue
  mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid
  palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum
  powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen
  seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal
  thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen
`
    .split(/\s+/)
    .filter(Boolean),
);
function hasNamedColor(value: string): boolean {
  // Whole words only: `var(--brand-red)` and `bg-red-500` name no colour here.
  return (value.toLowerCase().match(/(?<![\w-])[a-z]+(?![\w-])/g) ?? []).some((word) =>
    NAMED_COLORS.has(word),
  );
}
const COLOR_PROPERTY =
  /^(?:--[\w-]*colou?r[\w-]*|color|background(?:-color)?|border(?:-[\w-]+)?|outline(?:-color)?|fill|stroke|caret-color|accent-color|text-decoration(?:-color)?|column-rule(?:-color)?|box-shadow|text-shadow|scrollbar-color|stop-color|flood-color|lighting-color)$/i;
function hasLiteralColor(text: string, property = ""): boolean {
  const value = text.replace(CSS_URL, "url()");
  return (
    LITERAL_COLOR.test(value) ||
    (COLOR_PROPERTY.test(property.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)) &&
      hasNamedColor(value))
  );
}
/**
 * A Tailwind arbitrary property with a literal colour value: `[scrollbar-color:#3a414b_transparent]`,
 * `[background:rgb(0_0_0)]`, `[color:white]`. Underscores are the spaces of its value.
 */
function arbitraryPropertyColor(base: string): boolean {
  const match = /^\[([\w-]+):(.*)\]$/.exec(base);
  return !!match && hasLiteralColor((match[2] ?? "").replace(/_/g, " "), match[1] ?? "");
}
/** Utilities whose arbitrary value is a colour when it is a bare word: `bg-[white]`, `fill-[navy]`. */
const COLOR_UTILITY =
  /^(?:bg|text|border(?:-[xytrblse])?|fill|stroke|shadow|ring|ring-offset|outline|decoration|accent|caret|from|via|to|divide|placeholder|inset-shadow|drop-shadow)$/;
/**
 * A Tailwind arbitrary value with a literal colour anywhere in it: `bg-[#fff]`, `text-[oklch(…)]`,
 * `bg-[linear-gradient(#fff,#000)]`, `shadow-[0_0_4px_#fff]`, `border-[color:#fff]`, `bg-[white]`,
 * also with an opacity modifier (`bg-[#fff]/50`). Underscores are the spaces of its value.
 */
function arbitraryValueColor(base: string): boolean {
  const match = /^([a-z][\w-]*?)-\[(.+)\](?:\/[\w.%[\]-]+)?$/.exec(base);
  if (!match) return false;
  const payload = (match[2] ?? "").replace(/_/g, " ");
  const hint = /^([a-z-]+):(.*)$/.exec(payload);
  const value = hint && !/^url$/i.test(hint[1] ?? "") ? (hint[2] ?? "") : payload;
  return (
    hasLiteralColor(value) ||
    ((hint?.[1] === "color" || COLOR_UTILITY.test(match[1] ?? "")) &&
      hasNamedColor(value.replace(CSS_URL, "url()")))
  );
}
const THEME_MESSAGE =
  "follows the OS or a fixed colour instead of the app theme (stored choice > OS, the `.dark` class). Fix: use the theme tokens (bg-popover, text-foreground, var(--state-*)…) and `dark:` variants; new colours become tokens in packages/ui/src/styles/globals.css (docs/ui.md, Shell rules).";
/**
 * G10: an arbitrary font size that is not provably at least 12px and scaling: a px size
 * (`text-[13px]`, `text-[10px]/4`), which does not follow the root viewport scale; rem below 0.75
 * (12px); em below 1, which drops under 12px inside 12px text; and any other expression holding a
 * length unless it has a rem floor of at least 0.75: `max(…, 0.75rem)` or `clamp(0.75rem, …, …)`
 * (`text-[length:max(0.9em,0.75rem)]` passes, `calc(0.9em)` doesn't). Viewport and other units
 * (`2vw`, `cqi`, `pt`) need the same floor, and a px term anywhere in the expression is rejected:
 * `max(24px, 0.75rem)` stays a fixed 24px through the scale. Values without a length (variables,
 * colours) are not font sizes it can judge.
 */
const LENGTH =
  /\d(?:px|r?em|[sdl]?v(?:w|h|i|b|min|max)|cq(?:w|h|i|b|min|max)|ch|ex|lh|rlh|pt|pc|cm|mm|in|q)(?![a-z])/i;
function fixedOrTinyText(base: string): boolean {
  const match = /^text-\[(?:length:)?(.+?)\](?:\/[\w.%[\]()-]+)?$/.exec(base);
  const value = match?.[1]?.replaceAll("_", " ").trim();
  // An explicitly typed percentage is a font size relative to the parent: like em, below 100 % it
  // drops under 12px inside 12px text. (An untyped `text-[50%]` is left alone: it may be a colour.)
  const percent = /^text-\[length:(\d*\.?\d+)%\]/.exec(base);
  if (percent) return Number(percent[1]) < 100;
  // A percentage inside a typed expression (`length:calc(50%)`) is judged like any other length.
  const typedPercent = base.startsWith("text-[length:") && /\d%/.test(value ?? "");
  if (!value || (!typedPercent && !LENGTH.test(value))) return false;
  if (/\dpx(?![a-z])/i.test(value)) return true;
  const plain = /^(\d*\.?\d+)([a-z]+)$/i.exec(value);
  if (plain) {
    const size = Number(plain[1]);
    if (plain[2] === "rem") return size < 0.75;
    if (plain[2] === "em") return size < 1;
    return true;
  }
  const fn = /^(max|clamp)\((.*)\)$/.exec(value);
  if (!fn?.[2]) return true;
  const args: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of fn[2]) {
    if (char === "(") depth++;
    else if (char === ")") depth--;
    if (char === "," && depth === 0) {
      args.push(current.trim());
      current = "";
    } else current += char;
  }
  args.push(current.trim());
  const floors = fn[1] === "max" ? args : args.length === 3 ? [args[0] ?? ""] : [];
  return !floors.some((arg) => {
    const rem = /^(\d*\.?\d+)rem$/.exec(arg);
    return rem !== null && Number(rem[1]) >= 0.75;
  });
}
const FIXED_TEXT_MESSAGE =
  "a px size does not grow with the large-screen root scale, and no text is smaller than 12px. Fix: use the type scale, text-xs (12px) at the smallest, or give a relative size a floor (text-[max(0.9em,0.75rem)]); a label that does not fit wraps or ends in an ellipsis (docs/ui.md § Viewport scale).";
function isThemeScanned(file: string): boolean {
  return (
    /^(apps\/web|packages\/ui)\/src\//.test(file) &&
    file !== THEME_TOKENS &&
    !/\.test\.[cm]?[jt]sx?$/.test(file)
  );
}
/**
 * A deliberate fixed colour (a QR code that must stay dark-on-white to scan, a chess board, a share
 * image) carries `theme-exempt: <reason>` in a comment on the line above it, on its line, or inside
 * the flagged className/style value; the reason is required. G9 skips that finding and nothing else.
 */
const THEME_EXEMPT = /theme-exempt:\s*\S.{3,}/;
function withoutThemeExemptions(
  source: string,
  findings: Finding[],
  ends: ReadonlyMap<Finding, number> = new Map(),
): Finding[] {
  const lines = source.split("\n");
  const exempt = (finding: Finding) =>
    lines
      .slice(Math.max(0, finding.line - 2), ends.get(finding) ?? finding.line)
      .some((text) => THEME_EXEMPT.test(text));
  return findings.filter((finding) => finding.rule !== "G9" || !exempt(finding));
}
/** G11 scans non-test route files (the route test files mock the session modules). */
function isRouteScanned(file: string): boolean {
  return file.startsWith("apps/web/src/routes/") && !/\.test\.[cm]?[jt]sx?$/.test(file);
}
const ROUTE_SESSION_MODULE = "apps/web/src/server/auth-session";
/** A module specifier that names apps/web/src/server/auth-session (alias or relative, any extension). */
function isRouteSessionModule(file: string, specifier: string): boolean {
  const path = specifier.startsWith("@/")
    ? `apps/web/src/${specifier.slice(2)}`
    : specifier.startsWith(".")
      ? posix.join(posix.dirname(file), specifier)
      : specifier;
  return path.replace(/\.[cm]?[jt]sx?$/, "").replace(/\/index$/, "") === ROUTE_SESSION_MODULE;
}
const ROUTE_SESSION_MESSAGE =
  "A route file reaches the session without the document identity check, so a page could render the previous account's cached data after a sign-out or an account switch. Fix: call resolveRouteSession() from @/lib/route-session (docs/ui.md § Query cache follows identity).";

export function scanWebSource(file: string, source: string): Finding[] {
  const findings: Finding[] = [];
  // Where each finding's flagged node ends, so a theme-exempt comment inside a multiline
  // className/style value (above the literal it covers) still applies.
  const ends = new Map<Finding, number>();
  const add = (n: Node, rule: string, message: string) => {
    const finding = { file, line: line(n), rule, message };
    ends.set(finding, (n.loc as { end: { line: number } } | undefined)?.end.line ?? finding.line);
    findings.push(finding);
  };
  let ast: Node;
  try {
    ast = parse(source, {
      sourceType: "unambiguous",
      // JSX only where it can occur: in a .ts file, `<T>(value: T) => …` is a generic arrow.
      plugins: /\.[cm]?ts$/.test(file) ? ["typescript"] : ["typescript", "jsx"],
      allowUndeclaredExports: true,
    }) as unknown as Node;
  } catch (error) {
    const location = (error as { loc?: { line?: number } }).loc;
    return [
      {
        file,
        line: location?.line ?? 1,
        rule: "parse",
        message: `Cannot parse source: ${(error as Error).message}. Fix the syntax and rerun pnpm policy:web-conventions.`,
      },
    ];
  }
  const context = bindings(ast);
  const routeSessionLines = new Set<number>();
  walk(ast, [], (n, ancestors) => {
    if (n.type === "JSXOpeningElement") {
      const attrs = children(n.attributes);
      const tag = name(n.name);
      for (const attr of attrs) {
        if (name(attr.name) !== "className") continue;
        let sets: ClassSet[];
        try {
          sets = classSets(node(attr.value), ancestors, context);
        } catch (error) {
          add(attr, "parse", (error as Error).message);
          continue;
        }
        const gutters = new Set<string>();
        const colors = new Set<string>();
        for (const set of sets) {
          for (const u of set.tokens.map(utility)) {
            if (tag === "main" && /scrollbar-gutter:(?!auto\])/.test(u.base)) gutters.add(u.base);
            if (
              isThemeScanned(file) &&
              (arbitraryValueColor(u.base) || arbitraryPropertyColor(u.base))
            )
              colors.add(u.base);
          }
        }
        if (gutters.size)
          add(
            attr,
            "G8",
            `The page scroller reserves a scrollbar gutter (${[...gutters].join(", ")}), so every full-bleed rule inside it (footer, sub-nav, banners) stops short of the viewport edge with classic scrollbars. Fix: remove it from <main>; nested panes may keep it (docs/ui.md, Shell rules).`,
          );
        if (colors.size)
          add(attr, "G9", `Literal colour class (${[...colors].join(", ")}) ${THEME_MESSAGE}`);
      }
      const style = attrs.find((attr) => name(attr.name) === "style");
      const styleValue = node(style?.value);
      if (style && styleValue?.type === "JSXExpressionContainer") {
        for (const entry of styleEntries(node(styleValue.expression), ancestors, context)) {
          if (isThemeScanned(file) && hasLiteralColor(entry.text, entry.key))
            add(
              entry.at,
              "G9",
              `A literal colour in an inline style (${entry.text}) ${THEME_MESSAGE}`,
            );
          if (tag === "main" && entry.key === "scrollbarGutter" && !/^\s*auto\s*$/.test(entry.text))
            add(
              entry.at,
              "G8",
              `The page scroller reserves a scrollbar gutter (scrollbarGutter: ${entry.text || "a dynamic value"}), so every full-bleed rule inside it (footer, sub-nav, banners) stops short of the viewport edge with classic scrollbars. Fix: remove it from <main>; nested panes may keep it (docs/ui.md, Shell rules).`,
            );
        }
      }
      if (
        tag === "footer" &&
        file.startsWith("apps/web/src/routes/") &&
        !ancestors.some(
          (a) =>
            a.type === "JSXElement" && SECTION_TAGS.has(name(node(a.openingElement)?.name) ?? ""),
        )
      )
        add(
          n,
          "G8",
          "A route renders a site footer, which follows the page content instead of sitting at the bottom of a short page and repeats per page. Fix: site footer content goes in one shared footer component that the shell renders as the last box of its `flex min-h-full flex-col` column inside <main>; a footer that belongs to an <article>, <section> or similar stays inside that element (docs/ui.md, Shell rules).",
        );
    }
    // G11: any code reference (a call, an import under any name, a member access) to
    // getRouteSession, and any string naming its module (static, dynamic, type or re-export
    // import). Comments and other strings are not code, so they pass.
    if (isRouteScanned(file) && !routeSessionLines.has(line(n))) {
      if (
        (n.type === "Identifier" && n.name === "getRouteSession") ||
        (n.type === "StringLiteral" &&
          (isRouteSessionModule(file, String(n.value)) ||
            (ancestors.at(-1)?.type.startsWith("Import") === true &&
              n.value === "getRouteSession"))) ||
        (n.type === "TemplateLiteral" &&
          children(n.expressions).length === 0 &&
          isRouteSessionModule(
            file,
            String((children(n.quasis)[0]?.value as { cooked?: string } | undefined)?.cooked),
          ))
      ) {
        // One finding per line: an import names the function and its module together.
        routeSessionLines.add(line(n));
        add(n, "G11", ROUTE_SESSION_MESSAGE);
      }
    }
    // G10 looks at every string in web source, not only className values: class lists also live
    // in cva() variants, shared constants and other *ClassName props, and a text-[…] token means
    // the same wherever it is written.
    if (isThemeScanned(file) && (n.type === "StringLiteral" || n.type === "TemplateElement")) {
      const text =
        n.type === "StringLiteral" ? String(n.value) : String((n.value as { raw?: string })?.raw);
      const fixed = text
        .split(/\s+/)
        .filter(Boolean)
        .map((token) => utility(token).base)
        .filter(fixedOrTinyText);
      if (fixed.length)
        add(n, "G10", `Fixed or sub-12px text size (${fixed.join(", ")}): ${FIXED_TEXT_MESSAGE}`);
    }
    if (
      isThemeScanned(file) &&
      ((n.type === "StringLiteral" && /prefers-color-scheme/i.test(String(n.value))) ||
        (n.type === "TemplateElement" &&
          /prefers-color-scheme/i.test(String((n.value as { raw?: string })?.raw))))
    )
      add(n, "G9", `A prefers-color-scheme query ${THEME_MESSAGE}`);
  });
  return withoutThemeExemptions(source, findings, ends);
}

/**
 * A rule's selector with CSS nesting resolved against its parent block: an at-rule (`@media`)
 * keeps the parent's selector, `&` stands for the parent, and a nested selector without `&` is a
 * descendant of it.
 */
function nestedSelector(selector: string, parent: { effective: string } | undefined): string {
  const own = selector.trim();
  const outer = parent?.effective ?? "";
  if (own.startsWith("@")) return outer;
  if (!outer) return own;
  return splitTopLevel(own, /,/)
    .map((part) =>
      part.includes("&") ? part.replaceAll("&", `:is(${outer})`) : `:is(${outer}) ${part}`,
    )
    .join(", ");
}

/** CSS lexical blocks: comments/strings are masked, so only real selectors and declarations count. */
export function scanWebCss(file: string, source: string): Finding[] {
  const findings: Finding[] = [];
  const masked = source.replace(/\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, (part) =>
    part.replace(/[^\n]/g, " "),
  );
  const stack: Array<{
    start: number;
    selector: string;
    /** The selector with its nesting resolved: `main { & { … } }` styles `:is(main)`. */
    effective: string;
    declarations: Array<{ text: string; offset: number }>;
  }> = [];
  let start = 0;
  const declaration = (end: number) => {
    const text = masked.slice(start, end).trim();
    if (text) stack.at(-1)?.declarations.push({ text, offset: start });
  };
  for (let i = 0; i < masked.length; i++) {
    const char = masked[i];
    if (char === "{") {
      const selector = masked.slice(start, i);
      if (isThemeScanned(file) && /prefers-color-scheme/i.test(selector))
        findings.push({
          file,
          line: offsetLine(masked, start + selector.search(/\S/)),
          rule: "G9",
          message: `A prefers-color-scheme query ${THEME_MESSAGE}`,
        });
      stack.push({
        start: i,
        selector,
        effective: nestedSelector(selector, stack.at(-1)),
        declarations: [],
      });
      start = i + 1;
    } else if (char === ";") {
      declaration(i);
      start = i + 1;
    } else if (char === "}") {
      declaration(i);
      const block = stack.pop();
      if (!block)
        findings.push({
          file,
          line: offsetLine(masked, i),
          rule: "parse",
          message:
            "Unmatched CSS closing brace. Fix the syntax and rerun pnpm policy:web-conventions (docs/ui.md).",
        });
      if (block) {
        for (const d of block.declarations) {
          const at = () => offsetLine(masked, d.offset + masked.slice(d.offset).search(/\S/));
          if (
            isThemeScanned(file) &&
            hasLiteralColor(d.text.replace(/^[^:]*:/, ""), /^\s*([\w-]+)\s*:/.exec(d.text)?.[1])
          )
            findings.push({
              file,
              line: at(),
              rule: "G9",
              message: `A literal colour ${THEME_MESSAGE}`,
            });
          if (
            /^scrollbar-gutter\s*:/i.test(d.text) &&
            !/^scrollbar-gutter\s*:\s*auto\s*(?:!\s*important\s*)?$/i.test(d.text) &&
            targetsMain(block.effective)
          )
            findings.push({
              file,
              line: at(),
              rule: "G8",
              message:
                "The page scroller reserves a scrollbar gutter, so every full-bleed rule inside it stops short of the viewport edge with classic scrollbars. Fix: remove scrollbar-gutter from <main> (docs/ui.md, Shell rules).",
            });
        }
      }
      start = i + 1;
    }
  }
  if (stack.length)
    findings.push({
      file,
      line: offsetLine(masked, stack.at(-1)?.start ?? 0),
      rule: "parse",
      message:
        "Unclosed CSS rule. Fix the syntax and rerun pnpm policy:web-conventions (docs/ui.md).",
    });
  return withoutThemeExemptions(source, findings);
}

export function formatFinding(finding: Finding): string {
  return `${finding.file}:${finding.line} ${finding.rule}: ${finding.message}`;
}
export function checkWebConventions(root: string): string[] {
  let paths: string[];
  try {
    paths = [
      ...new Set(
        execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
          cwd: root,
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
        })
          .split("\0")
          .filter(Boolean),
      ),
    ].sort();
  } catch (error) {
    return [
      `scripts/check-web-conventions.ts:1 Cannot enumerate tracked/nonignored source. Fix Git access and rerun pnpm policy:web-conventions: ${(error as Error).message}`,
    ];
  }
  const failures: string[] = [];
  for (const file of paths) {
    const sourceFile =
      /^(apps\/web|packages\/ui)\/src\//.test(file) && /\.(?:[cm]?[jt]sx?|css)$/.test(file);
    if (!sourceFile || !existsSync(join(root, file))) continue; // tracked deletions have no working-tree source
    try {
      const source = readFileSync(join(root, file), "utf8");
      failures.push(
        ...(file.endsWith(".css") ? scanWebCss(file, source) : scanWebSource(file, source)).map(
          formatFinding,
        ),
      );
    } catch (error) {
      failures.push(
        `${file}:1 Cannot read/check source. Fix the file and rerun pnpm policy:web-conventions: ${(error as Error).message}`,
      );
    }
  }
  return failures;
}

if (import.meta.filename === process.argv[1]) {
  const failures = checkWebConventions(join(import.meta.dirname, ".."));
  for (const failure of failures) console.error(`POLICY VIOLATION: ${failure}`);
  if (failures.length > 0) process.exit(1);
  console.log(
    "web conventions passed: no page-scroller gutter, no route footer, no literal colours, no px or sub-12px text, route guards check the document identity (G8, G9, G10, G11).",
  );
}
