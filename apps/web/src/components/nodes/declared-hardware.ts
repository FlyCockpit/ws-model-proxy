/**
 * The hardware declaration the node hardware form saves (`nodes.update` `hardware`).
 */
import type { DeclaredHardware, GpuVendor } from "@ws-model-proxy/api/lib/runtime-spec";

export const KINDS = ["cpu", "discrete", "unified"] as const;
export type Kind = (typeof KINDS)[number];

export type GpuRow = {
  vendor: GpuVendor;
  index: string;
  name: string;
  /** Shares system memory (an APU, GB10): no VRAM of its own. */
  unified: boolean;
  vramGb: string;
};

/**
 * The declaration this form saves. Fields it does not edit (accelerator memory, reserved VRAM)
 * keep their declared values, so saving never drops them.
 */
export function toDeclaration(
  value: { kind: string; memoryGb: string; reservedMemoryGb: string; gpus: GpuRow[] },
  declared: DeclaredHardware | null,
): DeclaredHardware {
  const out: DeclaredHardware = {};
  const kind = KINDS.find((candidate) => candidate === value.kind);
  if (kind) out.kind = kind;
  if (value.memoryGb.trim() !== "") out.memoryGb = Number(value.memoryGb);
  if (declared?.acceleratorMemoryGb !== undefined)
    out.acceleratorMemoryGb = declared.acceleratorMemoryGb;
  if (value.reservedMemoryGb.trim() !== "") out.reservedMemoryGb = Number(value.reservedMemoryGb);
  if (declared?.reservedVramGb !== undefined) out.reservedVramGb = declared.reservedVramGb;
  if (value.gpus.length > 0)
    out.gpus = value.gpus.map((row) => ({
      vendor: row.vendor,
      index: row.index.trim() === "" ? Number.NaN : Number(row.index),
      ...(row.name.trim() === "" ? {} : { name: row.name.trim() }),
      ...(row.unified ? { unified: true } : { vramGb: Number(row.vramGb) }),
    }));
  return out;
}
