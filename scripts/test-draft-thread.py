#!/usr/bin/env python3
"""Test draft with full conversation thread context."""
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

def strip_html(html):
    text = re.sub(r"<style[^>]*>[\s\S]*?</style>", "", html, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    for ent, rep in [("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&#39;", "'")]:
        text = text.replace(ent, rep)
    text = re.sub(r"\s+", " ", text).strip()
    return text

# Search for the email - find the incoming one from Fagbokforlaget
params = urllib.parse.urlencode({
    "$top": "10",
    "$select": "id,subject,from,body,conversationId,receivedDateTime",
    "$search": '"Oppsigelse forhandleravtale"',
})
req = urllib.request.Request(base + "/messages?" + params, headers=ghdrs)
all_search = json.loads(urllib.request.urlopen(req).read()).get("value", [])
# Pick the one from fagbokforlaget (not from us, not a draft)
msgs = [m for m in all_search if "fagbokforlaget" in m.get("from", {}).get("emailAddress", {}).get("address", "")]
if not msgs:
    msgs = [m for m in all_search if "allvit" not in m.get("from", {}).get("emailAddress", {}).get("address", "")]
if not msgs:
    msgs = all_search[:1]

if not msgs:
    print("No emails found")
    exit(1)

conv_id = msgs[0].get("conversationId", "")
print(f"Conversation ID: {conv_id[:30]}...\n")

# Fetch ALL messages in this conversation using conversationId
# Graph doesn't support $filter on conversationId, so use $search on subject
# Fetch thread by searching broadly and filtering by conversationId
params2 = urllib.parse.urlencode({
    "$top": "20",
    "$select": "id,subject,from,body,receivedDateTime,sentDateTime,conversationId",
    "$search": '"Oppsigelse forhandleravtale"',
})
req2 = urllib.request.Request(base + "/messages?" + params2, headers=ghdrs)
all_results = json.loads(urllib.request.urlopen(req2).read()).get("value", [])
# Filter to same conversation
thread = [m for m in all_results if m.get("conversationId") == conv_id]
thread.sort(key=lambda m: m.get("receivedDateTime", ""))

print(f"Thread has {len(thread)} messages:\n")

thread_text = ""
latest_from_other = None

for msg in thread:
    from_addr = msg.get("from", {}).get("emailAddress", {}).get("address", "")
    from_name = msg.get("from", {}).get("emailAddress", {}).get("name", from_addr)
    subject = msg.get("subject", "")
    body_text = strip_html(msg.get("body", {}).get("content", ""))
    date = msg.get("receivedDateTime", "")[:16]

    # Extract just the reply (before quoted text)
    reply = body_text
    for sep in [" From: ", " Fra: ", " Sendt: "]:
        idx = reply.find(sep)
        if idx > 10:
            reply = reply[:idx].strip()
            break

    is_me = "allvit.no" in from_addr
    marker = "→ MAGNUS" if is_me else f"← {from_name}"
    print(f"  {date} {marker}")
    print(f"    {reply[:150]}")
    print()

    thread_text += f"\n{'Magnus' if is_me else from_name} ({date}):\n{reply[:400]}\n"

    if not is_me:
        latest_from_other = msg

if not latest_from_other:
    print("No external message to reply to")
    exit(1)

reply_to_addr = latest_from_other["from"]["emailAddress"]["address"]
reply_to_name = latest_from_other["from"]["emailAddress"]["name"]
reply_subject = latest_from_other.get("subject", "")
latest_body = strip_html(latest_from_other.get("body", {}).get("content", ""))

# Load style guide
style_guide = ""
try:
    with open("/opt/assistent/groups/privat/wiki/email-style-guide.md") as f:
        style_guide = f.read()
except:
    pass

# Draft with full thread context
prompt = f"""Du skal skrive et e-postsvar som Magnus Rudolfsen, daglig leder i Allvit AS.

Magnus sin skrivestil:
{style_guide}

Her er hele e-posttråden (eldst først):
{thread_text[:3000]}

Skriv Magnus sitt neste svar i tråden. Svar til {reply_to_name}.
Følg stilen nøye — kort, direkte, uformell. Bruk "Hei," som åpning og "Magnus" eller "Mvh Magnus" som avslutning.
Ta hensyn til hele konteksten i tråden, ikke bare siste melding.

Skriv KUN svarteksten (inkludert hilsen og signatur)."""

ai_data = json.dumps({
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 500,
    "messages": [{"role": "user", "content": prompt}]
}).encode()
ai_req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=ai_data, headers={
    "x-api-key": env["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01", "content-type": "application/json"
})
ai_resp = json.loads(urllib.request.urlopen(ai_req).read())
draft_text = ai_resp.get("content", [{}])[0].get("text", "")

print(f"\nDraft reply to {reply_to_name}:\n---\n{draft_text}\n---\n")

# Save as draft
if not reply_subject.startswith("SV:") and not reply_subject.startswith("Re:"):
    reply_subject = f"SV: {reply_subject}"

draft_body = json.dumps({
    "subject": reply_subject,
    "body": {"contentType": "text", "content": draft_text},
    "toRecipients": [{"emailAddress": {"address": reply_to_addr, "name": reply_to_name}}],
    "isDraft": True,
}).encode()
draft_req = urllib.request.Request(base + "/messages", data=draft_body, headers=ghdrs, method="POST")
result = json.loads(urllib.request.urlopen(draft_req).read())
print(f"Draft saved! Subject: {result['subject']}")
print("Check your Drafts folder in Outlook.")
