import type { Metadata, Viewport } from "next";
import { PwaRegistration } from "@/components/pwa";
import "./globals.css";
export const metadata: Metadata = {
  title: "CrashGuard · Error monitoring, simplified",
  description: "A lightweight home for your application errors.",
  applicationName: "CrashGuard",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "CrashGuard",
    statusBarStyle: "black-translucent",
  },
  icons: { apple: "/icons/pwa-192.png" },
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
      <body>
        <PwaRegistration />
        {children}
      </body>
    </html>
  );
}
