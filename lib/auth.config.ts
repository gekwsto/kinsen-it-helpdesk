import type { NextAuthConfig } from "next-auth";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";

const ALLOWED_DOMAIN = process.env.ALLOWED_EMAIL_DOMAIN || "kinsen.gr";

const PUBLIC_PATHS = [
  "/login",
  "/unauthorized",
  "/api/auth",
  "/api/email/inbound",
];

const TENANT_ID = process.env.AUTH_MICROSOFT_ENTRA_ID_TENANT_ID;

// NOTE: the provider config key is `issuer`, not `tenantId` — the latter is
// silently ignored at runtime by this package version. Without an `issuer`
// pinned to our tenant, Auth.js falls back to the multi-tenant "common"
// endpoint, which would accept sign-ins from *any* Microsoft/Entra tenant.
const microsoftIssuer = TENANT_ID
  ? `https://login.microsoftonline.com/${TENANT_ID}/v2.0`
  : undefined;

export const authConfig = {
  trustHost: true,
  providers: [
    MicrosoftEntraID({
      clientId: process.env.AUTH_MICROSOFT_ENTRA_ID_ID!,
      clientSecret: process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET!,
      issuer: microsoftIssuer,
      authorization: {
        params: {
          scope: "openid profile email User.Read",
        },
      },
      // Auto-link a Microsoft sign-in to an existing User row with the same
      // email (e.g. one created via credentials/admin) instead of erroring
      // out or creating a duplicate. This is only safe because sign-in is
      // already pinned to our own Entra tenant (`issuer` above) and further
      // gated to @<ALLOWED_DOMAIN> in the `signIn` callback (lib/auth.ts) — an
      // attacker cannot get a token bearing an existing user's email unless
      // they already control that identity in our own tenant. If the tenant
      // isn't configured (falls back to the multi-tenant "common" endpoint),
      // this is disabled since email would no longer be a trustworthy signal.
      allowDangerousEmailAccountLinking: Boolean(TENANT_ID),
    }),
  ],
  callbacks: {
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user;
      const isPublic = PUBLIC_PATHS.some((p) =>
        nextUrl.pathname.startsWith(p)
      );
      if (isPublic) return true;
      if (!isLoggedIn) return false;
      const email = auth?.user?.email;
      if (
        email &&
        !email.toLowerCase().endsWith(`@${ALLOWED_DOMAIN}`)
      ) {
        return false;
      }
      return true;
    },
  },
  pages: {
    signIn: "/login",
    error: "/unauthorized",
  },
  session: {
    strategy: "jwt",
  },
} satisfies NextAuthConfig;
