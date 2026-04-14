# Direct Mode E-postkø Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make direct mode process emails one at a time with automatic drain — each email gets its own Claude call, and the next email is picked up automatically after the previous is done.

**Architecture:** Two changes in `processGroupMessages()` in `src/index.ts`, both gated behind `AGENT_MODE === 'direct'`: (1) limit to 1 message per call, (2) re-enqueue when more messages are pending.

**Tech Stack:** TypeScript, existing GroupQueue

**Spec:** `docs/superpowers/specs/2026-04-14-direct-mode-email-queue-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/index.ts:224-345` | Modify | Limit messages and re-enqueue in direct mode |

---

### Task 1: Sequential email processing in direct mode

**Files:**
- Modify: `src/index.ts:224-345` (processGroupMessages function)

- [ ] **Step 1: Limit to 1 message in direct mode**

In `src/index.ts`, in the `processGroupMessages()` function (line 224), find the `getMessagesSince` call (line 236):

```typescript
  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );
```

Replace with:

```typescript
  const messageLimit = AGENT_MODE === 'direct' ? 1 : MAX_MESSAGES_PER_PROMPT;
  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    messageLimit,
  );
```

`AGENT_MODE` is already imported from `./config.js` (added in the v2 work).

- [ ] **Step 2: Re-enqueue when more messages are pending**

In the same function, find the successful return at the end (line 345):

```typescript
  return true;
}
```

Replace with:

```typescript
  // In direct mode, check for more pending messages and drain the queue
  if (AGENT_MODE === 'direct') {
    const remaining = getMessagesSince(
      chatJid,
      lastAgentTimestamp[chatJid] || '',
      ASSISTANT_NAME,
      1,
    );
    if (remaining.length > 0) {
      logger.info(
        { group: group.name, remaining: remaining.length },
        'More messages pending, re-enqueueing',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }

  return true;
}
```

This checks if there are more messages after the cursor was advanced. If yes, it enqueues another processing round. The GroupQueue handles scheduling — the next round starts after the current one completes.

- [ ] **Step 3: Build and verify**

Run: `npm run build && npx vitest run`
Expected: Clean build, all tests pass

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: sequential email processing with auto-drain in direct mode"
```

---

### Task 2: Deploy and test

- [ ] **Step 1: Push and rebuild**

```bash
git push origin main
ssh root@204.168.178.32 'cd /opt/assistent && git pull && docker build --no-cache -f customer/Dockerfile -t nanoclaw-customer:latest .'
```

- [ ] **Step 2: Restart with fresh DB**

```bash
ssh root@204.168.178.32 'docker stop nanoclaw-ats && docker rm nanoclaw-ats && rm -f /opt/nanoclaw-customers/ats/store/messages.db && docker run -d --name nanoclaw-ats --restart unless-stopped --env-file /opt/nanoclaw-customers/ats/.env -v /opt/nanoclaw-customers/ats/data:/app/data -v /opt/nanoclaw-customers/ats/groups:/app/groups -v /root/.gmail-mcp-ats-test:/app/credentials -v /opt/nanoclaw-customers/ats/store:/app/store --memory=1g --cpus=1.0 nanoclaw-customer:latest'
```

- [ ] **Step 3: Verify sequential processing**

Watch logs:
```bash
ssh root@204.168.178.32 'docker logs nanoclaw-ats -f' | grep -E 'Processing|messageCount|Gmail draft|re-enqueueing|pending'
```

Expected:
```
Processing messages messageCount: 1
Gmail draft created
More messages pending, re-enqueueing
Processing messages messageCount: 1
Gmail draft created
More messages pending, re-enqueueing
...
Processing messages messageCount: 1
Gmail draft created
(no more re-enqueueing — queue drained)
```
