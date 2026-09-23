import { describe, expect, it } from "vitest";

import {
  assertIncreasingTerminalSeq,
  buildApprovalTranscript,
  buildApprovalTranscriptV2,
  buildCliIdentityStatement,
  bytesToBase64Url,
  bytesToHex,
  cliIdentityFingerprint,
  concatBytes,
  DIRECTION_BROWSER_TO_CLI,
  DIRECTION_CLI_TO_BROWSER,
  decodeTerminalPlaintext,
  decodeTerminalPlaintextV2,
  deriveTerminalSessionKeys,
  deriveTerminalSessionKeysV2,
  ecPrivateJwk,
  encodeTerminalData,
  encodeTerminalOutputKey,
  encodeTerminalResize,
  hexToBytes,
  importEcdhPrivateJwk,
  importEcdhPublicRaw,
  importTerminalOutputKey,
  openTerminalBroadcast,
  openTerminalBytes,
  openTerminalBytesV2,
  sealTerminalBroadcast,
  sealTerminalBytes,
  sealTerminalBytesV2,
  signApprovalTranscript,
  signApprovalTranscriptV2,
  terminalAadV2,
  uncompressedPublicKey,
  verifyApprovalTranscript,
  verifyApprovalTranscriptV2,
  verifyCliIdentitySignature,
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

// Crypto v2 vectors. Mirrored in `apps/cli/src/terminal_crypto.rs`.
const VIEWER_A = bytesToBase64Url(Uint8Array.from({ length: 16 }, (_, index) => index + 1));
const VIEWER_B = bytesToBase64Url(Uint8Array.from({ length: 16 }, (_, index) => index + 17));
const OUT_KEY = Uint8Array.from({ length: 32 }, (_, index) => 0xa0 + index);
const IDENTITY_SCALAR = "5f2d1a6c3b4e8f7a9d0c1b2e3f4a5b6c7d8e9fa0b1c2d3e4f5061728394a5b6c";
const IDENTITY_X = "a63e98c188c90ae441b747a4b0b6064c2fe096705fb9772b3038fe0b67f78d99";
const IDENTITY_Y = "ac541a036077e5f3665af092f7ae2066d1bb3630cd21b0f0112fc6b95872ea16";
// Deterministic (RFC 6979) signature from the CLI's p256 crate.
const APPROVAL_V2_SIGNATURE_RUST =
  "6b0c3ea676796d57c38e650c1b4d2f3efb348058de0649397ab3632aad07153111c73b5a92bce9f1ba9822c1f996768d81e32f6e21b77717435d891335c44079";
// One randomized WebCrypto signature, verified by the CLI tests.
const APPROVAL_V2_SIGNATURE_WEB =
  "0ac67c3ebfcc5257b6bd38492893c7e15225b3f78c38e4ae5dce074bf577c93579ed33bacb3f4e61d68131463d8f633f1269581e74325b8c8947bc7b712151b9";
const APPROVAL_V2_TRANSCRIPT =
  "001477736d702d7465726d2d617070726f76652d7632000d7465726d5f766563746f725f31001641514944424155474277674a4367734d445134504541004104d12dfb5289c8d4f81208b70270398c342296970a0bccb74c736fc7554494bf6356fbf3ca366cc23e8157854c13c58d6aac23f046ada30f8353e74f33039872ab001000112233445566778899aabbccddeeff004104dad0b65394221cf9b051e1feca5787d098dfe637fc90b9ef945d0c37725811805271a0461cdb8252d61f1c456fa3e59ab1f45b33accf5f58389e0577b8990bb30010ffeeddccbbaa99887766554433221100";

async function vectorKeysV2(viewerId: string) {
  const cliRaw = uncompressedPublicKey(hexToBytes(CLI_X), hexToBytes(CLI_Y));
  const browserRaw = uncompressedPublicKey(hexToBytes(BROWSER_X), hexToBytes(BROWSER_Y));
  return deriveTerminalSessionKeysV2({
    browserPrivateKey: await importEcdhPrivateJwk(
      ecPrivateJwk(hexToBytes(BROWSER_SCALAR), hexToBytes(BROWSER_X), hexToBytes(BROWSER_Y)),
    ),
    cliPublicKey: await importEcdhPublicRaw(cliRaw),
    browserNonce: hexToBytes("00112233445566778899aabbccddeeff"),
    cliNonce: hexToBytes("ffeeddccbbaa99887766554433221100"),
    terminalId: "term_vector_1",
    viewerId,
    cliPublicRaw: cliRaw,
    browserPublicRaw: browserRaw,
  });
}

function approvalV2Input(viewerId: string) {
  return {
    terminalId: "term_vector_1",
    viewerId,
    browserPublicKey: uncompressedPublicKey(hexToBytes(BROWSER_X), hexToBytes(BROWSER_Y)),
    browserNonce: hexToBytes("00112233445566778899aabbccddeeff"),
    cliPublicKey: uncompressedPublicKey(hexToBytes(CLI_X), hexToBytes(CLI_Y)),
    cliNonce: hexToBytes("ffeeddccbbaa99887766554433221100"),
  };
}

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

describe("terminal crypto v2 vectors", () => {
  it("binds the viewer id into the pairwise keys", async () => {
    expect(VIEWER_A).toBe("AQIDBAUGBwgJCgsMDQ4PEA");
    expect(VIEWER_B).toBe("ERITFBUWFxgZGhscHR4fIA");
    const a = await vectorKeysV2(VIEWER_A);
    expect(bytesToHex(a.ikm)).toBe(
      "d6840f6b42f6edafd13116e0e12565202fef8e9ece7dce03812464d04b9442de",
    );
    expect(bytesToHex(a.browserToCliRaw)).toBe(
      "18d9eb864fb7002963cc992cb4fdf6be3d60f53439fb6fa1e5f772fd33535adf",
    );
    expect(bytesToHex(a.cliToBrowserRaw)).toBe(
      "ea07877ff03ae2c4624bc2d727be559a85d2ab897831c72e908b8f4156c02aa3",
    );
    const b = await vectorKeysV2(VIEWER_B);
    expect(bytesToHex(b.browserToCliRaw)).toBe(
      "1bf5fb8640685f2e550385d3dc380c600cf5b9065d715fc87d9773125e82f7e5",
    );
    expect(bytesToHex(b.cliToBrowserRaw)).toBe(
      "c5e0c6c04b496f7dd3e67a19baa9ad33f30f9121ad69d900209cad4049e645f4",
    );
  });

  it("seals exact v2 unicast data, resize, and output-key frames", async () => {
    const keys = await vectorKeysV2(VIEWER_A);
    const base = { terminalId: "term_vector_1", viewerId: VIEWER_A };

    const data = await sealTerminalBytesV2({
      ...base,
      key: keys.browserToCli,
      direction: DIRECTION_BROWSER_TO_CLI,
      seq: 1n,
      plaintext: encodeTerminalData(hexToBytes("6869")),
    });
    expect(bytesToHex(data)).toBe("8db4cc4ef29fc34d932252a4c7c961d86a3fd7");
    const openedData = await openTerminalBytesV2({
      ...base,
      key: keys.browserToCli,
      direction: DIRECTION_BROWSER_TO_CLI,
      seq: 1n,
      ciphertext: data,
    });
    expect(bytesToHex(openedData)).toBe("016869");

    const resize = await sealTerminalBytesV2({
      ...base,
      key: keys.cliToBrowser,
      direction: DIRECTION_CLI_TO_BROWSER,
      seq: 1n,
      plaintext: encodeTerminalResize(80, 24),
    });
    expect(bytesToHex(resize)).toBe("6170ea15143be28521dee2eb18f299562f0a2c568b");

    const keyPlaintext = encodeTerminalOutputKey(1, OUT_KEY);
    expect(bytesToHex(keyPlaintext)).toBe(
      "0300000001a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf",
    );
    const keyFrame = await sealTerminalBytesV2({
      ...base,
      key: keys.cliToBrowser,
      direction: DIRECTION_CLI_TO_BROWSER,
      seq: 2n,
      plaintext: keyPlaintext,
    });
    expect(bytesToHex(keyFrame)).toBe(
      "ec1e0c1a988a5751da40eb126b642620a3bbd7ba89b916829cd8c905faf171d294e801f3150c21f42bceb3ef5d7fdac87b2d650834",
    );
    const decoded = decodeTerminalPlaintextV2(
      await openTerminalBytesV2({
        ...base,
        key: keys.cliToBrowser,
        direction: DIRECTION_CLI_TO_BROWSER,
        seq: 2n,
        ciphertext: keyFrame,
      }),
    );
    expect(decoded).toEqual({ kind: "outputKey", epoch: 1, key: OUT_KEY });
  });

  it("seals an exact broadcast frame and rejects the wrong epoch", async () => {
    const outKey = await importTerminalOutputKey(OUT_KEY);
    const sealed = await sealTerminalBroadcast({
      key: outKey,
      terminalId: "term_vector_1",
      epoch: 1,
      seq: 1n,
      plaintext: encodeTerminalData(hexToBytes("6869")),
    });
    expect(bytesToHex(sealed)).toBe("8bbad4ba419145525c441597e232569d485873");
    const opened = await openTerminalBroadcast({
      key: outKey,
      terminalId: "term_vector_1",
      epoch: 1,
      seq: 1n,
      ciphertext: sealed,
    });
    expect(bytesToHex(opened)).toBe("016869");
    await expect(
      openTerminalBroadcast({
        key: outKey,
        terminalId: "term_vector_1",
        epoch: 2,
        seq: 1n,
        ciphertext: sealed,
      }),
    ).rejects.toThrow();
    await expect(
      openTerminalBroadcast({
        key: outKey,
        terminalId: "term_vector_1",
        epoch: 0,
        seq: 1n,
        ciphertext: sealed,
      }),
    ).rejects.toThrow(/epoch/);
  });

  it("rejects A's frame under B's key or B's AAD", async () => {
    const a = await vectorKeysV2(VIEWER_A);
    const b = await vectorKeysV2(VIEWER_B);
    const frame = await sealTerminalBytesV2({
      key: a.browserToCli,
      terminalId: "term_vector_1",
      viewerId: VIEWER_A,
      direction: DIRECTION_BROWSER_TO_CLI,
      seq: 1n,
      plaintext: encodeTerminalData(hexToBytes("6869")),
    });
    await expect(
      openTerminalBytesV2({
        key: b.browserToCli,
        terminalId: "term_vector_1",
        viewerId: VIEWER_A,
        direction: DIRECTION_BROWSER_TO_CLI,
        seq: 1n,
        ciphertext: frame,
      }),
    ).rejects.toThrow();
    await expect(
      openTerminalBytesV2({
        key: a.browserToCli,
        terminalId: "term_vector_1",
        viewerId: VIEWER_B,
        direction: DIRECTION_BROWSER_TO_CLI,
        seq: 1n,
        ciphertext: frame,
      }),
    ).rejects.toThrow();
  });

  it("length-prefixes ids so shifted boundaries give different AAD", () => {
    const left = terminalAadV2("ab", "c", DIRECTION_BROWSER_TO_CLI, 1n);
    const right = terminalAadV2("a", "bc", DIRECTION_BROWSER_TO_CLI, 1n);
    expect(bytesToHex(left)).toBe(
      "000c77736d702d7465726d2d76320002616200016301" + "0000000000000001",
    );
    expect(bytesToHex(left)).not.toBe(bytesToHex(right));
  });

  it("codes output-key plaintexts and rejects bad lengths and epoch 0", () => {
    expect(() => encodeTerminalOutputKey(0, OUT_KEY)).toThrow(/epoch/);
    expect(() => encodeTerminalOutputKey(1, OUT_KEY.slice(1))).toThrow(/32 bytes/);
    const encoded = encodeTerminalOutputKey(1, OUT_KEY);
    expect(() => decodeTerminalPlaintextV2(encoded.slice(0, 36))).toThrow(/37 bytes/);
    expect(() => decodeTerminalPlaintextV2(concatBytes([encoded, Uint8Array.of(0)]))).toThrow(
      /37 bytes/,
    );
    const epochZero = encoded.slice();
    epochZero[4] = 0;
    expect(() => decodeTerminalPlaintextV2(epochZero)).toThrow(/epoch/);
    expect(() => decodeTerminalPlaintext(encoded)).toThrow(/unknown/);
    expect(decodeTerminalPlaintextV2(hexToBytes("0200500018"))).toEqual({
      kind: "resize",
      cols: 80,
      rows: 24,
    });
  });

  it("builds the v2 approval transcript and verifies the CLI vector signature", async () => {
    const input = approvalV2Input(VIEWER_A);
    expect(bytesToHex(buildApprovalTranscriptV2(input))).toBe(APPROVAL_V2_TRANSCRIPT);
    const publicKey = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(uncompressedPublicKey(hexToBytes(IDENTITY_X), hexToBytes(IDENTITY_Y))),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const rustSignature = hexToBytes(APPROVAL_V2_SIGNATURE_RUST);
    await expect(verifyApprovalTranscriptV2(publicKey, input, rustSignature)).resolves.toBe(true);
    await expect(
      verifyApprovalTranscriptV2(publicKey, approvalV2Input(VIEWER_B), rustSignature),
    ).resolves.toBe(false);

    await expect(
      verifyApprovalTranscriptV2(publicKey, input, hexToBytes(APPROVAL_V2_SIGNATURE_WEB)),
    ).resolves.toBe(true);

    const privateKey = await crypto.subtle.importKey(
      "jwk",
      ecPrivateJwk(hexToBytes(IDENTITY_SCALAR), hexToBytes(IDENTITY_X), hexToBytes(IDENTITY_Y)),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    const signature = await signApprovalTranscriptV2(privateKey, input);
    expect(signature.byteLength).toBe(64);
    await expect(verifyApprovalTranscriptV2(publicKey, input, signature)).resolves.toBe(true);
    await expect(
      verifyApprovalTranscriptV2(publicKey, approvalV2Input(VIEWER_B), signature),
    ).resolves.toBe(false);
  });
});

// CLI identity vectors. Mirrored in `apps/cli/src/terminal_crypto.rs`.
const CLI_ID_SLUG = "desk-01";
const CLI_ID_STATEMENT =
  "001377736d702d7465726d2d636c692d69642d763100076465736b2d303104dad0b65394221cf9b051e1feca5787d098dfe637fc90b9ef945d0c37725811805271a0461cdb8252d61f1c456fa3e59ab1f45b33accf5f58389e0577b8990bb3";
// Deterministic (RFC 6979) signature from the CLI's p256 crate.
const CLI_ID_SIGNATURE_RUST =
  "605fffa5e3271aa6dcbf5a23e57a843c2e7c94399eea50331446c8183e5dfeedeac15186cde27a792ed704df722d2474a7902fc9a9ade88cba5f56c04f5a5624";
// One randomized WebCrypto signature, verified by the CLI tests.
const CLI_ID_SIGNATURE_WEB =
  "41d228ec04946ee19927954be52b2367823c911e99a9abac37cab3d7367ff82bdab3492d700e3976ca96ad5bc991a9948a1e38077d44f2136c2113da71b899c3";
const CLI_ID_FINGERPRINT = "EHI6 GLCX HTTU Q3DC VR2L P6WK K5PF OMMO";

describe("terminal CLI identity vectors", () => {
  const identityRaw = uncompressedPublicKey(hexToBytes(IDENTITY_X), hexToBytes(IDENTITY_Y));
  const cliRaw = uncompressedPublicKey(hexToBytes(CLI_X), hexToBytes(CLI_Y));

  it("builds the exact identity statement", () => {
    expect(bytesToHex(buildCliIdentityStatement(CLI_ID_SLUG, cliRaw))).toBe(CLI_ID_STATEMENT);
    expect(() => buildCliIdentityStatement(CLI_ID_SLUG, cliRaw.slice(1))).toThrow();
  });

  it("verifies the CLI and WebCrypto signatures and rejects other bindings", async () => {
    const verify = (signature: Uint8Array, cliSlug = CLI_ID_SLUG, ecdh = cliRaw) =>
      verifyCliIdentitySignature({
        identityPublicKey: identityRaw,
        signature,
        cliSlug,
        ecdhPublicKey: ecdh,
      });
    await expect(verify(hexToBytes(CLI_ID_SIGNATURE_RUST))).resolves.toBe(true);
    await expect(verify(hexToBytes(CLI_ID_SIGNATURE_WEB))).resolves.toBe(true);
    await expect(verify(hexToBytes(CLI_ID_SIGNATURE_RUST), "desk-02")).resolves.toBe(false);
    const browserRaw = uncompressedPublicKey(hexToBytes(BROWSER_X), hexToBytes(BROWSER_Y));
    await expect(verify(hexToBytes(CLI_ID_SIGNATURE_RUST), CLI_ID_SLUG, browserRaw)).resolves.toBe(
      false,
    );
    await expect(verify(hexToBytes(CLI_ID_SIGNATURE_RUST).slice(1))).resolves.toBe(false);

    const privateKey = await crypto.subtle.importKey(
      "jwk",
      ecPrivateJwk(hexToBytes(IDENTITY_SCALAR), hexToBytes(IDENTITY_X), hexToBytes(IDENTITY_Y)),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        privateKey,
        Uint8Array.from(buildCliIdentityStatement(CLI_ID_SLUG, cliRaw)),
      ),
    );
    expect(signature.byteLength).toBe(64);
    await expect(verify(signature)).resolves.toBe(true);
  });

  it("formats the fingerprint as base32 groups of 4", async () => {
    await expect(cliIdentityFingerprint(identityRaw)).resolves.toBe(CLI_ID_FINGERPRINT);
  });
});
