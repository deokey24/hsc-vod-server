module.exports = {
  apps: [
    {
      name: 'streaming-server',
      script: 'src/server.js',
      cwd: '/home/ubuntu/streaming-server',   // EC2 경로에 맞게 수정
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '2G',
      env: {
        NODE_ENV: 'production',
        FFMPEG_PATH: '/usr/bin/ffmpeg',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
    }
  ]
};
