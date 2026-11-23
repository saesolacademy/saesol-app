// 문자 발송 (솔라피 SOLAPI)
//
// 기본은 "미리보기" 모드라서 실제 문자는 나가지 않고 발송 기록에만 남습니다.
// 실제로 보내려면:
//   1) Cloudflare 에 SOLAPI_API_KEY, SOLAPI_API_SECRET, SOLAPI_SENDER 세 가지를 등록하고
//   2) 앱의 [설정] 화면에서 발송 방식을 "실제 발송" 으로 바꾸면 됩니다.

export function solapiReady(env) {
  return Boolean(env.SOLAPI_API_KEY && env.SOLAPI_API_SECRET && env.SOLAPI_SENDER);
}

async function hmacHex(secret, data) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function solapiSend(env, items) {
  const date = new Date().toISOString();
  const salt = crypto.randomUUID().replace(/-/g, '');
  const signature = await hmacHex(env.SOLAPI_API_SECRET, date + salt);
  const res = await fetch('https://api.solapi.com/messages/v4/send-many/detail', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `HMAC-SHA256 apiKey=${env.SOLAPI_API_KEY}, date=${date}, salt=${salt}, signature=${signature}`,
    },
    body: JSON.stringify({
      messages: items.map((m) => ({ to: m.to, from: env.SOLAPI_SENDER, text: m.text })),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.errorMessage || data.message || `솔라피 오류 (${res.status})`;
    return items.map(() => ({ status: '실패', error: msg }));
  }
  const failed = new Map();
  for (const f of data.failedMessageList || []) failed.set(f.to, f.statusMessage || '발송 실패');
  return items.map((m) => (failed.has(m.to) ? { status: '실패', error: failed.get(m.to) } : { status: '발송', error: null }));
}

// msgs: [{ kind, student_id, to, text, ref_type, ref_id }]
// 결과를 messages 표에 기록하고, 각 문자의 결과를 돌려줍니다.
export async function sendMessages(env, db, settings, userId, msgs) {
  if (!msgs.length) return [];
  const real = settings.send_mode === 'real' && solapiReady(env);
  const results = msgs.map((m) => (m.to ? null : { status: '실패', error: '학부모 연락처가 없습니다' }));
  const toSend = msgs.map((m, i) => ({ ...m, i })).filter((m) => !results[m.i]);

  if (real && toSend.length) {
    const r = await solapiSend(env, toSend);
    toSend.forEach((m, k) => (results[m.i] = r[k]));
  } else {
    toSend.forEach((m) => (results[m.i] = { status: '미리보기', error: null }));
  }

  await db.batch(
    msgs.map((m, i) =>
      db
        .prepare(
          `INSERT INTO messages (kind, student_id, to_phone, body, status, error, sent_by, ref_type, ref_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(m.kind, m.student_id ?? null, m.to || null, m.text, results[i].status, results[i].error, userId, m.ref_type ?? null, m.ref_id ?? null)
    )
  );
  return results;
}

export function fillTemplate(tpl, values) {
  return String(tpl).replace(/\{([^{}]+)\}/g, (all, k) => (k in values ? values[k] ?? '' : all));
}
