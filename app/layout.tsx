import type { Metadata, Viewport } from "next";
import "./globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  title: "ppt-live — Real-Time Presentations",
  description:
    "Upload your PowerPoint and present live. Share a room code so your audience can follow along in real-time.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <div className="bg-grid" aria-hidden="true" />
        <main className="page">{children}</main>
      </body>
    </html>
  );
}
