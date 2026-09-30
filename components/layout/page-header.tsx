import { cn } from "@/lib/utils";

interface PageHeaderProps {
  title: string;
  /** What this page covers, or its scope (which departments/workspace). One line. */
  description?: React.ReactNode;
  /** The page's single primary action, top right. */
  action?: React.ReactNode;
  className?: string;
}

/** Every core screen opens the same way: title, one scope line, one primary action. */
export function PageHeader({ title, description, action, className }: PageHeaderProps) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-x-6 gap-y-3", className)}>
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight text-balance">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {action && <div className="flex flex-wrap items-center gap-2">{action}</div>}
    </div>
  );
}
