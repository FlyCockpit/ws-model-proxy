import { describe, expect, it } from "vitest";
import { embeddingContractsMatch, parseEmbeddingContract } from "./embedding-contract";

const contract = {
  model: "embed-model",
  revision: "revision-1",
  dimensions: 768,
  normalization: "l2",
  vectorSpace: "space-1",
};
describe("embedding contracts", () => {
  it("requires a complete explicit contract", () => {
    expect(parseEmbeddingContract(null)).toBeNull();
    expect(parseEmbeddingContract({ dimensions: 768 })).toBeNull();
    expect(embeddingContractsMatch(contract, { ...contract })).toBe(true);
  });
  it.each(["model", "revision", "dimensions", "normalization", "vectorSpace"])(
    "rejects different %s even with the same dimensions",
    (field) => {
      expect(
        embeddingContractsMatch(contract, {
          ...contract,
          [field]: field === "dimensions" ? 1024 : field === "normalization" ? "none" : "different",
        }),
      ).toBe(false);
    },
  );
});
