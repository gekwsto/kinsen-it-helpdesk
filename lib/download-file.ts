/**
 * Fetches a file-download endpoint and saves the response as a real browser
 * download — used by the Projects Excel export buttons (list + detail) so
 * each can show a controlled loading/error state around the request,
 * instead of a plain `<a href download>`, which gives the caller no way to
 * know whether the request actually succeeded. The server's own
 * Content-Disposition header still names the saved file (never a
 * client-guessed name) — `fallbackFilename` is only used on the rare
 * response that omits that header.
 */
export async function downloadFile(url: string, fallbackFilename: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed (HTTP ${res.status})`);
  }

  const disposition = res.headers.get("Content-Disposition") ?? "";
  const filename = disposition.match(/filename="?([^";]+)"?/)?.[1] ?? fallbackFilename;

  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}
