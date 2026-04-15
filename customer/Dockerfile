FROM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# ---

FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl jq ca-certificates python3 make g++ sqlite3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm rebuild better-sqlite3

# Copy compiled JS from builder
COPY --from=builder /app/dist/ ./dist/

# Copy container skills (ATS feed tool etc.)
COPY container/skills/ ./container/skills/

# Copy chat widget
COPY widget/ ./widget/

# Default env for customer instances
ENV AGENT_MODE=direct
ENV EMAIL_CLASSIFICATION_ENABLED=false
ENV NODE_ENV=production

RUN mkdir -p data groups

CMD ["node", "dist/index.js"]
