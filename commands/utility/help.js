// ============================================================
//  APEX-MD · Help / Menu Command  (commands/utility/help.js)
//
//  Displays the full command catalogue grouped by category.
//  Works whether the bot runs standalone OR in API-bridge mode.
// ============================================================

'use strict';

const config            = require('../../config');
const { commands }      = require('../../lib/handler');

// ── Category display config ───────────────────────────────────
const CAT = {
  admin:      { emoji: '🛡️',  label: 'Admin' },
  ai:         { emoji: '🤖',  label: 'AI' },
  anime:      { emoji: '🎭',  label: 'Anime Reactions' },
  business:   { emoji: '💼',  label: 'Business' },
  downloader: { emoji: '📥',  label: 'Downloaders' },
  fun:        { emoji: '💥',  label: 'Fun' },
  games:      { emoji: '🎮',  label: 'Games & Economy' },
  media:      { emoji: '🎬',  label: 'Media' },
  owner:      { emoji: '👑',  label: 'Owner' },
  protection: { emoji: '🔒',  label: 'Protection' },
  utility:    { emoji: '🔧',  label: 'Utility' },
};

module.exports = {
  name:    'help',
  aliases: ['menu', 'commands', 'h', 'cmds'],
  category: 'utility',
  desc:    'Show all commands or details for one command',
  usage:   '.help [command]',
  public:  true,

  async execute({ sock, msg, from, args }) {
    const P   = config.BOT_PREFIX;
    const DIV = config.DIVIDER;
    const EMJ = config.THEME_EMOJI;

    // ── Single command detail ─────────────────────────────
    if (args[0]) {
      const name = args[0].toLowerCase().replace(/^\./, '');
      const cmd  = commands.get(name);
      if (!cmd) {
        return sock.sendMessage(from, {
          text: `❌ Command *${name}* not found.\nType *${P}help* to see all commands.`,
        }, { quoted: msg });
      }

      const flags = [
        cmd.ownerOnly  ? '👑 Owner only'  : null,
        cmd.adminOnly  ? '🛡️ Admin only'  : null,
        cmd.groupOnly  ? '👥 Groups only' : null,
        cmd.privateOnly? '💬 DM only'     : null,
        cmd.public     ? '🌍 Public'      : null,
      ].filter(Boolean).join('  ·  ');

      return sock.sendMessage(from, {
        text: [
          `${EMJ} *${cmd.name.toUpperCase()}*`,
          DIV,
          `📋 ${cmd.desc || 'No description'}`,
          `💡 *Usage:* ${cmd.usage || P + cmd.name}`,
          `🏷️ *Category:* ${CAT[cmd.category]?.label || cmd.category}`,
          cmd.aliases?.length ? `🔁 *Aliases:* ${cmd.aliases.join(', ')}` : null,
          flags ? `🔐 *Access:* ${flags}` : null,
        ].filter(Boolean).join('\n'),
      }, { quoted: msg });
    }

    // ── Full menu ─────────────────────────────────────────

    // Group commands by category
    const grouped = {};
    for (const [, cmd] of commands.entries()) {
      const cat = cmd.category || 'utility';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(cmd.name);
    }

    // Sort categories so owner is always last
    const catOrder = Object.keys(CAT).filter(c => grouped[c]);
    if (grouped['owner'] && catOrder.at(-1) !== 'owner') {
      catOrder.splice(catOrder.indexOf('owner'), 1);
      catOrder.push('owner');
    }

    const total = [...commands.values()].length;

    // Build header
    const lines = [
      `${EMJ} *${config.BOT_NAME}* v${config.BOT_VERSION}`,
      DIV,
      `📦 *${total} commands*  ·  Prefix: \`${P}\``,
      `🌍 Mode: ${config.PUBLIC_MODE ? 'Public' : 'Private'}`,
      `⚡ API Bridge: ${config.API_ENABLED ? 'Active ✅' : 'Disabled 🔴'}`,
      DIV,
    ];

    // One line per category
    for (const cat of catOrder) {
      const { emoji, label } = CAT[cat] || { emoji: '📌', label: cat };
      const cmds  = grouped[cat];
      const names = cmds.map(n => `\`${P}${n}\``).join('  ');
      lines.push(`${emoji} *${label}* (${cmds.length})`);
      lines.push(names);
      lines.push('');
    }

    lines.push(DIV);
    lines.push(`💡 Type *${P}help [command]* for details on any command.`);
    lines.push(`🔌 REST API: ${config.API_ENABLED ? 'On' : 'Off'}  ·  POST /api/send  etc.`);

    return sock.sendMessage(from, { text: lines.join('\n') }, { quoted: msg });
  },
};
