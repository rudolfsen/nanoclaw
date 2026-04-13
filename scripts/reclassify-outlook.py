#!/usr/bin/env python3
"""One-shot script to reclassify misplaced Viktig emails using updated patterns."""
import urllib.request, urllib.parse, json, re, os

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

# Get folders
req = urllib.request.Request(base + "/mailFolders?$top=50", headers=hdrs)
folders = json.loads(urllib.request.urlopen(req).read())
folder_ids = {f["displayName"]: f["id"] for f in folders.get("value", [])}

viktig_id = folder_ids.get("Viktig")
if not viktig_id:
    print("No Viktig folder found")
    exit(1)

newsletter_patterns = [
    r"unsubscribe", r"newsletter", r"weekly.*digest", r"nyhetsbrev", r"avmeld",
    r"\bdigest\b", r"\bukens?\s+(nyhet|oppdatering)", r"\bny(het|tt)!\s",
    r"\bny bok\b", r"\bnyheter i pocket\b", r"\bpå sitt sterkeste\b",
    r"\bterningkast\b", r"\bkommer:\s",
]
reklame_patterns = [
    r"campaign", r"\boffer\b", r"\bsale\b", r"rabatt", r"tilbud",
    r"\d+\s*%\s*off", r"\bjoin\b.*\bevent\b", r"\bregister\b.*\bnow\b",
    r"\btop \d+ things you.ll miss\b", r"\bgratismalen?\b",
]
automated_domains = [
    "figma.com", "tiktok.com", "mindtheproduct.com", "outsidecontext.co", "adobe.com",
    "mailchimp.com", "sendgrid.net", "hubspot.com", "klaviyo.com",
    "cappelendamm.no", "bonniernorskforlag.no", "friskforlag.no",
    "solumbokvennen.no", "ukultur.no", "respublica.no",
]

# Get messages in Viktig folder
req2 = urllib.request.Request(
    base + "/mailFolders/" + viktig_id + "/messages?$top=50&$select=id,subject,from,categories",
    headers=hdrs)
msgs = json.loads(urllib.request.urlopen(req2).read())

moved = 0
for msg in msgs.get("value", []):
    subj = msg.get("subject", "")
    from_addr = msg.get("from", {}).get("emailAddress", {}).get("address", "")
    domain = from_addr.split("@")[1] if "@" in from_addr else ""
    text = subj

    new_category = None
    target_folder = None

    for p in newsletter_patterns:
        if re.search(p, text, re.IGNORECASE):
            new_category = "Nyhetsbrev"
            target_folder = folder_ids.get("Nyhetsbrev")
            break

    if not new_category:
        for p in reklame_patterns:
            if re.search(p, text, re.IGNORECASE):
                new_category = "Reklame"
                target_folder = folder_ids.get("Reklame")
                break

    if not new_category and any(d in domain for d in automated_domains):
        new_category = "Nyhetsbrev"
        target_folder = folder_ids.get("Nyhetsbrev")

    if new_category and target_folder:
        mid = msg["id"]
        old_cats = msg.get("categories", [])
        new_cats = [c for c in old_cats if c != "Viktig"] + [new_category]
        body_data = json.dumps({"categories": new_cats}).encode()
        req3 = urllib.request.Request(base + "/messages/" + mid, data=body_data, headers=hdrs, method="PATCH")
        urllib.request.urlopen(req3)
        move_data = json.dumps({"destinationId": target_folder}).encode()
        req4 = urllib.request.Request(base + "/messages/" + mid + "/move", data=move_data, headers=hdrs, method="POST")
        urllib.request.urlopen(req4)
        print(f"Moved: {subj[:55]} -> {new_category}")
        moved += 1
    else:
        print(f"Kept:  {subj[:55]} ({from_addr})")

print(f"\nDone. Moved {moved} messages out of Viktig.")
