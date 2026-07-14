# add_department_workspace_model — run procedure

## Status: authored, schema-validated, **not executed**

`migration.sql` and `backfill.sql` in this folder were hand-written against
this repo's existing migration conventions (matched against
`20260706130000_add_activity_dependencies` for enum/table/index/FK style),
because no reachable database was available in the environment they were
written in to generate them via `prisma migrate dev`'s normal shadow-database
diff.

What *was* verified offline, without a database connection (these only read
`prisma/schema.prisma`):

- `npx prisma format && npx prisma validate` — schema is syntactically and
  referentially valid.
- `npx prisma generate` — `@prisma/client` types generated successfully for
  every new/changed model.
- `npx tsc --noEmit` — the whole app (including the new service layer)
  compiles cleanly against those generated types.
- `npm run build` — production build passes.

What was **not** done, and must be done by you against a real database
before this is live:

1. Actually applying `migration.sql`.
2. Running `backfill.sql`.
3. Any integration test that touches real rows.

Review both SQL files before running them — ideally against a staging copy
of production data first, not production directly.

## Steps

1. **Back up your database.** This adds a required unique `slug` column to
   `Department` and changes `TicketCategory`'s unique constraint from a flat
   `name` to a composite `(departmentId, name)` — both are additive/safe by
   design, but back up before any migration regardless.

2. **Apply the schema migration.** From the repo root, with `DATABASE_URL`
   pointing at your target database:

   ```bash
   npx prisma migrate deploy
   ```

   This runs `migration.sql` (and records it in Prisma's `_prisma_migrations`
   table). If you'd rather have Prisma track this the normal way instead of
   applying the hand-written file as-is, you can alternatively run
   `npx prisma migrate dev` locally against an empty/throwaway database first
   to confirm Prisma's own diff matches this file, then adjust if it
   doesn't — but `migrate deploy` against this file directly is the intended
   path for staging/production.

3. **Run the backfill**, against the same database:

   ```bash
   psql "$DATABASE_URL" -f prisma/migrations/20260714120000_add_department_workspace_model/backfill.sql
   ```

   It's wrapped in a single transaction and only touches rows that still
   need it, so it's safe to re-run if interrupted.

4. **Verify** using the commented queries at the bottom of `backfill.sql`
   (row counts of remaining NULL `departmentId`, membership role
   distribution, department slugs).

5. **Regenerate the Prisma client in that environment**:

   ```bash
   npx prisma generate
   ```

6. Restart the app.

## What this migration does NOT do

- Does not make any `departmentId` column `NOT NULL` at the database level
  — "required going forward" is enforced in the Zod/API layer in Phase 2,
  not a schema constraint, specifically so this migration can never fail or
  block on unmigrated historical data.
- Does not touch `lib/auth.ts` or any API route — no runtime behavior
  changes for existing users. Everything added here is inert until Phase 2
  wires it in.
- Does not require any Microsoft/Entra ID tenant configuration changes to
  apply safely — the `MicrosoftDepartmentMapping` table is just data; it's
  empty of real mappings until an admin adds them (Phase 3) or the seed
  script's illustrative rows are used as a starting point.
