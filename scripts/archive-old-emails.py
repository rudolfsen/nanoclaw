#!/usr/bin/env python3
"""Archive all inbox emails from before 2026 to Archive folder."""
import urllib.request, urllib.parse, json, os

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

# Get Archive folder ID
req = urllib.request.Request(base + "/mailFolders?$top=50", headers=hdrs)
folders = json.loads(urllib.request.urlopen(req).read()).get("value", [])
archive_id = None
for f in folders:
    if f["displayName"] == "Archive":
        archive_id = f["id"]
        break

if not archive_id:
    print("No Archive folder found, creating one...")
    create_data = json.dumps({"displayName": "Archive"}).encode()
    create_req = urllib.request.Request(base + "/mailFolders", data=create_data, headers=hdrs, method="POST")
    result = json.loads(urllib.request.urlopen(create_req).read())
    archive_id = result["id"]

print(f"Archive folder ID: {archive_id[:30]}...")

# Fetch and move in batches
total_moved = 0
batch = 0

while True:
    batch += 1
    params = urllib.parse.urlencode({
        "$top": "50",
        "$select": "id",
        "$filter": "receivedDateTime lt 2026-01-01T00:00:00Z",
        "$orderby": "receivedDateTime desc",
    })
    req = urllib.request.Request(base + "/mailFolders/Inbox/messages?" + params, headers=hdrs)
    resp = json.loads(urllib.request.urlopen(req).read())
    msgs = resp.get("value", [])

    if not msgs:
        break

    for msg in msgs:
        mid = msg["id"]
        try:
            move_data = json.dumps({"destinationId": archive_id}).encode()
            move_req = urllib.request.Request(base + "/messages/" + mid + "/move", data=move_data, headers=hdrs, method="POST")
            urllib.request.urlopen(move_req)
            total_moved += 1
        except Exception as e:
            print(f"  Failed to move: {e}")

    print(f"  Batch {batch}: moved {len(msgs)} (total: {total_moved})")

print(f"\nDone. Archived {total_moved} emails from before 2026.")
