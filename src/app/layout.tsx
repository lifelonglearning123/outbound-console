import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { listClients } from "@/lib/clients";
import { Nav } from "@/components/Nav";

// Every page reads the local SQLite database, so nothing is prerendered at build time.
export const dynamic = "force-dynamic";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Outbound Console",
  description: "Multi-client cold email control room on top of Instantly",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  const clients = listClients().map((c) => ({ id: c.id, name: c.name, keyStatus: c.key_status }));
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full font-sans">
        <Nav clients={clients} />
        <main className="min-w-0 flex-1 px-8 py-6">{children}</main>
      </body>
    </html>
  );
}
