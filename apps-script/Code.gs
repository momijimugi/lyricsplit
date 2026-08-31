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
var PROJECT_HEADERS = ['id', 'title', 'updatedAt', 'deleted', 'dataJson'];
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

function ensureSheet_(spreadsheet, name, headers) {
  var sheet = spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
  var first = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  if (String(first[0]) !== headers[0]) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function projectSheet_() {
  return ensureSheet_(getSpreadsheet_(), SHEET_NAME, PROJECT_HEADERS);
}

function pullProjects_() {
  var sheet = projectSheet_();
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var rows = sheet.getRange(2, 1, last - 1, PROJECT_HEADERS.length).getValues();
  var out = [];
  rows.forEach(function (row) {
    if (!row[0] || row[3] === true || String(row[3]) === 'TRUE') return; // 削除済みは返さない
    try {
      var project = JSON.parse(row[4]);
      if (project && project.id) out.push(project);
    } catch (e) {
      // 壊れた行は無視して同期自体は続行する
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
    var last = sheet.getLastRow();
    var ids = last < 2 ? [] : sheet.getRange(2, 1, last - 1, 1).getValues().map(function (r) { return String(r[0]); });

    var appended = [];
    projects.forEach(function (project) {
      if (!project || !project.id) return;
      var row = [
        String(project.id),
        String(project.title || ''),
        String(project.updatedAt || ''),
        false,
        JSON.stringify(project)
      ];
      var index = ids.indexOf(String(project.id));
      if (index >= 0) sheet.getRange(index + 2, 1, 1, PROJECT_HEADERS.length).setValues([row]);
      else { appended.push(row); ids.push(String(project.id)); }
    });
    if (appended.length) {
      sheet.getRange(sheet.getLastRow() + 1, 1, appended.length, PROJECT_HEADERS.length).setValues(appended);
    }
    return projects.length;
  } finally {
    lock.releaseLock();
  }
}

/** 行は消さず deleted フラグを立てる（誤操作からの復旧用）。 */
function deleteProject_(payload) {
  var id = payload && String(payload.id || '');
  if (!id) throw new Error('削除する案件IDがありません。');
  var sheet = projectSheet_();
  var last = sheet.getLastRow();
  if (last < 2) return false;
  var ids = sheet.getRange(2, 1, last - 1, 1).getValues().map(function (r) { return String(r[0]); });
  var index = ids.indexOf(id);
  if (index < 0) return false;
  sheet.getRange(index + 2, 4).setValue(true);
  return true;
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
