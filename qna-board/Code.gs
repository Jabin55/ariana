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
 *   AI_NAME         (선택) AI 답글에 표시할 이름. 기본값 "AI 선생님"
 *   CHARACTER_IMAGE_URL (선택) 캐릭터 이미지 주소(https://...). 비우면 기본 부엉이 캐릭터
 *   AI_REPLY_TO_COMMENTS (선택) false로 두면 댓글에는 AI가 답하지 않습니다. 기본값 true
 */

var POSTS_SHEET = 'Posts';
var COMMENTS_SHEET = 'Comments';
var POST_HEADERS = ['id', 'createdAt', 'author', 'text', 'status', 'category'];

// 게시판 맨 위에 보이는 분류. 질문이 올라오면 AI가 이 중 하나로 나눕니다.
// 시트 Posts 탭의 category 칸을 직접 고쳐서 분류를 바꿀 수도 있습니다.
var CATEGORIES = ['사회와 문화', '정치', '경제', '법과 사회'];
// replyTo: AI 댓글이 답한 대상 (질문이면 글 id, 댓글이면 댓글 id)
var COMMENT_HEADERS = ['id', 'postId', 'createdAt', 'author', 'text', 'isAI', 'replyTo'];

var DEFAULT_MODEL = 'gemini-3.8-flash';
var DEFAULT_TITLE = '질문 게시판';
var MAX_TEXT_LENGTH = 1000;
var MAX_NAME_LENGTH = 30;
var DEFAULT_AI_NAME = 'AI 선생님';
// 게시판 칸 너비에서 AI 답변이 10줄을 넘지 않는 길이 (한 줄에 약 19자)
var MAX_ANSWER_CHARS = 180;

var DEFAULT_SYSTEM_PROMPT = [
  '너는 고등학교 사회와 문화, 정치, 경제, 법과 사회를 가르치는 AI 선생님이야.',
  '학생 질문에 한국어로 학생 눈높이에 맞게 정확하고 친절하게 답변하되, 질문에 따라 단답형으로 한 문장으로 답을 하거나 서술식으로 답변해.',
  '답변은 반드시 공백 포함 ' + MAX_ANSWER_CHARS + '자 이내로, 줄바꿈이나 목록 없이 한 문단으로 써.',
  '정치·사회 쟁점은 여러 입장을 균형 있게 소개해.',
  '표나 제목(#)은 쓰지 마. 강조가 필요하면 **굵게**만 써.',
  '댓글로 이어지는 대화에서는 앞의 맥락을 이어서 답하고, 고맙다는 인사처럼 질문이 아닌 말에는 한두 문장으로만 답해.',
  '확실하지 않은 내용은 추측하지 말고 선생님께 확인해 보라고 안내해.',
  '개인정보를 묻거나 부적절한 질문에는 정중하게 답변을 사양해.'
].join('\n');

/* ───────────── 웹 앱 진입점 ───────────── */

function doGet() {
  var tpl = HtmlService.createTemplateFromFile('Index');
  tpl.boardTitle = getProp_('BOARD_TITLE', DEFAULT_TITLE);
  var img = getProp_('CHARACTER_IMAGE_URL', '');
  tpl.characterUrl = /^https:\/\//.test(img) ? img : '';
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
  var aiName = aiName_();
  comments.forEach(function (c) {
    var isAI = c.isAI === true || c.isAI === 'TRUE';
    (byPost[c.postId] = byPost[c.postId] || []).push({
      id: String(c.id),
      createdAt: toIso_(c.createdAt),
      author: isAI ? aiName : String(c.author), // 이름을 바꾸면 예전 AI 답글에도 새 이름이 보입니다
      text: String(c.text),
      isAI: isAI
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
        category: CATEGORIES.indexOf(String(p.category)) === -1 ? '' : String(p.category),
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
    getSheet_(POSTS_SHEET, POST_HEADERS).appendRow([id, new Date(), author, text, 'pending', '']);
  });

  answerPost_(id);
  return id;
}

/**
 * 사람이 다는 댓글. 저장만 하고 바로 돌아옵니다.
 * AI가 이어서 답해야 하면 true를 돌려주고, 화면이 곧바로 retryAnswer를 부릅니다.
 */
function addComment(postId, author, text) {
  text = clean_(text, MAX_TEXT_LENGTH);
  if (!text) throw new Error('댓글 내용을 입력해 주세요.');
  author = clean_(author, MAX_NAME_LENGTH) || '익명';
  var aiReplies = getProp_('AI_REPLY_TO_COMMENTS', 'true') !== 'false';

  withLock_(function () {
    var found = findPostRow_(postId);
    if (!found) throw new Error('게시글을 찾을 수 없습니다.');
    getSheet_(COMMENTS_SHEET, COMMENT_HEADERS)
      .appendRow([Utilities.getUuid(), postId, new Date(), author, text, false, '']);
    if (aiReplies) setStatus_(found, 'pending');
  });
  return aiReplies;
}

/** 아직 AI가 답하지 않은 글(또는 마지막 댓글)에 답합니다. "다시 받기" 버튼도 이걸 씁니다. */
function retryAnswer(postId) {
  var found = findPostRow_(postId);
  if (!found) throw new Error('게시글을 찾을 수 없습니다.');
  if (found.status === 'answered') return;
  answerPost_(postId);
}

/* ───────────── 관리용 (편집기에서 직접 실행) ───────────── */

/** 처음 한 번 실행: 시트를 만들고, API 키가 제대로 동작하는지 확인합니다. */
function setup() {
  getSheet_(POSTS_SHEET, POST_HEADERS);
  getSheet_(COMMENTS_SHEET, COMMENT_HEADERS);
  var reply = callGemini_([{ role: 'user', parts: [{ text: '설치 확인용 질문입니다. "준비 완료"라고만 답해 주세요.' }] }]);
  Logger.log('Gemini 응답: ' + reply);
}

/** 답변이 안 달린(pending/error) 글에 다시 답변합니다. 시간 기반 트리거로 걸어 두면 자동 재시도됩니다. */
function answerUnanswered() {
  var posts = readRows_(getSheet_(POSTS_SHEET, POST_HEADERS), POST_HEADERS);
  posts.forEach(function (p) {
    if (p.id !== '' && p.status !== 'answered') answerPost_(String(p.id));
  });
}

/** 분류가 비어 있는 글(이 기능 전에 올라온 글 등)을 AI로 분류합니다. 편집기에서 한 번 실행하세요. */
function classifyExisting() {
  var posts = readRows_(getSheet_(POSTS_SHEET, POST_HEADERS), POST_HEADERS);
  posts.forEach(function (p) {
    if (p.id === '' || p.status !== 'answered' || validCategory_(p.category)) return;
    try {
      classifyPost_({ id: String(p.id), text: String(p.text) });
    } catch (e) {
      console.error('분류 실패 (' + p.id + '): ' + e);
    }
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

/**
 * 글의 질문과 댓글 대화를 Gemini에 보내고, 마지막 사람 메시지에 대한 AI 댓글을 답니다.
 * 같은 메시지에 이미 AI 답이 있으면(동시에 다른 실행이 답한 경우) 다시 달지 않습니다.
 */
function answerPost_(postId) {
  var thread = loadThread_(postId);
  if (!thread) return;
  var target = thread.lastHumanId;
  if (thread.answered[target]) return;

  // 질문 자체에 처음 답할 때는 분류도 같이 받습니다.
  var needCategory = target === String(postId) && !thread.post.category;
  var answer, category, status;
  try {
    if (needCategory) {
      var r = callGeminiJson_(thread.contents, answerSchema_());
      answer = String(r.answer || '').trim();
      category = validCategory_(r.category);
      if (!answer) throw new Error('답변이 비어 있습니다.');
    } else {
      answer = callGemini_(thread.contents);
    }
    status = 'answered';
  } catch (e) {
    console.error('Gemini 호출 실패 (' + postId + '): ' + e);
    status = 'error';
  }

  withLock_(function () {
    var now = loadThread_(postId);
    if (!now) return; // 그 사이 시트에서 글이 지워진 경우
    if (now.answered[target]) return;
    if (status === 'answered') {
      answer = trimAnswer_(answer);
      getSheet_(COMMENTS_SHEET, COMMENT_HEADERS)
        .appendRow([Utilities.getUuid(), postId, new Date(), aiName_(), answer, true, target]);
    }
    if (category && !now.post.category) setCell_(now.post, 'category', category);
    // 답하는 사이 새 댓글이 달렸으면 그 댓글을 위해 pending으로 둡니다.
    if (now.lastHumanId === target) setStatus_(now.post, status);
  });
}

/** 글과 댓글을 읽어 Gemini에 보낼 대화(contents)와 답변 현황을 만듭니다. */
function loadThread_(postId) {
  var post = findPostRow_(postId);
  if (!post) return null;
  var comments = readRows_(getSheet_(COMMENTS_SHEET, COMMENT_HEADERS), COMMENT_HEADERS)
    .filter(function (c) { return String(c.postId) === String(postId); });

  var answered = {};
  var lastHumanId = String(postId);
  var turns = [{ role: 'user', text: post.author + '의 질문: ' + post.text }];
  comments.forEach(function (c) {
    var isAI = c.isAI === true || c.isAI === 'TRUE';
    if (isAI) {
      answered[String(c.replyTo) || String(postId)] = true; // replyTo가 없는 예전 답변은 질문에 대한 답
      turns.push({ role: 'model', text: String(c.text) });
    } else {
      lastHumanId = String(c.id);
      turns.push({ role: 'user', text: c.author + '의 댓글: ' + c.text, id: lastHumanId });
    }
  });

  // 마지막 사람 메시지까지만 보내고, 같은 역할이 연달아 나오면 하나로 합칩니다.
  var cut = 0;
  turns.forEach(function (t, i) { if (t.role === 'user') cut = i; });
  var contents = [];
  turns.slice(0, cut + 1).forEach(function (t) {
    var prev = contents[contents.length - 1];
    if (prev && prev.role === t.role) prev.parts[0].text += '\n\n' + t.text;
    else contents.push({ role: t.role, parts: [{ text: t.text }] });
  });

  return { post: post, contents: contents, answered: answered, lastHumanId: lastHumanId };
}

/** 지침을 어기고 길게 오면, 한 문단으로 합치고 글자 수 안에서 문장이 끝나는 곳까지만 남깁니다. */
function trimAnswer_(text) {
  text = String(text).replace(/\s*\n+\s*/g, ' ').trim();
  var limit = MAX_ANSWER_CHARS + 10; // 살짝 넘는 정도는 그대로 둡니다
  if (text.length <= limit) return text;
  var cut = text.slice(0, limit);
  var end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '),
    cut.lastIndexOf('다.'), cut.lastIndexOf('요.'));
  if (end >= MAX_ANSWER_CHARS / 2) return cut.slice(0, end + 2).trim();
  return cut.slice(0, MAX_ANSWER_CHARS - 1).trim() + '…';
}

function setStatus_(found, status) {
  setCell_(found, 'status', status);
}

function setCell_(found, header, value) {
  found.sheet.getRange(found.row, POST_HEADERS.indexOf(header) + 1).setValue(value);
}

function validCategory_(c) {
  return CATEGORIES.indexOf(String(c)) === -1 ? '' : String(c);
}

function answerSchema_() {
  return {
    type: 'OBJECT',
    properties: {
      category: { type: 'STRING', enum: CATEGORIES, description: '질문이 가장 가까운 과목' },
      answer: { type: 'STRING', description: '학생에게 보여 줄 답변' }
    },
    required: ['category', 'answer']
  };
}

/** 이미 답이 달렸지만 분류가 없는 글(예전 글)을 분류만 따로 합니다. */
function classifyPost_(found) {
  var r = callGeminiJson_(
    [{ role: 'user', parts: [{ text: '다음 학생 질문이 어느 과목에 가장 가까운지 분류해.\n\n' + found.text }] }],
    { type: 'OBJECT', properties: { category: { type: 'STRING', enum: CATEGORIES } }, required: ['category'] });
  var category = validCategory_(r.category);
  if (!category) return;
  withLock_(function () {
    var now = findPostRow_(found.id);
    if (now && !now.category) setCell_(now, 'category', category);
  });
}

function callGeminiJson_(contents, schema) {
  var text = callGemini_(contents, {
    responseMimeType: 'application/json',
    responseSchema: schema
  });
  try {
    return JSON.parse(text);
  } catch (e) {
    // JSON이 아니게 오면 전체를 답변으로 씁니다 (분류는 나중에 다시 시도).
    return { answer: text };
  }
}

function callGemini_(contents, generationConfig) {
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
      contents: contents,
      generationConfig: generationConfig || {}
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
  } else if (sheet.getLastColumn() < headers.length) {
    // 예전 버전으로 만든 시트에 새 열 제목을 채워 넣습니다.
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
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
      return { sheet: sheet, row: i + 2, id: String(rows[i].id), author: String(rows[i].author),
        text: String(rows[i].text), status: String(rows[i].status),
        category: validCategory_(rows[i].category) };
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

function aiName_() {
  return getProp_('AI_NAME', DEFAULT_AI_NAME);
}

function getProp_(key, fallback) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  return v ? v : fallback;
}
