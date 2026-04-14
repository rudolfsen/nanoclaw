# Customer Instance Deployment

## Setup

1. Create customer directory:
   ```bash
   mkdir -p /opt/nanoclaw-customers/ats/{data,groups/ats-email/wiki}
   ```

2. Copy deployment files:
   ```bash
   cp customer/docker-compose.yml /opt/nanoclaw-customers/ats/
   cp customer/.env.template /opt/nanoclaw-customers/ats/.env
   ```

3. Create `groups/ats-email/CLAUDE.md` with customer-specific agent instructions

4. Fill in `.env` with customer credentials (ANTHROPIC_API_KEY, Outlook creds)

5. Build and start:
   ```bash
   cd /opt/nanoclaw-customers/ats
   docker compose up -d --build
   ```

## Management

```bash
docker compose logs -f          # View logs
docker compose restart          # Restart
docker compose down             # Stop
docker compose up -d --build    # Rebuild and restart
```
