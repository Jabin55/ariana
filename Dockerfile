# 실시간 수업 사이트 (수업 서버 한 대에 화상 서버와 함께 설치할 때 사용: deploy/server/setup.sh)
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
COPY static ./static
# root가 아닌 사용자로 실행
RUN useradd --system --uid 10001 web && mkdir -p /srv/slides /srv/files && chown web /srv/slides /srv/files
USER web
ENV SLIDES_DIR=/srv/slides FILES_DIR=/srv/files
CMD ["uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8000", "--forwarded-allow-ips", "127.0.0.1", "--timeout-graceful-shutdown", "10"]
