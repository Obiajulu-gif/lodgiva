import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/shared';

/**
 * Documentation is meant to be found, so everything is crawlable. The OG
 * image route is excluded: those are generated images, not pages, and they
 * only dilute the index.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: ['/og/'] }],
    sitemap: siteUrl('/sitemap.xml'),
  };
}
