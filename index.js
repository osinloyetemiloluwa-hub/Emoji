import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Collection,
  SlashCommandBuilder,
  REST,
  Routes
} from 'discord.js';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const CONFIG = {
  token: process.env.DISCORD_TOKEN,
  sourceServerId: process.env.SOURCE_SERVER_ID,
  botOwnerId: process.env.BOT_OWNER_ID,
  prefix: process.env.EMOJI_PREFIX || '!',
  emojiLimit: 50
};

// HTTP Server for health checks
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

// Initialize Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildEmojisAndStickers
  ]
});

// Store synced emoji data
const syncedEmoji = new Collection();

// Helper: Format emoji for display (animated vs static)
function formatEmoji(e) {
  return `${e.animated ? '<a:' : '<:'}${e.name}:${e.id}>`;
}

// Load saved emoji data
function loadEmojiData() {
  try {
    if (fs.existsSync('./emoji-data.json')) {
      const data = JSON.parse(fs.readFileSync('./emoji-data.json', 'utf8'));
      syncedEmoji.clear();
      Object.entries(data).forEach(([name, info]) => {
        syncedEmoji.set(name, info);
      });
      console.log(`✅ Loaded ${syncedEmoji.size} emoji from saved data`);
    }
  } catch (error) {
    console.error('❌ Failed to load emoji data:', error.message);
  }
}

// Save emoji data to file
function saveEmojiData() {
  try {
    const data = Object.fromEntries(syncedEmoji);
    fs.writeFileSync('./emoji-data.json', JSON.stringify(data, null, 2));
    console.log(`💾 Saved ${syncedEmoji.size} emoji to data file`);
  } catch (error) {
    console.error('❌ Failed to save emoji data:', error.message);
  }
}

// Get emoji from source server
function getSourceServer() {
  return client.guilds.cache.get(CONFIG.sourceServerId);
}

// Download emoji image
async function downloadEmojiImage(emoji) {
  try {
    const response = await axios.get(emoji.url, { responseType: 'arraybuffer' });
    return Buffer.from(response.data);
  } catch (error) {
    console.error(`❌ Failed to download emoji ${emoji.name}:`, error.message);
    return null;
  }
}

// Download image from URL
async function downloadImageFromUrl(url) {
  let cleanUrl = url.trim();
  if (cleanUrl.startsWith('<') && cleanUrl.endsWith('>')) {
    cleanUrl = cleanUrl.slice(1, -1);
  }

  if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
    console.error(`❌ Invalid URL format: ${cleanUrl}`);
    return null;
  }

  try {
    const response = await axios.get(cleanUrl, {
      responseType: 'arraybuffer',
      headers: { 'User-Agent': 'DiscordEmojiBot/1.0' },
      timeout: 10000
    });
    const buffer = Buffer.from(response.data);

    // Check if GIF by magic bytes
    const isGif = buffer.length > 6 &&
      buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 &&
      (buffer[3] === 0x38 && (buffer[4] === 0x37 || buffer[4] === 0x39) && buffer[5] === 0x61);

    const contentType = response.headers['content-type'] || '';
    const isAnimated = isGif || contentType.includes('gif') || cleanUrl.toLowerCase().endsWith('.gif');

    return { buffer, animated: isAnimated };
  } catch (error) {
    console.error(`❌ Failed to download image from URL: ${cleanUrl}`, error.message);
    if (error.response) {
      console.error(`   Status: ${error.response.status} - ${error.response.statusText}`);
    }
    return null;
  }
}

// Sync ALL emoji from source server (animated + static)
async function syncEmoji() {
  const sourceServer = getSourceServer();
  if (!sourceServer) {
    console.error('❌ Source server not found!');
    return { success: false, count: 0 };
  }

  const emojis = await sourceServer.emojis.fetch();
  // Sync ALL emojis, not just animated
  const allEmojis = emojis;

  console.log(`\n🔄 Syncing ${allEmojis.size} emojis from ${sourceServer.name}...`);
  console.log(`   (Animated: ${emojis.filter(e => e.animated).size}, Static: ${emojis.filter(e => !e.animated).size})`);

  let synced = 0;
  for (const [id, emoji] of allEmojis) {
    try {
      const imageBuffer = await downloadEmojiImage(emoji);
      if (imageBuffer) {
        syncedEmoji.set(emoji.name, {
          name: emoji.name,
          id: emoji.id,
          animated: emoji.animated,
          image: imageBuffer.toString('base64'),
          requiresColons: emoji.requiresColons,
          createdAt: emoji.createdAt.toISOString()
        });
        synced++;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch (error) {
      console.error(`❌ Error syncing ${emoji.name}:`, error.message);
    }
  }

  saveEmojiData();
  console.log(`✅ Successfully synced ${synced}/${allEmojis.size} emojis!\n`);
  return { success: true, count: synced };
}

// Use emoji in target server
async function useEmojiInServer(guild, emojiName) {
  const emojiData = syncedEmoji.get(emojiName.toLowerCase());
  if (!emojiData) {
    return { success: false, error: 'Emoji not found' };
  }

  const existingEmoji = guild.emojis.cache.find(e => e.name.toLowerCase() === emojiName.toLowerCase());
  if (existingEmoji) {
    return { success: true, emoji: existingEmoji, reused: true };
  }

  const currentCount = guild.emojis.cache.size;
  if (currentCount >= CONFIG.emojiLimit) {
    return { success: false, error: `Emoji limit reached (${CONFIG.emojiLimit})` };
  }

  try {
    const imageBuffer = Buffer.from(emojiData.image, 'base64');
    const newEmoji = await guild.emojis.create({
      name: emojiData.name,
      attachment: imageBuffer,
      reason: `Synced by ${client.user.tag}`
    });
    return { success: true, emoji: newEmoji, reused: false };
  } catch (error) {
    if (error.message.includes('Emoji name')) {
      const altName = `${emojiData.name}_${Date.now().toString(36)}`;
      const newEmoji = await guild.emojis.create({
        name: altName,
        attachment: Buffer.from(emojiData.image, 'base64'),
        reason: `Synced by ${client.user.tag}`
      });
      return { success: true, emoji: newEmoji, reused: false, renamed: altName };
    }
    return { success: false, error: error.message };
  }
}

// Add emoji to database manually (owner only)
async function addEmojiToDatabase(name, imageBuffer, animated = false) {
  const cleanName = name.toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (!cleanName || cleanName.length > 32) {
    return { success: false, error: 'Invalid emoji name. Use 1-32 alphanumeric characters and underscores.' };
  }
  if (syncedEmoji.has(cleanName)) {
    return { success: false, error: `Emoji "${cleanName}" already exists in database.` };
  }
  const fakeId = `manual_${Date.now().toString(36)}`;
  syncedEmoji.set(cleanName, {
    name: cleanName,
    id: fakeId,
    animated: animated,
    image: imageBuffer.toString('base64'),
    requiresColons: true,
    createdAt: new Date().toISOString()
  });
  saveEmojiData();
  return { success: true, name: cleanName };
}

// Delete emoji from database (owner only)
function deleteEmojiFromDatabase(name) {
  const lowerName = name.toLowerCase();
  if (!syncedEmoji.has(lowerName)) {
    return { success: false, error: `Emoji "${name}" not found in database.` };
  }
  syncedEmoji.delete(lowerName);
  saveEmojiData();
  return { success: true };
}

// Event: Bot ready
client.once('ready', async () => {
  console.log(`
  ╔════════════════════════════════════════════════════════╗
  ║   🎭 Discord Emoji Bot Online!                         ║
  ║   Bot: ${client.user.tag.padEnd(42)}║
  ║   Servers: ${client.guilds.cache.size.toString().padEnd(40)}║
  ╚════════════════════════════════════════════════════════╝
  `);

  loadEmojiData();

  const sourceServer = getSourceServer();
  if (sourceServer && syncedEmoji.size === 0) {
    console.log('📥 Auto-syncing emoji from source server...');
    await syncEmoji();
  } else if (syncedEmoji.size > 0) {
    console.log(`📦 ${syncedEmoji.size} emoji loaded from cache`);
  }

  await registerSlashCommands();
  console.log('⚡ Slash commands registered');
});

// Register slash commands
async function registerSlashCommands() {
  const rest = new REST({ version: '10' }).setToken(CONFIG.token);
  const commands = [
    new SlashCommandBuilder().setName('sync-emojis').setDescription('Sync emoji from source server (Admin only)').toJSON(),
    new SlashCommandBuilder().setName('list-emojis').setDescription('List all available synced emojis')
      .addStringOption(option => option.setName('search').setDescription('Search for specific emoji').setRequired(false)).toJSON(),
    new SlashCommandBuilder().setName('add-emoji').setDescription('Add an emoji to this server')
      .addStringOption(option => option.setName('name').setDescription('Emoji name to add').setRequired(true).setAutocomplete(true)).toJSON(),
    new SlashCommandBuilder().setName('use-emoji').setDescription('Use an emoji (adds to server and sends)')
      .addStringOption(option => option.setName('name').setDescription('Emoji name to use').setRequired(true).setAutocomplete(true)).toJSON(),
    new SlashCommandBuilder().setName('emoji-info').setDescription('Get info about an emoji')
      .addStringOption(option => option.setName('name').setDescription('Emoji name').setRequired(true).setAutocomplete(true)).toJSON(),
    new SlashCommandBuilder().setName('bot-add-emoji').setDescription('[Owner] Add an emoji to bot database')
      .addStringOption(option => option.setName('name').setDescription('Emoji name (alphanumeric, underscores)').setRequired(true))
      .addStringOption(option => option.setName('url').setDescription('Image URL (or use attachment)').setRequired(false))
      .addAttachmentOption(option => option.setName('attachment').setDescription('Upload an image file').setRequired(false)).toJSON(),
    new SlashCommandBuilder().setName('bot-delete-emoji').setDescription('[Owner] Delete an emoji from bot database')
      .addStringOption(option => option.setName('name').setDescription('Emoji name to delete').setRequired(true).setAutocomplete(true)).toJSON()
  ];

  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
  } catch (error) {
    console.error('Failed to register slash commands:', error);
  }
}

// Interaction create
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  try {
    switch (commandName) {
      case 'sync-emojis': {
        if (interaction.user.id !== CONFIG.botOwnerId) return interaction.reply('❌ Only the bot owner can use this command!');
        await interaction.reply('🔄 Syncing emojis...');
        const result = await syncEmoji();
        await interaction.editReply(result.success ? `✅ Synced ${result.count} emojis!` : `❌ Sync failed: ${result.error}`);
        break;
      }
      case 'list-emojis': {
        const search = interaction.options.getString('search')?.toLowerCase();
        let emojis = Array.from(syncedEmoji.values()).filter(e => search ? e.name.toLowerCase().includes(search) : true);
        if (emojis.length === 0) return interaction.reply('❌ No emojis found!');

        // Use helper function for correct format (animated vs static)
        const list = emojis.slice(0, 25).map(e => `${formatEmoji(e)} \`${e.name}\``).join('\n');
        const more = emojis.length > 25 ? `\n*...and ${emojis.length - 25} more*` : '';
        await interaction.reply({ embeds: [{ title: `🎭 Synced Emojis (${emojis.length})`, description: list + more, color: 0x5865F2 }] });
        break;
      }
      case 'add-emoji': {
        const result = await useEmojiInServer(interaction.guild, interaction.options.getString('name'));
        if (!result.success) return interaction.reply(`❌ Failed: ${result.error}`);
        await interaction.reply(result.reused ? `♻️ Emoji already exists: ${result.emoji}` : `✅ Emoji added: ${result.emoji}`);
        break;
      }
      case 'use-emoji': {
        const name = interaction.options.getString('name');
        if (!syncedEmoji.has(name.toLowerCase())) return interaction.reply('❌ Emoji not found in database!');
        const result = await useEmojiInServer(interaction.guild, name);
        if (!result.success) return interaction.reply(`❌ Failed: ${result.error}`);
        await interaction.reply(`🎭 ${result.emoji}`);
        break;
      }
      case 'emoji-info': {
        const emojiData = syncedEmoji.get(interaction.options.getString('name').toLowerCase());
        if (!emojiData) return interaction.reply('❌ Emoji not found!');
        await interaction.reply({ embeds: [{
          title: `🎭 ${emojiData.name}`,
          fields: [
            { name: 'ID', value: `\`${emojiData.id}\``, inline: true },
            { name: 'Type', value: emojiData.animated ? '🎬 Animated' : '🖼️ Static', inline: true },
            { name: 'Created', value: new Date(emojiData.createdAt).toLocaleDateString(), inline: true },
            { name: 'Format', value: formatEmoji(emojiData), inline: false }
          ],
          color: 0x5865F2
        }] });
        break;
      }
      case 'bot-add-emoji': {
        if (interaction.user.id !== CONFIG.botOwnerId) return interaction.reply({ content: '❌ Owner only.', ephemeral: true });
        const name = interaction.options.getString('name');
        const url = interaction.options.getString('url')?.trim();
        const attachment = interaction.options.getAttachment('attachment');
        if (!url && !attachment) return interaction.reply({ content: '❌ Provide a URL or upload an image.', ephemeral: true });

        let imageBuffer, animated = false;
        if (attachment) {
          try {
            const resp = await axios.get(attachment.url, { responseType: 'arraybuffer' });
            imageBuffer = Buffer.from(resp.data);
            // Check GIF magic bytes
            const isGif = imageBuffer.length > 6 && imageBuffer[0] === 0x47 && imageBuffer[1] === 0x49 && imageBuffer[2] === 0x46 &&
              (imageBuffer[3] === 0x38 && (imageBuffer[4] === 0x37 || imageBuffer[4] === 0x39) && imageBuffer[5] === 0x61);
            animated = isGif || attachment.contentType?.includes('gif') || attachment.name?.toLowerCase().endsWith('.gif');
          } catch (e) {
            return interaction.reply({ content: `❌ Failed to download attachment: ${e.message}`, ephemeral: true });
          }
        } else if (url) {
          const result = await downloadImageFromUrl(url);
          if (!result) return interaction.reply({ content: '❌ Failed to download image from URL.', ephemeral: true });
          imageBuffer = result.buffer;
          animated = result.animated;
        }

        const addResult = await addEmojiToDatabase(name, imageBuffer, animated);
        if (!addResult.success) return interaction.reply({ content: `❌ ${addResult.error}`, ephemeral: true });
        await interaction.reply(`✅ Emoji \`${addResult.name}\` added (type: ${animated ? 'animated' : 'static'}).`);
        break;
      }
      case 'bot-delete-emoji': {
        if (interaction.user.id !== CONFIG.botOwnerId) return interaction.reply({ content: '❌ Owner only.', ephemeral: true });
        const name = interaction.options.getString('name');
        const result = deleteEmojiFromDatabase(name);
        if (!result.success) return interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
        await interaction.reply(`✅ Emoji \`${name}\` deleted from database.`);
        break;
      }
    }
  } catch (error) {
    console.error('Command error:', error);
    await interaction.reply('❌ An error occurred!');
  }
});

// Message create (prefix commands)
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.content.startsWith(CONFIG.prefix)) return;
  const args = message.content.slice(CONFIG.prefix.length).trim().split(/\s+/);
  const command = args.shift().toLowerCase();

  // Owner-only sync commands
  if (['sync', 'syncall', 'syncemoji', 'sync-emojis'].includes(command)) {
    if (message.author.id !== CONFIG.botOwnerId) return message.reply('❌ Owner only.');
    await message.reply('🔄 Syncing...');
    const result = await syncEmoji();
    await message.reply(result.success ? `✅ Synced ${result.count} emojis!` : `❌ Sync failed: ${result.error}`);
    return;
  }

  // Owner-only botadd / botdel
  if (command === 'botadd' || command === 'botaddemoji') {
    if (message.author.id !== CONFIG.botOwnerId) return message.reply('❌ Owner only.');
    const name = args[0];
    if (!name) return message.reply('❌ Usage: `!botadd <name> <url>` or attach an image.');
    let url = args[1]?.trim();
    const attachment = message.attachments.first();
    let imageBuffer, animated = false;

    if (attachment) {
      try {
        const resp = await axios.get(attachment.url, { responseType: 'arraybuffer' });
        imageBuffer = Buffer.from(resp.data);
        const isGif = imageBuffer.length > 6 && imageBuffer[0] === 0x47 && imageBuffer[1] === 0x49 && imageBuffer[2] === 0x46 &&
          (imageBuffer[3] === 0x38 && (imageBuffer[4] === 0x37 || imageBuffer[4] === 0x39) && imageBuffer[5] === 0x61);
        animated = isGif || attachment.contentType?.includes('gif') || attachment.name?.toLowerCase().endsWith('.gif');
      } catch (e) {
        return message.reply(`❌ Failed to download attachment: ${e.message}`);
      }
    } else if (url) {
      const result = await downloadImageFromUrl(url);
      if (!result) return message.reply('❌ Failed to download image from URL.');
      imageBuffer = result.buffer;
      animated = result.animated;
    } else {
      return message.reply('❌ Please provide a URL or attach an image.');
    }

    const addResult = await addEmojiToDatabase(name, imageBuffer, animated);
    if (!addResult.success) return message.reply(`❌ ${addResult.error}`);
    await message.reply(`✅ Emoji \`${addResult.name}\` added (type: ${animated ? 'animated' : 'static'}).`);
    return;
  }

  if (command === 'botdel' || command === 'botdelete') {
    if (message.author.id !== CONFIG.botOwnerId) return message.reply('❌ Owner only.');
    const name = args[0];
    if (!name) return message.reply('❌ Usage: `!botdel <name>`');
    const result = deleteEmojiFromDatabase(name);
    if (!result.success) return message.reply(`❌ ${result.error}`);
    await message.reply(`✅ Emoji \`${name}\` deleted from database.`);
    return;
  }

  // Public commands
  switch (command) {
    case 'emojis':
    case 'list': {
      const search = args[0]?.toLowerCase();
      let emojis = Array.from(syncedEmoji.values()).filter(e => search ? e.name.toLowerCase().includes(search) : true);
      if (emojis.length === 0) return message.reply('❌ No emojis found!');

      // Use helper function for correct format
      const list = emojis.slice(0, 20).map(e => `${formatEmoji(e)} \`${e.name}\``).join('\n');
      const more = emojis.length > 20 ? `\n*...and ${emojis.length - 20} more*` : '';
      message.reply({ embeds: [{ title: `🎭 Synced Emojis (${emojis.length})`, description: list + more, color: 0x5865F2 }] });
      break;
    }
    case 'add':
    case 'addemoji': {
      const name = args[0];
      if (!name) return message.reply('❌ Please specify an emoji name.');
      const result = await useEmojiInServer(message.guild, name);
      if (!result.success) return message.reply(`❌ Failed: ${result.error}`);
      message.reply(result.reused ? `♻️ Emoji already exists: ${result.emoji}` : `✅ Added: ${result.emoji}`);
      break;
    }
    case 'use': {
      const name = args[0];
      if (!name) return message.reply('❌ Please specify an emoji name.');
      if (!syncedEmoji.has(name.toLowerCase())) return message.reply('❌ Emoji not found in database!');
      const result = await useEmojiInServer(message.guild, name);
      if (!result.success) return message.reply(`❌ Failed: ${result.error}`);
      message.reply(`🎭 ${result.emoji}`);
      break;
    }
    case 'help':
    case 'commands': {
      message.reply({ embeds: [{
        title: '🎭 Emoji Bot Commands',
        description: `
**Prefix: \`${CONFIG.prefix}\`**

📥 **Owner Commands**
\`${CONFIG.prefix}sync\` - Sync all emojis from source
\`${CONFIG.prefix}botadd <name> <url|attachment>\` - Add emoji to bot
\`${CONFIG.prefix}botdel <name>\` - Delete emoji from bot

📋 **Public Commands**
\`${CONFIG.prefix}emojis [search]\` - List all emojis
\`${CONFIG.prefix}add <name>\` - Add emoji to this server
\`${CONFIG.prefix}use <name>\` - Use emoji in chat

⚡ **Slash Commands**
/sync-emojis, /list-emojis, /add-emoji, /use-emoji, /emoji-info, /bot-add-emoji, /bot-delete-emoji
        `,
        color: 0x5865F2
      }] });
      break;
    }
  }
});

// Autocomplete
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isAutocomplete()) return;
  if (['add-emoji', 'use-emoji', 'emoji-info', 'bot-delete-emoji'].includes(interaction.commandName)) {
    const focused = interaction.options.getFocused();
    const choices = Array.from(syncedEmoji.keys())
      .filter(name => name.toLowerCase().includes(focused.toLowerCase()))
      .slice(0, 25);
    await interaction.respond(choices.map(name => ({ name, value: name })));
  }
});

// Guild join
client.on('guildCreate', async (guild) => {
  console.log(`➕ Joined ${guild.name} (${guild.id})`);
  if (syncedEmoji.size > 0) {
    const emojis = Array.from(syncedEmoji.values()).slice(0, 10);
    let synced = 0;
    for (const emoji of emojis) {
      const result = await useEmojiInServer(guild, emoji.name);
      if (result.success && !result.reused) { synced++; await new Promise(r => setTimeout(r, 1000)); }
    }
    if (synced > 0) console.log(`  📦 Auto-synced ${synced} emoji to ${guild.name}`);
  }
});

// Error handling
process.on('unhandledRejection', (error) => console.error('❌ Unhandled rejection:', error));

// Login
if (!CONFIG.token) {
  console.error('❌ DISCORD_TOKEN not found in .env file!');
  process.exit(1);
}
client.login(CONFIG.token);
