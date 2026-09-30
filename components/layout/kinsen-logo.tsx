/* eslint-disable @next/next/no-img-element */

/**
 * Horizontal Kinsen lockup cut from the official vertical white logo
 * (public/kinsen_logo_white.webp, 3000x3000) instead of redrawing the mark
 * or re-setting the wordmark in another face. Crop boxes were measured on
 * the asset's alpha channel at 600px scale:
 *   mark      x 194–405, y 124–342
 *   wordmark  x 123–477, y 395–477
 * Each crop is an overflow-hidden window over the full image, scaled so the
 * measured box fills it exactly.
 */
const SRC = "/kinsen_logo_white.webp";
const ASSET = 600;

function Crop({ box, height }: { box: { x: number; y: number; w: number; h: number }; height: number }) {
  const k = height / box.h;
  return (
    <span className="relative block shrink-0 overflow-hidden" style={{ width: box.w * k, height }} aria-hidden="true">
      <img
        src={SRC}
        alt=""
        draggable={false}
        className="absolute max-w-none select-none"
        style={{ width: ASSET * k, height: ASSET * k, left: -box.x * k, top: -box.y * k }}
      />
    </span>
  );
}

const MARK = { x: 194, y: 124, w: 211, h: 218 };
const WORDMARK = { x: 123, y: 395, w: 354, h: 82 };

export function KinsenMark({ height = 26 }: { height?: number }) {
  return (
    <span role="img" aria-label="Kinsen" className="inline-flex">
      <Crop box={MARK} height={height} />
    </span>
  );
}

export function KinsenLockup({ height = 26 }: { height?: number }) {
  return (
    <span role="img" aria-label="Kinsen" className="inline-flex items-end gap-2.5">
      <Crop box={MARK} height={height} />
      <Crop box={WORDMARK} height={Math.round(height * 0.52)} />
    </span>
  );
}
