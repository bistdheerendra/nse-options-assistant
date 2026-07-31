import type { Metadata } from "next";
import { NavLinks } from "@/components/NavLinks";
import { Geist_Mono, IBM_Plex_Sans } from "next/font/google";
import Link from "next/link";
import "./globals.css";

/** Closest public match to Binance Plex for UI + ₹ amounts. */
const ibmPlexSans = IBM_Plex_Sans({
  variable: "--font-ibm-plex-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "NSE Options Assistant",
  description: "Rules-based NSE index options analysis + paper trading (not financial advice)",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${ibmPlexSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-binance-bg font-sans text-binance-text">
        <header className="border-b border-binance-border bg-binance-surface">
          <div className="mx-auto flex w-full max-w-[1600px] items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">
            <Link href="/" className="text-lg font-semibold tracking-tight text-binance-gold">
              NSE Options Assistant
            </Link>
            <NavLinks />
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-6 sm:px-6 lg:px-8">
          {children}
        </main>
        <footer className="border-t border-binance-border py-4 text-center text-xs text-binance-muted">
          Paper trading only · Rules-based heuristics · Not investment advice
        </footer>
      </body>
    </html>
  );
}
