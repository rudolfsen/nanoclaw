# Musikk Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Andy access to Magnus' Spotify listening data so it can recommend music based on what he already listens to.

**Architecture:** Spotify Web API with OAuth2 for read access to user library and listening history. Auth script runs locally (like Google OAuth), refresh token stored on server. Container agent calls a skill script that fetches Spotify data and formats it for Claude to reason about.

**Tech Stack:** TypeScript, Spotify Web API, OAuth2

**Note:** Spotify credentials exist in the `~/Dev/rpd-mix/` project. Reuse client ID and secret from there.

---

### Task 1: Create Spotify OAuth2 auth script

**Files:**
- Create: `scripts/spotify-auth.ts`

- [ ] **Step 1: Find existing Spotify credentials**

```bash
find ~/Dev/rpd-mix -name ".env*" -o -name "*.json" | head -20
# Look for SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET
```

- [ ] **Step 2: Write the auth script**

```typescript
// scripts/spotify-auth.ts
import http from 'http';
import url from 'url';
import { readEnvFile } from '../src/env.js';

const SCOPES = [
  'user-top-read',
  'user-read-recently-played',
  'user-library-read',
].join(' ');

const REDIRECT_URI = 'http://localhost:3336/callback';

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

  // Exchange code for tokens
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
```

- [ ] **Step 3: Run locally and authorize**

```bash
source .env && npx tsx scripts/spotify-auth.ts
```

Open the URL in browser, authorize, copy the refresh token.

- [ ] **Step 4: Add credentials to server**

```bash
ssh root@204.168.178.32 "echo 'SPOTIFY_CLIENT_ID=<id>' >> /opt/assistent/.env && echo 'SPOTIFY_CLIENT_SECRET=<secret>' >> /opt/assistent/.env && echo 'SPOTIFY_REFRESH_TOKEN=<token>' >> /opt/assistent/.env"
```

- [ ] **Step 5: Commit**

```bash
git add scripts/spotify-auth.ts
git commit -m "feat: add Spotify OAuth2 auth script"
```

---

### Task 2: Create Spotify API skill for container agent

**Files:**
- Create: `src/skills/spotify.ts`
- Create: `src/skills/spotify.test.ts`

- [ ] **Step 1: Write test for token refresh**

```typescript
// src/skills/spotify.test.ts
import { describe, it, expect } from 'vitest';
import { formatTopArtists, formatRecentTracks } from './spotify.js';

describe('spotify formatting', () => {
  it('formats top artists list', () => {
    const artists = [
      { name: 'Radiohead', genres: ['alternative rock'] },
      { name: 'Bon Iver', genres: ['indie folk'] },
    ];
    const result = formatTopArtists(artists);
    expect(result).toContain('Radiohead');
    expect(result).toContain('alternative rock');
    expect(result).toContain('Bon Iver');
  });

  it('formats recent tracks', () => {
    const tracks = [
      { name: 'Creep', artist: 'Radiohead', album: 'Pablo Honey' },
      { name: 'Skinny Love', artist: 'Bon Iver', album: 'For Emma' },
    ];
    const result = formatRecentTracks(tracks);
    expect(result).toContain('Creep');
    expect(result).toContain('Radiohead');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/skills/spotify.test.ts`
Expected: FAIL — module doesn't exist

- [ ] **Step 3: Implement Spotify skill**

```typescript
// src/skills/spotify.ts

interface SpotifyArtist {
  name: string;
  genres: string[];
}

interface SpotifyTrack {
  name: string;
  artist: string;
  album: string;
}

async function refreshAccessToken(): Promise<string> {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  const refreshToken = process.env.SPOTIFY_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, or SPOTIFY_REFRESH_TOKEN');
  }

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  const json = await res.json() as { access_token?: string };
  if (!json.access_token) throw new Error('Spotify token refresh failed');
  return json.access_token;
}

export async function getTopArtists(timeRange = 'medium_term', limit = 20): Promise<SpotifyArtist[]> {
  const token = await refreshAccessToken();
  const res = await fetch(
    `https://api.spotify.com/v1/me/top/artists?time_range=${timeRange}&limit=${limit}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const json = await res.json() as { items?: Array<{ name: string; genres: string[] }> };
  return (json.items || []).map(a => ({ name: a.name, genres: a.genres }));
}

export async function getRecentTracks(limit = 20): Promise<SpotifyTrack[]> {
  const token = await refreshAccessToken();
  const res = await fetch(
    `https://api.spotify.com/v1/me/player/recently-played?limit=${limit}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const json = await res.json() as { items?: Array<{ track: { name: string; artists: Array<{ name: string }>; album: { name: string } } }> };
  return (json.items || []).map(i => ({
    name: i.track.name,
    artist: i.track.artists[0]?.name || 'Unknown',
    album: i.track.album.name,
  }));
}

export function formatTopArtists(artists: SpotifyArtist[]): string {
  return artists
    .map((a, i) => `${i + 1}. ${a.name} (${a.genres.slice(0, 3).join(', ')})`)
    .join('\n');
}

export function formatRecentTracks(tracks: SpotifyTrack[]): string {
  return tracks
    .map(t => `• ${t.name} — ${t.artist} (${t.album})`)
    .join('\n');
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/skills/spotify.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/skills/spotify.ts src/skills/spotify.test.ts
git commit -m "feat: add Spotify API skill with top artists and recent tracks"
```

---

### Task 3: Create container skill documentation

**Files:**
- Create: `container/skills/spotify/SKILL.md`

- [ ] **Step 1: Write the skill doc**

```markdown
<!-- container/skills/spotify/SKILL.md -->
# Spotify Music Recommendations

Access Magnus' Spotify listening data to give personalized music recommendations.

## Get Top Artists

\`\`\`bash
npx tsx -e "
  const { getTopArtists, formatTopArtists } = require('/workspace/project/dist/skills/spotify.js');
  getTopArtists('medium_term', 20).then(a => console.log(formatTopArtists(a)));
"
\`\`\`

Time ranges: `short_term` (4 weeks), `medium_term` (6 months), `long_term` (all time)

## Get Recent Tracks

\`\`\`bash
npx tsx -e "
  const { getRecentTracks, formatRecentTracks } = require('/workspace/project/dist/skills/spotify.js');
  getRecentTracks(20).then(t => console.log(formatRecentTracks(t)));
"
\`\`\`

## How to Recommend

1. Fetch top artists and recent tracks
2. Analyze genres and patterns
3. Suggest artists/tracks that are similar but new
4. Consider context if provided ("for training", "for focus", etc.)
5. Recommend across platforms — Spotify, YouTube Music, SoundCloud
6. Remember what Magnus has liked/disliked (update CLAUDE.md "Musikkpreferanser")
```

- [ ] **Step 2: Add music section to agent CLAUDE.md**

Add to `groups/privat/CLAUDE.md`:

```markdown
## Musikk

- Bruk Spotify-verktøyet for å hente lyttedata (se container/skills/spotify/SKILL.md)
- Anbefal musikk basert på preferanser og kontekst
- Magnus hører på Spotify, YouTube Music og SoundCloud — anbefal på tvers
- Husk preferanser under "Musikkpreferanser"

## Musikkpreferanser

(Andy oppdaterer denne basert på samtaler)
```

- [ ] **Step 3: Commit**

```bash
git add container/skills/spotify/ groups/privat/CLAUDE.md
git commit -m "feat: add Spotify skill docs and agent music capability"
```

---

### Task 4: Deploy and verify

- [ ] **Step 1: Build and deploy**

```bash
ssh root@204.168.178.32 'cd /opt/assistent && git pull && npm run build && ./container/build.sh && systemctl restart nanoclaw'
```

- [ ] **Step 2: Verify Spotify API works from server**

```bash
ssh root@204.168.178.32 'cd /opt/assistent && source .env && npx tsx -e "
  const { getTopArtists, formatTopArtists } = await import(\"./dist/skills/spotify.js\");
  const artists = await getTopArtists(\"short_term\", 5);
  console.log(formatTopArtists(artists));
"'
```

- [ ] **Step 3: Test via Telegram**

Send to Andy: `Hva har jeg hørt på i det siste? Har du noen anbefalinger?`

Verify Andy fetches Spotify data and gives recommendations.
