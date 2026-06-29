const fetch = require('node-fetch');
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
// 요양기관 검색 API
app.get('/api/facilities/search', async (req, res) => {
  const { keyword, region, type, page = 1 } = req.query;
  const serviceKey = '54fa6a4fb68a227e04811bbe2844d5332bc4319c3105190c5e20758bc45af3ae';
  
  try {
    const params = new URLSearchParams({
      ServiceKey: serviceKey,
      pageNo: page,
      numOfRows: 10,
      resultType: 'json'
    });
    
    if (keyword) params.append('LtcInsttNm', keyword);
    if (region) params.append('siDoCd', region);
    if (type) params.append('longTermCareInsttSecd', type);

    const response = await fetch(`https://apis.data.go.kr/B550928/searchLtcInsttService02/getLtcInsttList?${params}`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: '요양기관 데이터를 불러오는데 실패했습니다.' });
  }
});

// 요양기관 상세조회 API
app.get('/api/facilities/:id', async (req, res) => {
  const serviceKey = '54fa6a4fb68a227e04811bbe2844d5332bc4319c3105190c5e20758bc45af3ae';
  
  try {
    const params = new URLSearchParams({
      ServiceKey: serviceKey,
      resultType: 'json',
      LtcInsttNo: req.params.id
    });

    const response = await fetch(`https://apis.data.go.kr/B550928/getLtcInsttDetailInfoService02/getLtcInsttDetailInfo?${params}`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: '상세 정보를 불러오는데 실패했습니다.' });
  }
});