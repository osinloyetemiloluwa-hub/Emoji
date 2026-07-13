# Discord Emoji Bot - Quick Start Guide

A Discord bot that syncs animated emojis from a source server and lets you use them in any server the bot is in!

## Features

- 🔄 **Sync Emojis**: Copy animated emojis from a source server
- 🎭 **Universal Use**: Use synced emojis in any server the bot joins
- ⚡ **Slash Commands**: Modern Discord interaction with autocomplete
- 📊 **Emoji Database**: Persistent storage of emoji data
- 🔒 **Owner Control**: Admin-only sync commands

## Setup

### 1. Create a Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application" → Name it (e.g., "Emoji Bot")
3. Go to "Bot" tab → Click "Add Bot"
4. Copy the **Token** (click "Reset Token" if needed)

### 2. Configure Bot Permissions

1. Go to "OAuth2" → "URL Generator"
2. Check scopes: `bot` and `applications.commands`
3. Check permissions:
   - `Manage Emojis` (required for creating emoji)
   - `Send Messages`
   - `Read Message History`
   - `Use Slash Commands`
4. Copy the generated URL and invite the bot

### 3. Install Dependencies

```bash
cd discord-emoji-bot
npm install
```

### 4. Configure Environment

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Edit `.env` with your settings:

```env
DISCORD_TOKEN=your_bot_token_here
SOURCE_SERVER_ID=123456789012345678
BOT_OWNER_ID=123456789012345678
EMOJI_PREFIX=!
```

### 5. Get Required IDs

**SOURCE_SERVER_ID**: Right-click your source server name → "Copy Server ID" (Developer Mode required)

**BOT_OWNER_ID**: Right-click your Discord name → "Copy User ID"

### 6. Run the Bot

```bash
npm start
```

## Commands

### Prefix Commands

| Command | Description |
|---------|-------------|
| `!sync` | Sync emojis from source server (owner only) |
| `!emojis` | List all synced emojis |
| `!emojis <search>` | Search for specific emoji |
| `!add <name>` | Add emoji to current server |
| `!use <name>` | Use emoji in chat |
| `!help` | Show help menu |

### Slash Commands

| Command | Description |
|---------|-------------|
| `/sync-emojis` | Sync emoji from source server (admin) |
| `/list-emojis` | List all synced emojis |
| `/add-emoji <name>` | Add emoji to server |
| `/use-emoji <name>` | Use emoji (autocomplete supported) |
| `/emoji-info <name>` | Get emoji information |

## How It Works

1. **Sync**: Run `!sync` or `/sync-emojis` to download all animated emojis from your source server
2. **Store**: Emojis are saved locally with image data
3. **Use**: Add emojis to any server the bot is in using `!add` or `/add-emoji`
4. **Chat**: Use `!use <name>` or `/use-emoji <name>` in any server

## Important Notes

### Discord Emoji Limits

- **Free servers**: Maximum 50 emoji
- **Nitro servers**: Up to 500 emoji

The bot will warn you if you hit the limit.

### Permissions Required

The bot needs `Manage Emojis` permission in each server to create emoji.

### Rate Limits

Discord has rate limits for creating emoji:
- ~1 emoji per second
- The bot handles this automatically

### Source Server Requirements

- Bot must be a member of the source server
- Bot needs "Manage Emoji" permission in source server
- Only animated emoji are synced by default

## Troubleshooting

### "Emoji not found"

1. Run `!sync` to download emojis first
2. Check if the emoji name is correct
3. Try using the autocomplete in slash commands

### "Emoji limit reached"

- Free Discord servers have a 50 emoji limit
- Delete unused emojis from the server

### Bot won't start

1. Check `.env` file exists and has correct values
2. Verify DISCORD_TOKEN is valid
3. Ensure bot has necessary intents enabled

## File Structure

```
discord-emoji-bot/
├── index.js          # Main bot code
├── package.json      # Dependencies
├── .env              # Configuration (create from .env.example)
├── .env.example      # Configuration template
├── emoji-data.json   # Synced emoji database (auto-generated)
└── README.md         # This file
```

## Support

For issues or feature requests, check:
- Discord.js Documentation: https://discord.js.org/
- Discord API Documentation: https://discord.com/developers/docs
