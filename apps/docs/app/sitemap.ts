import type { MetadataRoute } from 'next';
import { source } from '@/lib/source';
import { siteUrl } from '@/lib/shared';

/**
 * Every documentation page, plus the home page.
 *
 * The list is derived from the content tree rather than written out, so a new
 * page is in the sitemap the moment its file exists — a hand-maintained
 * sitemap is a sitemap that goes stale.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  return [
    {
      url: siteUrl(),
      lastModified: now,
      changeFrequency: 'weekly',
      priority: 1,
    },
    ...source.getPages().map((page) => ({
      url: siteUrl(page.url),
      lastModified: now,
      changeFrequency: 'weekly' as const,
      // Section landing pages matter more than the pages beneath them.
      priority: page.url.split('/').filter(Boolean).length <= 2 ? 0.8 : 0.6,
    })),
  ];
}
