// Test-only certificates generated entirely in memory. No persisted key, external
// tool, dependency or expiring checked-in certificate is needed by CI/Node slim.
import { generateKeyPairSync, sign } from "node:crypto";

function der(tag: number, value: Uint8Array): Buffer {
  const length =
    value.length < 128
      ? Buffer.from([value.length])
      : value.length < 256
        ? Buffer.from([0x81, value.length])
        : Buffer.from([0x82, value.length >>> 8, value.length & 0xff]);
  return Buffer.concat([Buffer.from([tag]), length, value]);
}
const sequence = (...values: Uint8Array[]) => der(0x30, Buffer.concat(values));
const oid = (hex: string) => der(0x06, Buffer.from(hex, "hex"));

export function providerTlsFixture(matching = true) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const algorithm = sequence(oid("2a8648ce3d040302")); // ecdsa-with-SHA256
  const name = sequence(der(0x31, sequence(oid("550403"), der(0x0c, Buffer.from("egress test")))));
  const ipv6 = Buffer.alloc(16);
  ipv6[15] = matching ? 1 : 2;
  const san = sequence(
    der(0x82, Buffer.from(matching ? "localhost" : "different.invalid")),
    der(0x87, Buffer.from([127, 0, 0, matching ? 1 : 2])),
    der(0x87, ipv6),
  );
  const extensions = der(
    0xa3,
    sequence(
      sequence(
        oid("551d13"),
        der(0x01, Buffer.from([0xff])),
        der(0x04, sequence(der(0x01, Buffer.from([0xff])))),
      ),
      sequence(oid("551d11"), der(0x04, san)),
    ),
  );
  const tbs = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([1])),
    algorithm,
    name,
    sequence(der(0x18, Buffer.from("20200101000000Z")), der(0x18, Buffer.from("21000101000000Z"))),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    extensions,
  );
  const certificate = sequence(
    tbs,
    algorithm,
    der(0x03, Buffer.concat([Buffer.from([0]), sign("sha256", tbs, privateKey)])),
  );
  const cert = `-----BEGIN CERTIFICATE-----\n${certificate
    .toString("base64")
    .match(/.{1,64}/gu)
    ?.join("\n")}\n-----END CERTIFICATE-----\n`;
  const key = privateKey.export({ type: "pkcs8", format: "pem" });
  return { cert, key };
}
