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

// Папка для истории (локальная, можно оставить или удалить)
const historyDir = path.join(__dirname, "history");
if (!fs.existsSync(historyDir)) {
  fs.mkdirSync(historyDir);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // на бэке используем service_role
);

// middlewares
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

async function fetchUserScores(userId, sinceDate, token) {
  const res = await fetch(`https://osu.ppy.sh/api/v2/users/${userId}/scores/recent?limit=100`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const scores = await res.json();

  // фильтруем только новые (после participation_date)
  return scores.filter(s => new Date(s.participation_date) > new Date(sinceDate));
}
async function saveScoresToDB(userid, scores) {
  for (const s of scores) {
    const { error } = await supabase
      .from("participant_scores") // <== новая таблица
      .upsert({
        userid,
        beatmap_id: s.beatmap.id,
        score_id: s.id,
        score_pp: s.pp,
        pp_gain: s.statistics?.pp || s.pp,
        beatmap_bg: s.beatmap.beatmapset.covers.card,
        beatmap_title: s.beatmap.beatmapset.title,
        beatmap_version: s.beatmap.version,
      });
    if (error) console.error("Ошибка вставки скора:", error);
  }
}
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

// === Обновление позиций в БД ===
async function updatePositionsInDB() {
  try {
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
    const updates = [];

    for (let i = 0; i < participants.length; i++) {
      const p = participants[i];
      const pPoints = parseFloat(p.points) || 0;

      if (pPoints !== lastPoints) {
        lastPosition = i + 1;
        lastPoints = pPoints;
      }

      const currentPos = p.position === null || p.position === undefined ? null : Number(p.position);
      if (currentPos !== lastPosition) {
        updates.push(
          supabase
            .from('participants')
            .update({ position: lastPosition })
            .eq('userid', p.userid)
        );
      }

      // добавим совместимое поле для отдачи фронту
      p.position = lastPosition;
    }

    if (updates.length > 0) {
      const results = await Promise.all(updates);
      for (const r of results) {
        if (r.error) console.error('Ошибка обновления позиции:', r.error);
      }
    }

    return participants;
  } catch (err) {
    console.error('Ошибка в updatePositionsInDB:', err);
    return [];
  }
}

// === Обновление PP участников ===
async function updateParticipantsPP() {
  try {
    const { data: participants, error } = await supabase
      .from("participants")
      .select("*");

    if (error) {
      console.error("Ошибка загрузки участников:", error);
      return;
    }

    const token = await getOsuAccessToken();

    for (let participant of participants) {
      try {
        // 1. Получаем профиль
        const res = await axios.get(
          `https://osu.ppy.sh/api/v2/users/${participant.userid}/osu`,
          { headers: { Authorization: `Bearer ${token}` } }
        );

        const currentPP = res.data.statistics.pp;
        const points = calculatePoints(
          parseFloat(participant.ppstart),
          parseFloat(currentPP)
        );

        // Обновляем участника
        await supabase
          .from("participants")
          .update({
            ppend: currentPP,
            points: points
          })
          .eq("userid", participant.userid);

        // 2. Получаем топ-200 скорборда (2 запроса по 100)
        let allScores = [];
        for (let offset of [0, 100]) {
          const scoresRes = await axios.get(
            `https://osu.ppy.sh/api/v2/users/${participant.userid}/scores/best?mode=osu&limit=100&offset=${offset}`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          allScores = allScores.concat(scoresRes.data);
        }

        // 3. Фильтруем по дате участия
        const joinDate = new Date(participant.participation_date);
        const filteredScores = allScores.filter(
          (score) => new Date(score.created_at) >= joinDate
        );

        // 4. Группируем по beatmap_id и выбираем максимум PP
        const maxScoresMap = {};
        filteredScores.forEach(score => {
          const beatmapId = score.beatmap.id;
          if (!maxScoresMap[beatmapId] || score.pp > maxScoresMap[beatmapId].pp) {
            maxScoresMap[beatmapId] = score;
          }
        });

        // 5. Формируем массив для вставки
        const insertData = Object.values(maxScoresMap).map(score => ({
          userid: participant.userid,
          score_id: score.id,
          score_pp: score.pp,
          pp_gain: score.pp, // потом можно пересчитать
          beatmap_id: score.beatmap.id,
          beatmap_title: `${score.beatmapset.title} [${score.beatmap.version}]`,
          beatmap_bg: score.beatmapset.covers["cover@2x"],
          created_at: score.created_at
        }));

        // 6. Вставляем (insert), обновляем только если score_id совпадает
        if (insertData.length > 0) {
          const { error: insertErr } = await supabase
            .from("participant_scores")
            .upsert(insertData, { onConflict: ["score_id"] });

          if (insertErr) {
            console.error("Ошибка вставки/обновления:", insertErr);
          } else {
            console.log(
              `✅ Добавлено/обновлено ${insertData.length} скор(ов) для ${participant.nickname}`
            );
          }
        }

      } catch (err) {
        console.error(
          `Ошибка обновления ${participant.nickname}:`,
          err.response?.data || err.message
        );
      }
    }

    await updatePositionsInDB();
    console.log("✅ Участники и скоры обновлены");
  } catch (err) {
    console.error("Ошибка в updateParticipantsPP:", err);
  }
}


// === Автоматический запуск ===
fetchOsuAccessToken().then(() => {
  updateParticipantsPP();
  setInterval(updateParticipantsPP, 5 * 60 * 1000); // каждые 5 минут
});
fetchOsuAccessToken().then(() => {
  updatePoolPP();
  setInterval(updatePoolPP, 5 * 60 * 1000); // каждые 5 минут
});
// CRON: сохраняем историю и очищаем пул
cron.schedule("0 0 * * 0", async () => {
  try {
    console.log("=== Сохранение истории пула ===");

    // 1) Получаем всех участников пула
    const { data: participants, error: pErr } = await supabase
      .from("pool_participants")
      .select("*")
      .order("total_pp", { ascending: false });

    if (pErr) throw pErr;
    if (!participants || participants.length === 0) {
      console.log("Нет участников для сохранения истории.");
      return;
    }

    // 2) Получаем все карты пула заранее
    const { data: allMaps, error: mapsErr } = await supabase
      .from("player_scores")
      .select(`
        id,
        participant_id,
        map_id,
        pp,
        pool_maps (
          difficulty_id,
          beatmap_id,
          title,
          map_url,
          background_url
        )
      `);

    if (mapsErr) throw mapsErr;

    // 3) Проходим по каждому участнику
    for (const [index, p] of participants.entries()) {
      // Получаем карты текущего игрока
      const scores = (allMaps || []).filter(s => s.participant_id === p.id);

      const formattedScores = (scores || []).map(s => ({
        pp: Number(s.pp) || 0,
        map_id: s.map_id,
        difficulty_id: s.pool_maps?.difficulty_id || null,
        beatmap_id: s.pool_maps?.beatmap_id || null,
        title: s.pool_maps?.title || null,
        map_url: s.pool_maps?.map_url || null,
        background_url: s.pool_maps?.background_url || null
      }));
      // Вставляем запись в pool_history
      const { error: insertErr } = await supabase.from("pool_history").insert({
        tournament_date: new Date().toISOString().split("T")[0],
        position: index + 1,
        avatar_url: p.avatar,
        nickname: p.nickname,
        total_pp: p.total_pp,
        scores: formattedScores
      });

      if (insertErr) console.error(`Ошибка вставки истории для ${p.nickname}:`, insertErr);
    }

    console.log("✅ История пула успешно сохранена!");

    // 4) Очистка таблиц
    await supabase.from("pool_participants").delete().neq("id", 0);
    await supabase.from("player_scores").delete().neq("id", 0);
    await supabase.from("pool_maps").delete().neq("id", 0);

    console.log("Пул и карты очищены.");

    try {
    // 1. Забираем все строки из table1
    const { data: rows, error: fetchError } = await supabase
      .from('test_pool_maps')
      .select('*');

    if (fetchError) throw fetchError;
    if (!rows.length) {
      console.log('Нет строк для перемещения');
      return;
    }

    // 2. Вставляем их в table2
    const { error: insertError } = await supabase
      .from('pool_maps')
      .insert(rows);

    if (insertError) throw insertError;
   

    console.log(`✅ Перемещено ${rows.length} строк`);
  } catch (err) {
    console.error('Ошибка перемещения:', err.message || err);
  }

  } catch (err) {
    console.error("Ошибка в CRON сохранения истории пула:", err.response?.data || err.message || err);
  }
}, { timezone: "Europe/Moscow" });
// CRON: каждое воскресенье в 00:00 по Москве — сохраняем историю и очищаем таблицу
cron.schedule("0 0 * * 0", async () => {
  try {
    // Сначала пересчитаем и запишем актуальные позиции в participants
    await updatePositionsInDB();

    // Получаем участников уже с позициями, отсортированных по позиции ASC
    const { data: participants, error: fetchErr } = await supabase
      .from('participants')
      .select('*')
      .order('position', { ascending: true });

    if (fetchErr) {
      console.error('Ошибка получения участников для истории:', fetchErr);
      return;
    }

    if (!participants || participants.length === 0) {
      console.log('Нет участников — история не сохранена.');
      return;
    }

    // Сформируем запись истории (с датой)
    const historyRow = {
      date: new Date().toISOString(),
      data: participants
    };

    const { error: insertErr } = await supabase.from("history").insert([historyRow]);
    if (insertErr) {
      console.error('Ошибка вставки в history:', insertErr);
      return;
    }

    // Очистим таблицу участников
    const { error: deleteErr } = await supabase.from("participants").delete().neq("id", 0);
    if (deleteErr) {
      console.error('Ошибка очистки participants после сохранения истории:', deleteErr);
      return;
    }
    const { error: deleteErr1 } = await supabase.from("participants_scores").delete().neq("id", 0);
    if (deleteErr) {
      console.error('Ошибка очистки participants_scores после сохранения истории:', deleteErr1);
      return;
    }

    console.log("✅ История сохранена и таблица участников очищена");
  } catch (err) {
    console.error('CRON error:', err);
  }
}, { timezone: "Europe/Moscow" });

// Роут для истории
app.get('/api/history', async (req, res) => {
  try {
    const { data, error } = await supabase.from("history").select("*").order("date", { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    console.error('Ошибка /api/history:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get("/history", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "history.html"));
});
app.post('/api/participate', async (req, res) => {
  // Проверка авторизации
  if (!req.session.user) {
    return res.status(401).json({ error: 'Not logged in' });
  }

  const user = req.session.user;

  // Проверка на участие
  const { data: exists, error: checkErr } = await supabase
    .from("participants")
    .select("userid")
    .eq("userid", user.id)
    .maybeSingle();

  if (checkErr) {
    console.error('Ошибка проверки участия:', checkErr);
    return res.status(500).json({ error: 'DB error' });
  }

  if (exists) {
    return res.status(400).json({ error: 'User already participating' });
  }

  // Проверка дня недели (только воскресенье)
  //const moscowTime = new Date(Date.now() + 3 * 60 * 60 * 1000); // UTC+3
  //if (moscowTime.getDay() !== 0) { // 0 = воскресенье
  //  return res.status(400).json({ error: 'Участвовать можно только в воскресенье' });
 // }

  try {
    // Получаем токен для osu! API
    const token = await getOsuAccessToken();

    // Получаем статистику игрока
    const resOsu = await axios.get(`https://osu.ppy.sh/api/v2/users/${user.id}/osu`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const ppStart = resOsu.data.statistics.pp || 0;

    // Создаем запись нового участника
    const newEntry = {
      userid: user.id,
      avatar: user.avatar_url || '',
      nickname: user.username,
      ppstart: Number(ppStart),
      ppend: ppStart,
      points: 0,
      participation_date: new Date().toISOString(),
      position: null // будет пересчитано
    };

    // Вставляем запись в базу
    const { error } = await supabase.from("participants").insert([newEntry]);
    if (error) {
      console.error('Ошибка вставки участника:', error);
      return res.status(500).json({ error: error.message });
    }

    // Обновляем позиции после добавления
    await updatePositionsInDB();

    // Отправляем успешный ответ
    res.json({ success: true, participant: newEntry });

  } catch (err) {
    console.error("Ошибка при регистрации:", err.response?.data || err.message);
    res.status(500).json({ error: "Ошибка osu! API" });
  }
});
app.get('/api/participant/:userid/scores', async (req, res) => {
  const userid = req.params.userid;
  try {
    // Получаем дату участия из participants
    const { data: participant, error: pErr } = await supabase
      .from('participants')
      .select('userid, nickname, participation_date')
      .eq('userid', userid)
      .maybeSingle();

    if (pErr) {
      console.error('participant fetch error', pErr);
      return res.status(500).json({ error: pErr.message });
    }

    if (!participant) {
      return res.status(404).json({ error: 'Участник не найден' });
    }

    const joinDate = participant.participation_date || null;

    // Получаем все его скоры из participant_scores
    let query = supabase
      .from('participant_scores')
      .select(`
        id,
        score_pp,
        pp_gain,
        created_at,
        beatmap_id,
        beatmap_title,
        beatmap_version,
        beatmap_bg
      `)
      .eq('userid', userid);

    // Фильтрация по participation_date
    if (joinDate) {
      query = query.gte('created_at', joinDate);
    }

    const { data, error } = await query.order('created_at', { ascending: false });

    if (error) {
      console.error('scores fetch error', error);
      return res.status(500).json({ error: error.message });
    }

    res.json(data || []);
  } catch (err) {
    console.error('unexpected error:', err);
    res.status(500).json({ error: err.message });
  }
});
// ========== pool endpoints (как у тебя было) ==========
// Участие в пуле карт
// server.js
app.get("/api/pool/history", async (req, res) => {
  try {
    // Берём все записи из pool_history
    const { data: rows, error } = await supabase
      .from("pool_history")
      .select("*")
      .order("tournament_date", { ascending: false })
      .order("position", { ascending: true });

    if (error) throw error;

    // Группируем по турнирам
    const historyMap = {};
    rows.forEach(row => {
      if (!historyMap[row.tournament_date]) {
        historyMap[row.tournament_date] = [];
      }
      historyMap[row.tournament_date].push({
        position: row.position,
        avatar_url: row.avatar_url,
        nickname: row.nickname,
        total_pp: row.total_pp,
        scores: row.scores || []
      });
    });

    // Формируем массив для фронта
    const history = Object.keys(historyMap).map(date => ({
      tournament_date: date,
      data: historyMap[date]
    }));

    res.json(history);
  } catch (err) {
    console.error("Ошибка при получении истории пул капа:", err);
    res.status(500).json({ error: "Ошибка при получении истории пул капа" });
  }
});
app.get('/pool', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pool.html'));
});
app.get('/api/pool/maps', async (req, res) => {
  try {
    // Берем карты из пула
    const { data: maps, error: mapsError } = await supabase
      .from('pool_maps')
      .select('id, beatmap_id, title, background_url, map_url, difficulty_id')
      .order('id', { ascending: true });

    if (mapsError) return res.status(500).json({ error: mapsError.message });
    if (!maps || maps.length === 0) return res.json([]);

    // Получаем все лучшие PP сразу одним запросом
    const { data: bestScores, error: scoresError } = await supabase
      .from('player_scores')
      .select('map_id, pp')
      .in('map_id', maps.map(m => m.id))
      .order('pp', { ascending: false });

    if (scoresError) {
      console.error('Ошибка загрузки скоров:', scoresError.message);
      return res.status(500).json({ error: scoresError.message });
    }

    // Сопоставляем карты с их максимальным PP
    const bestPPMap = {};
    bestScores.forEach(s => {
      if (!bestPPMap[s.map_id] || s.pp > bestPPMap[s.map_id]) {
        bestPPMap[s.map_id] = Math.round(s.pp);
      }
    });

    const mapsWithBest = maps.map(m => ({
      ...m,
      best_score_pp: bestPPMap[m.id] || 0
    }));

    res.json(mapsWithBest);
  } catch (err) {
    console.error('Ошибка /api/pool/maps:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
app.get('/api/scores/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('player_scores')
      .select(`
        id, userid, score_id, score_pp, accuracy, mods,
        max_combo, statistics, created_at,
        beatmap_id, beatmapset_id, beatmap_version, beatmap_bg
      `)
      .eq('id', req.params.id)
      .single();

    if (error) return res.status(500).json({ error: error.message });

    // подтянуть ник игрока
    const { data: user } = await supabase
      .from('participants')
      .select('nickname')
      .eq('userid', data.userid)
      .maybeSingle();

    res.json({ ...data, username: user?.nickname || 'Unknown' });
  } catch (err) {
    console.error('Ошибка /api/scores/:id', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/pool/participate', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });

  const user = req.session.user; // данные из osu!

  try {
    const { data: participant, error: pError } = await supabase
      .from("pool_participants")
      .insert([{
        userid: user.id,
        nickname: user.username,
        avatar: user.avatar_url || '',
        total_pp: 0
      }])
      .select()
      .single();

    if (pError) throw pError;

    const participantId = participant.id;

    const { data: pool, error: poolError } = await supabase
      .from("pool_maps")
      .select("id");

    if (poolError) throw poolError;

    const scoreRows = pool.map((map) => ({
      participant_id: participantId,
      map_id: map.id,
      pp: 0
    }));

    const { error: sError } = await supabase
      .from("player_scores")
      .insert(scoreRows);

    if (sError) throw sError;

    res.json({ success: true, participantId });
  } catch (err) {
    console.error('Ошибка /api/pool/participate:', err);
    res.status(500).json({ error: "Ошибка при добавлении участника" });
  }
});
async function updatePoolPP() {
  try {
    const token = await getOsuAccessToken();

    // 1) Участники пула
    const { data: participants, error: pErr } = await supabase
      .from("pool_participants")
      .select("id, userid, nickname, participation_date");
    if (pErr) throw pErr;

    // 2) Все карты пула
    const { data: maps, error: mErr } = await supabase
      .from("pool_maps")
      .select("id, beatmap_id, difficulty_id, title, map_url");
    if (mErr) throw mErr;

    const zeroPPMaps = [];

    for (const participant of participants) {
      const participationDate = participant.participation_date
        ? new Date(participant.participation_date)
        : new Date(0);

      for (const map of maps) {
        try {
          // Проверяем запись в player_scores
          const { data: existingRows, error: eErr } = await supabase
            .from("player_scores")
            .select("id, pp")
            .eq("participant_id", participant.id)
            .eq("map_id", map.id);

          if (eErr) throw eErr;

          if (!existingRows || existingRows.length === 0) {
            await supabase.from("player_scores").insert([
              { participant_id: participant.id, map_id: map.id, pp: 0 },
            ]);
          }

          // Резолвим difficulty_id
          let difficultyId = map.difficulty_id;
          if (!difficultyId) {
            const candidate =
              map.map_url?.match(/beatmaps\/(\d+)/)?.[1] || map.beatmap_id || null;

            if (candidate) {
              try {
                const bmRes = await axios.get(
                  `https://osu.ppy.sh/api/v2/beatmaps/${candidate}`,
                  { headers: { Authorization: `Bearer ${token}` } }
                );
                difficultyId = bmRes.data.id;
                const setId = bmRes.data?.beatmapset?.id || map.beatmap_id || null;

                if (difficultyId) {
                  await supabase
                    .from("pool_maps")
                    .update({
                      difficulty_id: difficultyId,
                      beatmap_id: setId,
                    })
                    .eq("id", map.id);
                }
              } catch (e) {
                console.warn(
                  `Не удалось разрешить difficulty для map.id=${map.id}:`,
                  e.response?.data || e.message
                );
              }
            }
          }

          if (!difficultyId) {
            console.warn(`Пропускаем map.id=${map.id} — отсутствует difficulty_id`);
            zeroPPMaps.push({
              participant: participant.nickname,
              map: map.title,
              bestPP: 0,
              reason: "no difficulty_id",
            });
            continue;
          }

          // Получаем лучший pp игрока на карте
          let bestPP = 0;
          try {
            const scoreRes = await axios.get(
              `https://osu.ppy.sh/api/v2/beatmaps/${difficultyId}/scores/users/${participant.userid}/all`,
              { headers: { Authorization: `Bearer ${token}` } }
            );

            let candidates = Array.isArray(scoreRes.data)
              ? scoreRes.data
              : scoreRes.data?.scores || [];

            // Фильтруем по дате участия
            candidates = candidates.filter((s) => {
  		if (!s?.created_at) return false;
  		return new Date(s.created_at) >= participationDate;
		});

            if (candidates.length > 0) {
              bestPP = Math.max(...candidates.map((s) => Number(s.pp || 0)));
            }
          } catch (e) {
            
          }

          // Обновляем таблицу player_scores
          
          await supabase
            .from("player_scores")
            .update({ pp: bestPP })
            .eq("participant_id", participant.id)
            .eq("map_id", map.id);

          if (!bestPP) {
            zeroPPMaps.push({
              participant: participant.nickname,
              map: map.title,
              bestPP,
              reason: "no score",
            });
          }
        } catch (err) {
          console.error(
            `Ошибка обработки map ${map.id} для ${participant.nickname}:`,
            err.response?.data || err.message
          );
        }
      }
    }

    // Пересчёт total_pp
    for (const participant of participants) {
      const { data: scores, error: sErr } = await supabase
        .from("player_scores")
        .select("pp")
        .eq("participant_id", participant.id);

      if (sErr) {
       
        continue;
      }

      const total_pp = (scores || []).reduce(
        (sum, s) => sum + (Number(s.pp) || 0),
        0
      );

      await supabase
        .from("pool_participants")
        .update({ total_pp })
        .eq("id", participant.id);
    }

    console.log("✅ Total PP участников пула обновлены");

    
  } catch (err) {
    console.error(
      "Ошибка updatePoolPP:",
      err.response?.data || err.message || err
    );
  }
}
cron.schedule("1 0 * * 0", async () => {
  const token = await getOsuAccessToken();
  let count = 0;
  const { error: deleteError } = await supabase
      .from('test_pool_maps')
      .delete()
      .neq('id', 0); // удаляем все строки

    if (deleteError) throw deleteError;
  console.log("Начата генерация пула карт");
  while (count < 10) {
    const randomSetId = Math.floor(Math.random() * 2300000) + 1; // до последнего ранкнутого сет-а
    try {
      const res = await axios.get(`https://osu.ppy.sh/api/v2/beatmapsets/${randomSetId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const set = res.data;

      // проверяем, что сам сет ранкнутый
      if (set.status !== "ranked") continue;

      // фильтруем карты внутри сета
      const validDiffs = set.beatmaps.filter(
        bm => bm.mode === "osu" && bm.difficulty_rating >= 6 && bm.difficulty_rating <= 8
      );

      if (validDiffs.length > 0) {
        // берём случайную подходящую сложность из сета
        const map = validDiffs[Math.floor(Math.random() * validDiffs.length)];

        // сохраняем сразу в БД
        await supabase.from("test_pool_maps").insert([{
          beatmap_id: set.id,
          difficulty_id: map.id,
          title: `${set.title} [${set.version}]`,
          background_url: set.covers.cover,
          map_url: `https://osu.ppy.sh/beatmaps/${map.id}`
        }]);

        console.log(`🎵 Добавлена карта: ${set.title} [${map.version}]`);

        count++;
      }
    } catch (err) {
      continue; // если ошибка или сет не подходит — пробуем снова
    }
  }

  console.log("✅ Новый пул карт сгенерирован.");
}, { timezone: "Europe/Moscow" });





// Получение таблицы участников пула
app.get('/api/pool/participants', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('pool_participants')
      .select(`
        id,
        userid,
        nickname,
        avatar,
        total_pp,
        player_scores (
          pp,
          pool_maps (
            id,
            beatmap_id,
            title,
            background_url,
            map_url
          )
        )
      `);

    if (error) throw error;
        
    res.json(data);
  } catch (err) {
    console.error("Ошибка при получении участников:", err);
    res.status(500).json({ error: "Ошибка при получении участников" });
  }

});

// Получение карт и результатов игрока (в пуле)
app.get('/api/pool/player/:id', async (req, res) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from("player_scores")
    .select("id, score_id, pp, pool_maps(title, background_url, map_url)")
    .eq("participant_id", id)
    .order('pp', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// === API основного турнира ===
app.get('/api/data', async (req, res) => {
  try {
    // 1. Обновляем позиции участников
    await updatePositionsInDB();

    // 2. Загружаем всех участников
    const { data: participants, error } = await supabase
      .from('participants')
      .select('*')
      .order('position', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });

    const token = await getOsuAccessToken();

    // 3. Обновляем playcount, если он устарел или отсутствует
    const updatedParticipants = await Promise.all(
      participants.map(async (p) => {
        if (p.playcount && p.playcount > 0) {
          // если уже есть playcount — просто возвращаем
          return p;
        }

        try {
          const resUser = await axios.get(
            `https://osu.ppy.sh/api/v2/users/${p.userid}/osu`,
            { headers: { Authorization: `Bearer ${token}` } }
          );

          const playcount = resUser.data.statistics.play_count || 0;

          // сохраняем playcount в Supabase
          const { error: updateErr } = await supabase
            .from('participants')
            .update({ playcount })
            .eq('userid', p.userid);

          if (updateErr) {
            console.error(`Ошибка обновления playcount для ${p.nickname}:`, updateErr.message);
          }

          return { ...p, playcount };
        } catch (err) {
          console.error(`Ошибка загрузки playcount для ${p.nickname}:`, err.message);
          return { ...p, playcount: 0 };
        }
      })
    );

    // 4. Возвращаем все данные
    res.json(updatedParticipants);
  } catch (err) {
    console.error('/api/data error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  res.json(req.session.user);
});

// === OAuth: авторизация ===
app.get('/auth/login', (req, res) => {
  const authUrl = `https://osu.ppy.sh/oauth/authorize?client_id=${osuClientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=public&state=main`;
  res.redirect(authUrl);
});

app.get('/pool/auth/login', (req, res) => {
  const authUrl = `https://osu.ppy.sh/oauth/authorize?client_id=${osuClientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=public&state=pool`;
  res.redirect(authUrl);
});

app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  const state = req.query.state || 'main'; // определяем откуда пришёл

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

    // редирект в зависимости от state
    if (state === 'pool') {
      return res.redirect('/pool');
    }
    return res.redirect('/');
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).send('Authorization error');
  }
});

app.post('/api/addMap', async (req, res) => {
  try {
    // Проверяем, что пользователь авторизован
    if (!req.session.user) {
      return res.status(401).json({ error: "Вы не авторизованы" });
    }

    // Разрешаем только игроку LLIaBKa
    if (req.session.user.username !== 'LLIaBKa') {
      return res.status(403).json({ error: "Нет доступа к добавлению карт" });
    }

    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "No URL provided" });

    // Парсим ссылку вида https://osu.ppy.sh/beatmapsets/1786810#osu/3660479
    const setMatch = url.match(/beatmapsets\/(\d+)/);
    const beatmapMatch = url.match(/#osu\/(\d+)/);

    if (!setMatch) return res.status(400).json({ error: "Invalid URL format" });

    const setId = setMatch[1];
    const beatmapId = beatmapMatch ? beatmapMatch[1] : null;

    const token = await getOsuAccessToken();

    // Если указан конкретный beatmap, получаем её, иначе берём весь сет
    let mapData;
    if (beatmapId) {
      const mapRes = await axios.get(`https://osu.ppy.sh/api/v2/beatmaps/${beatmapId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      mapData = mapRes.data;
    } else {
      const setRes = await axios.get(`https://osu.ppy.sh/api/v2/beatmapsets/${setId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      mapData = setRes.data.beatmaps[0];
    }

    // Сохраняем в Supabase
    const { data: inserted, error } = await supabase
      .from("pool_maps")
      .insert([{
        beatmap_id: mapData.beatmapset.id,         // ID сета
        difficulty_id: mapData.id,                 // ID конкретной difficulty
        title: `${mapData.beatmapset.title} [${mapData.version}]`,
        background_url: mapData.beatmapset.covers['cover'],
        map_url: `https://osu.ppy.sh/beatmaps/${mapData.id}`
      }])
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, map: inserted });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Ошибка при добавлении карты" });
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

// Удаление участника (админ)
app.delete('/api/participant/:nickname', async (req, res) => {
  if (!req.session.user || req.session.user.username !== 'LLIaBKa') {
    return res.status(403).json({ error: 'Not authorized' });
  }

  const nickname = req.params.nickname;

  const { error } = await supabase.from("participants").delete().eq("nickname", nickname);
  if (error) return res.status(500).json({ error: error.message });

  res.json({ success: true });
});

// Очистка таблицы participants (админ)
app.delete('/api/participants', async (req, res) => {
  if (!req.session.user || req.session.user.username !== 'LLIaBKa') {
    return res.status(403).json({ error: 'Not authorized' });
  }

  const { error } = await supabase.from("participants").delete().neq("id", 0);
  if (error) return res.status(500).json({ error: error.message });

  res.json({ success: true });
});

// === Участие основного турнира ===
app.post('/api/pool/participate', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });

  const user = req.session.user; // здесь твои данные из сессии osu!

  try {
    // 1. Добавляем участника
    const { data: participant, error: pError } = await supabase
      .from("pool_participants")
      .insert([{
        userid: user.id,
        nickname: user.username,       // <-- ЗДЕСЬ вместо "nickname"
        avatar: user.avatar_url || '',
        total_pp: 0,
        participation_date: new Date() // <-- сохраняем текущую дату
      }])
      .select()
      .single();

    if (pError) throw pError;

    const participantId = participant.id;

    // 2. Получаем все карты из пула
    const { data: pool, error: poolError } = await supabase
      .from("pool_maps")
      .select("id");

    if (poolError) throw poolError;

    // 3. Для каждой карты создаём запись с pp = 0
    const scoreRows = pool.map((map) => ({
      participant_id: participantId,
      map_id: map.id,
      pp: 0
    }));

    // 4. Вставляем в player_scores
    const { error: sError } = await supabase
      .from("player_scores")
      .insert(scoreRows);

    if (sError) throw sError;

    res.json({ success: true, participantId });
  } catch (err) {
    console.error('Ошибка /api/pool/participate:', err);
    res.status(500).json({ error: "Ошибка при добавлении участника" });
  }
});

app.post('/api/unparticipate', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  const user = req.session.user;

  const { error } = await supabase.from("participants").delete().eq("userid", user.id);
  if (error) return res.status(500).json({ error: error.message });

  // пересчитаем позиции после удаления
  await updatePositionsInDB();

  res.json({ success: true });
});

// === Запуск сервера ===
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
