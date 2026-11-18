import { expect, it } from 'vitest';
import { correctedSize, createRectifier, FULL_PHOTO, validCorners, type Corners } from './perspective';

const trapezoid: Corners = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.75, y: 1 }, { x: 0.25, y: 1 }];

function pixels(width: number, height: number, gradient = false): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set([gradient ? 30 * x : 0, gradient ? 30 * y : 0, 0, 255], 4 * (y * width + x));
  }
  return { width, height, data, colorSpace: 'srgb' };
}

it('maps a trapezoid to a rectangle through the diagonal intersection, interpolating source pixels', () => {
  const target = pixels(3, 3);
  const rows = createRectifier(pixels(5, 5, true), target, trapezoid);
  rows(0, 1);
  rows(1, 3);
  function rgba(x: number, y: number) {
    const offset = 4 * (y * 3 + x);
    return [...target.data.slice(offset, offset + 4)];
  }
  expect([rgba(0, 0), rgba(2, 0), rgba(2, 2), rgba(0, 2)]).toEqual([
    [0, 0, 0, 255], [120, 0, 0, 255], [90, 120, 0, 255], [30, 120, 0, 255],
  ]);
  expect(rgba(1, 1)).toEqual([60, 80, 0, 255]);
});

it('preserves the whole image and bounds the allocated pixel count', () => {
  const source = pixels(5, 5, true);
  const target = pixels(5, 5);
  createRectifier(source, target, FULL_PHOTO)(0, target.height);
  expect(target.data).toEqual(source.data);
  const { width, height } = correctedSize(FULL_PHOTO, 2400, 2400);
  expect(width * height).toBeLessThanOrEqual(4_000_000);
  expect(correctedSize(FULL_PHOTO, 2400, 1300)).toEqual({ width: 2400, height: 1300 });
});

it('rejects crossed, folded, tiny and out-of-bounds selections', () => {
  const [a, b, c, d] = FULL_PHOTO;
  const invalid: Corners[] = [[a, c, b, d], [a, b, { x: 0.8, y: 0.1 }, d], [a, { x: 0.01, y: 0 }, c, d], [a, b, { x: 1.1, y: 1 }, d]];
  for (const corners of invalid) expect(validCorners(corners)).toBe(false);
  expect(validCorners(trapezoid)).toBe(true);
});
