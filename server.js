const fetch = require('node-fetch');
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

const app = express();
const PORT = process.env.PORT || 3000;

// DB 초기화
const adapter = new FileSync('db.json');
const db = low(adapter);
db.defaults({ reviews: [], reports: [], nextId: 1 }).write();

// 건보공단 장기요양기관 평가결과 (CSV → JSON 가공, 기관코드별 최신 평가만)
let evaluationData = {};
try {
  evaluationData = JSON.parse(fs.readFileSync(path.join(__dirname, 'evaluations.json'), 'utf8'));
  console.log(`평가정보 로드 완료: ${Object.keys(evaluationData).length}개 기관`);
} catch (err) {
  console.error('평가정보 파일을 불러오지 못했습니다:', err.message);
}

// 시군구 코드 (행정표준코드, 시도코드별 시군구 목록)
let sigunguData = {};
try {
  sigunguData = JSON.parse(fs.readFileSync(path.join(__dirname, 'sigungu.json'), 'utf8'));
  console.log(`시군구 코드 로드 완료: ${Object.keys(sigunguData).length}개 시도`);
} catch (err) {
  console.error('시군구 코드 파일을 불러오지 못했습니다:', err.message);
}

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

// 여러 시설명에 대한 후기 개수를 한 번에 조회 (검색 결과 카드에 후기 개수 표시용)
app.post('/api/reviews/counts', (req, res) => {
  const { facilityNames } = req.body;
  if (!Array.isArray(facilityNames)) {
    return res.status(400).json({ error: 'facilityNames 배열이 필요합니다.' });
  }
  const reviews = db.get('reviews').value();
  const counts = {};
  facilityNames.forEach(name => {
    counts[name] = reviews.filter(r => r.facility_name === name).length;
  });
  res.json({ counts });
});

// 후기 작성
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

// 간단한 XML 파서
function parseXmlItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1];
    const obj = {};
    const fieldRegex = /<(\w+)>([\s\S]*?)<\/\1>/g;
    let fieldMatch;
    while ((fieldMatch = fieldRegex.exec(itemXml)) !== null) {
      obj[fieldMatch[1]] = fieldMatch[2].trim();
    }
    items.push(obj);
  }
  const totalCountMatch = xml.match(/<totalCount>(\d+)<\/totalCount>/);
  const totalCount = totalCountMatch ? Number(totalCountMatch[1]) : 0;
  return { items, totalCount };
}

// 전국 17개 시도 코드 (법정동 코드 기준)
// 주의: 강원(42), 전북(45)이 기존에 51/52로 잘못 매핑되어 있던 버그를 수정함
// (존재하지 않는 시도코드로 조회되어 강원/전북 검색이 항상 빈 결과를 반환하던 문제)
const SIDO_CODES = ['11','26','27','28','29','30','31','36','41','42','43','44','45','46','47','48','50'];
const SIDO_NAMES = {
  '11':'서울','26':'부산','27':'대구','28':'인천','29':'광주','30':'대전',
  '31':'울산','36':'세종','41':'경기','42':'강원','43':'충북','44':'충남',
  '45':'전북','46':'전남','47':'경북','48':'경남','50':'제주'
};

// 시도코드로 시군구 목록 조회
app.get('/api/regions/sigungu', (req, res) => {
  const { sido } = req.query;
  if (!sido || !sigunguData[sido]) return res.json({ items: [] });
  res.json({ items: sigunguData[sido] });
});

async function fetchSido(serviceKey, siDoCd, keyword, numOfRows) {
  const params = new URLSearchParams({
    ServiceKey: serviceKey,
    pageNo: 1,
    numOfRows,
    siDoCd
  });
  if (keyword) params.append('adminNm', keyword);

  const url = `https://apis.data.go.kr/B550928/searchLtcInsttService02/getLtcInsttSeachList02?${params}`;
  const response = await fetch(url);
  const xmlText = await response.text();
  const { items } = parseXmlItems(xmlText);
  return items.map(it => ({ ...it, siDoNm: SIDO_NAMES[siDoCd] || '' }));
}

// 요양기관 검색 API (건보공단 공공데이터)
// - region 지정: 해당 지역만, 서버 페이지네이션(20건씩) 그대로 사용. 키워드 없이도 동작(지역 전체 목록).
// - region 미지정(전국): 반드시 keyword 필요. 17개 시도를 병렬로 동시 조회해 합침(정렬 기준: 시도 가나다순 → 등록일순).
app.get('/api/facilities/search', async (req, res) => {
  const { keyword, region, sigungu, page = 1 } = req.query;
  const serviceKey = '54fa6a4fb68a227e04811bbe2844d5332bc4319c3105190c5e20758bc45af3ae';

  try {
    // 지역이 지정된 경우: 해당 지역만 검색, 서버 자체 페이지네이션 사용
    if (region) {
      const params = new URLSearchParams({
        ServiceKey: serviceKey,
        pageNo: page,
        numOfRows: 20,
        siDoCd: region
      });
      if (keyword) params.append('adminNm', keyword);
      if (sigungu) {
        // 응답 필드 siGunGuCd는 3자리(시도코드 2자리를 뺀 나머지)만 사용함 (예: 11590 동작구 → 590)
        const sigunguSuffix = sigungu.length === 5 ? sigungu.slice(2) : sigungu;
        params.append('siGunGuCd', sigunguSuffix);
      }

      const url = `https://apis.data.go.kr/B550928/searchLtcInsttService02/getLtcInsttSeachList02?${params}`;
      const response = await fetch(url);
      const xmlText = await response.text();
      const { items, totalCount } = parseXmlItems(xmlText);
      const itemsWithRegionName = items.map(it => ({ ...it, siDoNm: SIDO_NAMES[it.siDoCd] || '' }));
      const groupedItems = groupByFacility(itemsWithRegionName);
      return res.json({
        items: groupedItems,
        totalCount,
        page: Number(page),
        hasMore: Number(page) * 20 < totalCount
      });
    }

    // 전국: keyword 필수 (지역 정보 없이는 결과 기준이 모호하고 API 자체도 의미 있는 결과를 안 줌)
    if (!keyword) {
      return res.json({
        items: [],
        totalCount: 0,
        page: 1,
        hasMore: false,
        notice: '전국에서 찾으시려면 시설명을 입력해주세요. 지역을 먼저 선택하시면 해당 지역 전체 목록을 바로 볼 수 있어요.'
      });
    }

    // 17개 시도를 병렬로 동시 조회 (순차 호출보다 훨씬 빠름)
    const results = await Promise.allSettled(
      SIDO_CODES.map(siDoCd => fetchSido(serviceKey, siDoCd, keyword, 10))
    );

    let allItems = [];
    results.forEach((r, idx) => {
      if (r.status === 'fulfilled') {
        allItems = allItems.concat(r.value);
      } else {
        console.error(`siDoCd ${SIDO_CODES[idx]} 검색 실패:`, r.reason && r.reason.message);
      }
    });

    // 정렬 기준 명시: 시도 가나다순 → 등록일 최신순
    allItems.sort((a, b) => {
      if (a.siDoNm !== b.siDoNm) return (a.siDoNm || '').localeCompare(b.siDoNm || '');
      return (b.longTermPeribRgtDt || '').localeCompare(a.longTermPeribRgtDt || '');
    });

    const groupedItems = groupByFacility(allItems);

    res.json({
      items: groupedItems,
      totalCount: groupedItems.length,
      page: 1,
      hasMore: false,
      notice: `전국 17개 시도에서 "${keyword}"(으)로 검색한 결과예요. (시도별 최대 10건, 지역명 가나다순 정렬)`
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '요양기관 데이터를 불러오는데 실패했습니다.' });
  }
});

// 기관코드(longTermAdminSym) 기준으로 중복 row를 하나로 묶고, 운영 서비스 종류를 배열로 첨부
function groupByFacility(items) {
  const map = new Map();
  items.forEach(item => {
    const key = item.longTermAdminSym;
    const type = adminTypeInfoServer(item.adminPttnCd);
    if (!map.has(key)) {
      const ev = evaluationData[key];
      map.set(key, {
        ...item,
        services: [{ code: item.adminPttnCd, label: type.label }],
        grade: ev ? ev.grade : null,
        totalScore: ev ? ev.totalScore : null
      });
    } else {
      const existing = map.get(key);
      if (!existing.services.some(s => s.code === item.adminPttnCd)) {
        existing.services.push({ code: item.adminPttnCd, label: type.label });
      }
      // 가장 최근 지정일을 대표값으로 사용
      if ((item.longTermPeribRgtDt || '') > (existing.longTermPeribRgtDt || '')) {
        existing.longTermPeribRgtDt = item.longTermPeribRgtDt;
      }
    }
  });
  return Array.from(map.values());
}

function adminTypeInfoServer(code) {
  const map = {
    'A04': { label: '요양원' },
    'A03': { label: '요양병원' },
    'C01': { label: '방문요양' },
    'C02': { label: '방문목욕' },
    'C04': { label: '방문간호' },
    'C05': { label: '주야간보호' },
    'C06': { label: '단기보호' }
  };
  return map[code] || { label: '재가/복지기관' };
}

// ===== 네이버 검색 + 지도 연동 =====
const NAVER_SEARCH_CLIENT_ID = 'TdN68xax6fpQkH12uins';
const NAVER_SEARCH_CLIENT_SECRET = 'QpAGL0wFKj';
const NCP_MAPS_CLIENT_ID = 'sbg4s24ek6';
const NCP_MAPS_CLIENT_SECRET = 'vtIvmi9NOIZD4ylAaMUwlD4REKBObNYA36IBGWC3';

function stripHtmlTags(str) {
  return (str || '').replace(/<[^>]*>/g, '');
}

// 시설명(+지역힌트)으로 네이버 지역검색을 호출해 가장 그럴듯한 주소/전화번호를 찾음
async function searchNaverLocal(query) {
  const params = new URLSearchParams({ query, display: 5, sort: 'random' });
  const url = `https://openapi.naver.com/v1/search/local.json?${params}`;
  const response = await fetch(url, {
    headers: {
      'X-Naver-Client-Id': NAVER_SEARCH_CLIENT_ID,
      'X-Naver-Client-Secret': NAVER_SEARCH_CLIENT_SECRET
    }
  });
  if (!response.ok) return null;
  const data = await response.json();
  if (!data.items || data.items.length === 0) return null;

  const top = data.items[0];
  return {
    name: stripHtmlTags(top.title),
    address: top.roadAddress || top.address || '',
    phone: top.telephone || '',
    link: top.link || '',
    mapx: top.mapx,
    mapy: top.mapy
  };
}

// 주소 문자열로 NCP Geocoding을 호출해 위도/경도를 받음
async function geocodeAddress(address) {
  if (!address) return null;
  const params = new URLSearchParams({ query: address });
  const url = `https://maps.apigw.ntruss.com/map-geocode/v2/geocode?${params}`;
  const response = await fetch(url, {
    headers: {
      'x-ncp-apigw-api-key-id': NCP_MAPS_CLIENT_ID,
      'x-ncp-apigw-api-key': NCP_MAPS_CLIENT_SECRET
    }
  });
  if (!response.ok) return null;
  const data = await response.json();
  if (!data.addresses || data.addresses.length === 0) return null;
  const top = data.addresses[0];
  return {
    roadAddress: top.roadAddress || '',
    jibunAddress: top.jibunAddress || '',
    lat: top.y,
    lng: top.x
  };
}

function staticMapUrl(lat, lng) {
  const params = new URLSearchParams({
    'w': 600,
    'h': 300,
    'center': `${lng},${lat}`,
    'level': 16,
    'markers': `type:d|size:mid|pos:${lng} ${lat}`
  });
  return `https://maps.apigw.ntruss.com/map-static/v2/raster?${params}&X-NCP-APIGW-API-KEY-ID=${NCP_MAPS_CLIENT_ID}&X-NCP-APIGW-API-KEY=${NCP_MAPS_CLIENT_SECRET}`;
}

// 시설명 + 시도명을 조합해 주소/좌표/지도이미지/길찾기링크를 한 번에 조회
app.get('/api/facilities/location', async (req, res) => {
  const { name, region } = req.query;
  if (!name) return res.status(400).json({ error: '시설명(name)이 필요합니다.' });

  try {
    const localResult = await searchNaverLocal(region ? `${region} ${name}` : name);
    if (!localResult || !localResult.address) {
      return res.json({ found: false });
    }

    const geo = await geocodeAddress(localResult.address);

    const result = {
      found: true,
      address: (geo && geo.roadAddress) || localResult.address,
      phone: localResult.phone || '',
      lat: geo ? geo.lat : null,
      lng: geo ? geo.lng : null,
      mapImageUrl: geo ? staticMapUrl(geo.lat, geo.lng) : null,
      directionsUrl: geo
        ? `https://map.naver.com/p/directions/-/${geo.lng},${geo.lat},${encodeURIComponent(localResult.name)}/-/walk`
        : `https://map.naver.com/p/search/${encodeURIComponent(localResult.name)}`,
      naverMapViewUrl: geo
        ? `https://map.naver.com/p/search/${encodeURIComponent(geo.roadAddress)}`
        : `https://map.naver.com/p/search/${encodeURIComponent(localResult.name)}`
    };

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '위치 정보를 불러오는데 실패했습니다.' });
  }
});

// 추천시설: 같은 지역(siDoCd) + 같은 서비스유형(adminPttnCd)의 다른 시설 몇 곳을 보여줌
app.get('/api/facilities/recommend', async (req, res) => {
  const { region, type, exclude } = req.query;
  const serviceKey = '54fa6a4fb68a227e04811bbe2844d5332bc4319c3105190c5e20758bc45af3ae';

  if (!region) return res.json({ items: [] });

  try {
    const params = new URLSearchParams({
      ServiceKey: serviceKey,
      pageNo: 1,
      numOfRows: 8,
      siDoCd: region
    });

    const url = `https://apis.data.go.kr/B550928/searchLtcInsttService02/getLtcInsttSeachList02?${params}`;
    const response = await fetch(url);
    const xmlText = await response.text();
    const { items } = parseXmlItems(xmlText);

    let filtered = items.filter(it => it.longTermAdminSym !== exclude);
    if (type) filtered = filtered.filter(it => it.adminPttnCd === type);

    const grouped = groupByFacility(filtered).slice(0, 4);
    res.json({ items: grouped });
  } catch (err) {
    console.error(err);
    res.json({ items: [] });
  }
});

// 이 시설 관련 네이버 블로그 글 모음 (제목/요약/링크만 제공, 원문은 외부 링크로 이동)
app.get('/api/facilities/blogs', async (req, res) => {
  const { name } = req.query;
  if (!name) return res.json({ items: [] });

  try {
    // 후보를 넉넉히 받은 뒤, 시설명 전체가 정확히 포함된 글만 골라낸다.
    const params = new URLSearchParams({ query: name, display: 20, sort: 'sim' });
    const url = `https://openapi.naver.com/v1/search/blog.json?${params}`;
    const response = await fetch(url, {
      headers: {
        'X-Naver-Client-Id': NAVER_SEARCH_CLIENT_ID,
        'X-Naver-Client-Secret': NAVER_SEARCH_CLIENT_SECRET
      }
    });
    if (!response.ok) return res.json({ items: [] });
    const data = await response.json();

    const normalize = (s) => stripHtmlTags(s || '').replace(/\s+/g, '');
    const targetName = normalize(name);
    const jobPostingKeywords = ['채용', '구인', '구직', '모집공고', '직원모집', '근무자모집', '알바모집', '채용공고', '잡코리아', '사람인'];

    const items = (data.items || [])
      .filter(item => {
        const title = normalize(item.title);
        const desc = normalize(item.description);
        // 시설명 전체 문자열이 제목 또는 본문에 그대로 포함된 경우만 통과
        const nameMatched = title.includes(targetName) || desc.includes(targetName);
        if (!nameMatched) return false;
        // 채용/구인구직 관련 글은 이용자 정보가 아니므로 제외
        const isJobPosting = jobPostingKeywords.some(kw => title.includes(kw) || desc.includes(kw));
        return !isJobPosting;
      })
      .slice(0, 5)
      .map(item => ({
        title: stripHtmlTags(item.title),
        summary: stripHtmlTags(item.description),
        link: item.link,
        bloggerName: item.bloggername || '',
        postDate: item.postdate || ''
      }));

    res.json({ items });
  } catch (err) {
    console.error(err);
    res.json({ items: [] });
  }
});

// 단일 item(배열 아님) 응답 파서: <item>...</item> 하나만 있는 응답용
function parseXmlSingleItem(xml) {
  const match = xml.match(/<item>([\s\S]*?)<\/item>/);
  if (!match) return null;
  const obj = {};
  const fieldRegex = /<(\w+)>([\s\S]*?)<\/\1>/g;
  let fieldMatch;
  while ((fieldMatch = fieldRegex.exec(match[1])) !== null) {
    obj[fieldMatch[1]] = fieldMatch[2].trim();
  }
  return obj;
}

async function fetchDetailEndpoint(endpoint, serviceKey, longTermAdminSym, adminPttnCd, isList) {
  const params = new URLSearchParams({
    ServiceKey: serviceKey,
    longTermAdminSym,
    adminPttnCd
  });
  const url = `https://apis.data.go.kr/B550928/getLtcInsttDetailInfoService02/${endpoint}?${params}`;
  const response = await fetch(url);
  const xmlText = await response.text();
  if (isList) {
    const { items } = parseXmlItems(xmlText);
    return items;
  }
  return parseXmlSingleItem(xmlText);
}

// 시설 상세정보 종합 API: 6개 공공데이터 엔드포인트를 병렬 호출해 한 번에 합쳐서 반환
app.get('/api/facilities/detail/:longTermAdminSym', async (req, res) => {
  const serviceKey = '54fa6a4fb68a227e04811bbe2844d5332bc4319c3105190c5e20758bc45af3ae';
  const { longTermAdminSym } = req.params;
  const { adminPttnCd } = req.query;

  if (!adminPttnCd) {
    return res.status(400).json({ error: '기관유형코드(adminPttnCd)가 필요합니다.' });
  }

  try {
    const [general, staff, facility, occupancy, programs, etc, nonBenefit, convInstt, wlfareTool] = await Promise.allSettled([
      fetchDetailEndpoint('getGeneralSttusDetailInfoItem02', serviceKey, longTermAdminSym, adminPttnCd, false),
      fetchDetailEndpoint('getStaffSttusDetailInfoItem02', serviceKey, longTermAdminSym, adminPttnCd, false),
      fetchDetailEndpoint('getInsttSttusDetailInfoItem02', serviceKey, longTermAdminSym, adminPttnCd, false),
      fetchDetailEndpoint('getAceptncNmprDetailInfoItem02', serviceKey, longTermAdminSym, adminPttnCd, false),
      fetchDetailEndpoint('getProgramSttusDetailInfoList02', serviceKey, longTermAdminSym, adminPttnCd, true),
      fetchDetailEndpoint('getInsttEtcDetailInfoItem02', serviceKey, longTermAdminSym, adminPttnCd, false),
      fetchDetailEndpoint('getNonBenefitSttusDetailInfoList02', serviceKey, longTermAdminSym, adminPttnCd, true),
      fetchDetailEndpoint('getConvInsttDetailInfoList02', serviceKey, longTermAdminSym, adminPttnCd, true),
      fetchDetailEndpoint('getWlfareToolDetailInfoList02', serviceKey, longTermAdminSym, adminPttnCd, true)
    ]);

    const g = general.status === 'fulfilled' ? general.value : null;
    const s = staff.status === 'fulfilled' ? staff.value : null;
    const f = facility.status === 'fulfilled' ? facility.value : null;
    const o = occupancy.status === 'fulfilled' ? occupancy.value : null;
    const p = programs.status === 'fulfilled' ? programs.value : [];
    const e = etc.status === 'fulfilled' ? etc.value : null;
    const nb = nonBenefit.status === 'fulfilled' ? nonBenefit.value : [];
    const ci = convInstt.status === 'fulfilled' ? convInstt.value : [];
    const wt = wlfareTool.status === 'fulfilled' ? wlfareTool.value : [];

    // 전화번호 조합
    let phone = '';
    if (g && g.locTelNo_1) {
      phone = [g.locTelNo_1, g.locTelNo_2, g.locTelNo_3].filter(Boolean).join('-');
    }

    const result = {
      adminNm: (g && g.adminNm) || '',
      adminPttnCd,
      siDoCd: (g && g.siDoCd) || '',
      siDoNm: SIDO_NAMES[(g && g.siDoCd) || ''] || '',
      phone,
      registeredDate: g ? formatYmdServer(g.longTermPeribRgtDt) : '',
      reportedDate: g ? formatYmdServer(g.stpRptDt) : '',

      staff: s ? {
        간호사: Number(s.nur || 0),
        간호조무사: Number(s.nurArticle || 0),
        사회복지사: Number(s.socWel || 0),
        물리치료사: Number(s.physicalMTret || 0),
        작업치료사: Number(s.wrkMTret || 0),
        영양사: Number(s.nut || 0),
        조리원: Number(s.cook || 0),
        위생원: Number(s.hygiPrsn || 0),
        사무원: Number(s.ofceEmp || 0),
        관리인: Number(s.mgmtPrsn || 0),
        시설장: Number(s.hdOfce || 0),
        요양보호사1급: Number(s.recuProt_1 || 0),
        요양보호사2급: Number(s.recuProt_2 || 0),
        의사촉탁: Number(s.chrgDoc || 0),
        의사전임: Number(s.chargeDoc || 0)
      } : null,

      facility: f ? {
        '1인실': Number(f.prsnRoomreal1 || 0),
        '2인실': Number(f.prsnRoomreal2 || 0),
        '3인실': Number(f.prsnRoomreal3 || 0),
        '4인실이상': Number(f.prsnRoomreal4 || 0),
        화장실: Number(f.batRoom || 0),
        '의료/간호실': Number(f.medRoomreal || 0),
        프로그램실: Number(f.pgmRoomreal || 0),
        사무실: Number(f.ofce || 0),
        기능훈련실: Number(f.funcTrnRoomreal || 0)
      } : null,

      occupancy: o ? {
        정원: Number(o.totPer || 0),
        현원남: Number(o.maNowPer || 0),
        현원여: Number(o.fmNowPer || 0),
        대기남: Number(o.maRsvPer || 0),
        대기여: Number(o.frsvPer || 0)
      } : null,

      programs: (p || []).map(item => ({
        name: item.pgmTtl || item.pgmKndNm || '프로그램',
        target: item.pgmTrgtPer || '',
        cycle: item.pgmCycle || '',
        place: item.pgmPlace || ''
      })),

      homepage: (e && e.hmpgAddr && e.hmpgAddr !== '없음') ? e.hmpgAddr : '',
      parking: (e && e.pkngEquip) || '',
      transportation: (e && e.tfMth) || '',

      nonBenefits: (nb || []).map(item => ({
        name: item.nbnefBzClsfNm || item.itemNm || '항목',
        price: item.nbnefAmt || item.amt || '',
        basis: item.calcBasiCn || item.calcBass || '',
        date: item.regDt ? formatYmdServer(item.regDt) : ''
      })),

      convInstts: (ci || []).map(item => ({
        name: item.convAdminNm || item.cnvnInsttNm || '협약기관',
        period: [item.convStrtDt, item.convEndDt].filter(Boolean).map(formatYmdServer).join(' ~ ')
      })),

      welfareTools: (wt || []).map(item => ({
        name: item.eqpmnNm || item.itemNm || '복지용구',
        maker: item.mnftcr || '',
        model: item.modelNm || '',
        usage: item.useNm || ''
      })),

      evaluation: evaluationData[longTermAdminSym] || null
    };

    res.json({ item: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '상세 정보를 불러오는데 실패했습니다.' });
  }
});

function formatYmdServer(str) {
  if (!str || str.length !== 8) return '';
  return `${str.slice(0,4)}.${str.slice(4,6)}.${str.slice(6,8)}`;
}

app.listen(PORT, () => {
  console.log(`케어보이스 서버 실행: http://localhost:${PORT}`);
});