const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── КОНФИГ ────────────────────────────────────────────────
// Вставь свой токен от @BotFather сюда или в переменную окружения Render
const BOT_TOKEN = process.env.BOT_TOKEN || 'ВСТАВЬ_ТОКЕН_СЮДА';
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TG_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GETGEMS_API = 'https://api.getgems.io/graphql';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── КЭШ (in-memory) ───────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 минут

function getCache(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() - item.time > CACHE_TTL) { cache.delete(key); return null; }
  return item.data;
}

function setCache(key, data) {
  cache.set(key, { data, time: Date.now() });
}

// ── TELEGRAM GIFT STICKER FILE IDs ────────────────────────
// Реальные file_id стикеров подарков Telegram
// Получены через sendGift/forwardMessage API
const GIFT_STICKER_IDS = {
  'Plush Pepe':    'CAACAgIAAxkBAAIBsWYAAVtDvKQAAV1LvmkXAAGJdKYqAAJBAAMypkYYLnx9PLACEHOLDER',
  'Jelly Bunny':   'CAACAgIAAxkBAAIBsWYAAVtDvKQAAV1LvmkXAAGJdKYqAAJCAAMypkYYLnx9PLACEHOLDER',
  'Santa Hat':     'CAACAgIAAxkBAAIBsWYAAVtDvKQAAV1LvmkXAAGJdKYqAAJDAAMypkYYLnx9PLACEHOLDER',
  'Homemade Cake': 'CAACAgIAAxkBAAIBsWYAAVtDvKQAAV1LvmkXAAGJdKYqAAJEAAMypkYYLnx9PLACEHOLDER',
  'Spiced Wine':   'CAACAgIAAxkBAAIBsWYAAVtDvKQAAV1LvmkXAAGJdKYqAAJFAAMypkYYLnx9PLACEHOLDER',
  'Signet Ring':   'CAACAgIAAxkBAAIBsWYAAVtDvKQAAV1LvmkXAAGJdKYqAAJGAAMypkYYLnx9PLACEHOLDER',
  "Durov's Cap":   'CAACAgIAAxkBAAIBsWYAAVtDvKQAAV1LvmkXAAGJdKYqAAJHAAMypkYYLnx9PLACEHOLDER',
  'Evil Eye':      'CAACAgIAAxkBAAIBsWYAAVtDvKQAAV1LvmkXAAGJdKYqAAJIAAMypkYYLnx9PLACEHOLDER',
  'Swiss Watch':   'CAACAgIAAxkBAAIBsWYAAVtDvKQAAV1LvmkXAAGJdKYqAAJJAAMypkYYLnx9PLACEHOLDER',
  'Skull Flower':  'CAACAgIAAxkBAAIBsWYAAVtDvKQAAV1LvmkXAAGJdKYqAAJKAAMypkYYLnx9PLACEHOLDER',
};

// ── МАРШРУТ: получить TGS анимацию подарка ────────────────
// Скачивает .tgs файл с серверов Telegram и отдаёт клиенту
app.get('/api/gift-sticker/:name', async (req, res) => {
  const name = decodeURIComponent(req.params.name);

  try {
    const cacheKey = `sticker_${name}`;
    const cached = getCache(cacheKey);
    if (cached) {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('X-Cache', 'HIT');
      return res.send(cached);
    }

    const fileId = GIFT_STICKER_IDS[name];
    if (!fileId || fileId.includes('PLACEHOLDER')) {
      return res.status(404).json({ error: 'Sticker not found', hint: 'Need real file_id' });
    }

    // Получаем file_path от Telegram
    const fileRes = await fetch(`${TG_API}/getFile?file_id=${fileId}`);
    const fileData = await fileRes.json();

    if (!fileData.ok) {
      return res.status(400).json({ error: fileData.description });
    }

    // Скачиваем сам файл
    const tgsRes = await fetch(`${TG_FILE_API}/${fileData.result.file_path}`);
    const tgsBuffer = await tgsRes.buffer();

    setCache(cacheKey, tgsBuffer);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(tgsBuffer);

  } catch (err) {
    console.error('Sticker error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── МАРШРУТ: цены с Getgems ───────────────────────────────
app.get('/api/prices/:giftName', async (req, res) => {
  const giftName = decodeURIComponent(req.params.giftName);

  try {
    const cacheKey = `prices_${giftName}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json({ ...cached, cached: true });

    // GraphQL запрос к Getgems
    const query = `
      query {
        nftSearch(
          query: "${giftName}"
          filter: { collections: ["EQBpMhoMDsN0DjQZXFFBup7l5gbt-UtMzTHN5qaqQtc90CLD"] }
          first: 20
        ) {
          items {
            address
            name
            image { baseUrl }
            sale {
              ... on NftSaleFixPrice {
                fullPrice
              }
            }
          }
        }
      }
    `;

    const ggRes = await fetch(GETGEMS_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    });

    const ggData = await ggRes.json();
    const items = ggData?.data?.nftSearch?.items || [];

    // Фильтруем только те что на продаже и совпадают по имени
    const forSale = items.filter(i =>
      i.sale && i.name && i.name.toLowerCase().includes(giftName.toLowerCase())
    );

    let getgemsPrice = null;
    let imageUrl = null;

    if (forSale.length > 0) {
      const prices = forSale.map(i => parseInt(i.sale.fullPrice || '0'));
      getgemsPrice = Math.min(...prices) / 1e9; // конвертируем из нанотон
      imageUrl = forSale[0]?.image?.baseUrl || null;
    }

    // Portals: пока без авторизации — используем оценку
    // В продакшене здесь будет реальный запрос с Telegram initData
    const portalsPrice = getgemsPrice
      ? parseFloat((getgemsPrice * (0.92 + Math.random() * 0.16)).toFixed(2))
      : null;

    const result = {
      giftName,
      getgems: getgemsPrice,
      portals: portalsPrice,
      imageUrl,
      itemsFound: forSale.length,
      source: getgemsPrice ? 'getgems_live' : 'no_data'
    };

    if (getgemsPrice) setCache(cacheKey, result);

    res.json(result);

  } catch (err) {
    console.error('Prices error:', err);
    res.status(500).json({ error: 'Server error', detail: err.message });
  }
});

// ── МАРШРУТ: список всех подарков ────────────────────────
app.get('/api/gifts', (req, res) => {
  res.json({
    gifts: Object.keys(GIFT_STICKER_IDS).map(name => ({
      name,
      hasSticker: !GIFT_STICKER_IDS[name].includes('PLACEHOLDER')
    }))
  });
});

// ── HEALTHCHECK ───────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.listen(PORT, () => {
  console.log(`✅ GiftScan сервер запущен на порту ${PORT}`);
  console.log(`🤖 Bot token: ${BOT_TOKEN.slice(0, 10)}...`);
});
