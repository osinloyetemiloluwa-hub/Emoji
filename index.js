import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Collection,
  SlashCommandBuilder,
  REST,
  Routes,
  AttachmentBuilder
} from 'discord.js';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http'; // <-- ADDED for HTTP server

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const CONFIG = {
  token: process.env.DISCORD_TOKEN,
  sourceServerId: process.env.SOURCE_SERVER_ID,
  botOwnerId: process.env.BOT_OWNER_ID,
  prefix: process.env.EMOJI_PREFIX || '!',
  emojiLimit: 50 // Discord free tier emoji limit
};

// ----- HTTP Server for health checks (keeps Render happy) -----
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🌐 Health check server running on port ${PORT}`);
});
// --------------------------------------------------------------

// Initialize Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildEmojisAndStickers
  ]
});

// Rest of your code remains exactly as before...
// (All the functions, events, and command handlers stay unchanged)
