import { declaredHardwareSchema } from "@ws-model-proxy/api/lib/runtime-spec";
import { describe, expect, it } from "vitest";

import { type GpuRow, toDeclaration } from "./declared-hardware";

const FORM = { kind: "unified", memoryGb: "128", reservedMemoryGb: "" };

describe("toDeclaration", () => {
  it("declares a unified GPU without vramGb and a discrete one with it", () => {
    const gpus: GpuRow[] = [
      { vendor: "amd", index: "0", name: " Radeon 8060S ", unified: true, vramGb: "96" },
      { vendor: "nvidia", index: "1", name: "", unified: false, vramGb: "24" },
    ];
    const declaration = toDeclaration({ ...FORM, gpus }, null);
    expect(declaration).toEqual({
      kind: "unified",
      memoryGb: 128,
      gpus: [
        { vendor: "amd", index: 0, name: "Radeon 8060S", unified: true },
        { vendor: "nvidia", index: 1, vramGb: 24 },
      ],
    });
    expect(declaredHardwareSchema.safeParse(declaration).success).toBe(true);
  });

  it("keeps declared fields the form does not edit", () => {
    const declaration = toDeclaration(
      { ...FORM, gpus: [] },
      { acceleratorMemoryGb: 96, reservedVramGb: { "amd:0": 4 } },
    );
    expect(declaration).toEqual({
      kind: "unified",
      memoryGb: 128,
      acceleratorMemoryGb: 96,
      reservedVramGb: { "amd:0": 4 },
    });
  });

  it("produces an invalid declaration for a discrete GPU without VRAM", () => {
    const gpus: GpuRow[] = [{ vendor: "nvidia", index: "0", name: "", unified: false, vramGb: "" }];
    expect(declaredHardwareSchema.safeParse(toDeclaration({ ...FORM, gpus }, null)).success).toBe(
      false,
    );
  });
});
