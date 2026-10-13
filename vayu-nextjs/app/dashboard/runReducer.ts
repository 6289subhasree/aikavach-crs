import type {
  CheckName,
  CodeContext,
  EngineEvent,
  Finding,
  LogLine,
  Patch,
  Reasoning,
  RepoMap,
  RunState,
  StageName,
  Verification,
} from "./types";
import { STAGES } from "./types";

export function initialRun(target = "", replay = false): RunState {
  return {
    phase: "idle",
    replay,
    target,
    provider: null,
    model: null,
    repoMap: null,
    targetInfo: null,
    findings: [],
    evidence: null,
    reasoning: null,
    patch: null,
    checks: {},
    verification: null,
    artifacts: null,
    decision: null,
    elapsed: null,
    error: null,
    stages: Object.fromEntries(STAGES.map((s) => [s, { status: "idle" }])) as RunState["stages"],
    attempt: 0,
    log: [],
    clock: 0,
  };
}

export type Action =
  | { kind: "start"; target: string; replay: boolean }
  | { kind: "event"; event: EngineEvent }
  | { kind: "fail"; message: string }
  | { kind: "reset" };

const CHECK_LABEL: Record<string, string> = {
  build: "build",
  tests: "functional tests",
  security_regression: "security regression",
  static_rescan: "static rescan",
};

function push(state: RunState, level: LogLine["level"], text: string, t = state.clock): LogLine[] {
  const next = [...state.log, { t, level, text }];
  return next.length > 400 ? next.slice(-400) : next;
}

export function runReducer(state: RunState, action: Action): RunState {
  switch (action.kind) {
    case "reset":
      return initialRun(state.target);
    case "start": {
      const fresh = initialRun(action.target, action.replay);
      return {
        ...fresh,
        phase: "running",
        log: [{ t: 0, level: "dim", text: `${action.replay ? "replaying" : "launching"} vayu on ${action.target}` }],
      };
    }
    case "fail":
      return {
        ...state,
        phase: "error",
        error: { stage: "DASHBOARD", message: action.message },
        log: push(state, "error", action.message),
      };
    case "event":
      return applyEvent(state, action.event);
  }
}

function applyEvent(state: RunState, event: EngineEvent): RunState {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- event payloads are validated per type below
  const d = event.data as Record<string, any>;
  const t = event.type === "log" || event.type === "exit" ? state.clock : event.t ?? state.clock;
  const s: RunState = { ...state, clock: Math.max(state.clock, t) };

  switch (event.type) {
    case "hello":
      return {
        ...s,
        provider: d.provider,
        model: d.model,
        log: push(s, "info", `engine up · reasoning via ${d.provider === "ollama" ? `ollama/${d.model}` : "offline rules (no model)"}`, t),
      };
    case "repo_map": {
      const map = d as RepoMap;
      return { ...s, repoMap: map, log: push(s, "dim", `mapped ${map.files.length} files · ${map.total_lines} lines`, t) };
    }
    case "stage": {
      const stage = d.stage as StageName;
      const prev = s.stages[stage];
      const status = d.status as "running" | "done";
      const stages = {
        ...s.stages,
        [stage]: {
          status,
          start: status === "running" ? (prev.status === "idle" || prev.start === undefined ? t : prev.start) : prev.start,
          end: status === "done" ? t : undefined,
        },
      };
      const attempt = stage === "PATCH" && d.attempt ? Number(d.attempt) : s.attempt;
      const text = status === "running" ? `${stage.toLowerCase()} ›` + (attempt > 1 && stage === "PATCH" ? ` attempt ${attempt}` : "") : `${stage.toLowerCase()} ✓`;
      return { ...s, stages, attempt, log: push(s, status === "done" ? "ok" : "info", text, t) };
    }
    case "target":
      return { ...s, targetInfo: d as RunState["targetInfo"], log: push(s, "dim", `repo sha256 ${String(d.repository_hash ?? "").slice(0, 16)}…`, t) };
    case "findings": {
      const findings = (d.findings ?? []) as Finding[];
      const first = findings[0];
      return {
        ...s,
        findings,
        log: push(
          s,
          findings.length ? "warn" : "ok",
          findings.length
            ? `${findings.length} finding${findings.length > 1 ? "s" : ""} · ${first.vulnerability_type} at ${shortPath(first.file)}:${first.line_start}`
            : "no findings",
          t,
        ),
      };
    }
    case "evidence": {
      const ctx = d as CodeContext;
      return { ...s, evidence: ctx, log: push(s, "dim", `evidence window ${ctx.file}:${ctx.start_line}-${ctx.end_line} · wrapped as untrusted`, t) };
    }
    case "reasoning": {
      const r = d as Reasoning;
      return { ...s, reasoning: r, log: push(s, "info", `reasoned: ${r.vulnerability_class} · confidence ${Math.round(r.confidence * 100)}%`, t) };
    }
    case "patch": {
      const p = d as Patch;
      return { ...s, patch: p, log: push(s, "info", `patch built outside the model · ${p.target_file}`, t) };
    }
    case "check": {
      const name = d.check as CheckName;
      return {
        ...s,
        checks: { ...s.checks, [name]: { passed: !!d.passed, reason: String(d.reason ?? "") } },
        log: push(s, d.passed ? "ok" : "error", `${CHECK_LABEL[name] ?? name} ${d.passed ? "passed" : "failed"} — ${d.reason}`, t),
      };
    }
    case "verification": {
      const v = d as Verification;
      return { ...s, verification: v, log: push(s, v.approved ? "ok" : "error", v.reason ?? (v.approved ? "verified" : "rejected"), t) };
    }
    case "retry":
      return { ...s, checks: {}, log: push(s, "warn", `self-correcting after attempt ${d.attempt}: ${d.reason}`, t) };
    case "artifacts":
      return { ...s, artifacts: d as RunState["artifacts"], log: push(s, "dim", "provenance, SARIF and signed SLSA attestation written", t) };
    case "done": {
      const decision = d.decision as RunState["decision"];
      return {
        ...s,
        phase: "done",
        decision,
        elapsed: typeof d.elapsed === "number" ? d.elapsed : null,
        log: push(s, decision === "REJECTED" ? "error" : "ok", `final decision ${decision} · original repository untouched`, t),
      };
    }
    case "error": {
      const stage = (d.stage as StageName) ?? "FIND";
      const stages = { ...s.stages };
      if (stage in stages) stages[stage] = { ...stages[stage], status: "failed", end: t };
      for (const name of Object.keys(stages) as StageName[]) {
        if (stages[name].status === "running") stages[name] = { ...stages[name], status: "failed", end: t };
      }
      return { ...s, phase: "error", stages, error: { stage, message: String(d.message ?? "Unknown error") }, log: push(s, "error", String(d.message), t) };
    }
    case "log":
      return { ...s, log: push(s, "dim", String(d.message ?? "")) };
    case "exit":
      if (s.phase === "running") {
        return { ...s, phase: "error", error: { stage: "ENGINE", message: `Engine exited (code ${d.code}) before finishing` }, log: push(s, "error", `engine exited with code ${d.code}`) };
      }
      return s;
    default:
      return s;
  }
}

export function shortPath(file: string | null | undefined): string {
  if (!file) return "?";
  const parts = file.replace(/\\/g, "/").split("/");
  return parts.slice(-2).join("/");
}

/** Path of a finding relative to the scanned repository root. */
export function relativeFile(file: string | null | undefined, root: string | null | undefined): string | null {
  if (!file) return null;
  const f = file.replace(/\\/g, "/");
  const r = (root ?? "").replace(/\\/g, "/").replace(/\/$/, "");
  if (r && f.startsWith(r + "/")) return f.slice(r.length + 1);
  return f;
}
