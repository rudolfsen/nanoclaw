#!/usr/bin/env python3
"""Test: read an important email and create a draft reply using Claude."""
import urllib.request, urllib.parse, json, os, re

env = {}
env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
with open(env_path) as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith("#"): continue
        k, _, v = line.partition("=")
        env[k.strip()] = v.strip()

# Get Graph token
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
graph_token = json.loads(urllib.request.urlopen(req).read())["access_token"]

base = "https://graph.microsoft.com/v1.0/me"
ghdrs = {"Authorization": "Bearer " + graph_token, "Content-Type": "application/json"}

# Find a recent important email using search
params = urllib.parse.urlencode({
    "$top": "5",
    "$select": "id,subject,from,body,conversationId,receivedDateTime",
    "$search": '"Oppsigelse forhandleravtale"',
})
req = urllib.request.Request(base + "/messages?" + params, headers=ghdrs)
msgs = json.loads(urllib.request.urlopen(req).read()).get("value", [])

if not msgs:
    print("No emails found from Beate")
    exit(1)

msg = msgs[0]
from_addr = msg["from"]["emailAddress"]["address"]
from_name = msg["from"]["emailAddress"]["name"]
subject = msg["subject"]
conv_id = msg.get("conversationId", "")
body_html = msg.get("body", {}).get("content", "")

# Strip HTML
body_text = re.sub(r"<style[^>]*>[\s\S]*?</style>", "", body_html, flags=re.I)
body_text = re.sub(r"<[^>]+>", " ", body_text)
body_text = re.sub(r"&nbsp;", " ", body_text)
body_text = re.sub(r"\s+", " ", body_text).strip()

print(f"Email from: {from_name} <{from_addr}>")
print(f"Subject: {subject}")
print(f"Body preview: {body_text[:300]}")
print()

# Load style guide
style_guide = ""
try:
    with open("/opt/assistent/groups/privat/wiki/email-style-guide.md") as f:
        style_guide = f.read()
except:
    pass

style_examples = ""
try:
    with open("/opt/assistent/groups/privat/wiki/email-style-examples.md") as f:
        style_examples = f.read()[:2000]
except:
    pass

# Ask Claude to draft a reply in Magnus's style
api_key = env.get("ANTHROPIC_API_KEY", "")
prompt = f"""Du skal skrive et e-postsvar som Magnus Rudolfsen, daglig leder i Allvit AS.

Her er Magnus sin skrivestil:
{style_guide}

Her er noen eksempler på hvordan Magnus skriver:
{style_examples[:1500]}

Skriv et svar på denne e-posten. Følg stilen nøye — kort, direkte, uformell. Bruk "Hei," som åpning og "Magnus" eller "Mvh Magnus" som avslutning.

E-post å svare på:
Fra: {from_name} <{from_addr}>
Emne: {subject}
Innhold: {body_text[:800]}

Skriv KUN svarteksten (inkludert hilsen og signatur). Ikke inkluder emne eller metadata."""

ai_data = json.dumps({
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 500,
    "messages": [{"role": "user", "content": prompt}]
}).encode()
ai_req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=ai_data, headers={
    "x-api-key": api_key, "anthropic-version": "2023-06-01", "content-type": "application/json"
})
ai_resp = json.loads(urllib.request.urlopen(ai_req).read())
draft_text = ai_resp.get("content", [{}])[0].get("text", "")

print(f"Draft reply:\n---\n{draft_text}\n---\n")

# Save as draft via Graph API
reply_subject = subject if subject.startswith("SV:") or subject.startswith("Re:") else f"SV: {subject}"
draft_body = json.dumps({
    "subject": reply_subject,
    "body": {"contentType": "text", "content": draft_text},
    "toRecipients": [{"emailAddress": {"address": from_addr, "name": from_name}}],
    "isDraft": True,
}).encode()
draft_req = urllib.request.Request(base + "/messages", data=draft_body, headers=ghdrs, method="POST")
result = json.loads(urllib.request.urlopen(draft_req).read())
print(f"Draft saved! ID: {result['id'][:30]}...")
print(f"Subject: {result['subject']}")
print(f"Check your Drafts folder in Outlook.")
