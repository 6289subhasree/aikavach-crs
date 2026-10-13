import { spawn } from "node:child_process";
import path from "node:path";

import { REPO_ROOT, pythonExecutable, resolveTarget } from "../_lib/engine";

const MODES = new Set(["auto", "ollama", "offline"]);

/**
 * Start one Find -> Reason -> Patch -> Verify run and stream its events.
 *
 * The response body is newline-delimited JSON produced by `python -m crs.stream`.
 * Anything the engine prints to stderr is forwarded as `log` events so the
 * dashboard terminal shows it. Closing the request stops the run.
 */
export async function POST(request: Request) {
  let body: { target?: string; mode?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const target = resolveTarget(body.target ?? "");
  if (!target) {
    return Response.json({ error: "Target is not an existing directory" }, { status: 400 });
  }
  const mode = MODES.has(body.mode ?? "") ? (body.mode as string) : "auto";

  const encoder = new TextEncoder();
  const line = (type: string, data: Record<string, unknown>) =>
    encoder.encode(JSON.stringify({ type, t: 0, data }) + "\n");

  const child = spawn(
    pythonExecutable(),
    ["-u", "-m", "crs.stream", target, "--mode", mode, "--artifacts-dir", path.join(REPO_ROOT, "artifacts")],
    { cwd: REPO_ROOT, shell: false, env: { ...process.env, PYTHONIOENCODING: "utf-8" } },
  );

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const close = () => {
        if (!closed) {
          closed = true;
          controller.close();
        }
      };
      child.stdout.on("data", (chunk: Buffer) => !closed && controller.enqueue(chunk));
      child.stderr.on("data", (chunk: Buffer) => {
        for (const text of chunk.toString().split("\n")) {
          if (text.trim() && !closed) controller.enqueue(line("log", { level: "stderr", message: text }));
        }
      });
      child.on("error", (err) => {
        if (!closed) controller.enqueue(line("error", { stage: "SETUP", message: `Could not start Python: ${err.message}` }));
        close();
      });
      child.on("close", (code) => {
        if (!closed) controller.enqueue(line("exit", { code }));
        close();
      });
      request.signal.addEventListener("abort", () => {
        child.kill();
        close();
      });
    },
    cancel() {
      child.kill();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
