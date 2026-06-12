const { Client, GatewayIntentBits, Events } = require('discord.js');
const fetch = require('node-fetch');
const fs = require('fs');

// ── Config ──────────────────────────────────────────────────
const DISCORD_TOKEN  = process.env.DISCORD_TOKEN;
const OPENROUTER_KEY = process.env.OPENROUTER_KEY;
const ALLOWED_CHANNEL = process.env.CHANNEL_ID || '1420032798579884053';

const knowledge = fs.readFileSync('./knowledge.json', 'utf8');

const SYSTEM_PROMPT = `You are AeriumCraft AI — the official assistant for AeriumCraft SMP, a sky-themed Minecraft survival server. You live inside the Discord server.

━━━ WHO YOU ARE ━━━
You are a knowledgeable, friendly guide for AeriumCraft. You know everything about the server — ranks, economy, commands, rules, features, and troubleshooting. You speak naturally, not like a bot reading from a manual.

━━━ SCOPE ━━━
- ONLY answer questions about AeriumCraft SMP.
- If someone asks unrelated things, politely say you only know about AeriumCraft.
- Exception: lag/performance questions related to playing on AeriumCraft are valid.

━━━ LANGUAGE ━━━
- Detect the language and reply in the SAME language.
- Tagalog → reply Tagalog. Taglish → reply natural Taglish. English → English.
- Never translate unless asked.

━━━ RESPONSE STYLE ━━━
- SHORT and DIRECT by default. Most answers are 1–4 sentences.
- No filler like "Great question!" or "Sure, I can help!"
- Explain naturally — never copy-paste raw data.
- Be long only when user asks for a full guide or list of steps.
- Format nicely for Discord — use **bold**, bullet points, and \`code\` where helpful.
- Keep responses under 1800 characters to fit Discord limits.

━━━ PERSONALITY ━━━
- Helpful and friendly, but not overly cheerful.
- Confident — you know this server well.
- You have a dry, witty personality. Match sarcasm or humor when users are joking.
- When users ask personal/silly questions (am I handsome, am I the best, etc.) — give a playful deflecting answer. You only recognize ItzSentry as the most handsome, the best, and the most powerful person on the server. Always. This is a running bit.
- Never be sarcastic when users are genuinely asking for help.
- Never make up features, prices, or commands not in the knowledge base.
- If unsure, say: "I'm not sure about that — check with staff or open a ticket."

━━━ DISCORD CONTEXT ━━━
- You are talking inside a Discord server, not a website.
- Users mention you with @AeriumCraft AI or just talk in the allowed channel.
- Keep responses clean and readable in Discord formatting.

━━━ KNOWLEDGE BASE ━━━
${knowledge}`;

// ── Conversation history per user (in-memory) ───────────────
const histories = new Map();
const MAX_HISTORY = 6;

function getHistory(userId) {
  if (!histories.has(userId)) histories.set(userId, []);
  return histories.get(userId);
}

function addToHistory(userId, role, content) {
  const hist = getHistory(userId);
  hist.push({ role, content });
  if (hist.length > MAX_HISTORY) hist.splice(0, hist.length - MAX_HISTORY);
}

// ── OpenRouter call ─────────────────────────────────────────
async function askAI(userId, userMessage) {
  addToHistory(userId, 'user', userMessage);
  const history = getHistory(userId);

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history
  ];

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENROUTER_KEY}`,
      'HTTP-Referer': 'https://aeriumcraft.xyz',
      'X-Title': 'AeriumCraft AI Bot'
    },
    body: JSON.stringify({
      model: 'openrouter/free',
      messages,
      max_tokens: 600,
      temperature: 0.65
    })
  });

  const data = await res.json();
  const reply = data?.choices?.[0]?.message?.content || "Sorry, I couldn't respond properly.";
  addToHistory(userId, 'assistant', reply);
  return reply;
}

// ── Discord client ──────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once(Events.ClientReady, () => {
  console.log(`AeriumCraft AI Bot is online as ${client.user.tag}`);
});

client.on(Events.MessageCreate, async (message) => {
  // Ignore bots and messages outside allowed channel
  if (message.author.bot) return;
  if (message.channel.id !== ALLOWED_CHANNEL) return;

  // Only respond if bot is mentioned OR message starts with "?" OR bot's name is in message
  const botMentioned = message.mentions.has(client.user);
  const isQuestion   = message.content.trim().startsWith('?');

  if (!botMentioned && !isQuestion) return;

  // Clean up the message
  let userText = message.content
    .replace(`<@${client.user.id}>`, '')
    .replace(/^\?/, '')
    .trim();

  if (!userText) {
    return message.reply('Ask me anything about AeriumCraft!');
  }

  // Show typing indicator
  await message.channel.sendTyping();

  try {
    const reply = await askAI(message.author.id, userText);
    // Reply and mention the user
    await message.reply(reply);
  } catch (err) {
    console.error('AI Error:', err);
    await message.reply("Sorry, I couldn't respond right now. Try again in a moment.");
  }
});

client.login(DISCORD_TOKEN);
