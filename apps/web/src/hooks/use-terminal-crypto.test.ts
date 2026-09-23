import { describe, expect, it } from "vitest";

import {
  assertIncreasingTerminalSeq,
  buildApprovalTranscript,
  bytesToBase64Url,
  bytesToHex,
  DIRECTION_BROWSER_TO_CLI,
  DIRECTION_CLI_TO_BROWSER,
  decodeTerminalPlaintext,
  deriveTerminalSessionKeys,
  ecPrivateJwk,
  encodeTerminalData,
  encodeTerminalResize,
  hexToBytes,
  importEcdhPrivateJwk,
  importEcdhPublicRaw,
  openTerminalBytes,
  sealTerminalBytes,
  signApprovalTranscript,
  uncompressedPublicKey,
  verifyApprovalTranscript,
} from "./use-terminal-crypto";

const CLI_X = "DAD0B65394221CF9B051E1FECA5787D098DFE637FC90B9EF945D0C3772581180";
const CLI_Y = "5271A0461CDB8252D61F1C456FA3E59AB1F45B33ACCF5F58389E0577B8990BB3";
const BROWSER_SCALAR = "c6ef9c5d78ae012a011164acb397ce2088685d8f06bf9be0b283ab46476bee53";
const BROWSER_X = "D12DFB5289C8D4F81208B70270398C342296970A0BCCB74C736FC7554494BF63";
const BROWSER_Y = "56FBF3CA366CC23E8157854C13C58D6AAC23F046ADA30F8353E74F33039872AB";

const CLI_PUBLIC_B64 =
  "BNrQtlOUIhz5sFHh_spXh9CY3-Y3_JC575RdDDdyWBGAUnGgRhzbglLWHxxFb6PlmrH0WzOsz19YOJ4Fd7iZC7M";
const BROWSER_PUBLIC_B64 =
  "BNEt-1KJyNT4Egi3AnA5jDQilpcKC8y3THNvx1VElL9jVvvzyjZswj6BV4VME8WNaqwj8Eatow-DU-dPMwOYcqs";

describe("terminal crypto vectors", () => {
  it("round-trips the shared P-256, HKDF, and AES-GCM vectors", async () => {
    const cliRaw = uncompressedPublicKey(hexToBytes(CLI_X), hexToBytes(CLI_Y));
    const browserRaw = uncompressedPublicKey(hexToBytes(BROWSER_X), hexToBytes(BROWSER_Y));
    expect(bytesToBase64Url(cliRaw)).toBe(CLI_PUBLIC_B64);
    expect(bytesToBase64Url(browserRaw)).toBe(BROWSER_PUBLIC_B64);

    const browserPrivate = await importEcdhPrivateJwk(
      ecPrivateJwk(hexToBytes(BROWSER_SCALAR), hexToBytes(BROWSER_X), hexToBytes(BROWSER_Y)),
    );
    const cliPublic = await importEcdhPublicRaw(cliRaw);
    const keys = await deriveTerminalSessionKeys({
      browserPrivateKey: browserPrivate,
      cliPublicKey: cliPublic,
      browserNonce: hexToBytes("00112233445566778899aabbccddeeff"),
      cliNonce: hexToBytes("ffeeddccbbaa99887766554433221100"),
      terminalId: "term_vector_1",
      cliPublicRaw: cliRaw,
      browserPublicRaw: browserRaw,
    });

    expect(bytesToHex(keys.ikm)).toBe(
      "d6840f6b42f6edafd13116e0e12565202fef8e9ece7dce03812464d04b9442de",
    );
    expect(bytesToHex(keys.browserToCliRaw)).toBe(
      "f2726c8e442ef54d9c71c2057c8c5ab0e79da6536f134351bce6ec870d1dcb8f",
    );
    expect(bytesToHex(keys.cliToBrowserRaw)).toBe(
      "cb095d76e3491169f6bd4bacdc50c6382e05ec25ffada619f418a4e26541b3c1",
    );

    const dataPlaintext = encodeTerminalData(hexToBytes("6869"));
    expect(bytesToHex(dataPlaintext)).toBe("016869");
    const dataCiphertext = await sealTerminalBytes({
      key: keys.browserToCli,
      terminalId: "term_vector_1",
      direction: DIRECTION_BROWSER_TO_CLI,
      seq: 1n,
      plaintext: dataPlaintext,
    });
    expect(bytesToHex(dataCiphertext)).toBe("abf7af28ff10f995b04e545dd9510ca490ec2e");
    expect(
      bytesToHex(
        await openTerminalBytes({
          key: keys.browserToCli,
          terminalId: "term_vector_1",
          direction: DIRECTION_BROWSER_TO_CLI,
          seq: 1n,
          ciphertext: dataCiphertext,
        }),
      ),
    ).toBe("016869");

    const resizePlaintext = encodeTerminalResize(0x50, 0x18);
    expect(bytesToHex(resizePlaintext)).toBe("0200500018");
    const resizeCiphertext = await sealTerminalBytes({
      key: keys.cliToBrowser,
      terminalId: "term_vector_1",
      direction: DIRECTION_CLI_TO_BROWSER,
      seq: 1n,
      plaintext: resizePlaintext,
    });
    expect(bytesToHex(resizeCiphertext)).toBe("52433cf15579f5953561372e175ec4d22245c3e5d8");
    const openedResize = decodeTerminalPlaintext(
      await openTerminalBytes({
        key: keys.cliToBrowser,
        terminalId: "term_vector_1",
        direction: DIRECTION_CLI_TO_BROWSER,
        seq: 1n,
        ciphertext: resizeCiphertext,
      }),
    );
    expect(openedResize).toEqual({ kind: "resize", cols: 80, rows: 24 });
  });

  it("rejects a seq that does not strictly increase and a mismatched direction", async () => {
    expect(() => assertIncreasingTerminalSeq(1n, 1n)).toThrow(/did not increase/);
    expect(() => assertIncreasingTerminalSeq(2n, 1n)).toThrow(/did not increase/);
    assertIncreasingTerminalSeq(0n, 1n);

    const cliRaw = uncompressedPublicKey(hexToBytes(CLI_X), hexToBytes(CLI_Y));
    const browserRaw = uncompressedPublicKey(hexToBytes(BROWSER_X), hexToBytes(BROWSER_Y));
    const keys = await deriveTerminalSessionKeys({
      browserPrivateKey: await importEcdhPrivateJwk(
        ecPrivateJwk(hexToBytes(BROWSER_SCALAR), hexToBytes(BROWSER_X), hexToBytes(BROWSER_Y)),
      ),
      cliPublicKey: await importEcdhPublicRaw(cliRaw),
      browserNonce: hexToBytes("00112233445566778899aabbccddeeff"),
      cliNonce: hexToBytes("ffeeddccbbaa99887766554433221100"),
      terminalId: "term_vector_1",
      cliPublicRaw: cliRaw,
      browserPublicRaw: browserRaw,
    });
    const ciphertext = await sealTerminalBytes({
      key: keys.browserToCli,
      terminalId: "term_vector_1",
      direction: DIRECTION_BROWSER_TO_CLI,
      seq: 1n,
      plaintext: encodeTerminalData(hexToBytes("6869")),
    });
    await expect(
      openTerminalBytes({
        key: keys.browserToCli,
        terminalId: "term_vector_1",
        direction: DIRECTION_CLI_TO_BROWSER,
        seq: 1n,
        ciphertext,
      }),
    ).rejects.toThrow();
  });

  it("signs the approval transcript as IEEE P1363 and verifies it", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ]);
    const cliNonce = hexToBytes("ffeeddccbbaa99887766554433221100");
    const input = {
      terminalId: "term_vector_1",
      browserPublicKey: uncompressedPublicKey(hexToBytes(BROWSER_X), hexToBytes(BROWSER_Y)),
      browserNonce: hexToBytes("00112233445566778899aabbccddeeff"),
      cliPublicKey: uncompressedPublicKey(hexToBytes(CLI_X), hexToBytes(CLI_Y)),
      cliNonce,
    };
    const signature = await signApprovalTranscript(pair.privateKey, input);
    expect(signature.byteLength).toBe(64);
    const transcript = buildApprovalTranscript(input);
    expect(Array.from(transcript).join(",")).toContain(Array.from(cliNonce).join(","));
    const withoutNonce = buildApprovalTranscript({ ...input, cliNonce: new Uint8Array(16) });
    expect(transcript).not.toEqual(withoutNonce);
    await expect(verifyApprovalTranscript(pair.publicKey, input, signature)).resolves.toBe(true);
    await expect(
      verifyApprovalTranscript(pair.publicKey, { ...input, terminalId: "other" }, signature),
    ).resolves.toBe(false);
  });
});
