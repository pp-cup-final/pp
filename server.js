const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static("public"));
app.use(express.json());

let participantsFile = path.join(__dirname, "participants.json");

// === Работа с JSON-файлом ===
function loadData() {
  if (!fs.existsSync(participantsFile)) return [];
  return JSON.parse(fs.readFileSync(participantsFile, "utf-8"));
}

function saveData(data) {
  fs.writeFileSync(participantsFile, JSON.stringify(data, null, 2));
}

// === osu! API Access Token ===
let osuAccessToken = null;
let osuTokenExpiresAt = null;

async function getOsuAccessToken() {
  const now = Date.now();
  if (osuAccessToken && osuTokenExpiresAt && now < osuTokenExpiresAt) {
    return osuAccessToken;
  }
  try {
    const res = await axios.post("https://osu.ppy.sh/oauth/token", {
      client_id: process.env.OSU_CLIENT_ID,
      client_secret: process.env.OSU_CLIENT_SECRET,
      grant_type: "client_credentials",
      scope: "public",
    });
    osuAccessToken = res.data.access_token;
    osuTokenExpiresAt = now + res.data.expires_in * 1000;
    console.log("✅ osu! access token обновлен");
    return osuAccessToken;
  } catch (err) {
    console.error("❌ Ошибка получения токена osu:", err.response?.data || err.message);
    throw err;
  }
}

// === Подсчет очков ===
function calculatePoints(startPP, endPP) {
  const diff = endPP - startPP;
  if (diff <= 0) return 0;

  const multiplier = Math.floor(startPP / 1000) + 1;
  return diff * multiplier;
}

// === Обновление PP участников ===
async function updateParticipantsPP() {
  const data = loadData();

  for (let participant of data) {
    try {
      const token = await getOsuAccessToken();
      const res = await axios.get(
        `https://osu.ppy.sh/api/v2/users/${participant.UserID}/osu`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      const currentPP = res.data.statistics.pp;

      participant.PPend = currentPP;
      participant.Points = calculatePoints(
        parseFloat(participant.PPstart),
        parseFloat(currentPP)
      );
    } catch (err) {
      console.error(
        `❌ Ошибка обновления ${participant.Nickname}:`,
        err.response?.data || err.message
      );
    }
  }

  updatePositions(data);
  saveData(data);
}

// === Обновление позиций ===
function updatePositions(data) {
  data.sort((a, b) => b.Points - a.Points);
  data.forEach((p, i) => (p.Position = i + 1));
}

// === API ===

// Участие
app.post("/api/participate", async (req, res) => {
  const { code } = req.body;
  try {
    const tokenRes = await axios.post("https://osu.ppy.sh/oauth/token", {
      client_id: process.env.OSU_CLIENT_ID,
      client_secret: process.env.OSU_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: process.env.REDIRECT_URI,
    });

    const userRes = await axios.get("https://osu.ppy.sh/api/v2/me", {
      headers: { Authorization: `Bearer ${tokenRes.data.access_token}` },
    });

    const user = userRes.data;
    const data = loadData();

    if (data.find((p) => p.UserID === user.id)) {
      return res.status(400).json({ error: "Вы уже участвуете" });
    }

    const ppStart = user.statistics.pp;
    const ppEnd = ppStart;

    const newEntry = {
      UserID: user.id,
      Avatar: user.avatar_url || "",
      Nickname: user.username,
      PPstart: ppStart,
      PPend: ppEnd,
      Points: calculatePoints(ppStart, ppEnd),
    };

    data.push(newEntry);
    updatePositions(data);
    saveData(data);

    res.json({ success: true, user: newEntry });
  } catch (err) {
    console.error("Ошибка авторизации:", err.response?.data || err.message);
    res.status(500).json({ error: "Ошибка авторизации" });
  }
});

// Получить список участников
app.get("/api/participants", (req, res) => {
  const data = loadData();
  res.json(data);
});

// 🔒 Админ кнопка (только для ника LLIaBKa)
app.post("/api/admin/update", async (req, res) => {
  const { nickname } = req.body;
  if (nickname !== "LLIaBKa") {
    return res.status(403).json({ error: "Доступ запрещен" });
  }
  try {
    await updateParticipantsPP();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Ошибка обновления" });
  }
});

// === Запуск ===
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
