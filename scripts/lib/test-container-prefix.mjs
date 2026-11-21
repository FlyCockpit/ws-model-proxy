/**
 * The Docker name prefix of every disposable test fixture (backup:test,
 * db:test-migrations, db:test-adopt-released; test:pg uses the shell twin,
 * scripts/lib/test-container-prefix.sh, with the same rules).
 *
 * `--container-prefix <name>` wins; otherwise TEST_CONTAINER_PREFIX;
 * otherwise the harness's own default. The variable lets a chained run (CI,
 * a shared machine) keep its containers, networks and images in their own
 * namespace without passing arguments through. Test tooling only; not
 * shipped in the image.
 *
 * A valid prefix is a Docker container/network/volume name AND, with a
 * suffix, an image repository path component: lowercase alphanumerics joined
 * by single `.`/`_`, a double `__`, or runs of `-`. Bounded so every derived
 * container name stays one DNS label (at most 63 bytes): the backup test's
 * tool containers reach its Postgres by container name. An empty or invalid
 * value is an error, never a silent fallback to the default.
 */
export const PREFIX_ENV = "TEST_CONTAINER_PREFIX";
export const PREFIX_FLAG = "--container-prefix";
export const DEFAULT_TEST_CONTAINER_PREFIX = "wmp";
export const MAX_PREFIX = 24;
const PREFIX = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;

/**
 * @param {{ argv?: string[], env?: NodeJS.ProcessEnv, fallback?: string }} [options]
 *   argv: the harness's own arguments (process.argv.slice(2)).
 * @returns {string}
 */
export function testContainerPrefix({
  argv = [],
  env = process.env,
  fallback = DEFAULT_TEST_CONTAINER_PREFIX,
} = {}) {
  const index = argv.indexOf(PREFIX_FLAG);
  if (index === -1 && env[PREFIX_ENV] === undefined) return fallback;
  const [prefix, source] =
    index === -1 ? [env[PREFIX_ENV], PREFIX_ENV] : [argv[index + 1], PREFIX_FLAG];
  if (!prefix || prefix.length > MAX_PREFIX || !PREFIX.test(prefix))
    throw new Error(
      `${source} needs a Docker name prefix: lowercase letters and digits joined by ".", "_", "__" or "-", at most ${MAX_PREFIX} characters`,
    );
  return prefix;
}
