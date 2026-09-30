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

  // A real BOM is exactly three bytes and is credited once, however the
  // transport splits it. Detecting it from the first byte alone would credit
  // the +3 once per chunk until the third byte arrives.
  it("credits a BOM exactly once when it is split one byte at a time", () => {
    const bytes = Buffer.from("\uFEFFdata: tail\n\n");
    const parser = new SseDecoder();
    const offsets: number[] = [];
    for (let index = 0; index < bytes.byteLength; index += 1) {
      parser.push(bytes.subarray(index, index + 1), (_record, offset) => offsets.push(offset));
    }
    parser.finish();
    expect(offsets).toEqual([bytes.byteLength]);
  });

  // A non-BOM stream whose first character's UTF-8 starts with 0xef (e.g.
  // U+FFFD, ef bf bd) must not be credited as a BOM. Such a stream is not
  // valid SSE: the leading character joins the first line's field name, so the
  // decoder rejects it before emitting any offset — which is why the residual
  // miscount this row guards cannot be observed through a record offset.
  it.each(["\uFFFD", "\uFEBE", "\uF8FF"])(
    "rejects a stream led by the non-BOM 0xef character %j",
    (character) => {
      expect(Buffer.from(character)[0]).toBe(0xef);
      expect(character).not.toBe("\uFEFF");
      const bytes = Buffer.from(`${character}data: tail\n\n`);
      const parser = new SseDecoder();
      const offsets: number[] = [];
      expect(() => parser.push(bytes, (_record, offset) => offsets.push(offset))).toThrow(
        "Unsupported SSE field",
      );
      expect(offsets).toEqual([]);
    },
  );
});
