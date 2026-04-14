FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl jq ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# Copy container skills (ATS feed tool etc.)
COPY container/skills/ ./container/skills/

# Default env for customer instances
ENV AGENT_MODE=direct
ENV EMAIL_CLASSIFICATION_ENABLED=false
ENV NODE_ENV=production

# Data directories (mount as volumes)
RUN mkdir -p data groups

CMD ["node", "dist/index.js"]
