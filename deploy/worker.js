const { Miniflare } = require('miniflare');

const DB_NAME = 'bun-and-blaze';
const DB_ID = '00000000-0000-0000-0000-000000000001';
const MANAGER_PASSCODE = process.env.MANAGER_CODE || '1234';
const MANAGER_COOKIE = 'bb.manager.v2';
const SLOT_CAPACITY = 20;

const INIT = /* sql */
`CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  party INTEGER NOT NULL,
  occasion TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS seats (
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  closed INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, time)
);
`;

function cleanFlat(obj) {
  const out = {};
  for (const k of Object.keys(obj || {})) {
    if (k === 'notes') out[k] = String(obj[k] || '').slice(0, 200);
    else if (k === 'occasion') out[k] = String(obj[k] || '').slice(0, 60);
    else out[k] = obj[k];
  }
  return out;
}

function cleanBooking(obj) {
  const b = cleanFlat(obj);
  b.ref = String(b.ref || '').trim();
  b.name = String(b.name || '').trim();
  b.phone = String(b.phone || '').trim();
  b.email = String(b.email || '').replace(/[\s<>]/g, '').slice(0, 120);
  b.party = Math.trunc(Number(b.party) || 1);
  b.party = Math.min(Math.max(b.party, 1), SLOT_CAPACITY);
  b.date = String(b.date || '').trim();
  b.time = String(b.time || '').trim();
  b.occasion = String(b.occasion || '').trim();
  b.notes = String(b.notes || '').trim();
  if (b.party < 1) b.party = 1;
  if (b.status) b.status = String(b.status).trim();
  return b;
}

function makeRef() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i += 1) s += chars[Math.floor(Math.random() * chars.length)];
  return 'BG-' + s;
}

function nowISO() {
  return new Date().toISOString().replace(/T/, ' ').slice(0, 19);
}

async function query(db, sql, params = []) {
  const res = await db.prepare(sql).bind(...params).all();
  return res.results || res.results;
}

async function run(db, sql, params = []) {
  return db.prepare(sql).bind(...params).run();
}

async function getDb() {
  if (global._db) return global._db;
  const mf = new Miniflare({
    bindings: { DB: { databaseId: DB_ID, databaseName: DB_NAME } },
    modules: false,
  });
  const db = await mf.getDatabase('DB');
  await run(db, INIT);
  global._db = db;
  return db;
}

async function generateBookingRefs(db, count) {
  const refs = new Set();
  while (refs.size < count) refs.add(makeRef());
  return [...refs];
}

async function seedSeats(db, date) {
  const times = ['18:00', '19:00', '20:00', '21:00'];
  for (const t of times) {
    const existing = await query(db, 'SELECT id FROM seats WHERE date = ? AND time = ?', [date, t]);
    if (!existing.length) {
      await run(db, 'INSERT INTO seats (date, time, closed, used) VALUES (?, ?, 0, 0)', [date, t]);
    }
  }
}

async function createBooking(db, body) {
  const b = cleanBooking(body);
  if (!b.ref) b.ref = makeRef();
  if (!b.name || !b.phone || !b.date || !b.time) {
    throw { status: 400, error: 'name, phone, date and time are required' };
  }
  if (b.party < 1 || b.party > SLOT_CAPACITY) {
    throw { status: 400, error: 'party must be between 1 and 20' };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date)) {
    throw { status: 400, error: 'date must be YYYY-MM-DD' };
  }
  if (b.time !== '18:00' && b.time !== '19:00' && b.time !== '20:00' && b.time !== '21:00') {
    throw { status: 400, error: 'time must be 18:00, 19:00, 20:00 or 21:00' };
  }
  const [r] = await query(db, 'SELECT id, used FROM seats WHERE date = ? AND time = ?', [b.date, b.time]);
  if (!r) throw { status: 400, error: 'no seating for that time' };
  if (r.used + b.party > SLOT_CAPACITY) throw { status: 409, error: 'not enough seats left' };
  const [res] = await query(db, 'INSERT INTO bookings (ref, name, phone, email, date, time, party, occasion, notes, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [b.ref, b.name, b.phone, b.email, b.date, b.time, b.party, b.occasion, b.notes, b.status || 'pending']);
  await run(db, 'UPDATE seats SET used = used + ? WHERE date = ? AND time = ?', [b.party, b.date, b.time]);
  const row = await query(db, 'SELECT * FROM bookings WHERE id = ?', [res.lastInsertRowid]);
  const booked = await query(db, 'SELECT id, name, phone, email, date, time, party, occasion, notes, status FROM bookings WHERE ref = ?', [b.ref]);
  return booked[0];
}

async function listBookings(db, { date, status } = {}) {
  let sql = 'SELECT id, ref, name, phone, email, date, time, party, occasion, notes, status, created_at FROM bookings';
  const params = [];
  if (date) {
    sql += ' WHERE date = ?';
    params.push(date);
  }
  if (status && status !== 'all') {
    sql += !date ? ' WHERE status = ?' : ' AND status = ?';
    params.push(status);
  }
  sql += ' ORDER BY date DESC, time DESC';
  return query(db, sql, params);
}

async function patchBooking(db, id, body) {
  const b = cleanFlat(body);
  const keys = [];
  const values = [];
  for (const k of ['name', 'phone', 'email', 'date', 'time', 'party', 'occasion', 'notes', 'status']) {
    if (Object.prototype.hasOwnProperty.call(b, k)) {
      keys.push(k + ' = ?');
      values.push(b[k]);
    }
  }
  if (!keys.length) return { row: null, changed: false };
  values.push(id);
  const res = await run(db, `UPDATE bookings SET ${keys.join(', ')} WHERE id = ?`, values);
  if (res.changes === 0) return { row: null, changed: false };
  const row = await query(db, 'SELECT * FROM bookings WHERE id = ?', [id]);
  return { row: row[0], changed: true };
}

async function deleteBooking(db, id) {
  const res = await run(db, 'DELETE FROM bookings WHERE id = ?', [id]);
  const row = await query(db, 'SELECT * FROM bookings WHERE id = ?', [id]);
  return { row: row[0] || null, deleted: res.changes > 0 };
}

async function cancelByRef(db, ref) {
  const [row] = await query(db, 'SELECT id FROM bookings WHERE ref = ?', [ref]);
  if (!row) return { cancelled: false };
  const res = await run(db, 'UPDATE bookings SET status = ? WHERE ref = ?', ['cancelled', ref]);
  const id = row.id;
  await run(db, 'UPDATE seats SET used = used - (SELECT party FROM bookings WHERE id = ?)', [id]);
  return { cancelled: true, id };
}

async function getSeats(db, date) {
  const rows = await query(db, 'SELECT date, time, closed, used FROM seats WHERE date = ? ORDER BY time', [date]);
  return rows.map(r => ({ ...r, closed: Boolean(r.closed), used: Number(r.used) }));
}

async function setSeat(db, date, time, closed) {
  const [existing] = await query(db, 'SELECT id FROM seats WHERE date = ? AND time = ?', [date, time]);
  if (!existing) throw { status: 400, error: 'no such seating' };
  const res = await run(db, 'INSERT INTO seats (date, time, closed) VALUES (?, ?, ?) ON CONFLICT(date, time) DO UPDATE SET closed = excluded.closed', [date, time, closed ? 1 : 0]);
  return { updated: res.changes > 0 };
}

async function seedDemoBookings(db) {
  const now = new Date();
  const D = now.toISOString().slice(0, 10);
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  const N = next.toISOString().slice(0, 10);
  const refs = await generateBookingRefs(db, 6);
  const entries = [
    { ref: refs[0], name: 'Jordan Lee', phone: '5035550123', email: 'jordan@mail.com', date: D, time: '18:00', party: 2, occasion: 'Date night', notes: 'High chair needed', status: 'confirmed', created: now.toISOString() },
    { ref: refs[1], name: 'Alex Rivera', phone: '5035550234', email: '', date: D, time: '19:00', party: 3, occasion: '', notes: '', status: 'pending', created: now.toISOString() },
    { ref: refs[2], name: 'Priya Patel', phone: '5035550345', email: 'priya@work.com', date: D, time: '18:00', party: 2, occasion: '', notes: '', status: 'seated', created: now.toISOString() },
    { ref: refs[3], name: 'Sam Okafor', phone: '5035550456', email: '', date: N, time: '19:00', party: 4, occasion: 'Team dinner', notes: '', status: 'confirmed', created: now.toISOString() },
    { ref: refs[4], name: 'Morgan Lee', phone: '5035550567', email: '', date: N, time: '20:00', party: 1, occasion: '', notes: 'Smoke-sensitive table', status: 'pending', created: now.toISOString() },
    { ref: refs[5], name: 'Jamie Cruz', phone: '5035550678', email: 'jamie@mail.com', date: N, time: '19:00', party: 2, occasion: '', notes: '', status: 'cancelled', created: now.toISOString() },
  ];
  for (const e of entries) {
    const [res] = await query(db, 'INSERT INTO bookings (ref, name, phone, email, date, time, party, occasion, notes, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [e.ref, e.name, e.phone, e.email, e.date, e.time, e.party, e.occasion, e.notes, e.status, e.created]);
    await run(db, 'UPDATE seats SET used = used + ? WHERE date = ? AND time = ?', [e.party, e.date, e.time]);
  }
  return refs.length;
}

async function clearDemo(db) {
  const res = await run(db, 'DELETE FROM bookings WHERE status = ?', ['pending']);
  const [rows] = await query(db, 'SELECT id, party FROM bookings WHERE status = ?', ['confirmed']);
  let freed = 0;
  for (const r of rows) {
    freed += Number(r.party) || 0;
    await run(db, 'DELETE FROM bookings WHERE id = ?', [r.id]);
  }
  await run(db, 'UPDATE seats SET used = 0');
  return { removed: res.changes, freed };
}

function sendJson(res, status, data) {
  res = res || new Response(JSON.stringify(data), { status });
  res.headers.set('content-type', 'application/json; charset=utf-8');
  return res;
}

async function jsonBody(req) {
  const ct = req.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    return { error: 'expected application/json' };
  }
  let raw = await req.text();
  try { return JSON.parse(raw || '{}'); } catch (e) { return { error: 'invalid JSON' }; }
}

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/?/, '');
  const db = await getDb();

  if (path === 'slots') {
    const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJson(null, 400, { error: 'date must be YYYY-MM-DD' });
    await seedSeats(db, date);
    const seats = await getSeats(db, date);
    return sendJson(res, 200, { capacity: SLOT_CAPACITY, slots: seats });
  }

  if (path === 'reservations') {
    if (url.searchParams.has('date') || url.searchParams.has('status')) {
      const date = url.searchParams.get('date');
      const status = url.searchParams.get('status') || 'all';
      if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJson(null, 400, { error: 'date must be YYYY-MM-DD' });
      if (status !== 'all' && status !== 'pending' && status !== 'confirmed' && status !== 'seated' && status !== 'cancelled') {
        return sendJson(null, 400, { error: 'status must be pending, confirmed, seated, cancelled or all' });
      }
      const rows = await listBookings(db, { date, status });
      return sendJson(res, 200, { reservations: rows });
    }
    const body = await jsonBody(request);
    if (body && body.error) return sendJson(res, 400, body);
    const reservation = await createBooking(db, body);
    return sendJson(res, 201, { reservation });
  }

  if (path.startsWith('reservations/')) {
    let id;
    try { id = Number(path.split('/')[1]); } catch (e) { id = null; }
    const parts = path.split('/');
    if (parts.length === 3 && parts[2] === 'cancel') {
      const ref = parts[2];
      const result = await cancelByRef(db, ref);
      if (!result.cancelled) return sendJson(null, 404, { error: 'no booking with that reference' });
      const row = await query(db, 'SELECT id, ref, name, phone, email, date, time, party, occasion, notes, status, created_at FROM bookings WHERE id = ?', [result.id]);
      return sendJson(res, 200, { reservation: row[0] });
    }
    if (!id) return sendJson(null, 404, { error: 'not found' });
    const [row] = await query(db, 'SELECT id, ref, name, phone, email, date, time, party, occasion, notes, status, created_at FROM bookings WHERE id = ?', [id]);
    if (!row) return sendJson(null, 404, { error: 'not found' });
    const body = await jsonBody(request);
    if (request.method === 'PATCH') {
      const result = await patchBooking(db, id, body);
      if (!result.changed) return sendJson(null, 404, { error: 'not found' });
      return sendJson(res, 200, { reservation: result.row });
    }
    if (request.method === 'DELETE') {
      const { row: deleted, deleted: d } = await deleteBooking(db, id);
      if (!d) return sendJson(null, 404, { error: 'not found' });
      return sendJson(res, 200, { deleted: true });
    }
    return sendJson(null, 405, { error: 'method not allowed' });
  }

  if (path === 'mine') {
    const refs = url.searchParams.get('refs');
    if (!refs) return sendJson(res, 400, { error: 'refs query required' });
    const ids = refs.split(',').map(Number).filter(Number.isInteger);
    const rows = ids.length ? await query(db, 'SELECT id, ref, name, phone, email, date, time, party, occasion, notes, status, created_at FROM bookings WHERE id IN (' + ids.map(() => '?').join(',') + ')', ids) : [];
    return sendJson(res, 200, { reservations: rows });
  }

  if (path === 'manager' && url.pathname.includes('/login')) {
    const body = await jsonBody(request);
    if (!body || body.error) return sendJson(res, 400, { error: 'code required' });
    if (!body.code) return sendJson(null, 400, { error: 'code required' });
    if (String(body.code) === String(MANAGER_PASSCODE)) {
      const cookie = env?.BB_MANAGER_COOKIE || MANAGER_COOKIE;
      return new Response(JSON.stringify({ ok: true, cookie }), {
        status: 200,
        headers: { 'set-cookie': `${cookie}=${body.code}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400` },
      });
    }
    return sendJson(null, 401, { error: 'incorrect passcode' });
  }

  if (path === 'seating') {
    const body = await jsonBody(request);
    if (!body || body.error) return sendJson(res, 400, { error: 'date, time and closed required' });
    if (!body.date || !body.time || typeof body.closed !== 'boolean') return sendJson(null, 400, { error: 'date, time and closed required' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date)) return sendJson(null, 400, { error: 'date must be YYYY-MM-DD' });
    const result = await setSeat(db, body.date, body.time, body.closed);
    return sendJson(res, 200, { seating: result });
  }

  if (path === 'samples') {
    if (request.method === 'POST') {
      const count = await seedDemoBookings(db);
      return sendJson(res, 200, { added: count });
    }
    return sendJson(null, 405, { error: 'method not allowed' });
  }

  if (path === 'demo') {
    if (request.method === 'DELETE') {
      const info = await clearDemo(db);
      return sendJson(res, 200, { cleared: info });
    }
    return sendJson(null, 405, { error: 'method not allowed' });
  }

  return sendJson(null, 404, { error: 'not found' });
}

const PORT = Number(process.env.PORT || 8787);

async function main() {
  const mf = new Miniflare({ bindings: { DB: { databaseId: DB_ID, databaseName: DB_NAME } }, modules: false });
  const db = await mf.getDatabase('DB');
  await run(db, INIT);
  await seedDemoBookings(db);
  const server = await mf.createWorker().listen({
    port: PORT,
    host: '127.0.0.1',
  });
  console.log(`Bun & Blaze API listening on http://127.0.0.1:${PORT}`);
}

main().catch(err => { console.error(err); process.exit(1); });
