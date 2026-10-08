import { Container, Service } from 'typedi';
import { Types } from 'mongoose';
import { BookingModel } from '../../database/models/booking/booking.model';
import { ReviewModel } from '../../database/models/aftercare/aftercare.models';
import { ProviderProfileModel } from '../../database/models/provider/provider-profile.model';
import { UserModel } from '../../database/models/user/user.model';
import { BookingStatus } from '../../interfaces/IBooking';
import type { IReview } from '../../interfaces/IAftercare';
import type { Pagination } from '../../utils/response/pagination';
import { AlreadyReviewedError, ConflictError, NotFoundError } from '../../utils/types-errors';
import { AuditService, type AuditContext } from '../audit/audit.service';

/** Phone numbers, emails and links — contact details shouldn't be shared in public reviews. */
// Digits include Arabic-Indic (٠-٩) and Persian (۰-۹) forms — Arabic comments often use them.
const DIGIT = '[0-9\\u0660-\\u0669\\u06F0-\\u06F9]';
const CONTACT_PATTERN = new RegExp(
  `\\+?${DIGIT}(?:[\\s-]?${DIGIT}){7,}|[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+|https?://\\S+|www\\.\\S+`,
  'gi',
);
export const containsContact = (text: string | null) =>
  !!text && new RegExp(CONTACT_PATTERN.source, 'i').test(text);
export const maskContact = (text: string) => text.replace(CONTACT_PATTERN, '***');

/** "محمد ع." — reviewer shown by first name and initial only. */
export const reviewerName = (fullName: string | undefined) => {
  const [first = '', second = ''] = (fullName ?? '').trim().split(/\s+/);
  return second ? `${first} ${second[0]}.` : first;
};

/**
 * Reviews (spec §6.8, §7.8). One per completed booking. The provider's rating is recalculated right away
 * from visible reviews (create, hide, unhide) — cheap, and never stale.
 */
@Service()
export class ReviewService {
  private readonly audit = Container.get(AuditService);

  async create(
    userId: string,
    bookingId: string,
    input: { rating: number; comment?: string | null; tags?: string[] },
  ) {
    const booking = Types.ObjectId.isValid(bookingId)
      ? await BookingModel.findOne({ _id: bookingId, patientUserId: userId }).lean()
      : null;
    if (!booking) throw new NotFoundError('errors.booking_not_found');
    if (booking.status !== BookingStatus.COMPLETED || !booking.providerProfileId) {
      throw new ConflictError('errors.review_not_allowed');
    }
    if (await ReviewModel.exists({ bookingId: booking._id })) throw new AlreadyReviewedError();

    const comment = input.comment?.trim() || null;
    const review = await ReviewModel.create({
      bookingId: booking._id,
      patientUserId: userId,
      providerProfileId: booking.providerProfileId,
      rating: input.rating,
      comment,
      tags: input.tags ?? [],
      flagged: containsContact(comment),
    }).catch((err: unknown) => {
      // Two submits racing past the check above: the unique index on bookingId decides.
      if ((err as { code?: number }).code === 11000) throw new AlreadyReviewedError();
      throw err;
    });
    await this.recalculate(booking.providerProfileId);
    return review.toObject();
  }

  async hasReview(bookingId: Types.ObjectId | string) {
    return Boolean(await ReviewModel.exists({ bookingId }));
  }

  /** Visible reviews of a provider, newest first, with reviewer display names. */
  /** One provider, or (an organization's page) all of its staff. */
  async listForProvider(
    providerProfileId: Types.ObjectId | string | Types.ObjectId[],
    pagination: Pagination,
  ) {
    const query = {
      providerProfileId: Array.isArray(providerProfileId) ? { $in: providerProfileId } : providerProfileId,
      isVisible: true,
    };
    const [reviews, total] = await Promise.all([
      ReviewModel.find(query).sort({ createdAt: -1 }).skip(pagination.skip).limit(pagination.perPage).lean(),
      ReviewModel.countDocuments(query),
    ]);
    return { data: await this.withNames(reviews), total };
  }

  async recentForProvider(providerProfileId: Types.ObjectId | string | Types.ObjectId[], limit = 3) {
    const reviews = await ReviewModel.find({
      providerProfileId: Array.isArray(providerProfileId) ? { $in: providerProfileId } : providerProfileId,
      isVisible: true,
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    return this.withNames(reviews);
  }

  async adminList(filters: { flagged?: boolean; providerProfileId?: string }, pagination: Pagination) {
    const query = {
      ...(filters.flagged !== undefined ? { flagged: filters.flagged } : {}),
      ...(filters.providerProfileId ? { providerProfileId: filters.providerProfileId } : {}),
    };
    const [reviews, total] = await Promise.all([
      ReviewModel.find(query).sort({ createdAt: -1 }).skip(pagination.skip).limit(pagination.perPage).lean(),
      ReviewModel.countDocuments(query),
    ]);
    return { data: await this.withNames(reviews), total };
  }

  /** PATCH /admin/reviews/{id}: hide/show, or mask contact details (original kept). Audited. */
  async moderate(
    reviewId: string,
    input: { isVisible?: boolean; maskContact?: boolean },
    context: AuditContext,
  ) {
    const review = Types.ObjectId.isValid(reviewId) ? await ReviewModel.findById(reviewId) : null;
    if (!review) throw new NotFoundError('errors.review_not_found');
    const visibilityChanged = input.isVisible !== undefined && input.isVisible !== review.isVisible;
    if (input.isVisible !== undefined) review.isVisible = input.isVisible;
    if (input.maskContact && review.comment) {
      review.originalComment ??= review.comment;
      review.comment = maskContact(review.comment);
    }
    review.flagged = false; // reviewed by an admin
    await review.save();
    if (visibilityChanged) await this.recalculate(review.providerProfileId);
    await this.audit.log(context, {
      action: 'review.moderate',
      entityType: 'review',
      entityId: reviewId,
      metadata: { ...input },
    });
    return review.toObject();
  }

  /** ratingAvg (1 decimal) and ratingCount from visible reviews. */
  async recalculate(providerProfileId: Types.ObjectId | string) {
    const [stats] = await ReviewModel.aggregate<{ avg: number; count: number }>([
      { $match: { providerProfileId: new Types.ObjectId(String(providerProfileId)), isVisible: true } },
      { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
    ]);
    await ProviderProfileModel.updateOne(
      { _id: providerProfileId },
      { ratingAvg: stats ? Math.round(stats.avg * 10) / 10 : 0, ratingCount: stats?.count ?? 0 },
    );
  }

  /** Adds the reviewer display name ("محمد ع.") to each review. */
  async withNames(reviews: IReview[]) {
    const users = await UserModel.find({ _id: { $in: reviews.map((r) => r.patientUserId) } })
      .select('fullName')
      .setOptions({ withDeleted: true })
      .lean();
    const nameById = new Map(users.map((u) => [String(u._id), u.fullName]));
    return reviews.map((review) => ({
      review,
      patientName: reviewerName(nameById.get(String(review.patientUserId))),
    }));
  }
}
