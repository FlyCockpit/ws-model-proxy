import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const { parse } = createRequire(import.meta.url)("@babel/parser") as typeof import("@babel/parser");
const MODEL_OPERATIONS = new Set([
  "aggregate",
  "count",
  "create",
  "createMany",
  "createManyAndReturn",
  "delete",
  "deleteMany",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "findUnique",
  "findUniqueOrThrow",
  "groupBy",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
]);
const CLIENT_OPERATIONS = new Set([
  "$executeRaw",
  "$executeRawUnsafe",
  "$queryRaw",
  "$queryRawUnsafe",
  "$transaction",
]);
const EXCLUDED = new Set([".git", "dist", "node_modules", "prisma/generated"]);

type Node = {
  type: string;
  loc?: { start: { line: number; column: number } } | null;
  [key: string]: unknown;
};
type Provenance = "client" | "result" | "resultArray" | false;
type Environment = Map<string, Provenance>;
export type Violation = { file: string; line: number; column: number };

function node(value: unknown): Node | undefined {
  return typeof value === "object" && value !== null && "type" in value
    ? (value as Node)
    : undefined;
}
function unwrap(value: Node): Node {
  let current = value;
  while (
    [
      "AwaitExpression",
      "ChainExpression",
      "ParenthesizedExpression",
      "TSNonNullExpression",
      "TSSatisfiesExpression",
      "TSInstantiationExpression",
      "TSAsExpression",
      "TSTypeAssertion",
    ].includes(current.type)
  ) {
    const next = node(current.type === "AwaitExpression" ? current.argument : current.expression);
    if (!next) break;
    current = next;
  }
  return current;
}
function identifier(value: unknown): string | undefined {
  const candidate = node(value);
  return candidate?.type === "Identifier" ? (candidate.name as string) : undefined;
}
function memberName(value: Node): string | undefined {
  if (value.type !== "MemberExpression" && value.type !== "OptionalMemberExpression")
    return undefined;
  const property = node(value.property);
  if (property?.type === "Identifier" && value.computed !== true) return property.name as string;
  if (property?.type === "StringLiteral") return property.value as string;
  return undefined;
}
function children(value: Node): unknown[] {
  return Object.entries(value)
    .filter(([key]) => key !== "loc" && key !== "extra")
    .map(([, child]) => child);
}
function isPrismaClient(value: Node, environment: Environment): boolean {
  return environment.get(identifier(unwrap(value)) ?? "") === "client";
}
function isDelegateResult(value: Node, environment: Environment): boolean {
  const call = unwrap(value);
  if (
    call.type !== "CallExpression" &&
    call.type !== "OptionalCallExpression" &&
    call.type !== "TaggedTemplateExpression"
  )
    return false;
  const callee = unwrap(
    node(call.type === "TaggedTemplateExpression" ? call.tag : call.callee) ?? call,
  );
  const operation = memberName(callee);
  if (!operation || (!MODEL_OPERATIONS.has(operation) && !CLIENT_OPERATIONS.has(operation)))
    return false;
  const receiver = node(callee.object);
  if (!receiver) return false;
  if (CLIENT_OPERATIONS.has(operation)) return isPrismaClient(receiver, environment);
  const delegate = unwrap(receiver);
  if (delegate.type !== "MemberExpression" && delegate.type !== "OptionalMemberExpression")
    return false;
  const client = node(delegate.object);
  return client !== undefined && isPrismaClient(client, environment);
}
function isResultValue(value: Node, environment: Environment): boolean {
  return (
    isDelegateResult(value, environment) ||
    environment.get(identifier(unwrap(value)) ?? "") === "result"
  );
}
function isPromiseAll(value: Node, environment: Environment): boolean {
  const call = unwrap(value);
  if (call.type !== "CallExpression" && call.type !== "OptionalCallExpression") return false;
  const callee = unwrap(node(call.callee) ?? call);
  if (callee.type !== "MemberExpression" && callee.type !== "OptionalMemberExpression")
    return false;
  if (identifier(callee.object) !== "Promise" || memberName(callee) !== "all") return false;
  const firstArgument = node((call.arguments as unknown[] | undefined)?.[0]);
  if (firstArgument?.type !== "ArrayExpression") return false;
  return ((firstArgument.elements as unknown[] | undefined) ?? []).some((entry) => {
    const item = node(entry);
    // A const-bound Prisma promise can safely flow into Promise.all without
    // changing its result provenance. Track that alias as well as inline calls.
    return item !== undefined && isResultValue(item, environment);
  });
}
function resultProvenance(value: Node, environment: Environment): Provenance {
  if (isPrismaClient(value, environment)) return "client";
  if (isDelegateResult(value, environment)) return "result";
  if (isPromiseAll(value, environment)) return "resultArray";
  return environment.get(identifier(unwrap(value)) ?? "") ?? false;
}
function bindingNames(value: unknown): string[] {
  const current = node(value);
  if (!current) return [];
  const name = identifier(current);
  if (name) return [name];
  if (current.type === "AssignmentPattern" || current.type === "RestElement")
    return bindingNames(current.left ?? current.argument);
  if (current.type === "ArrayPattern")
    return ((current.elements as unknown[] | undefined) ?? []).flatMap(bindingNames);
  if (current.type === "ObjectPattern")
    return ((current.properties as Node[] | undefined) ?? []).flatMap((property) =>
      bindingNames(property.value ?? property.argument),
    );
  return [];
}
function isAssertion(value: Node): boolean {
  return value.type === "TSAsExpression" || value.type === "TSTypeAssertion";
}
function setBindingProvenance(
  pattern: unknown,
  provenance: Provenance,
  environment: Environment,
): void {
  const current = node(pattern);
  if (!current) return;
  const name = identifier(current);
  if (name) {
    environment.set(name, provenance);
    return;
  }
  if (current.type === "AssignmentPattern" || current.type === "RestElement") {
    setBindingProvenance(current.left ?? current.argument, provenance, environment);
    return;
  }
  if (current.type === "ArrayPattern") {
    // Promise.all preserves positional results. An array destructure of a
    // result-bearing Promise.all is therefore a direct Prisma result flow.
    for (const element of (current.elements as unknown[] | undefined) ?? []) {
      setBindingProvenance(element, provenance === "resultArray" ? "result" : false, environment);
    }
    return;
  }
  for (const name of bindingNames(current)) environment.set(name, false);
}

/** Reject type assertions whose value is a direct or one-const-hop Prisma result. */
export function findViolations(source: string, file = "fixture.ts"): Violation[] {
  const ast = parse(source, {
    sourceType: "module",
    sourceFilename: file,
    plugins: file.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"],
  });
  const violations: Violation[] = [];
  const seen = new Set<unknown>();
  const reported = new Set<Node>();
  function visit(value: unknown, environment: Environment, transactionParameter = false): void {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, environment);
      return;
    }
    const current = node(value);
    if (!current || seen.has(current)) return;
    seen.add(current);
    if (current.type === "Program" || current.type === "BlockStatement") {
      const body = (current.body as Node[] | undefined) ?? [];
      const scoped = new Map(environment);
      for (const statement of body) visit(statement, scoped);
      return;
    }
    if (current.type === "ImportDeclaration") {
      if (node(current.source)?.value === "@ws-model-proxy/db" && current.importKind !== "type") {
        for (const specifier of (current.specifiers as Node[] | undefined) ?? []) {
          if (
            specifier.type === "ImportDefaultSpecifier" ||
            (specifier.type === "ImportSpecifier" && identifier(specifier.imported) === "default")
          ) {
            const local = identifier(specifier.local);
            if (local) environment.set(local, "client");
          }
        }
      }
      return;
    }
    if (current.type === "VariableDeclaration") {
      for (const declaration of (current.declarations as Node[] | undefined) ?? []) {
        const init = node(declaration.init);
        if (init) visit(init, environment);
        const provenance =
          current.kind === "const" && init ? resultProvenance(init, environment) : false;
        setBindingProvenance(declaration.id, provenance, environment);
      }
      return;
    }
    if (
      [
        "ArrowFunctionExpression",
        "FunctionDeclaration",
        "FunctionExpression",
        "ObjectMethod",
        "ClassMethod",
      ].includes(current.type)
    ) {
      const scoped = new Map(environment);
      for (const [index, parameter] of ((current.params as Node[] | undefined) ?? []).entries())
        for (const name of bindingNames(parameter))
          scoped.set(name, transactionParameter && index === 0 ? "client" : false);
      visit(current.body, scoped);
      return;
    }
    if (isAssertion(current)) {
      const expression = node(current.expression);
      const sourceNode =
        expression &&
        (isDelegateResult(expression, environment)
          ? unwrap(expression)
          : environment.get(identifier(unwrap(expression)) ?? "") === "result"
            ? expression
            : undefined);
      if (sourceNode && !reported.has(sourceNode)) {
        reported.add(sourceNode);
        violations.push({
          file,
          line: current.loc?.start.line ?? 1,
          column: (current.loc?.start.column ?? 0) + 1,
        });
      }
    }
    const isTransaction =
      isDelegateResult(current, environment) &&
      memberName(unwrap(node(current.callee) ?? current)) === "$transaction";
    if (isTransaction) {
      visit(current.callee, environment);
      for (const [index, argument] of ((current.arguments as Node[] | undefined) ?? []).entries())
        visit(
          argument,
          environment,
          index === 0 &&
            ["ArrowFunctionExpression", "FunctionExpression"].includes(unwrap(argument).type),
        );
      return;
    }
    for (const child of children(current)) visit(child, environment);
  }
  visit(ast, new Map());
  return violations;
}

export function listPolicyFiles(root = process.cwd()): string[] {
  const result = spawnSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      "*.ts",
      "*.tsx",
      "*.mts",
      "*.cts",
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr.trim());
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .filter((file) => existsSync(path.join(root, file)))
    .filter(
      (file) =>
        !file
          .split("/")
          .some(
            (part, index, parts) =>
              EXCLUDED.has(part) || EXCLUDED.has(parts.slice(index, index + 2).join("/")),
          ),
    )
    .sort();
}
function main(): void {
  const args = process.argv.slice(2);
  let files: string[];
  try {
    files = args.length === 1 && args[0] === "--scan" ? listPolicyFiles() : args;
  } catch (error) {
    console.error(`Prisma query-cast policy could not enumerate inputs: ${String(error)}`);
    process.exitCode = 2;
    return;
  }
  if (files.length === 0) {
    console.error("Prisma query-cast policy received no TypeScript files.");
    process.exitCode = 2;
    return;
  }
  try {
    const violations = files.flatMap((file) => findViolations(readFileSync(file, "utf8"), file));
    for (const violation of violations)
      console.error(
        `${violation.file}:${violation.line}:${violation.column} Do not assert a type on a Prisma operation result. Remove the assertion and rely on inference; schema-check reusable query arguments with the appropriate generated Prisma type.`,
      );
    if (violations.length) process.exitCode = 1;
    else console.log(`Prisma query-cast policy passed (${files.length} files).`);
  } catch (error) {
    console.error(
      `Prisma query-cast policy could not parse an input: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 2;
  }
}
if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
