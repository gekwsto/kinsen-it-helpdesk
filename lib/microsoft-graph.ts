/**
 * Microsoft Graph API client for email integration.
 * Uses client credentials flow (app-only auth) to access the support mailbox.
 *
 * Required Azure App permissions (Application, not Delegated):
 *   - Mail.Read
 *   - Mail.Send
 *   - Mail.ReadWrite
 */

interface GraphMailMessage {
  id: string;
  subject: string;
  bodyPreview: string;
  body: {
    contentType: "html" | "text";
    content: string;
  };
  from: {
    emailAddress: { name: string; address: string };
  };
  toRecipients: Array<{ emailAddress: { name: string; address: string } }>;
  internetMessageId: string;
  conversationId: string;
  receivedDateTime: string;
  hasAttachments: boolean;
  attachments?: GraphAttachment[];
  isRead: boolean;
  internetMessageHeaders?: Array<{ name: string; value: string }>;
}

interface GraphAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  contentBytes?: string; // base64 encoded
}

interface SendMailPayload {
  message: {
    subject: string;
    body: { contentType: "HTML" | "Text"; content: string };
    toRecipients: Array<{ emailAddress: { address: string; name?: string } }>;
    replyTo?: Array<{ emailAddress: { address: string; name?: string } }>;
    internetMessageHeaders?: Array<{ name: string; value: string }>;
  };
  saveToSentItems?: boolean;
}

/**
 * Exported so other app-only (client-credentials) Graph consumers — e.g.
 * lib/services/microsoft-directory-service.ts — can reuse this exact token
 * flow instead of duplicating it. Still the same app registration/tenant as
 * the mailbox polling below (GRAPH_TENANT_ID / GRAPH_CLIENT_ID /
 * GRAPH_CLIENT_SECRET); callers needing directory-wide reads (e.g.
 * `GET /users`, used by microsoft-directory-service.ts to discover company-
 * wide department values) require that same registration to additionally
 * have the `Directory.Read.All` Application permission, admin-consented in
 * Azure — see docs/microsoft-graph-directory-sync.md, which documents both
 * as the two Graph operations of one Microsoft Directory Sync module. This
 * is a *different* permission/token type than the delegated `User.Read`
 * used by the signed-in user's own `/me` call at login
 * (lib/services/microsoft-graph-profile-service.ts) — granting or missing
 * one has no effect on the other. This function itself doesn't request or
 * know about scopes beyond `.default` (whatever's been consented in Azure is
 * what's usable), so a missing permission surfaces as a 403 from Graph on
 * the actual call, not here.
 */
export async function getAppOnlyGraphAccessToken(): Promise<string> {
  return getAccessToken();
}

async function getAccessToken(): Promise<string> {
  const tenantId = process.env.GRAPH_TENANT_ID!;
  const clientId = process.env.GRAPH_CLIENT_ID!;
  const clientSecret = process.env.GRAPH_CLIENT_SECRET!;

  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://graph.microsoft.com/.default",
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`Failed to get access token: ${response.statusText}`);
  }

  const data = await response.json();
  return data.access_token as string;
}

async function graphRequest<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = await getAccessToken();
  const baseUrl = "https://graph.microsoft.com/v1.0";

  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Graph API error ${response.status}: ${error}`);
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

const MAILBOX = process.env.GRAPH_USER_EMAIL || "kinsenitsupport@kinsen.gr";

export const microsoftGraph = {
  /**
   * Fetch unread messages from the support inbox.
   */
  async getUnreadMessages(top = 25): Promise<GraphMailMessage[]> {
    const select = [
      "id", "subject", "bodyPreview", "body", "from", "toRecipients",
      "internetMessageId", "conversationId", "receivedDateTime",
      "hasAttachments", "isRead", "internetMessageHeaders",
    ].join(",");
    const data = await graphRequest<{ value: GraphMailMessage[] }>(
      `/users/${MAILBOX}/mailFolders/Inbox/messages?$filter=isRead eq false&$top=${top}&$orderby=receivedDateTime asc&$select=${select}&$expand=attachments`
    );
    return data.value;
  },

  /**
   * Mark a message as read.
   */
  async markAsRead(messageId: string): Promise<void> {
    await graphRequest(`/users/${MAILBOX}/messages/${messageId}`, {
      method: "PATCH",
      body: JSON.stringify({ isRead: true }),
    });
  },

  /**
   * Move a message to a specific folder (e.g., Processed).
   */
  async moveMessage(messageId: string, destinationFolderName: string): Promise<void> {
    const folders = await graphRequest<{ value: Array<{ id: string; displayName: string }> }>(
      `/users/${MAILBOX}/mailFolders?$filter=displayName eq '${destinationFolderName}'`
    );

    let folderId: string;

    if (folders.value.length === 0) {
      const newFolder = await graphRequest<{ id: string }>(
        `/users/${MAILBOX}/mailFolders`,
        {
          method: "POST",
          body: JSON.stringify({ displayName: destinationFolderName }),
        }
      );
      folderId = newFolder.id;
    } else {
      folderId = folders.value[0].id;
    }

    await graphRequest(`/users/${MAILBOX}/messages/${messageId}/move`, {
      method: "POST",
      body: JSON.stringify({ destinationId: folderId }),
    });
  },

  /**
   * Send an email from the support mailbox.
   */
  async sendMail(payload: SendMailPayload): Promise<void> {
    await graphRequest(`/users/${MAILBOX}/sendMail`, {
      method: "POST",
      body: JSON.stringify({ ...payload, saveToSentItems: true }),
    });
  },

  /**
   * Validate Microsoft Graph credentials and mailbox access.
   * Returns structured result for the admin diagnostics panel.
   */
  async testConnection(): Promise<{
    tokenOk: boolean;
    mailboxOk: boolean;
    mailboxEmail?: string;
    unreadCount?: number;
    error?: string;
    details?: string;
  }> {
    let token: string;
    try {
      token = await getAccessToken();
    } catch (err) {
      return {
        tokenOk: false,
        mailboxOk: false,
        error: "Failed to acquire access token — check GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET",
        details: err instanceof Error ? err.message : String(err),
      };
    }

    try {
      const base = "https://graph.microsoft.com/v1.0";
      const hdrs = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
      const [profileRes, inboxRes] = await Promise.all([
        fetch(`${base}/users/${MAILBOX}?$select=mail,userPrincipalName`, { headers: hdrs }),
        fetch(
          `${base}/users/${MAILBOX}/mailFolders/Inbox/messages?$filter=isRead eq false&$top=1&$select=id`,
          { headers: hdrs }
        ),
      ]);

      if (!profileRes.ok) {
        const errText = await profileRes.text();
        return {
          tokenOk: true,
          mailboxOk: false,
          error: `Mailbox access failed (HTTP ${profileRes.status}) — verify GRAPH_USER_EMAIL and Mail.Read permission`,
          details: errText,
        };
      }

      const profile = (await profileRes.json()) as { mail?: string; userPrincipalName?: string };
      const inbox = inboxRes.ok
        ? ((await inboxRes.json()) as { value: unknown[] })
        : { value: [] };

      return {
        tokenOk: true,
        mailboxOk: true,
        mailboxEmail: profile.mail ?? profile.userPrincipalName ?? MAILBOX,
        unreadCount: inbox.value.length,
      };
    } catch (err) {
      return {
        tokenOk: true,
        mailboxOk: false,
        error: "Mailbox connectivity error",
        details: err instanceof Error ? err.message : String(err),
      };
    }
  },

  /**
   * Send a ticket reply notification email.
   */
  async sendTicketReply(params: {
    to: string;
    toName?: string;
    subject: string;
    htmlBody: string;
    ticketNumber: number;
  }): Promise<void> {
    const { formatTicketNumber } = await import("@/lib/utils");
    const ref = formatTicketNumber(params.ticketNumber);

    await microsoftGraph.sendMail({
      message: {
        subject: params.subject.includes(ref) ? params.subject : `Re: [${ref}] ${params.subject}`,
        body: { contentType: "HTML", content: params.htmlBody },
        toRecipients: [
          {
            emailAddress: {
              address: params.to,
              name: params.toName,
            },
          },
        ],
        internetMessageHeaders: [
          { name: "X-Ticket-Number", value: ref },
          { name: "X-Ticket-ID", value: String(params.ticketNumber) },
        ],
      },
    });
  },
};

export type { GraphMailMessage, GraphAttachment };
