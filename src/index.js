// 새솔학원 관리 앱 - 서버
// 화면(public 폴더)은 그대로 보여 주고, /api/ 로 시작하는 주소만 여기서 처리합니다.

import { ensureSchema, DEFAULT_SETTINGS, TEACHER_VIEW_LABELS } from './schema.js';
import { hashPassword, verifyPassword, createSession, sessionCookie, currentUser } from './auth.js';
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
      (SELECT COUNT(*) FROM students x WHERE s.family_id IS NOT NULL AND x.family_id = s.family_id AND x.id != s.id) AS sibling_count
     FROM students s WHERE ${where.join(' AND ')}
     ORDER BY CASE s.status WHEN '재원' THEN 0 WHEN '휴원' THEN 1 ELSE 2 END, s.name`,
    ...params
  );
  const view = await viewOf(db, user);
  return { students: rows.map((s) => {
    const o = shapeStudent(s, view);
    if (!view.siblings) delete o.sibling_count;
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
    courses: q.all(db, `SELECT c.id, c.name, c.subject, c.days, c.start_time, c.teacher_id, c.fee AS course_fee, e.fee AS own_fee, c.active, u.name AS teacher_name, u.photo_v AS teacher_photo_v
                        FROM enrollments e JOIN courses c ON c.id = e.course_id LEFT JOIN users u ON u.id = c.teacher_id WHERE e.student_id = ? ORDER BY c.active DESC, c.subject`, id),
    attendance: q.all(db, `SELECT a.date, a.status, a.memo, c.name AS course_name, c.subject FROM attendance a JOIN courses c ON c.id = a.course_id WHERE a.student_id = ? AND a.date >= ? ORDER BY a.date DESC`, id, addDays(today(), -60)),
    feedbacks: q.all(db, `SELECT f.id, f.content, f.status, f.sent_at, f.updated_at, p.title AS period_title, c.name AS course_name, c.subject FROM feedbacks f JOIN feedback_periods p ON p.id = f.period_id JOIN courses c ON c.id = f.course_id WHERE f.student_id = ? AND f.content != '' ORDER BY p.start_date DESC`, id),
    consultations: q.all(db, `SELECT k.*, u.name AS teacher_name, u.photo_v AS teacher_photo_v FROM consultations k LEFT JOIN users u ON u.id = k.teacher_id WHERE k.student_id = ? ORDER BY k.date DESC, k.id DESC`, id),
    flags: q.all(db, `SELECT r.*, u.name AS created_by_name FROM risk_flags r LEFT JOIN users u ON u.id = r.created_by WHERE r.student_id = ? ORDER BY r.resolved, r.created_at DESC`, id),
    messages: q.all(db, `SELECT m.id, m.kind, m.body, m.status, m.error, m.to_phone, m.created_at, u.name AS sent_by_name FROM messages m LEFT JOIN users u ON u.id = m.sent_by WHERE m.student_id = ? ORDER BY m.id DESC LIMIT 20`, id),
  };
  if (view.siblings && raw.family_id) jobs.siblings = q.all(db, `SELECT id, name, school, grade, status, photo_v FROM students WHERE family_id = ? AND id != ? ORDER BY birth_date, name`, raw.family_id, id);
  if (view.books) jobs.books = q.all(db, `SELECT b.*, u.name AS given_by_name FROM book_deliveries b LEFT JOIN users u ON u.id = b.given_by WHERE b.student_id = ? ORDER BY b.date DESC, b.id DESC`, id);
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
  if (view.fees) out.monthly_fee = out.courses.filter((c) => c.active).reduce((a, c) => a + (c.fee || 0), 0);
  if (view.tuition) out.tuition_paid_this_month = out.tuition.some((p) => p.month === month);
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

// 여러 명 한꺼번에 등록: 한 줄에 한 명, "이름, 학교, 학년, 어머니 연락처, 아버지 연락처"
route(
  'POST',
  '/api/students/bulk',
  async ({ db, body }) => {
    const lines = String(body.text || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length) fail(400, '등록할 학생을 한 줄에 한 명씩 적어 주세요');
    if (lines.length > 300) fail(400, '한 번에 300명까지 등록할 수 있어요');
    const t = today();
    const stmts = lines.map((l) => {
      const [name, school, grade, mom, dad] = l.split(/\t|,/).map((x) => x.trim());
      if (!name) fail(400, `이름이 없는 줄이 있어요: "${l}"`);
      return db.prepare('INSERT INTO students (name, school, grade, mother_phone, father_phone, enrolled_date) VALUES (?, ?, ?, ?, ?, ?)').bind(name, clean(school), clean(grade), phone(mom), phone(dad), t);
    });
    await db.batch(stmts);
    return { ok: true, added: stmts.length };
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
  const r = await q.run(
    db,
    'INSERT INTO book_deliveries (student_id, date, title, subject, qty, price, memo, given_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    isDate(body.date) ? body.date : today(),
    need(body.title, '교재 이름'),
    SUBJECTS.includes(body.subject) ? body.subject : null,
    qty,
    body.price === '' || body.price == null ? null : money(body.price),
    clean(body.memo),
    user.id
  );
  return { ok: true, id: r.meta.last_row_id };
});
route('DELETE', '/api/books/:id', async ({ db, user, params }) => {
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

function courseValues(body, base = {}) {
  const v = { ...base };
  for (const f of ['name', 'subject', 'days', 'start_time', 'end_time', 'room']) if (f in body) v[f] = clean(body[f]);
  if ('fee' in body) v.fee = body.fee === '' || body.fee == null ? null : money(body.fee);
  if ('teacher_id' in body) v.teacher_id = body.teacher_id ? Number(body.teacher_id) : null;
  if ('active' in body) v.active = body.active ? 1 : 0;
  if (!v.name) fail(400, '반 이름을 입력해 주세요');
  if (!SUBJECTS.includes(v.subject)) fail(400, '과목을 골라 주세요');
  if (v.days) v.days = v.days.split(/[,\s]+/).filter((d) => WEEK.includes(d)).join(',');
  return v;
}
const COURSE_FIELDS = ['name', 'subject', 'teacher_id', 'days', 'start_time', 'end_time', 'room', 'fee', 'active'];

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
    await db.batch([db.prepare('DELETE FROM enrollments WHERE course_id = ?').bind(id), ...ids.map((sid) => db.prepare('INSERT OR IGNORE INTO enrollments (course_id, student_id) VALUES (?, ?)').bind(id, sid))]);
    return { ok: true, count: ids.length };
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
    `SELECT c.id, c.name, c.subject, c.start_time, c.end_time, c.room, c.teacher_id, u.name AS teacher_name, u.photo_v AS teacher_photo_v,
      (SELECT COUNT(*) FROM enrollments e JOIN students s ON s.id = e.student_id WHERE e.course_id = c.id AND s.status = '재원') AS student_count,
      (SELECT COUNT(*) FROM attendance a WHERE a.course_id = c.id AND a.date = ?) AS checked_count
     FROM courses c LEFT JOIN users u ON u.id = c.teacher_id
     WHERE c.active = 1 AND instr(',' || IFNULL(c.days,'') || ',', ',' || ? || ',') > 0 ${mine}
     ORDER BY c.start_time, c.name`,
    ...params
  );
  return { date, weekday: wd, courses };
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
    `SELECT c.id, c.name, c.subject, c.start_time, c.end_time, c.room, c.teacher_id, u.name AS teacher_name, u.photo_v AS teacher_photo_v,
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

  return {
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
      today_courses: todayCourses,
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
  return { ...s, mottos: parseMottos(s), teacher_view: view, teacher_view_labels: TEACHER_VIEW_LABELS, solapi_ready: solapiReady(env) };
});

route('PUT', '/api/settings', async ({ db, env, body }) => {
  const set = [];
  if ('academy_name' in body) set.push(['academy_name', need(body.academy_name, '학원 이름')]);
  if ('mottos' in body) set.push(['mottos', JSON.stringify((body.mottos || []).map((m) => String(m).trim()).filter(Boolean).slice(0, 3))]);
  if ('tpl_attendance' in body) set.push(['tpl_attendance', need(body.tpl_attendance, '출결 문자 문구')]);
  if ('tpl_feedback' in body) set.push(['tpl_feedback', need(body.tpl_feedback, '피드백 문자 문구')]);
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
  async fetch(request, env) {
    const url = new URL(request.url);
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
