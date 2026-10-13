"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import { initialRun, relativeFile, runReducer, shortPath } from "./runReducer";
import SystemField from "./SystemField";
import type { EngineEvent, HistoryEntry, Mode, RunState, StageName, Status } from "./types";
import { CHECKS, STAGES } from "./types";

const HISTORY_KEY = "vayu.history.v1";
const PACED = new Set(["stage", "findings", "reasoning", "patch", "check", "verification", "done"]);
type Tab = "live" | "patch" | "proof";

const MODE_LABEL: Record<Mode, string> = {
  auto: "Auto",
  ollama: "Ollama",
  offline: "Offline rules",
};

/* ------------------------------------------------------------------ */
/* Root                                                                 */
/* ------------------------------------------------------------------ */

export default function Dashboard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [target, setTarget] = useState("");
  const [customPath, setCustomPath] = useState("");
  const [mode, setMode] = useState<Mode>("auto");
  const [tab, setTab] = useState<Tab>("live");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [hasReplay, setHasReplay] = useState(false);
  const [run, dispatch] = useReducer(runReducer, initialRun());
  const abortRef = useRef<AbortController | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/status", { cache: "no-store" });
      const body = (await res.json()) as Status;
      setStatus(body);
      setHasReplay(!!body.replay);
      setStatusError(false);
      setTarget((current) => current || body.targets[0]?.path || "");
    } catch {
      setStatusError(true);
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
      if (cancelled) return;
      setHistory(saved);
    };
    void init();
    return () => {
      cancelled = true;
    };
  }, [loadStatus]);

  // Record finished runs in local history.
  const recorded = useRef<string | null>(null);
  useEffect(() => {
    if (run.phase !== "done" && run.phase !== "error") return;
    const id = String(run.artifacts?.provenance?.run_id ?? `${run.target}-${run.clock}-${run.log.length}`);
    if (recorded.current === id || run.replay) return;
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
  }, [run.phase, run.artifacts, run.target, run.clock, run.log.length, run.decision, run.provider, run.elapsed, run.targetInfo, run.replay]);

  const activeTarget = customPath.trim() || target;

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
          try {
            const event = JSON.parse(raw) as EngineEvent;
            // Pace on-screen updates so fast runs stay readable; timings shown are the engine's own.
            const gap = PACED.has(event.type) ? 420 : 40;
            const wait = lastShown + gap - performance.now();
            if (wait > 0) await new Promise((r) => setTimeout(r, wait));
            if (controller.signal.aborted) return;
            lastShown = performance.now();
            dispatch({ kind: "event", event });
          } catch {
            dispatch({ kind: "event", event: { type: "log", t: 0, data: { message: raw } } });
          }
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
    const events = text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as EngineEvent);
    dispatch({ kind: "start", target: "recorded run", replay: true });
    let last = 0;
    for (const event of events) {
      if (controller.signal.aborted) return;
      const wait = Math.min(1400, Math.max(140, (event.t - last) * 1000));
      last = event.t;
      await new Promise((r) => setTimeout(r, wait));
      if (controller.signal.aborted) return;
      dispatch({ kind: "event", event });
    }
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    dispatch({ kind: "fail", message: "Run stopped from the dashboard" });
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    dispatch({ kind: "reset" });
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  const finding = run.findings[0] ?? null;
  const hotFile = relativeFile(finding?.file, run.targetInfo?.path);
  const running = run.phase === "running";

  return (
    <div className="dash">
      <div className="dash-bg" aria-hidden="true">
        <video className="dash-video" autoPlay muted loop playsInline>
          <source
            src="https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260809_012548_ef22562c-c0ae-4816-ad9d-f8922af4e6a7.mp4"
            type="video/mp4"
          />
        </video>
        <div className="dash-veil" />
        <div className="dash-grain" />
      </div>

      <div className="dash-frame">
        <TopBar
          status={status}
          statusError={statusError}
          target={target}
          setTarget={setTarget}
          customPath={customPath}
          setCustomPath={setCustomPath}
          mode={mode}
          setMode={setMode}
          disabled={running}
          onRefresh={loadStatus}
        />

        <section className="hero-grid">
          <aside className="side">
            <div className="title-row">
              <Link href="/" className="round-btn" aria-label="Back to home">
                <i className="fa-solid fa-arrow-left" />
              </Link>
              <div>
                <h1 className="display title">
                  System
                  <br />
                  Reasoning
                </h1>
                <p className="sub">
                  {run.repoMap
                    ? `Data based on ${run.repoMap.total_lines.toLocaleString()} lines · ${run.repoMap.files.length} file${run.repoMap.files.length === 1 ? "" : "s"}`
                    : "Find → Reason → Patch → Verify"}
                </p>
              </div>
            </div>

            <CodeDensity run={run} hotFile={hotFile} />
            <StageSpikes run={run} />
          </aside>

          <div className="center">
            <SystemField run={run} hotFile={hotFile} hotLine={finding?.line_start ?? null} />
            {run.decision && <Verdict decision={run.decision} elapsed={run.elapsed} />}
            {run.phase === "error" && run.error && (
              <div className="field-error" role="alert">
                <i className="fa-solid fa-circle-exclamation" />
                <div>
                  <strong>{run.error.stage} stopped</strong>
                  <span>{run.error.message}</span>
                  {/semgrep/i.test(run.error.message) && <code>pip install semgrep</code>}
                </div>
              </div>
            )}
            <Toolbar
              run={run}
              canRun={!!activeTarget && !running && (status?.engine.ok ?? true)}
              hasReplay={hasReplay}
              onRun={start}
              onStop={stop}
              onReplay={replay}
              onReset={reset}
            />
          </div>

          <aside className="gauges">
            <div className="view-pills" role="tablist" aria-label="Detail view">
              {(["live", "patch", "proof"] as Tab[]).map((t) => (
                <button key={t} role="tab" aria-selected={tab === t} className={`pill ${tab === t ? "on" : ""}`} onClick={() => setTab(t)}>
                  {t === "live" ? "Live" : t === "patch" ? "Patch" : "Proof"}
                </button>
              ))}
            </div>
            <Ring
              label="AI Confidence"
              value={run.reasoning ? Math.round(run.reasoning.confidence * 100) : null}
              max={100}
              suffix="%"
              note="not proof"
            />
            <Ring
              label="Checks Passed"
              value={Object.keys(run.checks).length || run.stages.VERIFY.status !== "idle" ? Object.values(run.checks).filter((c) => c?.passed).length : null}
              max={4}
              suffix="/4"
              note={run.attempt > 1 ? `attempt ${run.attempt}` : undefined}
              danger={Object.values(run.checks).some((c) => c && !c.passed)}
            />
          </aside>
        </section>

        <section className="low-grid">
          <StageGrid run={run} />
          <CheckTiles run={run} />
        </section>

        <section className="details">
          {tab === "live" && <LiveView run={run} hotLine={finding?.line_start ?? null} />}
          {tab === "patch" && <PatchView run={run} />}
          {tab === "proof" && <ProofView run={run} history={history} />}
        </section>

        <footer className="dash-foot">
          <span>VAYU · AIKavach CRS</span>
          <span>Runs locally · the model proposes, verification decides · original repository is never modified</span>
        </footer>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Top bar                                                              */
/* ------------------------------------------------------------------ */

function TopBar(props: {
  status: Status | null;
  statusError: boolean;
  target: string;
  setTarget: (v: string) => void;
  customPath: string;
  setCustomPath: (v: string) => void;
  mode: Mode;
  setMode: (m: Mode) => void;
  disabled: boolean;
  onRefresh: () => void;
}) {
  const { status } = props;
  const chips: { label: string; ok: boolean | null; title: string }[] = [
    { label: "Engine", ok: status ? status.engine.ok : props.statusError ? false : null, title: status?.engine.ok ? `Python ${status.engine.version}` : "python -m crs.stream not importable" },
    { label: "Semgrep", ok: status ? status.semgrep.ok : null, title: status?.semgrep.version ?? "Install with: pip install semgrep" },
    {
      label: "Ollama",
      ok: status ? status.ollama.ok && status.ollama.modelInstalled : null,
      title: status?.ollama.ok ? (status.ollama.modelInstalled ? status.ollama.model : `${status.ollama.model} not pulled`) : "Not running — Auto mode falls back to offline rules",
    },
  ];

  return (
    <header className="topbar">
      <Link href="/" className="brand display">
        VAYU<span>&gt;</span>
      </Link>

      <div className="filters">
        <label className="pill-select">
          <span>Target</span>
          <select value={props.target} onChange={(e) => props.setTarget(e.target.value)} disabled={props.disabled || !!props.customPath}>
            {(status?.targets ?? []).map((t) => (
              <option key={t.path} value={t.path}>
                {t.label}
              </option>
            ))}
            {!status?.targets.length && <option value="">No samples</option>}
          </select>
          <i className="fa-solid fa-chevron-down" />
        </label>
        <label className="pill-select">
          <span>Engine</span>
          <select value={props.mode} onChange={(e) => props.setMode(e.target.value as Mode)} disabled={props.disabled}>
            {(Object.keys(MODE_LABEL) as Mode[]).map((m) => (
              <option key={m} value={m}>
                {MODE_LABEL[m]}
              </option>
            ))}
          </select>
          <i className="fa-solid fa-chevron-down" />
        </label>
        <label className="pill-select hide-md">
          <span>Model</span>
          <b>{props.mode === "offline" ? "none" : status?.ollama.model ?? "qwen2.5-coder:3b"}</b>
        </label>
      </div>

      <div className="topbar-right">
        <label className="search">
          <input
            value={props.customPath}
            onChange={(e) => props.setCustomPath(e.target.value)}
            placeholder="Scan any local path…"
            disabled={props.disabled}
            aria-label="Local repository path"
          />
          <i className="fa-solid fa-magnifying-glass" />
        </label>
        <div className="chips">
          {chips.map((c) => (
            <span key={c.label} className={`chip ${c.ok === null ? "" : c.ok ? "ok" : "bad"}`} title={c.title}>
              <i />
              {c.label}
            </span>
          ))}
        </div>
        <button className="round-btn" onClick={props.onRefresh} aria-label="Recheck tools">
          <i className="fa-solid fa-gear" />
        </button>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------ */
/* Left column charts                                                   */
/* ------------------------------------------------------------------ */

function CodeDensity({ run, hotFile }: { run: RunState; hotFile: string | null }) {
  const map = run.repoMap;
  const single = map && map.files.length === 1 ? map.files[0] : null;
  const values = single ? single.lines : map ? map.files.map((f) => f.line_count) : [];
  const shown = values.slice(0, 64);
  const max = Math.max(1, ...shown);
  const hotIndex = single
    ? (run.findings[0]?.line_start ?? 0) - 1
    : map
      ? map.files.findIndex((f) => f.path === hotFile)
      : -1;

  return (
    <div className="mini">
      <h3>{single ? `Line Shape · ${single.path}` : "Code Density by File"}</h3>
      <div className="spikes" aria-hidden={!map}>
        {shown.length ? (
          shown.map((v, i) => (
            <span key={i} className={`spike ${i === hotIndex ? "hot" : ""}`} style={{ height: `${8 + (v / max) * 82}%` }}>
              <i />
            </span>
          ))
        ) : (
          Array.from({ length: 48 }, (_, i) => <span key={i} className="spike ghost" style={{ height: `${10 + ((i * 37) % 23)}%` }} />)
        )}
      </div>
      <div className="axis">
        <span>{shown.length ? Math.min(...shown) : "—"}</span>
        <span>{single ? "chars / line" : "lines / file"}</span>
        <span>{shown.length ? max : "—"}</span>
      </div>
    </div>
  );
}

function StageSpikes({ run }: { run: RunState }) {
  const durations = STAGES.map((s) => {
    const st = run.stages[s];
    if (st.start === undefined) return 0;
    return Math.max(0.01, (st.end ?? run.clock) - st.start);
  });
  const total = durations.reduce((a, b) => a + b, 0);
  const max = Math.max(0.01, ...durations);
  return (
    <div className="mini">
      <h3>Stage Timing</h3>
      <div className="peaks">
        {STAGES.map((s, i) => (
          <div key={s} className={`peak ${run.stages[s].status}`}>
            <svg viewBox="0 0 40 60" preserveAspectRatio="none">
              <polygon points={`0,60 20,${60 - Math.max(6, (durations[i] / max) * 56)} 40,60`} />
            </svg>
            <span>{s}</span>
            <em>{durations[i] ? `${durations[i].toFixed(durations[i] < 1 ? 2 : 1)}s` : "—"}</em>
          </div>
        ))}
      </div>
      <div className="axis">
        <span>0s</span>
        <span>total {total ? `${total.toFixed(2)}s` : "—"}</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Centre toolbar + verdict                                             */
/* ------------------------------------------------------------------ */

function Toolbar(props: {
  run: RunState;
  canRun: boolean;
  hasReplay: boolean;
  onRun: () => void;
  onStop: () => void;
  onReplay: () => void;
  onReset: () => void;
}) {
  const { run } = props;
  const running = run.phase === "running";
  return (
    <div className="toolbar">
      <button className="round-btn" onClick={props.onReset} aria-label="Reset" disabled={running}>
        <i className="fa-solid fa-rotate-left" />
      </button>
      {props.hasReplay && (
        <button className="round-btn" onClick={props.onReplay} aria-label="Replay recorded run" title="Replay recorded run" disabled={running}>
          <i className="fa-solid fa-clock-rotate-left" />
        </button>
      )}
      {running ? (
        <button className="round-btn primary" onClick={props.onStop} aria-label="Stop run">
          <i className="fa-solid fa-stop" />
        </button>
      ) : (
        <button className="round-btn primary" onClick={props.onRun} disabled={!props.canRun} aria-label="Run VAYU">
          <i className="fa-solid fa-play" />
        </button>
      )}
      <div className="stage-chips">
        {STAGES.map((s) => (
          <span key={s} className={`stage-chip ${run.stages[s].status}`}>
            <i className="fa-solid fa-circle" />
            {s}
          </span>
        ))}
      </div>
      <span className="toolbar-status">
        {run.replay && <b className="tag">Replay</b>}
        {running ? "Analysing…" : run.phase === "idle" ? "Ready" : run.phase === "error" ? "Stopped" : "Complete"}
      </span>
    </div>
  );
}

function Verdict({ decision, elapsed }: { decision: string; elapsed: number | null }) {
  return (
    <div className={`verdict ${decision.toLowerCase()}`}>
      <span className="display">{decision}</span>
      <small>
        {decision === "VERIFIED"
          ? "all four checks passed"
          : decision === "CLEAN"
            ? "no findings in this target"
            : "verification failed closed"}
        {elapsed !== null ? ` · ${elapsed}s` : ""}
      </small>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Right column gauges                                                  */
/* ------------------------------------------------------------------ */

function Ring({ label, value, max, suffix, note, danger }: { label: string; value: number | null; max: number; suffix: string; note?: string; danger?: boolean }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const frac = value === null ? 0 : Math.max(0, Math.min(1, value / max));
  const angle = -90 + frac * 360;
  const id = label.replace(/\s/g, "");
  return (
    <div className={`ring ${danger ? "danger" : ""}`}>
      <svg viewBox="0 0 90 90" aria-hidden="true">
        <defs>
          <linearGradient id={`g-${id}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#c9b8f2" />
            <stop offset="60%" stopColor="#e6a7c9" />
            <stop offset="100%" stopColor={danger ? "#ff6a4d" : "#f0a27a"} />
          </linearGradient>
        </defs>
        <circle cx="45" cy="45" r={r} className="ring-track" />
        <circle
          cx="45"
          cy="45"
          r={r}
          className="ring-arc"
          stroke={`url(#g-${id})`}
          strokeDasharray={`${c * frac} ${c}`}
          transform="rotate(-90 45 45)"
        />
        <line x1="45" y1="45" x2={45 + Math.cos((angle * Math.PI) / 180) * (r - 8)} y2={45 + Math.sin((angle * Math.PI) / 180) * (r - 8)} className="ring-needle" />
        <circle cx="45" cy="45" r="2.4" className="ring-hub" />
      </svg>
      <span className="ring-label">{label}</span>
      <span className="ring-value">
        {value === null ? "—" : value}
        <small>{value === null ? "" : suffix}</small>
      </span>
      {note && <span className="ring-note">{note}</span>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Lower grid                                                           */
/* ------------------------------------------------------------------ */

const STAGE_ICON: Record<StageName, string> = {
  FIND: "fa-magnifying-glass",
  REASON: "fa-brain",
  PATCH: "fa-code",
  VERIFY: "fa-shield-halved",
};

function StageGrid({ run }: { run: RunState }) {
  const columns = 30;
  const span = Math.max(run.clock, 0.001);
  const toCol = (t: number) => Math.min(columns - 1, Math.floor((t / span) * (columns - 1)));
  return (
    <div className="card stage-grid">
      <div className="card-head">
        <h3>Pipeline by Stage</h3>
        <span className="muted">{run.clock ? `${run.clock.toFixed(2)}s elapsed` : "idle"}</span>
      </div>
      <div className="grid-rows">
        {STAGES.map((s) => {
          const st = run.stages[s];
          const from = st.start !== undefined ? toCol(st.start) : -1;
          const to = st.start !== undefined ? toCol(st.end ?? run.clock) : -1;
          return (
            <div key={s} className="grid-row">
              <span className="row-label">{s.charAt(0) + s.slice(1).toLowerCase()}</span>
              <div className="dots">
                {Array.from({ length: columns }, (_, i) => {
                  const lit = i >= from && i <= to && from >= 0;
                  return <i key={i} className={lit ? `lit ${st.status}` : ""} />;
                })}
                {st.status !== "idle" && (
                  <span className={`grid-pin ${st.status}`} style={{ left: `${((to + 0.5) / columns) * 100}%` }}>
                    <i className={`fa-solid ${st.status === "failed" ? "fa-xmark" : STAGE_ICON[s]}`} />
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CheckTiles({ run }: { run: RunState }) {
  return (
    <div className="card checks">
      <div className="card-head">
        <h3>Verification by Check</h3>
        <span className="muted">fail-closed · all four required</span>
      </div>
      <div className="tiles">
        {CHECKS.map((c) => {
          const state = run.checks[c.id];
          const pending = run.stages.VERIFY.status === "running" && !state;
          return (
            <div key={c.id} className={`tile ${state ? (state.passed ? "pass" : "fail") : pending ? "pending" : ""}`}>
              <div className="tile-head">
                <i className={`fa-solid ${c.icon}`} />
                {c.label}
              </div>
              <span className="tile-hint">{c.hint}</span>
              <span className="tile-value display">{state ? (state.passed ? "PASS" : "FAIL") : pending ? "…" : "—"}</span>
              <span className="tile-reason" title={state?.reason}>
                {state?.reason ?? (pending ? "running in temp workspace" : "awaiting patch")}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Detail views                                                         */
/* ------------------------------------------------------------------ */

function LiveView({ run, hotLine }: { run: RunState; hotLine: number | null }) {
  const finding = run.findings[0];
  const r = run.reasoning;
  return (
    <div className="detail-grid">
      <div className="card">
        <div className="card-head">
          <h3>Finding</h3>
          {finding && <span className={`sev sev-${finding.severity.toLowerCase()}`}>{finding.severity}</span>}
        </div>
        {finding ? (
          <>
            <p className="lead">{finding.vulnerability_type}</p>
            <p className="muted small">{finding.title}</p>
            <CodeBlock context={run.evidence} hotLine={hotLine} />
            <p className="muted tiny">
              {finding.evidence[0]?.raw_reference} · scanner confidence {Math.round(finding.confidence * 100)}% · shown to the model as untrusted data
            </p>
          </>
        ) : (
          <Empty text={run.decision === "CLEAN" ? "No vulnerabilities detected." : "Findings appear here once FIND completes."} />
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h3>AI Reasoning</h3>
          <span className="muted">{run.provider === "ollama" ? `ollama · ${run.model}` : run.provider ? "offline rules · no model" : ""}</span>
        </div>
        {r ? (
          <div className="reason">
            <Fact icon="fa-xmark" tone="hot" title="Root cause" text={r.root_cause} />
            <Fact icon="fa-triangle-exclamation" tone="warn" title="Security impact" text={r.security_impact} />
            <Fact icon="fa-check" tone="safe" title="Remediation" text={r.remediation_strategy} />
            <div className="refs">
              {r.evidence_references.map((ref) => (
                <code key={ref}>{ref}</code>
              ))}
            </div>
          </div>
        ) : (
          <Empty text="Root cause, impact and remediation stream in during REASON." />
        )}
      </div>

      <div className="card terminal-card">
        <div className="card-head">
          <h3>Engine Log</h3>
          <span className="muted">{run.log.length} events</span>
        </div>
        <Terminal lines={run.log} />
      </div>
    </div>
  );
}

function PatchView({ run }: { run: RunState }) {
  const p = run.patch;
  return (
    <div className="detail-grid two">
      <div className="card">
        <div className="card-head">
          <h3>Unified Diff</h3>
          {p && <span className="muted">{p.target_file}</span>}
        </div>
        {p ? <Diff diff={p.unified_diff} /> : <Empty text="The patch appears once PATCH completes." />}
      </div>
      <div className="card">
        <div className="card-head">
          <h3>How the patch was made</h3>
        </div>
        <ol className="steps">
          <li className={run.patch ? "done" : ""}>
            <b>Model proposes one line.</b> It may only return a <code>replacement_line</code>; extra fields are rejected.
          </li>
          <li className={run.patch ? "done" : ""}>
            <b>Trusted code builds the diff.</b> File path, hunk header and metadata come from the scanner, not the model.
          </li>
          <li className={run.patch ? "done" : ""}>
            <b>Structural validation.</b> Single file, no path traversal, well-formed hunk.
          </li>
          <li className={run.verification ? (run.verification.approved ? "done" : "fail") : ""}>
            <b>Applied only in a temp copy.</b> Build, tests, security regression and static rescan decide.
          </li>
        </ol>
        {p && <p className="muted small">{p.rationale}</p>}
      </div>
    </div>
  );
}

function ProofView({ run, history }: { run: RunState; history: HistoryEntry[] }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- provenance is a free-form JSON record
  const prov = run.artifacts?.provenance as Record<string, any> | undefined;
  const download = (name: string, data: unknown) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  };
  return (
    <div className="detail-grid two">
      <div className="card">
        <div className="card-head">
          <h3>Provenance</h3>
          {prov && <span className={`decision ${String(prov.final_decision).toLowerCase()}`}>{prov.final_decision}</span>}
        </div>
        {prov ? (
          <>
            <dl className="kv">
              <dt>Run ID</dt>
              <dd>{prov.run_id}</dd>
              <dt>Repository SHA-256</dt>
              <dd>{prov.target?.repository_sha256}</dd>
              <dt>Patch SHA-256</dt>
              <dd>{prov.patch?.patch_sha256}</dd>
              <dt>Reasoning</dt>
              <dd>
                {prov.reasoning?.provider} · {prov.reasoning?.model}
              </dd>
              <dt>Policy</dt>
              <dd>
                {prov.safety?.verification_policy} · AI output treated as proof: {String(prov.safety?.ai_output_treated_as_proof)}
              </dd>
              <dt>Original modified</dt>
              <dd>{String(prov.safety?.original_repository_modified)}</dd>
            </dl>
            <div className="downloads">
              <button className="pill on" onClick={() => download("vayu-provenance.json", prov)}>
                <i className="fa-solid fa-download" /> Provenance
              </button>
              {run.artifacts?.sarif != null && (
                <button className="pill" onClick={() => download("vayu.sarif", run.artifacts?.sarif)}>
                  <i className="fa-solid fa-download" /> SARIF
                </button>
              )}
              {run.artifacts?.slsa != null && (
                <button className="pill" onClick={() => download("vayu-slsa.json", run.artifacts?.slsa)}>
                  <i className="fa-solid fa-signature" /> Signed SLSA
                </button>
              )}
            </div>
          </>
        ) : (
          <Empty text="A signed audit record is produced when a run completes." />
        )}
      </div>
      <div className="card">
        <div className="card-head">
          <h3>Recent Runs</h3>
          <span className="muted">this browser</span>
        </div>
        {history.length ? (
          <ul className="history">
            {history.map((h) => (
              <li key={h.id}>
                <span className={`dot ${h.decision.toLowerCase()}`} />
                <b>{h.target}</b>
                <span className="muted">{h.provider}</span>
                <span className={`decision ${h.decision.toLowerCase()}`}>{h.decision}</span>
                <span className="muted">{h.elapsed !== null ? `${h.elapsed}s` : ""}</span>
                <time className="muted">{new Date(h.when).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
              </li>
            ))}
          </ul>
        ) : (
          <Empty text="Completed runs are listed here." />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Small pieces                                                         */
/* ------------------------------------------------------------------ */

function CodeBlock({ context, hotLine }: { context: RunState["evidence"]; hotLine: number | null }) {
  const rows = useMemo(
    () =>
      (context?.content ?? "").split("\n").map((line) => {
        const m = /^(\d+): ?(.*)$/.exec(line);
        return m ? { n: Number(m[1]), text: m[2] } : { n: 0, text: line };
      }),
    [context],
  );
  if (!context) return <Empty text="Loading evidence window…" />;
  return (
    <pre className="code">
      {rows.map((row) => (
        <div key={row.n} className={row.n === hotLine ? "hot" : ""}>
          <span>{row.n}</span>
          <code>{row.text || " "}</code>
        </div>
      ))}
    </pre>
  );
}

function Diff({ diff }: { diff: string }) {
  return (
    <pre className="code diff">
      {diff
        .split("\n")
        .filter((l, i, arr) => !(i === arr.length - 1 && l === ""))
        .map((line, i) => {
          const cls = line.startsWith("+++") || line.startsWith("---") ? "meta" : line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "";
          return (
            <div key={i} className={cls}>
              <code>{line}</code>
            </div>
          );
        })}
    </pre>
  );
}

function Terminal({ lines }: { lines: RunState["log"] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [lines.length]);
  return (
    <div className="terminal" ref={ref} role="log" aria-live="polite">
      {lines.length ? (
        lines.map((l, i) => (
          <div key={i} className={`log-${l.level}`}>
            <span>{l.t.toFixed(2)}</span>
            <p>{l.text}</p>
          </div>
        ))
      ) : (
        <div className="log-dim">
          <span>0.00</span>
          <p>waiting for a run…</p>
        </div>
      )}
    </div>
  );
}

function Fact({ icon, tone, title, text }: { icon: string; tone: string; title: string; text: string }) {
  return (
    <div className="fact">
      <i className={`fa-solid ${icon} ${tone}`} />
      <div>
        <b>{title}</b>
        <p>{text}</p>
      </div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="empty">{text}</p>;
}
