import type { Metadata, Viewport } from "next";
import { MobileBottomNav } from "@/components/MobileBottomNav";
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
  description:
    "Rules-based NSE index options analysis + paper trading (not financial advice)",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "NSE Options",
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0B0E11",
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
      <body className="flex min-h-full flex-col bg-binance-bg font-sans text-binance-text">
        <header
          className="sticky top-0 z-40 border-b border-binance-border bg-binance-surface/95 backdrop-blur-md"
          style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
        >
          <div className="mx-auto flex w-full max-w-[1600px] items-center justify-between gap-3 px-3 py-2.5 sm:px-6 sm:py-3 lg:px-8">
            <Link
              href="/"
              className="min-w-0 truncate text-base font-semibold tracking-tight text-binance-gold sm:text-lg"
            >
              <span className="md:hidden">NSE Options</span>
              <span className="hidden md:inline">NSE Options Assistant</span>
            </Link>
            <NavLinks />
          </div>
        </header>

        <main className="app-main mx-auto w-full max-w-[1600px] flex-1 px-3 py-4 sm:px-6 sm:py-6 lg:px-8">
          {children}
        </main>

        <footer className="hidden border-t border-binance-border py-4 text-center text-xs text-binance-muted md:block">
          Paper trading only · Rules-based heuristics · Not investment advice
        </footer>

        <MobileBottomNav />
      </body>
    </html>
  );
}
