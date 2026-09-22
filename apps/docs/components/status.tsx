import type { ReactNode } from 'react';

/**
 * Says plainly whether a feature exists today.
 *
 * Documentation that describes a roadmap item as if you could use it now
 * wastes a hotel's evening. Every page describing something not fully
 * available carries one of these, next to the heading it applies to.
 */
const STYLES = {
  available: {
    label: 'Available',
    className:
      'bg-emerald-50 text-emerald-800 ring-emerald-600/20 dark:bg-emerald-950 dark:text-emerald-200 dark:ring-emerald-400/30',
  },
  beta: {
    label: 'Beta',
    className:
      'bg-amber-50 text-amber-900 ring-amber-600/20 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-400/30',
  },
  planned: {
    label: 'Planned',
    className:
      'bg-slate-100 text-slate-700 ring-slate-500/20 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-400/30',
  },
  'not-implemented': {
    label: 'Not implemented',
    className:
      'bg-slate-100 text-slate-700 ring-slate-500/20 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-400/30',
  },
  deprecated: {
    label: 'Deprecated',
    className:
      'bg-rose-50 text-rose-800 ring-rose-600/20 dark:bg-rose-950 dark:text-rose-200 dark:ring-rose-400/30',
  },
} as const;

export type StatusKind = keyof typeof STYLES;

export function Status({
  type = 'available',
  children,
}: {
  type?: StatusKind;
  children?: ReactNode;
}) {
  const style = STYLES[type] ?? STYLES.available;

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 align-middle text-[11px] font-semibold tracking-wide ring-1 ring-inset not-prose ${style.className}`}
    >
      {children ?? style.label}
    </span>
  );
}
