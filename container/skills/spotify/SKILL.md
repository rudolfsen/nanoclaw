# Spotify Music Recommendations

Access Magnus' Spotify listening data to give personalized music recommendations.

## Get Top Artists

```bash
npx tsx -e "
  import { getTopArtists, formatTopArtists } from '/workspace/project/dist/skills/spotify.js';
  const artists = await getTopArtists('medium_term', 20);
  console.log(formatTopArtists(artists));
"
```

Time ranges: `short_term` (4 weeks), `medium_term` (6 months), `long_term` (all time)

## Get Recent Tracks

```bash
npx tsx -e "
  import { getRecentTracks, formatRecentTracks } from '/workspace/project/dist/skills/spotify.js';
  const tracks = await getRecentTracks(20);
  console.log(formatRecentTracks(tracks));
"
```

## How to Recommend

1. Fetch top artists and recent tracks
2. Analyze genres and patterns
3. Suggest artists/tracks that are similar but new
4. Consider context if provided ("for training", "for focus", etc.)
5. Recommend across platforms — Spotify, YouTube Music, SoundCloud
6. Remember what Magnus has liked/disliked (update CLAUDE.md "Musikkpreferanser")
