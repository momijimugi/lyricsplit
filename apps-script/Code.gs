/**
 * LYRICLAB — Apps Script バックエンド
 *
 * 役割は2つ。SPLITAPP と同じ運用方針で、1つのウェブアプリにまとめてある。
 *   1. スプレッドシートをデータベースにした案件の同期（pull / push / deleteProject）
 *   2. Gemini へのプロキシ（generate）
 *      プロンプトはブラウザ側（app.js）が組み立てて送るので、
 *      判定ロジックを変えるときにここを触る必要はない。
 *
 * 導入手順:
 *   1. 新しいスプレッドシートを作り、URLの /d/ と /edit の間のIDを控える
 *   2. 新しい Apps Script プロジェクトにこのファイルを貼る
 *   3. プロジェクトの設定 > スクリプト プロパティ に次を登録
 *        SHEET_ID       … 上で控えたスプレッドシートID
 *        API_KEY        … アプリの「接続キー」に入れる任意の文字列
 *        GEMINI_API_KEY … AI分析を使う場合のみ（Google AI Studio のキー）
 *        GEMINI_MODEL   … 省略可（既定 gemini-3.1-flash-lite）
 *   4. エディタから setupDatabase を1回実行してシートを作成
 *   5. デプロイ > 新しいデプロイ > ウェブアプリ
 *        実行ユーザー: 自分 / アクセスできるユーザー: 全員
 *   6. /exec で終わるURLと API_KEY をアプリの「接続設定（AI・同期）」に入力
 *
 * 案件データは入れ子が深いので、列に展開せず dataJson へJSONのまま格納する。
 * 一覧や差分判定に使う id / title / updatedAt だけを列として持たせている。
 */

var SHEET_NAME = 'Projects';
// chunk / chunks は dataJson の分割用。1セルは5万文字までなので、
// 長くなった案件は複数行に分けて保存する（詳細は splitJson_ のコメント）。
var PROJECT_HEADERS = ['id', 'title', 'updatedAt', 'deleted', 'dataJson', 'chunk', 'chunks'];
var LEGACY_HEADERS = ['id', 'title', 'updatedAt', 'deleted', 'dataJson'];
// セル上限5万文字に対する安全側の分割幅。
var CHUNK_CHARS = 40000;
var MAX_PROJECT_CHARS = 4000000;
var DEFAULT_MODEL = 'gemini-3.1-flash-lite';
var MAX_PROMPT_CHARS = 60000;
var MAX_PUSH_PROJECTS = 200;

/** 初回に一度だけ手動実行する。 */
function setupDatabase() {
  var sheet = ensureSheet_(getSpreadsheet_(), SHEET_NAME, PROJECT_HEADERS);
  return 'LYRICLAB database is ready: ' + sheet.getName();
}

function doGet() {
  return json_({ ok: true, service: 'LYRICLAB API', version: 2 });
}

function doPost(event) {
  try {
    var params = (event && event.parameter) || {};
    authorize_(params.apiKey || '');
    var payload = JSON.parse(params.payload || 'null');

    if (params.action === 'pull') return json_({ ok: true, projects: pullProjects_() });
    if (params.action === 'push') return json_({ ok: true, saved: pushProjects_(payload) });
    if (params.action === 'deleteProject') return json_({ ok: true, deleted: deleteProject_(payload) });
    if (params.action === 'generate') return json_({ ok: true, text: generate_(payload) });

    throw new Error('Unsupported action: ' + params.action);
  } catch (error) {
    return json_({ ok: false, error: String((error && error.message) || error) });
  }
}

function authorize_(key) {
  var expected = PropertiesService.getScriptProperties().getProperty('API_KEY');
  if (!expected) throw new Error('API_KEY is not configured.');
  if (key !== expected) throw new Error('接続キーが違います。');
}

/* ----------------------------------------------------------------- Sheets */

function getSpreadsheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('SHEET_ID is not configured.');
  return SpreadsheetApp.openById(id);
}

/**
 * シートを用意する。
 * 旧5列（chunk / chunks なし）のシートは、見出しを足すだけで移行できる。
 * 既存行は chunk が空になるが、読み出し側で「1枚もの」として扱う。
 */
function ensureSheet_(spreadsheet, name, headers) {
  var sheet = spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
  if (sheet.getMaxColumns() < headers.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
  }
  var first = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  var needsHeader = false;
  for (var i = 0; i < headers.length; i++) {
    if (String(first[i]) !== headers[i]) { needsHeader = true; break; }
  }
  if (needsHeader) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * スプレッドシートの1セルは5万文字まで。案件データは歌詞・提案・コメントに
 * 加えて作業ログを全部持つので、少し使い込むとすぐに超える（ログ200件強で到達）。
 * そこで dataJson を CHUNK_CHARS ごとに切り、同じ id の行を複数並べて保存する。
 * 行の並び順には依存せず、chunk 列の番号で組み立て直す。
 */
function splitJson_(text) {
  var parts = [];
  for (var i = 0; i < text.length; i += CHUNK_CHARS) {
    parts.push(text.slice(i, i + CHUNK_CHARS));
  }
  return parts.length ? parts : [''];
}

function projectSheet_() {
  return ensureSheet_(getSpreadsheet_(), SHEET_NAME, PROJECT_HEADERS);
}

function pullProjects_() {
  var sheet = projectSheet_();
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var rows = sheet.getRange(2, 1, last - 1, PROJECT_HEADERS.length).getValues();

  // 同じ id の行を集めてから、chunk の番号順に連結して1つのJSONに戻す。
  var byId = {};
  var order = [];
  rows.forEach(function (row) {
    var id = String(row[0] || '');
    if (!id) return;
    if (row[3] === true || String(row[3]) === 'TRUE') return; // 削除済みは返さない
    if (!byId[id]) { byId[id] = []; order.push(id); }
    var chunk = Number(row[5]);
    byId[id].push({ chunk: isFinite(chunk) ? chunk : 0, text: String(row[4] || '') });
  });

  var out = [];
  order.forEach(function (id) {
    var parts = byId[id].sort(function (a, b) { return a.chunk - b.chunk; });
    var text = parts.map(function (p) { return p.text; }).join('');
    try {
      var project = JSON.parse(text);
      if (project && project.id) out.push(project);
    } catch (e) {
      // 壊れた／欠けた行は無視して同期自体は続行する
    }
  });
  return out;
}

function pushProjects_(projects) {
  if (!Array.isArray(projects)) throw new Error('Payload must be an array of projects.');
  if (!projects.length) return 0;
  if (projects.length > MAX_PUSH_PROJECTS) throw new Error('一度に送れる案件は' + MAX_PUSH_PROJECTS + '件までです。');

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sheet = projectSheet_();
    var width = PROJECT_HEADERS.length;
    var last = sheet.getLastRow();
    var existing = last < 2 ? [] : sheet.getRange(2, 1, last - 1, width).getValues();

    // 案件ごとの行数が変わりうるので、対象idの行はいったん全部落としてから書き直す。
    var targets = {};
    var rows = [];
    projects.forEach(function (project) {
      if (!project || !project.id) return;
      var id = String(project.id);
      var text = JSON.stringify(project);
      if (text.length > MAX_PROJECT_CHARS) {
        throw new Error('案件「' + String(project.title || id) + '」のデータが大きすぎます（' +
          text.length + '文字）。');
      }
      targets[id] = true;
      var parts = splitJson_(text);
      parts.forEach(function (part, index) {
        rows.push([
          id,
          index === 0 ? String(project.title || '') : '',
          index === 0 ? String(project.updatedAt || '') : '',
          false,
          part,
          index,
          parts.length
        ]);
      });
    });
    if (!rows.length) return 0;

    // 対象id以外の行はそのまま残す。書き戻しは1回にまとめる。
    var kept = existing.filter(function (row) {
      var id = String(row[0] || '');
      return id && !targets[id];
    });
    var next = kept.concat(rows);

    if (existing.length) sheet.getRange(2, 1, existing.length, width).clearContent();
    if (next.length > sheet.getMaxRows() - 1) {
      sheet.insertRowsAfter(sheet.getMaxRows(), next.length + 1 - sheet.getMaxRows());
    }
    sheet.getRange(2, 1, next.length, width).setValues(next);
    return projects.length;
  } finally {
    lock.releaseLock();
  }
}

/** 行は消さず deleted フラグを立てる（誤操作からの復旧用）。分割された行はすべて立てる。 */
function deleteProject_(payload) {
  var id = payload && String(payload.id || '');
  if (!id) throw new Error('削除する案件IDがありません。');
  var sheet = projectSheet_();
  var last = sheet.getLastRow();
  if (last < 2) return false;
  var ids = sheet.getRange(2, 1, last - 1, 1).getValues();
  var hit = false;
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) !== id) continue;
    sheet.getRange(i + 2, 4).setValue(true);
    hit = true;
  }
  return hit;
}

/* ----------------------------------------------------------------- Gemini */

function generate_(payload) {
  var prompt = payload && String(payload.prompt || '');
  if (!prompt) throw new Error('プロンプトが空です。');
  if (prompt.length > MAX_PROMPT_CHARS) throw new Error('プロンプトが長すぎます（' + MAX_PROMPT_CHARS + '文字まで）。');

  var properties = PropertiesService.getScriptProperties();
  var geminiKey = properties.getProperty('GEMINI_API_KEY');
  if (!geminiKey) throw new Error('GEMINI_API_KEY is not configured.');
  var model = String(payload.model || properties.getProperty('GEMINI_MODEL') || DEFAULT_MODEL);
  var temperature = Number(payload.temperature);
  if (!isFinite(temperature) || temperature < 0 || temperature > 1) temperature = 0.15;

  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(model) + ':generateContent';
  var response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': geminiKey },
    payload: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: temperature, responseMimeType: 'application/json' }
    }),
    muteHttpExceptions: true
  });

  var status = response.getResponseCode();
  var body = response.getContentText();
  if (status < 200 || status >= 300) throw new Error('Gemini API error ' + status + ': ' + body.slice(0, 300));

  var parsed = JSON.parse(body);
  var text = parsed.candidates && parsed.candidates[0] &&
    parsed.candidates[0].content && parsed.candidates[0].content.parts[0].text;
  if (!text) throw new Error('Gemini API returned no content.');
  return text;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
