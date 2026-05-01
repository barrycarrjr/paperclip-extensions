import { Jimp, loadFont, ResizeStrategy } from "jimp";
import { SANS_64_BLACK, SANS_64_WHITE, SANS_32_BLACK, SANS_32_WHITE, SANS_16_BLACK, SANS_16_WHITE, SANS_128_BLACK, SANS_128_WHITE } from "jimp/fonts";

export interface Layer {
  type?: "image" | "text";
  path?: string;
  text?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  font?: string;
  color?: string;
  size?: number;
  weight?: number;
  align?: "left" | "center" | "right";
}

export interface ComposeOptions {
  width: number;
  height: number;
  background?: string; // hex color or path
  layers: Layer[];
  outputPath: string;
}

async function pickFont(size: number, color: string): Promise<unknown> {
  const isLight = isLightColor(color);
  const choices: Array<[number, string, string]> = [
    [16, SANS_16_BLACK, SANS_16_WHITE],
    [32, SANS_32_BLACK, SANS_32_WHITE],
    [64, SANS_64_BLACK, SANS_64_WHITE],
    [128, SANS_128_BLACK, SANS_128_WHITE],
  ];
  let best: [number, string, string] = choices[0];
  let bestDiff = Math.abs(size - best[0]);
  for (const c of choices) {
    const diff = Math.abs(size - c[0]);
    if (diff < bestDiff) {
      best = c;
      bestDiff = diff;
    }
  }
  const fontPath = isLight ? best[2] : best[1];
  return await loadFont(fontPath);
}

function isLightColor(css: string): boolean {
  const c = css.trim().toLowerCase();
  if (c === "white" || c === "#fff" || c === "#ffffff") return true;
  if (c.startsWith("#")) {
    const hex = c.replace(/^#/, "");
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      return (r + g + b) / 3 > 128;
    }
  }
  return false;
}

function hexToInt(css: string): number {
  const c = css.trim().toLowerCase();
  if (c === "white" || c === "#fff" || c === "#ffffff") return 0xffffffff;
  if (c === "black" || c === "#000" || c === "#000000") return 0x000000ff;
  if (c.startsWith("#")) {
    const hex = c.replace(/^#/, "");
    if (hex.length === 6) return parseInt(hex + "ff", 16);
    if (hex.length === 8) return parseInt(hex, 16);
    if (hex.length === 3) {
      const expanded = hex.split("").map((ch) => ch + ch).join("");
      return parseInt(expanded + "ff", 16);
    }
  }
  return 0xffffffff;
}

export async function compose(opts: ComposeOptions): Promise<{
  outputPath: string;
  width: number;
  height: number;
}> {
  const { width, height, background, layers, outputPath } = opts;

  // The Jimp generic types are noisy due to a duplicate-types issue between
  // jimp's own export and its @jimp/types peer; using `any` here keeps the
  // pipeline readable. The runtime API is well-defined.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let canvas: any;
  if (background && /^#?[0-9a-fA-F]{3,8}$/.test(background.replace(/^#/, ""))) {
    canvas = new Jimp({ width, height, color: hexToInt(background) });
  } else if (background) {
    canvas = await Jimp.read(background);
    canvas.resize({ w: width, h: height, mode: ResizeStrategy.BILINEAR });
  } else {
    canvas = new Jimp({ width, height, color: 0xffffffff });
  }

  for (const layer of layers) {
    if (layer.type === "image" && layer.path) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const img: any = await Jimp.read(layer.path);
      if (layer.w !== undefined && layer.h !== undefined) {
        img.resize({ w: layer.w, h: layer.h, mode: ResizeStrategy.BILINEAR });
      } else if (layer.w !== undefined) {
        const ratio = layer.w / img.bitmap.width;
        img.resize({
          w: layer.w,
          h: Math.round(img.bitmap.height * ratio),
          mode: ResizeStrategy.BILINEAR,
        });
      } else if (layer.h !== undefined) {
        const ratio = layer.h / img.bitmap.height;
        img.resize({
          w: Math.round(img.bitmap.width * ratio),
          h: layer.h,
          mode: ResizeStrategy.BILINEAR,
        });
      }
      canvas.composite(img, Math.round(layer.x ?? 0), Math.round(layer.y ?? 0));
    } else if (layer.type === "text" && layer.text) {
      const size = layer.size ?? 32;
      const color = layer.color ?? "#000";
      const font = await pickFont(size, color);
      const printArgs: Record<string, unknown> = {
        font,
        x: Math.round(layer.x ?? 0),
        y: Math.round(layer.y ?? 0),
        text: layer.text,
      };
      if (layer.w !== undefined) printArgs.maxWidth = layer.w;
      if (layer.align === "center") printArgs.alignmentX = 1;
      if (layer.align === "right") printArgs.alignmentX = 2;
      canvas.print(printArgs);
    }
  }

  await canvas.write(outputPath);
  return { outputPath, width: canvas.bitmap.width, height: canvas.bitmap.height };
}
