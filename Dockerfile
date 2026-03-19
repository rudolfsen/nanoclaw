FROM node:20-slim

# Install build tools for native addons (better-sqlite3) and gh CLI
RUN apt-get update && apt-get install -y curl python3 make g++ && \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | \
    dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | \
    tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    apt-get update && apt-get install -y gh && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
ENV HUSKY=0
RUN npm ci

COPY . .
RUN npm run build

RUN npm prune --omit=dev

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
