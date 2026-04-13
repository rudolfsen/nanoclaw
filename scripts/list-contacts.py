#!/usr/bin/env python3
"""List Outlook contacts."""
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

# Try contacts
params = urllib.parse.urlencode({"$top": "200", "$select": "displayName,emailAddresses"})
try:
    req = urllib.request.Request(f"{base}/contacts?{params}", headers=hdrs)
    resp = json.loads(urllib.request.urlopen(req).read())
    contacts = resp.get("value", [])
    print(f"{len(contacts)} contacts found\n")
    for c in contacts:
        name = c.get("displayName", "")
        emails = [e.get("address", "") for e in c.get("emailAddresses", [])]
        print(f"  {name}: {', '.join(emails)}")
except Exception as e:
    print(f"Error accessing contacts: {e}")
    print("\nMay need Contacts.Read scope. Current scopes only cover Mail.")
