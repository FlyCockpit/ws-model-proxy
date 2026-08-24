import { describe, expect, it } from "vitest";
import type { MultipartPart } from "./multipart-form-data.js";
import {
  isBasicTranscriptionRequest,
  TranscriptionRequestError,
  transcriptionCapabilityCompatible,
  transcriptionRequestProfile,
  transcriptionRequestProfileFromParts,
} from "./transcription-request.js";

function requestForm(): FormData {
  const form = new FormData();
  form.set("model", "public/model");
  form.set("file", new File(["audio"], "voice.wav", { type: "audio/wav" }));
  return form;
}

describe("transcriptionRequestProfile", () => {
  it("extracts streaming and advanced request constraints without consuming extensions", () => {
    const form = requestForm();
    form.set("stream", "true");
    form.set("response_format", "diarized_json");
    form.append("timestamp_granularities[]", "word");
    form.append("timestamp_granularities[]", "segment");
    form.set("language", "de");
    form.set("vendor_option", "preserved");

    expect(transcriptionRequestProfile(form)).toEqual({
      stream: true,
      responseFormat: "diarized_json",
      timestampGranularities: ["word", "segment"],
      diarizationRequested: true,
      languageHints: ["de"],
      fileMimeType: "audio/wav",
      fileSize: 5,
    });
    expect(form.get("vendor_option")).toBe("preserved");
  });

  it("rejects ambiguous files and non-boolean stream values", () => {
    const duplicate = requestForm();
    duplicate.append("file", new File(["more"], "second.wav"));
    expect(() => transcriptionRequestProfile(duplicate)).toThrowError(TranscriptionRequestError);

    const invalidStream = requestForm();
    invalidStream.set("stream", "1");
    expect(() => transcriptionRequestProfile(invalidStream)).toThrowError(/true or false/);
  });

  it.each([
    ["file", "field"],
    ["model", "file"],
    ["stream", "file"],
    ["response_format", "file"],
    ["timestamp_granularities[]", "file"],
    ["timestamp_granularities", "file"],
    ["language", "file"],
    ["languages[]", "file"],
    ["diarization", "file"],
  ] as const)("rejects a type-confused exact known part name: %s", (name, kind) => {
    const validFile: MultipartPart = {
      kind: "file",
      name: "file",
      filename: "voice.wav",
      mimeType: "audio/wav",
      path: "/unused",
      size: 1,
    };
    const confused: MultipartPart =
      kind === "field"
        ? { kind: "field", name, value: "not-a-file" }
        : { kind: "file", name, filename: "x", mimeType: "text/plain", path: "/unused", size: 1 };
    expect(() =>
      transcriptionRequestProfileFromParts([
        { kind: "field", name: "model", value: "m" },
        validFile,
        confused,
      ]),
    ).toThrowError(TranscriptionRequestError);
  });

  it("does not confuse vendor names that merely resemble known fields", () => {
    const profile = transcriptionRequestProfileFromParts([
      { kind: "field", name: "model", value: "m" },
      {
        kind: "file",
        name: "file",
        filename: "voice.wav",
        mimeType: "audio/wav",
        path: "/unused",
        size: 1,
      },
      {
        kind: "file",
        name: "stream_vendor",
        filename: "extension.bin",
        mimeType: "application/octet-stream",
        path: "/unused",
        size: 1,
      },
    ]);
    expect(profile.stream).toBe(false);
  });
});

describe("transcriptionCapabilityCompatible", () => {
  const advanced = transcriptionRequestProfile(
    (() => {
      const form = requestForm();
      form.set("stream", "true");
      form.set("response_format", "verbose_json");
      form.append("timestamp_granularities[]", "word");
      form.set("language", "en");
      return form;
    })(),
  );

  it("requires affirmative detailed support for advanced requests", () => {
    expect(
      transcriptionCapabilityCompatible({ capability: { supported: true }, request: advanced }),
    ).toBe(false);
    expect(
      transcriptionCapabilityCompatible({
        capability: {
          supported: true,
          streaming: true,
          responseFormats: ["verbose_json"],
          timestampGranularities: ["word"],
          languages: ["en"],
          acceptedMimeTypes: ["audio/wav"],
          maxUploadBytes: 1024,
        },
        request: advanced,
      }),
    ).toBe(true);
  });

  it("rejects omitted language when automatic detection is explicitly unsupported", () => {
    const request = transcriptionRequestProfile(requestForm());
    expect(
      transcriptionCapabilityCompatible({
        capability: { supported: true, languageDetection: false },
        request,
      }),
    ).toBe(false);
    expect(
      transcriptionCapabilityCompatible({
        capability: { supported: true },
        request,
      }),
    ).toBe(true);
    expect(
      transcriptionCapabilityCompatible({
        capability: { supported: true, languageDetection: false, languages: ["en"] },
        request: { ...request, languageHints: ["en"] },
      }),
    ).toBe(true);
  });

  it("keeps v1-style basic support eligible for a basic request", () => {
    expect(
      transcriptionCapabilityCompatible({
        capability: { supported: true },
        request: transcriptionRequestProfile(requestForm()),
      }),
    ).toBe(true);
  });

  it("matches language tags and MIME types case-insensitively", () => {
    expect(
      transcriptionCapabilityCompatible({
        capability: {
          supported: true,
          languages: ["EN-us"],
          acceptedMimeTypes: ["Audio/WAV"],
        },
        request: {
          ...transcriptionRequestProfile(requestForm()),
          languageHints: ["en-US"],
          fileMimeType: "audio/wav",
        },
      }),
    ).toBe(true);
  });
});

describe("isBasicTranscriptionRequest", () => {
  it("only permits the default non-streaming, unconstrained request shape", () => {
    const basic = transcriptionRequestProfile(requestForm());
    expect(isBasicTranscriptionRequest(basic)).toBe(true);
    expect(isBasicTranscriptionRequest({ ...basic, stream: true })).toBe(false);
    expect(isBasicTranscriptionRequest({ ...basic, responseFormat: "text" })).toBe(false);
    expect(isBasicTranscriptionRequest({ ...basic, timestampGranularities: ["word"] })).toBe(false);
    expect(isBasicTranscriptionRequest({ ...basic, diarizationRequested: true })).toBe(false);
    expect(isBasicTranscriptionRequest({ ...basic, languageHints: ["en"] })).toBe(false);
  });
});
