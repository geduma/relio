# Stage 1: Build frontend
FROM node:20-alpine AS frontend-build

WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: Build backend dependencies (native modules for alpine/musl)
FROM node:20-alpine AS backend-build

WORKDIR /app
COPY package*.json ./
RUN apk add --no-cache python3 make g++ \
  && npm ci --omit=dev \
  && npm rebuild better-sqlite3

# Stage 3: Backend runtime (non-root)
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=backend-build /app/node_modules ./node_modules
COPY package*.json ./
COPY src/ ./src/
COPY config.example.json ./config.json
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

RUN mkdir -p logs db \
  && chown -R node:node /app

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/admin/api/metrics/health >/dev/null 2>&1 || exit 1

COPY scripts/setup-config-perm.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/setup-config-perm.sh
ENTRYPOINT ["setup-config-perm.sh"]
CMD ["node", "src/index.js"]
