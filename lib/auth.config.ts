import type { NextAuthConfig } from "next-auth";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";

const ALLOWED_DOMAIN = process.env.ALLOWED_EMAIL_DOMAIN || "kinsen.gr";

const PUBLIC_PATHS = [
  "/login",
  "/unauthorized",
  "/api/auth",
  "/api/email/inbound",
];

// Exact-pathname bypass, checked separately from PUBLIC_PATHS's
// startsWith() matching on purpose — a startsWith("/api/integrations")
// entry would also make /api/admin/integrations* "public" at this layer
// (admin integration management must stay session + integration.manage
// protected, see app/api/admin/integrations/**). "Public" here means only
// "skip the NextAuth browser-session redirect" — the route itself still
// requires and strictly verifies its own server-to-server Bearer API key
// (see verifyIntegrationKey in lib/services/integration-key-service.ts);
// it is never unauthenticated. A session-less/invalid-key/disabled-
// integration request must get this endpoint's own JSON error contract
// (401/403/etc.), never an HTML /login redirect — Postman (and any real
// integration caller) auto-following a redirect to a 200 HTML login page
// is exactly the bug this fixes.
const PUBLIC_API_TRANSPORT_PATHS = new Set<string>([
  "/api/integrations/tickets",
]);

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
    {
      ...MicrosoftEntraID({
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
      // Overrides the built-in provider's own `profile()`, which otherwise
      // does an IMPLICIT, uncontrolled Graph call (GET /me/photos/48x48/$value,
      // no timeout) on every single Microsoft sign-in and stuffs the result
      // into `user.image` — Auth.js's adapter only ever persists that field
      // on brand-new-user creation, so for every returning user this fetch
      // ran and its result was silently discarded, on every login, forever
      // (the root cause this change fixes). Photo sync is now handled
      // explicitly and uniformly — for both new and existing users — by
      // lib/services/microsoft-profile-photo-service.ts (called from
      // lib/services/microsoft-department-sync-service.ts), which adds a
      // real timeout, ETag caching, structured logging, and the
      // manual-avatar overwrite protection. This override just reproduces
      // the built-in profile()'s shape minus the photo fetch.
      profile(profile: { sub: string; name?: string; email?: string }) {
        return { id: profile.sub, name: profile.name, email: profile.email, image: null };
      },
    },
  ],
  callbacks: {
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user;
      const isPublic = PUBLIC_PATHS.some((p) =>
        nextUrl.pathname.startsWith(p)
      );
      if (isPublic) return true;
      if (PUBLIC_API_TRANSPORT_PATHS.has(nextUrl.pathname)) return true;
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
