'use strict';

require('dotenv').config();

const NodeMediaServer = require('node-media-server');
const express         = require('express');
const cors            = require('cors');
const http            = require('http');
const WebSocket       = require('ws');
const path            = require('path');
const fs              = require('fs');
const { spawn }       = require('child_process');
const os              = require('os');

const MetricsCollector = require('./metrics');

// ── FFmpeg 경로 감지 ───────────────────────────────────────
function detectFFmpeg() {
  if (process.env.FFMPEG_PATH) {
    return process.env.FFMPEG_PATH.replace(/\r|\n|"/g, '').trim();
  }
  const candidates = {
    win32:  ['C:\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\ffmpeg-8.1-full_build\\bin\\ffmpeg.exe', 'ffmpeg'],
    darwin: ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'],
    linux:  ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'],
  };
  for (const p of (candidates[process.platform] || ['ffmpeg'])) {
    try {
      require('child_process').execSync('"' + p + '" -version', { stdio: 'ignore' });
      console.log('[FFmpeg] 감지됨: ' + p);
      return p;
    } catch (_) {}
  }
  return 'ffmpeg';
}

const FFMPEG_BIN = detectFFmpeg();
const HLS_DIR    = path.join(__dirname, '../hls');
const PORT_NMS   = 8080;   // node-media-server 전용 — 환경변수 금지 (NMS가 PORT를 가로챔)
const PORT_API   = parseInt(process.env.API_PORT)  || 8888;  // Express 전용
const PORT_RTMP  = parseInt(process.env.RTMP_PORT) || 1935;

fs.mkdirSync(HLS_DIR, { recursive: true });

// ── node-media-server: RTMP 수신 전용 (trans 블록 제거) ───
const nms = new NodeMediaServer({
  rtmp: { port: PORT_RTMP, chunk_size: 4096, gop_cache: true, ping: 30, ping_timeout: 60 },
  http: { port: PORT_NMS,  allow_origin: '*', mediaroot: HLS_DIR },
});

// ── FFmpeg 프로세스 관리 ──────────────────────────────────
const ffmpegProcs = new Map();

function spawnFFmpeg(streamPath) {
  if (ffmpegProcs.has(streamPath)) return;

  const streamKey = streamPath.replace(/^\/|\/$/g, '').replace(/\//g, '_');
  const outDir    = path.join(HLS_DIR, 'live', streamKey);
  fs.mkdirSync(outDir, { recursive: true });

  const m3u8     = path.join(outDir, 'index.m3u8');
  const segPat   = path.join(outDir, 'seg%03d.ts');
  const inputUrl = 'rtmp://127.0.0.1:' + PORT_RTMP + streamPath;

  const args = [
    '-i', inputUrl,
    '-vf', 'scale=1280:720',
    '-c:v', 'libx264', '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-b:v', '2500k', '-maxrate', '3000k', '-bufsize', '3000k',
    '-r', '30', '-g', '30', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
    '-f', 'hls',
    '-hls_time', '1',
    '-hls_list_size', '3',
    '-hls_flags', 'delete_segments+append_list+omit_endlist',
    '-hls_segment_filename', segPat,
    m3u8,
  ];

  console.log('[FFmpeg] 시작: ' + streamPath);
  const proc = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  ffmpegProcs.set(streamPath, proc);

  proc.stderr.on('data', function(d) {
    const line = d.toString().trim();
    if (line.includes('frame=') || line.includes('fps=')) {
      process.stdout.write('\r[FFmpeg] ' + line.slice(0, 80));
    }
  });

  proc.on('close', function(code) {
    console.log('\n[FFmpeg] 종료 code=' + code);
    ffmpegProcs.delete(streamPath);
  });

  proc.on('error', function(err) {
    console.error('[FFmpeg] 실행 오류: ' + err.message);
    console.error('  FFMPEG_PATH 확인: ' + FFMPEG_BIN);
    ffmpegProcs.delete(streamPath);
  });
}

function killFFmpeg(streamPath) {
  const proc = ffmpegProcs.get(streamPath);
  if (proc) { proc.kill('SIGKILL'); ffmpegProcs.delete(streamPath); }
}

// ── NMS 이벤트 ───────────────────────────────────────────
nms.on('prePublish',  function(id, sp) { metrics.onStreamStart(sp); setTimeout(function(){ spawnFFmpeg(sp); }, 1000); });
nms.on('donePublish', function(id, sp) { metrics.onStreamEnd(sp);   killFFmpeg(sp); });
nms.on('prePlay',     function(id, sp) { metrics.onViewerPlay(id, sp); });
nms.on('donePlay',    function(id)     { metrics.onViewerStop(id); });
nms.on('postConnect', function()       { metrics.onViewerConnect(); });
nms.on('doneConnect', function()       { metrics.onViewerDisconnect(); });

// ── Express ──────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

app.use('/hls', function(req, res, next) {
  metrics.onHlsRequest(req);
  if (req.path.endsWith('.m3u8')) {
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  } else if (req.path.endsWith('.ts')) {
    res.setHeader('Content-Type', 'video/MP2T');
    res.setHeader('Cache-Control', 'public, max-age=30');
  }
  next();
}, express.static(HLS_DIR));

app.use('/dashboard', express.static(path.join(__dirname, '../public')));
app.get('/', function(_, res) { res.redirect('/dashboard'); });
app.get('/api/metrics', function(_, res) { res.json(metrics.getSnapshot()); });
app.get('/api/cost',    function(_, res) { res.json(metrics.getCostReport()); });
app.get('/api/streams', function(_, res) {
  var liveDir = path.join(HLS_DIR, 'live');
  var streams = [];
  if (fs.existsSync(liveDir)) {
    fs.readdirSync(liveDir).forEach(function(name) {
      if (fs.existsSync(path.join(liveDir, name, 'index.m3u8'))) {
        streams.push({ name: name, hlsUrl: '/hls/live/' + name + '/index.m3u8', active: true });
      }
    });
  }
  res.json({ streams: streams });
});

// ── WebSocket ─────────────────────────────────────────────
const httpServer = http.createServer(app);
const wss = new WebSocket.Server({ server: httpServer, path: '/ws/metrics' });

wss.on('connection', function(ws) {
  ws.send(JSON.stringify({ type: 'snapshot', data: metrics.getSnapshot() }));
  var iv = setInterval(function() {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'tick', data: metrics.getSnapshot() }));
    }
  }, 1000);
  ws.on('close', function() { clearInterval(iv); });
});

function broadcast(data) {
  wss.clients.forEach(function(c) {
    if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify(data));
  });
}

const metrics = new MetricsCollector({ broadcast: broadcast });

// ── 로컬 IP ───────────────────────────────────────────────
function getLocalIP() {
  var nets = os.networkInterfaces();
  for (var name of Object.keys(nets)) {
    for (var net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

// ── 서버 시작 ─────────────────────────────────────────────
nms.run();

httpServer.listen(PORT_API,  '0.0.0.0', function() {
  var ip = getLocalIP();
  console.log('\n======================================');
  console.log('  스트리밍 서버 시작됨');
  console.log('======================================');
  console.log('  RTMP 입력:  rtmp://' + ip + ':' + PORT_RTMP + '/<앱>/<키>');
  console.log('  HLS  출력:  http://' + ip + ':' + PORT_API  + '/hls/live/<앱>_<키>/index.m3u8');
  console.log('  대시보드:   http://' + ip + ':' + PORT_API  + '/dashboard');
  console.log('  메트릭 API: http://' + ip + ':' + PORT_API  + '/api/metrics');
  console.log('  FFmpeg:     ' + FFMPEG_BIN);
  console.log('======================================\n');
});

// ── 종료 처리 ─────────────────────────────────────────────
function shutdown() {
  console.log('\n서버 종료 중...');
  ffmpegProcs.forEach(function(proc) { proc.kill('SIGKILL'); });
  metrics.saveReport();
  process.exit(0);
}
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);
