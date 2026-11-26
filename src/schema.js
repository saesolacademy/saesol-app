// 데이터베이스 표(테이블) 설계
// 앱이 처음 켜질 때 자동으로 만들어집니다. (이미 있으면 그대로 둡니다)
//
// 역할(role)
//   owner   = 원장
//   teacher = 강사
//   student = 학생 (나중에 학생 앱을 붙일 때 사용. users.student_id 로 학생과 연결)

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    login_id TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner','teacher','student')),
    staff_role TEXT,
    student_id INTEGER,
    phone TEXT,
    photo TEXT,
    photo_v INTEGER,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    photo TEXT,
    photo_v INTEGER,
    birth_date TEXT,
    school TEXT,
    grade TEXT,
    address TEXT,
    student_phone TEXT,
    father_name TEXT,
    father_phone TEXT,
    mother_name TEXT,
    mother_phone TEXT,
    sms_target TEXT NOT NULL DEFAULT '어머니',
    family_id INTEGER,
    sibling_note TEXT,
    status TEXT NOT NULL DEFAULT '재원' CHECK (status IN ('재원','휴원','퇴원')),
    enrolled_date TEXT,
    status_date TEXT,
    status_reason TEXT,
    memo TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS courses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    subject TEXT NOT NULL,
    teacher_id INTEGER,
    days TEXT,
    times TEXT,
    start_time TEXT,
    end_time TEXT,
    room TEXT,
    fee INTEGER,
    log_fields TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS enrollments (
    course_id INTEGER NOT NULL,
    student_id INTEGER NOT NULL,
    fee INTEGER,
    PRIMARY KEY (course_id, student_id)
  )`,
  `CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    course_id INTEGER NOT NULL,
    student_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('출석','지각','결석','조퇴')),
    memo TEXT,
    checked_by INTEGER,
    notified_status TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (course_id, student_id, date)
  )`,
  `CREATE TABLE IF NOT EXISTS feedback_periods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    subjects TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS feedbacks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period_id INTEGER NOT NULL,
    course_id INTEGER NOT NULL,
    student_id INTEGER NOT NULL,
    teacher_id INTEGER,
    content TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '작성중',
    sent_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (period_id, course_id, student_id)
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    student_id INTEGER,
    to_phone TEXT,
    body TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    sent_by INTEGER,
    ref_type TEXT,
    ref_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS consultations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    teacher_id INTEGER,
    subject TEXT,
    date TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT '학부모 상담',
    content TEXT NOT NULL,
    follow_up TEXT,
    follow_up_done INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS risk_flags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_by INTEGER,
    resolved INTEGER NOT NULL DEFAULT 0,
    resolution TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
  )`,
  // 수업 일지 (반·날짜마다 한 장)
  `CREATE TABLE IF NOT EXISTS class_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    course_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    teacher_id INTEGER,
    content TEXT,
    homework TEXT,
    books TEXT,
    extras TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (course_id, date)
  )`,
  `CREATE TABLE IF NOT EXISTS class_log_notes (
    log_id INTEGER NOT NULL,
    student_id INTEGER NOT NULL,
    note TEXT,
    hw TEXT,
    achieve TEXT,
    PRIMARY KEY (log_id, student_id)
  )`,
  // 학생별 할인 (항목과 금액은 설정의 discount_items)
  `CREATE TABLE IF NOT EXISTS student_discounts (
    student_id INTEGER NOT NULL,
    item_id TEXT NOT NULL,
    PRIMARY KEY (student_id, item_id)
  )`,
  // 과목별 등록일·퇴원일
  `CREATE TABLE IF NOT EXISTS student_subjects (
    student_id INTEGER NOT NULL,
    subject TEXT NOT NULL,
    start_date TEXT,
    end_date TEXT,
    PRIMARY KEY (student_id, subject)
  )`,
  // 교재 목록
  `CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level TEXT,
    subject TEXT,
    supplier TEXT,
    name TEXT NOT NULL,
    list_price INTEGER,
    sale_price INTEGER,
    image TEXT,
    image_v INTEGER,
    memo TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  // 교재 입고 (수량이 음수면 반품·조정)
  `CREATE TABLE IF NOT EXISTS book_stock (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    qty INTEGER NOT NULL,
    supplier TEXT,
    memo TEXT,
    created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  // 청구서 보낸 기록
  `CREATE TABLE IF NOT EXISTS bills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    month TEXT NOT NULL,
    kind TEXT,
    items TEXT,
    total INTEGER NOT NULL,
    status TEXT,
    sent_by INTEGER,
    sent_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  // 진도표: 반마다 단원 계획
  `CREATE TABLE IF NOT EXISTS course_units (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    course_id INTEGER NOT NULL,
    seq INTEGER NOT NULL DEFAULT 0,
    book TEXT,
    title TEXT NOT NULL,
    planned_date TEXT,
    done_date TEXT,
    done_log_id INTEGER
  )`,
  // 일지 알림 보낸 기록 (같은 수업에 두 번 보내지 않게)
  `CREATE TABLE IF NOT EXISTS log_reminders (
    course_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    sent_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (course_id, date)
  )`,
  // 영단어 시험 (본시험 attempt=1, 재시험 2, 3 …)
  `CREATE TABLE IF NOT EXISTS word_tests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    course_id INTEGER,
    teacher_id INTEGER,
    date TEXT NOT NULL,
    book TEXT,
    range TEXT,
    total INTEGER NOT NULL,
    score INTEGER NOT NULL,
    pass_score INTEGER NOT NULL,
    passed INTEGER NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1,
    parent_id INTEGER,
    memo TEXT,
    photo TEXT,
    photo_v INTEGER,
    token TEXT,
    sent_at TEXT,
    retest_at TEXT,
    retest_memo TEXT,
    retest_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  // 교재 배부 내역
  `CREATE TABLE IF NOT EXISTS book_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    title TEXT NOT NULL,
    book_id INTEGER,
    subject TEXT,
    qty INTEGER NOT NULL DEFAULT 1,
    price INTEGER,
    memo TEXT,
    given_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  // 수납 내역 (교육비 / 교재비)
  `CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('교육비','교재비')),
    month TEXT,
    amount INTEGER NOT NULL,
    paid_date TEXT NOT NULL,
    method TEXT,
    memo TEXT,
    created_by INTEGER,
    ref TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  // 할 일: scope academy(원장이 정한 학원 업무) / personal(내 할 일)
  // repeat once(그날 하루, 못 하면 다음 날로 넘어감) / daily(매일) / weekly(고른 요일)
  `CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL DEFAULT 'personal',
    title TEXT NOT NULL,
    memo TEXT,
    assignee_id INTEGER,
    repeat TEXT NOT NULL DEFAULT 'once',
    days TEXT,
    date TEXT,
    needs_report INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS task_done (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    done_at TEXT NOT NULL DEFAULT (datetime('now')),
    report TEXT,
    report_status TEXT,
    checked_at TEXT,
    UNIQUE (task_id, user_id, date)
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_att_student_date ON attendance (student_id, date)`,
  `CREATE INDEX IF NOT EXISTS idx_att_course_date ON attendance (course_id, date)`,
  `CREATE INDEX IF NOT EXISTS idx_msg_created ON messages (created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_consult_student ON consultations (student_id)`,
  `CREATE INDEX IF NOT EXISTS idx_books_student ON book_deliveries (student_id)`,
  `CREATE INDEX IF NOT EXISTS idx_deliv_book ON book_deliveries (book_id)`,
  `CREATE INDEX IF NOT EXISTS idx_stock_book ON book_stock (book_id)`,
  `CREATE INDEX IF NOT EXISTS idx_bills_student ON bills (student_id, month)`,
  `CREATE INDEX IF NOT EXISTS idx_units_course ON course_units (course_id, seq)`,
  `CREATE INDEX IF NOT EXISTS idx_logs_date ON class_logs (date)`,
  `CREATE INDEX IF NOT EXISTS idx_wt_student ON word_tests (student_id, date)`,
  `CREATE INDEX IF NOT EXISTS idx_wt_course ON word_tests (course_id, date)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_wt_token ON word_tests (token)`,
  `CREATE INDEX IF NOT EXISTS idx_pay_student ON payments (student_id, kind)`,
  `CREATE INDEX IF NOT EXISTS idx_students_family ON students (family_id)`,
  `CREATE INDEX IF NOT EXISTS idx_task_done ON task_done (user_id, date)`,
  `CREATE INDEX IF NOT EXISTS idx_task_report ON task_done (report_status)`,
];

export const DEFAULT_SETTINGS = {
  academy_name: '새솔학원',
  mottos: JSON.stringify([
    '학생 한 명 한 명을 끝까지 챙깁니다.',
    '기록이 쌓이면 신뢰가 쌓입니다.',
    '오늘도 좋은 수업을 부탁드립니다.',
  ]),
  tpl_attendance: '[{학원}] {학생} 학생이 {날짜} {반} 수업에 {상태}하였습니다.{메모}',
  tpl_feedback: '[{학원}] {학생} 학생 {과목} 수업 피드백\n\n{내용}\n\n- {선생님} 드림',
  send_mode: 'preview',
  // 할인 항목 (설정에서 바꿀 수 있어요)
  discount_items: JSON.stringify([
    { id: 'd1', name: '2과목수강할인', amount: 20000 },
    { id: 'd2', name: '3과목수강할인', amount: 40000 },
    { id: 'd3', name: '3과목수강할인', amount: 50000 },
    { id: 'd4', name: '가족할인', amount: 10000 },
    { id: 'd5', name: '가족할인', amount: 30000 },
  ]),
  book_suppliers: JSON.stringify(['샘터서점', '대한서정', '러닝북스', '조이매스', '인터넷 총판']),
  // 수업 일지 알림: 수업이 끝나고 after_min 분이 지나도 일지가 없으면 알림
  log_remind: JSON.stringify({ on: true, after_min: 60, sms: true }),
  tpl_log_remind: '[{학원}] {선생님}쌤, 오늘 {반} ({시간}) 수업 일지가 아직 없어요. 시간 되실 때 작성 부탁드려요 🙏',
  // 영단어 시험
  word_pass_pct: '90',
  word_books: JSON.stringify([
    { name: '워드마스터 고등 Complete', days: 40 },
    { name: '워드마스터 하이스트', days: 50 },
    { name: '워드마스터 고등 숙어 1000', days: 50 },
  ]),
  tpl_word: '[{학원}] {학생} 단어시험 {차수}\n{교재} {범위}\n점수 {점수} ({결과})\n\n시험지 보기: {링크}',
  tpl_word_retest: '[{학원}] {학생} 영어 단어 재시험 안내\n{일시}\n범위: {교재} {범위}{메모}\n꼭 준비해서 와 주세요!',
  bank_account: '',
  bank_account_book: '',
  tpl_bill_tuition: '[{학원}] {학생} 학생 {월}월 교육비 안내\n\n{내역}\n합계 {합계}\n\n입금 계좌: {계좌}\n이미 납부하셨다면 이 문자는 넘겨 주세요. 감사합니다.',
  tpl_bill_book: '[{학원}] {학생} 학생 교재비 안내\n\n{내역}\n합계 {합계}\n\n입금 계좌: {계좌}\n이미 납부하셨다면 이 문자는 넘겨 주세요. 감사합니다.',
  tpl_bill: '[{학원}] {학생} 학생 {월}월 수납 안내\n\n{내역}\n합계 {합계}\n\n입금 계좌: {계좌}\n이미 납부하셨다면 이 문자는 넘겨 주세요. 감사합니다.',
  // 강사에게 보여 줄 학생 정보 (원장은 항상 전부 봅니다)
  teacher_view: JSON.stringify({
    birth: true,
    address: false,
    parents: true,
    siblings: true,
    memo: true,
    fees: false,
    books: true,
    tuition: false,
    bookpay: false,
  }),
};

export const TEACHER_VIEW_LABELS = {
  birth: '생년월일',
  address: '주소',
  parents: '부모님 성함·연락처',
  siblings: '형제·자매',
  memo: '특이사항 메모',
  fees: '수강료',
  books: '교재 배부 내역 (보기·기록)',
  tuition: '교육비 수납 내역',
  bookpay: '교재비 수납 내역',
};

const MIGRATIONS = [
  'ALTER TABLE word_tests ADD COLUMN retest_at TEXT',
  'ALTER TABLE word_tests ADD COLUMN retest_memo TEXT',
  'ALTER TABLE word_tests ADD COLUMN retest_by INTEGER',
  'ALTER TABLE users ADD COLUMN photo TEXT',
  'ALTER TABLE users ADD COLUMN photo_v INTEGER',
  'ALTER TABLE users ADD COLUMN staff_role TEXT',
  'ALTER TABLE courses ADD COLUMN fee INTEGER',
  'ALTER TABLE courses ADD COLUMN times TEXT',
  'ALTER TABLE payments ADD COLUMN ref TEXT',
  'ALTER TABLE book_deliveries ADD COLUMN book_id INTEGER',
  'ALTER TABLE bills ADD COLUMN kind TEXT',
  'ALTER TABLE class_log_notes ADD COLUMN hw TEXT',
  'ALTER TABLE class_log_notes ADD COLUMN achieve TEXT',
  'ALTER TABLE course_units ADD COLUMN book TEXT',
  'ALTER TABLE courses ADD COLUMN log_fields TEXT',
  'ALTER TABLE class_logs ADD COLUMN books TEXT',
  'ALTER TABLE class_logs ADD COLUMN extras TEXT',
  'ALTER TABLE enrollments ADD COLUMN fee INTEGER',
  'ALTER TABLE consultations ADD COLUMN subject TEXT',
];

let initialized = false;

export async function ensureSchema(db) {
  if (initialized) return;
  // 1) 표 만들기 (이미 있으면 그대로)
  await db.batch(SCHEMA.filter((sql) => !/CREATE INDEX/.test(sql)).map((sql) => db.prepare(sql)));
  // 2) 예전에 만든 데이터베이스에 새 칸이 없으면 추가 (이미 있으면 넘어감)
  for (const sql of MIGRATIONS) {
    try { await db.prepare(sql).run(); } catch (e) { /* 이미 있으면 그냥 넘어갑니다 */ }
  }
  // 3) 색인은 새 칸이 생긴 다음에 만들어요. 하나가 실패해도 앱은 멈추지 않아요.
  for (const sql of SCHEMA.filter((x) => /CREATE INDEX/.test(x))) {
    try { await db.prepare(sql).run(); } catch (e) { console.error('index', e && e.message); }
  }
  initialized = true;
}
