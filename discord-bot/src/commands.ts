// Slash command registration + handling for the GitSync bot.
//
// `/gitsync-listen url:<repo-url>` binds the channel it's run in to a repo.
// The bot has no Firestore credentials, so the binding is persisted by POSTing
// to the secret-auth `setRepoChannel` Cloud Function (which reuses the same
// parseGithubUrl → repoId logic as addRepo). Commands are registered per guild
// (not globally) so they appear instantly. See ARCHITECTURE.md §7.
import {
  ApplicationCommandOptionType,
  Guild,
  MessageFlags,
  type ApplicationCommandDataResolvable,
  type ChatInputCommandInteraction,
  type Client,
} from 'discord.js';

import type { BotConfig } from './config';

export const LISTEN_COMMAND = 'gitsync-listen';
export const DIGEST_COMMAND = 'gitsync-digest';

// Command definitions registered as guild commands.
const COMMAND_DEFS: ApplicationCommandDataResolvable[] = [
  {
    name: LISTEN_COMMAND,
    description: 'Listen to this channel for a GitHub repo (give the repo URL).',
    options: [
      {
        name: 'url',
        description: 'GitHub repo URL, e.g. https://github.com/owner/repo.git',
        type: ApplicationCommandOptionType.String,
        required: true,
      },
    ],
  },
  {
    name: DIGEST_COMMAND,
    description: "Ask AI to adjust this channel's daily digest summary.",
    options: [
      {
        name: 'instruction',
        description: 'How to adjust the summary, e.g. "shorten it" or "add action items".',
        type: ApplicationCommandOptionType.String,
        required: true,
      },
      {
        name: 'date',
        description: 'Day to edit (YYYY-MM-DD). Defaults to today.',
        type: ApplicationCommandOptionType.String,
        required: false,
      },
    ],
  },
];

// Registers the guild commands for one guild. Guild commands propagate
// instantly (unlike global commands, which can take up to an hour).
export async function registerGuildCommands(guild: Guild): Promise<void> {
  try {
    await guild.commands.set(COMMAND_DEFS);
    console.log(`[commands] registered in guild ${guild.id} (${guild.name})`);
  } catch (e) {
    console.error(`[commands] failed to register in guild ${guild.id}: ${String(e)}`);
  }
}

// Registers commands across every guild the bot is currently in.
export async function registerAllGuildCommands(client: Client): Promise<void> {
  await Promise.all(client.guilds.cache.map((g) => registerGuildCommands(g)));
}

// Handles the /gitsync-listen chat-input command: POST the binding to
// setRepoChannel and reply ephemerally with the result.
export async function handleListenCommand(
  interaction: ChatInputCommandInteraction,
  cfg: BotConfig,
): Promise<void> {
  const url = interaction.options.getString('url', true);
  const { guildId, channelId } = interaction;

  if (!guildId) {
    await interaction.reply({
      content: 'This command must be run inside a server channel.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    const res = await fetch(cfg.setRepoChannelUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ingest-secret': cfg.ingestSecret,
      },
      body: JSON.stringify({ githubUrl: url, guildId, channelId }),
      signal: AbortSignal.timeout(8000),
    });

    if (res.ok) {
      const { repoId } = (await res.json()) as { repoId?: string };
      await interaction.reply({
        content: `Now listening this channel for \`${repoId ?? 'unknown'}\`.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (res.status === 404) {
      await interaction.reply({
        content: 'Repo not found — add it in the app first.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const body = await res.text();
    await interaction.reply({
      content: `Could not bind this channel (HTTP ${res.status}): ${body}`,
      flags: MessageFlags.Ephemeral,
    });
  } catch (e) {
    await interaction.reply({
      content: `Could not reach the server: ${String(e)}`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

// Handles /gitsync-digest: POST the instruction to botEditDigest, which
// resolves the repo from this channel, AI-rewrites the day's digest, and
// returns the new markdown. The summary edit is AI-driven and may take a few
// seconds, so we defer the reply first.
export async function handleDigestCommand(
  interaction: ChatInputCommandInteraction,
  cfg: BotConfig,
): Promise<void> {
  const instruction = interaction.options.getString('instruction', true);
  const date = interaction.options.getString('date', false) ?? undefined;
  const { channelId } = interaction;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const res = await fetch(cfg.editDigestUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ingest-secret': cfg.ingestSecret,
      },
      body: JSON.stringify({ channelId, instruction, date }),
      signal: AbortSignal.timeout(30000),
    });

    if (res.ok) {
      const { markdown } = (await res.json()) as { markdown?: string };
      const preview = (markdown ?? '').slice(0, 1800);
      await interaction.editReply(
        `Digest updated.\n\n${preview || '(empty)'}`,
      );
      return;
    }

    if (res.status === 409) {
      await interaction.editReply(
        'That digest is locked — unlock it in the app to edit.',
      );
      return;
    }
    if (res.status === 404) {
      await interaction.editReply(
        'No digest for that day yet (or this channel is not bound to a repo).',
      );
      return;
    }

    const body = await res.text();
    await interaction.editReply(`Could not edit the digest (HTTP ${res.status}): ${body}`);
  } catch (e) {
    await interaction.editReply(`Could not reach the server: ${String(e)}`);
  }
}
