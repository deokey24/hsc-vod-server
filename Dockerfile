# ── 빌드 스테이지 ──────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

# ── 런타임 스테이지 ─────────────────────────────────────────
FROM node:20-alpine AS runtime

# FFmpeg 설치 (Alpine 패키지)
RUN apk add --no-cache \
    ffmpeg \
    tzdata \
    && cp /usr/share/zoneinfo/Asia/Seoul /etc/localtime \
    && echo "Asia/Seoul" > /etc/timezone \
    && apk del tzdata

WORKDIR /app

# node_modules 복사 (builder 스테이지에서)
COPY --from=builder /app/node_modules ./node_modules

# 소스 복사
COPY src/       ./src/
COPY public/    ./public/
COPY package.json ./

# HLS 세그먼트 및 로그 디렉터리
RUN mkdir -p /app/hls /app/logs \
    && chown -R node:node /app

# 비root 유저로 실행 (보안)
USER node

# 포트 노출
EXPOSE 1935 8080 9998/udp

# 헬스체크
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD wget -qO- http://localhost:8080/api/metrics || exit 1

CMD ["node", "src/server.js"]
