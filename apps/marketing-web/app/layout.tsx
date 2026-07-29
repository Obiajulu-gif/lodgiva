import type { Metadata } from "next";
import { Playfair_Display, Inter } from "next/font/google";
import "./globals.css";

// ANCHOR — a high-contrast editorial serif. Loaded at display weights only:
// it earns its keep at 40px+ and would be a liability in body copy.
const playfair = Playfair_Display({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-playfair",
  display: "swap",
});

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Lodgiva — Hotel Management Software for Nigerian Hotels",
  description:
    "Lodgiva is the all-in-one hotel management platform built for Nigerian hotels, serviced apartments and hotel groups. Reservations, front desk, housekeeping, payments, POS and reports — online or offline.",
  keywords: [
    "hotel management software",
    "Nigeria",
    "PMS",
    "hotel software Lagos",
    "property management system",
    "Lodgiva",
  ],
  openGraph: {
    title: "Lodgiva — Hotel Management Software for Nigerian Hotels",
    description:
      "Run your entire hotel from one beautiful dashboard. Reservations, payments, housekeeping and reports — built for Nigeria.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${playfair.variable} ${inter.variable}`}>
      <body>{children}</body>
    </html>
  );
}
