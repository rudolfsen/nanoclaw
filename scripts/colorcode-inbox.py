#!/usr/bin/env python3
"""One-shot: classify and color-code last 7 days of Outlook inbox."""
import urllib.request, urllib.parse, json, re, os
from datetime import datetime, timedelta

# Load env
env = {}
env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
with open(env_path) as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith("#"): continue
        k, _, v = line.partition("=")
        env[k.strip()] = v.strip()

# Get token
data = urllib.parse.urlencode({
    "client_id": env["OUTLOOK_CLIENT_ID"],
    "client_secret": env["OUTLOOK_CLIENT_SECRET"],
    "refresh_token": env["OUTLOOK_REFRESH_TOKEN"],
    "grant_type": "refresh_token",
    "scope": "https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/MailboxSettings.ReadWrite offline_access"
}).encode()
req = urllib.request.Request(
    f"https://login.microsoftonline.com/{env['OUTLOOK_TENANT_ID']}/oauth2/v2.0/token",
    data=data, headers={"Content-Type": "application/x-www-form-urlencoded"})
token = json.loads(urllib.request.urlopen(req).read())["access_token"]

base = "https://graph.microsoft.com/v1.0/me"
hdrs = {"Authorization": "Bearer " + token, "Content-Type": "application/json"}

# Classification patterns (mirroring email-sorter.ts)
RECEIPT_PATTERNS = [r"receipt", r"invoice", r"faktura", r"kvittering", r"payment.*confirm", r"amount.*charged", r"order.*confirm"]
RECEIPT_SENDERS = ["facebookmail.com", "paypal.com", "stripe.com", "vipps.no", "klarna.com"]
NEWSLETTER_PATTERNS = [
    r"unsubscribe", r"newsletter", r"weekly.*digest", r"nyhetsbrev", r"avmeld", r"list-unsubscribe",
    r"\bdigest\b", r"\bukens?\s+(nyhet|oppdatering)", r"\bny(het|tt)!\s", r"\bny bok\b",
    r"\bnyheter i pocket\b", r"\bpå sitt sterkeste\b", r"\bterningkast\b", r"\bkommer:\s",
]
REKLAME_PATTERNS = [
    r"campaign", r"\boffer\b", r"\bsale\b", r"rabatt", r"tilbud", r"\d+\s*%\s*off",
    r"\bjoin\b.*\bevent\b", r"\bregister\b.*\bnow\b", r"\btop \d+ things you.ll miss\b", r"\bgratismalen?\b",
]
AUTOMATED_SENDER_PATTERNS = [
    r"noreply", r"no-reply", r"donotreply", r"do-not-reply", r"notifications?@",
    r"alerts?@", r"support@", r"hello@", r"info@", r"contact@", r"news@",
    r"newsletter@", r"mailer@", r"updates?@",
]
AUTOMATED_DOMAINS = [
    "t.shopifyemail.com", "shopify.com", "mailchimp.com", "sendgrid.net", "mandrillapp.com",
    "amazonses.com", "mailgun.org", "sparkpostmail.com", "exacttarget.com", "salesforce.com",
    "hubspot.com", "klaviyo.com", "constantcontact.com", "mailerlite.com", "sendinblue.com",
    "figma.com", "tiktok.com", "mindtheproduct.com", "outsidecontext.co", "adobe.com",
    "w3.org", "edrlab.org", "penguinrandomhouse.com", "neustudio.com", "mailchimpapp.com",
    "styreforeningen.no", "bulabistro.no",
    "cappelendamm.no", "bonniernorskforlag.no", "friskforlag.no",
    "solumbokvennen.no", "ukultur.no", "respublica.no",
]

def classify(from_addr, subject):
    text = subject
    domain = from_addr.split("@")[1] if "@" in from_addr else ""

    if domain and "t.shopifyemail.com" in domain:
        return "Annet"
    if any(s in domain for s in RECEIPT_SENDERS) or any(re.search(p, text, re.I) for p in RECEIPT_PATTERNS):
        return "Kvitteringer"
    if any(re.search(p, text, re.I) for p in NEWSLETTER_PATTERNS):
        return "Nyhetsbrev"
    if any(re.search(p, text, re.I) for p in REKLAME_PATTERNS):
        return "Reklame"

    is_automated = False
    if any(d in domain for d in AUTOMATED_DOMAINS):
        is_automated = True
    if any(re.search(p, from_addr, re.I) for p in AUTOMATED_SENDER_PATTERNS):
        is_automated = True

    if not is_automated:
        return "Viktig"
    return "Annet"

def domain_tag(email):
    domain = email.split("@")[1] if "@" in email else None
    if not domain: return None
    name = re.sub(r"\.(com|no|org|net|io|co|se|dk|fi|eu|uk|de)$", "", domain, flags=re.I)
    name = re.sub(r"^(mail|email|noreply|no-reply|notifications?|alerts?|support|info|hello|news|newsletter|mailer|updates?)\.", "", name, flags=re.I)
    generic = ["gmail","outlook","hotmail","yahoo","icloud","live","googlemail","protonmail","fastmail","metamail","global.metamail"]
    if any(g in name for g in generic): return None
    if re.match(r"^(noreply|no-reply|donotreply|notifications?)$", name, re.I): return None
    return name[0].upper() + name[1:].lower()

# Fetch last 7 days from Inbox
since = (datetime.now(tz=None) - timedelta(days=7)).strftime("%Y-%m-%dT00:00:00Z")

all_msgs = []
params = urllib.parse.urlencode({
    "$top": "50",
    "$select": "id,subject,from,categories,receivedDateTime",
    "$filter": f"receivedDateTime ge {since}",
    "$orderby": "receivedDateTime desc",
})
url = f"{base}/mailFolders/Inbox/messages?{params}"
while url:
    req = urllib.request.Request(url, headers=hdrs)
    resp = json.loads(urllib.request.urlopen(req).read())
    all_msgs.extend(resp.get("value", []))
    url = resp.get("@odata.nextLink")

print(f"Found {len(all_msgs)} messages in Inbox from last 7 days\n")

updated = 0
skipped = 0
stats = {}

for msg in all_msgs:
    mid = msg["id"]
    subj = msg.get("subject", "")
    from_addr = msg.get("from", {}).get("emailAddress", {}).get("address", "")
    old_cats = msg.get("categories", [])

    cat = classify(from_addr, subj)
    tags = [cat]
    dt = domain_tag(from_addr)
    if dt:
        tags.append(dt)

    stats[cat] = stats.get(cat, 0) + 1

    if set(tags) != set(old_cats):
        body_data = json.dumps({"categories": tags}).encode()
        req = urllib.request.Request(base + "/messages/" + mid, data=body_data, headers=hdrs, method="PATCH")
        urllib.request.urlopen(req)
        updated += 1
    else:
        skipped += 1

print(f"Updated: {updated}, Already correct: {skipped}\n")
print("Breakdown:")
for cat, count in sorted(stats.items(), key=lambda x: -x[1]):
    print(f"  {cat}: {count}")
