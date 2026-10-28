/**
 * byUs 각색 기획안 Builder — Back-end (Google Apps Script)
 *
 * 역할
 *  1. Vercel 동기화 (운영 경로)
 *     - syncWithVercel() : 1분마다 시간 트리거로 실행. 시트 전체 행을 Vercel /api/sync 로 보내고,
 *                          Vercel(Upstash Redis)에만 있는 신규 가입자를 시트에 추가합니다.
 *     - installSyncTrigger() : 트리거 설치 (편집기에서 한 번 실행)
 *     - 스크립트 속성(프로젝트 설정 → 스크립트 속성)에 VERCEL_SYNC_URL, SYNC_SECRET 필요
 *  2. 웹 앱 (백업 경로, 회사 계정 사용자 전용)
 *     - doGet / api() / doPost : Index.html 서빙 + 가입/로그인 API
 *
 * 시트 컬럼 (1행 헤더)
 *  A: name | B: ID | C: password | D: permission | E: activate
 *  - activate 는 관리자가 TRUE 로 바꾸는 순간부터 사이트 권한이 부여됩니다. (Vercel 사이트는 최대 1분 내 반영)
 */

// ───────────────────────────── Vercel 동기화 ─────────────────────────────

var SYNC_INTERVAL_MINUTES = 1;

/** 시간 트리거가 호출. 편집기에서 직접 실행해도 됩니다. */
function syncWithVercel() {
  var props = PropertiesService.getScriptProperties();
  var url = str(props.getProperty('VERCEL_SYNC_URL'));
  var secret = str(props.getProperty('SYNC_SECRET'));
  if (!url || !secret) {
    throw new Error('스크립트 속성 VERCEL_SYNC_URL, SYNC_SECRET 을 먼저 설정하세요. (프로젝트 설정 → 스크립트 속성)');
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return; // 이전 동기화가 아직 실행 중
  try {
    var sheet = getSheet();
    var last = sheet.getLastRow();
    var rows = [];
    if (last >= 2) {
      sheet.getRange(2, 1, last - 1, HEADERS.length).getValues().forEach(function (r) {
        if (!str(r[1])) return; // ID 없는 빈 행 제외
        rows.push({ name: str(r[0]), id: str(r[1]), password: str(r[2]), permission: str(r[3]), activate: isTrue(r[4]) });
      });
    }

    var res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-sync-secret': secret },
      payload: JSON.stringify({ rows: rows }),
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    var body;
    try { body = JSON.parse(res.getContentText()); } catch (e) { body = null; }
    if (code !== 200 || !body || !body.ok) {
      throw new Error('동기화 실패 (HTTP ' + code + '): ' + (body && body.error ? body.error : res.getContentText().slice(0, 200)));
    }

    var append = body.data.append || [];
    if (append.length) {
      var values = append.map(function (u) { return [u.name, u.id, u.password, u.permission, '']; });
      sheet.getRange(sheet.getLastRow() + 1, 1, values.length, HEADERS.length).setValues(values);
    }
    Logger.log('sync ok: 시트 ' + rows.length + '행, 신규 추가 ' + append.length + '명, 가져옴 ' + (body.data.imported || 0) + ', 제거 ' + (body.data.removed || 0));
  } finally {
    lock.releaseLock();
  }
}

/** 편집기에서 한 번 실행: 기존 트리거를 정리하고 1분 주기 트리거를 설치합니다. */
function installSyncTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncWithVercel') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncWithVercel').timeBased().everyMinutes(SYNC_INTERVAL_MINUTES).create();
  Logger.log('트리거 설치 완료: syncWithVercel 매 ' + SYNC_INTERVAL_MINUTES + '분');
}

/** 트리거 제거 (동기화 중단) */
function removeSyncTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncWithVercel') ScriptApp.deleteTrigger(t);
  });
  Logger.log('트리거 제거 완료');
}

var SPREADSHEET_ID = '1bkeTv7isOVdy3TDpa7kkM2L2GDhJO73NaLdKwvXlw64';
var SHEET_NAME = '시트1';
var HEADERS = ['name', 'ID', 'password', 'permission', 'activate'];
var PERMISSIONS = ['Admin', 'Editor', 'Viewer'];

/**
 * true 로 바꾸면 비밀번호를 SHA-256 해시로 저장합니다.
 * (기본값 false: 요구사항대로 입력값을 그대로 password 컬럼에 기록)
 * 해시로 전환하면 이미 평문으로 저장된 행은 로그인할 수 없으니 함께 갱신해야 합니다.
 */
var HASH_PASSWORDS = false;

// ───────────────────────────── Web App 엔트리 ─────────────────────────────

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('byUs 각색 기획안 Builder')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(e) {
  var result;
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    result = api(body.action, body.payload);
  } catch (err) {
    result = fail('요청을 처리하지 못했습니다. ' + err.message);
  }
  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * 프론트엔드 공용 진입점.
 * @param {string} action  'register' | 'login' | 'status'
 * @param {Object} payload
 */
function api(action, payload) {
  payload = payload || {};
  switch (action) {
    case 'register':
      return registerUser(payload);
    case 'login':
      return login(payload.id, payload.password);
    case 'status':
      return checkStatus(payload.id);
    default:
      return fail('알 수 없는 요청입니다: ' + action);
  }
}

// ───────────────────────────── 비즈니스 로직 ─────────────────────────────

/**
 * [권한 신청하기]
 * 필수/형식 검증 후 시트에 한 행 추가. activate 는 비워 둠(= 권한 대기).
 */
function registerUser(p) {
  var name = str(p.name);
  var id = str(p.id);
  var password = str(p.password);
  var permission = str(p.permission);

  var invalid = [];
  if (!name || name.length > 16) invalid.push('name');
  if (!id || !/^[A-Za-z0-9!-\/:-@\[-`{-~]{1,16}$/.test(id)) invalid.push('id');
  if (!password || !/^[A-Za-z0-9!-\/:-@\[-`{-~]{8,}$/.test(password)) invalid.push('password');
  if (PERMISSIONS.indexOf(permission) === -1) invalid.push('permission');
  if (invalid.length) {
    return fail('필수 문항 작성이 필요합니다.', invalid);
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = getSheet();
    if (findRowById(sheet, id)) {
      return fail('이미 등록된 아이디입니다. 다른 아이디를 사용해 주세요.', ['id']);
    }
    sheet.appendRow([
      name,
      id,
      HASH_PASSWORDS ? hash(password) : password,
      permission,
      '' // activate: 관리자가 TRUE 로 변경하면 권한 부여
    ]);
  } finally {
    lock.releaseLock();
  }

  return ok({ name: name, id: id, permission: permission });
}

/**
 * 로그인. 아이디/비밀번호가 맞으면 activate 여부와 함께 사용자 정보를 돌려줍니다.
 * activate 가 TRUE 가 아니면 프론트엔드가 '권한 부여 대기 중입니다.' 화면을 보여줍니다.
 */
function login(id, password) {
  id = str(id);
  password = str(password);
  if (!id || !password) return fail('아이디와 비밀번호를 입력해 주세요.');

  var row = findRowById(getSheet(), id);
  if (!row) return fail('아이디 또는 비밀번호가 올바르지 않습니다.');

  var stored = str(row.password);
  var matches = HASH_PASSWORDS ? stored === hash(password) : stored === password;
  if (!matches) return fail('아이디 또는 비밀번호가 올바르지 않습니다.');

  return ok({
    name: row.name,
    id: row.id,
    permission: row.permission,
    activate: isTrue(row.activate)
  });
}

/** 권한 대기 화면에서 '다시 확인' 용도. 활성 여부만 돌려줍니다. */
function checkStatus(id) {
  var row = findRowById(getSheet(), str(id));
  if (!row) return fail('등록 정보를 찾을 수 없습니다.');
  return ok({ activate: isTrue(row.activate), permission: row.permission, name: row.name });
}

// ───────────────────────────── 시트 유틸 ─────────────────────────────

function getSheet() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
  }
  return sheet;
}

/** ID 컬럼(B)에서 대소문자 무시 매칭. 찾으면 행 객체, 없으면 null */
function findRowById(sheet, id) {
  var last = sheet.getLastRow();
  if (last < 2) return null;
  var values = sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
  var target = id.toLowerCase();
  for (var i = 0; i < values.length; i++) {
    var r = values[i];
    if (str(r[1]).toLowerCase() === target) {
      return {
        rowNumber: i + 2,
        name: str(r[0]),
        id: str(r[1]),
        password: str(r[2]),
        permission: str(r[3]),
        activate: r[4]
      };
    }
  }
  return null;
}

// ───────────────────────────── 공용 헬퍼 ─────────────────────────────

function ok(data) { return { ok: true, data: data || {} }; }
function fail(error, fields) { return { ok: false, error: error, fields: fields || [] }; }
function str(v) { return v === null || v === undefined ? '' : String(v).trim(); }
function isTrue(v) { return v === true || str(v).toUpperCase() === 'TRUE'; }

function hash(text) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

// ───────────────────────────── 편집기에서 수동 테스트 ─────────────────────────────

function test_registerAndLogin() {
  var sample = { name: '테스트', id: 'tester01', password: 'test1234!', permission: 'Viewer' };
  Logger.log(JSON.stringify(api('register', sample)));
  Logger.log(JSON.stringify(api('login', { id: sample.id, password: sample.password })));
}
