/** Shape returned by every Related Links route and consumed by the shared UI — only the fields the card needs. */
export interface RelatedLinkDto {
  id: string;
  url: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  createdBy: { id: string; name: string | null; email: string } | null;
}

export type RelatedLinkEntityType = "project" | "activity";
