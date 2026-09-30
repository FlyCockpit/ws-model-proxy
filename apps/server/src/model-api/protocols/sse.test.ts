import { describe, expect, it } from "vitest";
import { SseDecoder, type SseRecord } from "./sse.js";

describe("SSE record byte offsets", () => {
  const cases = ["\n\n", "\r\n\r\n", "\r\r"].flatMap((delimiter) =>
    [false, true].map((bom) => ({ delimiter, bom })),
  );

  it.each(cases)(
    "counts UTF-8, comments and framing: $delimiter BOM=$bom",
    ({ delimiter, bom }) => {
      const comment = `: hé${delimiter}`;
      const first = `event: terminal\ndata: hé${delimiter}`;
      const second = `data: tail${delimiter}`;
      const bytes = Buffer.from(`${bom ? "\uFEFF" : ""}${comment}${first}${second}`);
      const expected = [
        Buffer.byteLength(`${bom ? "\uFEFF" : ""}${comment}${first}`),
        bytes.byteLength,
      ];
      const records = [{ event: "terminal", data: "hé" }, { data: "tail" }];
      for (const width of [1, 7, bytes.byteLength]) {
        const parser = new SseDecoder();
        const offsets: number[] = [];
        const observed: SseRecord[] = [];
        for (let index = 0; index < bytes.byteLength; index += width) {
          observed.push(
            ...parser.push(bytes.subarray(index, index + width), (_record, offset) => {
              offsets.push(offset);
            }),
          );
        }
        observed.push(...parser.finish());
        expect(observed).toEqual(records);
        expect(offsets).toEqual(expected);
      }
      // Omitting the production observer preserves the decoder's record contract.
      const parser = new SseDecoder();
      expect([...parser.push(bytes), ...parser.finish()]).toEqual(records);
    },
  );
});
