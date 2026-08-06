import type { NextAuthConfig } from "next-auth";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import { SESSION_ABSOLUTE_DURATION_SECONDS, readRawSessionExpiryState, isAbsoluteSessionExpired } from "@/lib/session-expiry";

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
    // CRITICAL: middleware.ts constructs its OWN `NextAuth(authConfig)`
    // instance (edge runtime, no Prisma) — separate from the full app
    // config in lib/auth.ts (`NextAuth({ ...authConfig, callbacks: {...} })`
    // REPLACES the whole `callbacks` object via spread, it does not merge
    // per-key). Without a `jwt` callback defined HERE too, middleware's own
    // session resolution would use Auth.js's default passthrough jwt
    // callback — which never checks `absoluteSessionExpiresAt` at all —
    // meaning `auth.user` below would still look "logged in" for an
    // absolute-expired token, and the `authorized` callback's expired-
    // session branch could never be reached. This is the SAME rejection
    // check as lib/auth.ts's jwt callback (kept in sync manually since one
    // lives in an edge-safe config and the other doesn't need to be), minus
    // the sign-in/stamping logic — middleware only ever needs to REJECT an
    // already-expired token, never to stamp a new one (that only happens
    // during the real sign-in flow, handled entirely by lib/auth.ts).
    async jwt({ token }) {
      if (isAbsoluteSessionExpired(token.absoluteSessionExpiresAt)) return null;
      return token;
    },
    async authorized({ auth, request }) {
      const { nextUrl } = request;
      const isLoggedIn = !!auth?.user;
      const isPublic = PUBLIC_PATHS.some((p) =>
        nextUrl.pathname.startsWith(p)
      );
      if (isPublic) return true;
      if (PUBLIC_API_TRANSPORT_PATHS.has(nextUrl.pathname)) return true;

      if (!isLoggedIn) {
        // `auth` resolves to `null` for BOTH "never signed in" and "signed
        // in, but the absolute 8h session window has passed" (see
        // lib/auth.ts's jwt callback — it returns `null` once expired,
        // which is indistinguishable from no-session-at-all by the time it
        // reaches here). Recover the distinction with a raw, non-re-signing
        // token decode purely to pick the right response contract below —
        // this ONLY adds new handling for the genuinely-new "expired" case;
        // the pre-existing "never authenticated" `return false` path a few
        // lines down is completely unchanged.
        const rawState = await readRawSessionExpiryState({ headers: request.headers });
        if (rawState.hasToken && rawState.isExpired) {
          const isApiRequest = nextUrl.pathname.startsWith("/api/");
          if (isApiRequest) {
            // Central, single-point enforcement for every API route this
            // middleware matches (which is effectively all of them — see
            // `config.matcher` in middleware.ts) — a stale/expired session
            // can never reach an individual route handler at all, so there
            // is no per-route code to keep in sync with this contract.
            return new Response(
              JSON.stringify({
                code: "SESSION_EXPIRED",
                error: "Your session has expired after 8 hours. Please sign in again.",
                message: "Your session has expired after 8 hours. Please sign in again.",
              }),
              { status: 401, headers: { "content-type": "application/json" } }
            );
          }
          const loginUrl = new URL("/login", nextUrl);
          loginUrl.searchParams.set("message", "session_expired");
          loginUrl.searchParams.set("callbackUrl", nextUrl.href);
          return Response.redirect(loginUrl);
        }
        return false;
      }

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
    // Absolute upper bound for the session cookie's own technical
    // lifetime — necessary hygiene (also directly requested), but NOT the
    // primary enforcement mechanism: Auth.js's JWT-session implementation
    // re-signs (and re-extends) this cookie on every session read
    // regardless of this value, which is exactly the sliding-expiration
    // behavior lib/auth.ts's jwt/session callbacks explicitly override via
    // the separate, non-sliding `absoluteSessionExpiresAt` field. Setting
    // maxAge here just means that override can never even need to reach
    // further than 8h in the first place.
    maxAge: SESSION_ABSOLUTE_DURATION_SECONDS,
  },
  jwt: {
    maxAge: SESSION_ABSOLUTE_DURATION_SECONDS,
  },
} satisfies NextAuthConfig;
