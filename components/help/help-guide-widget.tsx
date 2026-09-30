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

// Every quoted label below must match the real, English UI text exactly —
// this guide is the Greek-speaking user's bridge to those screens, so a
// label that doesn't exist on screen is worse than no guide at all.
const GUIDES = [
  {
    id: "create",
    question: "Πώς ανοίγω ticket;",
    steps: [
      'Πατήστε "Tickets" → "Create Ticket" στο αριστερό μενού.',
      'Στο "Send to department" επιλέξτε το τμήμα που θα χειριστεί το αίτημα (π.χ. IT, Λογιστήριο). Δεν χρειάζεται να είναι το δικό σας.',
      'Συμπληρώστε "Title" και "Description". Κατηγορία και προτεραιότητα είναι προαιρετικές.',
      'Για συνημμένα, σύρετε τα αρχεία στο πλαίσιο "Attachments" ή πατήστε "browse".',
      'Πατήστε "Submit Ticket". Θα λάβετε email επιβεβαίωσης με τον αριθμό του ticket (KIN-…).',
    ],
  },
  {
    id: "view",
    question: "Πώς βλέπω τα tickets μου;",
    steps: [
      'Πατήστε "Tickets" → "Created by Me" στο αριστερό μενού.',
      "Εκεί βλέπετε όλα τα αιτήματα που έχετε ανοίξει.",
      "Ανοίξτε ένα ticket για να δείτε την κατάσταση, τις απαντήσεις και το ιστορικό του.",
      'Τα κλεισμένα αιτήματα βρίσκονται στο "Closed Tickets".',
    ],
  },
  {
    id: "reply",
    question: "Πώς απαντάω σε ticket;",
    steps: [
      "Ανοίξτε το ticket.",
      "Γράψτε το μήνυμά σας στο πεδίο στο κάτω μέρος της συζήτησης.",
      'Πατήστε "Send Reply" (ή Ctrl+Enter).',
      "Μπορείτε επίσης να απαντήσετε απευθείας στο email που λάβατε. Η απάντηση προστίθεται στο ίδιο ticket.",
    ],
  },
  {
    id: "attach",
    question: "Πώς προσθέτω συνημμένο;",
    steps: [
      'Σε νέο ticket: σύρετε τα αρχεία στο πλαίσιο "Attachments" ή πατήστε "browse".',
      'Σε υπάρχον ticket: πατήστε "Attach" δίπλα στο πεδίο απάντησης.',
      "Επιτρέπονται JPG, PNG, PDF, DOCX, XLSX και ZIP, έως 10 MB το καθένα.",
      "Αν κάποιο αρχείο δεν ανέβει, θα δείτε μήνυμα με το όνομά του. Προσθέστε το ξανά από τη σελίδα του ticket.",
    ],
  },
  {
    id: "cancel",
    question: "Πώς ακυρώνω αίτημα;",
    steps: [
      "Ανοίξτε το ticket.",
      'Πατήστε "Cancel My Request" στη δεξιά στήλη.',
      "Επιλέξτε λόγο ακύρωσης και επιβεβαιώστε.",
      'Το ticket μεταφέρεται στο "Closed Tickets".',
    ],
  },
  {
    id: "share",
    question: 'Τι κάνει το "Share with my department";',
    steps: [
      "Το ticket πηγαίνει πάντα στο τμήμα που επιλέξατε στο \"Send to department\".",
      'Το "Share with my department" επιτρέπει επιπλέον στους συναδέλφους του δικού σας τμήματος να βλέπουν το ticket.',
      'Το "Share with my sub-department" κάνει το ίδιο για το υποτμήμα σας.',
      "Κανένα από τα δύο δεν αλλάζει ποιος χειρίζεται το αίτημα.",
    ],
  },
  {
    id: "statuses",
    question: "Τι σημαίνουν τα statuses;",
    steps: [
      "Κάθε τμήμα ορίζει τις δικές του καταστάσεις, οπότε τα ονόματα μπορεί να διαφέρουν.",
      "Οι ανοιχτές καταστάσεις (π.χ. Open, In Progress) σημαίνουν ότι το αίτημα είναι σε εξέλιξη.",
      "Οι κλειστές καταστάσεις (π.χ. Resolved, Closed, Cancelled) σημαίνουν ότι ολοκληρώθηκε ή ακυρώθηκε.",
      "Η τρέχουσα κατάσταση φαίνεται στην κορυφή κάθε ticket.",
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
            <BookOpen className="h-4 w-4 text-link" />
            Help Guide
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
                    <span className="flex-shrink-0 flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-link text-[10px] font-bold mt-0.5">
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
