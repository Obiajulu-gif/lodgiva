/**
 * The Lodgiva house mark, the same one the marketing site and the PMS use:
 * a gold roofline over a white pillar on brand green. Kept as inline SVG so
 * it inherits the current colour scheme and needs no network request.
 */
export function Logo({ className = 'size-7' }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center justify-center rounded-[10px] bg-[var(--color-lodgiva-brand)] ${className}`}
      aria-hidden
    >
      <svg viewBox="0 0 24 24" fill="none" className="size-[70%]">
        <path
          d="M4 20V9.5L12 4l8 5.5V20"
          stroke="var(--color-lodgiva-gold)"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M9.5 20v-5.5a2.5 2.5 0 0 1 5 0V20"
          stroke="#fff"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

export function LogoWithName() {
  return (
    <span className="flex items-center gap-2.5">
      <Logo />
      <span className="font-display text-[17px] font-semibold tracking-tight">
        Lodgiva
        <span className="ml-1.5 align-middle text-[10px] font-semibold tracking-[0.16em] text-fd-muted-foreground uppercase">
          Docs
        </span>
      </span>
    </span>
  );
}
