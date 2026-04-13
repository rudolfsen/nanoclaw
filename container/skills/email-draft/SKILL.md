# Email Draft

Lag svarutkast for viktige e-poster i brukerens egen stil.

## VIKTIG: Juridiske e-poster

Lag ALDRI svarutkast på e-poster som kan ha juridiske konsekvenser (oppsigelser, avtaler, tvister, krav, forlik, kontraktsbrudd, compliance). Send i stedet en melding:

"⚠️ Denne e-posten kan ha juridiske implikasjoner. Anbefaler å konsultere jurist før du svarer."

Eksempler på juridiske e-poster:
- Oppsigelse av avtaler/kontrakter
- Krav eller tvister
- Svar på juridiske henvendelser
- Regulatoriske/compliance-saker

## Når du lager utkast

1. Les stilguiden: `cat /workspace/group/wiki/email-style-guide.md`
2. Les eksempler: `cat /workspace/group/wiki/email-style-examples.md`
3. Analyser den innkommende e-posten (avsender, emne, kontekst)
4. Skriv et utkast som matcher brukerens tone og stil
5. Presenter utkastet tydelig markert:

📝 **Utkast til svar:**

[utkasttekst]

---
Godkjenn, rediger, eller forkast?

## Lagre godkjent utkast

### Outlook (magnus@allvit.no)
Skriv en IPC-fil for å lagre som draft:

```bash
cat > /workspace/ipc/tasks/draft-$(date +%s).json << 'EOF'
{
  "type": "save_outlook_draft",
  "to": "mottaker@example.com",
  "subject": "Re: Emne",
  "body": "Utkasttekst her",
  "conversationId": "original-conversation-id"
}
EOF
```

### Gmail
```bash
cat > /workspace/ipc/tasks/draft-$(date +%s).json << 'EOF'
{
  "type": "save_gmail_draft",
  "to": "mottaker@example.com",
  "subject": "Re: Emne",
  "body": "Utkasttekst her",
  "threadId": "gmail-thread-id",
  "inReplyTo": "<original-message-id>",
  "references": "<original-message-id>"
}
EOF
```

## Oppdater stildata etter godkjenning

Når brukeren godkjenner eller redigerer et utkast:

1. Lagre svaret som eksempel i `/workspace/group/wiki/email-style-examples.md`
2. Maks 20 eksempler — fjern de eldste om nødvendig
3. Hvis brukeren redigerte, noter forskjellen mellom utkast og endelig versjon
4. Etter ≥10 eksempler: oppdater `/workspace/group/wiki/email-style-guide.md`

## Eksempelformat

```markdown
## [dato] Re: [emne] → [mottaker]
Kontekst: [formell/uformell], [norsk/engelsk]
---
[godkjent svartekst]
---
```

## Stilguide-format

```markdown
# E-poststil

## Tone
- [observasjoner om formalitet, humor, etc.]

## Hilsener
- Norsk formell: [eksempel]
- Norsk uformell: [eksempel]
- Engelsk: [eksempel]

## Avslutninger
- [typiske avslutninger]

## Språkvalg
- [når norsk vs. engelsk]

## Formuleringer
- [typiske uttrykk og vendinger]
```

## Markér respons for læring

Etter godkjent utkast, oppdater delivery-tracking:

```bash
node -e "
  const db = require('better-sqlite3')('/data/messages.db');
  db.prepare('UPDATE outlook_deliveries SET responded = 1 WHERE uid = ?').run('EMAIL_UID');
  db.prepare('UPDATE email_categories SET response_count = response_count + 1, last_response_at = datetime(\"now\") WHERE sender = ?').run('SENDER_EMAIL');
"
```
