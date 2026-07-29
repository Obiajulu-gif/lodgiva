"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Scroll-triggered entrance. Deliberately restrained: content fades up once,
 * never re-animates, and never moves layout — so it reads as polish rather
 * than as the page fighting the reader. Fully disabled under reduced motion,
 * and content is visible if IntersectionObserver is unavailable.
 */
export function Reveal({
  children,
  delay = 0,
  className = "",
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Renders visible. Content is never gated on JS, an observer firing, or a
  // browser that composites — the animation is added on top, not required.
  const [phase, setPhase] = useState<"static" | "hidden" | "in">("static");

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (
      typeof IntersectionObserver === "undefined" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return; // stay static + visible
    }
    // Only animate what the reader cannot already see; anything above the
    // fold would otherwise flash out and back in after hydration.
    if (el.getBoundingClientRect().top < window.innerHeight * 0.9) return;

    setPhase("hidden");
    let failsafe = 0;
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting) return;
        setPhase("in");
        io.disconnect();
        window.clearTimeout(failsafe);
      },
      { threshold: 0.15, rootMargin: "0px 0px -40px 0px" }
    );
    io.observe(el);
    // If the observer never reports (background tabs, non-compositing
    // contexts, some in-app browsers), show the content anyway.
    failsafe = window.setTimeout(() => {
      setPhase("in");
      io.disconnect();
    }, 2000);

    return () => {
      io.disconnect();
      window.clearTimeout(failsafe);
    };
  }, []);

  return (
    <div
      ref={ref}
      className={`${phase === "static" ? "" : "reveal"} ${phase === "in" ? "in" : ""} ${className}`}
      style={{ transitionDelay: `${delay}ms` }}
    >
      {children}
    </div>
  );
}
