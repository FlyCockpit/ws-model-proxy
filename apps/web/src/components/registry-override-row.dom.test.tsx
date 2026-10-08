// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import {
  POOL_ADVANCED_COLUMNS,
  POOL_ADVANCED_OVERRIDES,
} from "@ws-model-proxy/config/pool-defaults";
import { RUNTIME_ADVANCED } from "@ws-model-proxy/config/runtime-defaults";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { RegistryOverrideRow } from "./registry-override-row";

afterEach(cleanup);

const save = async () => true;

describe("RegistryOverrideRow help", () => {
  it.each([
    ["pool column", POOL_ADVANCED_COLUMNS.maxWaitMs, "dashboard:pool.advanced.help.maxWaitMs"],
    [
      "pool affinity",
      POOL_ADVANCED_OVERRIDES.affinity.ttlSeconds,
      "dashboard:pool.advanced.help.affinity.ttlSeconds",
    ],
    [
      "pool protection",
      POOL_ADVANCED_OVERRIDES.protection.share,
      "dashboard:pool.advanced.help.protection.share",
    ],
    [
      "pool flat",
      POOL_ADVANCED_OVERRIDES.maxAttachmentBytes,
      "dashboard:pool.advanced.help.maxAttachmentBytes",
    ],
    [
      "runtime",
      RUNTIME_ADVANCED.maxAttachmentBytes,
      "dashboard:runtime.advanced.help.maxAttachmentBytes",
    ],
  ])("renders the %s field's help and ties it to the input", (_, entry, key) => {
    render(
      <RegistryOverrideRow
        id="row"
        label="Label"
        entry={entry}
        view={{ effective: null, source: "auto" }}
        pending={false}
        onSave={save}
      />,
    );
    const help = screen.getByText(key);
    expect(help.id).toBe("row-help");
    expect(screen.getByLabelText("Label").getAttribute("aria-describedby")).toBe("row-help");
  });

  it("renders no help for an entry outside the registries", () => {
    render(
      <RegistryOverrideRow
        id="row"
        label="Label"
        entry={{ kind: "int", min: 0, max: 1, auto: { default: 0 } }}
        view={undefined}
        pending={false}
        onSave={save}
      />,
    );
    expect(screen.getByLabelText("Label").getAttribute("aria-describedby")).toBeNull();
  });
});

describe("registry help copy", () => {
  it("has help for every pool and runtime field in every locale", async () => {
    const { RUNTIME_LIMIT_COLUMNS } = await import("@ws-model-proxy/config/runtime-defaults");
    const { affinity, protection, ...flat } = POOL_ADVANCED_OVERRIDES;
    const expected = [
      ...Object.keys({ ...POOL_ADVANCED_COLUMNS, ...flat }).map((k) => `pool.advanced.help.${k}`),
      ...Object.keys(affinity).map((k) => `pool.advanced.help.affinity.${k}`),
      ...Object.keys(protection).map((k) => `pool.advanced.help.protection.${k}`),
      ...Object.keys({ ...RUNTIME_LIMIT_COLUMNS, ...RUNTIME_ADVANCED }).map(
        (k) => `runtime.advanced.help.${k}`,
      ),
    ];
    for (const locale of ["en-US", "es-MX"]) {
      const bundle: unknown = (await import(`../locales/${locale}/dashboard.json`)).default;
      for (const path of expected) {
        const value = path
          .split(".")
          .reduce<unknown>(
            (node, part) =>
              typeof node === "object" && node !== null
                ? (node as Record<string, unknown>)[part]
                : undefined,
            bundle,
          );
        expect(typeof value, `${locale} ${path}`).toBe("string");
      }
    }
  });
});
