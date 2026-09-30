import type { Metadata } from "next";
import { Commissioner } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { SessionProvider } from "next-auth/react";
import { auth } from "@/lib/auth";
import { NavigationLoader } from "@/components/layout/navigation-loader";
import { THEME_INIT_SCRIPT } from "@/components/theme/theme-script";

// Commissioner: a Greek-designed grotesk with full Greek coverage — staff
// names and department names are often Greek even though the UI is English.
const commissioner = Commissioner({ subsets: ["latin", "greek"], variable: "--font-sans", display: "swap" });

export const metadata: Metadata = {
  title: "Kinsen IT Helpdesk",
  description: "Kinsen's internal workspace for requests, projects and activities",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  return (
    <html lang="en" suppressHydrationWarning className={commissioner.variable}>
      <head>
        {/* Applies the saved light/dark preference before first paint. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="font-sans">
        <SessionProvider session={session}>
          {children}
          <Toaster richColors position="top-right" />
          <NavigationLoader />
        </SessionProvider>
      </body>
    </html>
  );
}
