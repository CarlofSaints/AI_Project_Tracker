import type { Metadata } from "next";
import Link from "next/link";
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
  title: "AI Project CRM",
  description: "Every AI project across GitHub and Vercel, in one view.",
};

const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/organizations", label: "Clients & Customers" },
];

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
      <body className="min-h-full flex flex-col bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
        <header className="bg-white dark:bg-neutral-900">
          <div className="mx-auto flex max-w-[1600px] items-center gap-8 px-6 py-3">
            <Link href="/" className="flex items-center gap-2.5 text-sm font-semibold tracking-tight">
              {/* The wordmark stays at full contrast; the mark carries the brand.
                  A gradient across the text itself would drop the cyan end to
                  roughly 1.5:1 on white. */}
              <span
                aria-hidden
                className="h-4 w-4 rounded-[5px] bg-gradient-to-br from-[var(--brand)] to-[var(--brand-2)]"
              />
              AI Project CRM
            </Link>
            <nav className="flex gap-1">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded-md px-3 py-1.5 text-sm text-neutral-600 transition hover:bg-[var(--brand-soft)] hover:text-[var(--brand-text)] dark:text-neutral-400"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
          <div className="h-px bg-gradient-to-r from-[var(--brand)] via-[var(--brand-2)] to-transparent opacity-70" />
        </header>
        <main className="mx-auto w-full max-w-[1600px] flex-1 px-6 py-8">
          {children}
        </main>
      </body>
    </html>
  );
}
