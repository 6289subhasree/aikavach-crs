"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { RepoMap, RunState } from "./types";

/**
 * Point-cloud terrain of the scanned codebase.
 *
 * Files are laid out as a treemap; each file's source lines are rasterised by
 * indent and length, blurred into a height field and mixed with fractal noise,
 * so dense code forms ridges and file boundaries form valleys. A finding adds a
 * heat field that renders as an orange/brown hot zone, which cools to lavender
 * once a patch is proposed. The terrain renders once to offscreen canvases;
 * each frame only composites them with light overlays.
 */

const PITCH = 4;

type RGB = [number, number, number];

// Landing palette, low → high.
const RAMP: [number, RGB][] = [
  [0.0, [58, 36, 98]],
  [0.22, [96, 62, 178]],
  [0.42, [142, 104, 232]],
  [0.6, [192, 160, 250]],
  [0.76, [238, 170, 214]],
  [0.9, [250, 206, 226]],
  [1.0, [255, 244, 248]],
];
const HEAT: [number, RGB][] = [
  [0.0, [236, 170, 136]],
  [0.35, [240, 140, 88]],
  [0.65, [208, 98, 52]],
  [1.0, [112, 54, 32]],
];

function ramp(stops: [number, RGB][], t: number): RGB {
  const v = Math.max(0, Math.min(1, t));
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const [a, ca] = stops[i - 1];
      const [b, cb] = stops[i];
      const k = (v - a) / (b - a || 1);
      return [ca[0] + (cb[0] - ca[0]) * k, ca[1] + (cb[1] - ca[1]) * k, ca[2] + (cb[2] - ca[2]) * k];
    }
  }
  return stops[stops.length - 1][1];
}

function hash(x: number, y: number, seed = 0) {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function valueNoise(x: number, y: number, seed: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi, seed);
  const b = hash(xi + 1, yi, seed);
  const c = hash(xi, yi + 1, seed);
  const d = hash(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x: number, y: number, seed = 1) {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  for (let o = 0; o < 5; o++) {
    sum += valueNoise(x * freq, y * freq, seed + o * 17) * amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / 0.97;
}

function blur(src: Float32Array, cols: number, rows: number, r: number) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const at = (arr: Float32Array, x: number, y: number) =>
    arr[Math.min(rows - 1, Math.max(0, y)) * cols + Math.min(cols - 1, Math.max(0, x))];
  for (let y = 0; y < rows; y++) {
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += at(src, x, y);
    for (let x = 0; x < cols; x++) {
      tmp[y * cols + x] = acc / (2 * r + 1);
      acc += at(src, x + r + 1, y) - at(src, x - r, y);
    }
  }
  for (let x = 0; x < cols; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += at(tmp, x, y);
    for (let y = 0; y < rows; y++) {
      out[y * cols + x] = acc / (2 * r + 1);
      acc += at(tmp, x, y + r + 1) - at(tmp, x, y - r);
    }
  }
  return out;
}

type Rect = { x: number; y: number; w: number; h: number };
type FileRect = Rect & { path: string; lines: number };

/** Binary treemap weighted by sqrt(lines) so small files stay visible. */
function treemap(files: RepoMap["files"], rect: Rect): FileRect[] {
  const items = files.filter((f) => f.line_count > 0).sort((a, b) => b.line_count - a.line_count);
  const out: FileRect[] = [];
  const weight = (f: (typeof items)[number]) => Math.sqrt(f.line_count);
  const split = (list: typeof items, r: Rect) => {
    if (!list.length) return;
    if (list.length === 1) {
      out.push({ ...r, path: list[0].path, lines: list[0].line_count });
      return;
    }
    const total = list.reduce((s, f) => s + weight(f), 0);
    let acc = 0;
    let cut = 0;
    while (cut < list.length - 1 && acc + weight(list[cut]) < total / 2) acc += weight(list[cut++]);
    cut = Math.max(1, cut);
    const k = list.slice(0, cut).reduce((s, f) => s + weight(f), 0) / total;
    if (r.w >= r.h) {
      split(list.slice(0, cut), { x: r.x, y: r.y, w: r.w * k, h: r.h });
      split(list.slice(cut), { x: r.x + r.w * k, y: r.y, w: r.w * (1 - k), h: r.h });
    } else {
      split(list.slice(0, cut), { x: r.x, y: r.y, w: r.w, h: r.h * k });
      split(list.slice(cut), { x: r.x, y: r.y + r.h * k, w: r.w, h: r.h * (1 - k) });
    }
  };
  split(items, rect);
  return out;
}

interface Built {
  cols: number;
  base: HTMLCanvasElement;
  heat: HTMLCanvasElement | null;
  cool: HTMLCanvasElement | null;
  lit: number[];
  files: (FileRect & { cx: number; cy: number })[];
  hot: { x: number; y: number } | null;
}

function build(W: number, H: number, map: RepoMap | null, hotFile: string | null, hotLine: number | null): Built {
  const cols = Math.floor(W / PITCH);
  const rows = Math.floor(H / PITCH);
  const seed = map ? (map.total_lines * 13 + map.files.length) % 997 : 41;

  const region: Rect = { x: cols * 0.1, y: rows * 0.08, w: cols * 0.8, h: rows * 0.84 };
  const rects = map ? treemap(map.files, region) : [];
  const byPath = new Map(map?.files.map((f) => [f.path, f]) ?? []);

  const density = new Float32Array(cols * rows);
  const inside = new Float32Array(cols * rows);
  let hotCell: { x: number; y: number } | null = null;

  for (const r of rects) {
    const f = byPath.get(r.path);
    if (!f) continue;
    const pad = Math.max(1, Math.min(r.w, r.h) * 0.08);
    for (let y = Math.max(0, Math.floor(r.y + pad)); y <= Math.min(rows - 1, Math.ceil(r.y + r.h - pad)); y++)
      for (let x = Math.max(0, Math.floor(r.x + pad)); x <= Math.min(cols - 1, Math.ceil(r.x + r.w - pad)); x++)
        inside[y * cols + x] = 1;
    const n = f.lines.length || 1;
    const maxChars = Math.max(40, ...f.lines);
    const iw = r.w - 2 * pad;
    const ih = r.h - 2 * pad;
    for (let i = 0; i < f.lines.length; i++) {
      const len = f.lines[i];
      const y = Math.round(r.y + pad + ((i + 0.5) / n) * ih);
      const x0 = r.x + pad + ((f.indent[i] ?? 0) / maxChars) * iw;
      const x1 = r.x + pad + (Math.max(len, 1) / maxChars) * iw;
      if (f.path === hotFile && hotLine === i + 1) hotCell = { x: (x0 + x1) / 2, y };
      if (!len || y < 0 || y >= rows) continue;
      for (let x = Math.max(0, Math.floor(x0)); x <= Math.min(cols - 1, Math.ceil(x1)); x++) density[y * cols + x] += 1;
    }
  }

  // Code shapes the land at two scales: broad highlands where code is dense,
  // and a faint trace of individual lines on top.
  const R = Math.max(4, Math.round(Math.min(cols, rows) / 9));
  const broad = blur(blur(blur(density, cols, rows, R), cols, rows, R), cols, rows, Math.ceil(R / 2));
  const fine = blur(density, cols, rows, 2);
  const ins = blur(inside, cols, rows, Math.max(3, Math.round(R / 2)));
  let maxB = 0;
  let maxF = 0;
  for (let i = 0; i < broad.length; i++) {
    maxB = Math.max(maxB, broad[i]);
    maxF = Math.max(maxF, fine[i]);
  }

  const height = new Float32Array(cols * rows);
  const heat = new Float32Array(cols * rows);
  const cx = cols / 2;
  const cy = rows / 2;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const nx = x / 26;
      const ny = y / 26;
      const warp = fbm(nx * 0.55 + 3.1, ny * 0.55, seed + 11);
      const warp2 = fbm(nx * 0.8 - 1.7, ny * 0.8 + 2.3, seed + 29);
      const n = fbm(nx + warp * 2.1, ny + warp2 * 1.8, seed);
      const ridge = 1 - Math.abs(fbm(nx * 1.6 + warp, ny * 1.6, seed + 7) * 2 - 1);
      const b = maxB ? broad[i] / maxB : 0;
      const d = maxF ? Math.pow(fine[i] / maxF, 0.6) : 0;
      const ex = (x - cx) / (cols * 0.5);
      const ey = (y - cy) / (rows * 0.5);
      // Ragged rounded rectangle, like a scanned plot of land.
      const edge = Math.pow(Math.pow(Math.abs(ex), 4) + Math.pow(Math.abs(ey), 4), 0.25) + (fbm(nx * 0.9, ny * 0.9, seed + 5) - 0.5) * 0.42;
      const mask = Math.max(0, Math.min(1, (1.0 - edge) / 0.16));
      const terrain = n * 0.78 + ridge * 0.22;
      const h = map ? terrain * (0.55 + 0.75 * b) * (0.78 + 0.22 * ins[i]) + d * 0.1 : terrain;
      height[i] = h * mask;
      if (hotCell) {
        const dx = x - hotCell.x;
        const dy = (y - hotCell.y) * 1.25;
        const wob = fbm(x / 7, y / 7, seed + 21);
        const core = Math.exp(-(dx * dx + dy * dy) / (2 * 9 * 9)) * (0.55 + wob * 0.9);
        heat[i] = Math.min(1, core * 1.2) * mask;
      }
    }
  }

  const make = () => {
    const c = document.createElement("canvas");
    c.width = cols * PITCH;
    c.height = rows * PITCH;
    return c;
  };
  const base = make();
  const bctx = base.getContext("2d")!;
  const heatC = hotCell ? make() : null;
  const coolC = hotCell ? make() : null;
  const hctx = heatC?.getContext("2d") ?? null;
  const cctx = coolC?.getContext("2d") ?? null;
  const lit: number[] = [];

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const h = height[i];
      const px = x * PITCH + PITCH / 2 + (hash(x, y, 3) - 0.5) * 1.2;
      const py = y * PITCH + PITCH / 2 + (hash(x, y, 4) - 0.5) * 1.2;
      if (h < 0.17) {
        if (h > 0.07 || (x % 2 === 0 && y % 2 === 0)) {
          bctx.fillStyle = `rgba(150,136,176,${h > 0.07 ? 0.34 : 0.14})`;
          bctx.fillRect(px, py, 1, 1);
        }
        continue;
      }
      const t = Math.min(1, Math.pow((h - 0.17) / 0.58, 0.85));
      const [r, g, b] = ramp(RAMP, t);
      const size = 0.7 + t * 1.15 + hash(x, y, 9) * 0.45;
      bctx.fillStyle = `rgba(${r | 0},${g | 0},${b | 0},${0.5 + t * 0.5})`;
      bctx.beginPath();
      bctx.arc(px, py, size / 2 + 0.15, 0, Math.PI * 2);
      bctx.fill();
      if (t > 0.5) lit.push(i);

      const q = heat[i];
      if (hctx && cctx && q > 0.07) {
        const s2 = size + q * 0.8;
        const [hr, hg, hb] = ramp(HEAT, q);
        hctx.fillStyle = `rgba(${hr | 0},${hg | 0},${hb | 0},${Math.min(1, 0.3 + q)})`;
        hctx.beginPath();
        hctx.arc(px, py, s2 / 2 + 0.2, 0, Math.PI * 2);
        hctx.fill();
        const [cr, cg, cb] = ramp(RAMP, 0.6 + q * 0.4);
        cctx.fillStyle = `rgba(${cr | 0},${cg | 0},${cb | 0},${Math.min(1, 0.25 + q * 0.75)})`;
        cctx.beginPath();
        cctx.arc(px, py, s2 / 2 + 0.2, 0, Math.PI * 2);
        cctx.fill();
      }
    }
  }

  return {
    cols,
    base,
    heat: heatC,
    cool: coolC,
    lit,
    files: rects
      .slice()
      .sort((a, b) => b.lines - a.lines)
      .map((r) => ({ ...r, cx: (r.x + r.w / 2) * PITCH, cy: (r.y + r.h / 2) * PITCH })),
    hot: hotCell ? { x: hotCell.x * PITCH + PITCH / 2, y: hotCell.y * PITCH + PITCH / 2 } : null,
  };
}

export interface TerrainProps {
  run: RunState;
  hotFile: string | null;
  hotLine: number | null;
  showPins: boolean;
  onHotspot: (point: { x: number; y: number; w: number; h: number } | null) => void;
}

export default function Terrain({ run, hotFile, hotLine, showPins, onHotspot }: TerrainProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const runRef = useRef(run);
  const patchedAt = useRef<number | null>(null);

  useEffect(() => {
    runRef.current = run;
    if (run.patch && patchedAt.current === null) patchedAt.current = performance.now();
    if (!run.patch) patchedAt.current = null;
  }, [run]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setSize({ w: Math.round(entry.contentRect.width), h: Math.round(entry.contentRect.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const built = useMemo(
    () => (size.w > 40 && size.h > 40 ? build(size.w, size.h, run.repoMap, hotFile, hotLine) : null),
    [size.w, size.h, run.repoMap, hotFile, hotLine],
  );

  const hot = run.findings.length && built?.hot ? built.hot : null;
  const hx = hot?.x ?? null;
  const hy = hot?.y ?? null;
  useEffect(() => {
    onHotspot(hx !== null && hy !== null ? { x: hx, y: hy, w: size.w, h: size.h } : null);
  }, [hx, hy, size.w, size.h, onHotspot]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !built) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size.w * dpr;
    canvas.height = size.h * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const order = ["build", "tests", "security_regression", "static_rescan"] as const;
    let raf = 0;
    const t0 = performance.now();

    const frame = (now: number) => {
      const t = (now - t0) / 1000;
      const r = runRef.current;
      ctx.clearRect(0, 0, size.w, size.h);
      ctx.globalAlpha = r.repoMap ? 1 : 0.6;
      ctx.drawImage(built.base, 0, 0);
      ctx.globalAlpha = 1;

      if (r.stages.FIND.status === "running" || (r.phase === "running" && !r.repoMap)) {
        const bx = ((t * 0.45) % 1.4) * size.w - 0.2 * size.w;
        ctx.save();
        ctx.beginPath();
        ctx.rect(bx - 50, 0, 100, size.h);
        ctx.clip();
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = 0.65;
        ctx.drawImage(built.base, 0, 0);
        ctx.restore();
      }

      if (!reduced && built.lit.length) {
        ctx.fillStyle = "rgba(255,248,252,0.75)";
        for (let k = 0; k < 26; k++) {
          const i = built.lit[(Math.random() * built.lit.length) | 0];
          ctx.fillRect((i % built.cols) * PITCH + 1, Math.floor(i / built.cols) * PITCH + 1, 1.6, 1.6);
        }
      }

      if (r.findings.length && built.heat && built.cool) {
        const pulse = reduced ? 1 : 0.86 + Math.sin(t * 2.2) * 0.14;
        const cooled = patchedAt.current && r.decision !== "REJECTED" ? Math.min(1, (now - patchedAt.current) / 1500) : 0;
        ctx.globalAlpha = (1 - cooled) * pulse;
        ctx.drawImage(built.heat, 0, 0);
        if (cooled) {
          ctx.globalAlpha = cooled * 0.85;
          ctx.drawImage(built.cool, 0, 0);
        }
        ctx.globalAlpha = 1;

        if (built.hot) {
          const { x, y } = built.hot;
          order.forEach((name, k) => {
            const c = r.checks[name];
            if (!c) return;
            ctx.strokeStyle = c.passed ? "rgba(226,214,252,0.32)" : "rgba(255,106,77,0.6)";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.ellipse(x, y, 34 + k * 20, (34 + k * 20) * 0.6, 0, 0, Math.PI * 2);
            ctx.stroke();
          });
          if (r.stages.VERIFY.status === "running" && !reduced) {
            const k = Object.keys(r.checks).length;
            const grow = (t * 30) % 20;
            ctx.strokeStyle = `rgba(255,255,255,${0.4 - grow / 55})`;
            ctx.setLineDash([2, 4]);
            ctx.beginPath();
            ctx.ellipse(x, y, 34 + k * 20 + grow, (34 + k * 20 + grow) * 0.6, 0, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);
          }
        }
      }

      if (!reduced) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [built, size]);

  const verified = run.decision === "VERIFIED";
  const failed = run.decision === "REJECTED" || (run.phase === "error" && run.findings.length > 0);
  const filePins = showPins && built && run.repoMap ? built.files.filter((f) => f.path !== hotFile && f.w * f.h > 120).slice(0, 5) : [];

  return (
    <div className="terrain" ref={wrapRef}>
      <canvas ref={canvasRef} role="img" aria-label="Point-cloud map of the scanned codebase" />
      {filePins.map((f) => (
        <span key={f.path} className="pin" style={{ left: f.cx, top: f.cy }} title={`${f.path} · ${f.lines} lines · no findings`}>
          <i className="fa-solid fa-shield-halved ok" />
        </span>
      ))}
      {showPins && hot && (
        <span className="pin pin-main" style={{ left: hot.x, top: hot.y }} title={`${hotFile}:${hotLine}`}>
          <i className={`fa-solid ${verified ? "fa-shield-halved ok" : failed ? "fa-xmark bad" : "fa-triangle-exclamation hot"}`} />
        </span>
      )}
    </div>
  );
}
