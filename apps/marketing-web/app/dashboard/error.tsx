"use client";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="rounded-2xl border border-red-100 bg-white p-8">
      <h1 className="font-display text-2xl font-semibold text-ink">
        This dashboard view could not load
      </h1>
      <p className="mt-2 text-sm text-ink/55">
        {error.message || "An unexpected error occurred."}
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-6 rounded-full bg-brand-800 px-5 py-2.5 text-sm font-semibold text-white"
      >
        Try again
      </button>
    </div>
  );
}
