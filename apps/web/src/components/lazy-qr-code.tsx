import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { lazy, Suspense } from "react";

/**
 * `qrcode.react` ships its own SVG-path encoder that is only ever needed during
 * 2FA enrollment — a path the vast majority of sessions never hit. `React.lazy`
 * splits it into its own chunk so it loads the moment a QR actually renders,
 * not when the (already route-split) security page mounts. This is the
 * component-level escape hatch for code-splitting; routes split automatically,
 * so reach for `lazy()` only for heavy widgets gated behind a rare interaction.
 * Component-level dynamic import for the QR encoder.
 */
const QRCodeSVG = lazy(() => import("qrcode.react").then((m) => ({ default: m.QRCodeSVG })));

/** `size` is px at the browser-default 16px root; the code is drawn in rem so it grows with the viewport scale. */
export function LazyQRCode({ value, size }: { value: string; size: number }) {
  const box = { width: `${size / 16}rem`, maxWidth: "100%", aspectRatio: "1" };
  return (
    <Suspense fallback={<Skeleton style={box} />}>
      <QRCodeSVG value={value} size={size} style={{ ...box, height: "auto" }} />
    </Suspense>
  );
}
