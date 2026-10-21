"use client";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { NotificationPreferenceRow } from "@/components/notifications/notification-preference-row";

export function NotificationPreferencesCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Notification Preferences</CardTitle>
        <CardDescription>Choose which optional notifications you want to receive.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <NotificationPreferenceRow
          apiPath="/api/users/me/mention-reminders"
          label="Mention reminders"
          description="Remind me when I have not responded to a Project or Activity mention."
          ariaLabel="Mention reminders"
          errorMessage="Could not update your mention reminder preference."
        />
        <NotificationPreferenceRow
          apiPath="/api/users/me/new-department-tickets"
          label="New department tickets"
          description="Notify me when a new ticket is created in a department I belong to."
          ariaLabel="New department tickets"
          errorMessage="Could not update your new department tickets preference."
        />
      </CardContent>
    </Card>
  );
}
