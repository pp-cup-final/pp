require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const session = require('express-session');
const app = express();
const PORT = process.env.PORT || 3000;
const cron = require("node-cron");
const { createClient } = require('@supabase/supabase-js');

// Папка для истории
const historyDir = path.join(__dirname, "history");
if (!fs.existsSync(historyDir)) {
  fs.mkdirSync(historyDir);
}
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // не public, а service_role
);

// CRON: каждое воскресенье в 00:00 по Москве
cron.schedule("0 0 * * 0", async () => {
  const { data: participants } = await supabase.from("participants").select("*");
  if (participants && participants.length > 0) {
    // Обновляем позиции перед сохранением
    updatePositionsInDB(participants);

    await supabase.from("history").insert([
      { date: new Date().toISOString(), data: participants }
    ]);
    const { error } = await supabase.from("participants").delete().neq('userid', 0);
    if (error) return res.status(500).json({ error: error.message });

    console.log("✅ История сохранена");
  }
}, { timezone: "Europe/Moscow" });


// Роут для истории
app.get('/api/history', async (req, res) => {
  const { data, error } = await supabase.from("history").select("*").order("date", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
app.get("/history", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "history.html"));
});
app.use(express.static('public'));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'some secret here',
  resave: false,
  saveUninitialized: true,
}));


// === osu! API токен ===
let osuAccessToken = null;
let osuTokenExpiry = 0;

const osuClientId = process.env.OSU_CLIENT_ID;
const osuClientSecret = process.env.OSU_CLIENT_SECRET;
const redirectUri = process.env.REDIRECT_URI || 'https://pp-cup-final-pp-b5fb.twc1.net/auth/callback';

async function fetchOsuAccessToken() {
  try {
    const response = await axios.post('https://osu.ppy.sh/oauth/token', {
      client_id: osuClientId,
      client_secret: osuClientSecret,
      grant_type: 'client_credentials',
      scope: 'public',
    });

    osuAccessToken = response.data.access_token;
    osuTokenExpiry = Date.now() + (response.data.expires_in * 1000); // обычно 3600 сек
    console.log('osu! access token обновлен');
  } catch (error) {
    console.error('Ошибка получения токена:', error.response?.data || error.message);
  }
}

async function getOsuAccessToken() {
  if (!osuAccessToken || Date.now() > osuTokenExpiry - 60000) { // обновляем за минуту до истечения
    await fetchOsuAccessToken();
  }
  return osuAccessToken;
}

// === Подсчет очков ===
function calculatePoints(ppStart, ppEnd) {
  const start = Math.floor(ppStart);
  const end = Math.floor(ppEnd);

  if (end <= start) return 0;

  let points = 0;
  const floorStart = Math.floor(start / 1000) * 1000;
  const floorEnd = Math.floor(end / 1000) * 1000;

  for (let thousand = floorStart; thousand <= floorEnd; thousand += 1000) {
    const lower = Math.max(start, thousand);
    const upper = Math.min(end, thousand + 999.999);
    const delta = upper - lower;

    if (delta > 0) {
      const multiplier = thousand / 1000;
      points += delta * multiplier;
    }
  }

  return Math.round(points);
}

async function updatePositionsInDB() {
  // Берём всех участников
  const { data: participants, error: selectErr } = await supabase
    .from('participants')
    .select('*');
  if (selectErr) {
    console.error('Ошибка чтения участников для позиций:', selectErr);
    return [];
  }

  // сортируем по points desc
  participants.sort((a, b) => {
    const pa = parseFloat(a.points) || 0;
    const pb = parseFloat(b.points) || 0;
    return pb - pa;
  });

  // считаем позиции (ровные очки — одинаковая позиция)
  let lastPoints = null;
  let lastPosition = 0;
  const updates = []; // массив промисов обновлений
  for (let i = 0; i < participants.length; i++) {
    const p = participants[i];
    const pPoints = parseFloat(p.points) || 0;

    if (pPoints !== lastPoints) {
      lastPosition = i + 1;
      lastPoints = pPoints;
    }

    // если в БД уже есть такое значение position — можно не обновлять,
    // но для простоты обновим только если отличается
    const currentPos = p.position === null || p.position === undefined ? null : Number(p.position);
    if (currentPos !== lastPosition) {
      updates.push(
        supabase
          .from('participants')
          .update({ position: lastPosition })
          .eq('userid', p.userid)
      );
    }

    // добавим поле для отдачи фронту (совместимость)
    p.Position = lastPosition;
  }

  // выполняем все обновления параллельно
  if (updates.length > 0) {
    const results = await Promise.all(updates);
    for (const r of results) {
      if (r.error) console.error('Ошибка обновления позиции:', r.error);
    }
  }

  return participants;
}

// === Обновление PP участников ===
async function updateParticipantsPP() {
  const { data: participants, error } = await supabase.from("participants").select("*");
  if (error) {
    console.error("Ошибка загрузки участников:", error);
    return;
  }

  for (let participant of participants) {
    try {
      const token = await getOsuAccessToken();
      const res = await axios.get(`https://osu.ppy.sh/api/v2/users/${participant.userid}/osu`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      const currentPP = res.data.statistics.pp;
      const points = calculatePoints(parseFloat(participant.ppstart), parseFloat(currentPP));

      await supabase.from("participants")
        .update({
          ppend: currentPP,
          points: points
        })
        .eq("userid", participant.userid);

    } catch (err) {
      console.error(`Ошибка обновления ${participant.nickname}:`, err.response?.data || err.message);
    }
  }
  console.log("✅ Участники обновлены");
}

// === Автоматический запуск ===
fetchOsuAccessToken().then(() => {
  updateParticipantsPP();
  setInterval(updateParticipantsPP, 5 * 60 * 1000); // каждые 10 минут
});

// === API ===

app.get('/api/data', async (req, res) => {
  const { data, error } = await supabase.from("participants").select("*").order("position", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  updatePositionsInDB(data); // модифицируем массив
  res.json(data);  
});

app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  res.json(req.session.user);
});

// === OAuth: авторизация ===
app.get('/auth/login', (req, res) => {
  const authUrl = `https://osu.ppy.sh/oauth/authorize?client_id=${osuClientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=public`;
  res.redirect(authUrl);
});

app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('No code provided');

  try {
    const tokenResponse = await axios.post('https://osu.ppy.sh/oauth/token', {
      client_id: osuClientId,
      client_secret: osuClientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    });

    const accessToken = tokenResponse.data.access_token;

    const userResponse = await axios.get('https://osu.ppy.sh/api/v2/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    req.session.user = userResponse.data;
    res.redirect('/');

  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).send('Authorization error');
  }
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error(err);
      return res.status(500).send('Ошибка выхода');
    }
    res.redirect('/');
  });
});

// Удаление участника
app.delete('/api/participant/:nickname', async (req, res) => {
  if (!req.session.user || req.session.user.username !== 'LLIaBKa') {
    return res.status(403).json({ error: 'Not authorized' });
  }

  const nickname = req.params.nickname;

  const { error } = await supabase.from("participants").delete().eq("nickname", nickname);
  if (error) return res.status(500).json({ error: error.message });

  res.json({ success: true });
});

// Очистка таблицы
app.delete('/api/participants', async (req, res) => {
  if (!req.session.user || req.session.user.username !== 'LLIaBKa') {
    return res.status(403).json({ error: 'Not authorized' });
  }

  // Удаляем все записи из таблицы participants
  const { error } = await supabase.from("participants").delete().neq('userid', 0);

  if (error) return res.status(500).json({ error: error.message });

  res.json({ success: true });
});

// === Участие ===
app.post('/api/participate', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });

  const user = req.session.user;

  // проверка на участие
  const { data: exists } = await supabase.from("participants")
    .select("userid")
    .eq("userid", user.id)
    .single();

  if (exists) {
    return res.status(400).json({ error: 'User already participating' });
  }
  const moscowTime = new Date(Date.now() + 3*60*60*1000); // UTC+3
  if (moscowTime.getDay() !== 0) { // 0 = воскресенье
    return res.status(400).json({ error: 'Участвовать можно только в воскресенье' });
  }
  else{
  try {
    const token = await getOsuAccessToken();
    const resOsu = await axios.get(`https://osu.ppy.sh/api/v2/users/${user.id}/osu`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const ppStart = resOsu.data.statistics.pp || 0;

    const newEntry = {
      position: position,
      userid: user.id,
      avatar: user.avatar_url || '',
      nickname: user.username,
      ppstart: Number(ppStart),
      ppend: ppStart,
      points: 0
    };

    await supabase.from("participants").insert([newEntry]);

    res.json({ success: true, participant: newEntry });
  } catch (err) {
    console.error("Ошибка при регистрации:", err.response?.data || err.message);
    res.status(500).json({ error: "Ошибка osu! API" });
  }}
});

app.post('/api/unparticipate', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  const user = req.session.user;

  const { error } = await supabase.from("participants").delete().eq("userid", user.id);
  if (error) return res.status(500).json({ error: error.message });

  res.json({ success: true });
});

// === Запуск сервера ===
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
