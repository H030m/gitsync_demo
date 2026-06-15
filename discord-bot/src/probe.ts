// Standalone connectivity probe for the GitSync forwarder bot.
//
// Logs into Discord and prints EVERY user message it can see straight to the
// terminal — no Cloud Function, no Firestore, no CHANNEL_REPO_MAP required.
// Use this to confirm the bot token works and the Message Content Intent is
// enabled BEFORE wiring up the full ingest path in src/index.ts.
//
// Run: npm run probe   (needs only DISCORD_BOT_TOKEN in discord-bot/.env)
import 'dotenv/config';
import { Client, Events, GatewayIntentBits } from 'discord.js';

const token = process.env.DISCORD_BOT_TOKEN;
if (!token || token === 'REPLACE_ME') {
  console.error('[probe] Missing DISCORD_BOT_TOKEN — set it in discord-bot/.env');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, (c) => {
  console.log(`[probe] logged in as ${c.user.tag}`);
  console.log('[probe] listening — post a message in any channel the bot can see…');
  console.log('[probe] (if content shows as <empty>, enable Message Content Intent in the Developer Portal)');
});

client.on(Events.MessageCreate, (msg) => {
  if (msg.author.bot) return; // ignore other bots (and itself)
  const channelName = 'name' in msg.channel && msg.channel.name ? `#${msg.channel.name}` : '(DM/unknown)';
  console.log(
    `[msg] ${channelName} [${msg.channelId}] ` +
      `${msg.author.username}: ${msg.content || '<empty — Message Content Intent off?>'}`,
  );
});

client.login(token).catch((e) => {
  console.error(`[probe] login failed: ${String(e)}`);
  process.exit(1);
});
