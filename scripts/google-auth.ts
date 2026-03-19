import { google } from 'googleapis';
import http from 'http';
import url from 'url';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive',
];

async function main() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error('Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in .env');
    process.exit(1);
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, 'http://localhost:3333/callback');
  const authUrl = oauth2Client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });

  console.log('Open this URL in your browser:\n');
  console.log(authUrl);
  console.log('\nWaiting for authorization...');

  const code = await new Promise<string>((resolve) => {
    const server = http.createServer((req, res) => {
      const query = url.parse(req.url || '', true).query;
      if (query.code) {
        res.end('Authorization successful! You can close this tab.');
        server.close();
        resolve(query.code as string);
      }
    });
    server.listen(3333);
  });

  const { tokens } = await oauth2Client.getToken(code);
  console.log('\nAdd this to your Railway environment variables:\n');
  console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
}

main().catch(console.error);
