import http from 'http';
import url from 'url';
import { readEnvFile } from '../src/env.js';

const SCOPES = [
  'user-top-read',
  'user-read-recently-played',
  'user-library-read',
].join(' ');

const REDIRECT_URI = 'http://127.0.0.1:3336/callback';

async function main() {
  const env = readEnvFile(['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET']);
  const clientId = process.env.SPOTIFY_CLIENT_ID || env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET || env.SPOTIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error('Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env');
    process.exit(1);
  }

  const authUrl = new URL('https://accounts.spotify.com/authorize');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('scope', SCOPES);

  console.log('Open this URL in your browser:\n');
  console.log(authUrl.toString());
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
    server.listen(3336);
  });

  const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });

  const tokens = await tokenRes.json() as { refresh_token?: string; access_token?: string };

  if (!tokens.refresh_token) {
    console.error('No refresh token in response:', tokens);
    process.exit(1);
  }

  console.log('\nAdd this to your .env on the server:\n');
  console.log(`SPOTIFY_REFRESH_TOKEN=${tokens.refresh_token}`);
}

main().catch(console.error);
