import { imageSize } from "image-size";

export const ACX_MIN_COVER_PX = 2400;

// Reads dimensions straight from the image header — image-size is pure JS, so
// it survives a .pcplugin install (native modules like the `sharp` this
// replaced never load there, because installs copy dist/ only).
export function coverDimensionIssues(buf: Uint8Array): string[] {
  let width: number | undefined;
  let height: number | undefined;
  try {
    ({ width, height } = imageSize(buf));
  } catch {
    return ["Could not read image dimensions from cover file."];
  }
  const issues: string[] = [];
  if ((width ?? 0) < ACX_MIN_COVER_PX || (height ?? 0) < ACX_MIN_COVER_PX) {
    issues.push(
      `Cover too small: ${width ?? "?"}×${height ?? "?"}px (ACX minimum ${ACX_MIN_COVER_PX}×${ACX_MIN_COVER_PX}).`,
    );
  }
  return issues;
}
