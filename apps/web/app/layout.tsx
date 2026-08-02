import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Harborline — disaster intelligence",
  description:
    "Verified, real-time disaster intelligence for Seattle and King County. Structured records determine the facts; language only restates them.",
  applicationName: "Harborline",
};

export const viewport: Viewport = {
  themeColor: "#0a0a0c",
  width: "device-width",
  initialScale: 1,
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="dark">
      <body className="min-h-dvh bg-hl-bg text-white antialiased">{children}</body>
    </html>
  );
}
