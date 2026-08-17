FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

# Persisted across restarts/deploys via a mounted volume (see fly.toml / README).
ENV AUTH_DIR=/data/auth_info
ENV DATA_DIR=/data/list-data
VOLUME ["/data"]

CMD ["node", "index.js"]
