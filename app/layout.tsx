import type { Metadata } from "next";
import { Fraunces, Inter } from "next/font/google";
import "./globals.css";

const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
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
    <html lang="en" className={`${fraunces.variable} ${inter.variable}`}>
      <body>{children}</body>
    </html>
  );
}
