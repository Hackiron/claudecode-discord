import { Message, TextChannel } from "discord.js";

const COLD_START_WINDOW = 30;
const MAX_CHARS_PER_MESSAGE = 800;
const MAX_TOTAL_CHARS = 6000;

// Last message this bot already folded into a prompt, per channel.
const lastHandled = new Map<string, string>();

export function markHandled(channelId: string, messageId: string): void {
  lastHandled.set(channelId, messageId);
}

function label(m: Message): string {
  const name = m.member?.displayName ?? m.author.username;
  return m.author.bot ? `${name} (bot)` : name;
}

/**
 * Transcript of what happened in the channel since this bot last answered.
 * Own messages are skipped — they are already in the resumed Claude session.
 */
export async function buildChannelContext(message: Message): Promise<string> {
  const channel = message.channel as TextChannel;
  const selfId = message.client.user!.id;
  const after = lastHandled.get(channel.id);

  const fetched = after
    ? await channel.messages.fetch({ after, limit: 100 })
    : await channel.messages.fetch({ limit: COLD_START_WINDOW });

  const lines: string[] = [];

  for (const m of [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp)) {
    if (m.id === message.id) continue;
    if (m.author.id === selfId) continue;
    if (m.system) continue;

    const content = m.content.trim();
    if (!content) continue;

    const truncated =
      content.length > MAX_CHARS_PER_MESSAGE
        ? `${content.slice(0, MAX_CHARS_PER_MESSAGE)}…`
        : content;
    lines.push(`${label(m)}: ${truncated}`);
  }

  // Drop oldest lines until the transcript fits.
  let total = lines.reduce((sum, l) => sum + l.length + 1, 0);
  while (lines.length > 0 && total > MAX_TOTAL_CHARS) {
    total -= lines[0].length + 1;
    lines.shift();
  }

  return lines.join("\n");
}
