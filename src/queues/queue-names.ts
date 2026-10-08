export enum QueueName {
  NOTIFICATIONS = 'notifications',
  MAINTENANCE = 'maintenance',
}

export enum MaintenanceJob {
  PRESENCE_CLEANUP = 'presence-cleanup',
  /** Direct-request timeouts, fallback broadcasts and broadcast expiry (spec §6.9a, §6.10). */
  BOOKING_DEADLINES = 'booking-deadlines',
  /** Visit reminders 24 h and 1 h before (spec §8). */
  BOOKING_REMINDERS = 'booking-reminders',
  /** Lifts timed suspensions that have ended (spec §4.10 `user_suspensions`). */
  SUSPENSION_EXPIRY = 'suspension-expiry',
  /** Documents expiring within 30 days → provider notice; expired license → pause (spec §4.4, decision 14). */
  DOCUMENT_EXPIRY = 'document-expiry',
  /** Cancels card / wallet bookings still unpaid after the payment window (M2.3). */
  PAYMENT_EXPIRY = 'payment-expiry',
  /** On payout_day: generates the weekly payout batch (M2.4). Runs daily, acts once on that day. */
  PAYOUT_BATCH = 'payout-batch',
}
