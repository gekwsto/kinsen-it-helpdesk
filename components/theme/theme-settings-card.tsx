"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useThemePreference } from "@/components/theme/use-theme-preference";
import type { ThemeMode } from "@/components/theme/theme-constants";

const OPTIONS: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

/** Same read/write path as the Topbar's ThemeToggle (useThemePreference) — picking a mode here is reflected there immediately, and vice versa, with no reload. */
export function ThemeSettingsCard() {
  const { mode, setThemeMode } = useThemePreference();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Appearance</CardTitle>
        <CardDescription>Choose how TicketApp looks on this device.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 gap-3">
          {OPTIONS.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              onClick={() => setThemeMode(value)}
              aria-pressed={mode === value}
              className={cn(
                "flex flex-col items-center gap-2 rounded-lg border px-3 py-3 text-sm font-medium transition-colors",
                mode === value
                  ? "border-primary bg-primary/5 text-primary"
                  : "border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              )}
            >
              <Icon className="h-5 w-5" />
              {label}
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
