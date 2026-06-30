"use client";

import { useState } from "react";
import { Send, Headset } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { getInitials } from "@/lib/utils";

interface Agent {
  id: string;
  name: string | null;
  image: string | null;
}

interface LiveSupportPanelProps {
  agents: Agent[];
  ticketId?: string; // undefined = pre-creation mode
}

export function LiveSupportPanel({ agents, ticketId }: LiveSupportPanelProps) {
  const [message, setMessage] = useState("");

  const isPreCreation = !ticketId;

  return (
    <div
      className="flex flex-col rounded-lg border bg-card overflow-hidden"
      style={{ minHeight: 320 }}
      data-ws-ready="false"
      data-ticket-id={ticketId ?? "pending"}
    >
      {/* Header */}
      <div className="flex items-center gap-3 border-b bg-muted/40 px-4 py-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10">
          <Headset className="h-4 w-4 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold leading-none">Live IT Support</p>
          <p className="text-xs text-muted-foreground mt-0.5">Real-time assistance</p>
        </div>
        <span className="flex items-center gap-1.5 text-xs text-emerald-600 font-medium">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
          Online
        </span>
      </div>

      {/* Agents */}
      {agents.length > 0 && (
        <div className="border-b px-4 py-3">
          <p className="text-xs font-medium text-muted-foreground mb-2">Available agents</p>
          <div className="flex flex-wrap gap-2">
            {agents.slice(0, 4).map((agent) => (
              <div key={agent.id} className="flex items-center gap-1.5">
                <Avatar className="h-6 w-6">
                  <AvatarImage src={agent.image ?? undefined} alt={agent.name ?? "Agent"} />
                  <AvatarFallback className="text-[10px]">{getInitials(agent.name)}</AvatarFallback>
                </Avatar>
                <span className="text-xs text-muted-foreground">{agent.name?.split(" ")[0]}</span>
              </div>
            ))}
            {agents.length > 4 && (
              <span className="text-xs text-muted-foreground">+{agents.length - 4} more</span>
            )}
          </div>
        </div>
      )}

      {/* Conversation area */}
      <div className="flex-1 flex items-center justify-center px-4 py-6">
        {isPreCreation ? (
          <div className="text-center space-y-2">
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-muted">
              <Headset className="h-5 w-5 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium">Chat available after submission</p>
            <p className="text-xs text-muted-foreground">
              Submit your ticket to start a live conversation with our IT team.
            </p>
          </div>
        ) : (
          <div className="text-center">
            <p className="text-sm text-muted-foreground">No messages yet.</p>
            <p className="text-xs text-muted-foreground mt-1">
              Send a message to start the conversation.
            </p>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="border-t p-3 flex items-center gap-2">
        <Input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={isPreCreation ? "Submit ticket to unlock chat…" : "Type a message…"}
          disabled={isPreCreation}
          className="h-8 text-sm"
        />
        <Button
          type="button"
          size="sm"
          className="h-8 w-8 p-0 shrink-0"
          disabled={isPreCreation || !message.trim()}
        >
          <Send className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
