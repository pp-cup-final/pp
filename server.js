require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const session = require('express-session');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'some secret here',
  resave: false,
  saveUninitialized: true,
}));

const DB_PATH = path.join(__dirname, 'data', 'database.json');

// === Работа с данными ===
function loadData() {
  if (!fs.existsSync(DB_PATH)) return [];
  const raw = fs.readFileSync(DB_PATH);
  return JSON.parse(raw);
}

function saveData(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

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

function updatePositions(data) {
  data.sort((a, b) => b.Points - a.Points);

  let lastPoints = null;
  let lastPosition = 0;

  data.forEach((participant, index) => {
    if (participant.Points !== lastPoints) {
      lastPosition = index + 1;
      lastPoints = participant.Points;
    }
    participant.Position = lastPosition;
  });
}

// === Обновление PP участников ===
async function updateParticipantsPP() {
  const data = loadData();

  for (let participant of data) {
    try {
      const token = await getOsuAccessToken();
      const res = await axios.get(`https://osu.ppy.sh/api/v2/users/${participant.Nickname}/osu`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      const currentPP = res.data.statistics.pp;

      participant.PPend = currentPP;
      participant.Points = calculatePoints(parseFloat(participant.PPstart), parseFloat(currentPP));
    } catch (err) {
      console.error(`Ошибка обновления ${participant.Nickname}:`, err.response?.data || err.message);
    }
  }

  updatePositions(data);
  saveData(data);
}

// === Автоматический запуск ===
fetchOsuAccessToken().then(() => {
  updateParticipantsPP();
  setInterval(updateParticipantsPP, 10 * 60 * 1000); // каждые 10 минут
});

// === API ===

app.get('/api/data', (req, res) => {
  const data = loadData();
  updatePositions(data);
  saveData(data);
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
app.delete('/api/participant/:nickname', (req, res) => {
  if (!req.session.user || req.session.user.username !== 'LLIaBKa') {
    return res.status(403).json({ error: 'Not authorized' });
  }

  let data = loadData();
  data = data.filter(p => p.Nickname !== req.params.nickname);
  saveData(data);

  res.json({ success: true });
});

// Очистка таблицы
app.delete('/api/participants', (req, res) => {
  if (!req.session.user || req.session.user.username !== 'LLIaBKa') {
    return res.status(403).json({ error: 'Not authorized' });
  }

  saveData([]);
  res.json({ success: true });
});

// === Участие ===
app.post('/api/participate', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });

  const user = req.session.user;
  let data = loadData();

  if (data.some(p => p.Nickname === user.username)) {
    return res.status(400).json({ error: 'User already participating' });
  }

  const ppStart = user.statistics?.pp || 0;
  const ppEnd = ppStart;

  const newEntry = {
    UserID: user.id,
    Avatar: user.avatar_url || '',
    Nickname: user.username,
    PPstart: ppStart,
    PPend: ppEnd,
    Points: calculatePoints(ppStart, ppEnd)
  };

  data.push(newEntry);
  updatePositions(data);
  saveData(data);

  res.json({ success: true, participant: newEntry });
});

app.post('/api/unparticipate', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });

  const user = req.session.user;
  let data = loadData();

  const newData = data.filter(p => p.Nickname !== user.username);

  if (newData.length === data.length) {
    return res.status(404).json({ error: 'User not found in participants' });
  }

  updatePositions(newData);
  saveData(newData);
  res.json({ success: true });
});

// === Запуск сервера ===
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
