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
 *   AI_NAME         (선택) AI 답글에 표시할 이름. 기본값 "AI 튜터"
 *   CHARACTER_IMAGE_URL (선택) 캐릭터 이미지 주소(https://...). 비우면 기본 부엉이 캐릭터
 *   NOTIFY_EMAIL    (선택) 새 질문 알림 메일을 받을 주소. 비우면 스크립트 주인 계정, off면 알림 끔
 *   CHAT_WEBHOOK_URL (선택) 구글 챗 스페이스의 웹훅 주소. 넣으면 알림이 구글 챗으로 갑니다.
 *                   이때 메일은 NOTIFY_EMAIL 에 주소를 직접 넣었을 때만 함께 보냅니다.
 *   REFERENCE_ONLY  (선택) true면 '자료' 탭 밖의 내용은 아예 답하지 않습니다. 기본값 false:
 *                   자료에 있으면 자료로만 답하고, 없으면 AI가 아는 내용으로 답하고, 필요할 때만 선생님 안내를 덧붙입니다.
 *   AI_REPLY_TO_COMMENTS (선택) false로 두면 댓글에는 AI가 답하지 않습니다. 기본값 true
 *   TEACHER_PASSWORD (선택) 선생님 전용 '학생 분석' 화면(게시판 주소 뒤에 ?teacher)의 비밀번호.
 *                   비워 두면 분석 화면이 열리지 않습니다.
 */

var POSTS_SHEET = 'Posts';
var COMMENTS_SHEET = 'Comments';
// unit: 대단원, competencies: 질문에 드러난 사회과 교과 역량 (쉼표로 구분, 최대 2개)
var POST_HEADERS = ['id', 'createdAt', 'author', 'text', 'status', 'category', 'unit', 'competencies'];

// 게시판 맨 위에 보이는 분류. 질문이 올라오면 AI가 이 중 하나로 나눕니다.
// 시트 Posts 탭의 category 칸을 직접 고쳐서 분류를 바꿀 수도 있습니다.
var CATEGORIES = ['사회와 문화', '정치', '경제', '법과 사회'];
// replyTo: AI 댓글이 답한 대상 (질문이면 글 id, 댓글이면 댓글 id)
// 선생님이 붙여 넣는 참고 자료. AI 튜터는 여기 있는 내용으로만 답합니다.
var REF_SHEET = '자료';
var REF_HEADERS = ['과목', '제목', '내용'];
var MAX_REF_CHARS = 60000; // 한 번에 AI에게 보내는 자료 길이 상한 (무료 한도 보호)
// 예전 지침에서 AI가 붙이던 표시. 혹시 나오면 지웁니다.
var NOT_IN_REF_MARK = '[자료없음]';

var COMMENT_HEADERS = ['id', 'postId', 'createdAt', 'author', 'text', 'isAI', 'replyTo'];

// 학생 분석 기준. 처음 실행할 때 시트에 '단원', '역량' 탭을 아래 기본값으로 만듭니다.
// 학교 교과서·교육과정에 맞게 시트에서 고치면 다음 분류부터 바로 반영됩니다.
var UNITS_SHEET = '단원';
var UNIT_HEADERS = ['과목', '대단원'];
var DEFAULT_UNITS = [
  ['사회와 문화', '사회·문화 현상의 탐구'],
  ['사회와 문화', '개인과 사회 구조'],
  ['사회와 문화', '문화와 일상생활'],
  ['사회와 문화', '사회 계층과 불평등'],
  ['사회와 문화', '현대의 사회 변동'],
  ['정치', '정치와 민주주의'],
  ['정치', '민주 국가와 정부'],
  ['정치', '정치 과정과 참여'],
  ['정치', '국제 정치'],
  ['경제', '경제생활과 경제 문제'],
  ['경제', '시장과 경제 활동'],
  ['경제', '국가와 경제 활동'],
  ['경제', '세계 시장과 교역'],
  ['법과 사회', '민주주의와 헌법'],
  ['법과 사회', '개인 생활과 법'],
  ['법과 사회', '사회생활과 법'],
  ['법과 사회', '국가와 국제 관계와 법']
];
var COMP_SHEET = '역량';
var COMP_HEADERS = ['역량', '설명'];
var DEFAULT_COMPETENCIES = [
  ['창의적 사고력', '새로운 관점이나 독창적인 생각, 기존 개념을 다른 상황에 연결하는 질문'],
  ['비판적 사고력', '주장·제도·자료의 타당성, 근거, 한계, 장단점을 따져 보는 질문'],
  ['문제 해결력 및 의사 결정력', '사회 문제의 원인과 해결 방안을 찾거나, 대안을 비교해 합리적으로 선택하려는 질문'],
  ['의사소통 및 협업 능력', '다른 사람의 의견·입장을 이해하고 조율하거나, 토론·협력에 관한 질문'],
  ['정보 활용 능력', '자료·통계·뉴스 등 정보를 찾고 해석하고 활용하는 방법에 관한 질문']
];
var MAX_COMPETENCIES = 2;

var DEFAULT_MODEL = 'gemini-3.8-flash';
var DEFAULT_TITLE = '질문 게시판';
var MAX_TEXT_LENGTH = 1000;
var MAX_NAME_LENGTH = 30;
var DEFAULT_AI_NAME = 'AI 튜터';
// 게시판 칸 너비에서 AI 답변이 10줄을 넘지 않는 길이 (한 줄에 약 19자)
var MAX_ANSWER_CHARS = 180;

var DEFAULT_SYSTEM_PROMPT = [
  '너는 고등학교 사회와 문화, 정치, 경제, 법과 사회를 가르치는 AI 튜터야.',
  '학생 질문에 한국어로 학생 눈높이에 맞게 정확하고 친절하게 답변하되, 질문에 따라 단답형으로 한 문장으로 답을 하거나 서술식으로 답변해.',
  '답변은 공백 포함 ' + MAX_ANSWER_CHARS + '자 안팎으로, 줄바꿈이나 목록 없이 한 문단으로 쓰고, 마지막 문장은 반드시 끝까지 완성해.',
  '정치·사회 쟁점은 여러 입장을 균형 있게 소개해.',
  '표나 제목(#)은 쓰지 마. 강조가 필요하면 **굵게**만 써.',
  '가끔은 답변에 위로나 공감의 말을 한 문장 덧붙여. 특히 학생이 어려워하거나 걱정·불안·속상함을 드러내면 "그 부분 정말 헷갈리죠", "걱정되는 마음 이해해요", "잘하고 있어요"처럼 마음을 먼저 알아주고 답해. 매번 붙이지는 말고 글자 수 제한 안에서 써.',
  '댓글로 이어지는 대화에서는 앞의 맥락을 이어서 답하고, 고맙다는 인사처럼 질문이 아닌 말에는 한두 문장으로만 답해.',
  '시사·최신 뉴스에 관한 질문도 뉴스 검색만 권하지 말고 먼저 관련 배경·개념·쟁점을 아는 범위에서 균형 있게 실제로 설명해. 그다음 선생님께 여쭤보라고 하지 말고 답변 끝에 "최신 소식은 뉴스를 검색해서 확인해 보세요"처럼 뉴스 검색을 권해. 최근 상황을 지어내지는 마.',
  '정말 모르는 내용은 추측해서 지어내지 마. 선생님께 여쭤보라는 말은 아주 드물게만 써. 네가 답할 수 있는 질문에는 절대 붙이지 마.',
  '개인정보를 묻거나 부적절한 질문에는 정중하게 답변을 사양해.'
].join('\n');

/* ───────────── 웹 앱 진입점 ───────────── */

function doGet(e) {
  if (e && e.parameter && e.parameter.teacher !== undefined) {
    var t = HtmlService.createTemplateFromFile('Teacher');
    t.boardTitle = getProp_('BOARD_TITLE', DEFAULT_TITLE);
    return t.evaluate()
      .setTitle('학생 분석 · ' + t.boardTitle)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
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
  if (duplicateAnswerRows_(comments).length) {
    removeDuplicateAnswers();
    comments = readRows_(getSheet_(COMMENTS_SHEET, COMMENT_HEADERS), COMMENT_HEADERS);
  }

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
  notifyNewPost_(id);
  return id;
}

/**
 * 새 질문이 올라오면 선생님께 알립니다 (AI 답변과 분류가 끝난 뒤).
 * CHAT_WEBHOOK_URL 이 있으면 구글 챗으로 보내고, 메일은 NOTIFY_EMAIL 에 주소를 직접 넣었을 때만 함께 보냅니다.
 * 알림이 안 가도 질문 올리기는 그대로 성공합니다.
 */
function notifyNewPost_(postId) {
  var thread;
  try {
    thread = loadThread_(postId);
  } catch (e) {
    console.error('알림 준비 실패: ' + e);
    return;
  }
  if (!thread) return;
  var post = thread.post;
  var note = {
    title: getProp_('BOARD_TITLE', DEFAULT_TITLE),
    category: post.category,
    author: post.author,
    text: post.text,
    answer: thread.contents.length > 1 ? thread.contents[1].parts[0].text : '(AI 답변을 받지 못했어요)',
    boardUrl: ScriptApp.getService().getUrl(),
    sheetUrl: SpreadsheetApp.getActiveSpreadsheet().getUrl()
  };

  var webhook = getProp_('CHAT_WEBHOOK_URL', '').trim();
  var email = getProp_('NOTIFY_EMAIL', '');
  if (webhook) {
    try {
      sendChat_(webhook, note);
    } catch (e) {
      console.error('구글 챗 알림 실패: ' + e);
    }
  } else if (!email) {
    email = Session.getEffectiveUser().getEmail();
  }
  if (email && email !== 'off') {
    try {
      sendMail_(email, note);
    } catch (e) {
      console.error('알림 메일 실패: ' + e);
    }
  }
}

function sendMail_(to, note) {
  MailApp.sendEmail({
    to: to,
    subject: '[' + note.title + '] 새 질문' + (note.category ? ' · ' + note.category : '') + ' - ' + note.author,
    body: note.author + ' 학생의 질문\n' + note.text + '\n\n' + aiName_() + ' 답변\n' + note.answer +
      '\n\n게시판 열기: ' + note.boardUrl +
      '\n시트 열기: ' + note.sheetUrl +
      '\n\n(알림을 끄려면 스크립트 속성 NOTIFY_EMAIL 을 off 로 바꾸세요.)'
  });
}

/** 구글 챗 스페이스의 웹훅으로 메시지를 보냅니다. */
function sendChat_(webhook, note) {
  if (webhook.indexOf('https://chat.googleapis.com/') !== 0) {
    throw new Error('CHAT_WEBHOOK_URL 은 https://chat.googleapis.com/ 으로 시작해야 합니다.');
  }
  // 구글 챗 서식: *굵게*, <주소|글자> 링크
  var text = '📌 *새 질문' + (note.category ? ' · ' + note.category : '') + '* — ' + note.author + '\n' +
    note.text + '\n\n' +
    '🦉 *' + aiName_() + ' 답변*\n' + note.answer + '\n\n' +
    '<' + note.boardUrl + '|게시판 열기> · <' + note.sheetUrl + '|시트 열기>';
  var res = UrlFetchApp.fetch(webhook, {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    payload: JSON.stringify({ text: text }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error(res.getResponseCode() + ' ' + res.getContentText().slice(0, 300));
  }
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

/** 분류되지 않은 글을 과목 칸으로 옮깁니다 (끌어다 놓기). 이미 분류된 글은 바꾸지 않습니다. */
function setCategory(postId, category) {
  category = validCategory_(category);
  if (!category) throw new Error('알 수 없는 과목입니다.');
  withLock_(function () {
    var found = findPostRow_(postId);
    if (!found) throw new Error('게시글을 찾을 수 없습니다.');
    if (found.category) throw new Error('이미 분류된 질문입니다. 시트에서 바꿀 수 있어요.');
    setCell_(found, 'category', category);
  });
}

/* ───────────── 선생님 전용 학생 분석 ───────────── */

/**
 * 학생 분석 화면에 필요한 글 목록과 분석 기준을 돌려줍니다. 비밀번호가 맞아야 합니다.
 * 비밀번호를 10번 틀리면 10분 동안 막습니다.
 */
function getAnalysis(password) {
  var expected = getProp_('TEACHER_PASSWORD', '');
  if (!expected) throw new Error('스크립트 속성에 TEACHER_PASSWORD 를 먼저 넣어 주세요.');
  var cache = CacheService.getScriptCache();
  var fails = Number(cache.get('teacher_fails') || 0);
  if (fails >= 10) throw new Error('비밀번호를 여러 번 틀렸어요. 10분 뒤에 다시 시도하세요.');
  if (String(password || '') !== expected) {
    cache.put('teacher_fails', String(fails + 1), 600);
    Utilities.sleep(1000);
    throw new Error('비밀번호가 맞지 않아요.');
  }

  var cfg = analysisConfig_();
  var comments = readRows_(getSheet_(COMMENTS_SHEET, COMMENT_HEADERS), COMMENT_HEADERS);
  var followUps = {}; // 글쓴이가 자기 질문에 단 후속 댓글 수
  var authorOf = {};
  var posts = readRows_(getSheet_(POSTS_SHEET, POST_HEADERS), POST_HEADERS).filter(function (p) { return p.id !== ''; });
  posts.forEach(function (p) { authorOf[p.id] = String(p.author).trim(); });
  comments.forEach(function (c) {
    var isAI = c.isAI === true || c.isAI === 'TRUE';
    if (!isAI && String(c.author).trim() === authorOf[c.postId]) followUps[c.postId] = (followUps[c.postId] || 0) + 1;
  });

  return {
    categories: CATEGORIES,
    units: cfg.units,
    competencies: cfg.competencies,
    posts: posts.map(function (p) {
      var category = validCategory_(p.category);
      return {
        createdAt: toIso_(p.createdAt),
        author: String(p.author).trim(),
        text: String(p.text),
        category: category,
        unit: validUnit_(category, p.unit),
        competencies: validCompetencies_(p.competencies).split(', ').filter(String),
        followUps: followUps[p.id] || 0
      };
    })
  };
}

/* ───────────── 관리용 (편집기에서 직접 실행) ───────────── */

/** 처음 한 번 실행: 시트를 만들고, API 키가 제대로 동작하는지 확인합니다. */
function setup() {
  getSheet_(POSTS_SHEET, POST_HEADERS);
  getSheet_(COMMENTS_SHEET, COMMENT_HEADERS);
  getSheet_(REF_SHEET, REF_HEADERS);
  var cfg = analysisConfig_();
  Logger.log('0) 분석 기준: 대단원 ' + CATEGORIES.map(function (c) { return c + ' ' + (cfg.units[c] || []).length + '개'; }).join(', ') +
    ' / 역량 ' + cfg.competencies.length + '개');
  var ref = referenceText_('');
  Logger.log('0) 참고 자료: ' + (ref ? ref.length + '자 (' + (referenceOnly_() ? '자료 안에서만 답변' : '자료 우선 참고') + ')' : '없음 (AI가 아는 내용으로 답변)'));
  var reply = callGemini_([{ role: 'user', parts: [{ text: '설치 확인용 질문입니다. "준비 완료"라고만 답해 주세요.' }] }]);
  Logger.log('1) Gemini 답변: ' + reply);
  try {
    var r = callGeminiJson_([{ role: 'user', parts: [{ text: '수요와 공급이 뭐예요?' }] }], answerSchema_(), systemPrompt_(''));
    Logger.log('2) 과목 분류: ' + r.category + ' · ' + (r.unit || '-') + ' · 역량 ' + (r.competencies || []).join(', ') +
      ' / 답변 ' + String(r.answer || '').length + '자');
  } catch (e) {
    Logger.log('2) 과목 분류 실패: ' + e);
  }
}

/** 답변이 안 달린(pending/error) 글에 다시 답변합니다. 시간 기반 트리거로 걸어 두면 자동 재시도됩니다. */
function answerUnanswered() {
  var posts = readRows_(getSheet_(POSTS_SHEET, POST_HEADERS), POST_HEADERS);
  posts.forEach(function (p) {
    if (p.id !== '' && p.status !== 'answered') answerPost_(String(p.id));
  });
}

/**
 * 과목·대단원·역량 분류가 비어 있는 글(이 기능 전에 올라온 글 등)을 AI로 분류합니다.
 * 편집기에서 실행하세요. 무료 한도를 넘지 않게 천천히(한 번에 최대 40개) 처리하므로,
 * 실행 로그에 '남은 글'이 있으면 몇 분 뒤 한 번 더 실행하면 됩니다.
 */
function analyzeExisting() {
  var started = Date.now();
  var posts = readRows_(getSheet_(POSTS_SHEET, POST_HEADERS), POST_HEADERS).filter(function (p) {
    return p.id !== '' && p.status === 'answered' &&
      (!validCategory_(p.category) || !validUnit_(validCategory_(p.category), p.unit) || !validCompetencies_(p.competencies));
  });
  var done = 0;
  for (var i = 0; i < posts.length && done < 40; i++) {
    if (Date.now() - started > 4.5 * 60 * 1000) break; // Apps Script 실행 시간(6분) 제한 보호
    var p = posts[i];
    if (done > 0) Utilities.sleep(4000); // 무료 한도(분당 요청 수) 보호
    try {
      analyzePost_({ id: String(p.id), text: String(p.text), category: validCategory_(p.category),
        unit: validUnit_(validCategory_(p.category), p.unit) });
      done++;
    } catch (e) {
      console.error('분류 실패 (' + p.id + '): ' + e);
      if (/Gemini API 429/.test(String(e))) { Logger.log('Gemini 무료 한도에 걸렸습니다. 잠시 뒤 다시 실행하세요.'); break; }
    }
  }
  Logger.log('분류한 글: ' + done + '개 / 남은 글: ' + (posts.length - done) + '개');
}

/** 예전 이름. analyzeExisting과 같습니다. */
function classifyExisting() {
  analyzeExisting();
}

/** 10분마다 answerUnanswered를 실행하는 트리거를 만듭니다. (선택) */
function installRetryTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'answerUnanswered') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('answerUnanswered').timeBased().everyMinutes(10).create();
}

/** 구글 챗 알림이 잘 가는지 시험 메시지를 보냅니다. CHAT_WEBHOOK_URL 을 넣은 뒤 편집기에서 실행하세요. */
function testChatNotify() {
  var webhook = getProp_('CHAT_WEBHOOK_URL', '').trim();
  if (!webhook) throw new Error('스크립트 속성 CHAT_WEBHOOK_URL 이 비어 있습니다.');
  sendChat_(webhook, {
    title: getProp_('BOARD_TITLE', DEFAULT_TITLE),
    category: '정치',
    author: '테스트',
    text: '알림 시험용 질문입니다. 이 메시지가 보이면 설정 완료!',
    answer: '구글 챗 알림이 잘 연결됐어요.',
    boardUrl: ScriptApp.getService().getUrl() || 'https://script.google.com',
    sheetUrl: SpreadsheetApp.getActiveSpreadsheet().getUrl()
  });
  Logger.log('구글 챗으로 시험 메시지를 보냈습니다.');
}

/**
 * 한 글에서 AI 답변이 사람 댓글 없이 연달아 달린 경우, 마지막 것만 남기고 시트에서 지웁니다.
 * 게시판을 열 때마다 자동으로 확인하므로 직접 실행할 필요는 없습니다.
 */
function removeDuplicateAnswers() {
  withLock_(function () {
    var sheet = getSheet_(COMMENTS_SHEET, COMMENT_HEADERS);
    var rows = duplicateAnswerRows_(readRows_(sheet, COMMENT_HEADERS));
    rows.sort(function (a, b) { return b - a; }).forEach(function (r) { sheet.deleteRow(r); });
  });
}

/* ───────────── 내부 함수 ───────────── */

/** 지울 중복 AI 답변의 시트 행 번호 목록. */
function duplicateAnswerRows_(comments) {
  var lastAiRow = {}; // 글마다 "바로 앞이 AI 답변이었다면 그 행"
  var dup = [];
  comments.forEach(function (c, i) {
    var key = String(c.postId);
    var isAI = c.isAI === true || c.isAI === 'TRUE';
    if (isAI) {
      if (lastAiRow[key]) dup.push(lastAiRow[key]);
      lastAiRow[key] = i + 2;
    } else {
      lastAiRow[key] = 0;
    }
  });
  return dup;
}


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
  var system = systemPrompt_(thread.post.category);
  var answer, category, unit, competencies, status;
  try {
    if (needCategory) {
      try {
        var r = callGeminiJson_(thread.contents, answerSchema_(), system);
        answer = String(r.answer || '').trim();
        category = validCategory_(r.category);
        unit = validUnit_(category, r.unit);
        competencies = validCompetencies_(r.competencies);
      } catch (e) {
        // 분류 방식(JSON 응답)이 거절되면 분류 없이 답변만 받습니다. 분류는 analyzeExisting으로 나중에.
        if (!/Gemini API 400/.test(String(e))) throw e;
        console.error('분류 요청 거절, 답변만 받습니다: ' + e);
      }
      if (!answer) answer = callGemini_(thread.contents, null, system);
    } else {
      answer = callGemini_(thread.contents, null, system);
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
      answer = finishAnswer_(answer);
      getSheet_(COMMENTS_SHEET, COMMENT_HEADERS)
        .appendRow([Utilities.getUuid(), postId, new Date(), aiName_(), answer, true, target]);
    }
    if (category && !now.post.category) {
      setCell_(now.post, 'category', category);
      if (unit && !validUnit_(category, now.post.unit)) setCell_(now.post, 'unit', unit);
    }
    if (competencies && !validCompetencies_(now.post.competencies)) setCell_(now.post, 'competencies', competencies);
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
/** 자료 밖 답변 표시를 안내 문구로 바꾸고, 안내 문구까지 합쳐 10줄 안에 들어가게 자릅니다. */
function finishAnswer_(text) {
  return trimAnswer_(String(text).split(NOT_IN_REF_MARK).join('').trim());
}

function trimAnswer_(text, max) {
  max = max || MAX_ANSWER_CHARS;
  text = String(text).replace(/\s*\n+\s*/g, ' ').trim();
  // 글자 수는 넉넉하게(1.5배까지) 봐 주고, 자를 때는 문장이 끝나는 곳에서만 자릅니다.
  var limit = Math.round(max * 1.5);
  if (text.length <= limit) return text;
  var ends = [];
  var re = /[.?!。…](?=\s|$)/g, m;
  while ((m = re.exec(text))) ends.push(m.index + 1);
  var inside = ends.filter(function (e) { return e <= limit; });
  if (inside.length && inside[inside.length - 1] >= max / 2) return text.slice(0, inside[inside.length - 1]).trim();
  // 그 안에서 문장이 끝나지 않으면, 다음 문장 끝까지 보여 줍니다 (중간에서 자르지 않음).
  var after = ends.filter(function (e) { return e > limit; });
  return after.length ? text.slice(0, after[0]).trim() : text;
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
  var schema = {
    type: 'OBJECT',
    properties: {
      category: { type: 'STRING', enum: CATEGORIES, description: '질문이 가장 가까운 과목' },
      answer: { type: 'STRING', description: '학생에게 보여 줄 답변' }
    },
    required: ['category', 'answer']
  };
  addAnalysisFields_(schema, '');
  return schema;
}

/**
 * 분류 스키마에 대단원·역량 칸을 붙입니다. category를 알면 그 과목의 단원만 고르게 합니다.
 * '단원'·'역량' 탭이 비어 있으면 그 칸은 빼고 분류하지 않습니다.
 */
function addAnalysisFields_(schema, category) {
  var cfg = analysisConfig_();
  var units = [];
  CATEGORIES.forEach(function (c) {
    if (!category || c === category) units = units.concat(cfg.units[c] || []);
  });
  units = units.filter(function (u, i) { return units.indexOf(u) === i; });
  if (units.length) {
    var guide = CATEGORIES.filter(function (c) { return (!category || c === category) && (cfg.units[c] || []).length; })
      .map(function (c) { return c + ': ' + cfg.units[c].join(', '); }).join(' / ');
    schema.properties.unit = { type: 'STRING', enum: units,
      description: '질문이 속하는 대단원. 반드시 고른 과목의 단원 중에서 고를 것 (' + guide + ')' };
    schema.required.push('unit');
  }
  if (cfg.competencies.length) {
    schema.properties.competencies = {
      type: 'ARRAY', minItems: 1, maxItems: MAX_COMPETENCIES,
      items: { type: 'STRING', enum: cfg.competencies.map(function (c) { return c.name; }) },
      description: '학생의 질문에 드러난 사회과 교과 역량 1~' + MAX_COMPETENCIES + '개 (가장 뚜렷한 것부터). 기준: ' +
        cfg.competencies.map(function (c) { return c.name + (c.desc ? '(' + c.desc + ')' : ''); }).join('; ')
    };
    schema.required.push('competencies');
  }
  return schema;
}

/** 이미 답이 달린 글의 과목·대단원·역량 중 빈 칸을 AI로 채웁니다. */
function analyzePost_(found) {
  var schema = { type: 'OBJECT', properties: {}, required: [] };
  if (!found.category) {
    schema.properties.category = { type: 'STRING', enum: CATEGORIES, description: '질문이 가장 가까운 과목' };
    schema.required.push('category');
  }
  addAnalysisFields_(schema, found.category);
  if (!schema.required.length) return;
  var r = callGeminiJson_(
    [{ role: 'user', parts: [{ text: '다음 학생 질문을 분류해.' +
      (found.category ? '\n과목: ' + found.category : '') + '\n\n질문: ' + found.text }] }],
    schema, '너는 고등학교 사회과 교사를 돕는 분류 도우미야. 학생 질문 하나를 정해진 기준으로 분류해.');
  var category = found.category || validCategory_(r.category);
  var unit = validUnit_(category, r.unit);
  var competencies = validCompetencies_(r.competencies);
  withLock_(function () {
    var now = findPostRow_(found.id);
    if (!now) return;
    if (!now.category && category) setCell_(now, 'category', category);
    if (unit && (now.category || category) === category && !validUnit_(category, now.unit)) setCell_(now, 'unit', unit);
    if (competencies && !validCompetencies_(now.competencies)) setCell_(now, 'competencies', competencies);
  });
}

function validUnit_(category, unit) {
  var list = analysisConfig_().units[category] || [];
  return list.indexOf(String(unit || '')) === -1 ? '' : String(unit);
}

function validCompetencies_(list) {
  var names = analysisConfig_().competencies.map(function (c) { return c.name; });
  var picked = [];
  (Array.isArray(list) ? list : String(list || '').split(',')).forEach(function (c) {
    c = String(c).trim();
    if (names.indexOf(c) !== -1 && picked.indexOf(c) === -1) picked.push(c);
  });
  return picked.slice(0, MAX_COMPETENCIES).join(', ');
}

var analysisConfigCache_ = null;

/** '단원'·'역량' 탭을 읽습니다. 탭이 없으면 기본값으로 만듭니다. */
function analysisConfig_() {
  if (analysisConfigCache_) return analysisConfigCache_;
  var units = {};
  readRows_(getConfigSheet_(UNITS_SHEET, UNIT_HEADERS, DEFAULT_UNITS), UNIT_HEADERS).forEach(function (r) {
    var c = String(r['과목'] || '').trim(), u = String(r['대단원'] || '').trim();
    if (CATEGORIES.indexOf(c) === -1 || !u) return;
    units[c] = units[c] || [];
    if (units[c].indexOf(u) === -1) units[c].push(u);
  });
  var competencies = [];
  readRows_(getConfigSheet_(COMP_SHEET, COMP_HEADERS, DEFAULT_COMPETENCIES), COMP_HEADERS).forEach(function (r) {
    var name = String(r['역량'] || '').trim();
    if (name && !competencies.some(function (c) { return c.name === name; })) {
      competencies.push({ name: name, desc: String(r['설명'] || '').trim() });
    }
  });
  analysisConfigCache_ = { units: units, competencies: competencies };
  return analysisConfigCache_;
}

function getConfigSheet_(name, headers, defaults) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (sheet) return sheet;
  try {
    sheet = getSheet_(name, headers);
    sheet.getRange(2, 1, defaults.length, headers.length).setValues(defaults);
    sheet.autoResizeColumns(1, headers.length);
  } catch (e) {
    // 다른 실행이 같은 탭을 먼저 만든 경우
    sheet = ss.getSheetByName(name);
    if (!sheet) throw e;
  }
  return sheet;
}

function callGeminiJson_(contents, schema, systemText) {
  var text = callGemini_(contents, {
    responseMimeType: 'application/json',
    responseSchema: schema
  }, systemText);
  try {
    return JSON.parse(text);
  } catch (e) {
    // JSON이 아니게 오면 전체를 답변으로 씁니다 (분류는 나중에 다시 시도).
    return { answer: text };
  }
}

/** AI 지침 + (있으면) '자료' 탭의 참고 자료. 과목을 알면 그 과목 자료와 과목 칸이 빈 자료만 보냅니다. */
function systemPrompt_(category) {
  var base = getProp_('SYSTEM_PROMPT', DEFAULT_SYSTEM_PROMPT);
  var ref = referenceText_(category || '');
  if (!ref) return base;
  var rule = referenceOnly_()
    ? '아래 [참고 자료]에 있는 내용만 근거로 답해. 자료에 없는 내용은 지어내거나 네가 아는 지식으로 채우지 말고, ' +
      '"참고 자료에 없는 내용이에요. 학교의 교과 담당 선생님께 물어보세요."라고 답해.'
    : '아래 [참고 자료]에 질문의 답이 있으면 자료에 있는 내용으로만 답해. ' +
      '자료에 답이 없으면 네가 정확히 아는 내용으로 답해. 교과서에 나오는 기본 개념이나 널리 알려진 일반 지식이면 따로 안내하지 마. ' +
      '선생님께 여쭤보라는 말은 기본적으로 쓰지 마. 시험 범위·수행평가·학교 사정처럼 너는 알 수 없고 선생님만 답할 수 있는 질문일 때만 ' +
      '문맥에 맞는 표현으로 한 문장 덧붙이고, 같은 대화에서 이미 했다면 다시 하지 마.';
  return base + '\n\n' + rule + '\n\n[참고 자료]\n' + ref;
}

function referenceOnly_() {
  return getProp_('REFERENCE_ONLY', 'false') === 'true';
}

function referenceText_(category) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName(REF_SHEET)) return '';
  var rows = readRows_(getSheet_(REF_SHEET, REF_HEADERS), REF_HEADERS);
  var text = '';
  rows.forEach(function (r) {
    var body = String(r['내용'] || '').trim();
    var cat = String(r['과목'] || '').trim();
    if (!body) return;
    if (category && cat && cat !== category) return;
    var block = '■ ' + [cat, String(r['제목'] || '').trim()].filter(String).join(' · ') + '\n' + body + '\n\n';
    if (text.length + block.length > MAX_REF_CHARS) {
      console.warn('참고 자료가 너무 길어 일부만 보냅니다 (' + MAX_REF_CHARS + '자 제한).');
      return;
    }
    text += block;
  });
  return text.trim();
}

function callGemini_(contents, generationConfig, systemText) {
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
      systemInstruction: { parts: [{ text: systemText || getProp_('SYSTEM_PROMPT', DEFAULT_SYSTEM_PROMPT) }] },
      contents: contents,
      generationConfig: generationConfig || {}
    })
  };

  // 503(서버 혼잡)·500은 잠깐 기다렸다가 두 번 더 시도합니다.
  // 429(무료 한도 초과)는 다시 해도 한도만 더 쓰므로 바로 멈춥니다.
  var code, body;
  for (var attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) Utilities.sleep(attempt * 3000);
    var res = UrlFetchApp.fetch(url, options);
    code = res.getResponseCode();
    body = res.getContentText();
    if ([500, 503].indexOf(code) === -1) break;
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
        category: validCategory_(rows[i].category),
        unit: String(rows[i].unit || ''), competencies: String(rows[i].competencies || '') };
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
