"use client";

import { useCallback, useEffect, useLayoutEffect, useState } from "react";

import type { RunState, StageName } from "./types";
import { STAGES } from "./types";

/* ------------------------------------------------------------------ */
/* Info tip: a small "i" next to a heading that explains the section.  */
/* ------------------------------------------------------------------ */

export function InfoTip({ text, side = "bottom" }: { text: string; side?: "bottom" | "top" | "left" }) {
  return (
    <span className={`info info-${side}`} tabIndex={0} role="note" aria-label={text}>
      <i className="fa-solid fa-info" aria-hidden="true" />
      <span className="info-pop" aria-hidden="true">
        {text}
      </span>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Plain-language narration of the current step.                       */
/* ------------------------------------------------------------------ */

const STAGE_COPY: Record<StageName, string> = {
  FIND: "Scanning every file with Semgrep for known vulnerability patterns.",
  REASON: "Reading the flagged code and explaining the root cause and impact.",
  PATCH: "Proposing a one-line fix; trusted code turns it into a patch.",
  VERIFY: "Testing the patch in a throwaway copy: build, tests, exploit check, rescan.",
};

export function narrate(run: RunState): { step: string | null; text: string } {
  const active = STAGES.findIndex((s) => run.stages[s].status === "running");
  if (run.phase === "running" && active >= 0) {
    return { step: `Step ${active + 1} of 4`, text: STAGE_COPY[STAGES[active]] };
  }
  if (run.phase === "running") return { step: null, text: "Starting the engine and reading the target…" };
  if (run.phase === "done") {
    if (run.decision === "VERIFIED") return { step: "Done", text: "The fix passed all four checks. Your original code was not changed." };
    if (run.decision === "REJECTED") return { step: "Done", text: "The fix did not pass every check, so VAYU rejected it." };
    return { step: "Done", text: "No known vulnerability patterns were found in this target." };
  }
  if (run.phase === "error") {
    if (run.error && /semgrep/i.test(run.error.message)) return { step: "Stopped", text: "Semgrep is not installed. Run: pip install semgrep" };
    return { step: "Stopped", text: run.error?.message ?? "The run stopped." };
  }
  return { step: null, text: "" };
}

/* ------------------------------------------------------------------ */
/* Guided tour                                                          */
/* ------------------------------------------------------------------ */

export interface TourStep {
  target: string;
  title: string;
  body: string;
}

export const TOUR: TourStep[] = [
  {
    target: "[data-tour=controls]",
    title: "1. Choose what to scan",
    body: "Pick a bundled sample under Target, or type any folder on your machine in the search box. Engine picks the reasoner: Ollama (a local AI model) or Offline rules. The three Tools dots show whether Python, Semgrep and Ollama are ready.",
  },
  {
    target: "[data-tour=run]",
    title: "2. Press play to start",
    body: "VAYU runs four steps in order: Find, Reason, Patch, Verify. These round icons light up as each step runs. You can stop at any time. Shortcut: R.",
  },
  {
    target: "[data-tour=map]",
    title: "3. The map is your code",
    body: "Every dot is part of your codebase. Each file gets its own region, and bright raised areas are where there is more code. Hover anywhere to see which file you are over.",
  },
  {
    target: "[data-tour=legend]",
    title: "4. Reading the colours",
    body: "Orange means a vulnerability was found there. It cools to lavender once a fix is proposed. Shield pins are files that were scanned clean; the warning pin marks the problem line.",
  },
  {
    target: "[data-tour=status]",
    title: "5. What is happening now",
    body: "This line always says, in plain words, which step VAYU is on and what it is doing.",
  },
  {
    target: "[data-tour=gauges]",
    title: "6. Confidence vs. proof",
    body: "Model Confidence is how sure the AI is about its explanation. It is not proof. Checks Passed is the proof: a fix is only accepted when all 4 checks pass.",
  },
  {
    target: "[data-tour=pipeline]",
    title: "7. Timeline of the run",
    body: "Each row is one step. Dots fill in as time passes, and the pin shows where that step finished.",
  },
  {
    target: "[data-tour=checks]",
    title: "8. The four checks",
    body: "Build: the patched file still compiles. Tests: your test suite still passes. Exploit: the dangerous call is gone. Rescan: Semgrep no longer flags it. All of this happens in a temporary copy.",
  },
  {
    target: "[data-tour=tabs]",
    title: "9. See the details",
    body: "Diff shows the vulnerable code and the exact patch. Provenance is the signed audit record you can download (JSON, SARIF, SLSA). Press ? anytime to replay this tour.",
  },
];

const TOUR_KEY = "vayu.tour.v1";

export function useTour() {
  const [step, setStep] = useState<number | null>(null);

  useEffect(() => {
    let seen = true;
    try {
      seen = window.localStorage.getItem(TOUR_KEY) === "done";
    } catch {
      /* storage unavailable: don't nag */
    }
    if (!seen) {
      const id = window.setTimeout(() => setStep(0), 900);
      return () => window.clearTimeout(id);
    }
  }, []);

  const close = useCallback(() => {
    setStep(null);
    try {
      window.localStorage.setItem(TOUR_KEY, "done");
    } catch {
      /* ignore */
    }
  }, []);

  return { step, setStep, open: () => setStep(0), close };
}

export function Tour({ step, setStep, close }: { step: number | null; setStep: (n: number) => void; close: () => void }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const current = step !== null ? TOUR[step] : null;

  useLayoutEffect(() => {
    if (!current) return;
    const measure = () => {
      const el = document.querySelector(current.target);
      if (el) {
        el.scrollIntoView({ block: "nearest", inline: "nearest" });
        setRect(el.getBoundingClientRect());
      } else {
        setRect(null);
      }
    };
    measure();
    window.addEventListener("resize", measure);
    const scroller = document.querySelector(".dash");
    scroller?.addEventListener("scroll", measure);
    return () => {
      window.removeEventListener("resize", measure);
      scroller?.removeEventListener("scroll", measure);
    };
  }, [current]);

  useEffect(() => {
    if (step === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key === "ArrowRight" || e.key === "Enter") {
        if (step < TOUR.length - 1) setStep(step + 1);
        else close();
      }
      if (e.key === "ArrowLeft" && step > 0) setStep(step - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, setStep, close]);

  if (step === null || !current) return null;

  const pad = 8;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const hole = rect
    ? { left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }
    : { left: vw / 2, top: vh / 2, width: 0, height: 0 };
  const cardW = Math.min(320, vw - 32);
  const below = hole.top + hole.height + 14;
  const cardTop = below + 190 < vh ? below : Math.max(16, hole.top - 190 - 14);
  const cardLeft = Math.min(Math.max(16, hole.left), vw - cardW - 16);

  return (
    <div className="tour" role="dialog" aria-modal="true" aria-label="VAYU guided tour">
      <div className="tour-hole" style={hole} />
      <div className="tour-card" style={{ top: cardTop, left: cardLeft, width: cardW }}>
        <div className="tour-top">
          <span className="tour-count">
            {step + 1} / {TOUR.length}
          </span>
          <button className="tour-skip" onClick={close}>
            Skip tour
          </button>
        </div>
        <h4>{current.title}</h4>
        <p>{current.body}</p>
        <div className="tour-foot">
          <div className="tour-dots" aria-hidden="true">
            {TOUR.map((_, i) => (
              <i key={i} className={i === step ? "on" : i < step ? "seen" : ""} />
            ))}
          </div>
          <div className="tour-btns">
            {step > 0 && (
              <button className="pill-btn" onClick={() => setStep(step - 1)}>
                Back
              </button>
            )}
            <button className="pill-btn on" onClick={() => (step < TOUR.length - 1 ? setStep(step + 1) : close())}>
              {step < TOUR.length - 1 ? "Next" : "Got it"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
