\set ON_ERROR_STOP on

-- TicketApp destructive data reset for legacy migration.
--
-- Safe by default:
--   psql -f reset-ticketapp.sql                 -> DRY RUN
--   psql -v execute_reset=true -f reset-ticketapp.sql -> EXECUTE
--
-- Final intended state:
--   * User: only admin@kinsen.gr
--   * CustomRole: only key=ADMIN
--   * Department roles: none
--   * Permission definitions: preserved
--   * Permission mappings: only mappings belonging to ADMIN/admin user
--   * Departments / memberships: empty
--   * Microsoft mappings: empty
--   * Tickets / comments / attachment DB rows / history: empty
--   * Projects / activities / notifications: empty
--   * Other application data: empty
--   * _prisma_migrations: preserved
--
-- Physical attachment files stored outside PostgreSQL are NOT deleted by this script.

\if :{?execute_reset}
\else
\set execute_reset false
\endif

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = 0;
SET LOCAL client_min_messages = notice;

CREATE TEMP TABLE "_reset_params"
(
    "admin_email"   text    NOT NULL,
    "execute_reset" boolean NOT NULL
)
ON COMMIT DROP;

INSERT INTO "_reset_params" ("admin_email", "execute_reset")
VALUES ('admin@kinsen.gr', :'execute_reset'::boolean);

CREATE TEMP TABLE "_reset_keep_rows"
(
    "keep_id"   bigserial PRIMARY KEY,
    "table_oid" oid   NOT NULL,
    "row_data"  jsonb NOT NULL,
    "reason"    text  NOT NULL
)
ON COMMIT DROP;

-- Prevent the same row being backed up more than once.
CREATE UNIQUE INDEX "_reset_keep_rows_unique"
ON "_reset_keep_rows" ("table_oid", md5("row_data"::text));

CREATE TEMP TABLE "_reset_restored_rows"
(
    "keep_id" bigint PRIMARY KEY
)
ON COMMIT DROP;

DO $reset$
DECLARE
    v_admin_email       text;
    v_execute           boolean;
    v_admin_count       integer;
    v_admin_role_count  integer;
    v_user_count        integer;
    v_role_count        integer;
    v_progress          integer;
    v_pending           integer;
    v_sql               text;
    v_columns           text;
    v_predicate         text;
    v_schema            text;
    v_table             text;
    v_json_value        jsonb;
    v_max_value         bigint;
    v_bad_count         bigint;
    i                   integer;
    r                   record;
    fk                  record;
BEGIN
    SELECT "admin_email", "execute_reset"
      INTO v_admin_email, v_execute
      FROM "_reset_params"
     LIMIT 1;

    -- Hard safety checks: this file is intentionally tied to the production DB name.
    IF current_database() <> 'kinsen_helpdesk' THEN
        RAISE EXCEPTION
            'RESET ABORTED: connected to database %, expected kinsen_helpdesk.',
            current_database();
    END IF;

    IF to_regclass('public."User"') IS NULL THEN
        RAISE EXCEPTION 'RESET ABORTED: public."User" does not exist.';
    END IF;

    IF to_regclass('public."CustomRole"') IS NULL THEN
        RAISE EXCEPTION 'RESET ABORTED: public."CustomRole" does not exist.';
    END IF;

    IF to_regclass('public."Permission"') IS NULL THEN
        RAISE EXCEPTION 'RESET ABORTED: public."Permission" does not exist.';
    END IF;

    SELECT count(*)
      INTO v_admin_count
      FROM public."User"
     WHERE lower("email") = lower(v_admin_email);

    IF v_admin_count <> 1 THEN
        RAISE EXCEPTION
            'RESET ABORTED: admin email % matched % User rows; expected exactly 1.',
            v_admin_email,
            v_admin_count;
    END IF;

    SELECT count(*)
      INTO v_admin_role_count
      FROM public."CustomRole"
     WHERE "key" = 'ADMIN';

    IF v_admin_role_count <> 1 THEN
        RAISE EXCEPTION
            'RESET ABORTED: CustomRole key ADMIN matched % rows; expected exactly 1.',
            v_admin_role_count;
    END IF;

    -- Composite FKs on User/CustomRole are deliberately rejected rather than guessed.
    IF EXISTS
    (
        SELECT 1
          FROM pg_constraint con
          JOIN pg_class child ON child.oid = con.conrelid
          JOIN pg_namespace ns ON ns.oid = child.relnamespace
         WHERE con.contype = 'f'
           AND ns.nspname = 'public'
           AND child.relname IN ('User', 'CustomRole')
           AND array_length(con.conkey, 1) <> 1
    ) THEN
        RAISE EXCEPTION
            'RESET ABORTED: composite FK detected on User or CustomRole. Review schema before reset.';
    END IF;

    RAISE NOTICE '============================================================';
    RAISE NOTICE 'TicketApp clean reset';
    RAISE NOTICE 'Database       : %', current_database();
    RAISE NOTICE 'Administrator  : %', v_admin_email;
    RAISE NOTICE 'Execute reset  : %', v_execute;
    RAISE NOTICE '============================================================';

    -- ---------------------------------------------------------------------
    -- Preserve the single administrator user.
    -- ---------------------------------------------------------------------
    INSERT INTO "_reset_keep_rows" ("table_oid", "row_data", "reason")
    SELECT 'public."User"'::regclass::oid,
           to_jsonb(u),
           'Administrator user'
      FROM public."User" u
     WHERE lower(u."email") = lower(v_admin_email)
    ON CONFLICT DO NOTHING;

    -- ---------------------------------------------------------------------
    -- Preserve only the ADMIN CustomRole.
    -- ---------------------------------------------------------------------
    INSERT INTO "_reset_keep_rows" ("table_oid", "row_data", "reason")
    SELECT 'public."CustomRole"'::regclass::oid,
           to_jsonb(cr),
           'Administrator global role'
      FROM public."CustomRole" cr
     WHERE cr."key" = 'ADMIN'
    ON CONFLICT DO NOTHING;

    -- ---------------------------------------------------------------------
    -- Sanitize the preserved User row.
    --
    -- User -> CustomRole : point it to ADMIN.
    -- User -> User       : NULL if nullable; self if required.
    -- User -> anything else (Department, Company, etc.): NULL if nullable.
    -- Required non-role dependencies cause an abort because they would make
    -- the requested "no departments / no mappings" final state impossible.
    -- ---------------------------------------------------------------------
    FOR fk IN
        SELECT parent.relname AS parent_table,
               child_col.attname AS child_column,
               parent_col.attname AS parent_column,
               child_col.attnotnull AS child_not_null
          FROM pg_constraint con
          JOIN pg_class child
            ON child.oid = con.conrelid
          JOIN pg_namespace child_ns
            ON child_ns.oid = child.relnamespace
          JOIN pg_class parent
            ON parent.oid = con.confrelid
          JOIN pg_namespace parent_ns
            ON parent_ns.oid = parent.relnamespace
          JOIN pg_attribute child_col
            ON child_col.attrelid = child.oid
           AND child_col.attnum = con.conkey[1]
          JOIN pg_attribute parent_col
            ON parent_col.attrelid = parent.oid
           AND parent_col.attnum = con.confkey[1]
         WHERE con.contype = 'f'
           AND child_ns.nspname = 'public'
           AND parent_ns.nspname = 'public'
           AND child.relname = 'User'
           AND array_length(con.conkey, 1) = 1
    LOOP
        IF fk.parent_table = 'CustomRole' THEN
            SELECT to_jsonb(cr) -> fk.parent_column
              INTO v_json_value
              FROM public."CustomRole" cr
             WHERE cr."key" = 'ADMIN'
             LIMIT 1;

            UPDATE "_reset_keep_rows"
               SET "row_data" = jsonb_set(
                       "row_data",
                       ARRAY[fk.child_column],
                       v_json_value,
                       false
                   )
             WHERE "table_oid" = 'public."User"'::regclass::oid;

        ELSIF fk.parent_table = 'User' THEN
            IF fk.child_not_null THEN
                SELECT to_jsonb(u) -> fk.parent_column
                  INTO v_json_value
                  FROM public."User" u
                 WHERE lower(u."email") = lower(v_admin_email)
                 LIMIT 1;

                UPDATE "_reset_keep_rows"
                   SET "row_data" = jsonb_set(
                           "row_data",
                           ARRAY[fk.child_column],
                           v_json_value,
                           false
                       )
                 WHERE "table_oid" = 'public."User"'::regclass::oid;
            ELSE
                UPDATE "_reset_keep_rows"
                   SET "row_data" = jsonb_set(
                           "row_data",
                           ARRAY[fk.child_column],
                           'null'::jsonb,
                           false
                       )
                 WHERE "table_oid" = 'public."User"'::regclass::oid;
            END IF;

        ELSE
            IF fk.child_not_null THEN
                RAISE EXCEPTION
                    'RESET ABORTED: User.% has a required FK to %. The requested empty reference data state is not safe.',
                    fk.child_column,
                    fk.parent_table;
            END IF;

            UPDATE "_reset_keep_rows"
               SET "row_data" = jsonb_set(
                       "row_data",
                       ARRAY[fk.child_column],
                       'null'::jsonb,
                       false
                   )
             WHERE "table_oid" = 'public."User"'::regclass::oid;
        END IF;
    END LOOP;

    -- ---------------------------------------------------------------------
    -- Sanitize optional dependencies on the ADMIN CustomRole row itself.
    -- ---------------------------------------------------------------------
    FOR fk IN
        SELECT parent.relname AS parent_table,
               child_col.attname AS child_column,
               parent_col.attname AS parent_column,
               child_col.attnotnull AS child_not_null
          FROM pg_constraint con
          JOIN pg_class child
            ON child.oid = con.conrelid
          JOIN pg_namespace child_ns
            ON child_ns.oid = child.relnamespace
          JOIN pg_class parent
            ON parent.oid = con.confrelid
          JOIN pg_namespace parent_ns
            ON parent_ns.oid = parent.relnamespace
          JOIN pg_attribute child_col
            ON child_col.attrelid = child.oid
           AND child_col.attnum = con.conkey[1]
          JOIN pg_attribute parent_col
            ON parent_col.attrelid = parent.oid
           AND parent_col.attnum = con.confkey[1]
         WHERE con.contype = 'f'
           AND child_ns.nspname = 'public'
           AND parent_ns.nspname = 'public'
           AND child.relname = 'CustomRole'
           AND array_length(con.conkey, 1) = 1
    LOOP
        IF fk.parent_table = 'User' THEN
            IF fk.child_not_null THEN
                SELECT to_jsonb(u) -> fk.parent_column
                  INTO v_json_value
                  FROM public."User" u
                 WHERE lower(u."email") = lower(v_admin_email)
                 LIMIT 1;

                UPDATE "_reset_keep_rows"
                   SET "row_data" = jsonb_set(
                           "row_data",
                           ARRAY[fk.child_column],
                           v_json_value,
                           false
                       )
                 WHERE "table_oid" = 'public."CustomRole"'::regclass::oid;
            ELSE
                UPDATE "_reset_keep_rows"
                   SET "row_data" = jsonb_set(
                           "row_data",
                           ARRAY[fk.child_column],
                           'null'::jsonb,
                           false
                       )
                 WHERE "table_oid" = 'public."CustomRole"'::regclass::oid;
            END IF;

        ELSIF fk.parent_table = 'CustomRole' THEN
            IF fk.child_not_null THEN
                SELECT to_jsonb(cr) -> fk.parent_column
                  INTO v_json_value
                  FROM public."CustomRole" cr
                 WHERE cr."key" = 'ADMIN'
                 LIMIT 1;

                UPDATE "_reset_keep_rows"
                   SET "row_data" = jsonb_set(
                           "row_data",
                           ARRAY[fk.child_column],
                           v_json_value,
                           false
                       )
                 WHERE "table_oid" = 'public."CustomRole"'::regclass::oid;
            ELSE
                UPDATE "_reset_keep_rows"
                   SET "row_data" = jsonb_set(
                           "row_data",
                           ARRAY[fk.child_column],
                           'null'::jsonb,
                           false
                       )
                 WHERE "table_oid" = 'public."CustomRole"'::regclass::oid;
            END IF;

        ELSE
            IF fk.child_not_null THEN
                RAISE EXCEPTION
                    'RESET ABORTED: CustomRole.% has a required FK to %. Review schema before reset.',
                    fk.child_column,
                    fk.parent_table;
            END IF;

            UPDATE "_reset_keep_rows"
               SET "row_data" = jsonb_set(
                       "row_data",
                       ARRAY[fk.child_column],
                       'null'::jsonb,
                       false
                   )
             WHERE "table_oid" = 'public."CustomRole"'::regclass::oid;
        END IF;
    END LOOP;

    -- ---------------------------------------------------------------------
    -- Preserve permission infrastructure.
    --
    -- Definition-style permission tables are preserved in full.
    -- Role/User permission relation tables are filtered so only ADMIN/admin
    -- mappings survive.
    -- Audit/history/log/mapping tables are deliberately excluded.
    -- ---------------------------------------------------------------------
    FOR r IN
        SELECT c.oid,
               ns.nspname AS schema_name,
               c.relname AS table_name
          FROM pg_class c
          JOIN pg_namespace ns ON ns.oid = c.relnamespace
         WHERE ns.nspname = 'public'
           AND c.relkind IN ('r', 'p')
           AND c.relname ~* 'Permission'
           AND c.relname !~* '(Audit|History|Log|Mapping)'
         ORDER BY c.relname
    LOOP
        v_predicate := 'TRUE';

        -- Restrict any FK to CustomRole to ADMIN.
        FOR fk IN
            SELECT parent_ns.nspname AS parent_schema,
                   parent.relname AS parent_table,
                   (
                       SELECT string_agg(
                           format(
                               'c.%I IS NOT DISTINCT FROM p.%I',
                               ca.attname,
                               pa.attname
                           ),
                           ' AND '
                           ORDER BY ck.ordinality
                       )
                         FROM unnest(con.conkey)
                              WITH ORDINALITY ck(attnum, ordinality)
                         JOIN unnest(con.confkey)
                              WITH ORDINALITY pk(attnum, ordinality)
                           ON pk.ordinality = ck.ordinality
                         JOIN pg_attribute ca
                           ON ca.attrelid = child.oid
                          AND ca.attnum = ck.attnum
                         JOIN pg_attribute pa
                           ON pa.attrelid = parent.oid
                          AND pa.attnum = pk.attnum
                   ) AS join_condition
              FROM pg_constraint con
              JOIN pg_class child ON child.oid = con.conrelid
              JOIN pg_class parent ON parent.oid = con.confrelid
              JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
             WHERE con.contype = 'f'
               AND con.conrelid = r.oid
               AND parent_ns.nspname = 'public'
               AND parent.relname IN ('CustomRole', 'User')
        LOOP
            IF fk.parent_table = 'CustomRole' THEN
                v_predicate := v_predicate || format(
                    ' AND EXISTS (
                        SELECT 1
                          FROM %I.%I p
                         WHERE p."key" = ''ADMIN''
                           AND %s
                    )',
                    fk.parent_schema,
                    fk.parent_table,
                    fk.join_condition
                );
            ELSIF fk.parent_table = 'User' THEN
                v_predicate := v_predicate || format(
                    ' AND EXISTS (
                        SELECT 1
                          FROM %I.%I p
                         WHERE lower(p."email") = lower(%L)
                           AND %s
                    )',
                    fk.parent_schema,
                    fk.parent_table,
                    v_admin_email,
                    fk.join_condition
                );
            END IF;
        END LOOP;

        v_sql := format(
            $sql$
            INSERT INTO "_reset_keep_rows" ("table_oid", "row_data", "reason")
            SELECT %s::oid,
                   to_jsonb(c),
                   %L
              FROM %I.%I c
             WHERE %s
            ON CONFLICT DO NOTHING
            $sql$,
            r.oid,
            'Permission infrastructure: ' || r.table_name,
            r.schema_name,
            r.table_name,
            v_predicate
        );

        EXECUTE v_sql;
    END LOOP;

    -- ---------------------------------------------------------------------
    -- Preview.
    -- ---------------------------------------------------------------------
    RAISE NOTICE '';
    RAISE NOTICE 'Rows that will survive:';

    FOR r IN
        SELECT ns.nspname AS schema_name,
               c.relname AS table_name,
               count(*) AS row_count
          FROM "_reset_keep_rows" k
          JOIN pg_class c ON c.oid = k."table_oid"
          JOIN pg_namespace ns ON ns.oid = c.relnamespace
         GROUP BY ns.nspname, c.relname
         ORDER BY c.relname
    LOOP
        RAISE NOTICE '  KEEP %.% -> % row(s)',
            r.schema_name,
            r.table_name,
            r.row_count;
    END LOOP;

    IF NOT v_execute THEN
        RAISE NOTICE '';
        RAISE NOTICE 'DRY RUN ONLY. No application data was deleted.';
        RAISE NOTICE 'Run with psql variable execute_reset=true to execute.';
        RETURN;
    END IF;

    -- ---------------------------------------------------------------------
    -- Destructive phase: truncate ALL public application tables except
    -- Prisma migration history. Temporary backup tables are in pg_temp and
    -- therefore are not affected.
    -- ---------------------------------------------------------------------
    SELECT string_agg(
               format('%I.%I', ns.nspname, c.relname),
               ', '
               ORDER BY c.relname
           )
      INTO v_sql
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND NOT c.relispartition
       AND c.relname <> '_prisma_migrations';

    IF v_sql IS NULL THEN
        RAISE EXCEPTION 'RESET ABORTED: no public application tables found.';
    END IF;

    RAISE NOTICE '';
    RAISE NOTICE 'Truncating application data...';

    EXECUTE 'TRUNCATE TABLE ' || v_sql || ' RESTART IDENTITY CASCADE';

    -- ---------------------------------------------------------------------
    -- Restore only the backed-up rows. Multiple passes allow FK parents to
    -- be restored before children without hardcoding table order.
    -- ---------------------------------------------------------------------
    FOR i IN 1..50 LOOP
        v_progress := 0;

        FOR r IN
            SELECT k."keep_id",
                   k."table_oid",
                   k."row_data"
              FROM "_reset_keep_rows" k
             WHERE NOT EXISTS
             (
                 SELECT 1
                   FROM "_reset_restored_rows" rr
                  WHERE rr."keep_id" = k."keep_id"
             )
             ORDER BY k."keep_id"
        LOOP
            SELECT ns.nspname, c.relname
              INTO v_schema, v_table
              FROM pg_class c
              JOIN pg_namespace ns ON ns.oid = c.relnamespace
             WHERE c.oid = r."table_oid";

            SELECT string_agg(format('%I', a.attname), ', ' ORDER BY a.attnum)
              INTO v_columns
              FROM pg_attribute a
             WHERE a.attrelid = r."table_oid"
               AND a.attnum > 0
               AND NOT a.attisdropped
               AND a.attgenerated = '';

            BEGIN
                v_sql := format(
                    $sql$
                    INSERT INTO %I.%I (%s)
                    OVERRIDING SYSTEM VALUE
                    SELECT %s
                      FROM jsonb_populate_record(NULL::%I.%I, $1)
                    $sql$,
                    v_schema,
                    v_table,
                    v_columns,
                    v_columns,
                    v_schema,
                    v_table
                );

                EXECUTE v_sql USING r."row_data";

                INSERT INTO "_reset_restored_rows" ("keep_id")
                VALUES (r."keep_id");

                v_progress := v_progress + 1;

            EXCEPTION
                WHEN foreign_key_violation THEN
                    -- Parent row may be restored in another pass.
                    NULL;
            END;
        END LOOP;

        SELECT count(*)
          INTO v_pending
          FROM "_reset_keep_rows" k
         WHERE NOT EXISTS
         (
             SELECT 1
               FROM "_reset_restored_rows" rr
              WHERE rr."keep_id" = k."keep_id"
         );

        EXIT WHEN v_pending = 0;

        IF v_progress = 0 THEN
            RAISE EXCEPTION
                'RESET ABORTED: % preserved rows could not be restored because of unresolved FK dependencies.',
                v_pending;
        END IF;
    END LOOP;

    -- ---------------------------------------------------------------------
    -- Final invariants. Any failure aborts the surrounding transaction.
    -- ---------------------------------------------------------------------
    SELECT count(*) INTO v_user_count FROM public."User";

    IF v_user_count <> 1 THEN
        RAISE EXCEPTION
            'FINAL CHECK FAILED: expected exactly 1 User, found %.',
            v_user_count;
    END IF;

    IF NOT EXISTS
    (
        SELECT 1
          FROM public."User"
         WHERE lower("email") = lower(v_admin_email)
    ) THEN
        RAISE EXCEPTION 'FINAL CHECK FAILED: administrator user is missing.';
    END IF;

    SELECT count(*) INTO v_role_count FROM public."CustomRole";

    IF v_role_count <> 1 THEN
        RAISE EXCEPTION
            'FINAL CHECK FAILED: expected exactly 1 CustomRole, found %.',
            v_role_count;
    END IF;

    IF NOT EXISTS
    (
        SELECT 1
          FROM public."CustomRole"
         WHERE "key" = 'ADMIN'
    ) THEN
        RAISE EXCEPTION 'FINAL CHECK FAILED: ADMIN CustomRole is missing.';
    END IF;

    -- Department roles must be empty. With only ADMIN in CustomRole this
    -- should already be true; the explicit check makes the intent enforceable.
    IF EXISTS
    (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'CustomRole'
           AND column_name = 'scope'
    ) THEN
        SELECT count(*)
          INTO v_bad_count
          FROM public."CustomRole"
         WHERE "key" <> 'ADMIN'
            OR "scope"::text = 'DEPARTMENT';

        IF v_bad_count <> 0 THEN
            RAISE EXCEPTION
                'FINAL CHECK FAILED: non-admin or department CustomRole survived.';
        END IF;
    END IF;

    -- Departments and mapping tables must be empty.
    FOR r IN
        SELECT c.oid,
               ns.nspname AS schema_name,
               c.relname AS table_name
          FROM pg_class c
          JOIN pg_namespace ns ON ns.oid = c.relnamespace
         WHERE ns.nspname = 'public'
           AND c.relkind IN ('r', 'p')
           AND c.relname ~* '(Department|Mapping)'
           AND c.relname <> '_prisma_migrations'
    LOOP
        EXECUTE format('SELECT count(*) FROM %I.%I', r.schema_name, r.table_name)
           INTO v_bad_count;

        IF v_bad_count <> 0 THEN
            RAISE EXCEPTION
                'FINAL CHECK FAILED: %.% still contains % row(s).',
                r.schema_name,
                r.table_name,
                v_bad_count;
        END IF;
    END LOOP;

    -- ---------------------------------------------------------------------
    -- Advance serial/identity sequences after restoring original IDs.
    -- ---------------------------------------------------------------------
    FOR r IN
        SELECT ns.nspname AS schema_name,
               c.relname AS table_name,
               a.attname AS column_name,
               pg_get_serial_sequence(
                   format('%I.%I', ns.nspname, c.relname),
                   a.attname
               ) AS sequence_name
          FROM pg_class c
          JOIN pg_namespace ns ON ns.oid = c.relnamespace
          JOIN pg_attribute a ON a.attrelid = c.oid
         WHERE ns.nspname = 'public'
           AND c.relkind IN ('r', 'p')
           AND a.attnum > 0
           AND NOT a.attisdropped
           AND pg_get_serial_sequence(
                   format('%I.%I', ns.nspname, c.relname),
                   a.attname
               ) IS NOT NULL
    LOOP
        EXECUTE format(
            'SELECT max(%I)::bigint FROM %I.%I',
            r.column_name,
            r.schema_name,
            r.table_name
        )
        INTO v_max_value;

        IF v_max_value IS NULL THEN
            PERFORM setval(r.sequence_name::regclass, 1, false);
        ELSE
            PERFORM setval(r.sequence_name::regclass, v_max_value, true);
        END IF;
    END LOOP;

    RAISE NOTICE '';
    RAISE NOTICE '============================================================';
    RAISE NOTICE 'RESET COMPLETED SUCCESSFULLY';
    RAISE NOTICE 'User             : admin@kinsen.gr only';
    RAISE NOTICE 'Global roles     : ADMIN only';
    RAISE NOTICE 'Department roles : none';
    RAISE NOTICE 'Departments      : empty';
    RAISE NOTICE 'Mappings         : empty';
    RAISE NOTICE 'Permission defs  : preserved';
    RAISE NOTICE 'Prisma migrations: preserved';
    RAISE NOTICE '============================================================';
END
$reset$;

COMMIT;
