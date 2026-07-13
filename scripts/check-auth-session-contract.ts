import { spawnSync } from "node:child_process";

type Check = {
  label: string;
  args: string[];
  allow?: (line: string) => boolean;
};

const checks: Check[] = [
  {
    label: "route files must not call authClient.getSession(",
    args: ["authClient\\.getSession\\(", "apps/web/src/routes"],
  },
  {
    label: "production code must call .useSession( only in apps/web/src/hooks/use-auth-session.ts",
    args: ["\\.useSession\\(", "apps/web/src"],
    allow: (line) => line.startsWith("apps/web/src/hooks/use-auth-session.ts:"),
  },
];

let failed = false;

for (const check of checks) {
  const result = spawnSync("rg", check.args, {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  if (result.status === 1) continue;
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }

  const matches = result.stdout
    .split("\n")
    .filter(Boolean)
    .filter((line) => !check.allow?.(line));

  if (matches.length > 0) {
    failed = true;
    console.error(`[auth-session-contract] ${check.label}`);
    for (const line of matches) console.error(line);
  }
}

if (failed) process.exit(1);
