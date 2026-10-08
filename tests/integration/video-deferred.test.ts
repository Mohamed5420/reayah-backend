import request from 'supertest';
import { Container } from 'typedi';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { useTestDatabase } from '../helpers/db';
import { createUserWithToken } from '../helpers/fixtures';
import { createBookingWorld, tomorrowAt, type BookingWorld } from '../helpers/booking-world';
import { ServiceCategoryModel } from '../../src/database/models/catalog/service-category.model';
import { UserRole } from '../../src/interfaces/enums';
import { SettingsService } from '../../src/services/settings';
import { VIDEO_CATEGORY_KEY } from '../../src/services/catalog/catalog.service';

/**
 * M2.6 (video consultations) is deferred: with `features.video_consult` off — the default — the video
 * category and its services stay out of every public lookup, search and booking, even if an admin
 * activates the category, and `type = video` is refused.
 */

useTestDatabase();
const app = createTestApp();

let world: BookingWorld;
let admin: Awaited<ReturnType<typeof createUserWithToken>>;
let videoServiceId: string;

beforeEach(async () => {
  world = await createBookingWorld(app);
  admin = await createUserWithToken(UserRole.ADMIN);
  const category = await ServiceCategoryModel.findOne({ key: VIDEO_CATEGORY_KEY }).lean();
  await request(app)
    .patch(`/api/v1/admin/service-categories/${String(category!._id)}`)
    .set('Authorization', admin.auth)
    .send({ is_active: true })
    .expect(200);
  const service = await request(app)
    .post('/api/v1/admin/services')
    .set('Authorization', admin.auth)
    .send({
      category_id: String(category!._id),
      name_ar: 'استشارة فيديو تمريضية',
      provider_type: 'nurse',
      pricing_unit: 'per_visit',
      default_duration_minutes: 30,
    })
    .expect(201);
  videoServiceId = service.body.data.id;
});

const setVideoFlag = (on: boolean) =>
  Container.get(SettingsService).update(
    { features: { video_consult: on, card_payment: false, packages: false } },
    { actorId: null },
  );

describe('video consultations while deferred', () => {
  it('the flag is off by default and app-config says so', async () => {
    const config = await request(app).get('/api/v1/app-config');
    expect(config.body.data.features.video_consult).toBe(false);
  });

  it('the video category and its services are hidden from lookups, search and booking', async () => {
    const patient = await world.newPatient();
    const categories = await request(app).get('/api/v1/service-categories');
    expect(categories.body.data.map((c: { key: string }) => c.key)).not.toContain(VIDEO_CATEGORY_KEY);
    const services = await request(app).get('/api/v1/services');
    expect(services.body.data.map((s: { id: string }) => s.id)).not.toContain(videoServiceId);
    expect((await request(app).get(`/api/v1/services/${videoServiceId}`)).status).toBe(404);

    const search = await request(app)
      .get(`/api/v1/providers?service_id=${videoServiceId}&area_id=${world.nasrCity}`)
      .set('Authorization', patient.auth);
    expect(search.status).toBe(404);

    const home = await request(app).get('/api/v1/home').set('Authorization', patient.auth);
    expect(home.body.data.categories.map((c: { key: string }) => c.key)).not.toContain(VIDEO_CATEGORY_KEY);

    // Turning the flag on shows the category the admin activated (no cache delay).
    await setVideoFlag(true);
    const shown = await request(app).get('/api/v1/service-categories');
    expect(shown.body.data.map((c: { key: string }) => c.key)).toContain(VIDEO_CATEGORY_KEY);
    expect((await request(app).get(`/api/v1/services/${videoServiceId}`)).status).toBe(200);
  });

  it('a booking with type = video is refused', async () => {
    const patient = await world.newPatient();
    const provider = await world.newProvider();
    const quote = await world.quote(patient, provider, {
      type: 'video',
      scheduled_start: tomorrowAt('10:00'),
    });
    expect(quote.status).toBe(422);
    expect(quote.body.error.fields.type).toBeDefined();
  });
});
