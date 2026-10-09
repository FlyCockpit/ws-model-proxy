import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runtimesContract } from "../contracts/runtimes";
import { RUNTIME_PRESET_LIST } from "./runtime-presets";
import {
  authoredRuntimeSpecSchema,
  runtimeSpecSchema,
  statusCanReportStopped,
} from "./runtime-spec";

const repoRoot = join(import.meta.dirname, "../../../..");
const vectors = JSON.parse(
  readFileSync(
    join(repoRoot, "apps/cli/tests/fixtures/relay-3.0/rules/status-command.json"),
    "utf8",
  ),
) as { refused: string[]; accepted: string[] };

const COMPOSE_STATUS =
  'out=$(docker compose ps --status running -q) || exit 1; [ -n "$out" ] || exit 3';

function service(commands: Record<string, unknown>, management = "service") {
  return {
    launch: {
      management,
      groupSize: 1,
      resources: [{ kind: "none" }],
      labels: [],
      commands: [{ start: "docker compose up -d", stop: "docker compose down", ...commands }],
      health: { intervalMs: 30000, failureThreshold: 3, successThreshold: 1 },
    },
  };
}

function statusIssues(spec: unknown) {
  const parsed = authoredRuntimeSpecSchema.safeParse(spec);
  return parsed.success
    ? []
    : parsed.error.issues
        .filter((issue) => issue.path.join(".") === "launch.commands.0.status")
        .map((issue) => (issue as { params?: { i18n?: string } }).params?.i18n);
}

describe("status commands that can never say stopped (shared with Rust)", () => {
  it("matches the shared vectors", () => {
    for (const command of vectors.refused)
      expect(statusCanReportStopped(command), JSON.stringify(command)).toBe(false);
    for (const command of vectors.accepted)
      expect(statusCanReportStopped(command), JSON.stringify(command)).toBe(true);
    for (const command of ["true", ":", "exit 0", "/bin/true", "/usr/bin/true", "true;"])
      expect(vectors.refused).toContain(command);
  });

  it("refuses them where a status command is required or accepted", () => {
    for (const status of ["true", " true; ", ":", "exit 0;", "/usr/bin/true"])
      expect(statusIssues(service({ status })), status).toEqual(["statusNeverStopped"]);
    // A process runtime may leave status out, but one it gives must still say stopped.
    expect(statusIssues(service({ status: "true" }, "process"))).toEqual(["statusNeverStopped"]);
    // An interactive step needs a status command: the same rule.
    expect(statusIssues(service({ status: "exit 0", interactive: { start: true } }))).toEqual([
      "statusNeverStopped",
    ]);
    expect(authoredRuntimeSpecSchema.safeParse(service({ status: COMPOSE_STATUS })).success).toBe(
      true,
    );
  });

  it("explains the contract with working examples", () => {
    const parsed = authoredRuntimeSpecSchema.safeParse(service({ status: "true" }));
    const message = parsed.success ? "" : (parsed.error.issues[0]?.message ?? "");
    expect(message).toContain("exits 0 while running and 3 once stopped");
    expect(message).toContain("systemctl is-active --quiet <unit>");
    expect(message).toContain(COMPOSE_STATUS);
  });

  it("refuses them on create and update, while a stored version still reads", () => {
    const legacy = service({ status: "true" });
    expect(runtimeSpecSchema.safeParse(legacy).success).toBe(true);
    const statusPaths = (result: {
      success: boolean;
      error?: { issues: { path: PropertyKey[] }[] };
    }) => result.error?.issues.map((issue) => issue.path.join(".")) ?? [];
    const create = runtimesContract.create.input.safeParse({
      slug: "llm",
      name: "LLM",
      kind: "STARTABLE",
      spec: legacy,
    });
    expect(statusPaths(create)).toEqual(["spec.launch.commands.0.status"]);
    const update = runtimesContract.update.input.safeParse({ runtimeId: "rt1", spec: legacy });
    expect(statusPaths(update)).toContain("spec.launch.commands.0.status");
  });

  it("keys a missing service stop command for the locale bundles", () => {
    const spec = service({ status: COMPOSE_STATUS });
    delete (spec.launch.commands[0] as { stop?: string }).stop;
    const parsed = authoredRuntimeSpecSchema.safeParse(spec);
    const issue = parsed.success
      ? undefined
      : parsed.error.issues.find((item) => item.path.join(".") === "launch.commands.0.stop");
    expect((issue as { params?: { i18n?: string } } | undefined)?.params?.i18n).toBe("serviceStop");
  });

  it("no preset ships one", () => {
    for (const preset of RUNTIME_PRESET_LIST)
      for (const commands of preset.spec.launch?.commands ?? [])
        if (commands.status !== undefined)
          expect(statusCanReportStopped(commands.status), preset.id).toBe(true);
  });
});
