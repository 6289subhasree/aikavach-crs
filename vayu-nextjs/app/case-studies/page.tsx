"use client";

import Link from "next/link";
import { useState } from "react";

import { CASES, type CaseStudy, type Line } from "./cases";
import "./case-studies.css";

const CHECKS = ["Build", "Tests", "Exploit removed", "Rescan clean"];

export default function CaseStudies() {
  return (
    <div className="cs">
      <header className="cs-head">
        <Link href="/" className="cs-logo">
          vayu<span>&gt;</span>
        </Link>
        <nav className="cs-nav">
          <Link href="/">Home</Link>
          <Link href="/dashboard">Dashboard</Link>
          <a className="active" href="#cases">
            Case Studies
          </a>
        </nav>
        <Link href="/dashboard" className="cs-cta">
          Open Dashboard
        </Link>
      </header>

      <section className="cs-hero">
        <p className="cs-kicker">Case Studies</p>
        <h1>
          Five bugs that pass
          <br />
          code review.
        </h1>
        <p className="cs-sub">
          Not textbook examples — these are the quiet ones. Each compiles, ships, and survives a human reviewer. VAYU finds each, reasons about the root cause, writes the minimal patch, and
          <em> proves it safe</em> in an isolated sandbox before accepting it. Toggle any case between the vulnerable code and the verified fix.
        </p>
        <a href="#cases" className="cs-scroll">
          Read the cases <i className="fa-solid fa-arrow-down" />
        </a>
      </section>

      <section className="cs-list" id="cases">
        {CASES.map((c, i) => (
          <Case key={c.id} data={c} index={i} />
        ))}
      </section>

      <footer className="cs-foot">
        <div>
          <b>The common thread</b>
          <p>
            Every one of these is invisible on the line it lives on — the danger is in data, in timing, or in a default. That is exactly why a verifier, not a confidence score, decides whether a fix is accepted.
          </p>
        </div>
        <Link href="/dashboard" className="cs-cta">
          See it run live
        </Link>
      </footer>
    </div>
  );
}

function Case({ data, index }: { data: CaseStudy; index: number }) {
  const [view, setView] = useState<"vuln" | "patched">("vuln");
  const lines = view === "vuln" ? data.vulnerable : data.patched;

  return (
    <article className="case">
      <div className="case-meta">
        <div className="case-top">
          <span className="case-no">{String(index + 1).padStart(2, "0")}</span>
          <span className={`sev sev-${data.severity.toLowerCase()}`}>{data.severity}</span>
          <span className="cwe">{data.cwe}</span>
        </div>
        <h2>{data.title}</h2>
        <p className="case-file">
          <i className="fa-regular fa-file-code" /> {data.file}
        </p>

        <div className="case-block">
          <span className="case-label impact">
            <i className="fa-solid fa-burst" /> Impact
          </span>
          <p>{data.impact}</p>
        </div>
        <div className="case-block">
          <span className="case-label subtle">
            <i className="fa-solid fa-user-secret" /> Why it passes review
          </span>
          <p>{data.whySubtle}</p>
        </div>
        <div className="case-block">
          <span className="case-label real">
            <i className="fa-solid fa-landmark" /> In the wild
          </span>
          <p>{data.realWorld}</p>
        </div>
      </div>

      <div className="case-code">
        <div className="code-bar">
          <div className="code-toggle" role="tablist">
            <button role="tab" aria-selected={view === "vuln"} className={view === "vuln" ? "on vuln" : ""} onClick={() => setView("vuln")}>
              <i className="fa-solid fa-triangle-exclamation" /> Vulnerable
            </button>
            <button role="tab" aria-selected={view === "patched"} className={view === "patched" ? "on patched" : ""} onClick={() => setView("patched")}>
              <i className="fa-solid fa-shield-halved" /> Patched
            </button>
          </div>
          <span className="code-file">{data.file}</span>
        </div>

        <pre className="code">
          {lines.map((line: Line, idx) => (
            <div key={idx} className={line.mark ? `ln ${line.mark}` : "ln"}>
              <span className="ln-no">{idx + 1}</span>
              <code>{line.t || " "}</code>
            </div>
          ))}
        </pre>

        {view === "vuln" ? (
          <div className="code-foot flag">
            <i className="fa-solid fa-magnifying-glass" />
            <span>
              <b>VAYU flags:</b> {data.flagged}
            </span>
          </div>
        ) : (
          <div className="code-foot verified">
            <span className="verdict">
              <i className="fa-solid fa-circle-check" /> VERIFIED
            </span>
            <div className="checks">
              {CHECKS.map((ch) => (
                <span key={ch}>
                  <i className="fa-solid fa-check" /> {ch}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </article>
  );
}
