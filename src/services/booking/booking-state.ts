import { BookingActor, BookingStatus, BookingType } from '../../interfaces/IBooking';

const { PATIENT, PROVIDER, ORGANIZATION, ADMIN, SYSTEM } = BookingActor;
const S = BookingStatus;

/**
 * The booking state machine (spec §5): from → to → who may do it. Anything not listed is refused
 * with 409 INVALID_STATUS_TRANSITION. `accepted → pending` is a patient reschedule, or (ORGANIZATION) a
 * booking taken back from a staff member who was removed — it returns to the owner's queue.
 */
const TRANSITIONS: Partial<Record<BookingStatus, Partial<Record<BookingStatus, BookingActor[]>>>> = {
  // Card / wallet: the request reaches the provider only once paid (SYSTEM, from the payment webhook).
  [S.AWAITING_PAYMENT]: {
    [S.PENDING]: [SYSTEM],
    [S.EXPIRED]: [SYSTEM],
    [S.CANCELLED]: [PATIENT, ADMIN],
  },
  [S.PENDING]: {
    // admin: only through reassign (it picks the provider); organization: the owner assigns a staff member
    [S.ACCEPTED]: [PROVIDER, ORGANIZATION, ADMIN],
    [S.DECLINED]: [PROVIDER, ORGANIZATION],
    [S.EXPIRED]: [SYSTEM],
    [S.CANCELLED]: [PATIENT, ADMIN],
  },
  [S.ACCEPTED]: {
    [S.ON_THE_WAY]: [PROVIDER],
    [S.IN_PROGRESS]: [PROVIDER],
    [S.PENDING]: [PATIENT, ORGANIZATION],
    [S.CANCELLED]: [PATIENT, PROVIDER, ORGANIZATION, ADMIN],
    [S.NO_SHOW]: [PROVIDER, ADMIN],
  },
  [S.ON_THE_WAY]: {
    [S.IN_PROGRESS]: [PROVIDER],
    [S.PENDING]: [ORGANIZATION],
    [S.CANCELLED]: [PATIENT, PROVIDER, ORGANIZATION, ADMIN],
    [S.NO_SHOW]: [PROVIDER, ADMIN],
  },
  [S.IN_PROGRESS]: { [S.COMPLETED]: [PROVIDER, ADMIN], [S.PENDING]: [ORGANIZATION] },
  [S.COMPLETED]: { [S.DISPUTED]: [PATIENT, ADMIN] },
  // A patient can contest a no-show the provider recorded.
  [S.NO_SHOW]: { [S.DISPUTED]: [PATIENT, ADMIN] },
};

export const canTransition = (
  from: BookingStatus,
  to: BookingStatus,
  actor: BookingActor,
  type: BookingType,
) => {
  // Video consultations and clinic visits have no journey (spec §5; clinic visits C3).
  if (to === S.ON_THE_WAY && (type === BookingType.VIDEO || type === BookingType.CLINIC_VISIT)) return false;
  // Clinic visits with instant confirmation: the system confirms a free appointment (when booked, or
  // once paid) — clinic visits only.
  if (
    type === BookingType.CLINIC_VISIT &&
    actor === SYSTEM &&
    to === S.ACCEPTED &&
    (from === S.PENDING || from === S.AWAITING_PAYMENT)
  ) {
    return true;
  }
  return TRANSITIONS[from]?.[to]?.includes(actor) ?? false;
};

/** Statuses an actor can move a booking to from where it is now. */
export const nextStatuses = (from: BookingStatus, actor: BookingActor, type: BookingType) =>
  (Object.keys(TRANSITIONS[from] ?? {}) as BookingStatus[]).filter((to) =>
    canTransition(from, to, actor, type),
  );
