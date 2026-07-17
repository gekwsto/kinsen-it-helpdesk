import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/prisma";
import { GlobalRoleSource, Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import { authConfig } from "@/lib/auth.config";
import { adminLoginSchema as credentialsLoginSchema } from "@/lib/validations";
import { handleMicrosoftJwtSignIn, SYNC_ELIGIBLE_USER_SELECT } from "@/lib/services/microsoft-department-sync-service";

const ALLOWED_DOMAIN = process.env.ALLOWED_EMAIL_DOMAIN || "kinsen.gr";
const isDev = process.env.NODE_ENV === "development";

// Typed credential errors — codes flow through to SignInResponse.code on the client
class InactiveUserError extends CredentialsSignin {
  code = "inactive_user";
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  trustHost: true,
  adapter: PrismaAdapter(prisma),
  providers: [
    ...authConfig.providers,

    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const parsed = credentialsLoginSchema.safeParse(credentials);
        if (!parsed.success) return null;

        const { email, password } = parsed.data;

        const user = await prisma.user.findUnique({
          where: { email },
          select: {
            id: true,
            email: true,
            name: true,
            image: true,
            role: true,
            isActive: true,
            passwordHash: true,
            mustChangePassword: true,
          },
        });

        if (!user || !user.passwordHash) {
          if (isDev) console.log("[authorize] User not found or no password:", email);
          return null;
        }

        if (!user.isActive) {
          if (isDev) console.log("[authorize] Inactive account:", email);
          throw new InactiveUserError();
        }

        const isValid = await bcrypt.compare(password, user.passwordHash);
        if (!isValid) {
          if (isDev) console.log("[authorize] Wrong password for:", email);
          return null;
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
          role: user.role,
          mustChangePassword: user.mustChangePassword,
        };
      },
    }),
  ],

  callbacks: {
    async signIn({ user, account }) {
      if (account?.provider === "credentials") return true;

      // Microsoft SSO: domain check
      const email = user.email ?? "";
      if (!email.endsWith(`@${ALLOWED_DOMAIN}`)) {
        return `/unauthorized?reason=domain`;
      }

      return true;
    },

    async jwt({ token, user, account, profile }) {
      // Runs only on first sign-in; subsequent requests reuse the existing token
      if (user?.email) {
        // Look up by `user.id`, not a fresh findUnique-by-email: on this
        // exact call, `user` IS the row Auth.js's PrismaAdapter just
        // created or resolved (confirmed by reading
        // @auth/core/lib/actions/callback/handle-login.js — `createUser`/
        // `getUserByAccount`/`getUserByEmail` all run and their result is
        // what's passed in here as `user`, before jwt() is ever invoked).
        // Re-deriving the row via a second, independent email lookup was
        // the cause of a real bug: on a brand-new user's first Microsoft
        // sign-in, that redundant lookup could miss, silently skipping
        // Microsoft department/role sync until the user logged in again.
        // Trusting `user.id` directly removes that indirection entirely.
        let dbUser = user.id
          ? await prisma.user.findUnique({ where: { id: user.id }, select: SYNC_ELIGIBLE_USER_SELECT })
          : null;

        if (!dbUser) {
          // Defensive fallback only — `user.id` should always be present
          // per the Auth.js flow described above. If it's ever missing,
          // fall back to the old email lookup rather than silently
          // skipping sync, and log it so a real occurrence is visible.
          if (!user.id) console.warn("[auth] jwt callback: user.id missing on sign-in, falling back to email lookup", { email: user.email });
          dbUser = await prisma.user.findUnique({ where: { email: user.email }, select: SYNC_ELIGIBLE_USER_SELECT });
        }

        if (dbUser) {
          // Microsoft login sync. The `department` signal is fetched live
          // from Microsoft Graph (GET /me) using this sign-in's delegated
          // access token — not from an ID-token claim, since the provider
          // (lib/auth.config.ts) only requests "openid profile email
          // User.Read" and department is never emitted as a claim under
          // that scope. User.Read is exactly what authorizes the Graph
          // GET /me call, so no extra Azure permission is needed.
          //
          // handleMicrosoftJwtSignIn awaits profile backfill + the sync +
          // a refetch, and returns the POST-sync row. Token fields below
          // are assigned from whatever this variable holds at that point —
          // for Microsoft sign-ins that's the fresh refetched row, not the
          // pre-sync snapshot fetched above (this is the fix for a real bug:
          // assigning token fields before the sync ran meant a brand-new
          // user's first-login token/session kept the stale default role
          // until a second login re-read the by-then-updated row).
          //
          // If the Graph call fails for any reason (missing/expired token,
          // 401/403/429, 5xx, network/timeout, malformed response), the
          // underlying sync logs a safe warning and skips itself for this
          // login — existing memberships (MANUAL or Microsoft-derived) are
          // left untouched and dbUser/token simply keep the pre-sync values.
          // Sign-in itself is never blocked by a Graph failure.
          //
          // groups/roles still come from the ID token (see msProfile below)
          // and remain empty until Azure AD is configured with a "groups"
          // claim and/or App Roles + a "roles" claim on the app
          // registration — Graph is deliberately not queried for those here.
          if (account?.provider === "microsoft-entra-id") {
            const msProfile = profile as
              | { oid?: string; department?: string; groups?: string[]; roles?: string[] }
              | undefined;

            dbUser = await handleMicrosoftJwtSignIn({
              dbUser,
              accessToken: account.access_token,
              oid: msProfile?.oid,
              providerAccountId: account.providerAccountId,
              userEmail: user.email,
              userName: user.name,
              userImage: user.image,
              fallbackGroups: msProfile?.groups,
              fallbackRoles: msProfile?.roles,
            });
          }

          // Single assignment point — always from whatever `dbUser` holds
          // right now (post-sync for Microsoft sign-ins, unchanged for
          // credentials sign-ins).
          token.id = dbUser.id;
          token.role = dbUser.role;
          token.isActive = dbUser.isActive;
          token.mustChangePassword = dbUser.mustChangePassword;
          token.departmentId = dbUser.departmentId;
          token.businessUnitId = dbUser.businessUnitId;
          token.customRoleId = dbUser.customRoleId;
          token.microsoftUserId = dbUser.microsoftUserId;
          token.globalRoleSource = dbUser.globalRoleSource;
        }
      }
      return token;
    },

    async session({ session, token }) {
      if (session.user) {
        if (token.isActive === false) return null as any;

        session.user.id = token.id as string;
        session.user.role = token.role as Role;
        session.user.mustChangePassword = (token.mustChangePassword as boolean) ?? false;
        session.user.departmentId = (token.departmentId as string | null) ?? undefined;
        session.user.businessUnitId = (token.businessUnitId as string | null) ?? undefined;
        session.user.customRoleId = (token.customRoleId as string | null) ?? undefined;
        session.user.microsoftUserId = (token.microsoftUserId as string | null) ?? undefined;
        session.user.globalRoleSource = (token.globalRoleSource as GlobalRoleSource) ?? undefined;
      }
      return session;
    },
  },

  secret: process.env.AUTH_SECRET,
});
