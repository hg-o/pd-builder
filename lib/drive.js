/**
 * Google Drive 파일 저장 (Apps Script 웹 앱 경유)
 *
 * 회사 Workspace 정책상 서비스 계정을 만들 수 없으므로, 파일 업로드·삭제는 Apps Script 웹 앱(회사 계정으로 실행)에
 * 맡기고 Vercel 함수는 그 웹 앱을 서버 간 호출합니다. 메타데이터(파일 목록)는 Redis 에 저장합니다.
 *
 * 필요한 환경 변수 (Vercel):
 *   APPS_SCRIPT_FILES_URL  Apps Script 웹 앱 배포 URL (https://script.google.com/macros/s/…/exec)
 *   SYNC_SECRET            Apps Script 스크립트 속성 SYNC_SECRET 과 같은 값 (요청 본문에 실어 보냄)
 *
 * Apps Script 쪽: apps-script/Code.gs 의 doPost → filesApi() (action: uploadFile | trashFiles)
 */

const FILE_EXTS = ['pdf', 'csv', 'xls', 'xlsx', 'doc', 'docx', 'hwp', 'hwpx', 'ppt', 'pptx', 'txt'];
const FILE_MAX_BYTES = 3 * 1024 * 1024; // Vercel 요청 본문 상한(4.5MB)을 base64 로 넘지 않도록 파일당 3MB
const FILE_NAME_MAX = 120;
const FILES_PER_FIELD_MAX = 20;
const TIMEOUT_MS = 25000;

function config() {
  const url = String(process.env.APPS_SCRIPT_FILES_URL || '').trim();
  const secret = String(process.env.SYNC_SECRET || '').trim();
  if (!url || !secret) {
    const e = new Error('서버 설정 오류: 파일 저장소(APPS_SCRIPT_FILES_URL / SYNC_SECRET) 환경 변수가 없습니다.');
    e.status = 500; throw e;
  }
  return { url, secret };
}

function extOf(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

/** Apps Script 웹 앱 호출. POST 는 302 로 결과 URL 에 리다이렉트되므로 fetch 가 따라가게 둡니다. */
async function call(action, payload) {
  const { url, secret } = config();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res, text;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // Apps Script 는 text/plain 본문을 postData.contents 로 받습니다
      body: JSON.stringify({ action, secret, ...payload }),
      redirect: 'follow',
      signal: ctrl.signal
    });
    text = await res.text();
  } catch (err) {
    const e = new Error('파일 저장소(Apps Script)에 연결하지 못했습니다. ' + (err.name === 'AbortError' ? '응답 시간이 초과되었습니다.' : err.message));
    e.status = 502; throw e;
  } finally { clearTimeout(timer); }
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = null; }
  if (!res.ok || !json || !json.ok) {
    const e = new Error('파일 저장소 처리에 실패했습니다. ' + (json && json.error ? json.error : 'HTTP ' + res.status));
    e.status = 502; throw e;
  }
  return json.data || {};
}

/**
 * 파일 업로드 → Drive 파일 메타 { driveId, name, mime, size, url, downloadUrl }
 * @param {{ name: string, mime: string, data: string(base64), titleId: string, titleName: string }} p
 */
async function uploadFile(p) {
  const d = await call('uploadFile', { name: p.name, mime: p.mime, data: p.data, titleId: p.titleId, titleName: p.titleName });
  if (!d.id) { const e = new Error('파일 저장소가 파일 ID 를 돌려주지 않았습니다.'); e.status = 502; throw e; }
  return {
    driveId: String(d.id),
    name: String(d.name || p.name),
    mime: String(d.mime || p.mime || ''),
    size: Number(d.size) || 0,
    url: String(d.url || ('https://drive.google.com/file/d/' + d.id + '/view')),
    downloadUrl: String(d.downloadUrl || ('https://drive.google.com/uc?export=download&id=' + d.id))
  };
}

/** Drive 파일을 휴지통으로. 실패해도 예외를 던지지 않고 결과만 돌려줍니다(메타데이터 정리는 계속 진행). */
async function trashFiles(ids) {
  const list = (ids || []).map(String).filter(Boolean);
  if (!list.length) return { trashed: 0 };
  try { return await call('trashFiles', { ids: list }); } catch (err) { console.error('[drive] trash 실패', err.message); return { trashed: 0, error: err.message }; }
}

module.exports = { FILE_EXTS, FILE_MAX_BYTES, FILE_NAME_MAX, FILES_PER_FIELD_MAX, extOf, uploadFile, trashFiles };
