# Stage 1: Build frontend
FROM node:20-alpine AS frontend-build

WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: Backend runtime
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY db/ ./db/
COPY config.example.json ./config.json
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

RUN mkdir -p logs

EXPOSE 3000

CMD ["node", "src/index.js"]
