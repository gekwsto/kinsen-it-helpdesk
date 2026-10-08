/**
 * A single label+value row inside a list-row Preview dialog's scrollable
 * body — extracted from components/project-requests/project-request-table.tsx
 * (the canonical Preview pattern this app's other list previews, e.g.
 * Projects/Activities, now also reuse verbatim) so the exact same look
 * never gets redefined three times over.
 */
export function PreviewField({ label, value, multiline }: { label: string; value: string; multiline?: boolean }) {
  return (
    <div className="px-4 py-3">
      <p className="text-xs font-medium text-muted-foreground mb-1">{label}</p>
      <p className={multiline ? "text-sm whitespace-pre-wrap" : "text-sm"}>{value}</p>
    </div>
  );
}
