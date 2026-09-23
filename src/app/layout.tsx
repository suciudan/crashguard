import type { Metadata, Viewport } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "CrashGuard · Error monitoring, simplified",
  description: "A lightweight home for your application errors.",
};
export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#050816",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}
