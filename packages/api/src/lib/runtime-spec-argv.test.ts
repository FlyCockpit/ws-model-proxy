import { describe, expect, it } from "vitest";
import { displayCommand } from "./command-render";
import {
  authoredRuntimeSpecSchema,
  RUNTIME_ARGV_MAX,
  type RuntimeSpec,
  runtimeSpecWarnings,
} from "./runtime-spec";

function service(launch: Record<string, unknown> = {}, commands: Record<string, unknown> = {}) {
  return {
    launch: {
      management: "service",
      groupSize: 1,
      resources: [{ kind: "none" }],
      labels: [],
      commands: [{ start: "agent up", stop: "agent down", status: "agent status", ...commands }],
      health: { intervalMs: 30000, failureThreshold: 3, successThreshold: 1 },
      ...launch,
    },
  };
}

function issueIds(spec: unknown): Array<[string, string | undefined]> {
  const parsed = authoredRuntimeSpecSchema.safeParse(spec);
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => [
        issue.path.join("."),
        (issue as { params?: { i18n?: string } }).params?.i18n,
      ]);
}

/** The node's twin is `argv_commands_are_checked_per_argument` (`runtime_store/validate.rs`). */
describe("argv commands", () => {
  it("accepts an argv anywhere a command goes", () => {
    expect(
      issueIds(
        service({ shell: "pwsh" }, { start: ["agent.exe", "up", "--port", "{{port}}", ""] }),
      ),
    ).toEqual([]);
    expect(issueIds(service({}, { status: ["agent", "status"] }))).toEqual([]);
  });

  it.each([
    ["no arguments", []],
    ["a blank program", [" ", "up"]],
    ["an unknown placeholder", ["agent", "{{nope}}"]],
    ["a hidden character", ["agent", "a\u202eb"]],
    ["too many arguments", Array.from({ length: RUNTIME_ARGV_MAX + 1 }, () => "a")],
    ["a joined length over the limit", ["a".repeat(2048), "b".repeat(2048)]],
  ])("refuses %s", (_name, start) => {
    expect(
      issueIds(service({}, { start })).some(([path]) => path.startsWith("launch.commands.0.start")),
    ).toBe(true);
  });

  it("refuses an argv in a cmd launch", () => {
    expect(issueIds(service({ shell: "cmd" }, { start: ["agent.exe"] }))).toEqual([
      ["launch.shell", "cmdArgv"],
    ]);
    expect(issueIds(service({ shell: "cmd" }))).toEqual([]);
  });

  it("refuses an interactive argv", () => {
    expect(
      issueIds(service({}, { prepare: ["setup", "--once"], interactive: { prepare: true } })),
    ).toEqual([["launch.commands.0.prepare", "interactiveArgv"]]);
  });

  it("checks an argv status like text", () => {
    expect(issueIds(service({}, { status: ["true"] }))).toEqual([
      ["launch.commands.0.status", "statusNeverStopped"],
    ]);
  });

  it("warns about an argv that binds every interface", () => {
    const spec = service({}, { start: ["agent", "--host", "0.0.0.0"] }) as RuntimeSpec;
    expect(runtimeSpecWarnings(spec)).toEqual(["binds_all_interfaces"]);
  });

  it("shows an argv with sh-style quotes where an argument needs them", () => {
    expect(displayCommand(["C:\\Tools\\agent.exe", "--name", "it's mine", "{{port}}", ""])).toBe(
      "'C:\\Tools\\agent.exe' --name 'it'\\''s mine' {{port}} ''",
    );
  });
});
