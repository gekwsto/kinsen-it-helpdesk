"use client";

import { useEffect, useState } from "react";
import { BookOpen, ChevronLeft, ChevronRight } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useHelpGuide } from "@/components/help/help-guide-provider";

const GUIDES = [
  {
    id: "create",
    question: "Πώς ανοίγω ticket;",
    steps: [
      'Πατήστε "Create Ticket" από το αριστερό μενού.',
      "Συμπληρώστε τίτλο, περιγραφή, κατηγορία και προτεραιότητα.",
      "Προσθέστε συνημμένα αν χρειάζεται.",
      'Πατήστε "Submit".',
      'Το ticket θα εμφανιστεί στη λίστα "My Tickets".',
    ],
  },
  {
    id: "view",
    question: "Πώς βλέπω τα tickets μου;",
    steps: [
      'Πατήστε "My Tickets" από το αριστερό μενού.',
      "Εκεί θα δείτε όλα τα αιτήματα που έχετε δημιουργήσει.",
      "Μπορείτε να ανοίξετε κάθε ticket για να δείτε status, απαντήσεις και ιστορικό.",
    ],
  },
  {
    id: "reply",
    question: "Πώς απαντάω σε ticket;",
    steps: [
      "Ανοίξτε το ticket από τη λίστα.",
      "Πηγαίνετε στο κάτω μέρος της σελίδας.",
      "Γράψτε την απάντησή σας στο πεδίο reply.",
      'Πατήστε "Send Reply".',
    ],
  },
  {
    id: "edit",
    question: "Πώς κάνω edit ticket;",
    steps: [
      "Ανοίξτε το ticket.",
      'Πατήστε "Edit" αν είναι διαθέσιμο.',
      "Αλλάξτε τα στοιχεία που επιτρέπονται.",
      'Πατήστε "Save".',
    ],
  },
  {
    id: "attach",
    question: "Πώς προσθέτω συνημμένο;",
    steps: [
      'Κατά τη δημιουργία ή την απάντηση σε ticket, πατήστε "Attach file".',
      "Επιλέξτε το αρχείο από τον υπολογιστή σας.",
      "Περιμένετε να ολοκληρωθεί το upload.",
      "Υποβάλετε το ticket ή την απάντηση.",
    ],
  },
  {
    id: "statuses",
    question: "Τι σημαίνουν τα statuses;",
    steps: [
      "New: Το ticket μόλις δημιουργήθηκε.",
      "Open: Το IT το έχει λάβει.",
      "In Progress: Το IT το επεξεργάζεται.",
      "Waiting: Αναμένεται απάντηση ή ενέργεια.",
      "Resolved: Έχει δοθεί λύση.",
      "Closed: Το αίτημα έχει ολοκληρωθεί.",
    ],
  },
] as const;

type GuideId = (typeof GUIDES)[number]["id"];

/**
 * The Help Guide panel — content/behavior unchanged from the old floating
 * widget (same GUIDES data, same list -> step-detail navigation), just
 * rendered through the standard Dialog primitive (matching every other
 * modal in this app) instead of a custom fixed-position div, since its
 * trigger now lives in the sidebar (components/layout/sidebar.tsx) rather
 * than anchored next to this panel. Open/close state is shared via
 * HelpGuideProvider, not owned here.
 */
export function HelpGuideWidget() {
  const { isOpen, close } = useHelpGuide();
  const [activeId, setActiveId] = useState<GuideId | null>(null);

  // Always start back at the guide list on the next open, matching the
  // previous widget's behavior of clearing activeId on close.
  useEffect(() => {
    if (!isOpen) setActiveId(null);
  }, [isOpen]);

  const activeGuide = GUIDES.find((g) => g.id === activeId) ?? null;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-primary" />
            Kinsen IT Help Guide
          </DialogTitle>
        </DialogHeader>

        <div className="max-h-96 overflow-y-auto -mx-6 px-6">
          {activeGuide ? (
            <div className="space-y-3 pb-1">
              <button
                onClick={() => setActiveId(null)}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                Πίσω
              </button>
              <p className="text-sm font-semibold">{activeGuide.question}</p>
              <ol className="space-y-2 pl-1">
                {activeGuide.steps.map((step, i) => (
                  <li key={i} className="flex gap-2.5 text-sm">
                    <span className="flex-shrink-0 flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-primary text-[10px] font-bold mt-0.5">
                      {i + 1}
                    </span>
                    <span className="text-muted-foreground leading-snug">{step}</span>
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            <div className="space-y-3 pb-1">
              <p className="text-xs text-muted-foreground">
                Καλώς ήρθατε! Επιλέξτε μια ερώτηση για να δείτε οδηγίες χρήσης.
              </p>
              <ul className="space-y-1">
                {GUIDES.map((guide) => (
                  <li key={guide.id}>
                    <button
                      onClick={() => setActiveId(guide.id)}
                      className="w-full flex items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-left text-sm hover:bg-muted transition-colors group"
                    >
                      <span className="text-foreground">{guide.question}</span>
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground flex-shrink-0 transition-colors" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
