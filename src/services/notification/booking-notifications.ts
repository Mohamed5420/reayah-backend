import { Container } from 'typedi';
import { ProviderProfileModel } from '../../database/models/provider/provider-profile.model';
import { OrganizationModel } from '../../database/models/organization/organization.models';
import { UserModel } from '../../database/models/user/user.model';
import { bookingEvents, type BookingEvent } from '../../events/booking.events';
import {
  AssignmentMode,
  BookingActor,
  BookingStatus,
  BookingType,
  type IBooking,
} from '../../interfaces/IBooking';
import { NotificationType } from '../../interfaces/INotification';
import type { Language } from '../../utils/i18n';
import { formatCairoDateTime } from '../../utils/time/cairo';
import { NotificationService, type NotificationTemplate } from './notification.service';

/**
 * Turns booking events into notifications (spec §8). Subscribed once at startup (`runServer`);
 * booking code never sends notifications itself.
 *
 *   status → recipient                       template
 *   accepted / declined / expired → patient   booking_accepted / _declined / _expired
 *   on_the_way / in_progress / no_show → patient
 *   completed → patient                       review_request (type review_request)
 *   cancelled → the other party (both if an admin cancelled)
 *   pending + 'sent_to_other_providers' → patient   booking_fallback
 *   new request → provider(s)                 booking_request / booking_offer / booking_rescheduled
 *   offer taken → providers who lost it       booking_offer_taken
 *   organization request → its owner           org_booking_request / _rescheduled / _returned / _offer
 *   assigned by the owner → the staff member    booking_assigned
 *   cancelled → also the organization's owner (unless the owner cancelled)
 */
export const registerBookingNotifications = () => {
  bookingEvents.subscribe((event) => handleBookingEvent(event));
};

const PATIENT_TEMPLATES: Partial<Record<BookingStatus, NotificationTemplate>> = {
  [BookingStatus.ACCEPTED]: 'booking_accepted',
  [BookingStatus.DECLINED]: 'booking_declined',
  [BookingStatus.EXPIRED]: 'booking_expired',
  [BookingStatus.ON_THE_WAY]: 'booking_on_the_way',
  [BookingStatus.IN_PROGRESS]: 'booking_started',
  [BookingStatus.NO_SHOW]: 'booking_no_show',
};

export const handleBookingEvent = async (event: BookingEvent) => {
  const notifications = Container.get(NotificationService);
  const booking = event.booking;
  const params = await bookingParams(booking);
  const data = { booking_id: String(booking._id) };

  if (event.type === 'new_request') {
    const template: NotificationTemplate =
      event.reason === 'rescheduled'
        ? 'booking_rescheduled'
        : // Fallback offers, and an owner's "send to all suitable" to their staff.
          booking.assignmentMode === AssignmentMode.BROADCAST ||
            booking.assignmentMode === AssignmentMode.ORGANIZATION
          ? 'booking_offer'
          : 'booking_request';
    const type =
      template === 'booking_offer' ? NotificationType.BOOKING_OFFER : NotificationType.BOOKING_REQUEST;
    await notifications.notify(await providerUserIds(event.providerProfileIds), {
      type,
      template,
      params,
      data,
    });
    return;
  }

  if (event.type === 'org_request') {
    const template: NotificationTemplate =
      event.reason === 'rescheduled'
        ? 'org_booking_rescheduled'
        : event.reason === 'returned'
          ? 'org_booking_returned'
          : event.reason === 'offer'
            ? 'org_booking_offer'
            : event.reason === 'time_changed'
              ? 'org_booking_time_changed'
              : 'org_booking_request';
    await notifications.notify(await ownerUserIds(event.organizationIds), {
      type: event.reason === 'offer' ? NotificationType.BOOKING_OFFER : NotificationType.BOOKING_REQUEST,
      template,
      params,
      data,
    });
    return;
  }

  if (event.type === 'assigned') {
    await notifications.notify(await providerUserIds([event.providerProfileId]), {
      type:
        event.reason === 'rescheduled' ? NotificationType.BOOKING_STATUS : NotificationType.BOOKING_REQUEST,
      template: event.reason === 'rescheduled' ? 'booking_time_changed' : 'booking_assigned',
      params,
      data,
    });
    return;
  }

  if (event.type === 'offer_taken') {
    await notifications.notify(await providerUserIds(event.providerProfileIds), {
      type: NotificationType.BOOKING_OFFER,
      template: 'booking_offer_taken',
      params,
      data,
    });
    return;
  }

  const statusData = { ...data, status: event.to };
  if (event.to === BookingStatus.PENDING) {
    if (event.reason === 'sent_to_other_providers') {
      await notifications.notify([booking.patientUserId], {
        type: NotificationType.BOOKING_STATUS,
        template: 'booking_fallback',
        params,
        data: statusData,
      });
    }
    return; // reschedules are announced to the provider through `new_request`
  }

  if (event.to === BookingStatus.CANCELLED) {
    const recipients = [
      ...(event.actor !== BookingActor.PATIENT ? [String(booking.patientUserId)] : []),
      // A provider never saw a booking that was still awaiting payment.
      ...(event.actor !== BookingActor.PROVIDER &&
      booking.providerProfileId &&
      event.from !== BookingStatus.AWAITING_PAYMENT
        ? await providerUserIds([String(booking.providerProfileId)])
        : []),
      // The organization's owner keeps track of its bookings.
      ...(booking.organizationId &&
      event.actor !== BookingActor.ORGANIZATION &&
      event.from !== BookingStatus.AWAITING_PAYMENT
        ? await ownerUserIds([String(booking.organizationId)])
        : []),
    ];
    await notifications.notify(recipients, {
      type: NotificationType.BOOKING_STATUS,
      template: 'booking_cancelled',
      params,
      data: statusData,
    });
    return;
  }

  if (event.to === BookingStatus.EXPIRED && event.reason === 'payment_timeout') {
    await notifications.notify([booking.patientUserId], {
      type: NotificationType.BOOKING_STATUS,
      template: 'booking_payment_expired',
      params,
      data: statusData,
    });
    return;
  }

  if (event.to === BookingStatus.COMPLETED) {
    await notifications.notify([booking.patientUserId], {
      type: NotificationType.REVIEW_REQUEST,
      template: 'review_request',
      params,
      data: statusData,
    });
    return;
  }

  // Clinic visits confirmed at once (C3): the patient gets the clinic and the visit code is in the app;
  // the doctor is told a new appointment is booked.
  if (event.to === BookingStatus.ACCEPTED && event.reason === 'instant_confirm') {
    await notifications.notify([booking.patientUserId], {
      type: NotificationType.BOOKING_STATUS,
      template: 'clinic_booking_confirmed',
      params,
      data: statusData,
    });
    if (booking.providerProfileId) {
      await notifications.notify(await providerUserIds([String(booking.providerProfileId)]), {
        type: NotificationType.BOOKING_REQUEST,
        template: 'clinic_booking_new',
        params,
        data: statusData,
      });
    }
    return;
  }
  if (
    event.to === BookingStatus.EXPIRED &&
    booking.type === BookingType.CLINIC_VISIT &&
    event.reason !== 'payment_timeout'
  ) {
    await notifications.notify([booking.patientUserId], {
      type: NotificationType.BOOKING_STATUS,
      template: 'clinic_booking_expired',
      params,
      data: { ...statusData, action: 'choose_again' },
    });
    return;
  }
  if (event.to === BookingStatus.NO_SHOW && booking.type === BookingType.CLINIC_VISIT) {
    await notifications.notify([booking.patientUserId], {
      type: NotificationType.BOOKING_STATUS,
      template: 'clinic_booking_no_show',
      params,
      data: statusData,
    });
    return;
  }

  const template = PATIENT_TEMPLATES[event.to];
  if (template) {
    await notifications.notify([booking.patientUserId], {
      type: NotificationType.BOOKING_STATUS,
      template,
      params,
      data: statusData,
    });
  }
};

/** Placeholder values for a booking, per recipient language. */
export const bookingParams = async (booking: IBooking) => {
  const provider = booking.providerProfileId ? await providerNameOf(String(booking.providerProfileId)) : '';
  return (lang: Language) => ({
    clinic: booking.clinic?.name ?? '',
    service: lang === 'en' && booking.service.nameEn ? booking.service.nameEn : booking.service.nameAr,
    time: formatCairoDateTime(booking.scheduledStart, lang),
    area: booking.address.areaNameAr,
    provider,
  });
};

export const providerUserIds = async (providerProfileIds: string[]) =>
  (
    await ProviderProfileModel.find({ _id: { $in: providerProfileIds } })
      .select('userId')
      .lean()
  ).map((p) => String(p.userId));

export const ownerUserIds = async (organizationIds: string[]) =>
  (
    await OrganizationModel.find({ _id: { $in: organizationIds } })
      .select('ownerUserId')
      .lean()
  ).map((o) => String(o.ownerUserId));

const providerNameOf = async (providerProfileId: string) => {
  const profile = await ProviderProfileModel.findById(providerProfileId).select('userId').lean();
  const user = profile ? await UserModel.findById(profile.userId).select('fullName').lean() : null;
  return user?.fullName ?? '';
};
