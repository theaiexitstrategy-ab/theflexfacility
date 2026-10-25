// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Shared browser code for the Fuel Agent pages. Each page sets
// <body data-slug="..."> and calls FuelAgent.init(). Everything
// challenge-specific (dates, coach name, copy) comes from the API.
//
// Exposes window.FuelAgent: { init, api, challenge, token, openJoin,
// openLog, openLink, track, fmt, signOut }.

(function () {
  'use strict';

  const API = '/api/fuel-challenge';
  const SLUG = document.body.dataset.slug;
  const TOKEN_KEY = 'fuelAgent:token:' + SLUG;
  const CHAT_KEY = 'fuelAgent:chat:' + SLUG;
  const MAX_UPLOAD = 25 * 1024 * 1024;
  const SOURCES = [
    { id: 'stair_machine_photo', label: 'Stair machine photo', hint: 'Snap the display right after your workout', camera: true },
    { id: 'watch_screenshot', label: 'Watch screenshot', hint: 'Apple Watch, Garmin, Fitbit, Samsung…' },
    { id: 'phone_app_screenshot', label: 'Phone app screenshot', hint: 'Apple Health/Fitness, Samsung Health, Google Fit…' },
  ];

  const state = { challenge: null, token: null, standing: null };

  // ─── Small helpers ────────────────────────────────────────────────
  const $ = (sel, root) => (root || document).querySelector(sel);
  const fmt = (n) => Number(n || 0).toLocaleString('en-US');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
  };
  function track(name, params) {
    try { if (typeof window.gtag === 'function') window.gtag('event', name, Object.assign({ challenge: SLUG }, params || {})); } catch { /* no GA */ }
  }

  async function api(action, opts) {
    opts = opts || {};
    const q = new URLSearchParams(Object.assign({ action: action }, opts.query || {}));
    const init = { method: opts.method || 'GET', headers: {} };
    if (opts.body) {
      init.method = 'POST';
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    let r;
    try {
      r = await fetch(API + '?' + q.toString(), init);
    } catch {
      throw Object.assign(new Error('You look offline. Check your connection and try again.'), { code: 'network' });
    }
    let data = null;
    try { data = await r.json(); } catch { /* not JSON */ }
    if (!r.ok || !data || data.ok === false) {
      const err = new Error((data && data.message) || 'Something went wrong. Try again.');
      err.code = data && data.error;
      err.status = r.status;
      throw err;
    }
    return data;
  }

  // Token: ?t= in the URL wins (from the emailed link), then localStorage.
  function loadToken() {
    const url = new URL(location.href);
    const t = url.searchParams.get('t');
    if (t) {
      store.set(TOKEN_KEY, t);
      url.searchParams.delete('t');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
    state.token = t || store.get(TOKEN_KEY);
    return state.token;
  }
  function setToken(t) { state.token = t; store.set(TOKEN_KEY, t); }
  function signOut() { state.token = null; store.del(TOKEN_KEY); }

  // ─── Time-zone math (mirrors lib/fuel/time.js) ────────────────────
  function offsetMin(instant, tz) {
    const p = {};
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(instant).forEach((x) => { p[x.type] = x.value; });
    return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - instant.getTime()) / 60000);
  }
  function zoned(date, tz) {
    const [y, m, d] = date.split('-').map(Number);
    const wall = Date.UTC(y, m - 1, d);
    let g = wall - offsetMin(new Date(wall), tz) * 60000;
    return new Date(wall - offsetMin(new Date(g), tz) * 60000);
  }
  function addDays(date, n) {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }
  function localToday(tz) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  }
  function dayLabel(date, today) {
    const nice = new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
    if (date === today) return 'Today · ' + nice;
    if (date === addDays(today, -1)) return 'Yesterday · ' + nice;
    return nice;
  }
  function shortRange(a, b) {
    const f = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    return f(a) + ' – ' + f(b);
  }
  // Days that can still be logged right now (server re-checks).
  function loggableDates(ch) {
    const tz = ch.timezone;
    const today = localToday(tz);
    const now = Date.now();
    const out = [];
    for (let i = 0; i < 9; i++) {
      const d = addDays(today, -i);
      if (d > ch.end_date || d < ch.start_date) continue;
      const closes = zoned(addDays(d, 1), tz).getTime() + ch.log_grace_hours * 3600000;
      if (now <= closes && now < new Date(ch.final_upload_deadline).getTime()) out.push(d);
    }
    return { dates: out, today: today };
  }

  // ─── Modals ───────────────────────────────────────────────────────
  function modal(id, title, html) {
    let m = document.getElementById(id);
    if (!m) {
      m = document.createElement('div');
      m.id = id;
      m.className = 'modal';
      m.setAttribute('role', 'dialog');
      m.setAttribute('aria-modal', 'true');
      m.innerHTML = '<div class="sheet"><div class="sheet-head"><h3></h3><button type="button" class="x" aria-label="Close">✕</button></div><div class="sheet-body"></div></div>';
      document.body.appendChild(m);
      m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('.x')) close(m); });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && m.classList.contains('open')) close(m); });
    }
    m.querySelector('h3').textContent = title;
    m.querySelector('.sheet-body').innerHTML = html;
    m.classList.add('open');
    document.body.style.overflow = 'hidden';
    const first = m.querySelector('input, select, button:not(.x)');
    if (first) setTimeout(() => first.focus(), 50);
    return m;
  }
  function close(m) { m.classList.remove('open'); document.body.style.overflow = ''; }

  // ─── Join ─────────────────────────────────────────────────────────
  function openJoin() {
    const ch = state.challenge;
    if (state.token) return openLog();
    if (ch && !['upcoming', 'live'].includes(ch.status)) {
      modal('fa-join', 'Joining is closed', '<p class="muted">This challenge is closed to new players. Watch for the next one!</p>');
      return;
    }
    const m = modal('fa-join', ch ? 'Join the challenge' : 'Join', `
      <form novalidate>
        <div class="row2">
          <div class="field"><label for="j-first">First name</label><input id="j-first" type="text" autocomplete="given-name" maxlength="40" required></div>
          <div class="field"><label for="j-last">Last name</label><input id="j-last" type="text" autocomplete="family-name" maxlength="40" required></div>
        </div>
        <div class="field"><label for="j-email">Email</label><input id="j-email" type="email" autocomplete="email" inputmode="email" required></div>
        <div class="field"><label for="j-phone">Phone <span class="muted">(optional)</span></label><input id="j-phone" type="tel" autocomplete="tel" inputmode="tel"></div>
        <label class="check"><input id="j-consent" type="checkbox"> <span>I agree to the <a href="/fuel/agent/rules" target="_blank" rel="noopener">challenge rules</a>. The leaderboard shows only my first name and last initial.</span></label>
        <p class="error" role="alert"></p>
        <button class="btn primary wide" type="submit">Join the challenge 💪🏾</button>
      </form>`);
    const form = $('form', m);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('button[type=submit]', form);
      const err = $('.error', form);
      err.textContent = '';
      btn.disabled = true;
      btn.textContent = 'Joining…';
      try {
        const r = await api('join', { body: {
          slug: SLUG,
          first_name: $('#j-first', form).value,
          last_name: $('#j-last', form).value,
          email: $('#j-email', form).value,
          phone: $('#j-phone', form).value || null,
          consent: $('#j-consent', form).checked,
        } });
        if (r.token) {
          setToken(r.token);
          track('fuel_join', { method: 'form' });
          $('.sheet-body', m).innerHTML = `
            <div class="agent-reply"><span class="emblem"><img src="/flex-logo.png" alt=""></span><span>You're in, ${esc(r.display_name)} 🙌🏾 ${r.emailed ? 'Your private link is in your email too.' : ''}</span></div>
            <p class="muted small" style="margin:14px 0">This phone stays signed in. Log your steps after every workout.</p>
            <div class="cta-stack"><button class="btn primary wide" type="button" data-act="log">Log steps</button><a class="btn ghost wide" href="/fuel/agent/me">My Challenge</a></div>`;
          $('[data-act=log]', m).addEventListener('click', () => { close(m); openLog(); });
          document.dispatchEvent(new CustomEvent('fuelagent:signedin'));
        } else {
          $('.sheet-body', m).innerHTML = '<div class="agent-reply"><span class="emblem"><img src="/flex-logo.png" alt=""></span><span>You\'re already in! 📬 We just emailed you a fresh link to sign in on this phone.</span></div>';
        }
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false;
        btn.textContent = 'Join the challenge 💪🏾';
      }
    });
  }

  // ─── Email me my link ─────────────────────────────────────────────
  function openLink() {
    const m = modal('fa-link', 'Sign in on this phone', `
      <p class="muted">Enter the email you joined with and we'll send your private My Challenge link.</p>
      <form novalidate>
        <div class="field"><label for="l-email">Email</label><input id="l-email" type="email" autocomplete="email" inputmode="email" required></div>
        <p class="error" role="alert"></p>
        <button class="btn primary wide" type="submit">Email my link</button>
        <p class="small muted" style="margin-top:14px">Not in yet? <button type="button" class="linkbtn" data-act="join">Join the challenge</button></p>
      </form>`);
    const form = $('form', m);
    $('[data-act=join]', m).addEventListener('click', () => { close(m); openJoin(); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('button[type=submit]', form);
      btn.disabled = true;
      try {
        const r = await api('resend-link', { body: { slug: SLUG, email: $('#l-email', form).value } });
        $('.sheet-body', m).innerHTML = `<div class="agent-reply"><span class="emblem"><img src="/flex-logo.png" alt=""></span><span>📬 ${esc(r.message)}</span></div>`;
      } catch (ex) {
        $('.error', form).textContent = ex.message;
        btn.disabled = false;
      }
    });
  }

  // ─── Log steps ────────────────────────────────────────────────────
  function mimeOf(file) {
    if (file.type) return file.type.toLowerCase();
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    return { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', heif: 'image/heif', webp: 'image/webp' }[ext] || '';
  }

  function putWithProgress(url, file, mime, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      xhr.setRequestHeader('Content-Type', mime);
      xhr.setRequestHeader('x-upsert', 'false');
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error('Upload failed. Try again.')));
      xhr.onerror = () => reject(new Error('Upload failed. Check your connection and try again.'));
      xhr.send(file);
    });
  }

  function openLog() {
    const ch = state.challenge;
    if (!state.token) return openLink();
    if (!ch) return;
    if (ch.status === 'upcoming') {
      modal('fa-log', 'Almost time', `<p class="muted">Logging opens ${esc(shortRange(ch.start_date, ch.end_date).split(' – ')[0])}. You're signed in and ready 💪🏾</p>`);
      return;
    }
    const { dates, today } = loggableDates(ch);
    if (!dates.length) {
      modal('fa-log', 'Logging is closed', '<p class="muted">There are no days left that can be logged. Final counts are being verified.</p>');
      return;
    }
    const m = modal('fa-log', 'Log your steps', `
      <form novalidate>
        <div class="field"><label for="g-date">Day</label>
          <select id="g-date">${dates.map((d) => `<option value="${d}">${esc(dayLabel(d, today))}</option>`).join('')}</select></div>
        <div class="field"><span class="label">Proof</span>
          <div class="choice" role="radiogroup">${SOURCES.map((s, i) => `
            <label><input type="radio" name="g-src" value="${s.id}" ${i === 0 ? 'checked' : ''}><span>${esc(s.label)}<small>${esc(s.hint)}</small></span></label>`).join('')}
          </div></div>
        <div class="field"><label for="g-steps">Steps on the screen</label>
          <input id="g-steps" type="text" inputmode="numeric" autocomplete="off" placeholder="e.g. 14,220" required></div>
        <div class="field">
          <label class="drop" for="g-file"><span>📸</span><b>Take or choose a photo</b><span class="small">JPG, PNG or HEIC</span><img alt="" hidden></label>
          <input id="g-file" class="sr-only" type="file" accept="image/*" capture="environment">
          <ul class="tips"><li>Show the full screen with the step number</li><li>No crops, no filters, no edits</li><li>Take it right after your workout</li></ul>
        </div>
        <div class="progress" hidden><i></i></div>
        <p class="error" role="alert"></p>
        <button class="btn primary wide" type="submit">Submit to the Fuel Agent</button>
      </form>`);
    const form = $('form', m);
    const fileInput = $('#g-file', form);
    const preview = $('.drop img', form);
    const err = $('.error', form);
    let file = null;

    // Camera straight away for the stair machine; library for screenshots.
    form.addEventListener('change', (e) => {
      if (e.target.name === 'g-src') {
        const src = SOURCES.find((s) => s.id === e.target.value);
        if (src.camera) fileInput.setAttribute('capture', 'environment'); else fileInput.removeAttribute('capture');
      }
    });
    fileInput.addEventListener('change', () => {
      file = fileInput.files && fileInput.files[0];
      err.textContent = '';
      if (!file) return;
      if (file.size > MAX_UPLOAD) { err.textContent = 'That photo is over 25 MB. Try a screenshot instead.'; file = null; return; }
      try {
        preview.src = URL.createObjectURL(file);
        preview.hidden = false;
        preview.onerror = () => { preview.hidden = true; }; // HEIC won't preview on most browsers
      } catch { preview.hidden = true; }
    });
    $('#g-steps', form).addEventListener('input', (e) => {
      const digits = e.target.value.replace(/\D/g, '').slice(0, 7);
      e.target.value = digits ? fmt(digits) : '';
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      const stepsN = parseInt($('#g-steps', form).value.replace(/\D/g, ''), 10);
      const source = (form.querySelector('input[name=g-src]:checked') || {}).value;
      const entryDate = $('#g-date', form).value;
      if (!stepsN) { err.textContent = 'Enter the steps shown on your screen.'; return; }
      if (!file) { err.textContent = 'Add your photo or screenshot.'; return; }
      const mime = mimeOf(file);
      if (!/^image\/(jpeg|png|heic|heif|webp)$/.test(mime)) { err.textContent = 'Use a JPG, PNG or HEIC photo.'; return; }

      const btn = $('button[type=submit]', form);
      const bar = $('.progress', form);
      btn.disabled = true;
      btn.textContent = 'Uploading…';
      bar.hidden = false;
      try {
        const up = await api('upload-url', { body: { t: state.token, filename: file.name, mime: mime } });
        await putWithProgress(up.upload_url, file, mime, (p) => { $('i', bar).style.width = Math.round(p * 85) + '%'; });
        btn.textContent = 'The Fuel Agent is checking…';
        $('i', bar).style.width = '92%';
        const r = await api('submit-entry', { body: { t: state.token, entry_date: entryDate, source: source, claimed_steps: stepsN, image_path: up.path } });
        $('i', bar).style.width = '100%';
        track('fuel_log_submit', { source: source });
        if (r.entry.status === 'counted') track('fuel_log_approved', { source: source });
        state.standing = r.standing;
        $('.sheet-body', m).innerHTML = `
          <div class="agent-reply"><span class="emblem"><img src="/flex-logo.png" alt=""></span><span>${esc(r.reply)}</span></div>
          <div class="cta-stack" style="margin-top:16px"><a class="btn ghost wide" href="/fuel/agent/me">See my entries</a><button class="btn primary wide" type="button" data-act="done">Done</button></div>`;
        $('[data-act=done]', m).addEventListener('click', () => close(m));
        document.dispatchEvent(new CustomEvent('fuelagent:logged', { detail: r }));
      } catch (ex) {
        if (ex.code === 'signed_out') { signOut(); close(m); openLink(); return; }
        err.textContent = ex.message;
        btn.disabled = false;
        btn.textContent = 'Submit to the Fuel Agent';
        bar.hidden = true;
      }
    });
  }

  // ─── Chat bubble ──────────────────────────────────────────────────
  function mountChat() {
    const ch = state.challenge;
    const name = (ch && ch.hero_copy && ch.hero_copy.agent_name) || 'Fuel Agent';
    const coach = (ch && ch.hero_copy && ch.hero_copy.coach_name) || 'the coach';
    const fab = document.createElement('button');
    fab.className = 'chat-fab';
    fab.type = 'button';
    fab.setAttribute('aria-label', 'Chat with the ' + name);
    fab.innerHTML = '<img src="/flex-logo.png" alt=""><span class="dot"></span>';
    const panel = document.createElement('div');
    panel.className = 'chat-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', name + ' chat');
    panel.innerHTML = `
      <div class="chat-head"><span class="emblem"><img src="/flex-logo.png" alt=""></span><div><b>${esc(name)}</b><small>AI coach · answers about this challenge</small></div><button type="button" class="x" aria-label="Close chat">✕</button></div>
      <div class="chat-log" aria-live="polite"></div>
      <div class="chat-chips"></div>
      <form class="chat-form"><input type="text" maxlength="500" placeholder="Ask the ${esc(name)}…" aria-label="Message"><button type="submit">Send</button></form>`;
    document.body.append(fab, panel);
    const log = $('.chat-log', panel);
    const chips = $('.chat-chips', panel);
    let history = [];
    try { history = JSON.parse(sessionStorage.getItem(CHAT_KEY) || '[]'); } catch { history = []; }

    function add(role, text, cls) {
      const el = document.createElement('div');
      el.className = 'msg ' + (role === 'user' ? 'me' : 'ai') + (cls ? ' ' + cls : '');
      el.textContent = text;
      log.appendChild(el);
      log.scrollTop = log.scrollHeight;
      return el;
    }
    function render() {
      log.innerHTML = '';
      add('assistant', `Hey! I'm the ${name} 💪🏾 Ask me about the rules, how to take a good photo, or how far you are from ${coach}.`);
      history.forEach((h) => add(h.role, h.content));
      chips.innerHTML = '';
      if (!history.length) {
        [`How far am I from ${coach}?`, 'How do I take a good photo?', 'What are the rules?'].forEach((q) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = q;
          b.addEventListener('click', () => send(q));
          chips.appendChild(b);
        });
      }
    }
    async function send(text) {
      text = String(text || '').trim();
      if (!text) return;
      history.push({ role: 'user', content: text });
      chips.innerHTML = '';
      add('user', text);
      const typing = add('assistant', '…', 'typing');
      try {
        const r = await api('agent-chat', { body: { slug: SLUG, t: state.token || undefined, messages: history.slice(-10) } });
        history.push({ role: 'assistant', content: r.reply });
        typing.remove();
        add('assistant', r.reply);
      } catch (ex) {
        history.pop();
        typing.remove();
        add('assistant', ex.message);
      }
      try { sessionStorage.setItem(CHAT_KEY, JSON.stringify(history.slice(-20))); } catch { /* private mode */ }
    }
    fab.addEventListener('click', () => {
      const open = panel.classList.toggle('open');
      if (open) { render(); setTimeout(() => $('input', panel).focus(), 50); }
      $('.dot', fab).hidden = true;
    });
    $('.x', panel).addEventListener('click', () => panel.classList.remove('open'));
    $('form', panel).addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('input', panel);
      const v = input.value;
      input.value = '';
      send(v);
    });
  }

  // ─── Init ─────────────────────────────────────────────────────────
  async function init(opts) {
    opts = opts || {};
    loadToken();
    document.addEventListener('click', (e) => {
      const a = e.target.closest('[data-fa]');
      if (!a) return;
      e.preventDefault();
      ({ join: openJoin, log: openLog, link: openLink }[a.dataset.fa] || function () {})();
    });
    try {
      const r = await api('challenge', { query: { slug: SLUG } });
      state.challenge = r.challenge;
    } catch (ex) {
      console.error('[fuel-agent] challenge load failed', ex);
    }
    if (opts.chat !== false) mountChat();
    return state.challenge;
  }

  window.FuelAgent = {
    init: init,
    api: api,
    track: track,
    fmt: fmt,
    esc: esc,
    shortRange: shortRange,
    openJoin: openJoin,
    openLog: openLog,
    openLink: openLink,
    signOut: signOut,
    get challenge() { return state.challenge; },
    get token() { return state.token; },
  };
})();
