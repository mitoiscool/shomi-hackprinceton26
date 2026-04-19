import { createRequire } from "node:module";
import sharp from "sharp";
import { fetchProductImage } from "./product-image-verifier.js";

const require = createRequire(import.meta.url);
const { GIFEncoder, applyPalette, quantize } = require("gifenc") as typeof import("gifenc");

export type ProductGifFrame = {
  imageUrl: string;
  index: number;
};

export type BuiltProductGif = {
  data: Uint8Array;
  fileName: string;
  mimeType: "image/gif";
};

const FRAME_SIZE = 480;
const FRAME_DELAY_MS = 1500;
const FETCH_TIMEOUT_MS = 5_000;

function makeLabelSvg(index: number) {
  const text = `${index}`;
  const padX = 18;
  const padY = 18;
  const boxW = 60;
  const boxH = 60;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${FRAME_SIZE}" height="${FRAME_SIZE}">
    <rect x="${padX}" y="${padY}" rx="14" ry="14" width="${boxW}" height="${boxH}" fill="black" fill-opacity="0.78"/>
    <text x="${padX + boxW / 2}" y="${padY + boxH / 2}" dominant-baseline="middle" text-anchor="middle"
      font-family="Helvetica, Arial, sans-serif" font-size="38" font-weight="700" fill="white">${text}</text>
  </svg>`;
}

async function renderFrame(frame: ProductGifFrame): Promise<Uint8Array | undefined> {
  try {
    const fetched = await fetchProductImage(frame.imageUrl, FETCH_TIMEOUT_MS);

    if (!fetched) {
      return undefined;
    }

    const labelSvg = makeLabelSvg(frame.index);
    const buffer = await sharp(fetched.bytes)
      .resize(FRAME_SIZE, FRAME_SIZE, {
        background: { r: 255, g: 255, b: 255, alpha: 1 },
        fit: "contain",
      })
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .composite([{ input: Buffer.from(labelSvg), left: 0, top: 0 }])
      .ensureAlpha()
      .raw()
      .toBuffer();
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  } catch (error) {
    console.error("[gif-builder] frame render failed", { error, index: frame.index });
    return undefined;
  }
}

export async function buildLabelledProductGif(
  frames: ProductGifFrame[],
): Promise<BuiltProductGif | undefined> {
  if (frames.length === 0) {
    return undefined;
  }

  const rendered = (await Promise.all(frames.map(renderFrame))).filter(
    (frame): frame is Uint8Array => frame !== undefined,
  );

  if (rendered.length === 0) {
    return undefined;
  }

  const encoder = GIFEncoder();
  for (const rgba of rendered) {
    const palette = quantize(rgba, 256);
    const indexed = applyPalette(rgba, palette);
    encoder.writeFrame(indexed, FRAME_SIZE, FRAME_SIZE, {
      delay: FRAME_DELAY_MS,
      palette,
    });
  }
  encoder.finish();

  return {
    data: encoder.bytes(),
    fileName: "shomi-products.gif",
    mimeType: "image/gif",
  };
}
