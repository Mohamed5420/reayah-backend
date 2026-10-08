/**
 * Organization plans (spec §4.7). Prices and limits are placeholders for the admin to set; the free
 * starter plan lets a new organization begin without paying (decision M3.4).
 */
export const SEED_PLANS = [
  {
    key: 'starter',
    nameAr: 'الأساسية',
    nameEn: 'Starter',
    monthlyPrice: 0,
    maxStaff: 5,
    features: [{ ar: 'حتى 5 أفراد في الفريق', en: 'Up to 5 team members' }],
    isActive: true,
    isDefault: true,
    sortOrder: 1,
  },
  {
    key: 'growth',
    nameAr: 'النمو',
    nameEn: 'Growth',
    monthlyPrice: 150000,
    maxStaff: 25,
    features: [{ ar: 'حتى 25 فرداً في الفريق', en: 'Up to 25 team members' }],
    isActive: true,
    isDefault: false,
    sortOrder: 2,
  },
];
