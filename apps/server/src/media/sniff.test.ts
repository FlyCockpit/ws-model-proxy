import { describe, expect, it } from "vitest";
import { sniffMediaMime } from "./sniff.js";

function bytes(...vals: number[]): Uint8Array {
  return new Uint8Array(vals);
}

function ascii(str: string, pad = 0): Uint8Array {
  const base = Array.from(str, (c) => c.charCodeAt(0));
  while (base.length < pad) base.push(0);
  return new Uint8Array(base);
}

/** Build an ISO-BMFF header: [size][ftyp][brand]. */
function ftyp(brand: string): Uint8Array {
  return new Uint8Array([0, 0, 0, 0x18, ...ascii("ftyp"), ...ascii(brand)]);
}

describe("sniffMediaMime — accepts allowlisted types", () => {
  it("detects JPEG", () => {
    expect(sniffMediaMime(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
  });
  it("detects PNG", () => {
    expect(sniffMediaMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
  });
  it("detects GIF", () => {
    expect(sniffMediaMime(ascii("GIF89a"))).toBe("image/gif");
  });
  it("detects WebP", () => {
    const buf = new Uint8Array([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP")]);
    expect(sniffMediaMime(buf)).toBe("image/webp");
  });
  it("detects WAV", () => {
    const buf = new Uint8Array([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WAVE")]);
    expect(sniffMediaMime(buf)).toBe("audio/wav");
  });
  it("detects FLAC", () => {
    expect(sniffMediaMime(ascii("fLaC"))).toBe("audio/flac");
  });
  it("detects Ogg/Opus", () => {
    expect(sniffMediaMime(ascii("OggS"))).toBe("audio/ogg");
  });
  it("detects MP3 via ID3", () => {
    expect(sniffMediaMime(ascii("ID3"))).toBe("audio/mpeg");
  });
  it("detects MP3 via frame sync", () => {
    expect(sniffMediaMime(bytes(0xff, 0xfb, 0x90, 0x00))).toBe("audio/mpeg");
  });
  it("detects a real-ish MPEG1 Layer III frame header (128 kbps, 44.1 kHz)", () => {
    // FF FB: sync + MPEG1 (11) + Layer III (01) + no CRC. 90: bitrate idx 1001,
    // sample rate 00 (44.1 kHz). A valid, non-reserved frame header.
    expect(sniffMediaMime(bytes(0xff, 0xfb, 0x90, 0x44))).toBe("audio/mpeg");
  });
  it("detects MP4 (isom brand) as video/mp4", () => {
    expect(sniffMediaMime(ftyp("isom"))).toBe("video/mp4");
  });
  it("detects M4A brand as audio/mp4", () => {
    expect(sniffMediaMime(ftyp("M4A "))).toBe("audio/mp4");
  });
  it("detects QuickTime brand as video/quicktime", () => {
    expect(sniffMediaMime(ftyp("qt  "))).toBe("video/quicktime");
  });
  it("detects WebM via EBML + doctype", () => {
    const buf = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...ascii(" ... webm ... ")]);
    expect(sniffMediaMime(buf)).toBe("video/webm");
  });
  it("detects Matroska via EBML", () => {
    const buf = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...ascii(" matroska ")]);
    expect(sniffMediaMime(buf)).toBe("video/x-matroska");
  });
});

describe("sniffMediaMime — rejects everything else", () => {
  it("rejects SVG (script-carrying XML)", () => {
    expect(sniffMediaMime(ascii('<svg xmlns="http://www.w3.org/2000/svg">'))).toBeNull();
  });
  it("rejects HTML", () => {
    expect(sniffMediaMime(ascii("<!DOCTYPE html><html>"))).toBeNull();
  });
  it("rejects plain text", () => {
    expect(sniffMediaMime(ascii("hello world"))).toBeNull();
  });
  it("rejects empty input", () => {
    expect(sniffMediaMime(new Uint8Array())).toBeNull();
  });
  it("rejects a PDF", () => {
    expect(sniffMediaMime(ascii("%PDF-1.7"))).toBeNull();
  });
  it("rejects FF E0 garbage with reserved layer bits (loose sync false positive)", () => {
    // 0xE0 = sync ok, version 00 (MPEG2.5), layer 00 (RESERVED) → not a frame.
    expect(sniffMediaMime(bytes(0xff, 0xe0, 0x00, 0x00))).toBeNull();
  });
  it("rejects a frame with reserved version bits", () => {
    // 0xEB = version 01 (RESERVED) even though layer bits look valid.
    expect(sniffMediaMime(bytes(0xff, 0xeb, 0x90, 0x00))).toBeNull();
  });
  it("rejects a frame with an invalid (1111) bitrate index", () => {
    // 0xFB valid version/layer, but byte 2 high nibble 1111 = bad bitrate.
    expect(sniffMediaMime(bytes(0xff, 0xfb, 0xf0, 0x00))).toBeNull();
  });
  it("rejects all-0xFF garbage", () => {
    expect(sniffMediaMime(bytes(0xff, 0xff, 0xff, 0xff))).toBeNull();
  });
});
