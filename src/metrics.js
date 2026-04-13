'use strict';

/**
 * streaming-server/src/metrics.js
 *
 * 대역폭 / 시청자 수 / AWS 비용을 실시간으로 측정하고 계산합니다.
 *
 * AWS 비용 기준 (서울 리전 ap-northeast-2):
 *   - EC2 t3.medium:    $0.0544/hr
 *   - EC2 t3.large:     $0.1088/hr
 *   - EC2 t3.xlarge:    $0.2176/hr
 *   - 데이터 전송(아웃):  $0.126/GB (처음 10TB)
 *   - EBS gp3 20GB:     ~$0.0128/hr (≈ $1.6/month ÷ 720hr)
 */

const os = require('os');
const fs = require('fs');
const path = require('path');

// ──────────────────────────────────────────
// AWS 비용 상수 (서울 리전 기준)
// ──────────────────────────────────────────
const AWS_PRICING = {
  ec2: {
    't3.micro':   0.0136,
    't3.small':   0.0272,
    't3.medium':  0.0544,
    't3.large':   0.1088,
    't3.xlarge':  0.2176,
    't3.2xlarge': 0.4352,
    'c5.large':   0.096,
    'c5.xlarge':  0.192,
  },
  // 아웃바운드 데이터 전송 (첫 10TB/월)
  dataTransferPerGB: 0.126,
  // EBS gp3 ($/GB/월) → 시간당
  ebsGp3PerGBMonth: 0.0912,
  ebsVolumeSizeGB: 20,
};

// 720p 30FPS 스트림의 예상 비트레이트
const STREAM_BITRATE_MBPS = 2.5 + 0.128; // video + audio (Mbps)

class MetricsCollector {
  constructor({ broadcast, instanceType = 't3.medium' } = {}) {
    this.broadcast = broadcast || (() => {});
    this.instanceType = instanceType;

    this.startTime = Date.now();
    this.activeViewers = new Set();
    this.viewerHistory = [];     // { time, count }
    this.hlsRequestCount = 0;
    this.totalBytesSent = 0;     // bytes
    this.isStreaming = false;
    this.streamPath = null;
    this.streamStartTime = null;
    this.peakViewers = 0;

    // HLS 요청별 바이트 추적 (세그먼트 파일 크기로 추정)
    this.segmentSizeCache = new Map();

    // 주기적 샘플링 (1초마다)
    this._sampleInterval = setInterval(() => this._sample(), 1000);

    // 리포트 저장 디렉터리
    this._reportDir = path.join(__dirname, '../logs');
    if (!fs.existsSync(this._reportDir)) {
      fs.mkdirSync(this._reportDir, { recursive: true });
    }

    console.log(`[Metrics] 초기화 완료 (instanceType: ${instanceType})`);
  }

  // ────────── 이벤트 핸들러 ──────────────

  onStreamStart(streamPath) {
    this.isStreaming = true;
    this.streamPath = streamPath;
    this.streamStartTime = Date.now();
    console.log(`[Metrics] 방송 시작: ${streamPath}`);
  }

  onStreamEnd(streamPath) {
    this.isStreaming = false;
    this.streamPath = null;
    console.log(`[Metrics] 방송 종료: ${streamPath}`);
  }

  onViewerConnect() {
    // RTMP 시청자 (플레이어가 RTMP로 직접 볼 경우)
  }

  onViewerDisconnect() {}

  onViewerPlay(id, streamPath) {
    this.activeViewers.add(id);
    if (this.activeViewers.size > this.peakViewers) {
      this.peakViewers = this.activeViewers.size;
    }
    console.log(`[Metrics] 시청자 추가 id=${id} 현재=${this.activeViewers.size}명`);
  }

  onViewerStop(id) {
    this.activeViewers.delete(id);
    console.log(`[Metrics] 시청자 이탈 id=${id} 현재=${this.activeViewers.size}명`);
  }

  onHlsRequest(req) {
    this.hlsRequestCount++;

    // .ts 세그먼트 요청 시 파일 크기로 전송량 추정
    if (req.path.endsWith('.ts')) {
      const filePath = path.join(__dirname, '../hls', req.path);
      try {
        const size = fs.statSync(filePath).size;
        this.totalBytesSent += size;
      } catch {
        // 파일이 없거나 삭제된 경우 평균 크기로 추정
        // 720p 2.5Mbps × 2s 세그먼트 = 약 625KB
        this.totalBytesSent += 640 * 1024;
      }
    }
  }

  // ────────── 샘플링 ─────────────────────

  _sample() {
    const count = this.activeViewers.size;
    this.viewerHistory.push({ time: Date.now(), count });

    // 히스토리 최대 3600개 (1시간)
    if (this.viewerHistory.length > 3600) {
      this.viewerHistory.shift();
    }

    this.broadcast({ type: 'tick', data: this.getSnapshot() });
  }

  // ────────── 비용 계산 ──────────────────

  /**
   * 현재까지 누적된 실제 비용 + 100명 시나리오 예측
   */
  getCostReport() {
    const elapsedHours = (Date.now() - this.startTime) / 3600000;
    const pricing = AWS_PRICING;
    const ec2HourlyRate = pricing.ec2[this.instanceType] || pricing.ec2['t3.medium'];

    // 현재까지 EC2 비용
    const ec2Cost = ec2HourlyRate * elapsedHours;

    // 현재까지 데이터 전송 비용
    const transferGB = this.totalBytesSent / (1024 ** 3);
    const transferCost = transferGB * pricing.dataTransferPerGB;

    // EBS 비용
    const ebsCost = (pricing.ebsGp3PerGBMonth * pricing.ebsVolumeSizeGB / 720) * elapsedHours;

    const totalCost = ec2Cost + transferCost + ebsCost;

    // ── 시청자별 예측 (1시간 기준) ──────────
    const scenarios = this._buildScenarios(ec2HourlyRate);

    return {
      elapsed: {
        hours: parseFloat(elapsedHours.toFixed(4)),
        label: this._formatDuration(Date.now() - this.startTime),
      },
      current: {
        instanceType: this.instanceType,
        ec2HourlyRate,
        ec2Cost:       parseFloat(ec2Cost.toFixed(6)),
        transferGB:    parseFloat(transferGB.toFixed(6)),
        transferCost:  parseFloat(transferCost.toFixed(6)),
        ebsCost:       parseFloat(ebsCost.toFixed(6)),
        totalCost:     parseFloat(totalCost.toFixed(6)),
        totalCostKRW:  Math.round(totalCost * 1350),
      },
      scenarios,   // 1명 ~ 100명 × 1시간
      monthly: this._buildMonthlyScenarios(ec2HourlyRate),
    };
  }

  /**
   * N명 시청자 × 1시간 비용 시나리오
   */
  _buildScenarios(ec2HourlyRate) {
    const viewerCounts = [1, 5, 10, 20, 30, 50, 100];
    return viewerCounts.map(viewers => {
      // 720p HLS: 세그먼트 2초, 5개 유지 → 시청자당 초당 ~320KB 다운로드
      // 실제 비트레이트 기반: 2.5Mbps = 312.5 KB/s
      const kbPerSecPerViewer = (STREAM_BITRATE_MBPS * 1000) / 8; // KB/s
      const gbPerHourPerViewer = (kbPerSecPerViewer * 3600) / (1024 * 1024); // GB/hr

      const transferGBHour = gbPerHourPerViewer * viewers;
      const transferCost = transferGBHour * AWS_PRICING.dataTransferPerGB;
      const ebsCostHour = (AWS_PRICING.ebsGp3PerGBMonth * AWS_PRICING.ebsVolumeSizeGB) / 720;

      // 필요한 인스턴스 타입 (CPU 기준 추정)
      const recommendedInstance = this._recommendInstance(viewers);
      const actualEc2Rate = AWS_PRICING.ec2[recommendedInstance] || ec2HourlyRate;

      const totalPerHour = actualEc2Rate + transferCost + ebsCostHour;

      return {
        viewers,
        recommendedInstance,
        ec2CostPerHour:      parseFloat(actualEc2Rate.toFixed(4)),
        transferGBPerHour:   parseFloat(transferGBHour.toFixed(3)),
        transferCostPerHour: parseFloat(transferCost.toFixed(4)),
        totalPerHour:        parseFloat(totalPerHour.toFixed(4)),
        totalPerHourKRW:     Math.round(totalPerHour * 1350),
        totalPerDay:         parseFloat((totalPerHour * 24).toFixed(3)),
        totalPerDayKRW:      Math.round(totalPerHour * 24 * 1350),
        totalPerMonth:       parseFloat((totalPerHour * 720).toFixed(2)),
        totalPerMonthKRW:    Math.round(totalPerHour * 720 * 1350),
      };
    });
  }

  /**
   * 월간 비용 시나리오 (24시간 방송 기준)
   */
  _buildMonthlyScenarios(ec2HourlyRate) {
    return [1, 10, 50, 100].map(viewers => {
      const instance = this._recommendInstance(viewers);
      const rate = AWS_PRICING.ec2[instance] || ec2HourlyRate;
      const kbPerSecPerViewer = (STREAM_BITRATE_MBPS * 1000) / 8;
      const gbMonth = (kbPerSecPerViewer * 3600 * 24 * 30 / (1024 * 1024)) * viewers;
      const transferCost = gbMonth * AWS_PRICING.dataTransferPerGB;
      const ebsCost = AWS_PRICING.ebsGp3PerGBMonth * AWS_PRICING.ebsVolumeSizeGB;
      const ec2Monthly = rate * 720;
      const total = ec2Monthly + transferCost + ebsCost;
      return {
        viewers,
        instance,
        ec2Monthly:  parseFloat(ec2Monthly.toFixed(2)),
        transferGB:  parseFloat(gbMonth.toFixed(1)),
        transferCost: parseFloat(transferCost.toFixed(2)),
        ebsCost:     parseFloat(ebsCost.toFixed(2)),
        total:       parseFloat(total.toFixed(2)),
        totalKRW:    Math.round(total * 1350),
      };
    });
  }

  /**
   * 시청자 수에 따른 권장 인스턴스
   * (FFmpeg 720p 트랜스코딩 + HLS 서빙 고려)
   */
  _recommendInstance(viewers) {
    if (viewers <= 10)  return 't3.medium';  // 2vCPU, 4GB
    if (viewers <= 30)  return 't3.large';   // 2vCPU, 8GB
    if (viewers <= 60)  return 't3.xlarge';  // 4vCPU, 16GB
    return 't3.2xlarge';                     // 8vCPU, 32GB
  }

  // ────────── 스냅샷 ─────────────────────

  getSnapshot() {
    const elapsedMs = Date.now() - this.startTime;
    const elapsedHours = elapsedMs / 3600000;
    const ec2Rate = AWS_PRICING.ec2[this.instanceType] || 0.0544;
    const transferGB = this.totalBytesSent / (1024 ** 3);
    const currentCost = ec2Rate * elapsedHours
                      + transferGB * AWS_PRICING.dataTransferPerGB
                      + (AWS_PRICING.ebsGp3PerGBMonth * AWS_PRICING.ebsVolumeSizeGB / 720) * elapsedHours;

    // 현재 초당 아웃바운드 (최근 5초 평균)
    const recentRequests = this.viewerHistory.slice(-5);
    const currentViewers = recentRequests.length > 0
      ? recentRequests[recentRequests.length - 1].count
      : this.activeViewers.size;

    const outboundMbps = currentViewers * STREAM_BITRATE_MBPS;

    return {
      timestamp: Date.now(),
      uptime: this._formatDuration(elapsedMs),
      isStreaming: this.isStreaming,
      viewers: {
        current: this.activeViewers.size,
        peak: this.peakViewers,
        history: this.viewerHistory.slice(-60), // 최근 60초
      },
      bandwidth: {
        outboundMbps: parseFloat(outboundMbps.toFixed(2)),
        totalBytesSent: this.totalBytesSent,
        totalGB: parseFloat(transferGB.toFixed(4)),
        hlsRequests: this.hlsRequestCount,
      },
      cost: {
        currentUSD: parseFloat(currentCost.toFixed(6)),
        currentKRW: Math.round(currentCost * 1350),
        ec2HourlyRate: ec2Rate,
        instanceType: this.instanceType,
      },
      system: {
        cpuModel: os.cpus()[0]?.model || 'Unknown',
        cpuCount: os.cpus().length,
        totalMemGB: (os.totalmem() / (1024 ** 3)).toFixed(1),
        freeMemGB: (os.freemem() / (1024 ** 3)).toFixed(1),
        loadAvg: os.loadavg()[0].toFixed(2),
      },
    };
  }

  // ────────── 리포트 저장 ────────────────

  saveReport() {
    const report = {
      generatedAt: new Date().toISOString(),
      snapshot: this.getSnapshot(),
      costReport: this.getCostReport(),
    };
    const filename = `report-${Date.now()}.json`;
    const filepath = path.join(this._reportDir, filename);
    fs.writeFileSync(filepath, JSON.stringify(report, null, 2));
    console.log(`[Metrics] 리포트 저장: ${filepath}`);
    return filepath;
  }

  // ────────── 유틸 ──────────────────────

  _formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    return `${String(h).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  destroy() {
    clearInterval(this._sampleInterval);
  }
}

module.exports = MetricsCollector;
