import { GlobalRoleSource, Role } from "@prisma/client";
import { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: Role;
      mustChangePassword: boolean;
      departmentId?: string;
      businessUnitId?: string;
      customRoleId?: string;
      // Entra `oid` — a stable, non-secret identity anchor. Deliberately NOT
      // accompanied by accessibleDepartments/activeDepartmentId: those would
      // go stale in the JWT between logins (see lib/services/workspace-service.ts
      // and department-scope-service.ts, which look them up fresh per request
      // instead). Never a raw Microsoft access/refresh token — those aren't
      // stored on the session at all.
      microsoftUserId?: string;
      // Provenance of `role` above — lets the UI (and future guardrails)
      // distinguish a Microsoft-mapped role from a manual admin override,
      // refreshed on every Microsoft sign-in (see
      // lib/services/microsoft-department-sync-service.ts).
      globalRoleSource?: GlobalRoleSource;
      // Absolute (non-sliding) application-session boundary — set once at
      // sign-in, epoch milliseconds (UTC), never recomputed by activity,
      // page refreshes, or Microsoft token refresh. See
      // lib/session-expiry.ts and lib/auth.ts's jwt/session callbacks.
      // Exposed to the client specifically so
      // components/auth/session-expiry-controller.tsx never has to
      // hardcode the 8h duration itself.
      loginAt?: number;
      absoluteSessionExpiresAt?: number;
    } & DefaultSession["user"];
  }

  interface User {
    role?: Role;
    mustChangePassword?: boolean;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    role?: Role;
    isActive?: boolean;
    mustChangePassword?: boolean;
    departmentId?: string | null;
    businessUnitId?: string | null;
    customRoleId?: string | null;
    microsoftUserId?: string | null;
    globalRoleSource?: GlobalRoleSource | null;
    // Set exactly once, on the initial sign-in branch of the jwt callback —
    // every subsequent invocation of that callback must preserve these
    // unchanged. See lib/session-expiry.ts.
    loginAt?: number;
    absoluteSessionExpiresAt?: number;
  }
}
