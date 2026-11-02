const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers, downloadMediaMessage } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

// Load configuration
const configPath = path.join(__dirname, 'config.json');
let config = {
    bot_phone_number: "8801671961399",
    business_name: "",
    social_links: {
        website: "",
        youtube: "",
        facebook: "",
        whatsapp_group: ""
    }
};

if (fs.existsSync(configPath)) {
    try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
        console.error('[CONFIG ERROR] Failed to parse config.json, using defaults.');
    }
}

let sock = null;
let currentQr = null;
let currentQrDataUrl = null;
let isConnected = false;
let currentPairingCode = null;

function getSessionKeyString() {
    try {
        const credsPath = path.join(__dirname, 'auth_session', 'creds.json');
        if (fs.existsSync(credsPath)) {
            const raw = fs.readFileSync(credsPath, 'utf8');
            return Buffer.from(raw).toString('base64');
        }
    } catch (_) {}
    return null;
}

function restoreSessionFromEnv() {
    const sessionDir = path.join(__dirname, 'auth_session');
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }
    const credsPath = path.join(sessionDir, 'creds.json');
    if (process.env.WHATSAPP_SESSION_DATA) {
        try {
            const rawJson = Buffer.from(process.env.WHATSAPP_SESSION_DATA.trim(), 'base64').toString('utf8');
            fs.writeFileSync(credsPath, rawJson, 'utf8');
            console.log('\n🔑 [PERMANENT SESSION RESTORED] Loaded credentials from WHATSAPP_SESSION_DATA env variable!\n');
        } catch (e) {
            console.error('[SESSION RESTORE ERROR] Could not decode WHATSAPP_SESSION_DATA:', e.message);
        }
    }
}

// Active chat conversation memory per sender
// senderPhone -> { lastActive: timestamp, greeted: boolean, history: [ { role: 'user' | 'model', parts: [{ text }] } ] }
const chatMemories = {};

function getChatMemory(senderPhone) {
    const now = Date.now();
    if (!chatMemories[senderPhone] || (now - chatMemories[senderPhone].lastActive > 30 * 60 * 1000)) {
        chatMemories[senderPhone] = {
            lastActive: now,
            greeted: false,
            history: []
        };
    }
    chatMemories[senderPhone].lastActive = now;
    return chatMemories[senderPhone];
}

function loadAiKnowledge() {
    try {
        const kPath = path.join(__dirname, 'ai_knowledge.json');
        if (fs.existsSync(kPath)) {
            return JSON.parse(fs.readFileSync(kPath, 'utf8'));
        }
    } catch (_) {}
    return {};
}

function getSmartFallbackReply(userMessage, hasImage = false, senderPhone = null) {
    if (hasImage && !userMessage) {
        return `স্ক্রিনশটটি পেয়েছি ভাই! এটি যদি পেমেন্টের স্ক্রিনশট হয়, তবে আপনার নম্বরের লাস্ট ডিজিট লিখে জানান, চেক করে কনফার্ম গ্রুপের লিংক দিয়ে দিচ্ছি। আর অন্য কোনো বিষয় হলে লিখে জানান ভাই!`;
    }
    const knowledge = loadAiKnowledge();
    const links = knowledge.links || {};
    const platformName = knowledge.platform_name || knowledge.business_or_person_name || 'আমাদের প্ল্যাটফর্ম';

    const mem = senderPhone ? getChatMemory(senderPhone) : null;
    const alreadyGreeted = mem ? mem.greeted : false;

    const raw = (userMessage || '').trim().toLowerCase();
    const isSalam = /(?:সালাম|assalamu|salam|slm|আসসালামু)/i.test(raw);
    const asksPayment = /(?:payment|পেমেন্ট|টাকা.*(?:পাঠাব|পাঠাবো|দিব|দেবো|দেওয়া|দেয়া|দেওয়ার|পাঠানোর|ভরব|মারব|কেমনে|কীভাবে|কিভাবে)|বিকাশ|নগদ|রকেট|bkash|nagad|rocket|send money|সেন্ড মানি|slot|স্লট|টাকা কোথায়|payment method|payment system)/i.test(raw);
    const asksFb = /(?:facebook|fb page|fb|ফেসবুক)/i.test(raw);
    const asksYt = /(?:youtube|yt channel|yt|ইউটিউব|ইউটিউবের)/i.test(raw);
    const asksTiktok = /(?:tiktok|টিকটক)/i.test(raw);
    const asksIg = /(?:instagram|insta|ig|ইনস্টা|ইন্সটা)/i.test(raw);
    const asksThreads = /(?:threads|থ্রেডস)/i.test(raw);
    const asksTg = /(?:telegram|টেলিগ্রাম|ট্যালিগ্রাম|tg|টিজি)/i.test(raw);
    const asksDc = /(?:discord|ডিসকর্ড|ডিসকোড|dc)/i.test(raw);
    const asksWaChannel = /(?:whatsapp channel|wa channel|হোয়াটসঅ্যাপ চ্যানেল|হোয়াটসঅ্যাপ চ্যানেল|হোয়াটসঅ্যাপ|হোয়াটসঅ্যাপ)/i.test(raw);

    const asksAllSocial = /(?:sob|shob|সব|all).*(?:platform|link|লিংক|প্ল্যাটফর্ম|সোশ্যাল|social|media|গূলা|গুলা|গুলো)|(?:social|সোশ্যাল).*(?:link|লিংক)|(?:aksathe|একসাথে).*(?:link|লিংক|দিতে|দেও|দাও|problem)|(?:link|লিংক).*(?:aksathe|একসাথে)|(?:platform|প্ল্যাটফর্ম)/i.test(raw);
    const isAngry = /(?:bainchod|mc|bc|madarchod|khankir|chutiya|বাইনচোদ|খানকির|চুদি|শালা|হারামি)/i.test(raw);

    const asksLink = /(?:website|ওয়েবসাইট|ওয়েবসাইট|web link|সাইট লিংক|সাইট কোথায়|সাইট খুঁজে|কোথায় পাব)/i.test(raw) || (raw.includes('link') && !asksAllSocial && !asksFb && !asksYt && !asksTiktok && !asksIg && !asksThreads && !asksTg && !asksDc && !asksWaChannel && !asksPayment);
    const isThanks = /(?:ধন্যবাদ|thanks|thx|tnx|shukriya|শুকরিয়া)/i.test(raw);
    const isHowAreYou = /(?:কেমন আছেন|kemon achen|bhalo achen|ভালো আছেন|kmn aso|kemon aso)/i.test(raw);
    const isDoing = /(?:ki koro|কী করো|কি করো|কি কর|ki korso)/i.test(raw);
    const isSure = /(?:sure|সিওর|শিওর)/i.test(raw);
    const asksWho = /(?:tmi k|tumi ke|apni ke|apni k|তুমি কে|আপনি কে|তমি ক|tmr porichoy|porichoy ki|পরিচয় কি|কে তুমি|ke tmi|ke tumi|কে আপনি|ke apni|তানিম কে|tanim ke|তানিম ভাই কে|tanim vai ke)/i.test(raw);
    const isHalaBanter = /(?:hur hla|hala|হালা|হালার|ভাগ|kire|কি রে)/i.test(raw);

    if (mem) mem.greeted = true;

    if (asksPayment) {
        return `PAYMENT METHOD- SEND MONEY ONLY\n\n` +
            `বিকাশ- 01611657757\n` +
            `নগদ- 01611657757\n` +
            `রকেট- 01611657757\n\n` +
            `notice\n\n` +
            `> একবার স্লট কনফার্ম করলে, পরবর্তীতে সেই স্লট বাতিলযোগ্য না।\n\n` +
            `> টাকা দেওয়ার পর প্রমান স্বরূপ Screenshot জমা দিবেন এবং নম্বরের লাস্ট ডিজিট বলবেন।\n\n` +
            `> টাকা দেওয়ার পর নিজ দায়িত্বে কনর্ফাম গ্রুপের লিংক নিয়ে নিবেন, তা না হলে স্লট শেষ হয়ে গেলে আমরা দায়ী থাকবো না।\n\n` +
            `> পেমেন্ট করতে দেরি হলে সেই সময়ের মধ্যে স্লট শেষ হয়ে গেলে পেমেন্ট ব্যাক দেওয়া হবে না, পরবর্তীতে যেকোনো সময়ে স্লট নিতে পারবেন।`;
    }

    if (asksWho) {
        return `আমি ${platformName}-এর এবং তানিম ভাইয়ের অফিসিয়াল সাপোর্ট অ্যাডমিন ভাই! কোনো হেল্প বা লিংক লাগলে বলেন, দিয়ে দিচ্ছি।`;
    }

    if (isHalaBanter) {
        return `আরে ভাই কি হইছে? হালা বলেন কেন 😂 কোনো সমস্যা বা লিংক লাগলে বলেন, দিচ্ছি!`;
    }

    if (asksAllSocial) {
        const linkItems = [];
        if (links.youtube) linkItems.push(`📺 YouTube: ${links.youtube}`);
        if (links.facebook) linkItems.push(`🌐 Facebook: ${links.facebook}`);
        if (links.whatsapp_channel) linkItems.push(`💬 WhatsApp Channel: ${links.whatsapp_channel}`);
        if (links.telegram) linkItems.push(`✈️ Telegram Channel: ${links.telegram}`);
        if (links.discord) linkItems.push(`👾 Discord Server: ${links.discord}`);
        if (links.tiktok) linkItems.push(`🎵 TikTok: ${links.tiktok}`);
        if (links.website) linkItems.push(`🌐 Website: ${links.website}`);
        if (links.instagram) linkItems.push(`📸 Instagram: ${links.instagram}`);

        if (linkItems.length > 0) {
            return `এই যে ভাই আমাদের অফিসিয়াল সব প্ল্যাটফর্ম ও সোশ্যাল মিডিয়ার লিংক একসাথে:\n\n` + linkItems.join('\n');
        }
        return `আমাদের সোশ্যাল মিডিয়া লিংকগুলো দ্রুতই এখানে যুক্ত করে দেওয়া হবে ভাই!`;
    }

    if (isAngry) {
        return `আরে ভাই রাগ করছেন কেন! বলেন কী লিংক বা কী দরকার, আমি এখনই দিয়ে দিচ্ছি ভাই।`;
    }

    if (asksWaChannel) {
        return links.whatsapp_channel ? `এই যে ভাই আমাদের অফিসিয়াল WhatsApp Channel লিংক:\n${links.whatsapp_channel}` : `আমাদের WhatsApp Channel লিংকটি দ্রুতই দেওয়া হবে ভাই।`;
    }
    if (asksTg) {
        return links.telegram ? `এই যে ভাই আমাদের অফিসিয়াল টেলিগ্রাম চ্যানেল লিংক:\n${links.telegram}` : `আমাদের টেলিগ্রাম চ্যানেল লিংকটি দ্রুতই দেওয়া হবে ভাই।`;
    }
    if (asksDc) {
        return links.discord ? `এই যে ভাই আমাদের অফিসিয়াল ডিসকর্ড সার্ভার লিংক:\n${links.discord}` : `আমাদের ডিসকর্ড সার্ভার লিংকটি দ্রুতই দেওয়া হবে ভাই।`;
    }
    if (asksFb) {
        return links.facebook ? `এই যে ভাই আমাদের অফিসিয়াল ফেসবুক পেজ:\n${links.facebook}` : `আমাদের ফেসবুক পেজ লিংকটি দ্রুতই আপডেট করা হবে ভাই।`;
    }
    if (asksYt) {
        return links.youtube ? `এই যে ভাই আমাদের অফিসিয়াল ইউটিউব চ্যানেল:\n${links.youtube}` : `আমাদের ইউটিউব চ্যানেল লিংকটি দ্রুতই আপডেট করা হবে ভাই।`;
    }
    if (asksTiktok) {
        return links.tiktok ? `এই যে ভাই আমাদের অফিসিয়াল টিকটক অ্যাকাউন্ট:\n${links.tiktok}` : `আমাদের টিকটক লিংকটি দ্রুতই আপডেট করা হবে ভাই।`;
    }
    if (asksIg) {
        return links.instagram ? `এই যে ভাই আমাদের অফিসিয়াল ইনস্টাগ্রাম আইডি:\n${links.instagram}` : `আমাদের ইনস্টাগ্রাম লিংকটি দ্রুতই আপডেট করা হবে ভাই।`;
    }
    if (asksThreads) {
        return links.threads ? `এই যে ভাই আমাদের থ্রেডস প্রোফাইল:\n${links.threads}` : `আমাদের থ্রেডস লিংকটি দ্রুতই আপডেট করা হবে ভাই।`;
    }
    if (asksLink) {
        return links.website ? `অবশ্যই ভাই! আমাদের অফিসিয়াল ওয়েবসাইট লিংক:\n${links.website}` : `আমাদের সব লিংক একসাথে পেতে "সব লিংক" লিখে মেসেজ দিন ভাই।`;
    }

    // Check how_to_guides or FAQ dynamically
    const guides = knowledge.how_to_guides || knowledge.frequently_asked_questions || {};
    for (const [key, val] of Object.entries(guides)) {
        if (typeof val === 'string' && val.length > 0) {
            const cleanKey = key.toLowerCase().replace(/_/g, ' ');
            if (raw.includes(cleanKey)) {
                return val;
            }
        }
    }

    if (isThanks) {
        return `ওয়েলকাম ভাই! যেকোনো প্রয়োজনে জানাবেন।`;
    }
    if (isDoing) {
        return `এই তো ভাই সাপোর্ট চ্যাটে আছি। বলেন কোনো সমস্যা বা হেল্প লাগবে?`;
    }
    if (isSure) {
        return `হ্যাঁ ভাই একদম সিওর! বলেন কী বিষয়?`;
    }
    if (isHowAreYou) {
        return isSalam ? `ওয়ালাইকুম আসসালাম ভাই! আলহামদুলিল্লাহ ভালো আছি। আপনার কী অবস্থা?` : `আলহামদুলিল্লাহ ভাই ভালো আছি। আপনি কেমন আছেন?`;
    }
    if (isSalam) {
        return `ওয়ালাইকুম আসসালাম ভাই! কোনো বিষয়ে হেল্প লাগলে বলেন।`;
    }
    const isInsisting = /(?:bolo|বলো|বল|please|প্লিজ|বলেন|bolte|kivave|কীভাবে|কিভাবে)/i.test(raw);
    if (isInsisting) {
        return `আরে ভাই সত্যি বলতে এটা নিয়ে আমার পুরোপুরি জানা নাই 😂 অন্য কোনো তথ্য বা হেল্প লাগলে বলেন দেখছি!`;
    }
    if (alreadyGreeted) {
        const casualReplies = [
            `জি ভাই বলেন, কী খবর?`,
            `আছি ভাই, বলেন কোনো হেল্প লাগবে?`,
            `হ্যাঁ ভাই বলেন, শুনতে পাচ্ছি।`
        ];
        return casualReplies[Math.floor(Math.random() * casualReplies.length)];
    }
    return `জি ভাই বলেন, কী অবস্থা?`;
}

function requestGeminiApi(modelName, data, apiKey, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'generativelanguage.googleapis.com',
            path: `/v1beta/models/${modelName}:generateContent?key=${apiKey}`,
            method: 'POST',
            timeout: timeoutMs,
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey,
                'Content-Length': Buffer.byteLength(data)
            }
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        const json = JSON.parse(body);
                        const reply = json.candidates?.[0]?.content?.parts?.[0]?.text;
                        if (reply) return resolve(reply.trim());
                    } catch (_) {}
                    return reject(new Error('Invalid JSON from Gemini'));
                } else {
                    console.warn(`⚠️ [GEMINI API ERROR HTTP ${res.statusCode} (${modelName})] ${body.slice(0, 180)}`);
                    return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 140)}`));
                }
            });
        });
        req.on('timeout', () => {
            req.destroy();
            reject(new Error(`Timeout after ${timeoutMs}ms`));
        });
        req.on('error', err => reject(err));
        req.write(data);
        req.end();
    });
}

// Sanitizes and validates multi-turn conversation contents for Google Gemini API
// Ensures strict alternation (user -> model -> user) and valid start/end roles
function formatGeminiContents(history = [], currentParts = []) {
    const raw = [];
    if (Array.isArray(history)) {
        for (const item of history) {
            if (!item || !item.role || !Array.isArray(item.parts) || item.parts.length === 0) continue;
            const validParts = item.parts.filter(p => p && (p.text || p.inlineData));
            if (validParts.length > 0) {
                raw.push({ role: item.role === 'model' ? 'model' : 'user', parts: validParts });
            }
        }
    }

    const validCurrent = (currentParts || []).filter(p => p && (p.text || p.inlineData));
    if (validCurrent.length > 0) {
        raw.push({ role: 'user', parts: validCurrent });
    }

    // Must start with 'user'
    while (raw.length > 0 && raw[0].role !== 'user') {
        raw.shift();
    }

    // Strictly alternate roles; merge consecutive same-role turns
    const clean = [];
    for (const turn of raw) {
        if (clean.length === 0) {
            clean.push(turn);
        } else {
            const last = clean[clean.length - 1];
            if (last.role === turn.role) {
                last.parts = last.parts.concat(turn.parts);
            } else {
                clean.push(turn);
            }
        }
    }

    // Must end with 'user'
    while (clean.length > 0 && clean[clean.length - 1].role !== 'user') {
        clean.pop();
    }

    if (clean.length === 0) {
        clean.push({ role: 'user', parts: validCurrent.length > 0 ? validCurrent : [{ text: 'Hello' }] });
    }

    return clean;
}

function getGeminiApiKeys() {
    let currentConfig = config;
    try {
        if (fs.existsSync(configPath)) {
            currentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
    } catch (_) {}

    const raw = process.env.GEMINI_API_KEY || currentConfig.gemini_api_key || config.gemini_api_key || '';
    if (!raw) return [];
    return raw.split(',').map(k => k.trim()).filter(Boolean);
}

let geminiKeyIndex = 0;

// AI Customer Support Assistant Helper
async function generateAiSupportReply(userMessage, senderPhone, imageBase64 = null, mimeType = 'image/jpeg') {
    let knowledge = {};
    try {
        const kPath = path.join(__dirname, 'ai_knowledge.json');
        if (fs.existsSync(kPath)) {
            knowledge = JSON.parse(fs.readFileSync(kPath, 'utf8'));
        }
    } catch (_) {}

    let currentConfig = config;
    try {
        if (fs.existsSync(configPath)) {
            currentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
    } catch (_) {}

    const apiKeys = getGeminiApiKeys();
    const primaryModel = process.env.GEMINI_MODEL || currentConfig.ai_model || config.ai_model || 'gemini-3.5-flash';
    const secondaryModel = (primaryModel === 'gemini-3.5-flash') ? 'gemini-3.5-flash-lite' : 'gemini-3.5-flash';
    const tertiaryModel = 'gemini-3.8-flash';

    const mem = getChatMemory(senderPhone);

    if (apiKeys.length === 0) {
        const fallback = getSmartFallbackReply(userMessage, !!imageBase64, senderPhone);
        mem.history.push({ role: 'user', parts: [{ text: userMessage || '[ছবি]' }] });
        mem.history.push({ role: 'model', parts: [{ text: fallback }] });
        mem.greeted = true;
        return fallback;
    }

    const platformName = knowledge.platform_name || knowledge.business_or_person_name || 'আমাদের প্ল্যাটফর্ম';

    const systemPrompt = `You are a real human customer support admin for ${platformName} on WhatsApp in Bangladesh. You are an actual Bangladeshi guy chatting naturally with users.

ABSOLUTE HUMAN RULES (NEVER BREAK THESE):
1. NEVER speak like an AI, a chatbot, or a corporate robot!
2. NEVER say "${platformName} সাপোর্ট টিমে আপনাকে স্বাগতম", "কীভাবে সাহায্য করতে পারি?", "আমাদের সাপোর্ট টিমে নক করুন" (YOU ARE THE SUPPORT ADMIN!).
3. NEVER repeat Salam in an active ongoing chat! If you already exchanged Salam or if it's mid-conversation, DO NOT say Salam again! Only say "ওয়ালাইকুম আসসালাম" if the user explicitly says Salam in this current message.
4. Keep replies short, natural, friendly, and straight to the point (1 to 2 lines maximum) just like a real person typing on WhatsApp.
5. Answer casual remarks & identity naturally:
   - "kmn aso" -> "আলহামদুলিল্লাহ ভাই ভালো, আপনার কী খবর?"
   - "ki koro" -> "এই তো ভাই সাপোর্ট চ্যাটে আছি। কোনো হেল্প লাগবে?"
   - "sure to?" -> "হ্যাঁ ভাই একদম সিওর! বলেন কী লাগবে?"
   - Identity ("tmi k?", "tumi ke?", "tmr porichoy ki?", "কে আপনি?"):
     Directly answer: "আমি ${platformName}-এর অফিসিয়াল সাপোর্ট অ্যাডমিন ভাই! কোনো হেল্প বা তথ্য লাগলে বলেন।"
   - Gamer banter & slang ("Hur hla", "hala", "kire", "bhai"):
     Answer chill & friendly: "আরে ভাই কি হইছে? কোনো সমস্যা নাকি?"
6. Provide exact links & guides directly from the Platform Knowledge Base whenever asked.
7. Screenshots & Images:
   - If user sends a screenshot or image, inspect what they are showing.
   - Tell them the exact next step directly like a helpful brother so they can easily complete it.

Platform Knowledge Base:
${JSON.stringify(knowledge, null, 2)}`;

    const currentParts = [];
    if (imageBase64) {
        currentParts.push({
            inlineData: {
                mimeType: mimeType || 'image/jpeg',
                data: imageBase64
            }
        });
    }
    currentParts.push({
        text: userMessage || 'এই স্ক্রিনশট বা ছবিটি দেখে আমাকে সাহায্য করুন ভাই।'
    });

    // Sanitized multi-turn conversation contents
    const historySlice = mem.history.slice(-8);
    const contents = formatGeminiContents(historySlice, currentParts);

    const data = JSON.stringify({
        systemInstruction: {
            parts: [{ text: systemPrompt }]
        },
        contents
    });

    let cleanReply = null;

    // Round-Robin Key Rotation order
    const keysToTry = [];
    const totalKeys = apiKeys.length;
    for (let i = 0; i < totalKeys; i++) {
        keysToTry.push(apiKeys[(geminiKeyIndex + i) % totalKeys]);
    }
    geminiKeyIndex = (geminiKeyIndex + 1) % totalKeys;

    // Try each key in the pool with automatic failover
    for (let kIdx = 0; kIdx < keysToTry.length; kIdx++) {
        const apiKey = keysToTry[kIdx];
        const keyTag = `Key ${kIdx + 1}/${totalKeys}`;

        // 1. Try Primary Model (8s timeout)
        try {
            cleanReply = await requestGeminiApi(primaryModel, data, apiKey, 8000);
            if (cleanReply) break;
        } catch (primaryErr) {
            console.warn(`⚠️ [GEMINI ${keyTag} BUSY (${primaryModel})] ${primaryErr.message}`);

            // If rate limit (429 / RESOURCE_EXHAUSTED / quota) and other keys are available, jump to next key immediately
            if (keysToTry.length > 1 && (primaryErr.message.includes('429') || primaryErr.message.includes('RESOURCE_EXHAUSTED') || primaryErr.message.includes('quota'))) {
                console.warn(`🔄 [AUTO KEY FAILOVER] Switching to next API key in pool...`);
                continue;
            }

            // 2. Try Secondary Model on this key (6s timeout)
            try {
                cleanReply = await requestGeminiApi(secondaryModel, data, apiKey, 6000);
                if (cleanReply) break;
            } catch (backupErr) {
                if (keysToTry.length > 1) {
                    continue;
                }
                // 3. Try Tertiary Model (5s timeout)
                try {
                    cleanReply = await requestGeminiApi(tertiaryModel, data, apiKey, 5000);
                    if (cleanReply) break;
                } catch (tertErr) {
                    console.warn(`⚠️ [GEMINI TERTIARY ERROR (${tertiaryModel})] ${tertErr.message}`);
                }
            }
        }
    }

    if (cleanReply) {
        mem.history.push({ role: 'user', parts: [{ text: userMessage || '[ছবি]' }] });
        mem.history.push({ role: 'model', parts: [{ text: cleanReply }] });
        mem.greeted = true;
        if (mem.history.length > 12) {
            mem.history = mem.history.slice(-10);
        }
        return cleanReply;
    }

    const fallback = getSmartFallbackReply(userMessage, !!imageBase64, senderPhone);
    mem.history.push({ role: 'user', parts: [{ text: userMessage || '[ছবি]' }] });
    mem.history.push({ role: 'model', parts: [{ text: fallback }] });
    mem.greeted = true;
    return fallback;
}

// Per-sender promise queue to strictly serialize rapid burst messages from the same user
// Prevents concurrent requests colliding on Gemini free tier quota (HTTP 429) and race conditions in chat memory.
const senderQueues = {};

function queueMessageForSender(senderPhone, fn) {
    if (!senderQueues[senderPhone]) {
        senderQueues[senderPhone] = Promise.resolve();
    }
    const nextPromise = senderQueues[senderPhone]
        .then(() => fn())
        .catch(err => {
            console.error(`❌ [QUEUE ERROR for ${senderPhone}]:`, err.message);
        });
    senderQueues[senderPhone] = nextPromise;
    nextPromise.finally(() => {
        if (senderQueues[senderPhone] === nextPromise) {
            delete senderQueues[senderPhone];
        }
    });
    return nextPromise;
}

async function startWhatsAppBot() {
    const sessionDir = path.join(__dirname, 'auth_session');
    restoreSessionFromEnv();
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version, isLatest } = await fetchLatestBaileysVersion();

    const activeKeys = getGeminiApiKeys();
    console.log(`\n======================================================`);
    console.log(`🤖 WhatsApp AI Customer Support Bot starting...`);
    console.log(`🔑 [AI KEY POOL] Active Gemini API Key(s): ${activeKeys.length}`);
    console.log(`📦 Using Baileys version: ${version.join('.')}, isLatest: ${isLatest}`);
    console.log(`🌐 Live Bot Portal & QR Page: http://localhost:3000`);
    console.log(`======================================================\n`);

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome')
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            currentQr = qr;
            isConnected = false;
            try {
                currentQrDataUrl = await QRCode.toDataURL(qr, { margin: 2, scale: 8 });
            } catch (err) {
                console.error('[QR ERROR]', err.message);
            }
            console.log('\n📱 [QR CODE GENERATED] Please scan with WhatsApp or open web portal /qr:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            isConnected = false;
            const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
            console.log(`\n⚠️ Connection closed: ${lastDisconnect?.error?.message || 'Unknown'}. Reconnecting: ${shouldReconnect}`);
            if (shouldReconnect) {
                setTimeout(startWhatsAppBot, 3000);
            }
        } else if (connection === 'open') {
            isConnected = true;
            currentQr = null;
            currentQrDataUrl = null;
            currentPairingCode = null;
            const sk = getSessionKeyString();
            console.log('\n✅ [WHATSAPP CONNECTED] Bot is active & listening 24/7!\n');
            if (sk) {
                console.log(`🔑 [PERMANENT SESSION KEY]: ${sk}\n`);
            }
        }
    });

    async function processSingleMessage(msg) {
        if (!msg || !msg.message || msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') return;

        const senderJid = msg.key.remoteJid;
        const senderPhone = senderJid.replace(/@.*$/, '');

        const imgMessage = msg.message.imageMessage ||
            msg.message.viewOnceMessage?.message?.imageMessage ||
            msg.message.viewOnceMessageV2?.message?.imageMessage ||
            msg.message.ephemeralMessage?.message?.imageMessage;

        const docImageMessage = (msg.message.documentMessage?.mimetype?.startsWith('image/'))
            ? msg.message.documentMessage
            : null;

        const effectiveImg = imgMessage || docImageMessage;

        const text = (
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            effectiveImg?.caption ||
            ''
        ).trim();

        let imageBase64 = null;
        let imageMime = effectiveImg?.mimetype || 'image/jpeg';

        if (effectiveImg) {
            try {
                const buffer = await downloadMediaMessage(
                    msg,
                    'buffer',
                    {},
                    { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
                );
                if (buffer && buffer.length > 0) {
                    imageBase64 = buffer.toString('base64');
                    console.log(`📸 [IMAGE RECEIVED & DOWNLOADED] From: ${senderPhone} | Size: ${(buffer.length / 1024).toFixed(1)} KB`);
                }
            } catch (mediaErr) {
                console.error(`⚠️ [MEDIA DOWNLOAD ERROR] ${mediaErr.message}`);
            }
        }

        if (!text && !imageBase64) return;

        // General conversation, greetings & queries handled by AI Support Agent
        console.log(`💬 [MESSAGE RECEIVED] From: ${senderPhone} | Text: "${text}" | HasImage: ${!!imageBase64}`);
        try {
            // Instantly notify user with typing presence so they know bot is online & responding
            sock.sendPresenceUpdate('composing', senderJid).catch(() => {});
            const aiReply = await generateAiSupportReply(text, senderPhone, imageBase64, imageMime);
            await sock.sendMessage(senderJid, { text: aiReply });
            console.log(`🤖 [AI SUPPORT REPLIED] To: ${senderPhone}`);
        } catch (aiErr) {
            console.error(`❌ [AI SUPPORT ERROR] ${aiErr.message}`);
            await sock.sendMessage(senderJid, {
                text: `স্বাগতম ভাই!\nকীভাবে সাহায্য করতে পারি বলুন।`
            });
        } finally {
            sock.sendPresenceUpdate('paused', senderJid).catch(() => {});
        }
    }

    // Listen to incoming messages (handles multiple users simultaneously and queues bursts per user)
    sock.ev.on('messages.upsert', async ({ messages }) => {
        if (!messages || messages.length === 0) return;
        for (const msg of messages) {
            if (!msg || !msg.message || msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') continue;
            const senderPhone = (msg.key.remoteJid || '').replace(/@.*$/, '');
            queueMessageForSender(senderPhone, () => processSingleMessage(msg));
        }
    });
}

// -------------------------------------------------------------
// Built-in Live Simulation Web Server (Port 3000)
// -------------------------------------------------------------
const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);

    // API: Bot Connection Status & Live QR
    if (parsedUrl.pathname === '/api/bot-status' && req.method === 'GET') {
        const sessionKey = getSessionKeyString();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            connected: isConnected,
            hasQr: !!currentQrDataUrl,
            qrImage: currentQrDataUrl || null,
            pairingCode: currentPairingCode,
            sessionKey: isConnected ? sessionKey : null,
            botPhone: config.bot_phone_number
        }));
        return;
    }

    // API: Logout / Reset Session (Change Number)
    if (parsedUrl.pathname === '/api/bot-logout' && req.method === 'POST') {
        try {
            console.log('🔄 [LOGOUT REQUESTED] Clearing WhatsApp session for new number link...');
            if (sock) {
                try { await sock.logout(); } catch (_) { try { sock.end(); } catch (__) {} }
            }
            isConnected = false;
            currentQr = null;
            currentQrDataUrl = null;
            currentPairingCode = null;

            const sessionDir = path.join(__dirname, 'auth_session');
            if (fs.existsSync(sessionDir)) {
                fs.rmSync(sessionDir, { recursive: true, force: true });
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Logged out. New QR code generating...' }));

            setTimeout(() => {
                startWhatsAppBot();
            }, 1500);
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: err.message }));
        }
        return;
    }

    // API: Request Pairing Code (Alternative to camera QR scan)
    if (parsedUrl.pathname === '/api/request-pairing' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const data = JSON.parse(body || '{}');
                let phone = (data.phone || config.bot_phone_number || '').replace(/\D/g, '');
                if (!phone.startsWith('88') && phone.startsWith('01')) {
                    phone = '88' + phone;
                }
                if (sock && !isConnected) {
                    const code = await sock.requestPairingCode(phone);
                    currentPairingCode = code;
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, pairingCode: code }));
                } else {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        success: false,
                        message: isConnected ? 'WhatsApp is already connected!' : 'Bot socket not ready yet. Please wait a few seconds.'
                    }));
                }
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: err.message }));
            }
        });
        return;
    }

    // Dedicated QR Code & Pairing Web Interface
    if (parsedUrl.pathname === '/qr') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html>
<html lang="bn">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WhatsApp Bot Link & Pairing</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700;800;900&family=JetBrains+Mono:wght@700&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: radial-gradient(circle at 50% 0%, #0f172a 0%, #020617 100%);
      font-family: 'Outfit', sans-serif;
      color: #f8fafc;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      background: rgba(15, 23, 42, 0.9);
      border: 1px solid rgba(255, 255, 255, 0.1);
      backdrop-filter: blur(16px);
      width: 100%;
      max-width: 480px;
      border-radius: 24px;
      padding: 32px 24px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7);
      text-align: center;
    }
    h1 { font-size: 1.5rem; font-weight: 800; margin-bottom: 8px; }
    p.sub { color: #94a3b8; font-size: 0.9rem; margin-bottom: 20px; line-height: 1.4; }
    .qr-container {
      background: #ffffff;
      padding: 16px;
      border-radius: 16px;
      display: inline-block;
      margin: 10px 0 16px 0;
      box-shadow: 0 8px 30px rgba(0,0,0,0.4);
    }
    .qr-container img {
      width: 240px;
      height: 240px;
      display: block;
    }
    .instructions {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 12px;
      padding: 14px;
      text-align: left;
      font-size: 0.85rem;
      color: #cbd5e1;
      margin-top: 14px;
      line-height: 1.6;
    }
    .instructions ol { padding-left: 20px; }
    .instructions li { margin-bottom: 4px; }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 14px;
      border-radius: 999px;
      font-size: 0.82rem;
      font-weight: 700;
      margin-bottom: 14px;
    }
    .badge.waiting { background: rgba(234, 179, 8, 0.15); border: 1px solid rgba(234, 179, 8, 0.4); color: #facc15; }
    .badge.connected { background: rgba(34, 197, 94, 0.15); border: 1px solid rgba(34, 197, 94, 0.4); color: #4ade80; }
    .btn-action {
      width: 100%;
      padding: 13px;
      background: linear-gradient(135deg, #2563eb, #1d4ed8);
      color: #fff;
      border: none;
      border-radius: 12px;
      font-size: 0.95rem;
      font-weight: 700;
      cursor: pointer;
      margin-top: 12px;
      transition: opacity 0.15s;
    }
    .btn-action:hover { opacity: 0.9; }
    .pairing-box {
      background: rgba(37, 99, 235, 0.1);
      border: 1px dashed #3b82f6;
      border-radius: 12px;
      padding: 14px;
      margin-top: 14px;
    }
    .pairing-code {
      font-family: 'JetBrains Mono', monospace;
      font-size: 1.8rem;
      font-weight: 900;
      letter-spacing: 4px;
      color: #60a5fa;
      margin-top: 6px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div id="statusBadge" class="badge waiting">
      <span>●</span> অপেক্ষমাণ: ডিভাইস লিংক করুন
    </div>

    <!-- CONNECTED SCREEN -->
    <div id="viewConnected" style="display: none;">
      <div style="font-size: 3rem; margin-bottom: 10px;">✅</div>
      <h1 style="color: #4ade80;">WhatsApp বট সংযুক্ত!</h1>
      <p class="sub">বট এখন ২৪/৭ চালু আছে এবং AI কাস্টমার সাপোর্ট চ্যাট হ্যান্ডেল করতে প্রস্তুত।</p>
      <div class="instructions" style="text-align: center; margin-bottom: 16px;">
        📱 <b>বট নম্বর:</b> <span style="color: #38bdf8; font-weight: 800;">${config.bot_phone_number}</span><br>
        🚀 <b>সার্ভার স্ট্যাটাস:</b> ONLINE & 24/7 ACTIVE
      </div>

      <a href="https://wa.me/${(config.bot_phone_number || '').replace(/\D/g, '')}" target="_blank" style="display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; padding: 13px; background: #25d366; color: #064e3b; text-decoration: none; border-radius: 12px; font-size: 0.95rem; font-weight: 800; margin-bottom: 16px; box-shadow: 0 4px 15px rgba(37, 211, 102, 0.4);">
        <span>💬</span> WhatsApp-এ সরাসরি চ্যাট করুন
      </a>

      <!-- PERMANENT AUTO-LOGIN KEY BOX -->
      <div style="background: rgba(34, 197, 94, 0.08); border: 1.5px dashed #22c55e; border-radius: 14px; padding: 16px; text-align: left; margin-bottom: 16px;">
        <div style="font-size: 0.85rem; color: #4ade80; font-weight: 800; display: flex; align-items: center; gap: 6px; margin-bottom: 6px;">
          <span>🔑</span> পার্মানেন্ট অটো-লগইন কি (Permanent Session Key)
        </div>
        <div style="font-size: 0.78rem; color: #94a3b8; line-height: 1.45; margin-bottom: 10px;">
          সার্ভার রিস্টার্ট হলেও যেন আর কখনো স্ক্যান না করতে হয়, তার জন্য নিচের কি-টি কপি করে Render-এর Environment-এ <b>WHATSAPP_SESSION_DATA</b> নামে বসিয়ে দিন।
        </div>
        <div style="display: flex; gap: 8px;">
          <input type="text" id="sessionKeyBox" readonly style="flex: 1; background: #020617; border: 1px solid #334155; color: #38bdf8; font-family: monospace; font-size: 0.82rem; padding: 10px 12px; border-radius: 8px; outline: none;">
          <button onclick="copySessionKey()" id="btnCopyKey" style="background: #22c55e; color: #052e16; font-weight: 800; font-size: 0.85rem; border: none; padding: 10px 16px; border-radius: 8px; cursor: pointer;">কপি 📋</button>
        </div>
        <div id="copyAlert" style="display: none; color: #4ade80; font-size: 0.8rem; font-weight: 700; margin-top: 6px;">✓ Session Key কপি করা হয়েছে!</div>
      </div>

      <!-- CHANGE NUMBER / LOGOUT BUTTON -->
      <button onclick="changeNumberLogout()" id="btnLogout" style="width: 100%; padding: 12px; background: rgba(239, 68, 68, 0.12); border: 1.5px solid rgba(239, 68, 68, 0.4); color: #f87171; border-radius: 12px; font-size: 0.9rem; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px;">
        <span>🔄</span> নম্বর পরিবর্তন করুন (Change WhatsApp Number / Logout)
      </button>
    </div>

    <!-- NOT CONNECTED SCREEN -->
    <div id="viewScan">
      <h1>WhatsApp কানেক্ট করুন</h1>
      <p class="sub">আপনার <b>${config.bot_phone_number}</b> নম্বরের ফোন দিয়ে নিচের QR কোডটি স্ক্যান করুন:</p>

      <div class="qr-container">
        <img id="qrImage" src="" alt="WhatsApp QR Code">
      </div>

      <div class="instructions">
        <ol>
          <li>আপনার ফোনে WhatsApp ওপেন করুন।</li>
          <li>উপরের ৩টি ডট বা <b>Settings</b>-এ যান।</li>
          <li><b>Linked Devices</b> (লিংক করা ডিভাইস)-এ চাপ দিন।</li>
          <li><b>Link a Device</b> চাপ দিয়ে উপরের QR কোডটি স্ক্যান করুন।</li>
        </ol>
      </div>

      <div class="pairing-box">
        <div style="font-size: 0.85rem; color: #94a3b8; font-weight: 600;">অথবা ক্যামেরা স্ক্যান ছাড়া কোড দিয়ে লিংক করুন:</div>
        <button class="btn-action" onclick="getPairingCode()" id="btnPair">Pairing Code তৈরি করুন 🔑</button>
        <div id="pairingCodeDisplay" class="pairing-code" style="display: none;">------</div>
        <div id="pairingHelp" style="display: none; font-size: 0.78rem; color: #94a3b8; margin-top: 6px;">
          ফোনে "Link with phone number instead" সিলেক্ট করে এই কোডটি লিখুন।
        </div>
      </div>
    </div>
  </div>

  <script>
    async function checkStatus() {
      try {
        const res = await fetch('/api/bot-status');
        const data = await res.json();
        if (data.connected) {
          document.getElementById('viewScan').style.display = 'none';
          document.getElementById('viewConnected').style.display = 'block';
          const b = document.getElementById('statusBadge');
          b.className = 'badge connected';
          b.innerHTML = '● WhatsApp কানেক্টেড';
          if (data.sessionKey) {
            document.getElementById('sessionKeyBox').value = data.sessionKey;
          }
        } else {
          document.getElementById('viewScan').style.display = 'block';
          document.getElementById('viewConnected').style.display = 'none';
          if (data.qrImage) {
            document.getElementById('qrImage').src = data.qrImage;
          }
          if (data.pairingCode) {
            document.getElementById('pairingCodeDisplay').innerText = data.pairingCode;
            document.getElementById('pairingCodeDisplay').style.display = 'block';
            document.getElementById('pairingHelp').style.display = 'block';
          }
        }
      } catch (e) {
        console.error(e);
      }
    }

    function copySessionKey() {
      const box = document.getElementById('sessionKeyBox');
      box.select();
      navigator.clipboard.writeText(box.value).then(() => {
        document.getElementById('copyAlert').style.display = 'block';
        setTimeout(() => { document.getElementById('copyAlert').style.display = 'none'; }, 3000);
      });
    }

    async function changeNumberLogout() {
      if (!confirm('আপনি কি নিশ্চিত যে বর্তমান WhatsApp নম্বরটি ডিসকানেক্ট করে নতুন নম্বর দিয়ে স্ক্যান করতে চান?')) return;
      const btn = document.getElementById('btnLogout');
      btn.innerText = 'লগআউট হচ্ছে...';
      btn.disabled = true;
      try {
        const res = await fetch('/api/bot-logout', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          alert('সেশন ক্লিয়ার হয়েছে! এখন নতুন নম্বর দিয়ে স্ক্যান করতে পারবেন।');
          location.reload();
        } else {
          alert('এরর: ' + data.message);
          btn.innerText = '🔄 নম্বর পরিবর্তন করুন (Change WhatsApp Number / Logout)';
          btn.disabled = false;
        }
      } catch (e) {
        alert('সার্ভার এরর: ' + e.message);
        btn.innerText = '🔄 নম্বর পরিবর্তন করুন (Change WhatsApp Number / Logout)';
        btn.disabled = false;
      }
    }

    async function getPairingCode() {
      const btn = document.getElementById('btnPair');
      btn.innerText = 'কোড তৈরি হচ্ছে...';
      btn.disabled = true;
      try {
        const res = await fetch('/api/request-pairing', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: '${config.bot_phone_number}' })
        });
        const data = await res.json();
        if (data.success) {
          document.getElementById('pairingCodeDisplay').innerText = data.pairingCode;
          document.getElementById('pairingCodeDisplay').style.display = 'block';
          document.getElementById('pairingHelp').style.display = 'block';
          btn.innerText = 'নতুন কোড পান 🔄';
          btn.disabled = false;
        } else {
          alert(data.message || 'Error');
          btn.innerText = 'Pairing Code তৈরি করুন 🔑';
          btn.disabled = false;
        }
      } catch (err) {
        alert('এরর: ' + err.message);
        btn.innerText = 'Pairing Code তৈরি করুন 🔑';
        btn.disabled = false;
      }
    }

    checkStatus();
    setInterval(checkStatus, 2500);
  </script>
</body>
</html>`);
        return;
    }

    // Serve HTML Web Interface: redirect to /qr
    if (parsedUrl.pathname === '/' || parsedUrl.pathname === '/index.html') {
        res.writeHead(302, { 'Location': '/qr' });
        res.end();
        return;
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 [AI BOT DASHBOARD READY] Open in browser: http://localhost:${PORT}`);
    console.log(`🔗 [QR LINK & PAIRING PAGE]: http://localhost:${PORT}/qr`);
});

startWhatsAppBot();
