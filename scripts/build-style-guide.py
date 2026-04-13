#!/usr/bin/env python3
"""Scan sent emails and build a writing style guide using Claude."""
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
    text = re.sub(r"&nbsp;", " ", text)
    text = re.sub(r"&amp;", "&", text)
    text = re.sub(r"&lt;", "<", text)
    text = re.sub(r"&gt;", ">", text)
    text = re.sub(r"&quot;", '"', text)
    text = re.sub(r"\s+", " ", text).strip()
    return text

# Fetch sent emails (last 30 days, max 50)
print("Fetching sent emails...")
params = urllib.parse.urlencode({
    "$top": "50",
    "$select": "subject,toRecipients,body,sentDateTime",
    "$orderby": "sentDateTime desc",
})
req = urllib.request.Request(base + "/mailFolders/SentItems/messages?" + params, headers=ghdrs)
msgs = json.loads(urllib.request.urlopen(req).read()).get("value", [])

print(f"Found {len(msgs)} sent emails\n")

# Extract reply texts (strip quoted content)
examples = []
for msg in msgs:
    subject = msg.get("subject", "")
    to_list = msg.get("toRecipients", [])
    to = to_list[0]["emailAddress"]["address"] if to_list else ""
    to_name = to_list[0]["emailAddress"].get("name", to) if to_list else ""
    body_html = msg.get("body", {}).get("content", "")
    body_text = strip_html(body_html)

    # Try to extract just the reply (before quoted text)
    # Common patterns: "From:", "Fra:", "On ... wrote:", "Den ... skrev:"
    reply_text = body_text
    for sep in [" From: ", " Fra: ", " On ", " Den ", "________________________________"]:
        idx = reply_text.find(sep)
        if idx > 20:  # Must have some content before the separator
            reply_text = reply_text[:idx].strip()
            break

    # Skip very short or empty replies
    if len(reply_text) < 20:
        continue
    # Skip auto-replies
    if reply_text.startswith("Automatic reply") or reply_text.startswith("Automatisk svar"):
        continue

    # Determine context
    is_english = not any(c in reply_text.lower() for c in ["hei", "takk", "hilsen", "mvh", "vennlig"])
    formality = "formell" if any(w in reply_text.lower() for w in ["med vennlig hilsen", "best regards", "kind regards"]) else "uformell"

    examples.append({
        "subject": subject,
        "to": to,
        "to_name": to_name,
        "text": reply_text[:500],
        "lang": "english" if is_english else "norsk",
        "formality": formality,
    })

print(f"Extracted {len(examples)} usable examples\n")

# Show a few examples
for i, ex in enumerate(examples[:5]):
    print(f"--- Example {i+1}: {ex['subject'][:50]} → {ex['to_name'][:30]} ({ex['lang']}, {ex['formality']}) ---")
    print(f"{ex['text'][:200]}")
    print()

# Save top 20 examples to wiki file
examples_md = "# E-post svareksempler\n\nSamling av Magnus sine faktiske svar, hentet fra Sendte elementer.\n\n"
for i, ex in enumerate(examples[:20]):
    examples_md += f"## {ex['subject'][:60]} → {ex['to_name'][:30]}\n"
    examples_md += f"Kontekst: {ex['formality']}, {ex['lang']}\n"
    examples_md += f"---\n{ex['text'][:400]}\n---\n\n"

examples_path = "/opt/assistent/groups/privat/wiki/email-style-examples.md"
with open(examples_path, "w") as f:
    f.write(examples_md)
print(f"Saved {min(len(examples), 20)} examples to {examples_path}")

# Now ask Claude to analyze the style and create a guide
print("\nAnalyzing writing style with Claude...")

all_texts = "\n\n---\n\n".join([
    f"To: {ex['to_name']} ({ex['lang']})\nSubject: {ex['subject']}\n\n{ex['text'][:300]}"
    for ex in examples[:20]
])

style_prompt = f"""Analyser disse e-postsvarene skrevet av Magnus Rudolfsen (daglig leder i Allvit, norsk bokbransje-teknologi). Lag en kort stilguide som beskriver hvordan han skriver.

E-poster:
{all_texts[:4000]}

Lag en stilguide i dette formatet (skriv på norsk):

# E-poststil — Magnus Rudolfsen

## Tone
- [observasjoner]

## Hilsener
- Norsk formell: [eksempel]
- Norsk uformell: [eksempel]
- Engelsk: [eksempel]

## Avslutninger
- [typiske avslutninger]

## Språkvalg
- [når norsk vs. engelsk]

## Typiske formuleringer
- [uttrykk og vendinger Magnus bruker ofte]

## Lengde og struktur
- [observasjoner om svarenes lengde og oppbygging]

Vær konkret og bruk eksempler fra e-postene."""

ai_data = json.dumps({
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 1500,
    "messages": [{"role": "user", "content": style_prompt}]
}).encode()
ai_req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=ai_data, headers={
    "x-api-key": env["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01", "content-type": "application/json"
})
ai_resp = json.loads(urllib.request.urlopen(ai_req).read())
style_guide = ai_resp.get("content", [{}])[0].get("text", "")

guide_path = "/opt/assistent/groups/privat/wiki/email-style-guide.md"
with open(guide_path, "w") as f:
    f.write(style_guide)

print(f"\nStyle guide saved to {guide_path}")
print("\n" + style_guide)
