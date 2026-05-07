# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/superpowers/specs/2026-03-19-personlig-assistent-design.md](docs/superpowers/specs/2026-03-19-personlig-assistent-design.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Active channels: Telegram and Gmail (self-register at startup). Messages route to Claude Agent SDK running in Docker containers (Linux). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/` | Skills loaded inside agent containers (browser, status, formatting) |

## Secrets / Credentials / Proxy (OneCLI)

API keys, secret keys, OAuth tokens, and auth credentials are managed by the OneCLI gateway — which handles secret injection into containers at request time, so no keys or tokens are ever passed to containers directly. Run `onecli --help`.

## Skills

Four types of skills exist in NanoClaw. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and guidelines.

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-telegram`, `/add-slack`)
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/init-onecli` | Install OneCLI Agent Vault and migrate `.env` credentials to it |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Deployment (Hetzner VPS)

Production runs on Hetzner VPS (`204.168.178.32`), not Railway. **Two parallel deployments share the same `/opt/assistent` checkout.**

### Personal NanoClaw (systemd) — Magnus' Telegram/Gmail orchestrator

```bash
# Deploy
ssh root@204.168.178.32 'cd /opt/assistent && git pull && npm install && npm run build && systemctl restart nanoclaw'

# Check status / logs
ssh root@204.168.178.32 'systemctl status nanoclaw'
ssh root@204.168.178.32 'journalctl -u nanoclaw --no-pager -n 50'
```

App directory: `/opt/assistent`. Service: `nanoclaw` (systemd, enabled).

### Customer chat-API (Docker) — public chat widget on lbs.no/ats.no

The chat-API on port 3003 (and lead dashboard on 3002) runs in a separate Docker container `nanoclaw-ats`, NOT under systemd. It uses the `nanoclaw-customer:latest` image built from `customer/Dockerfile`. Per-customer config (`.env`, `data/`/`groups/`/`store/`, Gmail creds) lives at `/opt/nanoclaw-customers/<instance>/`.

```bash
# Deploy chat-API changes (server has no docker-compose plugin — using docker run)
ssh root@204.168.178.32 'cd /opt/assistent && git pull && \
  docker build -f customer/Dockerfile -t nanoclaw-customer:latest . && \
  docker stop nanoclaw-ats; docker rm nanoclaw-ats; \
  docker run -d --name nanoclaw-ats --restart unless-stopped \
    --env-file /opt/nanoclaw-customers/ats/.env \
    -v /opt/nanoclaw-customers/ats/data:/app/data \
    -v /opt/nanoclaw-customers/ats/groups:/app/groups \
    -v /opt/nanoclaw-customers/ats/store:/app/store \
    -v /root/.gmail-mcp-ats-test:/app/credentials \
    -p 3002:3002 -p 3003:3003 \
    --memory 1g --cpus 1.0 nanoclaw-customer:latest'

# Check status / logs
ssh root@204.168.178.32 'docker ps --filter name=nanoclaw-ats'
ssh root@204.168.178.32 'docker logs --tail 50 nanoclaw-ats'
```

`customer/docker-compose.yml` in this repo is a template for future use if the docker-compose plugin gets installed. Until then, the server uses the explicit `docker run` invocation above. **Channel connect failures are isolated** (`src/index.ts`) so an expired Gmail token in one channel won't crash startup.

#### Prompt-only changes (no rebuild needed)

`groups/` is bind-mounted from `/opt/nanoclaw-customers/ats/groups/`, NOT from the git checkout. Editing `groups/chat-lbs/CLAUDE.md` or `groups/chat-ats/CLAUDE.md` in git and deploying via `git pull` does NOT update the live prompts. After every prompt change, sync explicitly:

```bash
ssh root@204.168.178.32 'cd /opt/assistent && git pull && \
  cp groups/chat-lbs/CLAUDE.md /opt/nanoclaw-customers/ats/groups/chat-lbs/CLAUDE.md && \
  cp groups/chat-ats/CLAUDE.md /opt/nanoclaw-customers/ats/groups/chat-ats/CLAUDE.md'
```

`loadSystemPrompt()` reads the file fresh on every chat request, so no container restart is needed for prompt-only changes.

### Storage

- Database: SQLite at `store/messages.db`
- Container runtime: Docker (customer instances + agent execution containers)

### Ports and env vars

| Port | Purpose | Enable via |
|------|---------|------------|
| 3001 | Credential proxy | `CREDENTIAL_PROXY_PORT` |
| 3002 | Lead dashboard | `LEAD_DASHBOARD_PORT` + `LEAD_DASHBOARD_TOKEN` |
| 3003 | Public chat API | `CHAT_API_PORT` |
| 3004 | Cowork API (Outlook bridge) | `COWORK_API_PORT` + `COWORK_API_TOKEN` |

The Cowork API binds to `127.0.0.1:3004` and is exposed publicly at `https://mail.numra.no` via Caddy (Let's Encrypt, auto-renew). Caddyfile at `/etc/caddy/Caddyfile` forwards only `/healthz` and `/api/cowork/*`; every other path returns 404 so sibling services can't leak on the same hostname. Don't change `COWORK_API_BIND` off loopback — the only sanctioned path in is through Caddy.

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, SKILL.md format rules, PR requirements, and the pre-submission checklist (searching for existing PRs/issues, testing, description format).

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
npx vitest           # Run tests
```

## Rules

- Never tell the user to run commands — run them directly
- Never send emails on the user's behalf
- Gmail credentials live in `~/.gmail-mcp/credentials.json` (NOT in `.env` `GOOGLE_REFRESH_TOKEN`)
- Google app is in "testing" mode — refresh tokens expire after 7 days. Re-auth with `npx tsx scripts/google-auth.ts` locally, then update `~/.gmail-mcp/credentials.json` on the server
- OAuth auth scripts (Google, Outlook, Snap) must be run locally — they open a browser for consent

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
