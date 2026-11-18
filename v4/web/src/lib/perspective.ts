export type Point = Readonly<{ x: number; y: number }>;
export type Corners = readonly [Point, Point, Point, Point]; // Top left, clockwise.

export const FULL_PHOTO: Corners = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];

export function validCorners(corners: Corners): boolean {
  return corners.every((a, i) => {
    if (![a.x, a.y].every((n) => Number.isFinite(n) && n >= 0 && n <= 1)) return false;
    const b = corners[(i + 1) % 4]!;
    const c = corners[(i + 2) % 4]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    // Require clockwise, convex, well separated corners.
    return Math.hypot(dx, dy) >= 0.02 && dx * (c.y - b.y) - dy * (c.x - b.x) > 0.001;
  });
}

export function correctedSize(corners: Corners, width: number, height: number) {
  const [a, b, c, d] = corners;
  const distance = (p: Point, q: Point) => Math.hypot((p.x - q.x) * (width - 1), (p.y - q.y) * (height - 1));
  const w = 1 + Math.max(distance(a, b), distance(d, c));
  const h = 1 + Math.max(distance(a, d), distance(b, c));
  const scale = Math.min(1, 2400 / Math.max(w, h), Math.sqrt(4_000_000 / (w * h)));
  return { width: Math.max(2, Math.floor(w * scale)), height: Math.max(2, Math.floor(h * scale)) };
}

export function createRectifier(source: ImageData, target: ImageData, corners: Corners) {
  if (!validCorners(corners)) throw new Error('Sudut dokumen harus berurutan dan tidak boleh bersilangan atau terlalu dekat.');
  const [a, b, c, d] = corners;
  // The homogeneous map sends the unit square to the selected quadrilateral.
  const dx1 = b.x - c.x, dx2 = d.x - c.x, dx3 = a.x - b.x + c.x - d.x;
  const dy1 = b.y - c.y, dy2 = d.y - c.y, dy3 = a.y - b.y + c.y - d.y;
  const det = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / det;
  const h = (dx1 * dy3 - dx3 * dy1) / det;
  const ux = b.x - a.x + g * b.x, uy = b.y - a.y + g * b.y;
  const vx = d.x - a.x + h * d.x, vy = d.y - a.y + h * d.y;
  const { width: sw, height: sh, data: src } = source;
  const { width: tw, height: th, data: dst } = target;
  return (start: number, end: number) => {
    for (let row = start; row < end; row++) {
      const v = row / (th - 1);
      const baseX = a.x + vx * v, baseY = a.y + vy * v, baseZ = 1 + h * v;
      for (let col = 0; col < tw; col++) {
        const u = col / (tw - 1);
        const z = baseZ + g * u;
        const x = Math.max(0, Math.min(sw - 1, ((baseX + ux * u) / z) * (sw - 1)));
        const y = Math.max(0, Math.min(sh - 1, ((baseY + uy * u) / z) * (sh - 1)));
        const ix = Math.floor(x), iy = Math.floor(y);
        const fx = x - ix, fy = y - iy;
        const tl = 4 * (iy * sw + ix);
        const tr = tl + (ix < sw - 1 ? 4 : 0);
        const bl = tl + (iy < sh - 1 ? 4 * sw : 0);
        const br = bl + tr - tl;
        const out = 4 * (row * tw + col);
        for (let k = 0; k < 3; k++) {
          dst[out + k] = ((1 - fx) * src[tl + k]! + fx * src[tr + k]!) * (1 - fy)
            + ((1 - fx) * src[bl + k]! + fx * src[br + k]!) * fy;
        }
        dst[out + 3] = 255;
      }
    }
  };
}
