# Working-days release — production deployment runbook

This release changes how Project and Activity durations are counted (working days, Monday–Friday) and converts existing stored durations with a **one-off, approval-gated backfill**. Nothing converts data automatically at application startup. Every data step below is run by hand from the `ops` container.

Run the whole sequence in one maintenance window. Users must not use the app between step 3 and step 10, because the new code and unconverted data would show inconsistent durations. The backfill itself is a single database transaction, so the database is never partially converted.

## What is deployed

| Item | Notes |
|---|---|
| Migration `20261125120000_add_project_duration_overrides` | Additive columns (override flags, `actualTotalDays`). Fills `actualTotalDays` in calendar days; the backfill converts it. |
| Migration `20261126090000_add_duration_backfill_ledger` | Additive tables `DurationBackfillRun` / `DurationBackfillChange` (record-level backup used by rollback). |
| `dist/ops/working-days-backfill.cjs` | The backfill CLI, compiled at image build (`npm run ops:build`). Needs only `node` and `@prisma/client`. |
| Compose service `kinsen-helpdesk-ops` | Profile `ops`, so it is **never** started by `docker compose up`. Used for migrations and the backfill. Output goes to `./ops-output/`. |

Shorthand used below:

```sh
OPS="docker compose --profile ops run --rm kinsen-helpdesk-ops"
BF="node dist/ops/working-days-backfill.cjs"
```

## Sequence

### 0. Before the window
- Record the currently running image so you can revert to it:
  `docker image tag kinsen-it-helpdesk-kinsen-helpdesk:latest kinsen-helpdesk:pre-working-days`
  (Use `docker compose images` to confirm the actual image name.)
- Build the new images without starting anything:
  `docker compose build kinsen-helpdesk && docker compose --profile ops build kinsen-helpdesk-ops`
- `mkdir -p ops-output`

### 1. Stop the application and every worker (keep the database running)
```sh
docker compose stop kinsen-helpdesk kinsen-helpdesk-email-poller kinsen-helpdesk-mention-reminder-worker \
  kinsen-helpdesk-project-request-setup-reminder-worker kinsen-helpdesk-sqlgeneral-user-sync-worker \
  kinsen-helpdesk-sqlgeneral-tree-snapshot-worker
```

### 2. Back up the database and verify the backup
```sh
docker compose exec -T kinsen-helpdesk-db pg_dump -U kinsen_user -d kinsen_helpdesk -Fc > ops-output/pre-working-days.dump
docker compose exec -T kinsen-helpdesk-db pg_restore -l < ops-output/pre-working-days.dump | grep -c "TABLE DATA"   # must be > 0
shasum -a 256 ops-output/pre-working-days.dump
```
Copy the dump off the host before continuing.

### 3. Apply pending migrations
```sh
$OPS npx prisma migrate status    # expect exactly the two migrations above to be pending
$OPS npx prisma migrate deploy
$OPS npx prisma migrate status    # "Database schema is up to date!"
```

### 4. Read-only impact report — APPROVAL CHECKPOINT
```sh
$OPS $BF report --out /out/pre-report
```
Review `ops-output/pre-report/working-days-impact.json` (counts per category, before/after financial totals, affected Project rollups) and `working-days-impact-records.csv` (every record that will change or will be preserved).

**Go / no-go decision by the approver.** Pay particular attention to these categories:
- `PRESERVE_UNVERIFIED`: the value can't be traced to its dates, so it is kept.
- `PRESERVE_AMBIGUOUS_SOURCE_TOTAL`: the value equals an import's explicitly supplied total, so it is kept.
- `FILL_MISSING`: an automatic duration was empty although both dates exist, so it will be filled. To skip these, add `--exclude-fill-missing` to step 6.

If the decision is no-go, use rollback path R1 below.

### 5. Snapshot (read-only, immediately before applying)
```sh
$OPS $BF snapshot --out /out/pre-snapshot.json
```

### 6. Controlled backfill (one transaction)
```sh
$OPS $BF apply --confirm "APPLY WORKING DAYS BACKFILL" > ops-output/apply.json
```
Record `runId` from `ops-output/apply.json`. You need it for validation and rollback.

### 7. Post-backfill validation (must report `"ok": true`)
```sh
$OPS $BF validate --before /out/pre-snapshot.json --run <runId> > ops-output/validate.json
```
This proves that:
- only the ledgered fields changed, each exactly from old to new;
- dates, statuses, completion timestamps, rate snapshots, manual costs and `updatedAt` are unchanged;
- a re-plan finds zero remaining writes;
- edit-page and detail/export values agree;
- financial totals equal the report's predicted totals.

Optionally, also check through the real API and Excel export (the ops image includes the dev tooling):
```sh
$OPS node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx \
  scripts/working-days-backfill/verify-views.ts --run <runId> --admin-email <an ADMIN user's email>
```
If validation fails, do not start the app. Use rollback path R2.

### 8. Confirm idempotency
```sh
$OPS $BF apply --confirm "APPLY WORKING DAYS BACKFILL"   # must say "Nothing to do"
$OPS $BF status                                           # exactly one APPLIED run
```

### 9. Start the application and workers
```sh
docker compose up -d
```
Smoke test: open a converted Project's detail and edit pages (the durations must match), one Activity, and an Excel export.

### 10. Close the window
Keep `ops-output/` (report, snapshot, apply/validate output, run id) and the dump together with the release record.

## Rollback

The old application is compatible with the new schema, because both migrations only add columns and tables with defaults. **Never roll back data without also rolling back the app, and never roll back the app without the data.** The old code counts calendar days and the new code counts working days, so a mix shows inconsistent durations.

**R1 — no-go at the approval checkpoint (step 4).** Data is unchanged.
```sh
docker image tag kinsen-helpdesk:pre-working-days kinsen-it-helpdesk-kinsen-helpdesk:latest
docker compose up -d --no-build
```
`actualTotalDays` is still in calendar days, but the old app doesn't read it.

**R2 — after applying, before reopening to users (steps 6–8).** Either:
- `$OPS $BF rollback --run <runId> --confirm "ROLLBACK WORKING DAYS BACKFILL"` restores every changed value and override flag exactly, in one transaction; or
- restore the full backup:
  `docker compose exec -T kinsen-helpdesk-db pg_restore -U kinsen_user -d kinsen_helpdesk --clean --if-exists < ops-output/pre-working-days.dump`

Then revert the image and start, as in R1.

**R3 — after reopening to users.** Do **not** restore the dump, because it would discard users' changes since go-live. Stop the app, then run:
```sh
$OPS $BF rollback --run <runId> --confirm "ROLLBACK WORKING DAYS BACKFILL"
```
Rollback only restores fields whose value is still exactly what the run wrote. If a field was edited since, rollback aborts and lists the conflicts. Review them, then re-run with `--skip-conflicts` to restore everything else, keeping users' later edits. Revert the image and start as in R1. Projects and Activities created after go-live keep their working-day values. List them with `updatedAt` / `createdAt` greater than the run's `appliedAt` and correct them manually if needed.

The schema is never rolled back. The additive columns and ledger tables are harmless to the old application.
