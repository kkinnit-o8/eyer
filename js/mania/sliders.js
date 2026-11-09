// Slider paths, from the curve in an .osu file: Bézier (B), perfect circle
// arc (P), straight lines (L) or Catmull-Rom (C), in osu! pixels.

const STEP = 4; // roughly how far apart the sampled points are (osu! pixels)

/**
 * The path a slider's ball follows, cut (or stretched along its last
 * direction) to `length`. Returns { length, at(d) } where at(d) is the
 * point d pixels along it.
 */
export function sliderPath({ type, points }, length) {
  let raw;
  if (points.length < 2) raw = [points[0], points[0]];
  else if (type === "P" && points.length === 3) raw = arc(points) ?? bezier(points);
  else if (type === "C") raw = catmull(points);
  else if (type === "L") raw = points;
  else raw = bezierSegments(points);
  return measure(raw, length);
}

// A repeated point (a red anchor in the editor) splits a Bézier slider
// into separate curves.
function bezierSegments(points) {
  const out = [];
  let segment = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    const prev = points[i - 1];
    if (p.x === prev.x && p.y === prev.y) {
      if (segment.length > 1) out.push(...bezier(segment));
      segment = [p];
    } else {
      segment.push(p);
    }
  }
  if (segment.length > 1) out.push(...bezier(segment));
  return out.length ? out : [points[0], points[0]];
}

function bezier(control) {
  if (control.length === 2) return control;
  let polygon = 0;
  for (let i = 1; i < control.length; i++) polygon += dist(control[i - 1], control[i]);
  const n = Math.max(8, Math.min(400, Math.ceil(polygon / STEP)));
  const out = [];
  for (let i = 0; i <= n; i++) {
    // de Casteljau
    const t = i / n;
    const p = control.map((q) => ({ ...q }));
    for (let k = p.length - 1; k > 0; k--) {
      for (let j = 0; j < k; j++) {
        p[j].x += (p[j + 1].x - p[j].x) * t;
        p[j].y += (p[j + 1].y - p[j].y) * t;
      }
    }
    out.push(p[0]);
  }
  return out;
}

// The circle through three points, from the first through the second to
// the third. null if they're in a line.
function arc([a, b, c]) {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-6) return null;
  const sq = (p) => p.x * p.x + p.y * p.y;
  const cx = (sq(a) * (b.y - c.y) + sq(b) * (c.y - a.y) + sq(c) * (a.y - b.y)) / d;
  const cy = (sq(a) * (c.x - b.x) + sq(b) * (a.x - c.x) + sq(c) * (b.x - a.x)) / d;
  const r = Math.hypot(a.x - cx, a.y - cy);
  const start = Math.atan2(a.y - cy, a.x - cx);
  let end = Math.atan2(c.y - cy, c.x - cx);
  // Go the way that passes through b.
  const clockwise = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) < 0;
  if (clockwise) while (end > start) end -= 2 * Math.PI;
  else while (end < start) end += 2 * Math.PI;
  const n = Math.max(8, Math.min(400, Math.ceil((Math.abs(end - start) * r) / STEP)));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const angle = start + ((end - start) * i) / n;
    out.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
  }
  return out;
}

function catmull(points) {
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const n = Math.max(4, Math.ceil(dist(p1, p2) / STEP));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - a - 3 * c + d) * t3);
      out.push({ x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y) });
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

// Cumulative distances along the points, cut or stretched to `length`.
function measure(raw, length) {
  const pts = [raw[0]];
  const cum = [0];
  for (let i = 1; i < raw.length; i++) {
    const d = dist(raw[i - 1], raw[i]);
    if (d < 1e-6) continue;
    pts.push(raw[i]);
    cum.push(cum[cum.length - 1] + d);
  }
  const total = cum[cum.length - 1];
  if (!(length > 0)) length = total;
  if (total < length && pts.length > 1) {
    // Too short: carry on in the last direction.
    const a = pts[pts.length - 2];
    const b = pts[pts.length - 1];
    const d = dist(a, b);
    const extra = length - total;
    pts.push({ x: b.x + ((b.x - a.x) / d) * extra, y: b.y + ((b.y - a.y) / d) * extra });
    cum.push(length);
  }
  const at = (distance) => {
    const d = Math.max(0, Math.min(length, distance));
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= d) lo = mid;
      else hi = mid;
    }
    if (hi === lo) return { ...pts[lo] };
    const f = (d - cum[lo]) / (cum[hi] - cum[lo] || 1);
    return { x: pts[lo].x + (pts[hi].x - pts[lo].x) * f, y: pts[lo].y + (pts[hi].y - pts[lo].y) * f };
  };
  return { length, at };
}

function dist(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}
