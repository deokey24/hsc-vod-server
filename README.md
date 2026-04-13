# 실시간 스트리밍 서버 – AWS EC2 구축 가이드

720p 30FPS HLS 스트리밍 서버를 AWS EC2에 구축하고, 시청자 수(1~100명)에 따른 실제 비용을 측정합니다.

---

## 아키텍처

```
OBS (RTMP) → EC2:1935 → FFmpeg (720p/30fps) → HLS 세그먼트
                                                    ↓
                                           Express (포트 8080)
                                                    ↓
                                        시청자 (HLS 플레이어)
                                                    ↓
                                         MetricsCollector
                                         (비용 실시간 계산)
```

---

## 1단계: EC2 인스턴스 생성

### AWS 콘솔에서 설정

```
AMI:           Ubuntu 22.04 LTS
Instance Type: t3.medium (테스트 시작용 – 2vCPU, 4GB RAM)
Storage:       gp3 20GB
```

### Security Group 인바운드 규칙

| 포트  | 프로토콜 | 용도              |
|-------|----------|-------------------|
| 22    | TCP      | SSH               |
| 80    | TCP      | HTTP              |
| 8080  | TCP      | Node.js 서버      |
| 1935  | TCP      | RTMP 입력         |

---

## 2단계: 서버 초기 설정

SSH 접속 후 실행:

```bash
# 스크립트에 실행 권한 부여
chmod +x scripts/setup-ec2.sh

# EC2 초기 설정 (Node.js, FFmpeg, PM2 설치)
./scripts/setup-ec2.sh
```

---

## 3단계: 프로젝트 설치 및 실행

```bash
cd ~/streaming-server
npm install

# PM2로 서버 시작
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # 재부팅 시 자동 시작 설정
```

---

## 4단계: OBS에서 스트림 송출

OBS → 설정 → 방송:

```
서비스:    사용자 지정
서버:      rtmp://YOUR_EC2_PUBLIC_IP:1935/live
스트림 키: stream
```

OBS → 설정 → 출력:

```
출력 형식:    고급
인코더:       x264 (소프트웨어)
비트레이트:   2500 Kbps
키프레임 간격: 2초
프리셋:       veryfast
```

OBS → 설정 → 비디오:

```
기본 해상도: 1280×720
출력 해상도: 1280×720
FPS:         30
```

---

## 5단계: 시청자 URL

```
HLS URL: http://YOUR_EC2_IP:8080/hls/live/stream/index.m3u8

대시보드: http://YOUR_EC2_IP:8080/dashboard
메트릭:   http://YOUR_EC2_IP:8080/api/metrics
비용:     http://YOUR_EC2_IP:8080/api/cost
```

HLS.js 플레이어로 재생하거나, VLC → 미디어 → 네트워크 스트림에서 URL 입력

---

## 6단계: 부하 테스트 (1~100명)

```bash
# 서버에서 실행
node scripts/load-test.js --host http://YOUR_EC2_IP:8080 --stream stream

# 또는 원격 머신에서 실행
node scripts/load-test.js --host http://EC2_PUBLIC_IP:8080 --stream stream
```

테스트는 1 → 5 → 10 → 20 → 30 → 50 → 100명 순으로 자동 진행됩니다.

---

## 예상 비용 (서울 리전 기준)

| 시청자 | 인스턴스    | EC2/hr  | 전송/hr | 합계/hr  | 월 예상(24hr) |
|--------|-------------|---------|---------|----------|---------------|
| 1명    | t3.medium   | $0.0544 | $0.0134 | $0.069   | ₩66,906       |
| 10명   | t3.medium   | $0.0544 | $0.1340 | $0.190   | ₩184,140      |
| 30명   | t3.large    | $0.1088 | $0.4020 | $0.513   | ₩496,602      |
| 50명   | t3.xlarge   | $0.2176 | $0.6700 | $0.890   | ₩861,840      |
| 100명  | t3.2xlarge  | $0.4352 | $1.3400 | $1.778   | ₩1,721,160    |

> ※ 전송 비용: 720p 2.5Mbps × N명, 1 USD = 1,350 KRW

---

## 비용 절감 팁

1. **Reserved Instance**: 1년 약정 시 EC2 비용 40% 절감
2. **CloudFront CDN**: 대용량 트래픽 시 전송 비용 절감 (월 1TB까지 무료)
3. **S3 + CloudFront**: HLS 세그먼트를 S3에 저장하고 CDN 배포
4. **Spot Instance**: 최대 90% 절감 (중단 허용 환경에서)

---

## 모니터링

```bash
# 실시간 로그
pm2 logs streaming-server

# 서버 상태
pm2 status

# 시스템 리소스
htop

# 네트워크 사용량
nethogs
```

---

## API 응답 예시

### GET /api/metrics
```json
{
  "timestamp": 1710000000000,
  "uptime": "00:05:30",
  "isStreaming": true,
  "viewers": { "current": 10, "peak": 15 },
  "bandwidth": { "outboundMbps": 25.0, "totalGB": 0.45 },
  "cost": { "currentUSD": 0.000123, "currentKRW": 166 }
}
```

### GET /api/cost
```json
{
  "current": {
    "totalCost": 0.000456,
    "totalCostKRW": 616
  },
  "scenarios": [
    { "viewers": 1,   "totalPerHour": 0.069, "totalPerHourKRW": 93 },
    { "viewers": 100, "totalPerHour": 1.778, "totalPerHourKRW": 2400 }
  ]
}
```
