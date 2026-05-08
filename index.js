const { Client, WebhookClient, MessageEmbed } = require('discord.js-selfbot-v13');
const { createClient } = require('@supabase/supabase-js');
const http = require('http');
const WebSocket = require('ws');

const TOKEN = process.env.TOKEN; 
const WEBHOOK_URL = 'https://discord.com/api/webhooks/1501843778955378698/jL4VE6ryXXU2ElBIo6ohhk48sHiB3QlPIWnU2vzrUf2GulgkK9_ex7uOjyXNEC2wZCGH'; 
const SUPABASE_URL = 'https://vsmyfpdysryespiwzqds.supabase.co'; 
const SUPABASE_KEY = 'sb_secret_l6f6Hlv-SHQ1XOp3MpRGMw_KNTXcV6k'; 

const SOURCE_CHANNEL_ID = '1009860471328874617';

if (!TOKEN) {
    console.error("ошибка токена");
    process.exit(1);
}
if (WEBHOOK_URL === 'ТВОЙ_ВЕБХУК_URL') {
    console.error("ошибка ключей бд");
    process.exit(1);
}

const ACCENT_COLOR = '#2B2D31';
const client = new Client();
const webhook = new WebhookClient({ url: WEBHOOK_URL });

// Подключение Supabase с поддержкой WebSocket 
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { 
    auth: { persistSession: false },
    realtime: { transport: WebSocket } 
});

const activeTimers = new Map();
const processedIssues = new Set();
const processedRemovals = new Set();

// --- МИНИ ВЕБ-СЕРВЕР 
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Creativeban  is online!\n');
}).listen(PORT, () => console.log(` Веб-сервер запущен на порту ${PORT}`));

function parseDurationToMs(durationStr) {
    const match = durationStr.match(/(\d+)\s*(д|ч|м|с)/i);
    if (!match) return 0;
    const value = parseInt(match[1] || '0', 10);
    const unit = (match[2] || '').toLowerCase();

    if (unit === 'д') return value * 24 * 60 * 60 * 1000;
    if (unit === 'ч') return value * 60 * 60 * 1000;
    if (unit === 'м') return value * 60 * 1000;
    if (unit === 'с') return value * 1000;
    return 0;
}

function formatDate(date) {
    const mskString = date.toLocaleString('en-US', { timeZone: 'Europe/Moscow' });
    const mskDate = new Date(mskString);

    const pad = (n) => n.toString().padStart(2, '0');
    return `${pad(mskDate.getDate())}.${pad(mskDate.getMonth() + 1)}.${mskDate.getFullYear()}, ${pad(mskDate.getHours())}:${pad(mskDate.getMinutes())}`;
}
function extractIdFromMention(mention) {
    const match = mention.match(/<@!?(\d+)>/);
    return match ? (match[1] || mention) : mention;
}

async function getModeratorAvatar(moderatorMention) {
    const modId = extractIdFromMention(moderatorMention);
    try {
        const user = await client.users.fetch(modId);
        if (user) return user.displayAvatarURL({ format: 'png', size: 256 });
    } catch (e) { }
    return null;
}

async function sendStyledEmbed(title, lines, moderatorMention, avatarUrl) {
    const embed = new MessageEmbed()
        .setColor(ACCENT_COLOR)
        .setDescription(`**${title}**\n\n${lines.join('\n')}\n\n*Ответственный: ${moderatorMention}*`);
    if (avatarUrl) embed.setThumbnail(avatarUrl);
    await webhook.send({ embeds: [embed] }).catch(console.error);
}

//  СБРОС ТАЙМЕРОВ (АВТО-РАЗБАН) ---
async function scheduleUnban(banData) {
    const targetId = banData.target_id;
    const endDate = new Date(banData.end_date);
    const timeRemaining = endDate.getTime() - Date.now();

    if (activeTimers.has(targetId)) clearTimeout(activeTimers.get(targetId));

    if (timeRemaining <= 0) {
        await executeUnban(banData);
    } else {
        const timeoutId = setTimeout(async () => {
            await executeUnban(banData);
        }, timeRemaining);
        activeTimers.set(targetId, timeoutId);
    }
}

async function executeUnban(banData) {
    const resetLines = [
        `Пользователь: ${banData.target_name}`,
        `Причина выдачи бана: \`\`${banData.reason}\`\``,
        `Продолжительность: \`\`${banData.duration_str}\`\``,
        `Начало: \`\`${formatDate(new Date(banData.start_date))}\`\``,
        `Конец: \`\`${formatDate(new Date(banData.end_date))}\`\``
    ];
    await sendStyledEmbed('Сброс Creativeban', resetLines, banData.moderator, banData.avatar_url);
    
    await supabase.from('active_bans').delete().eq('target_id', banData.target_id);
    activeTimers.delete(banData.target_id);
    console.log(`[АВТО-СБРОС] Снят бан с ${banData.target_name}`);
}

async function loadBansOnStartup() {
    const { data: bans, error } = await supabase.from('active_bans').select('*');
    if (error) {
        console.error("Ошибка загрузки банов из БД:", error);
        return;
    }
    
    console.log(`Загружено активных банов из базы: ${bans.length}`);
    for (const ban of bans) {
        scheduleUnban(ban); 
    }
}

// --- ОБРАБОТКА СООБЩЕНИЙ ---
async function handleBanMessage(message) {
    if (message.channelId !== SOURCE_CHANNEL_ID) return;
    if (!message.embeds || message.embeds.length === 0) return;

    const embed = message.embeds[0];
    const description = embed.description || '';
    let title = embed.title || embed.author?.name || description || '';

    if (processedIssues.size > 1000) processedIssues.clear();
    if (processedRemovals.size > 1000) processedRemovals.clear();

    // 1. ВЫДАЧА БАНА
    if (title.includes('Выдать отстранение') || title.includes('Выдача Creativeban') || description.includes('было выдано отстранение')) {
        if (processedIssues.has(message.id)) return;

        const targetMatch = description.match(/(?:Пользователю|Пользователь)[^<]*(<@!?\d+>)/i);
        const reasonMatch = description.match(/Причина[\s*:]*(.+)/i);
        const durationMatch = description.match(/(?:Длительность|Продолжительность)[\s*:]*(.+)/i);
        const moderatorMatch = description.match(/Ответственный[\s*:]*(<@!?\d+>)/i);

        if (targetMatch && reasonMatch && durationMatch && moderatorMatch) {
            const target = (targetMatch[1] || '').trim();
            const reason = (reasonMatch[1] || '').replace(/[*`]/g, '').trim();
            const durationStr = (durationMatch[1] || '').replace(/[*`]/g, '').trim();
            const moderator = (moderatorMatch[1] || '').trim();
            const targetId = extractIdFromMention(target);

            processedIssues.add(message.id);
            const avatarUrl = await getModeratorAvatar(moderator);
            console.log(`[ЗАПИСЬ] Выдача бана: Кому: ${target} | Креатив: ${moderator} | Срок: ${durationStr}`);

            const durationMs = parseDurationToMs(durationStr);
            const startDate = new Date();
            const endDate = new Date(startDate.getTime() + durationMs);

            const banData = {
                target_id: targetId,
                target_name: target,
                moderator: moderator,
                reason: reason,
                duration_str: durationStr,
                start_date: startDate.toISOString(),
                end_date: endDate.toISOString(),
                avatar_url: avatarUrl
            };

            await supabase.from('active_bans').upsert(banData);
            scheduleUnban(banData);

            const issueLines = [
                `Пользователь: ${target}`,
                `Причина: \`\`${reason}\`\``,
                `Продолжительность: \`\`${durationStr}\`\``,
                `Начало: \`\`${formatDate(startDate)}\`\``,
                `Конец: \`\`${formatDate(endDate)}\`\``
            ];
            await sendStyledEmbed('Выдача Creativeban', issueLines, moderator, avatarUrl);
        }
    }

    // 2. РУЧНОЕ СНЯТИЕ БАНА
    else if (title.includes('Снять отстранение') || title.includes('Снятие Creativeban') || description.includes('было снято отстранение')) {
        if (processedRemovals.has(message.id)) return;

        const targetMatch = description.match(/(?:Пользователю|Пользователь)[^<]*(<@!?\d+>)/i);
        const moderatorMatch = description.match(/Ответственный[\s*:]*(<@!?\d+>)/i);
        const removeReasonMatch = description.match(/(?:Причина снятия бана|Причина)[\s*:]*(.+)/i);

        if (targetMatch && moderatorMatch && removeReasonMatch) {
            const target = (targetMatch[1] || '').trim();
            const moderator = (moderatorMatch[1] || '').trim();
            const removeReason = (removeReasonMatch[1] || '').replace(/[*`]/g, '').trim();
            const targetId = extractIdFromMention(target);

            processedRemovals.add(message.id);
            const avatarUrl = await getModeratorAvatar(moderator);
            console.log(`[РУЧНОЕ СНЯТИЕ] Снят бан с ${target}`);

            const { data: dbBan } = await supabase.from('active_bans').select('*').eq('target_id', targetId).single();
            
            const originalReason = dbBan ? dbBan.reason : 'Неизвестно (выдано давно)';
            const durationStr = dbBan ? dbBan.duration_str : 'Неизвестно';
            const startDateStr = dbBan ? formatDate(new Date(dbBan.start_date)) : 'Неизвестно';
            const endDateStr = dbBan ? formatDate(new Date(dbBan.end_date)) : 'Неизвестно';

            if (activeTimers.has(targetId)) {
                clearTimeout(activeTimers.get(targetId));
                activeTimers.delete(targetId);
            }
            await supabase.from('active_bans').delete().eq('target_id', targetId);

            const removeLines = [
                `Пользователь: ${target}`,
                `Причина выдачи бана: \`\`${originalReason}\`\``,
                `Продолжительность: \`\`${durationStr}\`\``,
                `Начало: \`\`${startDateStr}\`\``,
                `Конец: \`\`${endDateStr}\`\``,
                '',
                `Причина снятия бана: \`\`${removeReason}\`\``
            ];
            await sendStyledEmbed('Снятие Creativeban', removeLines, moderator, avatarUrl);
        }
    }
}

client.on('ready', async () => {
    console.log(`Селф-бот запущен (${client.user?.tag}).`);
    await loadBansOnStartup(); 
});

client.on('messageCreate', async (message) => await handleBanMessage(message));
client.on('messageUpdate', async (_, newMessage) => await handleBanMessage(newMessage));

client.login(TOKEN);
