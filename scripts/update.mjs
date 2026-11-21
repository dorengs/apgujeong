// 압구정 실거래 전광판 자료 갱신
// 국토교통부 아파트 매매 실거래가 상세 자료(강남구 → 압구정동)를 받아 raw/rows.json 을 고치고 site/data.js 를 새로 만든다.
// 서울부동산정보광장의 토지거래허가 내역(강남구)도 받아 압구정 1~6구역 지번만 raw/permits.json 에 모은다.
// 사용법: MOLIT_KEY=인증키 node scripts/update.mjs [auto | 개월수 | all | build | permits]
//   auto    : 평소 최근 3개월, 월요일(한국 시간)에는 최근 12개월
//   all     : 2006년 1월부터 전부
//   build   : 받지 않고 raw/rows.json 으로 site/data.js 만 다시 만든다
//   permits : 국토부 자료는 받지 않고 토지거래허가 내역만 받아 site/data.js 를 다시 만든다(인증키 필요 없음)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONF = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/cfg.json'), 'utf8'));
const CFG = CONF.cfg;
const RAW = path.join(ROOT, 'raw/rows.json');
const PRAW = path.join(ROOT, 'raw/permits.json');
const OUT = path.join(ROOT, 'site/data.js');
const PERMIT_URL = 'https://land.seoul.go.kr/land/wsklis/getContractList.do';
const BASE = 'https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev';
const KEY = (process.env.MOLIT_KEY || '').trim();
const MODE = (process.argv[2] || 'auto').trim();

const sleep = ms => new Promise(r => setTimeout(r, ms));
const cs = s => { let a = 0; for (let i = 0; i < s.length; i++) a = (a + s.charCodeAt(i) * ((i % 97) + 1)) % 1000003; return a; };
const kstNow = () => new Date(Date.now() + 9 * 3600000);            // 한국 시각을 UTC 칸에 담은 날짜
const kstDay = () => kstNow().toISOString().slice(0, 10).replace(/-/g, '');
const say = (...a) => console.log(...a);
const summary = t => { if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, t + '\n'); };
const fail = msg => { console.error('실패: ' + msg); summary('**실패:** ' + msg); process.exit(1); };

let S = { rows: [], months: {}, track: { since: '', days: [] } };
if (fs.existsSync(RAW)) { const j = JSON.parse(fs.readFileSync(RAW, 'utf8')); S = { rows: j.rows || [], months: j.months || {}, track: j.track || { since: '', days: [] } }; }

async function call(ymd, page) {
  const u = BASE + '?serviceKey=' + encodeURIComponent(KEY) + '&LAWD_CD=11680&DEAL_YMD=' + ymd + '&numOfRows=1000&pageNo=' + page + '&_type=json';
  const r = await fetch(u, { cache: 'no-store', signal: AbortSignal.timeout(40000) });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch (e) { const er = new Error('응답 해석 실패(HTTP ' + r.status + ')'); er.code = 'PARSE ' + t.slice(0, 200).replace(/\s+/g, ' '); throw er; }
  if (j.OpenAPI_ServiceResponse) { const h = j.OpenAPI_ServiceResponse.cmmMsgHeader || {}; const er = new Error(h.returnAuthMsg || h.errMsg || '오류'); er.code = String(h.errMsg || '') + ' ' + String(h.returnAuthMsg || '') + ' ' + String(h.returnReasonCode || ''); throw er; }
  const h = j.response && j.response.header;
  if (!h || !/^0+$/.test(String(h.resultCode))) { const er = new Error('API 오류: ' + (h ? h.resultCode + ' ' + h.resultMsg : '')); er.code = h ? String(h.resultMsg) : ''; throw er; }
  const b = j.response.body || {};
  let items = b.items && b.items.item; if (!items) items = []; if (!Array.isArray(items)) items = [items];
  return { items, total: Number(b.totalCount || 0) };
}
const isKeyErr = e => { const c = (e.code || '') + ' ' + (e.message || ''); if (/초당|PER_SECOND/i.test(c)) return false; return /NOT_REGISTERED|등록되지 않은|KEY_IS_NULL|DEADLINE|기한만료|UNREGISTERED_IP|REQUESTS_EXCEEDS|Unauthorized|Forbidden/i.test(c); };
async function retry(fn, tries = 7) { let last; for (let i = 0; i < tries; i++) { try { return await fn(); } catch (e) { last = e; if (isKeyErr(e)) { e.keyErr = true; throw e; } await sleep(Math.min(1200 * Math.pow(1.6, i), 15000)); } } throw last; }
const pick = x => ({ n: String(x.aptNm || '').trim(), a: Number(x.excluUseAr), y: +x.dealYear, m: +x.dealMonth, d: +x.dealDay, p: Number(String(x.dealAmount).replace(/,/g, '')), f: (x.floor === '' || x.floor == null) ? null : +x.floor, dong: String(x.aptDong || '').trim(), c: String(x.cdealType || '').trim(), cd: String(x.cdealDay || '').trim(), g: String(x.dealingGbn || '').trim(), by: +x.buildYear || null, jb: String(x.jibun || '').trim(), rg: String(x.rgstDate || '').trim(), seq: String(x.aptSeq || '').trim(), umd: String(x.umdNm || '').trim() });
async function month(ymd) {
  let page = 1, out = [], total = 0;
  while (true) {
    const res = await retry(() => call(ymd, page));
    total = res.total; out.push(...res.items);
    if (out.length >= total || res.items.length === 0 || page > 30) break;
    page++; await sleep(400);
  }
  if (out.length !== total) throw new Error('건수 불일치 ' + out.length + '/' + total);
  return { all: out.length, total, apg: out.filter(x => String(x.umdNm || '').includes('압구정')).map(pick) };
}
const rkey = r => [r.n, r.a, r.y, r.m, r.d, r.p, r.f, r.c].join('|');
const dt = r => r.y * 10000 + r.m * 100 + r.d;
const gkey = n => n.replace(/\(.*$/, '');

async function refresh(months) {
  const today = kstDay(); const fresh = []; const failed = [];
  const sinceYm = S.track.since ? +S.track.since.slice(0, 6) : 999999;
  for (const ymd of months) {
    try {
      const r = await month(ymd);
      const old = {}; S.rows.forEach(x => { if (x.y * 100 + x.m === ymd) { const k = rkey(x); (old[k] = old[k] || []).push(x.s || ''); } });
      const tracked = !!S.months[ymd] || ymd > sinceYm;
      r.apg.forEach(x => { const k = rkey(x); if (old[k] && old[k].length) { const v = old[k].shift(); if (v) x.s = v; } else if (tracked) { x.s = today; fresh.push(x); } });
      S.rows = S.rows.filter(x => x.y * 100 + x.m !== ymd).concat(r.apg);
      S.months[ymd] = [r.all, r.total, r.apg.length];
      if (months.length > 12 && months.indexOf(ymd) % 24 === 0) say('  …', ymd, '누계', S.rows.length);
    } catch (e) {
      if (e.keyErr) fail('인증키로 접속되지 않습니다 (' + (e.message || '') + '). 저장소의 MOLIT_KEY 비밀값을 확인해 주세요.');
      failed.push(ymd + ': ' + (e.message || e) + (e.code ? ' [' + String(e.code).slice(0, 120) + ']' : ''));
    }
    await sleep(450);
  }
  return { fresh, failed };
}

function aggregate() {
  const now = kstNow();
  const G = CFG.map((l, i) => { const f = l.split('|'); return { i, zone: f[0], unit: f[1], name: f[3], keys: f[2].split(','), areas: f[4] ? f[4].split(',').map(Number) : [], v: [], nc: 0, dongs: {} }; });
  const un = {}; let cancel = 0;
  S.rows.forEach(r => { const k = gkey(r.n); const g = G.find(g => g.keys.includes(k) && g.areas.includes(r.a)); if (!g) { const u = k + ':' + r.a; un[u] = (un[u] || 0) + 1; return; } r._g = g.i; if (r.c === 'O') { g.nc++; cancel++; return; } g.v.push(r); if (r.dong) g.dongs[r.dong] = 1; });
  const cut = (now.getUTCFullYear() - 1) * 10000 + (now.getUTCMonth() + 1) * 100 + now.getUTCDate();
  const REC = new Map();
  const T = r => [r.p, dt(r), r.f == null ? '' : r.f, r.dong || '', (r.g === '직거래' ? 'D' : '') + (REC.get(r) ? 'H' : '')].join(',');
  const lines = []; const all = [];
  G.forEach(g => {
    const v = g.v.slice().sort((a, b) => dt(a) - dt(b) || a.p - b.p);
    let mx = 0; v.forEach((r, idx) => { REC.set(r, idx > 0 && r.p > mx); if (r.p > mx) mx = r.p; });
    let hi = null; v.forEach(r => { if (!hi || r.p > hi.p || (r.p === hi.p && dt(r) >= dt(hi))) hi = r; });
    const rec = v.slice(-5).reverse(); const c12 = v.filter(r => dt(r) >= cut).length;
    const line = [g.i, v.length, c12, g.nc, v.length ? v[0].y : '', hi ? T(hi) : '', rec.map(T).join(';'), Object.keys(g.dongs).sort((a, b) => a - b).join('.')].join('|');
    lines.push(line + '|#' + cs(line)); v.forEach(r => all.push([g.i, r]));
  });
  const F = x => x[0] + ',' + T(x[1]) + ',' + (x[1].s || '');
  const feed = all.slice().sort((a, b) => dt(b[1]) - dt(a[1]) || b[1].p - a[1].p).slice(0, 12).map(F);
  const fresh = all.filter(x => x[1].s).sort((a, b) => b[1].s.localeCompare(a[1].s) || dt(b[1]) - dt(a[1]) || b[1].p - a[1].p).slice(0, 30).map(F);
  return { G, lines, feed, fresh, valid: all.length, cancel, un };
}

// ── 토지거래허가 내역(서울부동산정보광장 → 강남구) ──────────────────────
// 한 번에 최대 62일까지 조회된다. 압구정동 주소만 골라, 거래 자료에서 그 지번에 가장 많이 나온 단지로 이름을 붙인다.
let P = { asOf: '', from: '', to: '', rows: [] };
if (fs.existsSync(PRAW)) { try { const j = JSON.parse(fs.readFileSync(PRAW, 'utf8')); P = { asOf: j.asOf || '', from: j.from || '', to: j.to || '', rows: j.rows || [] }; } catch (e) { say('raw/permits.json 을 읽지 못해 새로 만듭니다.'); } }
const dayShift = (d, n) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8) + n)).toISOString().slice(0, 10).replace(/-/g, '');
function jibunUnits() {
  const keyUnit = {};
  CFG.forEach(l => { const f = l.split('|'); f[2].split(',').forEach(k => { keyUnit[k] = f[0] + '|' + f[1]; }); });
  const cnt = {};
  S.rows.forEach(r => { const u = keyUnit[gkey(r.n)]; if (!u || !r.jb) return; const m = (cnt[r.jb] = cnt[r.jb] || {}); m[u] = (m[u] || 0) + 1; });
  const out = {};
  Object.keys(cnt).forEach(jb => { const best = Object.entries(cnt[jb]).sort((a, b) => b[1] - a[1])[0][0].split('|'); out[jb] = { z: best[0], u: best[1] }; });
  return out;
}
async function permitCall(begin, end) {
  const r = await fetch(PERMIT_URL, {
    method: 'POST',
    body: new URLSearchParams({ sggCd: '11680', beginDate: begin, endDate: end }),
    headers: { 'X-Requested-With': 'XMLHttpRequest', 'Referer': 'https://land.seoul.go.kr/land/other/contractStatus.do', 'User-Agent': 'Mozilla/5.0 (apgujeong-board)' },
    signal: AbortSignal.timeout(40000)
  });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch (e) { throw new Error('응답 해석 실패(HTTP ' + r.status + ')'); }
  if (!j || !Array.isArray(j.result)) throw new Error('응답 형식이 예상과 다릅니다');
  if (j.result.length && j.result[0].MESSAGE === 'EXCEPTION') throw new Error('한국토지정보시스템 점검 중');
  return j.result;
}
async function refreshPermits() {
  const end = kstDay(), begin = dayShift(end, -60);
  const list = await retry(() => permitCall(begin, end), 3);
  const map = jibunUnits();
  const got = {};
  list.forEach(x => {
    const addr = String(x.ADDRESS || '');
    if (!addr.includes('압구정동')) return;
    const jb = addr.replace(/^.*압구정동\s*/, '').trim();
    const u = map[jb]; if (!u) return;                      // 1~6구역 단지가 아닌 지번(상가·다른 건물)은 뺀다
    // 같은 신청이 대표 지번·개별 지번으로 두 번 올라오는 경우가 있어 접수번호로 묶는다
    const k = x.ACC_NO ? String(x.ACC_YEAR || '') + '-' + String(x.ACC_NO) : ['X', jb, x.HNDL_YMD, x.OBJ_SEQNO].join('-');
    const rec = { k, d: String(x.HNDL_YMD || ''), z: u.z, u: u.u, jb, st: String(x.JOB_GBN_NM || '').trim(), pu: String(x.USE_PURP || '').trim() };
    if (!got[k] || rec.d >= got[k].d) got[k] = rec;
  });
  const known = new Set(P.rows.map(x => x.k));
  const first = !P.rows.length;
  const recs = Object.values(got);
  const fresh = recs.filter(x => !known.has(x.k));
  const byK = new Map(P.rows.map(x => [x.k, x]));
  recs.forEach(x => byK.set(x.k, x));
  P.rows = [...byK.values()].sort((a, b) => b.d.localeCompare(a.d) || b.k.localeCompare(a.k)).slice(0, 300);
  P.from = begin; P.to = end;
  return { fresh, first, total: list.length, apg: recs.length };
}

function monthsFor(mode) {
  const d0 = kstNow(); const list = [];
  const push = n => { for (let i = n - 1; i >= 0; i--) { const d = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() - i, 1)); list.push(d.getUTCFullYear() * 100 + d.getUTCMonth() + 1); } };
  if (mode === 'all' || S.rows.length < 5000) { for (let y = 2006, m = 1; y * 100 + m <= d0.getUTCFullYear() * 100 + d0.getUTCMonth() + 1;) { list.push(y * 100 + m); m++; if (m > 12) { m = 1; y++; } } return { list, full: true }; }
  if (mode === 'auto') push(d0.getUTCDay() === 1 ? 12 : 3); else push(Math.max(1, Math.min(60, parseInt(mode, 10) || 3)));
  return { list, full: false };
}

const today = kstDay();
let fresh = [], failed = [], full = false;
if (MODE !== 'build' && MODE !== 'permits') {
  if (!KEY) fail('MOLIT_KEY 비밀값이 없습니다. 저장소 Settings → Secrets and variables → Actions 에 MOLIT_KEY 를 넣어 주세요.');
  if (!S.track.since && CONF.seed && CONF.seed.since) S.track = { since: CONF.seed.since, days: [CONF.seed.since] };
  const plan = monthsFor(MODE); full = plan.full;
  say((full ? '전체 수집 ' : '갱신 ') + plan.list[0] + '~' + plan.list[plan.list.length - 1] + ' (' + plan.list.length + '개월)');
  const before = S.rows.length;
  const r = await refresh(plan.list); fresh = r.fresh; failed = r.failed;
  if (failed.length === plan.list.length) fail('국토부 자료를 한 달도 받지 못했습니다. ' + failed[0]);
  if (full && failed.length) fail('전체 수집 중 ' + failed.length + '개월을 받지 못했습니다: ' + failed.slice(0, 5).join(' / '));
  if (full && CONF.seed && CONF.seed.seen) CONF.seed.seen.forEach(q => { const hit = S.rows.filter(x => gkey(x.n) === q.k && x.a === q.a && dt(x) === q.date && x.p === q.p && x.f === q.f && x.c !== 'O' && !x.s); if (hit.length === 1) hit[0].s = q.s; });
  if (!S.track.since) S.track = { since: today, days: [today] };
  if (!S.track.days.includes(today)) S.track.days.push(today);
  S.track.days = S.track.days.slice(-60);
  say('행 수 ' + before + ' → ' + S.rows.length + ', 새로 뜬 거래 ' + fresh.length + '건' + (failed.length ? ', 받지 못한 달 ' + failed.length + '개' : ''));
}
if (S.rows.length < 5000) fail('받아 둔 자료가 없습니다. 먼저 전체 수집(all)을 돌려 주세요.');

// 토지거래허가 내역은 실패해도 전광판 갱신을 멈추지 않는다(직전 자료를 그대로 둔다).
let pr = null, permitErr = '';
if (MODE !== 'build') {
  try {
    pr = await refreshPermits();
    P.asOf = kstNow().toISOString().slice(0, 19) + '+09:00';
    say('토지거래허가 내역: 강남구 ' + pr.total + '건 중 압구정 1~6구역 ' + pr.apg + '건' + (pr.first ? ' (처음 받음)' : ', 새로 ' + pr.fresh.length + '건'));
  } catch (e) {
    permitErr = e.message || String(e);
    say('토지거래허가 내역을 받지 못했습니다(직전 자료 유지): ' + permitErr);
  }
}

S.rows.sort((p, q) => dt(p) - dt(q) || (p.n < q.n ? -1 : p.n > q.n ? 1 : 0) || p.a - q.a || p.p - q.p || (p.f || 0) - (q.f || 0) || (p.c < q.c ? -1 : p.c > q.c ? 1 : 0));
const A = aggregate();
const unKeys = Object.keys(A.un).sort();
const unTotal = unKeys.reduce((s, k) => s + A.un[k], 0);
const newAreas = unKeys.filter(k => !(CONF.excluded || []).includes(k));
const kn = kstNow();
// permits 모드는 국토부 자료를 받지 않으므로 기준 시각을 바꾸지 않는다.
const prevAsOf = (() => { try { const m = fs.readFileSync(OUT, 'utf8').match(/asOf:\s*"([^"]+)"/); return m ? m[1] : ''; } catch (e) { return ''; } })();
const asOf = (MODE === 'permits' && prevAsOf) ? prevAsOf : kn.toISOString().slice(0, 19) + '+09:00';
const last = S.rows.length ? S.rows[S.rows.length - 1] : null;
const arr = a => '[\n' + a.map(x => JSON.stringify(x)).join(',\n') + '\n  ]';
const js = '/* 압구정 실거래 전광판 데이터 — 자동으로 만들어지는 파일입니다(scripts/update.mjs). 직접 고치지 마세요.\n'
  + '   국토교통부 아파트 매매 실거래가 상세 자료(강남구 압구정동), 계약일 기준.\n'
  + '   cfg  : 구역|단지|국토부 단지명|호칭|전용면적㎡|동\n'
  + '   lines: 번호|유효건수|최근1년건수|해제건수|첫거래연도|최고가|최근거래(최대 5건, ;구분)|등기거래에서 확인된 동|#체크섬\n'
  + '   거래 : 금액(만원),계약일,층,동,표시(D=직거래, H=계약 당시 신고가)\n'
  + '   feed : 번호,금액,계약일,층,동,표시,뜬 날 (최근 계약 순)   fresh: 같은 형식, 새로 뜬 거래(뜬 날 최신순)\n'
  + '   permits: 서울부동산정보광장 토지거래허가 내역(강남구) 중 압구정 1~6구역, rows = [처리일, 구역, 단지, 결과, 이용목적] (처리일 최신순) */\n'
  + 'window.APG = {\n'
  + '  asOf: ' + JSON.stringify(asOf) + ',\n'
  + '  counts: ' + JSON.stringify({ rows: S.rows.length, valid: A.valid, cancel: A.cancel, excluded: unTotal, from: '2006-01', to: last ? last.y + '-' + String(last.m).padStart(2, '0') : '' }) + ',\n'
  + '  track: ' + JSON.stringify(S.track) + ',\n'
  + '  cfg: ' + arr(CFG) + ',\n'
  + '  lines: ' + arr(A.lines) + ',\n'
  + '  feed: ' + arr(A.feed) + ',\n'
  + '  fresh: ' + arr(A.fresh) + ',\n'
  + '  permits: ' + (P.asOf ? JSON.stringify({ asOf: P.asOf, from: P.from, to: P.to, rows: P.rows.slice(0, 10).map(x => [x.d, x.z, x.u, x.st, x.pu]) }) : 'null') + '\n'
  + '};\n';
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, js);
if (MODE !== 'build' && MODE !== 'permits') {
  fs.mkdirSync(path.dirname(RAW), { recursive: true });
  const rowsOut = S.rows.map(r => { const o = { ...r }; delete o._g; return o; });
  fs.writeFileSync(RAW, '{"track":' + JSON.stringify(S.track) + ',"months":' + JSON.stringify(S.months) + ',"rows":[\n' + rowsOut.map(r => JSON.stringify(r)).join(',\n') + '\n]}\n');
}
if (pr) {
  fs.mkdirSync(path.dirname(PRAW), { recursive: true });
  fs.writeFileSync(PRAW, '{"asOf":' + JSON.stringify(P.asOf) + ',"from":' + JSON.stringify(P.from) + ',"to":' + JSON.stringify(P.to) + ',"rows":[\n' + P.rows.map(r => JSON.stringify(r)).join(',\n') + '\n]}\n');
}

const won = p => { const e = Math.floor(p / 10000), r = p % 10000; return (e ? e + '억' : '') + (r ? (e ? ' ' : '') + r.toLocaleString('ko-KR') + (e ? '' : '만') : ''); };
const label = r => { const g = A.G[r._g]; return (g ? g.unit + ' ' + g.name : gkey(r.n) + ' 전용 ' + r.a + '㎡(호칭 없음)'); };
say('기준 ' + asOf + ' · 전체 ' + S.rows.length + '건 = 유효 ' + A.valid + ' + 해제 ' + A.cancel + ' + 집계 제외 ' + unTotal);
summary('### 압구정 실거래 전광판 갱신');
summary('- 기준 시각: ' + asOf.replace('T', ' ').slice(0, 16) + ' (한국 시간)');
summary('- 전체 ' + S.rows.length.toLocaleString('ko-KR') + '건 (유효 ' + A.valid.toLocaleString('ko-KR') + ' · 해제 ' + A.cancel + ' · 집계 제외 ' + unTotal + ')');
summary('- 새로 뜬 거래: ' + fresh.length + '건');
fresh.forEach(r => { const t = '  - ' + r.y + '.' + String(r.m).padStart(2, '0') + '.' + String(r.d).padStart(2, '0') + ' 계약 · ' + label(r) + ' · ' + won(r.p) + (r.f != null ? ' · ' + r.f + '층' : '') + (r.c === 'O' ? ' · 해제 신고' : ''); say(t); summary(t); });
if (failed.length) { say('받지 못한 달:', failed.join(' / ')); summary('- 받지 못한 달(다음 갱신 때 다시 받음): ' + failed.join(' / ')); }
if (newAreas.length) { const t = '호칭이 없는 새 면적이 나왔습니다(평형별 집계에서 빠져 있음): ' + newAreas.join(', '); say(t); summary('- **확인 필요:** ' + t); }
const pd = d => d.slice(0, 4) + '.' + d.slice(4, 6) + '.' + d.slice(6, 8);
if (permitErr) summary('- 토지거래허가 내역: 받지 못함(직전 자료 유지) — ' + permitErr);
else if (pr) {
  summary('- 토지거래허가 내역(압구정 1~6구역, 최근 60일): ' + pr.apg + '건' + (pr.first ? ' — 처음 받음' : ', 새로 ' + pr.fresh.length + '건'));
  if (!pr.first) pr.fresh.slice(0, 15).forEach(x => { const t = '  - ' + pd(x.d) + ' ' + x.st + ' · ' + x.z + '구역 ' + x.u + (x.pu ? ' · ' + x.pu : ''); say(t); summary(t); });
}
