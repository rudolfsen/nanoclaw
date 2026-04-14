import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() => '# Test CLAUDE.md'),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
    },
  };
});

// Mock the Anthropic SDK
const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = { create: mockCreate };
    },
  };
});

import { runDirectAgent, buildSystemPrompt, buildTools } from './direct-agent.js';
import type { RegisteredGroup } from './types.js';
import type { ContainerOutput } from './container-runner.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@test',
  added_at: '2024-01-01T00:00:00Z',
};

describe('buildSystemPrompt', () => {
  it('joins global and group CLAUDE.md files', () => {
    const prompt = buildSystemPrompt('test-group');
    // existsSync returns true for both, readFileSync returns '# Test CLAUDE.md'
    expect(prompt).toContain('# Test CLAUDE.md');
    expect(prompt).toContain('---');
  });
});

describe('buildTools', () => {
  it('returns all expected tools', () => {
    const tools = buildTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('ats_feed');
    expect(names).toContain('send_message');
    expect(names).toContain('create_draft');
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
    expect(tools).toHaveLength(5);
  });
});

describe('runDirectAgent', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('returns success with text on end_turn', async () => {
    mockCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Hello from Claude!' }],
    });

    const outputs: ContainerOutput[] = [];
    const onOutput = vi.fn(async (output: ContainerOutput) => {
      outputs.push(output);
    });

    await runDirectAgent(testGroup, 'Hi there', 'chat@jid', onOutput);

    expect(onOutput).toHaveBeenCalledTimes(1);
    expect(outputs[0]).toEqual({
      status: 'success',
      result: 'Hello from Claude!',
    });
  });

  it('returns error output on API error', async () => {
    mockCreate.mockRejectedValueOnce(new Error('API rate limit exceeded'));

    const outputs: ContainerOutput[] = [];
    const onOutput = vi.fn(async (output: ContainerOutput) => {
      outputs.push(output);
    });

    await runDirectAgent(testGroup, 'Hi there', 'chat@jid', onOutput);

    expect(onOutput).toHaveBeenCalledTimes(1);
    expect(outputs[0]).toEqual({
      status: 'error',
      result: null,
      error: 'API rate limit exceeded',
    });
  });

  it('handles tool_use loop: first call returns tool_use, second returns end_turn', async () => {
    // First call: Claude wants to use a tool
    mockCreate.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'tool_abc123',
          name: 'read_file',
          input: { path: 'products.md' },
        },
      ],
    });

    // Second call: Claude returns final text
    mockCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Here is the file content summary.' }],
    });

    const outputs: ContainerOutput[] = [];
    const onOutput = vi.fn(async (output: ContainerOutput) => {
      outputs.push(output);
    });

    await runDirectAgent(testGroup, 'Read the products file', 'chat@jid', onOutput);

    // Should have been called twice: Claude API called twice
    expect(mockCreate).toHaveBeenCalledTimes(2);

    // onOutput called once for final result
    expect(onOutput).toHaveBeenCalledTimes(1);
    expect(outputs[0]).toEqual({
      status: 'success',
      result: 'Here is the file content summary.',
    });

    // Verify the second call included tool results
    const secondCall = mockCreate.mock.calls[1][0];
    expect(secondCall.messages).toHaveLength(3); // user, assistant (tool_use), user (tool_result)
    expect(secondCall.messages[2].role).toBe('user');

    const toolResultContent = secondCall.messages[2].content as Array<{ type: string; tool_use_id: string }>;
    expect(toolResultContent[0].type).toBe('tool_result');
    expect(toolResultContent[0].tool_use_id).toBe('tool_abc123');
  });

  it('streams intermediate text when tool_use follows text', async () => {
    // First call: Claude provides text + tool_use
    mockCreate.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Let me look that up for you.' },
        {
          type: 'tool_use',
          id: 'tool_xyz',
          name: 'read_file',
          input: { path: 'info.md' },
        },
      ],
    });

    // Second call: final answer
    mockCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Done!' }],
    });

    const outputs: ContainerOutput[] = [];
    const onOutput = vi.fn(async (output: ContainerOutput) => {
      outputs.push(output);
    });

    await runDirectAgent(testGroup, 'Look up info', 'chat@jid', onOutput);

    // Two outputs: intermediate text + final
    expect(onOutput).toHaveBeenCalledTimes(2);
    expect(outputs[0]).toEqual({
      status: 'success',
      result: 'Let me look that up for you.',
    });
    expect(outputs[1]).toEqual({
      status: 'success',
      result: 'Done!',
    });
  });

  it('returns null result on end_turn with no text', async () => {
    mockCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [],
    });

    const outputs: ContainerOutput[] = [];
    const onOutput = vi.fn(async (output: ContainerOutput) => {
      outputs.push(output);
    });

    await runDirectAgent(testGroup, 'Hi', 'chat@jid', onOutput);

    expect(outputs[0]).toEqual({
      status: 'success',
      result: null,
    });
  });
});
