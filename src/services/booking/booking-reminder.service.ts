import { Container, Service } from 'typedi';
import { BookingModel } from '../../database/models/booking/booking.model';
import { BookingStatus, type IBooking } from '../../interfaces/IBooking';
import { NotificationType } from '../../interfaces/INotification';
import { logger } from '../../utils/logger/winston';
import { bookingParams, providerUserIds } from '../notification/booking-notifications';
import { NotificationService } from '../notification/notification.service';

const HOUR = 3600_000;
const REMINDABLE = [BookingStatus.ACCEPTED, BookingStatus.ON_THE_WAY];

/**
 * Visit reminders to patient and provider (spec §8): one when the visit is within 24 h, one within 1 h.
 * Run every minute by the maintenance queue. Each reminder is claimed with a conditional update before
 * sending, so concurrent sweeps can't send it twice. A visit booked less than an hour ahead only gets the
 * 1-hour one; sending it also marks the day one as done. Rescheduling resets both.
 */
@Service()
export class BookingReminderService {
  private readonly notifications = Container.get(NotificationService);

  async processDue(now = new Date()) {
    const soon = new Date(now.getTime() + HOUR);
    const tomorrow = new Date(now.getTime() + 24 * HOUR);
    let sent = 0;

    const hourDue = await BookingModel.find({
      status: { $in: REMINDABLE },
      scheduledStart: { $gt: now, $lte: soon },
      'remindersSent.hour': null,
    }).lean();
    for (const booking of hourDue) {
      const claimed = await BookingModel.findOneAndUpdate(
        { _id: booking._id, 'remindersSent.hour': null },
        { $set: { 'remindersSent.hour': now, 'remindersSent.day': booking.remindersSent?.day ?? now } },
      );
      if (claimed) sent += await this.send(booking, 'booking_reminder_hour');
    }

    const dayDue = await BookingModel.find({
      status: { $in: REMINDABLE },
      scheduledStart: { $gt: soon, $lte: tomorrow },
      'remindersSent.day': null,
    }).lean();
    for (const booking of dayDue) {
      const claimed = await BookingModel.findOneAndUpdate(
        { _id: booking._id, 'remindersSent.day': null },
        { $set: { 'remindersSent.day': now } },
      );
      if (claimed) sent += await this.send(booking, 'booking_reminder_day');
    }
    return sent;
  }

  private async send(booking: IBooking, template: 'booking_reminder_day' | 'booking_reminder_hour') {
    try {
      const recipients = [
        String(booking.patientUserId),
        ...(booking.providerProfileId ? await providerUserIds([String(booking.providerProfileId)]) : []),
      ];
      await this.notifications.notify(recipients, {
        type: NotificationType.BOOKING_REMINDER,
        template,
        params: await bookingParams(booking),
        data: { booking_id: String(booking._id) },
      });
      return 1;
    } catch (err) {
      logger.error(`Reminder failed for booking ${String(booking._id)}`, err);
      return 0;
    }
  }
}
