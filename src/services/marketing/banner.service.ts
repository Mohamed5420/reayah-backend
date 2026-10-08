import { Container, Service } from 'typedi';
import { Types } from 'mongoose';
import { BannerModel } from '../../database/models/marketing/marketing.models';
import { BannerAction, type IBanner } from '../../interfaces/IMarketing';
import { cached, invalidateCacheNamespace } from '../../utils/cache/cache';
import { NotFoundError, ValidationError } from '../../utils/types-errors';
import { AuditService, applyPatch, type AuditContext } from '../audit/audit.service';
import { StorageService } from '../storage/storage.service';

export const BANNERS_CACHE = 'banners';
const CACHE_TTL_SECONDS = 300;

export type BannerInput = {
  titleAr?: string | null;
  titleEn?: string | null;
  /** A temporary upload (purpose `banner`) to attach; required on create. */
  imageKey?: string;
  action?: BannerAction;
  value?: string | null;
  sortOrder?: number;
  isActive?: boolean;
  startsAt?: Date | null;
  endsAt?: Date | null;
};

type BannerRow = Omit<IBanner, 'startsAt' | 'endsAt' | 'createdAt' | 'updatedAt'> & {
  startsAt: string | null;
  endsAt: string | null;
};

/** Home banners (spec §7.3 `/home`, §7.15 marketing). Images live in the private bucket under `banners/`. */
@Service()
export class BannerService {
  private readonly audit = Container.get(AuditService);
  private readonly storage = Container.get(StorageService);

  /** Banners showing now, in order (cached; the date window is applied on every call). */
  async active(now = new Date()) {
    const rows = await cached(BANNERS_CACHE, 'active', CACHE_TTL_SECONDS, async () => {
      const docs = await BannerModel.find({ isActive: true }).sort({ sortOrder: 1, createdAt: -1 }).lean();
      return docs.map((b): BannerRow => ({
        ...b,
        startsAt: b.startsAt ? b.startsAt.toISOString() : null,
        endsAt: b.endsAt ? b.endsAt.toISOString() : null,
      }));
    });
    return rows.filter(
      (b) => (!b.startsAt || new Date(b.startsAt) <= now) && (!b.endsAt || new Date(b.endsAt) > now),
    );
  }

  list() {
    return BannerModel.find().sort({ sortOrder: 1, createdAt: -1 }).lean();
  }

  async create(input: BannerInput, context: AuditContext) {
    if (!input.imageKey) throw new ValidationError({ image_key: ['validation.required'] });
    const banner = new BannerModel({ ...input, imageKey: await this.attach(input.imageKey, context) });
    assertBannerRules(banner);
    await banner.save();
    await this.afterWrite(context, 'banner.create', String(banner._id), { input });
    return banner.toObject();
  }

  async update(id: string, patch: BannerInput, context: AuditContext) {
    const banner = Types.ObjectId.isValid(id) ? await BannerModel.findById(id) : null;
    if (!banner) throw new NotFoundError('errors.banner_not_found');
    const imageKey = patch.imageKey ? await this.attach(patch.imageKey, context) : undefined;
    const changes = applyPatch(banner, { ...patch, imageKey });
    assertBannerRules(banner);
    if (Object.keys(changes).length) {
      await banner.save();
      await this.afterWrite(context, 'banner.update', id, { changes });
    }
    return banner.toObject();
  }

  async remove(id: string, context: AuditContext) {
    const banner = Types.ObjectId.isValid(id) ? await BannerModel.findById(id) : null;
    if (!banner) throw new NotFoundError('errors.banner_not_found');
    await banner.softDelete();
    await this.afterWrite(context, 'banner.delete', id, {});
  }

  imageUrl(key: string) {
    return this.storage.signedUrl(key);
  }

  private attach(tempKey: string, context: AuditContext) {
    return this.storage.promote(tempKey, {
      ownerId: String(context.actorId),
      purpose: 'banner',
      destPrefix: 'banners',
    });
  }

  private async afterWrite(
    context: AuditContext,
    action: string,
    id: string,
    metadata: Record<string, unknown>,
  ) {
    await this.audit.log(context, { action, entityType: 'banner', entityId: id, metadata });
    await invalidateCacheNamespace(BANNERS_CACHE);
  }
}

/** `value` must fit `action`: a code, an id, an https link, or nothing. */
const assertBannerRules = (banner: Pick<IBanner, 'action' | 'value' | 'startsAt' | 'endsAt'>) => {
  const value = banner.value ?? null;
  const ok =
    banner.action === BannerAction.NONE
      ? value === null
      : banner.action === BannerAction.PROMO
        ? !!value && /^[A-Za-z0-9_-]{2,32}$/.test(value)
        : banner.action === BannerAction.URL
          ? !!value && /^https:\/\/\S+$/.test(value)
          : !!value && Types.ObjectId.isValid(value) && /^[a-f\d]{24}$/i.test(value);
  if (!ok) throw new ValidationError({ value: ['validation.banner_value'] });
  if (banner.startsAt && banner.endsAt && banner.endsAt <= banner.startsAt) {
    throw new ValidationError({ ends_at: ['validation.valid_to_after_from'] });
  }
};
