/**
 * Direct Agent Runner for NanoClaw
 * Runs Claude via the Anthropic Messages API with tool use, in-process.
 * Replaces Docker container spawning for customer instances.
 */
import Anthropic from '@anthropic-ai/sdk';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { ContainerOutput } from './container-runner.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

const MAX_TOOL_TURNS = 30;
const MODEL = 'claude-sonnet-4-6';
const ATS_FEED_TIMEOUT = 30_000;

/**
 * Build the system prompt by concatenating global and group CLAUDE.md files.
 */
export function buildSystemPrompt(groupFolder: string): string {
  const parts: string[] = [];

  const globalPath = path.join(GROUPS_DIR, 'global', 'CLAUDE.md');
  if (fs.existsSync(globalPath)) {
    parts.push(fs.readFileSync(globalPath, 'utf-8'));
  }

  const groupPath = path.join(GROUPS_DIR, groupFolder, 'CLAUDE.md');
  if (fs.existsSync(groupPath)) {
    parts.push(fs.readFileSync(groupPath, 'utf-8'));
  }

  return parts.join('\n\n---\n\n');
}

/**
 * Build tool definitions for the Anthropic Messages API.
 */
export function buildTools(): Anthropic.Tool[] {
  return [
    {
      name: 'ats_feed',
      description:
        'Query the ATS Norway product database. Commands: list [count], get <id>, search <query>.',
      input_schema: {
        type: 'object' as const,
        properties: {
          command: {
            type: 'string',
            description: 'The command to run: list, get, or search',
            enum: ['list', 'get', 'search'],
          },
          argument: {
            type: 'string',
            description:
              'Optional argument for the command (count for list, id for get, query for search)',
          },
        },
        required: ['command'],
      },
    },
    {
      name: 'lbs_feed',
      description:
        'Query the Landbrukssalg.no agricultural equipment database. Commands: list [count], get <id>, search <query>, categories.',
      input_schema: {
        type: 'object' as const,
        properties: {
          command: {
            type: 'string',
            description: 'The command to run: list, get, search, or categories',
            enum: ['list', 'get', 'search', 'categories'],
          },
          argument: {
            type: 'string',
            description:
              'Argument for the command (count for list, id for get, query for search)',
          },
        },
        required: ['command'],
      },
    },
    {
      name: 'send_message',
      description: 'Send a message to a chat via IPC.',
      input_schema: {
        type: 'object' as const,
        properties: {
          chat_jid: {
            type: 'string',
            description: 'The JID of the chat to send the message to',
          },
          text: {
            type: 'string',
            description: 'The message text to send',
          },
        },
        required: ['chat_jid', 'text'],
      },
    },
    {
      name: 'create_draft',
      description:
        'Create an email draft via IPC. Set provider to "gmail" or "outlook" depending on which channel received the email.',
      input_schema: {
        type: 'object' as const,
        properties: {
          provider: {
            type: 'string',
            description: 'Email provider: "outlook" or "gmail"',
            enum: ['outlook', 'gmail'],
          },
          to: {
            type: 'string',
            description: 'Recipient email address',
          },
          subject: {
            type: 'string',
            description: 'Email subject',
          },
          body: {
            type: 'string',
            description: 'Email body content',
          },
          conversationId: {
            type: 'string',
            description: 'Outlook: conversation ID for threading',
          },
          fromAddress: {
            type: 'string',
            description: 'Outlook: sender address for shared mailbox',
          },
          categories: {
            type: 'array',
            items: { type: 'string' },
            description: 'Outlook: categories for color coding',
          },
          threadId: {
            type: 'string',
            description: 'Gmail: thread ID for reply threading',
          },
          inReplyTo: {
            type: 'string',
            description: 'Gmail: Message-ID header for In-Reply-To',
          },
          references: {
            type: 'string',
            description: 'Gmail: Message-ID header for References',
          },
        },
        required: ['to', 'subject', 'body'],
      },
    },
    {
      name: 'read_file',
      description: 'Read a file from the group wiki directory.',
      input_schema: {
        type: 'object' as const,
        properties: {
          path: {
            type: 'string',
            description: 'File path relative to the group wiki directory',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'write_file',
      description: 'Write content to a file in the group wiki directory.',
      input_schema: {
        type: 'object' as const,
        properties: {
          path: {
            type: 'string',
            description: 'File path relative to the group wiki directory',
          },
          content: {
            type: 'string',
            description: 'Content to write to the file',
          },
        },
        required: ['path', 'content'],
      },
    },
  ];
}

/**
 * Execute the ats-feed.sh script with the given command and argument.
 */
export function executeAtsFeed(
  command: string,
  argument?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(
      process.cwd(),
      'container',
      'skills',
      'ats-feed',
      'ats-feed.sh',
    );

    if (!fs.existsSync(scriptPath)) {
      resolve('Error: ats-feed.sh not found');
      return;
    }

    const args = [command];
    if (argument) args.push(argument);

    execFile(
      scriptPath,
      args,
      { timeout: ATS_FEED_TIMEOUT },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`ats-feed error: ${stderr || error.message}`));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

/**
 * Write a JSON file to the group's IPC directory.
 */
export function writeIpcFile(
  groupFolder: string,
  dir: string,
  data: Record<string, unknown>,
): void {
  const ipcDir = path.join(DATA_DIR, 'ipc', groupFolder, dir);
  fs.mkdirSync(ipcDir, { recursive: true });

  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  const filename = `${timestamp}-${random}.json`;

  fs.writeFileSync(path.join(ipcDir, filename), JSON.stringify(data, null, 2));
}

/**
 * Execute a tool call and return the result as a string.
 */
export async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  groupFolder: string,
): Promise<string> {
  switch (toolName) {
    case 'ats_feed': {
      const result = await executeAtsFeed(
        input.command as string,
        input.argument as string | undefined,
      );
      return result;
    }

    case 'lbs_feed': {
      const scriptPath = path.join(
        process.cwd(),
        'container',
        'skills',
        'lbs-feed',
        'lbs-feed.sh',
      );
      if (!fs.existsSync(scriptPath)) {
        return 'Error: lbs-feed.sh not found';
      }
      return new Promise((resolve) => {
        const args = [input.command as string];
        if (input.argument) args.push(input.argument as string);
        execFile(
          scriptPath,
          args,
          { timeout: 30_000 },
          (error, stdout, stderr) => {
            if (error) resolve(`Error: ${stderr || error.message}`);
            else resolve(stdout || 'No results');
          },
        );
      });
    }

    case 'send_message': {
      writeIpcFile(groupFolder, 'messages', {
        type: 'message',
        chatJid: input.chat_jid,
        text: input.text,
      });
      return 'Message queued for delivery.';
    }

    case 'create_draft': {
      // Auto-detect provider from configured channels — agent's choice is ignored
      // to prevent misconfiguration (agent often defaults to "outlook")
      const outlookConfigured = !!(
        process.env.OUTLOOK_REFRESH_TOKEN &&
        process.env.OUTLOOK_REFRESH_TOKEN.length > 10
      );
      const provider = outlookConfigured ? 'outlook' : 'gmail';
      if (provider === 'gmail') {
        writeIpcFile(groupFolder, 'tasks', {
          type: 'save_gmail_draft',
          to: input.to,
          subject: input.subject,
          body: input.body,
          threadId: input.threadId,
          inReplyTo: input.inReplyTo,
          references: input.references,
        });
      } else {
        writeIpcFile(groupFolder, 'tasks', {
          type: 'save_outlook_draft',
          to: input.to,
          subject: input.subject,
          body: input.body,
          conversationId: input.conversationId,
          from: input.fromAddress,
          categories: input.categories,
        });
      }
      return 'Draft creation queued.';
    }

    case 'read_file': {
      const safeName = path.basename(input.path as string);
      const wikiDir = path.join(GROUPS_DIR, groupFolder, 'wiki');
      const filePath = path.join(wikiDir, safeName);

      if (!fs.existsSync(filePath)) {
        return `File not found: ${safeName}`;
      }
      return fs.readFileSync(filePath, 'utf-8');
    }

    case 'write_file': {
      const safeName = path.basename(input.path as string);
      const wikiDir = path.join(GROUPS_DIR, groupFolder, 'wiki');
      fs.mkdirSync(wikiDir, { recursive: true });

      const filePath = path.join(wikiDir, safeName);
      fs.writeFileSync(filePath, input.content as string);
      return `File written: ${safeName}`;
    }

    default:
      return `Unknown tool: ${toolName}`;
  }
}

/**
 * Run the direct agent — calls Claude via the Anthropic Messages API
 * with a manual tool-use agentic loop.
 */
export async function runDirectAgent(
  group: RegisteredGroup,
  prompt: string,
  _chatJid: string,
  onOutput: (output: ContainerOutput) => Promise<void>,
): Promise<void> {
  try {
    const client = new Anthropic();
    const systemPrompt = buildSystemPrompt(group.folder);
    const tools = buildTools();

    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: prompt },
    ];

    let turns = 0;

    while (turns < MAX_TOOL_TURNS) {
      turns++;

      logger.debug(
        { group: group.name, turn: turns },
        'Direct agent: calling Claude',
      );

      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 16384,
        system: systemPrompt,
        tools,
        messages,
      });

      // Collect text blocks for intermediate streaming
      const textParts: string[] = [];
      const toolUseBlocks: Anthropic.ContentBlock[] = [];

      for (const block of response.content) {
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          toolUseBlocks.push(block);
        }
        // thinking blocks are silently consumed
      }

      // Stream intermediate text to user between tool calls
      if (textParts.length > 0 && toolUseBlocks.length > 0) {
        const intermediateText = textParts.join('\n');
        if (intermediateText.trim()) {
          await onOutput({ status: 'success', result: intermediateText });
        }
      }

      // If stop reason is end_turn, return final text
      if (response.stop_reason === 'end_turn') {
        const finalText = textParts.join('\n');
        await onOutput({ status: 'success', result: finalText || null });
        return;
      }

      // Process tool use blocks
      if (response.stop_reason === 'tool_use' && toolUseBlocks.length > 0) {
        // Add the assistant's response to messages
        messages.push({ role: 'assistant', content: response.content });

        // Execute each tool and build results
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const block of toolUseBlocks) {
          if (block.type === 'tool_use') {
            logger.info(
              { group: group.name, tool: block.name, turn: turns },
              'Direct agent: executing tool',
            );

            try {
              const result = await executeTool(
                block.name,
                block.input as Record<string, unknown>,
                group.folder,
              );
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: result,
              });
            } catch (err) {
              const errorMessage =
                err instanceof Error ? err.message : String(err);
              logger.error(
                { group: group.name, tool: block.name, err },
                'Direct agent: tool execution failed',
              );
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: `Error: ${errorMessage}`,
                is_error: true,
              });
            }
          }
        }

        // Add tool results to messages
        messages.push({ role: 'user', content: toolResults });
      } else {
        // Unexpected stop reason — return what we have
        const finalText = textParts.join('\n');
        await onOutput({ status: 'success', result: finalText || null });
        return;
      }
    }

    // Max turns reached
    logger.warn(
      { group: group.name, turns: MAX_TOOL_TURNS },
      'Direct agent: max tool turns reached',
    );
    await onOutput({
      status: 'error',
      result: null,
      error: `Agent reached maximum tool turns (${MAX_TOOL_TURNS})`,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error({ group: group.name, err }, 'Direct agent: unhandled error');
    await onOutput({
      status: 'error',
      result: null,
      error: errorMessage,
    });
  }
}
