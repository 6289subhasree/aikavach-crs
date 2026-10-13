"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import { initialRun, relativeFile, runReducer, shortPath } from "./runReducer";
import Terrain from "./Terrain";
import type { EngineEvent, HistoryEntry, Mode, RunState, StageName, Status } from "./types";
import { CHECKS, STAGES } from "./types";

const HISTORY_KEY = "vayu.history.v1";
const PACED = new Set(["stage", "findings", "reasoning", "patch", "check", "verification", "done"]);
type Drawer = null | "diff" | "proof" | "log";
type PinMode = "all" | "findings" | "none";

const MODE_LABEL: Record<Mode, string> = { auto: "Auto", ollama: "Ollama", offline: "Offline rules" };

export default function Dashboard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [target, setTarget] = useState("");
  const [customPath, setCustomPath] = useState("");
  const [mode, setMode] = useState<Mode>("auto");
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [pins, setPins] = useState<PinMode>("all");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [hasReplay, setHasReplay] = useState(false);
  const [hotspot, setHotspot] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [run, dispatch] = useReducer(runReducer, initialRun());
  const abortRef = useRef<AbortController | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const loadStatus = useCallback(async () => {
    try {
      const body = (await fetch("/api/status", { cache: "no-store" }).then((r) => r.json())) as Status;
      setStatus(body);
      setHasReplay(!!body.replay);
      setTarget((current) => current || body.targets[0]?.path || "");
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      await loadStatus();
      let saved: HistoryEntry[] = [];
      try {
        saved = JSON.parse(window.localStorage.getItem(HISTORY_KEY) ?? "[]");
      } catch {
        /* storage unavailable */
      }
      if (!cancelled) setHistory(saved);
    };
    void init();
    return () => {
      cancelled = true;
    };
  }, [loadStatus]);

  const recorded = useRef<string | null>(null);
  useEffect(() => {
    if ((run.phase !== "done" && run.phase !== "error") || run.replay) return;
    const id = String(run.artifacts?.provenance?.run_id ?? `${run.target}-${run.clock}`);
    if (recorded.current === id) return;
    recorded.current = id;
    const entry: HistoryEntry = {
      id,
      target: run.targetInfo?.name ?? shortPath(run.target),
      decision: run.decision ?? "ERROR",
      provider: run.provider ?? "—",
      elapsed: run.elapsed,
      when: new Date().toISOString(),
    };
    setHistory((prev) => {
      const next = [entry, ...prev].slice(0, 12);
      try {
        window.localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  }, [run.phase, run.replay, run.artifacts, run.target, run.clock, run.targetInfo, run.decision, run.provider, run.elapsed]);

  const activeTarget = customPath.trim() || target;
  const running = run.phase === "running";

  const start = useCallback(async () => {
    if (!activeTarget) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    recorded.current = null;
    dispatch({ kind: "start", target: activeTarget, replay: false });
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: activeTarget, mode }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        dispatch({ kind: "fail", message: body.error ?? "Run could not start" });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let lastShown = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const raw = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!raw) continue;
          let event: EngineEvent;
          try {
            event = JSON.parse(raw) as EngineEvent;
          } catch {
            event = { type: "log", t: 0, data: { message: raw } };
          }
          // Pace on-screen updates so fast runs stay readable; timings shown are the engine's own.
          const wait = lastShown + (PACED.has(event.type) ? 420 : 40) - performance.now();
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
          if (controller.signal.aborted) return;
          lastShown = performance.now();
          dispatch({ kind: "event", event });
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") dispatch({ kind: "fail", message: `Lost connection to the engine: ${(err as Error).message}` });
    }
  }, [activeTarget, mode]);

  const replay = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const text = await fetch("/replay.ndjson").then((r) => r.text());
    const events = text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as EngineEvent);
    dispatch({ kind: "start", target: "recorded run", replay: true });
    for (const event of events) {
      await new Promise((r) => setTimeout(r, PACED.has(event.type) ? 420 : 40));
      if (controller.signal.aborted) return;
      dispatch({ kind: "event", event });
    }
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    dispatch({ kind: "fail", message: "Run stopped" });
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    dispatch({ kind: "reset" });
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  const finding = run.findings[0] ?? null;
  const hotFile = relativeFile(finding?.file, run.targetInfo?.path);
  const hotLine = finding?.line_start ?? null;

  const downloadProvenance = () => {
    if (run.artifacts?.provenance) download("vayu-provenance.json", run.artifacts.provenance);
  };

  return (
    <div className="dash">
      <div className="shell">
        {/* ---------------- top bar ---------------- */}
        <header className="top">
          <Link href="/" className="logo">
            vayu<span>&gt;</span>
          </Link>
          <div className="filters">
            <Filter label="Target">
              <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={running || !!customPath}>
                {(status?.targets ?? []).map((t) => (
                  <option key={t.path} value={t.path}>
                    {t.id}
                  </option>
                ))}
                {!status?.targets.length && <option value="">none</option>}
              </select>
            </Filter>
            <Filter label="Engine">
              <select value={mode} onChange={(e) => setMode(e.target.value as Mode)} disabled={running}>
                {(Object.keys(MODE_LABEL) as Mode[]).map((m) => (
                  <option key={m} value={m}>
                    {MODE_LABEL[m]}
                  </option>
                ))}
              </select>
            </Filter>
            <Filter label="Model" readOnly>
              <span className="filter-value">{mode === "offline" ? "none" : status?.ollama.model ?? "qwen2.5-coder:3b"}</span>
            </Filter>
            <Filter label="Tools" readOnly>
              <span className="filter-value tools">
                <Dot ok={status?.engine.ok} title="Python engine" />
                <Dot ok={status?.semgrep.ok} title={status?.semgrep.version ?? "Semgrep not found"} />
                <Dot ok={status ? status.ollama.ok && status.ollama.modelInstalled : undefined} title={status?.ollama.ok ? "Ollama" : "Ollama offline"} />
              </span>
            </Filter>
          </div>
          <div className="top-right">
            <label className="search">
              <input
                ref={searchRef}
                value={customPath}
                onChange={(e) => setCustomPath(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !running && start()}
                placeholder="Scan a local path"
                disabled={running}
                aria-label="Local repository path"
              />
              <i className="fa-solid fa-magnifying-glass" />
            </label>
            <button className="icon-btn" onClick={loadStatus} aria-label="Recheck tools" title="Recheck tools">
              <i className="fa-solid fa-gear" />
            </button>
          </div>
        </header>

        {/* ---------------- main stage ---------------- */}
        <section className="stage">
          <aside className="left">
            <div className="heading">
              <Link href="/" className="icon-btn" aria-label="Back">
                <i className="fa-solid fa-arrow-left" />
              </Link>
              <div>
                <h1>
                  Codebase
                  <br />
                  Analysis
                </h1>
                <p>
                  {run.repoMap
                    ? `Data based on ${run.repoMap.total_lines.toLocaleString()} lines in ${run.repoMap.files.length} file${run.repoMap.files.length === 1 ? "" : "s"}`
                    : "No target scanned yet"}
                </p>
              </div>
            </div>

            <Intensity run={run} hotFile={hotFile} />
            <Nesting run={run} hotFile={hotFile} />

            <div className="left-controls">
              <Filter label="" compact>
                <select value={pins} onChange={(e) => setPins(e.target.value as PinMode)} aria-label="Pins">
                  <option value="all">All pins</option>
                  <option value="findings">Findings only</option>
                  <option value="none">No pins</option>
                </select>
              </Filter>
              <Filter label="" compact>
                <select value="" onChange={(e) => e.target.value && setDrawer(e.target.value as Drawer)} aria-label="Open panel">
                  <option value="">Last run</option>
                  <option value="diff">Code &amp; diff</option>
                  <option value="proof">Provenance</option>
                  <option value="log">Engine log</option>
                </select>
              </Filter>
              <button className="icon-btn sm" onClick={reset} disabled={running} aria-label="Reset" title="Reset">
                <i className="fa-solid fa-rotate-right" />
              </button>
              <button className="icon-btn sm" onClick={() => setDrawer("log")} aria-label="Engine log" title="Engine log">
                <i className="fa-solid fa-ellipsis" />
              </button>
              <button className="icon-btn sm" onClick={downloadProvenance} disabled={!run.artifacts} aria-label="Export provenance" title="Export provenance">
                <i className="fa-solid fa-arrow-up-from-bracket" />
              </button>
            </div>
          </aside>

          <div className="map">
            <Terrain run={run} hotFile={hotFile} hotLine={hotLine} showPins={pins !== "none"} onHotspot={setHotspot} />
            {pins === "findings" && <style>{`.terrain .pin:not(.pin-main){display:none}`}</style>}

            <StatusPill run={run} />
            {hotspot && finding && <Callout run={run} at={hotspot} hotFile={hotFile} hotLine={hotLine} onOpen={setDrawer} />}

            <div className="toolbar">
              <button className="icon-btn" onClick={reset} disabled={running} aria-label="Reset" title="Reset">
                <i className="fa-solid fa-rotate-left" />
              </button>
              {running ? (
                <button className="icon-btn on" onClick={stop} aria-label="Stop" title="Stop">
                  <i className="fa-solid fa-stop" />
                </button>
              ) : (
                <button className="icon-btn on" onClick={start} disabled={!activeTarget || status?.engine.ok === false} aria-label="Run VAYU" title="Run">
                  <i className="fa-solid fa-play" />
                </button>
              )}
              {STAGES.map((s) => (
                <span key={s} className={`stage-dot ${run.stages[s].status}`} title={`${s} · ${run.stages[s].status}`}>
                  <i className={`fa-solid ${STAGE_ICON[s]}`} />
                </span>
              ))}
              {hasReplay && (
                <button className="icon-btn" onClick={replay} disabled={running} aria-label="Replay recorded run" title="Replay recorded run">
                  <i className="fa-solid fa-clock-rotate-left" />
                </button>
              )}
              <span className="toolbar-mode">
                {run.provider ? (run.provider === "ollama" ? "ollama" : "offline") : MODE_LABEL[mode].toLowerCase()}
              </span>
            </div>
          </div>

          <aside className="right">
            <div className="tabs" role="tablist">
              {(
                [
                  [null, "View"],
                  ["diff", "Diff"],
                  ["proof", "Provenance"],
                ] as [Drawer, string][]
              ).map(([key, label]) => (
                <button key={label} role="tab" aria-selected={drawer === key} className={drawer === key ? "on" : ""} onClick={() => setDrawer(key)}>
                  {label}
                </button>
              ))}
            </div>

            <Gauge label="Model Confidence" value={run.reasoning ? Math.round(run.reasoning.confidence * 100) : null} max={100} />
            <Gauge
              label="Checks Passed"
              value={Object.keys(run.checks).length || run.stages.VERIFY.status !== "idle" ? Object.values(run.checks).filter((c) => c?.passed).length : null}
              max={4}
              bad={Object.values(run.checks).some((c) => c && !c.passed)}
            />

            <div className="right-foot">
              <button className="icon-btn sm" onClick={() => searchRef.current?.focus()} aria-label="Scan another path" title="Scan another path">
                <i className="fa-solid fa-plus" />
              </button>
              <button className="chip-btn" onClick={() => setPins(pins === "none" ? "all" : "none")} title="Toggle pins">
                Findings {run.findings.length}
                <i className={`fa-solid ${pins === "none" ? "fa-eye" : "fa-xmark"}`} />
              </button>
            </div>
          </aside>

          {drawer && <DrawerPanel kind={drawer} run={run} history={history} onClose={() => setDrawer(null)} onSwitch={setDrawer} />}
        </section>

        {/* ---------------- lower band ---------------- */}
        <section className="lower">
          <StageBlocks run={run} hotFile={hotFile} onRun={start} onReset={reset} onExport={downloadProvenance} canRun={!running && !!activeTarget} />
          <Checks run={run} onHistory={() => setDrawer("proof")} onExport={downloadProvenance} />
        </section>
      </div>
    </div>
  );
}

const STAGE_ICON: Record<StageName, string> = {
  FIND: "fa-magnifying-glass",
  REASON: "fa-diagram-project",
  PATCH: "fa-code",
  VERIFY: "fa-shield-halved",
};

/* ---------------- small building blocks ---------------- */

function Filter({ label, children, readOnly, compact }: { label: string; children: React.ReactNode; readOnly?: boolean; compact?: boolean }) {
  return (
    <label className={`filter ${compact ? "compact" : ""}`}>
      {label && <span className="filter-label">{label}</span>}
      <span className="filter-box">
        {children}
        {!readOnly && <i className="fa-solid fa-chevron-down" />}
      </span>
    </label>
  );
}

function Dot({ ok, title }: { ok: boolean | undefined; title: string }) {
  return <i className={`tool ${ok === undefined ? "" : ok ? "ok" : "bad"}`} title={title} />;
}

function download(name: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

function StatusPill({ run }: { run: RunState }) {
  const active = STAGES.find((s) => run.stages[s].status === "running");
  let text = "Idle";
  let tone = "";
  if (run.phase === "running") text = active ? `${cap(active)}ing` : "Starting";
  if (run.phase === "done") {
    text = run.decision === "CLEAN" ? "No findings" : cap(run.decision ?? "done");
    tone = run.decision === "REJECTED" ? "bad" : "ok";
  }
  if (run.phase === "error") {
    text = `${cap(run.error?.stage ?? "run")} failed`;
    tone = "bad";
  }
  return (
    <div className={`status ${tone}`}>
      <i className={run.phase === "running" ? "live" : ""} />
      {text}
      {run.elapsed !== null && <span>{run.elapsed}s</span>}
      {run.replay && <span>replay</span>}
      {run.phase === "error" && run.error && <em title={run.error.message}>{run.error.message}</em>}
    </div>
  );
}

function cap(s: string) {
  const v = s.toLowerCase();
  if (v === "find") return "Scan";
  return v.charAt(0).toUpperCase() + v.slice(1);
}

function Callout({
  run,
  at,
  hotFile,
  hotLine,
  onOpen,
}: {
  run: RunState;
  at: { x: number; y: number; w: number; h: number };
  hotFile: string | null;
  hotLine: number | null;
  onOpen: (d: Drawer) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const finding = run.findings[0];
  const r = run.reasoning;
  const v = run.verification;
  const rows: { id: string; icon: string; label: string; body: string | null }[] = [
    { id: "cause", icon: "fa-crosshairs", label: "Root cause", body: r?.root_cause ?? null },
    { id: "impact", icon: "fa-bolt", label: "Impact", body: r?.security_impact ?? null },
    { id: "fix", icon: "fa-wrench", label: run.patch ? "Patch" : "Remediation", body: r?.remediation_strategy ?? null },
    { id: "verify", icon: "fa-shield-halved", label: v ? (v.approved ? "Verified" : "Rejected") : "Verification", body: v?.reason ?? null },
  ].filter((row) => row.body);

  const flip = at.x > at.w - 370;
  const up = at.y > at.h * 0.52;
  const verified = run.decision === "VERIFIED";
  return (
    <div className={`callout ${flip ? "flip" : ""} ${up ? "up" : ""}`} style={{ left: at.x, top: at.y }}>
      <div className="callout-head">
        <span className="callout-main">
          <i className={`fa-solid ${verified ? "fa-shield-halved ok" : "fa-triangle-exclamation hot"}`} />
          <span className="callout-text" title={`${hotFile}:${hotLine}`}>
            {kind(finding?.vulnerability_type)} in {hotFile?.split("/").pop()}:{hotLine}
          </span>
          <i className="fa-solid fa-chevron-up dim" />
        </span>
        <button className="icon-btn sm" onClick={() => onOpen("diff")} aria-label="Open code and diff" title="Code & diff">
          <i className="fa-solid fa-sliders" />
        </button>
        <button className="icon-btn sm" onClick={() => onOpen("log")} aria-label="Open engine log" title="Engine log">
          <i className="fa-solid fa-magnifying-glass" />
        </button>
      </div>
      {rows.map((row) => (
        <div key={row.id} className={`callout-row ${open === row.id ? "open" : ""}`}>
          <button onClick={() => setOpen(open === row.id ? null : row.id)} aria-expanded={open === row.id}>
            <span className="avatar">
              <i className={`fa-solid ${row.icon}`} />
            </span>
            {row.label}
            <i className="fa-solid fa-chevron-down dim" />
          </button>
          {open === row.id && <p>{row.body}</p>}
        </div>
      ))}
    </div>
  );
}

function kind(type: string | undefined) {
  if (!type) return "Finding";
  if (/shell/i.test(type)) return "Command injection";
  return type;
}

/* ---------------- left charts ---------------- */

function Intensity({ run, hotFile }: { run: RunState; hotFile: string | null }) {
  const map = run.repoMap;
  const single = map?.files.length === 1 ? map.files[0] : null;
  const values = single ? single.lines : map ? map.files.map((f) => f.line_count) : [];
  const shown = values.slice(0, 90);
  const hot = single ? (run.findings[0]?.line_start ?? 0) - 1 : map ? map.files.findIndex((f) => f.path === hotFile) : -1;
  const max = Math.max(1, ...shown);
  const peak = shown.indexOf(max);
  const W = 210;
  const H = 70;
  const n = Math.max(shown.length, 1);
  const x = (i: number) => 4 + (i / Math.max(n - 1, 1)) * (W - 8);
  const markers = shown.length ? [hot >= 0 && hot < shown.length ? hot : -1, peak].filter((v, i, a) => v >= 0 && a.indexOf(v) === i) : [];

  return (
    <div className="chart">
      <h3>{single ? "Code Intensity by Line" : "Code Intensity by File"}</h3>
      <svg viewBox={`0 0 ${W} ${H + 28}`} className="chart-svg" aria-hidden="true">
        <line x1="0" x2={W} y1={H} y2={H} className="base" />
        {shown.length
          ? shown.map((v, i) => {
              const h = 4 + (v / max) * (H - 10);
              return (
                <g key={i}>
                  <line x1={x(i)} x2={x(i)} y1={H} y2={H - h} className={i === hot ? "bar hot" : "bar"} />
                  {(i === hot || i === peak || i % 7 === 0) && <circle cx={x(i)} cy={H - h} r={i === hot ? 2 : 1.3} className={i === hot ? "cap hot" : "cap"} />}
                </g>
              );
            })
          : Array.from({ length: 60 }, (_, i) => <line key={i} x1={x(i * 1.5)} x2={x(i * 1.5)} y1={H} y2={H - 3 - ((i * 37) % 11)} className="bar ghost" />)}
        {markers.map((m) => (
          <g key={m}>
            <line x1={x(m)} x2={x(m)} y1={H} y2={H + 9} className="tick" />
            <text x={x(m)} y={H + 22} textAnchor="middle" className={m === hot ? "label hot" : "label"}>
              {shown[m]}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

function Nesting({ run, hotFile }: { run: RunState; hotFile: string | null }) {
  const map = run.repoMap;
  const items = useMemo(() => {
    if (!map) return [] as { v: number; hot: boolean }[];
    if (map.files.length === 1) {
      const f = map.files[0];
      const chunk = Math.max(1, Math.ceil(f.lines.length / 14));
      const hotLine = (run.findings[0]?.line_start ?? 0) - 1;
      const out: { v: number; hot: boolean }[] = [];
      for (let i = 0; i < f.lines.length; i += chunk) {
        const idx = f.indent.slice(i, i + chunk).filter((_, k) => f.lines[i + k] > 0);
        out.push({ v: idx.length ? Math.max(...idx) : 0, hot: hotLine >= i && hotLine < i + chunk });
      }
      return out;
    }
    return map.files.slice(0, 16).map((f) => {
      const idx = f.indent.filter((_, k) => f.lines[k] > 0);
      return { v: idx.length ? Math.max(...idx) : 0, hot: f.path === hotFile };
    });
  }, [map, hotFile, run.findings]);

  const W = 210;
  const H = 46;
  const max = Math.max(4, ...items.map((i) => i.v));
  const n = items.length || 14;
  const step = (W - 16) / n;
  const hotIdx = items.findIndex((i) => i.hot);
  const markIdx = hotIdx >= 0 ? hotIdx : items.length ? items.map((i) => i.v).indexOf(max) : -1;
  const mx = markIdx >= 0 ? 8 + step * (markIdx + 0.5) : W / 2;

  return (
    <div className="chart nesting">
      <h3>Nesting Depth</h3>
      <svg viewBox={`0 0 ${W} ${H + 46}`} className="chart-svg" aria-hidden="true">
        {markIdx >= 0 && (
          <>
            <text x={mx} y="10" textAnchor="middle" className={hotIdx >= 0 ? "label hot" : "label"}>
              {items[markIdx].v}
            </text>
            <line x1={mx} x2={mx} y1="16" y2={H + 30} className="marker" />
            <circle cx={mx} cy={H + 30} r="2" className="cap" />
          </>
        )}
        <line x1="0" x2={W} y1={H + 18} y2={H + 18} className="base dotted" />
        {(items.length ? items : Array.from({ length: 14 }, (_, i) => ({ v: (i * 5) % 9, hot: false }))).map((it, i) => {
          const cx = 8 + step * (i + 0.5);
          const h = 4 + (it.v / max) * (H - 8);
          return (
            <polygon
              key={i}
              points={`${cx - step * 0.32},${H + 18} ${cx},${H + 18 - h} ${cx + step * 0.32},${H + 18}`}
              className={!items.length ? "tri ghost" : it.hot ? "tri hot" : "tri"}
            />
          );
        })}
        <text x="2" y={H + 42} className="label">
          {items.length ? Math.min(...items.map((i) => i.v)) : ""}
        </text>
        <text x={W - 2} y={H + 42} textAnchor="end" className="label">
          {items.length ? max : ""}
        </text>
      </svg>
    </div>
  );
}

/* ---------------- right gauges ---------------- */

function Gauge({ label, value, max, bad }: { label: string; value: number | null; max: number; bad?: boolean }) {
  const r = 30;
  const c = 2 * Math.PI * r;
  const f = value === null ? 0 : Math.max(0, Math.min(1, value / max));
  const a = ((-90 + f * 360) * Math.PI) / 180;
  const id = label.replace(/\W/g, "");
  return (
    <div className={`gauge ${bad ? "bad" : ""}`}>
      <svg viewBox="0 0 80 80" aria-hidden="true">
        <defs>
          <linearGradient id={`gg-${id}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#c9b8f2" />
            <stop offset="1" stopColor={bad ? "#ff6a4d" : "#f0a27a"} />
          </linearGradient>
        </defs>
        <circle cx="40" cy="40" r={r} className="track" />
        <circle cx="40" cy="40" r={r} className="arc" stroke={`url(#gg-${id})`} strokeDasharray={`${c * f} ${c}`} transform="rotate(-90 40 40)" />
        <line x1="40" y1="40" x2={40 + Math.cos(a) * (r + 6)} y2={40 + Math.sin(a) * (r + 6)} className="needle" />
        <circle cx="40" cy="40" r="1.6" className="hub" />
      </svg>
      <span className="gauge-label">{label}</span>
      <span className="gauge-value">
        {value ?? "—"}
        <small> / {max}</small>
      </span>
    </div>
  );
}

/* ---------------- lower band ---------------- */

function StageBlocks({
  run,
  hotFile,
  onRun,
  onReset,
  onExport,
  canRun,
}: {
  run: RunState;
  hotFile: string | null;
  onRun: () => void;
  onReset: () => void;
  onExport: () => void;
  canRun: boolean;
}) {
  const COLS = 36;
  const first = 5;
  const last = 30;
  const span = Math.max(run.clock, 0.001);
  const col = (t: number) => Math.round(first + (t / span) * (last - first));
  const started = STAGES.some((s) => run.stages[s].start !== undefined);
  const finding = run.findings[0];

  return (
    <div className="blocks">
      <div className="band-head">
        <h3>Pipeline by Stage</h3>
        <button className="icon-btn sm" onClick={onRun} disabled={!canRun} aria-label="Run" title="Run">
          <i className="fa-solid fa-arrow-up" />
        </button>
      </div>
      <div className="blocks-body">
        <div className="row-labels">
          {STAGES.map((s) => (
            <span key={s}>{s.charAt(0) + s.slice(1).toLowerCase()}</span>
          ))}
        </div>
        <div className="dotfield" style={{ "--cols": COLS } as React.CSSProperties}>
          {STAGES.map((s, row) => (
            <div key={s} className="dotrow">
              {Array.from({ length: COLS }, (_, i) => {
                const st = run.stages[s];
                const lit = st.start !== undefined && i >= col(st.start) && i <= col(st.end ?? run.clock);
                return <i key={i} className={lit ? `lit ${st.status}` : row % 2 ? "alt" : ""} />;
              })}
              {run.stages[s].status !== "idle" && (
                <span className="pin" style={{ left: `${((col(run.stages[s].end ?? run.clock) + 0.5) / COLS) * 100}%` }}>
                  <i
                    className={`fa-solid ${
                      run.stages[s].status === "failed"
                        ? "fa-xmark bad"
                        : s === "FIND" && finding
                          ? "fa-triangle-exclamation hot"
                          : run.stages[s].status === "running"
                            ? "fa-circle-notch fa-spin"
                            : "fa-shield-halved ok"
                    }`}
                  />
                </span>
              )}
            </div>
          ))}
          {started && (
            <div className="selection" style={{ left: `${(first / COLS) * 100}%`, width: `${((last - first + 1) / COLS) * 100}%` }}>
              <i className="corner tl" />
              <i className="corner tr" />
              <i className="corner bl" />
              <i className="corner br" />
            </div>
          )}
          <div className="cluster">
            <div className="cluster-btns">
              <button className="icon-btn sm" onClick={onReset} aria-label="Reset" title="Reset">
                <i className="fa-solid fa-rotate-right" />
              </button>
              <button className="icon-btn on" onClick={onRun} disabled={!canRun} aria-label="Run" title="Run">
                <i className="fa-solid fa-play" />
              </button>
              <button className="icon-btn sm" onClick={onExport} disabled={!run.artifacts} aria-label="Export" title="Export provenance">
                <i className="fa-solid fa-arrow-up-from-bracket" />
              </button>
            </div>
            <span className="cluster-pill">
              {finding ? (
                <>
                  <i className={`fa-solid ${run.decision === "VERIFIED" ? "fa-shield-halved ok" : "fa-triangle-exclamation hot"}`} />
                  {kind(finding.vulnerability_type)} in {shortPath(hotFile)}
                </>
              ) : run.decision === "CLEAN" ? (
                <>
                  <i className="fa-solid fa-shield-halved ok" />
                  No findings
                </>
              ) : (
                <>
                  <i className="fa-solid fa-circle-dot dim" />
                  {run.phase === "running" ? "Scanning" : "Ready to scan"}
                </>
              )}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Checks({ run, onHistory, onExport }: { run: RunState; onHistory: () => void; onExport: () => void }) {
  const verifyStart = run.stages.VERIFY.start ?? 0;
  const timings = CHECKS.map((c, i) => {
    const st = run.checks[c.id];
    if (!st) return null;
    const before = i > 0 ? run.checks[CHECKS[i - 1].id]?.at : undefined;
    return Math.max(0, st.at - (before ?? verifyStart));
  });
  return (
    <div className="checks">
      <div className="band-head">
        <h3>Verification by Check</h3>
        <div className="band-actions">
          <button className="icon-btn sm" onClick={onHistory} aria-label="Run history" title="Run history">
            <i className="fa-regular fa-calendar" />
          </button>
          <button className="icon-btn sm" onClick={onExport} disabled={!run.artifacts} aria-label="Export" title="Export provenance">
            <i className="fa-solid fa-arrow-up" />
          </button>
        </div>
      </div>
      <div className="cols">
        {CHECKS.map((c, i) => {
          const st = run.checks[c.id];
          const pending = run.stages.VERIFY.status === "running" && !st;
          return (
            <div key={c.id} className={`col ${st ? (st.passed ? "pass" : "fail") : pending ? "pending" : ""}`} title={st?.reason}>
              <div className="col-head">
                <i className={`fa-solid ${st ? (st.passed ? "fa-shield-halved ok" : "fa-triangle-exclamation bad") : c.icon}`} />
                {c.label}
              </div>
              <div className="col-foot">
                <span>{c.hint}</span>
                <b>
                  {st ? (st.passed ? "Pass" : "Fail") : pending ? "…" : "—"}
                  {timings[i] !== null && <small> / {(timings[i] as number).toFixed(2)}s</small>}
                </b>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- drawer ---------------- */

function DrawerPanel({
  kind: k,
  run,
  history,
  onClose,
  onSwitch,
}: {
  kind: Exclude<Drawer, null>;
  run: RunState;
  history: HistoryEntry[];
  onClose: () => void;
  onSwitch: (d: Drawer) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const title = k === "diff" ? "Code & diff" : k === "proof" ? "Provenance" : "Engine log";
  return (
    <div className="drawer" role="dialog" aria-label={title}>
      <div className="drawer-head">
        <div className="drawer-tabs">
          {(["diff", "proof", "log"] as const).map((d) => (
            <button key={d} className={d === k ? "on" : ""} onClick={() => onSwitch(d)}>
              {d === "diff" ? "Code & diff" : d === "proof" ? "Provenance" : "Log"}
            </button>
          ))}
        </div>
        <button className="icon-btn sm" onClick={onClose} aria-label="Close">
          <i className="fa-solid fa-xmark" />
        </button>
      </div>
      <div className="drawer-body">
        {k === "diff" && <DiffPanel run={run} />}
        {k === "proof" && <ProofPanel run={run} history={history} />}
        {k === "log" && <LogPanel run={run} />}
      </div>
    </div>
  );
}

function DiffPanel({ run }: { run: RunState }) {
  const finding = run.findings[0];
  const rows = (run.evidence?.content ?? "").split("\n").map((line) => {
    const m = /^(\d+): ?(.*)$/.exec(line);
    return m ? { n: Number(m[1]), text: m[2] } : { n: 0, text: line };
  });
  return (
    <>
      <h4>Evidence {run.evidence && <span>{run.evidence.file}:{run.evidence.start_line}–{run.evidence.end_line}</span>}</h4>
      {run.evidence ? (
        <pre className="code">
          {rows.map((r) => (
            <div key={r.n} className={r.n === finding?.line_start ? "hot" : ""}>
              <span>{r.n}</span>
              <code>{r.text || " "}</code>
            </div>
          ))}
        </pre>
      ) : (
        <p className="none">No finding yet.</p>
      )}
      <h4>Patch {run.patch && <span>{run.patch.target_file}</span>}</h4>
      {run.patch ? (
        <pre className="code diff">
          {run.patch.unified_diff
            .split("\n")
            .filter(Boolean)
            .map((line, i) => (
              <div key={i} className={line.startsWith("@@") ? "hunk" : line.startsWith("+++") || line.startsWith("---") ? "meta" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : ""}>
                <code>{line}</code>
              </div>
            ))}
        </pre>
      ) : (
        <p className="none">No patch yet.</p>
      )}
      {finding && (
        <dl className="kv">
          <dt>Rule</dt>
          <dd>{finding.evidence[0]?.raw_reference}</dd>
          <dt>Severity</dt>
          <dd>{finding.severity}</dd>
          {run.reasoning && (
            <>
              <dt>Class</dt>
              <dd>{run.reasoning.vulnerability_class}</dd>
            </>
          )}
        </dl>
      )}
    </>
  );
}

function ProofPanel({ run, history }: { run: RunState; history: HistoryEntry[] }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- provenance is a free-form JSON record
  const p = run.artifacts?.provenance as Record<string, any> | undefined;
  return (
    <>
      <h4>This run</h4>
      {p ? (
        <>
          <dl className="kv">
            <dt>Decision</dt>
            <dd className={String(p.final_decision).toLowerCase()}>{p.final_decision}</dd>
            <dt>Run ID</dt>
            <dd>{p.run_id}</dd>
            <dt>Repo SHA-256</dt>
            <dd>{p.target?.repository_sha256}</dd>
            <dt>Patch SHA-256</dt>
            <dd>{p.patch?.patch_sha256}</dd>
            <dt>Reasoning</dt>
            <dd>
              {p.reasoning?.provider} / {p.reasoning?.model}
            </dd>
            <dt>Original repo</dt>
            <dd>{p.safety?.original_repository_modified ? "modified" : "untouched"}</dd>
          </dl>
          <div className="downloads">
            <button onClick={() => download("vayu-provenance.json", p)}>
              <i className="fa-solid fa-download" /> provenance.json
            </button>
            {run.artifacts?.sarif != null && (
              <button onClick={() => download("vayu.sarif", run.artifacts?.sarif)}>
                <i className="fa-solid fa-download" /> report.sarif
              </button>
            )}
            {run.artifacts?.slsa != null && (
              <button onClick={() => download("vayu-slsa.json", run.artifacts?.slsa)}>
                <i className="fa-solid fa-signature" /> slsa.json
              </button>
            )}
          </div>
        </>
      ) : (
        <p className="none">Written when a run completes.</p>
      )}
      <h4>Recent runs</h4>
      {history.length ? (
        <ul className="runs">
          {history.map((h) => (
            <li key={h.id}>
              <i className={h.decision.toLowerCase()} />
              <b>{h.target}</b>
              <span>{h.provider}</span>
              <span className={h.decision.toLowerCase()}>{h.decision.toLowerCase()}</span>
              <time>{new Date(h.when).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
            </li>
          ))}
        </ul>
      ) : (
        <p className="none">None yet.</p>
      )}
    </>
  );
}

function LogPanel({ run }: { run: RunState }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [run.log.length]);
  return (
    <div className="log" ref={ref} role="log" aria-live="polite">
      {run.log.length ? (
        run.log.map((l, i) => (
          <div key={i} className={l.level}>
            <span>{l.t.toFixed(2)}</span>
            <p>{l.text}</p>
          </div>
        ))
      ) : (
        <p className="none">Nothing yet.</p>
      )}
    </div>
  );
}
