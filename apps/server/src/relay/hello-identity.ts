import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";

/** `lp16("wsmp-relay-hello-v1") ‖ nonce(16) ‖ lp16(cliSlug)`. Matches the CLI. */
const HELLO_IDENTITY_LABEL = Buffer.from("wsmp-relay-hello-v1");
/** SPKI prefix for an uncompressed P-256 point (26 bytes + 65-byte SEC1). */
const SPKI_P256_UNCOMPRESSED_PREFIX = Buffer.from(
  "3059301306072a8648ce3d020106082a8648ce3d030107034200",
  "hex",
);

function lp16(bytes: Buffer): Buffer {
  if (bytes.length > 0xffff) {
    throw new Error("length-prefixed field exceeds 65535 bytes.");
  }
  const out = Buffer.allocUnsafe(2 + bytes.length);
  out.writeUInt16BE(bytes.length, 0);
  bytes.copy(out, 2);
  return out;
}

export function helloIdentityStatement(nonce: Buffer, cliSlug: string): Buffer {
  return Buffer.concat([lp16(HELLO_IDENTITY_LABEL), nonce, lp16(Buffer.from(cliSlug, "utf8"))]);
}

function p256KeyFromUncompressed(publicRaw: Buffer) {
  if (publicRaw.length !== 65 || publicRaw[0] !== 0x04) return null;
  try {
    return createPublicKey({
      key: Buffer.concat([SPKI_P256_UNCOMPRESSED_PREFIX, publicRaw]),
      format: "der",
      type: "spki",
    });
  } catch {
    return null;
  }
}

export function verifyHelloIdentitySignature(input: {
  identityPublicKey: string;
  signature: string;
  nonce: string;
  cliSlug: string;
}): boolean {
  const publicRaw = Buffer.from(input.identityPublicKey, "base64url");
  const signature = Buffer.from(input.signature, "base64url");
  const nonce = Buffer.from(input.nonce, "base64url");
  if (signature.length !== 64 || nonce.length !== 16) return false;
  const key = p256KeyFromUncompressed(publicRaw);
  if (!key) return false;
  try {
    return verify(
      "sha256",
      helloIdentityStatement(nonce, input.cliSlug),
      { key, dsaEncoding: "ieee-p1363" },
      signature,
    );
  } catch {
    return false;
  }
}

export type TestHelloIdentity = {
  publicKey: string;
  sign(nonce: string, cliSlug: string): string;
};

/** A throwaway P-256 identity for tests that need a real hello signature. */
export function generateTestHelloIdentity(): TestHelloIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const publicRaw = Buffer.from(spki.subarray(spki.length - 65));
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" });
  const signingKey = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  return {
    publicKey: publicRaw.toString("base64url"),
    sign(nonce, cliSlug) {
      const nonceRaw = Buffer.from(nonce, "base64url");
      const signature = sign("sha256", helloIdentityStatement(nonceRaw, cliSlug), {
        key: signingKey,
        dsaEncoding: "ieee-p1363",
      });
      return signature.toString("base64url");
    },
  };
}
