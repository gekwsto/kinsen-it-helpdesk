import Link from "next/link";
import { Mail, MessagesSquare, Send } from "lucide-react";

interface WhatHappensNextProps {
  /** Name of the currently selected destination department, if any. */
  departmentName?: string;
}

/**
 * Honest post-submit expectations for the requester, replacing the old
 * decorative "Live IT Support" panel. Every line here describes behaviour
 * that actually exists: the requester confirmation email and emailed
 * public replies (lib/ticket-notification-service.ts), `[KIN-N]` email
 * replies threading into the ticket (lib/ticket-email-service.ts), and the
 * Created by Me list.
 */
export function WhatHappensNext({ departmentName }: WhatHappensNextProps) {
  const steps = [
    {
      icon: Send,
      text: departmentName ? (
        <>
          Your ticket goes to <span className="font-medium text-foreground">{departmentName}</span>, who will pick it up and assign it.
        </>
      ) : (
        "Your ticket goes to the department you choose, who will pick it up and assign it."
      ),
    },
    {
      icon: Mail,
      text: "You get a confirmation email with the ticket number (KIN-…). Public replies from the department arrive by email too.",
    },
    {
      icon: MessagesSquare,
      text: (
        <>
          Reply to that email, or open the ticket from{" "}
          <Link href="/tickets/created-by-me" className="font-medium text-foreground underline underline-offset-2">
            Created by Me
          </Link>
          , to add information later.
        </>
      ),
    },
  ];

  return (
    <section aria-labelledby="what-happens-next" className="">
      <h2 id="what-happens-next" className="text-sm font-semibold">
        What happens next
      </h2>
      <ol className="mt-3 space-y-3">
        {steps.map(({ icon: Icon, text }, i) => (
          <li key={i} className="flex gap-2.5 text-sm text-muted-foreground">
            <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span>{text}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
