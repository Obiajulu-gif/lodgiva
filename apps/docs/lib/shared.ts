import { createGetUrl } from 'fumadocs-core/source';

export const appName = 'Lodgiva Docs';
export const siteDescription =
  'Run your hotel on Lodgiva: set up your property, take bookings, check guests in and out, bill in naira with VAT, and close the day.';
export const docsRoute = '/docs';
export const docsImageRoute = '/og/docs';
export const docsContentRoute = '/llms.mdx/docs';

/** Where "Edit this page" and "View on GitHub" point. */
export const gitConfig = {
  user: 'Obiajulu-gif',
  repo: 'lodgiva',
  branch: 'main',
  /** The docs app's path inside the repository. */
  contentPath: 'apps/docs',
};

export function getEditUrl(path: string) {
  const { user, repo, branch, contentPath } = gitConfig;
  return `https://github.com/${user}/${repo}/blob/${branch}/${contentPath}/content/docs/${path}`;
}

const getContentUrl = createGetUrl(docsContentRoute);

export function getPageMarkdownUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, 'content.md'];

  return { segments, url: getContentUrl(segments, page.locale) };
}

const getImageUrl = createGetUrl(docsImageRoute);

export function getPageImageUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, 'image.png'];

  return { segments, url: getImageUrl(segments, page.locale) };
}
