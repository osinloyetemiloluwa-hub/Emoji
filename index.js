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

// NEW: download image from URL or buffer (for manual add)
async function downloadImageFromUrl(url) {
  try {
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(response.data);
    // Detect animated by checking first 6 bytes for GIF signature
    const isGif = buffer.length > 6 &&
      buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 &&
      (buffer[3] === 0x38 && (buffer[4] === 0x37 || buffer[4] === 0x39) && buffer[5] === 0x61);
    const contentType = response.headers['content-type'] || '';
    const isAnimated = isGif || contentType.includes('gif') || url.toLowerCase().endsWith('.gif');
    return { buffer, animated: isAnimated };
  } catch (error) {
    console.error('❌ Failed to download image:', error.message);
    return null;
  }
}

// Sync emoji from source server
async function syncEmoji() {
  const sourceServer = getSourceServer();

  if (!sourceServer) {
    console.error('❌ Source server not found!');
    return { success: false, count: 0 };
  }

  const emojis = await sourceServer.emojis.fetch();
  const animatedEmojis = emojis.filter(e => e.animated);

  console.log(`\n🔄 Syncing ${animatedEmojis.size} animated emojis from ${sourceServer.name}...`);

  let synced = 0;

  for (const [id, emoji] of animatedEmojis) {
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

        // Rate limit handling
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch (error) {
      console.error(`❌ Error syncing ${emoji.name}:`, error.message);
    }
  }

  saveEmojiData();
  console.log(`✅ Successfully synced ${synced}/${animatedEmojis.size} emojis!\n`);

  return { success: true, count: synced };
}

// Use emoji in target server
async function useEmojiInServer(guild, emojiName) {
  const emojiData = syncedEmoji.get(emojiName.toLowerCase());

  if (!emojiData) {
    return { success: false, error: 'Emoji not found' };
  }

  // Check if emoji already exists in this guild
  const existingEmoji = guild.emojis.cache.find(e => e.name.toLowerCase() === emojiName.toLowerCase());

  if (existingEmoji) {
    return { success: true, emoji: existingEmoji, reused: true };
  }

  // Check emoji limit
  const currentCount = guild.emojis.cache.size;
  if (currentCount >= CONFIG.emojiLimit) {
    return { success: false, error: `Emoji limit reached (${CONFIG.emojiLimit})` };
  }

  try {
    // Create new emoji from synced data
    const imageBuffer = Buffer.from(emojiData.image, 'base64');
    const newEmoji = await guild.emojis.create({
      name: emojiData.name,
      attachment: imageBuffer,
      reason: `Synced by ${client.user.tag}`
    });

    return { success: true, emoji: newEmoji, reused: false };
  } catch (error) {
    // Common error: emoji already exists with different ID
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

// NEW: Add an emoji to the local database manually (owner only)
async function addEmojiToDatabase(name, imageBuffer, animated = false) {
  // Validate name (Discord emoji name rules: alphanumeric + underscore, max 32 chars)
  const cleanName = name.toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (!cleanName || cleanName.length > 32) {
    return { success: false, error: 'Invalid emoji name. Use 1-32 alphanumeric characters and underscores.' };
  }
  if (syncedEmoji.has(cleanName)) {
    return { success: false, error: `Emoji "${cleanName}" already exists in database.` };
  }

  // Generate a fake ID for storage (since we don't have a real Discord emoji ID)
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

// NEW: Delete an emoji from the local database (owner only)
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
  ║                                                        ║
  ║   🎭 Discord Emoji Bot Online!                         ║
  ║                                                        ║
  ║   Bot: ${client.user.tag.padEnd(42)}║
  ║   Servers: ${client.guilds.cache.size.toString().padEnd(40)}║
  ║                                                        ║
  ╚════════════════════════════════════════════════════════╝
  `);

  // Load saved data
  loadEmojiData();

  // Auto-sync if source server is available
  const sourceServer = getSourceServer();
  if (sourceServer && syncedEmoji.size === 0) {
    console.log('📥 Auto-syncing emoji from source server...');
    await syncEmoji();
  } else if (syncedEmoji.size > 0) {
    console.log(`📦 ${syncedEmoji.size} emoji loaded from cache`);
  }

  // Register slash commands
  await registerSlashCommands();
  console.log('⚡ Slash commands registered');
});

// Register slash commands
async function registerSlashCommands() {
  const rest = new REST({ version: '10' }).setToken(CONFIG.token);

  const commands = [
    new SlashCommandBuilder()
      .setName('sync-emojis')
      .setDescription('Sync emoji from source server (Admin only)')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('list-emojis')
      .setDescription('List all available synced emojis')
      .addStringOption(option =>
        option.setName('search')
          .setDescription('Search for specific emoji')
          .setRequired(false)
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName('add-emoji')
      .setDescription('Add an emoji to this server')
      .addStringOption(option =>
        option.setName('name')
          .setDescription('Emoji name to add')
          .setRequired(true)
          .setAutocomplete(true)
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName('use-emoji')
      .setDescription('Use an emoji (adds to server and sends)')
      .addStringOption(option =>
        option.setName('name')
          .setDescription('Emoji name to use')
          .setRequired(true)
          .setAutocomplete(true)
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName('emoji-info')
      .setDescription('Get info about an emoji')
      .addStringOption(option =>
        option.setName('name')
          .setDescription('Emoji name')
          .setRequired(true)
          .setAutocomplete(true)
      )
      .toJSON(),
    // NEW: Owner-only commands to manage bot's local database
    new SlashCommandBuilder()
      .setName('bot-add-emoji')
      .setDescription('[Owner] Add an emoji to bot database')
      .addStringOption(option =>
        option.setName('name')
          .setDescription('Emoji name (alphanumeric, underscores)')
          .setRequired(true)
      )
      .addStringOption(option =>
        option.setName('url')
          .setDescription('Image URL (or use attachment)')
          .setRequired(false)
      )
      .addAttachmentOption(option =>
        option.setName('attachment')
          .setDescription('Upload an image file')
          .setRequired(false)
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName('bot-delete-emoji')
      .setDescription('[Owner] Delete an emoji from bot database')
      .addStringOption(option =>
        option.setName('name')
          .setDescription('Emoji name to delete')
          .setRequired(true)
          .setAutocomplete(true)
      )
      .toJSON()
  ];

  try {
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );
  } catch (error) {
    console.error('Failed to register slash commands:', error);
  }
}

// Event: Interaction create (slash commands)
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  try {
    switch (commandName) {
      case 'sync-emojis': {
        if (interaction.user.id !== CONFIG.botOwnerId) {
          return interaction.reply('❌ Only the bot owner can use this command!');
        }
        await interaction.reply('🔄 Syncing emojis...');
        const result = await syncEmoji();
        await interaction.editReply(result.success
          ? `✅ Synced ${result.count} emojis successfully!`
          : `❌ Sync failed: ${result.error}`
        );
        break;
      }

      case 'list-emojis': {
        const search = interaction.options.getString('search')?.toLowerCase();
        let emojis = Array.from(syncedEmoji.values());

        if (search) {
          emojis = emojis.filter(e => e.name.toLowerCase().includes(search));
        }

        if (emojis.length === 0) {
          return interaction.reply('❌ No emojis found!');
        }

        // Create embed with emoji list
        const emojiList = emojis.slice(0, 25).map(e =>
          `<a:${e.name}:${e.id}> \`${e.name}\``
        ).join('\n');

        const remaining = emojis.length > 25 ? `\n*...and ${emojis.length - 25} more*` : '';

        await interaction.reply({
          embeds: [{
            title: `🎭 Synced Emojis (${emojis.length})`,
            description: emojiList + remaining,
            color: 0x5865F2
          }]
        });
        break;
      }

      case 'add-emoji': {
        const emojiName = interaction.options.getString('name');
        const result = await useEmojiInServer(interaction.guild, emojiName);

        if (!result.success) {
          return interaction.reply(`❌ Failed to add emoji: ${result.error}`);
        }

        if (result.reused) {
          await interaction.reply(`♻️ Emoji already exists: ${result.emoji}`);
        } else {
          await interaction.reply(`✅ Emoji added to server: ${result.emoji}`);
        }
        break;
      }

      case 'use-emoji': {
        const emojiName = interaction.options.getString('name');
        const emojiData = syncedEmoji.get(emojiName.toLowerCase());

        if (!emojiData) {
          return interaction.reply('❌ Emoji not found in database!');
        }

        const result = await useEmojiInServer(interaction.guild, emojiName);

        if (!result.success) {
          return interaction.reply(`❌ Failed: ${result.error}`);
        }

        await interaction.reply(`🎭 ${result.emoji}`);
        break;
      }

      case 'emoji-info': {
        const emojiName = interaction.options.getString('name');
        const emojiData = syncedEmoji.get(emojiName.toLowerCase());

        if (!emojiData) {
          return interaction.reply('❌ Emoji not found!');
        }

        const createdDate = new Date(emojiData.createdAt).toLocaleDateString();

        await interaction.reply({
          embeds: [{
            title: `🎭 ${emojiData.name}`,
            fields: [
              { name: 'ID', value: `\`${emojiData.id}\``, inline: true },
              { name: 'Animated', value: emojiData.animated ? '✅ Yes' : '❌ No', inline: true },
              { name: 'Created', value: createdDate, inline: true },
              { name: 'Format', value: `<a:${emojiData.name}:${emojiData.id}>`, inline: false }
            ],
            color: 0x5865F2
          }]
        });
        break;
      }

      // NEW: Handle bot-add-emoji
      case 'bot-add-emoji': {
        if (interaction.user.id !== CONFIG.botOwnerId) {
          return interaction.reply({ content: '❌ Only the bot owner can use this command!', ephemeral: true });
        }

        const name = interaction.options.getString('name');
        const url = interaction.options.getString('url');
        const attachment = interaction.options.getAttachment('attachment');

        // Must provide either URL or attachment
        if (!url && !attachment) {
          return interaction.reply({ content: '❌ Please provide either a URL or upload an image attachment.', ephemeral: true });
        }

        // If both provided, prefer attachment
        let imageBuffer, animated = false;
        if (attachment) {
          // Download attachment
          try {
            const response = await axios.get(attachment.url, { responseType: 'arraybuffer' });
            imageBuffer = Buffer.from(response.data);
            // Detect animated GIF
            const isGif = imageBuffer.length > 6 &&
              imageBuffer[0] === 0x47 && imageBuffer[1] === 0x49 && imageBuffer[2] === 0x46 &&
              (imageBuffer[3] === 0x38 && (imageBuffer[4] === 0x37 || imageBuffer[4] === 0x39) && imageBuffer[5] === 0x61);
            animated = isGif || attachment.contentType?.includes('gif') || attachment.name?.toLowerCase().endsWith('.gif');
          } catch (error) {
            return interaction.reply({ content: `❌ Failed to download attachment: ${error.message}`, ephemeral: true });
          }
        } else if (url) {
          const result = await downloadImageFromUrl(url);
          if (!result) {
            return interaction.reply({ content: '❌ Failed to download image from the provided URL.', ephemeral: true });
          }
          imageBuffer = result.buffer;
          animated = result.animated;
        }

        // Add to database
        const addResult = await addEmojiToDatabase(name, imageBuffer, animated);
        if (!addResult.success) {
          return interaction.reply({ content: `❌ ${addResult.error}`, ephemeral: true });
        }

        await interaction.reply(`✅ Emoji \`${addResult.name}\` added to bot database (animated: ${animated ? 'yes' : 'no'}).`);
        break;
      }

      // NEW: Handle bot-delete-emoji
      case 'bot-delete-emoji': {
        if (interaction.user.id !== CONFIG.botOwnerId) {
          return interaction.reply({ content: '❌ Only the bot owner can use this command!', ephemeral: true });
        }

        const name = interaction.options.getString('name');
        const result = deleteEmojiFromDatabase(name);
        if (!result.success) {
          return interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
        }
        await interaction.reply(`✅ Emoji \`${name}\` deleted from bot database.`);
        break;
      }
    }
  } catch (error) {
    console.error('Command error:', error);
    await interaction.reply('❌ An error occurred while processing the command!');
  }
});

// Event: Message create (prefix commands)
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.content.startsWith(CONFIG.prefix)) return;

  const args = message.content.slice(CONFIG.prefix.length).trim().split(/\s+/);
  const command = args.shift().toLowerCase();

  // Owner-only commands
  if ([
    'sync', 'syncall', 'syncemoji', 'sync-emojis'
  ].includes(command)) {
    if (message.author.id !== CONFIG.botOwnerId) {
      return message.reply('❌ Only the bot owner can use this command!');
    }

    await message.reply('🔄 Syncing emojis from source server...');
    const result = await syncEmoji();
    await message.reply(result.success
      ? `✅ Synced ${result.count} emojis!`
      : `❌ Sync failed: ${result.error}`
    );
    return;
  }

  // NEW: Owner-only commands for database management
  if (command === 'botadd' || command === 'botaddemoji') {
    if (message.author.id !== CONFIG.botOwnerId) {
      return message.reply('❌ Only the bot owner can use this command!');
    }
    // Usage: !botadd <name> <url>  (or attach an image and provide name)
    const name = args[0];
    if (!name) {
      return message.reply('❌ Usage: `!botadd <name> <url>` or attach an image and use `!botadd <name>`');
    }
    let url = args[1];
    // Check for attachment
    let attachment = message.attachments.first();
    let imageBuffer, animated = false;

    if (attachment) {
      try {
        const response = await axios.get(attachment.url, { responseType: 'arraybuffer' });
        imageBuffer = Buffer.from(response.data);
        const isGif = imageBuffer.length > 6 &&
          imageBuffer[0] === 0x47 && imageBuffer[1] === 0x49 && imageBuffer[2] === 0x46 &&
          (imageBuffer[3] === 0x38 && (imageBuffer[4] === 0x37 || imageBuffer[4] === 0x39) && imageBuffer[5] === 0x61);
        animated = isGif || attachment.contentType?.includes('gif') || attachment.name?.toLowerCase().endsWith('.gif');
      } catch (error) {
        return message.reply(`❌ Failed to download attachment: ${error.message}`);
      }
    } else if (url) {
      const result = await downloadImageFromUrl(url);
      if (!result) {
        return message.reply('❌ Failed to download image from the provided URL.');
      }
      imageBuffer = result.buffer;
      animated = result.animated;
    } else {
      return message.reply('❌ Please provide a URL or attach an image.');
    }

    const addResult = await addEmojiToDatabase(name, imageBuffer, animated);
    if (!addResult.success) {
      return message.reply(`❌ ${addResult.error}`);
    }
    await message.reply(`✅ Emoji \`${addResult.name}\` added to bot database (animated: ${animated ? 'yes' : 'no'}).`);
    return;
  }

  if (command === 'botdel' || command === 'botdelete') {
    if (message.author.id !== CONFIG.botOwnerId) {
      return message.reply('❌ Only the bot owner can use this command!');
    }
    const name = args[0];
    if (!name) {
      return message.reply('❌ Usage: `!botdel <name>`');
    }
    const result = deleteEmojiFromDatabase(name);
    if (!result.success) {
      return message.reply(`❌ ${result.error}`);
    }
    await message.reply(`✅ Emoji \`${name}\` deleted from bot database.`);
    return;
  }

  // Public commands
  switch (command) {
    case 'emojis':
    case 'list': {
      const search = args[0]?.toLowerCase();
      let emojis = Array.from(syncedEmoji.values());

      if (search) {
        emojis = emojis.filter(e => e.name.toLowerCase().includes(search));
      }

      if (emojis.length === 0) {
        return message.reply('❌ No emojis found!');
      }

      const emojiList = emojis.slice(0, 20).map(e =>
        `<a:${e.name}:${e.id}> \`${e.name}\``
      ).join('\n');

      const remaining = emojis.length > 20 ? `\n*...and ${emojis.length - 20} more*` : '';

      message.reply({
        embeds: [{
          title: `🎭 Synced Emojis (${emojis.length})`,
          description: emojiList + remaining,
          color: 0x5865F2
        }]
      });
      break;
    }

    case 'add':
    case 'addemoji': {
      const emojiName = args[0];
      if (!emojiName) {
        return message.reply('❌ Please specify an emoji name!\nUsage: `!add <emoji_name>`');
      }

      const result = await useEmojiInServer(message.guild, emojiName);

      if (!result.success) {
        return message.reply(`❌ Failed: ${result.error}`);
      }

      message.reply(result.reused
        ? `♻️ Emoji already exists: ${result.emoji}`
        : `✅ Added to server: ${result.emoji}`
      );
      break;
    }

    case 'use': {
      const emojiName = args[0];
      if (!emojiName) {
        return message.reply('❌ Please specify an emoji name!\nUsage: `!use <emoji_name>`');
      }

      const result = await useEmojiInServer(message.guild, emojiName);

      if (!result.success) {
        return message.reply(`❌ Failed: ${result.error}`);
      }

      message.reply(`🎭 ${result.emoji}`);
      break;
    }

    case 'help':
    case ' commands': {
      message.reply({
        embeds: [{
          title: '🎭 Emoji Bot Commands',
          description: `
**Prefix: \`${CONFIG.prefix}\`**

📥 **Sync Commands** (Owner only)
\`${CONFIG.prefix}sync\` - Sync emoji from source server

📋 **List Commands**
\`${CONFIG.prefix}emojis\` - List all synced emoji
\`${CONFIG.prefix}emojis <search>\` - Search emoji

📦 **Use Commands**
\`${CONFIG.prefix}add <name>\` - Add emoji to server
\`${CONFIG.prefix}use <name>\` - Use emoji in chat

🔧 **Bot Database Management** (Owner only)
\`${CONFIG.prefix}botadd <name> <url>\` or attach image - Add emoji to bot database
\`${CONFIG.prefix}botdel <name>\` - Delete emoji from bot database

⚡ **Slash Commands**
\`/sync-emojis\` - Sync emoji (admin)
\`/list-emojis\` - List all emoji
\`/add-emoji <name>\` - Add emoji to server
\`/use-emoji <name>\` - Use emoji
\`/emoji-info <name>\` - Get emoji info
\`/bot-add-emoji\` - [Owner] Add emoji to bot database
\`/bot-delete-emoji\` - [Owner] Delete emoji from bot database
          `,
          color: 0x5865F2
        }]
      });
      break;
    }
  }
});

// Event: Autocomplete
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isAutocomplete()) return;

  if (['add-emoji', 'use-emoji', 'emoji-info', 'bot-delete-emoji'].includes(interaction.commandName)) {
    const focused = interaction.options.getFocused();
    const choices = Array.from(syncedEmoji.keys())
      .filter(name => name.toLowerCase().includes(focused.toLowerCase()))
      .slice(0, 25);

    await interaction.respond(
      choices.map(name => ({ name, value: name }))
    );
  }
});

// Event: Bot joins a server
client.on('guildCreate', async (guild) => {
  console.log(`➕ Joined new server: ${guild.name} (${guild.id})`);

  // Auto-sync emoji to new server if data exists
  if (syncedEmoji.size > 0) {
    const syncCount = Math.min(10, syncedEmoji.size); // Sync first 10 emoji
    const emojis = Array.from(syncedEmoji.values()).slice(0, syncCount);

    let synced = 0;
    for (const emoji of emojis) {
      const result = await useEmojiInServer(guild, emoji.name);
      if (result.success && !result.reused) {
        synced++;
        await new Promise(resolve => setTimeout(resolve, 1000)); // Rate limit
      }
    }

    if (synced > 0) {
      console.log(`  📦 Auto-synced ${synced} emoji to ${guild.name}`);
    }
  }
});

// Error handling
process.on('unhandledRejection', (error) => {
  console.error('❌ Unhandled rejection:', error);
});

// Login
if (!CONFIG.token) {
  console.error('❌ DISCORD_TOKEN not found in .env file!');
  console.log('\n📝 Please create a .env file with your bot token:');
  console.log('   DISCORD_TOKEN=your_bot_token_here');
  process.exit(1);
}

client.login(CONFIG.token);
