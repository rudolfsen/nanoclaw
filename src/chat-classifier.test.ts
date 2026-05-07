import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { classifyPendingChats } from './chat-classifier.js';

interface MockAnthropic {
  messages: { create: ReturnType<typeof vi.fn> };
}

function makeAnthropic(jsonReplies: string[]): MockAnthropic {
  const create = vi.fn();
  for (const reply of jsonReplies) {
    create.mockResolvedValueOnce({
      content: [{ type: 'text', text: reply }],
      stop_reason: 'end_turn',
    });
  }
  return { messages: { create } };
}

function initTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE chat_contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT '',
      phone TEXT,
      email TEXT,
      interest TEXT,
      site TEXT NOT NULL,
      conversation TEXT,
      machines_shown TEXT,
      status TEXT,
      created_at TEXT NOT NULL,
      session_id TEXT
    );
  `);
  return db;
}

function insertPending(
  db: Database.Database,
  sessionId: string,
  conversation: { role: string; content: string }[],
): void {
  db.prepare(
    `INSERT INTO chat_contacts
     (session_id, name, site, conversation, machines_shown, status, created_at)
     VALUES (?, '', 'lbs', ?, '[]', 'pending_classification', ?)`,
  ).run(sessionId, JSON.stringify(conversation), new Date().toISOString());
}

describe('classifyPendingChats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('promotes pending rows to has_contact when the model finds contact info', async () => {
    const db = initTestDb();
    insertPending(db, 'sess_1', [
      { role: 'user', content: 'Selge dieseltank' },
      { role: 'assistant', content: 'Hva er navnet ditt?' },
      { role: 'user', content: 'Noah, 99999999' },
    ]);

    const anthropic = makeAnthropic([
      JSON.stringify({
        has_contact: true,
        name: 'Noah',
        phone: '99999999',
        email: null,
        interest: 'Selge dieseltank',
      }),
    ]);

    const result = await classifyPendingChats(db, anthropic as never);

    expect(result.classified).toBe(1);
    expect(anthropic.messages.create).toHaveBeenCalledTimes(1);

    const row = db
      .prepare('SELECT * FROM chat_contacts WHERE session_id = ?')
      .get('sess_1') as Record<string, unknown>;
    expect(row.status).toBe('has_contact');
    expect(row.name).toBe('Noah');
    expect(row.phone).toBe('99999999');
    expect(row.interest).toBe('Selge dieseltank');
  });

  it('marks rows as no_contact when the model finds nothing', async () => {
    const db = initTestDb();
    insertPending(db, 'sess_2', [
      { role: 'user', content: 'Har dere traktor?' },
      { role: 'assistant', content: 'Vi har flere modeller, se ats.no.' },
    ]);

    const anthropic = makeAnthropic([
      JSON.stringify({
        has_contact: false,
        name: null,
        phone: null,
        email: null,
        interest: null,
      }),
    ]);

    await classifyPendingChats(db, anthropic as never);

    const row = db
      .prepare('SELECT * FROM chat_contacts WHERE session_id = ?')
      .get('sess_2') as Record<string, unknown>;
    expect(row.status).toBe('no_contact');
    expect(row.name).toBe('');
  });

  it('skips rows that are already has_contact or no_contact', async () => {
    const db = initTestDb();
    db.prepare(
      `INSERT INTO chat_contacts (session_id, name, site, conversation, machines_shown, status, created_at)
       VALUES ('sess_done', 'Noah', 'lbs', '[]', '[]', 'has_contact', ?)`,
    ).run(new Date().toISOString());
    db.prepare(
      `INSERT INTO chat_contacts (session_id, name, site, conversation, machines_shown, status, created_at)
       VALUES ('sess_skip', '', 'lbs', '[]', '[]', 'no_contact', ?)`,
    ).run(new Date().toISOString());

    const anthropic = makeAnthropic([]);

    const result = await classifyPendingChats(db, anthropic as never);

    expect(result.classified).toBe(0);
    expect(anthropic.messages.create).not.toHaveBeenCalled();
  });

  it('leaves the row pending when the model returns malformed JSON', async () => {
    const db = initTestDb();
    insertPending(db, 'sess_bad', [{ role: 'user', content: 'hei' }]);

    const anthropic = makeAnthropic(['this is not JSON at all']);

    await classifyPendingChats(db, anthropic as never);

    const row = db
      .prepare('SELECT status FROM chat_contacts WHERE session_id = ?')
      .get('sess_bad') as { status: string };
    // Don't bury the row in no_contact based on a parse error — leave pending
    // for retry on the next pass.
    expect(row.status).toBe('pending_classification');
  });

  it('respects the row limit', async () => {
    const db = initTestDb();
    for (let i = 0; i < 5; i++) {
      insertPending(db, `sess_${i}`, [{ role: 'user', content: `msg ${i}` }]);
    }
    const anthropic = makeAnthropic(
      Array(5).fill(
        JSON.stringify({
          has_contact: false,
          name: null,
          phone: null,
          email: null,
          interest: null,
        }),
      ),
    );

    const result = await classifyPendingChats(db, anthropic as never, {
      limit: 2,
    });

    expect(result.classified).toBe(2);
    expect(anthropic.messages.create).toHaveBeenCalledTimes(2);

    const remaining = db
      .prepare(
        "SELECT COUNT(*) as n FROM chat_contacts WHERE status = 'pending_classification'",
      )
      .get() as { n: number };
    expect(remaining.n).toBe(3);
  });
});
