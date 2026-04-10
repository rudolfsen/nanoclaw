# Meta Invoice PDF Fetcher

Downloads invoice PDFs from Facebook Ads Manager using agent-browser.

## Prerequisites
- Facebook login credentials available (user logs in manually first, session cookies persist)
- agent-browser installed globally in container

## Usage

Use agent-browser to navigate to the Facebook Ads Manager billing page and download invoice PDFs.

### Step 1: Open Billing Page

```bash
agent-browser open "https://business.facebook.com/billing_hub/payment_activity?business_id=341685731414495"
agent-browser snapshot -i
```

### Step 2: Navigate and Download

Use agent-browser to:
1. Find the invoice/receipt links on the billing page
2. Click to download each PDF
3. Save to /workspace/group/receipts/

### Manual First-Time Setup

Facebook requires a manual login with 2FA the first time. Run:
```bash
agent-browser open "https://business.facebook.com/billing_hub/payment_activity"
agent-browser snapshot -i
```
Then log in manually. Session cookies will persist for future automated runs.

### After Download

Run the receipt push script to send downloaded PDFs to regnskapsbotten:
```bash
npx tsx scripts/push-receipts.ts
```
