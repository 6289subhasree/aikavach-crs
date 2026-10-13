"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { RepoMap, RunState } from "./types";

/**
 * The centre "system analysis" field.
 *
 * Every source line of the scanned repository is drawn as a row of dots shaped
 * like the code itself (indent and length), so the field literally is the
 * codebase. Pipeline events animate it: a scan beam during FIND, the vulnerable
 * line igniting, evidence links during REASON, the line rewriting during PATCH
 * and one ripple ring per verification check.
 */

const PALETTE = ["#c9b8f2", "#b7a1ea", "#e6a7c9", "#f0b08c", "#e98a5c"];
const HOT = "#ff7a45";
const CHAR_PER_DOT = 2;
const MAX_DOTS_PER_LINE = 60;

interface Dot {
  x: number;
  y: number;
  c: number;
  key: string;
}

interface LineBox {
  x: number;
  y: number;
  w: number;
}

interface Layout {
  dots: Dot[];
  lines: Map<string, LineBox>;
  labels: { x: number; y: number; text: string }[];
  size: number;
  rowsPerDot: number;
  box: { x: number; y: number; w: number; h: number };
}

function layoutField(map: RepoMap | null, W: number, H: number): Layout | null {
  if (!map || !map.files.length || W < 50 || H < 50) return null;
  const regionW = W * 0.76;
  const regionH = H * 0.7;
  const files = map.files.filter((f) => f.line_count > 0);
  if (!files.length) return null;

  const blockW = (f: (typeof files)[number]) =>
    Math.min(MAX_DOTS_PER_LINE, Math.max(8, ...f.lines.map((l) => Math.ceil(l / CHAR_PER_DOT))));

  // Pick the column count that gives the largest dot spacing, then group
  // source lines vertically if the tallest column still doesn't fit.
  let best: { cols: number; sx: number; sy: number; columns: (typeof files)[]; widths: number[] } | null = null;
  for (let cols = 1; cols <= Math.min(files.length, 10); cols++) {
    const columns: (typeof files)[] = Array.from({ length: cols }, () => []);
    const heights = new Array(cols).fill(0);
    for (const f of files) {
      const i = heights.indexOf(Math.min(...heights));
      columns[i].push(f);
      heights[i] += f.lines.length + 3;
    }
    const widths = columns.map((c) => (c.length ? Math.max(...c.map(blockW)) : 0));
    const dotsWide = widths.reduce((a, b) => a + b, 0) + (cols - 1) * 6;
    const sx = regionW / dotsWide;
    const sy = regionH / Math.max(...heights);
    if (!best || Math.min(sx, sy) > Math.min(best.sx, best.sy)) best = { cols, sx, sy, columns, widths };
  }
  if (!best) return null;

  const sp = Math.min(13, best.sx);
  const rowsPerDot = best.sy >= sp ? 1 : Math.ceil(sp / best.sy);
  const widths = best.widths;
  const totalW = (widths.reduce((a, b) => a + b, 0) + (best.cols - 1) * 6) * sp;
  const heights = best.columns.map((c) => c.reduce((h, f) => h + Math.ceil(f.lines.length / rowsPerDot) + 3, 0));
  const totalH = Math.max(...heights) * sp;
  const x0 = (W - totalW) / 2;
  const y0 = (H - totalH) / 2 + sp;

  const dots: Dot[] = [];
  const lines = new Map<string, LineBox>();
  const labels: Layout["labels"] = [];
  let cx = x0;
  best.columns.forEach((column, ci) => {
    let row = 0;
    for (const f of column) {
      labels.push({ x: cx, y: y0 + row * sp - sp * 1.2, text: f.path });
      for (let i = 0; i < f.lines.length; i += rowsPerDot) {
        let len = 0;
        let indent = Infinity;
        for (let k = i; k < Math.min(i + rowsPerDot, f.lines.length); k++) {
          len = Math.max(len, f.lines[k]);
          if (f.lines[k] > 0) indent = Math.min(indent, f.indent[k] ?? 0);
        }
        if (!Number.isFinite(indent)) indent = 0;
        const startDot = Math.floor(indent / CHAR_PER_DOT);
        const endDot = Math.min(MAX_DOTS_PER_LINE, Math.ceil(len / CHAR_PER_DOT));
        const y = y0 + row * sp;
        const depth = Math.min(PALETTE.length - 1, Math.floor(indent / 4));
        for (let k = i; k < Math.min(i + rowsPerDot, f.lines.length); k++) {
          lines.set(`${f.path}:${k + 1}`, { x: cx + startDot * sp, y, w: Math.max(1, endDot - startDot) * sp });
        }
        for (let d = startDot; d < endDot; d++) {
          dots.push({ x: cx + d * sp, y, c: depth, key: `${f.path}:${i + 1}` });
        }
        row++;
      }
      row += 3;
    }
    cx += (widths[ci] + 6) * sp;
  });

  return { dots, lines, labels, size: sp, rowsPerDot, box: { x: x0, y: y0 - sp, w: totalW, h: totalH } };
}

function noise(x: number, y: number, t: number) {
  return (
    Math.sin(x * 0.013 + t * 0.6) * Math.cos(y * 0.017 - t * 0.4) +
    Math.sin((x + y) * 0.007 + t * 0.25) * 0.6 +
    Math.cos(x * 0.031 - y * 0.011 + t * 0.9) * 0.25
  );
}

export interface FieldProps {
  run: RunState;
  hotFile: string | null;
  hotLine: number | null;
}

export default function SystemField({ run, hotFile, hotLine }: FieldProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  }, [run]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ w: Math.round(width), h: Math.round(height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const layout = useMemo(() => layoutField(run.repoMap, size.w, size.h), [run.repoMap, size.w, size.h]);
  const group = (line: number) => (layout ? Math.floor((line - 1) / layout.rowsPerDot) * layout.rowsPerDot + 1 : line);
  const hotKey = hotFile && hotLine ? `${hotFile}:${group(hotLine)}` : null;
  const hotBox = layout && hotKey ? layout.lines.get(hotKey) ?? null : null;

  const evidenceKeys = useMemo(() => {
    const ev = run.evidence;
    if (!ev) return new Set<string>();
    const keys = new Set<string>();
    const rows = layout?.rowsPerDot ?? 1;
    for (let l = ev.start_line; l <= ev.end_line; l++) keys.add(`${ev.file}:${Math.floor((l - 1) / rows) * rows + 1}`);
    return keys;
  }, [run.evidence, layout]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size.w || !size.h) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size.w * dpr;
    canvas.height = size.h * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const ambientStep = 13;
    let raf = 0;
    const started = performance.now();

    const draw = (now: number) => {
      const t = (now - started) / 1000;
      const r = runRef.current;
      const W = size.w;
      const H = size.h;
      ctx.clearRect(0, 0, W, H);

      const scanning = r.stages.FIND.status === "running";
      const verifying = r.stages.VERIFY.status === "running";
      const decided = r.decision;
      const beam = scanning ? ((t * 0.42) % 1.3) * W - 0.15 * W : -1e9;

      // Ambient terrain: the "everything else" the system watches.
      for (let y = ambientStep / 2; y < H; y += ambientStep) {
        const v = y / H;
        for (let x = ambientStep / 2; x < W; x += ambientStep) {
          const n = noise(x, y, reduced ? 0 : t);
          let a = Math.max(0, n) * 0.16 + 0.025;
          if (layout) {
            const b = layout.box;
            if (x > b.x - 20 && x < b.x + b.w + 20 && y > b.y - 20 && y < b.y + b.h + 20) a *= 0.25;
          }
          if (scanning) a += Math.max(0, 1 - Math.abs(x - beam) / 60) * 0.35;
          ctx.fillStyle = v < 0.5 ? `rgba(185,161,234,${a})` : `rgba(240,160,122,${a * (0.6 + v * 0.5)})`;
          ctx.fillRect(x, y, 1.6, 1.6);
        }
      }

      if (!layout) {
        raf = reduced ? 0 : requestAnimationFrame(draw);
        return;
      }

      const sp = layout.size;
      const ds = Math.max(1.2, sp * 0.56);
      const hasEvidence = evidenceKeys.size > 0;
      const patched = !!r.patch;

      for (const dot of layout.dots) {
        let alpha = 0.5;
        let color = PALETTE[dot.c];
        let s = ds;
        if (scanning) {
          const dist = Math.abs(dot.x - beam);
          alpha = 0.22 + Math.max(0, 1 - dist / 70) * 0.78;
        } else if (hasEvidence) {
          alpha = evidenceKeys.has(dot.key) ? 0.9 : 0.24;
        }
        if (dot.key === hotKey) {
          color = patched ? "#ffffff" : HOT;
          alpha = 1;
          s = ds * 1.25;
        }
        if (decided === "VERIFIED" && !reduced) alpha = Math.min(1, alpha + Math.max(0, Math.sin(t * 1.6)) * 0.08);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = color;
        ctx.fillRect(dot.x - s / 2, dot.y - s / 2, s, s);
      }
      ctx.globalAlpha = 1;

      if (hotBox) {
        const hx = hotBox.x + hotBox.w / 2;
        const hy = hotBox.y;
        const pulse = reduced ? 0.5 : (Math.sin(t * 3) + 1) / 2;

        // Bloom around the vulnerable line.
        const bloom = ctx.createRadialGradient(hx, hy, 0, hx, hy, 60 + pulse * 18);
        const tint = patched ? (decided === "REJECTED" ? "255,106,77" : "201,184,242") : "255,122,69";
        bloom.addColorStop(0, `rgba(${tint},0.38)`);
        bloom.addColorStop(1, `rgba(${tint},0)`);
        ctx.fillStyle = bloom;
        ctx.fillRect(hx - 90, hy - 90, 180, 180);

        // Evidence links while the model reasons.
        if (hasEvidence && !patched) {
          ctx.lineWidth = 1;
          for (const key of evidenceKeys) {
            const box = layout.lines.get(key);
            if (!box || key === hotKey) continue;
            ctx.strokeStyle = `rgba(201,184,242,${0.12 + pulse * 0.3})`;
            ctx.beginPath();
            ctx.moveTo(hx, hy);
            ctx.lineTo(box.x + box.w / 2, box.y);
            ctx.stroke();
          }
        }

        // One ring per verification check.
        const done = Object.values(r.checks);
        done.forEach((check, i) => {
          ctx.strokeStyle = check?.passed ? "rgba(201,184,242,0.55)" : "rgba(255,106,77,0.7)";
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(hx, hy, 34 + i * 22, 0, Math.PI * 2);
          ctx.stroke();
        });
        if (verifying) {
          const rr = 34 + done.length * 22 + (reduced ? 0 : ((t * 40) % 22));
          ctx.strokeStyle = `rgba(255,255,255,${0.35 - ((t * 40) % 22) / 80})`;
          ctx.setLineDash([2, 5]);
          ctx.beginPath();
          ctx.arc(hx, hy, rr, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      if (!reduced) raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [size, layout, hotKey, hotBox, evidenceKeys]);

  const finding = run.findings[0];
  const pinX = hotBox ? hotBox.x + hotBox.w / 2 : null;
  const pinY = hotBox ? hotBox.y : null;
  const verified = run.decision === "VERIFIED";
  const rejected = run.decision === "REJECTED" || (run.phase === "error" && !!finding);
  const calloutLeft = pinX !== null && pinX > size.w * 0.62;

  return (
    <div className="field" ref={wrapRef}>
      <canvas ref={canvasRef} className="field-canvas" aria-hidden="true" />

      {layout && layout.labels.length <= 14 && layout.size >= 4 &&
        layout.labels.map((label) => (
          <span key={label.text} className="field-label" style={{ left: label.x, top: label.y }}>
            {label.text}
          </span>
        ))}

      {pinX !== null && pinY !== null && finding && (
        <>
          <span
            className={`pin ${verified ? "pin-safe" : rejected ? "pin-fail" : "pin-hot"}`}
            style={{ left: pinX, top: pinY }}
            title={finding.title}
          >
            <i className={`fa-solid ${verified ? "fa-shield-halved" : rejected ? "fa-xmark" : "fa-triangle-exclamation"}`} />
          </span>
          <div className={`callout ${calloutLeft ? "callout-left" : ""}`} style={{ left: pinX, top: pinY }}>
            <i className={`fa-solid ${verified ? "fa-shield-halved safe" : "fa-triangle-exclamation hot"}`} />
            <span>
              {verified ? "Patched & proven" : finding.vulnerability_type}
              <em>
                {hotFile}:{hotLine}
              </em>
            </span>
          </div>
        </>
      )}

      {!run.repoMap && (
        <div className="field-empty">
          <span className="display">{run.phase === "running" ? "Mapping system" : "Awaiting target"}</span>
          <p>{run.phase === "running" ? "Reading every source file…" : "Pick a repository and run VAYU. Every line of code appears here as it is analysed."}</p>
        </div>
      )}
    </div>
  );
}
