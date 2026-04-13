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
    throw new Error(
      'Missing SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, or SPOTIFY_REFRESH_TOKEN',
    );
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

  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error('Spotify token refresh failed');
  return json.access_token;
}

export async function getTopArtists(
  timeRange = 'medium_term',
  limit = 20,
): Promise<SpotifyArtist[]> {
  const token = await refreshAccessToken();
  const res = await fetch(
    `https://api.spotify.com/v1/me/top/artists?time_range=${timeRange}&limit=${limit}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const json = (await res.json()) as {
    items?: Array<{ name: string; genres: string[] }>;
  };
  return (json.items || []).map((a) => ({ name: a.name, genres: a.genres }));
}

export async function getRecentTracks(limit = 20): Promise<SpotifyTrack[]> {
  const token = await refreshAccessToken();
  const res = await fetch(
    `https://api.spotify.com/v1/me/player/recently-played?limit=${limit}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const json = (await res.json()) as {
    items?: Array<{
      track: {
        name: string;
        artists: Array<{ name: string }>;
        album: { name: string };
      };
    }>;
  };
  return (json.items || []).map((i) => ({
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
  return tracks.map((t) => `• ${t.name} — ${t.artist} (${t.album})`).join('\n');
}
