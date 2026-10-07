import { PricingUnit, ProviderType } from '../../../interfaces/enums';

/** Spec §4.5 categories. Phase 1 is nursing only, so the others start inactive (admins enable them later). */
export const SEED_CATEGORIES = [
  { key: 'nursing', nameAr: 'تمريض منزلي', nameEn: 'Home nursing', isActive: true, sortOrder: 1 },
  {
    key: 'doctor_home_visit',
    nameAr: 'زيارة طبيب منزلية',
    nameEn: 'Doctor home visit',
    isActive: false,
    sortOrder: 2,
  },
  {
    key: 'video_consultation',
    nameAr: 'استشارة فيديو',
    nameEn: 'Video consultation',
    isActive: false,
    sortOrder: 3,
  },
  { key: 'elderly_care', nameAr: 'رعاية المسنين', nameEn: 'Elderly care', isActive: false, sortOrder: 4 },
  { key: 'packages', nameAr: 'باقات', nameEn: 'Packages', isActive: false, sortOrder: 5 },
];

type SeedService = {
  nameAr: string;
  nameEn: string;
  descriptionAr: string;
  pricingUnit: PricingUnit;
  defaultDurationMinutes: number;
};

/** Starter nursing services. Prices are set by each provider. */
export const SEED_NURSING_SERVICES: SeedService[] = [
  {
    nameAr: 'غيار على جرح',
    nameEn: 'Wound dressing',
    descriptionAr: 'تنظيف الجرح وتغيير الغيار بأدوات معقمة',
    pricingUnit: PricingUnit.PER_VISIT,
    defaultDurationMinutes: 45,
  },
  {
    nameAr: 'حقن عضل أو وريد',
    nameEn: 'Injection (IM / IV)',
    descriptionAr: 'إعطاء الحقن حسب روشتة الطبيب',
    pricingUnit: PricingUnit.PER_VISIT,
    defaultDurationMinutes: 20,
  },
  {
    nameAr: 'تركيب كانيولا ومحاليل',
    nameEn: 'Cannula and IV fluids',
    descriptionAr: 'تركيب كانيولا ومتابعة المحاليل الوريدية',
    pricingUnit: PricingUnit.PER_VISIT,
    defaultDurationMinutes: 60,
  },
  {
    nameAr: 'قياس العلامات الحيوية والسكر',
    nameEn: 'Vital signs and blood sugar',
    descriptionAr: 'قياس الضغط والنبض والحرارة ونسبة الأكسجين والسكر',
    pricingUnit: PricingUnit.PER_VISIT,
    defaultDurationMinutes: 30,
  },
  {
    nameAr: 'تركيب أو تغيير قسطرة بولية',
    nameEn: 'Urinary catheter insertion or change',
    descriptionAr: 'تركيب أو تغيير القسطرة البولية مع العناية بها',
    pricingUnit: PricingUnit.PER_VISIT,
    defaultDurationMinutes: 45,
  },
  {
    nameAr: 'تغذية بالأنبوب (رايل)',
    nameEn: 'Tube feeding (NG tube)',
    descriptionAr: 'تركيب أو متابعة أنبوب التغذية والتغذية من خلاله',
    pricingUnit: PricingUnit.PER_VISIT,
    defaultDurationMinutes: 30,
  },
  {
    nameAr: 'العناية بقرح الفراش',
    nameEn: 'Bedsore care',
    descriptionAr: 'تنظيف وعلاج قرح الفراش وتغيير وضعية المريض',
    pricingUnit: PricingUnit.PER_VISIT,
    defaultDurationMinutes: 45,
  },
  {
    nameAr: 'رعاية تمريضية بالساعة',
    nameEn: 'Hourly nursing care',
    descriptionAr: 'ممرض أو ممرضة لرعاية المريض بالساعة',
    pricingUnit: PricingUnit.PER_HOUR,
    defaultDurationMinutes: 60,
  },
  {
    nameAr: 'رعاية تمريضية يومية (24 ساعة)',
    nameEn: 'Daily nursing care (24 hours)',
    descriptionAr: 'ممرض أو ممرضة مقيم لرعاية المريض طوال اليوم',
    pricingUnit: PricingUnit.PER_DAY,
    defaultDurationMinutes: 1440,
  },
].map((service) => ({ ...service, providerType: ProviderType.NURSE }));

/**
 * Starter doctor home-visit services (M2.1). Their category starts inactive, so they stay hidden until
 * an admin activates "زيارة طبيب منزلية" for launch.
 */
export const SEED_DOCTOR_SERVICES: SeedService[] = [
  {
    nameAr: 'كشف منزلي',
    nameEn: 'Home consultation',
    descriptionAr: 'فحص المريض في البيت وتشخيص الحالة وكتابة العلاج',
    pricingUnit: PricingUnit.PER_VISIT,
    defaultDurationMinutes: 45,
  },
  {
    nameAr: 'متابعة منزلية',
    nameEn: 'Follow-up home visit',
    descriptionAr: 'زيارة متابعة لنفس الحالة بعد الكشف ومراجعة العلاج',
    pricingUnit: PricingUnit.PER_VISIT,
    defaultDurationMinutes: 30,
  },
  {
    nameAr: 'تقييم شامل لكبار السن',
    nameEn: 'Comprehensive elderly assessment',
    descriptionAr: 'تقييم شامل لحالة المريض المسن وأدويته وخطة الرعاية',
    pricingUnit: PricingUnit.PER_VISIT,
    defaultDurationMinutes: 60,
  },
].map((service) => ({ ...service, providerType: ProviderType.DOCTOR }));
