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
  const isManager = () => state.me && state.me.role === 'teacher' && state.me.staff_role === 'manager';
  const canEditStudents = () => isOwner() || isManager(); // 원장·감독
  const roleLabel = (u) => (u.role === 'owner' ? '원장' : u.staff_role === 'manager' ? '감독' : '강사');
  const roleChip = (u) => (u.role === 'owner' ? '<span class="chip gold">원장</span>' : u.staff_role === 'manager' ? '<span class="chip blue">감독</span>' : '<span class="chip">강사</span>');
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

  // 반 시간표 글자: "월·수 18:00~20:00 / 금 19:00~21:00"
  const DAYS = ['월', '화', '수', '목', '금', '토', '일'];
  function courseTimes(c) {
    let t = {};
    try { t = c.times ? JSON.parse(c.times) : {}; } catch {}
    const days = (c.days || '').split(',').filter(Boolean);
    const out = {};
    for (const d of DAYS) {
      if (t[d]) out[d] = { start: t[d].start || '', end: t[d].end || '' };
      else if (days.includes(d)) out[d] = { start: c.start_time || '', end: c.end_time || '' };
    }
    return out;
  }
  function scheduleText(c) {
    const t = courseTimes(c);
    const groups = [];
    for (const d of DAYS) {
      if (!t[d]) continue;
      const span = t[d].start ? `${t[d].start}${t[d].end ? '~' + t[d].end : ''}` : '';
      const g = groups.find((x) => x.span === span);
      if (g) g.days.push(d); else groups.push({ span, days: [d] });
    }
    return groups.map((g) => `${g.days.join('·')} ${g.span}`.trim()).join(' / ') || '-';
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
        <h1>${h(status.academy_name)}${SCORE ? ' 채점' : ''}</h1>
        <p>${SCORE ? '단어시험 채점 · 선생님 로그인' : '원장님·선생님 로그인'}</p>
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
    { group: '원장 전용', owner: true, items: [['teachers', '👥', '선생님 계정'], ['courses', '🗂️', '반 관리'], ['periods', '🗓️', '피드백 기간'], ['bills', '🧾', '청구서 보내기'], ['payimport', '💳', '결제·입금 대조'], ['settings', '⚙️', '설정']] },
    { group: '학생 관리', items: [['attendance', '✅', '출결·수업 일지'], ['word', '📝', '단어시험 채점'], ['logs', '📒', '일지 모아 보기'], ['progress', '📈', '진도표'], ['feedback', '📝', '피드백 작성'], ['risks', '🚨', '이탈 신호 관리'], ['messages', '📨', '피드백·문자 발송 기록'], ['consultations', '💬', '상담 정리']] },
    { group: '기본 정보', items: [['students', '🎒', '학생 명부'], ['books', '📚', '교재 관리'], ['courses', '🗂️', '반 학생 넣기', 'manager']] },
  ];

  // 채점 전용 앱(/score): 메뉴 없이 채점 화면만
  const SCORE = window.APP_MODE === 'score';
  function renderScoreShell() {
    const me = state.me;
    $('#app').innerHTML = `
      <div class="score-shell" id="shell">
        <div class="score-top"><div class="brand-mark">채</div><div style="flex:1"><b>${h(state.academy)} 채점</b><div class="small">${h(me.name)} ${roleLabel(me)}</div></div>
          <button class="btn sm" id="logout">로그아웃</button></div>
        <main class="main" id="main"></main>
      </div>`;
    $('#logout').onclick = async () => { await api('POST', '/api/logout').catch(() => {}); state.me = null; location.hash = '#/'; showLogin(); };
  }
  function renderShell() {
    if (SCORE) return renderScoreShell();
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
                ${g.items.filter((it) => it[3] !== 'manager' || isManager()).map(([k, ico, label]) => `<a href="#/${k}" data-nav="${k}"><span class="ico">${ico}</span>${h(label)}</a>`).join('')}
              </div>`).join('')}
          </nav>
          <div class="side-foot">
            <div class="who">${avatar(me.id, me.photo_v, me.name, 36)}<div>${h(me.name)} <small>${roleLabel(me)} · ${h(me.login_id)}</small></div></div>
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
    const key = SCORE ? 'word' : parts[0] || '';
    $$('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === key));
    if (!SCORE) $('#shell').classList.remove('menu-open');
    const main = $('#main');
    const page = PAGES[key];
    if (!page || (page.owner && !isOwner()) || (page.allow && !page.allow())) {
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
    const greet = d.user.role === 'owner' ? `${h(d.user.name)} 원장님, 오늘도 좋은 하루 되세요.` : d.user.staff_role === 'manager' ? `${h(d.user.name)} 감독님, 오늘도 잘 부탁드려요.` : `${h(d.user.name)}쌤, 오늘도 잘 부탁드려요.`;
    const [y, m, dd] = d.today.split('-');
    const alertTxt = s.today_alerts.length ? s.today_alerts.map((a) => `${a.status} ${a.n}`).join(' · ') : '지각·결석 없음';
    const checked = s.today_courses.filter((c) => c.checked_count > 0).length;
    const ml = d.missing_logs || [];
    el.innerHTML = `
      ${ml.length ? `<div class="banner warn">📘 <b>아직 안 쓴 수업 일지 ${ml.length}개</b> — ${ml.slice(0, 3).map((m) => `<a href="#/attendance?date=${m.date}&course=${m.course_id}">${prettyDate(m.date)} ${h(m.course_name)}${isOwner() || isManager() ? ` (${h(m.teacher_name || '')})` : ''}</a>`).join(', ')}${ml.length > 3 ? ` 외 ${ml.length - 3}개` : ''} <a href="#/logs" class="space-l">모아 보기 →</a></div>` : ''}
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
              <td style="width:110px">${h(c.start_time || '')}${c.end_time ? `<div class="small muted">~${h(c.end_time)}</div>` : ''}</td>
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
      <div class="page-head"><div><h1>출결·수업 일지</h1><p>출결을 체크하면 지각·결석·조퇴는 학부모님께 바로 문자가 가요. 아래에 그날 수업 일지도 적어 주세요.</p></div>
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
      <div id="sheet"></div>
      <div id="logbox"></div>`;

    const go = (cid, dt = date) => (location.hash = `#/attendance?date=${dt}${cid ? `&course=${cid}` : ''}`);
    $('#date').onchange = (e) => go(null, e.target.value);
    $$('[data-course]', el).forEach((b) => (b.onclick = () => go(b.dataset.course)));
    if ($('#other')) $('#other').onchange = (e) => e.target.value && go(e.target.value);
    if (courseId) {
      await renderSheet($('#sheet'), courseId, date);
      await renderLog($('#logbox'), courseId, date);
    }
  }

  // ───────── 수업 일지 ─────────
  async function renderLog(box, courseId, date) {
    const [{ log, notes, recent, units, hw_miss, fields, words }, att] = await Promise.all([api('GET', `/api/classlog?course_id=${courseId}&date=${date}`), api('GET', `/api/attendance?course_id=${courseId}&date=${date}`)]);
    const noteOf = new Map(notes.map((n) => [n.student_id, n]));
    const wordOf = new Map();
    for (const w of words || []) { if (!wordOf.has(w.student_id)) wordOf.set(w.student_id, []); wordOf.get(w.student_id).push(w); }
    const hasWords = (words || []).length > 0;
    const missOf = new Map(hw_miss.map((x) => [x.student_id, x]));
    const logId = log ? log.id : -1;
    const openUnits = units.filter((u) => !u.done_date || u.done_log_id === logId);
    const doneN = units.filter((u) => u.done_date).length;
    const bookNames = [...new Set(units.map((u) => u.book || ''))];
    const chosenBooks = new Set(log && log.books ? log.books.split(', ') : units.filter((u) => u.done_log_id === logId).map((u) => u.book || ''));
    let extras = {};
    try { extras = log && log.extras ? JSON.parse(log.extras) : {}; } catch {}
    const seg = (name, opts, val) => `<div class="seg sm">${opts.map(([v, l]) => `<button type="button" data-seg="${name}" data-v="${v}" class="${val === v ? 'on' : ''}">${l}</button>`).join('')}<input type="hidden" name="${name}" value="${h(val || '')}"></div>`;
    box.innerHTML = `
      <div class="card mt">
        <div class="row"><h2 style="margin:0">📘 ${prettyDate(date)} 수업 일지</h2><span class="space"></span>${log ? `<span class="small muted">${h(log.teacher_name || '')} · ${prettyTime(log.updated_at)} 저장</span>` : '<span class="chip orange">아직 안 씀</span>'}</div>
        <form id="logf" class="mt">
          <label class="field"><span>수업 내용 · 진도</span><textarea name="content" placeholder="예: 일차함수 그래프 그리기, 교재 p.38~44">${h(log ? log.content || '' : '')}</textarea></label>
          <div class="field"><div class="row"><span class="small muted">📚 교재 · 단원 — 눌러서 고르세요 · ${units.length ? `진도율 ${Math.round((doneN / units.length) * 100)}% (${doneN}/${units.length})` : '아직 교재·단원이 없어요'}</span><span class="space"></span><a href="#" id="editUnits" class="small">교재·단원·기타 항목 ${units.length || fields.length ? '고치기' : '설정하기'}</a></div>
            ${bookNames.filter(Boolean).length ? `<div class="chips mt-s">${bookNames.filter(Boolean).map((b) => `<button type="button" class="pick ${chosenBooks.has(b) ? 'on' : ''}" data-book="${h(b)}">📘 ${h(b)}</button>`).join('')}</div>` : ''}
            <div id="unitArea">${bookNames.map((b) => {
              const list = units.filter((u) => (u.book || '') === b && (!u.done_date || u.done_log_id === logId));
              const show = !b || chosenBooks.has(b) || !bookNames.filter(Boolean).length;
              return `<div class="unitgrp" data-ubook="${h(b)}" ${show ? '' : 'hidden'}>${b ? `<div class="small muted" style="margin:8px 0 4px">${h(b)} 단원</div>` : ''}${list.length ? `<div class="chips">${list.map((u) => `<label class="pick ${u.done_log_id === logId ? 'on' : ''}"><input type="checkbox" name="u_${u.id}" ${u.done_log_id === logId ? 'checked' : ''} hidden>${h(u.title)}${u.planned_date ? ` <span class="small ${u.planned_date < date && !u.done_date ? 'red-t' : 'muted'}">${u.planned_date.slice(5).replace('-', '/')}</span>` : ''}</label>`).join('')}</div>` : '<div class="small muted">🎉 이 교재 단원을 모두 마쳤어요</div>'}</div>`;
            }).join('')}</div>
          </div>
          ${att.course.subject === '영어' || hasWords ? `<div class="field"><span class="small muted">🔤 영단어 시험: ${hasWords ? `${new Set(words.map((w) => w.student_id)).size}명 · 통과 ${new Set(words.filter((w) => w.passed).map((w) => w.student_id)).size}명 (학생별 표에 보여요)` : '아직 기록이 없어요'} · <a href="#/word?date=${date}&course=${courseId}">단어시험 채점하기 →</a></span></div>` : ''}
          ${fields.length ? `<div class="field"><span class="small muted">🗂️ 기타 항목</span>${fields.map((fd, i) => `
            <div class="row" style="margin-top:6px"><b class="small" style="min-width:90px">${h(fd.name)}</b>
              ${fd.options && fd.options.length ? `<div class="chips">${fd.options.map((o) => `<button type="button" class="pick ${extras[fd.name] === o ? 'on' : ''}" data-ex="${i}" data-v="${h(o)}">${h(o)}</button>`).join('')}</div>` : `<input type="text" data-ext="${i}" value="${h(extras[fd.name] || '')}" style="flex:1">`}
            </div>`).join('')}</div>` : ''}
          <label class="field"><span>숙제</span><input type="text" name="homework" value="${h(log ? log.homework || '' : '')}" placeholder="예: 쎈 p.45~50"></label>
          ${att.rows.length ? `<div class="field"><div class="row"><span class="small muted">학생별 숙제 검사 · 성취도 · 메모 (선생님들끼리만 봐요 · 학부모 문자로 나가지 않아요)</span><span class="space"></span><button type="button" class="btn sm" id="hwAll">숙제 모두 ○</button></div>
            <div class="table-wrap"><table class="list logtable"><thead><tr><th>학생</th><th>출결</th>${hasWords ? '<th>단어시험</th>' : ''}<th>숙제 검사</th><th>성취도</th><th>메모</th></tr></thead><tbody>${att.rows.map((r) => {
              const n = noteOf.get(r.student_id) || {};
              const m = missOf.get(r.student_id);
              return `<tr data-sid="${r.student_id}"><td style="min-width:130px"><div class="row" style="flex-wrap:nowrap">${sAvatar({ id: r.student_id, name: r.name, photo_v: r.photo_v }, 26)}<div><b>${h(r.name)}</b>${m && m.miss ? `<div class="small red-t">최근 숙제 × ${m.miss}번</div>` : ''}</div></div></td>
                <td>${r.status ? statusChip(r.status) : '<span class="muted small">-</span>'}</td>
                ${hasWords ? `<td>${(wordOf.get(r.student_id) || []).map((w) => `<span class="wchip ${w.passed ? 'ok' : 'no'}">${w.attempt > 1 ? '재 ' : ''}${w.score}/${w.total} ${w.passed ? '✓' : '✗'}</span>`).join(' ') || '<span class="muted small">-</span>'}</td>` : ''}
                <td>${seg('hw_' + r.student_id, [['○', '○'], ['△', '△'], ['×', '×']], n.hw)}</td>
                <td>${seg('ach_' + r.student_id, [['상', '상'], ['중', '중'], ['하', '하']], n.achieve)}</td>
                <td style="min-width:200px"><input type="text" name="note_${r.student_id}" value="${h(n.note || '')}" placeholder="예: 질문 많이 함, 계산 실수"></td></tr>`;
            }).join('')}</tbody></table></div></div>` : ''}
          <div class="row"><span class="space"></span><button class="btn primary">일지 저장</button></div>
        </form>
        ${recent.length ? `<div class="small muted mt"><b>지난 수업</b>${recent.map((x) => `<div style="margin-top:4px">${prettyDate(x.date)} — ${x.books ? `📘 ${h(x.books)} ` : ''}${h(x.content || '')}${x.homework ? ` · 숙제: ${h(x.homework)}` : ''}</div>`).join('')}</div>` : ''}
      </div>`;
    $$('[data-seg]', box).forEach((b) => (b.onclick = () => {
      const wrap = b.parentElement, hid = $('input[type=hidden]', wrap);
      const on = !b.classList.contains('on');
      $$('button', wrap).forEach((x) => x.classList.remove('on'));
      if (on) b.classList.add('on');
      hid.value = on ? b.dataset.v : '';
    }));
    $$('label.pick input', box).forEach((cb) => (cb.onchange = () => {
      cb.parentElement.classList.toggle('on', cb.checked);
      const g = cb.closest('.unitgrp');
      if (cb.checked && g && g.dataset.ubook) { const bb = $(`[data-book="${CSS.escape(g.dataset.ubook)}"]`, box); if (bb && !bb.classList.contains('on')) bb.click(); }
    }));
    $$('[data-book]', box).forEach((b) => (b.onclick = () => {
      b.classList.toggle('on');
      const on = b.classList.contains('on');
      const g = $(`.unitgrp[data-ubook="${CSS.escape(b.dataset.book)}"]`, box);
      if (g) g.hidden = !on;
      if (!on && g) $$('input', g).forEach((i) => { i.checked = false; i.parentElement.classList.remove('on'); });
    }));
    $$('[data-ex]', box).forEach((b) => (b.onclick = () => {
      const on = !b.classList.contains('on');
      $$(`[data-ex="${b.dataset.ex}"]`, box).forEach((x) => x.classList.remove('on'));
      if (on) b.classList.add('on');
    }));
    if ($('#hwAll', box)) $('#hwAll', box).onclick = () => $$('[data-seg^="hw_"][data-v="○"]', box).forEach((b) => { if (!b.classList.contains('on')) b.click(); });
    $('#editUnits', box).onclick = (e) => { e.preventDefault(); setupModal(courseId, () => renderLog(box, courseId, date)); };
    $('#logf', box).onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      const notesBody = att.rows.map((r) => ({ student_id: r.student_id, note: f['note_' + r.student_id] || '', hw: f['hw_' + r.student_id] || '', achieve: f['ach_' + r.student_id] || '' }));
      const unit_ids = Object.keys(f).filter((k) => k.startsWith('u_')).map((k) => Number(k.slice(2)));
      try {
        const books = $$('[data-book].on', box).map((b) => b.dataset.book);
        const ex = {};
        fields.forEach((fd, i) => {
          const on = $(`[data-ex="${i}"].on`, box), tx = $(`[data-ext="${i}"]`, box);
          const v = on ? on.dataset.v : tx ? tx.value.trim() : '';
          if (v) ex[fd.name] = v;
        });
        await api('PUT', '/api/classlog', { course_id: courseId, date, content: f.content, homework: f.homework, notes: notesBody, unit_ids, books, extras: ex });
        toast('수업 일지를 저장했어요');
        renderLog(box, courseId, date);
      } catch (err) { toast(err.message); }
    };
  }

  // 반 수업 설정: 교재명 · 교재별 단원 · 일지 기타 항목 (반 관리 / 진도표 / 일지에서 열어요)
  async function unitsModal(courseId, done) { return setupModal(courseId, done); }
  async function setupModal(courseId, done) {
    const [{ course, units }, cat, crs] = await Promise.all([api('GET', `/api/courses/${courseId}/units`), api('GET', '/api/catalog').catch(() => ({ books: [] })), api('GET', '/api/courses')]);
    let fields = [];
    try { fields = JSON.parse(course.log_fields || '[]') || []; } catch {}
    const groups = [];
    for (const u of units) {
      const k = u.book || '';
      let g = groups.find((x) => x.book === k);
      if (!g) groups.push((g = { book: k, units: [] }));
      g.units.push(u);
    }
    if (!groups.length) groups.push({ book: '', units: [] });
    const others = crs.courses.filter((c) => c.id !== courseId);
    const bookBlock = (g) => `<div class="bkblock card">
      <div class="row"><input type="text" class="bk-name-in" list="catList" value="${h(g.book)}" placeholder="교재명 (예: 쎈 수학 중2-1)" style="flex:1"><button type="button" class="btn sm danger" data-rmbk>교재 빼기</button></div>
      <textarea class="bk-units" style="min-height:120px;margin-top:6px" placeholder="한 줄에 한 단원 (예정일은 | 뒤에, 선택)&#10;1단원 일차함수의 뜻 | 2026-12-01&#10;2단원 일차함수의 그래프">${h(g.units.map((u) => `${u.title}${u.planned_date ? ' | ' + u.planned_date : ''}`).join('\n'))}</textarea>
      ${g.units.some((u) => u.done_date) ? `<div class="small muted">완료: ${g.units.filter((u) => u.done_date).map((u) => h(u.title)).join(', ')}</div>` : ''}
    </div>`;
    const fieldRow = (f = { name: '', options: [] }) => `<div class="row fieldrow" style="margin-bottom:6px"><input type="text" class="f-name" value="${h(f.name)}" placeholder="항목 이름 (예: 단어시험)" style="flex:1"><input type="text" class="f-opts" value="${h((f.options || []).join(', '))}" placeholder="선택지를 쉼표로 (예: 통과, 재시험) · 비우면 글로 적기" style="flex:2"><button type="button" class="btn sm danger" data-rmf>✕</button></div>`;
    modal({
      title: `${course.name} · 수업 일지 설정`, wide: true, submitText: '저장',
      body: `
        <datalist id="catList">${cat.books.map((b) => `<option value="${h(b.name)}">`).join('')}</datalist>
        ${others.length ? `<div class="row small" style="margin-bottom:10px"><span class="muted">다른 반 설정 그대로 가져오기</span><select id="copyFrom" style="width:auto"><option value="">— 반 고르기 —</option>${others.map((c) => `<option value="${c.id}">${h(c.name)}</option>`).join('')}</select><button type="button" class="btn sm" id="copyGo">가져오기</button></div>` : ''}
        <div class="form-sec">📚 교재와 단원</div>
        <p class="small muted" style="margin-top:-4px">수업 일지에서 교재를 누르면 그 교재의 단원이 나와요. 단원을 누르면 진도표에 "완료"로 기록돼요. 교재명은 [교재 관리]에 있는 교재를 목록에서 고를 수도 있어요.</p>
        <div id="bkList">${groups.map(bookBlock).join('')}</div>
        <button type="button" class="btn sm" id="bkAdd">＋ 교재 추가</button>
        <div class="form-sec mt">🗂️ 기타 항목 (원하는 만큼)</div>
        <p class="small muted" style="margin-top:-4px">예) 단어시험: 통과, 재시험 / 수업 태도: 좋음, 보통, 산만 / 클리닉: 함, 안 함 / 다음 수업 준비물 (선택지 없이 글로)</p>
        <div id="fList">${(fields.length ? fields : [{ name: '', options: [] }]).map(fieldRow).join('')}</div>
        <button type="button" class="btn sm" id="fAdd">＋ 항목 추가</button>`,
      onOpen: (f, close) => {
        const wireBk = (el) => ($('[data-rmbk]', el).onclick = () => el.remove());
        const wireF = (el) => ($('[data-rmf]', el).onclick = () => el.remove());
        $$('.bkblock', f).forEach(wireBk);
        $$('.fieldrow', f).forEach(wireF);
        $('#bkAdd', f).onclick = () => { const d = document.createElement('div'); d.innerHTML = bookBlock({ book: '', units: [] }); const el = d.firstElementChild; $('#bkList', f).appendChild(el); wireBk(el); $('.bk-name-in', el).focus(); };
        $('#fAdd', f).onclick = () => { const d = document.createElement('div'); d.innerHTML = fieldRow(); const el = d.firstElementChild; $('#fList', f).appendChild(el); wireF(el); $('.f-name', el).focus(); };
        if ($('#copyGo', f)) $('#copyGo', f).onclick = async () => {
          const from = $('#copyFrom', f).value;
          if (!from) return toast('가져올 반을 골라 주세요');
          if (!confirm('그 반의 교재·단원·기타 항목으로 바꿀까요? (이미 완료한 단원 기록은 남아요)')) return;
          await api('POST', `/api/courses/${courseId}/copy-setup`, { from_course_id: Number(from) });
          toast('가져왔어요');
          close();
          setupModal(courseId, done);
        };
      },
      onSubmit: async (_d, f) => {
        const keyOf = new Map(units.map((u) => [`${u.book || ''}|${u.title}`, u.id]));
        const list = [];
        for (const blk of $$('.bkblock', f)) {
          const book = $('.bk-name-in', blk).value.trim();
          for (const line of $('.bk-units', blk).value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
            const [t, dt] = line.split('|').map((x) => x.trim());
            const m = (dt || '').match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
            list.push({ id: keyOf.get(`${book}|${t}`) || null, book, title: t, planned_date: m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null });
          }
          if (book && !$('.bk-units', blk).value.trim()) list.push({ id: keyOf.get(`${book}|(전체)`) || null, book, title: '(전체)' });
        }
        const fieldsBody = $$('.fieldrow', f).map((r) => ({ name: $('.f-name', r).value.trim(), options: $('.f-opts', r).value })).filter((x) => x.name);
        await api('PUT', `/api/courses/${courseId}/units`, { units: list });
        await api('PUT', `/api/courses/${courseId}/log-fields`, { fields: fieldsBody });
        toast('수업 일지 설정을 저장했어요');
        done && done();
      },
    });
  }


  // ───────── 영단어 시험 채점 (휴대폰용) ─────────
  // 시험지 사진을 작게 줄여요 (긴 쪽 1400px, 용량이 크면 화질을 낮춰요)
  async function shrinkPhoto(file) {
    const u = URL.createObjectURL(file);
    const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('사진을 열 수 없어요')); i.src = u; });
    const M = 1400, sc = Math.min(1, M / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(u);
    let q = 0.72, out = c.toDataURL('image/jpeg', q);
    while (out.length > 850000 && q > 0.3) { q -= 0.1; out = c.toDataURL('image/jpeg', q); }
    return out;
  }

  async function pageWord(el, _p, query) {
    const date = query.date || todayStr();
    const [todayRaw, allRaw] = await Promise.all([api('GET', `/api/attendance/today?date=${date}`), api('GET', '/api/courses')]);
    // 영어 반만 보여요
    const todayData = { courses: todayRaw.courses.filter((c) => c.subject === '영어') };
    const all = { courses: allRaw.courses.filter((c) => c.subject === '영어') };
    const courseId = (all.courses.some((c) => c.id === Number(query.course)) && Number(query.course)) || (todayData.courses[0] && todayData.courses[0].id) || (all.courses[0] && all.courses[0].id) || null;
    const others = all.courses.filter((c) => !todayData.courses.some((t) => t.id === c.id));
    if (!all.courses.length) {
      el.innerHTML = `<div class="page-head"><div><h1>📝 단어시험 채점</h1></div></div><div class="card empty">${isOwner() ? '과목이 "영어"인 반이 없어요. [반 관리]에서 영어 반의 과목을 "영어"로 정해 주세요.' : '내가 맡은 영어 반이 없어요.'}</div>`;
      return;
    }
    el.innerHTML = `
      <div class="page-head"><div><h1>📝 단어시험 채점</h1><p>채점한 시험지를 찍고 맞은 개수만 누르면 돼요. 결과와 시험지가 학생·담당 선생님께 가고, 수업 일지에 기록돼요.</p></div>
        <input type="date" id="wdate" value="${h(date)}" style="width:auto"></div>
      <div class="card">
        <div class="small muted" style="margin-bottom:8px">영어 반 ${all.courses.length}개${todayData.courses.length ? ` · 오늘 수업 ${todayData.courses.length}개는 앞에 있어요` : ''}</div>
        <div class="course-pick">${[...todayData.courses.map((c) => ({ ...c, today: true })), ...others].map((c) => `<button data-wc="${c.id}" class="${c.id === courseId ? 'on' : ''}"><b>${h(c.name)}</b><span class="small muted">${c.today ? `오늘 ${h(c.start_time || '')} · ` : ''}${h(c.teacher_name || '')}</span>${c.today ? '<span class="chip green" style="margin-top:4px">오늘</span>' : ''}</button>`).join('')}</div>
      </div>
      <div id="wbox"></div>`;
    const go = (cid, dt = date) => (location.hash = `#/word?date=${dt}${cid ? `&course=${cid}` : ''}`);
    $('#wdate').onchange = (e) => go(courseId, e.target.value);
    $$('[data-wc]', el).forEach((b) => (b.onclick = () => go(b.dataset.wc)));
    if (courseId) await renderWordClass($('#wbox'), courseId, date);
  }

  async function renderWordClass(box, courseId, date) {
    const d = await api('GET', `/api/word/class?course_id=${courseId}&date=${date}`);
    const st = { book: (d.last && d.last.book) || '', range: (d.last && d.last.range) || '', total: (d.last && d.last.total) || 20, round: (d.last && d.last.round) || 1, kind: (d.last && d.last.kind) || '한글뜻' };
    const kinds = d.word_kinds || { 한글뜻: 90, 스펠링: 80, 혼합: 90 };
    const wLabel = (t) => [t.round ? `${t.round}회독` : '', t.kind || ''].filter(Boolean).join(' · ');
    // 수업 있는 요일의 날짜들 (4주 전 ~ 2주 뒤)
    const classDays = (d.course.days || '').split(',').filter(Boolean);
    const classDates = [];
    if (classDays.length) {
      const base = new Date(date + 'T00:00:00');
      for (let i = -28; i <= 14; i++) {
        const x = new Date(base); x.setDate(x.getDate() + i);
        const wd = '일월화수목금토'[x.getDay()];
        if (classDays.includes(wd)) classDates.push({ v: `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`, label: `${x.getMonth() + 1}/${x.getDate()}(${wd})` });
      }
    }
    const books = [...new Set([...d.units.map((u) => u.book).filter(Boolean), ...d.word_books.map((b) => b.name)])];
    const byStu = new Map();
    for (const t of d.tests) { if (!byStu.has(t.student_id)) byStu.set(t.student_id, []); byStu.get(t.student_id).push(t); }
    const pendingBy = new Map(d.pending.map((t) => [t.student_id, t]));
    const chip = (t) => `<span class="wchip ${t.passed ? 'ok' : 'no'}" data-wt="${t.id}" title="${h(wLabel(t))}">${t.range ? `<b>${h(t.range.replace(/^Day\s*/, 'D').replace(/^Unit\s*/, 'U'))}</b> ` : ''}${t.attempt > 1 ? '재 ' : ''}${t.score}/${t.total} ${t.passed ? '✓' : '✗'}${t.photo_v ? ' 📷' : ''}</span>`;
    const rangeOpts = () => {
      const fromUnits = d.units.filter((u) => u.book === st.book).map((u) => u.title);
      const wb = d.word_books.find((b) => b.name === st.book);
      const days = wb ? Array.from({ length: wb.days }, (_, i) => `${wb.unit === 'Unit' ? 'Unit' : 'Day'} ${i + 1}`) : [];
      return fromUnits.length ? fromUnits : days;
    };
    const draw = () => {
      const ro = rangeOpts();
      // 범위는 Day 1개만. 예전 "Day 3~5" 같은 값은 첫 Day로 맞춰요
      if (ro.length && !ro.includes(st.range)) { const m = (st.range || '').match(/^(.*?)~/); st.range = m && ro.includes(m[1]) ? m[1] : ro[0]; }
      box.innerHTML = `
        <div class="card mt">
          <div class="row"><h2 style="margin:0">${h(d.course.name)}</h2><span class="small muted">${prettyDate(date)}</span></div>
          <div class="field mt"><span>📅 수업 날짜 ${classDays.length ? `(${classDays.join('·')}요일)` : ''}</span>
            ${classDates.length ? `<div class="tabs" style="flex-wrap:nowrap;overflow-x:auto;padding-bottom:4px">${classDates.map((x) => `<button type="button" class="btn sm ${x.v === date ? 'primary' : ''}" data-wdate="${x.v}" style="white-space:nowrap">${x.label}</button>`).join('')}</div>` : '<div class="small muted">[반 관리]에서 이 반의 수업 요일을 정하면 여기에 수업 날짜가 나와요. 지금은 위쪽 날짜 칸에서 골라 주세요.</div>'}</div>
          <div class="field"><span>🔁 회독</span><div class="tabs">${Array.from({ length: d.word_rounds || 4 }, (_, i) => i + 1).map((n) => `<button type="button" class="btn sm ${st.round === n ? 'primary' : ''}" data-wround="${n}">${n}회독</button>`).join('')}</div></div>
          <div class="field"><span>📝 시험 유형 · 통과 기준</span><div class="tabs">${Object.entries(kinds).map(([k, pct]) => `<button type="button" class="btn sm ${st.kind === k ? 'primary' : ''}" data-wkind="${k}">${k} <span class="small">(${pct}%)</span></button>`).join('')}</div></div>
          <div class="grid g3f mt">
            <label class="field"><span>교재</span><select id="wbook"><option value="">— 고르기 —</option>${books.map((b) => `<option ${st.book === b ? 'selected' : ''}>${h(b)}</option>`).join('')}<option value="__">직접 적기…</option></select></label>
            <label class="field"><span>시험 범위 (${h(((d.word_books.find((b) => b.name === st.book) || {}).unit) || 'Day')} 1개)</span>${ro.length ? `<select id="wfrom">${ro.map((x) => `<option ${x === st.range ? 'selected' : ''}>${h(x)}</option>`).join('')}</select>` : `<input type="text" id="wrange" value="${h(st.range)}" placeholder="예: Day 1">`}</label>
            <label class="field"><span>문항 수 · 통과 <b id="wpass">${Math.ceil((st.total * kinds[st.kind]) / 100)}</b>개 이상 (${kinds[st.kind]}%)</span><input type="number" id="wtotal" value="${st.total}" min="1" max="500" inputmode="numeric"></label>
          </div>
          <div class="small muted">학생 이름을 누르면 채점 화면이 열려요. ✗는 불통이에요. 결과 칸을 누르면 시험지를 볼 수 있어요.</div>
        </div>
        ${d.pending.length ? `<div class="card mt missbox"><h2>🔁 재시험 대기 (지난 수업)</h2>${d.pending.map((t) => `<div class="row wrow"><b>${h((d.students.find((x) => x.id === t.student_id) || {}).name || '')}</b><span class="small muted">${prettyDate(t.date)} · ${h(t.book || '')} ${h(t.range || '')}${wLabel(t) ? ' · ' + h(wLabel(t)) : ''}</span>${chip(t)}<span class="space"></span><button class="btn sm primary" data-re="${t.id}" data-sid="${t.student_id}">재시험</button></div>`).join('')}</div>` : ''}
        <div class="card mt"><div class="wlist">${d.students.map((s) => {
          const ts = byStu.get(s.id) || [];
          // 지금 고른 Day·회독·유형의 시험만 보고 채점/재시험/통과를 정해요 (하루에 Day 여러 개를 쳐요)
          const cur = ts.filter((t) => (t.range || '') === (st.range || '') && (t.round || null) === (st.round || null) && (t.kind || null) === (st.kind || null));
          const last = cur[cur.length - 1];
          const need = last && !last.passed;
          return `<div class="wrow">
            <button class="wname" data-stu="${s.id}">${sAvatar(s, 34)}<span><b>${h(s.name)}</b><span class="small muted"> ${h(s.grade || '')}</span>${s.has_phone ? '' : '<span class="small red-t"> · 학생 번호 없음</span>'}</span></button>
            <div class="chips">${ts.map(chip).join('')}</div>
            <span class="space"></span>
            ${!last ? `<button class="btn sm primary" data-stu="${s.id}">채점</button>` : need ? `<button class="btn sm" style="border-color:var(--red);color:var(--red)" data-re="${last.id}" data-sid="${s.id}">재시험</button>` : '<span class="chip green">통과</span>'}
          </div>`;
        }).join('') || '<div class="empty">이 반에 학생이 없어요</div>'}</div></div>`;
      const sync = () => {
        const bk = $('#wbook', box).value;
        if (bk && bk !== '__') st.book = bk;
        if ($('#wfrom', box)) st.range = $('#wfrom', box).value;
        if ($('#wrange', box)) st.range = $('#wrange', box).value.trim();
        st.total = Number($('#wtotal', box).value) || st.total;
      };
      $$('[data-wdate]', box).forEach((b) => (b.onclick = () => (location.hash = `#/word?date=${b.dataset.wdate}&course=${courseId}`)));
      $$('[data-wround]', box).forEach((b) => (b.onclick = () => { sync(); st.round = Number(b.dataset.wround); draw(); }));
      $$('[data-wkind]', box).forEach((b) => (b.onclick = () => { sync(); st.kind = b.dataset.wkind; draw(); }));
      $('#wtotal', box).oninput = (e) => { $('#wpass', box).textContent = Math.ceil(((Number(e.target.value) || 0) * kinds[st.kind]) / 100); };
      $('#wbook', box).onchange = (e) => {
        if (e.target.value === '__') { const v = prompt('교재 이름을 적어 주세요'); if (v) { st.book = v.trim(); books.push(st.book); } draw(); return; }
        st.book = e.target.value; st.range = ''; draw();
      };
      if ($('#wfrom', box)) {
        $('#wfrom', box).onchange = () => { sync(); draw(); };
      }
      $$('[data-stu]', box).forEach((b) => (b.onclick = () => { sync(); gradeModal(d, Number(b.dataset.stu), st, null, () => renderWordClass(box, courseId, date)); }));
      $$('[data-re]', box).forEach((b) => (b.onclick = () => {
        sync();
        const prev = [...d.tests, ...d.pending].find((t) => t.id === Number(b.dataset.re));
        gradeModal(d, Number(b.dataset.sid), { book: prev.book, range: prev.range, total: prev.total, round: prev.round, kind: prev.kind }, prev, () => renderWordClass(box, courseId, date));
      }));
      $$('[data-wt]', box).forEach((c) => (c.onclick = () => { const t = [...d.tests, ...d.pending].find((x) => x.id === Number(c.dataset.wt)); wordViewModal(t, () => renderWordClass(box, courseId, date)); }));
    };
    draw();
  }

  function gradeModal(d, sid, st, retestOf, done) {
    const s = d.students.find((x) => x.id === sid) || { name: '' };
    let score = retestOf ? retestOf.score : st.total;
    let photo = null;
    const kinds = d.word_kinds || { 한글뜻: 90, 스펠링: 80, 혼합: 90 };
    const pct = st.kind && kinds[st.kind] ? kinds[st.kind] : d.pass_pct;
    const passOf = (total) => Math.ceil((total * pct) / 100);
    const label = [st.round ? `${st.round}회독` : '', st.kind || ''].filter(Boolean).join(' · ');
    modal({
      title: `${s.name} ${retestOf ? '재시험' : '단어시험'} 채점`, wide: true, submitText: '저장하고 보내기',
      body: `
        <div class="small muted">${h(st.book || '교재 미선택')} · ${h(st.range || '범위 미선택')}${label ? ` · <b>${h(label)}</b>` : ''}${retestOf ? ` · 지난 결과 ${retestOf.score}/${retestOf.total} ✗` : ''}</div>
        <label class="photo-btn mt"><input type="file" accept="image/*" capture="environment" id="wph" hidden><span id="wphTxt">📷 채점한 시험지 찍기</span><img id="wprev" hidden></label>
        <div class="grid g2 mt">
          <label class="field"><span>문항 수</span><input type="number" name="total" value="${st.total}" min="1" inputmode="numeric"></label>
          <label class="field"><span>통과 기준 (맞은 개수 · ${pct}% 고정)</span><input type="number" name="pass_score" value="${passOf(st.total)}" min="0" inputmode="numeric" ${st.kind ? 'readonly style="background:#f3f5ef"' : ''}></label>
        </div>
        <div class="scorebox">
          <button type="button" class="btn" data-d="-1">−</button>
          <div><div class="big" id="wscore"></div><div id="wres"></div></div>
          <button type="button" class="btn" data-d="1">＋</button>
        </div>
        <div class="keypad">${[1, 2, 3, 4, 5, 6, 7, 8, 9, '지움', 0, '만점'].map((k) => `<button type="button" class="btn" data-k="${k}">${k}</button>`).join('')}</div>
        <label class="field mt"><span>메모 (선택)</span><input type="text" name="memo" placeholder="예: 철자 실수 많음"></label>
        <label class="inline-check"><input type="checkbox" name="send" checked> 학생과 담당 선생님께 결과·시험지 보내기</label>`,
      onOpen: (f) => {
        let typed = '';
        const total = () => Number($('input[name=total]', f).value) || 0;
        const show = () => {
          if (score > total()) score = total();
          if (score < 0) score = 0;
          const pass = Number($('input[name=pass_score]', f).value);
          $('#wscore', f).innerHTML = `${score}<small> / ${total()}</small>`;
          $('#wres', f).innerHTML = score >= pass ? '<span class="chip green">통과</span>' : `<span class="chip red">불통 · ${pass - score}개 부족</span>`;
        };
        show();
        $('input[name=total]', f).oninput = () => { $('input[name=pass_score]', f).value = passOf(total()); show(); };
        $('input[name=pass_score]', f).oninput = show;
        $$('[data-d]', f).forEach((b) => (b.onclick = () => { score += Number(b.dataset.d); typed = ''; show(); }));
        $$('[data-k]', f).forEach((b) => (b.onclick = () => {
          const k = b.dataset.k;
          if (k === '만점') { score = total(); typed = ''; }
          else if (k === '지움') { typed = typed.slice(0, -1); score = Number(typed) || 0; }
          else { typed = (typed + k).slice(-3); score = Number(typed); }
          show();
        }));
        $('#wph', f).onchange = async (e) => {
          const file = e.target.files[0];
          if (!file) return;
          $('#wphTxt', f).textContent = '사진 줄이는 중…';
          try { photo = await shrinkPhoto(file); $('#wprev', f).src = photo; $('#wprev', f).hidden = false; $('#wphTxt', f).textContent = '📷 다시 찍기'; }
          catch (err) { toast(err.message); $('#wphTxt', f).textContent = '📷 채점한 시험지 찍기'; }
        };
      },
      onSubmit: async (fd) => {
        const r = await api('POST', '/api/word/tests', {
          student_id: sid, course_id: d.course.id, date: d.date, book: st.book, range: st.range, round: st.round, kind: st.kind,
          total: fd.total, score, pass_score: fd.pass_score, memo: fd.memo, photo, send: !!fd.send, retest_of: retestOf ? retestOf.id : null,
        });
        const sent = r.sent.length ? ` · 보냄: ${r.sent.map((x) => `${x.to} ${x.status}`).join(', ')}` : '';
        toast(`${s.name} ${r.passed ? '통과 ✓' : '불통 ✗ (재시험 필요)'}${sent}`);
        done && done();
      },
    });
  }

  function wordViewModal(t, done) {
    modal({
      title: `단어시험 ${t.attempt > 1 ? '재시험' : '본시험'} · ${prettyDate(t.date)}`,
      body: `<div class="row"><b style="font-size:24px">${t.score} / ${t.total}</b>${t.passed ? '<span class="chip green">통과</span>' : `<span class="chip red">불통 (기준 ${t.pass_score})</span>`}</div>
        <div class="small muted">${h(t.book || '')} ${h(t.range || '')}${t.round ? ` · ${t.round}회독` : ''}${t.kind ? ` · ${h(t.kind)}` : ''} · ${h(t.teacher_name || '')}${t.sent_at ? ' · 보냄 ' + prettyTime(t.sent_at) : ''}</div>
        ${t.memo ? `<p>${h(t.memo)}</p>` : ''}
        ${t.photo_v ? `<img src="/api/word/photos/${t.id}?v=${t.photo_v}" style="width:100%;border-radius:10px;margin-top:10px">` : '<p class="muted small">시험지 사진이 없어요</p>'}`,
      foot: `<button type="button" class="btn sm danger" id="wdel">기록 지우기</button>`,
      onOpen: (f, close) => { $('#wdel', f.parentElement).onclick = async () => { if (!confirm('이 시험 기록을 지울까요?')) return; try { await api('DELETE', `/api/word/tests/${t.id}`); close(); toast('지웠어요'); done && done(); } catch (e) { toast(e.message); } }; },
    });
  }

  // ───────── 진도표 ─────────
  async function pageProgress(el, parts) {
    if (parts[0]) return pageProgressCourse(el, Number(parts[0]));
    const { courses } = await api('GET', '/api/progress');
    el.innerHTML = `
      <div class="page-head"><div><h1>진도표</h1><p>반마다 단원 계획을 넣어 두면, 수업 일지에서 체크한 단원으로 진도율이 자동 계산돼요.${isOwner() || isManager() ? '' : ' 내 반만 보여요.'}</p></div>
        <button class="btn primary" id="uImport">📂 엑셀로 한꺼번에 올리기</button></div>
      <div class="card"><div class="table-wrap"><table class="list">
        <thead><tr><th>반</th><th>담당</th><th style="width:34%">진도</th><th>다음 단원</th><th>최근 일지</th><th></th></tr></thead>
        <tbody>${courses.map((c) => {
          const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
          return `<tr><td><span class="chip">${h(c.subject)}</span> <b>${h(c.name)}</b></td><td>${withAvatar(c.teacher_id, c.teacher_photo_v, c.teacher_name, 20)}</td>
            <td>${c.total ? `<div class="bar"><div style="width:${pct}%"></div></div><div class="small muted">${pct}% · ${c.done}/${c.total}단원${c.late ? ` · <span class="red-t">예정보다 늦은 단원 ${c.late}개</span>` : ''}</div>` : '<span class="small muted">진도표 없음</span>'}</td>
            <td class="small">${h(c.next_unit || (c.total ? '모두 완료 🎉' : '-'))}</td><td class="small">${c.last_log ? prettyDate(c.last_log) : '-'}</td>
            <td style="text-align:right"><a class="btn sm" href="#/progress/${c.id}">${c.total ? '보기' : '만들기'}</a></td></tr>`;
        }).join('') || '<tr><td colspan="6" class="empty">반이 없어요</td></tr>'}</tbody></table></div></div>`;
    $('#uImport').onclick = () => unitsImportModal(null, reload);
  }
  // 진도표 엑셀 → [{course, book, title, planned_date}]
  function unitRowsFromGrid(grid, hasDefault) {
    const norm = (c) => String(c ?? '').replace(/\s/g, '');
    const hi = grid.findIndex((r) => r.some((c) => /^(단원|단원명|차시|진도|진도내용|수업내용|내용)$/.test(norm(c))));
    let col;
    if (hi >= 0) {
      const head = grid[hi].map(norm);
      const find = (re) => head.findIndex((x) => re.test(x));
      col = { course: find(/^(반|반이름|반명|수업|수업명|클래스)$/), book: find(/교재|책/), title: find(/^(단원|단원명|차시|진도|진도내용|수업내용|내용)$/), date: find(/예정|날짜|일자|수업일|계획/) };
    } else {
      col = hasDefault ? { course: -1, book: 0, title: 1, date: 2 } : { course: 0, book: 1, title: 2, date: 3 };
    }
    const out = [];
    let lastCourse = '', lastBook = '';
    for (const r of grid.slice(hi + 1)) {
      const get = (k) => (col[k] >= 0 ? String(r[col[k]] ?? '').replace(/[\t\r\n]+/g, ' ').trim() : '');
      const course = get('course') || lastCourse; // 엑셀에서 칸을 합쳐 둔 경우 위 칸을 이어 써요
      const book = get('book') || (get('course') && get('course') !== lastCourse ? '' : lastBook);
      const title = get('title');
      if (!title && !get('course') && !get('book')) continue;
      lastCourse = course; lastBook = book;
      const dv = get('date');
      out.push({ course, book, title, planned_date: /^\d+(\.\d+)?$/.test(dv) ? excelDate(dv).slice(0, 10) : dv });
    }
    return { rows: out, hasHeader: hi >= 0, hasCourseCol: col.course >= 0 };
  }
  function unitsImportModal(defaultCourse, done) {
    let parsed = null, checkedKey = null;
    modal({
      title: defaultCourse ? `${defaultCourse.name} 진도표 엑셀로 올리기` : '진도표 엑셀로 한꺼번에 올리기',
      wide: true,
      submitText: '미리 보기',
      body: `
        <div class="howto">
          <b>엑셀 첫 줄에 제목</b>을 넣어 주세요: <b>반 · 교재 · 단원 · 예정일</b> (예정일은 없어도 돼요)
          <div class="small muted" style="margin-top:6px">
            ${defaultCourse ? '이 반 것만 올릴 땐 <b>반</b> 칸은 비워 두거나 빼도 돼요.<br>' : '여러 반을 한 파일에 같이 넣어도 돼요. <b>반 이름은 [반 관리]에 적힌 이름과 똑같이</b> 써 주세요(띄어쓰기는 달라도 괜찮아요).<br>'}
            반·교재 칸이 비어 있으면 <b>바로 위 줄과 같은 것</b>으로 알아들어요. 예정일은 2026-12-01, 2026.12.1 모두 돼요.
          </div>
          <div class="row" style="margin-top:8px"><label class="btn sm primary" style="cursor:pointer">📂 엑셀 파일 고르기<input type="file" id="uFile" accept=".xlsx,.csv" hidden></label>
            <a class="btn sm" href="/units-template.csv" download="진도표양식.csv">⬇ 진도표 양식 내려받기</a><span class="small muted" id="uFileName"></span></div>
          <details style="margin-top:8px"><summary class="small">파일 대신 엑셀에서 복사해 붙여 넣기</summary>
            <textarea id="uPaste" style="min-height:120px;margin-top:6px" placeholder="반	교재	단원	예정일&#10;중2A	개념원리 중2-1	1단원 유리수와 순환소수	2026-12-01"></textarea></details>
        </div>
        <div class="field mt"><span class="small muted">이미 단원이 들어 있는 반은</span>
          <div class="seg" style="margin-top:4px">
            <label><input type="radio" name="mode" value="add" checked> 뒤에 이어 붙이기</label>
            <label><input type="radio" name="mode" value="replace"> 안 나간 단원은 지우고 새로 넣기</label>
          </div>
          <div class="small muted">이미 수업 일지에서 나간 단원 기록은 어느 쪽이든 그대로 남아요. 똑같은 단원은 두 번 들어가지 않아요.</div></div>
        <div id="uPreview"></div>`,
      onOpen: (f) => {
        const reset = () => { checkedKey = null; $('button[type=submit]', f).textContent = '미리 보기'; $('#uPreview', f).innerHTML = ''; };
        const take = (grid, name) => { parsed = unitRowsFromGrid(grid, !!defaultCourse); $('#uFileName', f).textContent = name || ''; reset(); f.requestSubmit(); };
        $('#uFile', f).onchange = async (e) => {
          const file = e.target.files[0];
          if (!file) return;
          try {
            const grid = /\.csv$/i.test(file.name) ? (await file.text()).replace(/^﻿/, '').split(/\r?\n/).map((l) => l.split(',')) : await readXlsx(file);
            take(grid, file.name);
          } catch (err) { $('.err', f).textContent = err.message; }
          e.target.value = '';
        };
        $('#uPaste', f).oninput = (e) => { const t = e.target.value; parsed = t.trim() ? unitRowsFromGrid(t.split(/\r?\n/).map((l) => l.split('\t')), !!defaultCourse) : null; $('#uFileName', f).textContent = ''; reset(); };
        $$('input[name=mode]', f).forEach((r) => (r.onchange = () => { if (parsed) { reset(); f.requestSubmit(); } }));
      },
      onSubmit: async (d, f) => {
        if (!parsed || !parsed.rows.length) throw new Error('먼저 엑셀 파일을 골라 주세요. (단원이 한 줄도 없어요)');
        const payload = { rows: parsed.rows, mode: d.mode, default_course_id: defaultCourse ? defaultCourse.id : null };
        const key = JSON.stringify(payload);
        if (checkedKey !== key) {
          const p = await api('POST', '/api/units/import', { ...payload, preview: true });
          $('#uPreview', f).innerHTML = `
            <div class="mt"><b>미리 보기</b> — 새로 들어갈 단원 <b>${p.total}개</b>${parsed.hasHeader ? '' : ` · <span style="color:var(--orange)">제목 줄이 없어서 "${defaultCourse ? '교재, 단원, 예정일' : '반, 교재, 단원, 예정일'}" 순서로 읽었어요</span>`}</div>
            ${p.courses.length ? `<div class="table-wrap" style="margin-top:6px"><table class="list"><thead><tr><th>반</th><th>지금</th><th>새로 넣기</th><th>건너뜀(같은 단원)</th>${p.mode === 'replace' ? '<th>지울 단원</th>' : ''}<th>앞부분 보기</th></tr></thead><tbody>
              ${p.courses.map((c) => `<tr><td><span class="chip">${h(c.subject)}</span> <b>${h(c.name)}</b></td><td>${c.before}개</td><td><b>${c.add}개</b></td><td>${c.dup || '-'}</td>${p.mode === 'replace' ? `<td>${c.removed ? `<span class="red-t">${c.removed}개</span>` : '-'}</td>` : ''}
                <td class="small">${c.sample.map((u) => `${u.book ? `<span class="muted">${h(u.book)} ·</span> ` : ''}${h(u.title)}${u.planned_date ? ` <span class="muted">(${h(u.planned_date)})</span>` : ''}`).join('<br>')}${c.add > c.sample.length ? '<br><span class="muted">…</span>' : ''}</td></tr>`).join('')}
            </tbody></table></div>` : ''}
            ${p.unknown.length ? `<div class="small" style="color:var(--orange);margin-top:6px">⚠ 못 찾은 반 (이 줄들은 빠져요): ${p.unknown.map((u) => `<b>${h(u.name)}</b> ${u.count}줄`).join(', ')}<br>
              <span class="muted">[반 관리]의 반 이름: ${p.my_courses.map(h).join(', ') || '없음'}</span></div>` : ''}
            ${p.no_title ? `<div class="small" style="color:var(--orange)">단원 칸이 비어 있는 줄 ${p.no_title}개는 빠져요.</div>` : ''}
            ${p.bad_date ? `<div class="small" style="color:var(--orange)">예정일을 알아보지 못한 줄 ${p.bad_date}개는 예정일 없이 들어가요.</div>` : ''}
            <div class="small muted" style="margin-top:6px">맞으면 아래 <b>이대로 넣기</b>를 눌러 주세요.</div>`;
          checkedKey = key;
          const btn = $('button[type=submit]', f);
          btn.textContent = `이대로 ${p.total}개 넣기`;
          btn.disabled = false;
          if (!p.total && !(p.mode === 'replace' && p.courses.some((c) => c.removed))) { setTimeout(() => (btn.disabled = true)); }
          return true;
        }
        const r = await api('POST', '/api/units/import', payload);
        toast(`${r.courses.length}개 반에 단원 ${r.total}개를 넣었어요`);
        done && done();
      },
    });
  }
  async function pageProgressCourse(el, id) {
    const { course, units } = await api('GET', `/api/courses/${id}/units`);
    const done = units.filter((u) => u.done_date).length, now = todayStr();
    el.innerHTML = `
      <div><a href="#/progress" class="small muted">← 진도표</a></div>
      <div class="page-head mt"><div><h1>${h(course.name)} 진도표</h1><p>${units.length ? `진도율 ${Math.round((done / units.length) * 100)}% · ${done}/${units.length}단원` : '아직 단원이 없어요. [진도표 고치기]로 넣어 주세요.'}</p></div>
        <div class="row"><button class="btn" id="uImport">📂 엑셀로 올리기</button><button class="btn primary" id="eu">교재·단원 고치기</button></div></div>
      ${units.length ? `<div class="card"><table class="list"><thead><tr><th>#</th><th>교재</th><th>단원</th><th>예정일</th><th>나간 날</th><th></th></tr></thead><tbody>${units.map((u, i) => `
        <tr><td class="muted">${i + 1}</td><td class="small">${h(u.book || '-')}</td><td><b>${h(u.title)}</b></td>
        <td class="${u.planned_date && !u.done_date && u.planned_date < now ? 'red-t' : ''}">${h(u.planned_date || '-')}</td>
        <td>${u.done_date ? `<span class="chip green">✓ ${h(u.done_date)}</span>` : '<span class="muted small">아직</span>'}</td>
        <td style="text-align:right"><button class="btn sm" data-tg="${u.id}" data-done="${u.done_date ? 0 : 1}">${u.done_date ? '완료 취소' : '완료로 표시'}</button></td></tr>`).join('')}</tbody></table></div>` : ''}`;
    $('#eu').onclick = () => unitsModal(id, reload);
    $('#uImport').onclick = () => unitsImportModal(course, reload);
    $$('[data-tg]', el).forEach((b) => (b.onclick = async () => { await api('PATCH', `/api/units/${b.dataset.tg}`, { done: b.dataset.done === '1' }); reload(); }));
  }

  // ───────── 수업 일지 모아 보기 ─────────
  async function pageLogs(el, _p, query) {
    const qs = new URLSearchParams(Object.entries({ from: query.from, to: query.to, course_id: query.course, teacher_id: query.teacher }).filter(([, v]) => v)).toString();
    const [d, { courses }] = await Promise.all([api('GET', '/api/logs' + (qs ? '?' + qs : '')), api('GET', '/api/courses')]);
    const all = isOwner() || isManager();
    const days = [...new Set([...d.logs.map((l) => l.date), ...d.missing.map((m) => m.date)])].sort().reverse();
    const chips = (l) => [
      l.student_count ? `<span class="chip">출석 ${l.present}/${l.student_count}${l.absent ? ` · 결석 ${l.absent}` : ''}</span>` : '',
      l.hw_o + l.hw_p + l.hw_x ? `<span class="chip ${l.hw_x ? 'orange' : 'green'}">숙제 ○${l.hw_o} △${l.hw_p} ×${l.hw_x}</span>` : '',
      l.word_n ? `<span class="chip ${l.word_pass < l.word_n ? 'orange' : 'green'}">단어 통과 ${l.word_pass}/${l.word_n}</span>` : '',
      l.ach_h + l.ach_m + l.ach_l ? `<span class="chip blue">성취 상${l.ach_h} 중${l.ach_m} 하${l.ach_l}</span>` : '',
    ].join(' ');
    el.innerHTML = `
      <div class="page-head"><div><h1>수업 일지 모아 보기</h1><p>${all ? '모든 반의 일지를 날짜별로 모아 봐요. 수업이 있었는데 일지가 없는 반은 빨간색으로 보여요.' : '내 반 일지를 모아 봐요.'}</p></div></div>
      <form class="card row" id="lf">
        <input type="date" name="from" value="${h(d.from)}" style="width:auto"> ~ <input type="date" name="to" value="${h(d.to)}" style="width:auto">
        <select name="course" style="width:auto"><option value="">모든 반</option>${courses.map((c) => `<option value="${c.id}" ${String(c.id) === query.course ? 'selected' : ''}>${h(c.name)}</option>`).join('')}</select>
        ${all ? `<select name="teacher" style="width:auto"><option value="">모든 선생님</option>${d.teachers.map((t) => `<option value="${t.id}" ${String(t.id) === query.teacher ? 'selected' : ''}>${h(t.name)}</option>`).join('')}</select>` : ''}
        <button class="btn">보기</button><span class="space"></span>
        <span class="small muted">일지 ${d.logs.length}개 · <b class="${d.missing.length ? 'red-t' : ''}">안 쓴 일지 ${d.missing.length}개</b></span>
      </form>
      ${d.missing.length ? `<div class="card mt missbox"><h2>⚠️ 아직 안 쓴 수업 일지 ${d.missing.length}개</h2>
        <table class="list"><tbody>${d.missing.map((m) => `<tr><td>${prettyDate(m.date)}</td><td><b>${h(m.course_name)}</b> <span class="small muted">${h([m.start, m.end].filter(Boolean).join('~'))}</span></td><td>${withAvatar(m.teacher_id, m.teacher_photo_v, m.teacher_name, 20)}</td>
          <td style="text-align:right"><a class="btn sm primary" href="#/attendance?date=${m.date}&course=${m.course_id}">일지 쓰기</a></td></tr>`).join('')}</tbody></table></div>` : ''}
      ${days.map((day) => {
        const ls = d.logs.filter((l) => l.date === day);
        const ms = d.missing.filter((m) => m.date === day);
        return `<div class="mt"><div class="tl-month">${prettyDate(day)}</div>${ls.map((l) => `
          <div class="card logcard">
            <div class="row"><span class="chip">${h(l.subject)}</span><b>${h(l.course_name)}</b>${withAvatar(l.teacher_id, l.teacher_photo_v, l.teacher_name, 20)}<span class="space"></span>${chips(l)}
              <a class="btn sm" href="#/attendance?date=${l.date}&course=${l.course_id}">열기</a></div>
            ${l.books ? `<div class="small" style="margin-top:4px">📘 ${h(l.books)}</div>` : ''}
            ${l.content ? `<div class="content">📖 ${h(l.content)}</div>` : ''}
            ${(() => { try { const e = JSON.parse(l.extras || '{}'); const k = Object.keys(e); return k.length ? `<div class="chips" style="margin-top:6px">${k.map((x) => `<span class="chip">${h(x)}: ${h(e[x])}</span>`).join('')}</div>` : ''; } catch { return ''; } })()}
            ${l.units ? `<div class="small" style="margin-top:4px">📈 진도: ${h(l.units)}</div>` : ''}
            ${l.homework ? `<div class="small" style="margin-top:4px">✏️ 숙제: ${h(l.homework)}</div>` : ''}
          </div>`).join('')}${ms.map((m) => `<div class="card logcard miss"><div class="row"><span class="chip red">일지 없음</span><b>${h(m.course_name)}</b>${withAvatar(m.teacher_id, m.teacher_photo_v, m.teacher_name, 20)}<span class="small muted">${h([m.start, m.end].filter(Boolean).join('~'))}</span><span class="space"></span><a class="btn sm" href="#/attendance?date=${m.date}&course=${m.course_id}">일지 쓰기</a></div></div>`).join('')}</div>`;
      }).join('') || '<div class="card empty mt">이 기간에는 수업이 없어요</div>'}`;
    $('#lf').onsubmit = (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      location.hash = '#/logs?' + new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
    };
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
          <select name="kind" style="width:auto"><option value="">모든 종류</option>${['출결', '피드백', '청구서'].map((k) => `<option ${query.kind === k ? 'selected' : ''}>${k}</option>`).join('')}</select>
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

  const bookImg = (id, v, size = 44) => v
    ? `<img class="bookimg" src="/api/book-images/${id}?v=${v}" alt="" style="width:${size}px;height:${Math.round(size * 1.3)}px">`
    : `<span class="bookimg none" style="width:${size}px;height:${Math.round(size * 1.3)}px">📘</span>`;
  // 사진을 골라 정사각형이 아닌 세로 비율(교재 표지)로 줄여서 올리기
  function pickImage(url, done, ratio = 1) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        const u = URL.createObjectURL(file);
        const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('사진을 열 수 없어요')); i.src = u; });
        const W = 300, H = Math.round(300 * ratio);
        const c = document.createElement('canvas');
        c.width = W; c.height = H;
        const g = c.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
        const sc = Math.min(W / img.width, H / img.height);
        g.drawImage(img, (W - img.width * sc) / 2, (H - img.height * sc) / 2, img.width * sc, img.height * sc);
        URL.revokeObjectURL(u);
        await api('PUT', url, { data: c.toDataURL('image/jpeg', 0.85) });
        toast('사진을 올렸어요');
        done && done();
      } catch (e) { toast(e.message); }
    };
    input.click();
  }

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
    const { students, view, month } = await api('GET', '/api/students' + (qs ? '?' + qs : ''));
    const showT = students.some((x) => x.tuition), showB = view.bookpay;
    const unpaid = (x) => (x.tuition && (x.tuition.state === '미납' || x.tuition.state === '부분')) || x.book_due > 0;
    const list = query.unpaid ? students.filter(unpaid) : students;
    const tChip = (t) => !t ? '' : t.state === '완납' ? '<span class="chip green">완납</span>' : t.state === '부분' ? `<span class="chip orange">${won(t.due)} 남음</span>` : t.state === '미납' ? '<span class="chip red">미납</span>' : '<span class="muted small">-</span>';
    const count = (k) => students.filter((s) => s.status === k).length;
    el.innerHTML = `
      <div class="page-head"><div><h1>학생 명부</h1><p>${isOwner() ? '학생을 누르면 인적사항·상담·교재·수납이 한 화면에 나와요.' : isManager() ? '학원 전체 학생이에요. 학생을 누르면 학생 카드가 열려요.' : '내 반 학생만 보여요. 학생을 누르면 학생 카드가 열려요.'}</p></div>
        ${canEditStudents() ? '<div class="row"><button class="btn" id="bulk">여러 명 한꺼번에 추가</button><button class="btn primary" id="add">＋ 학생 등록</button></div>' : ''}</div>
      <div class="card">
        <form class="row" id="filter">
          <div class="tabs">${[['재원', '재원생'], ['휴원', '휴원생'], ['퇴원', '퇴원생'], ['', '전체']].map(([v, l]) => `<button type="button" class="btn sm ${st === v ? 'primary' : ''}" data-st="${v}">${l}</button>`).join('')}</div>
          ${showT || showB ? `<label class="inline-check small" style="margin-left:6px"><input type="checkbox" id="unpaid" ${query.unpaid ? 'checked' : ''}> 미납만 보기</label>` : ''}
          <span class="space"></span>
          <input type="search" name="q" placeholder="이름·학교 검색" value="${h(query.q || '')}" style="width:180px">
          <button class="btn">찾기</button>
        </form>
        <div class="table-wrap mt"><table class="list">
          <thead><tr><th></th><th>이름</th><th>학교·학년</th>${view.birth ? '<th>생년월일</th>' : ''}<th>수강</th>${view.parents ? '<th>어머니 / 아버지</th>' : ''}${showT ? `<th>${Number(month.slice(5))}월 교육비</th>` : ''}${showB ? '<th>교재비</th>' : ''}<th>상태</th></tr></thead>
          <tbody>${list.map((s) => `<tr class="click" data-id="${s.id}">
            <td style="width:44px">${sAvatar(s, 34)}</td>
            <td style="white-space:nowrap"><b>${h(s.name)}</b>${s.sibling_count ? ` <span class="chip gold" title="형제·자매가 함께 다녀요">형제 ${s.sibling_count}</span>` : ''}</td>
            <td style="white-space:nowrap">${h(s.school || '')} ${h(s.grade || '')}</td>
            ${view.birth ? `<td class="small" style="white-space:nowrap">${h(s.birth_date || '')}</td>` : ''}
            <td class="small" style="min-width:180px">${h(s.courses || '-')}</td>
            ${view.parents ? `<td class="small" style="white-space:nowrap">${h(fmtPhone(s.mother_phone)) || '-'}<br>${h(fmtPhone(s.father_phone)) || '-'}</td>` : ''}
            ${showT ? `<td style="white-space:nowrap">${tChip(s.tuition)}</td>` : ''}
            ${showB ? `<td>${s.book_due ? `<span class="chip red">${won(s.book_due)} 미납</span>` : s.book_total ? '<span class="chip green">정산</span>' : '<span class="muted small">-</span>'}</td>` : ''}
            <td>${statusChip(s.status)}${s.has_phone ? '' : ' <span class="chip red">번호 없음</span>'}</td></tr>`).join('')}</tbody>
        </table></div>
        ${list.length ? `<div class="small muted mt">${list.length}명${query.unpaid ? ' (미납만)' : ''}${st === '' ? ` (재원 ${count('재원')} · 휴원 ${count('휴원')} · 퇴원 ${count('퇴원')})` : ''}</div>` : '<div class="empty">학생이 없어요</div>'}
      </div>`;
    const go = (patch) => {
      const q = { status: st, q: query.q, unpaid: query.unpaid, ...patch };
      location.hash = '#/students?' + new URLSearchParams(Object.entries(q).map(([k, v]) => [k, v ?? ''])).toString();
    };
    $$('[data-st]', el).forEach((b) => (b.onclick = () => go({ status: b.dataset.st })));
    if ($('#unpaid')) $('#unpaid').onchange = (e) => go({ unpaid: e.target.checked ? '1' : '' });
    $('#filter').onsubmit = (e) => { e.preventDefault(); go({ q: new FormData(e.target).get('q') }); };
    $$('tr[data-id]', el).forEach((tr) => (tr.onclick = () => (location.hash = `#/students/${tr.dataset.id}`)));
    if (!canEditStudents()) return;
    $('#add').onclick = () => modal({ title: '학생 등록', wide: true, body: studentForm({ status: '재원' }), onSubmit: async (d) => { const r = await api('POST', '/api/students', d); toast('등록했어요'); location.hash = `#/students/${r.id}`; } });
    $('#bulk').onclick = () => {
      let checked = null; // 미리 보기를 마친 글
      modal({
        title: '여러 명 한꺼번에 추가', wide: true, submitText: '미리 보기',
        body: `
          <div class="howto">
            <b>엑셀에서 제목 줄까지 같이</b> 복사해서(Ctrl+C) 아래 칸에 붙여 넣어 주세요(Ctrl+V). 칸 순서는 상관없어요. 제목을 보고 알아서 맞춰요.
            <div class="small muted" style="margin-top:6px">알아듣는 제목: 이름 · 학교 · 학년 · 생년월일 · <b>학생 연락처</b> · 주소 · 아버지 성함 · 아버지 연락처 · 어머니 성함 · 어머니 연락처 · 문자 받을 분(어머니/아버지/둘 다) · 등록일 · 형제 · 특이사항</div>
            <div class="row" style="margin-top:8px"><label class="btn sm primary" style="cursor:pointer">📂 엑셀 파일로 올리기<input type="file" id="stuFile" accept=".xlsx,.csv" hidden></label>
            <a class="btn sm" href="/student-template.csv" download="학생등록양식.csv">⬇ 엑셀 양식 내려받기</a><span class="small muted" id="stuFileName"></span></div>
          </div>
          <textarea name="text" style="min-height:200px;font-family:inherit" placeholder="이름	학교	학년	생년월일	주소	어머니 성함	어머니 연락처	아버지 성함	아버지 연락처&#10;홍길동	대치중	중2	2012-05-14	서울 강남구 …	김영희	010-1234-5678	홍판서	010-2345-6789"></textarea>
          <div id="bulkPreview"></div>`,
        onOpen: (f) => {
          const ta = $('textarea', f);
          ta.oninput = () => { checked = null; $('button[type=submit]', f).textContent = '미리 보기'; $('#bulkPreview', f).innerHTML = ''; };
          // 엑셀 파일을 읽어서 칸에 채우고 바로 미리 보기
          $('#stuFile', f).onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
              const grid = /\.csv$/i.test(file.name) ? (await file.text()).split(/\r?\n/).map((l) => l.split(',')) : await readXlsx(file);
              const hi = grid.findIndex((r) => r.some((c) => /이름|성명|학생명/.test(String(c))));
              const head = hi >= 0 ? grid[hi].map((c) => String(c).replace(/\s/g, '')) : [];
              const dateCols = head.map((h) => /생년월일|생일|등록일|입학일/.test(h));
              const lines = grid.slice(Math.max(0, hi))
                .map((r, i) => r.map((c, k) => (i > 0 && dateCols[k] ? excelDate(c) : String(c ?? '')).replace(/[\t\r\n]+/g, ' ').trim()).join('\t'))
                .filter((l) => l.replace(/\t/g, '').trim());
              ta.value = lines.join('\n');
              $('#stuFileName', f).textContent = file.name;
              ta.oninput();
              f.requestSubmit();
            } catch (err) { $('.err', f).textContent = err.message; }
            e.target.value = '';
          };
        },
        onSubmit: async (d, f) => {
          if (checked !== d.text) {
            const p = await api('POST', '/api/students/bulk', { text: d.text, preview: true });
            const cols = ['name', 'school', 'grade', 'birth_date', 'student_phone', 'address', 'mother_name', 'mother_phone', 'father_name', 'father_phone', 'sms_target', 'enrolled_date', 'sibling_note', 'memo'];
            const label = { name: '이름', school: '학교', grade: '학년', birth_date: '생년월일', student_phone: '학생 연락처', address: '주소', mother_name: '어머니', mother_phone: '어머니 연락처', father_name: '아버지', father_phone: '아버지 연락처', sms_target: '문자', enrolled_date: '등록일', sibling_note: '형제', memo: '특이사항' };
            const used = cols.filter((c) => p.rows.some((r) => r[c]));
            const ignored = p.columns.filter((c) => !c.label).map((c) => c.header).filter(Boolean);
            $('#bulkPreview', f).innerHTML = `
              <div class="mt"><b>미리 보기</b> — 모두 <b>${p.total}명</b>${p.total > p.rows.length ? ` (앞의 ${p.rows.length}명만 보여요)` : ''}${p.hasHeader ? '' : ' · <span style="color:var(--orange)">제목 줄이 없어서 "이름, 학교, 학년, 어머니 연락처, 아버지 연락처" 순서로 읽었어요</span>'}</div>
              ${p.hasHeader ? `<div class="small muted">칸 맞춤: ${p.columns.filter((c) => c.label).map((c) => `${h(c.header)} → <b>${h(c.label)}</b>`).join(' · ')}</div>` : ''}
              ${ignored.length ? `<div class="small" style="color:var(--orange)">읽지 않은 칸: ${ignored.map(h).join(', ')}</div>` : ''}
              <div class="table-wrap" style="margin-top:6px"><table class="list"><thead><tr>${used.map((c) => `<th>${label[c]}</th>`).join('')}</tr></thead>
              <tbody>${p.rows.map((r) => `<tr>${used.map((c) => `<td class="small">${h(c.endsWith('phone') ? fmtPhone(r[c]) : r[c] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
              ${p.warnings.length ? `<div class="small" style="color:var(--orange);margin-top:6px">${p.warnings.map(h).join('<br>')}</div>` : ''}
              <div class="small muted" style="margin-top:6px">칸이 잘 맞았으면 <b>이대로 등록하기</b>를 눌러 주세요. 틀렸으면 엑셀 제목을 고쳐서 다시 붙여 넣어 주세요.</div>`;
            checked = d.text;
            $('button[type=submit]', f).textContent = `이대로 ${p.total}명 등록하기`;
            return true; // 창을 닫지 않아요
          }
          const r = await api('POST', '/api/students/bulk', { text: d.text });
          toast(`${r.added}명 등록했어요`);
          reload();
        },
      });
    };
  }

  async function pageStudent(el, id) {
    const d = await api('GET', `/api/students/${id}`);
    const s = d.student, v = d.view, own = isOwner(), edit = canEditStudents();
    const tz = todayStr();
    const since30 = (() => { const t = new Date(); t.setDate(t.getDate() - 30); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; })();
    const att30 = d.attendance.filter((a) => a.date >= since30);
    const absent30 = att30.filter((a) => a.status === '결석').length;
    const late30 = att30.filter((a) => a.status === '지각' || a.status === '조퇴').length;
    const rate = att30.length ? Math.round(((att30.length - absent30) / att30.length) * 100) : null;
    const pendingFollow = d.consultations.filter((k) => k.follow_up && !k.follow_up_done);
    const openFlags = d.flags.filter((f) => !f.resolved);
    const lastLog = d.logs[0];
    const mm = Number(d.month.slice(5));
    const ts = d.tuition_status, bs = d.book_status;

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

    // ── 타임라인: 모든 기록을 날짜순으로
    const tl = [];
    for (const k of d.consultations) tl.push({ type: '상담', date: k.date, subject: k.subject || '공통', html: `
      <div class="row"><span class="chip">${h(k.kind)}</span>${withAvatar(k.teacher_id, k.teacher_photo_v, k.teacher_name, 20)}</div>
      <div class="content">${h(k.content)}</div>${k.follow_up ? `<div class="follow ${k.follow_up_done ? 'done' : ''}">📌 ${h(k.follow_up)}</div>` : ''}` });
    for (const l of d.logs) tl.push({ type: '수업 일지', date: l.date, subject: l.subject, html: `
      <div class="row"><b>${h(l.course_name)}</b>${l.att_status ? statusChip(l.att_status) : ''}${withAvatar(l.teacher_id, l.teacher_photo_v, l.teacher_name, 20)}</div>
      ${l.books ? `<div class="small">📘 ${h(l.books)}</div>` : ''}${l.content ? `<div class="content">📖 ${h(l.content)}</div>` : ''}${(() => { try { const e = JSON.parse(l.extras || '{}'); const k = Object.keys(e); return k.length ? `<div class="chips" style="margin-top:4px">${k.map((x) => `<span class="chip">${h(x)}: ${h(e[x])}</span>`).join('')}</div>` : ''; } catch { return ''; } })()}${l.homework ? `<div class="content small">✏️ 숙제: ${h(l.homework)}</div>` : ''}${l.hw || l.achieve ? `<div class="row" style="margin-top:4px">${l.hw ? `<span class="chip ${l.hw === '×' ? 'red' : l.hw === '△' ? 'orange' : 'green'}">숙제 ${h(l.hw)}</span>` : ''}${l.achieve ? `<span class="chip blue">성취도 ${h(l.achieve)}</span>` : ''}</div>` : ''}${l.note ? `<div class="follow">🗒️ ${h(l.note)}</div>` : ''}` });
    const logged = new Set(d.logs.map((l) => `${l.date}|${l.course_name}`));
    for (const a of d.attendance) if (a.status !== '출석' && !logged.has(`${a.date}|${a.course_name}`)) tl.push({ type: '출결', date: a.date, subject: a.subject, html: `<div class="row">${statusChip(a.status)}<span>${h(a.course_name)}</span><span class="small muted">${h(a.memo || '')}</span></div>` });
    for (const f of d.feedbacks) tl.push({ type: '피드백', date: (f.sent_at || f.updated_at || '').slice(0, 10), subject: f.subject, html: `<div class="row"><b>${h(f.period_title)}</b>${statusChip(f.status)}</div><div class="content small">${h(f.content)}</div>` });
    for (const b of d.books || []) tl.push({ type: '교재', date: b.date, subject: b.subject || '공통', html: `<div class="row">${b.book_id ? bookImg(b.book_id, b.book_image_v, 26) : ''}<b>${h(b.title)}</b><span class="small muted">${b.qty}권 · ${won(b.price)} · ${h(b.given_by_name || '')}</span></div>` });
    for (const p of [...(d.tuition || []), ...(d.bookpay || [])]) tl.push({ type: '수납', date: p.paid_date, subject: '공통', html: `<div class="row"><b>${h(p.kind)}</b>${p.month ? `<span class="small muted">${h(p.month)}분</span>` : ''}<b>${won(p.amount)}</b><span class="small muted">${h(p.method || '')} ${h(p.memo || '')}</span></div>` });
    for (const w of d.words || []) tl.push({ type: '단어시험', date: w.date, subject: '영어', html: `<div class="row"><span class="wchip ${w.passed ? 'ok' : 'no'}">${w.attempt > 1 ? '재시험 ' : ''}${w.score}/${w.total} ${w.passed ? '✓ 통과' : '✗ 불통'}</span><span class="small muted">${h(w.book || '')} ${h(w.range || '')}${w.round ? ` · ${w.round}회독` : ''}${w.kind ? ` · ${h(w.kind)}` : ''} · ${h(w.teacher_name || '')}</span>${w.photo_v ? `<a href="/api/word/photos/${w.id}?v=${w.photo_v}" target="_blank" class="small">📷 시험지</a>` : ''}</div>${w.memo ? `<div class="small">${h(w.memo)}</div>` : ''}` });
    for (const b of d.bills || []) tl.push({ type: '청구서', date: (b.sent_at || '').slice(0, 10), subject: '공통', html: `<div class="row"><b>${Number(b.month.slice(5))}월 ${b.kind === 'book' ? '교재비' : b.kind === 'tuition' ? '교육비' : ''} 청구서 ${won(b.total)}</b>${statusChip(b.status)}<span class="small muted">${h(b.sent_by_name || '')}</span></div>` });
    for (const x of d.subjects || []) {
      if (x.start_date) tl.push({ type: '등록·퇴원', date: x.start_date, subject: x.subject, html: `<div class="row"><b>${h(x.subject)} 등록</b></div>` });
      if (x.end_date) tl.push({ type: '등록·퇴원', date: x.end_date, subject: x.subject, html: `<div class="row"><b>${h(x.subject)} 퇴원</b></div>` });
    }
    for (const f of d.flags) tl.push({ type: '걱정 표시', date: (f.created_at || '').slice(0, 10), subject: '공통', html: `<div class="row">${f.resolved ? '<span class="chip">해결됨</span>' : '<span class="chip red">진행 중</span>'}<b>${h(f.reason)}</b><span class="small muted">${h(f.created_by_name || '')}</span></div>${f.resolution ? `<div class="small muted">→ ${h(f.resolution)}</div>` : ''}` });
    tl.sort((x, y) => (y.date || '').localeCompare(x.date || ''));
    const ICON = { 상담: '💬', '수업 일지': '📘', 단어시험: '🔤', 출결: '⏰', 피드백: '📝', 교재: '📚', 수납: '💳', 청구서: '🧾', '등록·퇴원': '🚪', '걱정 표시': '🚨' };
    const types = Object.keys(ICON).filter((t) => tl.some((x) => x.type === t));
    const tlSubjects = [...new Set(tl.map((x) => x.subject).filter((x) => x && x !== '공통'))];
    let lastMonth = '';
    const tlHtml = tl.map((x) => {
      const m = (x.date || '').slice(0, 7);
      const head = m !== lastMonth ? ((lastMonth = m), `<div class="tl-month" data-month>${m ? `${m.slice(0, 4)}년 ${Number(m.slice(5))}월` : '날짜 없음'}</div>`) : '';
      return `${head}<div class="tl-item" data-type="${h(x.type)}" data-subject="${h(x.subject || '공통')}">
        <div class="tl-date">${x.date ? prettyDate(x.date) : ''}</div>
        <div class="tl-dot">${ICON[x.type]}</div>
        <div class="tl-body"><div class="small muted">${h(x.type)}${x.subject && x.subject !== '공통' ? ' · ' + h(x.subject) : ''}</div>${x.html}</div></div>`;
    }).join('');

    const tile = (label, big, sub, tone = '') => `<div class="card stat ${tone}"><div class="label">${label}</div><div class="num" style="font-size:22px">${big}</div><div class="sub">${sub}</div></div>`;
    const tiles = [
      tile('✅ 최근 30일 출석', rate == null ? '-' : `${rate}<small>%</small>`, `결석 ${absent30} · 지각/조퇴 ${late30}`, absent30 >= 2 ? 'warn' : ''),
      ts && tile(`💳 ${mm}월 교육비`, ts.state === '완납' ? '완납' : ts.state === '부분' ? `${won(ts.due)} 남음` : ts.state === '미납' ? '미납' : '-', ts.fee ? `${won(ts.fee)} 중 ${won(ts.paid)} 납부` : '수강료 미정', ts.state === '미납' || ts.state === '부분' ? 'warn' : ''),
      bs && tile('📚 교재비', bs.due ? `${won(bs.due)} 미납` : '정산 완료', `배부 ${won(bs.total)} · 납부 ${won(bs.paid)}`, bs.due ? 'warn' : ''),
      tile('💬 상담', d.consultations[0] ? prettyDate(d.consultations[0].date) : '없음', pendingFollow.length ? `📌 할 일 ${pendingFollow.length}건 남음` : `모두 ${d.consultations.length}건`),
      (() => { const l30 = d.logs.filter((l) => l.date >= since30); const x = l30.filter((l) => l.hw === '×').length, p = l30.filter((l) => l.hw === '△').length, chk = l30.filter((l) => l.hw).length;
        const ach = l30.filter((l) => l.achieve); const last = ach[0];
        return tile('✏️ 숙제·성취도 (30일)', chk ? `×${x}<small> / ${chk}번</small>` : '-', `${p ? `일부 ${p}번 · ` : ''}${last ? `최근 성취도 ${h(last.achieve)}` : lastLog ? '최근 수업 ' + prettyDate(lastLog.date) : '수업 일지가 아직 없어요'}`, x >= 3 ? 'warn' : ''); })(),
      (d.words || []).length && (() => { const w30 = d.words.filter((w) => w.date >= since30 && w.attempt === 1); const p = w30.filter((w) => w.passed).length; const re = d.words.filter((w) => w.date >= since30 && w.attempt > 1).length;
        return tile('🔤 단어시험 (30일)', w30.length ? `${Math.round((p / w30.length) * 100)}<small>% 통과</small>` : '-', `본시험 ${w30.length}번 · 재시험 ${re}번`, w30.length && p / w30.length < 0.7 ? 'warn' : ''); })(),
      tile('🚨 이탈 신호', openFlags.length ? `${openFlags.length}건` : '없음', openFlags.length ? h(openFlags[0].reason) : '걱정 표시 없음', openFlags.length ? 'warn' : ''),
    ].filter(Boolean);

    const payTable = (list, kind) => list.length ? `<table class="list"><thead><tr>${kind === '교육비' ? '<th>해당 월</th>' : '<th>내용</th>'}<th>납부일</th><th>금액</th><th>방법</th>${own ? '<th></th>' : ''}</tr></thead><tbody>${list.map((p) => `
        <tr><td>${kind === '교육비' ? h(p.month) : h(p.memo || '-')}</td><td>${h(p.paid_date)}</td><td><b>${won(p.amount)}</b></td><td>${h(p.method || '')}${kind === '교육비' && p.memo ? `<div class="small muted">${h(p.memo)}</div>` : ''}</td>
        ${own ? `<td style="text-align:right"><button class="btn sm danger no-print" data-delpay="${p.id}">삭제</button></td>` : ''}</tr>`).join('')}</tbody></table>` : '<div class="empty">수납 기록이 없어요</div>';
    const monthTable = (d.tuition_months || []).length ? `<table class="list" style="margin-bottom:10px"><thead><tr><th>달</th><th>납부 합계</th><th>상태</th></tr></thead><tbody>${d.tuition_months.map((m) => {
        const fee = d.monthly_fee || 0;
        const st = !fee ? '' : m.paid >= fee ? '<span class="chip green">완납</span>' : `<span class="chip orange">${won(fee - m.paid)} 남음</span>`;
        return `<tr><td>${h(m.month)}</td><td><b>${won(m.paid)}</b>${m.count > 1 ? ` <span class="small muted">(${m.count}번 나눠 냄)</span>` : ''}</td><td>${st}</td></tr>`;
      }).join('')}</tbody></table>` : '';

    el.innerHTML = `
      <div class="no-print"><a href="#/students" class="small muted">← 학생 명부</a></div>
      <div class="card profile mt">
        <div class="profile-photo" id="photoBtn" title="사진 바꾸기">${sAvatar(s, 104)}<span class="no-print">📷</span></div>
        <div class="profile-main">
          <div class="row"><h1>${h(s.name)}</h1>${statusChip(s.status)}${d.siblings && d.siblings.length ? `<span class="chip gold">형제·자매 ${d.siblings.length}명</span>` : ''}</div>
          <div class="muted">${h(s.school || '')} ${h(s.grade || '')}${v.birth && s.birth_date ? ` · ${ageOf(s.birth_date)}` : ''}${d.courses.length ? ` · ${d.courses.filter((c) => c.active).map((c) => h(c.subject)).join(', ')}` : ''}</div>
        </div>
        <div class="profile-actions no-print">
          <button class="btn" id="consult">💬 상담 기록</button>
          <button class="btn" id="flag">🚨 걱정 표시</button>
          <button class="btn" onclick="window.print()">🖨️ 인쇄</button>
          ${edit ? '<button class="btn primary" id="edit">인적사항 고치기</button>' : ''}
        </div>
      </div>

      <div class="glance mt">${tiles.join('')}</div>

      <div class="grid g2 mt">
        <div class="card"><h2>인적사항</h2>
          <table class="list kv"><tbody>${info.map(([k, val]) => `<tr><td class="muted">${k}</td><td>${val}</td></tr>`).join('')}</tbody></table>
          <h2 class="mt">과목별 등록 · 퇴원</h2>
          ${d.subjects.length ? `<table class="list"><thead><tr><th>과목</th><th>등록일</th><th>퇴원일</th><th></th><th></th></tr></thead><tbody>${d.subjects.map((x) => `
            <tr><td><span class="chip">${h(x.subject)}</span></td><td>${h(x.start_date || '-')}</td><td>${h(x.end_date || '-')}</td>
            <td>${x.end_date ? '<span class="chip">퇴원</span>' : '<span class="chip green">수강 중</span>'}</td>
            <td style="text-align:right">${edit ? `<button class="btn sm no-print" data-subjedit="${h(x.subject)}">고치기</button>` : ''}</td></tr>`).join('')}</tbody></table>` : '<div class="muted small">아직 과목 기록이 없어요. 반에 넣으면 등록일이 자동으로 들어가요.</div>'}
          ${edit ? '<button class="btn sm mt no-print" id="subjAdd">＋ 과목 날짜 넣기</button>' : ''}
        </div>
        <div class="card"><h2>수강 과목${v.fees ? ' · 수강료' : ''}</h2>
          ${d.courses.length ? `<table class="list"><tbody>${d.courses.map((c) => `
            <tr style="${c.active ? '' : 'opacity:.5'}"><td><span class="chip">${h(c.subject)}</span></td>
              <td><b>${h(c.name)}</b><div class="small muted row" style="gap:6px">${withAvatar(c.teacher_id, c.teacher_photo_v, c.teacher_name, 18)} ${h(scheduleText(c))}</div></td>
              ${v.fees ? `<td style="text-align:right;white-space:nowrap">${won(c.fee)}${c.fee_custom ? '<div class="small muted">개별 금액</div>' : ''}${own ? ` <button class="btn sm no-print" data-fee="${c.id}">수정</button>` : ''}</td>` : ''}</tr>`).join('')}</tbody></table>
            ${v.fees ? `
            ${d.discount_items && d.discount_items.length ? `<div class="discounts mt"><div class="small muted">할인${own ? ' (체크하면 바로 저장돼요)' : ''}</div>
              <div class="days">${d.discount_items.map((i) => `<label class="${i.on ? 'on' : ''}"><input type="checkbox" data-disc="${h(i.id)}" ${i.on ? 'checked' : ''} ${own ? '' : 'disabled'}> ${h(i.name)} <b>-${won(i.amount)}</b></label>`).join('')}</div></div>` : ''}
            <div class="row mt"><span class="muted">수강료 ${won(d.gross_fee)}${d.discount_total ? ` − 할인 ${won(d.discount_total)}` : ''}</span><span class="space"></span><span class="muted small">월 수강료</span><b style="font-size:18px">${won(d.monthly_fee)}</b></div>` : ''}`
            : `<div class="empty">아직 반에 들어가 있지 않아요${edit ? ' — [반 관리]에서 넣어 주세요' : ''}</div>`}
          ${v.siblings ? `
          <h2 class="mt">형제·자매</h2>
          <div class="row">${(d.siblings || []).map((x) => `<a class="sib" href="#/students/${x.id}">${sAvatar(x, 26)}<span><b>${h(x.name)}</b> <span class="small muted">${h(x.school || '')} ${h(x.grade || '')}</span></span>${statusChip(x.status)}${edit ? `<button class="btn sm no-print" data-unsib="${x.id}" title="연결 끊기">✕</button>` : ''}</a>`).join('') || '<span class="muted small">우리 학원에 다니는 형제·자매가 없어요</span>'}</div>
          ${s.sibling_note ? `<div class="small mt">📝 ${h(s.sibling_note)}</div>` : ''}
          ${edit ? '<button class="btn sm mt no-print" id="sib">＋ 형제·자매 연결</button>' : ''}` : ''}
        </div>
      </div>

      <div class="card mt">
        <div class="row"><h2 style="margin:0">기록 타임라인 <span class="small muted">모든 선생님 기록 · 최근 것부터</span></h2></div>
        ${tl.length ? `
        <div class="tabs no-print mt">${['전체', ...types].map((t, i) => `<button class="btn sm ${i ? '' : 'primary'}" data-tltype="${i ? h(t) : ''}">${i ? ICON[t] + ' ' : ''}${h(t)} ${i ? tl.filter((x) => x.type === t).length : tl.length}</button>`).join('')}</div>
        ${tlSubjects.length > 1 ? `<div class="tabs no-print" style="margin-top:6px"><button class="btn sm primary" data-tlsub="">모든 과목</button>${tlSubjects.map((x) => `<button class="btn sm" data-tlsub="${h(x)}">${h(x)}</button>`).join('')}</div>` : ''}
        <div class="timeline mt" id="timeline">${tlHtml}</div>` : '<div class="empty">아직 기록이 없어요</div>'}
      </div>

      ${v.tuition || v.bookpay ? `<div class="grid g2 mt">
        ${v.tuition ? `<div class="card"><div class="row"><h2 style="margin:0">교육비</h2><span class="space"></span>${own ? '<button class="btn sm no-print" data-addpay="교육비">＋ 수납 기록</button>' : ''}</div>
          ${ts && ts.fee ? `<div class="small mt">${mm}월: 수강료 ${won(ts.fee)} 중 <b>${won(ts.paid)}</b> 납부${ts.due ? ` · <b style="color:var(--red)">${won(ts.due)} 남음</b>` : ' · ✅ 완납'}</div>` : ''}
          <div class="mt">${monthTable}${payTable(d.tuition, '교육비')}</div></div>` : '<div></div>'}
        ${v.bookpay ? `<div class="card"><div class="row"><h2 style="margin:0">교재비</h2><span class="space"></span>${own ? '<button class="btn sm no-print" data-addpay="교재비">＋ 수납 기록</button>' : ''}</div>
          <div class="small mt">배부한 교재 ${won(bs.total)} · 납부 ${won(bs.paid)}${bs.due ? ` · <b style="color:var(--red)">${won(bs.due)} 미납</b>` : ' · ✅ 정산 완료'}${bs.over ? ` · <span class="chip blue">${won(bs.over)} 더 냄</span>` : ''}</div>
          <div class="mt">${payTable(d.bookpay, '교재비')}</div></div>` : ''}
      </div>` : ''}

      ${v.books ? `
      <div class="card mt">
        <div class="row"><h2 style="margin:0">교재 배부 내역</h2><span class="space"></span><button class="btn sm no-print" id="addBook">＋ 교재 배부</button></div>
        ${d.books.length ? `<div class="table-wrap mt"><table class="list"><thead><tr><th></th><th>날짜</th><th>과목</th><th>교재</th><th>수량</th><th>가격</th><th>준 사람</th><th>메모</th><th></th></tr></thead><tbody>${d.books.map((b) => `
          <tr><td style="width:40px">${b.book_id ? `<a href="#/books/${b.book_id}">${bookImg(b.book_id, b.book_image_v, 32)}</a>` : bookImg(0, null, 32)}</td><td>${h(b.date)}</td><td>${h(b.subject || '')}</td><td><b>${h(b.title)}</b></td><td>${b.qty}</td><td>${won(b.price)}</td><td>${h(b.given_by_name || '')}</td><td class="small">${h(b.memo || '')}</td>
          <td style="text-align:right">${own || b.given_by === state.me.id ? `<button class="btn sm danger no-print" data-delbook="${b.id}">삭제</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">교재 배부 기록이 없어요</div>'}
      </div>` : ''}

      <div class="card mt no-print"><h2>최근 보낸 문자</h2>${d.messages.length ? `<table class="list"><tbody>${d.messages.map((m) => `<tr><td style="white-space:nowrap">${prettyTime(m.created_at)}</td><td>${h(m.kind)}</td><td class="small">${h(fmtPhone(m.to_phone) || '')}</td><td>${statusChip(m.status)}</td><td><details><summary class="small">${h(m.body.slice(0, 30))}…</summary><div class="preview">${h(m.body)}</div></details></td></tr>`).join('')}</tbody></table>` : '<div class="empty">보낸 문자가 없어요</div>'}</div>
      ${own ? '' : '<div class="small muted mt">🔒 원장님이 정한 범위의 정보만 보여요.</div>'}`;

    // 타임라인 고르기
    const tlFilter = { type: '', sub: '' };
    const applyTl = () => {
      const items = $$('#timeline .tl-item', el);
      items.forEach((it) => (it.style.display = (!tlFilter.type || it.dataset.type === tlFilter.type) && (!tlFilter.sub || it.dataset.subject === tlFilter.sub || it.dataset.subject === '공통') ? '' : 'none'));
      // 보이는 항목이 없는 달 제목은 숨기기
      $$('#timeline [data-month]', el).forEach((mh) => {
        let n = mh.nextElementSibling, any = false;
        while (n && !n.hasAttribute('data-month')) { if (n.style.display !== 'none') any = true; n = n.nextElementSibling; }
        mh.style.display = any ? '' : 'none';
      });
    };
    $$('[data-tltype]', el).forEach((b) => (b.onclick = () => { $$('[data-tltype]', el).forEach((x) => x.classList.toggle('primary', x === b)); tlFilter.type = b.dataset.tltype; applyTl(); }));
    $$('[data-tlsub]', el).forEach((b) => (b.onclick = () => { $$('[data-tlsub]', el).forEach((x) => x.classList.toggle('primary', x === b)); tlFilter.sub = b.dataset.tlsub; applyTl(); }));

    $('#photoBtn').onclick = () => pickStudentPhoto(id, reload);
    $('#consult').onclick = () => consultModal({ student_id: id });
    $('#flag').onclick = () => flagModal(id);

    if ($('#addBook')) $('#addBook').onclick = async () => {
      const { books } = await api('GET', '/api/catalog');
      modal({
      title: `${s.name} 교재 배부`,
      body: `${books.length ? `<label class="field"><span>교재 관리에서 고르기</span><select name="book_id" id="bkSel"><option value="">— 직접 적기 —</option>${books.map((b) => `<option value="${b.id}">${h(b.name)} (${h(b.level || '')} ${h(b.subject || '')} · ${won(b.sale_price ?? b.list_price)} · 재고 ${b.stock})</option>`).join('')}</select></label>
        <div id="bkPrev" class="row" style="margin-bottom:10px"></div>` : '<p class="small muted">💡 [교재 관리]에 교재를 등록해 두면 목록에서 골라 사진·가격이 자동으로 들어가요.</p>'}
        <div class="grid g2"><label class="field"><span>날짜</span><input type="date" name="date" value="${todayStr()}"></label>
        <label class="field"><span>과목</span><select name="subject"><option value="">선택 안 함</option>${SUBJECTS.map((x) => `<option>${x}</option>`).join('')}</select></label></div>
        <label class="field"><span>교재 이름</span><input type="text" name="title" required placeholder="예: 쎈 수학 중2-1"></label>
        <div class="grid g2"><label class="field"><span>수량</span><input type="text" name="qty" value="1" inputmode="numeric"></label>
        <label class="field"><span>가격 (선택)</span><input type="text" name="price" inputmode="numeric" placeholder="예: 15000"></label></div>
        <label class="field"><span>메모</span><input type="text" name="memo"></label>`,
      onOpen: (f) => {
        const sel = $('#bkSel', f);
        if (!sel) return;
        sel.onchange = () => {
          const b = books.find((x) => x.id === Number(sel.value));
          $('#bkPrev', f).innerHTML = b ? `${bookImg(b.id, b.image_v, 48)}<div><b>${h(b.name)}</b><div class="small muted">정가 ${won(b.list_price)} · 판매가 ${won(b.sale_price)} · 재고 ${b.stock}</div></div>` : '';
          $('input[name=title]', f).required = !b;
          $('input[name=title]', f).closest('label').style.display = b ? 'none' : '';
          if (b) { $('select[name=subject]', f).value = b.subject || ''; $('input[name=price]', f).value = b.sale_price ?? b.list_price ?? ''; }
        };
      },
      onSubmit: async (f) => { await api('POST', `/api/students/${id}/books`, f); toast('기록했어요'); reload(); },
    });
    };
    $$('[data-disc]', el).forEach((cb) => (cb.onchange = async () => {
      const ids = $$('[data-disc]', el).filter((x) => x.checked).map((x) => x.dataset.disc);
      try { await api('PUT', `/api/students/${id}/discounts`, { item_ids: ids }); toast('할인을 저장했어요'); reload(); } catch (e) { toast(e.message); }
    }));
    const subjModal = (x = {}) => modal({
      title: x.subject ? `${x.subject} 등록 · 퇴원` : '과목 날짜 넣기',
      body: `<label class="field"><span>과목</span><select name="subject" ${x.subject ? 'disabled' : ''}>${SUBJECTS.map((sj) => `<option ${x.subject === sj ? 'selected' : ''}>${sj}</option>`).join('')}</select></label>
        <div class="grid g2"><label class="field"><span>등록일</span><input type="date" name="start_date" value="${h(x.start_date || '')}"></label>
        <label class="field"><span>퇴원일 (그만둘 때만)</span><input type="date" name="end_date" value="${h(x.end_date || '')}"></label></div>
        <label class="inline-check"><input type="checkbox" name="remove" checked> 퇴원일을 넣으면 그 과목 반에서도 빼기</label>
        <p class="small muted">학생 전체가 그만두는 경우는 [인적사항 고치기]에서 상태를 "퇴원"으로 바꿔 주세요.</p>`,
      onSubmit: async (f) => { await api('PUT', `/api/students/${id}/subjects`, { subject: x.subject || f.subject, start_date: f.start_date, end_date: f.end_date, remove_from_courses: !!f.remove }); toast('저장했어요'); reload(); },
    });
    $$('[data-subjedit]', el).forEach((b) => (b.onclick = () => subjModal(d.subjects.find((x) => x.subject === b.dataset.subjedit))));
    if ($('#subjAdd')) $('#subjAdd').onclick = () => subjModal();
    $$('[data-delbook]', el).forEach((b) => (b.onclick = async () => { if (!confirm('이 교재 배부 기록을 지울까요?')) return; try { await api('DELETE', `/api/deliveries/${b.dataset.delbook}`); reload(); } catch (e) { toast(e.message); } }));
    if (!edit) return;

    $('#edit').onclick = () => modal({
      title: '인적사항 고치기', wide: true, body: studentForm(s),
      foot: isOwner() ? '<button type="button" class="btn danger" id="stuDel">🗑 학생 기록 삭제</button>' : '',
      onOpen: (f, closeEdit) => {
        if (!isOwner()) return;
        $('#stuDel', f).onclick = () => { closeEdit(); deleteStudentModal(s); };
      },
      onSubmit: async (f) => { await api('PATCH', `/api/students/${id}`, f); toast('저장했어요'); reload(); },
    });
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
    const own = isOwner();
    const [{ courses }, { teachers }] = await Promise.all([api('GET', '/api/courses?active=all'), own ? api('GET', '/api/teachers') : Promise.resolve({ teachers: [] })]);
    el.innerHTML = `
      <div class="page-head"><div><h1>${own ? '반 관리' : '반 학생 넣기'}</h1><p>${own ? '반을 만들고 담당 선생님과 학생을 넣어 주세요. 선생님은 자기 반 학생만 볼 수 있어요.' : '반마다 [학생 넣기]를 눌러 학생을 배정해 주세요. 반 만들기·수강료는 원장님이 정해요.'}</p></div>
        ${own ? '<button class="btn primary" id="add">＋ 반 만들기</button>' : ''}</div>
      <div class="card"><div class="table-wrap"><table class="list">
        <thead><tr><th>반 이름</th><th>과목</th><th>담당</th><th>요일·시간</th>${own ? '<th>월 수강료</th>' : ''}<th>학생</th><th></th></tr></thead>
        <tbody>${courses.map((c) => `<tr style="${c.active ? '' : 'opacity:.5'}">
          <td><b>${h(c.name)}</b>${c.active ? '' : ' <span class="chip">종료</span>'}${c.room ? `<div class="small muted">${h(c.room)}</div>` : ''}</td>
          <td>${h(c.subject)}</td><td>${c.teacher_name ? withAvatar(c.teacher_id, c.teacher_photo_v, c.teacher_name) : '-'}</td>
          <td class="small">${h(scheduleText(c))}</td>
          ${own ? `<td>${c.fee != null ? Number(c.fee).toLocaleString('ko-KR') + '원' : '-'}</td>` : ''}
          <td>${c.student_count}명</td>
          <td style="text-align:right;white-space:nowrap"><button class="btn sm" data-setup="${c.id}">📚 교재·일지</button> <button class="btn sm" data-stu="${c.id}">학생 넣기·빼기</button>${own ? ` <button class="btn sm" data-edit="${c.id}">고치기</button>` : ''}</td></tr>`).join('')}</tbody>
      </table></div>${courses.length ? '' : '<div class="empty">아직 반이 없어요</div>'}</div>`;
    const byId = new Map(courses.map((c) => [c.id, c]));
    const form = (c = {}) => {
      const times = courseTimes(c);
      return `
        <div class="grid g2">
          <label class="field"><span>반 이름</span><input type="text" name="name" value="${h(c.name)}" required placeholder="예: 중2 수학 A"></label>
          <label class="field"><span>과목</span><select name="subject" required>${SUBJECTS.map((s) => `<option ${c.subject === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
          <label class="field"><span>담당 선생님</span><select name="teacher_id"><option value="">없음</option>${teachers.map((t) => `<option value="${t.id}" ${c.teacher_id === t.id ? 'selected' : ''}>${h(t.name)}${t.role === 'owner' ? ' (원장)' : t.staff_role === 'manager' ? ' (감독)' : ''}</option>`).join('')}</select></label>
          <label class="field"><span>강의실</span><input type="text" name="room" value="${h(c.room)}" placeholder="예: 1관 201호"></label>
          <label class="field"><span>월 수강료 (기본)</span><input type="text" name="fee" inputmode="numeric" value="${h(c.fee ?? '')}" placeholder="예: 320000"></label>
        </div>
        <div class="field"><span class="small muted">수업 요일과 시간 — 요일에 체크하고 그 요일의 시간을 적어 주세요</span>
          <table class="timetable">${DAYS.map((d) => `<tr data-day="${d}" class="${times[d] ? 'on' : ''}">
            <td><label class="inline-check"><input type="checkbox" name="day_${d}" ${times[d] ? 'checked' : ''}> <b>${d}</b></label></td>
            <td><input type="time" name="start_${d}" value="${h(times[d] ? times[d].start : '')}"></td><td class="muted">~</td>
            <td><input type="time" name="end_${d}" value="${h(times[d] ? times[d].end : '')}"></td></tr>`).join('')}</table>
          <button type="button" class="btn sm" data-copytime style="margin-top:6px">⤵ 첫 번째 요일 시간을 체크한 요일에 모두 똑같이 넣기</button>
        </div>
        ${c.id ? `<label class="inline-check"><input type="checkbox" name="active" ${c.active ? 'checked' : ''}> 운영 중인 반 (끄면 종료된 반)</label>` : ''}`;
    };
    const toBody = (d, editing) => ({
      name: d.name, subject: d.subject, teacher_id: d.teacher_id || null, room: d.room, fee: d.fee,
      times: Object.fromEntries(DAYS.filter((x) => d['day_' + x]).map((x) => [x, { start: d['start_' + x] || null, end: d['end_' + x] || null }])),
      ...(editing ? { active: !!d.active } : {}),
    });
    // 시간표 칸 동작: 시간을 적으면 그 요일 자동 체크, "똑같이 넣기" 버튼
    const wireTimes = (f) => {
      $$('.timetable tr', f).forEach((tr) => {
        const box = $('input[type=checkbox]', tr);
        const sync = () => tr.classList.toggle('on', box.checked);
        box.onchange = sync;
        $$('input[type=time]', tr).forEach((i) => (i.oninput = () => { if (i.value) { box.checked = true; sync(); } }));
      });
      $('[data-copytime]', f).onclick = () => {
        const rows = $$('.timetable tr', f).filter((tr) => $('input[type=checkbox]', tr).checked);
        if (!rows.length) return toast('먼저 요일에 체크하고 첫 요일 시간을 적어 주세요');
        const [st, en] = $$('input[type=time]', rows[0]).map((i) => i.value);
        rows.slice(1).forEach((tr) => { const [a, b] = $$('input[type=time]', tr); a.value = st; b.value = en; });
      };
    };
    if (own) $('#add').onclick = () => modal({ title: '반 만들기', wide: true, body: form(), onOpen: wireTimes, onSubmit: async (d) => { await api('POST', '/api/courses', toBody(d)); toast('반을 만들었어요'); reload(); } });
    $$('[data-edit]', el).forEach((b) => (b.onclick = () => {
      const c = byId.get(Number(b.dataset.edit));
      modal({ title: '반 고치기', wide: true, body: form(c), onOpen: wireTimes, onSubmit: async (d) => { await api('PATCH', `/api/courses/${c.id}`, toBody(d, true)); toast('저장했어요'); reload(); } });
    }));
    $$('[data-setup]', el).forEach((b) => (b.onclick = () => setupModal(Number(b.dataset.setup), reload)));
    $$('[data-stu]', el).forEach((b) => (b.onclick = async () => {
      const c = byId.get(Number(b.dataset.stu));
      const [{ students }, cur] = await Promise.all([api('GET', '/api/students?status=재원'), api('GET', `/api/courses/${c.id}`)]);
      const info = new Map(students.map((s) => [s.id, s]));
      cur.students.forEach((s) => { if (!info.has(s.id)) info.set(s.id, s); }); // 휴원·퇴원생도 이 반에 있으면 빼기에 보여요
      const orig = new Set(cur.students.map((s) => s.id));
      const sel = new Set(orig);
      const line = (s) => `<b>${h(s.name)}</b> <span class="muted small">${h(s.school || '')} ${h(s.grade || '')}${s.status && s.status !== '재원' ? ` · ${h(s.status)}` : ''}</span>`;
      modal({
        title: `${c.name} 학생 넣기·빼기`, wide: true, submitText: '저장',
        body: `
          <div class="row"><b>이 반 학생</b> <span class="small muted" id="cnt"></span></div>
          <div class="small muted">잘못 넣은 학생은 오른쪽 <b>빼기</b>를 누르세요. 저장을 눌러야 반영돼요.</div>
          <div class="checklist" id="inList" style="margin-top:6px;max-height:260px"></div>
          <div class="row mt"><b>학생 넣기</b><span class="small muted">재원생 중에서 찾아서 <b>넣기</b>를 누르세요</span></div>
          <input type="search" id="find" placeholder="이름·학교로 찾기" style="margin:6px 0">
          <div class="checklist" id="outList" style="max-height:260px"></div>
          <div class="small" style="margin-top:8px" id="chg"></div>`,
        onOpen: (f) => {
          let q = '';
          const draw = () => {
            const inS = [...sel].map((id) => info.get(id)).filter(Boolean).sort((a, b2) => a.name.localeCompare(b2.name, 'ko'));
            $('#inList', f).innerHTML = inS.map((s) => `<div class="row" style="padding:6px 2px;border-bottom:1px solid #f3f1ec"><span>${line(s)}${orig.has(s.id) ? '' : ' <span class="chip green">새로 넣음</span>'}</span><span class="space"></span><button type="button" class="btn sm danger" data-out="${s.id}">빼기</button></div>`).join('') || '<div class="empty">아직 학생이 없어요</div>';
            const outS = students.filter((s) => !sel.has(s.id) && (!q || (s.name + ' ' + (s.school || '') + ' ' + (s.grade || '')).toLowerCase().includes(q)));
            $('#outList', f).innerHTML = outS.map((s) => `<div class="row" style="padding:6px 2px;border-bottom:1px solid #f3f1ec"><span>${line(s)}${orig.has(s.id) ? ' <span class="chip red">뺄 예정</span>' : ''}</span><span class="space"></span><button type="button" class="btn sm primary" data-in="${s.id}">넣기</button></div>`).join('') || `<div class="empty">${q ? '찾는 학생이 없어요' : '넣을 수 있는 재원생이 없어요'}</div>`;
            $('#cnt', f).textContent = `${sel.size}명`;
            const added = [...sel].filter((id) => !orig.has(id)).length, removed = [...orig].filter((id) => !sel.has(id));
            $('#chg', f).innerHTML = added || removed.length ? `바뀐 내용: ${added ? `<b class="green-t">${added}명 넣기</b>` : ''}${added && removed.length ? ' · ' : ''}${removed.length ? `<b class="red-t">${removed.map((id) => h(info.get(id).name)).join(', ')} 빼기</b>` : ''} — <b>저장</b>을 눌러 주세요` : '<span class="muted">아직 바뀐 게 없어요</span>';
            $$('[data-out]', f).forEach((x) => (x.onclick = () => { sel.delete(Number(x.dataset.out)); draw(); }));
            $$('[data-in]', f).forEach((x) => (x.onclick = () => { sel.add(Number(x.dataset.in)); draw(); }));
          };
          $('#find', f).oninput = (e) => { q = e.target.value.trim().toLowerCase(); draw(); };
          draw();
        },
        onSubmit: async () => {
          const removed = [...orig].filter((id) => !sel.has(id));
          if (removed.length && !confirm(`${removed.map((id) => info.get(id).name).join(', ')} 학생을 ${c.name}에서 뺄까요?\n(출결·수업 일지 기록은 지워지지 않아요)`)) return true;
          const r = await api('PUT', `/api/courses/${c.id}/students`, { student_ids: [...sel] });
          toast(`저장했어요 · ${r.added}명 넣고 ${removed.length}명 뺐어요 (모두 ${r.count}명)`);
          reload();
        },
      });
    }));
  }

  // 학생 기록 완전히 삭제 (원장만)
  function deleteStudentModal(s) {
    modal({
      title: `${s.name} 학생 기록 삭제`,
      submitText: '완전히 삭제하기',
      body: `
        <div class="howto" style="border-color:var(--red);background:#fff5f5">
          <b class="red-t">⚠ 삭제하면 되돌릴 수 없어요.</b><br>
          인적사항·사진, 반 배정, 출결, 수업 일지의 이 학생 기록, 상담, 피드백, 문자 기록, 단어시험, 할인, 청구서, 수납 기록이 <b>모두 지워져요.</b>
          <div class="small muted" style="margin-top:6px">교재 재고 숫자가 틀어지지 않도록, 교재를 나눠 준 수량만 이름 없이 남아요.</div>
        </div>
        <div class="small" style="margin-top:10px">💡 그만둔 학생은 삭제 대신 <b>[인적사항 고치기]에서 상태를 "퇴원"</b>으로 바꾸면 기록이 남아서, 다시 올 때 이어서 쓸 수 있어요.<br>삭제는 <b>잘못 등록했거나 두 번 등록된 학생</b>에게만 써 주세요.</div>
        <label class="field mt"><span>정말 지우려면 학생 이름 <b>${h(s.name)}</b>을(를) 똑같이 적어 주세요</span><input type="text" name="confirm_name" autocomplete="off" placeholder="${h(s.name)}"></label>`,
      onOpen: (f) => {
        const btn = $('button[type=submit]', f);
        btn.classList.remove('primary'); btn.classList.add('danger'); btn.disabled = true;
        $('input[name=confirm_name]', f).oninput = (e) => { btn.disabled = e.target.value.replace(/\s/g, '') !== String(s.name).replace(/\s/g, ''); };
      },
      onSubmit: async (d) => {
        await api('DELETE', `/api/students/${s.id}`, { confirm_name: d.confirm_name });
        toast(`${s.name} 학생 기록을 삭제했어요`);
        location.hash = '#/students';
      },
    });
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
      <div class="page-head"><div><h1>선생님 계정</h1><p>선생님마다 아이디를 만들어 드리세요. 강사는 자기 반 학생만 보고, 감독은 전체 학생을 보며 학생 등록·반 배정을 할 수 있어요. 원장 전용 메뉴와 수납은 원장님만 봐요.</p></div>
        <button class="btn primary" id="add">＋ 선생님 추가</button></div>
      <div class="card"><div class="table-wrap"><table class="list">
        <thead><tr><th></th><th>이름</th><th>아이디</th><th>역할</th><th>연락처</th><th>담당 반</th><th>상태</th><th></th></tr></thead>
        <tbody>${users.map((u) => `<tr style="${u.active ? '' : 'opacity:.5'}"><td style="width:52px">${avatar(u.id, u.photo_v, u.name, 38)}</td><td><b>${h(u.name)}</b></td><td>${h(u.login_id)}</td><td>${roleChip(u)}</td>
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
        <label class="field"><span>역할</span><select name="role"><option value="teacher">강사 (자기 반 학생만)</option><option value="manager">감독 (전체 학생 열람·학생 등록·반 배정)</option><option value="owner">원장 (모든 권한)</option></select></label>`,
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
          ${u.role === 'teacher' ? `<label class="field"><span>역할</span><select name="role"><option value="teacher" ${u.staff_role !== 'manager' ? 'selected' : ''}>강사 (자기 반 학생만)</option><option value="manager" ${u.staff_role === 'manager' ? 'selected' : ''}>감독 (전체 학생 열람·학생 등록·반 배정)</option></select></label>` : ''}
          ${u.id === state.me.id ? '' : `<label class="inline-check"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> 사용 중 (끄면 로그인할 수 없어요)</label>`}`,
        onOpen: (f, close) => {
          $('[data-photo]', f).onclick = () => pickPhoto(u.id, () => { close(); if (u.id === state.me.id) renderShell(); reload(); });
          const del = $('[data-nophoto]', f);
          if (del) del.onclick = async () => { await api('DELETE', `/api/users/${u.id}/photo`); if (u.id === state.me.id) { state.me.photo_v = null; renderShell(); } close(); toast('사진을 지웠어요'); reload(); };
        },
        onSubmit: async (d) => {
          const body = { name: d.name, phone: d.phone };
          if (d.role) body.role = d.role;
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
        <h2 class="mt">할인 항목</h2>
        <p class="small muted" style="margin-top:-6px">학생 카드에서 체크하면 월 수강료에서 빠져요. 이름이나 금액을 바꾸면 체크된 학생 모두에게 바로 반영돼요.</p>
        <div id="discs">${s.discount_items.map((i) => `<div class="row disc-row" style="margin-bottom:6px"><input type="hidden" value="${h(i.id)}" data-did><input type="text" value="${h(i.name)}" data-dname style="flex:2"><input type="text" value="${i.amount}" data-damt inputmode="numeric" style="flex:1"><span class="small muted">원</span><button type="button" class="btn sm danger" data-ddel>✕</button></div>`).join('')}</div>
        <button type="button" class="btn sm" id="discAdd">＋ 할인 항목 추가</button>
        <h2 class="mt">교재 거래처</h2>
        <label class="field"><span>한 줄에 하나씩</span><textarea name="suppliers" style="min-height:110px">${h(s.book_suppliers.join('\n'))}</textarea></label>
        <h2 class="mt">청구서</h2>
        <label class="field"><span>교육비 입금 계좌</span><input type="text" name="bank_account" value="${h(s.bank_account || '')}" placeholder="예: 농협 123-4567-8901 (예금주 새솔학원)"></label>
        <label class="field"><span>교재비 입금 계좌 (교육비와 같으면 비워 두세요)</span><input type="text" name="bank_account_book" value="${h(s.bank_account_book || '')}" placeholder="예: 국민 987-65-43210 (예금주 이은희)"></label>
        <p class="small muted" style="margin-top:-6px">청구서에는 청구하는 항목에 맞는 계좌만 들어가요. 교육비·교재비를 같이 청구하면 두 계좌가 따로 적혀요.</p>
        <p class="small muted">청구서 문구 — 쓸 수 있는 칸: {학원} {학생} {월} {내역} {합계} {계좌}</p>
        <label class="field"><span>💳 교육비 청구서 문구</span><textarea name="tpl_bill_tuition" style="min-height:130px">${h(s.tpl_bill_tuition)}</textarea></label>
        <label class="field"><span>📚 교재비 청구서 문구</span><textarea name="tpl_bill_book" style="min-height:130px">${h(s.tpl_bill_book)}</textarea></label>
        <label class="field"><span>🧾 함께 청구할 때 문구</span><textarea name="tpl_bill" style="min-height:130px">${h(s.tpl_bill)}</textarea></label>
        <h2 class="mt">영단어 시험</h2>
        <div class="small">통과 기준은 시험 유형별로 고정이에요: <b>한글뜻 90%</b> · <b>스펠링 80%</b> · <b>혼합 90%</b>. 채점 화면에서 회독(1~4회독)과 유형을 골라요.<input type="hidden" name="word_pass_pct" value="${h(s.word_pass_pct || 90)}"></div>
        <p class="small muted mt">단어 교재 (교재 이름 · 개수 · Day 또는 Unit. 채점 화면에서 Day 1~N 또는 Unit 1~N 중 하나를 골라요. 학원 자체 단어장은 Unit으로 정해 주세요. 반 관리에서 교재·단원을 넣은 반은 그 단원으로 골라요)</p>
        <div id="wbooks">${s.word_books.map((b) => `<div class="row wb-row" style="margin-bottom:6px"><input type="text" class="wb-name" value="${h(b.name)}" style="flex:2"><input type="number" class="wb-days" value="${b.days}" style="width:80px"><select class="wb-unit" style="width:auto"><option ${b.unit === 'Unit' ? '' : 'selected'}>Day</option><option ${b.unit === 'Unit' ? 'selected' : ''}>Unit</option></select><span class="small muted">개</span><button type="button" class="btn sm danger" data-wbdel>✕</button></div>`).join('')}</div>
        <button type="button" class="btn sm" id="wbAdd">＋ 단어 교재 추가</button>
        <label class="field mt"><span>단어시험 결과 문자 — 쓸 수 있는 칸: {학원} {학생} {차수} {교재} {범위} {점수} {결과} {링크}</span><textarea name="tpl_word" style="min-height:110px">${h(s.tpl_word)}</textarea></label>
        <h2 class="mt">수업 일지 알림</h2>
        <p class="small muted" style="margin-top:-6px">수업이 끝나고 정한 시간이 지나도 일지가 없으면 그 선생님 대시보드에 알림이 뜨고, 문자도 보낼 수 있어요. 문자는 30분마다 확인해서 한 수업에 한 번만 보내요. (선생님 연락처가 [선생님 계정]에 있어야 해요)</p>
        <div class="row" style="gap:14px">
          <label class="inline-check"><input type="checkbox" name="lr_on" ${s.log_remind.on ? 'checked' : ''}> 알림 켜기</label>
          <label class="inline-check">수업 끝나고 <input type="text" name="lr_after" value="${s.log_remind.after_min}" inputmode="numeric" style="width:70px"> 분 뒤</label>
          <label class="inline-check"><input type="checkbox" name="lr_sms" ${s.log_remind.sms ? 'checked' : ''}> 선생님께 문자도 보내기</label>
        </div>
        <label class="inline-check mt" style="display:flex">이 날짜부터 일지 확인 <input type="date" name="lr_start" value="${h(s.log_remind.start_date || '')}" style="width:auto"> <span class="small muted">(이 날짜 전 수업은 "안 쓴 일지"로 세지 않아요. 앱을 처음 쓰기 시작하는 날로 정해 주세요)</span></label>
        <label class="field mt"><span>알림 문자 문구 — 쓸 수 있는 칸: {학원} {선생님} {반} {시간} {날짜}</span><textarea name="tpl_log_remind" style="min-height:70px">${h(s.tpl_log_remind)}</textarea></label>
        <h2 class="mt">강사에게 보여 줄 학생 정보</h2>
        <p class="small muted" style="margin-top:-6px">원장님은 항상 전부 볼 수 있어요. 강사는 체크한 항목만, 그리고 자기 반 학생만 볼 수 있어요. 감독은 전체 학생의 인적사항·연락처를 보고, 수강료·수납은 볼 수 없어요(주소는 이 체크를 따라요). 수납 기록은 원장님만 쓸 수 있어요.</p>
        <div class="view-grid">${Object.entries(s.teacher_view_labels).map(([k, l]) => `<label class="inline-check"><input type="checkbox" name="tv_${k}" ${s.teacher_view[k] ? 'checked' : ''}> ${h(l)}</label>`).join('')}</div>
        <h2 class="mt">문자 발송 방식</h2>
        <label class="inline-check" style="display:flex;margin-bottom:6px"><input type="radio" name="send_mode" value="preview" ${s.send_mode !== 'real' ? 'checked' : ''}> 미리보기 (연습용 — 실제로 나가지 않고 기록만 남아요)</label>
        <label class="inline-check" style="display:flex"><input type="radio" name="send_mode" value="real" ${s.send_mode === 'real' ? 'checked' : ''} ${s.solapi_ready ? '' : 'disabled'}> 실제 발송 (솔라피로 학부모님께 문자가 나가요)</label>
        <p class="small ${s.solapi_ready ? 'muted' : ''}" style="${s.solapi_ready ? '' : 'color:var(--orange)'}">${s.solapi_ready ? '✅ 솔라피 연결 준비가 끝났어요.' : '⚠️ 솔라피 키가 아직 등록되지 않았어요. Cloudflare에 키를 넣으면 "실제 발송"을 고를 수 있어요.'}</p>
        <div class="err"></div>
        <div class="row mt"><span class="space"></span><button class="btn primary">저장하기</button></div>
      </form>`;
    const wireWb = (row) => ($('[data-wbdel]', row).onclick = () => row.remove());
    $$('.wb-row', el).forEach(wireWb);
    $('#wbAdd').onclick = () => { const dv = document.createElement('div'); dv.className = 'row wb-row'; dv.style.marginBottom = '6px'; dv.innerHTML = '<input type="text" class="wb-name" placeholder="예: 워드마스터 중등 실력" style="flex:2"><input type="number" class="wb-days" value="40" style="width:80px"><select class="wb-unit" style="width:auto"><option selected>Day</option><option>Unit</option></select><span class="small muted">개</span><button type="button" class="btn sm danger" data-wbdel>✕</button>'; $('#wbooks').appendChild(dv); wireWb(dv); };
    const wireDisc = (row) => ($('[data-ddel]', row).onclick = () => row.remove());
    $$('.disc-row', el).forEach(wireDisc);
    $('#discAdd').onclick = () => {
      const div = document.createElement('div');
      div.className = 'row disc-row';
      div.style.marginBottom = '6px';
      div.innerHTML = '<input type="hidden" value="" data-did><input type="text" data-dname placeholder="할인 이름" style="flex:2"><input type="text" data-damt inputmode="numeric" placeholder="금액" style="flex:1"><span class="small muted">원</span><button type="button" class="btn sm danger" data-ddel>✕</button>';
      $('#discs').appendChild(div);
      wireDisc(div);
    };
    $('#f').onsubmit = async (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(e.target));
      try {
        const teacher_view = Object.fromEntries(Object.keys(s.teacher_view_labels).map((k) => [k, !!d['tv_' + k]]));
        const discount_items = $$('.disc-row', e.target).map((r) => ({ id: $('[data-did]', r).value, name: $('[data-dname]', r).value, amount: $('[data-damt]', r).value })).filter((x) => x.name.trim());
        const book_suppliers = String(d.suppliers || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
        await api('PUT', '/api/settings', { academy_name: d.academy_name, mottos: [d.motto0, d.motto1, d.motto2], tpl_attendance: d.tpl_attendance, tpl_feedback: d.tpl_feedback, send_mode: d.send_mode, teacher_view, discount_items, book_suppliers, bank_account: d.bank_account, bank_account_book: d.bank_account_book, tpl_bill: d.tpl_bill, tpl_bill_tuition: d.tpl_bill_tuition, tpl_bill_book: d.tpl_bill_book, word_pass_pct: d.word_pass_pct, tpl_word: d.tpl_word, word_books: $$('.wb-row', e.target).map((r) => ({ name: $('.wb-name', r).value, days: $('.wb-days', r).value, unit: $('.wb-unit', r).value })), log_remind: { on: !!d.lr_on, after_min: d.lr_after, sms: !!d.lr_sms, start_date: d.lr_start }, tpl_log_remind: d.tpl_log_remind });
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
      <div class="page-head"><div><h1>내 정보</h1><p>${h(state.me.name)} · ${roleLabel(state.me)} · 아이디 ${h(state.me.login_id)}</p></div></div>
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



  // ───────── 교재 관리 ─────────
  async function pageBooks(el, parts, query) {
    if (parts[0]) return pageBook(el, Number(parts[0]));
    const manage = canEditStudents();
    const qs = new URLSearchParams(Object.entries({ level: query.level, subject: query.subject, supplier: query.supplier, q: query.q, active: query.all ? 'all' : '' }).filter(([, v]) => v)).toString();
    const d = await api('GET', '/api/catalog' + (qs ? '?' + qs : ''));
    let books = d.books;
    if (query.low) books = books.filter((b) => b.stock <= 3);
    const go = (patch) => {
      const q2 = { level: query.level, subject: query.subject, supplier: query.supplier, q: query.q, low: query.low, all: query.all, ...patch };
      location.hash = '#/books?' + new URLSearchParams(Object.entries(q2).filter(([, v]) => v)).toString();
    };
    const tabs = (key, list, label) => `<div class="tabs"><button class="btn sm ${!query[key] ? 'primary' : ''}" data-tab="${key}" data-v="">${label}</button>${list.map((x) => `<button class="btn sm ${query[key] === x ? 'primary' : ''}" data-tab="${key}" data-v="${h(x)}">${h(x)}</button>`).join('')}</div>`;
    el.innerHTML = `
      <div class="page-head"><div><h1>교재 관리</h1><p>교재를 등록하고 입고를 기록하면 재고가 자동으로 계산돼요. 학생에게 배부하면 재고에서 빠지고 학생 카드에 기록돼요.</p></div>
        ${manage ? '<div class="row"><button class="btn" id="importBk">📂 엑셀로 한꺼번에 등록</button><button class="btn primary" id="addBk">＋ 교재 등록</button></div>' : ''}</div>
      <div class="card">
        ${tabs('level', d.levels, '전체 학년')}
        <div style="margin-top:6px">${tabs('subject', ['국어', '영어', '수학', '과학', '사회', '기타'], '전체 과목')}</div>
        <form class="row mt" id="bf">
          <select name="supplier" style="width:auto"><option value="">모든 거래처</option>${d.suppliers.map((x) => `<option ${query.supplier === x ? 'selected' : ''}>${h(x)}</option>`).join('')}</select>
          <input type="search" name="q" placeholder="교재명 검색" value="${h(query.q || '')}" style="width:180px">
          <label class="inline-check small"><input type="checkbox" name="low" ${query.low ? 'checked' : ''}> 재고 3권 이하만</label>
          <label class="inline-check small"><input type="checkbox" name="all" ${query.all ? 'checked' : ''}> 판매 중지 교재도 보기</label>
          <button class="btn">찾기</button><span class="space"></span><span class="small muted">${books.length}종 · 재고 합계 ${books.reduce((a, b) => a + b.stock, 0)}권</span>
        </form>
      </div>
      <div class="bookgrid mt">${books.map((b) => `
        <div class="card bookcard ${b.active ? '' : 'off'}">
          <a href="#/books/${b.id}" class="bk-img">${bookImg(b.id, b.image_v, 92)}</a>
          <div class="bk-info">
            <a href="#/books/${b.id}" class="bk-name">${h(b.name)}</a>
            <div class="small muted">${[b.level, b.subject, b.supplier].filter(Boolean).map(h).join(' · ')}</div>
            <div class="small" style="margin-top:4px">정가 <s class="muted">${won(b.list_price)}</s> · 판매 <b>${won(b.sale_price ?? b.list_price)}</b></div>
            <div class="row" style="margin-top:6px"><span class="chip ${b.stock <= 0 ? 'red' : b.stock <= 3 ? 'orange' : 'green'}">재고 ${b.stock}권</span><span class="small muted">입고 ${b.stock_in} · 배부 ${b.delivered}</span></div>
            <div class="row" style="margin-top:8px">${manage ? `<button class="btn sm" data-in="${b.id}">＋ 입고</button>` : ''}<button class="btn sm" data-give="${b.id}">배부</button><a class="btn sm" href="#/books/${b.id}">내역</a></div>
          </div>
        </div>`).join('') || '<div class="card empty">교재가 없어요</div>'}</div>`;
    $$('[data-tab]', el).forEach((b) => (b.onclick = () => go({ [b.dataset.tab]: b.dataset.v })));
    $('#bf').onsubmit = (e) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); go({ supplier: f.supplier, q: f.q, low: f.low ? '1' : '', all: f.all ? '1' : '' }); };
    if ($('#addBk')) $('#addBk').onclick = () => bookModal(d);
    if ($('#importBk')) $('#importBk').onclick = () => bookImportModal();
    $$('[data-in]', el).forEach((b) => (b.onclick = () => stockModal(books.find((x) => x.id === Number(b.dataset.in)), d.suppliers)));
    $$('[data-give]', el).forEach((b) => (b.onclick = () => deliverModal(books.find((x) => x.id === Number(b.dataset.give)))));
  }

  // 엑셀 파일(아이키즈에서 옮긴 목록 등)로 교재 여러 개 한꺼번에 등록
  function bookImportModal() {
    let list = null;
    const pick = (head, re) => head.findIndex((x) => re.test(x));
    const parse = (grid) => {
      const hi = grid.findIndex((r) => r.some((c) => /교재명|교재이름|물품명/.test(String(c).replace(/\s/g, ''))));
      if (hi < 0) throw new Error('제목 줄에 "교재명" 칸이 있어야 해요');
      const head = grid[hi].map((c) => String(c).replace(/\s/g, ''));
      const col = {
        name: pick(head, /교재명|교재이름|물품명/), level: pick(head, /학교급|학년/), subject: pick(head, /과목/), cat: pick(head, /카테고리|분류/),
        supplier: pick(head, /거래처/), list_price: pick(head, /정가|구매가/), sale_price: pick(head, /판매가|할인가/),
        stock: pick(head, /재고|수량/), date: pick(head, /등록일|입고일/), memo: pick(head, /메모|비고/),
      };
      const get = (r, k) => (col[k] >= 0 ? String(r[col[k]] ?? '').trim() : '');
      return grid.slice(hi + 1).map((r) => {
        const cat = get(r, 'cat');
        let level = get(r, 'level'), subject = get(r, 'subject');
        if (!level) level = (cat.match(/^(유아|초등|중등|고등)/) || [])[1] || '';
        if (!subject) subject = (cat.match(/(국어|영어|수학|과학|사회)/) || [])[1] || (/몬스터|연산|매스/.test(cat) ? '수학' : '');
        let date = get(r, 'date');
        if (/^\d+(\.\d+)?$/.test(date)) date = excelDate(date).slice(0, 10);
        date = date.replace(/[.\/]\s*/g, '-').replace(/-$/, '');
        return { name: get(r, 'name'), level, subject, supplier: get(r, 'supplier'), list_price: get(r, 'list_price'), sale_price: get(r, 'sale_price'), stock: get(r, 'stock'), date, memo: get(r, 'memo') };
      }).filter((x) => x.name);
    };
    modal({
      title: '엑셀로 교재 한꺼번에 등록', wide: true, submitText: '파일을 먼저 골라 주세요',
      body: `
        <div class="howto">
          엑셀 파일을 고르면 미리 보기가 나와요. 확인하고 <b>등록하기</b>를 누르면 끝이에요.
          <div class="small muted" style="margin-top:6px">알아듣는 제목: <b>교재명</b> · 학교급 · 과목 · 카테고리 · 거래처 · 구매가(정가) · 판매가 · 재고 · 등록일 · 메모<br>
          이미 같은 이름으로 등록된 교재는 건너뛰어요. 재고가 있으면 첫 입고로 기록돼요.</div>
          <div class="row" style="margin-top:8px"><label class="btn sm primary" style="cursor:pointer">📂 엑셀 파일 고르기<input type="file" id="bkFile" accept=".xlsx,.csv" hidden></label><span class="small muted" id="bkFileName"></span></div>
        </div>
        <div id="bkPreview"></div>`,
      onOpen: (f) => {
        $('#bkFile', f).onchange = async (e) => {
          const file = e.target.files[0];
          if (!file) return;
          $('.err', f).textContent = '';
          try {
            const grid = /\.csv$/i.test(file.name) ? (await file.text()).replace(/^﻿/, '').split(/\r?\n/).map((l) => l.split(',')) : await readXlsx(file);
            list = parse(grid);
            if (!list.length) throw new Error('읽을 교재가 없어요');
            $('#bkFileName', f).textContent = file.name;
            const count = (k) => Object.entries(list.reduce((a, x) => ((a[x[k] || '(없음)'] = (a[x[k] || '(없음)'] || 0) + 1), a), {})).map(([k2, v]) => `${h(k2)} ${v}`).join(' · ');
            $('#bkPreview', f).innerHTML = `
              <div class="mt"><b>미리 보기</b> — 모두 <b>${list.length}개</b> (앞의 10개만 보여요)</div>
              <div class="small muted">학교급: ${count('level')}<br>과목: ${count('subject')}<br>거래처: ${count('supplier')}</div>
              <div class="table-wrap" style="margin-top:6px"><table class="list"><thead><tr><th>교재명</th><th>학교급</th><th>과목</th><th>거래처</th><th>정가</th><th>판매가</th><th>재고</th></tr></thead>
              <tbody>${list.slice(0, 10).map((x) => `<tr><td class="small">${h(x.name)}</td><td class="small">${h(x.level)}</td><td class="small">${h(x.subject)}</td><td class="small">${h(x.supplier)}</td><td class="small">${h(x.list_price)}</td><td class="small">${h(x.sale_price)}</td><td class="small">${h(x.stock)}</td></tr>`).join('')}</tbody></table></div>
              <div id="bkProgress" class="small" style="margin-top:6px"></div>`;
            $('button[type=submit]', f).textContent = `이대로 ${list.length}개 등록하기`;
          } catch (err) { list = null; $('.err', f).textContent = err.message; }
          e.target.value = '';
        };
      },
      onSubmit: async (d, f) => {
        if (!list) throw new Error('엑셀 파일을 먼저 골라 주세요');
        const btn = $('button[type=submit]', f);
        btn.disabled = true;
        let added = 0, skipped = 0, stocked = 0;
        try {
          for (let i = 0; i < list.length; i += 15) {
            $('#bkProgress', f).textContent = `등록하는 중… ${i} / ${list.length}`;
            const r = await api('POST', '/api/catalog/import', { rows: list.slice(i, i + 15) });
            added += r.added; skipped += r.skipped; stocked += r.stocked;
          }
        } finally { btn.disabled = false; }
        toast(`${added}개 등록했어요${skipped ? ` (이미 있어서 건너뜀 ${skipped}개)` : ''}`);
        reload();
      },
    });
  }

  function bookModal(meta, b = null) {
    modal({
      title: b ? '교재 고치기' : '교재 등록', wide: true,
      body: `
        <div class="grid g2">
          <label class="field"><span>교재명 *</span><input type="text" name="name" value="${h(b ? b.name : '')}" required placeholder="예: 쎈 수학 중2-1"></label>
          <label class="field"><span>거래처</span><select name="supplier"><option value="">선택 안 함</option>${meta.suppliers.map((x) => `<option ${b && b.supplier === x ? 'selected' : ''}>${h(x)}</option>`).join('')}</select></label>
          <label class="field"><span>학년 구분</span><select name="level"><option value="">선택 안 함</option>${meta.levels.map((x) => `<option ${b && b.level === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
          <label class="field"><span>과목</span><select name="subject"><option value="">선택 안 함</option>${meta.subjects.map((x) => `<option ${b && b.subject === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
          <label class="field"><span>정가</span><input type="text" name="list_price" inputmode="numeric" value="${h(b ? b.list_price ?? '' : '')}" placeholder="예: 17000"></label>
          <label class="field"><span>판매가 (할인가)</span><input type="text" name="sale_price" inputmode="numeric" value="${h(b ? b.sale_price ?? '' : '')}" placeholder="예: 15000"></label>
        </div>
        ${b ? '' : `<div class="grid g2"><label class="field"><span>처음 입고 수량 (선택)</span><input type="text" name="first_qty" inputmode="numeric" placeholder="예: 20"></label>
          <label class="field"><span>입고일</span><input type="date" name="first_date" value="${todayStr()}"></label></div>`}
        <label class="field"><span>메모</span><input type="text" name="memo" value="${h(b ? b.memo || '' : '')}"></label>
        ${b ? `<label class="inline-check"><input type="checkbox" name="active" ${b.active ? 'checked' : ''}> 판매 중 (끄면 목록에서 숨겨져요)</label>` : '<p class="small muted">교재 사진은 저장한 다음 교재 화면에서 올릴 수 있어요.</p>'}`,
      onSubmit: async (f) => {
        const body = { ...f, ...(b ? { active: !!f.active } : {}) };
        if (b) { await api('PATCH', `/api/catalog/${b.id}`, body); toast('저장했어요'); reload(); }
        else { const r = await api('POST', '/api/catalog', body); toast('교재를 등록했어요. 사진을 올려 주세요'); location.hash = `#/books/${r.id}`; }
      },
    });
  }
  function stockModal(b, suppliers) {
    modal({
      title: `${b.name} 입고`,
      body: `<div class="grid g2"><label class="field"><span>입고일</span><input type="date" name="date" value="${todayStr()}"></label>
        <label class="field"><span>수량 (반품·조정은 -2처럼)</span><input type="text" name="qty" inputmode="numeric" required></label></div>
        <label class="field"><span>거래처</span><select name="supplier">${suppliers.map((x) => `<option ${b.supplier === x ? 'selected' : ''}>${h(x)}</option>`).join('')}</select></label>
        <label class="field"><span>메모</span><input type="text" name="memo" placeholder="예: 거래명세서 번호"></label>`,
      onSubmit: async (f) => { await api('POST', `/api/catalog/${b.id}/stock`, f); toast('입고를 기록했어요'); reload(); },
    });
  }
  async function deliverModal(b) {
    const [{ courses }, { students }] = await Promise.all([api('GET', '/api/courses'), api('GET', '/api/students?status=재원')]);
    const members = new Map();
    modal({
      title: `${b.name} 배부`, wide: true,
      body: `<div class="row" style="margin-bottom:10px">${bookImg(b.id, b.image_v, 48)}<div><b>${h(b.name)}</b><div class="small muted">판매가 ${won(b.sale_price ?? b.list_price)} · 재고 ${b.stock}권</div></div></div>
        <div class="grid g2"><label class="field"><span>배부일</span><input type="date" name="date" value="${todayStr()}"></label>
        <label class="field"><span>한 권 가격 (교재비로 청구돼요)</span><input type="text" name="price" inputmode="numeric" value="${h(b.sale_price ?? b.list_price ?? '')}"></label></div>
        <label class="field"><span>반 전체 고르기</span><select id="crs"><option value="">— 반 고르기 —</option>${courses.map((c) => `<option value="${c.id}">${h(c.name)} (${c.student_count}명)</option>`).join('')}</select></label>
        <input type="search" id="find" placeholder="이름·학교로 찾기" style="margin-bottom:8px">
        <div class="checklist">${students.map((x) => `<label data-txt="${h((x.name + ' ' + (x.school || '') + ' ' + (x.grade || '')).toLowerCase())}"><input type="checkbox" name="s_${x.id}"> <b>${h(x.name)}</b> <span class="muted small">${h(x.school || '')} ${h(x.grade || '')}</span></label>`).join('')}</div>
        <div class="small muted" style="margin-top:6px" id="cnt"></div>
        <label class="field mt"><span>메모</span><input type="text" name="memo"></label>`,
      submitText: '배부 기록하기',
      onOpen: (f) => {
        const upd = () => ($('#cnt', f).textContent = `${$$('.checklist input:checked', f).length}명 선택 · 배부 후 재고 ${b.stock - $$('.checklist input:checked', f).length}권`);
        upd();
        $$('.checklist input', f).forEach((i) => (i.onchange = upd));
        $('#find', f).oninput = (e) => { const t = e.target.value.trim().toLowerCase(); $$('.checklist label', f).forEach((l) => (l.style.display = !t || l.dataset.txt.includes(t) ? '' : 'none')); };
        $('#crs', f).onchange = async (e) => {
          if (!e.target.value) return;
          const cid = Number(e.target.value);
          if (!members.has(cid)) members.set(cid, (await api('GET', `/api/courses/${cid}`)).students.map((x) => x.id));
          for (const sid of members.get(cid)) { const cb = $(`input[name=s_${sid}]`, f); if (cb) cb.checked = true; }
          upd();
        };
      },
      onSubmit: async (f) => {
        const ids = Object.keys(f).filter((k) => k.startsWith('s_')).map((k) => Number(k.slice(2)));
        const r = await api('POST', `/api/catalog/${b.id}/deliver`, { student_ids: ids, date: f.date, price: f.price, memo: f.memo });
        toast(`${r.count}명에게 배부했어요`);
        reload();
      },
    });
  }

  async function pageBook(el, id) {
    const d = await api('GET', `/api/catalog/${id}`);
    const b = d.book, manage = canEditStudents();
    const meta = manage ? await api('GET', '/api/catalog?active=all') : null;
    el.innerHTML = `
      <div><a href="#/books" class="small muted">← 교재 관리</a></div>
      <div class="card mt bookhead">
        <div class="bk-big" ${manage ? 'id="bkPhoto" title="사진 바꾸기"' : ''}>${bookImg(b.id, b.image_v, 150)}${manage ? '<span class="cam">📷</span>' : ''}</div>
        <div style="flex:1;min-width:220px">
          <div class="row"><h1 style="margin:0">${h(b.name)}</h1>${b.active ? '' : '<span class="chip">판매 중지</span>'}</div>
          <div class="muted">${[b.level, b.subject, b.supplier].filter(Boolean).map(h).join(' · ')}</div>
          <div class="mt">정가 <s class="muted">${won(b.list_price)}</s> · 판매가 <b style="font-size:18px">${won(b.sale_price ?? b.list_price)}</b></div>
          <div class="row mt"><span class="chip ${b.stock <= 0 ? 'red' : b.stock <= 3 ? 'orange' : 'green'}" style="font-size:15px">재고 ${b.stock}권</span><span class="muted small">입고 ${b.stock_in}권 · 배부 ${b.delivered}권</span></div>
          ${b.memo ? `<div class="small mt">📝 ${h(b.memo)}</div>` : ''}
        </div>
        <div class="profile-actions">${manage ? '<button class="btn" id="bkIn">＋ 입고</button>' : ''}<button class="btn primary" id="bkGive">학생에게 배부</button>${manage ? '<button class="btn" id="bkEdit">고치기</button>' : ''}</div>
      </div>
      <div class="grid g2 mt">
        <div class="card"><h2>입고 내역</h2>${d.stock.length ? `<table class="list"><thead><tr><th>입고일</th><th>수량</th><th>거래처</th><th>메모</th><th></th></tr></thead><tbody>${d.stock.map((x) => `<tr><td>${h(x.date)}</td><td><b>${x.qty > 0 ? '+' : ''}${x.qty}</b></td><td>${h(x.supplier || '')}</td><td class="small">${h(x.memo || '')} <span class="muted">${h(x.created_by_name || '')}</span></td><td>${manage ? `<button class="btn sm danger" data-delst="${x.id}">삭제</button>` : ''}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">입고 기록이 없어요</div>'}</div>
        <div class="card"><h2>배부 내역 <span class="small muted">${d.deliveries.length}건</span></h2>${d.deliveries.length ? `<div style="max-height:420px;overflow-y:auto"><table class="list"><tbody>${d.deliveries.map((x) => `<tr><td>${h(x.date)}</td><td><a href="#/students/${x.student_id}"><b>${h(x.student_name)}</b></a> <span class="small muted">${h(x.school || '')} ${h(x.grade || '')}</span></td><td>${x.qty}권</td><td>${won(x.price)}</td><td class="small muted">${h(x.given_by_name || '')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">아직 배부하지 않았어요</div>'}</div>
      </div>`;
    if ($('#bkPhoto')) $('#bkPhoto').onclick = () => pickImage(`/api/catalog/${b.id}/image`, reload, 1.3);
    if ($('#bkIn')) $('#bkIn').onclick = () => stockModal(b, meta.suppliers);
    if ($('#bkEdit')) $('#bkEdit').onclick = () => bookModal(meta, b);
    $('#bkGive').onclick = () => deliverModal(b);
    $$('[data-delst]', el).forEach((x) => (x.onclick = async () => { if (!confirm('이 입고 기록을 지울까요?')) return; await api('DELETE', `/api/book-stock/${x.dataset.delst}`); reload(); }));
  }

  // ───────── 청구서 보내기 (원장) ─────────
  async function pageBills(el, _p, query) {
    const showAll = !!query.all;
    const month = query.month || todayStr().slice(0, 7);
    const kind = ['tuition', 'book', 'all'].includes(query.kind) ? query.kind : 'tuition';
    const d = await api('GET', `/api/bills?month=${month}&kind=${kind}`);
    const KL = { tuition: '교육비', book: '교재비', all: '교육비+교재비' };
    const showT = kind !== 'book', showB = kind !== 'tuition';
    const link = (patch) => '#/bills?' + new URLSearchParams(Object.entries({ month, kind, all: showAll ? '1' : '', ...patch }).filter(([, v]) => v)).toString();
    const mm = Number(month.slice(5));

    const rows = showAll ? d.rows : d.rows.filter((r) => r.total > 0 || r.last_bill);
    const state = (r) => r.total === 0 ? (r.last_bill ? '<span class="chip green">청구 후 완납</span>' : '<span class="chip green">완납</span>')
      : r.last_bill ? `<span class="chip orange">청구함 · 미수납</span>` : '<span class="chip">청구 전</span>';
    el.innerHTML = `
      <div class="page-head"><div><h1>청구서 보내기</h1><p>교육비 청구서와 교재비 청구서를 따로 보낼 수 있어요. 보낸 기록과 상태도 종류별로 따로 남아요.</p></div>
        <div class="row"><input type="month" id="mon" value="${h(month)}" style="width:auto"></div></div>
      ${d.bank_account || d.bank_account_book ? '' : '<div class="banner info">🏦 입금 계좌가 아직 없어요. <a href="#/settings">설정</a>에서 교육비·교재비 입금 계좌를 넣어 주세요.</div>'}
      <div class="tabs" style="margin-bottom:12px">${['tuition', 'book', 'all'].map((k) => `<a class="btn ${kind === k ? 'primary' : ''}" href="${link({ kind: k })}">${k === 'tuition' ? '💳 교육비 청구' : k === 'book' ? '📚 교재비 청구' : '🧾 함께 청구'}</a>`).join('')}</div>
      <div class="card">
        <div class="row"><span class="small muted"><b>${KL[kind]}</b> 청구서 · 보낼 금액 합계 <b>${won(rows.reduce((a, r) => a + r.total, 0))}</b> · ${rows.filter((r) => r.total > 0).length}명</span><span class="space"></span>
          <label class="inline-check small"><input type="checkbox" id="all" ${showAll ? 'checked' : ''}> 보낼 금액 없는 학생도 보기</label></div>
        <div class="table-wrap mt"><table class="list">
          <thead><tr><th><input type="checkbox" id="pickAll"></th><th>학생</th>${showT ? `<th style="text-align:right">월 수강료</th><th style="text-align:right">${mm}월 교육비 남음</th>` : ''}${showB ? '<th style="text-align:right">교재비 미납</th>' : ''}<th style="text-align:right">청구 금액</th><th>청구서 보낸 때</th><th>상태</th></tr></thead>
          <tbody>${rows.map((r) => `<tr>
            <td><input type="checkbox" data-pick="${r.id}" ${r.total > 0 && r.has_phone ? '' : 'disabled'}></td>
            <td><a href="#/students/${r.id}"><b>${h(r.name)}</b></a> <span class="small muted">${h(r.school || '')} ${h(r.grade || '')}</span>${r.has_phone ? '' : ' <span class="chip red">번호 없음</span>'}</td>
            ${showT ? `<td style="text-align:right">${won(r.fee)}${r.discount ? `<div class="small muted">할인 -${won(r.discount)}</div>` : ''}</td>
            <td style="text-align:right">${r.tuition_due ? `<b>${won(r.tuition_due)}</b>` : '-'}${r.paid ? `<div class="small muted">낸 금액 ${won(r.paid)}</div>` : ''}</td>` : ''}
            ${showB ? `<td style="text-align:right">${r.book_due ? `<b>${won(r.book_due)}</b>` : '-'}${!showT && r.recent_books ? `<div class="small muted">${h(r.recent_books)}</div>` : ''}</td>` : ''}
            <td style="text-align:right"><b style="font-size:15px">${won(r.total)}</b></td>
            <td class="small">${r.last_bill ? `${prettyTime(r.last_bill.sent_at)}<div class="muted">${won(r.last_bill.total)}${r.bill_count > 1 ? ` · ${r.bill_count}번째` : ''} ${r.last_bill.status === '미리보기' ? '(미리보기)' : ''}</div>` : '<span class="muted">-</span>'}</td>
            <td>${state(r)}</td></tr>`).join('') || `<tr><td colspan="8" class="empty">보낼 ${KL[kind]} 청구서가 없어요</td></tr>`}</tbody></table></div>
        <div class="sticky-bar row"><span id="pc">0명 선택</span><span class="space"></span><button class="btn" id="prev">문자 미리 보기</button><button class="btn primary" id="send" disabled>${KL[kind]} 청구서 보내기</button></div>
      </div>
      <div class="small muted mt">상태는 수납이 기록되는 대로 바뀌어요. 결제·입금 대조로 기록하면 "청구 후 완납"으로 바뀌어요.</div>`;
    const picked = () => $$('[data-pick]:checked', el).map((x) => Number(x.dataset.pick));
    const upd = () => { const n = picked().length; $('#pc').textContent = `${n}명 선택 · ${won(rows.filter((r) => picked().includes(r.id)).reduce((a, r) => a + r.total, 0))}`; $('#send').disabled = !n; };
    $$('[data-pick]', el).forEach((x) => (x.onchange = upd));
    $('#pickAll').onchange = (e) => { $$('[data-pick]:not(:disabled)', el).forEach((x) => (x.checked = e.target.checked)); upd(); };
    $('#mon').onchange = (e) => (location.hash = link({ month: e.target.value }));
    $('#all').onchange = (e) => (location.hash = link({ all: e.target.checked ? '1' : '' }));
    $('#prev').onclick = async () => {
      const r = rows.find((x) => picked().includes(x.id)) || rows.find((x) => x.total > 0);
      if (!r) return toast('미리 볼 학생이 없어요');
      const st = await api('GET', '/api/settings');
      const lines = [];
      const useT = showT && r.tuition_due > 0, useB = showB && r.book_due > 0;
      if (useT) lines.push(`· ${mm}월 교육비 ${r.tuition_due.toLocaleString('ko-KR')}원${r.discount ? ` (할인 ${r.discount.toLocaleString('ko-KR')}원 적용)` : ''}${r.paid ? ` (이미 ${r.paid.toLocaleString('ko-KR')}원 납부)` : ''}`);
      if (useB) lines.push(`· 교재비 ${r.book_due.toLocaleString('ko-KR')}원${r.recent_books ? ` (${r.recent_books})` : ''}`);
      const text = (kind === 'tuition' ? st.tpl_bill_tuition : kind === 'book' ? st.tpl_bill_book : st.tpl_bill).replace(/\{([^{}]+)\}/g, (all, k) => ({ 학원: st.academy_name, 학생: r.name, 월: mm, 내역: lines.join('\n'), 합계: `${r.total.toLocaleString('ko-KR')}원`, 계좌: (() => { const t = st.bank_account || '', b = st.bank_account_book || ''; if (!t && !b) return '(학원으로 문의해 주세요)'; if (useT && useB && t && b && t !== b) return `\n· 교육비: ${t}\n· 교재비: ${b}`; if (useB && !useT) return b || t; return t || b; })() })[k] ?? all);
      modal({ title: `${r.name} ${KL[kind]} 청구서 미리 보기`, body: `<div class="preview">${h(text)}</div><p class="small muted">${KL[kind]} 청구서 문구는 [설정 → 청구서]에서 따로 바꿀 수 있어요.</p>` });
    };
    $('#send').onclick = async () => {
      const ids = picked();
      if (!confirm(`${ids.length}명에게 ${KL[kind]} 청구서를 보낼까요?`)) return;
      $('#send').disabled = true;
      try {
        const r = await api('POST', '/api/bills/send', { month, kind, student_ids: ids });
        toast(`${r.sent}명에게 보냈어요${r.failed ? `, ${r.failed}명 실패` : ''}`);
        reload();
      } catch (e) { toast(e.message); $('#send').disabled = false; }
    };
  }

  // ───────── 엑셀(.xlsx) 읽기 — 따로 프로그램 없이 브라우저에서 바로 ─────────
  async function readXlsx(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const dv = new DataView(buf.buffer);
    if (dv.getUint32(0, true) !== 0x04034b50) throw new Error('엑셀(.xlsx) 파일이 아니에요. 엑셀에서 "다른 이름으로 저장 → Excel 통합 문서(.xlsx)"로 저장해서 올리거나, 내용을 복사해 붙여 넣어 주세요.');
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('파일을 읽지 못했어요');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const files = {};
    const dec = new TextDecoder();
    for (let k = 0; k < count; k++) {
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const off = dv.getUint32(p + 42, true);
      files[dec.decode(buf.slice(p + 46, p + 46 + nlen))] = { method, csize, off };
      p += 46 + nlen + elen + clen;
    }
    const read = async (name) => {
      const f = files[name];
      if (!f) return null;
      const start = f.off + 30 + dv.getUint16(f.off + 26, true) + dv.getUint16(f.off + 28, true);
      const raw = buf.slice(start, start + f.csize);
      if (f.method === 0) return dec.decode(raw);
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Response(stream).text();
    };
    const xml = (t) => new DOMParser().parseFromString(t, 'application/xml');
    const shared = [];
    const ss = await read('xl/sharedStrings.xml');
    if (ss) for (const si of xml(ss).getElementsByTagName('si')) shared.push([...si.getElementsByTagName('t')].map((t) => t.textContent).join(''));
    const sheetName = files['xl/worksheets/sheet1.xml'] ? 'xl/worksheets/sheet1.xml' : Object.keys(files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0];
    const doc = xml(await read(sheetName));
    const rows = [];
    for (const row of doc.getElementsByTagName('row')) {
      const out = [];
      for (const c of row.getElementsByTagName('c')) {
        const ref = c.getAttribute('r') || '';
        const letters = ref.replace(/\d+/g, '');
        let col = 0;
        for (const ch of letters) col = col * 26 + (ch.charCodeAt(0) - 64);
        const t = c.getAttribute('t');
        const v = c.getElementsByTagName('v')[0];
        let val = '';
        if (t === 's' && v) val = shared[Number(v.textContent)] ?? '';
        else if (t === 'inlineStr') val = [...c.getElementsByTagName('t')].map((x) => x.textContent).join('');
        else if (v) val = v.textContent;
        out[(col || out.length + 1) - 1] = val;
      }
      rows.push([...out].map((x) => x ?? ''));
    }
    return rows;
  }
  const excelDate = (v) => {
    // 엑셀 날짜 숫자(1954~2119년 범위)만 날짜로 바꿔요. 130319 같은 생년월일 6자리는 그대로 둬요.
    if (!/^\d+(\.\d+)?$/.test(String(v)) || Number(v) < 20000 || Number(v) >= 80000) return String(v);
    const d = new Date(Math.round((Number(v) - 25569) * 864e5));
    const z = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${z(d.getUTCMonth() + 1)}-${z(d.getUTCDate())} ${z(d.getUTCHours())}:${z(d.getUTCMinutes())}:${z(d.getUTCSeconds())}`;
  };
  // 제목 줄을 찾아 칸을 맞춰요
  function payRowsFromGrid(grid) {
    // 영주사랑: 거래일시·결제자·결제금액 / 통장: 거래일시·입금자(적요·내용)·입금액(맡기신 금액)
    const hi = grid.findIndex((r) => r.some((c) => /결제자|결제금액|입금자|입금액|맡기신|적요|기재내용|보낸분/.test(String(c).replace(/\s/g, ''))));
    if (hi < 0) throw new Error('제목 줄을 찾지 못했어요. 영주사랑 결제 내역이나 은행 입출금 내역 엑셀인지 확인해 주세요.');
    const head = grid[hi].map((c) => String(c).replace(/\s/g, ''));
    const find = (re, not) => head.findIndex((c) => re.test(c) && !(not && not.test(c)));
    const bank = head.some((c) => /입금자|입금액|맡기신|적요|기재내용|보낸분|의뢰인/.test(c));
    const col = bank
      ? { date: find(/일시|일자|날짜/), method: -1, payer: find(/입금자|보낸분|의뢰인|기재내용|적요|내용/), amount: find(/입금액|맡기신|입금금액|입금(?!자)/, /출금/), status: -1, memo: find(/메모|비고/) }
      : { date: find(/일시|일자|날짜/), method: find(/구분|수단|방법/), payer: find(/결제자|이름|성명|고객/), amount: find(/금액/), status: find(/상태/), memo: find(/메모|비고/) };
    if (col.payer < 0 || col.amount < 0) throw new Error(bank ? '입금자 또는 입금액 칸을 찾지 못했어요' : '결제자 또는 결제금액 칸을 찾지 못했어요');
    const get = (r, k) => (col[k] >= 0 ? String(r[col[k]] ?? '').trim() : '');
    return grid.slice(hi + 1)
      .map((r) => ({ date: excelDate(get(r, 'date')), method: bank ? '계좌이체' : get(r, 'method'), payer: get(r, 'payer'), amount: get(r, 'amount'), status: get(r, 'status'), memo: get(r, 'memo') }))
      .filter((r) => r.payer && r.amount && Number(String(r.amount).replace(/[^0-9]/g, '')) > 0);
  }

  // ───────── 영주사랑 결제 대조 (원장) ─────────
  async function pagePayImport(el) {
    el.innerHTML = `
      <div class="page-head"><div><h1>결제·입금 대조</h1><p>영주사랑 결제 엑셀이나 은행 입출금 내역 엑셀을 올리면, 학부모 이름·핸드폰 뒷자리·입금자명·메모로 학생을 찾아 수납 기록을 넣어 드려요.</p></div></div>
      <div class="card">
        <div class="howto">
          <b>1.</b> 영주사랑 관리 화면의 결제 내역, 또는 은행 앱·인터넷뱅킹의 <b>입출금 거래내역</b>을 엑셀로 내려받아 주세요. (통장은 입금만 골라서 대조해요)<br>
          <b>2.</b> 아래 <b>파일 고르기</b>를 눌러 그 파일을 골라 주세요. (같은 파일을 또 올려도 이미 기록한 결제는 다시 기록하지 않아요)
        </div>
        <div class="row"><label class="btn primary" style="cursor:pointer">📂 파일 고르기<input type="file" id="xfile" accept=".xlsx,.csv" hidden></label>
          <span class="small muted">또는</span><button class="btn sm" id="pasteBtn">엑셀 내용 붙여 넣기</button><span class="small muted" id="fname"></span></div>
        <div id="pasteBox" hidden class="mt"><textarea id="pasteText" style="min-height:140px" placeholder="엑셀에서 제목 줄(거래일시·결제구분·결제자·결제금액…)부터 Ctrl+A, Ctrl+C 한 다음 여기에 Ctrl+V"></textarea>
          <button class="btn sm mt" id="pasteGo">대조하기</button></div>
      </div>
      <div id="result"></div>`;
    const run = async (rows) => {
      if (!rows.length) return toast('결제 줄이 없어요');
      $('#result').innerHTML = '<div class="card mt muted">대조하는 중…</div>';
      try {
        const [pv, all] = await Promise.all([api('POST', '/api/payments/import/preview', { rows }), api('GET', '/api/students?status=')]);
        renderMatch($('#result'), pv.rows, all.students, rows);
      } catch (e) { $('#result').innerHTML = errBox(e); }
    };
    $('#xfile').onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      $('#fname').textContent = f.name;
      try {
        const grid = /\.csv$/i.test(f.name) ? (await f.text()).split(/\r?\n/).map((l) => l.split(',')) : await readXlsx(f);
        await run(payRowsFromGrid(grid));
      } catch (err) { $('#result').innerHTML = errBox(err); }
      e.target.value = '';
    };
    $('#pasteBtn').onclick = () => { $('#pasteBox').hidden = false; $('#pasteText').focus(); };
    $('#pasteGo').onclick = async () => {
      try { await run(payRowsFromGrid($('#pasteText').value.split(/\r?\n/).map((l) => l.split('\t')))); } catch (err) { $('#result').innerHTML = errBox(err); }
    };
  }

  function renderMatch(box, rows, students, original) {
    const byId = new Map(students.map((x) => [x.id, x]));
    const STATE = { sure: ['✅ 확실', 'green'], check: ['🟡 확인 필요', 'gold'], none: ['🔴 못 찾음', 'red'], done: ['⏭ 이미 기록됨', ''], cancelled: ['✖ 취소된 결제', ''] };
    // 줄마다 기록할 몫(parts)
    for (const r of rows) {
      r.on = r.state === 'sure' || r.state === 'check';
      r.parts = [{ student_id: r.student_id, kind: r.kind, month: r.month, amount: r.amount }];
      r.cinfo = new Map(r.candidates.map((c) => [c.student_id, c]));
    }
    const groups = new Map();
    rows.forEach((r) => groups.set(r.payer, [...(groups.get(r.payer) || []), r]));
    let filter = '';
    const studentOptions = (r, sel) => {
      const cands = r.candidates.map((c) => `<option value="${c.student_id}" ${c.student_id === sel ? 'selected' : ''}>★ ${h(c.name)} (${h(c.school || '')} ${h(c.grade || '')}) — ${h(c.why)}</option>`).join('');
      const rest = students.filter((x) => !r.cinfo.has(x.id)).map((x) => `<option value="${x.id}" ${x.id === sel ? 'selected' : ''}>${h(x.name)} (${h(x.school || '')} ${h(x.grade || '')}${x.status !== '재원' ? ', ' + h(x.status) : ''})</option>`).join('');
      return `<option value="">— 학생 고르기 —</option>${cands}${cands ? '<option disabled>──────────</option>' : ''}${rest}`;
    };
    // 이번에 넣을 금액까지 합쳐서 학생별 상태 계산
    const hintFor = (r, part) => {
      if (!part.student_id) return '';
      const c = r.cinfo.get(part.student_id);
      const sameAlloc = (kind, month) => rows.reduce((a, x) => a + (x.on && x.state !== 'done' && x.state !== 'cancelled' ? x.parts.filter((pp) => pp.student_id === part.student_id && pp.kind === kind && (kind === '교재비' || pp.month === month)).reduce((s2, pp) => s2 + (Number(pp.amount) || 0), 0) : 0), 0);
      if (part.kind === '교재비') {
        const due = c ? c.book_due : (byId.get(part.student_id) || {}).book_due;
        if (due == null) return '';
        const after = due - sameAlloc('교재비');
        return `교재비 미납 ${won(due)} → ${after <= 0 ? (after < 0 ? `<b style="color:var(--blue)">${won(-after)} 더 냄</b>` : '<b style="color:var(--brand)">정산 완료</b>') : `<b style="color:var(--orange)">${won(after)} 남음</b>`}`;
      }
      if (!c || !c.fee) return c ? '수강료가 정해지지 않았어요' : '';
      const total = c.paid + sameAlloc('교육비', part.month);
      const left = c.fee - total;
      return `${Number(part.month.slice(5))}월 수강료 ${won(c.fee)} · 기존 ${won(c.paid)} + 이번 ${won(total - c.paid)} → ${left <= 0 ? (left < 0 ? `<b style="color:var(--blue)">${won(-left)} 더 냄</b>` : '<b style="color:var(--brand)">완납</b>') : `<b style="color:var(--orange)">${won(left)} 남음</b>`}`;
    };
    const draw = () => {
      const cnt = (k) => rows.filter((r) => r.state === k).length;
      const chosen = rows.filter((r) => r.on && r.state !== 'done' && r.state !== 'cancelled');
      const readyN = chosen.filter((r) => r.parts.every((pp) => pp.student_id && pp.amount > 0 && (pp.kind === '교재비' || pp.month))).length;
      const sum = chosen.reduce((a, r) => a + r.amount, 0);
      let gi = 0;
      const shade = new Map([...groups.keys()].map((k) => [k, groups.get(k).length > 1 ? (gi++ % 2 ? 'g2' : 'g1') : '']));
      box.innerHTML = `
        <div class="card mt">
          <div class="row">
            <h2 style="margin:0">대조 결과 ${rows.length}건</h2><span class="space"></span>
            ${[['', `전체 ${rows.length}`], ['sure', `✅ 확실 ${cnt('sure')}`], ['check', `🟡 확인 필요 ${cnt('check')}`], ['none', `🔴 못 찾음 ${cnt('none')}`], ['done', `⏭ 기록됨 ${cnt('done')}`], ['cancelled', `✖ 취소 ${cnt('cancelled')}`]]
              .filter(([k], i) => !i || cnt(k)).map(([k, l]) => `<button class="btn sm ${filter === k ? 'primary' : ''}" data-flt="${k}">${l}</button>`).join('')}
          </div>
          <div class="small muted" style="margin-top:6px">★ 표시는 앱이 찾은 학생이에요. 🟡·🔴 줄은 학생을 골라 주세요. 같은 분이 여러 번 결제한 줄은 같은 색 묶음으로 보여요. 형제 몫을 한 번에 낸 경우 <b>나눠 기록</b>을 눌러 주세요.</div>
          <div class="table-wrap mt"><table class="list match">
            <thead><tr><th></th><th>결제</th><th style="text-align:right">금액</th><th>학생 · 종류 · 해당 월</th><th>상태</th></tr></thead>
            <tbody>${rows.filter((r) => !filter || r.state === filter).map((r) => {
              const g = groups.get(r.payer);
              const lock = r.state === 'done' || r.state === 'cancelled';
              return `<tr class="${shade.get(r.payer)} ${lock ? 'locked' : ''}" data-i="${r.i}">
                <td><input type="checkbox" data-on ${r.on && !lock ? 'checked' : ''} ${lock ? 'disabled' : ''}></td>
                <td style="min-width:170px"><b>${h(r.payer)}</b><div class="small muted">${h(r.date || '')} ${h(r.time || '')} · ${h(r.method_raw)}</div>${r.memo ? `<div class="small">📝 ${h(r.memo)}</div>` : ''}
                  ${g.length > 1 && g[0] === r ? `<div class="small" style="color:var(--brand)">같은 분 ${g.length}건 · 합계 ${won(g.reduce((a, x) => a + x.amount, 0))}</div>` : ''}</td>
                <td style="text-align:right;white-space:nowrap"><b>${won(r.amount)}</b></td>
                <td style="min-width:380px">${lock ? `<span class="muted small">${r.state === 'done' ? '이미 앱에 기록된 결제예요' : '취소된 결제라 기록하지 않아요'}</span>` : r.parts.map((pp, k) => `
                  <div class="part" data-k="${k}">
                    <select data-f="student_id" style="max-width:260px">${studentOptions(r, pp.student_id)}</select>
                    <select data-f="kind" style="width:auto"><option ${pp.kind === '교육비' ? 'selected' : ''}>교육비</option><option ${pp.kind === '교재비' ? 'selected' : ''}>교재비</option></select>
                    ${pp.kind === '교육비' ? `<input type="month" data-f="month" value="${h(pp.month)}" style="width:auto">` : ''}
                    ${r.parts.length > 1 ? `<input type="text" inputmode="numeric" data-f="amount" value="${pp.amount}" style="width:110px" title="금액">${k ? `<button class="btn sm" data-del title="이 몫 지우기">✕</button>` : ''}` : ''}
                    <div class="small muted hint">${hintFor(r, pp)}</div>
                  </div>`).join('') + `<button class="btn sm" data-split>＋ 나눠 기록</button>${r.parts.length > 1 ? ` <span class="small ${r.parts.reduce((a, pp) => a + (Number(pp.amount) || 0), 0) === r.amount ? 'muted' : ''}" style="${r.parts.reduce((a, pp) => a + (Number(pp.amount) || 0), 0) === r.amount ? '' : 'color:var(--red)'}">나눈 합계 ${won(r.parts.reduce((a, pp) => a + (Number(pp.amount) || 0), 0))} / ${won(r.amount)}</span>` : ''}`}</td>
                <td><span class="chip ${STATE[r.state][1]}">${STATE[r.state][0]}</span>${r.siblings ? '<div class="small" style="color:var(--orange)">형제가 같은 번호예요</div>' : ''}</td></tr>`;
            }).join('')}</tbody></table></div>
          <div class="sticky-bar row"><span>체크한 <b>${chosen.length}건</b> · ${won(sum)}${readyN < chosen.length ? ` <span style="color:var(--red)">(${chosen.length - readyN}건은 학생·월을 골라 주세요)</span>` : ''}</span><span class="space"></span>
            <button class="btn primary" id="commit" ${chosen.length && readyN === chosen.length ? '' : 'disabled'}>체크한 ${chosen.length}건 수납 기록하기</button></div>
        </div>`;
      $$('[data-flt]', box).forEach((b) => (b.onclick = () => { filter = b.dataset.flt; draw(); }));
      $$('tr[data-i]', box).forEach((tr) => {
        const r = rows.find((x) => x.i === Number(tr.dataset.i));
        const on = $('[data-on]', tr);
        if (on) on.onchange = () => { r.on = on.checked; draw(); };
        $$('.part', tr).forEach((pd) => {
          const pp = r.parts[Number(pd.dataset.k)];
          $$('[data-f]', pd).forEach((inp) => (inp.onchange = () => {
            const f = inp.dataset.f;
            pp[f] = f === 'student_id' ? Number(inp.value) || null : f === 'amount' ? Number(String(inp.value).replace(/[^0-9]/g, '')) || 0 : inp.value;
            if (f === 'student_id' && pp.student_id) r.on = true;
            if (f === 'amount' && r.parts.length === 2 && Number(pd.dataset.k) === 1) r.parts[0].amount = Math.max(0, r.amount - pp.amount);
            draw();
          }));
          const del = $('[data-del]', pd);
          if (del) del.onclick = () => { r.parts.splice(Number(pd.dataset.k), 1); if (r.parts.length === 1) r.parts[0].amount = r.amount; draw(); };
        });
        const sp = $('[data-split]', tr);
        if (sp) sp.onclick = () => {
          // 형제가 있으면 형제를, 수강료 비율대로 나눠 미리 채워요
          const used = new Set(r.parts.map((pp) => pp.student_id));
          const next = r.candidates.find((c) => !used.has(c.student_id));
          r.parts.push({ student_id: next ? next.student_id : null, kind: '교육비', month: r.month, amount: 0 });
          const fees = r.parts.map((pp) => (r.cinfo.get(pp.student_id) || {}).fee || 0);
          const tot = fees.reduce((a, b) => a + b, 0);
          if (tot > 0) {
            let left = r.amount;
            r.parts.forEach((pp, k) => { pp.amount = k === r.parts.length - 1 ? left : Math.round((r.amount * fees[k]) / tot / 1000) * 1000; left -= pp.amount; });
          } else {
            const each = Math.floor(r.amount / r.parts.length / 1000) * 1000;
            r.parts.forEach((pp, k) => (pp.amount = k === r.parts.length - 1 ? r.amount - each * (r.parts.length - 1) : each));
          }
          r.on = true;
          draw();
        };
      });
      $('#commit', box).onclick = async () => {
        const items = [];
        for (const r of chosen) {
          const total = r.parts.reduce((a, pp) => a + (Number(pp.amount) || 0), 0);
          if (r.parts.length > 1 && total !== r.amount) return toast(`${r.payer} ${won(r.amount)}: 나눈 금액 합계가 맞지 않아요`);
          r.parts.forEach((pp, k) => items.push({ ref: k ? `${r.ref}#${k}` : r.ref, student_id: pp.student_id, kind: pp.kind, month: pp.month, amount: r.parts.length > 1 ? pp.amount : r.amount, paid_date: r.date, method: r.method, memo: `${r.method === '계좌이체' ? '통장 입금' : '영주사랑'} ${r.payer}${r.memo ? ' · ' + r.memo : ''}` }));
        }
        if (!confirm(`${chosen.length}건(${won(sum)})을 수납 기록할까요?`)) return;
        $('#commit', box).disabled = true;
        try {
          const res = await api('POST', '/api/payments/import', { items });
          toast(`${res.added}건 기록했어요${res.skipped ? ` (${res.skipped}건은 이미 기록돼 있어 건너뜀)` : ''}`);
          const [pv, all] = await Promise.all([api('POST', '/api/payments/import/preview', { rows: original }), api('GET', '/api/students?status=')]);
          renderMatch(box, pv.rows, all.students, original);
        } catch (e) { toast(e.message); $('#commit', box).disabled = false; }
      };
    };
    draw();
  }

  const PAGES = {
    '': { render: pageDashboard },
    attendance: { render: pageAttendance },
    feedback: { render: pageFeedback },
    risks: { render: pageRisks },
    messages: { render: pageMessages },
    consultations: { render: pageConsultations },
    students: { render: pageStudents },
    courses: { render: pageCourses, allow: () => isOwner() || isManager() },
    periods: { render: pagePeriods, owner: true },
    teachers: { render: pageTeachers, owner: true },
    settings: { render: pageSettings, owner: true },
    payimport: { render: pagePayImport, owner: true },
    bills: { render: pageBills, owner: true },
    books: { render: pageBooks },
    logs: { render: pageLogs },
    word: { render: pageWord },
    progress: { render: pageProgress },
    me: { render: pageMe },
  };

  // ───────── 시작 ─────────
  async function start() {
    try {
      const [me, st] = await Promise.all([api('GET', '/api/me'), api('GET', '/api/settings')]);
      if (me.user.role === 'student') throw new Error('학생 계정');
      state.me = me.user;
      state.academy = st.academy_name || '학원';
      document.title = SCORE ? `${state.academy} 채점` : state.academy;
      renderShell();
      router();
    } catch {
      if (!state.me) showLogin();
    }
  }
  window.addEventListener('hashchange', router);
  start();
})();
