import { Role } from "@prisma/client";
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
  }
}
