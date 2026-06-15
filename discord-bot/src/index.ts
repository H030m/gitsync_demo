// GitSync bot entry point.
//
// Real-time message forwarding has been removed. The bot now:
//   1. Registers the `/gitsync-listen` (bind channel→repo) and `/gitsync-digest`
//      (AI-edit the day's digest) slash commands per guild.
//   2. Polls claimDiscordFetch for on-demand backfill requests and REST-
//      backfills the day's messages to discordMessageIngest.
// Stateless Cloud Functions can't hold a Discord gateway connection, so this
// runs separately (locally / on a VPS). See ARCHITECTURE.md §7.
import { Client, Events, GatewayIntentBits } from 'discord.js';

import {
  handleDigestCommand,
  handleListenCommand,
  DIGEST_COMMAND,
  LISTEN_COMMAND,
  registerAllGuildCommands,
  registerGuildCommands,
} from './commands';
import { loadConfig } from './config';
import { startBackfillPoller } from './backfill';

const cfg = loadConfig();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    // MessageContent stays a required intent even though real-time forwarding
    // is gone: REST message backfill (channel.messages.fetch) only returns
    // populated `content` when the privileged Message Content Intent is on.
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, async (c) => {
  console.log(`[bot] logged in as ${c.user.tag}`);
  await registerAllGuildCommands(c);
  startBackfillPoller(c, cfg);
});

// Register commands for guilds the bot joins after startup.
client.on(Events.GuildCreate, (guild) => {
  void registerGuildCommands(guild);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === LISTEN_COMMAND) {
    await handleListenCommand(interaction, cfg);
  } else if (interaction.commandName === DIGEST_COMMAND) {
    await handleDigestCommand(interaction, cfg);
  }
});

client.login(cfg.botToken).catch((e) => {
  console.error(`[bot] login failed: ${String(e)}`);
  process.exit(1);
});
