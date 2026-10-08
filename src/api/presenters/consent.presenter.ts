import type { IConsentDocument } from '../../interfaces/IConsent';
import type { ConsentService } from '../../services/consent/consent.service';
import type { Language } from '../../utils/i18n';
import { localized } from './localize';

export const presentConsentDocument = (d: IConsentDocument, lang: Language) => ({
  kind: d.kind,
  version: d.version,
  title: localized(d.titleAr, d.titleEn, lang),
  body: localized(d.bodyAr, d.bodyEn, lang),
  url: d.url,
  roles: d.roles,
  published_at: d.createdAt.toISOString(),
});

export const presentConsentStatus = (rows: Awaited<ReturnType<ConsentService['status']>>, lang: Language) =>
  rows.map((r) => ({
    kind: r.document.kind,
    current_version: r.document.version,
    title: localized(r.document.titleAr, r.document.titleEn, lang),
    accepted_version: r.acceptedVersion,
    accepted_at: r.acceptedAt?.toISOString() ?? null,
    withdrawn_at: r.withdrawnAt?.toISOString() ?? null,
    up_to_date: r.upToDate,
  }));

export const presentAdminConsentDocument = (d: IConsentDocument) => ({
  id: String(d._id),
  kind: d.kind,
  version: d.version,
  title_ar: d.titleAr,
  title_en: d.titleEn,
  body_ar: d.bodyAr,
  body_en: d.bodyEn,
  url: d.url,
  roles: d.roles,
  published_by: d.publishedBy ? String(d.publishedBy) : null,
  published_at: d.createdAt.toISOString(),
});
