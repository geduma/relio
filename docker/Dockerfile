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

# Stage 3: Backend runtime
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY --from=backend-build /app/node_modules ./node_modules
COPY package*.json ./
COPY src/ ./src/
COPY config.example.json ./config.json
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

RUN mkdir -p logs

EXPOSE 3000

CMD ["node", "src/index.js"]
