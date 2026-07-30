import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
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
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-binance-bg text-binance-text">
        <header className="border-b border-binance-border bg-binance-surface">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
            <Link href="/" className="text-lg font-semibold tracking-tight text-binance-gold">
              NSE Options Assistant
            </Link>
            <nav className="flex gap-4 text-sm text-binance-muted">
              <Link href="/" className="hover:text-binance-text">
                Analysis
              </Link>
              <Link href="/paper" className="hover:text-binance-text">
                Paper
              </Link>
              <Link href="/backtest" className="hover:text-binance-text">
                Track Record
              </Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">{children}</main>
        <footer className="border-t border-binance-border py-4 text-center text-xs text-binance-muted">
          Paper trading only · Rules-based heuristics · Not investment advice
        </footer>
      </body>
    </html>
  );
}
