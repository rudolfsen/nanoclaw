#!/usr/bin/env python3
"""Find John Murray's emails and fix their category to Viktig."""
import urllib.request, urllib.parse, json, os, re

env = {}
env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
with open(env_path) as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith("#"): continue
        k, _, v = line.partition("=")
        env[k.strip()] = v.strip()

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

# Search for John's emails
params = urllib.parse.urlencode({
    "$top": "10",
    "$select": "id,subject,from,categories",
    "$search": '"john k-team"',
})
req = urllib.request.Request(base + "/messages?" + params, headers=hdrs)
msgs = json.loads(urllib.request.urlopen(req).read()).get("value", [])

if not msgs:
    # Try broader search
    params = urllib.parse.urlencode({
        "$top": "10",
        "$select": "id,subject,from,categories",
        "$search": '"Regnskapsrapport"',
    })
    req = urllib.request.Request(base + "/messages?" + params, headers=hdrs)
    msgs = json.loads(urllib.request.urlopen(req).read()).get("value", [])

print(f"Found {len(msgs)} messages\n")

john_addr = None
for m in msgs:
    addr = m.get("from", {}).get("emailAddress", {}).get("address", "")
    name = m.get("from", {}).get("emailAddress", {}).get("name", "")
    cats = m.get("categories", [])
    print(f"  {name} <{addr}> | {m['subject'][:50]} | {cats}")

    # Update category to Viktig
    if "Kvitteringer" in cats or "Annet" in cats:
        new_cats = [c for c in cats if c not in ("Kvitteringer", "Annet")] + ["Viktig"]
        body = json.dumps({"categories": new_cats}).encode()
        req2 = urllib.request.Request(base + "/messages/" + m["id"], data=body, headers=hdrs, method="PATCH")
        urllib.request.urlopen(req2)
        print(f"    -> Updated to {new_cats}")

    if "k-team" in addr or "john" in addr.lower():
        john_addr = addr

# Save learned category for John's address
if john_addr:
    print(f"\nJohn's address: {john_addr}")
    import sqlite3
    db = sqlite3.connect("/opt/assistent/store/messages.db")
    db.execute(
        "INSERT INTO email_categories (sender, category, confidence) VALUES (?, 'viktig', 0.95) "
        "ON CONFLICT(sender, category) DO UPDATE SET confidence = 0.95",
        (john_addr,)
    )
    db.commit()
    db.close()
    print(f"Saved learned category: {john_addr} -> viktig (0.95)")
