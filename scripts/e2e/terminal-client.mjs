import assert from "node:assert/strict";
import { tsImport } from "tsx/esm/api";

// Use the same tested E2E primitives as the browser's terminal crypto tests.
const terminalCrypto = await tsImport(
  "../../apps/web/src/hooks/use-terminal-crypto.ts",
  import.meta.url,
);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function openTerminalTestClient({ WebSocket, serverUrl, cookie, terminalId }) {
  const handshake = await terminalCrypto.generateEphemeralHandshake();
  const socket = new WebSocket(`${serverUrl.replace("http", "ws")}/api/dashboard/terminal/ws`, {
    headers: { cookie, origin: serverUrl },
  });
  let failure;
  let keys;
  let viewerId;
  let sequence = 0n;
  let screen = "";
  const messages = [];
  const outputKeys = new Map();
  let chain = Promise.resolve();
  socket.on("error", (error) => {
    failure = error;
  });
  socket.on("message", (data, binary) => {
    // Preserve key-delivery / scrollback order across asynchronous crypto.
    chain = chain
      .then(async () => {
        if (!binary) {
          const message = JSON.parse(data.toString());
          messages.push(message);
          if (message.type === "attaching") viewerId = message.viewerId;
          if (message.type === "attached") {
            assert(viewerId, "attach did not assign a viewer");
            const cliPublicRaw = terminalCrypto.base64UrlToBytes(message.cliPublicKey);
            keys = await terminalCrypto.deriveTerminalSessionKeysV2({
              browserPrivateKey: handshake.privateKey,
              browserPublicRaw: handshake.publicKeyRaw,
              browserNonce: handshake.nonce,
              cliPublicRaw,
              cliPublicKey: await terminalCrypto.importEcdhPublicRaw(cliPublicRaw),
              cliNonce: terminalCrypto.base64UrlToBytes(message.cliNonce),
              terminalId,
              viewerId,
            });
          }
          if (message.type === "error" || message.type === "rejected")
            throw new Error(`terminal refused: ${message.code ?? message.reason}`);
          return;
        }
        assert(keys, "terminal bytes preceded attachment");
        const length = data.readUInt32BE(0);
        const metadata = JSON.parse(data.subarray(4, 4 + length).toString());
        assert.equal(metadata.terminalId, terminalId);
        const ciphertext = new Uint8Array(data.subarray(4 + length));
        const plaintext =
          metadata.epoch === undefined
            ? await terminalCrypto.openTerminalBytesV2({
                key: keys.cliToBrowser,
                terminalId,
                viewerId,
                direction: terminalCrypto.DIRECTION_CLI_TO_BROWSER,
                seq: BigInt(metadata.seq),
                ciphertext,
              })
            : await terminalCrypto.openTerminalBroadcast({
                key: outputKeys.get(metadata.epoch),
                terminalId,
                epoch: metadata.epoch,
                seq: BigInt(metadata.seq),
                ciphertext,
              });
        const decoded = terminalCrypto.decodeTerminalPlaintextV2(plaintext);
        if (decoded.kind === "outputKey")
          outputKeys.set(decoded.epoch, await terminalCrypto.importTerminalOutputKey(decoded.key));
        if (decoded.kind === "data") screen += new TextDecoder().decode(decoded.data);
      })
      .catch((error) => {
        failure = error;
      });
  });
  const waitFor = async (predicate) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      if (predicate()) return;
      if (socket.readyState === WebSocket.CLOSED)
        throw new Error("terminal closed before expected screen");
      await pause(25);
    }
    throw new Error("terminal screen/handshake timed out");
  };
  const close = async () => {
    if (socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise((resolve) => socket.once("close", resolve));
    socket.close();
    const timer = setTimeout(() => socket.terminate(), 1000);
    try {
      await closed;
      await chain;
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    await waitFor(() => socket.readyState === WebSocket.OPEN);
    socket.send(JSON.stringify({ type: "list" }));
    await waitFor(() =>
      messages.some(
        (message) =>
          message.type === "terminals" &&
          message.terminals.some((terminal) => terminal.terminalId === terminalId),
      ),
    );
    socket.send(
      JSON.stringify({
        type: "attach",
        terminalId,
        publicKey: handshake.publicKeyB64,
        nonce: terminalCrypto.bytesToBase64Url(handshake.nonce),
      }),
    );
    await waitFor(() => keys !== undefined);
    return {
      waitForScreen: (predicate) => waitFor(() => predicate(screen)),
      async keypress(text) {
        sequence += 1n;
        const sealed = await terminalCrypto.sealTerminalBytesV2({
          key: keys.browserToCli,
          terminalId,
          viewerId,
          direction: terminalCrypto.DIRECTION_BROWSER_TO_CLI,
          seq: sequence,
          plaintext: terminalCrypto.encodeTerminalData(new TextEncoder().encode(text)),
        });
        const metadata = Buffer.from(
          JSON.stringify({ type: "term.sealed", terminalId, seq: Number(sequence) }),
        );
        const header = Buffer.alloc(4);
        header.writeUInt32BE(metadata.length);
        socket.send(Buffer.concat([header, metadata, sealed]));
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
