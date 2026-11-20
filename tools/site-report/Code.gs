/**
 * 青松山 平成院 植樹葬霊園 公式サイト　週次・月次レポート
 *
 * Google スプレッドシートに紐づく Apps Script として使う。設定手順は同じフォルダの README.md。
 *
 *   データ元 … Search Console（必須）／GA4（測定開始後）／シート「問い合わせ記録」（手入力）
 *   出力先   … シート（数値と本文）＋メール
 *   分析     … Claude API が、集計済みの数値だけを読んで日本語の所見を書く
 *
 * 秘密情報（Claude API キー）はスクリプト プロパティにだけ保存する。
 * このファイルは公開リポジトリにあるため、キーや個人情報を書き込まないこと。
 */

const TZ = 'Asia/Tokyo';

/** Search Console は数値の確定に2〜3日かかるため、週次はその分さかのぼって集計する。 */
const GSC_LAG_DAYS = 3;

/** この件数未満は「判断保留」とする目安（AI への指示と、数値表の注記に使う）。 */
const SMALL_COUNT = 10;

const SHEETS = {
  kpi: 'KPI履歴',
  queries: '検索語句（最新）',
  pages: 'ページ（最新）',
  channels: '流入元（最新）',
  phone: '電話タップ（最新）',
  notFound: '404（最新）',
  inquiries: '問い合わせ記録',
  reports: 'レポート',
};

const KPI_HEADERS = [
  '実行日', '種別', '期間開始', '期間終了',
  '検索 表示回数', '検索 クリック', '検索 CTR', '検索 平均掲載順位',
  'セッション', 'エンゲージのあったセッション', '電話タップ', '問い合わせ記録 件数',
];

const INQUIRY_HEADERS = ['日付', '種別（電話／見学／契約）', 'きっかけ（ホームページ／紹介／看板／不明 など）', 'メモ（氏名・電話番号は書かない）'];

/** 検索語句のまとまり。1つの語句が複数に入ることがある。 */
const QUERY_GROUPS = [
  ['指名（平成院・青松山）', /平成院|へいせいいん|青松山/],
  ['植樹葬', /植樹葬/],
  ['樹木葬', /樹木葬|樹林葬/],
  ['永代供養', /永代供養/],
  ['地名（岩手・洋野・八戸など）', /岩手|洋野|八戸|久慈|二戸|盛岡|青森|東北|大野/],
];

// ------------------------------------------------------------------ 実行の入口

/** 週次レポート（トリガーから毎週月曜に実行）。 */
function runWeekly() {
  run_('週次', weeklyPeriods_(new Date()), { send: true });
}

/** 月次レポート（トリガーから毎月5日に実行）。前月分を集計する。 */
function runMonthly() {
  run_('月次', monthlyPeriods_(new Date()), { send: true });
}

/** 試し実行：シートには書くが、メールは送らない。結果は「実行ログ」で確認する。 */
function previewWeekly() {
  run_('週次', weeklyPeriods_(new Date()), { send: false });
}

/** 初回だけ実行：シートを用意し、週次・月次のトリガーを登録する。 */
function setup() {
  sheet_(SHEETS.kpi, KPI_HEADERS);
  sheet_(SHEETS.inquiries, INQUIRY_HEADERS);
  sheet_(SHEETS.reports, ['実行日時', '種別', '期間', 'レポート本文']);

  ScriptApp.getProjectTriggers().forEach((t) => {
    if (['runWeekly', 'runMonthly'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runWeekly').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(8).create();
  ScriptApp.newTrigger('runMonthly').timeBased().onMonthDay(5).atHour(8).create();
  Logger.log('シートとトリガーを用意しました（週次：毎週月曜 8時台／月次：毎月5日 8時台）。');
}

/** 接続の確認：Search Console・GA4・Claude API に、それぞれ小さな問い合わせを送る。 */
function checkConnections() {
  const cfg = config_();
  const range = weeklyPeriods_(new Date()).cur;
  try {
    const t = gscTotals_(cfg, range);
    Logger.log('Search Console：OK（直近7日の表示回数 ' + t.impressions + '）');
  } catch (e) {
    Logger.log('Search Console：失敗 … ' + e.message);
  }
  if (cfg.ga4Property) {
    try {
      const rows = ga4Report_(cfg, range, [], ['sessions']);
      Logger.log('GA4：OK（直近7日のセッション ' + (rows[0] ? rows[0].vals[0] : 0) + '）');
    } catch (e) {
      Logger.log('GA4：失敗 … ' + e.message);
    }
  } else {
    Logger.log('GA4：未設定（GA4_PROPERTY_ID が空のため、GA4 は集計しません）');
  }
  if (cfg.apiKey) {
    try {
      callClaude_(cfg, 'あなたは接続確認の相手です。', '「接続できました」とだけ返してください。', 'low');
      Logger.log('Claude API：OK');
    } catch (e) {
      Logger.log('Claude API：失敗 … ' + e.message);
    }
  } else {
    Logger.log('Claude API：未設定（ANTHROPIC_API_KEY が空のため、数値だけのレポートになります）');
  }
}

// ------------------------------------------------------------------ 本体

function run_(kind, periods, opts) {
  const cfg = config_();
  try {
    const data = collect_(cfg, kind, periods);
    const numbers = numbersText_(data);

    let analysis = '';
    if (cfg.apiKey) {
      try {
        analysis = callClaude_(cfg, systemPrompt_(kind), analysisInput_(data), kind === '月次' ? 'medium' : 'low');
      } catch (e) {
        analysis = '（AI による所見の作成に失敗しました：' + e.message + '）\n上の数値はそのままご覧いただけます。';
      }
    } else {
      analysis = '（Claude API キーが未設定のため、数値のみのレポートです）';
    }

    const body = numbers + '\n\n' + analysis + '\n\n― 詳しい数値：' + SpreadsheetApp.getActiveSpreadsheet().getUrl();
    writeSheets_(data, body);
    if (opts.send) sendMail_(cfg, '【平成院サイト】' + kind + 'レポート ' + periodLabel_(periods.cur), body);
    Logger.log(body);
  } catch (e) {
    // データ取得そのものに失敗したとき。原因を知らせるだけで、秘密情報は含めない。
    const msg = kind + 'レポートの作成に失敗しました。\n\n' + e.message;
    if (opts.send) sendMail_(cfg, '【平成院サイト】' + kind + 'レポート 作成エラー', msg);
    throw e;
  }
}

function collect_(cfg, kind, periods) {
  const data = { kind: kind, periods: periods, ga4Enabled: !!cfg.ga4Property };

  // Search Console
  data.gsc = {
    cur: gscTotals_(cfg, periods.cur),
    prev: gscTotals_(cfg, periods.prev),
    yoy: periods.yoy ? gscTotals_(cfg, periods.yoy) : null,
  };
  const queryRows = gscQuery_(cfg, periods.cur, ['query'], 1000);
  const prevQueryRows = gscQuery_(cfg, periods.prev, ['query'], 1000);
  data.gsc.topQueries = queryRows.slice(0, 30).map(gscRow_);
  data.gsc.groups = queryGroups_(queryRows, prevQueryRows);
  data.gsc.topPages = gscQuery_(cfg, periods.cur, ['page'], 20).map(gscRow_);
  data.gsc.devices = gscQuery_(cfg, periods.cur, ['device'], 10).map(gscRow_);

  // GA4（測定IDとプロパティIDが設定されてから）
  if (cfg.ga4Property) {
    data.ga4 = {
      cur: ga4Totals_(cfg, periods.cur),
      prev: ga4Totals_(cfg, periods.prev),
      channels: ga4Report_(cfg, periods.cur, ['sessionDefaultChannelGroup'], ['sessions', 'engagedSessions'], null, 10),
      landing: ga4Report_(cfg, periods.cur, ['landingPage'], ['sessions', 'engagedSessions'], null, 15),
      phone: ga4PhoneClicks_(cfg, periods.cur),
      phonePrev: ga4PhoneClicks_(cfg, periods.prev),
      notFound: ga4NotFound_(cfg, periods.cur),
    };
  }

  // 事務局の手入力（件数だけを使う）
  data.inquiries = readInquiries_(periods.cur);
  data.inquiriesPrev = readInquiries_(periods.prev);
  return data;
}

// ------------------------------------------------------------------ 期間

function fmt_(d) {
  return Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
}

function addDays_(d, n) {
  const x = new Date(d.getTime());
  x.setDate(x.getDate() + n);
  return x;
}

function weeklyPeriods_(today) {
  const end = addDays_(today, -GSC_LAG_DAYS);
  const start = addDays_(end, -6);
  return {
    cur: { start: fmt_(start), end: fmt_(end) },
    prev: { start: fmt_(addDays_(start, -7)), end: fmt_(addDays_(start, -1)) },
  };
}

function monthlyPeriods_(today) {
  const y = today.getFullYear();
  const m = today.getMonth();
  return {
    cur: { start: fmt_(new Date(y, m - 1, 1)), end: fmt_(new Date(y, m, 0)) },
    prev: { start: fmt_(new Date(y, m - 2, 1)), end: fmt_(new Date(y, m - 1, 0)) },
    // Search Console は16か月分残るため、前年同月とも比べる
    yoy: { start: fmt_(new Date(y - 1, m - 1, 1)), end: fmt_(new Date(y - 1, m, 0)) },
  };
}

function periodLabel_(r) {
  return r.start + '〜' + r.end;
}

// ------------------------------------------------------------------ 設定

function config_() {
  const p = PropertiesService.getScriptProperties();
  const get = (k, d) => String(p.getProperty(k) || d || '').trim();
  return {
    gscSite: get('GSC_SITE_URL', 'sc-domain:shokuju-reien.jp'),
    ga4Property: get('GA4_PROPERTY_ID').replace(/^properties\//, ''),
    apiKey: get('ANTHROPIC_API_KEY'),
    model: get('CLAUDE_MODEL', 'claude-opus-5-5'),
    email: get('REPORT_EMAIL'),
  };
}

// ------------------------------------------------------------------ Google API

function googleApi_(url, body) {
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(body),
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code >= 300) throw new Error(url.replace(/\?.*$/, '') + ' → ' + code + '：' + text.slice(0, 400));
  return JSON.parse(text);
}

function gscQuery_(cfg, range, dimensions, rowLimit) {
  const url =
    'https://searchconsole.googleapis.com/webmasters/v3/sites/' +
    encodeURIComponent(cfg.gscSite) +
    '/searchAnalytics/query';
  const res = googleApi_(url, {
    startDate: range.start,
    endDate: range.end,
    dimensions: dimensions,
    rowLimit: rowLimit,
  });
  return res.rows || [];
}

function gscTotals_(cfg, range) {
  const row = gscQuery_(cfg, range, [], 1)[0];
  return row
    ? { clicks: row.clicks, impressions: row.impressions, ctr: row.ctr, position: row.position }
    : { clicks: 0, impressions: 0, ctr: 0, position: null };
}

function gscRow_(r) {
  return {
    key: r.keys[0],
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: round_(r.ctr * 100, 1),
    position: round_(r.position, 1),
  };
}

function queryGroups_(rows, prevRows) {
  const sum = (list, re) =>
    list.reduce(
      (acc, r) => (re.test(r.keys[0]) ? { clicks: acc.clicks + r.clicks, impressions: acc.impressions + r.impressions } : acc),
      { clicks: 0, impressions: 0 }
    );
  return QUERY_GROUPS.map(([name, re]) => ({ name: name, cur: sum(rows, re), prev: sum(prevRows, re) }));
}

function ga4Report_(cfg, range, dimensions, metrics, filter, limit) {
  const body = {
    dateRanges: [{ startDate: range.start, endDate: range.end }],
    dimensions: dimensions.map((n) => ({ name: n })),
    metrics: metrics.map((n) => ({ name: n })),
    limit: limit || 50,
  };
  if (filter) body.dimensionFilter = filter;
  const res = googleApi_('https://analyticsdata.googleapis.com/v1beta/properties/' + cfg.ga4Property + ':runReport', body);
  return (res.rows || []).map((r) => ({
    dims: (r.dimensionValues || []).map((v) => v.value),
    vals: (r.metricValues || []).map((v) => Number(v.value)),
  }));
}

function ga4Totals_(cfg, range) {
  const row = ga4Report_(cfg, range, [], ['sessions', 'engagedSessions', 'activeUsers'])[0];
  return row ? { sessions: row.vals[0], engaged: row.vals[1], users: row.vals[2] } : { sessions: 0, engaged: 0, users: 0 };
}

const PHONE_FILTER = { filter: { fieldName: 'eventName', stringFilter: { value: 'phone_click' } } };

/**
 * 電話タップ。回線・位置の内訳は、GA4 でカスタム ディメンション（phone_line / link_location）を
 * 登録してから取れるようになる。未登録のあいだは合計だけを返す。
 */
function ga4PhoneClicks_(cfg, range) {
  let total = 0;
  let breakdown = [];
  ga4Report_(cfg, range, ['eventName'], ['eventCount'], PHONE_FILTER).forEach((r) => (total += r.vals[0]));
  try {
    breakdown = ga4Report_(
      cfg,
      range,
      ['customEvent:phone_line', 'customEvent:link_location'],
      ['eventCount'],
      PHONE_FILTER,
      20
    ).map((r) => ({ line: r.dims[0], place: r.dims[1], count: r.vals[0] }));
  } catch (e) {
    breakdown = null; // カスタム ディメンション未登録
  }
  return { total: total, breakdown: breakdown };
}

/** 404ページが表示されたURL（旧サイトのURLや、リンク切れの手がかり）。 */
function ga4NotFound_(cfg, range) {
  const filter = { filter: { fieldName: 'pageTitle', stringFilter: { matchType: 'BEGINS_WITH', value: 'ページが見つかりません' } } };
  return ga4Report_(cfg, range, ['pagePath'], ['screenPageViews'], filter, 30).map((r) => ({ path: r.dims[0], views: r.vals[0] }));
}

// ------------------------------------------------------------------ 問い合わせ記録（手入力）

function readInquiries_(range) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.inquiries);
  if (!sh || sh.getLastRow() < 2) return null;
  const result = { total: 0, byKind: {}, bySource: {} };
  sh.getRange(2, 1, sh.getLastRow() - 1, 3)
    .getValues()
    .forEach((row) => {
      const date = row[0];
      if (!(date instanceof Date)) return;
      const day = fmt_(date);
      if (day < range.start || day > range.end) return;
      const kind = String(row[1] || '未記入').trim();
      const source = String(row[2] || '未記入').trim();
      result.total++;
      result.byKind[kind] = (result.byKind[kind] || 0) + 1;
      result.bySource[source] = (result.bySource[source] || 0) + 1;
    });
  return result;
}

// ------------------------------------------------------------------ 数値の文章化

function round_(n, digits) {
  if (n === null || n === undefined || isNaN(n)) return null;
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

function change_(cur, prev) {
  if (!prev) return '前期間 0';
  const pct = Math.round(((cur - prev) / prev) * 100);
  return '前期間 ' + prev + '、' + (pct >= 0 ? '+' : '') + pct + '%';
}

function small_(n) {
  return n < SMALL_COUNT ? '　※件数が少ないため参考値' : '';
}

function numbersText_(d) {
  const g = d.gsc;
  const lines = [];
  lines.push('■ ' + d.kind + 'レポート　' + periodLabel_(d.periods.cur) + '（前期間 ' + periodLabel_(d.periods.prev) + '）');
  lines.push('');
  lines.push('［Google 検索］');
  lines.push('　表示回数 ' + g.cur.impressions + '（' + change_(g.cur.impressions, g.prev.impressions) + '）');
  lines.push('　クリック ' + g.cur.clicks + '（' + change_(g.cur.clicks, g.prev.clicks) + '）' + small_(g.cur.clicks));
  lines.push('　クリック率 ' + round_(g.cur.ctr * 100, 1) + '%　平均掲載順位 ' + (round_(g.cur.position, 1) || '－'));
  if (g.yoy) lines.push('　前年同月：表示回数 ' + g.yoy.impressions + '、クリック ' + g.yoy.clicks);

  lines.push('');
  lines.push('［検索語句のまとまり（表示回数／クリック）］');
  g.groups.forEach((x) => {
    lines.push('　' + x.name + '：' + x.cur.impressions + '／' + x.cur.clicks + '（前期間 ' + x.prev.impressions + '／' + x.prev.clicks + '）');
  });

  lines.push('');
  if (d.ga4) {
    const a = d.ga4;
    lines.push('［サイト訪問（GA4）］');
    lines.push('　セッション ' + a.cur.sessions + '（' + change_(a.cur.sessions, a.prev.sessions) + '）' + small_(a.cur.sessions));
    lines.push('　電話タップ ' + a.phone.total + '（' + change_(a.phone.total, a.phonePrev.total) + '）' + small_(a.phone.total));
    lines.push('　※電話タップは「電話番号を押した回数」です。電話がつながった件数ではありません。');
  } else {
    lines.push('［サイト訪問（GA4）］まだ計測していません');
  }

  if (d.inquiries) {
    lines.push('');
    lines.push('［問い合わせ記録（事務局の記入）］');
    lines.push('　合計 ' + d.inquiries.total + ' 件　' + Object.keys(d.inquiries.byKind).map((k) => k + ' ' + d.inquiries.byKind[k]).join('、'));
  }
  return lines.join('\n');
}

// ------------------------------------------------------------------ Claude API

function systemPrompt_(kind) {
  const length = kind === '月次' ? '1500字' : '800字';
  const sections =
    kind === '月次'
      ? '■ 要約（3行以内）\n■ 主な数字の変化（前月・前年同月との比較）\n■ 検索の動き\n■ ページと電話タップ\n■ 問い合わせ記録との照らし合わせ\n■ 改善の提案（最大3件）\n■ 来月に見ること'
      : '■ 要約（3行以内）\n■ 主な数字の変化\n■ 検索の動き\n■ ページと電話タップ\n■ 改善の提案（最大3件）\n■ 来週に見ること';

  return [
    'あなたは、岩手県九戸郡洋野町にある「青松山 平成院 植樹葬霊園」公式サイトのアクセス解析担当です。',
    '渡された集計データだけをもとに、霊園の担当者に向けた' + kind + 'レポートを日本語で書きます。',
    '',
    '# サイトについて',
    '- サイトの目的は、現地に来てもらうことです。第一の目標は霊園事務局への電話、第二の目標は見学のご相談です。',
    '- サイトに問い合わせフォームはなく、問い合わせはすべて電話です。',
    '- 主な読者は、50〜80代のご本人と、40〜50代のご家族です。',
    '- 平成院では、生前にご自身で墓標となる花木を選んで苗木を植え、没後はその木のもとに埋蔵される樹木葬を「植樹葬」と呼んでいます。一般の人は「樹木葬」という言葉で検索することが多いです。',
    '',
    '# 守ること',
    '- 数字は、データにあるものだけを使ってください。データにない数字や原因を、事実として書かないでください。推測を書くときは「考えられる理由」として分けてください。',
    '- 料金・制度・アクセス・駐車場・見学予約など、データにない霊園の事実を前提にした提案には、必ず「（要確認）」と付けてください。',
    '- 他の霊園や、一般的な樹木葬との比較を書かないでください。',
    '- 「継承者不要」のような断定表現や、確認されていない表現をサイトに書くよう提案しないでください。',
    '- 件数が少ないとき（目安：クリック・セッション・電話タップがそれぞれ' + SMALL_COUNT + '件未満）は、増減を断定せず「件数が少ないため判断保留」と書いてください。',
    '- 電話タップ（phone_click）は「電話番号を押した回数」で、電話がつながった件数ではありません。',
    '- データに GA4 がない場合は、Google 検索の数値だけで書いてください。',
    '',
    '# 書き方',
    '- 読み手はウェブの専門家ではありません。専門用語は避けるか、短く言い換えてください。',
    '- メールの本文として読まれます。マークダウンの表や「#」の見出しは使わず、見出しは次の「■」の形にしてください。',
    '- 全体で' + length + '程度にしてください。',
    '- 改善の提案には、それぞれ「根拠となる数字」と「期待する効果」を書いてください。',
    '',
    '# 見出し',
    sections,
  ].join('\n');
}

/** Claude に渡すのは集計済みの数値だけ（個人情報は含まない）。 */
function analysisInput_(d) {
  const input = {
    種別: d.kind,
    期間: d.periods,
    google検索: d.gsc,
    ga4: d.ga4 || '未計測',
    問い合わせ記録: d.inquiries || '記入なし',
    問い合わせ記録_前期間: d.inquiriesPrev || '記入なし',
  };
  return '次のデータをもとにレポートを書いてください。\n\n' + JSON.stringify(input, null, 1);
}

function callClaude_(cfg, system, userText, effort) {
  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2026-10-21',
      // 安全上の理由で断られたとき、サーバー側で別のモデルに切り替えて続ける
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    },
    payload: JSON.stringify({
      model: cfg.model,
      max_tokens: 16000,
      system: system,
      output_config: { effort: effort },
      fallbacks: 'default',
      messages: [{ role: 'user', content: userText }],
    }),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code >= 300) throw new Error('Claude API ' + code + '：' + text.slice(0, 300));
  const msg = JSON.parse(text);
  if (msg.stop_reason === 'refusal') throw new Error('Claude API が回答を控えました');
  const out = (msg.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  if (!out) throw new Error('Claude API の応答に本文がありません（stop_reason: ' + msg.stop_reason + '）');
  return out;
}

// ------------------------------------------------------------------ シート・メール

function sheet_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    if (headers) {
      sh.appendRow(headers);
      sh.setFrozenRows(1);
    }
  }
  return sh;
}

function replaceSheet_(name, headers, rows) {
  const sh = sheet_(name);
  sh.clearContents();
  const data = [headers].concat(rows);
  sh.getRange(1, 1, data.length, headers.length).setValues(data);
  sh.setFrozenRows(1);
}

function writeSheets_(d, body) {
  const now = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm');
  const label = '（' + d.kind + ' ' + periodLabel_(d.periods.cur) + '）';

  sheet_(SHEETS.kpi, KPI_HEADERS).appendRow([
    now, d.kind, d.periods.cur.start, d.periods.cur.end,
    d.gsc.cur.impressions, d.gsc.cur.clicks, round_(d.gsc.cur.ctr * 100, 2), round_(d.gsc.cur.position, 1),
    d.ga4 ? d.ga4.cur.sessions : '', d.ga4 ? d.ga4.cur.engaged : '', d.ga4 ? d.ga4.phone.total : '',
    d.inquiries ? d.inquiries.total : '',
  ]);

  const gscHeaders = ['項目' + label, 'クリック', '表示回数', 'CTR（%）', '平均掲載順位'];
  const gscRows = (list) => list.map((r) => [r.key, r.clicks, r.impressions, r.ctr, r.position]);
  replaceSheet_(SHEETS.queries, gscHeaders, gscRows(d.gsc.topQueries));
  replaceSheet_(SHEETS.pages, gscHeaders, gscRows(d.gsc.topPages));

  if (d.ga4) {
    replaceSheet_(SHEETS.channels, ['流入元' + label, 'セッション', 'エンゲージのあったセッション'], d.ga4.channels.map((r) => [r.dims[0], r.vals[0], r.vals[1]]));
    replaceSheet_(
      SHEETS.phone,
      ['回線' + label, '位置', 'タップ数'],
      d.ga4.phone.breakdown ? d.ga4.phone.breakdown.map((r) => [r.line, r.place, r.count]) : [['（内訳はカスタム ディメンション登録後）', '', d.ga4.phone.total]]
    );
    replaceSheet_(SHEETS.notFound, ['404になったURL' + label, '表示回数'], d.ga4.notFound.map((r) => [r.path, r.views]));
  }

  sheet_(SHEETS.reports, ['実行日時', '種別', '期間', 'レポート本文']).appendRow([now, d.kind, periodLabel_(d.periods.cur), body]);
}

function sendMail_(cfg, subject, body) {
  if (!cfg.email) {
    Logger.log('REPORT_EMAIL が未設定のため、メールは送りませんでした。');
    return;
  }
  MailApp.sendEmail(cfg.email, subject, body);
}
