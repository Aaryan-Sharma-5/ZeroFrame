import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
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
  title: "ZeroFrame — AI Football Highlights on 0G",
  description:
    "Decentralized AI football highlight engine. Raw footage in, verifiable clip CIDs out. Built on 0G Storage + Compute.",
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
      <body className="min-h-full flex flex-col" style={{ background: "#050505" }}>
        <nav
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 24px",
            borderBottom: "0.5px solid rgba(255,255,255,0.08)",
            background: "rgba(5,5,5,0.97)",
            position: "sticky",
            top: 0,
            zIndex: 50,
          }}
        >
          <span
            style={{
              fontSize: "13px",
              fontWeight: 500,
              letterSpacing: "0.12em",
              color: "#E8E8E8",
            }}
          >
            ZERO<span style={{ color: "#C97832" }}>FRAME</span>
          </span>
          <span
            style={{
              fontSize: "11px",
              color: "#888780",
              fontFamily: "var(--font-geist-mono), monospace",
              display: "flex",
              alignItems: "center",
              gap: "6px",
            }}
          >
            <span
              style={{
                display: "inline-block",
                width: "6px",
                height: "6px",
                borderRadius: "50%",
                background: "#22c55e",
              }}
            />
            0G Testnet · Newton
          </span>
        </nav>
        {children}
      </body>
    </html>
  );
}
