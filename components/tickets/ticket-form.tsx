"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { createTicketSchema, type CreateTicketInput } from "@/lib/validations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Check, Loader2, Paperclip } from "lucide-react";
import { AttachmentDropzone } from "@/components/tickets/attachment-dropzone";
import { LiveSupportPanel } from "@/components/tickets/live-support-panel";
import { SimpleCommentBox } from "@/components/tickets/simple-comment-box";

interface Agent {
  id: string;
  name: string | null;
  image: string | null;
}

interface CreateTicketFormProps {
  categories: Array<{ id: string; name: string }>;
  priorities: Array<{ id: string; name: string; color: string; level: number }>;
  departments: Array<{ id: string; name: string }>;
  itAgents: Agent[];
  projects?: Array<{ id: string; title: string }>;
  activities?: Array<{ id: string; title: string; projectId: string | null }>;
}

export function CreateTicketForm({
  categories,
  priorities,
  departments,
  itAgents,
  projects = [],
  activities = [],
}: CreateTicketFormProps) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [pendingComments, setPendingComments] = useState<string[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<CreateTicketInput>({
    resolver: zodResolver(createTicketSchema),
  });

  const uploadAttachment = async (ticketId: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    await fetch(`/api/tickets/${ticketId}/attachments`, { method: "POST", body: fd });
  };

  const postInitialMessage = async (ticketId: string, body: string) => {
    await fetch(`/api/tickets/${ticketId}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body, direction: "INBOUND", isInternal: false }),
    });
  };

  const onSubmit = async (data: CreateTicketInput) => {
    setIsSubmitting(true);
    try {
      const res = await fetch("/api/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to create ticket");
      }

      const ticket = await res.json();

      // Upload attachments (best-effort, non-blocking on error)
      if (files.length > 0) {
        await Promise.allSettled(files.map((f) => uploadAttachment(ticket.id, f)));
      }

      // Post any saved initial messages
      if (pendingComments.length > 0) {
        await Promise.allSettled(
          pendingComments.map((body) => postInitialMessage(ticket.id, body))
        );
      }

      toast.success("Ticket created successfully!");
      router.push(`/tickets/${ticket.id}`);
    } catch (error: any) {
      toast.error(error.message ?? "Something went wrong");
      setIsSubmitting(false);
    }
  };

  const handleInitialComment = async (text: string) => {
    setPendingComments((prev) => [...prev, text]);
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <div className="grid gap-6 lg:grid-cols-3">
        {/* ── Left: main content (2/3) ─────────────────────────── */}
        <div className="lg:col-span-2 space-y-5">
          {/* Ticket details */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Ticket Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="title">
                  Title <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="title"
                  placeholder="Brief summary of your issue…"
                  {...register("title")}
                />
                {errors.title && (
                  <p className="text-xs text-destructive">{errors.title.message}</p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="description">
                  Description <span className="text-destructive">*</span>
                </Label>
                <Textarea
                  id="description"
                  placeholder="Describe the issue in detail. Include steps to reproduce, error messages, what you expected vs what happened…"
                  className="min-h-[160px] resize-y"
                  {...register("description")}
                />
                {errors.description && (
                  <p className="text-xs text-destructive">{errors.description.message}</p>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Attachments */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Paperclip className="h-4 w-4" />
                Attachments
                {files.length > 0 && (
                  <span className="ml-auto text-xs font-normal text-muted-foreground">
                    {files.length} file{files.length !== 1 ? "s" : ""} selected
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <AttachmentDropzone files={files} onFilesChange={setFiles} />
            </CardContent>
          </Card>

          {/* Initial message */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Initial Message</CardTitle>
              <p className="text-xs text-muted-foreground">
                Optional message to the IT team — sent after your ticket is submitted.
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              <SimpleCommentBox
                onSubmit={handleInitialComment}
                placeholder="Add context, urgency details, or ask a quick question…"
              />
              {pendingComments.length > 0 && (
                <p className="flex items-center gap-1.5 text-xs text-emerald-600">
                  <Check className="h-3 w-3" />
                  {pendingComments.length} message
                  {pendingComments.length > 1 ? "s" : ""} saved — will be posted with ticket
                </p>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ── Right: sidebar (1/3) ─────────────────────────────── */}
        <div className="space-y-4">
          {/* Properties */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Properties</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label>Category</Label>
                <Select onValueChange={(v) => setValue("categoryId", v)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select category…" />
                  </SelectTrigger>
                  <SelectContent>
                    {categories.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label>Priority</Label>
                <Select onValueChange={(v) => setValue("priorityId", v)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select priority…" />
                  </SelectTrigger>
                  <SelectContent>
                    {[...priorities].sort((a, b) => b.level - a.level).map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        <span className="flex items-center gap-2">
                          <span
                            className="h-2 w-2 rounded-full shrink-0"
                            style={{ backgroundColor: p.color }}
                          />
                          {p.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label>Department</Label>
                <Select onValueChange={(v) => setValue("departmentId", v)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select department…" />
                  </SelectTrigger>
                  <SelectContent>
                    {departments.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {projects.length > 0 && (
                <div className="space-y-1.5">
                  <Label>Project</Label>
                  <Select
                    onValueChange={(v) => {
                      const val = v === "_none" ? "" : v;
                      setValue("projectId", val || undefined);
                      setSelectedProjectId(val);
                      setValue("activityId", undefined);
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="No project" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_none">No project</SelectItem>
                      {projects.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {activities.length > 0 && (
                <div className="space-y-1.5">
                  <Label>Activity</Label>
                  <Select
                    onValueChange={(v) =>
                      setValue("activityId", v === "_none" ? undefined : v)
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="No activity" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_none">No activity</SelectItem>
                      {activities
                        .filter(
                          (a) =>
                            !selectedProjectId ||
                            a.projectId === selectedProjectId
                        )
                        .map((a) => (
                          <SelectItem key={a.id} value={a.id}>
                            {a.title}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </CardContent>
          </Card>

          <Button type="submit" className="w-full" size="lg" disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Submitting…
              </>
            ) : (
              "Submit Ticket"
            )}
          </Button>

          {/* Live support panel */}
          <LiveSupportPanel agents={itAgents} />
        </div>
      </div>
    </form>
  );
}
