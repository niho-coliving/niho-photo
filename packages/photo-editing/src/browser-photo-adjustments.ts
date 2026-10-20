export type BrowserPhotoAdjustments = {
  exposure: number;
  contrast: number;
  temperature: number;
  tint: number;
  saturation: number;
};

export const NEUTRAL_BROWSER_PHOTO_ADJUSTMENTS: BrowserPhotoAdjustments = {
  exposure: 0,
  contrast: 0,
  temperature: 0,
  tint: 0,
  saturation: 0,
};

function finiteClamp(value: unknown, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : 0;
}

export function normalizeBrowserPhotoAdjustments(value: Partial<BrowserPhotoAdjustments>): BrowserPhotoAdjustments {
  return {
    exposure: finiteClamp(value.exposure, -5, 5),
    contrast: finiteClamp(value.contrast, -100, 100),
    temperature: finiteClamp(value.temperature, -100, 100),
    tint: finiteClamp(value.tint, -100, 100),
    saturation: finiteClamp(value.saturation, -100, 100),
  };
}

export function isNeutralBrowserPhotoAdjustments(value: BrowserPhotoAdjustments): boolean {
  const normalized = normalizeBrowserPhotoAdjustments(value);
  return Object.values(normalized).every((item) => item === 0);
}

function byte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(255, Math.max(0, Math.round(value * 255)));
}

/** Preview と JPEG 書き出しが共有する唯一の画素変換。neutral は入力バイトを一切変更しない。 */
export function applyBrowserPhotoAdjustments(
  input: Uint8ClampedArray,
  value: BrowserPhotoAdjustments,
): Uint8ClampedArray {
  const settings = normalizeBrowserPhotoAdjustments(value);
  if (isNeutralBrowserPhotoAdjustments(settings)) return new Uint8ClampedArray(input);

  const output = new Uint8ClampedArray(input.length);
  const exposure = 2 ** settings.exposure;
  const contrast = Math.max(0, 1 + settings.contrast / 100);
  const saturation = Math.max(0, 1 + settings.saturation / 100);
  const warmth = settings.temperature / 100;
  const tint = settings.tint / 100;
  const redGain = Math.max(0, 1 + warmth * 0.2 + tint * 0.08);
  const greenGain = Math.max(0, 1 - Math.abs(warmth) * 0.03 - tint * 0.14);
  const blueGain = Math.max(0, 1 - warmth * 0.2 + tint * 0.08);

  for (let index = 0; index < input.length; index += 4) {
    let red = (input[index] / 255) * exposure * redGain;
    let green = (input[index + 1] / 255) * exposure * greenGain;
    let blue = (input[index + 2] / 255) * exposure * blueGain;

    red = (red - 0.5) * contrast + 0.5;
    green = (green - 0.5) * contrast + 0.5;
    blue = (blue - 0.5) * contrast + 0.5;

    const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
    output[index] = byte(luminance + (red - luminance) * saturation);
    output[index + 1] = byte(luminance + (green - luminance) * saturation);
    output[index + 2] = byte(luminance + (blue - luminance) * saturation);
    output[index + 3] = input[index + 3];
  }
  return output;
}
