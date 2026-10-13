import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** Repository root that contains the Python `crs` package. */
export const REPO_ROOT = path.resolve(
  process.env.VAYU_REPO_ROOT ?? path.join(/*turbopackIgnore: true*/ process.cwd(), ".."),
);

export const SAMPLES_DIR = path.join(REPO_ROOT, "samples", "vulnerable");

/** Python interpreter: VAYU_PYTHON, then a project venv, then the system one. */
export function pythonExecutable(): string {
  if (process.env.VAYU_PYTHON) return process.env.VAYU_PYTHON;
  const candidates =
    process.platform === "win32"
      ? ["venv\\Scripts\\python.exe", ".venv\\Scripts\\python.exe"]
      : ["venv/bin/python", ".venv/bin/python"];
  for (const candidate of candidates) {
    const full = path.join(/*turbopackIgnore: true*/ REPO_ROOT, candidate);
    if (existsSync(full)) return full;
  }
  return process.platform === "win32" ? "python" : "python3";
}

export type Target = { id: string; label: string; path: string; files: number };

export function listSampleTargets(): Target[] {
  if (!existsSync(SAMPLES_DIR)) return [];
  return readdirSync(SAMPLES_DIR)
    .filter((name) => statSync(path.join(SAMPLES_DIR, name)).isDirectory())
    .sort()
    .map((name) => {
      const full = path.join(SAMPLES_DIR, name);
      return {
        id: name,
        label: name.replace(/[_-]+/g, " "),
        path: path.relative(REPO_ROOT, full),
        files: readdirSync(full).length,
      };
    });
}

/**
 * Resolve a requested target to an existing directory. Relative paths are
 * taken from the repository root. The dashboard is a local tool, so any
 * readable directory on this machine is allowed — nothing is ever modified.
 */
export function resolveTarget(requested: string): string | null {
  if (!requested || typeof requested !== "string") return null;
  const full = path.isAbsolute(requested) ? requested : path.join(REPO_ROOT, requested);
  try {
    return statSync(full).isDirectory() ? full : null;
  } catch {
    return null;
  }
}

/** Run a short command and resolve with its first output line, or null. */
export function probe(command: string, args: string[], timeoutMs = 6000): Promise<string | null> {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const finish = (value: string | null) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    try {
      const child = spawn(command, args, { cwd: REPO_ROOT, shell: false });
      const timer = setTimeout(() => {
        child.kill();
        finish(null);
      }, timeoutMs);
      child.stdout.on("data", (d) => (out += d.toString()));
      child.stderr.on("data", (d) => (out += d.toString()));
      child.on("error", () => {
        clearTimeout(timer);
        finish(null);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        finish(code === 0 ? out.trim().split("\n")[0] ?? "" : null);
      });
    } catch {
      finish(null);
    }
  });
}

export const OLLAMA_URL = (process.env.AIKAVACH_OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/$/, "");
export const OLLAMA_MODEL = process.env.AIKAVACH_OLLAMA_MODEL ?? "qwen2.5-coder:3b";
