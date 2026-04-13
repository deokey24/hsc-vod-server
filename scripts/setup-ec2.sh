#!/bin/bash
# ============================================================
# AWS EC2 스트리밍 서버 초기 설정 스크립트
# Ubuntu 22.04 LTS / t3.medium 이상 권장
# ============================================================
set -e

echo "======================================"
echo " 실시간 스트리밍 서버 EC2 초기 설정"
echo "======================================"

# 1. 시스템 업데이트
echo "[1/7] 시스템 업데이트..."
sudo apt update && sudo apt upgrade -y

# 2. Node.js 20 LTS 설치
echo "[2/7] Node.js 20 설치..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 3. FFmpeg 설치 (720p 트랜스코딩용)
echo "[3/7] FFmpeg 설치..."
sudo apt install -y ffmpeg

# 4. 필수 도구 설치
echo "[4/7] 기타 도구 설치..."
sudo apt install -y git htop iotop nethogs curl wget unzip

# 5. 방화벽 설정 (AWS Security Group도 같이 열어야 함)
echo "[5/7] UFW 방화벽 설정..."
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP
sudo ufw allow 443/tcp   # HTTPS
sudo ufw allow 1935/tcp  # RTMP
sudo ufw allow 8080/tcp  # Node.js HTTP (테스트용)
sudo ufw --force enable

# 6. 프로젝트 디렉터리 생성
echo "[6/7] 디렉터리 구조 생성..."
mkdir -p ~/streaming-server/{src,scripts,hls,public,logs}
cd ~/streaming-server

# 7. PM2 (프로세스 매니저) 전역 설치
echo "[7/7] PM2 설치..."
sudo npm install -g pm2

echo ""
echo "======================================"
echo " 설정 완료! 다음 단계:"
echo "  1. cd ~/streaming-server"
echo "  2. npm install"
echo "  3. pm2 start ecosystem.config.js"
echo "======================================"

# EC2 인스턴스 정보 출력
echo ""
echo "[ 인스턴스 정보 ]"
echo "Public IP: $(curl -s http://169.254.169.254/latest/meta-data/public-ipv4)"
echo "Instance Type: $(curl -s http://169.254.169.254/latest/meta-data/instance-type)"
echo "Region: $(curl -s http://169.254.169.254/latest/meta-data/placement/region)"
