const noblox = require("noblox.js");
const fetch = require("node-fetch");
require("dotenv").config();

// ── Config ────────────────────────────────────────────────────────────────────

const ROBLOSECURITY    = process.env.ROBLOSECURITY;     // your alt account cookie
const DISCORD_WEBHOOK  = process.env.DISCORD_WEBHOOK;   // your discord webhook url
const PLACE_ID         = 108198689428508;               // Stonks game place ID
const COOLDOWN_MS      = 60 * 1000;                     // 1 min cooldown per name

// ── Patterns from the screenshot ─────────────────────────────────────────────
// Matches things like:
//   "LDN is going CRAZY!"
//   "MAHO lowkey getting pumped rn"
//   "garubon sold 1 share of LDN for P 4!"  ← rising trade activity

const RISE_PATTERNS = [
  /is going crazy/i,
  /getting pumped/i,
  /is going up/i,
  /is rising/i,
  /is surging/i,
  /📈/,
  /🚀/,
  /mooning/i,
  /to the moon/i,
  /pumping/i,
  /skyrocket/i,
];

// Detects rapid sell messages for the same ticker (trade activity surge)
// e.g. multiple "sold X share of LDN" in a short window
const recentTrades = new Map(); // ticker → [timestamps]
const TRADE_SURGE_COUNT  = 3;    // how many trades in the window = surge
const TRADE_SURGE_WINDOW = 30000; // 30 seconds

// ── State ─────────────────────────────────────────────────────────────────────

const lastAlerted = new Map(); // name → timestamp

function isOnCooldown(name) {
  const last = lastAlerted.get(name) ?? 0;
  return Date.now() - last < COOLDOWN_MS;
}

// ── Pattern matching ──────────────────────────────────────────────────────────

function checkRisePatterns(message) {
  return RISE_PATTERNS.some((p) => p.test(message));
}

/**
 * Detects a trade surge for a ticker.
 * e.g. "garubon sold 1 share of LDN for P 4!" → ticker = "LDN"
 * If the same ticker appears 3+ times in 30s, it's surging.
 */
function checkTradeSurge(message) {
  // Match "sold X share(s) of TICKER for"
  const m = message.match(/sold \d+ shares? of ([A-Z]{2,6}) for/i);
  if (!m) return null;

  const ticker = m[1].toUpperCase();
  const now = Date.now();

  if (!recentTrades.has(ticker)) recentTrades.set(ticker, []);
  const times = recentTrades.get(ticker);

  // Add current timestamp
  times.push(now);

  // Remove timestamps outside the window
  const windowStart = now - TRADE_SURGE_WINDOW;
  const recent = times.filter((t) => t >= windowStart);
  recentTrades.set(ticker, recent);

  if (recent.length >= TRADE_SURGE_COUNT) {
    return ticker; // surge detected
  }
  return null;
}

// ── Discord webhook ───────────────────────────────────────────────────────────

async function sendAlert(name, reason, rawMessage) {
  console.log(`[Alert] ${name} — ${reason}`);

  const body = {
    content: `@here 📈 **${name}** is rising on Stonks!`,
    embeds: [
      {
        title: `📈 ${name} is going UP!`,
        description: `**Reason:** ${reason}\n**Message:**\n> ${rawMessage}`,
        color: 0x00ff88,
        fields: [
          {
            name: "🎮 Play now",
            value: "[Stonks on Roblox](https://www.roblox.com/games/108198689428508/Stonks)",
          },
        ],
        footer: { text: "Stonks Chat Notifier" },
        timestamp: new Date().toISOString(),
      },
    ],
  };

  const res = await fetch(DISCORD_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) console.error(`[Webhook] Failed: ${res.status}`);
}

// ── Message handler ───────────────────────────────────────────────────────────

async function handleMessage(msg) {
  const text = msg.message ?? msg.text ?? String(msg);
  if (!text) return;

  console.log(`[Chat] ${text}`);

  // Check direct rise patterns
  if (checkRisePatterns(text)) {
    // Try to extract a ticker/name from the message
    const nameMatch = text.match(/\b([A-Z]{2,6})\b/);
    const name = nameMatch ? nameMatch[1] : text.slice(0, 30).trim();

    if (!isOnCooldown(name)) {
      lastAlerted.set(name, Date.now());
      await sendAlert(name, "Rise phrase detected in chat", text);
    }
    return;
  }

  // Check for trade surge (e.g. lots of "sold X share of LDN" quickly)
  const surgeTicker = checkTradeSurge(text);
  if (surgeTicker && !isOnCooldown(surgeTicker)) {
    lastAlerted.set(surgeTicker, Date.now());
    await sendAlert(surgeTicker, `Trade surge — ${TRADE_SURGE_COUNT}+ trades in ${TRADE_SURGE_WINDOW / 1000}s`, text);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!ROBLOSECURITY)   throw new Error("Missing ROBLOSECURITY in .env");
  if (!DISCORD_WEBHOOK) throw new Error("Missing DISCORD_WEBHOOK in .env");

  console.log("[Bot] Logging into Roblox...");
  await noblox.setCookie(ROBLOSECURITY);

  const me = await noblox.getCurrentUser();
  console.log(`[Bot] Logged in as: ${me.UserName}`);

  // Join the Stonks game server
  // noblox doesn't control the actual Roblox client (that would require
  // launching the app), but it CAN listen to the game's chat via
  // the social chat API if your account is present in the server.
  //
  // The most reliable approach: launch the Roblox client separately
  // (or use Roblox's "Play" button) and let this script listen via
  // the chat subscription below.

  console.log(`[Bot] Subscribing to chat in place ${PLACE_ID}...`);

  // Listen to game chat using noblox's onMessage
  // This hooks into the Roblox chat websocket for your account's current session
  const chatEvent = await noblox.onMessage(PLACE_ID);

  chatEvent.on("data", async (msg) => {
    try {
      await handleMessage(msg);
    } catch (err) {
      console.error("[Handler] Error:", err.message);
    }
  });

  chatEvent.on("error", (err) => {
    console.error("[Chat] Error:", err.message);
  });

  chatEvent.on("close", () => {
    console.warn("[Chat] Connection closed — reconnecting in 5s...");
    setTimeout(main, 5000);
  });

  console.log("[Bot] ✅ Listening for rising stonks...");
}

main().catch((err) => {
  console.error("[Fatal]", err.message);
  process.exit(1);
});
