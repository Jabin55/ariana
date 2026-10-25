# 수업 서버 만들기 — 해외 서버 한 대에 모두 (Hetzner)

**수업 사이트 + 화상 서버(LiveKit) + 데이터베이스**를 월 정액 해외 서버 한 대에 함께 설치합니다.
사용량이 늘어도 요금이 크게 늘지 않고, 학생 정보가 모두 EU(독일·핀란드) 한 곳에 있습니다.

- 서버: [Hetzner Cloud](https://www.hetzner.com/cloud), 시범 운영은 **CX23** 약 월 €6~7 (약 1만 원), 학교 전체는 **CX53** 약 월 €30~37 (아래 '서버 크기')
- 한국에서 독일·핀란드까지 거리 때문에 영상·소리가 약 0.25~0.3초 늦습니다. 강의에는 거의 느껴지지 않고, 모둠 대화는 살짝 어색할 수 있습니다.

## 1. 서버 만들기 (약 15분, 명령어 입력 없음)

1. https://www.hetzner.com/cloud 에서 가입합니다. 결제 수단(카드·PayPal)을 등록하고, 신분 확인을 요청받으면 안내를 따릅니다.
2. 이 폴더의 [`cloud-init.yaml`](cloud-init.yaml) 내용을 복사해 메모장에 붙여 넣고, **맨 위 두 줄**을 채웁니다.
   ```
   ADMIN_EMAILS=내구글이메일@gmail.com
   ALLOWED_DOMAINS=s.myschool.kr
   ```
   (`ADMIN_EMAILS` = 전체 관리자, `ALLOWED_DOMAINS` = 학생 구글 계정의 @ 뒷부분. 나중에 바꿀 수도 있어요.)
3. **Cloud Console → 프로젝트 만들기 → Add Server(서버 추가)** 를 누르고 다음처럼 고릅니다.
   - Location(위치): **Helsinki** 또는 **Falkenstein** / **Nuremberg**
   - Image(운영체제): **Ubuntu 24.04**
   - Type(종류): **Shared vCPU → CX23** (학교 전체라면 CX53)
   - Networking: **Public IPv4** 켜기 (학생 기기 대부분이 IPv4로 접속)
   - SSH keys: 건너뛰어도 됩니다 (root 비밀번호가 메일로 옵니다)
   - **Backups**: 켜기 권장 (서버 요금의 20%, 서버 전체를 매일 다른 곳에 복사)
   - **Cloud config** 칸: 2에서 채운 내용을 **전부 붙여 넣기**
   - Name: `live-class` 같은 이름
4. **Create & Buy now** 를 누릅니다. 서버가 켜지면 자동으로 설치가 진행됩니다(약 5~10분).

## 2. 수업 사이트 주소 확인하고 구글 로그인 연결하기

1. 서버 화면 오른쪽 위 **>_ (Console)** 버튼을 누르고, `root` 와 메일로 받은 비밀번호로 로그인합니다
   (처음 로그인하면 비밀번호를 바꾸라고 합니다).
2. 로그인하면 화면에 바로 안내가 보입니다(안 보이면 `cat /root/live-info.txt`). 아직 없으면 설치 중이니 몇 분 뒤 다시 확인하세요(진행 상황: `tail -f /root/setup.log`).
   ```
   수업 사이트:   https://class.49-12-34-56.sslip.io
   화상 서버:     https://rtc.class.49-12-34-56.sslip.io   (OK 가 보이면 정상)
   ```
3. [Google Cloud 콘솔](https://console.cloud.google.com)에서 **OAuth 클라이언트 ID(웹 애플리케이션)** 를 만들고
   **승인된 JavaScript 원본**에 수업 사이트 주소(`https://class.…`)를 넣습니다. (자세한 순서는 저장소 첫 README의 '설정 순서')
4. 콘솔에 만들어진 ID를 입력합니다.
   ```
   live-config GOOGLE_CLIENT_ID=1234-abcd.apps.googleusercontent.com
   ```
5. 브라우저로 수업 사이트 주소를 열어 구글로 로그인해 봅니다. 전체 관리자 계정이면 '전체 관리' 탭이 보입니다.

> 주소의 `sslip.io` 는 IP 주소만으로 쓰는 **무료 주소**입니다. 학교 도메인(예: `class.myschool.kr`)을 쓰고 싶으면
> DNS에 `class.myschool.kr`, `rtc.class.myschool.kr`, `turn.class.myschool.kr` 세 이름을 서버 IP로 등록한 뒤
> 콘솔에서 `bash /root/setup.sh class.myschool.kr` 를 실행하세요(데이터·설정은 그대로). 구글 콘솔의 JavaScript 원본도 새 주소로 바꿔야 합니다.

## 3. 관리 — 평소에는 할 일이 없습니다

| 상황 | 누가 하나 |
|---|---|
| 서버가 재부팅되거나 프로그램이 멈춤 | 자동으로 다시 켜짐 |
| HTTPS 인증서 갱신 (90일마다) | 자동 |
| 운영체제 보안 업데이트 | 매일 자동 설치, 필요하면 **새벽 4시(한국 시각)** 자동 재부팅 |
| 데이터베이스 백업 | **매일 새벽 3시 30분** 자동, 서버 안 `/opt/live/backups` 에 14일치 (Hetzner Backups를 켜면 서버 밖에도 매일 복사) |
| 서버 하드웨어 고장 | Hetzner가 다른 기계로 옮김 |

콘솔에서 쓰는 명령:

| 명령 | 하는 일 |
|---|---|
| `live-config` | 지금 설정 보기 |
| `live-config 이름=값` | 설정 바꾸기 (예: `live-config SCHOOLS=가나고,다라고`). 바꿀 수 있는 이름은 저장소 첫 README의 표 참고 |
| `live-update` | 수업 사이트를 GitHub의 최신 버전으로 (수업이 없는 시간에) |
| `live-backup` | 지금 바로 백업 |
| `live-restore 백업파일` | 그 백업 시점으로 되돌리기 (되돌리기 전 상태도 자동으로 백업) |

가끔 할 일:
- **결제 카드 유효기간** 확인 (Hetzner가 매달 카드로 청구, 인보이스 PDF는 콘솔에서 내려받아 학교에 청구)
- 학교 도메인을 쓰면 **1년마다 도메인 갱신**
- 권장: [UptimeRobot](https://uptimerobot.com)(무료)에 수업 사이트 주소를 등록해 두면 서버가 멈췄을 때 메일로 알려 줍니다.

문제가 생기면:
1. Hetzner 콘솔에서 서버 **Power → Reset**(재시작). 대부분 이것으로 해결됩니다.
2. 그래도 안 되면 콘솔에 로그인해 `cd /opt/live && docker compose ps` 와 `docker compose logs --tail 50` 로 오류를 확인하세요.
3. 서버를 지우고 다시 만들어야 할 때는 먼저 `/opt/live/backups` 의 최근 백업 파일을 받아 두세요(또는 Hetzner Backups에서 서버째 복원).

## 서버 크기

| 동시에 수업하는 규모 | 권장 서버 | 월 비용 (2026년 6월 가격 인상 반영 추정, 바뀔 수 있음) |
|---|---|---|
| 한두 반 (~40명) | CX23 (2 vCPU, 4GB, 트래픽 20TB) | 약 €6~7 |
| 몇 반 동시 (~200명) | CX33 또는 CX43 | 약 €8~16 |
| 학교 전체 (~1,000명 동시) | CX53 (16 vCPU, 32GB, 20TB) 또는 전용 서버 AX41 (트래픽 무제한) | 약 €30~60 |

- 서버를 바꾸려면 콘솔에서 **Rescale** 로 크기만 올리면 됩니다(설치 다시 할 필요 없음, 1~2분 꺼짐).
- 포함 트래픽(20TB)을 넘으면 1TB당 약 €1이 붙습니다. 데이터 절약 모드를 켜면 한 반 월 5회×4시간은 약 0.2TB입니다.
- 학교 전체 규모로는 아직 시험하지 않았습니다. 처음에는 작게 시작해 늘려 가세요.

## 열리는 포트 (참고)

| 포트 | 용도 |
|---|---|
| 443/tcp | 수업 사이트·화상 서버 접속(HTTPS) + 학교·공공 와이파이에서 UDP가 막혔을 때 우회(TURN/TLS) |
| 80/tcp | HTTPS 인증서 발급 |
| 7881/tcp | UDP가 안 될 때 영상 전송 |
| 3478/udp, 50000–60000/udp | 영상·음성 (가장 빠른 경로) |

데이터베이스(5432)와 수업 사이트 내부 포트(8000)는 서버 안에서만 열려 있어 밖에서 접속할 수 없습니다.
