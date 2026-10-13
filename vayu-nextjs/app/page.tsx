"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

export default function Home() {
  const [menuOpen, setMenuOpen] = useState(false);
  
  // stats logic
  useEffect(() => {
    const stats = document.querySelectorAll(".stat-value");
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          startCounting(entry.target);
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.25 });

    stats.forEach(stat => observer.observe(stat));

    function startCounting(el: any) {
      const target = parseFloat(el.getAttribute("data-target") || "0");
      const decimals = parseInt(el.getAttribute("data-decimals") || "0", 10);
      const index = Array.from(stats).indexOf(el);
      
      const duration = 1500 + index * 80;
      const delay = 480 + index * 90;
      
      const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
      
      setTimeout(() => {
        let start = performance.now();
        
        function update(currentTime: number) {
          const elapsed = currentTime - start;
          const progress = Math.min(elapsed / duration, 1);
          
          const current = target * easeOutCubic(progress);
          
          el.textContent = current.toFixed(decimals);
          
          if (progress < 1) {
            requestAnimationFrame(update);
          } else {
            el.textContent = target.toFixed(decimals);
          }
        }
        
        requestAnimationFrame(update);
      }, delay);
    }

    return () => {
      stats.forEach(stat => observer.unobserve(stat));
    };
  }, []);

  // menu logic
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    const handleResize = () => {
      if (window.innerWidth > 720) {
        setMenuOpen(false);
      }
    };
    
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleResize);
    
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  useEffect(() => {
    if (menuOpen) {
      document.body.classList.add("menu-open");
    } else {
      document.body.classList.remove("menu-open");
    }
  }, [menuOpen]);

  const toggleMenu = () => setMenuOpen(prev => !prev);
  const closeMenu = () => setMenuOpen(false);

  return (
    <>
      <div className="bg">
        <video
          className="bg-video"
          autoPlay
          muted
          loop
          playsInline
        >
          <source src="https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260809_012548_ef22562c-c0ae-4816-ad9d-f8922af4e6a7.mp4" type="video/mp4" />
        </video>
      </div>

      <div className="page">
        <header className="header anim" style={{ "--d": "0s" } as React.CSSProperties}>
          <nav className="desktop-nav">
            <a href="#" className="nav-link active">Home</a>
            <Link href="/dashboard" className="nav-link">Dashboard</Link>
            <a href="#" className="nav-link">Case Studies</a>
            <a href="#" className="nav-link">Contact</a>
          </nav>
          <button 
            className="burger mobile-only" 
            aria-expanded={menuOpen} 
            aria-label="Toggle menu"
            onClick={toggleMenu}
          >
            <span className="bar"></span>
            <span className="bar"></span>
            <span className="bar"></span>
          </button>
        </header>

        <main className="hero">
          {/* 
          <div className="trust-row anim" style={{ "--d": "0.05s" } as React.CSSProperties}>
            <div className="avatar-group">
              <div className="avatar a1"><i className="fa-brands fa-microsoft"></i></div>
              <div className="avatar a2"><i className="fa-brands fa-amazon"></i></div>
              <div className="avatar a3"><i className="fa-brands fa-google"></i></div>
            </div>
            <div className="trust-pill">Trusted by 2000+ Enterprises</div>
          </div>
          */}

          <h1 className="headline">
            <span className="line line1 anim" style={{ "--d": "0.12s" } as React.CSSProperties}>Intelligence</span><br />
            <span className="line anim" style={{ "--d": "0.3s" } as React.CSSProperties}>Designed To Evolve</span>
          </h1>

          <p className="subhead anim" style={{ "--d": "0.28s" } as React.CSSProperties}>
            Experience true autonomous cybersecurity. VAYU doesn't just find vulnerabilities—<br />it reasons, patches, and mathematically proves they are eradicated.
          </p>

          <Link href="/dashboard" className="cta anim" style={{ "--d": "0.4s" } as React.CSSProperties}>Open Dashboard</Link>
        </main>

        <footer className="stats-footer">
          <div className="stat anim" style={{ "--d": "0.5s" } as React.CSSProperties}>
            <div className="stat-icon">&lt;</div>
            <div className="stat-value-container">
              <span className="stat-value" data-target="0" data-decimals="0">0</span><span className="stat-suffix"></span>
            </div>
            <div className="stat-label">False Positives</div>
          </div>
          <div className="stat anim" style={{ "--d": "0.58s" } as React.CSSProperties}>
            <div className="stat-icon">%</div>
            <div className="stat-value-container">
              <span className="stat-value" data-target="100" data-decimals="0">0</span><span className="stat-suffix">%</span>
            </div>
            <div className="stat-label">Patch Verification</div>
          </div>
          <div className="stat anim" style={{ "--d": "0.66s" } as React.CSSProperties}>
            <div className="stat-icon">*</div>
            <div className="stat-value-container">
              <span className="stat-value" data-target="24" data-decimals="0">0</span><span className="stat-suffix">/7</span>
            </div>
            <div className="stat-label">Autonomous SecOps</div>
          </div>
          <div className="stat anim" style={{ "--d": "0.74s" } as React.CSSProperties}>
            <div className="stat-icon">#</div>
            <div className="stat-value-container">
              <span className="stat-value" data-target="15" data-decimals="1">0.0</span><span className="stat-suffix">M+</span>
            </div>
            <div className="stat-label">Lines Analyzed</div>
          </div>
        </footer>
      </div>

      <div className={`mobile-overlay ${menuOpen ? "" : "hidden"}`} onClick={closeMenu}></div>
      <div className={`mobile-menu ${menuOpen ? "" : "hidden"}`}>
        <nav className="mobile-nav">
          <a href="#" className="nav-link active anim-mob" onClick={closeMenu}>Home</a>
          <Link href="/dashboard" className="nav-link anim-mob" onClick={closeMenu}>Dashboard</Link>
          <a href="#" className="nav-link anim-mob" onClick={closeMenu}>Case Studies</a>
          <a href="#" className="nav-link anim-mob" onClick={closeMenu}>Contact</a>
        </nav>
      </div>
    </>
  );
}
