/** One push to one user (already in their language). The in-app record is written before this is queued. */
export type SendNotificationJob = {
  userId: string;
  title: string;
  body: string;
  /** Deep-link ids; always includes `type` and `notification_id`. */
  data: Record<string, string>;
};
