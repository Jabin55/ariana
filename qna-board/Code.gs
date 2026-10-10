/**
 * 질문 게시판 (Padlet 대체) — Google Apps Script + Gemini API
 *
 * 질문을 올리면 Gemini가 자동으로 답변 댓글을 답니다.
 * 데이터는 이 스크립트가 붙어 있는 구글 시트에 저장됩니다.
 *
 * 스크립트 속성 (프로젝트 설정 → 스크립트 속성)
 *   GEMINI_API_KEY  (필수) Google AI Studio에서 발급한 키
 *   GEMINI_MODEL    (선택) 기본값 gemini-3.8-flash
 *   BOARD_TITLE     (선택) 게시판 제목. 기본값 "질문 게시판"
 *   SYSTEM_PROMPT   (선택) AI 답변 지침. 비우면 아래 DEFAULT_SYSTEM_PROMPT 사용
 */

var POSTS_SHEET = 'Posts';
var COMMENTS_SHEET = 'Comments';
var POST_HEADERS = ['id', 'createdAt', 'author', 'text', 'status'];
var COMMENT_HEADERS = ['id', 'postId', 'createdAt', 'author', 'text', 'isAI'];

var DEFAULT_MODEL = 'gemini-3.8-flash';
var DEFAULT_TITLE = '질문 게시판';
var MAX_TEXT_LENGTH = 1000;
var MAX_NAME_LENGTH = 30;
var AI_NAME = 'AI 도우미';

var DEFAULT_SYSTEM_PROMPT = [
  '너는 학교 질문 게시판의 AI 도우미야.',
  '학생이 올린 질문에 한국어로, 학생 눈높이에 맞게 정확하고 친절하게 답해.',
  '답변은 5~10문장 정도로 핵심부터 말하고, 필요하면 짧은 예시를 들어.',
  '마크다운 표나 제목(#)은 쓰지 말고, 강조가 필요하면 **굵게**만 써.',
  '확실하지 않은 내용은 추측하지 말고 선생님께 확인해 보라고 안내해.',
  '개인정보를 묻거나 부적절한 질문에는 정중하게 답변을 사양해.'
].join('\n');

/* ───────────── 웹 앱 진입점 ───────────── */

function doGet() {
  var tpl = HtmlService.createTemplateFromFile('Index');
  tpl.boardTitle = getProp_('BOARD_TITLE', DEFAULT_TITLE);
  return tpl.evaluate()
    .setTitle(tpl.boardTitle)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/* ───────────── 클라이언트에서 호출하는 함수 ───────────── */

/** 게시글과 댓글 전체를 최신 글이 위로 오게 반환합니다. */
function getBoard() {
  var posts = readRows_(getSheet_(POSTS_SHEET, POST_HEADERS), POST_HEADERS);
  var comments = readRows_(getSheet_(COMMENTS_SHEET, COMMENT_HEADERS), COMMENT_HEADERS);

  var byPost = {};
  comments.forEach(function (c) {
    (byPost[c.postId] = byPost[c.postId] || []).push({
      id: String(c.id),
      createdAt: toIso_(c.createdAt),
      author: String(c.author),
      text: String(c.text),
      isAI: c.isAI === true || c.isAI === 'TRUE'
    });
  });

  return posts
    .filter(function (p) { return p.id !== ''; })
    .map(function (p) {
      return {
        id: String(p.id),
        createdAt: toIso_(p.createdAt),
        author: String(p.author),
        text: String(p.text),
        status: String(p.status),
        comments: byPost[p.id] || []
      };
    })
    .reverse();
}

/** 질문을 저장하고 곧바로 AI 답변을 시도합니다. */
function addPost(author, text) {
  text = clean_(text, MAX_TEXT_LENGTH);
  if (!text) throw new Error('질문 내용을 입력해 주세요.');
  author = clean_(author, MAX_NAME_LENGTH) || '익명';

  var id = Utilities.getUuid();
  withLock_(function () {
    getSheet_(POSTS_SHEET, POST_HEADERS).appendRow([id, new Date(), author, text, 'pending']);
  });

  answerPost_(id, text);
  return id;
}

/** 사람이 다는 댓글. */
function addComment(postId, author, text) {
  text = clean_(text, MAX_TEXT_LENGTH);
  if (!text) throw new Error('댓글 내용을 입력해 주세요.');
  author = clean_(author, MAX_NAME_LENGTH) || '익명';
  if (!findPostRow_(postId)) throw new Error('게시글을 찾을 수 없습니다.');

  withLock_(function () {
    getSheet_(COMMENTS_SHEET, COMMENT_HEADERS)
      .appendRow([Utilities.getUuid(), postId, new Date(), author, text, false]);
  });
}

/** "AI 답변 다시 받기" 버튼. 답변에 실패한 글만 다시 시도합니다. */
function retryAnswer(postId) {
  var found = findPostRow_(postId);
  if (!found) throw new Error('게시글을 찾을 수 없습니다.');
  if (found.status === 'answered') return;
  answerPost_(postId, found.text);
}

/* ───────────── 관리용 (편집기에서 직접 실행) ───────────── */

/** 처음 한 번 실행: 시트를 만들고, API 키가 제대로 동작하는지 확인합니다. */
function setup() {
  getSheet_(POSTS_SHEET, POST_HEADERS);
  getSheet_(COMMENTS_SHEET, COMMENT_HEADERS);
  var reply = callGemini_('설치 확인용 질문입니다. "준비 완료"라고만 답해 주세요.');
  Logger.log('Gemini 응답: ' + reply);
}

/** 답변이 안 달린(pending/error) 글에 다시 답변합니다. 시간 기반 트리거로 걸어 두면 자동 재시도됩니다. */
function answerUnanswered() {
  var posts = readRows_(getSheet_(POSTS_SHEET, POST_HEADERS), POST_HEADERS);
  posts.forEach(function (p) {
    if (p.id !== '' && p.status !== 'answered') answerPost_(String(p.id), String(p.text));
  });
}

/** 1분마다 answerUnanswered를 실행하는 트리거를 만듭니다. (선택) */
function installRetryTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'answerUnanswered') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('answerUnanswered').timeBased().everyMinutes(1).create();
}

/* ───────────── 내부 함수 ───────────── */

function answerPost_(postId, question) {
  var answer, status;
  try {
    answer = callGemini_(question);
    status = 'answered';
  } catch (e) {
    console.error('Gemini 호출 실패 (' + postId + '): ' + e);
    status = 'error';
  }

  withLock_(function () {
    var found = findPostRow_(postId);
    if (!found) return; // 그 사이 시트에서 글이 지워진 경우
    if (found.status === 'answered') return; // 동시에 다른 실행이 이미 답한 경우
    if (status === 'answered') {
      getSheet_(COMMENTS_SHEET, COMMENT_HEADERS)
        .appendRow([Utilities.getUuid(), postId, new Date(), AI_NAME, answer, true]);
    }
    found.sheet.getRange(found.row, POST_HEADERS.indexOf('status') + 1).setValue(status);
  });
}

function callGemini_(question) {
  var apiKey = getProp_('GEMINI_API_KEY', '');
  if (!apiKey) throw new Error('스크립트 속성에 GEMINI_API_KEY가 없습니다.');
  var model = getProp_('GEMINI_MODEL', DEFAULT_MODEL);
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(model) + ':generateContent';

  var options = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': apiKey },
    muteHttpExceptions: true,
    payload: JSON.stringify({
      systemInstruction: { parts: [{ text: getProp_('SYSTEM_PROMPT', DEFAULT_SYSTEM_PROMPT) }] },
      contents: [{ role: 'user', parts: [{ text: question }] }]
    })
  };

  // 503(서버 혼잡)·429(호출 한도)·500은 잠깐 기다렸다가 두 번 더 시도합니다.
  var code, body;
  for (var attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) Utilities.sleep(attempt * 3000);
    var res = UrlFetchApp.fetch(url, options);
    code = res.getResponseCode();
    body = res.getContentText();
    if ([429, 500, 503].indexOf(code) === -1) break;
  }
  if (code !== 200) throw new Error('Gemini API ' + code + ': ' + body.slice(0, 300));

  var data = JSON.parse(body);
  var parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
  var text = parts.map(function (p) { return p.text || ''; }).join('').trim();
  if (!text) throw new Error('Gemini가 빈 답변을 보냈습니다: ' + body.slice(0, 300));
  return text;
}

function getSheet_(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function readRows_(sheet, headers) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, headers.length).getValues().map(function (r) {
    var o = {};
    headers.forEach(function (h, i) { o[h] = r[i]; });
    return o;
  });
}

function findPostRow_(postId) {
  var sheet = getSheet_(POSTS_SHEET, POST_HEADERS);
  var rows = readRows_(sheet, POST_HEADERS);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].id) === String(postId)) {
      return { sheet: sheet, row: i + 2, text: String(rows[i].text), status: String(rows[i].status) };
    }
  }
  return null;
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function clean_(s, max) {
  s = String(s == null ? '' : s).trim();
  // 시트에서 수식으로 해석되지 않도록 = + - @ 로 시작하면 앞에 작은따옴표를 붙입니다.
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s.slice(0, max);
}

function toIso_(v) {
  return v instanceof Date ? v.toISOString() : String(v);
}

function getProp_(key, fallback) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  return v ? v : fallback;
}
