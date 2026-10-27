import { afterEach, describe, expect, it, vi } from "vitest";
import vectors from "../../../../packages/config/src/terminal-image-vectors.json";
import {
  decodeTerminalImageMessage,
  encodeTerminalImageChunk,
  encodeTerminalImageControl,
  TERMINAL_IMAGE_ACK_TIMEOUT_MS,
  TERMINAL_IMAGE_CANCEL,
  TERMINAL_IMAGE_CHUNK_BYTES,
  TERMINAL_IMAGE_PASTE,
  TERMINAL_IMAGE_REPLY,
  TerminalImageTransfer,
  terminalImagePasteText,
} from "./terminal-images";

const fromHex = (value: string) => Uint8Array.from(Buffer.from(value, "hex"));
const replyBytes = (value: unknown) =>
  Uint8Array.from([TERMINAL_IMAGE_REPLY, ...new TextEncoder().encode(JSON.stringify(value))]);

afterEach(() => {
  vi.useRealTimers();
});

describe("terminal image uploads", () => {
  it.each([true, false])(
    "cancels an unused offer once, only while its session is current (%s)",
    async (stillCurrent) => {
      const transfer = new TerminalImageTransfer();
      transfer.supported = true;
      let current = true;
      const cancelledIds: string[] = [];
      const offered = await transfer.upload(
        new File(["png"], "image.png", { type: "image/png" }),
        (bytes) => {
          const id = Buffer.from(bytes.slice(1, 17)).toString("hex");
          if (bytes[0] === TERMINAL_IMAGE_CANCEL) cancelledIds.push(id);
          else transfer.receive({ id, received: 3, path: vectors.reply.path });
        },
        () => current,
        () => undefined,
      );
      expect(cancelledIds).toEqual([]);
      current = stillCurrent;
      offered.cancel();
      offered.cancel();
      expect(cancelledIds).toEqual(stillCurrent ? [offered.id] : []);
    },
  );

  it("rejects a node error without producing a paste", async () => {
    const transfer = new TerminalImageTransfer();
    transfer.supported = true;
    const progress = vi.fn();
    await expect(
      transfer.upload(
        new File(["png"], "image.png", { type: "image/png" }),
        (bytes) => {
          const id = Buffer.from(bytes.slice(1, 17)).toString("hex");
          const decoded = decodeTerminalImageMessage(
            replyBytes({ id, received: 0, error: "node_limit" }),
          );
          if (decoded?.kind !== "imageReply") throw new Error("missing reply");
          transfer.receive(decoded.reply);
        },
        () => true,
        progress,
      ),
    ).rejects.toThrow("node_limit");
    expect(progress).not.toHaveBeenCalled();
  });

  it("times out after 15 seconds without an acknowledgement and can retry", async () => {
    vi.useFakeTimers();
    const transfer = new TerminalImageTransfer();
    transfer.supported = true;
    let sent: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      sent = resolve;
    });
    const promise = transfer.upload(
      new File(["png"], "image.png", { type: "image/png" }),
      () => sent?.(),
      () => true,
      () => undefined,
    );
    const rejected = expect(promise).rejects.toThrow("timeout");
    await started;
    await vi.advanceTimersByTimeAsync(TERMINAL_IMAGE_ACK_TIMEOUT_MS);
    await rejected;
    const retry = await transfer.upload(
      new File(["png"], "image.png", { type: "image/png" }),
      (bytes) =>
        transfer.receive({
          id: Buffer.from(bytes.slice(1, 17)).toString("hex"),
          received: 3,
          path: vectors.reply.path,
        }),
      () => true,
      () => undefined,
    );
    expect(retry).toEqual({
      id: expect.stringMatching(/^[a-f0-9]{32}$/),
      text: `${vectors.reply.path} `,
      cancel: expect.any(Function),
    });
  });

  it("uses the same wire fixtures as the Rust CLI", () => {
    expect(
      encodeTerminalImageControl(TERMINAL_IMAGE_PASTE, vectors.paste.id, vectors.paste.text),
    ).toEqual(fromHex(vectors.paste.plaintextHex));
    expect(encodeTerminalImageControl(TERMINAL_IMAGE_CANCEL, vectors.paste.id)).toEqual(
      fromHex(vectors.cancelHex),
    );
    expect(decodeTerminalImageMessage(fromHex(vectors.capabilitiesHex))).toEqual({
      kind: "imageCapabilities",
    });
    expect(
      encodeTerminalImageChunk({
        ...vectors.chunk,
        data: fromHex(vectors.chunk.dataHex),
      }),
    ).toEqual(fromHex(vectors.chunk.plaintextHex));
    expect(decodeTerminalImageMessage(replyBytes(vectors.reply))).toEqual({
      kind: "imageReply",
      reply: vectors.reply,
    });
  });

  it("rejects control characters in returned paths and quotes shell metacharacters", () => {
    for (const path of ["relative.png", "/tmp/a\n.png", "/tmp/\x1b[31m.png", "/tmp/é.png"]) {
      expect(() => terminalImagePasteText(path)).toThrow();
      expect(() => decodeTerminalImageMessage(replyBytes({ ...vectors.reply, path }))).toThrow();
    }
    expect(terminalImagePasteText("/tmp/a b'$(touch marker).png")).toBe(
      "'/tmp/a b'\\''$(touch marker).png' ",
    );
  });

  it("pastes a Windows node's own quoting as is", () => {
    const { windowsReply } = vectors;
    expect(decodeTerminalImageMessage(replyBytes(windowsReply))).toEqual({
      kind: "imageReply",
      reply: windowsReply,
    });
    expect(terminalImagePasteText(windowsReply.path, windowsReply.paste)).toBe(windowsReply.paste);
    // A drive path only comes with the node's text, and that text with a path.
    const { paste: _paste, ...withoutPaste } = windowsReply;
    const { path: _path, ...withoutPath } = windowsReply;
    for (const reply of [
      withoutPaste,
      withoutPath,
      { ...windowsReply, paste: "C:\\image.png" },
      { ...windowsReply, paste: "C:\\a\x1b[31m.png " },
      { ...windowsReply, paste: 7 },
    ]) {
      expect(() => decodeTerminalImageMessage(replyBytes(reply))).toThrow();
    }
    expect(() => terminalImagePasteText(windowsReply.path)).toThrow();
    expect(() => terminalImagePasteText(windowsReply.path, "line\nbreak ")).toThrow();
  });

  it("refuses an older CLI without sending any bytes", async () => {
    const transfer = new TerminalImageTransfer();
    let sends = 0;
    await expect(
      transfer.upload(
        new File(["png"], "image.png", { type: "image/png" }),
        () => {
          sends += 1;
        },
        () => true,
        () => undefined,
      ),
    ).rejects.toThrow("update");
    expect(sends).toBe(0);
  });

  it("waits for every chunk acknowledgement before returning the saved path", async () => {
    const transfer = new TerminalImageTransfer();
    transfer.supported = true;
    const file = new File([new Uint8Array(TERMINAL_IMAGE_CHUNK_BYTES + 8)], "image.png", {
      type: "image/png",
    });
    const offsets: number[] = [];
    const progress: number[] = [];
    const path = await transfer.upload(
      file,
      (bytes) => {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const offset = view.getUint32(21, false);
        const received = offset + bytes.length - 26;
        offsets.push(offset);
        transfer.receive({
          id: Buffer.from(bytes.slice(1, 17)).toString("hex"),
          received,
          ...(received === file.size ? { path: vectors.reply.path } : {}),
        });
      },
      () => true,
      (value) => progress.push(value),
    );
    expect(offsets).toEqual([0, TERMINAL_IMAGE_CHUNK_BYTES]);
    expect(progress.at(-1)).toBe(100);
    expect(path).toEqual({
      id: expect.stringMatching(/^[a-f0-9]{32}$/),
      text: `${vectors.reply.path} `,
      cancel: expect.any(Function),
    });
  });

  it("never returns a paste after the session disconnects", async () => {
    const transfer = new TerminalImageTransfer();
    transfer.supported = true;
    await expect(
      transfer.upload(
        new File(["png"], "image.png", { type: "image/png" }),
        () => transfer.abort(),
        () => true,
        () => undefined,
      ),
    ).rejects.toThrow("unavailable");
  });
});
