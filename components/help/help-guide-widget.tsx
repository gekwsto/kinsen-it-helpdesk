"use client";

import { useState, useEffect } from "react";
import { BookOpen, X, ChevronLeft, ChevronRight } from "lucide-react";

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

const LS_KEY = "help-guide-open";

export function HelpGuideWidget() {
  const [isOpen, setIsOpen] = useState(false);
  const [activeId, setActiveId] = useState<GuideId | null>(null);

  useEffect(() => {
    try {
      setIsOpen(localStorage.getItem(LS_KEY) === "true");
    } catch {}
  }, []);

  function toggle() {
    setIsOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(LS_KEY, String(next));
      } catch {}
      if (!next) setActiveId(null);
      return next;
    });
  }

  function close() {
    setIsOpen(false);
    setActiveId(null);
    try {
      localStorage.setItem(LS_KEY, "false");
    } catch {}
  }

  const activeGuide = GUIDES.find((g) => g.id === activeId) ?? null;

  // left-72 = 288px, clears the 256px (w-64) sidebar
  return (
    <div className="fixed bottom-5 left-72 z-50 flex flex-col items-start gap-2">
      {/* Panel — opens upward above the trigger button */}
      {isOpen && (
        <div className="w-80 rounded-xl border bg-background shadow-xl flex flex-col overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between gap-2 bg-primary px-4 py-3">
            <div className="flex items-center gap-2">
              <BookOpen className="h-4 w-4 text-primary-foreground" />
              <span className="text-sm font-semibold text-primary-foreground">
                Kinsen IT Help Guide
              </span>
            </div>
            <button
              onClick={close}
              aria-label="Close help guide"
              className="text-primary-foreground/70 hover:text-primary-foreground transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto max-h-96">
            {activeGuide ? (
              <div className="p-4 space-y-3">
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
              <div className="p-4 space-y-3">
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
        </div>
      )}

      {/* Trigger button */}
      <button
        onClick={toggle}
        aria-label="Toggle help guide"
        className="flex items-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground shadow-lg hover:bg-primary/90 transition-colors"
      >
        <BookOpen className="h-4 w-4" />
        Help Guide
      </button>
    </div>
  );
}
