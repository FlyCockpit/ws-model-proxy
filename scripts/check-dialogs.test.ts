import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  byRole,
  type CheckRun,
  formSignIn,
  pollPage,
  sessionName,
  stopped,
  totpCode,
  withBrowser,
} from "./browser-check-lib.ts";
import { DIALOGS, SHELL_PAGES } from "./browser-checks.config.ts";
import { type DialogProbe, judgeDialog, measure, stepScript } from "./check-dialogs.ts";

const fits: DialogProbe = {
  vw: 1280,
  vh: 800,
  popup: { top: 200, bottom: 600, left: 440, right: 840 },
  scrollers: [],
  covered: [],
};

describe("judgeDialog", () => {
  it("passes a dialog that shows all of itself inside the viewport", () => {
    assert.deepEqual(judgeDialog("Create project 1280×800", fits), []);
  });

  it("fails a dialog whose popup or a box inside it scrolls", () => {
    const bad = judgeDialog("Create sandbox 390×844", {
      ...fits,
      scrollers: [{ name: "[data-slot=dialog-content]", scrollHeight: 1900, clientHeight: 780 }],
    });
    assert.equal(bad.length, 1);
    assert.match(
      bad[0] ?? "",
      /\[data-slot=dialog-content\] scrolls \(1900px of content in 780px\)/,
    );
    assert.match(bad[0] ?? "", /page or a wide side sheet/);
  });

  it("fails a dialog whose action bar or header sits on top of its fields", () => {
    const bad = judgeDialog("Create project 1280×800", {
      ...fits,
      covered: [{ bar: "action bar", what: "p", overlap: 9 }],
    });
    assert.deepEqual(bad, ["Create project 1280×800: the action bar covers 9px of p"]);
  });

  it("fails a dialog that reaches outside the viewport", () => {
    for (const popup of [
      { top: -4, bottom: 600, left: 440, right: 840 },
      { top: 200, bottom: 801, left: 440, right: 840 },
      { top: 200, bottom: 600, left: -1, right: 840 },
      { top: 200, bottom: 600, left: 440, right: 1281 },
    ])
      assert.match(judgeDialog("x", { ...fits, popup })[0] ?? "", /outside the 1280×800 viewport/);
  });

  it("fails when no dialog opened", () => {
    assert.deepEqual(judgeDialog("x", { ...fits, popup: null }), ["x: no dialog opened"]);
  });
});

describe("browser-checks.config", () => {
  it("names every dialog once, with a locale path and at least one opening step", () => {
    const names = DIALOGS.map((dialog) => dialog.name);
    assert.equal(new Set(names).size, names.length);
    for (const dialog of DIALOGS) {
      assert.match(dialog.path, /^\/[a-z]{2}-[A-Z]{2}\//);
      assert.ok(dialog.steps.length > 0, dialog.name);
    }
  });

  it("measures at least two signed-in pages for the shell loading check", () => {
    assert.ok(SHELL_PAGES.length >= 2);
    for (const page of SHELL_PAGES) assert.notEqual(page.role, "anonymous", page.name);
  });

  it("turns steps into page scripts that fail loudly when the target is missing", () => {
    assert.match(stepScript({ click: "#a" }), /querySelector\("#a"\)/);
    assert.match(stepScript({ clickText: "New project" }), /"New project"/);
    assert.match(stepScript({ clickText: "x" }), /throw new Error/);
  });
});

const noPause = async () => {};
const navigated = () =>
  new Error(
    "agent-browser eval exited 1: ✗ CDP error (Runtime.evaluate): Inspected target navigated or closed",
  );

describe("pollPage", () => {
  /** A fake agent-browser: each eval answers with the next scripted reply (an Error is thrown). */
  const scripted = (replies: (string | Error)[]) => {
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return reply ?? "null";
    };
    return { run, calls };
  };

  it("keeps polling across the full page load a redirectTo sign-in ends in", async () => {
    const { run } = scripted(["null", '"/en-US/login"', navigated(), '"app"']);
    assert.equal(await pollPage(run, "probe", noPause), "app");
  });

  it("also looks again after a destroyed execution context", async () => {
    const destroyed = new Error(
      "agent-browser eval exited 1: ✗ CDP error (Runtime.evaluate): Execution context was destroyed.",
    );
    const { run } = scripted([destroyed, '"code"']);
    assert.equal(await pollPage(run, "probe", noPause), "code");
  });

  it("gives up after 20s with the page it is stuck on", async () => {
    const replies: string[] = [];
    for (let i = 0; i < 40; i++) replies.push("null", '"/en-US/login"');
    const { run } = scripted(replies);
    assert.equal(await pollPage(run, "probe", noPause), "still on /en-US/login after 20s");
  });

  it("passes a closed browser or any other failure on at once", async () => {
    const closed = new Error(
      "agent-browser eval exited 1: Target page, context or browser has been closed",
    );
    const first = scripted([closed, '"app"']);
    await assert.rejects(pollPage(first.run, "probe", noPause), /has been closed/);
    assert.equal(first.calls.length, 1);
    const { run } = scripted([new Error("agent-browser eval exited 1: daemon not running")]);
    await assert.rejects(pollPage(run, "probe", noPause), /daemon not running/);
  });

  it("reports the navigation error, not a page, when every attempt was cut off", async () => {
    const { run } = scripted(Array.from({ length: 40 }, navigated));
    await assert.rejects(pollPage(run, "probe", noPause), /Inspected target navigated/);
  });

  it("sends one short expression per poll, never over stdin", async () => {
    const { run, calls } = scripted(['"app"']);
    await pollPage(run, "probe()", noPause);
    assert.deepEqual(calls, [["eval", "probe()"]]);
  });
});

/**
 * A fake agent-browser for a whole sign-in: `answer` picks the reply to each
 * eval (an Error is thrown); every command and its stdin are recorded.
 */
function fakeBrowser(answer: (script: string) => string | Error = () => "true") {
  const commands: { args: string[]; input?: string }[] = [];
  const browser: CheckRun["browser"] = {
    async run(args, input) {
      commands.push({ args, input });
      if (args[0] !== "eval") return "";
      const reply = answer(input ?? args[1] ?? "");
      if (reply instanceof Error) throw reply;
      return reply;
    },
    async evalJson<T>(): Promise<T> {
      throw new Error("not used");
    },
    close() {},
  };
  return { browser, commands };
}

/** A stack whose sign-in ends in a full page load: the first poll after the submit is cut off. */
function stack(options: { secondFactor?: boolean; landsOn?: string } = {}) {
  let submitted = false;
  let verified = false;
  let cutOff = false;
  return (script: string): string | Error => {
    if (script.includes("__reactProps")) return '"ready"';
    if (script.includes("requestSubmit")) {
      submitted = true;
      return "true";
    }
    if (script.includes("button.click()")) {
      verified = true;
      return '"clicked"';
    }
    if (script === "location.pathname") return JSON.stringify(options.landsOn ?? "/en-US/login");
    if (script.startsWith("location.pathname ===")) {
      if (!submitted || (options.secondFactor && !verified))
        return options.secondFactor && script.includes("totp-code") ? '"code"' : "null";
      if (!cutOff) {
        cutOff = true;
        return navigated();
      }
      return options.landsOn ? "null" : '"app"';
    }
    return "true";
  };
}

describe("formSignIn", () => {
  const base = "http://127.0.0.1:3001";
  const account = { email: "e2e-user@example.com", password: "correct horse battery" };

  it("signs in through the form and survives the page load the redirect ends in", async () => {
    const { browser, commands } = fakeBrowser(stack());
    await formSignIn({ base, browser, args: [] }, account, "/en-US/settings", noPause);
    assert.deepEqual(commands[0]?.args, [
      "open",
      `${base}/en-US/login?redirectTo=%2Fen-US%2Fsettings`,
    ]);
    assert.equal(
      commands.some((command) => command.args.join(" ").includes("consent")),
      false,
    );
  });

  it("sends the password over stdin only", async () => {
    const { browser, commands } = fakeBrowser(stack());
    await formSignIn({ base, browser, args: [] }, account, "/en-US/settings", noPause);
    assert.ok(commands.some((command) => command.input?.includes(account.password)));
    for (const command of commands)
      assert.ok(!command.args.join(" ").includes(account.password), command.args.join(" "));
  });

  it("types a current code at the second-factor step and waits for the app", async () => {
    let asked = 0;
    const { browser, commands } = fakeBrowser(stack({ secondFactor: true }));
    await formSignIn(
      { base, browser, args: [] },
      {
        ...account,
        totp: () => {
          asked++;
          return "123456";
        },
      },
      "/en-US/settings",
      noPause,
    );
    assert.equal(asked, 1);
    assert.ok(commands.some((command) => command.input?.includes('"123456"')));
  });

  it("says what is wrong when the account has a second factor and no code", async () => {
    const { browser } = fakeBrowser(stack({ secondFactor: true }));
    await assert.rejects(
      formSignIn({ base, browser, args: [] }, account, "/en-US/settings", noPause),
      /has a second factor and no code source/,
    );
  });

  it("reports where a refused sign-in is stuck, never the password", async () => {
    const { browser } = fakeBrowser(stack({ landsOn: "/en-US/login" }));
    await assert.rejects(
      formSignIn({ base, browser, args: [] }, account, "/en-US/settings", noPause),
      (error: Error) =>
        /sign-in did not open the app \(still on \/en-US\/login after 20s\)/.test(error.message) &&
        !error.message.includes(account.password),
    );
  });
});

describe("sign-in page scripts", () => {
  it("uses WMP's hydrated form and polls its disabled Verify button without a page timer", async () => {
    const { browser, commands } = fakeBrowser(stack({ secondFactor: true }));
    await formSignIn(
      { base: "http://localhost:3000", browser, args: [] },
      { email: "user@example.invalid", password: "test-password", totp: () => "123456" },
      "/en-US/settings",
      noPause,
    );
    const hydrated = commands.find(({ args }) => args[1]?.includes("__reactProps"))?.args[1];
    const verify = commands.find(({ args }) => args[1]?.includes("button.click()"))?.args[1];
    assert.ok(hydrated);
    assert.ok(verify);
    const form: Record<string, unknown> = {};
    const readForm = new Function("document", `return ${hydrated}`) as (doc: unknown) => unknown;
    const doc = { querySelector: () => ({ form }) };
    assert.equal(readForm(doc), null);
    form.__reactProps123 = {};
    assert.equal(readForm(doc), "ready");
    let clicks = 0;
    const button = { disabled: true, click: () => clicks++ };
    const readVerify = new Function("document", `return ${verify}`) as (doc: unknown) => unknown;
    const challenge = {
      getElementById: (id: string) =>
        id === "totp-code" ? { closest: () => ({ nextElementSibling: button }) } : null,
    };
    assert.equal(readVerify(challenge), null);
    assert.equal(clicks, 0);
    button.disabled = false;
    assert.equal(readVerify(challenge), "clicked");
    assert.equal(clicks, 1);
    assert.equal(verify.includes("setTimeout"), false);
  });

  it("redacts a browser failure that echoes password or verification stdin", async () => {
    for (const secondFactor of [false, true]) {
      const answer = stack({ secondFactor });
      const secret = secondFactor ? "123456" : "do-not-log-test-password";
      const { browser } = fakeBrowser((script) =>
        script.includes(JSON.stringify(secret)) ? new Error(`echo: ${script}`) : answer(script),
      );
      await assert.rejects(
        formSignIn(
          { base: "http://localhost:3000", browser, args: [] },
          {
            email: "user@example.invalid",
            password: "do-not-log-test-password",
            totp: () => "123456",
          },
          "/en-US/settings",
          noPause,
        ),
        (error: Error) => /could not type/.test(error.message) && !error.message.includes(secret),
      );
    }
  });
});

describe("totpCode", () => {
  it("matches RFC 6238's SHA-1 vectors (6 digits)", () => {
    assert.equal(totpCode("12345678901234567890", 59_000), "287082");
    assert.equal(totpCode("12345678901234567890", 1_111_111_109_000), "081804");
  });
});

describe("sessionName", () => {
  it("is one session per process, behind an optional prefix", () => {
    assert.equal(sessionName("check-layout", "", 42), "check-layout-42");
    assert.equal(sessionName("check-layout", "lane-d-", 42), "lane-d-check-layout-42");
    assert.match(sessionName("check-dialogs"), new RegExp(`check-dialogs-${process.pid}$`));
  });
});

describe("byRole", () => {
  it("groups the cases by role and keeps the listed order inside each", () => {
    const cases = [
      { name: "a", role: "user" },
      { name: "b", role: "admin" },
      { name: "c", role: "user" },
    ];
    assert.deepEqual(
      byRole(cases).map((item) => item.name),
      ["a", "c", "b"],
    );
  });
});

describe("precondition diagnostics", () => {
  it("keeps only the first line, without the stack", () => {
    assert.equal(
      stopped(new Error("missing account; supply --accounts\nprivate details")),
      "stopped: missing account; supply --accounts",
    );
    assert.equal(stopped("unavailable\nmore"), "stopped: unavailable");
  });
});

describe("dialog preconditions", () => {
  it("includes the record requirement when the dialog cannot open", async (t) => {
    const previous = process.env.WMP_CHECK_DISPOSABLE;
    process.env.WMP_CHECK_DISPOSABLE = "1";
    t.after(() => {
      if (previous === undefined) delete process.env.WMP_CHECK_DISPOSABLE;
      else process.env.WMP_CHECK_DISPOSABLE = previous;
    });
    const browser: CheckRun["browser"] = {
      async run(args) {
        if (args[0] === "wait" && args[1] !== "input[autocomplete=current-password]")
          throw new Error("selector timeout\nprivate diagnostics");
        const script = args[1] ?? "";
        if (script.includes("__reactProps")) return '"ready"';
        if (script.startsWith("location.pathname ===")) return '"app"';
        return "true";
      },
      async evalJson<T>(script: string): Promise<T> {
        return (script.includes("presets/list") ? { presets: [] } : { id: "fixture" }) as T;
      },
      close() {},
    };
    const failures = await measure({
      base: "http://localhost:3000",
      browser,
      args: ["--only", "Delete runtime"],
    });
    assert.equal(failures.length, 2);
    for (const failure of failures) {
      assert.match(
        failure,
        /could not open: selector timeout; this dialog needs the check-created runtimeId fixture/,
      );
      assert.equal(failure.includes("\n"), false);
      assert.equal(failure.includes("private diagnostics"), false);
    }
  });
});

describe("browser check setup", () => {
  it("rejects a malformed URL before starting a browser, without printing credentials", async (t) => {
    const previous = process.argv;
    t.after(() => {
      process.argv = previous;
    });
    const messages: string[] = [];
    t.mock.method(console, "error", (message: string) => messages.push(message));
    for (const url of ["--no-sandbox", "file:///tmp/page", "http://user:private@localhost:3000"]) {
      process.argv = [previous[0] ?? "node", previous[1] ?? "check", "--url", url];
      assert.equal(
        await withBrowser(
          "check:test",
          "unused",
          async () => {
            throw new Error("must not run");
          },
          { mockServer: false },
        ),
        1,
      );
    }
    assert.equal(messages.length, 3);
    for (const message of messages) {
      assert.match(message, /pass --url/);
      assert.equal(message.includes("private"), false);
      assert.equal(message.includes("\n"), false);
    }
  });
});
