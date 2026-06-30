import type { NextAuthConfig } from "next-auth";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";

const ALLOWED_DOMAIN = process.env.ALLOWED_EMAIL_DOMAIN || "kinsen.gr";

const PUBLIC_PATHS = ["/login", "/unauthorized", "/api/auth", "/api/email/inbound"];

export const authConfig = {
  providers: [
    MicrosoftEntraID({
      clientId: process.env.AUTH_MICROSOFT_ENTRA_ID_ID!,
      clientSecret: process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET!,
      // @ts-expect-error tenantId is valid at runtime; type def omits it in this beta
      tenantId: process.env.AUTH_MICROSOFT_ENTRA_ID_TENANT_ID!,
      authorization: {
        params: { scope: "openid profile email User.Read" },
      },
    }),
  ],
  callbacks: {
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user;
      const isPublic = PUBLIC_PATHS.some((p) => nextUrl.pathname.startsWith(p));

      if (isPublic) return true;
      if (!isLoggedIn) return false;

      return true;
    },
  },
  pages: {
    signIn: "/login",
    error: "/unauthorized",
  },
  session: { strategy: "jwt" as const },
} satisfies NextAuthConfig;
