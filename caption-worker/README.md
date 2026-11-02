# 별도 EU 자막 서버

실시간 수업의 **교사 마이크** 음성을 4초 단위로 받아 한국어 자막을 만듭니다. 음성과 자막은 파일·DB에 저장하지 않습니다. 학생 음성은 보내지 않습니다.

## 운영 구성

1. 별도 EU 서버를 준비합니다. Whisper `small` 모델을 CPU로 실행하므로 **4 vCPU·8 GB RAM 이상**에서 먼저 시험하십시오. 동시 수업 수와 서버 성능에 따라 지연이 달라집니다. 이 구성은 한 번에 한 음성 조각을 인식합니다.
2. 자막 서버의 공개 IP에 연결되는 호스트명을 준비합니다. 예: `caption.example.org`. 서버의 80·443 포트는 Caddy 인증서 발급과 HTTPS 접속을 위해 열고, **8090 포트는 외부에 열지 않습니다**.
3. 이 디렉터리를 자막 서버로 복사합니다. 실제 운영값을 `.env`에 적습니다. `SITE_PUBLIC_IP`는 **외솔온닷 사이트 서버의 공개 IP**입니다. Caddy는 이 IP에서 온 요청만 음성인식 서비스로 전달합니다.

   ```bash
   umask 077
   cp .env.example .env
   # .env의 CAPTION_HOST, SITE_PUBLIC_IP를 실제 값으로 수정
   printf 'CAPTION_WORKER_TOKEN=%s\n' "$(openssl rand -hex 32)" > worker.env
   docker compose up -d --build
   ```

   처음 시작할 때 Whisper 모델을 내려받아 메모리에 올립니다. 모델 다운로드에 초기 인터넷 연결이 필요합니다. 토큰과 `.env`는 GitHub에 올리지 마십시오.

4. 사이트 서버에서 새 사이트 코드를 `live-update`로 반영한 다음, 자막 서버의 `worker.env`에 저장한 토큰을 사이트 서버의 설정에 입력합니다. 토큰 자체를 채팅에 보내지 말고 두 서버의 관리자 콘솔에서만 취급하십시오.

   ```bash
   read -rs -p '자막 서버 토큰: ' CAPTION_SECRET; echo
   live-config CAPTION_WORKER_URL=https://caption.example.org "CAPTION_WORKER_TOKEN=$CAPTION_SECRET"
   unset CAPTION_SECRET
   ```

   `caption.example.org`를 실제 자막 서버 호스트명으로 바꾸십시오. 사이트 서버는 HTTPS 주소만 사용합니다.

5. 교사 화면에서 마이크를 켠 뒤 **자막 켜기**를 누릅니다. 학생 화면에는 자막과 **자막 숨기기** 버튼이 보입니다. 시험 수업에서 인식 지연과 정확도를 확인하십시오.

자막은 일시적인 화면 표시이며 녹화·출결·수업 기록에 포함되지 않습니다. 음성인식 서버를 설정하지 않은 동안 자막 버튼은 표시되지 않습니다. 접근 IP 제한과 공유 토큰을 함께 적용하고, 토큰은 정기적으로 교체하십시오.
