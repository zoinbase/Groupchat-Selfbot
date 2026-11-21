# gcmanager

A Discord group chat manager that runs on a user account. It keeps a ban list, supports votekicks, and lets you snipe deleted and edited messages. It only acts in the one group chat you configure.

> **Warning:** this uses [`discord.js-selfbot-v13`](https://github.com/aiko-chan-ai/discord.js-selfbot-v13). Automating a user account is against Discord's Terms of Service and can get the account banned. Use it at your own risk, preferably on an account you can afford to lose. Never share or commit your token.

## Features

- **Ban list:** banned users are removed straight away if someone re-adds them. The person re-adding gets a warning on the second attempt and is kicked on the third (owners are exempt).
- **Votekick:** anyone can start a vote, and the target is removed once enough people react ✅.
- **Snipe:** keeps the last 7 deleted messages, including attachments.
- **Edit snipe:** keeps the last 7 edits, showing who edited and the before and after text.

## Setup

Requires Node.js 20.18 or newer.

```bash
git clone https://github.com/zoinbase/Groupchat-Selfbot
cd gcmanager
npm install
cp config.example.json config.json   # on Windows: copy config.example.json config.json
```

Edit `config.json`, then start it:

```bash
npm start
```

### Config

| Key | Description |
| --- | --- |
| `token` | Token of the account the bot runs on |
| `groupId` | ID of the group chat to manage |
| `ownerIds` | User IDs allowed to use owner commands (include the account running the bot if it should use them) |
| `snipeIds` | Extra user IDs allowed to use `,s` and `,esnipe` |
| `votekickTime` | How long a votekick stays open, in ms |
| `votesRequired` | Votes needed to kick |
| `commandCooldownTime` | Per-user command cooldown, in ms |

Turn on Developer Mode in Discord settings, then right-click a user or channel and choose Copy ID to get IDs.

## Commands

Prefix is `,`. Replies are reactions: ✅ worked, ❌ failed or bad usage, ⏳ votekick on lockout, 🔨 ban or successful votekick.

| Command | Who | What it does |
| --- | --- | --- |
| `,kick <@user or ID>` | Owners | Remove a user |
| `,ban <@user or ID>` | Owners | Add to the ban list and remove |
| `,unban <ID>` | Owners | Remove from the ban list |
| `,banlist` | Owners | List banned users |
| `,votekick <@user or ID>` | Anyone | Start a votekick (one per 60s) |
| `,s` | Owners and `snipeIds` | DM the last 7 deleted messages |
| `,esnipe` | Owners and `snipeIds` | DM the last 7 edits |

## Files created

`banned.json`, `snipes.json` and `esnipes.json` are created next to `index.js`. They are git-ignored, as is `config.json`.

## Keeping it running

For auto-restart, use something like [pm2](https://pm2.keymetrics.io/):

```bash
npm i -g pm2
pm2 start index.js --name gcmanager
```
