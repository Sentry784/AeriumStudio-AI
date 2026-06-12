const { Client, GatewayIntentBits, Events } = require('discord.js');
const fetch = require('node-fetch');
const fs = require('fs');

// ── Config ────────────────────────────────────────────────────────────────────
const DISCORD_TOKEN   = process.env.DISCORD_TOKEN;
const GEMINI_API_KEY  = process.env.GEMINI_API_KEY;
const GROQ_API_KEY    = process.env.GROQ_API_KEY;
const ALLOWED_CHANNEL = process.env.CHANNEL_ID || '1491189148563013663';

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL   = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
const GROQ_URL     = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL   = 'llama-3.3-70b-versatile';

const knowledge = fs.readFileSync('./knowledge.json', 'utf8');

const SYSTEM_PROMPT = `You are AeriumCraft AI — the official assistant for AeriumCraft SMP, a sky-themed Minecraft survival server. You live inside the Discord server.

━━━ WHO YOU ARE ━━━
You are a knowledgeable, friendly guide for AeriumCraft. You know everything about the server — ranks, economy, commands, rules, features, and troubleshooting. You speak naturally, not like a bot reading from a manual.

━━━ SCOPE ━━━
- ONLY answer questions about AeriumCraft SMP.
- If someone asks unrelated things, politely say you only know about AeriumCraft.
- Exception: lag/performance questions related to playing on AeriumCraft are valid.

━━━ LANGUAGE ━━━
- Always respond in English only, regardless of the language the user writes in.
- Should understand any languages

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

// ── Conversation history per user (in-memory) ─────────────────────────────────
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

// ── Gemini API call ───────────────────────────────────────────────────────────
async function callGemini(history) {
  const contents = history.map(m => ({
    role:  m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));

  if (contents.length > 0 && contents[0].role === 'model') {
    contents.unshift({ role: 'user', parts: [{ text: 'Hello' }] });
  }

  const payload = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents,
    generationConfig: { maxOutputTokens: 600, temperature: 0.65 }
  };

  const res = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const data = await res.json();

  if (data.error) {
    const code = data.error.code ?? 0;
    const msg  = data.error.message ?? 'Unknown error';
    console.error(`[Gemini Error ${code}]`, msg);
    return { reply: null, error: { code, msg } };
  }

  const finishReason = data.candidates?.[0]?.finishReason;
  if (finishReason === 'SAFETY') {
    console.warn('[Gemini] Response blocked by safety filters.');
    return { reply: null, error: { code: 'SAFETY', msg: 'Safety block' } };
  }

  const reply = data.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
  return { reply, error: null };
}

// ── Groq API call (fallback) ──────────────────────────────────────────────────
async function callGroq(history) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.map(m => ({ role: m.role, content: m.content }))
  ];

  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      max_tokens: 600,
      temperature: 0.65
    })
  });

  const data = await res.json();

  if (data.error) {
    const msg = data.error.message ?? 'Unknown Groq error';
    console.error('[Groq Error]', msg);
    return { reply: null, error: msg };
  }

  const reply = data.choices?.[0]?.message?.content ?? null;
  return { reply, error: null };
}

// ── Friendly error messages ───────────────────────────────────────────────────
function geminiErrorMessage(code) {
  return {
    401: 'Invalid Gemini API key.',
    403: 'Gemini API access denied.',
    429: 'Rate limit hit. Switching to backup AI...',
    500: 'Gemini is temporarily unavailable. Switching to backup AI...',
    503: 'Gemini is temporarily unavailable. Switching to backup AI...'
  }[code] ?? null;
}

// ── Main AI handler (Gemini → Groq fallback) ──────────────────────────────────
async function askAI(userId, userMessage) {
  addToHistory(userId, 'user', userMessage);
  const history = getHistory(userId);

  // 1. Try Gemini
  const geminiResult = await callGemini(history);

  let reply = null;
  let modelUsed = 'gemini';

  if (geminiResult.reply) {
    reply = geminiResult.reply;
  } else {
    const errCode = geminiResult.error?.code;

    // Fallback on rate limit / server errors
    const shouldFallback = [429, 500, 503].includes(errCode) || errCode !== 'SAFETY';

    if (shouldFallback) {
      console.warn(`[Fallback] Gemini failed (code ${errCode}), trying Groq...`);
      const groqResult = await callGroq(history);

      if (groqResult.reply) {
        reply = groqResult.reply;
        modelUsed = 'groq';
      } else {
        throw new Error('Both AI providers are currently unavailable. Please try again shortly.');
      }
    } else {
      // Safety block — don't fallback, just surface it
      throw new Error('Response blocked by safety filters.');
    }
  }

  console.log(`[AI] Responded via ${modelUsed}`);

  // Trim to Discord's limit
  const trimmed = reply.length > 1800 ? reply.slice(0, 1797) + '...' : reply;
  addToHistory(userId, 'assistant', trimmed);
  return trimmed;
}

// ── Discord client ────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once(Events.ClientReady, () => {
  console.log(`AeriumCraft AI Bot is online as ${client.user.tag}`);
  console.log(`Primary model : ${GEMINI_MODEL}`);
  console.log(`Fallback model: ${GROQ_MODEL}`);
  console.log(`Allowed channel: ${ALLOWED_CHANNEL}`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.channel.id !== ALLOWED_CHANNEL) return;

  const botMentioned = message.mentions.has(client.user);
  const isQuestion   = message.content.trim().startsWith('?');

  if (!botMentioned && !isQuestion) return;

  let userText = message.content
    .replace(`<@${client.user.id}>`, '')
    .replace(/^\?/, '')
    .trim();

  if (!userText) {
    return message.reply('Ask me anything about AeriumCraft!');
  }

  await message.channel.sendTyping();

  try {
    const reply = await askAI(message.author.id, userText);
    await message.reply(reply);
  } catch (err) {
    console.error('[Bot Error]', err.message);
    await message.reply(`Sorry, something went wrong: ${err.message}`);
  }
});

client.login(DISCORD_TOKEN);
