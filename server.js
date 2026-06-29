const express = require('express');
const cors = require('cors');
const path = require('path');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

const app = express();
const PORT = process.env.PORT || 3000;

// DB 초기화
const adapter = new FileSync('db.json');
const db = low(adapter);
db.defaults({ reviews: [], reports: [], nextId: 1 }).write();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 후기 목록 조회
app.get('/api/reviews', (req, res) => {
  const { facility_name, region, facility_type, page = 1 } = req.query;
  const limit = 10;

  let reviews = db.get('reviews').value();

  if (facility_name) reviews = reviews.filter(r => r.facility_name.includes(facility_name));
  if (region) reviews = reviews.filter(r => r.region === region);
  if (facility_type) reviews = reviews.filter(r => r.facility_type === facility_type);

  reviews = reviews.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const total = reviews.length;
  const paginated = reviews.slice((page - 1) * limit, page * limit);

  res.json({ reviews: paginated, total, page: Number(page) });
});

// 후기 작성ㅈ
app.post('/api/reviews', (req, res) => {
  const {
    facility_name, facility_type, region,
    care_number, admission_date, discharge_date,
    rating_food, rating_clean, rating_staff,
    rating_visit, rating_overall, content
  } = req.body;

  if (!facility_name || !care_number || !admission_date || !content) {
    return res.status(400).json({ error: '필수 항목을 모두 입력해주세요.' });
  }
  if (content.length < 50) {
    return res.status(400).json({ error: '후기는 50자 이상 작성해주세요.' });
  }
  if (!/^\d{10,12}$/.test(care_number.replace(/-/g, ''))) {
    return res.status(400).json({ error: '장기요양인정번호 형식이 올바르지 않습니다.' });
  }

  const id = db.get('nextId').value();
  const review = {
    id, facility_name, facility_type, region,
    care_number: care_number.replace(/-/g, ''),
    admission_date, discharge_date: discharge_date || null,
    rating_food, rating_clean, rating_staff,
    rating_visit, rating_overall, content,
    helpful_count: 0,
    created_at: new Date().toISOString()
  };

  db.get('reviews').push(review).write();
  db.set('nextId', id + 1).write();

  res.json({ success: true, id });
});

// 도움이 됐어요
app.post('/api/reviews/:id/helpful', (req, res) => {
  const id = Number(req.params.id);
  const review = db.get('reviews').find({ id }).value();
  if (review) {
    db.get('reviews').find({ id }).assign({ helpful_count: (review.helpful_count || 0) + 1 }).write();
  }
  res.json({ success: true });
});

// 신고
app.post('/api/reviews/:id/report', (req, res) => {
  const { reason } = req.body;
  db.get('reports').push({ review_id: Number(req.params.id), reason, created_at: new Date().toISOString() }).write();
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`케어보이스 서버 실행: http://localhost:${PORT}`);
});
