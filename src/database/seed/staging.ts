import { Container } from 'typedi';
import { addDays, cairoDate, cairoToUtc } from '../../utils/time/cairo';
import { AreaModel } from '../models/location/area.model';
import { GovernorateModel } from '../models/location/governorate.model';
import { CatalogServiceModel } from '../models/catalog/catalog-service.model';
import { UserModel } from '../models/user/user.model';
import { PatientProfileModel } from '../models/patient/patient-profile.model';
import { AddressModel } from '../models/patient/address.model';
import { ProviderProfileModel } from '../models/provider/provider-profile.model';
import { Gender, ProviderType, Relation, UserRole, VerificationStatus } from '../../interfaces/enums';
import { BookingType, PaymentMethod, PreferredGender } from '../../interfaces/IBooking';
import { BookingService, ProviderBookingService, QuoteService } from '../../services/booking';
import { ReviewService } from '../../services/aftercare';
import { invalidateCacheNamespace } from '../../utils/cache/cache';
import { PROVIDER_PRICES_CACHE } from '../../services/catalog';
import { runSeeds } from './index';
import { SPECIALTY_KEYS } from '../../services/catalog/specialties';

/**
 * Demo data for staging (spec §10 "Seed data for staging"): approved nurses spread over every active
 * area, patients with a home address, and bookings in several states — created through the real
 * booking services, so they obey every rule. Idempotent: accounts are keyed by reserved phone ranges
 * (+20100000xxxx patients, +20110000xxxx nurses, +20120000xxxx doctors) and skipped when they already exist.
 * Never run it against production (the script refuses).
 */

export type StagingSeedOptions = {
  providers?: number;
  doctors?: number;
  patients?: number;
  bookings?: number;
};

const FIRST_NAMES = {
  female: ['منى', 'سارة', 'هبة', 'نورا', 'مريم', 'ياسمين', 'دينا', 'ريهام', 'إيمان', 'آية'],
  male: ['أحمد', 'محمد', 'محمود', 'عمر', 'كريم', 'مصطفى', 'يوسف', 'خالد', 'طارق', 'حسن'],
};
const LAST_NAMES = ['حسن', 'علي', 'إبراهيم', 'عبد الله', 'السيد', 'فؤاد', 'سالم', 'منصور', 'رمضان', 'شاكر'];
const STREETS = ['شارع عباس العقاد', 'شارع مكرم عبيد', 'شارع التسعين', 'شارع النصر', 'شارع الثورة'];

/** Deterministic pseudo-random numbers, so re-runs produce the same data. */
const rng = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed / 2 ** 31;
};

export const seedStaging = async (options: StagingSeedOptions = {}) => {
  const providersWanted = options.providers ?? 200;
  const patientsWanted = options.patients ?? 50;
  const bookingsWanted = options.bookings ?? 40;
  const doctorsWanted = options.doctors ?? 30;
  const random = rng(42);
  const pick = <T>(list: T[]) => list[Math.floor(random() * list.length)];
  const name = (gender: Gender) =>
    `${pick(gender === Gender.FEMALE ? FIRST_NAMES.female : FIRST_NAMES.male)} ${pick(LAST_NAMES)}`;

  await runSeeds();
  const governorates = await GovernorateModel.find({ isActive: true }).lean();
  const areas = await AreaModel.find({
    isActive: true,
    governorateId: { $in: governorates.map((g) => g._id) },
  }).lean();
  const services = await CatalogServiceModel.find({
    isActive: true,
    providerType: ProviderType.NURSE,
  }).lean();
  if (!areas.length || !services.length) throw new Error('No active areas or services to seed against');

  // ── Providers: approved nurses, 2–4 areas each, 3–6 services, open 09:00–21:00 except Fridays ──
  let providersCreated = 0;
  for (let i = 1; i <= providersWanted; i++) {
    const phone = `+20110000${String(i).padStart(4, '0')}`;
    const gender = random() < 0.7 ? Gender.FEMALE : Gender.MALE;
    const fullName = name(gender);
    const home = pick(areas);
    const nearby = areas.filter((a) => String(a.governorateId) === String(home.governorateId));
    const coverage = [home, ...Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(nearby))];
    const offered = [...services].sort(() => random() - 0.5).slice(0, 3 + Math.floor(random() * 4));
    if (await UserModel.exists({ phone })) continue;

    const user = await UserModel.create({
      phone,
      fullName,
      gender,
      dateOfBirth: new Date(1975 + Math.floor(random() * 25), 0, 1),
      role: UserRole.PROVIDER,
    });
    await ProviderProfileModel.create({
      userId: user._id,
      type: ProviderType.NURSE,
      bio: 'ممرض/ة بخبرة في الرعاية المنزلية — بيانات تجريبية',
      yearsOfExperience: 1 + Math.floor(random() * 20),
      languages: ['ar'],
      licenseNumber: `STG-${String(i).padStart(5, '0')}`,
      syndicateNumber: `SYN-${String(i).padStart(5, '0')}`,
      verificationStatus: VerificationStatus.APPROVED,
      isAcceptingBookings: random() < 0.9,
      ratingAvg: 0,
      ratingCount: 0,
      serviceAreas: [...new Map(coverage.map((a) => [String(a._id), a])).values()].map((a) => ({
        areaId: a._id,
        travelFee: Math.min(a.maxTravelFee ?? 5000, 1000 * Math.floor(random() * 6)),
      })),
      services: offered.map((s) => {
        const min = s.minPrice ?? 10000;
        const max = s.maxPrice ?? min * 3;
        return {
          serviceId: s._id,
          price: Math.round((min + random() * (max - min)) / 500) * 500,
          isActive: true,
        };
      }),
      availability: [0, 1, 2, 3, 4, 6].map((dayOfWeek) => ({
        dayOfWeek,
        startTime: '09:00',
        endTime: '21:00',
      })),
    });
    providersCreated++;
  }

  // ── Doctors (M2.1): hidden until an admin activates the doctor home-visit category ──
  const doctorServices = await CatalogServiceModel.find({
    isActive: true,
    providerType: ProviderType.DOCTOR,
  }).lean();
  let doctorsCreated = 0;
  for (let i = 1; i <= doctorsWanted && doctorServices.length; i++) {
    const phone = `+20120000${String(i).padStart(4, '0')}`;
    const gender = random() < 0.5 ? Gender.FEMALE : Gender.MALE;
    const fullName = `د. ${name(gender)}`;
    const home = pick(areas);
    if (await UserModel.exists({ phone })) continue;
    const user = await UserModel.create({
      phone,
      fullName,
      gender,
      dateOfBirth: new Date(1965 + Math.floor(random() * 25), 0, 1),
      role: UserRole.PROVIDER,
    });
    await ProviderProfileModel.create({
      userId: user._id,
      type: ProviderType.DOCTOR,
      specialty: pick([...SPECIALTY_KEYS]),
      bio: 'طبيب/ة للزيارات المنزلية — بيانات تجريبية',
      yearsOfExperience: 3 + Math.floor(random() * 30),
      languages: ['ar', 'en'],
      licenseNumber: `STG-D-${String(i).padStart(5, '0')}`,
      syndicateNumber: `SYN-D-${String(i).padStart(5, '0')}`,
      verificationStatus: VerificationStatus.APPROVED,
      isAcceptingBookings: true,
      serviceAreas: [{ areaId: home._id, travelFee: Math.min(home.maxTravelFee ?? 5000, 2000) }],
      services: doctorServices.map((s) => ({
        serviceId: s._id,
        price: 30000 + 5000 * Math.floor(random() * 8),
        isActive: true,
      })),
      availability: [0, 1, 2, 3, 4, 6].map((dayOfWeek) => ({
        dayOfWeek,
        startTime: '16:00',
        endTime: '22:00',
      })),
    });
    doctorsCreated++;
  }

  // ── Patients: self profile + a default home address ──
  let patientsCreated = 0;
  for (let i = 1; i <= patientsWanted; i++) {
    const phone = `+20100000${String(i).padStart(4, '0')}`;
    if (await UserModel.exists({ phone })) continue;
    const gender = random() < 0.5 ? Gender.FEMALE : Gender.MALE;
    const fullName = name(gender);
    const dateOfBirth = new Date(1950 + Math.floor(random() * 50), 5, 1);
    const area = pick(areas);
    const user = await UserModel.create({ phone, fullName, gender, dateOfBirth, role: UserRole.PATIENT });
    await PatientProfileModel.create({
      ownerUserId: user._id,
      fullName,
      relation: Relation.SELF,
      gender,
      dateOfBirth,
    });
    await AddressModel.create({
      userId: user._id,
      label: 'البيت',
      governorateId: area.governorateId,
      areaId: area._id,
      street: pick(STREETS),
      building: String(1 + Math.floor(random() * 60)),
      isDefault: true,
    });
    patientsCreated++;
  }
  await invalidateCacheNamespace(PROVIDER_PRICES_CACHE);

  // ── Bookings through the real services: tomorrow/after, some accepted, some completed + reviewed ──
  const quotes = Container.get(QuoteService);
  const bookings = Container.get(BookingService);
  const providerBookings = Container.get(ProviderBookingService);
  const reviews = Container.get(ReviewService);
  const patients = await UserModel.find({ phone: /^\+20100000/, role: UserRole.PATIENT }).lean();
  let bookingsCreated = 0;
  let bookingsSkipped = 0;
  for (let i = 0; i < bookingsWanted && patients.length; i++) {
    const patient = patients[i % patients.length];
    const address = await AddressModel.findOne({ userId: patient._id, isDefault: true }).lean();
    const profile = await PatientProfileModel.findOne({
      ownerUserId: patient._id,
      relation: Relation.SELF,
    }).lean();
    if (!address || !profile) continue;
    const provider = await ProviderProfileModel.findOne({
      type: ProviderType.NURSE, // doctor services stay hidden until their category is activated
      'serviceAreas.areaId': address.areaId,
      verificationStatus: VerificationStatus.APPROVED,
      isAcceptingBookings: true,
    }).skip(i % 3);
    if (!provider) continue;
    const day = addDays(cairoDate(), 1 + (i % 7));
    const hour = 9 + ((i * 2) % 11);
    try {
      const quote = await quotes.quote(
        String(patient._id),
        {
          serviceId: String(provider.services[0].serviceId),
          providerId: String(provider._id),
          organizationId: null,
          patientProfileId: String(profile._id),
          addressId: String(address._id),
          type: BookingType.HOME_VISIT,
          preferredGender: PreferredGender.ANY,
          allowFallback: true,
          scheduledStart: cairoToUtc(day, `${String(hour).padStart(2, '0')}:00`),
          quantity: 1,
        },
        'ar',
      );
      const booking = await bookings.create(String(patient._id), {
        quoteToken: quote.token,
        paymentMethod: PaymentMethod.CASH,
        patientNotes: 'بيانات تجريبية',
      });
      bookingsCreated++;
      const id = String(booking._id);
      const providerUserId = String(provider.userId);
      if (i % 4 === 0) continue; // leave a quarter pending
      await providerBookings.accept(provider, id, providerUserId);
      if (i % 4 === 1) continue; // and a quarter accepted
      await providerBookings.onTheWay(provider, id, providerUserId);
      await providerBookings.start(provider, id, providerUserId);
      await providerBookings.complete(provider, id, providerUserId);
      await reviews.create(String(patient._id), id, {
        rating: 3 + Math.floor(random() * 3),
        comment: pick(['ممتازة ومحترمة', 'وصلت في الميعاد', 'خدمة جيدة', null]),
        tags: ['punctual'],
      });
    } catch {
      // Slot taken by an earlier seeded booking, etc. — staging data doesn't need every one.
      bookingsSkipped++;
    }
  }

  return { providersCreated, doctorsCreated, patientsCreated, bookingsCreated, bookingsSkipped };
};
