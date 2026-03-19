# Calendar Tools

Google Calendar — les og opprett hendelser.

## Capabilities

### List Events for a Date
Use the Google Calendar MCP tool or run directly:

```bash
node -e "
  const { google } = require('googleapis');
  const auth = new google.auth.OAuth2(process.env.GOOGLE_OAUTH_CLIENT_ID, process.env.GOOGLE_OAUTH_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  const cal = google.calendar({ version: 'v3', auth });
  const date = 'DATE_HERE'; // YYYY-MM-DD
  cal.events.list({
    calendarId: 'primary',
    timeMin: new Date(date + 'T00:00:00').toISOString(),
    timeMax: new Date(date + 'T23:59:59').toISOString(),
    singleEvents: true,
    orderBy: 'startTime'
  }).then(r => {
    const events = r.data.items || [];
    if (events.length === 0) console.log('Ingen hendelser denne dagen.');
    else events.forEach(e => {
      const start = e.start?.dateTime || e.start?.date || '';
      const time = start.match(/T(\d{2}:\d{2})/)?.[1] || 'Heldags';
      console.log(time + ' — ' + (e.summary || '(Uten tittel)') + (e.location ? ' @ ' + e.location : ''));
    });
  });
"
```

Replace `DATE_HERE` with the target date in YYYY-MM-DD format.

### Create an Event

```bash
node -e "
  const { google } = require('googleapis');
  const auth = new google.auth.OAuth2(process.env.GOOGLE_OAUTH_CLIENT_ID, process.env.GOOGLE_OAUTH_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  const cal = google.calendar({ version: 'v3', auth });
  cal.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary: 'EVENT_TITLE',
      start: { dateTime: 'START_ISO' },
      end: { dateTime: 'END_ISO' },
      location: 'LOCATION'
    }
  }).then(r => console.log('Opprettet: ' + r.data.summary + ' — ' + r.data.htmlLink));
"
```

Replace `EVENT_TITLE`, `START_ISO`, `END_ISO`, and optionally `LOCATION`.

## Norwegian Natural Language Parsing
When the user writes in Norwegian, parse these patterns:
- Time: "kl 10", "kl. 14:30"
- Days: idag, imorgen, mandag, tirsdag, onsdag, torsdag, fredag, lordag, sondag
- Example: "Sett opp moete med Ola imorgen kl 10" -> summary="moete med Ola", day=tomorrow, hour=10
