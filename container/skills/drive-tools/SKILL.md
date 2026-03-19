# Drive Tools

Google Drive — sok, les og last opp filer.

## Capabilities

### Search Files

```bash
node -e "
  const { google } = require('googleapis');
  const auth = new google.auth.OAuth2(process.env.GOOGLE_OAUTH_CLIENT_ID, process.env.GOOGLE_OAUTH_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  const drive = google.drive({ version: 'v3', auth });
  drive.files.list({
    q: \"QUERY_HERE and trashed = false\",
    fields: 'files(id, name, mimeType, modifiedTime, size)',
    pageSize: 20
  }).then(r => {
    const files = r.data.files || [];
    if (files.length === 0) console.log('Ingen filer funnet.');
    else files.forEach(f => console.log(f.name + ' (' + f.mimeType + ') — ' + f.id));
  });
"
```

Replace `QUERY_HERE` with a Drive API query. Common patterns:
- Name search: `name contains 'kvittering'`
- Full-text: `fullText contains 'sokeord'`
- PDF files: `mimeType='application/pdf'`
- In folder: `'FOLDER_ID' in parents`

### Read File Content
For Google Docs, Sheets, Presentations — exports as text/CSV:

```bash
node -e "
  const { google } = require('googleapis');
  const auth = new google.auth.OAuth2(process.env.GOOGLE_OAUTH_CLIENT_ID, process.env.GOOGLE_OAUTH_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  const drive = google.drive({ version: 'v3', auth });
  const fileId = 'FILE_ID_HERE';
  drive.files.get({ fileId, fields: 'id,name,mimeType' }).then(async meta => {
    const mime = meta.data.mimeType;
    const exportMap = {
      'application/vnd.google-apps.document': 'text/plain',
      'application/vnd.google-apps.spreadsheet': 'text/csv',
      'application/vnd.google-apps.presentation': 'text/plain'
    };
    if (exportMap[mime]) {
      const r = await drive.files.export({ fileId, mimeType: exportMap[mime] }, { responseType: 'text' });
      console.log(r.data);
    } else if (mime.startsWith('text/')) {
      const r = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'text' });
      console.log(r.data);
    } else {
      console.log('Binary file — cannot display content. Name: ' + meta.data.name);
    }
  });
"
```

### Upload File

```bash
node -e "
  const { google } = require('googleapis');
  const fs = require('fs');
  const path = require('path');
  const auth = new google.auth.OAuth2(process.env.GOOGLE_OAUTH_CLIENT_ID, process.env.GOOGLE_OAUTH_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  const drive = google.drive({ version: 'v3', auth });
  const localPath = 'LOCAL_PATH';
  drive.files.create({
    requestBody: { name: path.basename(localPath) },
    media: { body: fs.createReadStream(localPath) },
    fields: 'id, name, mimeType'
  }).then(r => console.log('Lastet opp: ' + r.data.name + ' — id: ' + r.data.id));
"
```

Replace `LOCAL_PATH` with the file to upload. Optionally add `parents: ['FOLDER_ID']` to requestBody to place in a specific folder.
