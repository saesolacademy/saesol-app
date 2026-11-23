// 학원 관리 앱 - 화면
(() => {
  'use strict';

  // ───────── 기본 도구 ─────────
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const h = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
  const SUBJECTS = ['국어', '영어', '수학', '과학', '사회', '기타'];

  const state = { me: null, academy: '학원' };

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = {};
    try { data = await res.json(); } catch {}
    if (res.status === 401 && !path.startsWith('/api/login') && !path.startsWith('/api/setup')) {
      state.me = null;
      showLogin();
      throw new Error(data.error || '로그인이 필요해요');
    }
    if (!res.ok) throw new Error(data.error || '오류가 났어요');
    return data;
  }

  function toast(msg) {
    const box = $('#toast');
    const d = document.createElement('div');
    d.textContent = msg;
    box.appendChild(d);
    setTimeout(() => d.remove(), 2800);
  }

  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function prettyDate(s) {
    if (!s) return '';
    const [y, m, d] = s.slice(0, 10).split('-').map(Number);
    const wd = WEEK[new Date(y, m - 1, d).getDay()];
    return `${m}월 ${d}일(${wd})`;
  }
  function prettyTime(s) {
    // DB 시간은 UTC 로 저장되어 있어 한국 시간으로 바꿔 보여 줍니다.
    if (!s) return '';
    const d = new Date(s.replace(' ', 'T') + 'Z');
    if (isNaN(d)) return s;
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  const fmtPhone = (p) => (!p ? '' : p.length === 11 ? `${p.slice(0, 3)}-${p.slice(3, 7)}-${p.slice(7)}` : p.length === 10 ? `${p.slice(0, 3)}-${p.slice(3, 6)}-${p.slice(6)}` : p);
  const isOwner = () => state.me && state.me.role === 'owner';
  const statusChip = (s) => {
    const map = { 출석: 'green', 지각: 'orange', 결석: 'red', 조퇴: 'blue', 미리보기: 'gold', 발송: 'green', 실패: 'red', 발송완료: 'green', 작성중: 'blue', 미작성: '', 재원: 'green', 휴원: 'orange', 퇴원: '', 높음: 'red', 주의: 'orange' };
    return `<span class="chip ${map[s] || ''}">${h(s)}</span>`;
  };
  // 선생님 사진 (없으면 이름 첫 글자)
  const avatar = (id, v, name, size = 28) => v
    ? `<img class="avatar" src="/api/photos/${id}?v=${v}" alt="${h(name)}" style="width:${size}px;height:${size}px">`
    : `<span class="avatar ini" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.45)}px">${h(String(name || '?').slice(0, 1))}</span>`;
  const withAvatar = (id, v, name, size = 22) => (name ? `<span class="who-tag">${avatar(id, v, name, size)}${h(name)}</span>` : '');

  // 사진 고르기 → 정사각형으로 잘라 작게 줄여서 올리기
  function pickPhoto(userId, done) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        const url = URL.createObjectURL(file);
        const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('사진을 열 수 없어요')); i.src = url; });
        const S = 320, side = Math.min(img.width, img.height);
        const c = document.createElement('canvas');
        c.width = c.height = S;
        c.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, S, S);
        URL.revokeObjectURL(url);
        const r = await api('PUT', `/api/users/${userId}/photo`, { data: c.toDataURL('image/jpeg', 0.85) });
        if (state.me && state.me.id === userId) state.me.photo_v = r.photo_v;
        toast('사진을 바꿨어요');
        done && done(r.photo_v);
      } catch (e) { toast(e.message); }
    };
    input.click();
  }

  const errBox = (e) => `<div class="card empty">😥 ${h(e.message || e)}</div>`;

  // ───────── 모달 ─────────
  function modal({ title, body, submitText = '저장', wide = false, onSubmit, onOpen, foot }) {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `
      <form class="modal ${wide ? 'wide' : ''}" autocomplete="off">
        <div class="modal-head"><h3>${h(title)}</h3><button type="button" class="btn sm" data-close>닫기</button></div>
        <div class="modal-body">${body}<div class="err"></div></div>
        <div class="modal-foot">${foot || ''}<span class="space"></span>${onSubmit ? `<button class="btn primary" type="submit">${h(submitText)}</button>` : ''}</div>
      </form>`;
    document.body.appendChild(back);
    const form = $('form', back);
    const close = () => back.remove();
    $('[data-close]', back).onclick = close;
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (!onSubmit) return;
      const btn = $('button[type=submit]', form);
      btn.disabled = true;
      $('.err', back).textContent = '';
      try {
        const data = Object.fromEntries(new FormData(form));
        const keep = await onSubmit(data, form, close);
        if (keep !== true) close();
      } catch (err) {
        $('.err', back).textContent = err.message;
      } finally {
        btn.disabled = false;
      }
    };
    if (onOpen) onOpen(form, close);
    const first = $('input:not([type=hidden]):not([type=checkbox]), textarea, select', form);
    if (first) first.focus();
    return close;
  }

  // ───────── 로그인 / 처음 설정 ─────────
  async function showLogin() {
    const app = $('#app');
    let status = { needsSetup: false, academy_name: '' };
    try { status = await api('GET', '/api/setup-status'); } catch (e) {
      app.innerHTML = `<div class="auth"><div class="card"><h1>연결 오류</h1><p>${h(e.message)}</p></div></div>`;
      return;
    }
    document.title = status.academy_name || '학원 관리';
    if (status.needsSetup) {
      app.innerHTML = `
        <div class="auth"><form class="card" id="f">
          <h1>처음 오셨네요 👋</h1>
          <p>원장님 계정을 먼저 만들어 주세요. 선생님 계정은 들어가서 만들 수 있어요.</p>
          <label class="field"><span>학원 이름</span><input type="text" name="academy_name" value="${h(status.academy_name)}" required></label>
          <label class="field"><span>원장님 이름</span><input type="text" name="name" required></label>
          <label class="field"><span>아이디 (영어·숫자 3자 이상)</span><input type="text" name="login_id" required autocapitalize="off"></label>
          <label class="field"><span>비밀번호 (8자 이상)</span><input type="password" name="password" required minlength="8"></label>
          <label class="field"><span>비밀번호 한 번 더</span><input type="password" name="password2" required></label>
          <div class="err"></div>
          <button class="btn primary" style="width:100%;justify-content:center;margin-top:8px">원장 계정 만들기</button>
        </form></div>`;
      $('#f').onsubmit = async (e) => {
        e.preventDefault();
        const d = Object.fromEntries(new FormData(e.target));
        if (d.password !== d.password2) return ($('.err').textContent = '비밀번호 두 개가 서로 달라요');
        try {
          const r = await api('POST', '/api/setup', d);
          state.me = r.user;
          start();
        } catch (err) { $('.err').textContent = err.message; }
      };
      return;
    }
    app.innerHTML = `
      <div class="auth"><form class="card" id="f">
        <h1>${h(status.academy_name)}</h1>
        <p>원장님·선생님 로그인</p>
        <label class="field"><span>아이디</span><input type="text" name="login_id" required autocapitalize="off" autocomplete="username"></label>
        <label class="field"><span>비밀번호</span><input type="password" name="password" required autocomplete="current-password"></label>
        <div class="err"></div>
        <button class="btn primary" style="width:100%;justify-content:center;margin-top:8px">로그인</button>
      </form></div>`;
    $('#f').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const r = await api('POST', '/api/login', Object.fromEntries(new FormData(e.target)));
        if (r.user.role === 'student') throw new Error('학생 계정은 학생 앱에서 로그인해 주세요');
        state.me = r.user;
        start();
      } catch (err) { $('.err').textContent = err.message; }
    };
  }

  // ───────── 메뉴 ─────────
  const NAV = [
    { group: null, items: [['', '🏠', '대시보드']] },
    { group: '원장 전용', owner: true, items: [['teachers', '👥', '선생님 계정'], ['courses', '🗂️', '반 관리'], ['periods', '🗓️', '피드백 기간'], ['settings', '⚙️', '설정']] },
    { group: '학생 관리', items: [['attendance', '✅', '출결 알림'], ['feedback', '📝', '피드백 작성'], ['risks', '🚨', '이탈 신호 관리'], ['messages', '📨', '피드백·문자 발송 기록'], ['consultations', '💬', '상담 정리']] },
    { group: '기본 정보', items: [['students', '🎒', '학생 명부']] },
  ];

  function renderShell() {
    const me = state.me;
    $('#app').innerHTML = `
      <div class="shell" id="shell">
        <div class="topbar"><button id="menuBtn" aria-label="메뉴">☰</button><b>${h(state.academy)}</b></div>
        <aside class="side">
          <div class="brand"><div class="brand-mark">${h(state.academy.slice(0, 1))}</div><div><div class="brand-name">${h(state.academy)}</div><div class="brand-sub">학원 관리</div></div></div>
          <nav class="nav">
            ${NAV.filter((g) => !g.owner || me.role === 'owner').map((g) => `
              <div class="nav-group ${g.owner ? 'owner' : ''}">
                ${g.group ? `<div class="nav-title">${g.owner ? '☆ ' : ''}${h(g.group)}</div>` : ''}
                ${g.items.map(([k, ico, label]) => `<a href="#/${k}" data-nav="${k}"><span class="ico">${ico}</span>${h(label)}</a>`).join('')}
              </div>`).join('')}
          </nav>
          <div class="side-foot">
            <div class="who">${avatar(me.id, me.photo_v, me.name, 36)}<div>${h(me.name)} <small>${me.role === 'owner' ? '원장' : '강사'} · ${h(me.login_id)}</small></div></div>
            <nav class="nav"><a href="#/me"><span class="ico">🔑</span>내 정보·비밀번호</a><a href="#" id="logout"><span class="ico">🚪</span>로그아웃</a></nav>
          </div>
        </aside>
        <main class="main" id="main"></main>
      </div>`;
    $('#menuBtn').onclick = () => $('#shell').classList.toggle('menu-open');
    $('#logout').onclick = async (e) => {
      e.preventDefault();
      await api('POST', '/api/logout').catch(() => {});
      state.me = null;
      location.hash = '#/';
      showLogin();
    };
  }

  // ───────── 주소에 따라 화면 바꾸기 ─────────
  function parseHash() {
    const raw = location.hash.replace(/^#\/?/, '');
    const [path, qs] = raw.split('?');
    const parts = path.split('/').filter(Boolean);
    return { parts, query: Object.fromEntries(new URLSearchParams(qs || '')) };
  }

  async function router() {
    if (!state.me) return;
    const { parts, query } = parseHash();
    const key = parts[0] || '';
    $$('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === key));
    $('#shell').classList.remove('menu-open');
    const main = $('#main');
    const page = PAGES[key];
    if (!page || (page.owner && !isOwner())) {
      main.innerHTML = errBox('없는 화면이에요');
      return;
    }
    main.innerHTML = '<div class="muted">불러오는 중…</div>';
    window.scrollTo(0, 0);
    try {
      await page.render(main, parts.slice(1), query);
    } catch (e) {
      main.innerHTML = errBox(e);
    }
  }
  const reload = () => router();

  // ───────── 대시보드 ─────────
  async function pageDashboard(el) {
    const d = await api('GET', '/api/dashboard');
    const s = d.stats;
    const greet = d.user.role === 'owner' ? `${h(d.user.name)} 원장님, 오늘도 좋은 하루 되세요.` : `${h(d.user.name)}쌤, 오늘도 잘 부탁드려요.`;
    const [y, m, dd] = d.today.split('-');
    const alertTxt = s.today_alerts.length ? s.today_alerts.map((a) => `${a.status} ${a.n}`).join(' · ') : '지각·결석 없음';
    const checked = s.today_courses.filter((c) => c.checked_count > 0).length;
    el.innerHTML = `
      ${d.send_mode === 'preview' ? `<div class="banner info">🔔 지금은 <b>미리보기 모드</b>예요. 문자가 실제로 나가지 않고 발송 기록에만 남아요.${isOwner() ? ' <a href="#/settings">설정에서 바꾸기</a>' : ''}</div>` : ''}
      <section class="hero">
        <div class="date">${y}년 ${Number(m)}월 ${Number(dd)}일 ${d.weekday}요일</div>
        <div class="hero-who">${avatar(d.user.id, d.user.photo_v, d.user.name, 54)}<h1>${greet}</h1></div>
        ${d.mottos.length ? `<div class="mottos">${d.mottos.map((t, i) => `<div class="motto"><small>0${i + 1}</small><div>${h(t)}</div></div>`).join('')}</div>` : ''}
      </section>

      ${d.periods.length ? `<div class="grid g3 mt">${d.periods.map((p) => `
        <a class="card dcard ${p.phase}" href="#/feedback?period=${p.id}">
          <div>
            <div class="t">📝 ${h(p.title)}</div>
            <div class="s">${prettyDate(p.start_date)} ~ ${prettyDate(p.end_date)}</div>
            <div class="s">${p.phase === 'overdue' ? `마감이 지났어요 · ${p.unsent}건 아직 안 보냄` : p.phase === 'open' ? `${p.total}건 중 ${p.unsent}건 남음` : '곧 시작해요'}</div>
          </div>
          <div class="dbadge"><small>${h(p.badge)}</small><b>${h(p.dday)}</b></div>
        </a>`).join('')}</div>` : ''}

      <div class="grid g4 mt">
        <div class="card stat"><div class="label">🎒 재원생</div><div class="num">${s.students}<small>명</small></div><div class="sub">이번 달 신규 ${s.new_this_month}명</div></div>
        <a class="card stat" href="#/attendance" style="text-decoration:none"><div class="label">📅 오늘 수업</div><div class="num">${s.today_courses.length}<small>개</small></div><div class="sub">출결 완료 ${checked} · 남음 ${s.today_courses.length - checked}</div></a>
        <a class="card stat ${s.today_alerts.length ? 'warn' : ''}" href="#/attendance" style="text-decoration:none"><div class="label">🔔 오늘 출결 알림</div><div class="num">${s.today_alerts.reduce((a, b) => a + b.n, 0)}<small>건</small></div><div class="sub">${h(alertTxt)}</div></a>
        <a class="card stat ${s.risk_high ? 'warn' : ''}" href="#/risks" style="text-decoration:none"><div class="label">🚨 이탈 신호</div><div class="num">${s.risk_total}<small>명</small></div><div class="sub">높음 ${s.risk_high} · 상담 후속 ${s.consult_pending}건</div></a>
      </div>

      <div class="grid g2 mt">
        <div class="card">
          <h2>오늘 수업</h2>
          ${s.today_courses.length ? `<table class="list"><tbody>${s.today_courses.map((c) => `
            <tr class="click" data-go="#/attendance?course=${c.id}">
              <td style="width:90px">${h(c.start_time || '')}</td>
              <td><b>${h(c.name)}</b><div class="small muted row" style="gap:6px">${h(c.subject)} · ${c.teacher_name ? withAvatar(c.teacher_id, c.teacher_photo_v, c.teacher_name, 18) : '담당 없음'}${c.room ? ' · ' + h(c.room) : ''}</div></td>
              <td style="text-align:right">${c.checked_count ? `<span class="chip green">출결 ${c.checked_count}/${c.student_count}</span>` : '<span class="btn sm">출결하기</span>'}</td>
            </tr>`).join('')}</tbody></table>` : '<div class="empty">오늘은 수업이 없어요</div>'}
        </div>
        <div class="card">
          <h2>살펴볼 학생</h2>
          ${d.risks.length ? d.risks.map((r) => `
            <div class="item"><div class="row"><a class="title" href="#/students/${r.id}">${h(r.name)}</a><span class="small muted">${h(r.school || '')} ${h(r.grade || '')}</span><span class="space"></span>${statusChip(r.level)}</div>
            <div class="small muted">${r.reasons.map(h).join(' · ')}</div></div>`).join('') : '<div class="empty">지금은 걱정되는 학생이 없어요 🙂</div>'}
          <div class="small muted mt">이번 달 상담 ${s.consult_month}건 · 수강 반 ${s.courses_by_subject.map((x) => `${h(x.subject)} ${x.n}`).join(', ') || '없음'}</div>
        </div>
      </div>`;
    $$('[data-go]', el).forEach((tr) => (tr.onclick = () => (location.hash = tr.dataset.go)));
  }

  // ───────── 출결 알림 ─────────
  async function pageAttendance(el, _p, query) {
    const date = query.date || todayStr();
    const [todayData, all] = await Promise.all([api('GET', `/api/attendance/today?date=${date}`), api('GET', '/api/courses')]);
    const courseId = Number(query.course) || (todayData.courses[0] && todayData.courses[0].id) || null;
    const others = all.courses.filter((c) => !todayData.courses.some((t) => t.id === c.id));

    el.innerHTML = `
      <div class="page-head"><div><h1>출결 알림</h1><p>출결을 체크하면 지각·결석·조퇴는 학부모님께 바로 문자가 가요.</p></div>
        <div class="row"><input type="date" id="date" value="${h(date)}" style="width:auto"></div></div>
      <div class="card">
        <h2>${prettyDate(date)} 수업</h2>
        ${todayData.courses.length ? `<div class="course-pick">${todayData.courses.map((c) => `
          <button data-course="${c.id}" class="${c.id === courseId ? 'on' : ''}"><b>${h(c.name)}</b>
          <span class="small muted row" style="gap:6px;margin:3px 0">${h(c.start_time || '')} ${withAvatar(c.teacher_id, c.teacher_photo_v, c.teacher_name, 18)}</span>
          ${c.checked_count ? `<span class="chip green">완료 ${c.checked_count}/${c.student_count}</span>` : `<span class="chip">${c.student_count}명 · 아직</span>`}</button>`).join('')}</div>`
          : '<div class="muted">이 날짜에 잡힌 수업이 없어요.</div>'}
        ${others.length ? `<div class="row mt"><span class="small muted">다른 반 고르기</span><select id="other" style="width:auto"><option value="">선택</option>${others.map((c) => `<option value="${c.id}" ${c.id === courseId ? 'selected' : ''}>${h(c.name)}</option>`).join('')}</select></div>` : ''}
      </div>
      <div id="sheet"></div>`;

    const go = (cid, dt = date) => (location.hash = `#/attendance?date=${dt}${cid ? `&course=${cid}` : ''}`);
    $('#date').onchange = (e) => go(null, e.target.value);
    $$('[data-course]', el).forEach((b) => (b.onclick = () => go(b.dataset.course)));
    if ($('#other')) $('#other').onchange = (e) => e.target.value && go(e.target.value);
    if (courseId) await renderSheet($('#sheet'), courseId, date);
  }

  async function renderSheet(box, courseId, date) {
    const d = await api('GET', `/api/attendance?course_id=${courseId}&date=${date}`);
    const marks = new Map(d.rows.map((r) => [r.student_id, { status: r.status, memo: r.memo || '' }]));
    box.innerHTML = `
      <div class="card mt">
        <div class="row"><h2 style="margin:0">${h(d.course.name)}</h2><span class="muted small">${h(d.course.subject)} · ${h(d.course.teacher_name || '')}</span><span class="space"></span>
          <button class="btn sm" id="allPresent">모두 출석</button></div>
        ${d.rows.length ? d.rows.map((r) => `
          <div class="att-row" data-sid="${r.student_id}">
            <div class="row" style="flex-wrap:nowrap">${sAvatar({ id: r.student_id, name: r.name, photo_v: r.photo_v }, 34)}<div><b>${h(r.name)}</b><div class="small muted">${h(r.school || '')} ${h(r.grade || '')}${r.has_phone ? '' : ' · <span style="color:var(--red)">학부모 번호 없음</span>'}</div></div></div>
            <div class="seg">${['출석', '지각', '결석', '조퇴'].map((s) => `<button type="button" data-v="${s}" class="${r.status === s ? 'on' : ''}">${s}</button>`).join('')}</div>
            <div class="row"><input type="text" placeholder="메모 (예: 병원)" value="${h(r.memo || '')}" data-memo>${r.notified_status ? `<span class="chip gold" title="알림 보낸 상태">알림 ${h(r.notified_status)}</span>` : ''}</div>
          </div>`).join('') : '<div class="empty">이 반에 학생이 없어요. 원장님이 [반 관리]에서 학생을 넣어 주세요.</div>'}
        ${d.rows.length ? `
        <div class="row mt">
          <label class="inline-check"><input type="checkbox" id="send" checked> 학부모님께 알림 보내기 (지각·결석·조퇴)</label>
          <label class="inline-check"><input type="checkbox" id="present"> 출석도 알림 보내기</label>
          <span class="space"></span>
          <button class="btn primary" id="save">저장하기</button>
        </div>
        <div class="small muted" style="margin-top:6px">이미 같은 내용으로 알림이 간 학생에게는 다시 보내지 않아요.</div>` : ''}
        <div id="result"></div>
      </div>`;
    $$('.att-row', box).forEach((row) => {
      const sid = Number(row.dataset.sid);
      $$('.seg button', row).forEach((b) => (b.onclick = () => {
        $$('.seg button', row).forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        marks.get(sid).status = b.dataset.v;
      }));
      $('[data-memo]', row).oninput = (e) => (marks.get(sid).memo = e.target.value);
    });
    const all = $('#allPresent', box);
    if (all) all.onclick = () => $$('.att-row', box).forEach((row) => {
      const m = marks.get(Number(row.dataset.sid));
      if (!m.status) { m.status = '출석'; $$('.seg button', row).forEach((x) => x.classList.toggle('on', x.dataset.v === '출석')); }
    });
    const save = $('#save', box);
    if (!save) return;
    save.onclick = async () => {
      const records = [...marks].filter(([, m]) => m.status).map(([student_id, m]) => ({ student_id, status: m.status, memo: m.memo }));
      if (!records.length) return toast('출결을 하나 이상 골라 주세요');
      save.disabled = true;
      try {
        const r = await api('POST', '/api/attendance', { course_id: courseId, date, records, send: $('#send').checked, include_present: $('#present').checked });
        toast(`${r.saved}명 저장했어요`);
        const names = new Map(d.rows.map((x) => [x.student_id, x.name]));
        $('#result', box).innerHTML = r.messages.length ? `<div class="mt"><b>보낸 알림</b>${r.messages.map((m) => `
          <div class="item"><div class="row"><b>${h(names.get(m.student_id))}</b>${statusChip(m.status)}${m.error ? `<span class="small" style="color:var(--red)">${h(m.error)}</span>` : ''}</div>
          <div class="preview">${h(m.text)}</div></div>`).join('')}</div>` : '<div class="muted small mt">새로 보낼 알림은 없었어요.</div>';
        setTimeout(() => $('#result', box).scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
      } catch (e) { toast(e.message); } finally { save.disabled = false; }
    };
  }

  // ───────── 피드백 작성 ─────────
  async function pageFeedback(el, _p, query) {
    const { periods } = await api('GET', '/api/periods');
    if (!periods.length) {
      el.innerHTML = `<div class="page-head"><div><h1>피드백 작성</h1></div></div><div class="card empty">아직 피드백 기간이 없어요.${isOwner() ? ' <a href="#/periods">피드백 기간 만들기</a>' : ' 원장님이 기간을 만들면 여기에 나와요.'}</div>`;
      return;
    }
    const pick = periods.find((p) => String(p.id) === query.period) || periods.find((p) => p.phase === 'overdue' && p.total) || periods.find((p) => p.phase === 'open') || periods[0];
    const d = await api('GET', `/api/feedbacks?period_id=${pick.id}`);
    const filter = query.f || 'all';
    const courses = [...new Map(d.rows.map((r) => [r.course_id, r.course_name])).entries()];
    const course = query.c || '';
    const rows = d.rows.filter((r) => (filter === 'all' || r.status === filter) && (!course || String(r.course_id) === course));
    const count = (s) => d.rows.filter((r) => r.status === s).length;
    const p = d.period;

    el.innerHTML = `
      <div class="page-head"><div><h1>피드백 작성</h1><p>쓰고 나서 칸 밖을 누르면 자동으로 저장돼요. 다 쓰면 골라서 한 번에 보내세요.</p></div>
        ${isOwner() ? '<a class="btn" href="#/periods">🗓️ 기간 관리</a>' : ''}</div>
      <div class="card">
        <div class="row">
          <select id="period" style="width:auto;max-width:100%">${periods.map((x) => `<option value="${x.id}" ${x.id === pick.id ? 'selected' : ''}>${h(x.title)} (${h(x.badge)} ${h(x.dday)})</option>`).join('')}</select>
          <span class="chip ${p.phase === 'overdue' ? 'red' : p.phase === 'open' ? 'green' : ''}">${prettyDate(p.start_date)} ~ ${prettyDate(p.end_date)}</span>
        </div>
        <div class="row mt">
          ${[['all', `전체 ${d.rows.length}`], ['미작성', `미작성 ${count('미작성')}`], ['작성중', `작성 완료·미발송 ${count('작성중')}`], ['발송완료', `발송 완료 ${count('발송완료')}`]].map(([k, l]) => `<button class="btn sm ${filter === k ? 'primary' : ''}" data-f="${k}">${h(l)}</button>`).join('')}
          <span class="space"></span>
          ${courses.length > 1 ? `<select id="course" style="width:auto"><option value="">모든 반</option>${courses.map(([id, n]) => `<option value="${id}" ${String(id) === course ? 'selected' : ''}>${h(n)}</option>`).join('')}</select>` : ''}
        </div>
      </div>
      <div class="mt" id="list">
        ${rows.length ? rows.map((r) => `
          <div class="fb" data-key="${r.course_id}-${r.student_id}">
            <div class="fb-head">
              <input type="checkbox" data-pick ${r.feedback_id && r.content && r.status !== '발송완료' ? '' : 'disabled'} style="width:auto">
              <b>${h(r.student_name)}</b><span class="small muted">${h(r.school || '')} ${h(r.grade || '')} · ${h(r.course_name)}${isOwner() ? ' · ' + h(r.teacher_name || '') : ''}</span>
              <span class="space"></span><span data-status>${statusChip(r.status)}</span>
              ${r.has_phone ? '' : '<span class="chip red">학부모 번호 없음</span>'}
            </div>
            <textarea placeholder="이번 기간 수업 태도, 성취, 다음 목표 등을 적어 주세요">${h(r.content)}</textarea>
            <div class="row" style="margin-top:6px"><button class="btn sm" data-preview>문자 미리보기</button><span class="small muted" data-saved>${r.sent_at ? '보낸 시각 ' + prettyTime(r.sent_at) : ''}</span></div>
            <div class="preview" hidden>${h(r.preview)}</div>
          </div>`).join('') : '<div class="card empty">해당하는 학생이 없어요</div>'}
      </div>
      <div class="sticky-bar row">
        <button class="btn" id="pickAll">작성된 것 모두 선택</button>
        <span class="small muted" id="pickCount">0건 선택</span>
        <span class="space"></span>
        <button class="btn primary" id="send">선택한 피드백 보내기</button>
      </div>`;

    const go = (patch) => {
      const q = { period: pick.id, f: filter, c: course, ...patch };
      location.hash = '#/feedback?' + new URLSearchParams(Object.entries(q).filter(([, v]) => v)).toString();
    };
    $('#period').onchange = (e) => go({ period: e.target.value, f: 'all', c: '' });
    $$('[data-f]', el).forEach((b) => (b.onclick = () => go({ f: b.dataset.f })));
    if ($('#course')) $('#course').onchange = (e) => go({ c: e.target.value });

    const byKey = new Map(d.rows.map((r) => [`${r.course_id}-${r.student_id}`, r]));
    const updateCount = () => ($('#pickCount').textContent = `${$$('[data-pick]:checked', el).length}건 선택`);
    $$('.fb', el).forEach((card) => {
      const r = byKey.get(card.dataset.key);
      const ta = $('textarea', card);
      const pickBox = $('[data-pick]', card);
      pickBox.onchange = updateCount;
      $('[data-preview]', card).onclick = () => { const pv = $('.preview', card); pv.hidden = !pv.hidden; };
      ta.onblur = async () => {
        const content = ta.value.trim();
        if (content === (r.content || '').trim()) return;
        try {
          const res = await api('PUT', '/api/feedbacks', { period_id: pick.id, course_id: r.course_id, student_id: r.student_id, content });
          r.content = content;
          r.feedback_id = res.feedback.id;
          if (r.status !== '발송완료') {
            r.status = content ? '작성중' : '미작성';
            $('[data-status]', card).innerHTML = statusChip(r.status);
            pickBox.disabled = !content;
            if (!content) pickBox.checked = false;
          } else {
            $('[data-status]', card).innerHTML = statusChip('발송완료') + ' <span class="chip orange">보낸 뒤 수정됨</span>';
          }
          r.preview = res.preview;
          $('.preview', card).textContent = res.preview;
          $('[data-saved]', card).textContent = '저장됨 ✓';
          updateCount();
        } catch (e) { toast(e.message); }
      };
    });
    $('#pickAll').onclick = () => { $$('[data-pick]:not(:disabled)', el).forEach((c) => (c.checked = true)); updateCount(); };
    $('#send').onclick = async () => {
      const ids = $$('.fb', el).filter((c) => $('[data-pick]', c).checked).map((c) => byKey.get(c.dataset.key).feedback_id).filter(Boolean);
      if (!ids.length) return toast('보낼 피드백을 골라 주세요');
      if (!confirm(`${ids.length}건의 피드백을 학부모님께 보낼까요?`)) return;
      $('#send').disabled = true;
      try {
        const r = await api('POST', '/api/feedbacks/send', { feedback_ids: ids });
        toast(`${r.mode === 'preview' ? '[미리보기] ' : ''}${r.sent}건 보냄${r.failed ? `, ${r.failed}건 실패` : ''}`);
        reload();
      } catch (e) { toast(e.message); $('#send').disabled = false; }
    };
  }

  // ───────── 이탈 신호 ─────────
  async function pageRisks(el) {
    const { risks } = await api('GET', '/api/risks');
    el.innerHTML = `
      <div class="page-head"><div><h1>이탈 신호 관리</h1><p>최근 30일 결석·지각이 잦거나, 선생님이 직접 "걱정돼요"라고 표시한 학생이에요.</p></div>
        <button class="btn primary" id="add">＋ 직접 표시하기</button></div>
      <div class="card">
        ${risks.length ? risks.map((r) => `
          <div class="item">
            <div class="row">${sAvatar(r, 30)}<a class="title" href="#/students/${r.id}">${h(r.name)}</a><span class="small muted">${h(r.school || '')} ${h(r.grade || '')}</span>${statusChip(r.level)}<span class="space"></span>
              <button class="btn sm" data-consult="${r.id}">💬 상담 기록</button></div>
            <ul class="reasons">${r.reasons.map((x) => `<li>${h(x)}</li>`).join('')}</ul>
            <div class="row small muted" style="margin-top:6px">마지막 상담: ${r.last_consult ? prettyDate(r.last_consult) : '없음'}
              ${r.flags.map((f) => `<button class="btn sm" data-resolve="${f.id}">"${h(f.reason.slice(0, 14))}" 해결됨</button>`).join('')}</div>
          </div>`).join('') : '<div class="empty">지금은 이탈 신호가 있는 학생이 없어요 🙂</div>'}
      </div>
      <div class="small muted mt">자동 기준: 최근 2번 연속 결석 / 30일 결석 2번 이상 / 30일 지각·조퇴 3번 이상. "높음"은 연속 결석, 결석 3번 이상, 또는 직접 표시한 경우예요.</div>`;
    $('#add').onclick = () => flagModal();
    $$('[data-consult]', el).forEach((b) => (b.onclick = () => consultModal({ student_id: Number(b.dataset.consult) })));
    $$('[data-resolve]', el).forEach((b) => (b.onclick = () => modal({
      title: '해결됨으로 표시',
      body: `<label class="field"><span>어떻게 해결됐나요? (선택)</span><textarea name="resolution" placeholder="예: 상담 후 계속 다니기로 함"></textarea></label>`,
      submitText: '해결됨',
      onSubmit: async (d) => { await api('PATCH', `/api/risks/${b.dataset.resolve}`, d); toast('해결됨으로 바꿨어요'); reload(); },
    })));
  }

  async function studentOptions(selected) {
    const { students } = await api('GET', '/api/students?status=재원');
    return students.map((s) => `<option value="${s.id}" ${s.id === selected ? 'selected' : ''}>${h(s.name)} (${h(s.school || '')} ${h(s.grade || '')})</option>`).join('');
  }

  async function flagModal(studentId) {
    const opts = await studentOptions(studentId);
    modal({
      title: '이탈 신호 직접 표시',
      body: `<label class="field"><span>학생</span><select name="student_id" required><option value="">고르세요</option>${opts}</select></label>
             <label class="field"><span>걱정되는 이유</span><textarea name="reason" required placeholder="예: 학부모님이 다른 학원 알아보는 중"></textarea></label>`,
      onSubmit: async (d) => { await api('POST', '/api/risks', d); toast('표시했어요'); reload(); },
    });
  }

  // ───────── 발송 기록 ─────────
  async function pageMessages(el, _p, query) {
    const qs = new URLSearchParams(Object.entries({ kind: query.kind, status: query.status, q: query.q }).filter(([, v]) => v)).toString();
    const { messages } = await api('GET', '/api/messages' + (qs ? '?' + qs : ''));
    el.innerHTML = `
      <div class="page-head"><div><h1>피드백·문자 발송 기록</h1><p>${isOwner() ? '모든 선생님이 보낸 문자예요.' : '내가 보낸 문자예요.'} 최근 100건까지 보여요.</p></div></div>
      <div class="card">
        <form class="row" id="filter">
          <select name="kind" style="width:auto"><option value="">모든 종류</option>${['출결', '피드백'].map((k) => `<option ${query.kind === k ? 'selected' : ''}>${k}</option>`).join('')}</select>
          <select name="status" style="width:auto"><option value="">모든 상태</option>${['발송', '미리보기', '실패'].map((k) => `<option ${query.status === k ? 'selected' : ''}>${k}</option>`).join('')}</select>
          <input type="search" name="q" placeholder="학생 이름" value="${h(query.q || '')}" style="width:160px">
          <button class="btn">찾기</button>
        </form>
        <div class="table-wrap mt"><table class="list">
          <thead><tr><th>시각</th><th>종류</th><th>학생</th><th>받는 번호</th><th>상태</th><th>내용</th>${isOwner() ? '<th>보낸 사람</th>' : ''}</tr></thead>
          <tbody>${messages.map((m) => `
            <tr><td style="white-space:nowrap">${prettyTime(m.created_at)}</td><td>${h(m.kind)}</td>
              <td>${m.student_id ? `<a href="#/students/${m.student_id}">${h(m.student_name || '')}</a>` : ''}</td>
              <td style="white-space:nowrap">${h(fmtPhone(m.to_phone))}</td>
              <td>${statusChip(m.status)}${m.error ? `<div class="small" style="color:var(--red)">${h(m.error)}</div>` : ''}</td>
              <td><details><summary class="small">${h(m.body.slice(0, 26))}…</summary><div class="preview">${h(m.body)}</div></details></td>
              ${isOwner() ? `<td>${h(m.sent_by_name || '')}</td>` : ''}</tr>`).join('')}</tbody>
        </table></div>
        ${messages.length ? '' : '<div class="empty">발송 기록이 없어요</div>'}
      </div>
      <div class="small muted mt">"미리보기"는 연습 모드라 실제로 나가지 않은 문자예요.</div>`;
    $('#filter').onsubmit = (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(e.target));
      location.hash = '#/messages?' + new URLSearchParams(Object.entries(d).filter(([, v]) => v)).toString();
    };
  }

  // ───────── 상담 정리 ─────────
  async function consultModal(preset = {}) {
    const opts = await studentOptions(preset.student_id);
    const kinds = ['학부모 상담', '학생 상담', '전화 상담', '등록 상담', '기타'];
    const editing = !!preset.id;
    modal({
      title: editing ? '상담 기록 고치기' : '새 상담 기록',
      wide: true,
      body: `
        <div class="grid g2">
          <label class="field"><span>학생</span><select name="student_id" required ${editing ? 'disabled' : ''}><option value="">고르세요</option>${opts}</select></label>
          <div class="grid g2" style="gap:8px">
            <label class="field"><span>날짜</span><input type="date" name="date" value="${h(preset.date || todayStr())}" required></label>
            <label class="field"><span>종류</span><select name="kind">${kinds.map((k) => `<option ${preset.kind === k ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
          </div>
        </div>
        <label class="field"><span>과목</span><select name="subject">${editing ? '' : '<option value="">내 담당 과목 (자동)</option>'}${['공통', ...SUBJECTS].map((x) => `<option ${preset.subject === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
        <label class="field"><span>상담 내용</span><textarea name="content" required style="min-height:130px" placeholder="누구와, 어떤 이야기를 나눴는지 적어 주세요">${h(preset.content || '')}</textarea></label>
        <label class="field"><span>해야 할 일 (후속 조치, 선택)</span><input type="text" name="follow_up" value="${h(preset.follow_up || '')}" placeholder="예: 다음 주 보충 수업 일정 잡기"></label>`,
      onSubmit: async (d) => {
        if (editing) await api('PATCH', `/api/consultations/${preset.id}`, d);
        else await api('POST', '/api/consultations', d);
        toast('저장했어요');
        reload();
      },
    });
  }

  async function pageConsultations(el, _p, query) {
    const qs = new URLSearchParams(Object.entries({ pending: query.pending, q: query.q, subject: query.subject }).filter(([, v]) => v)).toString();
    const { consultations, subjects } = await api('GET', '/api/consultations' + (qs ? '?' + qs : ''));
    el.innerHTML = `
      <div class="page-head"><div><h1>상담 정리</h1><p>상담 내용과 해야 할 일을 기록해 두면 다른 선생님과도 함께 볼 수 있어요.</p></div>
        <button class="btn primary" id="add">＋ 새 상담 기록</button></div>
      <div class="card">
        <form class="row" id="filter">
          <select name="subject" style="width:auto"><option value="">모든 과목</option>${subjects.map((x) => `<option ${query.subject === x ? 'selected' : ''}>${x}</option>`).join('')}</select>
          <label class="inline-check"><input type="checkbox" name="pending" value="1" ${query.pending ? 'checked' : ''}> 할 일이 남은 것만</label>
          <input type="search" name="q" placeholder="학생 이름·내용 검색" value="${h(query.q || '')}" style="width:200px">
          <button class="btn">찾기</button>
        </form>
        <div class="mt">${consultations.length ? consultations.map((k) => `
          <div class="item">
            <div class="row"><a class="title" href="#/students/${k.student_id}">${h(k.student_name)}</a><span class="small muted">${h(k.school || '')} ${h(k.grade || '')}</span>
              <span class="chip green">${h(k.subject || '공통')}</span><span class="chip">${h(k.kind)}</span><span class="small muted row" style="gap:6px">${prettyDate(k.date)} ${withAvatar(k.teacher_id, k.teacher_photo_v, k.teacher_name, 18)}</span><span class="space"></span>
              ${isOwner() || k.teacher_id === state.me.id ? `<button class="btn sm" data-edit="${k.id}">고치기</button><button class="btn sm danger" data-del="${k.id}">삭제</button>` : ''}</div>
            <div class="content">${h(k.content)}</div>
            ${k.follow_up ? `<div class="follow ${k.follow_up_done ? 'done' : ''} row"><span>📌 ${h(k.follow_up)}</span><span class="space"></span>
              ${isOwner() || k.teacher_id === state.me.id ? `<button class="btn sm" data-done="${k.id}" data-v="${k.follow_up_done ? 0 : 1}">${k.follow_up_done ? '다시 열기' : '완료'}</button>` : ''}</div>` : ''}
          </div>`).join('') : '<div class="empty">상담 기록이 없어요</div>'}</div>
      </div>`;
    const byId = new Map(consultations.map((k) => [k.id, k]));
    $('#add').onclick = () => consultModal();
    $('#filter').onsubmit = (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(e.target));
      location.hash = '#/consultations?' + new URLSearchParams(Object.entries(d).filter(([, v]) => v)).toString();
    };
    $$('[data-edit]', el).forEach((b) => (b.onclick = () => consultModal(byId.get(Number(b.dataset.edit)))));
    $$('[data-del]', el).forEach((b) => (b.onclick = async () => {
      if (!confirm('이 상담 기록을 지울까요?')) return;
      try { await api('DELETE', `/api/consultations/${b.dataset.del}`); toast('지웠어요'); reload(); } catch (e) { toast(e.message); }
    }));
    $$('[data-done]', el).forEach((b) => (b.onclick = async () => {
      try { await api('PATCH', `/api/consultations/${b.dataset.done}`, { follow_up_done: b.dataset.v === '1' }); reload(); } catch (e) { toast(e.message); }
    }));
  }

  // ───────── 학생 명단 / 학생 카드 ─────────
  const won = (n) => (n == null || n === '' ? '-' : `${Number(n).toLocaleString('ko-KR')}원`);
  const thisMonth = () => todayStr().slice(0, 7);
  function ageOf(b) {
    if (!b) return '';
    const [y, m, d] = b.split('-').map(Number);
    const t = new Date();
    let a = t.getFullYear() - y;
    if (t.getMonth() + 1 < m || (t.getMonth() + 1 === m && t.getDate() < d)) a--;
    return `만 ${a}세`;
  }
  const sAvatar = (s, size = 32) => s.photo_v
    ? `<img class="avatar" src="/api/student-photos/${s.id}?v=${s.photo_v}" alt="" style="width:${size}px;height:${size}px">`
    : `<span class="avatar ini student" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px">${h(String(s.name || '?').slice(0, 1))}</span>`;

  function pickStudentPhoto(id, done) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        const url = URL.createObjectURL(file);
        const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('사진을 열 수 없어요')); i.src = url; });
        const S = 320, side = Math.min(img.width, img.height);
        const c = document.createElement('canvas');
        c.width = c.height = S;
        c.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, S, S);
        URL.revokeObjectURL(url);
        await api('PUT', `/api/students/${id}/photo`, { data: c.toDataURL('image/jpeg', 0.85) });
        toast('사진을 바꿨어요');
        done && done();
      } catch (e) { toast(e.message); }
    };
    input.click();
  }

  function studentForm(s = {}) {
    return `
      <div class="form-sec">기본 정보</div>
      <div class="grid g3f">
        <label class="field"><span>이름 *</span><input type="text" name="name" value="${h(s.name)}" required></label>
        <label class="field"><span>생년월일</span><input type="date" name="birth_date" value="${h(s.birth_date)}"></label>
        <label class="field"><span>학생 연락처</span><input type="tel" name="student_phone" value="${h(fmtPhone(s.student_phone))}"></label>
        <label class="field"><span>학교</span><input type="text" name="school" value="${h(s.school)}"></label>
        <label class="field"><span>학년</span><input type="text" name="grade" value="${h(s.grade)}" placeholder="예: 중2"></label>
        <label class="field"><span>등록일</span><input type="date" name="enrolled_date" value="${h(s.enrolled_date || todayStr())}"></label>
      </div>
      <label class="field"><span>주소</span><input type="text" name="address" value="${h(s.address)}"></label>
      <div class="form-sec">부모님</div>
      <div class="grid g2">
        <label class="field"><span>아버지 성함</span><input type="text" name="father_name" value="${h(s.father_name)}"></label>
        <label class="field"><span>아버지 연락처</span><input type="tel" name="father_phone" value="${h(fmtPhone(s.father_phone))}"></label>
        <label class="field"><span>어머니 성함</span><input type="text" name="mother_name" value="${h(s.mother_name)}"></label>
        <label class="field"><span>어머니 연락처</span><input type="tel" name="mother_phone" value="${h(fmtPhone(s.mother_phone))}"></label>
      </div>
      <label class="field"><span>학원 문자 받으실 분</span><select name="sms_target">${['어머니', '아버지', '둘 다'].map((x) => `<option ${(s.sms_target || '어머니') === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
      <div class="form-sec">재원 상태</div>
      <div class="grid g3f">
        <label class="field"><span>상태</span><select name="status">${['재원', '휴원', '퇴원'].map((x) => `<option ${(s.status || '재원') === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
        <label class="field"><span>휴원·퇴원 날짜</span><input type="date" name="status_date" value="${h(s.status_date)}"></label>
        <label class="field"><span>휴원·퇴원 사유</span><input type="text" name="status_reason" value="${h(s.status_reason)}"></label>
      </div>
      <div class="form-sec">기타</div>
      <label class="field"><span>형제·자매 메모 (우리 학원에 안 다니는 형제 등)</span><input type="text" name="sibling_note" value="${h(s.sibling_note)}" placeholder="예: 누나 고3 (다른 학원)"></label>
      <label class="field"><span>특이사항 메모</span><textarea name="memo">${h(s.memo)}</textarea></label>`;
  }

  async function pageStudents(el, parts, query) {
    if (parts[0]) return pageStudent(el, Number(parts[0]));
    const st = query.status ?? '재원';
    const qs = new URLSearchParams(Object.entries({ status: st, q: query.q }).filter(([, v]) => v)).toString();
    const { students, view } = await api('GET', '/api/students' + (qs ? '?' + qs : ''));
    const count = (k) => students.filter((s) => s.status === k).length;
    el.innerHTML = `
      <div class="page-head"><div><h1>학생 명부</h1><p>${isOwner() ? '학생을 누르면 인적사항·상담·교재·수납이 한 화면에 나와요.' : '내 반 학생만 보여요. 학생을 누르면 학생 카드가 열려요.'}</p></div>
        ${isOwner() ? '<div class="row"><button class="btn" id="bulk">여러 명 한꺼번에 추가</button><button class="btn primary" id="add">＋ 학생 등록</button></div>' : ''}</div>
      <div class="card">
        <form class="row" id="filter">
          <div class="tabs">${[['재원', '재원생'], ['휴원', '휴원생'], ['퇴원', '퇴원생'], ['', '전체']].map(([v, l]) => `<button type="button" class="btn sm ${st === v ? 'primary' : ''}" data-st="${v}">${l}</button>`).join('')}</div>
          <span class="space"></span>
          <input type="search" name="q" placeholder="이름·학교 검색" value="${h(query.q || '')}" style="width:180px">
          <button class="btn">찾기</button>
        </form>
        <div class="table-wrap mt"><table class="list">
          <thead><tr><th></th><th>이름</th><th>학교·학년</th>${view.birth ? '<th>생년월일</th>' : ''}<th>수강</th>${view.parents ? '<th>어머니 / 아버지</th>' : ''}<th>상태</th></tr></thead>
          <tbody>${students.map((s) => `<tr class="click" data-id="${s.id}">
            <td style="width:44px">${sAvatar(s, 34)}</td>
            <td><b>${h(s.name)}</b>${s.sibling_count ? ` <span class="chip gold" title="형제·자매가 함께 다녀요">형제 ${s.sibling_count}</span>` : ''}</td>
            <td>${h(s.school || '')} ${h(s.grade || '')}</td>
            ${view.birth ? `<td class="small">${h(s.birth_date || '')}</td>` : ''}
            <td class="small">${h(s.courses || '-')}</td>
            ${view.parents ? `<td class="small">${h(fmtPhone(s.mother_phone)) || '-'}<br>${h(fmtPhone(s.father_phone)) || '-'}</td>` : ''}
            <td>${statusChip(s.status)}${s.has_phone ? '' : ' <span class="chip red">번호 없음</span>'}</td></tr>`).join('')}</tbody>
        </table></div>
        ${students.length ? `<div class="small muted mt">${students.length}명${st === '' ? ` (재원 ${count('재원')} · 휴원 ${count('휴원')} · 퇴원 ${count('퇴원')})` : ''}</div>` : '<div class="empty">학생이 없어요</div>'}
      </div>`;
    const go = (patch) => {
      const q = { status: st, q: query.q, ...patch };
      location.hash = '#/students?' + new URLSearchParams(Object.entries(q).map(([k, v]) => [k, v ?? ''])).toString();
    };
    $$('[data-st]', el).forEach((b) => (b.onclick = () => go({ status: b.dataset.st })));
    $('#filter').onsubmit = (e) => { e.preventDefault(); go({ q: new FormData(e.target).get('q') }); };
    $$('tr[data-id]', el).forEach((tr) => (tr.onclick = () => (location.hash = `#/students/${tr.dataset.id}`)));
    if (!isOwner()) return;
    $('#add').onclick = () => modal({ title: '학생 등록', wide: true, body: studentForm({ status: '재원' }), onSubmit: async (d) => { const r = await api('POST', '/api/students', d); toast('등록했어요'); location.hash = `#/students/${r.id}`; } });
    $('#bulk').onclick = () => modal({
      title: '여러 명 한꺼번에 추가', wide: true, submitText: '등록하기',
      body: `<p class="small muted" style="margin-top:0">한 줄에 한 명씩, <b>이름, 학교, 학년, 어머니 연락처, 아버지 연락처</b> 순서로 적어 주세요. 엑셀에서 칸을 그대로 복사해 붙여 넣어도 돼요. 나머지 정보는 학생 카드에서 채우면 돼요.</p>
             <textarea name="text" style="min-height:220px" placeholder="홍길동, 대치중, 중2, 010-1234-5678, 010-2345-6789&#10;김영희, 대치고, 고1, 010-2222-3333"></textarea>`,
      onSubmit: async (d) => { const r = await api('POST', '/api/students/bulk', d); toast(`${r.added}명 등록했어요`); reload(); },
    });
  }

  async function pageStudent(el, id) {
    const d = await api('GET', `/api/students/${id}`);
    const s = d.student, v = d.view, own = isOwner();
    const absent = d.attendance.filter((a) => a.status === '결석').length;
    const late = d.attendance.filter((a) => a.status === '지각' || a.status === '조퇴').length;
    const subjects = [...new Set(d.consultations.map((k) => k.subject || '공통'))];
    const info = [
      v.birth && ['생년월일', s.birth_date ? `${h(s.birth_date)} <span class="muted small">(${ageOf(s.birth_date)})</span>` : '-'],
      ['학교·학년', `${h(s.school || '-')} ${h(s.grade || '')}`],
      v.parents && ['학생 연락처', h(fmtPhone(s.student_phone)) || '-'],
      v.address && ['주소', h(s.address || '-')],
      v.parents && ['아버지', `${h(s.father_name || '')} ${h(fmtPhone(s.father_phone)) || (s.father_name ? '' : '-')}${s.sms_target === '아버지' || s.sms_target === '둘 다' ? ' <span class="chip green">문자 받음</span>' : ''}`],
      v.parents && ['어머니', `${h(s.mother_name || '')} ${h(fmtPhone(s.mother_phone)) || (s.mother_name ? '' : '-')}${(s.sms_target || '어머니') === '어머니' || s.sms_target === '둘 다' ? ' <span class="chip green">문자 받음</span>' : ''}`],
      ['등록일', h(s.enrolled_date || '-')],
      s.status !== '재원' && [`${s.status}`, `${h(s.status_date || '')} ${v.memo ? h(s.status_reason || '') : ''}`],
      v.memo && ['특이사항', `<span style="white-space:pre-wrap">${h(s.memo || '-')}</span>`],
    ].filter(Boolean);

    const payTable = (list, kind) => list.length ? `<table class="list"><thead><tr>${kind === '교육비' ? '<th>해당 월</th>' : '<th>내용</th>'}<th>납부일</th><th>금액</th><th>방법</th>${own ? '<th></th>' : ''}</tr></thead><tbody>${list.map((p) => `
        <tr><td>${kind === '교육비' ? h(p.month) : h(p.memo || '-')}</td><td>${h(p.paid_date)}</td><td><b>${won(p.amount)}</b></td><td>${h(p.method || '')}${kind === '교육비' && p.memo ? `<div class="small muted">${h(p.memo)}</div>` : ''}</td>
        ${own ? `<td style="text-align:right"><button class="btn sm danger" data-delpay="${p.id}">삭제</button></td>` : ''}</tr>`).join('')}</tbody></table>
        <div class="small muted" style="margin-top:6px">합계 ${won(list.reduce((a, p) => a + p.amount, 0))}</div>` : '<div class="empty">수납 기록이 없어요</div>';

    el.innerHTML = `
      <div class="no-print"><a href="#/students" class="small muted">← 학생 명부</a></div>
      <div class="card profile mt">
        <div class="profile-photo" id="photoBtn" title="사진 바꾸기">${sAvatar(s, 104)}<span class="no-print">📷</span></div>
        <div class="profile-main">
          <div class="row"><h1>${h(s.name)}</h1>${statusChip(s.status)}${d.siblings && d.siblings.length ? `<span class="chip gold">형제·자매 ${d.siblings.length}명 재원</span>` : ''}</div>
          <div class="muted">${h(s.school || '')} ${h(s.grade || '')}${v.birth && s.birth_date ? ` · ${ageOf(s.birth_date)}` : ''}${d.courses.length ? ` · ${d.courses.filter((c) => c.active).map((c) => h(c.subject)).join(', ')}` : ''}</div>
          ${v.tuition ? `<div class="mt">${d.tuition_paid_this_month ? `<span class="chip green">${Number(d.month.slice(5))}월 교육비 납부</span>` : `<span class="chip red">${Number(d.month.slice(5))}월 교육비 미납</span>`}${v.fees && d.monthly_fee ? ` <span class="chip">월 수강료 ${won(d.monthly_fee)}</span>` : ''}</div>` : ''}
        </div>
        <div class="profile-actions no-print">
          <button class="btn" id="consult">💬 상담 기록</button>
          <button class="btn" id="flag">🚨 걱정 표시</button>
          <button class="btn" onclick="window.print()">🖨️ 인쇄</button>
          ${own ? '<button class="btn primary" id="edit">인적사항 고치기</button>' : ''}
        </div>
      </div>

      <div class="grid g2 mt">
        <div class="card"><h2>인적사항</h2>
          <table class="list kv"><tbody>${info.map(([k, val]) => `<tr><td class="muted">${k}</td><td>${val}</td></tr>`).join('')}</tbody></table>
        </div>
        <div class="card"><h2>수강 과목${v.fees ? ' · 수강료' : ''}</h2>
          ${d.courses.length ? `<table class="list"><tbody>${d.courses.map((c) => `
            <tr style="${c.active ? '' : 'opacity:.5'}"><td><span class="chip">${h(c.subject)}</span></td>
              <td><b>${h(c.name)}</b><div class="small muted row" style="gap:6px">${withAvatar(c.teacher_id, c.teacher_photo_v, c.teacher_name, 18)} ${h(c.days || '')} ${h(c.start_time || '')}</div></td>
              ${v.fees ? `<td style="text-align:right;white-space:nowrap">${won(c.fee)}${c.fee_custom ? '<div class="small muted">개별 금액</div>' : ''}${own ? ` <button class="btn sm no-print" data-fee="${c.id}">수정</button>` : ''}</td>` : ''}</tr>`).join('')}</tbody></table>
            ${v.fees ? `<div class="row mt"><span class="muted">월 수강료 합계</span><span class="space"></span><b style="font-size:18px">${won(d.monthly_fee)}</b></div>` : ''}`
            : `<div class="empty">아직 반에 들어가 있지 않아요${own ? ' — [반 관리]에서 넣어 주세요' : ''}</div>`}
          ${v.siblings ? `
          <h2 class="mt">형제·자매</h2>
          <div class="row">${(d.siblings || []).map((x) => `<a class="sib" href="#/students/${x.id}">${sAvatar(x, 26)}<span><b>${h(x.name)}</b> <span class="small muted">${h(x.school || '')} ${h(x.grade || '')}</span></span>${statusChip(x.status)}${own ? `<button class="btn sm no-print" data-unsib="${x.id}" title="연결 끊기">✕</button>` : ''}</a>`).join('') || '<span class="muted small">우리 학원에 다니는 형제·자매가 없어요</span>'}</div>
          ${s.sibling_note ? `<div class="small mt">📝 ${h(s.sibling_note)}</div>` : ''}
          ${own ? '<button class="btn sm mt no-print" id="sib">＋ 형제·자매 연결</button>' : ''}` : ''}
        </div>
      </div>

      <div class="card mt">
        <div class="row"><h2 style="margin:0">상담 기록 <span class="small muted">모든 선생님 기록 ${d.consultations.length}건</span></h2><span class="space"></span>
          ${subjects.length > 1 ? `<div class="tabs no-print"><button class="btn sm primary" data-subj="">전체</button>${subjects.map((x) => `<button class="btn sm" data-subj="${h(x)}">${h(x)}</button>`).join('')}</div>` : ''}</div>
        <div id="consults" class="mt">${d.consultations.length ? d.consultations.map((k) => `
          <div class="item" data-subject="${h(k.subject || '공통')}">
            <div class="row"><span class="chip green">${h(k.subject || '공통')}</span><span class="chip">${h(k.kind)}</span><span class="small muted">${prettyDate(k.date)}</span>${withAvatar(k.teacher_id, k.teacher_photo_v, k.teacher_name, 20)}</div>
            <div class="content">${h(k.content)}</div>
            ${k.follow_up ? `<div class="follow ${k.follow_up_done ? 'done' : ''}">📌 ${h(k.follow_up)}</div>` : ''}
          </div>`).join('') : '<div class="empty">상담 기록이 없어요</div>'}</div>
      </div>

      ${v.books ? `
      <div class="card mt">
        <div class="row"><h2 style="margin:0">교재 배부 내역</h2><span class="space"></span><button class="btn sm no-print" id="addBook">＋ 교재 배부</button></div>
        ${d.books.length ? `<div class="table-wrap mt"><table class="list"><thead><tr><th>날짜</th><th>과목</th><th>교재</th><th>수량</th><th>가격</th><th>준 사람</th><th>메모</th><th></th></tr></thead><tbody>${d.books.map((b) => `
          <tr><td>${h(b.date)}</td><td>${h(b.subject || '')}</td><td><b>${h(b.title)}</b></td><td>${b.qty}</td><td>${won(b.price)}</td><td>${h(b.given_by_name || '')}</td><td class="small">${h(b.memo || '')}</td>
          <td style="text-align:right">${own || b.given_by === state.me.id ? `<button class="btn sm danger no-print" data-delbook="${b.id}">삭제</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">교재 배부 기록이 없어요</div>'}
      </div>` : ''}

      ${v.tuition || v.bookpay ? `<div class="grid g2 mt">
        ${v.tuition ? `<div class="card"><div class="row"><h2 style="margin:0">교육비 수납 내역</h2><span class="space"></span>${own ? '<button class="btn sm no-print" data-addpay="교육비">＋ 수납 기록</button>' : ''}</div><div class="mt">${payTable(d.tuition, '교육비')}</div></div>` : '<div></div>'}
        ${v.bookpay ? `<div class="card"><div class="row"><h2 style="margin:0">교재비 수납 내역</h2><span class="space"></span>${own ? '<button class="btn sm no-print" data-addpay="교재비">＋ 수납 기록</button>' : ''}</div><div class="mt">${payTable(d.bookpay, '교재비')}</div></div>` : ''}
      </div>` : ''}

      <div class="grid g2 mt">
        <div class="card"><h2>최근 60일 출결 <span class="small muted">결석 ${absent} · 지각/조퇴 ${late}</span></h2>
          ${d.attendance.length ? `<div style="max-height:280px;overflow-y:auto"><table class="list"><tbody>${d.attendance.map((a) => `<tr><td>${prettyDate(a.date)}</td><td class="small">${h(a.course_name)}</td><td>${statusChip(a.status)}</td><td class="small muted">${h(a.memo || '')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">기록이 없어요</div>'}
        </div>
        <div class="card"><h2>피드백</h2>${d.feedbacks.length ? `<div style="max-height:280px;overflow-y:auto">${d.feedbacks.map((f) => `<div class="item"><div class="row"><span class="chip green">${h(f.subject)}</span><b>${h(f.period_title)}</b>${statusChip(f.status)}</div><div class="content small">${h(f.content)}</div></div>`).join('')}</div>` : '<div class="empty">피드백이 없어요</div>'}</div>
      </div>

      ${d.flags.length ? `<div class="card mt"><h2>이탈 신호 표시</h2>${d.flags.map((f) => `<div class="item"><div class="row">${f.resolved ? '<span class="chip">해결됨</span>' : '<span class="chip red">진행 중</span>'}<b>${h(f.reason)}</b><span class="small muted">${h(f.created_by_name || '')} · ${prettyTime(f.created_at)}</span></div>${f.resolution ? `<div class="small muted">→ ${h(f.resolution)}</div>` : ''}</div>`).join('')}</div>` : ''}

      <div class="card mt no-print"><h2>최근 보낸 문자</h2>${d.messages.length ? `<table class="list"><tbody>${d.messages.map((m) => `<tr><td style="white-space:nowrap">${prettyTime(m.created_at)}</td><td>${h(m.kind)}</td><td class="small">${h(fmtPhone(m.to_phone) || '')}</td><td>${statusChip(m.status)}</td><td><details><summary class="small">${h(m.body.slice(0, 30))}…</summary><div class="preview">${h(m.body)}</div></details></td></tr>`).join('')}</tbody></table>` : '<div class="empty">보낸 문자가 없어요</div>'}</div>
      ${own ? '' : '<div class="small muted mt">🔒 원장님이 정한 범위의 정보만 보여요.</div>'}`;

    $('#photoBtn').onclick = () => pickStudentPhoto(id, reload);
    $('#consult').onclick = () => consultModal({ student_id: id });
    $('#flag').onclick = () => flagModal(id);
    $$('[data-subj]', el).forEach((b) => (b.onclick = () => {
      $$('[data-subj]', el).forEach((x) => x.classList.toggle('primary', x === b));
      $$('#consults .item', el).forEach((it) => (it.style.display = !b.dataset.subj || it.dataset.subject === b.dataset.subj ? '' : 'none'));
    }));
    if ($('#addBook')) $('#addBook').onclick = () => modal({
      title: `${s.name} 교재 배부`,
      body: `<div class="grid g2"><label class="field"><span>날짜</span><input type="date" name="date" value="${todayStr()}"></label>
        <label class="field"><span>과목</span><select name="subject"><option value="">선택 안 함</option>${SUBJECTS.map((x) => `<option>${x}</option>`).join('')}</select></label></div>
        <label class="field"><span>교재 이름</span><input type="text" name="title" required placeholder="예: 쎈 수학 중2-1"></label>
        <div class="grid g2"><label class="field"><span>수량</span><input type="text" name="qty" value="1" inputmode="numeric"></label>
        <label class="field"><span>가격 (선택)</span><input type="text" name="price" inputmode="numeric" placeholder="예: 15000"></label></div>
        <label class="field"><span>메모</span><input type="text" name="memo"></label>`,
      onSubmit: async (f) => { await api('POST', `/api/students/${id}/books`, f); toast('기록했어요'); reload(); },
    });
    $$('[data-delbook]', el).forEach((b) => (b.onclick = async () => { if (!confirm('이 교재 배부 기록을 지울까요?')) return; try { await api('DELETE', `/api/books/${b.dataset.delbook}`); reload(); } catch (e) { toast(e.message); } }));
    if (!own) return;

    $('#edit').onclick = () => modal({ title: '인적사항 고치기', wide: true, body: studentForm(s), onSubmit: async (f) => { await api('PATCH', `/api/students/${id}`, f); toast('저장했어요'); reload(); } });
    $$('[data-fee]', el).forEach((b) => (b.onclick = () => {
      const c = d.courses.find((x) => x.id === Number(b.dataset.fee));
      modal({
        title: `${c.name} 수강료`,
        body: `<p class="small muted" style="margin-top:0">반 기본 수강료는 ${won(c.course_fee)}예요. 형제 할인 등으로 이 학생만 다르게 받으면 금액을 적고, 비워 두면 반 기본 금액을 써요.</p>
          <label class="field"><span>이 학생 월 수강료</span><input type="text" name="fee" inputmode="numeric" value="${c.fee_custom ? c.fee : ''}" placeholder="${c.course_fee ?? ''}"></label>`,
        onSubmit: async (f) => { await api('PATCH', '/api/enrollments', { course_id: c.id, student_id: id, fee: f.fee }); toast('저장했어요'); reload(); },
      });
    }));
    if ($('#sib')) $('#sib').onclick = async () => {
      const { students } = await api('GET', '/api/students');
      const ids = new Set((d.siblings || []).map((x) => x.id).concat(id));
      modal({
        title: `${s.name} 형제·자매 연결`,
        body: `<label class="field"><span>함께 다니는 형제·자매</span><select name="sibling_id" required><option value="">고르세요</option>${students.filter((x) => !ids.has(x.id)).map((x) => `<option value="${x.id}">${h(x.name)} (${h(x.school || '')} ${h(x.grade || '')}, ${h(x.status)})</option>`).join('')}</select></label>
          <p class="small muted">연결하면 두 학생 카드에 서로 표시돼요.</p>`,
        submitText: '연결하기',
        onSubmit: async (f) => { await api('POST', `/api/students/${id}/siblings`, f); toast('연결했어요'); reload(); },
      });
    };
    $$('[data-unsib]', el).forEach((b) => (b.onclick = async (e) => { e.preventDefault(); if (!confirm('형제·자매 연결을 끊을까요?')) return; await api('DELETE', `/api/students/${id}/siblings/${b.dataset.unsib}`); reload(); }));
    $$('[data-addpay]', el).forEach((b) => (b.onclick = () => {
      const kind = b.dataset.addpay;
      modal({
        title: `${kind} 수납 기록`,
        body: `${kind === '교육비' ? `<label class="field"><span>몇 월 교육비인가요?</span><input type="month" name="month" value="${thisMonth()}" required></label>` : ''}
          <div class="grid g2"><label class="field"><span>금액</span><input type="text" name="amount" inputmode="numeric" required value="${kind === '교육비' && d.monthly_fee ? d.monthly_fee : ''}"></label>
          <label class="field"><span>납부일</span><input type="date" name="paid_date" value="${todayStr()}" required></label></div>
          <label class="field"><span>결제 방법</span><select name="method">${['카드', '계좌이체', '현금', '지역화폐', '기타'].map((x) => `<option>${x}</option>`).join('')}</select></label>
          <label class="field"><span>${kind === '교재비' ? '내용 (어떤 교재인지)' : '메모'}</span><input type="text" name="memo"></label>`,
        onSubmit: async (f) => { await api('POST', `/api/students/${id}/payments`, { ...f, kind }); toast('기록했어요'); reload(); },
      });
    }));
    $$('[data-delpay]', el).forEach((b) => (b.onclick = async () => { if (!confirm('이 수납 기록을 지울까요?')) return; await api('DELETE', `/api/payments/${b.dataset.delpay}`); reload(); }));
  }

  // ───────── 반 관리 (원장) ─────────
  async function pageCourses(el) {
    const [{ courses }, { teachers }] = await Promise.all([api('GET', '/api/courses?active=all'), api('GET', '/api/teachers')]);
    el.innerHTML = `
      <div class="page-head"><div><h1>반 관리</h1><p>반을 만들고 담당 선생님과 학생을 넣어 주세요. 선생님은 자기 반 학생만 볼 수 있어요.</p></div>
        <button class="btn primary" id="add">＋ 반 만들기</button></div>
      <div class="card"><div class="table-wrap"><table class="list">
        <thead><tr><th>반 이름</th><th>과목</th><th>담당</th><th>요일·시간</th><th>월 수강료</th><th>학생</th><th></th></tr></thead>
        <tbody>${courses.map((c) => `<tr style="${c.active ? '' : 'opacity:.5'}">
          <td><b>${h(c.name)}</b>${c.active ? '' : ' <span class="chip">종료</span>'}${c.room ? `<div class="small muted">${h(c.room)}</div>` : ''}</td>
          <td>${h(c.subject)}</td><td>${c.teacher_name ? withAvatar(c.teacher_id, c.teacher_photo_v, c.teacher_name) : '-'}</td>
          <td>${h(c.days || '-')} ${h(c.start_time || '')}${c.end_time ? '~' + h(c.end_time) : ''}</td>
          <td>${c.fee != null ? Number(c.fee).toLocaleString('ko-KR') + '원' : '-'}</td>
          <td>${c.student_count}명</td>
          <td style="text-align:right;white-space:nowrap"><button class="btn sm" data-stu="${c.id}">학생 넣기</button> <button class="btn sm" data-edit="${c.id}">고치기</button></td></tr>`).join('')}</tbody>
      </table></div>${courses.length ? '' : '<div class="empty">아직 반이 없어요</div>'}</div>`;
    const byId = new Map(courses.map((c) => [c.id, c]));
    const form = (c = {}) => {
      const days = (c.days || '').split(',');
      return `
        <div class="grid g2">
          <label class="field"><span>반 이름</span><input type="text" name="name" value="${h(c.name)}" required placeholder="예: 중2 수학 A"></label>
          <label class="field"><span>과목</span><select name="subject" required>${SUBJECTS.map((s) => `<option ${c.subject === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
          <label class="field"><span>담당 선생님</span><select name="teacher_id"><option value="">없음</option>${teachers.map((t) => `<option value="${t.id}" ${c.teacher_id === t.id ? 'selected' : ''}>${h(t.name)}${t.role === 'owner' ? ' (원장)' : ''}</option>`).join('')}</select></label>
          <label class="field"><span>강의실</span><input type="text" name="room" value="${h(c.room)}" placeholder="예: 1관 201호"></label>
          <label class="field"><span>월 수강료 (기본)</span><input type="text" name="fee" inputmode="numeric" value="${h(c.fee ?? '')}" placeholder="예: 320000"></label>
        </div>
        <label class="field"><span>수업 요일</span><div class="days">${['월', '화', '수', '목', '금', '토', '일'].map((d) => `<label><input type="checkbox" name="day_${d}" ${days.includes(d) ? 'checked' : ''}>${d}</label>`).join('')}</div></label>
        <div class="grid g2">
          <label class="field"><span>시작 시간</span><input type="time" name="start_time" value="${h(c.start_time)}"></label>
          <label class="field"><span>끝 시간</span><input type="time" name="end_time" value="${h(c.end_time)}"></label>
        </div>
        ${c.id ? `<label class="inline-check"><input type="checkbox" name="active" ${c.active ? 'checked' : ''}> 운영 중인 반 (끄면 종료된 반)</label>` : ''}`;
    };
    const toBody = (d, editing) => ({
      name: d.name, subject: d.subject, teacher_id: d.teacher_id || null, room: d.room, start_time: d.start_time, end_time: d.end_time, fee: d.fee,
      days: ['월', '화', '수', '목', '금', '토', '일'].filter((x) => d['day_' + x]).join(','),
      ...(editing ? { active: !!d.active } : {}),
    });
    $('#add').onclick = () => modal({ title: '반 만들기', wide: true, body: form(), onSubmit: async (d) => { await api('POST', '/api/courses', toBody(d)); toast('반을 만들었어요'); reload(); } });
    $$('[data-edit]', el).forEach((b) => (b.onclick = () => {
      const c = byId.get(Number(b.dataset.edit));
      modal({ title: '반 고치기', wide: true, body: form(c), onSubmit: async (d) => { await api('PATCH', `/api/courses/${c.id}`, toBody(d, true)); toast('저장했어요'); reload(); } });
    }));
    $$('[data-stu]', el).forEach((b) => (b.onclick = async () => {
      const c = byId.get(Number(b.dataset.stu));
      const [{ students }, cur] = await Promise.all([api('GET', '/api/students?status=재원'), api('GET', `/api/courses/${c.id}`)]);
      const inSet = new Set(cur.students.map((s) => s.id));
      modal({
        title: `${c.name} 학생 넣기`, wide: true,
        body: `<input type="search" id="find" placeholder="이름·학교로 찾기" style="margin-bottom:8px">
          <div class="checklist">${students.map((s) => `<label data-txt="${h((s.name + ' ' + (s.school || '') + ' ' + (s.grade || '')).toLowerCase())}"><input type="checkbox" name="s_${s.id}" ${inSet.has(s.id) ? 'checked' : ''}> <b>${h(s.name)}</b> <span class="muted small">${h(s.school || '')} ${h(s.grade || '')}</span></label>`).join('') || '<div class="empty">재원생이 없어요. 먼저 학생 명단에서 등록해 주세요.</div>'}</div>
          <div class="small muted" style="margin-top:6px" id="cnt"></div>`,
        onOpen: (f) => {
          const upd = () => ($('#cnt', f).textContent = `${$$('.checklist input:checked', f).length}명 선택`);
          upd();
          $$('.checklist input', f).forEach((i) => (i.onchange = upd));
          $('#find', f).oninput = (e) => { const t = e.target.value.trim().toLowerCase(); $$('.checklist label', f).forEach((l) => (l.style.display = !t || l.dataset.txt.includes(t) ? '' : 'none')); };
        },
        onSubmit: async (d) => {
          const ids = Object.keys(d).filter((k) => k.startsWith('s_')).map((k) => Number(k.slice(2)));
          await api('PUT', `/api/courses/${c.id}/students`, { student_ids: ids });
          toast(`${ids.length}명으로 저장했어요`);
          reload();
        },
      });
    }));
  }

  // ───────── 피드백 기간 (원장) ─────────
  async function pagePeriods(el) {
    const { periods } = await api('GET', '/api/periods');
    el.innerHTML = `
      <div class="page-head"><div><h1>피드백 기간</h1><p>과목별로 언제까지 피드백을 보내야 하는지 정해 주세요. 대시보드에 D-day로 나와요.</p></div>
        <button class="btn primary" id="add">＋ 기간 만들기</button></div>
      <div class="card"><div class="table-wrap"><table class="list">
        <thead><tr><th>이름</th><th>과목</th><th>기간</th><th>상태</th><th>남은 피드백</th><th></th></tr></thead>
        <tbody>${periods.map((p) => `<tr><td><b>${h(p.title)}</b></td><td>${p.subjects.map(h).join(', ')}</td><td>${prettyDate(p.start_date)} ~ ${prettyDate(p.end_date)}</td>
          <td><span class="chip ${p.phase === 'overdue' ? 'red' : p.phase === 'open' ? 'green' : ''}">${h(p.badge)} ${h(p.dday)}</span></td><td>${p.unsent} / ${p.total}</td>
          <td style="text-align:right;white-space:nowrap"><a class="btn sm" href="#/feedback?period=${p.id}">보기</a> <button class="btn sm" data-edit="${p.id}">고치기</button> <button class="btn sm danger" data-del="${p.id}">삭제</button></td></tr>`).join('')}</tbody>
      </table></div>${periods.length ? '' : '<div class="empty">아직 기간이 없어요</div>'}</div>`;
    const byId = new Map(periods.map((p) => [p.id, p]));
    const form = (p = {}) => `
      <label class="field"><span>이름</span><input type="text" name="title" value="${h(p.title)}" required placeholder="예: 11월 수학 피드백"></label>
      <label class="field"><span>과목 (여러 개 고를 수 있어요)</span><div class="days">${SUBJECTS.map((s) => `<label><input type="checkbox" name="sub_${s}" ${(p.subjects || []).includes(s) ? 'checked' : ''}>${s}</label>`).join('')}</div></label>
      <div class="grid g2"><label class="field"><span>시작일</span><input type="date" name="start_date" value="${h(p.start_date)}" required></label><label class="field"><span>마감일</span><input type="date" name="end_date" value="${h(p.end_date)}" required></label></div>`;
    const toBody = (d) => ({ title: d.title, start_date: d.start_date, end_date: d.end_date, subjects: SUBJECTS.filter((s) => d['sub_' + s]) });
    $('#add').onclick = () => modal({ title: '피드백 기간 만들기', body: form(), onSubmit: async (d) => { await api('POST', '/api/periods', toBody(d)); toast('만들었어요'); reload(); } });
    $$('[data-edit]', el).forEach((b) => (b.onclick = () => { const p = byId.get(Number(b.dataset.edit)); modal({ title: '기간 고치기', body: form(p), onSubmit: async (d) => { await api('PATCH', `/api/periods/${p.id}`, toBody(d)); toast('저장했어요'); reload(); } }); }));
    $$('[data-del]', el).forEach((b) => (b.onclick = async () => {
      if (!confirm('이 기간을 지울까요?')) return;
      try { await api('DELETE', `/api/periods/${b.dataset.del}`); toast('지웠어요'); reload(); } catch (e) { toast(e.message); }
    }));
  }

  // ───────── 선생님 계정 (원장) ─────────
  async function pageTeachers(el) {
    const { users } = await api('GET', '/api/users');
    el.innerHTML = `
      <div class="page-head"><div><h1>선생님 계정</h1><p>선생님마다 아이디를 만들어 드리세요. 선생님은 자기 반 학생만 보고, 원장 전용 메뉴는 보이지 않아요.</p></div>
        <button class="btn primary" id="add">＋ 선생님 추가</button></div>
      <div class="card"><div class="table-wrap"><table class="list">
        <thead><tr><th></th><th>이름</th><th>아이디</th><th>역할</th><th>연락처</th><th>담당 반</th><th>상태</th><th></th></tr></thead>
        <tbody>${users.map((u) => `<tr style="${u.active ? '' : 'opacity:.5'}"><td style="width:52px">${avatar(u.id, u.photo_v, u.name, 38)}</td><td><b>${h(u.name)}</b></td><td>${h(u.login_id)}</td><td>${u.role === 'owner' ? '<span class="chip gold">원장</span>' : '<span class="chip">강사</span>'}</td>
          <td>${h(fmtPhone(u.phone))}</td><td>${u.course_count}개</td><td>${u.active ? '<span class="chip green">사용 중</span>' : '<span class="chip">중지</span>'}</td>
          <td style="text-align:right"><button class="btn sm" data-edit="${u.id}">관리</button></td></tr>`).join('')}</tbody>
      </table></div></div>
      <div class="small muted mt">선생님이 그만두시면 [관리] → "사용 중지"를 눌러 주세요. 기록은 그대로 남고 로그인만 막혀요.</div>`;
    const byId = new Map(users.map((u) => [u.id, u]));
    $('#add').onclick = () => modal({
      title: '선생님 추가',
      body: `<label class="field"><span>이름</span><input type="text" name="name" required placeholder="예: Dee"></label>
        <label class="field"><span>아이디 (영어·숫자 3자 이상)</span><input type="text" name="login_id" required autocapitalize="off"></label>
        <label class="field"><span>처음 비밀번호 (8자 이상, 선생님께 알려 드리세요)</span><input type="text" name="password" required minlength="8"></label>
        <label class="field"><span>연락처 (선택)</span><input type="tel" name="phone"></label>
        <label class="field"><span>역할</span><select name="role"><option value="teacher">강사</option><option value="owner">원장 (모든 권한)</option></select></label>`,
      onSubmit: async (d) => { await api('POST', '/api/users', d); toast('계정을 만들었어요'); reload(); },
    });
    $$('[data-edit]', el).forEach((b) => (b.onclick = () => {
      const u = byId.get(Number(b.dataset.edit));
      modal({
        title: `${u.name} 계정 관리`,
        body: `<div class="photo-edit">${avatar(u.id, u.photo_v, u.name, 72)}<div><button type="button" class="btn sm" data-photo>사진 올리기·바꾸기</button>${u.photo_v ? ' <button type="button" class="btn sm danger" data-nophoto>사진 지우기</button>' : ''}<div class="small muted" style="margin-top:4px">얼굴이 잘 보이는 사진이 좋아요. 자동으로 정사각형으로 잘려요.</div></div></div>
          <label class="field"><span>이름</span><input type="text" name="name" value="${h(u.name)}" required></label>
          <label class="field"><span>연락처</span><input type="tel" name="phone" value="${h(fmtPhone(u.phone))}"></label>
          <label class="field"><span>새 비밀번호 (바꿀 때만 적어 주세요)</span><input type="text" name="password" minlength="8"></label>
          ${u.id === state.me.id ? '' : `<label class="inline-check"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> 사용 중 (끄면 로그인할 수 없어요)</label>`}`,
        onOpen: (f, close) => {
          $('[data-photo]', f).onclick = () => pickPhoto(u.id, () => { close(); if (u.id === state.me.id) renderShell(); reload(); });
          const del = $('[data-nophoto]', f);
          if (del) del.onclick = async () => { await api('DELETE', `/api/users/${u.id}/photo`); if (u.id === state.me.id) { state.me.photo_v = null; renderShell(); } close(); toast('사진을 지웠어요'); reload(); };
        },
        onSubmit: async (d) => {
          const body = { name: d.name, phone: d.phone };
          if (d.password) body.password = d.password;
          if (u.id !== state.me.id) body.active = !!d.active;
          await api('PATCH', `/api/users/${u.id}`, body);
          toast('저장했어요');
          reload();
        },
      });
    }));
  }

  // ───────── 설정 (원장) ─────────
  async function pageSettings(el) {
    const s = await api('GET', '/api/settings');
    const m = [...s.mottos, '', '', ''].slice(0, 3);
    el.innerHTML = `
      <div class="page-head"><div><h1>설정</h1></div></div>
      <form class="card" id="f">
        <h2>학원 정보</h2>
        <label class="field"><span>학원 이름</span><input type="text" name="academy_name" value="${h(s.academy_name)}" required></label>
        <label class="field"><span>대시보드 문구 3개 (운영 철학, 공지 등)</span>
          ${m.map((x, i) => `<input type="text" name="motto${i}" value="${h(x)}" style="margin-bottom:6px">`).join('')}</label>
        <h2 class="mt">문자 문구</h2>
        <p class="small muted" style="margin-top:-6px">{ } 안의 글자는 자동으로 바뀌어요.</p>
        <label class="field"><span>출결 알림 — 쓸 수 있는 칸: {학원} {학생} {날짜} {반} {상태} {메모}</span><textarea name="tpl_attendance">${h(s.tpl_attendance)}</textarea></label>
        <label class="field"><span>피드백 — 쓸 수 있는 칸: {학원} {학생} {과목} {반} {내용} {선생님}</span><textarea name="tpl_feedback" style="min-height:120px">${h(s.tpl_feedback)}</textarea></label>
        <h2 class="mt">강사에게 보여 줄 학생 정보</h2>
        <p class="small muted" style="margin-top:-6px">원장님은 항상 전부 볼 수 있어요. 강사는 체크한 항목만, 그리고 자기 반 학생만 볼 수 있어요. 수납 기록은 원장님만 쓸 수 있어요.</p>
        <div class="view-grid">${Object.entries(s.teacher_view_labels).map(([k, l]) => `<label class="inline-check"><input type="checkbox" name="tv_${k}" ${s.teacher_view[k] ? 'checked' : ''}> ${h(l)}</label>`).join('')}</div>
        <h2 class="mt">문자 발송 방식</h2>
        <label class="inline-check" style="display:flex;margin-bottom:6px"><input type="radio" name="send_mode" value="preview" ${s.send_mode !== 'real' ? 'checked' : ''}> 미리보기 (연습용 — 실제로 나가지 않고 기록만 남아요)</label>
        <label class="inline-check" style="display:flex"><input type="radio" name="send_mode" value="real" ${s.send_mode === 'real' ? 'checked' : ''} ${s.solapi_ready ? '' : 'disabled'}> 실제 발송 (솔라피로 학부모님께 문자가 나가요)</label>
        <p class="small ${s.solapi_ready ? 'muted' : ''}" style="${s.solapi_ready ? '' : 'color:var(--orange)'}">${s.solapi_ready ? '✅ 솔라피 연결 준비가 끝났어요.' : '⚠️ 솔라피 키가 아직 등록되지 않았어요. Cloudflare에 키를 넣으면 "실제 발송"을 고를 수 있어요.'}</p>
        <div class="err"></div>
        <div class="row mt"><span class="space"></span><button class="btn primary">저장하기</button></div>
      </form>`;
    $('#f').onsubmit = async (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(e.target));
      try {
        const teacher_view = Object.fromEntries(Object.keys(s.teacher_view_labels).map((k) => [k, !!d['tv_' + k]]));
        await api('PUT', '/api/settings', { academy_name: d.academy_name, mottos: [d.motto0, d.motto1, d.motto2], tpl_attendance: d.tpl_attendance, tpl_feedback: d.tpl_feedback, send_mode: d.send_mode, teacher_view });
        state.academy = d.academy_name;
        toast('저장했어요');
        renderShell();
        router();
      } catch (err) { $('.err', e.target).textContent = err.message; }
    };
  }

  // ───────── 내 정보 ─────────
  async function pageMe(el) {
    el.innerHTML = `
      <div class="page-head"><div><h1>내 정보</h1><p>${h(state.me.name)} · ${state.me.role === 'owner' ? '원장' : '강사'} · 아이디 ${h(state.me.login_id)}</p></div></div>
      <div class="card" style="max-width:440px">
        <h2>내 사진</h2>
        <div class="photo-edit">${avatar(state.me.id, state.me.photo_v, state.me.name, 72)}<div><button class="btn primary sm" id="photo">사진 올리기·바꾸기</button>${state.me.photo_v ? ' <button class="btn sm danger" id="nophoto">지우기</button>' : ''}<div class="small muted" style="margin-top:4px">다른 선생님과 원장님 화면에서 내 이름 옆에 나와요.</div></div></div>
      </div>
      <form class="card" id="f" style="max-width:440px">
        <h2>비밀번호 바꾸기</h2>
        <label class="field"><span>지금 비밀번호</span><input type="password" name="current" required autocomplete="current-password"></label>
        <label class="field"><span>새 비밀번호 (8자 이상)</span><input type="password" name="next" required minlength="8" autocomplete="new-password"></label>
        <label class="field"><span>새 비밀번호 한 번 더</span><input type="password" name="next2" required autocomplete="new-password"></label>
        <div class="err"></div>
        <button class="btn primary">바꾸기</button>
      </form>`;
    $('#photo').onclick = () => pickPhoto(state.me.id, () => { renderShell(); router(); });
    if ($('#nophoto')) $('#nophoto').onclick = async () => { await api('DELETE', `/api/users/${state.me.id}/photo`); state.me.photo_v = null; toast('사진을 지웠어요'); renderShell(); router(); };
    $('#f').onsubmit = async (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(e.target));
      if (d.next !== d.next2) return ($('.err', e.target).textContent = '새 비밀번호 두 개가 서로 달라요');
      try { await api('POST', '/api/me/password', d); toast('비밀번호를 바꿨어요'); e.target.reset(); } catch (err) { $('.err', e.target).textContent = err.message; }
    };
  }

  const PAGES = {
    '': { render: pageDashboard },
    attendance: { render: pageAttendance },
    feedback: { render: pageFeedback },
    risks: { render: pageRisks },
    messages: { render: pageMessages },
    consultations: { render: pageConsultations },
    students: { render: pageStudents },
    courses: { render: pageCourses, owner: true },
    periods: { render: pagePeriods, owner: true },
    teachers: { render: pageTeachers, owner: true },
    settings: { render: pageSettings, owner: true },
    me: { render: pageMe },
  };

  // ───────── 시작 ─────────
  async function start() {
    try {
      const [me, st] = await Promise.all([api('GET', '/api/me'), api('GET', '/api/settings')]);
      if (me.user.role === 'student') throw new Error('학생 계정');
      state.me = me.user;
      state.academy = st.academy_name || '학원';
      document.title = state.academy;
      renderShell();
      router();
    } catch {
      if (!state.me) showLogin();
    }
  }
  window.addEventListener('hashchange', router);
  start();
})();
