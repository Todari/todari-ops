import { Client, GatewayIntentBits, Partials, type Client as DiscordClient } from "discord.js";

let _client: DiscordClient | null = null;

export function createClient(): DiscordClient {
  if (_client) return _client;
  _client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message],
  });
  return _client;
}

export function getDiscordClient(): DiscordClient {
  if (!_client) throw new Error("Discord client not initialized");
  return _client;
}

export async function login(client: DiscordClient, token: string): Promise<void> {
  await client.login(token);
}
