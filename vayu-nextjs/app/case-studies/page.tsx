"use client";

import Link from "next/link";
import { useState } from "react";

import { CASES, type CaseStudy, type Line } from "./cases";
import "./case-studies.css";

const CHECKS = ["Build", "Tests", "Exploit removed", "Rescan clean"];

export default function CaseStudies() {
  return (
    <div className="cs paper">
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

      <article className="paper-body">
        <section className="masthead">
          <p className="cs-kicker">Technical Note · Autonomous Remediation</p>
          <h1>Five Vulnerabilities That Pass Code Review</h1>
          <p className="byline">
            AIKavach <b>VAYU</b> — Autonomous Cyber Reasoning System · Find → Reason → Patch → Verify
          </p>
          <div className="rule" />
          <div className="abstract">
            <span className="abstract-tag">Abstract</span>
            <p>
              We present five realistic vulnerability classes that survive compilation, testing, and human review. In each, the defect is not visible on the line it occupies — it hides in
              untrusted data, in timing, or in a seemingly benign default. For each case, VAYU locates the flaw, reasons about its root cause, synthesises the minimal patch, and
              <em> proves the patch safe</em> inside an isolated sandbox before accepting it. A fix is admitted only when four independent checks pass — verification, not model confidence,
              is the deciding authority. Toggle any listing between its vulnerable and verified-patched form.
            </p>
          </div>
          <a href="#cases" className="cs-scroll">
            Read the cases <i className="fa-solid fa-arrow-down" />
          </a>
        </section>

        <section className="cs-list" id="cases">
          {CASES.map((c, i) => (
            <Case key={c.id} data={c} index={i} />
          ))}
        </section>

        <section className="conclusion">
          <h2>
            <span className="sec-no">6</span> Discussion
          </h2>
          <p>
            Every case above is invisible on the line it lives on — the danger is in data, in timing, or in a default configuration. That is precisely why a deterministic verifier, rather than
            a confidence score, must decide whether a proposed fix is accepted. VAYU treats the model as a source of hypotheses and the sandbox as the arbiter of truth.
          </p>
          <Link href="/dashboard" className="cs-cta inline">
            See the loop run live →
          </Link>
        </section>
      </article>
    </div>
  );
}

function Case({ data, index }: { data: CaseStudy; index: number }) {
  const [view, setView] = useState<"vuln" | "patched">("vuln");
  const lines = view === "vuln" ? data.vulnerable : data.patched;

  return (
    <section className="case">
      <div className="case-meta">
        <div className="case-top">
          <span className="sec-no">{index + 1}</span>
          <h2>{data.title}</h2>
        </div>
        <div className="tags">
          <span className={`sev sev-${data.severity.toLowerCase()}`}>{data.severity}</span>
          <span className="cwe">{data.cwe}</span>
          <span className="case-file">
            <i className="fa-regular fa-file-code" /> {data.file}
          </span>
        </div>

        <div className="case-block">
          <span className="case-label">Impact</span>
          <p>{data.impact}</p>
        </div>
        <div className="case-block">
          <span className="case-label">Why it passes review</span>
          <p>{data.whySubtle}</p>
        </div>
        <div className="case-block">
          <span className="case-label">In the wild</span>
          <p>{data.realWorld}</p>
        </div>
      </div>

      <figure className="case-code">
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
        <figcaption>
          Listing {index + 1}. {view === "vuln" ? "Vulnerable implementation" : "Verified patch"} — {data.file}
        </figcaption>
      </figure>
    </section>
  );
}
