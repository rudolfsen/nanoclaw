import { describe, it, expect } from 'vitest';
import { formatTopArtists, formatRecentTracks } from './spotify.js';

describe('spotify formatting', () => {
  it('formats top artists with numbered list and genres', () => {
    const artists = [
      { name: 'Radiohead', genres: ['alternative rock', 'art rock'] },
      { name: 'Bon Iver', genres: ['indie folk', 'chamber pop'] },
    ];
    const result = formatTopArtists(artists);
    expect(result).toContain('1. Radiohead');
    expect(result).toContain('alternative rock');
    expect(result).toContain('2. Bon Iver');
  });

  it('formats recent tracks with bullet points', () => {
    const tracks = [
      { name: 'Creep', artist: 'Radiohead', album: 'Pablo Honey' },
      { name: 'Skinny Love', artist: 'Bon Iver', album: 'For Emma' },
    ];
    const result = formatRecentTracks(tracks);
    expect(result).toContain('• Creep — Radiohead');
    expect(result).toContain('Pablo Honey');
  });

  it('handles empty arrays', () => {
    expect(formatTopArtists([])).toBe('');
    expect(formatRecentTracks([])).toBe('');
  });

  it('truncates genres to 3', () => {
    const artists = [
      { name: 'Test', genres: ['a', 'b', 'c', 'd', 'e'] },
    ];
    const result = formatTopArtists(artists);
    expect(result).toContain('a, b, c');
    expect(result).not.toContain('d');
  });
});
