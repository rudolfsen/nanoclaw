/**
 * Snapchat Marketing API OAuth2 authorization.
 * Run locally to obtain a refresh token.
 *
 * Since Snap requires HTTPS redirect, this runs on the Hetzner server.
 * Run: ssh root@204.168.178.32 'cd /opt/assistent && npx tsx scripts/snap-auth.ts'
 * Then open the URL in your browser.
 */
import https from 'https';
import http from 'http';
import fs from 'fs';
import url from 'url';
import path from 'path';
import crypto from 'crypto';

// Load .env
try {
  const envPath = path.resolve(process.cwd(), '.env');
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (k && !(k in process.env)) process.env[k] = v;
  }
} catch {}

const CLIENT_ID = process.env.SNAP_CLIENT_ID || '';
const CLIENT_SECRET = process.env.SNAP_CLIENT_SECRET || '';
const REDIRECT_URI = 'https://204.168.178.32:3335/callback';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set SNAP_CLIENT_ID and SNAP_CLIENT_SECRET in .env');
  process.exit(1);
}

const authUrl =
  `https://accounts.snapchat.com/login/oauth2/authorize?` +
  `response_type=code&client_id=${CLIENT_ID}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&scope=snapchat-marketing-api` +
  `&state=${crypto.randomUUID()}`;

console.log('Open this URL in your browser:\n');
console.log(authUrl);
console.log('\nWaiting for authorization on port 3335...');

// Generate self-signed cert for HTTPS
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
});

// Create self-signed cert for HTTPS
import { execSync } from 'child_process';
const keyFile = '/tmp/snap-auth-key.pem';
const certFile = '/tmp/snap-auth-cert.pem';
execSync(
  `openssl req -x509 -newkey rsa:2048 -keyout ${keyFile} -out ${certFile} -days 1 -nodes -subj "/CN=204.168.178.32" 2>/dev/null`,
);
const selfSignedCert = {
  key: fs.readFileSync(keyFile),
  cert: fs.readFileSync(certFile),
};

const server = https.createServer(selfSignedCert, async (req, res) => {
  const query = url.parse(req.url || '', true).query;
  if (!query.code) {
    res.writeHead(200);
    res.end('Waiting for authorization...');
    return;
  }

  res.writeHead(200);
  res.end('Authorization successful! You can close this tab.');

  // Exchange code for tokens
  const tokenBody = new URLSearchParams({
    code: query.code as string,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT_URI,
  });

  try {
    const tokenResp = await fetch(
      'https://accounts.snapchat.com/login/oauth2/access_token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenBody.toString(),
      },
    );

    const tokens = (await tokenResp.json()) as any;

    if (tokens.error) {
      console.error('\nError:', tokens.error_description || tokens.error);
      process.exit(1);
    }

    console.log('\nAdd this to your .env:\n');
    console.log(`SNAP_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log(`\nAccess token (expires in ${tokens.expires_in}s):`);
    console.log(tokens.access_token);
  } catch (err) {
    console.error('\nToken exchange failed:', err);
  }

  server.close();
  process.exit(0);
});

server.listen(3335, '0.0.0.0');
