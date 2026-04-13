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
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Deployment (Hetzner VPS)

Production runs on Hetzner VPS (`204.168.178.32`), not Railway.

```bash
# Deploy
ssh root@204.168.178.32 'cd /opt/assistent && git pull && npm run build && systemctl restart nanoclaw'

# Check status
ssh root@204.168.178.32 'systemctl status nanoclaw'

# View logs
ssh root@204.168.178.32 'journalctl -u nanoclaw --no-pager -n 50'
```

- App directory: `/opt/assistent`
- Service: `nanoclaw` (systemd, enabled)
- Database: SQLite at `store/messages.db`
- Container runtime: Docker

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
