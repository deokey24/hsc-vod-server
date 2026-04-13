'use strict';

/**
 * streaming-server/src/server.js
 *
 * 역할:
 *  - RTMP 수신 (포트 1935) → FFmpeg 트랜스코딩 → HLS 생성
 *  - Express로 HLS 파일 서빙 (포트 8080)
 *  - WebSocket으로 실시간 메트릭 전송 (포트 8081)
 *  - 대역폭 / 연결 수 / 예상 비용 측정
 */

const NodeMediaServer = require('node-media-server');
const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const MetricsCollector = require('./metrics');

// ──────────────────────────────────────────
// 설정
// ──────────────────────────────────────────
const CONFIG = {
  rtmp: {
    port: 1935,
    chunk_size: 4096,
    gop_cache: true,
    ping: 30,
    ping_timeout: 60,
  },
  http: {
    port: 8080,
    allow_origin: '*',
    mediaroot: path.join(__dirname, '../hls'),
  },
  trans: {
    ffmpeg: process.env.FFMPEG_PATH || '/usr/bin/ffmpeg',
    tasks: [
      {
        app: 'live',
        hls: true,
        hlsFlags: [
          // 720p 30FPS HLS 세그먼트 설정
          '-vf scale=1280:720',
          '-c:v libx264',
          '-preset veryfast',       // CPU 절약 (ultrafast는 화질 저하)
          '-b:v 2500k',             // 720p 적정 비트레이트
          '-maxrate 3000k',
          '-bufsize 6000k',
          '-r 30',                  // 30 FPS
          '-g 60',                  // GOP = 2초 (30fps × 2)
          '-c:a aac',
          '-b:a 128k',
          '-ar 44100',
          '-hls_time 2',            // 세그먼트 2초
          '-hls_list_size 5',       // 최근 5개 세그먼트 유지
          '-hls_flags delete_segments+append_list',
        ].join(' '),
      },
    ],
  },
};

// ──────────────────────────────────────────
// HLS 디렉터리 초기화
// ──────────────────────────────────────────
const HLS_DIR = path.join(__dirname, '../hls');
if (!fs.existsSync(HLS_DIR)) fs.mkdirSync(HLS_DIR, { recursive: true });

// ──────────────────────────────────────────
// 1. RTMP + HLS 서버 (node-media-server)
// ──────────────────────────────────────────
const nms = new NodeMediaServer(CONFIG);

nms.on('preConnect', (id, args) => {
  console.log(`[RTMP] 연결 시도 id=${id}`, args);
});

nms.on('postConnect', (id, args) => {
  console.log(`[RTMP] 연결 성공 id=${id}`);
  metrics.onViewerConnect();
});

nms.on('doneConnect', (id, args) => {
  console.log(`[RTMP] 연결 종료 id=${id}`);
  metrics.onViewerDisconnect();
});

nms.on('prePublish', (id, StreamPath, args) => {
  console.log(`[RTMP] 방송 시작 path=${StreamPath}`);
  metrics.onStreamStart(StreamPath);
});

nms.on('donePublish', (id, StreamPath, args) => {
  console.log(`[RTMP] 방송 종료 path=${StreamPath}`);
  metrics.onStreamEnd(StreamPath);
});

nms.on('prePlay', (id, StreamPath, args) => {
  console.log(`[RTMP] 시청 시작 path=${StreamPath} id=${id}`);
  metrics.onViewerPlay(id, StreamPath);
});

nms.on('donePlay', (id, StreamPath, args) => {
  console.log(`[RTMP] 시청 종료 id=${id}`);
  metrics.onViewerStop(id);
});

// ──────────────────────────────────────────
// 2. Express – HLS 파일 서빙
// ──────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// HLS 파일 서빙 (MIME 타입 명시)
app.use('/hls', (req, res, next) => {
  metrics.onHlsRequest(req);

  if (req.path.endsWith('.m3u8')) {
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache, no-store');
  } else if (req.path.endsWith('.ts')) {
    res.setHeader('Content-Type', 'video/MP2T');
    res.setHeader('Cache-Control', 'public, max-age=86400');
  }
  next();
}, express.static(HLS_DIR));

// 대시보드 정적 파일
app.use('/dashboard', express.static(path.join(__dirname, '../public')));

// ── API 엔드포인트 ──────────────────────────

// 현재 스트림 목록
app.get('/api/streams', (req, res) => {
  const streams = [];
  const liveDir = path.join(HLS_DIR, 'live');
  if (fs.existsSync(liveDir)) {
    fs.readdirSync(liveDir).forEach(name => {
      const m3u8 = path.join(liveDir, name, 'index.m3u8');
      if (fs.existsSync(m3u8)) {
        streams.push({
          name,
          hlsUrl: `/hls/live/${name}/index.m3u8`,
          active: true,
        });
      }
    });
  }
  res.json({ streams });
});

// 실시간 메트릭 스냅샷
app.get('/api/metrics', (req, res) => {
  res.json(metrics.getSnapshot());
});

// 비용 리포트
app.get('/api/cost', (req, res) => {
  res.json(metrics.getCostReport());
});

const httpServer = http.createServer(app);

// ──────────────────────────────────────────
// 3. WebSocket – 실시간 메트릭 스트림
// ──────────────────────────────────────────
const wss = new WebSocket.Server({ server: httpServer, path: '/ws/metrics' });

wss.on('connection', (ws) => {
  console.log('[WS] 대시보드 연결');
  ws.send(JSON.stringify({ type: 'snapshot', data: metrics.getSnapshot() }));

  const interval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'tick', data: metrics.getSnapshot() }));
    }
  }, 1000);

  ws.on('close', () => {
    clearInterval(interval);
    console.log('[WS] 대시보드 연결 해제');
  });
});

// 메트릭 업데이트를 WS 클라이언트에 브로드캐스트
function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

// ──────────────────────────────────────────
// 4. 메트릭 수집기 초기화
// ──────────────────────────────────────────
const metrics = new MetricsCollector({ broadcast });

// ──────────────────────────────────────────
// 서버 시작
// ──────────────────────────────────────────
nms.run();

httpServer.listen(8080, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log('\n======================================');
  console.log('  스트리밍 서버 시작됨');
  console.log('======================================');
  console.log(`  RTMP 입력:  rtmp://${ip}:1935/live/stream`);
  console.log(`  HLS  출력:  http://${ip}:8080/hls/live/stream/index.m3u8`);
  console.log(`  메트릭 API: http://${ip}:8080/api/metrics`);
  console.log(`  대시보드:   http://${ip}:8080/dashboard`);
  console.log(`  WS 메트릭:  ws://${ip}:8080/ws/metrics`);
  console.log('======================================\n');
});

function getLocalIP() {
  try {
    const result = execSync("hostname -I | awk '{print $1}'").toString().trim();
    return result || 'localhost';
  } catch {
    return 'localhost';
  }
}

process.on('SIGINT', () => {
  console.log('\n서버 종료 중...');
  metrics.saveReport();
  process.exit(0);
});
