import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { SessionProvider } from "next-auth/react";
import { auth } from "@/lib/auth";
import { NavigationLoader } from "@/components/layout/navigation-loader";
import { THEME_INIT_SCRIPT } from "@/components/theme/theme-script";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Kinsen IT Helpdesk",
  description: "Internal IT Support Ticketing System",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className={inter.className}>
        <SessionProvider session={session}>
          {children}
          <Toaster richColors position="top-right" />
          <NavigationLoader />
        </SessionProvider>
      </body>
    </html>
  );
}
