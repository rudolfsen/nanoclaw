import { describe, it, expect, vi } from 'vitest';
import { categorizeEmail, lookupLearnedCategory, classifyWithClaude, EmailInput } from '../src/skills/email-sorter';
import Database from 'better-sqlite3';
import { initSkillTables } from '../src/db';

describe('Email Sorter - Heuristic', () => {
  it('should detect receipt emails by common patterns', () => {
    const email: EmailInput = {
      from: 'noreply@facebookmail.com',
      subject: 'Your receipt from Meta',
      body: 'Amount charged: 1,500.00 NOK',
    };
    const result = categorizeEmail(email);
    expect(result.category).toBe('kvittering');
  });

  it('should detect newsletters', () => {
    const email: EmailInput = {
      from: 'newsletter@example.com',
      subject: 'Weekly digest',
      body: 'Unsubscribe from this newsletter',
    };
    const result = categorizeEmail(email);
    expect(result.category).toBe('nyhetsbrev');
  });

  it('should classify personal sender as viktig', () => {
    const email: EmailInput = {
      from: 'person@company.com',
      subject: 'Hello',
      body: 'Just checking in',
    };
    const result = categorizeEmail(email);
    expect(result.category).toBe('viktig');
  });
});

describe('Email Sorter - Learned Categories', () => {
  it('should use learned category from database', () => {
    const db = new Database(':memory:');
    initSkillTables(db);
    db.prepare('INSERT INTO email_categories (sender, category, confidence) VALUES (?, ?, ?)')
      .run('person@company.com', 'jobb', 0.9);

    const result = lookupLearnedCategory(db, 'person@company.com');
    expect(result?.category).toBe('jobb');
    expect(result?.confidence).toBe(0.9);
    db.close();
  });

  it('should return null for unknown senders', () => {
    const db = new Database(':memory:');
    initSkillTables(db);
    const result = lookupLearnedCategory(db, 'unknown@example.com');
    expect(result).toBeNull();
    db.close();
  });
});

describe('Email Sorter - Claude Classification', () => {
  it('should return a valid category result', async () => {
    const mockClaude = vi.fn().mockResolvedValue({
      category: 'jobb',
      confidence: 0.85,
    });

    const email: EmailInput = {
      from: 'person@company.com',
      subject: 'Q1 budget review',
      body: 'Please review the attached budget',
    };

    const result = await classifyWithClaude(email, mockClaude);
    expect(result.category).toBe('jobb');
    expect(result.confidence).toBe(0.85);
    expect(result.needsAI).toBe(false);
  });
});
