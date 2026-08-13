import { describe, expect, it } from "vitest";

import {
  acceptedAttachmentAcceptAttr,
  attachmentFileInfo,
  attachmentModalityForType,
  rewriteDataUrlMime,
} from "./image-attachments";

describe("chat attachment media selection", () => {
  it("includes explicit iOS-compatible extensions and aliases in the picker filter", () => {
    const accept = acceptedAttachmentAcceptAttr({ image: false, audio: true, video: true });

    expect(accept).toContain("audio/x-m4a");
    expect(accept).toContain(".m4a");
    expect(accept).toContain(".mov");
    expect(accept).toContain(".mkv");
  });

  it.each([
    [
      { name: "voice-note.m4a", type: "audio/x-m4a" },
      { modality: "audio", mime: "audio/mp4" },
    ],
    [
      { name: "voice-note.m4a", type: "" },
      { modality: "audio", mime: "audio/mp4" },
    ],
    [
      { name: "clip.MOV", type: "" },
      { modality: "video", mime: "video/quicktime" },
    ],
    [
      { name: "clip.m4v", type: "video/x-m4v" },
      { modality: "video", mime: "video/mp4" },
    ],
    [
      { name: "image.jpg", type: "" },
      { modality: "image", mime: "image/jpeg" },
    ],
  ])(
    "recognizes supported media despite a blank or vendor-specific MIME type",
    (file, expected) => {
      expect(attachmentFileInfo(file)).toEqual(expected);
    },
  );

  it("does not accept an unsupported extension simply because its declared MIME is empty", () => {
    expect(attachmentFileInfo({ name: "notes.txt", type: "" })).toBeNull();
  });

  it("normalizes known audio aliases when no filename is available", () => {
    expect(attachmentModalityForType("audio/x-m4a")).toBe("audio");
  });

  it("rewrites an empty or generic FileReader data-URL MIME to the canonical MIME", () => {
    expect(rewriteDataUrlMime("data:;base64,Zm9v", "audio/mp4")).toBe("data:audio/mp4;base64,Zm9v");
    expect(rewriteDataUrlMime("data:application/octet-stream;base64,Zm9v", "audio/mp4")).toBe(
      "data:audio/mp4;base64,Zm9v",
    );
  });
});
