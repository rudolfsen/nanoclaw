/**
 * Microsoft OAuth2 authorization for Outlook IMAP.
 * Run locally to obtain a refresh token for headless deployment.
 */
import fs from 'fs';
import http from 'http';
import path from 'path';
import url from 'url';

// Load .env file
const envPath = path.join(process.cwd(), '.env');
try {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
} catch { /* .env not found, rely on process.env */ }

const TENANT_ID = process.env.OUTLOOK_TENANT_ID;
const CLIENT_ID = process.env.OUTLOOK_CLIENT_ID;
const CLIENT_SECRET = process.env.OUTLOOK_CLIENT_SECRET;

if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set OUTLOOK_TENANT_ID, OUTLOOK_CLIENT_ID, and OUTLOOK_CLIENT_SECRET in .env');
  process.exit(1);
}

const REDIRECT_URI = 'http://localhost:3334/callback';
const SCOPES = [
  'https://graph.microsoft.com/Mail.ReadWrite',
  'https://graph.microsoft.com/Mail.Send',
  'https://graph.microsoft.com/MailboxSettings.ReadWrite',
  'https://graph.microsoft.com/Contacts.Read',
  'offline_access',
];

const authUrl = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize?` +
  `client_id=${CLIENT_ID}` +
  `&response_type=code` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&scope=${encodeURIComponent(SCOPES.join(' '))}` +
  `&response_mode=query`;

console.log('Open this URL in your browser:\n');
console.log(authUrl);
console.log('\nWaiting for authorization...');

const server = http.createServer(async (req, res) => {
  const query = url.parse(req.url || '', true).query;
  if (!query.code) return;

  res.end('Authorization successful! You can close this tab.');
  server.close();

  // Exchange code for tokens
  const tokenUrl = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: CLIENT_ID!,
    client_secret: CLIENT_SECRET!,
    code: query.code as string,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
    scope: SCOPES.join(' '),
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const tokens = await response.json() as any;

  if (tokens.error) {
    console.error('\nError:', tokens.error_description);
    process.exit(1);
  }

  console.log('\nAdd these to your .env and server:\n');
  console.log(`OUTLOOK_REFRESH_TOKEN=${tokens.refresh_token}`);
});

server.listen(3334);
