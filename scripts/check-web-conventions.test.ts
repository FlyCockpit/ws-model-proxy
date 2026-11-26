import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import {
  checkWebConventions,
  formatFinding,
  scanWebCss,
  scanWebSource,
} from "./check-web-conventions.ts";

// A git hook (or any caller) may export GIT_DIR, GIT_INDEX_FILE and the like;
// inherited by the scratch repositories' git calls (here and in
// checkWebConventions), they would point at the caller's repository. Drop every
// GIT_* variable, stop discovery at the temp dir, and turn hooks off for every
// git call in this process and its children (a global core.hooksPath must not
// judge these repos; `git init` and `git add` run hooks too).
for (const name of Object.keys(process.env)) if (name.startsWith("GIT_")) delete process.env[name];
process.env.GIT_CEILING_DIRECTORIES = tmpdir();
process.env.GIT_CONFIG_COUNT = "1";
process.env.GIT_CONFIG_KEY_0 = "core.hooksPath";
process.env.GIT_CONFIG_VALUE_0 = "/dev/null";

const FILE = "apps/web/src/components/example.tsx";
function rules(source: string, file = FILE): string[] {
  return scanWebSource(file, source).map((finding) => finding.rule);
}
function accepts(source: string, file = FILE): void {
  assert.deepEqual(scanWebSource(file, source), [], source);
}
function rejects(rule: string, source: string, file = FILE): void {
  assert.ok(rules(source, file).includes(rule), source);
}

describe("scanWebSource G8: the shells own the scroller and the footer", () => {
  it("rejects a scrollbar gutter on the page scroller and a footer in a route file", () => {
    rejects(
      "G8",
      '<main id="main-content" className="min-h-0 overflow-y-auto overflow-x-clip [scrollbar-gutter:stable]" />',
      "apps/web/src/components/public-shell.tsx",
    );
    rejects("G8", '<main className="md:[scrollbar-gutter:stable_both-edges]" />');
    rejects("G8", '<main style={{ scrollbarGutter: "stable" }} />');
    rejects(
      "G8",
      'const frame = { scrollbarGutter: "stable both-edges" }; <main style={{ ...frame }} />',
    );
    rejects("G8", "<main style={{ scrollbarGutter: gutter }} />");
    rejects("G8", "<footer>links</footer>", "apps/web/src/routes/$lang/_public/index.tsx");
    rejects("G8", '<footer className="mt-auto" />', "apps/web/src/routes/$lang/_app/route.tsx");
    const blog = "apps/web/src/routes/$lang/_public/blog/$slug.tsx";
    rejects("G8", "<div><article>Body</article><footer>links</footer></div>", blog);
    rejects("G8", "<main><footer>links</footer></main>", blog);
  });
  it("accepts a footer that belongs to an article, section or other sectioning element in a route", () => {
    const blog = "apps/web/src/routes/$lang/_public/blog/$slug.tsx";
    accepts("<article><h1>Post</h1><footer>By Ada</footer></article>", blog);
    accepts("<section><div><footer>Updated today</footer></div></section>", blog);
    accepts("<blockquote><p>Quote</p><footer>Ada</footer></blockquote>", blog);
    accepts("<figure><img alt='' /><footer>Credit</footer></figure>", blog);
  });
  it("accepts a gutter on a nested pane, an explicit auto gutter and the shared footer component", () => {
    accepts('<main className="[scrollbar-gutter:auto]" />');
    accepts('<main style={{ scrollbarGutter: "auto", paddingTop: "var(--safe-area-top)" }} />');
    accepts('<div style={{ scrollbarGutter: "stable" }} />');
    accepts(
      '<div className="min-h-0 overflow-y-auto overflow-x-clip [scrollbar-gutter:stable]" />',
      "apps/web/src/components/inbox-pane.tsx",
    );
    accepts('<footer className="border-t" />', "apps/web/src/components/public-footer.tsx");
  });
});

describe("scanWebSource G10: text scales and stays at least 12px", () => {
  it("rejects px font sizes and rem/em sizes below 0.75", () => {
    for (const token of [
      "text-[10px]",
      "text-[13px]",
      "md:text-[18px]",
      "text-[10px]/4",
      "text-[10px]/[120%]",
      "text-[length:11px]",
      "text-[0.625rem]",
      "text-[0.7rem]",
      "text-[.7em]",
      "text-[0.9em]",
      "[&_code]:text-[0.9em]",
      "text-[length:calc(0.9em)]",
      "text-[max(0.9em,0.5rem)]",
      "text-[min(1rem,2vw)]",
      "text-[clamp(10px,1vw,2rem)]",
      "text-[clamp(0.625rem,1vw,2rem)]",
      "text-[length:2vw]",
      "text-[3vmin]",
      "text-[2cqi]",
      "text-[9pt]",
      "text-[max(24px,0.75rem)]",
      "text-[clamp(0.75rem,1vw,40px)]",
      "text-[length:50%]",
      "text-[length:calc(50%)]",
    ])
      rejects("G10", `<span className="${token} font-medium" />`);
    rejects("G10", '<span className={cn("uppercase", compact && "text-[11px]")} />');
    // Class lists outside a className attribute: cva() variants, constants, other props.
    rejects(
      "G10",
      'const badge = cva("inline-flex", { variants: { size: { sm: "text-[10px]" } } });',
    );
    rejects("G10", "const LABEL = `max-w-full text-[11px]`;");
    rejects("G10", '<Code preClassName="text-[10px]" />');
  });
  it("accepts the type scale, rem sizes from 0.75 and non-size text utilities", () => {
    for (const token of [
      "text-xs",
      "text-sm/relaxed",
      "text-[0.75rem]",
      "text-[1.1em]",
      "text-[length:110%]",
      "text-[length:max(50%,0.75rem)]",
      "text-[max(0.9em,0.75rem)]",
      "[&_:not(pre)>code]:text-[length:max(0.9em,0.75rem)]",
      "text-[max(0.9em,_0.75rem)]",
      "text-[clamp(0.75rem,1vw,2rem)]",
      "text-[1.125rem]",
      "text-[var(--step)]",
      "text-[length:var(--step)]",
      "text-(--step)",
      "min-h-[44px]",
    ])
      accepts(`<span className="${token}" />`);
    accepts('<span className="text-[10px]" />', "apps/web/src/components/example.test.tsx");
  });
});

describe("scanWebSource G9: surfaces follow the app theme", () => {
  it("rejects literal colour classes and prefers-color-scheme in app source", () => {
    for (const token of [
      "bg-[#f2f2f2]",
      "text-[rgb(0,0,0)]",
      "dark:bg-[oklch(0.2_0_0)]",
      "border-[color:#fff]",
      "fill-[hsl(0_0%_100%)]",
    ])
      rejects("G9", `<div className="${token}" />`);
    rejects("G9", 'const dark = matchMedia("(prefers-color-scheme: dark)").matches;');
    rejects("G9", '<div style={{ backgroundColor: "#fff", color: "#000" }} />');
    rejects("G9", 'const bg = "rgb(0 0 0)"; <div style={{ background: bg }} />');
    rejects("G9", 'const styles = { backgroundColor: "#fff" }; <div style={styles} />');
    rejects("G9", 'const base = { color: "#000" }; <div style={{ ...base, margin: 0 }} />');
    rejects("G9", '<div style={{ clipPath: "url(#fade)", color: "#fade" }} />');
    rejects("G9", '<div style={{ background: "url(#grad) #fff" }} />');
    rejects(
      "G9",
      "const q = `(prefers-color-scheme: dark)`;",
      "packages/ui/src/components/toaster.tsx",
    );
  });
  it("rejects literal colours in arbitrary properties and named colours in colour properties", () => {
    for (const token of [
      "[&_.xterm-viewport]:[scrollbar-color:#3a414b_transparent]",
      "[background:rgb(0_0_0)]",
      "md:[color:white]",
      "[--brand-color:oklch(0.5_0.1_200)]",
      "bg-[linear-gradient(#fff,#000)]",
      "shadow-[0_0_4px_#fff]",
      "bg-[white]",
      "text-[color:darkred]",
      "bg-[#fff]/50",
    ])
      rejects("G9", `<div className="${token}" />`);
    rejects("G9", '<div style={{ background: "white" }} />');
    rejects("G9", '<div style={{ borderColor: "Black" }} />');
    rejects("G9", '<div style={{ border: "1px solid navy" }} />');
    rejects("G9", '<div style={{ color: "rebeccapurple" }} />');
  });
  it("accepts tokens, url() references and non-colour words in arbitrary and inline styles", () => {
    for (const token of [
      "[mask-image:url(#fade)]",
      "[scrollbar-color:var(--border)_transparent]",
      "[scrollbar-gutter:stable]",
      "[font-family:Gray_Sans]",
      "bg-[url(/tan.svg)]",
      "shadow-[0_0_0_1px_var(--border)]",
      "text-[length:var(--text-red)]",
      "grid-cols-[repeat(2,minmax(0,1fr))]",
      "bg-[var(--popover)]/50",
    ])
      accepts(`<div className="${token}" />`);
    accepts('<div style={{ fontFamily: "Tomato Grotesk", color: "currentColor" }} />');
    accepts('<div style={{ background: "transparent", borderColor: "var(--border)" }} />');
    accepts('<div style={{ color: "var(--brand-red)", outline: "none" }} />');
  });
  it("accepts tokens, opacity modifiers, comments and tests", () => {
    for (const token of [
      "bg-popover",
      "text-foreground",
      "bg-black/10",
      "bg-[var(--popover)]",
      "dark:bg-input/30",
      "text-(--state-success)",
    ])
      accepts(`<div className="${token}" />`);
    accepts('<div style={{ color: "var(--foreground)", paddingTop: "var(--safe-area-top)" }} />');
    accepts('const swatch = { color: "#fff" }; // data, not a style');
    accepts('<div style={{ clipPath: "url(#fade)", mask: "url( \'#m\' )" }} />');
    accepts('<div style={{ maskImage: `url("#fade-mask")` }} />');
    accepts('<div style={{ clipPath: "url(/shapes.svg#fade)", mask: "url(\'/m.svg#a\')" }} />');
    accepts('<><a href="#main-content">Skip</a><a href="#fade">Top</a></>');
    accepts("// unlike the OS prefers-color-scheme, the stored choice wins\nconst x = 1;");
    accepts(
      'const q = "(prefers-color-scheme: dark)";',
      "apps/web/src/components/theme-provider.test.tsx",
    );
  });
});

describe("scanWebSource G11: route guards check the document identity", () => {
  const ROUTE = "apps/web/src/routes/$lang/_auth.tsx";
  it("rejects every way a route file reaches getRouteSession or its module", () => {
    for (const source of [
      "const decision = decideProtectedRouteAccess(await getRouteSession());",
      'import { getRouteSession } from "@/server/auth-session";',
      'import { getRouteSession as probe } from "@/lib/route-session";',
      'import { "getRouteSession" as probe } from "./elsewhere";',
      "const [s, c] = await Promise.all([getRouteSession(), load()]);",
      "/* guard */ const decision = await getRouteSession();",
      'import * as session from "@/server/auth-session";',
      "const m = await import('@/server/auth-session');",
      "const m = await import(`@/server/auth-session`);",
      'import("@/server/auth-session.ts").then((m) => m.probe());',
      'import type { X } from "../../server/auth-session";',
      'export { getRouteSession as probe } from "@/server/auth-session";',
      "const r = /\\/\\//; const s = await sessions.getRouteSession();",
    ])
      rejects("G11", source, ROUTE);
    rejects("G11", 'import { x } from "../server/auth-session";', "apps/web/src/routes/index.tsx");
  });
  it("accepts resolveRouteSession, comments, strings and code outside route files", () => {
    for (const source of [
      'import { resolveRouteSession } from "@/lib/route-session";',
      "const decision = decideProtectedRouteAccess(await resolveRouteSession());",
      "// resolveRouteSession() wraps getRouteSession() with the identity check.\nconst a = 1;",
      "const session = await resolveRouteSession(); // replaces getRouteSession()",
      "/**\n * getRouteSession() alone would skip it.\n */\nconst done = 1;",
      'const label = "getRouteSession()";',
      "const myGetRouteSessionLike = 1;",
      'import { getMcpWebAvailability } from "@/server/mcp-availability";',
      'import { x } from "../server/auth-session-helpers";',
    ])
      assert.ok(!rules(source, ROUTE).includes("G11"), source);
    for (const file of [
      "apps/web/src/lib/route-session.ts",
      "apps/web/src/routes/$lang/-_auth.dom.test.tsx",
    ])
      assert.ok(
        !rules('import { getRouteSession } from "@/server/auth-session";', file).includes("G11"),
        file,
      );
  });
});

describe("scanWebCss", () => {
  it("keeps literal colours and color-scheme queries in the theme's token file (G9)", () => {
    const app = "apps/web/src/index.css";
    for (const css of [
      ".toast { background: #f2f2f2; }",
      ".toast { color: rgba(0, 0, 0, 0.5); }",
      ":root { --brand: oklch(0.5 0.1 200); }",
      "@media (prefers-color-scheme: dark) { .x { color: var(--foreground); } }",
    ])
      assert.ok(
        scanWebCss(app, css).some((f) => f.rule === "G9"),
        css,
      );
    assert.equal(
      scanWebCss(app, ".x { color: var(--foreground); background: transparent; }").length,
      0,
    );
    assert.equal(scanWebCss(app, '/* #fff */ .x { content: "#fff"; }').length, 0);
    for (const css of [
      ".x { clip-path: url(#fade); }",
      ".x { clip-path: url(/shapes.svg#fade); }",
      ".x { mask: url( #mask-1 ); fill: url('#grad'); }",
      "#fade { color: var(--foreground); }",
      "a[href='#fade'] { color: var(--primary); }",
      ".x { color: transparent; font-family: Gray, serif; content: 'white'; background: none; }",
    ])
      assert.equal(scanWebCss(app, css).length, 0, css);
    for (const css of [
      ".x { fill: url(#grad) #fade; }",
      ".x { color: #ABCDEF; }",
      ".x { color: white; }",
      ".x { border: 1px solid black; }",
      ".x { --brand-color: navy; }",
    ])
      assert.ok(
        scanWebCss(app, css).some((f) => f.rule === "G9"),
        css,
      );
    assert.equal(
      scanWebCss("packages/ui/src/styles/globals.css", ":root { --popover: oklch(1 0 0); }").length,
      0,
    );
  });
  it("skips G9 on a line marked theme-exempt with a reason, and only there", () => {
    accepts(
      '// theme-exempt: QR codes stay dark on white so phones can scan them\nconst qr = <div style={{ background: "#fff" }} />;',
    );
    accepts(
      'const qr = <div className="bg-[#fff]" />; // theme-exempt: QR codes must stay dark on white',
    );
    accepts(
      'const qr = (\n  <div\n    style={{\n      // theme-exempt: QR codes stay dark on white to scan\n      backgroundColor: "#fff",\n    }}\n  />\n);',
    );
    rejects(
      "G9",
      'const qr = (\n  <div\n    style={{\n      // theme-exempt: QR codes stay dark on white to scan\n      backgroundColor: "#fff",\n      color: "#000",\n    }}\n  />\n);',
    );
    accepts(
      'const qr = (\n  <div\n    className={cn(\n      "p-2",\n      // theme-exempt: QR codes stay dark on white to scan\n      "bg-[#fff]",\n    )}\n  />\n);',
    );
    rejects("G9", '// theme-exempt:\nconst qr = <div style={{ background: "#fff" }} />;');
    rejects(
      "G9",
      '// theme-exempt: QR codes stay dark on white\nconst a = 1;\nconst qr = <div style={{ background: "#fff" }} />;',
    );
    const app = "apps/web/src/index.css";
    assert.equal(
      scanWebCss(
        app,
        "/* theme-exempt: the board is the same in both themes */\n.sq { background: #f0d9b5; }",
      ).length,
      0,
    );
    assert.ok(
      scanWebSource(
        FILE,
        '// theme-exempt: fixed art\n<main className="[scrollbar-gutter:stable]" />',
      ).some((f) => f.rule === "G8"),
      "theme-exempt never silences other rules",
    );
  });
  it("rejects a scrollbar gutter on the page scroller (G8)", () => {
    for (const css of [
      "main { scrollbar-gutter: stable; }",
      "#main-content { scrollbar-gutter: stable both-edges; }",
      ".shell > main:not(.x) { scrollbar-gutter: stable; }",
      ".pane, main:is(.a, .b) { scrollbar-gutter: stable; }",
      ":is(main, #main-content) { scrollbar-gutter: stable; }",
      ".shell > :where(main) { scrollbar-gutter: stable; }",
      ".a :is(.b, :where(#main-content)) { scrollbar-gutter: stable; }",
      "main { & { scrollbar-gutter: stable; } }",
      "main { @media (min-width: 48rem) { scrollbar-gutter: stable; } }",
      "#main-content { &.wide { scrollbar-gutter: stable; } }",
      "@media (min-width: 48rem) { main { scrollbar-gutter: stable; } }",
    ])
      assert.equal(scanWebCss("apps/web/src/index.css", css)[0]?.rule, "G8", css);
    for (const css of [
      ".pane { scrollbar-gutter: stable; }",
      "main .pane { scrollbar-gutter: stable; }",
      "#main-content > .list { scrollbar-gutter: stable; }",
      "main { scrollbar-gutter: auto; }",
      "main { scrollbar-gutter: auto !important; }",
      ".pane:not(#main-content) { scrollbar-gutter: stable; }",
      ".pane:not(main, #main-content) { scrollbar-gutter: stable; }",
      ":is(main, #main-content) .pane { scrollbar-gutter: stable; }",
      ".pane:not(:is(main)) { scrollbar-gutter: stable; }",
      ".pane:has(main) { scrollbar-gutter: stable; }",
      "main { .pane { scrollbar-gutter: stable; } }",
      "main { & > .list { scrollbar-gutter: stable; } }",
    ])
      assert.equal(scanWebCss("apps/web/src/index.css", css).length, 0, css);
  });
  it("fails malformed source closed", () => {
    assert.equal(
      scanWebCss("packages/ui/src/styles/example.css", ".a { color: red;")[0]?.rule,
      "parse",
    );
    assert.equal(scanWebCss("packages/ui/src/styles/example.css", ".a { } }")[0]?.rule, "parse");
    assert.equal(rules("const = {{{")[0], "parse");
  });
  it("parses a generic arrow in a .ts file (no JSX there)", () => {
    accepts("export const keep = <T>(value: T): T => value;", "apps/web/src/lib/example.ts");
  });
});

describe("checkWebConventions source enumeration and diagnostics", () => {
  it("enumerates tracked plus nonignored untracked source, ignoring deleted and ignored paths", () => {
    const root = mkdtempSync(join(tmpdir(), "web-conventions-"));
    const write = (file: string, source: string) => {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), source);
    };
    try {
      // Isolated temporary Git index only; never touches the user's index or creates commits.
      execFileSync("git", ["init", "--quiet", root]);
      write(".gitignore", "ignored/\napps/web/src/components/ignored.tsx\n");
      write(FILE, '<main className="[scrollbar-gutter:stable]" />');
      execFileSync("git", ["add", FILE], { cwd: root });
      write("apps/web/src/routes/untracked.tsx", "<footer>links</footer>");
      write("packages/ui/src/components/untracked.tsx", '<div className="bg-[#fff]" />');
      write("packages/ui/src/styles/example.css", ".x { color: #fff; }");
      write("apps/web/src/components/ignored.tsx", '<div className="bg-[#fff]" />');
      write("ignored/apps/web/src/x.tsx", '<div className="bg-[#fff]" />');
      write("apps/web/src/deleted.ts", "const value = 1;");
      execFileSync("git", ["add", "apps/web/src/deleted.ts"], { cwd: root });
      rmSync(join(root, "apps/web/src/deleted.ts"));
      const findings = checkWebConventions(root);
      assert.equal(findings.length, 4, findings.join("\n"));
      for (const finding of findings) {
        assert.match(finding, /^[^:]+:\d+ G[89]: /);
        assert.match(finding, /Fix:/);
        assert.match(finding, /docs\/ui\.md/);
      }
      assert.ok(
        findings.every((finding) => !finding.includes("ignored") && !finding.includes("deleted")),
      );
      write("apps/web/src/broken.ts", "const = {{{");
      assert.ok(
        checkWebConventions(root).some((finding) => finding.includes("broken.ts:1 parse:")),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("fails Git enumeration errors closed", () => {
    const root = mkdtempSync(join(tmpdir(), "web-conventions-no-git-"));
    try {
      assert.match(checkWebConventions(root).join("\n"), /Cannot enumerate.*Fix Git access/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("formats a finding as file:line rule: message", () => {
    assert.equal(
      formatFinding({ file: "a.tsx", line: 3, rule: "G9", message: "m" }),
      "a.tsx:3 G9: m",
    );
  });
});
