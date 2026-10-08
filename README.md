# 정치쌤 챗봇

고등학교 **정치** 과목(2022 개정 교육과정)을 공부하는 학생이 질문하고 답변을 받는 웹 챗봇입니다. Claude API를 사용합니다.

- **개념 질의응답**: 교과 개념을 학생 눈높이로 설명하고 헷갈리기 쉬운 점을 짚어 줍니다.
- **문제 풀이·퀴즈**: "문제 내 줘"라고 하면 OX·5지선다·서술형 문제를 내고, 학생 답을 채점·해설합니다.
- **정치적 중립**: 특정 정당·후보를 지지하지 않고, 쟁점은 여러 입장을 균형 있게 소개합니다.

## 실행 방법

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...      # Anthropic 콘솔에서 발급
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

브라우저에서 http://localhost:8000 을 열면 됩니다. 같은 네트워크의 학생들은 `http://<이 컴퓨터 IP>:8000` 으로 접속할 수 있습니다.

## 인터넷에 배포하기 (Render)

이 저장소에는 [Render](https://render.com) 배포 설정(`render.yaml`)이 들어 있습니다.

1. Render에 GitHub 계정으로 가입·로그인합니다.
2. **New → Blueprint** 를 누르고 `jabin55/ariana` 저장소를 선택합니다.
3. `ANTHROPIC_API_KEY` 입력란에 API 키를 넣고 **Apply** 를 누릅니다.
4. 몇 분 뒤 `https://politics-chatbot-xxxx.onrender.com` 같은 주소가 생깁니다. 이 주소를 학생들에게 알려 주면 됩니다.

이후 GitHub 저장소에 코드를 올리면 Render가 자동으로 다시 배포합니다.
무료 요금제는 한동안 접속이 없으면 잠들었다가, 다음 접속 때 깨어나느라 첫 화면이 30초~1분 정도 늦게 뜰 수 있습니다.

## 구성

| 파일 | 역할 |
|---|---|
| `app/prompts.py` | 챗봇의 성격·교과 범위·중립 원칙을 정한 시스템 프롬프트. **수업에 맞게 고치려면 이 파일을 수정하세요.** |
| `app/main.py` | FastAPI 서버. `/api/chat` 에서 Claude 응답을 스트리밍합니다. |
| `static/` | 채팅 화면(HTML/CSS/JS) |

## 설정 (환경 변수)

| 변수 | 기본값 | 설명 |
|---|---|---|
| `ANTHROPIC_API_KEY` | (필수) | Claude API 키 |
| `CHATBOT_MODEL` | `claude-opus-5-5` | 사용할 모델 |
| `CHATBOT_EFFORT` | `low` | 답변 깊이(`low`/`medium`/`high`). 높을수록 느리고 비용이 늘어납니다. |

## 참고

- 대화 기록은 학생 브라우저에만 있고 서버에 저장하지 않습니다. 새로고침하면 사라집니다.
- 정책상 답변이 거절되면 서버에서 다른 모델로 자동 재시도합니다(`fallbacks: "default"`).
- 화면의 마크다운 렌더링 라이브러리(marked, DOMPurify)는 `static/vendor/`에 포함되어 있어 학교망에서 CDN이 막혀도 동작합니다.
- 시스템 프롬프트는 프롬프트 캐싱을 적용해 반복 요청 비용을 줄입니다.
- 학생들에게 공개 배포하려면 로그인이나 접속 제한, 사용량 제한(rate limit)을 추가하는 것을 권장합니다. 현재는 누구나 접속하면 API 비용이 발생합니다.
