import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/prisma";
import { Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import { authConfig } from "@/lib/auth.config";
import { adminLoginSchema as credentialsLoginSchema } from "@/lib/validations";

const ALLOWED_DOMAIN = process.env.ALLOWED_EMAIL_DOMAIN || "kinsen.gr";
const isDev = process.env.NODE_ENV === "development";

// Typed credential errors — codes flow through to SignInResponse.code on the client
class InactiveUserError extends CredentialsSignin {
  code = "inactive_user";
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
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

    async jwt({ token, user }) {
      // Runs only on first sign-in; subsequent requests reuse the existing token
      if (user?.email) {
        const dbUser = await prisma.user.findUnique({
          where: { email: user.email },
          select: {
            id: true,
            role: true,
            isActive: true,
            mustChangePassword: true,
            departmentId: true,
            businessUnitId: true,
            customRoleId: true,
          },
        });
        if (dbUser) {
          token.id = dbUser.id;
          token.role = dbUser.role;
          token.isActive = dbUser.isActive;
          token.mustChangePassword = dbUser.mustChangePassword;
          token.departmentId = dbUser.departmentId;
          token.businessUnitId = dbUser.businessUnitId;
          token.customRoleId = dbUser.customRoleId;
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
      }
      return session;
    },
  },

  secret: process.env.AUTH_SECRET,
});
