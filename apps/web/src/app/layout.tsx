import type { Metadata } from "next";
import { Fraunces, Geist, Geist_Mono } from "next/font/google";
import { TourShell } from "@/components/tour/TourShell";
import "./globals.css";

const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  axes: ["opsz"],
  style: ["normal", "italic"],
});
const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

// Every screen reads the session and the database at request time, so nothing is
// prerendered at build time (builds run without DATABASE_URL in CI).
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Ledgerly",
  description: "A creator marketplace on Whop rails",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body
        className={`${fraunces.variable} ${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
        <TourShell />
      </body>
    </html>
  );
}
