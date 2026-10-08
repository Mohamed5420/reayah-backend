import { Router } from 'express';
import { env } from '../../../config/env.config';
import { resolveLanguage, t, type Language, type TranslationKey } from '../../../utils/i18n';
import { PAGE_SCRIPT } from './page-script';

/**
 * Account deletion outside the app (Google Play requires a web link): `GET <prefix>/account-deletion`.
 * The page signs the person in with the normal OTP flow (same rate limits; test numbers included), shows
 * whose account it is, and closes it with `DELETE /me` — the same rules as in the app (no active
 * bookings). Tokens stay in the page's memory; cancelling logs the session out. Text comes from
 * `account_deletion_page.*` in the locales.
 */
export const accountDeletionRouter = Router();

const KEYS = [
  'title',
  'intro',
  'what_happens_title',
  'what_happens_1',
  'what_happens_2',
  'what_happens_3',
  'what_happens_4',
  'phone_label',
  'phone_hint',
  'send_code',
  'code_label',
  'code_sent',
  'verify',
  'no_account',
  'confirm_title',
  'confirm_body',
  'reason_label',
  'confirm_button',
  'cancel',
  'cancelled',
  'done_title',
  'done_body',
  'invalid_phone',
  'invalid_code',
  'network_error',
  'start_over',
] as const;

const strings = (lang: Language) =>
  Object.fromEntries(
    KEYS.map((k) => [k, t(`account_deletion_page.${k}` as TranslationKey, undefined, lang)]),
  );

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

const page = (lang: Language) => {
  const s = strings(lang);
  const h = (k: (typeof KEYS)[number]) => escapeHtml(s[k]);
  // The script reads its strings from a JSON block (not executed, so the default CSP allows it).
  const json = JSON.stringify({ apiBase: env.apiPrefix, strings: s }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${h('title')}</title>
<style>
:root { --bg: #f3f7f6; --card: #fff; --fg: #142420; --muted: #55675f; --line: #d4dfdb; --accent: #0e6a5a; --danger: #b3261e; --danger-bg: #fbe9e7; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --bg: #0f1614; --card: #16201d; --fg: #e3ebe8; --muted: #9fb2aa; --line: #2a3b36; --accent: #5cc4ae; --danger: #ffb4ab; --danger-bg: #3b1714; color-scheme: dark; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.7 "Segoe UI", Tahoma, "Noto Sans Arabic", system-ui, sans-serif; }
main { max-width: 520px; margin: 0 auto; padding: 32px 16px 48px; display: grid; gap: 18px; }
h1 { font-size: 26px; margin: 0; }
h2 { font-size: 17px; margin: 0; }
p { margin: 0; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 20px; display: grid; gap: 14px; }
.muted { color: var(--muted); }
ul { margin: 0; padding-inline-start: 20px; display: grid; gap: 6px; }
label { font-weight: 600; display: grid; gap: 6px; }
input, textarea { font: inherit; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--fg); width: 100%; }
input[inputmode="numeric"], input[type="tel"] { direction: ltr; text-align: start; letter-spacing: .04em; }
button { font: inherit; font-weight: 600; padding: 11px 16px; border-radius: 8px; border: 1px solid var(--accent); background: var(--accent); color: #fff; cursor: pointer; }
button.secondary { background: transparent; color: var(--accent); }
button.danger { background: var(--danger); border-color: var(--danger); }
button:disabled { opacity: .6; cursor: wait; }
button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.row { display: flex; gap: 10px; flex-wrap: wrap; }
.error { color: var(--danger); background: var(--danger-bg); padding: 10px 12px; border-radius: 8px; }
[hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <h1>${h('title')}</h1>
  <p class="muted">${h('intro')}</p>
  <section class="card">
    <h2>${h('what_happens_title')}</h2>
    <ul>
      <li>${h('what_happens_1')}</li>
      <li>${h('what_happens_2')}</li>
      <li>${h('what_happens_3')}</li>
      <li>${h('what_happens_4')}</li>
    </ul>
  </section>
  <p id="error" class="error" role="alert" hidden></p>
  <form id="step-phone" class="card" novalidate>
    <label for="phone">${h('phone_label')}
      <input id="phone" name="phone" type="tel" autocomplete="tel" placeholder="${h('phone_hint')}" required>
    </label>
    <button type="submit">${h('send_code')}</button>
  </form>
  <form id="step-code" class="card" novalidate hidden>
    <p id="code-sent" class="muted"></p>
    <label for="code">${h('code_label')}
      <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="4" required>
    </label>
    <div class="row">
      <button type="submit">${h('verify')}</button>
      <button type="button" class="secondary" data-restart>${h('start_over')}</button>
    </div>
  </form>
  <form id="step-confirm" class="card" novalidate hidden>
    <h2>${h('confirm_title')}</h2>
    <p id="confirm-body"></p>
    <label for="reason">${h('reason_label')}
      <textarea id="reason" name="reason" rows="3" maxlength="500"></textarea>
    </label>
    <div class="row">
      <button type="submit" class="danger">${h('confirm_button')}</button>
      <button type="button" class="secondary" id="cancel">${h('cancel')}</button>
    </div>
  </form>
  <section id="step-done" class="card" hidden>
    <h2 id="done-title"></h2>
    <p id="done-body"></p>
  </section>
</main>
<script type="application/json" id="config">${json}</script>
<script src="${env.apiPrefix}/account-deletion/app.js"></script>
</body>
</html>`;
};

accountDeletionRouter.get('/account-deletion', (req, res) => {
  res
    .set('Cache-Control', 'no-store')
    .type('html')
    .send(page(resolveLanguage(req)));
});

accountDeletionRouter.get('/account-deletion/app.js', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300').type('application/javascript').send(PAGE_SCRIPT);
});
