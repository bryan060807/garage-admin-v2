module.exports = {
  apps: [
    {
      name: "garage-admin-v2",
      cwd: __dirname,
      script: "backend/src/server.js",
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      watch: false,
      autorestart: true,
      min_uptime: "5s",
      max_restarts: 10,
      restart_delay: 2000,
      max_memory_restart: "300M",
      time: true,
      env: {
        NODE_ENV: "production",
        PORT: "3010",
        FRONTEND_ORIGIN: "http://127.0.0.1:3010",
      },
    },
  ],
};
