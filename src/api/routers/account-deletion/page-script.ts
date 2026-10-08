/**
 * The account-deletion page's script (served as `account-deletion/app.js`, so the default CSP — scripts
 * from 'self' only — applies). Plain ES5, no build step; strings come from the page's JSON block.
 */
export const PAGE_SCRIPT = String.raw`(function () {
  'use strict';
  var config = JSON.parse(document.getElementById('config').textContent);
  var s = config.strings;
  var api = config.apiBase;
  var state = { phone: null, access: null, refresh: null };
  var steps = ['step-phone', 'step-code', 'step-confirm', 'step-done'];

  function $(id) { return document.getElementById(id); }
  function hideError() { $('error').hidden = true; }
  function showError(message) { var e = $('error'); e.textContent = message; e.hidden = false; }
  function show(id) {
    steps.forEach(function (step) { $(step).hidden = step !== id; });
    hideError();
    var first = $(id).querySelector('input, textarea, button');
    if (first) first.focus();
  }
  function done(title, body) { $('done-title').textContent = title; $('done-body').textContent = body; show('step-done'); }
  function fill(text, params) {
    return text.replace(/\{\{(\w+)\}\}/g, function (match, key) { return params[key] != null ? params[key] : match; });
  }
  // Arabic-Indic (٠-٩) and Persian (۰-۹) digits → ASCII.
  function asciiDigits(value) {
    return value.replace(/[٠-٩۰-۹]/g, function (d) {
      var c = d.charCodeAt(0);
      return String(c >= 0x06f0 ? c - 0x06f0 : c - 0x0660);
    });
  }
  function normalizePhone(value) {
    var v = asciiDigits(value).replace(/[\s\-().]/g, '');
    if (/^00/.test(v)) v = '+' + v.slice(2);
    if (/^01\d{9}$/.test(v)) v = '+2' + v;
    if (/^201\d{9}$/.test(v)) v = '+' + v;
    return /^\+201[0125]\d{8}$/.test(v) ? v : null;
  }
  function call(method, path, body, token) {
    var headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    return fetch(api + path, {
      method: method,
      headers: headers,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'omit',
    }).then(
      function (res) {
        return res.text().then(function (text) {
          var payload = null;
          try { payload = text ? JSON.parse(text) : null; } catch (e) { payload = null; }
          if (!res.ok) throw new Error((payload && payload.error && payload.error.message) || s.network_error);
          return payload && payload.data;
        });
      },
      function () { throw new Error(s.network_error); }
    );
  }
  function onSubmit(form, run) {
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      hideError();
      var buttons = form.querySelectorAll('button');
      Array.prototype.forEach.call(buttons, function (b) { b.disabled = true; });
      Promise.resolve()
        .then(run)
        .catch(function (err) { showError(err.message); })
        .then(function () { Array.prototype.forEach.call(buttons, function (b) { b.disabled = false; }); });
    });
  }

  onSubmit($('step-phone'), function () {
    var phone = normalizePhone($('phone').value);
    if (!phone) throw new Error(s.invalid_phone);
    return call('POST', '/auth/otp/request', { phone: phone }).then(function () {
      state.phone = phone;
      $('code-sent').textContent = fill(s.code_sent, { phone: phone });
      $('code').value = '';
      show('step-code');
    });
  });

  onSubmit($('step-code'), function () {
    var code = asciiDigits($('code').value.trim());
    if (!/^\d{4}$/.test(code)) throw new Error(s.invalid_code);
    return call('POST', '/auth/otp/verify', { phone: state.phone, code: code }).then(function (data) {
      if (data.is_new_user) return done(s.title, s.no_account);
      state.access = data.access_token;
      state.refresh = data.refresh_token;
      $('confirm-body').textContent = fill(s.confirm_body, { name: (data.user && data.user.full_name) || state.phone });
      show('step-confirm');
    });
  });

  onSubmit($('step-confirm'), function () {
    var reason = $('reason').value.trim();
    return call('DELETE', '/me', reason ? { reason: reason } : {}, state.access).then(function () {
      state.access = null;
      state.refresh = null;
      done(s.done_title, s.done_body);
    });
  });

  $('cancel').addEventListener('click', function () {
    var refresh = state.refresh;
    state.access = null;
    state.refresh = null;
    if (refresh) call('POST', '/auth/logout', { refresh_token: refresh }).catch(function () {});
    done(s.title, s.cancelled);
  });

  Array.prototype.forEach.call(document.querySelectorAll('[data-restart]'), function (button) {
    button.addEventListener('click', function () { state.phone = null; show('step-phone'); });
  });
})();
`;
