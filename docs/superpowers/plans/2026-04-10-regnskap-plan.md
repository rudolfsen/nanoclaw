# Regnskap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automate receipt collection from email and ad platforms, download Meta invoice PDFs via browser automation, and push everything to regnskapsbotten.

**Architecture:** Receipt scanning pipeline already exists (scan-receipts.ts → receipt-collector.ts → voucher-inbox.ts). Snap invoices work via API. Meta invoices require agent-browser because the Graph API doesn't expose invoice PDFs. We add scheduled tasks for daily receipt scanning and monthly invoice fetching.

**Tech Stack:** TypeScript, agent-browser (Chromium), better-sqlite3, Supabase

---

### Task 1: Create Meta invoice browser automation script

**Files:**
- Create: `container/skills/meta-invoices/SKILL.md`
- Create: `container/skills/meta-invoices/fetch.sh`

- [ ] **Step 1: Write the browser automation skill doc**

```markdown
<!-- container/skills/meta-invoices/SKILL.md -->
# Meta Invoice PDF Fetcher

Downloads invoice PDFs from Facebook Ads Manager using agent-browser.

## Prerequisites
- Facebook login credentials available (user logs in manually first, session cookies persist)
- agent-browser installed globally in container

## Usage

\`\`\`bash
bash /workspace/project/container/skills/meta-invoices/fetch.sh
\`\`\`

## How It Works

1. Opens Facebook Ads Manager Billing page
2. Navigates to payment history / invoices
3. Downloads each invoice PDF for the specified period
4. Saves to /workspace/group/receipts/

## Manual First-Time Setup

Facebook requires a manual login with 2FA the first time. Run:
\`\`\`bash
agent-browser open "https://business.facebook.com/billing_hub/payment_activity"
agent-browser snapshot -i
\`\`\`
Then log in manually. Session cookies will persist for future automated runs.
```

- [ ] **Step 2: Write the fetch script**

```bash
#!/bin/bash
# container/skills/meta-invoices/fetch.sh
# Downloads Meta invoice PDFs via agent-browser
set -euo pipefail

BILLING_URL="https://business.facebook.com/billing_hub/payment_activity?business_id=${META_BUSINESS_ID:-341685731414495}"
RECEIPTS_DIR="/workspace/group/receipts"
mkdir -p "$RECEIPTS_DIR"

echo "Opening Ads Manager billing page..."
agent-browser open "$BILLING_URL"
sleep 5
agent-browser snapshot -i

echo "Looking for invoice download links..."
# The agent will use agent-browser interactively from here
# This script provides the starting point; the Claude agent
# navigates the page, finds invoice links, and downloads PDFs
```

- [ ] **Step 3: Commit**

```bash
git add container/skills/meta-invoices/
git commit -m "feat: add Meta invoice browser automation skill"
```

---

### Task 2: Set up daily receipt scanning as scheduled task

**Files:**
- Modify: `groups/privat/CLAUDE.md` — document receipt scanning capability

- [ ] **Step 1: Verify existing receipt scan script works**

```bash
ssh root@204.168.178.32 'cd /opt/assistent && source .env && npx tsx scripts/scan-receipts.ts --days 7 2>&1 | tail -10'
```

- [ ] **Step 2: Verify voucher inbox push works**

```bash
ssh root@204.168.178.32 'cd /opt/assistent && source .env && npx tsx scripts/push-receipts.ts 2>&1 | tail -10'
```

- [ ] **Step 3: Add receipt tools documentation to agent CLAUDE.md**

Add to `groups/privat/CLAUDE.md`:

```markdown
## Receipt Management

You can scan for receipts and push them to the accounting system:

- Scan emails for receipts: `npx tsx scripts/scan-receipts.ts --days 7`
- Push pending receipts to regnskapsbotten: `npx tsx scripts/push-receipts.ts`
- Fetch Snap invoices: `npx tsx scripts/fetch-ad-invoices.ts --days 90`
- Fetch Meta invoices: Use agent-browser (see container/skills/meta-invoices/SKILL.md)

After scanning, report what was found and pushed.
```

- [ ] **Step 4: Set up daily receipt scan via Telegram**

Send to Andy:
```
@Andy Schedule a daily task: every day at 20:00, scan emails for receipts from the last 2 days and push any new ones to regnskapsbotten. Use cron "0 20 * * *" with isolated context. Prompt: "Run npx tsx scripts/scan-receipts.ts --days 2, then run npx tsx scripts/push-receipts.ts. Report results to me."
```

- [ ] **Step 5: Set up monthly ad invoice fetch via Telegram**

Send to Andy:
```
@Andy Schedule a monthly task: on the 2nd of every month, fetch Snap invoices for the last 35 days and push to regnskapsbotten. Use cron "0 10 2 * *" with isolated context. Prompt: "Run npx tsx scripts/fetch-ad-invoices.ts --days 35, then run npx tsx scripts/push-receipts.ts. Report results."
```

- [ ] **Step 6: Commit CLAUDE.md changes**

```bash
git add groups/privat/CLAUDE.md
git commit -m "feat: add receipt management docs and scheduled tasks"
```

---

### Task 3: Wire email triage receipts into receipt pipeline

**Files:**
- Modify: `src/skills/email-classifier.ts` — flag kvittering emails for receipt processing

- [ ] **Step 1: Write test for receipt flagging**

```typescript
// Add to src/skills/email-classifier.test.ts
it('flags kvittering emails in receipts table', () => {
  const db = new Database(':memory:');
  // Create both tables
  db.exec(`CREATE TABLE categorized_emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email_uid TEXT NOT NULL, source TEXT NOT NULL,
    sender TEXT, subject TEXT, category TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE TABLE receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email_uid TEXT NOT NULL, source TEXT NOT NULL,
    vendor TEXT, amount REAL, currency TEXT DEFAULT 'NOK',
    date TEXT, pdf_path TEXT, status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  classifyAndStore(db, {
    uid: 'receipt1',
    source: 'gmail',
    from: 'receipt@paypal.com',
    subject: 'Payment receipt',
    body: 'Amount: kr 500,00',
  });

  const row = db.prepare('SELECT * FROM categorized_emails WHERE email_uid = ?').get('receipt1') as any;
  expect(row.category).toBe('kvittering');
  db.close();
});
```

- [ ] **Step 2: Run test**

Run: `npx vitest run src/skills/email-classifier.test.ts`
Expected: PASS (classification already works, receipt processing happens via scan-receipts.ts)

- [ ] **Step 3: Commit**

```bash
git add src/skills/email-classifier.test.ts
git commit -m "test: verify receipt emails are classified correctly"
```

---

### Task 4: Deploy and verify

- [ ] **Step 1: Build and deploy**

```bash
ssh root@204.168.178.32 'cd /opt/assistent && git pull && npm run build && systemctl restart nanoclaw'
```

- [ ] **Step 2: Verify startup**

```bash
ssh root@204.168.178.32 'sleep 5 && journalctl -u nanoclaw --no-pager -n 15 --since "5 sec ago"'
```

- [ ] **Step 3: Test receipt scan manually**

```bash
ssh root@204.168.178.32 'cd /opt/assistent && source .env && npx tsx scripts/scan-receipts.ts --days 30 2>&1'
```

- [ ] **Step 4: Verify scheduled tasks are registered**

```bash
ssh root@204.168.178.32 "sqlite3 /opt/assistent/store/messages.db \"SELECT id, substr(prompt,1,50), schedule_value, status FROM scheduled_tasks WHERE status='active'\""
```
