import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import { CosmosProvider } from "@/components/cosmos/CosmosProvider";
import { SessionProvider } from "@/lib/session";
import "./globals.css";

const serif = Instrument_Serif({ subsets: ["latin"], weight: "400", style: ["normal", "italic"], variable: "--font-serif" });
const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

export const metadata: Metadata = {
  title: "Orion",
  description: "See the company before you change it. A company graph on FalkorDB you can fork, break and replay.",
};

export const viewport: Viewport = { themeColor: "#04050a", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${geist.variable} ${mono.variable}`}>
      <body className="grain">
        <SessionProvider>
          <CosmosProvider>{children}</CosmosProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
