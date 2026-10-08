import { BookingActor, BookingStatus, BookingType } from '../../interfaces/IBooking';

const { PATIENT, PROVIDER, ADMIN, SYSTEM } = BookingActor;
const S = BookingStatus;

/**
 * The booking state machine (spec §5): from → to → who may do it. Anything not listed is refused
 * with 409 INVALID_STATUS_TRANSITION. `accepted → pending` is a patient reschedule.
 */
const TRANSITIONS: Partial<Record<BookingStatus, Partial<Record<BookingStatus, BookingActor[]>>>> = {
  // Card / wallet: the request reaches the provider only once paid (SYSTEM, from the payment webhook).
  [S.AWAITING_PAYMENT]: {
    [S.PENDING]: [SYSTEM],
    [S.EXPIRED]: [SYSTEM],
    [S.CANCELLED]: [PATIENT, ADMIN],
  },
  [S.PENDING]: {
    [S.ACCEPTED]: [PROVIDER, ADMIN], // admin: only through reassign (it picks the provider)
    [S.DECLINED]: [PROVIDER],
    [S.EXPIRED]: [SYSTEM],
    [S.CANCELLED]: [PATIENT, ADMIN],
  },
  [S.ACCEPTED]: {
    [S.ON_THE_WAY]: [PROVIDER],
    [S.IN_PROGRESS]: [PROVIDER],
    [S.PENDING]: [PATIENT],
    [S.CANCELLED]: [PATIENT, PROVIDER, ADMIN],
    [S.NO_SHOW]: [PROVIDER, ADMIN],
  },
  [S.ON_THE_WAY]: {
    [S.IN_PROGRESS]: [PROVIDER],
    [S.CANCELLED]: [PATIENT, PROVIDER, ADMIN],
    [S.NO_SHOW]: [PROVIDER, ADMIN],
  },
  [S.IN_PROGRESS]: { [S.COMPLETED]: [PROVIDER, ADMIN] },
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
  // Video consultations have no journey (spec §5).
  if (to === S.ON_THE_WAY && type === BookingType.VIDEO) return false;
  return TRANSITIONS[from]?.[to]?.includes(actor) ?? false;
};

/** Statuses an actor can move a booking to from where it is now. */
export const nextStatuses = (from: BookingStatus, actor: BookingActor, type: BookingType) =>
  (Object.keys(TRANSITIONS[from] ?? {}) as BookingStatus[]).filter((to) =>
    canTransition(from, to, actor, type),
  );
