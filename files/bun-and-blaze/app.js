(function () {
  'use strict';

  const MINE_KEY = 'bunblaze.mine.v2';
  const MANAGER_KEY = 'bunblaze.manager.v2';
  const STATUS_LABEL = {
    pending: 'Awaiting approval',
    confirmed: 'Approved',
    seated: 'Seated',
    cancelled: 'Cancelled'
  };
  const ACTIVE_STATUSES = ['confirmed', 'seated', 'cancelled'];

  /* helpers */
  const $ = (sel, root) => (root || document).querySelector(sel);

  function todayISO() {
    const d = new Date();
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
  }
  function shiftISO(iso, days) {
    const d = new Date(iso + 'T12:00:00');
    d.setDate(d.getDate() + days);
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
  }
  function fmtDate(iso) {
    if (!iso) return '';
    return new Date(iso + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }
  function fmtTime(t) {
    if (!t) return '';
    const parts = t.split(':').map(Number);
    const suffix = parts[0] >= 12 ? 'pm' : 'am';
    const hour = parts[0] % 12 === 0 ? 12 : parts[0] % 12;
    return hour + (parts[1] ? ':' + String(parts[1]).padStart(2, '0') : '') + ' ' + suffix;
  }
  function esc(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function plural(n, word) {
    return n + ' ' + word + (Number(n) === 1 ? '' : 's');
  }

  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-on'), 3400);
  }

  /* api + session */
  function managerCode() {
    try { return sessionStorage.getItem(MANAGER_KEY) || ''; } catch (err) { return ''; }
  }
  function setManagerCode(code) {
    try {
      if (code) sessionStorage.setItem(MANAGER_KEY, code);
      else sessionStorage.removeItem(MANAGER_KEY);
    } catch (err) { /* ignore */ }
  }
  function mineRefs() {
    try {
      const parsed = JSON.parse(localStorage.getItem(MINE_KEY) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) { return []; }
  }
  function saveMineRefs(refs) {
    try { localStorage.setItem(MINE_KEY, JSON.stringify(refs.slice(-25))); } catch (err) { /* ignore */ }
  }

  async function api(path, options) {
    const opts = options || {};
    const headers = { 'content-type': 'application/json' };
    const code = managerCode();
    if (code) headers['x-manager-code'] = code;

    let res;
    try {
      res = await fetch('/api/' + path, {
        method: opts.method || 'GET',
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
      });
    } catch (err) {
      throw new Error('Could not reach the booking service. Check your connection and try again.');
    }

    let data = null;
    try { data = await res.json(); } catch (err) { data = null; }
    if (!res.ok) {
      const error = new Error((data && data.error) || 'Something went wrong (' + res.status + ').');
      error.status = res.status;
      throw error;
    }
    return data || {};
  }

  /* routing */
  let officeStarted = false;

  function showView(name) {
    const office = name === 'office';
    const customerView = $('#customer-view');
    const officeView = $('#office-view');
    customerView.hidden = office;
    officeView.hidden = !office;
    const visible = office ? officeView : customerView;
    visible.classList.remove('view-in');
    void visible.offsetWidth;
    visible.classList.add('view-in');
    if (office) {
      startOffice();
    } else {
      stopPolling();
      renderMine();
    }
  }

  function goTo(target) {
    const name = String(target || 'home').replace('#', '');
    if (name === 'office' || name === 'manager') {
      showView('office');
      window.scrollTo(0, 0);
      if (location.hash !== '#office') history.replaceState(null, '', '#office');
      return;
    }
    showView('home');
    const el = document.getElementById(name);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      history.replaceState(null, '', '#' + name);
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      history.replaceState(null, '', '#home');
    }
  }

  document.addEventListener('click', (e) => {
    const link = e.target.closest('a[href^="#"]');
    if (!link) return;
    const href = link.getAttribute('href');
    if (!href || href === '#') return;
    e.preventDefault();
    goTo(href.slice(1));
  });

  window.addEventListener('hashchange', () => {
    const name = location.hash.replace('#', '');
    if (!name) return;
    if (name === 'office' || name === 'manager') showView('office');
    else goTo(name);
  });

  /* customer: the flow */
  const flowEl = $('#flow');
  const form = $('#booking-form');
  const partySelect = $('#party');
  const dateSelect = $('#date');
  const timeSelect = $('#time');
  const formError = $('#form-error');
  const flowState = { party: '', date: '', time: '' };
  let capacity = 20;
  let timeRequest = 0;

  function stepEl(n) {
    return flowEl ? flowEl.querySelector('[data-step="' + n + '"]') : null;
  }
  function setStepValue(n, text) {
    const el = stepEl(n);
    const value = el && el.querySelector('[data-value]');
    if (value) value.textContent = text;
  }
  function openStep(n) {
    for (let i = 1; i <= 4; i += 1) {
      const el = stepEl(i);
      if (!el) continue;
      el.hidden = i > n;
      el.classList.toggle('is-open', i === n);
      el.classList.toggle('is-done', i < n);
      const edit = el.querySelector('[data-edit]');
      if (edit) edit.hidden = i >= n;
    }
  }

  function buildDateOptions() {
    if (!dateSelect) return;
    const days = [];
    for (let i = 0; i < 30; i += 1) {
      const iso = shiftISO(todayISO(), i);
      const label = i === 0 ? 'Today \u00b7 ' + fmtDate(iso) : i === 1 ? 'Tomorrow \u00b7 ' + fmtDate(iso) : fmtDate(iso);
      days.push('<option value="' + iso + '">' + label + '</option>');
    }
    dateSelect.innerHTML = '<option value="">Choose a day</option>' + days.join('');
  }

  async function loadTimes() {
    if (!timeSelect) return;
    const token = (timeRequest += 1);
    timeSelect.disabled = true;
    timeSelect.innerHTML = '<option value="">Checking seats\u2026</option>';
    setStepValue(3, 'Checking seats\u2026');

    let data;
    try {
      data = await api('slots?date=' + encodeURIComponent(flowState.date));
    } catch (err) {
      if (token !== timeRequest) return;
      timeSelect.innerHTML = '<option value="">Could not load seats</option>';
      setStepValue(3, err.message);
      timeSelect.disabled = false;
      return;
    }
    if (token !== timeRequest) return;

    capacity = Number(data.capacity) || 20;
    const party = Number(flowState.party) || 1;
    const slots = data.slots || [];
    const options = slots.map((slot) => {
      const left = Math.max(0, capacity - slot.used);
      const closed = Boolean(slot.closed);
      const full = left < party;
      const label = closed ? 'closed by the restaurant' : full ? 'fully booked' : plural(left, 'seat') + ' left';
      return '<option value="' + esc(slot.time) + '"' + (closed || full ? ' disabled' : '') + '>' +
        esc(fmtTime(slot.time)) + ' \u2014 ' + esc(label) +
        '</option>';
    });
    timeSelect.innerHTML = '<option value="">Choose a seating</option>' + options.join('');
    timeSelect.disabled = false;

    const anyOpen = slots.some((slot) => !slot.closed && capacity - slot.used >= party);
    setStepValue(3, anyOpen ? 'Pick a time' : 'Nothing left for this party size');
  }

  function resetFlow() {
    flowState.party = '';
    flowState.date = '';
    flowState.time = '';
    if (partySelect) partySelect.value = '';
    if (dateSelect) dateSelect.value = '';
    if (timeSelect) timeSelect.innerHTML = '<option value="">Choose a seating</option>';
    setStepValue(1, 'Choose a party size');
    setStepValue(2, 'Choose a day');
    setStepValue(3, 'Choose a seating');
    openStep(1);
  }

  function showFormError(msg) {
    if (!formError) return;
    formError.textContent = msg;
    formError.hidden = !msg;
  }

  function confirmationCard(res) {
    return (
      '<div class="confirm__card">' +
        '<div class="confirm__top">' +
          '<p class="confirm__title">Request sent.</p>' +
          '<span class="confirm__ref">' + esc(res.ref) + '</span>' +
        '</div>' +
        '<div class="confirm__meta">' +
          '<div><span>Date</span>' + esc(fmtDate(res.date)) + '</div>' +
          '<div><span>Seating</span>' + esc(fmtTime(res.time)) + '</div>' +
          '<div><span>Guests</span>' + esc(res.party) + '</div>' +
          '<div><span>Under</span>' + esc(res.name) + '</div>' +
        '</div>' +
        '<p class="confirm__status"><span class="chip chip--pending">Awaiting approval</span></p>' +
        '<p class="confirm__note">The floor team approves requests from the back office. Keep reference ' + esc(res.ref) + ' \u2014 the status updates under \u201cRecent bookings\u201d below.</p>' +
      '</div>'
    );
  }

  if (flowEl) {
    buildDateOptions();

    partySelect.addEventListener('change', () => {
      flowState.party = partySelect.value;
      if (!flowState.party) return;
      showFormError('');
      setStepValue(1, 'Party of ' + flowState.party);
      flowState.date = '';
      flowState.time = '';
      if (dateSelect) dateSelect.value = '';
      if (timeSelect) timeSelect.innerHTML = '<option value="">Choose a seating</option>';
      openStep(2);
    });

    dateSelect.addEventListener('change', () => {
      flowState.date = dateSelect.value;
      if (!flowState.date) return;
      showFormError('');
      setStepValue(2, fmtDate(flowState.date));
      flowState.time = '';
      openStep(3);
      loadTimes();
    });

    timeSelect.addEventListener('change', () => {
      flowState.time = timeSelect.value;
      if (!flowState.time) return;
      showFormError('');
      setStepValue(3, fmtTime(flowState.time));
      openStep(4);
      const details = stepEl(4);
      if (details) details.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const nameField = $('#name');
      if (nameField) setTimeout(() => nameField.focus({ preventScroll: true }), 350);
    });

    flowEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-edit]');
      if (!btn) return;
      const n = Number(btn.closest('[data-step]').getAttribute('data-step'));
      if (!n || n < 2) return;
      if (n <= 2) {
        flowState.date = '';
        flowState.time = '';
        if (dateSelect) dateSelect.value = '';
      }
      if (n <= 3) {
        flowState.time = '';
        if (timeSelect) timeSelect.innerHTML = '<option value="">Choose a seating</option>';
        setStepValue(3, 'Choose a seating');
      }
      openStep(n);
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = $('#name').value.trim();
      const phone = $('#phone').value.trim();
      const email = $('#email').value.trim();

      if (!flowState.party) return showFormError('Choose how many guests are coming.');
      if (!flowState.date) return showFormError('Choose a day for your table.');
      if (!flowState.time) return showFormError('Choose a seating time.');
      if (name.length < 2) return showFormError('We need a name for the table.');
      if (phone.replace(/\D/g, '').length < 7) return showFormError('Add a phone number so we can reach you.');
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return showFormError('That email looks off \u2014 check it or leave it blank.');
      showFormError('');

      const button = form.querySelector('button[type="submit"]');
      const label = button.textContent;
      button.disabled = true;
      button.textContent = 'Sending\u2026';

      try {
        const payload = await api('reservations', {
          method: 'POST',
          body: {
            name,
            phone,
            email,
            date: flowState.date,
            time: flowState.time,
            party: Number(flowState.party),
            occasion: $('#occasion').value,
            notes: $('#notes').value.trim()
          }
        });
        const reservation = payload.reservation;
        saveMineRefs(mineRefs().concat([reservation.ref]));

        const confirm = $('#confirm');
        confirm.innerHTML = confirmationCard(reservation);
        confirm.hidden = false;

        form.reset();
        resetFlow();
        toast('Request sent \u2014 reference ' + reservation.ref);
        confirm.scrollIntoView({ behavior: 'smooth', block: 'center' });
        renderMine();
      } catch (err) {
        showFormError(err.message);
      } finally {
        button.disabled = false;
        button.textContent = label;
      }
    });
  }

  /* customer: my bookings */
  async function renderMine() {
    const section = $('#mine');
    const list = $('#mine-list');
    if (!section || !list) return;

    const refs = mineRefs();
    if (!refs.length) {
      section.hidden = true;
      list.innerHTML = '';
      return;
    }

    list.innerHTML = '<p class="slots__note slots__note--dark">Loading your bookings\u2026</p>';
    try {
      const data = await api('mine?refs=' + encodeURIComponent(refs.join(',')));
      const bookings = (data.reservations || []).slice().sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
      section.hidden = bookings.length === 0;
      if (!bookings.length) return;

      list.innerHTML = bookings.map((r) => (
        '<div class="mine-item' + (r.status === 'cancelled' ? ' is-cancelled' : '') + '">' +
          '<div class="mine-item__when">' + esc(fmtDate(r.date)) + ' \u00b7 ' + esc(fmtTime(r.time)) + '</div>' +
          '<div class="mine-item__who">' + esc(r.name) + ' \u00b7 ' + esc(plural(r.party, 'guest')) +
            '<br><span class="mine-item__ref">' + esc(r.ref) + '</span></div>' +
          '<span class="chip chip--' + esc(r.status) + '">' + esc(STATUS_LABEL[r.status] || r.status) + '</span>' +
          (r.status === 'cancelled' ? '' : '<button class="link-btn link-btn--danger" type="button" data-cancel="' + esc(r.ref) + '">Cancel</button>') +
        '</div>'
      )).join('');
    } catch (err) {
      list.innerHTML = '<p class="slots__note slots__note--bad">' + esc(err.message) + '</p>';
      section.hidden = false;
    }
  }

  const mineList = $('#mine-list');
  if (mineList) {
    mineList.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-cancel]');
      if (!btn) return;
      const ref = btn.getAttribute('data-cancel');
      btn.disabled = true;
      try {
        await api('reservations/' + encodeURIComponent(ref) + '/cancel', { method: 'POST' });
        toast('Booking ' + ref + ' cancelled.');
        renderMine();
        if (managerCode()) loadOffice(true);
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
      }
    });
  }

  const clearMine = $('#clear-mine');
  if (clearMine) {
    clearMine.addEventListener('click', () => {
      saveMineRefs([]);
      renderMine();
      toast('Cleared from this device\u2019s history.');
    });
  }

  /* back office */
  let officeDate = todayISO();
  let officeFilter = 'all';
  let officeRows = [];
  let officeSlots = [];
  let officeTimer = null;

  function markSync() {
    const el = $('#m-sync');
    if (!el) return;
    el.textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function startPolling() {
    stopPolling();
    officeTimer = setInterval(() => {
      if (!$('#office-view').hidden && managerCode()) loadOffice(true);
    }, 8000);
  }
  function stopPolling() {
    if (officeTimer) {
      clearInterval(officeTimer);
      officeTimer = null;
    }
  }

  /* inactivity auto-lock */
  let inactivityTimer = null;
  function resetInactivity() {
    if (!managerCode()) return;
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      if (managerCode() && !$('#gate').hidden) {
        lockOffice('You\u2019ve been away \u2014 the back office locked itself for safety.');
        toast('Back office locked due to inactivity.');
      }
      inactivityTimer = null;
    }, 300000);
  }
  function attachInactivity() {
    if (!document.body) return;
    const events = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'];
    let running = false;
    const tick = () => {
      if (running) return;
      running = true;
      requestAnimationFrame(() => {
        running = false;
        resetInactivity();
      });
    };
    for (const ev of events) {
      document.body.addEventListener(ev, tick, { passive: true });
    }
  }

  function startOffice() {
    const unlocked = Boolean(managerCode());
    $('#gate').hidden = unlocked;
    $('#dash').hidden = !unlocked;
    if (!unlocked) {
      stopPolling();
      return;
    }
    const dateEl = $('#m-date');
    if (dateEl && !dateEl.value) dateEl.value = officeDate;
    officeDate = (dateEl && dateEl.value) || todayISO();
    if (!officeStarted) {
      officeStarted = true;
      loadOffice();
    } else {
      loadOffice(true);
    }
    startPolling();
    attachInactivity();
    resetInactivity();
  }

  function lockOffice(message) {
    if (inactivityTimer) {
      clearTimeout(inactivityTimer);
      inactivityTimer = null;
    }
    stopPolling();
    setManagerCode('');
    const live = $('#m-live');
    if (live) live.hidden = true;
    $('#dash').hidden = true;
    $('#gate').hidden = false;
    const err = $('#gate-error');
    if (err) {
      err.textContent = message || '';
      err.hidden = !message;
    }
  }

  async function loadOffice(silent) {
    const rowsEl = $('#m-rows');
    const queueEl = $('#m-queue');
    if (!rowsEl || !queueEl) return;
    const dateEl = $('#m-date');
    officeDate = (dateEl && dateEl.value) || todayISO();

    if (!silent) {
      rowsEl.innerHTML = '<div class="empty">Loading the board\u2026</div>';
      queueEl.innerHTML = '<div class="empty">Loading requests\u2026</div>';
    }

    let board;
    let seats;
    try {
      const results = await Promise.all([
        api('reservations?date=' + encodeURIComponent(officeDate)),
        api('slots?date=' + encodeURIComponent(officeDate))
      ]);
      board = results[0];
      seats = results[1];
    } catch (err) {
      if (err.status === 401) {
        lockOffice('Your session ended \u2014 enter the passcode again.');
        return;
      }
      rowsEl.innerHTML = '<div class="empty"><strong>Could not load the board</strong>' + esc(err.message) + '</div>';
      queueEl.innerHTML = '';
      return;
    }

    officeRows = board.reservations || [];
    capacity = Number(seats.capacity) || 20;
    officeSlots = seats.slots || [];
    const clearDemo = $('#m-clear-demo');
    if (clearDemo) clearDemo.hidden = !Number(board.demoCount || 0);
    paintOffice();
    markSync();
  }

  function paintOffice() {
    const pending = officeRows
      .filter((r) => r.status === 'pending')
      .sort((a, b) => a.time.localeCompare(b.time) || a.name.localeCompare(b.name));
    const active = officeRows.filter((r) => r.status !== 'cancelled');
    const covers = active.reduce((sum, r) => sum + Number(r.party || 0), 0);
    const seated = officeRows.filter((r) => r.status === 'seated').reduce((sum, r) => sum + Number(r.party || 0), 0);
    const approved = officeRows.filter((r) => r.status === 'confirmed').length;

    $('#m-stats').innerHTML = [
      { label: 'Waiting for approval', value: pending.length, alert: pending.length > 0 },
      { label: 'Approved', value: approved },
      { label: 'Covers booked', value: covers },
      { label: 'Seated covers', value: seated }
    ].map((s) => (
      '<div class="stat' + (s.alert ? ' stat--alert' : '') + '">' +
        '<span class="stat__label">' + esc(s.label) + '</span>' +
        '<span class="stat__value">' + esc(s.value) + '</span>' +
      '</div>'
    )).join('');

    const countEl = $('#m-pending-count');
    if (countEl) {
      countEl.textContent = pending.length;
      countEl.setAttribute('data-empty', pending.length ? '0' : '1');
    }

    const queueEl = $('#m-queue');
    queueEl.innerHTML = pending.length
      ? pending.map(queueCard).join('')
      : '<div class="queue__empty"><strong>All caught up.</strong>New requests land here the moment a customer books.</div>';

    paintServiceList();
    paintLoad();
  }

  function queueCard(r) {
    return (
      '<article class="req">' +
        '<div class="req__top">' +
          '<span class="req__time">' + esc(fmtTime(r.time)) + '</span>' +
          '<span class="req__party">' + esc(plural(r.party, 'guest')) + '</span>' +
          '<span class="req__ref">' + esc(r.ref) + '</span>' +
        '</div>' +
        '<h3 class="req__name">' + esc(r.name) + '</h3>' +
        '<p class="req__contact">' + esc(r.phone) + (r.email ? ' &middot; ' + esc(r.email) : '') + '</p>' +
        (r.occasion ? '<p class="req__contact">Occasion: ' + esc(r.occasion) + '</p>' : '') +
        (r.notes ? '<p class="req__note">' + esc(r.notes) + '</p>' : '') +
        '<div class="req__actions">' +
          '<button class="btn" type="button" data-id="' + esc(r.id) + '" data-set="confirmed">Approve</button>' +
          '<button class="btn btn--ghost req__decline" type="button" data-id="' + esc(r.id) + '" data-set="cancelled">Decline</button>' +
        '</div>' +
      '</article>'
    );
  }

  function paintServiceList() {
    const rowsEl = $('#m-rows');
    const countEl = $('#m-count');
    if (!rowsEl) return;

    const listed = officeRows
      .filter((r) => ACTIVE_STATUSES.indexOf(r.status) !== -1)
      .filter((r) => officeFilter === 'all' || r.status === officeFilter)
      .sort((a, b) => a.time.localeCompare(b.time) || a.name.localeCompare(b.name));

    if (countEl) countEl.textContent = plural(listed.length, 'booking');

    if (!listed.length) {
      rowsEl.innerHTML = '<div class="empty"><strong>Nothing here yet</strong>' +
        (officeRows.length ? 'No bookings match that filter for this date.' : 'No bookings for this date.') + '</div>';
      return;
    }

    const groups = new Map();
    listed.forEach((r) => {
      if (!groups.has(r.time)) groups.set(r.time, []);
      groups.get(r.time).push(r);
    });

    rowsEl.innerHTML = Array.from(groups.keys())
      .sort()
      .map((time) => {
        const group = groups.get(time);
        const covers = group.filter((r) => r.status !== 'cancelled').reduce((sum, r) => sum + Number(r.party || 0), 0);
        return (
          '<details class="group" open>' +
            '<summary class="group__sum">' +
              '<span class="group__time">' + esc(fmtTime(time)) + '</span>' +
              '<span class="group__meta">' + esc(plural(group.length, 'booking')) + ' &middot; ' + esc(plural(covers, 'cover')) + '</span>' +
            '</summary>' +
            '<div class="group__body">' + group.map(serviceRow).join('') + '</div>' +
          '</details>'
        );
      }).join('');
  }

  function serviceRow(r) {
    const actions = [];
    actions.push('<button class="link-btn" type="button" data-edit-id="' + esc(r.id) + '">Edit</button>');
    if (r.status === 'confirmed') {
      actions.push('<button class="btn" type="button" data-id="' + esc(r.id) + '" data-set="seated">Seat</button>');
    }
    if (r.status !== 'cancelled') {
      actions.push('<button class="btn btn--ghost" type="button" data-id="' + esc(r.id) + '" data-set="cancelled">Cancel</button>');
    }
    if (r.status === 'seated' || r.status === 'cancelled') {
      actions.push('<button class="link-btn" type="button" data-id="' + esc(r.id) + '" data-set="confirmed">Reopen</button>');
    }
    if (r.status === 'cancelled') {
      actions.push('<button class="link-btn link-btn--danger" type="button" data-id="' + esc(r.id) + '" data-delete="1">Delete</button>');
    }

    return (
      '<article class="row' + (r.status === 'cancelled' ? ' row--cancelled' : '') + '">' +
        '<div class="row__time">' + esc(fmtTime(r.time)) +
          '<span class="row__party">' + esc(plural(r.party, 'guest')) + '</span></div>' +
        '<div>' +
          '<div class="row__name">' + esc(r.name) +
            ' <span class="chip chip--' + esc(r.status) + '">' + esc(STATUS_LABEL[r.status] || r.status) + '</span></div>' +
          '<div class="row__contact">' + esc(r.phone) + (r.email ? ' &middot; ' + esc(r.email) : '') + ' &middot; ' + esc(r.ref) + '</div>' +
          (r.notes ? '<div class="row__note">' + esc(r.notes) + '</div>' : '') +
          (r.occasion ? '<div class="row__contact">Occasion: ' + esc(r.occasion) + '</div>' : '') +
        '</div>' +
        '<div class="row__side"><div class="row__actions">' + actions.join('') + '</div></div>' +
      '</article>'
    );
  }

  function paintLoad() {
    const el = $('#m-load');
    if (!el) return;
    if (!officeSlots.length) {
      el.innerHTML = '<p class="slots__note slots__note--dark">No seat data.</p>';
      return;
    }
    el.innerHTML = officeSlots.map((slot) => {
      const pct = Math.min(100, Math.round((slot.used / capacity) * 100));
      const closed = Boolean(slot.closed);
      return (
        '<div class="load__row' + (closed ? ' is-closed' : slot.used >= capacity ? ' is-full' : '') + '">' +
          '<span class="load__time">' + esc(fmtTime(slot.time)) + '</span>' +
          '<span class="load__bar"><span class="load__fill" style="width:' + (closed ? 100 : pct) + '%"></span></span>' +
          '<span class="load__count">' + (closed ? 'shut' : slot.used + '/' + capacity) + '</span>' +
          '<button class="load__toggle" type="button" data-seat-time="' + esc(slot.time) + '" data-seat-closed="' + (closed ? '0' : '1') + '">' +
            (closed ? 'Reopen' : 'Close') +
          '</button>' +
        '</div>'
      );
    }).join('');
  }

  async function setStatus(id, status) {
    try {
      await api('reservations/' + encodeURIComponent(id), { method: 'PATCH', body: { status } });
      toast(status === 'confirmed' ? 'Approved \u2014 the customer sees it straight away.'
        : status === 'seated' ? 'Marked as seated.'
        : status === 'cancelled' ? 'Declined. The seats are free again.'
        : 'Booking updated.');
      await loadOffice(true);
    } catch (err) {
      toast(err.message);
      throw err;
    }
  }

  async function deleteBooking(id) {
    try {
      await api('reservations/' + encodeURIComponent(id), { method: 'DELETE' });
      toast('Booking deleted.');
      await loadOffice(true);
    } catch (err) {
      toast(err.message);
    }
  }

  /* booking sheet: edit an existing booking or add one at the desk */
  const sheet = $('#booking-sheet');
  const sheetForm = $('#sheet-form');
  const sheetTitle = $('#sheet-title');
  let sheetMode = 'edit';
  let sheetId = null;

  function fillOptions(select, options, value) {
    if (!select) return;
    select.innerHTML = options.map((o) =>
      '<option value="' + esc(o.value) + '"' + (o.disabled ? ' disabled' : '') +
      (String(o.value) === String(value) ? ' selected' : '') + '>' + esc(o.label) + '</option>'
    ).join('');
  }

  async function openSheet(mode, booking) {
    if (!sheet) return;
    if (!officeSlots.length) {
      try {
        const seats = await api('slots?date=' + encodeURIComponent(officeDate));
        officeSlots = seats.slots || [];
        capacity = Number(seats.capacity) || capacity;
      } catch (err) {
        toast(err.message);
        return;
      }
    }
    sheetMode = mode;
    sheetId = booking ? booking.id : null;
    sheetTitle.textContent = mode === 'new' ? 'Add a booking \u00b7 ' + fmtDate(officeDate) : 'Edit ' + booking.ref;
    fillOptions($('#s-party'), Array.from({ length: 8 }, (_, i) => ({ value: i + 1, label: plural(i + 1, 'guest') })), booking ? booking.party : 2);
    fillOptions($('#s-time'), officeSlots.map((slot) => ({
      value: slot.time,
      label: fmtTime(slot.time) + (slot.closed ? ' \u2014 closed' : ' \u2014 ' + slot.used + '/' + capacity + ' seats taken'),
      disabled: slot.closed && !(booking && booking.time === slot.time)
    })), booking ? booking.time : (officeSlots.find((slot) => !slot.closed) || officeSlots[0] || {}).time);
    $('#s-name').value = booking ? booking.name : '';
    $('#s-phone').value = booking ? booking.phone : '';
    $('#s-occasion').value = booking ? booking.occasion : '';
    $('#s-notes').value = booking ? booking.notes : '';
    $('#s-error').hidden = true;
    $('#s-save').textContent = mode === 'new' ? 'Add booking' : 'Save changes';
    if (typeof sheet.showModal === 'function') sheet.showModal();
    else sheet.setAttribute('open', '');
    setTimeout(() => $('#s-name').focus(), 80);
  }

  function closeSheet() {
    if (!sheet) return;
    if (typeof sheet.close === 'function') sheet.close();
    else sheet.removeAttribute('open');
  }

  async function toggleSeating(time, closed) {
    try {
      await api('seating', { method: 'POST', body: { date: officeDate, time, closed } });
      toast(fmtTime(time) + (closed ? ' closed to online bookings.' : ' reopened for bookings.'));
      await loadOffice(true);
    } catch (err) {
      toast(err.message);
    }
  }

  if (sheet && sheetForm) {
    sheet.addEventListener('click', (e) => {
      if (e.target === sheet || e.target.closest('[data-close]')) closeSheet();
    });

    sheetForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errorEl = $('#s-error');
      errorEl.hidden = true;
      const payload = {
        name: $('#s-name').value.trim(),
        phone: $('#s-phone').value.trim(),
        party: Number($('#s-party').value),
        time: $('#s-time').value,
        occasion: $('#s-occasion').value.trim(),
        notes: $('#s-notes').value.trim()
      };
      const save = $('#s-save');
      save.disabled = true;
      try {
        if (sheetMode === 'new') {
          await api('reservations', { method: 'POST', body: Object.assign({}, payload, { date: officeDate, status: 'confirmed' }) });
          toast('Booking added and approved.');
        } else {
          await api('reservations/' + encodeURIComponent(sheetId), { method: 'PATCH', body: payload });
          toast('Booking updated.');
        }
        closeSheet();
        await loadOffice(true);
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
      } finally {
        save.disabled = false;
      }
    });
  }

  const gateForm = $('#gate-form');
  if (gateForm) {
    gateForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = $('#passcode');
      const button = gateForm.querySelector('button');
      const code = input.value.trim();
      if (!code) return;
      button.disabled = true;
      try {
        await api('manager/login', { method: 'POST', body: { code } });
        setManagerCode(code);
        input.value = '';
        $('#gate-error').hidden = true;
        $('#gate').hidden = true;
        $('#dash').hidden = false;
        const live = $('#m-live');
        if (live) live.hidden = false;
        startOffice();
        toast('Unlocked \u2014 showing live bookings.');
        resetInactivity();
      } catch (err) {
        const errorEl = $('#gate-error');
        errorEl.textContent = err.status === 401 ? 'That\u2019s not it. The demo passcode is 1234.' : err.message;
        errorEl.hidden = false;
        input.select();
      } finally {
        button.disabled = false;
      }
    });
  }

  const mDate = $('#m-date');
  if (mDate) {
    mDate.value = todayISO();
    mDate.addEventListener('change', () => {
      officeDate = mDate.value || todayISO();
      loadOffice();
    });
  }

  const mStatus = $('#m-status');
  if (mStatus) {
    mStatus.addEventListener('change', () => {
      officeFilter = mStatus.value;
      paintServiceList();
    });
  }

  const dash = $('#dash');
  if (dash) {
    dash.addEventListener('click', async (e) => {
      if (e.target.closest('#m-new')) {
        openSheet('new', null);
        return;
      }

      const seatToggle = e.target.closest('[data-seat-time]');
      if (seatToggle) {
        seatToggle.disabled = true;
        await toggleSeating(seatToggle.getAttribute('data-seat-time'), seatToggle.getAttribute('data-seat-closed') === '1');
        return;
      }

      const editBtn = e.target.closest('[data-edit-id]');
      if (editBtn) {
        const booking = officeRows.find((r) => r.id === editBtn.getAttribute('data-edit-id'));
        if (booking) openSheet('edit', booking);
        return;
      }

      const btn = e.target.closest('[data-set], [data-delete]');
      if (!btn) return;
      const id = btn.getAttribute('data-id');
      btn.disabled = true;
      try {
        if (btn.hasAttribute('data-delete')) await deleteBooking(id);
        else await setStatus(id, btn.getAttribute('data-set'));
      } catch (err) {
        btn.disabled = false;
      }
    });
  }

  const mRefresh = $('#m-refresh');
  if (mRefresh) {
    mRefresh.addEventListener('click', () => {
      loadOffice();
      toast('Board refreshed.');
      resetInactivity();
    });
  }

  const mSignout = $('#m-signout');
  if (mSignout) {
    mSignout.addEventListener('click', () => {
      lockOffice('');
      toast('Back office locked.');
    });
  }

  const mSamples = $('#m-samples');
  if (mSamples) {
    mSamples.addEventListener('click', async () => {
      mSamples.disabled = true;
      try {
        const res = await api('samples', { method: 'POST' });
        toast(res.added ? res.added + ' sample requests added.' : (res.message || 'Samples already on the board.'));
        await loadOffice(true);
      } catch (err) {
        toast(err.message);
      } finally {
        mSamples.disabled = false;
      }
    });
  }

  const mClearDemo = $('#m-clear-demo');
  if (mClearDemo) {
    mClearDemo.addEventListener('click', async () => {
      try {
        await api('demo', { method: 'DELETE' });
        toast('Sample bookings removed.');
        await loadOffice(true);
      } catch (err) {
        toast(err.message);
      }
    });
  }

  const mExport = $('#m-export');
  if (mExport) {
    mExport.addEventListener('click', () => {
      const rows = officeRows.slice().sort((a, b) => a.time.localeCompare(b.time));
      if (!rows.length) {
        toast('Nothing to export for this date.');
        return;
      }
      const header = ['Reference', 'Date', 'Time', 'Name', 'Guests', 'Phone', 'Email', 'Occasion', 'Notes', 'Status'];
      const body = rows.map((r) => [r.ref, r.date, r.time, r.name, r.party, r.phone, r.email, r.occasion, r.notes, r.status]);
      const csv = [header].concat(body)
        .map((line) => line.map((cell) => '"' + String(cell == null ? '' : cell).replace(/"/g, '""') + '"').join(','))
        .join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'bun-and-blaze-' + officeDate + '.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast('Exported ' + plural(rows.length, 'booking') + '.');
    });
  }

  /* start */
  const initial = location.hash.replace('#', '');
  if (initial === 'office' || initial === 'manager') {
    showView('office');
  } else if (initial) {
    goTo(initial);
  }
  renderMine();
})();
