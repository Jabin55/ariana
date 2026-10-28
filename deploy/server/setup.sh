#!/usr/bin/env bash
# 실시간 수업 서버 설치 스크립트 — 수업 사이트 + 화상 서버(LiveKit) + 데이터베이스를 서버 한 대에
#
# 새로 만든 Ubuntu 24.04 서버에서 root로 한 번만 실행하면 된다.
#   bash setup.sh                     → 무료 주소(class.…sslip.io)를 자동으로 사용
#   bash setup.sh class.myschool.kr   → 내 도메인 사용. class.myschool.kr, rtc.class.myschool.kr,
#                                       turn.class.myschool.kr 세 이름이 이 서버 IP를 가리키도록
#                                       DNS(A 레코드)를 먼저 만들어 둘 것
#
# 하는 일: Docker 설치 → 방화벽 → 보안 업데이트 자동 설치(새벽 4시 자동 재부팅)
#         → 수업 사이트 코드 내려받기 → 데이터베이스(PostgreSQL)·수업 사이트·화상 서버·Caddy(HTTPS 자동) 실행
#         → 매일 새벽 3시 30분 데이터베이스 백업 → 접속 정보 출력
# 다시 실행해도 안전하다(키·비밀번호·설정은 처음 만든 것을 그대로 쓴다).
set -euo pipefail

LIVEKIT_IMAGE="livekit/livekit-server:v1.13.10"
CADDY_IMAGE="livekit/caddyl4:v2.11.3"
POSTGRES_IMAGE="postgres:16-alpine"
REPO="${LIVE_REPO:-https://github.com/Jabin55/ariana.git}"
BRANCH="${LIVE_BRANCH:-}"  # 비우면 저장소 기본 브랜치
DIR="${LIVE_DIR:-/opt/live}"
BIN="${LIVE_BIN:-/usr/local/bin}"
INFO="${LIVE_INFO:-/root/live-info.txt}"
SETTINGS="${LIVE_SETTINGS:-/root/live-settings.env}"  # cloud-init 에서 미리 채운 설정 (있으면)
SKIP_SYSTEM="${SKIP_SYSTEM:-0}"  # 1이면 설정 파일만 만든다 (시험용)

log() { echo -e "\n\033[1;34m▶ $*\033[0m"; }
rand() { openssl rand -base64 64 | tr -dc 'A-Za-z0-9' | head -c "$1"; }

IP="${SERVER_IP:-$(curl -4 -fsS --max-time 10 https://api.ipify.org || hostname -I | awk '{print $1}')}"
# 주소: 적으면 그 도메인, 안 적으면 지난번 주소(없으면 무료 주소) — 다시 실행해도 내 도메인이 풀리지 않게
SAVED_SITE="$(cat "$DIR/site" 2>/dev/null || true)"
SITE="${1:-${SAVED_SITE:-class.${IP//./-}.sslip.io}}"
RTC="rtc.$SITE"
TURN="turn.$SITE"
mkdir -p "$DIR" "$DIR/backups" "$DIR/slides" "$DIR/files"
echo "$SITE" > "$DIR/site"
chmod 700 "$DIR" "$DIR/backups"  # 학생 개인정보(백업)가 들어 있으므로 관리자만

# ── 키·비밀번호: 처음 한 번 만들고 계속 같은 것을 쓴다
if [ -f "$DIR/keys.env" ]; then
  # shellcheck disable=SC1091
  source "$DIR/keys.env"
else
  API_KEY="API$(openssl rand -hex 6)"
  API_SECRET="$(rand 48)"
  SECRET_KEY="$(rand 48)"
  DB_PASSWORD="$(rand 32)"
  printf 'API_KEY=%s\nAPI_SECRET=%s\nSECRET_KEY=%s\nDB_PASSWORD=%s\n' \
    "$API_KEY" "$API_SECRET" "$SECRET_KEY" "$DB_PASSWORD" > "$DIR/keys.env"
  chmod 600 "$DIR/keys.env"
fi

# ── 선생님이 바꾸는 설정 (처음 한 번만 만든다. 이후에는 live-config 로 고친다)
SETTING_NAMES="GOOGLE_CLIENT_ID ADMIN_EMAILS ALLOWED_DOMAINS TEACHER_EMAILS SCHOOLS ANTHROPIC_API_KEY LOW_BANDWIDTH MIC_LOCK OPERATOR_NAME PRIVACY_OFFICER PRIVACY_CONTACT RETENTION EVIDENCE_RETENTION_DAYS EVIDENCE_RETENTION_BASIS SERVER_REGION GOOGLE_API_KEY GOOGLE_APP_ID ALLOW_RECORDING CONSENT_TO NEIS_API_KEY CHATBOT_MODEL"
if [ ! -f "$DIR/app.env" ]; then
  {
    echo "# 수업 사이트 설정. 바꾸려면 콘솔에서:  live-config 이름=값   (예: live-config ADMIN_EMAILS=me@gmail.com)"
    for name in GOOGLE_CLIENT_ID ADMIN_EMAILS ALLOWED_DOMAINS TEACHER_EMAILS SCHOOLS ANTHROPIC_API_KEY \
                OPERATOR_NAME PRIVACY_OFFICER PRIVACY_CONTACT; do
      value=""
      if [ -f "$SETTINGS" ]; then
        value="$(grep -E "^$name=" "$SETTINGS" | tail -n 1 | cut -d= -f2- | tr -d '\r' || true)"
      fi
      echo "$name=$value"
    done
  } > "$DIR/app.env"
  chmod 600 "$DIR/app.env"
fi

# ── 설치 스크립트가 관리하는 설정 (다시 실행할 때마다 새로 쓴다. app.env 보다 우선)
cat > "$DIR/auto.env" <<EOF
# 자동 생성됨 (setup.sh). 고치지 마세요.
APP_MODE=live
COOKIE_SECURE=1
SECRET_KEY=$SECRET_KEY
DATABASE_URL=postgresql://live:$DB_PASSWORD@127.0.0.1:5432/live
LIVEKIT_URL=wss://$RTC
LIVEKIT_API_KEY=$API_KEY
LIVEKIT_API_SECRET=$API_SECRET
EOF
chmod 600 "$DIR/auto.env"

if [ "$SKIP_SYSTEM" != "1" ]; then
  log "프로그램 설치 (Docker, 방화벽, 자동 보안 업데이트)"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y docker.io docker-compose-v2 docker-buildx ufw unattended-upgrades curl openssl git
  systemctl enable --now docker
  timedatectl set-timezone Asia/Seoul || true

  # 보안 업데이트는 매일 자동 설치, 필요하면 새벽 4시(한국 시각)에 자동 재부팅 → 관리할 필요 없음
  cat > /etc/apt/apt.conf.d/52live-class-auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:00";
EOF

  log "방화벽 설정"
  ufw allow 22/tcp          # 관리용 접속
  ufw allow 80/tcp          # HTTPS 인증서 발급
  ufw allow 443/tcp         # 수업 사이트·화상 서버 접속 + 학교망 우회(TURN/TLS)
  ufw allow 7881/tcp        # UDP가 막힌 곳에서 영상 전송
  ufw allow 3478/udp        # TURN
  ufw allow 50000:60000/udp # 영상·음성
  ufw --force enable        # 데이터베이스(5432)·수업 사이트(8000)는 서버 안에서만 열려 있다

  log "수업 사이트 코드 내려받기"
  if [ -d "$DIR/src/.git" ]; then
    git -C "$DIR/src" pull --ff-only
  else
    git clone --depth 1 ${BRANCH:+--branch "$BRANCH"} "$REPO" "$DIR/src"
  fi
fi

log "설정 파일 만들기 ($DIR)"
cat > "$DIR/livekit.yaml" <<EOF
# 자동 생성됨 (setup.sh). 고친 뒤에는: cd $DIR && docker compose restart livekit
port: 7880
bind_addresses:
  - ""
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 60000
  use_external_ip: true
  enable_loopback_candidate: false
turn:
  enabled: true
  domain: $TURN
  tls_port: 5349
  udp_port: 3478
  external_tls: true
  proxy_protocol: true
keys:
  $API_KEY: $API_SECRET
logging:
  level: info
EOF
chmod 600 "$DIR/livekit.yaml"

# Caddy: 443 포트 하나로 들어온 연결을 이름(SNI)에 따라 수업 사이트·화상 서버·TURN으로 나눈다.
# 인증서는 Let's Encrypt에서 자동으로 받고 자동으로 갱신한다.
cat > "$DIR/caddy.yaml" <<EOF
logging:
  logs:
    default:
      level: INFO
storage:
  module: file_system
  root: /data
apps:
  tls:
    certificates:
      automate:
        - $SITE
        - $RTC
        - $TURN
  layer4:
    servers:
      main:
        listen: [":443"]
        routes:
          - match:
              - tls:
                  sni: ["$TURN"]
            handle:
              - handler: tls
              - handler: proxy
                proxy_protocol: v2
                upstreams:
                  - dial: ["localhost:5349"]
          - match:
              - tls:
                  sni: ["$RTC"]
            handle:
              - handler: tls
                connection_policies:
                  - alpn: ["http/1.1"]
              - handler: proxy
                upstreams:
                  - dial: ["localhost:7880"]
          - match:
              - tls:
                  sni: ["$SITE"]
            handle:
              - handler: tls
                connection_policies:
                  - alpn: ["http/1.1"]
              - handler: proxy
                proxy_protocol: v2  # 접속한 사람의 실제 IP를 안쪽으로 넘긴다 (접속기록용)
                upstreams:
                  - dial: ["127.0.0.1:8001"]
  http:
    servers:
      site:
        # 수업 사이트 안쪽 관문: 실제 IP를 X-Forwarded-For 로 붙여 앱(8000)에 넘긴다.
        # 바깥에서 보낸 X-Forwarded-For 는 믿지 않고 덮어쓴다.
        listen: ["127.0.0.1:8001"]
        listener_wrappers:
          - wrapper: proxy_protocol
            allow: ["127.0.0.1/32"]
        automatic_https:
          disable: true
        routes:
          - handle:
              - handler: reverse_proxy
                flush_interval: -1
                upstreams:
                  - dial: "127.0.0.1:8000"
                headers:
                  request:
                    set:
                      X-Forwarded-Proto: ["https"]
EOF

cat > "$DIR/docker-compose.yaml" <<EOF
# 자동 생성됨 (setup.sh). 서버가 재부팅되면 모두 자동으로 다시 켜진다.
# 로그는 서비스마다 10MB × 3개까지만 남긴다 (디스크가 차지 않게, 접속 기록을 오래 두지 않게)
x-logging: &logging
  driver: json-file
  options:
    max-size: "10m"
    max-file: "3"
services:
  caddy:
    image: $CADDY_IMAGE
    command: run --config /etc/caddy.yaml --adapter yaml
    logging: *logging
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./caddy.yaml:/etc/caddy.yaml:ro
      - ./caddy_data:/data
  livekit:
    image: $LIVEKIT_IMAGE
    command: --config /etc/livekit.yaml
    logging: *logging
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./livekit.yaml:/etc/livekit.yaml:ro
  db:
    image: $POSTGRES_IMAGE
    command: ["postgres", "-c", "listen_addresses=127.0.0.1", "-c", "max_connections=60"]
    logging: *logging
    restart: unless-stopped
    network_mode: host
    environment:
      POSTGRES_USER: live
      POSTGRES_DB: live
      POSTGRES_PASSWORD: $DB_PASSWORD
    volumes:
      - ./pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD", "pg_isready", "-h", "127.0.0.1", "-U", "live"]
      interval: 5s
      retries: 30
  app:
    build: ./src
    image: live-class-app
    logging: *logging
    restart: unless-stopped
    network_mode: host
    env_file: [app.env, auto.env]
    volumes:
      - ./slides:/srv/slides   # 수업 자료(PDF)
      - ./files:/srv/files     # 학생 과제 제출 파일
    depends_on:
      db:
        condition: service_healthy
EOF

# ── 관리용 명령 (콘솔에서 바로 쓸 수 있게)
mkdir -p "$BIN"
cat > "$BIN/live-config" <<EOF
#!/usr/bin/env bash
# 수업 사이트 설정 보기·바꾸기
#   live-config                          → 지금 설정 보기
#   live-config ADMIN_EMAILS=a@gmail.com  → 바꾸고 수업 사이트 다시 시작 (여러 개를 한 번에 적어도 됨)
set -euo pipefail
DIR="$DIR"
ALLOWED="$SETTING_NAMES"
if [ \$# -eq 0 ]; then
  sed -E 's/^(ANTHROPIC_API_KEY=.{6}).+/\1…(가림)/' "\$DIR/app.env"
  echo; echo "바꿀 수 있는 이름: \$ALLOWED"
  exit 0
fi
for pair in "\$@"; do
  name="\${pair%%=*}"; value="\${pair#*=}"
  if [ "\$name" = "\$pair" ] || ! [[ " \$ALLOWED " == *" \$name "* ]]; then
    echo "알 수 없는 설정: \$pair  (바꿀 수 있는 이름: \$ALLOWED)"; exit 1
  fi
  value="\$(printf '%s' "\$value" | tr -d '\r\n')"
  tmp="\$(mktemp)"
  grep -v -E "^\$name=" "\$DIR/app.env" > "\$tmp" || true
  printf '%s=%s\n' "\$name" "\$value" >> "\$tmp"
  cat "\$tmp" > "\$DIR/app.env"; rm -f "\$tmp"
  echo "✔ \$name 을(를) 바꿨어요."
done
if [ "\${LIVE_NO_RESTART:-0}" != "1" ]; then
  cd "\$DIR" && docker compose up -d app >/dev/null && echo "수업 사이트를 다시 시작했어요 (진행 중인 수업은 학생 화면이 자동으로 다시 연결돼요)."
fi
EOF

cat > "$BIN/live-update" <<EOF
#!/usr/bin/env bash
# 수업 사이트를 GitHub의 최신 버전으로 올린다 (수업이 없는 시간에 실행할 것)
# 설정 파일·관리 명령도 새 버전에 맞춰 다시 만든다 (키·주소·선생님 설정은 그대로)
set -euo pipefail
cd "$DIR"
git -C src pull --ff-only
before=\$(sha256sum caddy.yaml 2>/dev/null || true)
LIVE_DIR="$DIR" LIVE_BIN="$BIN" SKIP_SYSTEM=1 bash src/deploy/server/setup.sh >/dev/null
docker compose build app
docker compose up -d
if [ "\$before" != "\$(sha256sum caddy.yaml)" ]; then docker compose restart caddy >/dev/null; fi  # 연결 설정이 바뀌었으면 적용
echo "✅ 최신 버전으로 올렸어요."
EOF

cat > "$BIN/live-backup" <<EOF
#!/usr/bin/env bash
# 데이터베이스 백업 (매일 새벽 3시 30분 자동 실행, 14일치 보관)
set -euo pipefail
umask 077
cd "$DIR"
f="backups/live-\$(date +%Y%m%d-%H%M).sql.gz"
docker compose exec -T db pg_dump -U live live | gzip > "\$f.tmp" && mv "\$f.tmp" "\$f"
find backups -name 'live-*.sql.gz' -mmin +20160 -delete
echo "백업: $DIR/\$f"
EOF
cat > "$BIN/live-restore" <<EOF
#!/usr/bin/env bash
# 백업으로 되돌리기:  live-restore $DIR/backups/live-20260301-0330.sql.gz
# 지금 데이터베이스 내용은 모두 지워지고 그 백업 시점으로 돌아간다 (되돌리기 전 상태도 따로 백업해 둔다).
set -euo pipefail
f="\${1:-}"
[ -f "\$f" ] || { echo "백업 파일을 적어 주세요. 예: live-restore \$(ls -t $DIR/backups/*.sql.gz 2>/dev/null | head -n 1)"; exit 1; }
if [ "\${LIVE_YES:-0}" != "1" ]; then
  read -r -p "지금 데이터를 \$(basename "\$f") 시점으로 되돌릴까요? 진행 중인 수업은 끊겨요. (yes 입력) " a
  [ "\$a" = "yes" ] || { echo "취소했어요."; exit 1; }
fi
"$BIN/live-backup" >/dev/null && echo "되돌리기 전 상태도 백업해 두었어요."
cd "$DIR"
docker compose stop app
docker compose exec -T db psql -q -U live -d postgres -c "DROP DATABASE live WITH (FORCE)" -c "CREATE DATABASE live OWNER live"
gunzip -c "\$f" | docker compose exec -T db psql -q -U live -d live -v ON_ERROR_STOP=1 >/dev/null
docker compose up -d app
echo "✅ \$(basename "\$f") 시점으로 되돌렸어요."
EOF
chmod 755 "$BIN/live-config" "$BIN/live-update" "$BIN/live-backup" "$BIN/live-restore"

cat > "$INFO" <<EOF
━━━━━━━━━━━━━━━━━━ 실시간 수업 서버 ━━━━━━━━━━━━━━━━━━
수업 사이트:   https://$SITE
화상 서버:     https://$RTC   (OK 가 보이면 정상)

[처음 한 번] 구글 로그인 연결
  1) Google Cloud Console → API 및 서비스 → 사용자 인증 정보
     → OAuth 클라이언트 ID 만들기(웹 애플리케이션)
     → 승인된 JavaScript 원본에  https://$SITE  추가
  2) 받은 클라이언트 ID를 이 콘솔에 입력:
     live-config GOOGLE_CLIENT_ID=….apps.googleusercontent.com
  3) 전체 관리자·학생 계정 도메인도 확인:
     live-config ADMIN_EMAILS=내이메일@gmail.com ALLOWED_DOMAINS=학생계정도메인
  4) 개인정보 처리방침에 들어갈 학교 정보:
     live-config OPERATOR_NAME="○○고등학교" PRIVACY_OFFICER="교감 홍길동" PRIVACY_CONTACT="02-000-0000"
     확인: https://$SITE/live/privacy  ·  보호자 안내문(인쇄용): https://$SITE/live/notice

자주 쓰는 명령
  live-config            지금 설정 보기 / live-config 이름=값 으로 바꾸기
  live-update            수업 사이트를 최신 버전으로 (수업 없는 시간에)
  live-backup            지금 바로 백업 (매일 새벽 3:30 자동, $DIR/backups 에 14일치)
  live-restore 파일      백업 시점으로 되돌리기
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EOF
chmod 600 "$INFO"

if [ "$SKIP_SYSTEM" = "1" ]; then
  cat "$INFO"
  exit 0
fi

# 매일 새벽 3시 30분(한국 시각) 백업 — 4시 자동 재부팅보다 먼저
echo "30 3 * * * root $BIN/live-backup >> /var/log/live-backup.log 2>&1" > /etc/cron.d/live-backup
chown 10001 "$DIR/slides" "$DIR/files"  # 수업 사이트(root가 아닌 사용자)가 수업 자료·과제 파일을 저장하는 곳
cp "$INFO" /etc/motd       # 콘솔에 로그인하면 바로 보이게

log "수업 서버 시작 (처음에는 5~10분 걸려요)"
cd "$DIR"
for i in 1 2 3 4 5; do  # Docker Hub가 일시적으로 거절할 때를 대비해 다시 시도
  docker compose pull caddy livekit db && break
  sleep $((i * 20))
done
docker compose build app
docker compose up -d

log "HTTPS 인증서 발급과 수업 사이트 시작을 기다리는 중 (보통 1~2분)"
ok=0
for _ in $(seq 1 72); do
  if curl -fsS --max-time 5 "https://$RTC" 2>/dev/null | grep -q OK \
     && curl -fsS --max-time 5 "https://$SITE/api/me" 2>/dev/null | grep -q google_client_id; then ok=1; break; fi
  sleep 5
done

cat "$INFO"
if [ "$ok" = "1" ]; then
  echo "✅ 설치 완료: 수업 사이트와 화상 서버가 정상 동작합니다."
else
  echo "⚠️  아직 https://$SITE 에 연결되지 않습니다. 도메인(DNS)이 이 서버 IP($IP)를 가리키는지 확인하고,"
  echo "    몇 분 뒤 브라우저로 다시 열어 보세요. 로그 확인: cd $DIR && docker compose logs --tail 50"
fi
