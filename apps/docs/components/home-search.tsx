'use client';

import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { useSearchContext } from 'fumadocs-ui/contexts/search';

/**
 * The search box on the documentation home page.
 *
 * It opens the same dialog as Ctrl/Cmd+K rather than being a second search
 * implementation, so results and keyboard behaviour stay identical
 * everywhere.
 */
export function HomeSearch() {
  const { setOpenSearch } = useSearchContext();
  const [isMac, setIsMac] = useState(false);

  // Rendered after mount: the platform is unknown on the server, and showing
  // the wrong shortcut is worse than showing none for a moment.
  useEffect(() => {
    setIsMac(/Mac|iPhone|iPad/i.test(navigator.platform ?? navigator.userAgent));
  }, []);

  return (
    <button
      type="button"
      onClick={() => setOpenSearch(true)}
      className="flex w-full items-center gap-3 rounded-lg border border-fd-border bg-fd-background px-4 py-3 text-left text-sm text-fd-muted-foreground transition-colors hover:border-fd-primary/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fd-ring"
      aria-label="Search the documentation"
    >
      <Search className="size-4 shrink-0" aria-hidden />
      <span className="flex-1">Search the documentation…</span>
      <kbd className="hidden shrink-0 rounded border border-fd-border px-1.5 py-0.5 font-mono text-[11px] sm:inline-block">
        {isMac ? '⌘' : 'Ctrl'} K
      </kbd>
    </button>
  );
}
