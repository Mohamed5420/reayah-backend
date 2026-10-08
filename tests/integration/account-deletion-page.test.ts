import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { useTestDatabase } from '../helpers/db';
import { loginWithOtp, signUp } from '../helpers/fixtures';
import { UserModel } from '../../src/database/models/user/user.model';
import { PAGE_SCRIPT } from '../../src/api/routers/account-deletion/page-script';

/** Launch: the account-deletion web page Google Play links to. */

useTestDatabase();
const app = createTestApp();

describe('account deletion page', () => {
  it('serves an Arabic page and its script under the default CSP', async () => {
    const page = await request(app).get('/api/v1/account-deletion').expect(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.headers['content-security-policy']).toMatch(/script-src 'self'/);
    expect(page.text).toContain('<html lang="ar" dir="rtl">');
    expect(page.text).toContain('حذف حساب رعاية+');
    expect(page.text).toContain('src="/api/v1/account-deletion/app.js"');

    const script = await request(app).get('/api/v1/account-deletion/app.js').expect(200);
    expect(script.headers['content-type']).toMatch(/javascript/);
    expect(() => new Function(PAGE_SCRIPT)).not.toThrow();
  });

  it('the calls the page makes close the account (OTP → DELETE /me)', async () => {
    const session = await signUp(app);
    const verified = await loginWithOtp(app, session.phone);
    await request(app)
      .delete('/api/v1/me')
      .set('Authorization', `Bearer ${verified.access_token}`)
      .send({ reason: 'من صفحة الحذف' })
      .expect(202);
    const user = await UserModel.findById(session.user.id).setOptions({ withDeleted: true }).lean();
    expect(user!.status).toBe('deleted');
  });
});
