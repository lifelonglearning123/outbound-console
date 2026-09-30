import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { listClients } from "@/lib/clients";
import { canSeeClient, currentUser } from "@/lib/auth";
import { Nav } from "@/components/Nav";

// Every page reads the database and depends on who is signed in, so nothing is prerendered at build time.
export const dynamic = "force-dynamic";
// AI writing and syncing run after responses (next/server after()); give them room on Vercel.
export const maxDuration = 300;

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Outbound Console",
  description: "Multi-client cold email control room on top of Instantly",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const user = await currentUser();
  // Signed out (login / setup pages): no menu, and no client names.
  const clients = user
    ? (await listClients()).filter((c) => canSeeClient(user, c.id)).map((c) => ({ id: c.id, name: c.name, keyStatus: c.key_status }))
    : [];
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full font-sans">
        {user && <Nav clients={clients} user={{ email: user.email, isAdmin: user.role === "admin" }} />}
        <main className="min-w-0 flex-1 px-8 py-6 print:p-0">{children}</main>
      </body>
    </html>
  );
}
