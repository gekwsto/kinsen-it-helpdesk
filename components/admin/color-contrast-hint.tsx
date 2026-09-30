import { AlertTriangle } from "lucide-react";
import { StatusMark } from "@/components/shared/marks";

function luminance(hex: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(m[1].slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: number, b: number) {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// The two surfaces marks are drawn on: light card (#FFFFFF) and dark card (#0C1E2B).
const LIGHT_CARD = 1;
const DARK_CARD = luminance("#0C1E2B")!;

/**
 * Live preview of how an admin-picked colour renders as a status mark on
 * both themes, with a warning when it falls under the 3:1 contrast that
 * non-text graphics need. Labels stay neutral text regardless, so a faint
 * colour weakens the mark, never the words.
 */
export function ColorContrastHint({ color, label = "Preview" }: { color: string; label?: string }) {
  const lum = luminance(color);
  if (lum === null) return null;
  const faintOnLight = contrast(lum, LIGHT_CARD) < 3;
  const faintOnDark = contrast(lum, DARK_CARD) < 3;
  const theme = faintOnLight && faintOnDark ? "both themes" : faintOnLight ? "the light theme" : faintOnDark ? "the dark theme" : null;

  return (
    <div className="space-y-1.5">
      <div className="flex overflow-hidden rounded border text-xs">
        <span className="flex-1 bg-white px-2.5 py-1.5 text-[#0D1B26]">
          <StatusMark label={label} color={color} className="text-[#0D1B26]" />
        </span>
        <span className="flex-1 bg-[#0C1E2B] px-2.5 py-1.5">
          <StatusMark label={label} color={color} className="text-[#E4ECF1]" />
        </span>
      </div>
      {theme && (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground" role="status">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden="true" />
          This colour is hard to see in {theme}. Pick a deeper shade so the mark stays visible.
        </p>
      )}
    </div>
  );
}
