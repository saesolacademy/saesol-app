// 로그인 / 비밀번호 관련 기능

const enc = new TextEncoder();
const ITER = 100000;

function b64(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(str) {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

async function pbkdf2(password, salt, iter) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2(password, salt, ITER);
  return `pbkdf2$${ITER}$${b64(salt)}$${b64(bits)}`;
}

export async function verifyPassword(password, stored) {
  const [kind, iter, salt, hash] = String(stored).split('$');
  if (kind !== 'pbkdf2') return false;
  const bits = b64(await pbkdf2(password, unb64(salt), Number(iter)));
  if (bits.length !== hash.length) return false;
  let diff = 0;
  for (let i = 0; i < bits.length; i++) diff |= bits.charCodeAt(i) ^ hash.charCodeAt(i);
  return diff === 0;
}

export function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const SESSION_DAYS = 30;

export async function createSession(db, userId) {
  const token = newToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  await db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').bind(token, userId, expires).run();
  return token;
}

export function sessionCookie(token, maxAge = SESSION_DAYS * 86400) {
  return `sid=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

// 요청에서 로그인한 사람 찾기
// 웹 화면은 쿠키를, 나중에 만들 학생 앱은 "Authorization: Bearer 토큰" 을 사용합니다.
export function readToken(request) {
  const auth = request.headers.get('authorization') || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const cookie = request.headers.get('cookie') || '';
  const m = cookie.match(/(?:^|;\s*)sid=([a-f0-9]+)/);
  return m ? m[1] : null;
}

export async function currentUser(db, request) {
  const token = readToken(request);
  if (!token) return null;
  const row = await db
    .prepare(
      `SELECT u.id, u.login_id, u.name, u.role, u.student_id, u.phone, u.photo_v, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND u.active = 1`
    )
    .bind(token)
    .first();
  if (!row) return null;
  if (row.expires_at < new Date().toISOString()) {
    await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    return null;
  }
  return { ...row, token };
}
