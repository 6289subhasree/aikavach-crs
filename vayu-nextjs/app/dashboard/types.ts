export type StageName = "FIND" | "REASON" | "PATCH" | "VERIFY";
export const STAGES: StageName[] = ["FIND", "REASON", "PATCH", "VERIFY"];

export type CheckName = "build" | "tests" | "security_regression" | "static_rescan";
export const CHECKS: { id: CheckName; label: string; icon: string; hint: string }[] = [
  { id: "build", label: "Build", icon: "fa-cube", hint: "Patched file compiles" },
  { id: "tests", label: "Tests", icon: "fa-vial", hint: "Project test suite" },
  { id: "security_regression", label: "Exploit", icon: "fa-bug-slash", hint: "Vulnerable call removed" },
  { id: "static_rescan", label: "Rescan", icon: "fa-magnifying-glass-chart", hint: "Semgrep re-run" },
];

export type Mode = "auto" | "ollama" | "offline";

export interface EngineEvent {
  type: string;
  t: number;
  data: Record<string, unknown>;
}

export interface RepoFile {
  path: string;
  line_count: number;
  lines: number[];
  indent: number[];
}

export interface RepoMap {
  root: string;
  files: RepoFile[];
  total_lines: number;
}

export interface Finding {
  finding_id: string;
  title: string;
  vulnerability_type: string;
  severity: string;
  confidence: number;
  file: string | null;
  line_start: number | null;
  line_end: number | null;
  evidence: { source: string; description: string; raw_reference?: string | null }[];
}

export interface CodeContext {
  file: string;
  start_line: number;
  end_line: number;
  content: string;
}

export interface Reasoning {
  finding_id: string;
  vulnerability_class: string;
  root_cause: string;
  security_impact: string;
  remediation_strategy: string;
  assumptions: string[];
  evidence_references: string[];
  confidence: number;
}

export interface Patch {
  finding_id: string;
  target_file: string;
  rationale: string;
  unified_diff: string;
  expected_security_effect: string;
  confidence: number;
}

export interface Verification {
  build_passed: boolean;
  tests_passed: boolean;
  security_test_passed: boolean;
  static_rescan_clean: boolean;
  approved: boolean;
  reason: string | null;
}

export interface StageState {
  status: "idle" | "running" | "done" | "failed";
  start?: number;
  end?: number;
}

export interface CheckState {
  passed: boolean;
  reason: string;
  at: number;
}

export interface LogLine {
  t: number;
  level: "info" | "ok" | "warn" | "error" | "dim";
  text: string;
}

export interface RunState {
  phase: "idle" | "running" | "done" | "error";
  replay: boolean;
  target: string;
  provider: string | null;
  model: string | null;
  repoMap: RepoMap | null;
  targetInfo: { name: string; path: string; languages: string[]; file_count: number; repository_hash: string | null } | null;
  findings: Finding[];
  evidence: CodeContext | null;
  reasoning: Reasoning | null;
  patch: Patch | null;
  checks: Partial<Record<CheckName, CheckState>>;
  verification: Verification | null;
  artifacts: { provenance: Record<string, unknown>; sarif?: unknown; slsa?: unknown; github_annotation?: string } | null;
  decision: "VERIFIED" | "REJECTED" | "CLEAN" | null;
  elapsed: number | null;
  error: { stage: string; message: string } | null;
  stages: Record<StageName, StageState>;
  attempt: number;
  log: LogLine[];
  clock: number;
}

export interface HistoryEntry {
  id: string;
  target: string;
  decision: string;
  provider: string;
  elapsed: number | null;
  when: string;
}

export interface Status {
  engine: { ok: boolean; python: string; version: string | null };
  semgrep: { ok: boolean; version: string | null };
  ollama: { ok: boolean; url: string; model: string; modelInstalled: boolean; models: string[] };
  targets: { id: string; label: string; path: string; files: number }[];
  replay: boolean;
}
