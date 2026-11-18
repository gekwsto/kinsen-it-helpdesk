#!/bin/sh
# Deploy-time, read-only verification that the attachment storage mount is
# EXACTLY what production expects — run this AFTER `docker compose up` (or
# an equivalent recreate) completes, as a routine post-deploy check, never
# automatically. Complements (never replaces) lib/attachment-storage-
# service.ts's own in-process check: that one can only confirm "UPLOAD_DIR
# is SOME distinct mount" (from inside the container, via
# /proc/self/mountinfo, which cannot see the HOST-side source path at all);
# THIS script runs from the Docker host, where `docker inspect`'s
# `.Mounts[].Source` is directly visible, and can assert the SPECIFIC
# expected host path and destination both — the stronger assertion only
# possible from outside the container.
#
# TWO DELIBERATELY SEPARATE MODES — never confused with each other:
#
#   discover  — prints the ACTUAL mount found, for a human to read and
#               copy the real source path from. Makes NO pass/fail claim
#               of any kind. Always exits 0 if it could run at all,
#               REGARDLESS of what it found — this is NOT a gate, and
#               must never be used as one in any deploy script.
#
#   verify    — the actual production acceptance gate. REQUIRES both the
#               expected destination AND the expected host source as
#               mandatory arguments — refuses to run with either missing,
#               so it can never silently "pass" merely because SOME mount
#               exists at the right destination with an unconfirmed
#               source. Exits 0 only if type, source, destination, and
#               writability all match exactly; exits 1 otherwise.
#
# READ-ONLY in both modes: only `docker inspect` is ever run. Never stops,
# starts, recreates, or removes anything; never touches /var/lib/docker.
#
# Usage:
#   ./scripts/verify-attachment-storage-mount.sh discover [container_name] [destination]
#   ./scripts/verify-attachment-storage-mount.sh verify <container_name> <expected_destination> <expected_source>
#
# First deploy: run `discover` once, read the printed Source by eye, then
# use that exact value as `verify`'s third argument on every deploy after.

set -eu

MODE="${1:-}"

usage() {
  echo "Usage:"
  echo "  $0 discover [container_name] [destination]"
  echo "  $0 verify <container_name> <expected_destination> <expected_source>"
  exit 1
}

find_mount() {
  # Prints "type|source|destination|rw" for the mount at $2 on container $1,
  # or nothing if no such mount exists. Read-only.
  docker inspect --format='{{range .Mounts}}{{if eq .Destination "'"$2"'"}}{{.Type}}|{{.Source}}|{{.Destination}}|{{.RW}}{{end}}{{end}}' "$1"
}

case "${MODE}" in
  discover)
    CONTAINER="${2:-kinsen-helpdesk}"
    DEST="${3:-/app/storage/uploads}"

    echo "=== Attachment storage mount DISCOVERY (read-only, NOT a pass/fail gate) ==="
    echo "Container:   ${CONTAINER}"
    echo "Destination: ${DEST}"
    echo ""

    if ! docker inspect "${CONTAINER}" >/dev/null 2>&1; then
      echo "No container named '${CONTAINER}' found (docker inspect failed). Nothing was started, stopped, or modified."
      exit 0
    fi

    echo "Container created: $(docker inspect --format='{{.Created}}' "${CONTAINER}")"
    echo "Image:              $(docker inspect --format='{{.Config.Image}}' "${CONTAINER}")"
    echo ""

    MOUNT_LINE=$(find_mount "${CONTAINER}" "${DEST}")
    if [ -z "${MOUNT_LINE}" ]; then
      echo "No mount found at destination ${DEST}. Full mount list for reference:"
      docker inspect --format='{{json .Mounts}}' "${CONTAINER}"
      exit 0
    fi

    MOUNT_SOURCE=$(echo "${MOUNT_LINE}" | cut -d'|' -f2)
    echo "Found: ${MOUNT_LINE}"
    echo ""
    echo "To turn this into an actual production gate, run:"
    echo "  $0 verify ${CONTAINER} ${DEST} ${MOUNT_SOURCE}"
    echo "(only after you've confirmed by eye that this Source is really the correct, intended host path)."
    exit 0
    ;;

  verify)
    CONTAINER="${2:-}"
    EXPECTED_DEST="${3:-}"
    EXPECTED_SOURCE="${4:-}"
    if [ -z "${CONTAINER}" ] || [ -z "${EXPECTED_DEST}" ] || [ -z "${EXPECTED_SOURCE}" ]; then
      echo "verify requires ALL THREE arguments: container, expected destination, expected source."
      echo "Run '$0 discover' first if you don't already have a confirmed expected source."
      usage
    fi

    echo "=== Attachment storage mount VERIFICATION (read-only production gate) ==="
    echo "Container:            ${CONTAINER}"
    echo "Expected destination: ${EXPECTED_DEST}"
    echo "Expected source:      ${EXPECTED_SOURCE}"
    echo ""

    if ! docker inspect "${CONTAINER}" >/dev/null 2>&1; then
      echo "FAIL: no container named '${CONTAINER}' found (docker inspect failed). Nothing was started, stopped, or modified."
      exit 1
    fi

    MOUNT_LINE=$(find_mount "${CONTAINER}" "${EXPECTED_DEST}")
    if [ -z "${MOUNT_LINE}" ]; then
      echo "FAIL: no mount found at destination ${EXPECTED_DEST} at all."
      echo "Full mount list for reference (read-only):"
      docker inspect --format='{{json .Mounts}}' "${CONTAINER}"
      exit 1
    fi

    MOUNT_TYPE=$(echo "${MOUNT_LINE}" | cut -d'|' -f1)
    MOUNT_SOURCE=$(echo "${MOUNT_LINE}" | cut -d'|' -f2)
    MOUNT_RW=$(echo "${MOUNT_LINE}" | cut -d'|' -f4)
    echo "Found mount: ${MOUNT_LINE}"
    echo ""

    FAILED=0

    if [ "${MOUNT_TYPE}" != "bind" ] && [ "${MOUNT_TYPE}" != "volume" ]; then
      echo "FAIL: mount type is '${MOUNT_TYPE}' — expected 'bind' or 'volume' (a durable mount), not a plain directory."
      FAILED=1
    fi

    if [ "${MOUNT_RW}" != "true" ]; then
      echo "FAIL: mount is not writable (RW=${MOUNT_RW})."
      FAILED=1
    fi

    if [ "${MOUNT_SOURCE}" != "${EXPECTED_SOURCE}" ]; then
      echo "FAIL: mount source is '${MOUNT_SOURCE}', expected EXACTLY '${EXPECTED_SOURCE}'."
      echo "      (A merely-existing mount at the right destination is NOT sufficient — the"
      echo "       exact expected host source must match. If the host path legitimately"
      echo "       changed, re-run 'discover' and update the expected value you pass here —"
      echo "       never assumed automatically.)"
      FAILED=1
    fi

    if [ "${FAILED}" -eq 0 ]; then
      echo "PASS: ${EXPECTED_DEST} is mounted from exactly '${EXPECTED_SOURCE}' as a durable, writable ${MOUNT_TYPE} mount."
      exit 0
    fi
    exit 1
    ;;

  *)
    usage
    ;;
esac
