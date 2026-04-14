#!/usr/bin/env python3
"""Count inbox emails from before 2026."""
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

# Count emails before 2026
params = urllib.parse.urlencode({
    "$filter": "receivedDateTime lt 2026-01-01T00:00:00Z",
    "$count": "true",
    "$top": "1",
    "$select": "id",
})
req = urllib.request.Request(base + "/mailFolders/Inbox/messages?" + params, headers={**hdrs, "ConsistencyLevel": "eventual"})
resp = json.loads(urllib.request.urlopen(req).read())
count = resp.get("@odata.count", len(resp.get("value", [])))

# Also get total inbox count
req2 = urllib.request.Request(base + "/mailFolders/Inbox?$select=totalItemCount,unreadItemCount", headers=hdrs)
folder = json.loads(urllib.request.urlopen(req2).read())

print(f"Inbox total: {folder.get('totalItemCount', '?')}")
print(f"Inbox unread: {folder.get('unreadItemCount', '?')}")
print(f"Before 2026: {count}")
