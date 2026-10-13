"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { RunState } from "./types";

/**
 * System view: a data-flow diagram of the architecture the scanned code runs
 * in, drawn in the same point-cloud style as the terrain.
 *
 * Nodes are rotating point-cloud spheres (input source, the application
 * function, the flagged call, downstream services) plus VAYU and its sandbox.
 * Benign request markers flow along the edges so the system looks alive. The
 * edge that carries untrusted data into the flagged call is marked as the risk
 * path; once the verified patch lands, that edge is shown closed. This is an
 * illustration driven by the run's real data — VAYU never runs exploits.
 */

export type NodeId = "input" | "app" | "sink" | "downstream" | "vayu" | "sandbox";

interface NodeView {
  id: NodeId;
  title: string;
  sub: string;
  detail: string;
  icon: string;
}

type EdgeId = "in-app" | "app-sink" | "sink-down" | "vayu-app" | "app-box" | "vayu-box";
const EDGES: Record<EdgeId, [NodeId, NodeId, number]> = {
  "in-app": ["input", "app", -0.14],
  "app-sink": ["app", "sink", 0.12],
  "sink-down": ["sink", "downstream", -0.14],
  "vayu-app": ["vayu", "app", 0.12],
  "app-box": ["app", "sandbox", -0.12],
  "vayu-box": ["vayu", "sandbox", 0.0],
};
const POS: Record<NodeId, [number, number]> = {
  input: [0.1, 0.46],
  app: [0.33, 0.3],
  sink: [0.56, 0.5],
  downstream: [0.88, 0.42],
  vayu: [0.64, 0.84],
  sandbox: [0.3, 0.82],
};

interface Marker {
  route: EdgeId[];
  leg: number;
  t: number;
  speed: number;
  kind: "benign" | "trace" | "copy";
}

export function deriveSystem(run: RunState, hotFile: string | null, hotLine: number | null) {
  const finding = run.findings[0];
  const ev = run.evidence;
  const lines = (ev?.content ?? "").split("\n").map((l) => {
    const m = /^(\d+): ?(.*)$/.exec(l);
    return m ? { n: Number(m[1]), text: m[2] } : { n: 0, text: l };
  });
  let fn: string | null = null;
  for (const l of lines) {
    if (hotLine && l.n > hotLine) break;
    const m = /def\s+(\w+)\s*\(/.exec(l.text);
    if (m) fn = m[1];
  }
  const hotText = lines.find((l) => l.n === hotLine)?.text.trim() ?? null;
  const all = ev?.content ?? "";
  const source = /sys\.argv/.test(all)
    ? "command-line arguments"
    : /request\b/.test(all)
      ? "an HTTP request"
      : /input\s*\(/.test(all)
        ? "console input"
        : "an external caller";
  const sinkName = hotText ? hotText.replace(/\s*#.*/, "").slice(0, 46) : finding?.vulnerability_type ?? "the flagged call";
  const downstream = /subprocess|os\.system|Popen/.test(all)
    ? { title: "System shell", sub: "OS commands", icon: "fa-terminal" }
    : /execute|cursor|sql/i.test(all)
      ? { title: "Database", sub: "SQL queries", icon: "fa-database" }
      : /open\(|Path\(|\.read/.test(all)
        ? { title: "File system", sub: "file access", icon: "fa-folder-tree" }
        : { title: "Downstream", sub: "external effect", icon: "fa-diagram-project" };

  const nodes: Record<NodeId, NodeView> = {
    input: { id: "input", title: "Untrusted input", sub: source, detail: `Data arrives from ${source}. VAYU treats everything from here as untrusted.`, icon: "fa-right-to-bracket" },
    app: { id: "app", title: fn ? `${fn}()` : "Application", sub: hotFile ?? "your code", detail: fn ? `The function ${fn}() in ${hotFile} handles the request.` : "Your code handles the request.", icon: "fa-code" },
    sink: { id: "sink", title: "Flagged call", sub: sinkName, detail: hotText ? `Line ${hotLine}: ${hotText}` : "The call Semgrep flagged.", icon: "fa-triangle-exclamation" },
    downstream: { ...downstream, id: "downstream", detail: `The flagged call reaches the ${downstream.title.toLowerCase()}.` } as NodeView,
    vayu: { id: "vayu", title: "VAYU", sub: "reasoning agent", detail: "VAYU reasons about the finding, proposes a patch, and verifies it before accepting.", icon: "fa-shield-halved" },
    sandbox: { id: "sandbox", title: "Sandbox", sub: "throwaway copy", detail: "A temporary copy of the repo where the patch is built and tested. Your real files are never touched.", icon: "fa-box-archive" },
  };

  const stage: "scan" | "reason" | "patched" | "rejected" | "idle" =
    run.decision === "VERIFIED"
      ? "patched"
      : run.decision === "REJECTED"
        ? "rejected"
        : run.stages.PATCH.status !== "idle" || run.reasoning
          ? "reason"
          : run.findings.length
            ? "reason"
            : run.phase === "running"
              ? "scan"
              : "idle";

  return { nodes, downstream, sinkName, fn, hotText, source, stage, patched: run.decision === "VERIFIED" };
}

export interface SystemProps {
  run: RunState;
  hotFile: string | null;
  hotLine: number | null;
  onInspect: (node: NodeId) => void;
}

export default function System({ run, hotFile, hotLine, onInspect }: SystemProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hoverNode, setHoverNode] = useState<NodeId | null>(null);
  const model = useMemo(() => deriveSystem(run, hotFile, hotLine), [run, hotFile, hotLine]);
  const markers = useRef<Marker[]>([]);
  const lastSpawn = useRef(0);
  const modelRef = useRef(model);
  useEffect(() => {
    modelRef.current = model;
  }, [model]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Sphere point clouds, one per node, generated once.
  const clouds = useMemo(() => {
    const out: Record<string, { x: number; y: number; z: number }[]> = {};
    for (const id of Object.keys(POS)) {
      const pts: { x: number; y: number; z: number }[] = [];
      const n = id === "input" ? 90 : 150;
      for (let i = 0; i < n; i++) {
        const phi = Math.acos(1 - (2 * (i + 0.5)) / n);
        const theta = Math.PI * (1 + Math.sqrt(5)) * i;
        pts.push({ x: Math.sin(phi) * Math.cos(theta), y: Math.sin(phi) * Math.sin(theta), z: Math.cos(phi) });
      }
      out[id] = pts;
    }
    return out;
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.w < 40 || size.h < 40) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size.w * dpr;
    canvas.height = size.h * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const W = size.w;
    const H = size.h;
    const px = (id: NodeId) => ({ x: POS[id][0] * W, y: POS[id][1] * H });
    const radius = Math.max(16, Math.min(W, H) * 0.058);

    const bezier = (a: { x: number; y: number }, b: { x: number; y: number }, bow: number, t: number) => {
      const mx = (a.x + b.x) / 2 + (b.y - a.y) * bow;
      const my = (a.y + b.y) / 2 - (b.x - a.x) * bow;
      const u = 1 - t;
      return { x: u * u * a.x + 2 * u * t * mx + t * t * b.x, y: u * u * a.y + 2 * u * t * my + t * t * b.y };
    };

    let raf = 0;
    const t0 = performance.now();

    const spawn = (now: number) => {
      const m = modelRef.current;
      if (m.stage === "idle") return;
      if (now - lastSpawn.current > 900) {
        lastSpawn.current = now;
        markers.current.push({ route: ["in-app", "app-sink", "sink-down"], leg: 0, t: 0, speed: 0.22, kind: "benign" });
      }
      // Scan sweeps while finding/reasoning.
      if ((m.stage === "scan" || m.stage === "reason") && Math.random() < 0.04) {
        markers.current.push({ route: ["vayu-app"], leg: 0, t: 0, speed: 0.4, kind: "trace" });
      }
      // Copy into sandbox around patch time.
      if (m.stage === "reason" && Math.random() < 0.03) {
        markers.current.push({ route: ["app-box"], leg: 0, t: 0, speed: 0.5, kind: "copy" });
      }
    };

    const frame = (now: number) => {
      const t = (now - t0) / 1000;
      const m = modelRef.current;
      ctx.clearRect(0, 0, W, H);
      spawn(now);

      // Edges.
      for (const [eid, [a, b, bow]] of Object.entries(EDGES) as [EdgeId, [NodeId, NodeId, number]][]) {
        const pa = px(a);
        const pb = px(b);
        const risk = eid === "app-sink" || eid === "sink-down";
        const closed = risk && m.patched;
        const support = eid === "vayu-app" || eid === "app-box" || eid === "vayu-box";
        ctx.save();
        for (let s = 0; s <= 1.0001; s += 0.03) {
          const p = bezier(pa, pb, bow, s);
          const near = s < 0.12 || s > 0.88;
          if (near) continue;
          let col = "rgba(150,140,175,0.5)";
          if (risk) col = closed ? "rgba(201,184,242,0.55)" : "rgba(255,138,82,0.7)";
          else if (support) col = "rgba(201,184,242,0.3)";
          ctx.fillStyle = col;
          ctx.fillRect(p.x - 0.9, p.y - 0.9, 1.8, 1.8);
        }
        if (closed) {
          const mid = bezier(pa, pb, bow, 0.5);
          ctx.strokeStyle = "rgba(201,184,242,0.8)";
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(mid.x - 5, mid.y - 5);
          ctx.lineTo(mid.x + 5, mid.y + 5);
          ctx.moveTo(mid.x + 5, mid.y - 5);
          ctx.lineTo(mid.x - 5, mid.y + 5);
          ctx.stroke();
        }
        ctx.restore();
      }

      // Markers.
      markers.current = markers.current.filter((pk) => {
        pk.t += (reduced ? 0.02 : 0.016) * pk.speed * 2.2;
        if (pk.t >= 1) {
          pk.leg += 1;
          pk.t = 0;
          if (pk.leg >= pk.route.length) return false;
        }
        const eid = pk.route[pk.leg];
        const [a, b, bow] = EDGES[eid];
        const p = bezier(px(a), px(b), bow, pk.t);
        let color = "rgba(214,206,236,0.9)";
        const r = 2;
        if (pk.kind === "trace") {
          color = "rgba(201,184,242,0.95)";
        } else if (pk.kind === "copy") {
          color = "rgba(240,162,122,0.9)";
        }
        ctx.save();
        ctx.shadowBlur = 8;
        ctx.shadowColor = color;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        return true;
      });
      if (markers.current.length > 60) markers.current = markers.current.slice(-60);

      // Nodes as rotating spheres.
      const draw = (id: NodeId) => {
        const c = px(id);
        const cloud = clouds[id];
        const ry = reduced ? id.length : t * 0.5 + id.length;
        const risky = id === "sink";
        const base: [number, number, number] = risky && !m.patched ? [255, 138, 82] : risky ? [201, 184, 242] : id === "vayu" || id === "sandbox" ? [201, 184, 242] : [170, 150, 220];
        const active = hoverNode === id;
        for (const pt of cloud) {
          const cosA = Math.cos(ry);
          const sinA = Math.sin(ry);
          const x = pt.x * cosA - pt.z * sinA;
          const z = pt.x * sinA + pt.z * cosA;
          const depth = (z + 1) / 2;
          const sx = c.x + x * radius;
          const sy = c.y + pt.y * radius;
          const a = 0.2 + depth * 0.7;
          const s = 0.6 + depth * 1.3;
          ctx.fillStyle = `rgba(${base[0]},${base[1]},${base[2]},${a * (active ? 1 : 0.85)})`;
          ctx.fillRect(sx - s / 2, sy - s / 2, s, s);
        }
        // Halo on the risky node.
        if (risky) {
          const pulse = reduced ? 0.4 : (Math.sin(t * 2.4) + 1) / 2;
          const tint = m.patched ? "201,184,242" : "255,138,82";
          const g = ctx.createRadialGradient(c.x, c.y, radius * 0.4, c.x, c.y, radius * 1.9);
          g.addColorStop(0, `rgba(${tint},${0.22 + pulse * 0.18})`);
          g.addColorStop(1, `rgba(${tint},0)`);
          ctx.fillStyle = g;
          ctx.fillRect(c.x - radius * 2, c.y - radius * 2, radius * 4, radius * 4);
        }
      };
      (["downstream", "input", "sandbox", "vayu", "app", "sink"] as NodeId[]).forEach(draw);

      if (!reduced) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [size, clouds, hoverNode]);

  const radius = Math.max(16, Math.min(size.w, size.h) * 0.058);
  const hit = (e: React.MouseEvent) => {
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const mx = e.clientX - box.left;
    const my = e.clientY - box.top;
    let found: NodeId | null = null;
    for (const id of Object.keys(POS) as NodeId[]) {
      const dx = mx - POS[id][0] * size.w;
      const dy = my - POS[id][1] * size.h;
      if (dx * dx + dy * dy < (radius * 1.3) ** 2) found = id;
    }
    return found;
  };

  return (
    <div className="system" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label="Simulated diagram of the system the scanned code runs in"
        onMouseMove={(e) => setHoverNode(hit(e))}
        onMouseLeave={() => setHoverNode(null)}
        onClick={(e) => {
          const n = hit(e);
          if (n) onInspect(n);
        }}
        style={{ cursor: hoverNode ? "pointer" : "default" }}
      />
      {(Object.keys(POS) as NodeId[]).map((id) => {
        const node = model.nodes[id];
        return (
          <button
            key={id}
            className={`sys-node ${id === "sink" ? (model.patched ? "safe" : "risk") : ""} ${hoverNode === id ? "hover" : ""}`}
            style={{ left: `${POS[id][0] * 100}%`, top: `${POS[id][1] * 100}%` }}
            onMouseEnter={() => setHoverNode(id)}
            onMouseLeave={() => setHoverNode(null)}
            onClick={() => onInspect(id)}
          >
            <span className="sys-ic">
              <i className={`fa-solid ${node.icon}`} />
            </span>
            <span className="sys-label">
              <b>{node.title}</b>
              <em>{node.sub}</em>
            </span>
          </button>
        );
      })}

      <div className="sys-banner">
        {model.stage === "idle" && <span className="dim">Run VAYU to map the system this code runs in.</span>}
        {model.stage === "scan" && <span>Tracing how untrusted input flows toward the flagged call…</span>}
        {model.stage === "reason" && !model.patched && (
          <span>
            <i className="fa-solid fa-triangle-exclamation hot" /> Untrusted input can reach <b>{model.sinkName}</b> → {model.downstream.title.toLowerCase()}. Risk path is open.
          </span>
        )}
        {model.stage === "patched" && (
          <span>
            <i className="fa-solid fa-shield-halved ok" /> Verified patch closes the risk path — untrusted input no longer reaches the {model.downstream.title.toLowerCase()}.
          </span>
        )}
        {model.stage === "rejected" && (
          <span>
            <i className="fa-solid fa-xmark bad" /> Patch rejected — the risk path stays open until a fix passes all checks.
          </span>
        )}
      </div>

      <div className="sys-hint">Click any node for details</div>
    </div>
  );
}
