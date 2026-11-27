-- Project Status trigger consistency (follow-up to 20261129090000).
--
-- Replaces ONLY the function behind the project_status_definition_sync
-- trigger (no table, column, index or data change). The trigger stays a
-- DATA-INTEGRITY backstop for writers that bypass the application
-- (scripts, raw SQL); it implements no lifecycle workflow — completion,
-- reopening, Feedback obligations and notifications remain exclusively in
-- the application (PATCH /api/projects/[id]).
--
-- Semantics now match lib/services/project-status-service.ts
-- resolveProjectStatusWrite for canonical-only writes:
--  * canonical state unchanged (or definition supplied explicitly): the
--    definition is kept as-is — an existing custom (even inactive) status
--    is never replaced;
--  * canonical state changed with the definition untouched (or an INSERT
--    with no definition): the ACTIVE system definition of the new state,
--    else the first ACTIVE definition mapped to it (sortOrder, then id);
--    NEVER an inactive one — if none is active the write is rejected
--    (project_status_no_active_definition);
--  * the stored definition must always map to the stored canonical state
--    (project_status_mismatch).
--
-- Concurrency: every definition read takes FOR SHARE on that definition
-- row, so a concurrent remap (UPDATE of "canonicalStatus", which locks the
-- row) and a Project assignment serialize: whichever commits second sees
-- the other's committed result and is rejected if it would break
-- consistency (the remap via project_status_definition_guard's EXISTS
-- check, the assignment via project_status_mismatch).

CREATE OR REPLACE FUNCTION project_status_definition_sync() RETURNS trigger AS $$
DECLARE
  current_canonical "ProjectStatus";
BEGIN
  IF NEW."statusDefinitionId" IS NULL
     OR (TG_OP = 'UPDATE' AND NEW."status" IS DISTINCT FROM OLD."status"
         AND NEW."statusDefinitionId" IS NOT DISTINCT FROM OLD."statusDefinitionId") THEN
    SELECT "canonicalStatus" INTO current_canonical FROM "ProjectStatusDefinition"
      WHERE "id" = NEW."statusDefinitionId" FOR SHARE;
    IF current_canonical IS DISTINCT FROM NEW."status" THEN
      NEW."statusDefinitionId" := NULL;
      SELECT "id" INTO NEW."statusDefinitionId" FROM "ProjectStatusDefinition"
        WHERE "canonicalStatus" = NEW."status" AND "isActive"
        ORDER BY "isSystem" DESC, "sortOrder" ASC, "id" ASC
        LIMIT 1
        FOR SHARE;
      IF NEW."statusDefinitionId" IS NULL THEN
        RAISE EXCEPTION 'project_status_no_active_definition: no active Project Status represents %', NEW."status"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  SELECT "canonicalStatus" INTO current_canonical FROM "ProjectStatusDefinition"
    WHERE "id" = NEW."statusDefinitionId" FOR SHARE;
  IF current_canonical IS NULL OR current_canonical <> NEW."status" THEN
    RAISE EXCEPTION 'project_status_mismatch: definition % does not map to canonical status %', NEW."statusDefinitionId", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
