export function Logo({ light = false }: { light?: boolean }) {
  return (
    <span className="flex items-center gap-2.5">
      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-800">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          className="h-5 w-5"
          aria-hidden="true"
        >
          <path
            d="M4 20V9.5L12 4l8 5.5V20"
            stroke="#cda95c"
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
      <span
        className={`font-display text-2xl font-semibold tracking-tight ${
          light ? "text-white" : "text-ink"
        }`}
      >
        Lodgiva
      </span>
    </span>
  );
}
