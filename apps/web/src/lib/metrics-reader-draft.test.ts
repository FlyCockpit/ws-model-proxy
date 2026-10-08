import { metricsReaderSchema } from "@ws-model-proxy/api/lib/runtime-spec";
import { describe, expect, it } from "vitest";

import {
  draftToReader,
  READER_PRESET_VALUES,
  READER_PRESETS,
  readerToDraft,
} from "./metrics-reader-draft";

describe("metrics reader draft", () => {
  it.each(READER_PRESETS)("preset %s is a valid reader and round-trips", (id) => {
    const reader = READER_PRESET_VALUES[id];
    expect(metricsReaderSchema.safeParse(reader).success).toBe(true);
    expect(draftToReader(readerToDraft(reader), reader)).toEqual(reader);
  });

  it("keeps series labels the form does not edit", () => {
    const reader = {
      kind: "route" as const,
      route: "/stats",
      format: "json" as const,
      intervalSecs: 5,
      countRoute: "/tokenize",
      map: { running: { series: "/a", labels: { model: "x" }, scale: 0.5, divideBy: "/b" } },
    };
    const draft = readerToDraft(reader);
    draft.map[0].scale = "2";
    expect(draftToReader(draft, reader)).toEqual({
      ...reader,
      map: { running: { series: "/a", labels: { model: "x" }, scale: 2, divideBy: "/b" } },
    });
    // Another series: the old labels would select the wrong samples.
    draft.map[0].series = "/c";
    expect(draftToReader(draft, reader)).toEqual({
      ...reader,
      map: { running: { series: "/c", scale: 2, divideBy: "/b" } },
    });
  });

  it("no reader reads as undefined", () => {
    expect(draftToReader(readerToDraft(undefined), undefined)).toBeUndefined();
  });
});
