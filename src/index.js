// 새솔학원 관리 앱 - 서버
// 화면(public 폴더)은 그대로 보여 주고, /api/ 로 시작하는 주소만 여기서 처리합니다.

import { ensureSchema, DEFAULT_SETTINGS, TEACHER_VIEW_LABELS } from './schema.js';
import { hashPassword, verifyPassword, createSession, sessionCookie, currentUser, newToken } from './auth.js';
import { sendMessages, fillTemplate, solapiReady } from './sms.js';

// ───────── 공통 도구 ─────────

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

const q = {
  all: async (db, sql, ...p) => (await db.prepare(sql).bind(...p).all()).results || [],
  first: (db, sql, ...p) => db.prepare(sql).bind(...p).first(),
  run: (db, sql, ...p) => db.prepare(sql).bind(...p).run(),
};

const clean = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};
const phone = (v) => {
  const d = String(v ?? '').replace(/[^0-9]/g, '');
  return d || null;
};
const money = (v) => {
  const n = Number(String(v ?? '').replace(/[^0-9]/g, ''));
  if (!Number.isFinite(n) || n > 100000000) fail(400, '금액이 올바르지 않아요');
  return n;
};
const need = (v, label) => {
  const s = clean(v);
  if (!s) fail(400, `${label}을(를) 입력해 주세요`);
  return s;
};
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

// 한국 시간 기준 날짜
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
function today() {
  return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
}
function weekdayOf(date) {
  return WEEK[new Date(date + 'T00:00:00Z').getUTCDay()];
}
function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function diffDays(a, b) {
  return Math.round((new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 864e5);
}
function prettyDate(date) {
  const [, m, d] = date.split('-');
  return `${Number(m)}월 ${Number(d)}일(${weekdayOf(date)})`;
}

const SUBJECTS = ['국어', '영어', '수학', '과학', '사회', '기타'];
const ATT_STATUS = ['출석', '지각', '결석', '조퇴'];

// 감독: 학원 전체 학생을 보고, 학생 등록·수정과 반 배정을 할 수 있는 강사 (원장 전용 메뉴·돈 관련은 제외)
const isManager = (user) => user.role === 'teacher' && user.staff_role === 'manager';
const seesAll = (user) => user.role === 'owner' || isManager(user);

// 강사는 "내 반에 있는 학생" 만 볼 수 있습니다.
const MY_STUDENTS = `SELECT e.student_id FROM enrollments e JOIN courses c ON c.id = e.course_id WHERE c.teacher_id = ?`;
function studentScope(user, col = 's.id') {
  if (seesAll(user)) return { sql: '1=1', params: [] };
  return { sql: `${col} IN (${MY_STUDENTS})`, params: [user.id] };
}
async function canSeeStudent(db, user, studentId) {
  if (seesAll(user)) return true;
  const r = await q.first(db, `SELECT 1 AS ok FROM enrollments e JOIN courses c ON c.id = e.course_id WHERE c.teacher_id = ? AND e.student_id = ?`, user.id, studentId);
  return !!r;
}
async function mustSeeStudent(db, user, studentId) {
  const s = await q.first(db, 'SELECT * FROM students WHERE id = ?', studentId);
  if (!s) fail(404, '학생을 찾을 수 없어요');
  if (!(await canSeeStudent(db, user, studentId))) fail(403, '담당 학생이 아니에요');
  return s;
}
async function mustSeeCourse(db, user, courseId) {
  const c = await q.first(db, 'SELECT c.*, u.name AS teacher_name FROM courses c LEFT JOIN users u ON u.id = c.teacher_id WHERE c.id = ?', courseId);
  if (!c) fail(404, '반을 찾을 수 없어요');
  if (!seesAll(user) && c.teacher_id !== user.id) fail(403, '담당 반이 아니에요');
  return c;
}

async function getSettings(db) {
  const s = { ...DEFAULT_SETTINGS };
  for (const r of await q.all(db, 'SELECT key, value FROM settings')) s[r.key] = r.value;
  return s;
}
function parseMottos(s) {
  try {
    const arr = JSON.parse(s.mottos);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

const publicUser = (u) => ({ id: u.id, login_id: u.login_id, name: u.name, role: u.role, staff_role: u.staff_role ?? null, student_id: u.student_id ?? null, phone: u.phone ?? null, photo_v: u.photo_v ?? null });

// ───────── 주소(라우트) 등록 ─────────

const routes = [];
function route(method, path, handler, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, handler, roles: opts.roles || ['owner', 'teacher'], om: !!opts.om, public: !!opts.public });
}
const OWNER = { roles: ['owner'] };
const OM = { roles: ['owner', 'teacher'], om: true }; // 원장 또는 감독
const EVERYONE = { roles: ['owner', 'teacher', 'student'] };

// ───────── 처음 설정 / 로그인 ─────────

route(
  'GET',
  '/api/setup-status',
  async ({ db }) => {
    const r = await q.first(db, 'SELECT COUNT(*) AS n FROM users');
    const s = await getSettings(db);
    return { needsSetup: r.n === 0, academy_name: s.academy_name };
  },
  { public: true }
);

function checkLoginId(id) {
  if (!/^[a-zA-Z0-9_.-]{3,30}$/.test(id || '')) fail(400, '아이디는 영어·숫자 3~30자로 만들어 주세요');
}
function checkPassword(pw) {
  if (!pw || String(pw).length < 8) fail(400, '비밀번호는 8자 이상으로 만들어 주세요');
}

route(
  'POST',
  '/api/setup',
  async ({ db, body }) => {
    const r = await q.first(db, 'SELECT COUNT(*) AS n FROM users');
    if (r.n > 0) fail(400, '이미 원장 계정이 만들어져 있어요');
    checkLoginId(body.login_id);
    checkPassword(body.password);
    const name = need(body.name, '이름');
    const res = await q.run(db, `INSERT INTO users (login_id, password_hash, name, role) VALUES (?, ?, ?, 'owner')`, body.login_id, await hashPassword(body.password), name);
    const academy = clean(body.academy_name);
    if (academy) await q.run(db, `INSERT OR REPLACE INTO settings (key, value) VALUES ('academy_name', ?)`, academy);
    const userId = res.meta.last_row_id;
    const token = await createSession(db, userId);
    const user = await q.first(db, 'SELECT * FROM users WHERE id = ?', userId);
    return json({ ok: true, token, user: publicUser(user) }, 200, { 'set-cookie': sessionCookie(token) });
  },
  { public: true }
);

route(
  'POST',
  '/api/login',
  async ({ db, body }) => {
    const u = await q.first(db, 'SELECT * FROM users WHERE login_id = ? AND active = 1', String(body.login_id || '').trim());
    if (!u || !(await verifyPassword(String(body.password || ''), u.password_hash))) fail(401, '아이디 또는 비밀번호가 맞지 않아요');
    await q.run(db, 'DELETE FROM sessions WHERE expires_at < ?', new Date().toISOString());
    const token = await createSession(db, u.id);
    return json({ ok: true, token, user: publicUser(u) }, 200, { 'set-cookie': sessionCookie(token) });
  },
  { public: true }
);

route(
  'POST',
  '/api/logout',
  async ({ db, user }) => {
    await q.run(db, 'DELETE FROM sessions WHERE token = ?', user.token);
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
  },
  EVERYONE
);

route('GET', '/api/me', async ({ user }) => ({ user: publicUser(user) }), EVERYONE);

route(
  'POST',
  '/api/me/password',
  async ({ db, user, body }) => {
    const u = await q.first(db, 'SELECT * FROM users WHERE id = ?', user.id);
    if (!(await verifyPassword(String(body.current || ''), u.password_hash))) fail(400, '지금 비밀번호가 맞지 않아요');
    checkPassword(body.next);
    await q.run(db, 'UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(body.next), user.id);
    await q.run(db, 'DELETE FROM sessions WHERE user_id = ? AND token != ?', user.id, user.token);
    return { ok: true };
  },
  EVERYONE
);

// ───────── 선생님 계정 (원장 전용) ─────────

route(
  'GET',
  '/api/users',
  async ({ db }) => ({
    users: await q.all(
      db,
      `SELECT u.id, u.login_id, u.name, u.role, u.staff_role, u.phone, u.photo_v, u.active, u.created_at,
        (SELECT COUNT(*) FROM courses c WHERE c.teacher_id = u.id AND c.active = 1) AS course_count
       FROM users u WHERE u.role IN ('owner','teacher')
       ORDER BY u.active DESC, u.role = 'owner' DESC, u.name`
    ),
  }),
  OWNER
);

route(
  'POST',
  '/api/users',
  async ({ db, body }) => {
    checkLoginId(body.login_id);
    checkPassword(body.password);
    const role = body.role === 'owner' ? 'owner' : 'teacher';
    const staffRole = body.role === 'manager' ? 'manager' : null;
    const exists = await q.first(db, 'SELECT id FROM users WHERE login_id = ?', body.login_id);
    if (exists) fail(400, '이미 쓰고 있는 아이디예요');
    const r = await q.run(db, 'INSERT INTO users (login_id, password_hash, name, role, staff_role, phone) VALUES (?, ?, ?, ?, ?, ?)', body.login_id, await hashPassword(body.password), need(body.name, '이름'), role, staffRole, phone(body.phone));
    return { ok: true, id: r.meta.last_row_id };
  },
  OWNER
);

route(
  'PATCH',
  '/api/users/:id',
  async ({ db, body, params, user }) => {
    const id = Number(params.id);
    const u = await q.first(db, `SELECT * FROM users WHERE id = ? AND role IN ('owner','teacher')`, id);
    if (!u) fail(404, '계정을 찾을 수 없어요');
    if ('name' in body) await q.run(db, 'UPDATE users SET name = ? WHERE id = ?', need(body.name, '이름'), id);
    if ('phone' in body) await q.run(db, 'UPDATE users SET phone = ? WHERE id = ?', phone(body.phone), id);
    if ('role' in body && u.role === 'teacher') {
      await q.run(db, 'UPDATE users SET staff_role = ? WHERE id = ?', body.role === 'manager' ? 'manager' : null, id);
    }
    if ('active' in body) {
      if (id === user.id && !body.active) fail(400, '내 계정은 사용 중지할 수 없어요');
      await q.run(db, 'UPDATE users SET active = ? WHERE id = ?', body.active ? 1 : 0, id);
      if (!body.active) await q.run(db, 'DELETE FROM sessions WHERE user_id = ?', id);
    }
    if (body.password) {
      checkPassword(body.password);
      await q.run(db, 'UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(body.password), id);
      await q.run(db, 'DELETE FROM sessions WHERE user_id = ?', id);
    }
    return { ok: true };
  },
  OWNER
);

// 반 배정용 강사 목록 (원장만)
route('GET', '/api/teachers', async ({ db }) => ({ teachers: await q.all(db, `SELECT id, name, role, staff_role, photo_v FROM users WHERE role IN ('owner','teacher') AND active = 1 ORDER BY name`) }), OWNER);

// ───────── 선생님 사진 ─────────
// 사진은 화면에서 작게(정사각형) 줄인 뒤 데이터베이스에 저장합니다.

const PHOTO_MAX = 400 * 1024;

route('PUT', '/api/users/:id/photo', async ({ db, user, body, params }) => {
  const id = Number(params.id);
  if (user.role !== 'owner' && id !== user.id) fail(403, '내 사진만 바꿀 수 있어요');
  const target = await q.first(db, `SELECT id FROM users WHERE id = ? AND role IN ('owner','teacher')`, id);
  if (!target) fail(404, '계정을 찾을 수 없어요');
  const data = String(body.data || '');
  if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(data)) fail(400, '사진 파일(jpg, png)만 올릴 수 있어요');
  if (data.length > PHOTO_MAX) fail(400, '사진이 너무 커요. 다른 사진으로 해 주세요');
  const v = Date.now();
  await q.run(db, 'UPDATE users SET photo = ?, photo_v = ? WHERE id = ?', data, v, id);
  return { ok: true, photo_v: v };
});

route('DELETE', '/api/users/:id/photo', async ({ db, user, params }) => {
  const id = Number(params.id);
  if (user.role !== 'owner' && id !== user.id) fail(403, '내 사진만 지울 수 있어요');
  await q.run(db, 'UPDATE users SET photo = NULL, photo_v = NULL WHERE id = ?', id);
  return { ok: true };
});

// 사진 보여 주기 (로그인한 사람만)
route('GET', '/api/photos/:id', async ({ db, params }) => {
  const r = await q.first(db, 'SELECT photo FROM users WHERE id = ?', Number(params.id));
  if (!r || !r.photo) fail(404, '사진이 없어요');
  return photoResponse(r.photo);
}, EVERYONE);

function photoResponse(dataUrl) {
  const m = dataUrl.match(/^data:(image\/[a-z]+);base64,(.+)$/);
  const bin = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
  return new Response(bin, { headers: { 'content-type': m[1], 'cache-control': 'private, max-age=604800' } });
}

// ───────── 학생 ─────────

// 강사에게 보여 줄 항목 (원장은 항상 전부)
async function viewOf(db, user) {
  if (user.role === 'owner') return Object.fromEntries(Object.keys(TEACHER_VIEW_LABELS).map((k) => [k, true]));
  const s = await getSettings(db);
  let v = {};
  try { v = JSON.parse(s.teacher_view); } catch {}
  const def = JSON.parse(DEFAULT_SETTINGS.teacher_view);
  const out = Object.fromEntries(Object.keys(TEACHER_VIEW_LABELS).map((k) => [k, k in v ? !!v[k] : def[k]]));
  if (isManager(user)) {
    // 학생 등록·수정을 맡으므로 인적사항은 열고, 수강료·수납은 닫습니다
    Object.assign(out, { birth: true, parents: true, siblings: true, memo: true, books: true, fees: false, tuition: false, bookpay: false });
  }
  return out;
}

const maskPhone = (p) => (p ? String(p).replace(/^(\d{3})\d+(\d{4})$/, '$1-****-$2') : p);

// 보여 주면 안 되는 칸을 지웁니다. 사진 원본은 절대 목록에 넣지 않습니다.
function shapeStudent(s, view) {
  const o = { ...s };
  delete o.photo;
  o.has_phone = recipients(s).length > 0;
  if (!view.birth) delete o.birth_date;
  if (!view.address) delete o.address;
  if (!view.parents) for (const k of ['father_name', 'father_phone', 'mother_name', 'mother_phone', 'sms_target', 'student_phone']) delete o[k];
  if (!view.siblings) delete o.sibling_note, delete o.family_id;
  if (!view.memo) delete o.memo, delete o.status_reason;
  return o;
}

// 할인: 항목은 설정(discount_items), 학생별 체크는 student_discounts
function discountItems(settings) {
  try {
    const a = JSON.parse(settings.discount_items);
    return Array.isArray(a) ? a.filter((x) => x && x.id && x.name) : [];
  } catch {
    return [];
  }
}
async function discountTotals(db) {
  const items = new Map(discountItems(await getSettings(db)).map((i) => [i.id, i]));
  const m = new Map();
  for (const r of await q.all(db, 'SELECT student_id, item_id FROM student_discounts')) {
    const it = items.get(r.item_id);
    if (it) m.set(r.student_id, (m.get(r.student_id) || 0) + (Number(it.amount) || 0));
  }
  return m;
}

// 이번 달 교육비 상태 (나눠 내는 경우 합계로 판단)
function tuitionStatus(fee, paid) {
  fee = fee || 0;
  paid = paid || 0;
  if (!fee) return { state: paid ? '납부' : '-', fee, paid, due: 0 };
  if (paid >= fee) return { state: '완납', fee, paid, due: 0 };
  if (paid > 0) return { state: '부분', fee, paid, due: fee - paid };
  return { state: '미납', fee, paid, due: fee };
}

// 문자 받을 번호 (어머니 / 아버지 / 둘 다)
function recipients(s) {
  const t = s.sms_target || '어머니';
  const list = [];
  if ((t === '어머니' || t === '둘 다') && s.mother_phone) list.push(s.mother_phone);
  if ((t === '아버지' || t === '둘 다') && s.father_phone) list.push(s.father_phone);
  if (!list.length) {
    const any = s.mother_phone || s.father_phone;
    if (any) list.push(any);
  }
  return list;
}
// 한 학생에게 보낼 문자들 (번호가 없으면 "실패" 기록용 1건)
function messagesFor(s, base) {
  const to = recipients(s);
  return (to.length ? to : [null]).map((n) => ({ ...base, student_id: s.id, to: n }));
}

const PHONES = 's.father_phone, s.mother_phone, s.sms_target';

route('GET', '/api/students', async ({ db, user, query }) => {
  const sc = studentScope(user);
  const where = [sc.sql];
  const params = [...sc.params];
  if (query.status) where.push('s.status = ?'), params.push(query.status);
  if (query.q) where.push('(s.name LIKE ? OR s.school LIKE ?)'), params.push(`%${query.q}%`, `%${query.q}%`);
  const rows = await q.all(
    db,
    `SELECT s.*,
      (SELECT group_concat(c.subject || ' ' || c.name, ', ') FROM enrollments e JOIN courses c ON c.id = e.course_id WHERE e.student_id = s.id AND c.active = 1) AS courses,
      (SELECT COUNT(*) FROM students x WHERE s.family_id IS NOT NULL AND x.family_id = s.family_id AND x.id != s.id) AS sibling_count,
      (SELECT IFNULL(SUM(IFNULL(e.fee, c.fee)), 0) FROM enrollments e JOIN courses c ON c.id = e.course_id WHERE e.student_id = s.id AND c.active = 1) AS fee_month,
      (SELECT IFNULL(SUM(p.amount), 0) FROM payments p WHERE p.student_id = s.id AND p.kind = '교육비' AND p.month = ?) AS tuition_paid,
      (SELECT IFNULL(SUM(IFNULL(b.price, 0) * b.qty), 0) FROM book_deliveries b WHERE b.student_id = s.id) AS book_total,
      (SELECT IFNULL(SUM(p.amount), 0) FROM payments p WHERE p.student_id = s.id AND p.kind = '교재비') AS book_paid
     FROM students s WHERE ${where.join(' AND ')}
     ORDER BY CASE s.status WHEN '재원' THEN 0 WHEN '휴원' THEN 1 ELSE 2 END, s.name`,
    today().slice(0, 7),
    ...params
  );
  const view = await viewOf(db, user);
  const disc = view.fees ? await discountTotals(db) : new Map();
  return { month: today().slice(0, 7), students: rows.map((s) => {
    const o = shapeStudent(s, view);
    if (!view.siblings) delete o.sibling_count;
    if (view.tuition && view.fees) o.tuition = tuitionStatus(Math.max(0, s.fee_month - (disc.get(s.id) || 0)), s.tuition_paid);
    if (view.bookpay) o.book_due = Math.max(0, s.book_total - s.book_paid), o.book_total = s.book_total, o.book_paid = s.book_paid;
    for (const k of ['fee_month', 'tuition_paid']) delete o[k];
    if (!view.bookpay) delete o.book_total, delete o.book_paid;
    return o;
  }), view };
});

route('GET', '/api/students/:id', async ({ db, user, params }) => {
  const id = Number(params.id);
  const raw = await mustSeeStudent(db, user, id);
  const view = await viewOf(db, user);
  const student = shapeStudent(raw, view);
  const month = today().slice(0, 7);
  const jobs = {
    courses: q.all(db, `SELECT c.id, c.name, c.subject, c.days, c.times, c.start_time, c.end_time, c.teacher_id, c.fee AS course_fee, e.fee AS own_fee, c.active, u.name AS teacher_name, u.photo_v AS teacher_photo_v
                        FROM enrollments e JOIN courses c ON c.id = e.course_id LEFT JOIN users u ON u.id = c.teacher_id WHERE e.student_id = ? ORDER BY c.active DESC, c.subject`, id),
    attendance: q.all(db, `SELECT a.date, a.status, a.memo, c.name AS course_name, c.subject FROM attendance a JOIN courses c ON c.id = a.course_id WHERE a.student_id = ? AND a.date >= ? ORDER BY a.date DESC`, id, addDays(today(), -180)),
    logs: q.all(db, `SELECT l.id, l.date, l.content, l.homework, l.books, l.extras, l.course_id, c.name AS course_name, c.subject, u.name AS teacher_name, u.photo_v AS teacher_photo_v, l.teacher_id, n.note, n.hw, n.achieve, a.status AS att_status
                     FROM class_logs l JOIN enrollments e ON e.course_id = l.course_id AND e.student_id = ?
                     JOIN courses c ON c.id = l.course_id LEFT JOIN users u ON u.id = l.teacher_id
                     LEFT JOIN class_log_notes n ON n.log_id = l.id AND n.student_id = ?
                     LEFT JOIN attendance a ON a.course_id = l.course_id AND a.student_id = ? AND a.date = l.date
                     ORDER BY l.date DESC, l.id DESC LIMIT 200`, id, id, id),
    feedbacks: q.all(db, `SELECT f.id, f.content, f.status, f.sent_at, f.updated_at, p.title AS period_title, c.name AS course_name, c.subject FROM feedbacks f JOIN feedback_periods p ON p.id = f.period_id JOIN courses c ON c.id = f.course_id WHERE f.student_id = ? AND f.content != '' ORDER BY p.start_date DESC`, id),
    consultations: q.all(db, `SELECT k.*, u.name AS teacher_name, u.photo_v AS teacher_photo_v FROM consultations k LEFT JOIN users u ON u.id = k.teacher_id WHERE k.student_id = ? ORDER BY k.date DESC, k.id DESC`, id),
    flags: q.all(db, `SELECT r.*, u.name AS created_by_name FROM risk_flags r LEFT JOIN users u ON u.id = r.created_by WHERE r.student_id = ? ORDER BY r.resolved, r.created_at DESC`, id),
    messages: q.all(db, `SELECT m.id, m.kind, m.body, m.status, m.error, m.to_phone, m.created_at, u.name AS sent_by_name FROM messages m LEFT JOIN users u ON u.id = m.sent_by WHERE m.student_id = ? ORDER BY m.id DESC LIMIT 20`, id),
  };
  if (view.siblings && raw.family_id) jobs.siblings = q.all(db, `SELECT id, name, school, grade, status, photo_v FROM students WHERE family_id = ? AND id != ? ORDER BY birth_date, name`, raw.family_id, id);
  if (view.books || view.bookpay) jobs.books = q.all(db, `SELECT b.*, u.name AS given_by_name, bk.image_v AS book_image_v FROM book_deliveries b LEFT JOIN users u ON u.id = b.given_by LEFT JOIN books bk ON bk.id = b.book_id WHERE b.student_id = ? ORDER BY b.date DESC, b.id DESC`, id);
  jobs.subjects = q.all(db, 'SELECT subject, start_date, end_date FROM student_subjects WHERE student_id = ?', id);
  jobs.words = q.all(db, `SELECT w.id, w.date, w.book, w.range, w.round, w.kind, w.total, w.score, w.pass_score, w.passed, w.attempt, w.photo_v, w.memo, w.teacher_id, u.name AS teacher_name, c.name AS course_name FROM word_tests w LEFT JOIN users u ON u.id = w.teacher_id LEFT JOIN courses c ON c.id = w.course_id WHERE w.student_id = ? ORDER BY w.date DESC, w.id DESC LIMIT 200`, id);
  if (view.fees) jobs.my_discounts = q.all(db, 'SELECT item_id FROM student_discounts WHERE student_id = ?', id);
  if (user.role === 'owner') jobs.bills = q.all(db, `SELECT bl.*, u.name AS sent_by_name FROM bills bl LEFT JOIN users u ON u.id = bl.sent_by WHERE bl.student_id = ? ORDER BY bl.id DESC LIMIT 24`, id);
  if (view.tuition) jobs.tuition = q.all(db, `SELECT p.*, u.name AS created_by_name FROM payments p LEFT JOIN users u ON u.id = p.created_by WHERE p.student_id = ? AND p.kind = '교육비' ORDER BY p.paid_date DESC, p.id DESC`, id);
  if (view.bookpay) jobs.bookpay = q.all(db, `SELECT p.*, u.name AS created_by_name FROM payments p LEFT JOIN users u ON u.id = p.created_by WHERE p.student_id = ? AND p.kind = '교재비' ORDER BY p.paid_date DESC, p.id DESC`, id);

  const keys = Object.keys(jobs);
  const vals = await Promise.all(keys.map((k) => jobs[k]));
  const out = Object.fromEntries(keys.map((k, i) => [k, vals[i]]));

  // 수강료: 학생별 금액이 있으면 그것, 없으면 반 기본 금액
  out.courses = out.courses.map((c) => {
    const fee = c.own_fee ?? c.course_fee ?? null;
    const o = { ...c, fee, fee_custom: c.own_fee != null };
    delete o.own_fee;
    if (!view.fees) delete o.fee, delete o.course_fee, delete o.fee_custom;
    return o;
  });
  // 과목별 등록·퇴원: 기록이 없는 수강 과목도 보여 줍니다
  const subjMap = new Map(out.subjects.map((x) => [x.subject, x]));
  for (const c of out.courses) if (c.active && !subjMap.has(c.subject)) subjMap.set(c.subject, { subject: c.subject, start_date: null, end_date: null });
  out.subjects = [...subjMap.values()].sort((a, b) => SUBJECTS.indexOf(a.subject) - SUBJECTS.indexOf(b.subject));
  if (view.fees) {
    out.gross_fee = out.courses.filter((c) => c.active).reduce((a, c) => a + (c.fee || 0), 0);
    const checked = new Set(out.my_discounts.map((x) => x.item_id));
    out.discount_items = discountItems(await getSettings(db)).map((i) => ({ ...i, on: checked.has(i.id) }));
    out.discount_total = out.discount_items.filter((i) => i.on).reduce((a, i) => a + (Number(i.amount) || 0), 0);
    out.monthly_fee = Math.max(0, out.gross_fee - out.discount_total);
    delete out.my_discounts;
  }
  if (view.tuition) {
    out.tuition_paid_this_month = out.tuition.some((p) => p.month === month);
    if (view.fees) out.tuition_status = tuitionStatus(out.monthly_fee, out.tuition.filter((p) => p.month === month).reduce((a, p) => a + p.amount, 0));
    // 달마다 합계 (나눠 낸 경우를 한 줄로)
    const byMonth = {};
    for (const p of out.tuition) if (p.month) (byMonth[p.month] = byMonth[p.month] || { month: p.month, paid: 0, count: 0 }), (byMonth[p.month].paid += p.amount), byMonth[p.month].count++;
    out.tuition_months = Object.values(byMonth).sort((a, b) => b.month.localeCompare(a.month));
  }
  if (view.bookpay) {
    const total = (out.books || []).reduce((a, b) => a + (b.price || 0) * b.qty, 0);
    const paid = out.bookpay.reduce((a, p) => a + p.amount, 0);
    out.book_status = { total, paid, due: Math.max(0, total - paid), over: Math.max(0, paid - total) };
  }
  if (!view.parents) out.messages = out.messages.map((m) => ({ ...m, to_phone: maskPhone(m.to_phone) }));

  return { student, view, month, ...out };
});

const STUDENT_FIELDS = ['name', 'birth_date', 'school', 'grade', 'address', 'student_phone', 'father_name', 'father_phone', 'mother_name', 'mother_phone', 'sms_target', 'sibling_note', 'status', 'enrolled_date', 'status_date', 'status_reason', 'memo'];
function studentValues(body, base = {}) {
  const v = { ...base };
  for (const f of STUDENT_FIELDS) if (f in body) v[f] = f.endsWith('phone') ? phone(body[f]) : clean(body[f]);
  if (!v.name) fail(400, '학생 이름을 입력해 주세요');
  v.status = v.status || '재원';
  if (!['재원', '휴원', '퇴원'].includes(v.status)) fail(400, '상태는 재원/휴원/퇴원 중 하나예요');
  v.sms_target = ['어머니', '아버지', '둘 다'].includes(v.sms_target) ? v.sms_target : '어머니';
  for (const d of ['birth_date', 'enrolled_date', 'status_date']) if (v[d] && !isDate(v[d])) fail(400, '날짜 형식이 맞지 않아요');
  // 상태가 바뀌었는데 날짜가 없으면 오늘로
  if (base.status && base.status !== v.status && !('status_date' in body && body.status_date)) v.status_date = today();
  return v;
}

route(
  'POST',
  '/api/students',
  async ({ db, body }) => {
    const v = studentValues(body);
    if (!v.enrolled_date) v.enrolled_date = today();
    const r = await q.run(db, `INSERT INTO students (${STUDENT_FIELDS.join(',')}) VALUES (${STUDENT_FIELDS.map(() => '?').join(',')})`, ...STUDENT_FIELDS.map((f) => v[f] ?? null));
    return { ok: true, id: r.meta.last_row_id };
  },
  OM
);

// 여러 명 한꺼번에 등록
// 엑셀에서 제목 줄까지 복사해 붙여 넣으면 제목을 보고 칸을 맞춥니다 (순서 상관없음).
// 제목 줄이 없으면 "이름, 학교, 학년, 어머니 연락처, 아버지 연락처" 순서로 읽습니다.
const BULK_LABELS = {
  name: '이름', school: '학교', grade: '학년', birth_date: '생년월일', address: '주소', student_phone: '학생 연락처',
  father_name: '아버지 성함', father_phone: '아버지 연락처', mother_name: '어머니 성함', mother_phone: '어머니 연락처',
  sms_target: '문자 받을 분', enrolled_date: '등록일', sibling_note: '형제·자매 메모', memo: '특이사항',
};
function bulkField(header) {
  const n = String(header || '').replace(/[\s()·._\-\/]/g, '');
  if (!n) return null;
  // 국어등록일 / 수학 퇴원일 같은 과목별 날짜
  const subj = SUBJECTS.find((x) => x !== '기타' && n.includes(x));
  if (subj && /(등록|입원|시작)/.test(n)) return `start:${subj}`;
  if (subj && /(퇴원|종료|그만)/.test(n)) return `end:${subj}`;
  const tel = /(연락처|전화|휴대|핸드폰|번호|폰)/;
  if (/(학생|본인)/.test(n) && tel.test(n)) return 'student_phone';
  if (/(학부모|보호자|부모)/.test(n)) return tel.test(n) ? 'mother_phone' : 'mother_name';
  if (/(아버지|부친|아빠|^부)/.test(n)) return tel.test(n) ? 'father_phone' : 'father_name';
  if (/(어머니|모친|엄마|^모)/.test(n)) return tel.test(n) ? 'mother_phone' : 'mother_name';
  if (/문자/.test(n)) return 'sms_target';
  if (/(생년월일|생일|출생)/.test(n)) return 'birth_date';
  if (/(등록일|입학일|입원일|등록날짜)/.test(n)) return 'enrolled_date';
  if (/주소/.test(n)) return 'address';
  if (/학교/.test(n)) return 'school';
  if (/학년/.test(n)) return 'grade';
  if (/(형제|자매|남매)/.test(n)) return 'sibling_note';
  if (/(메모|특이|비고)/.test(n)) return 'memo';
  if (/(이름|성명|학생명|^학생$)/.test(n)) return 'name';
  if (tel.test(n)) return 'mother_phone';
  return null;
}
// 2012.5.14 / 2012-05-14 / 20120514 / 2012년 5월 14일 → 2012-05-14
function toDate(v) {
  const sraw = String(v || '').trim();
  if (!sraw) return { value: null };
  let m = sraw.match(/^(\d{4})\D+(\d{1,2})\D+(\d{1,2})/) || sraw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) {
    // 130319- / 130319 / 130319-4 → 2013-03-19 (앞 6자리만 씁니다)
    const y6 = sraw.match(/^(\d{2})(\d{2})(\d{2})(?:-\d*)?$/);
    if (y6) {
      const yy = Number(y6[1]);
      const cur = Number(today().slice(2, 4));
      m = [null, String(yy <= cur ? 2000 + yy : 1900 + yy), y6[2], y6[3]];
    }
  }
  if (!m) return { value: null, bad: true };
  const d = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  const ok = !isNaN(new Date(d + 'T00:00:00Z')) && Number(m[2]) <= 12 && Number(m[3]) <= 31;
  return ok ? { value: d } : { value: null, bad: true };
}
function parseBulk(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) fail(400, '등록할 학생을 붙여 넣어 주세요');
  const split = (l) => (l.includes('\t') ? l.split('\t') : l.split(',')).map((x) => x.trim());
  const first = split(lines[0]);
  const mapped = first.map(bulkField);
  const hasHeader = mapped.includes('name');
  const columns = hasHeader
    ? first.map((hd, i) => ({ header: hd, field: mapped[i], label: mapped[i] ? BULK_LABELS[mapped[i]] : null }))
    : ['name', 'school', 'grade', 'mother_phone', 'father_phone'].map((f) => ({ header: BULK_LABELS[f], field: f, label: BULK_LABELS[f] }));
  for (const c of columns) if (c.field && c.field.includes(':')) c.label = `${c.field.split(':')[1]} ${c.field.startsWith('start') ? '등록일' : '퇴원일'}`;
  const body = hasHeader ? lines.slice(1) : lines;
  if (body.length > 300) fail(400, '한 번에 300명까지 등록할 수 있어요');
  const warnings = [];
  const rows = [];
  body.forEach((l, idx) => {
    const cells = split(l);
    const r = {};
    columns.forEach((c, i) => {
      if (!c.field || cells[i] == null || cells[i] === '') return;
      if (r[c.field] != null) return; // 같은 칸이 두 번 나오면 앞의 것을 씁니다
      r[c.field] = cells[i];
    });
    const lineNo = idx + (hasHeader ? 2 : 1);
    if (!clean(r.name)) { warnings.push(`${lineNo}번째 줄: 이름이 없어서 건너뛰어요`); return; }
    const out = { name: clean(r.name) };
    for (const f of ['school', 'grade', 'address', 'father_name', 'mother_name', 'sibling_note', 'memo']) out[f] = clean(r[f]);
    // 학년이 숫자만 있으면 학교 이름을 보고 초/중/고를 붙입니다 (예: 영주여중 + 1 → 중1)
    if (out.grade && /^\d$/.test(out.grade) && out.school) {
      const lv = /초(등학교)?$/.test(out.school) ? '초' : /중(학교)?$/.test(out.school) ? '중' : /고(등학교)?$/.test(out.school) ? '고' : '';
      if (lv) out.grade = lv + out.grade;
    }
    for (const f of ['student_phone', 'father_phone', 'mother_phone']) out[f] = phone(r[f]);
    for (const f of ['birth_date', 'enrolled_date']) {
      const d = toDate(r[f]);
      out[f] = d.value;
      if (d.bad) warnings.push(`${lineNo}번째 줄 ${out.name}: ${BULK_LABELS[f]} "${r[f]}"를 읽지 못해 비워 둬요`);
    }
    // 과목별 날짜
    out.subjects = {};
    for (const [k, v] of Object.entries(r)) {
      if (!k.includes(':')) continue;
      const [kind, subj] = k.split(':');
      const d = toDate(v);
      if (d.bad) warnings.push(`${lineNo}번째 줄 ${out.name}: ${subj} ${kind === 'start' ? '등록일' : '퇴원일'} "${v}"를 읽지 못해 비워 둬요`);
      if (!d.value) continue;
      out.subjects[subj] = out.subjects[subj] || {};
      out.subjects[subj][kind] = d.value;
    }
    const t = String(r.sms_target || '');
    out.sms_target = /둘|모두|양/.test(t) ? '둘 다' : /(아버지|부|아빠)/.test(t) ? '아버지' : '어머니';
    if (!r.sms_target && !out.mother_phone && out.father_phone) out.sms_target = '아버지';
    rows.push(out);
  });
  return { hasHeader, columns: columns.map((c) => ({ header: c.header, label: c.label })), rows, warnings };
}
const BULK_FIELDS = ['name', 'school', 'grade', 'birth_date', 'address', 'student_phone', 'father_name', 'father_phone', 'mother_name', 'mother_phone', 'sms_target', 'enrolled_date', 'sibling_note', 'memo'];

route(
  'POST',
  '/api/students/bulk',
  async ({ db, body }) => {
    const parsed = parseBulk(body.text);
    if (body.preview) return { ok: true, preview: true, ...parsed, total: parsed.rows.length, rows: parsed.rows.slice(0, 8) };
    if (!parsed.rows.length) fail(400, '등록할 학생이 없어요. 이름 칸을 확인해 주세요');
    const t = today();
    // 학생을 넣고, 바로 뒤에 그 학생의 과목별 날짜를 넣습니다 (MAX(id) = 방금 넣은 학생)
    const stmts = [];
    for (const r of parsed.rows) {
      stmts.push(db.prepare(`INSERT INTO students (${BULK_FIELDS.join(',')}) VALUES (${BULK_FIELDS.map(() => '?').join(',')})`).bind(...BULK_FIELDS.map((f) => (f === 'enrolled_date' ? r[f] || t : r[f] ?? null))));
      for (const [subj, d] of Object.entries(r.subjects || {}))
        stmts.push(db.prepare('INSERT OR REPLACE INTO student_subjects (student_id, subject, start_date, end_date) VALUES ((SELECT MAX(id) FROM students), ?, ?, ?)').bind(subj, d.start || null, d.end || null));
    }
    await db.batch(stmts);
    return { ok: true, added: parsed.rows.length, warnings: parsed.warnings };
  },
  OM
);

route(
  'PATCH',
  '/api/students/:id',
  async ({ db, body, params }) => {
    const cur = await q.first(db, 'SELECT * FROM students WHERE id = ?', Number(params.id));
    if (!cur) fail(404, '학생을 찾을 수 없어요');
    const v = studentValues(body, cur);
    await q.run(db, `UPDATE students SET ${STUDENT_FIELDS.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`, ...STUDENT_FIELDS.map((f) => v[f] ?? null), cur.id);
    return { ok: true };
  },
  OM
);

// 학생 사진 (원장, 또는 그 학생을 맡은 강사)
route('PUT', '/api/students/:id/photo', async ({ db, user, body, params }) => {
  const id = Number(params.id);
  await mustSeeStudent(db, user, id);
  const data = String(body.data || '');
  if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(data)) fail(400, '사진 파일(jpg, png)만 올릴 수 있어요');
  if (data.length > PHOTO_MAX) fail(400, '사진이 너무 커요. 다른 사진으로 해 주세요');
  const v = Date.now();
  await q.run(db, 'UPDATE students SET photo = ?, photo_v = ? WHERE id = ?', data, v, id);
  return { ok: true, photo_v: v };
});
route('DELETE', '/api/students/:id/photo', async ({ db, user, params }) => {
  const id = Number(params.id);
  await mustSeeStudent(db, user, id);
  await q.run(db, 'UPDATE students SET photo = NULL, photo_v = NULL WHERE id = ?', id);
  return { ok: true };
});
// 학생 기록 완전히 삭제 (원장만). 되돌릴 수 없어요.
// 교재 재고 숫자가 틀어지지 않도록 교재 배부 기록은 이름 없이(학생 0번) 남겨요.
route('DELETE', '/api/students/:id', async ({ db, params, body }) => {
  const id = Number(params.id);
  const s = await q.first(db, 'SELECT id, name FROM students WHERE id = ?', id);
  if (!s) fail(404, '학생을 찾을 수 없어요');
  if (String((body && body.confirm_name) || '').replace(/\s/g, '') !== String(s.name).replace(/\s/g, '')) fail(400, '확인용 이름이 학생 이름과 달라요');
  const del = (table) => db.prepare(`DELETE FROM ${table} WHERE student_id = ?`).bind(id);
  const stmts = [
    db.prepare('DELETE FROM class_log_notes WHERE student_id = ?').bind(id),
    ...['enrollments', 'attendance', 'feedbacks', 'messages', 'consultations', 'risk_flags', 'student_discounts', 'student_subjects', 'bills', 'word_tests', 'payments'].map(del),
    db.prepare('UPDATE book_deliveries SET student_id = 0, memo = NULL WHERE student_id = ?').bind(id),
    db.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE student_id = ?)').bind(id),
    db.prepare('DELETE FROM users WHERE student_id = ? AND role = ?').bind(id, 'student'),
    db.prepare('DELETE FROM students WHERE id = ?').bind(id),
  ];
  await db.batch(stmts);
  return { ok: true };
}, OWNER);
route('GET', '/api/student-photos/:id', async ({ db, user, params }) => {
  const id = Number(params.id);
  if (!(await canSeeStudent(db, user, id))) {
    // 형제·자매 사진은 볼 수 있게 합니다 (내 학생의 형제일 때)
    const view = await viewOf(db, user);
    const sib = view.siblings && (await q.first(db, `SELECT 1 AS ok FROM students a JOIN students b ON a.family_id = b.family_id WHERE a.id = ? AND b.id IN (${MY_STUDENTS})`, id, user.id));
    if (!sib) fail(403, '볼 수 없는 사진이에요');
  }
  const r = await q.first(db, 'SELECT photo FROM students WHERE id = ?', id);
  if (!r || !r.photo) fail(404, '사진이 없어요');
  return photoResponse(r.photo);
});

// 형제·자매 연결 (원장)
route('POST', '/api/students/:id/siblings', async ({ db, body, params }) => {
  const a = await q.first(db, 'SELECT id, family_id FROM students WHERE id = ?', Number(params.id));
  const b = await q.first(db, 'SELECT id, family_id FROM students WHERE id = ?', Number(body.sibling_id));
  if (!a || !b) fail(404, '학생을 찾을 수 없어요');
  if (a.id === b.id) fail(400, '같은 학생이에요');
  const fam = a.family_id || b.family_id || Math.min(a.id, b.id);
  // 두 가족을 하나로 합칩니다
  const stmts = [db.prepare('UPDATE students SET family_id = ? WHERE id IN (?, ?)').bind(fam, a.id, b.id)];
  for (const old of [a.family_id, b.family_id]) if (old && old !== fam) stmts.push(db.prepare('UPDATE students SET family_id = ? WHERE family_id = ?').bind(fam, old));
  await db.batch(stmts);
  return { ok: true };
}, OM);

route('DELETE', '/api/students/:id/siblings/:other', async ({ db, params }) => {
  const other = await q.first(db, 'SELECT id, family_id FROM students WHERE id = ?', Number(params.other));
  if (!other || !other.family_id) return { ok: true };
  await q.run(db, 'UPDATE students SET family_id = NULL WHERE id = ?', other.id);
  // 한 명만 남으면 가족 표시도 지웁니다
  const left = await q.all(db, 'SELECT id FROM students WHERE family_id = ?', other.family_id);
  if (left.length === 1) await q.run(db, 'UPDATE students SET family_id = NULL WHERE id = ?', left[0].id);
  return { ok: true };
}, OM);

// 학생별 할인 체크 (원장)
route('PUT', '/api/students/:id/discounts', async ({ db, body, params }) => {
  const id = Number(params.id);
  if (!(await q.first(db, 'SELECT id FROM students WHERE id = ?', id))) fail(404, '학생을 찾을 수 없어요');
  const valid = new Set(discountItems(await getSettings(db)).map((i) => i.id));
  const ids = [...new Set((body.item_ids || []).map(String))].filter((x) => valid.has(x));
  await db.batch([db.prepare('DELETE FROM student_discounts WHERE student_id = ?').bind(id), ...ids.map((x) => db.prepare('INSERT INTO student_discounts (student_id, item_id) VALUES (?, ?)').bind(id, x))]);
  return { ok: true };
}, OWNER);

// 과목별 등록일·퇴원일 (원장·감독). 퇴원하면서 그 과목 반에서 빼기도 할 수 있어요.
route('PUT', '/api/students/:id/subjects', async ({ db, body, params }) => {
  const id = Number(params.id);
  if (!(await q.first(db, 'SELECT id FROM students WHERE id = ?', id))) fail(404, '학생을 찾을 수 없어요');
  if (!SUBJECTS.includes(body.subject)) fail(400, '과목을 골라 주세요');
  const start = isDate(body.start_date) ? body.start_date : null;
  const end = isDate(body.end_date) ? body.end_date : null;
  if (start && end && end < start) fail(400, '퇴원일이 등록일보다 빨라요');
  const stmts = [
    !start && !end
      ? db.prepare('DELETE FROM student_subjects WHERE student_id = ? AND subject = ?').bind(id, body.subject)
      : db.prepare(`INSERT INTO student_subjects (student_id, subject, start_date, end_date) VALUES (?, ?, ?, ?)
                    ON CONFLICT (student_id, subject) DO UPDATE SET start_date = excluded.start_date, end_date = excluded.end_date`).bind(id, body.subject, start, end),
  ];
  if (end && body.remove_from_courses) stmts.push(db.prepare('DELETE FROM enrollments WHERE student_id = ? AND course_id IN (SELECT id FROM courses WHERE subject = ?)').bind(id, body.subject));
  await db.batch(stmts);
  return { ok: true };
}, OM);

// 학생별 수강료 (원장) — 비우면 반 기본 금액을 씁니다
route('PATCH', '/api/enrollments', async ({ db, body }) => {
  const e = await q.first(db, 'SELECT * FROM enrollments WHERE course_id = ? AND student_id = ?', Number(body.course_id), Number(body.student_id));
  if (!e) fail(404, '수강 정보를 찾을 수 없어요');
  const fee = body.fee === '' || body.fee == null ? null : money(body.fee);
  await q.run(db, 'UPDATE enrollments SET fee = ? WHERE course_id = ? AND student_id = ?', fee, e.course_id, e.student_id);
  return { ok: true };
}, OWNER);

// 교재 배부
route('POST', '/api/students/:id/books', async ({ db, user, body, params }) => {
  const id = Number(params.id);
  await mustSeeStudent(db, user, id);
  if (!(await viewOf(db, user)).books) fail(403, '교재 배부 내역을 쓸 권한이 없어요');
  const qty = Math.max(1, Math.min(99, Number(body.qty) || 1));
  const bk = body.book_id ? await q.first(db, 'SELECT * FROM books WHERE id = ?', Number(body.book_id)) : null;
  if (body.book_id && !bk) fail(404, '교재를 찾을 수 없어요');
  const r = await q.run(
    db,
    'INSERT INTO book_deliveries (student_id, book_id, date, title, subject, qty, price, memo, given_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    bk ? bk.id : null,
    isDate(body.date) ? body.date : today(),
    bk ? bk.name : need(body.title, '교재 이름'),
    SUBJECTS.includes(body.subject) ? body.subject : bk ? bk.subject : null,
    qty,
    body.price === '' || body.price == null ? (bk ? bk.sale_price ?? bk.list_price ?? null : null) : money(body.price),
    clean(body.memo),
    user.id
  );
  return { ok: true, id: r.meta.last_row_id };
});
route('DELETE', '/api/deliveries/:id', async ({ db, user, params }) => {
  const b = await q.first(db, 'SELECT * FROM book_deliveries WHERE id = ?', Number(params.id));
  if (!b) fail(404, '기록을 찾을 수 없어요');
  if (user.role !== 'owner' && b.given_by !== user.id) fail(403, '내가 쓴 기록만 지울 수 있어요');
  await q.run(db, 'DELETE FROM book_deliveries WHERE id = ?', b.id);
  return { ok: true };
});

// 수납 (원장만 기록) — 강사는 설정에서 허락한 경우 보기만
route('POST', '/api/students/:id/payments', async ({ db, user, body, params }) => {
  const id = Number(params.id);
  if (!(await q.first(db, 'SELECT id FROM students WHERE id = ?', id))) fail(404, '학생을 찾을 수 없어요');
  const kind = body.kind === '교재비' ? '교재비' : '교육비';
  const month = /^\d{4}-\d{2}$/.test(body.month || '') ? body.month : null;
  if (kind === '교육비' && !month) fail(400, '몇 월 교육비인지 골라 주세요');
  const amount = money(body.amount);
  if (!amount) fail(400, '금액을 입력해 주세요');
  const method = ['카드', '계좌이체', '현금', '지역화폐', '기타'].includes(body.method) ? body.method : '기타';
  const r = await q.run(db, 'INSERT INTO payments (student_id, kind, month, amount, paid_date, method, memo, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, kind, month, amount, isDate(body.paid_date) ? body.paid_date : today(), method, clean(body.memo), user.id);
  return { ok: true, id: r.meta.last_row_id };
}, OWNER);
route('DELETE', '/api/payments/:id', async ({ db, params }) => {
  await q.run(db, 'DELETE FROM payments WHERE id = ?', Number(params.id));
  return { ok: true };
}, OWNER);

// ───────── 반(강좌) ─────────

route('GET', '/api/courses', async ({ db, user, query }) => {
  const where = [];
  const params = [];
  if (!seesAll(user)) where.push('c.teacher_id = ?'), params.push(user.id);
  if (query.active !== 'all') where.push('c.active = 1');
  const courses = await q.all(
    db,
    `SELECT c.*, u.name AS teacher_name, u.photo_v AS teacher_photo_v,
      (SELECT COUNT(*) FROM enrollments e JOIN students s ON s.id = e.student_id WHERE e.course_id = c.id AND s.status = '재원') AS student_count
     FROM courses c LEFT JOIN users u ON u.id = c.teacher_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY c.active DESC, c.subject, c.name`,
    ...params
  );
  if (!(await viewOf(db, user)).fees) for (const c of courses) delete c.fee;
  return { courses, subjects: SUBJECTS };
});

route('GET', '/api/courses/:id', async ({ db, user, params }) => {
  const course = await mustSeeCourse(db, user, Number(params.id));
  const students = await q.all(db, `SELECT s.id, s.name, s.school, s.grade, s.status, s.photo_v FROM enrollments e JOIN students s ON s.id = e.student_id WHERE e.course_id = ? ORDER BY s.name`, course.id);
  return { course, students };
});

// 요일별 수업 시간: { "월": { start: "18:00", end: "20:00" }, "수": { start: "19:00", end: "21:00" } }
const isTime = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t || ''));
function parseTimes(raw) {
  if (!raw) return {};
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}
// 그 요일의 시작·끝 시간 (요일별 시간이 없으면 반 기본 시간)
function timeOn(c, wd) {
  const t = parseTimes(c.times)[wd];
  return { start: (t && t.start) || c.start_time || '', end: (t && t.end) || c.end_time || '' };
}
function withTodayTime(list, wd) {
  for (const c of list) {
    const t = timeOn(c, wd);
    c.start_time = t.start;
    c.end_time = t.end;
  }
  return list.sort((a, b) => (a.start_time || '99').localeCompare(b.start_time || '99') || a.name.localeCompare(b.name));
}

function courseValues(body, base = {}) {
  const v = { ...base };
  for (const f of ['name', 'subject', 'days', 'start_time', 'end_time', 'room']) if (f in body) v[f] = clean(body[f]);
  if ('times' in body) {
    const src = parseTimes(body.times);
    const times = {};
    for (const d of WEEK) {
      if (!src[d]) continue;
      const start = isTime(src[d].start) ? src[d].start : null;
      const end = isTime(src[d].end) ? src[d].end : null;
      if (start && end && end <= start) fail(400, `${d}요일 끝 시간이 시작 시간보다 빨라요`);
      times[d] = { start, end };
    }
    const order = ['월', '화', '수', '목', '금', '토', '일'];
    const days = order.filter((d) => times[d]);
    v.days = days.join(',');
    v.times = days.length ? JSON.stringify(Object.fromEntries(days.map((d) => [d, times[d]]))) : null;
    // 예전 칸(대표 시간)도 첫 요일 시간으로 맞춰 둡니다
    v.start_time = days.length ? times[days[0]].start : null;
    v.end_time = days.length ? times[days[0]].end : null;
  }
  if ('fee' in body) v.fee = body.fee === '' || body.fee == null ? null : money(body.fee);
  if ('teacher_id' in body) v.teacher_id = body.teacher_id ? Number(body.teacher_id) : null;
  if ('active' in body) v.active = body.active ? 1 : 0;
  if (!v.name) fail(400, '반 이름을 입력해 주세요');
  if (!SUBJECTS.includes(v.subject)) fail(400, '과목을 골라 주세요');
  if (v.days) v.days = v.days.split(/[,\s]+/).filter((d) => WEEK.includes(d)).join(',');
  return v;
}
const COURSE_FIELDS = ['name', 'subject', 'teacher_id', 'days', 'times', 'start_time', 'end_time', 'room', 'fee', 'active'];

route(
  'POST',
  '/api/courses',
  async ({ db, body }) => {
    const v = courseValues(body, { active: 1 });
    const r = await q.run(db, `INSERT INTO courses (${COURSE_FIELDS.join(',')}) VALUES (${COURSE_FIELDS.map(() => '?').join(',')})`, ...COURSE_FIELDS.map((f) => v[f] ?? null));
    return { ok: true, id: r.meta.last_row_id };
  },
  OWNER
);

route(
  'PATCH',
  '/api/courses/:id',
  async ({ db, body, params }) => {
    const cur = await q.first(db, 'SELECT * FROM courses WHERE id = ?', Number(params.id));
    if (!cur) fail(404, '반을 찾을 수 없어요');
    const v = courseValues(body, cur);
    await q.run(db, `UPDATE courses SET ${COURSE_FIELDS.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`, ...COURSE_FIELDS.map((f) => v[f] ?? null), cur.id);
    return { ok: true };
  },
  OWNER
);

route(
  'PUT',
  '/api/courses/:id/students',
  async ({ db, body, params }) => {
    const id = Number(params.id);
    if (!(await q.first(db, 'SELECT id FROM courses WHERE id = ?', id))) fail(404, '반을 찾을 수 없어요');
    const ids = [...new Set((body.student_ids || []).map(Number).filter(Boolean))];
    const course = await q.first(db, 'SELECT subject FROM courses WHERE id = ?', id);
    const before = new Set((await q.all(db, 'SELECT student_id FROM enrollments WHERE course_id = ?', id)).map((r) => r.student_id));
    const added = ids.filter((sid) => !before.has(sid));
    const t = today();
    await db.batch([
      db.prepare('DELETE FROM enrollments WHERE course_id = ?').bind(id),
      ...ids.map((sid) => db.prepare('INSERT OR IGNORE INTO enrollments (course_id, student_id) VALUES (?, ?)').bind(id, sid)),
      // 새로 들어온 학생: 그 과목 등록일이 없거나 퇴원했던 경우 오늘로 다시 등록
      ...added.map((sid) => db.prepare(`INSERT INTO student_subjects (student_id, subject, start_date) VALUES (?, ?, ?)
        ON CONFLICT (student_id, subject) DO UPDATE SET start_date = CASE WHEN student_subjects.end_date IS NOT NULL OR student_subjects.start_date IS NULL THEN excluded.start_date ELSE student_subjects.start_date END, end_date = NULL`).bind(sid, course.subject, t)),
    ]);
    return { ok: true, count: ids.length, added: added.length };
  },
  OM
);

// ───────── 출결 알림 ─────────

route('GET', '/api/attendance/today', async ({ db, user, query }) => {
  const date = isDate(query.date) ? query.date : today();
  const wd = weekdayOf(date);
  const params = [date, wd];
  let mine = '';
  if (!seesAll(user)) (mine = 'AND c.teacher_id = ?'), params.push(user.id);
  const courses = await q.all(
    db,
    `SELECT c.id, c.name, c.subject, c.start_time, c.end_time, c.times, c.room, c.teacher_id, u.name AS teacher_name, u.photo_v AS teacher_photo_v,
      (SELECT COUNT(*) FROM enrollments e JOIN students s ON s.id = e.student_id WHERE e.course_id = c.id AND s.status = '재원') AS student_count,
      (SELECT COUNT(*) FROM attendance a WHERE a.course_id = c.id AND a.date = ?) AS checked_count
     FROM courses c LEFT JOIN users u ON u.id = c.teacher_id
     WHERE c.active = 1 AND instr(',' || IFNULL(c.days,'') || ',', ',' || ? || ',') > 0 ${mine}
     ORDER BY c.start_time, c.name`,
    ...params
  );
  return { date, weekday: wd, courses: withTodayTime(courses, wd) };
});

route('GET', '/api/attendance', async ({ db, user, query }) => {
  const course = await mustSeeCourse(db, user, Number(query.course_id));
  const date = isDate(query.date) ? query.date : today();
  const rows = await q.all(
    db,
    `SELECT s.id AS student_id, s.name, s.school, s.grade, s.photo_v, ${PHONES}, a.status, a.memo, a.notified_status
     FROM enrollments e JOIN students s ON s.id = e.student_id
     LEFT JOIN attendance a ON a.course_id = e.course_id AND a.student_id = s.id AND a.date = ?
     WHERE e.course_id = ? AND s.status = '재원'
     ORDER BY s.name`,
    date,
    course.id
  );
  for (const r of rows) {
    r.has_phone = recipients(r).length > 0;
    delete r.father_phone, delete r.mother_phone, delete r.sms_target;
  }
  return { course, date, rows };
});

route('POST', '/api/attendance', async ({ db, env, user, body }) => {
  const course = await mustSeeCourse(db, user, Number(body.course_id));
  const date = isDate(body.date) ? body.date : today();
  const records = (body.records || []).filter((r) => ATT_STATUS.includes(r.status));
  if (!records.length) fail(400, '출결을 하나 이상 골라 주세요');

  const enrolled = new Map((await q.all(db, `SELECT s.id, s.name, ${PHONES} FROM enrollments e JOIN students s ON s.id = e.student_id WHERE e.course_id = ?`, course.id)).map((s) => [s.id, s]));
  const existing = new Map((await q.all(db, 'SELECT student_id, notified_status FROM attendance WHERE course_id = ? AND date = ?', course.id, date)).map((r) => [r.student_id, r.notified_status]));

  const settings = await getSettings(db);
  const toNotify = [];
  const stmts = [];
  for (const r of records) {
    const sid = Number(r.student_id);
    const st = enrolled.get(sid);
    if (!st) continue;
    const memo = clean(r.memo);
    stmts.push(
      db
        .prepare(
          `INSERT INTO attendance (course_id, student_id, date, status, memo, checked_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT (course_id, student_id, date) DO UPDATE SET status = excluded.status, memo = excluded.memo, checked_by = excluded.checked_by, updated_at = excluded.updated_at`
        )
        .bind(course.id, sid, date, r.status, memo, user.id)
    );
    const wants = body.send && (r.status !== '출석' || body.include_present);
    if (wants && existing.get(sid) !== r.status) {
      toNotify.push(
        ...messagesFor(st, {
          kind: '출결',
          ref_type: 'attendance',
          text: fillTemplate(settings.tpl_attendance, {
            학원: settings.academy_name,
            학생: st.name,
            날짜: prettyDate(date),
            반: course.name,
            상태: r.status,
            메모: memo ? `\n(${memo})` : '',
          }),
        })
      );
    }
  }
  await db.batch(stmts);
  const results = await sendMessages(env, db, settings, user.id, toNotify);
  const okIds = [...new Set(toNotify.filter((m, i) => results[i].status !== '실패').map((m) => m.student_id))];
  const marks = okIds.map((sid) => db.prepare('UPDATE attendance SET notified_status = status WHERE course_id = ? AND student_id = ? AND date = ?').bind(course.id, sid, date));
  if (marks.length) await db.batch(marks);
  return {
    ok: true,
    saved: stmts.length,
    messages: toNotify.map((m, i) => ({ student_id: m.student_id, text: m.text, to: seesAll(user) ? m.to : maskPhone(m.to), ...results[i] })),
  };
});

// ───────── 영주사랑(지역화폐) 결제 대조 ─────────
// 결제자 "최*희(2650)" = 학부모 이름 첫·끝 글자 + 핸드폰 뒷자리 4개
// 메모에 학생 이름이 있으면 그 학생으로 확정합니다.

function parsePayer(raw) {
  const t = String(raw || '').trim();
  const m = t.match(/^(.*?)\s*\((\d{4})\)\s*$/);
  const mask = (m ? m[1] : t).trim();
  const last4 = m ? m[2] : (t.match(/(\d{4})\D*$/) || [])[1] || null;
  let re = null;
  if (mask) {
    const src = mask.split('').map((ch) => (ch === '*' ? '.*' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('');
    try { re = new RegExp('^' + src + '$'); } catch {}
  }
  return { mask, last4, re };
}
const won0 = (v) => Number(String(v ?? '').replace(/[^0-9.-]/g, '')) || 0;
function payDate(v) {
  const t = String(v || '').trim();
  const m = t.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
}
const payRef = (r) => `ys|${String(r.date || '').trim()}|${String(r.payer || '').trim()}|${won0(r.amount)}`;

route('POST', '/api/payments/import/preview', async ({ db, body }) => {
  const input = (body.rows || []).slice(0, 1000);
  if (!input.length) fail(400, '결제 내역이 없어요');
  const students = await q.all(
    db,
    `SELECT s.id, s.name, s.school, s.grade, s.status, s.family_id, s.mother_name, s.mother_phone, s.father_name, s.father_phone,
      (SELECT IFNULL(SUM(IFNULL(e.fee, c.fee)), 0) FROM enrollments e JOIN courses c ON c.id = e.course_id WHERE e.student_id = s.id AND c.active = 1) AS fee_month,
      (SELECT IFNULL(SUM(IFNULL(b.price, 0) * b.qty), 0) FROM book_deliveries b WHERE b.student_id = s.id) AS book_total,
      (SELECT IFNULL(SUM(p.amount), 0) FROM payments p WHERE p.student_id = s.id AND p.kind = '교재비') AS book_paid
     FROM students s`
  );
  const disc = await discountTotals(db);
  for (const s of students) s.fee_month = Math.max(0, s.fee_month - (disc.get(s.id) || 0));
  const paidRows = await q.all(db, `SELECT student_id, month, SUM(amount) AS paid FROM payments WHERE kind = '교육비' AND month IS NOT NULL GROUP BY student_id, month`);
  const paidOf = new Map(paidRows.map((r) => [`${r.student_id}|${r.month}`, r.paid]));
  const refs = new Set((await q.all(db, `SELECT ref FROM payments WHERE ref LIKE 'ys|%'`)).map((r) => r.ref.replace(/#\d+$/, '')));
  const last4 = (p) => (p ? String(p).slice(-4) : null);

  const rows = input.map((r, i) => {
    const date = payDate(r.date);
    const amount = won0(r.amount);
    const ref = payRef(r);
    const payer = parsePayer(r.payer);
    const memo = clean(r.memo) || '';
    const cancelled = /취소|환불|실패/.test(String(r.status || ''));
    // 메모의 "2월" → 그 달 교육비
    let month = date ? date.slice(0, 7) : today().slice(0, 7);
    const mm = memo.match(/(\d{1,2})\s*월/);
    if (mm && date && Number(mm[1]) >= 1 && Number(mm[1]) <= 12) {
      let y = Number(date.slice(0, 4));
      const want = Number(mm[1]), have = Number(date.slice(5, 7));
      if (want - have > 6) y--; else if (have - want > 6) y++;
      month = `${y}-${String(want).padStart(2, '0')}`;
    }
    const cands = [];
    for (const s of students) {
      let score = 0;
      const why = [];
      if (memo && s.name && memo.includes(s.name)) (score += 6), why.push('메모에 학생 이름');
      // 통장 입금자처럼 이름이 다 보일 때 (가림표 * 없음)
      const full = payer.mask && !payer.mask.includes('*') ? payer.mask.replace(/\s/g, '') : null;
      if (full && full === s.name) (score += 6), why.push('입금자 = 학생 이름');
      for (const [who, nm, ph] of [['어머니', s.mother_name, s.mother_phone], ['아버지', s.father_name, s.father_phone]]) {
        const phoneHit = payer.last4 && last4(ph) === payer.last4;
        const nameHit = payer.re && nm && payer.re.test(nm);
        if (full && nm && full === nm.replace(/\s/g, '') && !phoneHit) { score += 5; why.push(`입금자 = ${who} ${nm}`); continue; }
        if (phoneHit && nameHit) (score += 5), why.push(`${who} ${nm}·뒷자리 일치`);
        else if (phoneHit) (score += 3), why.push(`${who} 뒷자리 일치`);
        else if (nameHit && payer.mask.length >= 2) (score += 1), why.push(`${who} 이름 비슷함`);
      }
      if (score < 2) continue;
      const paidNow = paidOf.get(`${s.id}|${month}`) || 0;
      const bookDue = Math.max(0, s.book_total - s.book_paid);
      cands.push({
        student_id: s.id, name: s.name, school: s.school, grade: s.grade, status: s.status, family_id: s.family_id,
        score, why: why.join(', '), fee: s.fee_month, paid: paidNow, book_due: bookDue,
      });
    }
    cands.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    const top = cands[0];
    const tied = top ? cands.filter((c) => c.score === top.score) : [];
    let state = 'none';
    if (cancelled) state = 'cancelled';
    else if (refs.has(ref)) state = 'done';
    else if (top && tied.length === 1 && top.score >= 5) state = 'sure';
    else if (top && top.score >= 3) state = 'check';
    // 교재비 추천: 메모에 "교재" 또는 금액이 교재비 미납과 같을 때
    let kind = '교육비';
    if (top && (/교재|책/.test(memo) || (top.book_due > 0 && amount === top.book_due))) kind = '교재비';
    return {
      i, ref, date, time: String(r.date || '').slice(11, 16), payer: String(r.payer || ''), method_raw: String(r.method || ''),
      method: /카드/.test(String(r.method || '')) ? '카드' : /계좌|이체|입금|통장|은행/.test(String(r.method || '')) ? '계좌이체' : '지역화폐', amount, memo, month, state, kind,
      student_id: state === 'sure' || state === 'check' ? top.student_id : null,
      siblings: tied.length > 1,
      candidates: cands.slice(0, 6),
    };
  });
  return { rows };
}, OWNER);

route('POST', '/api/payments/import', async ({ db, user, body }) => {
  const items = (body.items || []).slice(0, 2000);
  if (!items.length) fail(400, '기록할 결제를 골라 주세요');
  const exist = new Set((await q.all(db, `SELECT ref FROM payments WHERE ref LIKE 'ys|%'`)).map((r) => r.ref));
  const ids = new Set((await q.all(db, 'SELECT id FROM students')).map((r) => r.id));
  const stmts = [];
  let skipped = 0;
  for (const it of items) {
    const ref = String(it.ref || '');
    if (!ref.startsWith('ys|') || exist.has(ref) || !ids.has(Number(it.student_id))) { skipped++; continue; }
    const kind = it.kind === '교재비' ? '교재비' : '교육비';
    const month = /^\d{4}-\d{2}$/.test(it.month || '') ? it.month : null;
    if (kind === '교육비' && !month) { skipped++; continue; }
    const amount = won0(it.amount);
    if (amount <= 0) { skipped++; continue; }
    exist.add(ref);
    stmts.push(
      db.prepare('INSERT INTO payments (student_id, kind, month, amount, paid_date, method, memo, created_by, ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(Number(it.student_id), kind, kind === '교육비' ? month : null, amount, isDate(it.paid_date) ? it.paid_date : today(), ['카드', '계좌이체'].includes(it.method) ? it.method : '지역화폐', clean(it.memo), user.id, ref)
    );
  }
  if (stmts.length) await db.batch(stmts);
  return { ok: true, added: stmts.length, skipped };
}, OWNER);

// ───────── 교재 관리 ─────────
const BOOK_LEVELS = ['유아', '초등', '중등', '고등'];
function suppliersOf(settings) {
  try { const a = JSON.parse(settings.book_suppliers); return Array.isArray(a) ? a : []; } catch { return []; }
}
const BOOK_STOCK_SQL = `
  (SELECT IFNULL(SUM(qty), 0) FROM book_stock st WHERE st.book_id = bk.id) AS stock_in,
  (SELECT IFNULL(SUM(qty), 0) FROM book_deliveries d WHERE d.book_id = bk.id) AS delivered`;

route('GET', '/api/catalog', async ({ db, query }) => {
  const where = [];
  const params = [];
  if (query.level) where.push('bk.level = ?'), params.push(query.level);
  if (query.subject) where.push('bk.subject = ?'), params.push(query.subject);
  if (query.supplier) where.push('bk.supplier = ?'), params.push(query.supplier);
  if (query.q) where.push('bk.name LIKE ?'), params.push(`%${query.q}%`);
  if (query.active !== 'all') where.push('bk.active = 1');
  const books = await q.all(
    db,
    `SELECT bk.id, bk.level, bk.subject, bk.supplier, bk.name, bk.list_price, bk.sale_price, bk.image_v, bk.memo, bk.active, ${BOOK_STOCK_SQL},
      (SELECT MAX(date) FROM book_stock st WHERE st.book_id = bk.id) AS last_in
     FROM books bk ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY bk.active DESC, CASE bk.level WHEN '유아' THEN 0 WHEN '초등' THEN 1 WHEN '중등' THEN 2 ELSE 3 END, bk.subject, bk.name`,
    ...params
  );
  for (const b of books) b.stock = b.stock_in - b.delivered;
  return { books, levels: BOOK_LEVELS, subjects: SUBJECTS, suppliers: suppliersOf(await getSettings(db)) };
});

route('GET', '/api/catalog/:id', async ({ db, user, params }) => {
  const book = await q.first(db, `SELECT bk.id, bk.level, bk.subject, bk.supplier, bk.name, bk.list_price, bk.sale_price, bk.image_v, bk.memo, bk.active, ${BOOK_STOCK_SQL} FROM books bk WHERE bk.id = ?`, Number(params.id));
  if (!book) fail(404, '교재를 찾을 수 없어요');
  book.stock = book.stock_in - book.delivered;
  const stock = await q.all(db, `SELECT st.*, u.name AS created_by_name FROM book_stock st LEFT JOIN users u ON u.id = st.created_by WHERE st.book_id = ? ORDER BY st.date DESC, st.id DESC`, book.id);
  const sc = studentScope(user);
  const deliveries = await q.all(
    db,
    `SELECT d.id, d.date, d.qty, d.price, d.memo, s.id AS student_id, s.name AS student_name, s.school, s.grade, u.name AS given_by_name
     FROM book_deliveries d JOIN students s ON s.id = d.student_id LEFT JOIN users u ON u.id = d.given_by
     WHERE d.book_id = ? AND ${sc.sql} ORDER BY d.date DESC, d.id DESC`,
    book.id, ...sc.params
  );
  return { book, stock, deliveries };
});

function bookValues(body, base = {}) {
  const v = { ...base };
  if ('name' in body) v.name = need(body.name, '교재명');
  if ('level' in body) v.level = BOOK_LEVELS.includes(body.level) ? body.level : null;
  if ('subject' in body) v.subject = SUBJECTS.includes(body.subject) ? body.subject : null;
  if ('supplier' in body) v.supplier = clean(body.supplier);
  if ('list_price' in body) v.list_price = body.list_price === '' || body.list_price == null ? null : money(body.list_price);
  if ('sale_price' in body) v.sale_price = body.sale_price === '' || body.sale_price == null ? null : money(body.sale_price);
  if ('memo' in body) v.memo = clean(body.memo);
  if ('active' in body) v.active = body.active ? 1 : 0;
  if (!v.name) fail(400, '교재명을 입력해 주세요');
  return v;
}
const BOOK_FIELDS = ['level', 'subject', 'supplier', 'name', 'list_price', 'sale_price', 'memo', 'active'];
route('POST', '/api/catalog', async ({ db, user, body }) => {
  const v = bookValues(body, { active: 1 });
  const r = await q.run(db, `INSERT INTO books (${BOOK_FIELDS.join(',')}) VALUES (${BOOK_FIELDS.map(() => '?').join(',')})`, ...BOOK_FIELDS.map((f) => v[f] ?? null));
  const id = r.meta.last_row_id;
  // 처음 입고 수량을 같이 적었으면 입고도 기록
  const qty = Math.trunc(Number(body.first_qty) || 0);
  if (qty) await q.run(db, 'INSERT INTO book_stock (book_id, date, qty, supplier, created_by) VALUES (?, ?, ?, ?, ?)', id, isDate(body.first_date) ? body.first_date : today(), qty, v.supplier, user.id);
  return { ok: true, id };
}, OM);
// 엑셀로 교재 여러 개 한꺼번에 등록 (화면에서 15개씩 나눠 보내요)
// 같은 이름의 교재가 이미 있으면 건너뛰고, 재고가 있으면 첫 입고로 기록해요.
route('POST', '/api/catalog/import', async ({ db, user, body }) => {
  const rows = Array.isArray(body.rows) ? body.rows.slice(0, 20) : [];
  const exist = new Set((await q.all(db, 'SELECT name FROM books')).map((r) => normName(r.name)));
  const stmts = [];
  const newSup = new Set();
  let added = 0, skipped = 0, stocked = 0;
  for (const r of rows) {
    const name = clean(r.name);
    if (!name || exist.has(normName(name))) { skipped++; continue; }
    exist.add(normName(name));
    const num = (v) => { const n = Number(String(v ?? '').replace(/[^0-9]/g, '')); return String(v ?? '').trim() === '' || !Number.isFinite(n) || n > 100000000 ? null : n; };
    const supplier = clean(r.supplier);
    if (supplier) newSup.add(supplier);
    stmts.push(db.prepare('INSERT INTO books (level, subject, supplier, name, list_price, sale_price, memo, active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)')
      .bind(BOOK_LEVELS.includes(r.level) ? r.level : null, SUBJECTS.includes(r.subject) ? r.subject : null, supplier, name.slice(0, 200), num(r.list_price), num(r.sale_price), clean(r.memo)));
    const qty = Math.trunc(Number(r.stock) || 0);
    if (qty > 0 && qty < 100000) {
      stmts.push(db.prepare('INSERT INTO book_stock (book_id, date, qty, supplier, memo, created_by) VALUES (last_insert_rowid(), ?, ?, ?, ?, ?)')
        .bind(isDate(r.date) ? r.date : today(), qty, supplier, '아이키즈에서 옮긴 재고', user.id));
      stocked++;
    }
    added++;
  }
  // 처음 보는 거래처는 거래처 목록에도 넣어요
  const sups = suppliersOf(await getSettings(db));
  const more = [...newSup].filter((x) => !sups.includes(x));
  if (more.length) stmts.push(db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('book_suppliers', ?)`).bind(JSON.stringify([...sups, ...more])));
  if (stmts.length) await db.batch(stmts);
  return { ok: true, added, skipped, stocked };
}, OM);
route('PATCH', '/api/catalog/:id', async ({ db, body, params }) => {
  const cur = await q.first(db, 'SELECT * FROM books WHERE id = ?', Number(params.id));
  if (!cur) fail(404, '교재를 찾을 수 없어요');
  const v = bookValues(body, cur);
  await q.run(db, `UPDATE books SET ${BOOK_FIELDS.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`, ...BOOK_FIELDS.map((f) => v[f] ?? null), cur.id);
  return { ok: true };
}, OM);
route('PUT', '/api/catalog/:id/image', async ({ db, body, params }) => {
  const data = String(body.data || '');
  if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(data)) fail(400, '사진 파일(jpg, png)만 올릴 수 있어요');
  if (data.length > PHOTO_MAX) fail(400, '사진이 너무 커요. 다른 사진으로 해 주세요');
  const v = Date.now();
  await q.run(db, 'UPDATE books SET image = ?, image_v = ? WHERE id = ?', data, v, Number(params.id));
  return { ok: true, image_v: v };
}, OM);
route('DELETE', '/api/catalog/:id/image', async ({ db, params }) => {
  await q.run(db, 'UPDATE books SET image = NULL, image_v = NULL WHERE id = ?', Number(params.id));
  return { ok: true };
}, OM);
route('GET', '/api/book-images/:id', async ({ db, params }) => {
  const r = await q.first(db, 'SELECT image FROM books WHERE id = ?', Number(params.id));
  if (!r || !r.image) fail(404, '사진이 없어요');
  return photoResponse(r.image);
});
route('POST', '/api/catalog/:id/stock', async ({ db, user, body, params }) => {
  const bk = await q.first(db, 'SELECT * FROM books WHERE id = ?', Number(params.id));
  if (!bk) fail(404, '교재를 찾을 수 없어요');
  const qty = Math.trunc(Number(body.qty) || 0);
  if (!qty) fail(400, '수량을 입력해 주세요 (반품은 -2처럼 적어요)');
  const r = await q.run(db, 'INSERT INTO book_stock (book_id, date, qty, supplier, memo, created_by) VALUES (?, ?, ?, ?, ?, ?)', bk.id, isDate(body.date) ? body.date : today(), qty, clean(body.supplier) || bk.supplier, clean(body.memo), user.id);
  return { ok: true, id: r.meta.last_row_id };
}, OM);
route('DELETE', '/api/book-stock/:id', async ({ db, params }) => {
  await q.run(db, 'DELETE FROM book_stock WHERE id = ?', Number(params.id));
  return { ok: true };
}, OM);
// 여러 학생에게 한 번에 배부 (반 전체 등)
route('POST', '/api/catalog/:id/deliver', async ({ db, user, body, params }) => {
  const bk = await q.first(db, 'SELECT * FROM books WHERE id = ?', Number(params.id));
  if (!bk) fail(404, '교재를 찾을 수 없어요');
  if (!(await viewOf(db, user)).books) fail(403, '교재 배부를 기록할 권한이 없어요');
  const ids = [...new Set((body.student_ids || []).map(Number).filter(Boolean))];
  if (!ids.length) fail(400, '학생을 골라 주세요');
  for (const sid of ids) if (!(await canSeeStudent(db, user, sid))) fail(403, '담당 학생이 아닌 학생이 있어요');
  const price = body.price === '' || body.price == null ? bk.sale_price ?? bk.list_price ?? null : money(body.price);
  const date = isDate(body.date) ? body.date : today();
  await db.batch(ids.map((sid) => db.prepare('INSERT INTO book_deliveries (student_id, book_id, date, title, subject, qty, price, memo, given_by) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)').bind(sid, bk.id, date, bk.name, bk.subject, price, clean(body.memo), user.id)));
  return { ok: true, count: ids.length };
});

// ───────── 청구서 ─────────
// 계좌 글: 청구하는 항목에 맞는 계좌만 넣어요 (교육비 계좌 / 교재비 계좌)
function accountText(settings, hasTuition, hasBook) {
  const t = settings.bank_account || '', b = settings.bank_account_book || '';
  if (!t && !b) return '(학원으로 문의해 주세요)';
  if (hasTuition && hasBook && t && b && t !== b) return `\n· 교육비: ${t}\n· 교재비: ${b}`;
  if (hasBook && !hasTuition) return b || t;
  return t || b;
}

// 이번 달 교육비(할인 반영) 남은 금액 + 교재비 미납을 학부모님께 문자로 보냅니다.
// kind: tuition(교육비만) / book(교재비만) / all(함께)
const BILL_KINDS = ['tuition', 'book', 'all'];
async function billRows(db, month, kind = 'all') {
  const rows = await q.all(
    db,
    `SELECT s.id, s.name, s.school, s.grade, s.photo_v, s.father_phone, s.mother_phone, s.sms_target,
      (SELECT IFNULL(SUM(IFNULL(e.fee, c.fee)), 0) FROM enrollments e JOIN courses c ON c.id = e.course_id WHERE e.student_id = s.id AND c.active = 1) AS gross,
      (SELECT IFNULL(SUM(p.amount), 0) FROM payments p WHERE p.student_id = s.id AND p.kind = '교육비' AND p.month = ?) AS paid,
      (SELECT IFNULL(SUM(IFNULL(b.price, 0) * b.qty), 0) FROM book_deliveries b WHERE b.student_id = s.id) AS book_total,
      (SELECT IFNULL(SUM(p.amount), 0) FROM payments p WHERE p.student_id = s.id AND p.kind = '교재비') AS book_paid,
      (SELECT group_concat(b.title || CASE WHEN b.qty > 1 THEN ' x' || b.qty ELSE '' END, ', ') FROM book_deliveries b WHERE b.student_id = s.id AND b.price > 0 AND b.date >= ?) AS recent_books
     FROM students s WHERE s.status = '재원' ORDER BY s.name`,
    month, `${month}-01`
  );
  const disc = await discountTotals(db);
  const last = new Map((await q.all(db, `SELECT student_id, MAX(id) AS id FROM bills WHERE month = ? AND IFNULL(kind, 'all') = ? GROUP BY student_id`, month, kind)).map((r) => [r.student_id, r.id]));
  const lastBills = last.size ? new Map((await q.all(db, `SELECT * FROM bills WHERE id IN (${[...last.values()].join(',')})`)).map((b) => [b.student_id, b])) : new Map();
  const counts = new Map((await q.all(db, `SELECT student_id, COUNT(*) AS n FROM bills WHERE month = ? AND IFNULL(kind, 'all') = ? GROUP BY student_id`, month, kind)).map((r) => [r.student_id, r.n]));
  return rows.map((r) => {
    const discount = disc.get(r.id) || 0;
    const fee = Math.max(0, r.gross - discount);
    const tuition_due = Math.max(0, fee - r.paid);
    const book_due = Math.max(0, r.book_total - r.book_paid);
    const b = lastBills.get(r.id);
    return {
      id: r.id, name: r.name, school: r.school, grade: r.grade, photo_v: r.photo_v, has_phone: recipients(r).length > 0,
      gross: r.gross, discount, fee, paid: r.paid, tuition_due, book_due, recent_books: r.recent_books,
      total: kind === 'tuition' ? tuition_due : kind === 'book' ? book_due : tuition_due + book_due,
      last_bill: b ? { sent_at: b.sent_at, total: b.total, status: b.status } : null,
      bill_count: counts.get(r.id) || 0,
      _r: r,
    };
  });
}
route('GET', '/api/bills', async ({ db, query }) => {
  const month = /^\d{4}-\d{2}$/.test(query.month || '') ? query.month : today().slice(0, 7);
  const kind = BILL_KINDS.includes(query.kind) ? query.kind : 'tuition';
  const rows = (await billRows(db, month, kind)).map(({ _r, ...x }) => x);
  const s = await getSettings(db);
  return { month, kind, rows, bank_account: s.bank_account || '', bank_account_book: s.bank_account_book || '' };
}, OWNER);
route('POST', '/api/bills/send', async ({ db, env, user, body }) => {
  const month = /^\d{4}-\d{2}$/.test(body.month || '') ? body.month : today().slice(0, 7);
  const ids = new Set((body.student_ids || []).map(Number));
  if (!ids.size) fail(400, '청구서를 보낼 학생을 골라 주세요');
  const settings = await getSettings(db);
  const mm = Number(month.slice(5));
  const kind = BILL_KINDS.includes(body.kind) ? body.kind : 'tuition';
  const targets = (await billRows(db, month, kind)).filter((r) => ids.has(r.id) && r.total > 0);
  if (!targets.length) fail(400, '보낼 금액이 있는 학생이 없어요 (이미 다 냈어요)');
  const msgs = [];
  const billInfo = [];
  for (const t of targets) {
    const lines = [];
    const useT = kind !== 'book' && t.tuition_due > 0, useB = kind !== 'tuition' && t.book_due > 0;
    if (useT) lines.push(`· ${mm}월 교육비 ${t.tuition_due.toLocaleString('ko-KR')}원${t.discount ? ` (할인 ${t.discount.toLocaleString('ko-KR')}원 적용)` : ''}${t.paid ? ` (이미 ${t.paid.toLocaleString('ko-KR')}원 납부)` : ''}`);
    if (useB) lines.push(`· 교재비 ${t.book_due.toLocaleString('ko-KR')}원${t.recent_books ? ` (${t.recent_books})` : ''}`);
    const tpl = kind === 'tuition' ? settings.tpl_bill_tuition : kind === 'book' ? settings.tpl_bill_book : settings.tpl_bill;
    const text = fillTemplate(tpl, { 학원: settings.academy_name, 학생: t.name, 월: mm, 내역: lines.join('\n'), 합계: `${t.total.toLocaleString('ko-KR')}원`, 계좌: accountText(settings, useT, useB) });
    const parts = messagesFor(t._r, { kind: '청구서', text, ref_type: 'bill' });
    msgs.push(...parts);
    billInfo.push({ t, lines, n: parts.length });
  }
  const results = await sendMessages(env, db, settings, user.id, msgs);
  let k = 0;
  const stmts = [];
  const out = [];
  for (const bi of billInfo) {
    const rs = results.slice(k, k + bi.n);
    k += bi.n;
    const status = rs.some((x) => x.status === '발송') ? '발송' : rs.some((x) => x.status === '미리보기') ? '미리보기' : '실패';
    stmts.push(db.prepare('INSERT INTO bills (student_id, month, kind, items, total, status, sent_by) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(bi.t.id, month, kind, JSON.stringify({ tuition: kind === 'book' ? 0 : bi.t.tuition_due, book: kind === 'tuition' ? 0 : bi.t.book_due, discount: bi.t.discount, lines: bi.lines }), bi.t.total, status, user.id));
    out.push({ student_id: bi.t.id, name: bi.t.name, total: bi.t.total, status, error: (rs.find((x) => x.error) || {}).error || null });
  }
  await db.batch(stmts);
  return { ok: true, sent: out.filter((x) => x.status !== '실패').length, failed: out.filter((x) => x.status === '실패').length, results: out };
}, OWNER);

// ───────── 수업 일지 ─────────
// 반·날짜마다 한 장: 수업 내용(진도), 숙제, 학생별 메모(학부모에게 가지 않음)

route('GET', '/api/classlog', async ({ db, user, query }) => {
  const course = await mustSeeCourse(db, user, Number(query.course_id));
  const date = isDate(query.date) ? query.date : today();
  const log = await q.first(db, `SELECT l.*, u.name AS teacher_name FROM class_logs l LEFT JOIN users u ON u.id = l.teacher_id WHERE l.course_id = ? AND l.date = ?`, course.id, date);
  const notes = log ? await q.all(db, 'SELECT student_id, note, hw, achieve FROM class_log_notes WHERE log_id = ?', log.id) : [];
  const recent = await q.all(db, `SELECT date, content, homework, books FROM class_logs WHERE course_id = ? AND date < ? ORDER BY date DESC LIMIT 3`, course.id, date);
  const units = await q.all(db, 'SELECT * FROM course_units WHERE course_id = ? ORDER BY seq, id', course.id);
  // 지난 수업 숙제 검사 누적 (최근 30일 × 횟수)
  const hwMiss = await q.all(db, `SELECT n.student_id, SUM(CASE WHEN n.hw = '×' THEN 1 ELSE 0 END) AS miss, SUM(CASE WHEN n.hw = '△' THEN 1 ELSE 0 END) AS part
    FROM class_log_notes n JOIN class_logs l ON l.id = n.log_id WHERE l.course_id = ? AND l.date >= ? AND l.date < ? GROUP BY n.student_id`, course.id, addDays(date, -30), date);
  const words = await q.all(db, 'SELECT id, student_id, score, total, passed, attempt, range, round, kind, photo_v FROM word_tests WHERE course_id = ? AND date = ? ORDER BY attempt, id', course.id, date);
  return { log, notes, recent, units, hw_miss: hwMiss, fields: parseFields(course.log_fields), words };
});

route('PUT', '/api/classlog', async ({ db, user, body }) => {
  const course = await mustSeeCourse(db, user, Number(body.course_id));
  const date = isDate(body.date) ? body.date : today();
  const content = clean(body.content);
  const homework = clean(body.homework);
  const HW = ['○', '△', '×'], ACH = ['상', '중', '하'];
  const notes = (body.notes || []).map((n) => ({ sid: Number(n.student_id), note: clean(n.note), hw: HW.includes(n.hw) ? n.hw : null, achieve: ACH.includes(n.achieve) ? n.achieve : null }));
  const unitIds = [...new Set((body.unit_ids || []).map(Number).filter(Boolean))];
  const books = [...new Set((body.books || []).map(clean).filter(Boolean))].slice(0, 10).join(', ') || null;
  const ex = {};
  for (const [k, v] of Object.entries(body.extras || {}).slice(0, 20)) { const kk = clean(k), vv = clean(v); if (kk && vv) ex[kk] = vv.slice(0, 200); }
  const extras = Object.keys(ex).length ? JSON.stringify(ex) : null;
  if (!content && !homework && !books && !extras && !notes.some((n) => n.note || n.hw || n.achieve) && !unitIds.length) fail(400, '수업 내용이나 숙제를 적거나, 교재·단원을 골라 주세요');
  await q.run(
    db,
    `INSERT INTO class_logs (course_id, date, teacher_id, content, homework, books, extras, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (course_id, date) DO UPDATE SET teacher_id = excluded.teacher_id, content = excluded.content, homework = excluded.homework, books = excluded.books, extras = excluded.extras, updated_at = excluded.updated_at`,
    course.id, date, user.id, content, homework, books, extras
  );
  const log = await q.first(db, 'SELECT id FROM class_logs WHERE course_id = ? AND date = ?', course.id, date);
  const enrolled = new Set((await q.all(db, 'SELECT student_id FROM enrollments WHERE course_id = ?', course.id)).map((r) => r.student_id));
  const stmts = [];
  for (const n of notes) {
    if (!enrolled.has(n.sid)) continue;
    stmts.push(n.note || n.hw || n.achieve
      ? db.prepare('INSERT INTO class_log_notes (log_id, student_id, note, hw, achieve) VALUES (?, ?, ?, ?, ?) ON CONFLICT (log_id, student_id) DO UPDATE SET note = excluded.note, hw = excluded.hw, achieve = excluded.achieve').bind(log.id, n.sid, n.note, n.hw, n.achieve)
      : db.prepare('DELETE FROM class_log_notes WHERE log_id = ? AND student_id = ?').bind(log.id, n.sid));
  }
  // 진도: 이 일지에서 체크한 단원을 "완료"로, 체크를 푼 단원은 되돌림
  if (Array.isArray(body.unit_ids)) {
    stmts.push(db.prepare('UPDATE course_units SET done_date = NULL, done_log_id = NULL WHERE course_id = ? AND done_log_id = ?').bind(course.id, log.id));
    for (const uid of unitIds) stmts.push(db.prepare('UPDATE course_units SET done_date = ?, done_log_id = ? WHERE id = ? AND course_id = ? AND (done_log_id IS NULL OR done_log_id = ?)').bind(date, log.id, uid, course.id, log.id));
  }
  if (stmts.length) await db.batch(stmts);
  return { ok: true, id: log.id };
});

// ───────── 영단어 시험 채점 ─────────
const WORD_PHOTO_MAX = 900 * 1024;
function wordBooks(s) { try { const a = JSON.parse(s.word_books); return Array.isArray(a) ? a.filter((b) => b && b.name) : []; } catch { return []; } }
// 시험 유형별 통과 기준(고정): 한글뜻 90%, 스펠링 80%, 혼합 90%
const WORD_KINDS = { 한글뜻: 90, 스펠링: 80, 혼합: 90 };
const WORD_ROUNDS = 4;
const wordLabel = (t) => [t.round ? `${t.round}회독` : '', t.kind || ''].filter(Boolean).join(' · ');
const attemptLabel = (n) => (n <= 1 ? '본시험' : `재시험${n > 2 ? ' ' + (n - 1) + '차' : ''}`);
const wordPublic = (t) => ({ id: t.id, student_id: t.student_id, course_id: t.course_id, teacher_id: t.teacher_id, date: t.date, book: t.book, range: t.range, total: t.total, score: t.score, pass_score: t.pass_score, passed: !!t.passed, attempt: t.attempt, round: t.round, kind: t.kind, parent_id: t.parent_id, memo: t.memo, photo_v: t.photo_v, sent_at: t.sent_at, teacher_name: t.teacher_name, student_name: t.student_name });

// 채점 화면: 반 학생 + 그날 시험 결과
route('GET', '/api/word/class', async ({ db, user, query }) => {
  const course = await mustSeeCourse(db, user, Number(query.course_id));
  const date = isDate(query.date) ? query.date : today();
  const students = await q.all(db, `SELECT s.id, s.name, s.school, s.grade, s.photo_v, s.student_phone FROM enrollments e JOIN students s ON s.id = e.student_id WHERE e.course_id = ? AND s.status = '재원' ORDER BY s.name`, course.id);
  const tests = await q.all(db, `SELECT w.*, u.name AS teacher_name FROM word_tests w LEFT JOIN users u ON u.id = w.teacher_id WHERE w.course_id = ? AND w.date = ? ORDER BY w.attempt, w.id`, course.id, date);
  // 아직 통과 못 한 지난 시험 (재시험 대기)
  const pending = await q.all(db, `SELECT w.* FROM word_tests w WHERE w.course_id = ? AND w.date < ? AND w.date >= ? AND w.passed = 0
      AND NOT EXISTS (SELECT 1 FROM word_tests x WHERE x.parent_id = IFNULL(w.parent_id, w.id) AND x.attempt > w.attempt)
      ORDER BY w.date DESC`, course.id, date, addDays(date, -30));
  const settings = await getSettings(db);
  const units = await q.all(db, 'SELECT book, title FROM course_units WHERE course_id = ? ORDER BY seq, id', course.id);
  const last = await q.first(db, 'SELECT book, range, total, round, kind FROM word_tests WHERE course_id = ? ORDER BY id DESC LIMIT 1', course.id);
  return {
    course, date, units, last,
    students: students.map((s) => ({ id: s.id, name: s.name, school: s.school, grade: s.grade, photo_v: s.photo_v, has_phone: !!s.student_phone })),
    tests: tests.map(wordPublic), pending: pending.map(wordPublic),
    pass_pct: Number(settings.word_pass_pct) || 90, word_kinds: WORD_KINDS, word_rounds: WORD_ROUNDS, word_books: wordBooks(settings), teacher_has_phone: !!(await q.first(db, 'SELECT phone FROM users WHERE id = ?', course.teacher_id || user.id) || {}).phone,
  };
});

// 시험 결과 저장 (+ 사진) → 학생·담당 선생님께 문자
route('POST', '/api/word/tests', async ({ db, env, user, body, url }) => {
  const sid = Number(body.student_id);
  const s = await mustSeeStudent(db, user, sid);
  const course = body.course_id ? await mustSeeCourse(db, user, Number(body.course_id)) : null;
  const total = Math.trunc(Number(body.total) || 0), score = Math.trunc(Number(body.score));
  if (total < 1 || total > 500) fail(400, '문항 수를 입력해 주세요');
  if (!(score >= 0 && score <= total)) fail(400, '맞은 개수가 문항 수보다 많아요');
  const settings = await getSettings(db);
  let kind = WORD_KINDS[body.kind] ? body.kind : null;
  let round = Math.trunc(Number(body.round)) || null;
  if (round && (round < 1 || round > WORD_ROUNDS)) round = null;
  let attempt = 1, parentId = null;
  if (body.retest_of) {
    const prev = await q.first(db, 'SELECT * FROM word_tests WHERE id = ?', Number(body.retest_of));
    if (!prev || prev.student_id !== sid) fail(400, '재시험할 시험을 찾을 수 없어요');
    parentId = prev.parent_id || prev.id;
    attempt = (await q.first(db, 'SELECT MAX(attempt) AS m FROM word_tests WHERE id = ? OR parent_id = ?', parentId, parentId)).m + 1;
    // 재시험은 본시험과 같은 회독·유형으로
    kind = kind || prev.kind; round = round || prev.round;
  }
  // 유형이 정해지면 통과 기준은 고정 (한글뜻 90%, 스펠링 80%, 혼합 90%)
  const pass = kind ? Math.ceil((total * WORD_KINDS[kind]) / 100)
    : body.pass_score != null && body.pass_score !== '' ? Math.trunc(Number(body.pass_score)) : Math.ceil((total * (Number(settings.word_pass_pct) || 90)) / 100);
  let photo = null;
  if (body.photo) {
    photo = String(body.photo);
    if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photo)) fail(400, '사진 파일만 올릴 수 있어요');
    if (photo.length > WORD_PHOTO_MAX) fail(400, '사진이 너무 커요');
  }
  const token = newToken().slice(0, 24);
  const date = isDate(body.date) ? body.date : today();
  const r = await q.run(db, `INSERT INTO word_tests (student_id, course_id, teacher_id, date, book, range, total, score, pass_score, passed, attempt, parent_id, memo, photo, photo_v, token, round, kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    sid, course ? course.id : null, user.id, date, clean(body.book), clean(body.range), total, score, pass, score >= pass ? 1 : 0, attempt, parentId, clean(body.memo), photo, photo ? Date.now() : null, token, round, kind);
  const id = r.meta.last_row_id;
  // 보내기: 학생 + 담당 선생님 (사진이 있거나 보내기를 골랐을 때)
  let sent = [];
  if (body.send !== false) {
    const link = `${url.origin}/w/${token}`;
    const text = fillTemplate(settings.tpl_word, { 학원: settings.academy_name, 학생: s.name, 차수: attemptLabel(attempt), 교재: clean(body.book) || '', 범위: [clean(body.range), wordLabel({ round, kind })].filter(Boolean).join(' · '), 점수: `${score}/${total}`, 결과: score >= pass ? '통과' : `불통 · 통과 기준 ${pass}개`, 링크: link });
    const tchId = course && course.teacher_id ? course.teacher_id : user.id;
    const tch = await q.first(db, 'SELECT name, phone FROM users WHERE id = ?', tchId);
    const msgs = [];
    if (s.student_phone) msgs.push({ kind: '단어시험', student_id: sid, to: s.student_phone, text, ref_type: 'word', ref_id: id });
    if (tch && tch.phone) msgs.push({ kind: '단어시험', student_id: sid, to: phone(tch.phone), text: `[담당 선생님용] ${text}`, ref_type: 'word', ref_id: id });
    if (msgs.length) {
      const res = await sendMessages(env, db, settings, user.id, msgs);
      sent = msgs.map((m, i) => ({ to: m === msgs[0] && s.student_phone ? '학생' : '선생님', status: res[i].status, error: res[i].error }));
      await q.run(db, `UPDATE word_tests SET sent_at = datetime('now') WHERE id = ?`, id);
    }
  }
  return { ok: true, id, passed: score >= pass, pass_score: pass, attempt, sent };
});

route('PATCH', '/api/word/tests/:id', async ({ db, user, body, params }) => {
  const t = await q.first(db, 'SELECT * FROM word_tests WHERE id = ?', Number(params.id));
  if (!t) fail(404, '시험을 찾을 수 없어요');
  await mustSeeStudent(db, user, t.student_id);
  if (!seesAll(user) && t.teacher_id !== user.id) fail(403, '내가 기록한 시험만 고칠 수 있어요');
  const total = 'total' in body ? Math.trunc(Number(body.total) || 0) : t.total;
  const score = 'score' in body ? Math.trunc(Number(body.score)) : t.score;
  if (total < 1 || !(score >= 0 && score <= total)) fail(400, '점수를 확인해 주세요');
  const pass = t.kind && WORD_KINDS[t.kind] ? Math.ceil((total * WORD_KINDS[t.kind]) / 100) : 'pass_score' in body ? Math.trunc(Number(body.pass_score)) : t.pass_score;
  let photo = t.photo, pv = t.photo_v;
  if (body.photo) {
    if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(String(body.photo)) || String(body.photo).length > WORD_PHOTO_MAX) fail(400, '사진을 확인해 주세요');
    photo = String(body.photo); pv = Date.now();
  }
  await q.run(db, 'UPDATE word_tests SET total = ?, score = ?, pass_score = ?, passed = ?, book = ?, range = ?, memo = ?, photo = ?, photo_v = ? WHERE id = ?',
    total, score, pass, score >= pass ? 1 : 0, 'book' in body ? clean(body.book) : t.book, 'range' in body ? clean(body.range) : t.range, 'memo' in body ? clean(body.memo) : t.memo, photo, pv, t.id);
  return { ok: true };
});
route('DELETE', '/api/word/tests/:id', async ({ db, user, params }) => {
  const t = await q.first(db, 'SELECT * FROM word_tests WHERE id = ?', Number(params.id));
  if (!t) fail(404, '시험을 찾을 수 없어요');
  if (!seesAll(user) && t.teacher_id !== user.id) fail(403, '내가 기록한 시험만 지울 수 있어요');
  await q.run(db, 'DELETE FROM word_tests WHERE id = ?', t.id);
  return { ok: true };
});
route('GET', '/api/word/photos/:id', async ({ db, user, params }) => {
  const t = await q.first(db, 'SELECT student_id, photo FROM word_tests WHERE id = ?', Number(params.id));
  if (!t || !t.photo) fail(404, '사진이 없어요');
  if (!(await canSeeStudent(db, user, t.student_id))) fail(403, '볼 수 없는 사진이에요');
  return photoResponse(t.photo);
});
// 학생별 단어시험 기록
route('GET', '/api/word/student/:id', async ({ db, user, params }) => {
  const sid = Number(params.id);
  await mustSeeStudent(db, user, sid);
  const tests = await q.all(db, `SELECT w.*, u.name AS teacher_name, c.name AS course_name FROM word_tests w LEFT JOIN users u ON u.id = w.teacher_id LEFT JOIN courses c ON c.id = w.course_id WHERE w.student_id = ? ORDER BY w.date DESC, w.id DESC LIMIT 200`, sid);
  return { tests: tests.map((t) => ({ ...wordPublic(t), course_name: t.course_name })) };
});

// 링크로 여는 시험지 (로그인 없이, 링크를 받은 사람만)
async function wordSheetPage(db, token, wantPhoto) {
  const t = await q.first(db, 'SELECT w.*, s.name AS student_name FROM word_tests w JOIN students s ON s.id = w.student_id WHERE w.token = ?', token);
  if (!t) return new Response('시험지를 찾을 수 없어요', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  if (wantPhoto) return t.photo ? photoResponse(t.photo) : new Response('사진 없음', { status: 404 });
  const settings = await getSettings(db);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const html = `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(t.student_name)} 단어시험</title>
<style>body{margin:0;font-family:-apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;background:#f7f9f2;color:#1f330a}.w{max-width:560px;margin:0 auto;padding:18px}.c{background:#fff;border-radius:16px;padding:18px;box-shadow:0 2px 10px rgba(0,0,0,.06);margin-bottom:12px}h1{font-size:20px;margin:0 0 4px}.m{color:#6b7a5c;font-size:14px}.s{font-size:40px;font-weight:800;margin:10px 0}.p{display:inline-block;padding:4px 12px;border-radius:99px;font-weight:700}.ok{background:#8dc63f}.no{background:#fdeeec;color:#c8443c}img{width:100%;border-radius:12px;display:block}</style></head>
<body><div class="w"><div class="c"><div class="m">${esc(settings.academy_name)} · ${esc(t.date)}</div><h1>${esc(t.student_name)} 단어시험 ${esc(attemptLabel(t.attempt))}</h1><div class="m">${esc(t.book || '')} ${esc(t.range || '')}${wordLabel(t) ? ' · ' + esc(wordLabel(t)) : ''}</div>
<div class="s">${t.score} / ${t.total}</div><span class="p ${t.passed ? 'ok' : 'no'}">${t.passed ? '통과' : '불통 · 통과 기준 ' + t.pass_score + '개'}</span>${t.memo ? `<p>${esc(t.memo)}</p>` : ''}</div>
${t.photo ? `<div class="c"><img src="/w/${esc(token)}/photo" alt="시험지"></div>` : ''}</div></body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex' } });
}

// ───────── 진도표 ─────────
async function mustEditCourse(db, user, courseId) {
  const c = await mustSeeCourse(db, user, courseId);
  return c; // 원장·감독은 모든 반, 강사는 자기 반
}
route('GET', '/api/progress', async ({ db, user }) => {
  const where = seesAll(user) ? '' : 'AND c.teacher_id = ?';
  const params = seesAll(user) ? [] : [user.id];
  const rows = await q.all(db, `SELECT c.id, c.name, c.subject, c.teacher_id, u.name AS teacher_name, u.photo_v AS teacher_photo_v,
      (SELECT COUNT(*) FROM course_units x WHERE x.course_id = c.id) AS total,
      (SELECT COUNT(*) FROM course_units x WHERE x.course_id = c.id AND x.done_date IS NOT NULL) AS done,
      (SELECT COUNT(*) FROM course_units x WHERE x.course_id = c.id AND x.done_date IS NULL AND x.planned_date IS NOT NULL AND x.planned_date < ?) AS late,
      (SELECT title FROM course_units x WHERE x.course_id = c.id AND x.done_date IS NULL ORDER BY seq, id LIMIT 1) AS next_unit,
      (SELECT MAX(date) FROM class_logs l WHERE l.course_id = c.id) AS last_log
     FROM courses c LEFT JOIN users u ON u.id = c.teacher_id WHERE c.active = 1 ${where} ORDER BY c.subject, c.name`, today(), ...params);
  return { courses: rows };
});
route('GET', '/api/courses/:id/units', async ({ db, user, params }) => {
  const course = await mustSeeCourse(db, user, Number(params.id));
  const units = await q.all(db, 'SELECT * FROM course_units WHERE course_id = ? ORDER BY seq, id', course.id);
  return { course, units };
});
// 진도표 통째로 저장: [{id?, title, planned_date}] 순서대로. 이미 완료된 단원 기록은 지켜요.
route('PUT', '/api/courses/:id/units', async ({ db, user, body, params }) => {
  const course = await mustEditCourse(db, user, Number(params.id));
  const list = (body.units || []).map((u) => ({ id: Number(u.id) || null, book: clean(u.book), title: clean(u.title), planned_date: isDate(u.planned_date) ? u.planned_date : null })).filter((u) => u.title);
  if (list.length > 300) fail(400, '단원은 300개까지 넣을 수 있어요');
  const existing = new Set((await q.all(db, 'SELECT id FROM course_units WHERE course_id = ?', course.id)).map((r) => r.id));
  const keep = new Set(list.filter((u) => u.id && existing.has(u.id)).map((u) => u.id));
  const stmts = [...existing].filter((id) => !keep.has(id)).map((id) => db.prepare('DELETE FROM course_units WHERE id = ?').bind(id));
  list.forEach((u, i) => stmts.push(u.id && existing.has(u.id)
    ? db.prepare('UPDATE course_units SET seq = ?, book = ?, title = ?, planned_date = ? WHERE id = ?').bind(i, u.book, u.title, u.planned_date, u.id)
    : db.prepare('INSERT INTO course_units (course_id, seq, book, title, planned_date) VALUES (?, ?, ?, ?, ?)').bind(course.id, i, u.book, u.title, u.planned_date)));
  if (stmts.length) await db.batch(stmts);
  return { ok: true, count: list.length };
});
// 진도표 엑셀로 한꺼번에 올리기: rows = [{course, book, title, planned_date}]
// mode: 'add'(뒤에 이어 붙이기, 같은 단원은 건너뛰기) | 'replace'(아직 안 나간 단원을 새 것으로 바꾸기, 나간 단원 기록은 지킴)
function unitDate(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})[-./년\s]+(\d{1,2})[-./월\s]+(\d{1,2})/);
  if (m) {
    const z = (n) => String(n).padStart(2, '0');
    const d = `${m[1]}-${z(m[2])}-${z(m[3])}`;
    return isDate(d) && Number(m[2]) <= 12 && Number(m[3]) <= 31 ? d : null;
  }
  return null;
}
const normName = (s) => String(s ?? '').replace(/\s+/g, '').toLowerCase();
route('POST', '/api/units/import', async ({ db, user, body }) => {
  const rows = Array.isArray(body.rows) ? body.rows.slice(0, 3000) : [];
  const mode = body.mode === 'replace' ? 'replace' : 'add';
  const defaultId = Number(body.default_course_id) || null;
  const where = seesAll(user) ? '' : 'AND teacher_id = ?';
  const courses = await q.all(db, `SELECT id, name, subject FROM courses WHERE active = 1 ${where} ORDER BY subject, name`, ...(seesAll(user) ? [] : [user.id]));
  const byName = new Map(courses.map((c) => [normName(c.name), c]));
  const byId = new Map(courses.map((c) => [c.id, c]));
  if (defaultId && !byId.has(defaultId)) fail(403, '담당 반이 아니에요');
  const groups = new Map();
  const unknown = new Map();
  let noTitle = 0, badDate = 0;
  for (const r of rows) {
    const title = clean(r.title);
    const cname = clean(r.course);
    if (!title) { if (cname || clean(r.book)) noTitle++; continue; }
    const c = cname ? byName.get(normName(cname)) : byId.get(defaultId);
    if (!c) { const k = cname || '(반 이름 없음)'; unknown.set(k, (unknown.get(k) || 0) + 1); continue; }
    const pd = unitDate(r.planned_date);
    if (clean(r.planned_date) && !pd) badDate++;
    if (!groups.has(c.id)) groups.set(c.id, { course: c, list: [] });
    groups.get(c.id).list.push({ book: clean(r.book), title: title.slice(0, 200), planned_date: pd });
  }
  const result = [];
  const stmts = [];
  for (const { course, list } of groups.values()) {
    const existing = await q.all(db, 'SELECT id, seq, book, title, done_date FROM course_units WHERE course_id = ? ORDER BY seq, id', course.id);
    const kept = mode === 'replace' ? existing.filter((u) => u.done_date) : existing;
    const seen = new Set(kept.map((u) => `${u.book || ''}|${u.title}`));
    const add = [];
    let dup = 0;
    for (const u of list) {
      const k = `${u.book || ''}|${u.title}`;
      if (seen.has(k)) { dup++; continue; }
      seen.add(k);
      add.push(u);
    }
    if (kept.length + add.length > 300) fail(400, `${course.name}: 단원은 반마다 300개까지 넣을 수 있어요`);
    const removed = mode === 'replace' ? existing.length - kept.length : 0;
    result.push({ course_id: course.id, name: course.name, subject: course.subject, before: existing.length, add: add.length, dup, removed, sample: add.slice(0, 5) });
    if (!body.preview) {
      if (mode === 'replace') stmts.push(db.prepare('DELETE FROM course_units WHERE course_id = ? AND done_date IS NULL').bind(course.id));
      let seq = kept.reduce((m, u) => Math.max(m, u.seq || 0), 0);
      for (const u of add) stmts.push(db.prepare('INSERT INTO course_units (course_id, seq, book, title, planned_date) VALUES (?, ?, ?, ?, ?)').bind(course.id, ++seq, u.book, u.title, u.planned_date));
    }
  }
  if (!body.preview && stmts.length) {
    for (let i = 0; i < stmts.length; i += 90) await db.batch(stmts.slice(i, i + 90));
  }
  return {
    ok: true, preview: !!body.preview, mode,
    courses: result,
    unknown: [...unknown].map(([name, count]) => ({ name, count })),
    no_title: noTitle, bad_date: badDate,
    total: result.reduce((s, c) => s + c.add, 0),
    my_courses: courses.map((c) => c.name),
  };
});

// 일지 기타 항목: [{name, options: [..]}] (선택지가 없으면 글로 적는 칸)
function parseFields(raw) {
  try { const a = typeof raw === 'string' ? JSON.parse(raw) : raw; return Array.isArray(a) ? a : []; } catch { return []; }
}
route('PUT', '/api/courses/:id/log-fields', async ({ db, user, body, params }) => {
  const course = await mustEditCourse(db, user, Number(params.id));
  const fields = (body.fields || []).slice(0, 20).map((f) => ({
    name: clean(f.name),
    options: (Array.isArray(f.options) ? f.options : String(f.options || '').split(/[,，\/]/)).map((o) => String(o).trim()).filter(Boolean).slice(0, 12),
  })).filter((f) => f.name);
  await q.run(db, 'UPDATE courses SET log_fields = ? WHERE id = ?', JSON.stringify(fields), course.id);
  return { ok: true, count: fields.length };
});
// 다른 반 설정 복사 (교재·단원·기타 항목)
route('POST', '/api/courses/:id/copy-setup', async ({ db, user, body, params }) => {
  const course = await mustEditCourse(db, user, Number(params.id));
  const src = await mustSeeCourse(db, user, Number(body.from_course_id));
  const units = await q.all(db, 'SELECT * FROM course_units WHERE course_id = ? ORDER BY seq, id', src.id);
  const stmts = [db.prepare('DELETE FROM course_units WHERE course_id = ? AND done_date IS NULL').bind(course.id)];
  units.forEach((u, i) => stmts.push(db.prepare('INSERT INTO course_units (course_id, seq, book, title, planned_date) VALUES (?, ?, ?, ?, ?)').bind(course.id, 1000 + i, u.book, u.title, u.planned_date)));
  stmts.push(db.prepare('UPDATE courses SET log_fields = ? WHERE id = ?').bind(src.log_fields, course.id));
  await db.batch(stmts);
  return { ok: true, units: units.length };
});

route('PATCH', '/api/units/:id', async ({ db, user, body, params }) => {
  const u = await q.first(db, 'SELECT * FROM course_units WHERE id = ?', Number(params.id));
  if (!u) fail(404, '단원을 찾을 수 없어요');
  await mustEditCourse(db, user, u.course_id);
  const done = body.done ? (isDate(body.done_date) ? body.done_date : today()) : null;
  await q.run(db, 'UPDATE course_units SET done_date = ?, done_log_id = NULL WHERE id = ?', done, u.id);
  return { ok: true };
});

// ───────── 수업 일지 모아 보기 / 안 쓴 일지 ─────────
function nowKST() {
  const d = new Date(Date.now() + 9 * 3600e3);
  return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16) };
}
const plusMin = (hhmm, m) => {
  const [h, mi] = String(hhmm).split(':').map(Number);
  const t = h * 60 + mi + m;
  return t >= 24 * 60 ? '23:59' : `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};
function remindSettings(s) {
  try { return { on: true, after_min: 60, sms: true, start_date: '', ...JSON.parse(s.log_remind || '{}') }; } catch { return { on: true, after_min: 60, sms: true, start_date: '' }; }
}
// UTC로 저장된 시각 → 한국 날짜
const kstDate = (utc) => (utc ? new Date(new Date(String(utc).replace(' ', 'T') + 'Z').getTime() + 9 * 3600e3).toISOString().slice(0, 10) : '0000-00-00');
// from~to 사이에 수업이 있었는데 일지가 없는 반 (오늘은 수업이 끝나고 after_min 분이 지난 것만)
async function missingLogs(db, { from, to, teacherId = null, courseId = null, afterMin = 0, startDate = '' }) {
  const now = nowKST();
  if (to > now.date) to = now.date;
  if (startDate && from < startDate) from = startDate; // 원장님이 정한 "이 날짜부터 확인"
  if (from > to) return [];
  const courses = await q.all(db, `SELECT c.id, c.name, c.subject, c.days, c.times, c.start_time, c.end_time, c.teacher_id, c.created_at, u.name AS teacher_name, u.phone AS teacher_phone, u.photo_v AS teacher_photo_v
    FROM courses c LEFT JOIN users u ON u.id = c.teacher_id WHERE c.active = 1 ${teacherId ? 'AND c.teacher_id = ?' : ''} ${courseId ? 'AND c.id = ?' : ''}`, ...[teacherId, courseId].filter(Boolean));
  if (!courses.length) return [];
  const have = new Set((await q.all(db, 'SELECT course_id, date FROM class_logs WHERE date BETWEEN ? AND ?', from, to)).map((r) => `${r.course_id}|${r.date}`));
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const wd = weekdayOf(d);
    for (const c of courses) {
      if (!(',' + (c.days || '') + ',').includes(',' + wd + ',')) continue;
      if (d < kstDate(c.created_at)) continue; // 반을 만들기 전 수업은 세지 않아요
      if (have.has(`${c.id}|${d}`)) continue;
      const t = timeOn(c, wd);
      if (d === now.date) {
        const endAt = t.end || t.start;
        if (!endAt || plusMin(endAt, afterMin) > now.time) continue;
      }
      out.push({ course_id: c.id, course_name: c.name, subject: c.subject, date: d, start: t.start, end: t.end, teacher_id: c.teacher_id, teacher_name: c.teacher_name, teacher_photo_v: c.teacher_photo_v, teacher_phone: c.teacher_phone });
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || (a.start || '').localeCompare(b.start || ''));
}

route('GET', '/api/logs', async ({ db, user, query }) => {
  const to = isDate(query.to) ? query.to : today();
  let from = isDate(query.from) ? query.from : addDays(to, -6);
  if (diffDays(to, from) > 62) from = addDays(to, -62);
  const params = [from, to];
  let extra = '';
  if (!seesAll(user)) (extra += ' AND c.teacher_id = ?'), params.push(user.id);
  else if (query.teacher_id) (extra += ' AND c.teacher_id = ?'), params.push(Number(query.teacher_id));
  if (query.course_id) (extra += ' AND c.id = ?'), params.push(Number(query.course_id));
  const logs = await q.all(db, `SELECT l.*, c.name AS course_name, c.subject, u.name AS teacher_name, u.photo_v AS teacher_photo_v,
      (SELECT COUNT(*) FROM enrollments e JOIN students s ON s.id = e.student_id WHERE e.course_id = c.id AND s.status = '재원') AS student_count,
      (SELECT COUNT(*) FROM attendance a WHERE a.course_id = c.id AND a.date = l.date AND a.status IN ('출석','지각','조퇴')) AS present,
      (SELECT COUNT(*) FROM attendance a WHERE a.course_id = c.id AND a.date = l.date AND a.status = '결석') AS absent,
      (SELECT COUNT(*) FROM class_log_notes n WHERE n.log_id = l.id AND n.hw = '○') AS hw_o,
      (SELECT COUNT(*) FROM class_log_notes n WHERE n.log_id = l.id AND n.hw = '△') AS hw_p,
      (SELECT COUNT(*) FROM class_log_notes n WHERE n.log_id = l.id AND n.hw = '×') AS hw_x,
      (SELECT COUNT(*) FROM class_log_notes n WHERE n.log_id = l.id AND n.achieve = '상') AS ach_h,
      (SELECT COUNT(*) FROM class_log_notes n WHERE n.log_id = l.id AND n.achieve = '중') AS ach_m,
      (SELECT COUNT(*) FROM class_log_notes n WHERE n.log_id = l.id AND n.achieve = '하') AS ach_l,
      (SELECT group_concat(x.title, ', ') FROM course_units x WHERE x.done_log_id = l.id) AS units,
      (SELECT COUNT(DISTINCT w.student_id) FROM word_tests w WHERE w.course_id = c.id AND w.date = l.date AND w.attempt = 1) AS word_n,
      (SELECT COUNT(DISTINCT w.student_id) FROM word_tests w WHERE w.course_id = c.id AND w.date = l.date AND w.passed = 1) AS word_pass
     FROM class_logs l JOIN courses c ON c.id = l.course_id LEFT JOIN users u ON u.id = l.teacher_id
     WHERE l.date BETWEEN ? AND ? ${extra} ORDER BY l.date DESC, c.name`, ...params);
  const missing = await missingLogs(db, { from, to, startDate: remindSettings(await getSettings(db)).start_date, teacherId: !seesAll(user) ? user.id : query.teacher_id ? Number(query.teacher_id) : null, courseId: query.course_id ? Number(query.course_id) : null });
  for (const m of missing) delete m.teacher_phone;
  const teachers = seesAll(user) ? await q.all(db, `SELECT id, name FROM users WHERE role IN ('owner','teacher') AND active = 1 ORDER BY name`) : [];
  return { from, to, logs, missing, teachers };
});

// 일지 안 쓴 수업 → 선생님께 문자 (크론이 30분마다 부름)
async function runLogReminders(env) {
  const db = env.DB;
  await ensureSchema(db);
  const settings = await getSettings(db);
  const rs = remindSettings(settings);
  if (!rs.on || !rs.sms) return { sent: 0 };
  const now = nowKST();
  const list = await missingLogs(db, { from: now.date, to: now.date, startDate: rs.start_date, afterMin: Number(rs.after_min) || 0 });
  if (!list.length) return { sent: 0 };
  const done = new Set((await q.all(db, 'SELECT course_id FROM log_reminders WHERE date = ?', now.date)).map((r) => r.course_id));
  const todo = list.filter((m) => !done.has(m.course_id) && m.teacher_id);
  if (!todo.length) return { sent: 0 };
  const msgs = todo.map((m) => ({
    kind: '일지 알림', student_id: null, to: phone(m.teacher_phone), ref_type: 'course', ref_id: m.course_id,
    text: fillTemplate(settings.tpl_log_remind, { 학원: settings.academy_name, 선생님: m.teacher_name || '', 반: m.course_name, 시간: [m.start, m.end].filter(Boolean).join('~'), 날짜: prettyDate(m.date) }),
  }));
  await sendMessages(env, db, settings, null, msgs);
  await db.batch(todo.map((m) => db.prepare('INSERT OR IGNORE INTO log_reminders (course_id, date) VALUES (?, ?)').bind(m.course_id, m.date)));
  return { sent: todo.length };
}
// 원장님이 바로 확인해 볼 수 있게
route('POST', '/api/logs/remind-now', async ({ env }) => runLogReminders(env), OWNER);

// ───────── 피드백 기간 ─────────

function periodCard(p, unsent, total, now) {
  const subjects = p.subjects.split(',');
  if (now < p.start_date) return { ...p, subjects, unsent, total, phase: 'upcoming', badge: '시작', dday: `D-${diffDays(p.start_date, now)}` };
  if (now <= p.end_date) {
    const left = diffDays(p.end_date, now);
    return { ...p, subjects, unsent, total, phase: 'open', badge: '마감', dday: left === 0 ? 'D-DAY' : `D-${left}` };
  }
  return { ...p, subjects, unsent, total, phase: unsent > 0 ? 'overdue' : 'done', badge: unsent > 0 ? '마감 지남' : '완료', dday: `D+${diffDays(now, p.end_date)}` };
}

async function periodCounts(db, user, p) {
  const params = [p.id, p.subjects];
  let mine = '';
  if (!seesAll(user)) (mine = 'AND c.teacher_id = ?'), params.push(user.id);
  const r = await q.first(
    db,
    `SELECT COUNT(*) AS total, SUM(CASE WHEN f.status = '발송완료' THEN 0 ELSE 1 END) AS unsent
     FROM enrollments e JOIN courses c ON c.id = e.course_id JOIN students s ON s.id = e.student_id
     LEFT JOIN feedbacks f ON f.period_id = ? AND f.course_id = c.id AND f.student_id = s.id
     WHERE c.active = 1 AND s.status = '재원' AND instr(',' || ? || ',', ',' || c.subject || ',') > 0 ${mine}`,
    ...params
  );
  return { total: r.total || 0, unsent: r.unsent || 0 };
}

route('GET', '/api/periods', async ({ db, user }) => {
  const now = today();
  const periods = await q.all(db, 'SELECT * FROM feedback_periods ORDER BY start_date DESC LIMIT 30');
  const out = [];
  for (const p of periods) {
    const c = await periodCounts(db, user, p);
    out.push(periodCard(p, c.unsent, c.total, now));
  }
  return { periods: out, subjects: SUBJECTS };
});

function periodValues(body) {
  const title = need(body.title, '기간 이름');
  const subjects = (Array.isArray(body.subjects) ? body.subjects : String(body.subjects || '').split(',')).map((s) => s.trim()).filter((s) => SUBJECTS.includes(s));
  if (!subjects.length) fail(400, '과목을 하나 이상 골라 주세요');
  if (!isDate(body.start_date) || !isDate(body.end_date)) fail(400, '시작일과 마감일을 골라 주세요');
  if (body.start_date > body.end_date) fail(400, '마감일이 시작일보다 빨라요');
  return [title, subjects.join(','), body.start_date, body.end_date];
}

route('POST', '/api/periods', async ({ db, body }) => {
  const r = await q.run(db, 'INSERT INTO feedback_periods (title, subjects, start_date, end_date) VALUES (?, ?, ?, ?)', ...periodValues(body));
  return { ok: true, id: r.meta.last_row_id };
}, OWNER);

route('PATCH', '/api/periods/:id', async ({ db, body, params }) => {
  await q.run(db, 'UPDATE feedback_periods SET title = ?, subjects = ?, start_date = ?, end_date = ? WHERE id = ?', ...periodValues(body), Number(params.id));
  return { ok: true };
}, OWNER);

route('DELETE', '/api/periods/:id', async ({ db, params }) => {
  const id = Number(params.id);
  const used = await q.first(db, `SELECT COUNT(*) AS n FROM feedbacks WHERE period_id = ? AND content != ''`, id);
  if (used.n > 0) fail(400, '이미 작성된 피드백이 있어서 지울 수 없어요');
  await db.batch([db.prepare('DELETE FROM feedbacks WHERE period_id = ?').bind(id), db.prepare('DELETE FROM feedback_periods WHERE id = ?').bind(id)]);
  return { ok: true };
}, OWNER);

// ───────── 피드백 작성 / 발송 ─────────

function feedbackText(settings, row, teacherName) {
  return fillTemplate(settings.tpl_feedback, {
    학원: settings.academy_name,
    학생: row.student_name,
    과목: row.subject,
    반: row.course_name,
    내용: row.content || '',
    선생님: teacherName || '',
  });
}

route('GET', '/api/feedbacks', async ({ db, user, query }) => {
  const period = await q.first(db, 'SELECT * FROM feedback_periods WHERE id = ?', Number(query.period_id));
  if (!period) fail(404, '피드백 기간을 찾을 수 없어요');
  const params = [period.id, period.subjects];
  let mine = '';
  if (!seesAll(user)) (mine = 'AND c.teacher_id = ?'), params.push(user.id);
  const rows = await q.all(
    db,
    `SELECT c.id AS course_id, c.name AS course_name, c.subject, u.name AS teacher_name,
            s.id AS student_id, s.name AS student_name, s.school, s.grade, s.photo_v, ${PHONES},
            f.id AS feedback_id, IFNULL(f.content, '') AS content, IFNULL(f.status, '미작성') AS status, f.sent_at, f.updated_at
     FROM enrollments e JOIN courses c ON c.id = e.course_id JOIN students s ON s.id = e.student_id
     LEFT JOIN users u ON u.id = c.teacher_id
     LEFT JOIN feedbacks f ON f.period_id = ? AND f.course_id = c.id AND f.student_id = s.id
     WHERE c.active = 1 AND s.status = '재원' AND instr(',' || ? || ',', ',' || c.subject || ',') > 0 ${mine}
     ORDER BY c.subject, c.name, s.name`,
    ...params
  );
  const settings = await getSettings(db);
  for (const r of rows) {
    r.preview = feedbackText(settings, r, r.teacher_name);
    r.has_phone = recipients(r).length > 0;
    delete r.father_phone, delete r.mother_phone, delete r.sms_target;
  }
  return { period: periodCard(period, rows.filter((r) => r.status !== '발송완료').length, rows.length, today()), rows };
});

route('PUT', '/api/feedbacks', async ({ db, user, body }) => {
  const period = await q.first(db, 'SELECT * FROM feedback_periods WHERE id = ?', Number(body.period_id));
  if (!period) fail(404, '피드백 기간을 찾을 수 없어요');
  const course = await mustSeeCourse(db, user, Number(body.course_id));
  const sid = Number(body.student_id);
  const enrolled = await q.first(db, 'SELECT 1 AS ok FROM enrollments WHERE course_id = ? AND student_id = ?', course.id, sid);
  if (!enrolled) fail(400, '이 반 학생이 아니에요');
  const content = String(body.content ?? '').trim();
  await q.run(
    db,
    `INSERT INTO feedbacks (period_id, course_id, student_id, teacher_id, content, status, updated_at) VALUES (?, ?, ?, ?, ?, '작성중', datetime('now'))
     ON CONFLICT (period_id, course_id, student_id) DO UPDATE SET content = excluded.content, teacher_id = excluded.teacher_id, updated_at = excluded.updated_at`,
    period.id,
    course.id,
    sid,
    user.id,
    content
  );
  const f = await q.first(db, 'SELECT id, status, updated_at FROM feedbacks WHERE period_id = ? AND course_id = ? AND student_id = ?', period.id, course.id, sid);
  const st = await q.first(db, 'SELECT name FROM students WHERE id = ?', sid);
  const preview = feedbackText(await getSettings(db), { student_name: st.name, subject: course.subject, course_name: course.name, content }, course.teacher_name);
  return { ok: true, feedback: f, preview };
});

route('POST', '/api/feedbacks/send', async ({ db, env, user, body }) => {
  const ids = [...new Set((body.feedback_ids || []).map(Number).filter(Boolean))];
  if (!ids.length) fail(400, '보낼 피드백을 골라 주세요');
  if (ids.length > 200) fail(400, '한 번에 200건까지 보낼 수 있어요');
  const rows = await q.all(
    db,
    `SELECT f.id, f.content, f.course_id, f.student_id, c.name AS course_name, c.subject, c.teacher_id, u.name AS teacher_name,
            s.name AS student_name, ${PHONES}
     FROM feedbacks f JOIN courses c ON c.id = f.course_id JOIN students s ON s.id = f.student_id LEFT JOIN users u ON u.id = c.teacher_id
     WHERE f.id IN (${ids.map(() => '?').join(',')})`,
    ...ids
  );
  const allowed = rows.filter((r) => (seesAll(user) || r.teacher_id === user.id) && r.content.trim());
  if (!allowed.length) fail(400, '보낼 수 있는 피드백이 없어요 (내용이 비어 있거나 담당 반이 아니에요)');
  const settings = await getSettings(db);
  const msgs = allowed.flatMap((r) => messagesFor({ ...r, id: r.student_id }, { kind: '피드백', text: feedbackText(settings, r, r.teacher_name), ref_type: 'feedback', ref_id: r.id }));
  const results = await sendMessages(env, db, settings, user.id, msgs);
  const okFb = new Set(msgs.filter((m, i) => results[i].status !== '실패').map((m) => m.ref_id));
  const ok = allowed.filter((r) => okFb.has(r.id));
  if (ok.length) await db.batch(ok.map((r) => db.prepare(`UPDATE feedbacks SET status = '발송완료', sent_at = datetime('now') WHERE id = ?`).bind(r.id)));
  return {
    ok: true,
    sent: ok.length,
    failed: allowed.length - ok.length,
    skipped: ids.length - allowed.length,
    mode: results.some((r) => r.status === '발송') ? 'real' : 'preview',
    results: msgs.map((m, i) => ({ feedback_id: m.ref_id, student_id: m.student_id, ...results[i] })),
  };
});

// ───────── 발송 기록 ─────────

route('GET', '/api/messages', async ({ db, user, query }) => {
  const where = [];
  const params = [];
  if (user.role !== 'owner') where.push('m.sent_by = ?'), params.push(user.id);
  if (query.kind) where.push('m.kind = ?'), params.push(query.kind);
  if (query.status) where.push('m.status = ?'), params.push(query.status);
  if (query.q) where.push('s.name LIKE ?'), params.push(`%${query.q}%`);
  if (query.before) where.push('m.id < ?'), params.push(Number(query.before));
  const messages = await q.all(
    db,
    `SELECT m.*, s.name AS student_name, u.name AS sent_by_name
     FROM messages m LEFT JOIN students s ON s.id = m.student_id LEFT JOIN users u ON u.id = m.sent_by
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY m.id DESC LIMIT 100`,
    ...params
  );
  const view = await viewOf(db, user);
  if (!view.parents) for (const m of messages) m.to_phone = maskPhone(m.to_phone);
  return { messages };
});

// ───────── 이탈 신호 ─────────
// 최근 30일 출결과 원장·강사가 직접 표시한 신호를 모아서 "그만둘 수도 있는 학생" 을 보여 줍니다.

async function computeRisks(db, user) {
  const since = addDays(today(), -30);
  const sc = studentScope(user);
  const students = await q.all(db, `SELECT s.id, s.name, s.school, s.grade, s.photo_v FROM students s WHERE s.status = '재원' AND ${sc.sql}`, ...sc.params);
  if (!students.length) return [];
  const sc2 = studentScope(user, 'a.student_id');
  const att = await q.all(db, `SELECT a.student_id, a.date, a.status FROM attendance a WHERE a.date >= ? AND ${sc2.sql} ORDER BY a.date DESC, a.id DESC`, since, ...sc2.params);
  const sc3 = studentScope(user, 'r.student_id');
  const flags = await q.all(db, `SELECT r.*, u.name AS created_by_name FROM risk_flags r LEFT JOIN users u ON u.id = r.created_by WHERE r.resolved = 0 AND ${sc3.sql} ORDER BY r.created_at DESC`, ...sc3.params);
  const sc4 = studentScope(user, 'k.student_id');
  const lastConsult = new Map((await q.all(db, `SELECT k.student_id, MAX(k.date) AS last FROM consultations k WHERE ${sc4.sql} GROUP BY k.student_id`, ...sc4.params)).map((r) => [r.student_id, r.last]));

  const byStudent = new Map();
  for (const a of att) {
    if (!byStudent.has(a.student_id)) byStudent.set(a.student_id, []);
    byStudent.get(a.student_id).push(a);
  }
  const out = [];
  for (const s of students) {
    const list = byStudent.get(s.id) || [];
    const absent = list.filter((a) => a.status === '결석').length;
    const late = list.filter((a) => a.status === '지각' || a.status === '조퇴').length;
    const streak = list.length >= 2 && list[0].status === '결석' && list[1].status === '결석';
    const myFlags = flags.filter((f) => f.student_id === s.id);
    const reasons = [];
    if (streak) reasons.push('최근 2번 연속 결석');
    if (absent >= 2) reasons.push(`최근 30일 결석 ${absent}번`);
    if (late >= 3) reasons.push(`최근 30일 지각·조퇴 ${late}번`);
    for (const f of myFlags) reasons.push(`${f.reason} (${f.created_by_name || ''} 표시)`);
    if (!reasons.length) continue;
    const level = streak || absent >= 3 || myFlags.length ? '높음' : '주의';
    out.push({ ...s, absent, late, reasons, level, flags: myFlags, last_consult: lastConsult.get(s.id) || null });
  }
  out.sort((a, b) => (a.level === b.level ? b.absent - a.absent : a.level === '높음' ? -1 : 1));
  return out;
}

route('GET', '/api/risks', async ({ db, user }) => ({ risks: await computeRisks(db, user) }));

route('POST', '/api/risks', async ({ db, user, body }) => {
  const sid = Number(body.student_id);
  await mustSeeStudent(db, user, sid);
  const r = await q.run(db, 'INSERT INTO risk_flags (student_id, reason, created_by) VALUES (?, ?, ?)', sid, need(body.reason, '이유'), user.id);
  return { ok: true, id: r.meta.last_row_id };
});

route('PATCH', '/api/risks/:id', async ({ db, user, body, params }) => {
  const f = await q.first(db, 'SELECT * FROM risk_flags WHERE id = ?', Number(params.id));
  if (!f) fail(404, '표시를 찾을 수 없어요');
  await mustSeeStudent(db, user, f.student_id);
  await q.run(db, `UPDATE risk_flags SET resolved = 1, resolution = ?, resolved_at = datetime('now') WHERE id = ?`, clean(body.resolution), f.id);
  return { ok: true };
});

// ───────── 상담 정리 ─────────

const CONSULT_KINDS = ['학부모 상담', '학생 상담', '전화 상담', '등록 상담', '기타'];

route('GET', '/api/consultations', async ({ db, user, query }) => {
  const sc = studentScope(user, 'k.student_id');
  const where = [sc.sql];
  const params = [...sc.params];
  if (query.student_id) where.push('k.student_id = ?'), params.push(Number(query.student_id));
  if (query.subject) where.push('k.subject = ?'), params.push(query.subject);
  if (query.pending === '1') where.push(`k.follow_up IS NOT NULL AND k.follow_up != '' AND k.follow_up_done = 0`);
  if (query.q) where.push('(s.name LIKE ? OR k.content LIKE ?)'), params.push(`%${query.q}%`, `%${query.q}%`);
  const consultations = await q.all(
    db,
    `SELECT k.*, s.name AS student_name, s.school, s.grade, u.name AS teacher_name, u.photo_v AS teacher_photo_v
     FROM consultations k JOIN students s ON s.id = k.student_id LEFT JOIN users u ON u.id = k.teacher_id
     WHERE ${where.join(' AND ')}
     ORDER BY k.date DESC, k.id DESC LIMIT 200`,
    ...params
  );
  return { consultations, kinds: CONSULT_KINDS, subjects: ['공통', ...SUBJECTS] };
});

route('POST', '/api/consultations', async ({ db, user, body }) => {
  const sid = Number(body.student_id);
  await mustSeeStudent(db, user, sid);
  const date = isDate(body.date) ? body.date : today();
  const kind = CONSULT_KINDS.includes(body.kind) ? body.kind : '기타';
  // 과목을 안 고르면 이 선생님이 그 학생을 가르치는 반의 과목으로 채웁니다
  let subject = SUBJECTS.includes(body.subject) ? body.subject : body.subject === '공통' ? '공통' : null;
  if (!subject) {
    const c = await q.first(db, 'SELECT c.subject FROM enrollments e JOIN courses c ON c.id = e.course_id WHERE e.student_id = ? AND c.teacher_id = ? ORDER BY c.active DESC LIMIT 1', sid, user.id);
    subject = c ? c.subject : '공통';
  }
  const r = await q.run(db, 'INSERT INTO consultations (student_id, teacher_id, subject, date, kind, content, follow_up) VALUES (?, ?, ?, ?, ?, ?, ?)', sid, user.id, subject, date, kind, need(body.content, '상담 내용'), clean(body.follow_up));
  return { ok: true, id: r.meta.last_row_id };
});

async function mustOwnConsult(db, user, id) {
  const k = await q.first(db, 'SELECT * FROM consultations WHERE id = ?', id);
  if (!k) fail(404, '상담 기록을 찾을 수 없어요');
  if (user.role !== 'owner' && k.teacher_id !== user.id) fail(403, '내가 쓴 상담 기록만 고칠 수 있어요');
  return k;
}

route('PATCH', '/api/consultations/:id', async ({ db, user, body, params }) => {
  const k = await mustOwnConsult(db, user, Number(params.id));
  const v = {
    date: isDate(body.date) ? body.date : k.date,
    kind: CONSULT_KINDS.includes(body.kind) ? body.kind : k.kind,
    subject: SUBJECTS.includes(body.subject) || body.subject === '공통' ? body.subject : k.subject,
    content: 'content' in body ? need(body.content, '상담 내용') : k.content,
    follow_up: 'follow_up' in body ? clean(body.follow_up) : k.follow_up,
    follow_up_done: 'follow_up_done' in body ? (body.follow_up_done ? 1 : 0) : k.follow_up_done,
  };
  await q.run(db, 'UPDATE consultations SET date = ?, kind = ?, subject = ?, content = ?, follow_up = ?, follow_up_done = ? WHERE id = ?', v.date, v.kind, v.subject, v.content, v.follow_up, v.follow_up_done, k.id);
  return { ok: true };
});

route('DELETE', '/api/consultations/:id', async ({ db, user, params }) => {
  const k = await mustOwnConsult(db, user, Number(params.id));
  await q.run(db, 'DELETE FROM consultations WHERE id = ?', k.id);
  return { ok: true };
});

// ───────── 대시보드 ─────────

route('GET', '/api/dashboard', async ({ db, user }) => {
  const now = today();
  const settings = await getSettings(db);
  const sc = studentScope(user);

  const periods = await q.all(db, 'SELECT * FROM feedback_periods WHERE end_date >= ? ORDER BY start_date LIMIT 20', addDays(now, -30));
  const cards = [];
  for (const p of periods) {
    const c = await periodCounts(db, user, p);
    if (c.total === 0) continue;
    const card = periodCard(p, c.unsent, c.total, now);
    if (card.phase !== 'done') cards.push(card);
  }
  const order = { overdue: 0, open: 1, upcoming: 2 };
  cards.sort((a, b) => order[a.phase] - order[b.phase] || a.end_date.localeCompare(b.end_date));

  const studentCount = await q.first(db, `SELECT COUNT(*) AS n FROM students s WHERE s.status = '재원' AND ${sc.sql}`, ...sc.params);
  const newThisMonth = await q.first(db, `SELECT COUNT(*) AS n FROM students s WHERE s.status = '재원' AND substr(s.created_at, 1, 7) = ? AND ${sc.sql}`, now.slice(0, 7), ...sc.params);

  const courseWhere = seesAll(user) ? '' : 'AND c.teacher_id = ?';
  const courseParams = seesAll(user) ? [] : [user.id];
  const bySubject = await q.all(db, `SELECT c.subject, COUNT(*) AS n FROM courses c WHERE c.active = 1 ${courseWhere} GROUP BY c.subject ORDER BY n DESC`, ...courseParams);

  const wd = weekdayOf(now);
  const todayCourses = await q.all(
    db,
    `SELECT c.id, c.name, c.subject, c.start_time, c.end_time, c.times, c.room, c.teacher_id, u.name AS teacher_name, u.photo_v AS teacher_photo_v,
      (SELECT COUNT(*) FROM attendance a WHERE a.course_id = c.id AND a.date = ?) AS checked_count,
      (SELECT COUNT(*) FROM enrollments e JOIN students s ON s.id = e.student_id WHERE e.course_id = c.id AND s.status = '재원') AS student_count
     FROM courses c LEFT JOIN users u ON u.id = c.teacher_id
     WHERE c.active = 1 AND instr(',' || IFNULL(c.days,'') || ',', ',' || ? || ',') > 0 ${courseWhere}
     ORDER BY c.start_time, c.name`,
    now,
    wd,
    ...courseParams
  );

  const sc2 = studentScope(user, 'a.student_id');
  const alerts = await q.all(db, `SELECT a.status, COUNT(*) AS n FROM attendance a WHERE a.date = ? AND a.status != '출석' AND ${sc2.sql} GROUP BY a.status`, now, ...sc2.params);

  const sc3 = studentScope(user, 'k.student_id');
  const consultMonth = await q.first(db, `SELECT COUNT(*) AS n FROM consultations k WHERE substr(k.date, 1, 7) = ? AND ${sc3.sql}`, now.slice(0, 7), ...sc3.params);
  const consultPending = await q.first(db, `SELECT COUNT(*) AS n FROM consultations k WHERE k.follow_up IS NOT NULL AND k.follow_up != '' AND k.follow_up_done = 0 AND ${sc3.sql}`, ...sc3.params);

  const risks = await computeRisks(db, user);
  const rset = remindSettings(settings);
  const missLogs = rset.on ? await missingLogs(db, { from: addDays(now, -6), to: now, startDate: rset.start_date, teacherId: seesAll(user) ? null : user.id, afterMin: Number(rset.after_min) || 0 }) : [];
  for (const m of missLogs) delete m.teacher_phone;

  return {
    missing_logs: missLogs.slice(0, 30),
    user: publicUser(user),
    academy_name: settings.academy_name,
    mottos: parseMottos(settings),
    today: now,
    weekday: wd,
    send_mode: settings.send_mode === 'real' ? 'real' : 'preview',
    periods: cards.slice(0, 6),
    stats: {
      students: studentCount.n,
      new_this_month: newThisMonth.n,
      courses_by_subject: bySubject,
      today_courses: withTodayTime(todayCourses, wd),
      today_alerts: alerts,
      consult_month: consultMonth.n,
      consult_pending: consultPending.n,
      risk_high: risks.filter((r) => r.level === '높음').length,
      risk_total: risks.length,
    },
    risks: risks.slice(0, 5),
  };
});

// ───────── 설정 ─────────

route('GET', '/api/settings', async ({ db, env, user }) => {
  const s = await getSettings(db);
  const view = await viewOf(db, { role: 'teacher' });
  if (user.role !== 'owner') return { academy_name: s.academy_name, mottos: parseMottos(s), teacher_view: view };
  return { ...s, mottos: parseMottos(s), teacher_view: view, teacher_view_labels: TEACHER_VIEW_LABELS, solapi_ready: solapiReady(env), discount_items: discountItems(s), book_suppliers: suppliersOf(s), log_remind: remindSettings(s), word_books: wordBooks(s) };
});

route('PUT', '/api/settings', async ({ db, env, body }) => {
  const set = [];
  if ('academy_name' in body) set.push(['academy_name', need(body.academy_name, '학원 이름')]);
  if ('mottos' in body) set.push(['mottos', JSON.stringify((body.mottos || []).map((m) => String(m).trim()).filter(Boolean).slice(0, 3))]);
  if ('tpl_attendance' in body) set.push(['tpl_attendance', need(body.tpl_attendance, '출결 문자 문구')]);
  if ('tpl_feedback' in body) set.push(['tpl_feedback', need(body.tpl_feedback, '피드백 문자 문구')]);
  if ('log_remind' in body) {
    const r = body.log_remind || {};
    const after = Math.max(0, Math.min(600, Math.trunc(Number(r.after_min) || 0)));
    set.push(['log_remind', JSON.stringify({ on: !!r.on, after_min: after, sms: !!r.sms, start_date: isDate(r.start_date) ? r.start_date : '' })]);
  }
  if ('tpl_log_remind' in body) set.push(['tpl_log_remind', need(body.tpl_log_remind, '일지 알림 문구')]);
  if ('word_pass_pct' in body) set.push(['word_pass_pct', String(Math.max(1, Math.min(100, Math.trunc(Number(body.word_pass_pct) || 90))))]);
  if ('word_books' in body) set.push(['word_books', JSON.stringify((body.word_books || []).map((b) => ({ name: clean(b.name), days: Math.max(1, Math.min(200, Math.trunc(Number(b.days) || 0))) })).filter((b) => b.name))]);
  if ('tpl_word' in body) set.push(['tpl_word', need(body.tpl_word, '단어시험 문자 문구')]);
  if ('discount_items' in body) {
    const items = (body.discount_items || [])
      .map((x, i) => ({ id: clean(x.id) || `d${Date.now().toString(36)}${i}`, name: clean(x.name), amount: money(x.amount) }))
      .filter((x) => x.name);
    set.push(['discount_items', JSON.stringify(items)]);
  }
  if ('book_suppliers' in body) set.push(['book_suppliers', JSON.stringify((body.book_suppliers || []).map(clean).filter(Boolean))]);
  if ('bank_account' in body) set.push(['bank_account', clean(body.bank_account) || '']);
  if ('bank_account_book' in body) set.push(['bank_account_book', clean(body.bank_account_book) || '']);
  if ('tpl_bill' in body) set.push(['tpl_bill', need(body.tpl_bill, '함께 청구 문구')]);
  if ('tpl_bill_tuition' in body) set.push(['tpl_bill_tuition', need(body.tpl_bill_tuition, '교육비 청구서 문구')]);
  if ('tpl_bill_book' in body) set.push(['tpl_bill_book', need(body.tpl_bill_book, '교재비 청구서 문구')]);
  if ('teacher_view' in body) {
    const tv = body.teacher_view || {};
    set.push(['teacher_view', JSON.stringify(Object.fromEntries(Object.keys(TEACHER_VIEW_LABELS).map((k) => [k, !!tv[k]])))]);
  }
  if ('send_mode' in body) {
    const mode = body.send_mode === 'real' ? 'real' : 'preview';
    if (mode === 'real' && !solapiReady(env)) fail(400, '솔라피 키가 아직 등록되지 않아서 실제 발송으로 바꿀 수 없어요');
    set.push(['send_mode', mode]);
  }
  if (set.length) await db.batch(set.map(([k, v]) => db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(k, v)));
  return { ok: true };
}, OWNER);

// ───────── 요청 처리 ─────────

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runLogReminders(env).catch((e) => console.error('일지 알림 오류', e)));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    const wm = url.pathname.match(/^\/w\/([a-f0-9]{24})(\/photo)?$/);
    if (wm && env.DB) {
      await ensureSchema(env.DB);
      return wordSheetPage(env.DB, wm[1], !!wm[2]);
    }
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
    }
    try {
      if (!env.DB) fail(500, '데이터베이스(D1)가 연결되지 않았어요. wrangler.toml 의 database_id 를 확인해 주세요');
      await ensureSchema(env.DB);

      // 다른 사이트에서 몰래 요청을 보내는 것을 막습니다.
      if (request.method !== 'GET') {
        const origin = request.headers.get('origin');
        if (origin && new URL(origin).host !== url.host) fail(403, '허용되지 않은 요청이에요');
      }

      for (const r of routes) {
        if (r.method !== request.method) continue;
        const m = url.pathname.match(r.re);
        if (!m) continue;
        const params = {};
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        const ctx = { request, env, db: env.DB, url, params, query: Object.fromEntries(url.searchParams) };
        if (!r.public) {
          ctx.user = await currentUser(env.DB, request);
          if (!ctx.user) fail(401, '로그인이 필요해요');
          if (!r.roles.includes(ctx.user.role)) fail(403, '이 메뉴를 쓸 권한이 없어요');
          if (r.om && !seesAll(ctx.user)) fail(403, '원장님이나 감독님만 할 수 있어요');
        }
        if (request.method !== 'GET') ctx.body = await request.json().catch(() => ({}));
        const res = await r.handler(ctx);
        return res instanceof Response ? res : json(res ?? { ok: true });
      }
      fail(404, '없는 주소예요');
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: '서버에서 오류가 났어요: ' + (e && e.message) }, 500);
    }
  },
};
