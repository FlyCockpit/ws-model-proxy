import { describe, expect, it } from "vitest";
import { TEST_NODE_FEATURES } from "./node-features-test-fixture";
import { nodeFeaturesSchema } from "./runtime-spec";

describe("node features", () => {
  it("reads current node capabilities without optional launch evidence", () => {
    const { launch: _launch, ...features } = TEST_NODE_FEATURES;
    expect(nodeFeaturesSchema.parse(features)).toEqual(features);
  });

  it("keeps live feature reports strict about unknown keys", () => {
    expect(
      nodeFeaturesSchema.safeParse({ ...TEST_NODE_FEATURES, unknownPolicy: true }).success,
    ).toBe(false);
  });
});
