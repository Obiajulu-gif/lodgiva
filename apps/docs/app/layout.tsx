import { RootProvider } from 'fumadocs-ui/provider/next';
import './global.css';
import { Inter, Playfair_Display } from 'next/font/google';
import type { Metadata } from 'next';
import { appName, siteDescription } from '@/lib/shared';

/** The marketing site's pairing: Playfair for headings, Inter for text. */
const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });
const playfair = Playfair_Display({
  subsets: ['latin'],
  weight: ['600', '700'],
  variable: '--font-playfair',
});

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_DOCS_URL ?? 'https://lodgiva-docs.vercel.app',
  ),
  title: {
    default: `${appName} — hotel management for Nigerian hotels`,
    template: `%s | ${appName}`,
  },
  description: siteDescription,
  openGraph: {
    type: 'website',
    siteName: appName,
    title: `${appName} — hotel management for Nigerian hotels`,
    description: siteDescription,
  },
  twitter: {
    card: 'summary_large_image',
    title: `${appName} — hotel management for Nigerian hotels`,
    description: siteDescription,
  },
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${playfair.variable} ${inter.className}`}
      suppressHydrationWarning
    >
      <body className="flex flex-col min-h-screen">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
