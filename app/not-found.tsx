import Link from "next/link";
import { Compass } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

// Next.js renders this for any unmatched route, still inside the root
// layout (app/layout.tsx) — so it inherits the FOUC-prevention script and
// `.dark` class already applied there. Without a page here, Next falls
// back to its own built-in 404, which is unstyled, plain-white, and
// ignores the app's theme entirely — a jarring break in dark mode.
export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md border-0 shadow-2xl text-center">
        <CardContent className="pt-10 pb-8 flex flex-col items-center gap-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
            <Compass className="h-7 w-7 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Page not found</h1>
            <p className="text-muted-foreground text-sm mt-1 max-w-sm">
              The page you&apos;re looking for doesn&apos;t exist or may have been moved.
            </p>
          </div>
          <Button asChild>
            <Link href="/dashboard">Go to Dashboard</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
