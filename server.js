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
const NodeCache = require('node-cache');
const cache = new NodeCache({
  stdTTL: 300, // Кэш живёт 5 минут
  checkperiod: 120, // Проверка каждые 2 минуты
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // на бэке используем service_role
);

app.use(express.static('public'));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'some secret here',
  resave: false,
  saveUninitialized: true,
}));

let osuAccessToken = null;
let osuTokenExpiry = 0;

const osuClientId = process.env.OSU_CLIENT_ID;
const osuClientSecret = process.env.OSU_CLIENT_SECRET;
const redirectUri = process.env.REDIRECT_URI || 'https://xn--80aea7bebb7e.xn--p1ai/auth/callback';

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
app.get('/api/recommend', async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Необходимо авторизоваться' });
  }
  const userId = req.session.user.id;

  try {
    // Проверяем последнюю рекомендацию (не чаще 1 раза в 5 секунд)
    const { data: lastRec, error: lastErr } = await supabase
      .from('recommendations')
      .select('created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!lastErr && lastRec) {
      const lastTime = new Date(lastRec.created_at).getTime();
      const now = Date.now();
      if (now - lastTime < 5000) {
        return res.status(429).json({ error: 'Слишком частые запросы. Подождите 5 секунд.' });
      }
    }

    // Получаем ранг текущего пользователя из osu API
    const token = await getOsuAccessToken();
    if (!token) {
      return res.status(500).json({ error: 'Ошибка получения токена osu' });
    }

    const userOsuRes = await axios.get(`https://osu.ppy.sh/api/v2/users/${userId}/osu`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const rank = userOsuRes.data.statistics?.global_rank;
    if (!rank) {
      return res.status(400).json({ error: 'Не удалось определить ранг игрока' });
    }

    // Вычисляем целевой ранг
    const maxOffset = Math.max(1, Math.floor(rank * 0.1));
    const offset = Math.floor(Math.random() * maxOffset) + 1;
    const sign = Math.random() < 0.5 ? -1 : 1;
    let targetRank = rank + sign * offset;
    if (targetRank < 1) targetRank = 1;

    // Получаем страницу рейтинга около targetRank
    const pageSize = 50;
    const page = Math.floor((targetRank - 1) / pageSize) + 1;
    const rankingsRes = await axios.get(`https://osu.ppy.sh/api/v2/rankings/osu/performance?page=${page}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const ranking = rankingsRes.data.ranking;
    if (!ranking || ranking.length === 0) {
      return res.status(500).json({ error: 'Не удалось получить список игроков' });
    }

    // Выбираем случайного игрока из этой страницы
    const randomIndex = Math.floor(Math.random() * ranking.length);
    const targetPlayer = ranking[randomIndex].user;

    // Получаем топ-100 скоров этого игрока
    const scoresRes = await axios.get(`https://osu.ppy.sh/api/v2/users/${targetPlayer.id}/scores/best?mode=osu&limit=100&offset=0`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const scores = scoresRes.data;
    if (!scores || scores.length === 0) {
      return res.status(500).json({ error: 'У выбранного игрока нет скоров' });
    }

    // Выбираем случайный скор из первых 50
    const maxScoreIndex = Math.min(50, scores.length) - 1;
    const scoreIndex = Math.floor(Math.random() * (maxScoreIndex + 1));
    const score = scores[scoreIndex];

    // Формируем данные для ответа и сохранения
    const beatmap = score.beatmap;
    const beatmapset = score.beatmapset;
    const recommendation = {
      user_id: userId,
      target_user_id: targetPlayer.id,
      beatmap_id: beatmap.id,
      score_id: score.id,
      mods: score.mods || [],
      pp: score.pp,
      star_rating: beatmap.difficulty_rating,
      beatmap_title: beatmapset.title,
      beatmap_version: beatmap.version,
      background_url: beatmapset.covers?.['cover@2x'] || beatmapset.covers?.cover || '',
    };

    // Сохраняем в БД
    const { error: insertErr } = await supabase
      .from('recommendations')
      .insert([recommendation]);

    if (insertErr) {
      console.error('Ошибка сохранения рекомендации:', insertErr);
      // но всё равно вернём данные клиенту
    }

    // Отправляем ответ клиенту
    res.json({
      beatmap_id: beatmap.id,
      title: beatmapset.title,
      version: beatmap.version,
      star_rating: beatmap.difficulty_rating,
      mods: score.mods || [],
      pp: score.pp,
      background_url: recommendation.background_url,
      target_nickname: targetPlayer.username,
      score_url: `https://osu.ppy.sh/scores/osu/${score.id}`
    });

  } catch (err) {
    console.error('Ошибка в /api/recommend:', err.response?.data || err.message);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});
async function getOsuAccessToken() {
  if (!osuAccessToken || Date.now() > osuTokenExpiry - 60000) { // обновляем за минуту до истечения
    await fetchOsuAccessToken();
  }
  return osuAccessToken;
}

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
  try {
    const { data: participants, error: selectErr } = await supabase
      .from('participants')
      .select('*');

    if (selectErr) {
      console.error('Ошибка чтения участников для позиций:', selectErr);
      return [];
    }

    participants.sort((a, b) => {
      const pa = parseFloat(a.points) || 0;
      const pb = parseFloat(b.points) || 0;

      if (pb !== pa) return pb - pa; 

      const dateA = new Date(a.participation_date);
      const dateB = new Date(b.participation_date);
      return dateA - dateB; 
    });

    let lastPoints = null;
    let lastDate = null;
    let lastPosition = 0;
    const updates = [];

    for (let i = 0; i < participants.length; i++) {
      const p = participants[i];
      const pPoints = parseFloat(p.points) || 0;
      const pDate = new Date(p.participation_date);

      if (pPoints !== lastPoints || pDate.getTime() !== lastDate?.getTime()) {
        lastPosition = i + 1;
        lastPoints = pPoints;
        lastDate = pDate;
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
        // 1️⃣ Получаем профиль (для обновления PP и поинтов)
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

        // 2️⃣ Получаем его top-200 скорборд
        let allScores = [];
        for (let offset of [0, 100]) {
          const scoresRes = await axios.get(
            `https://osu.ppy.sh/api/v2/users/${participant.userid}/scores/best?mode=osu&limit=100&offset=${offset}`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          allScores = allScores.concat(scoresRes.data);
        }

        // 3️⃣ Берём только скоры, сыгранные после участия
        const joinDate = new Date(participant.participation_date);
        const weekAgo = new Date();
        weekAgo.setDate(weekAgo.getDate() - 7); // ограничим последнюю неделю

        const filteredScores = allScores.filter(score => {
          const createdAt = new Date(score.created_at);
          return createdAt >= joinDate && createdAt >= weekAgo;
        });

        // 4️⃣ Оставляем только лучшие по PP на каждой карте
        const bestScoresByMap = {};
        for (const s of filteredScores) {
          const id = s.beatmap.id;
          if (!bestScoresByMap[id] || s.pp > bestScoresByMap[id].pp) {
            bestScoresByMap[id] = s;
          }
        }

        // 5️⃣ Готовим массив для вставки в БД
        const insertData = Object.values(bestScoresByMap).map(score => ({
          userid: participant.userid,
          score_id: score.id,
          score_pp: score.pp,
          pp_gain: score.pp,
          beatmap_id: score.beatmap.id,
          beatmap_title: `${score.beatmapset.title} [${score.beatmap.version}]`,
          beatmap_bg: score.beatmapset.covers["cover@2x"],
          created_at: score.created_at
        }));

        // 6️⃣ Удаляем старые записи игрока за последнюю неделю,
        // чтобы не было дублирующихся скоров по картам
        const deleteSince = weekAgo.toISOString();
        await supabase
          .from("participant_scores")
          .delete()
          .eq("userid", participant.userid)
          .gte("created_at", deleteSince);

        // 7️⃣ Вставляем новые лучшие скоры
        if (insertData.length > 0) {
          const { error: insertErr } = await supabase
            .from("participant_scores")
            .insert(insertData);

          if (insertErr) {
            console.error("Ошибка вставки скоров:", insertErr);
          } else {
            console.log(`✅ ${participant.nickname}: ${insertData.length} лучших скор(ов) за неделю сохранено`);
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
    console.log("✅ Все участники и лучшие скоры за неделю обновлены");
  } catch (err) {
    console.error("Ошибка в updateParticipantsPP:", err);
  }
}

async function verifyAndFixPlayerStats(userIds = null) {
  try {
    let allPlayers = [];
    if (!userIds) {
      const { data: players, error } = await supabase.from('players').select('*');
      if (error) throw error;
      allPlayers = players || [];
    } else {
      const { data: players, error } = await supabase
        .from('players')
        .select('*')
        .in('userid', userIds);
      if (error) throw error;
      allPlayers = players || [];
    }

    const playerIds = allPlayers.map(p => p.userid);
    const playcountCache = new Map();

    for (const userid of playerIds) {
      try {
        const { data: player } = await supabase
          .from('players')
          .select('*')
          .eq('userid', userid)
          .single();

        if (!player) {
          console.warn(`Игрок с userid ${userid} не найден, пропускаем`);
          continue;
        }
        const { data: ppData } = await supabase
          .from('history')
          .select('date, data')
          .order('date', { ascending: true });
        const ppHistoryRaw = ppData || [];

        let ppParticipations = 0;
        let ppWins = 0;
        let ppTotalPoints = 0;
        let ppBestPosition = Infinity;
        let currentEloPP = player.elo_pp_cup || 1000;

        console.log(`🔍 Проверяем PP для ${player.nickname} (${userid})`);

        for (const tournament of ppHistoryRaw) {
          const participants = tournament.data || [];
          
          const playerEntry = participants.find(p => {
            const pUserId = p.userid?.toString().trim();
            const targetUserId = userid.toString().trim();
            const pNick = (p.nickname || '').toLowerCase().trim();
            const playerNick = (player.nickname || '').toLowerCase().trim();
            return pUserId === targetUserId || pNick === playerNick;
          });
          
          if (playerEntry) {
            ppParticipations++;
            const position = parseInt(playerEntry.position) || Infinity;
            ppTotalPoints += parseFloat(playerEntry.points || 0);
            ppBestPosition = Math.min(ppBestPosition, position);
            
            if (playerEntry.elo_after !== undefined && playerEntry.elo_after !== null) {
              currentEloPP = parseFloat(playerEntry.elo_after);
            }

            participants.sort((a, b) => (a.position || Infinity) - (b.position || Infinity));

            let winnerUserid = null;
            let winnerNickname = null;

            for (const entry of participants) {
              const entryUserid = entry.userid?.toString().trim();
              const entryPosition = parseInt(entry.position) || Infinity;

              let playcount = 0;
              if (entry.playcount !== undefined) playcount = parseFloat(entry.playcount);
              else if (entry.statistics && entry.statistics.play_count !== undefined) playcount = parseFloat(entry.statistics.play_count);
              else if (entry['play_count'] !== undefined) playcount = parseFloat(entry['play_count']);

              let finalPlaycount = playcount;
              let isBanned = false;

              if ((playcount === 0 || isNaN(playcount)) && parseFloat(entry.ppstart || 0) > 0) {
                if (playcountCache.has(entryUserid)) {
                  finalPlaycount = playcountCache.get(entryUserid);
                  console.log(`  🗄 Кэш: playcount для ${entry.nickname} = ${finalPlaycount}`);
                } else {
                  try {
                    const token = await getOsuAccessToken();
                    const osuRes = await axios.get(
                      `https://osu.ppy.sh/api/v2/users/${entryUserid}/osu`,
                      { headers: { Authorization: `Bearer ${token}` } }
                    );
                    finalPlaycount = parseFloat(osuRes.data.statistics?.play_count) || 0;
                    playcountCache.set(entryUserid, finalPlaycount);
                    console.log(`  🔄 API: playcount для ${entry.nickname} был ${playcount}, теперь ${finalPlaycount}`);
                  } catch (apiErr) {
                    isBanned = true;
                    finalPlaycount = 0; 
                    playcountCache.set(entryUserid, 0);
                    console.warn(`  ⚠️ Забанен? ${entry.nickname} (${entryUserid}). Playcount=0`);
                  }
                }
              }

              const ppStart = parseFloat(entry.ppstart) || 0;
              const isQualified = ppStart >= 4000 && finalPlaycount >= 30000;

              console.log(`    Кандидат ${entry.nickname} (pos ${entryPosition}): PP=${ppStart}, Play=${finalPlaycount}${isBanned ? ' (banned)' : ''}, Qual=${isQualified}`);

              if (isQualified) {
                winnerUserid = entryUserid;
                winnerNickname = entry.nickname;
                break; 
              }
            }
            if (winnerUserid && winnerUserid === userid.toString().trim()) {
              ppWins++;
              console.log(`  🏆 ПОБЕДА для ${player.nickname} в турнире ${tournament.date}! (первый квалифицированный)`);
            } else if (winnerUserid) {
              console.log(`  Победитель турнира ${tournament.date}: ${winnerNickname} (не текущий игрок)`);
            } else {
              console.log(`  Нет квалифицированных победителей в турнире ${tournament.date}`);
            }
          }
        }

        console.log(`📊 ИТОГО PP для ${player.nickname}: участий=${ppParticipations}, побед=${ppWins}, best_pos=${ppBestPosition === Infinity ? 'N/A' : ppBestPosition}`);

        const { data: poolData } = await supabase
          .from('pool_history')
          .select('*')
          .order('tournament_date', { ascending: true });
        const poolHistory = poolData || [];

        let poolParticipations = 0;
        let poolWins = 0;
        let poolTotalPP = 0;
        let poolBestPosition = Infinity;
        let currentEloPool = player.elo_pool_cup || 1000;

        for (const entry of poolHistory) {
          const entryUserId = entry.userid?.toString().trim();
          const targetUserId = userid.toString().trim();
          const entryNick = (entry.nickname || '').trim().toLowerCase();
          const playerNick = (player.nickname || '').trim().toLowerCase();
          
          if ((entryUserId === targetUserId || entryNick === playerNick) && 
              entry.position !== undefined && entry.position !== null) {
            poolParticipations++;
            
            if (entry.position === 1) {
              poolWins++;
            }
            
            poolTotalPP += parseFloat(entry.total_pp || 0);
            poolBestPosition = Math.min(poolBestPosition, parseInt(entry.position));
            
            if (entry.elo_after !== undefined && entry.elo_after !== null) {
              currentEloPool = parseFloat(entry.elo_after);
            }
          }
        }

        const needsUpdate = 
          player.total_participations_pp !== ppParticipations ||
          player.wins_pp !== ppWins ||
          player.total_participations_pool !== poolParticipations ||
          player.wins_pool !== poolWins ||
          Math.abs((player.elo_pp_cup || 1000) - currentEloPP) > 0.01 ||
          Math.abs((player.elo_pool_cup || 1000) - currentEloPool) > 0.01;

        if (needsUpdate) {
          await supabase
            .from('players')
            .update({
              elo_pp_cup: Math.round(currentEloPP),
              total_participations_pp: ppParticipations,
              wins_pp: ppWins,
              total_points_pp: Math.round(ppTotalPoints),
              best_position_pp: ppBestPosition === Infinity ? null : ppBestPosition,
              elo_pool_cup: Math.round(currentEloPool),
              total_participations_pool: poolParticipations,
              wins_pool: poolWins,
              total_pp_pool: Math.round(poolTotalPP),
              best_position_pool: poolBestPosition === Infinity ? null : poolBestPosition
            })
            .eq('userid', userid);

          console.log(`✅ Обновлена статистика для ${player.nickname}: PP побед=${ppWins}, Pool побед=${poolWins}`);
        }

      } catch (err) {
        console.error(`Ошибка проверки статистики для ${userid}:`, err);
      }
    }

    console.log(`✅ Пересчитана статистика для ${playerIds.length} игроков`);
  } catch (err) {
    console.error('Ошибка в verifyAndFixPlayerStats:', err);
  }
}

app.get('/api/debug/history-structure', async (req, res) => {
  try {
    const { data: ppData } = await supabase
      .from('history')
      .select('date, data')
      .limit(3); 

    const analysis = ppData.map(t => {
      const sampleParticipant = t.data?.[0];
      return {
        date: t.date,
        participantKeys: sampleParticipant ? Object.keys(sampleParticipant) : [],
        hasPlaycount: !!sampleParticipant?.playcount,
        hasStatistics: !!sampleParticipant?.statistics,
        playcountValue: sampleParticipant?.playcount,
        statisticsPlaycount: sampleParticipant?.statistics?.play_count
      };
    });

    res.json({ 
      success: true, 
      analysis,
      message: 'Структура данных турниров' 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get('/fix-stats', async (req, res) => {
  try {
    console.log('🔧 НАЧАТ ПЕРЕСЧЕТ СТАТИСТИКИ ВСЕХ ИГРОКОВ (public)...');
    
    const startTime = Date.now();
    await verifyAndFixPlayerStats();
    const duration = Date.now() - startTime;
    
    const clearedKeys = cache.keys().filter(key => 
      key.startsWith('profile_') || key === 'all_players'
    );
    clearedKeys.forEach(key => cache.del(key));
    
    console.log(`✅ ПЕРЕСЧЕТ СТАТИСТИКИ ЗАВЕРШЕН за ${duration}ms! Очищено ключей кэша: ${clearedKeys.length}`);
    
    res.json({ 
      success: true,
      message: 'Статистика всех игроков успешно пересчитана!',
      timestamp: new Date().toISOString(),
      duration_ms: duration,
      cleared_cache_keys: clearedKeys.length
    });
    
  } catch (error) {
    console.error('❌ ОШИБКА ПЕРЕСЧЕТА СТАТИСТИКИ:', error);
    res.status(500).json({ 
      error: 'Ошибка при пересчете статистики',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});


fetchOsuAccessToken().then(() => {
  updateParticipantsPP();
  setInterval(updateParticipantsPP, 5 * 60 * 1000); // каждые 5 минут
});
fetchOsuAccessToken().then(() => {
  updatePoolPP();
  setInterval(updatePoolPP, 5 * 60 * 1000); // каждые 5 минут
});




// CRON: сохраняем историю пп капа и очищаем таблицу
cron.schedule("0 0 * * 0", async () => {
  try {
    // Сначала пересчитаем и запишем актуальные позиции в participants
    await updatePositionsInDB();
    await syncPlayersFromHistories().catch(console.error);
    await updateEloFromHistory().catch(console.error);
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
    const { error: deleteErr } = await supabase.from("participants").delete().neq("userid", 0);
    if (deleteErr) {
      console.error('Ошибка очистки participants после сохранения истории:', deleteErr);
      return;
    }
    const { error: deleteErr1 } = await supabase.from("participant_scores").delete().neq("id", 0);
    if (deleteErr1) {
      console.error('Ошибка очистки participant_scores после сохранения истории:', deleteErr1);
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
    return res.status(401).json({ error: 'Необходимо авторизоваться!' });
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
    return res.status(500).json({ error: 'Ошибка базы данных' });
  }

  if (exists) {
    return res.status(400).json({ error: 'Вы уже участвуете!' });
  }

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
        score_id,
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

async function updatePoolPP() {
  try {
    const token = await getOsuAccessToken();

    // 1️⃣ Загружаем всех участников
    const { data: participants, error: pErr } = await supabase
      .from("pool_participants")
      .select("id, userid, nickname, participation_date");

    if (pErr) throw pErr;
    if (!participants?.length) {
      console.log("Нет участников для обновления.");
      return;
    }

    // 2️⃣ Загружаем карты пула
    const { data: maps, error: mErr } = await supabase
      .from("pool_maps")
      .select("id, difficulty_id, title");
    if (mErr) throw mErr;
    if (!maps?.length) {
      console.log("Нет карт в пуле.");
      return;
    }

    console.log(`Обновление PP для ${participants.length} участников...`);

    // 3️⃣ Обрабатываем каждого участника
    for (const participant of participants) {
      const participationDate = new Date(participant.participation_date);
      let totalPP = 0;

      for (const map of maps) {
        const difficultyId = map.difficulty_id;
        let bestPP = 0;
        let bestScoreId = null;

        try {
          // Получаем ВСЕ скорЫ игрока по карте
          const scoreRes = await axios.get(
            `https://osu.ppy.sh/api/v2/beatmaps/${difficultyId}/scores/users/${participant.userid}/all`,
            { headers: { Authorization: `Bearer ${token}` } }
          );

          let candidates = Array.isArray(scoreRes.data)
            ? scoreRes.data
            : scoreRes.data?.scores || [];

          // Фильтруем только скоры после даты участия
          candidates = candidates.filter((s) => {
            if (!s?.created_at) return false;
            return new Date(s.created_at) >= participationDate;
          });

          if (candidates.length > 0) {
            // Находим скор с максимальным PP
            const bestScore = candidates.reduce((max, s) =>
              (s.pp || 0) > (max.pp || 0) ? s : max
            );

            bestPP = Number(bestScore.pp || 0);
            bestScoreId = bestScore.id || null;
          }
        } catch (e) {
          console.warn(
            `Ошибка запроса для карты ${map.id}, игрок ${participant.nickname}:`,
            e.response?.data || e.message
          );
        }

        // Обновляем или вставляем запись в player_scores
        const { data: existing, error: existingErr } = await supabase
          .from("player_scores")
          .select("id")
          .eq("participant_id", participant.id)
          .eq("map_id", map.id)
          .maybeSingle();

        if (existingErr) {
          console.error("Ошибка проверки существующего скора:", existingErr);
          continue;
        }

        if (existing) {
          // обновляем
          await supabase
            .from("player_scores")
            .update({
              pp: bestPP,
              score_id: bestScoreId,
            })
            .eq("id", existing.id);
        } else {
          // вставляем
          await supabase.from("player_scores").insert({
            participant_id: participant.id,
            map_id: map.id,
            pp: bestPP,
            score_id: bestScoreId,
          });
        }

        totalPP += bestPP;
      }

      // 4️⃣ Обновляем общий PP в таблице участников
      await supabase
        .from("pool_participants")
        .update({ total_pp: totalPP })
        .eq("id", participant.id);

      console.log(`✅ ${participant.nickname} обновлён (totalPP: ${totalPP.toFixed(2)})`);
    }

    console.log("Обновление PP завершено!");
  } catch (err) {
    console.error("Ошибка в updatePoolPP:", err);
  }
}



// CRON: каждый день в 00:01 Moscow time, но выполняется только каждые 2 дня от 2025-10-20 (0,2,4...)
cron.schedule("1 0 * * *", async () => {
  const startDate = new Date("2025-10-20T00:00:00+03:00"); // стартовый день (включая)
  const today = new Date();
  today.setHours(0, 0, 0, 0); // только дата

  const diffDays = Math.floor((today - startDate) / (1000 * 60 * 60 * 24));

  // Запускаем только по чётным дням (0,2,4...) и не раньше старта
  if (diffDays < 0 || diffDays % 2 !== 0) {
    console.log(`⏭️ CRON пропущен: ${today.toISOString().split('T')[0]} (diffDays=${diffDays})`);
    return;
  }

  console.log(`🚀 CRON запущен: день ${diffDays} от 2025-10-20`);

  // Объявляем переменную token один раз и используем везде
  let token = null;

  try {
    // =========================
    // 1) Сохранение истории пула
    // =========================
    console.log("=== Сохранение истории пула ===");

    const { data: participants, error: pErr } = await supabase
      .from("pool_participants")
      .select("*")
      .order("total_pp", { ascending: false });

    if (pErr) throw pErr;

    if (!participants || participants.length === 0) {
      console.log("Нет участников для сохранения истории.");
    } else {
      // Получаем все строки player_scores с подключенным pool_maps (включаем score_id)
      const { data: allMaps, error: mapsErr } = await supabase
        .from("player_scores")
        .select(`
          id,
          score_id,
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

      // Проходим по участникам и формируем запись истории
      for (const [index, p] of participants.entries()) {
        const scores = (allMaps || []).filter(s => s.participant_id === p.id);

        const formattedScores = (scores || []).map(s => ({
          pp: Number(s.pp) || 0,
          map_id: s.map_id,
          score_id: s.score_id || null,
          difficulty_id: s.pool_maps?.difficulty_id || null,
          beatmap_id: s.pool_maps?.beatmap_id || null,
          title: s.pool_maps?.title || null,
          map_url: s.pool_maps?.map_url || null,
          background_url: s.pool_maps?.background_url || null
        }));

        const { error: insertErr } = await supabase.from("pool_history").insert({
          tournament_date: today.toISOString().split("T")[0],
          position: index + 1,
          avatar_url: p.avatar || null,
          nickname: p.nickname || p.username || null,
          total_pp: p.total_pp || 0,
          scores: formattedScores
        });

        if (insertErr) {
          console.error(`Ошибка вставки истории для ${p.nickname || p.username || ('id:'+p.id)}:`, insertErr);
        } else {
          console.log(`✔ История добавлена для ${p.nickname || p.username || ('id:'+p.id)} (pos ${index + 1})`);
        }
      }
      console.log("✅ История пула успешно сохранена!");
    }

    // =========================
    // 2) Очистка таблиц пула и карт
    // =========================
    // У тебя выбран вариант A — очищаем всегда
    console.log("=== Очистка pool_participants, player_scores, pool_maps ===");
    const deletePoolParticipants = await supabase.from("pool_participants").delete().neq("id", 0);
    if (deletePoolParticipants.error) console.error("Ошибка очистки pool_participants:", deletePoolParticipants.error);

    const deletePlayerScores = await supabase.from("player_scores").delete().neq("id", 0);
    if (deletePlayerScores.error) console.error("Ошибка очистки player_scores:", deletePlayerScores.error);

    const deletePoolMaps = await supabase.from("pool_maps").delete().neq("id", 0);
    if (deletePoolMaps.error) console.error("Ошибка очистки pool_maps:", deletePoolMaps.error);

    console.log("Пул и карты очищены.");

    // =========================
    // 3) Перенос из test_pool_maps -> pool_maps
    // =========================
    try {
      console.log("=== Перемещение test_pool_maps -> pool_maps ===");
      const { data: rows, error: fetchError } = await supabase
        .from('test_pool_maps')
        .select('*');

      if (fetchError) throw fetchError;
      if (!rows || rows.length === 0) {
        console.log('Нет строк в test_pool_maps для перемещения');
      } else {
        const { error: insertError } = await supabase
          .from('pool_maps')
          .insert(rows);

        if (insertError) throw insertError;

        console.log(`✅ Перемещено ${rows.length} строк из test_pool_maps в pool_maps`);
      }
    } catch (err) {
      console.error('Ошибка перемещения test_pool_maps -> pool_maps:', err.message || err);
    }

  } catch (err) {
    console.error("Ошибка в CRON (сохранение истории/очистка/перенос):", err.response?.data || err.message || err);
  }

  // =========================
  // 4) Синхронизация и обновление рейтинга (вне основного блока, чтобы не прервать генерацию карт)
  // =========================
  try {
    console.log('Начато обновление статистики для игроков');
    await syncPlayersFromHistories().catch(e => console.error("syncPlayersFromHistories error:", e));
    await updateEloFromHistory().catch(e => console.error("updateEloFromHistory error:", e));
  } catch (err) {
    console.error("Ошибка при синхронизации/обновлении Elo:", err.message || err);
  }

  // =========================
  // 5) Генерация нового пула карт (test_pool_maps)
  // =========================
  try {
    console.log("=== Генерация пула карт (test_pool_maps) ===");

    // всегда получаем токен перед генерацией (один раз)
    token = await getOsuAccessToken();
    if (!token) {
      console.error('❌ Не удалось получить osu! токен, генерация пула остановлена');
      return;
    }

    // Очистка test_pool_maps (вариант A — всегда)
    try {
      const { data: deletedData, error: deleteError } = await supabase
        .from('test_pool_maps')
        .delete()
        .neq('id', 0);

      if (deleteError) {
        console.error('Ошибка очистки test_pool_maps перед генерацией:', deleteError);
      } else {
        console.log(`✅ Очищено ${Array.isArray(deletedData) ? deletedData.length : 0} записей в test_pool_maps`);
      }
    } catch (err) {
      console.error('Ошибка при очистке test_pool_maps:', err.message || err);
    }

    let count = 0;
    let attempts = 0;
    const maxAttempts = 10000;

    while (count < 5 && attempts < maxAttempts) {
      attempts++;
      const randomSetId = Math.floor(Math.random() * 2300000) + 1;

      try {
        const resApi = await axios.get(`https://osu.ppy.sh/api/v2/beatmapsets/${randomSetId}`, {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 10000
        });

        const set = resApi.data;
        if (!set || !set.beatmaps || !Array.isArray(set.beatmaps)) {
          console.warn(`⚠️ Сет ${randomSetId} не содержит валидных beatmaps, пропускаем`);
          continue;
        }

        if (set.status !== "ranked") {
          // не ранкнутые — пропускаем
          continue;
        }

        const validDiffs = set.beatmaps.filter(
          bm => bm.mode === "osu" &&
                typeof bm.difficulty_rating === "number" &&
                bm.difficulty_rating >= 6 && bm.difficulty_rating <= 8
        );

        if (validDiffs.length === 0) continue;

        const map = validDiffs[Math.floor(Math.random() * validDiffs.length)];

        const insertData = {
          beatmap_id: set.id || null,
          difficulty_id: map.id || null,
          title: `${set.title || "Unnamed"} [${map.version || "Unknown"}]`,
          background_url: set.covers?.cover || null,
          map_url: `https://osu.ppy.sh/beatmaps/${map.id || 0}`
        };

        // Вставляем карту и сразу получаем данные вставки
        const { error: insertError, data: insertedData } = await supabase
          .from("test_pool_maps")
          .insert([insertData])
          .select();

        if (insertError) {
          console.error(`❌ Ошибка вставки карты ${map.id}:`, insertError);
          continue;
        }

        if (Array.isArray(insertedData) && insertedData.length > 0) {
          console.log(`🎵 Успешно добавлена карта: ${insertedData[0].title} (id: ${insertedData[0].id})`);
          count++;
        } else {
          console.warn(`⚠️ Вставка карты ${map.id} не вернула данные, но ошибки нет`);
        }

      } catch (err) {
        // безопасный вывод ошибки
        console.warn(`Пропущен сет ${randomSetId}:`, err.response?.status ? `${err.response.status} ${err.response.statusText}` : (err.message || err));
        // если rate limit — ждем 5 сек
        if (err.response?.status === 429) {
          console.log("⏳ Rate limit, пауза 5 сек...");
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
        continue;
      }
    }

    // Проверим записи в базе после генерации
    const { data: generatedMaps, error: fetchError } = await supabase
      .from('test_pool_maps')
      .select('*');

    if (fetchError) {
      console.error('Ошибка при получении данных из test_pool_maps:', fetchError);
    } else {
      console.log(`✅ Сгенерировано ${count}/5 карт, в базе: ${generatedMaps.length} записей`);
    }

  } catch (err) {
    console.error('❌ Ошибка в процессе генерации пула карт:', err.message || err);
  }

}, { timezone: "Europe/Moscow" });

app.get("/run-cron-manual", async (req, res) => {
  console.log("🚀 Ручной запуск CRON...");

  const startDate = new Date("2025-10-20T00:00:00+03:00");
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const diffDays = Math.floor((today - startDate) / (1000 * 60 * 60 * 24));

  console.log(`📅 diffDays=${diffDays}`);

  let token = null;

  try {
    // =========================
    // 1) Сохранение истории пула
    // =========================
    const { data: participants, error: pErr } = await supabase
      .from("pool_participants")
      .select("*")
      .order("total_pp", { ascending: false });

    if (pErr) throw pErr;

    if (participants && participants.length > 0) {
      const { data: allMaps, error: mapsErr } = await supabase
        .from("player_scores")
        .select(`
          id,
          score_id,
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

      for (const [index, p] of participants.entries()) {
        const scores = (allMaps || []).filter(s => s.participant_id === p.id);

        const formattedScores = scores.map(s => ({
          pp: Number(s.pp) || 0,
          map_id: s.map_id,
          score_id: s.score_id || null,
          difficulty_id: s.pool_maps?.difficulty_id || null,
          beatmap_id: s.pool_maps?.beatmap_id || null,
          title: s.pool_maps?.title || null,
          map_url: s.pool_maps?.map_url || null,
          background_url: s.pool_maps?.background_url || null
        }));

        await supabase.from("pool_history").insert({
          tournament_date: today.toISOString().split("T")[0],
          position: index + 1,
          avatar_url: p.avatar || null,
          nickname: p.nickname || p.username || null,
          total_pp: p.total_pp || 0,
          scores: formattedScores
        });
      }
    }

    // =========================
    // 2) Очистка таблиц
    // =========================
    await supabase.from("pool_participants").delete().neq("id", 0);
    await supabase.from("player_scores").delete().neq("id", 0);
    await supabase.from("pool_maps").delete().neq("id", 0);

    // =========================
    // 3) Перенос test_pool_maps -> pool_maps
    // =========================
    const { data: rows } = await supabase
      .from("test_pool_maps")
      .select("*");

    if (rows && rows.length > 0) {
      await supabase.from("pool_maps").insert(rows);
    }

    // =========================
    // 4) Обновление статистики
    // =========================
    await syncPlayersFromHistories();
    await updateEloFromHistory();

    // =========================
    // 5) Генерация нового пула
    // =========================
    token = await getOsuAccessToken();
    if (!token) throw new Error("Не удалось получить osu токен");

    await supabase.from("test_pool_maps").delete().neq("id", 0);

    let count = 0;
    let attempts = 0;

    while (count < 5 && attempts < 10000) {
      attempts++;
      const randomSetId = Math.floor(Math.random() * 2300000) + 1;

      try {
        const resApi = await axios.get(
          `https://osu.ppy.sh/api/v2/beatmapsets/${randomSetId}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );

        const set = resApi.data;
        if (!set?.beatmaps || set.status !== "ranked") continue;

        const validDiffs = set.beatmaps.filter(
          bm => bm.mode === "osu" &&
                bm.difficulty_rating >= 6 &&
                bm.difficulty_rating <= 8
        );

        if (!validDiffs.length) continue;

        const map = validDiffs[Math.floor(Math.random() * validDiffs.length)];

        await supabase.from("test_pool_maps").insert({
          beatmap_id: set.id,
          difficulty_id: map.id,
          title: `${set.title} [${map.version}]`,
          background_url: set.covers?.cover || null,
          map_url: `https://osu.ppy.sh/beatmaps/${map.id}`
        });

        count++;

      } catch (err) {
        if (err.response?.status === 429) {
          await new Promise(r => setTimeout(r, 5000));
        }
      }
    }

    res.json({
      success: true,
      message: "CRON выполнен вручную",
      generated_maps: count
    });

  } catch (err) {
    console.error("Ошибка ручного CRON:", err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});
// === ИСПРАВЛЕННЫЙ РОУТ ДЛЯ ПЕРЕСЧЕТА ПОБЕД ===


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
          score_id,
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
  // Сохраняем текущий URL в сессии
  req.session.returnTo = req.headers.referer || '/';
  const authUrl = `https://osu.ppy.sh/oauth/authorize?client_id=${osuClientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=public&state=${encodeURIComponent(JSON.stringify({ type: 'main', returnTo: req.session.returnTo }))}`;
  res.redirect(authUrl);
});

app.get('/pool/auth/login', (req, res) => {
  // Сохраняем текущий URL в сессии
  req.session.returnTo = req.headers.referer || '/pool';
  const authUrl = `https://osu.ppy.sh/oauth/authorize?client_id=${osuClientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=public&state=${encodeURIComponent(JSON.stringify({ type: 'pool', returnTo: req.session.returnTo }))}`;
  res.redirect(authUrl);
});

app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  const state = req.query.state ? JSON.parse(decodeURIComponent(req.query.state)) : { type: 'main', returnTo: '/' };

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

    // Редирект на сохранённый URL или по умолчанию
    const redirectTo = state.returnTo || (state.type === 'pool' ? '/pool' : '/');
    res.redirect(redirectTo);
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).send('Authorization error');
  }
});

app.get('/api/profile/:userid', async (req, res) => {
  const { userid } = req.params;
  const cacheKey = `profile_${userid}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return res.json(cached);
  }

  try {
    // Параллельные запросы к Supabase и osu! API
    const [playerRes, osuRes] = await Promise.all([
      supabase.from('players').select('*').eq('userid', userid).single(),
      axios.get(`https://osu.ppy.sh/api/v2/users/${userid}/osu`, {
        headers: { Authorization: `Bearer ${await getOsuAccessToken()}` },
      }).catch(err => {
        console.warn(`Osu API error for user ${userid}:`, err.message);
        return { data: { statistics: { pp: null }, country: { name: 'N/A' }, join_date: null } }; // Fallback на null данные
      }),
    ]);

    const player = playerRes.data;
    if (playerRes.error || !player) {
      return res.status(404).json({ error: 'Player not found' });
    }

    const osuData = osuRes.data;

    // История PP Cup из history
    const { data: ppHistoryRaw } = await supabase
      .from('history')
      .select('date, data')
      .order('date', { ascending: false });
    const ppHistory = ppHistoryRaw.reduce((acc, row) => {
      const userEntry = (row.data || []).find(p => 
        p.userid === Number(userid) || 
        p.userid == userid || 
        p.nickname === player.nickname
      );
      if (userEntry) {
        acc.push({
          date: row.date,
          position: userEntry.position,
          points: userEntry.points,
          elo_after: userEntry.elo_after || 'N/A',
        });
      }
      return acc;
    }, []);

    // История Pool Cup
    const { data: poolHistoryRaw, error: poolErr } = await supabase
      .from('pool_history')
      .select('*')
      .order('tournament_date', { ascending: false });
    const poolHistory = poolErr
      ? []
      : poolHistoryRaw
          .filter(entry => 
            entry.userid == userid || 
            entry.userid === userid.toString() || 
            entry.nickname === player.nickname
          )
          .map(entry => ({
            tournament_date: entry.tournament_date,
            position: entry.position,
            total_pp: entry.total_pp,
            elo_after: entry.elo_after || 'N/A',
          }));

    // Формируем и кэшируем ответ
    const response = {
      ...player,
      current_pp: osuData.statistics?.pp || player.current_pp || 0, // Fallback на локальное значение
      playcount: osuData.statistics?.play_count || player.playcount || 0,
      country: osuData.country?.name || 'N/A',
      join_date: osuData.join_date || player.join_date || null,
      pp_history: ppHistory,
      pool_history: poolHistory,
    };
    cache.set(cacheKey, response);

    res.json(response);
  } catch (err) {
    console.error('/api/profile error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// Эндпоинт для списка игроков
async function getOsuUser(userId, token) {
  const res = await fetch(`https://osu.ppy.sh/api/v2/users/${userId}/osu`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) return null;
  return res.json();
}

const pLimit = require('p-limit');
// ========== Обновление current_pp всех игроков (с логированием и повторами) ==========
async function updateAllPlayersPP() {
  console.log('🔄 Запуск обновления current_pp для всех игроков...');
  
  try {
    // Получаем всех игроков из БД
    const { data: players, error } = await supabase.from('players').select('userid');
    if (error) throw error;
    if (!players || players.length === 0) {
      console.log('❌ Нет игроков для обновления.');
      return;
    }
    console.log(`👥 Найдено игроков: ${players.length}`);

    const token = await getOsuAccessToken();
    if (!token) {
      console.error('❌ Не удалось получить токен osu! API');
      return;
    }

    const CONCURRENT = 5; // не более 5 одновременных запросов
    let updated = 0;
    let failed = 0;

    // Разбиваем на пачки по CONCURRENT
    for (let i = 0; i < players.length; i += CONCURRENT) {
      const batch = players.slice(i, i + CONCURRENT);
      
      await Promise.allSettled(batch.map(async (player) => {
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            console.log(`🔄 [попытка ${attempt}] Запрос для ${player.userid}...`);
            
            const osuRes = await axios.get(`https://osu.ppy.sh/api/v2/users/${player.userid}/osu`, {
              headers: { Authorization: `Bearer ${token}` },
              timeout: 8000
            });

            // Логируем первые 200 символов ответа
            console.log(`📦 Ответ для ${player.userid}:`, JSON.stringify(osuRes.data).substring(0, 200) + '...');

            const currentPP = osuRes.data.statistics?.pp;
            if (currentPP === undefined || currentPP === null) {
              console.warn(`⚠️ У игрока ${player.userid} нет поля statistics.pp в ответе`);
              failed++;
              return;
            }

            console.log(`📊 PP для ${player.userid}: ${currentPP}`);

            // Обновляем в БД и сразу получаем обновлённую запись
            const { data, error: updateError } = await supabase
              .from('players')
              .update({ current_pp: currentPP })
              .eq('userid', player.userid)
              .select('userid, current_pp');

            if (updateError) {
              console.error(`❌ Ошибка БД для ${player.userid}:`, updateError);
              failed++;
              return;
            }

            if (data && data.length > 0) {
              console.log(`✅ Игрок ${player.userid} обновлён: current_pp = ${data[0].current_pp}`);
              updated++;
            } else {
              console.warn(`⚠️ Игрок ${player.userid} не найден или не обновлён`);
              failed++;
            }

            return; // успешно – выходим

          } catch (err) {
            console.warn(`⚠️ Ошибка загрузки профиля для ${player.userid} (попытка ${attempt}):`, err.message);
            if (attempt === 2) {
              failed++;
            } else {
              await new Promise(resolve => setTimeout(resolve, 1000)); // пауза перед повтором
            }
          }
        }
      }));

      // Небольшая пауза между пачками, чтобы снизить нагрузку
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log(`✅ Обновление завершено: успешно ${updated}, ошибок ${failed}`);
  } catch (err) {
    console.error('❌ Ошибка в updateAllPlayersPP:', err);
  }
}

// Запускаем каждый час в 0 минут (можно изменить интервал)
cron.schedule('0 * * * *', () => {
  updateAllPlayersPP();
}, { timezone: 'Europe/Moscow' });

// Также можно запустить сразу при старте (но с задержкой)
setTimeout(() => {
  updateAllPlayersPP();
}, 10 * 1000);
app.get('/api/players', async (req, res) => {
  try {
    const all = req.query.all === 'true';
    let query = supabase.from('players').select('*', { count: 'exact' });

    if (!all) {
      const page = parseInt(req.query.page) || 1;
      const limitRows = 8;
      const from = (page - 1) * limitRows;
      const to = from + limitRows - 1;
      query = query.range(from, to);
    }

    const { data: players, error, count } = await query;
    if (error) throw error;

    if (all) {
      res.json(players);
    } else {
      res.json({
        players,
        currentPage: page,
        totalPages: Math.ceil((count || 0) / limitRows),
        totalPlayers: count || 0
      });
    }
  } catch (err) {
    console.error('Ошибка загрузки игроков:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
app.get('/api/update-pp', async (req, res) => {
  await updateAllPlayersPP();
  res.json({ message: 'Update triggered' });
});

    
app.get('/players', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'players.html'));
  
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error(err);
      return res.status(500).send('Ошибка выхода');
    }
    // Редирект на текущую страницу (referer) или корень, если referer отсутствует
    const redirectTo = req.headers.referer || '/';
    res.redirect(redirectTo);
  });
});

// === Участие основного турнира ===
app.post('/api/pool/participate', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Необходимо авторизоваться!' });

  const user = req.session.user;

  try {
    // 1) Проверяем, есть ли участник в таблице
    const { data: existing, error: checkError } = await supabase
      .from("pool_participants")
      .select("id")
      .eq("userid", user.id)
      .single();

    if (checkError && checkError.code !== 'PGRST116') throw checkError; // PGRST116 = нет записи

    if (existing) {
      // Участник уже есть
      return res.status(400).json({ error: "Вы уже участвуете!" });
    }

    // 2) Вставляем нового участника
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

    // 3) Получаем все карты пула
    const { data: pool, error: poolError } = await supabase
      .from("pool_maps")
      .select("id");

    if (poolError) throw poolError;

    // 4) Создаём записи для карт
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

app.post('/api/unparticipate', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  const user = req.session.user;

  const { error } = await supabase.from("participants").delete().eq("userid", user.id);
  if (error) return res.status(500).json({ error: error.message });

  // пересчитаем позиции после удаления
  await updatePositionsInDB();

  res.json({ success: true });
});

// === ФУНКЦИИ ELO (оставляем для новых турниров) ===
async function updateEloFromHistory() {
  try {
    // Шаг 1: Загружаем все истории PP Cup (history)
    const { data: ppHistoryRaw, error: ppErr } = await supabase
      .from('history')
      .select('date, data')
      .order('date', { ascending: true });

    if (ppErr) {
      console.error('Ошибка загрузки PP history:', ppErr);
      return;
    }

    // Шаг 2: Загружаем все истории Pool Cup (pool_history)
    const { data: poolHistoryRaw, error: poolErr } = await supabase
      .from('pool_history')
      .select('*')
      .order('tournament_date', { ascending: true });

    if (poolErr) {
      console.error('Ошибка загрузки Pool history:', poolErr);
      return;
    }

    // Шаг 3: Загружаем всех игроков из players для текущих ELO/статистики
    const { data: allPlayers, error: playersErr } = await supabase.from('players').select('*');
    if (playersErr) {
      console.error('Ошибка загрузки players:', playersErr);
      return;
    }
    const playerMap = new Map(allPlayers.map(p => [p.userid.toString(), p]));

    // Шаг 4: Обрабатываем PP Cup турниры
    for (const tournament of ppHistoryRaw) {
      const participants = tournament.data || [];
      if (!participants.length) {
        console.log(`PP турнир ${tournament.date} пуст, пропускаем`);
        continue;
      }

      console.log(`Обрабатываем PP турнир ${tournament.date}`);

      // Фильтруем участников с валидными userid и points
      const validParticipants = participants
        .filter(p => p.userid && Number.isFinite(parseFloat(p.points)))
        .map(p => ({
          ...p,
          userid: p.userid.toString(), // Приводим к строке для консистентности
          points: parseFloat(p.points),
          position: parseInt(p.position) || Infinity,
        }));

      if (!validParticipants.length) {
        console.log(`Нет валидных участников в PP турнире ${tournament.date}, пропускаем`);
        continue;
      }

      // Рассчитываем ELO
      const eloMap = await calculateEloForTournament('pp', validParticipants, playerMap);

      // Обновляем elo_after для всех участников
      const updatedParticipants = participants.map(p => {
        if (!p.userid || !eloMap.has(p.userid.toString())) {
          return p; // Пропускаем участников без userid или ELO
        }
        return {
          ...p,
          elo_after: eloMap.get(p.userid.toString()),
        };
      });

      // Сохраняем обновленный data обратно в history
      const { error: updateErr } = await supabase
        .from('history')
        .update({ data: updatedParticipants })
        .eq('date', tournament.date);

      if (updateErr) {
        console.error(`Ошибка обновления PP турнира ${tournament.date}:`, updateErr);
        continue;
      }

      await updatePlayersFromTournament('pp', validParticipants, eloMap, playerMap);
      console.log(`✅ PP турнир ${tournament.date} обработан, обновлено ${eloMap.size} ELO`);
    }

    // Шаг 5: Группируем pool_history по датам
    const poolTournaments = new Map();
    for (const entry of poolHistoryRaw) {
      const date = entry.tournament_date;
      if (!poolTournaments.has(date)) poolTournaments.set(date, []);
      poolTournaments.get(date).push(entry);
    }

    for (const [date, participants] of poolTournaments) {
      console.log(`Обрабатываем Pool турнир ${date}`);

      // Фильтруем участников с валидными userid и total_pp
      const validParticipants = participants
        .filter(p => p.userid && Number.isFinite(parseFloat(p.total_pp)))
        .map(p => ({
          ...p,
          userid: p.userid.toString(), // Приводим к строке
          total_pp: parseFloat(p.total_pp),
          position: parseInt(p.position) || Infinity,
        }));

      if (!validParticipants.length) {
        console.log(`Нет валидных участников в Pool турнире ${date}, пропускаем`);
        continue;
      }

      // Рассчитываем ELO
      const eloMap = await calculateEloForTournament('pool', validParticipants, playerMap);

      // Обновляем elo_after в pool_history
      for (const p of validParticipants) {
        const { error: updateErr } = await supabase
          .from('pool_history')
          .update({ elo_after: eloMap.get(p.userid) })
          .eq('id', p.id);

        if (updateErr) {
          console.error(`Ошибка обновления ELO для ${p.nickname} в Pool турнире ${date}:`, updateErr);
        }
      }

      await updatePlayersFromTournament('pool', validParticipants, eloMap, playerMap);
      console.log(`✅ Pool турнир ${date} обработан, обновлено ${eloMap.size} ELO`);
    }

    // Шаг 6: Финальная проверка и исправление статистик
    console.log('Пересчитываем статистику для всех игроков...');
    await verifyAndFixPlayerStats([...playerMap.keys()]);

    console.log('✅ ELO и статистика обновлены для всех турниров');
  } catch (err) {
    console.error('Ошибка в updateEloFromHistory:', err);
  }
}

// Вспомогательная: Расчет ELO для одного турнира
async function calculateEloForTournament(type, participants, playerMap) {
  const eloField = type === 'pp' ? 'elo_pp_cup' : 'elo_pool_cup';
  const K = 32; // Уменьшаем K для более плавных изменений рейтинга
  const newEloMap = new Map();

  // Сортируем участников по очкам или позиции для определения относительных результатов
  const sortedParticipants = [...participants].sort((a, b) => {
    const scoreA = type === 'pp' ? a.points : a.total_pp;
    const scoreB = type === 'pp' ? b.points : b.total_pp;
    return scoreB - scoreA || a.position - b.position; // Сначала по очкам, потом по позиции
  });

  for (let i = 0; i < sortedParticipants.length; i++) {
    const playerA = sortedParticipants[i];
    const playerId = playerA.userid.toString();
    const currentPlayer = playerMap.get(playerId) || { [eloField]: 1000 };
    let currentEloA = parseFloat(currentPlayer[eloField]) || 1000;
    let delta = 0;

    for (let j = 0; j < sortedParticipants.length; j++) {
      if (i === j) continue;
      const playerB = sortedParticipants[j];
      const playerBId = playerB.userid.toString();
      const eloB = parseFloat(playerMap.get(playerBId)?.[eloField]) || 1000;

      // Ожидаемая вероятность победы
      const E_a = 1 / (1 + Math.pow(10, (eloB - currentEloA) / 400));

      // Реальный результат: 1 (победа), 0.5 (ничья), 0 (поражение)
      const scoreA = type === 'pp' ? (playerA.points || 0) : (playerA.total_pp || 0);
      const scoreB = type === 'pp' ? (playerB.points || 0) : (playerB.total_pp || 0);
      const S_a = scoreA > scoreB ? 1 : scoreA === scoreB ? 0.5 : 0;

      delta += K * (S_a - E_a);
    }

    // Усредняем изменение рейтинга
    const newElo = Math.round(currentEloA + delta / Math.max(1, sortedParticipants.length - 1));
    newEloMap.set(playerId, Math.max(100, newElo)); // Ограничиваем минимальный ELO
  }

  return newEloMap;
}

// Вспомогательная: Обновление players из турнира
async function updatePlayersFromTournament(type, participants, eloMap, playerMap) {
  const eloField = type === 'pp' ? 'elo_pp_cup' : 'elo_pool_cup';
  const participationsField = type === 'pp' ? 'total_participations_pp' : 'total_participations_pool';
  const totalScoreField = type === 'pp' ? 'total_points_pp' : 'total_pp_pool';
  const bestPosField = type === 'pp' ? 'best_position_pp' : 'best_position_pool';
  const winsField = type === 'pp' ? 'wins_pp' : 'wins_pool';

  const updates = participants.map(playerA => {
    const playerId = playerA.userid.toString();
    const currentPlayer = playerMap.get(playerId) || {
      [participationsField]: 0,
      [totalScoreField]: 0,
      [bestPosField]: null,
      [winsField]: 0,
      nickname: playerA.nickname || 'Unknown',
      avatar_url: playerA.avatar_url || playerA.avatar || null,
      userid: playerId,
    };

    const score = type === 'pp' ? (playerA.points || 0) : (playerA.total_pp || 0);
    const newParticipations = (currentPlayer[participationsField] || 0) + 1;
    const newTotalScore = (currentPlayer[totalScoreField] || 0) + score;
    const newBestPos = currentPlayer[bestPosField]
      ? Math.min(currentPlayer[bestPosField], playerA.position || Infinity)
      : playerA.position;
    const newWins = (currentPlayer[winsField] || 0) + (playerA.position === 1 ? 1 : 0);
    const newElo = eloMap.get(playerId);

    return {
      userid: playerId,
      nickname: currentPlayer.nickname,
      avatar_url: currentPlayer.avatar_url,
      [eloField]: newElo,
      [participationsField]: newParticipations,
      [totalScoreField]: type === 'pp' ? Math.round(newTotalScore) : newTotalScore, // Не округляем для Pool
      [bestPosField]: Number.isFinite(newBestPos) ? newBestPos : null,
      [winsField]: newWins,
    };
  });

  const { error } = await supabase.from('players').upsert(updates, { onConflict: 'userid' });
  if (error) {
    console.error(`Ошибка массового обновления players для ${type}:`, error);
  }

  // Обновляем playerMap
  updates.forEach(update => {
    playerMap.set(update.userid, update);
  });
}
async function syncPlayersFromHistories() {
  try {
    console.log('🔄 Начинаем синхронизацию игроков...');

    // --- 1. Загружаем данные из history (PP капы)
    const { data: historyRows, error: histErr } = await supabase.from('history').select('data');
    if (histErr) throw histErr;

    const idsFromHistory = new Set();
    const nicksFromHistory = new Set();

    (historyRows || []).forEach(row => {
      const data = row?.data;
      if (!Array.isArray(data)) return;
      data.forEach(p => {
        const id = Number(p.userid || p.user_id || p.id);
        const nick = (p.nickname || p.username || '').trim();
        if (id && !Number.isNaN(id)) idsFromHistory.add(id);
        if (nick) nicksFromHistory.add(nick.toLowerCase());
      });
    });

    // --- 2. Загружаем данные из pool_history (Pool капы)
    const { data: poolRows, error: poolErr } = await supabase
      .from('pool_history')
      .select('nickname, avatar_url');
    if (poolErr) throw poolErr;

    const nicksFromPool = new Map();
    (poolRows || []).forEach(p => {
      const nick = (p.nickname || '').trim();
      if (nick) {
        nicksFromPool.set(nick.toLowerCase(), p.avatar_url || null);
      }
    });

    // --- 3. Загружаем существующих игроков
    const { data: existingPlayers, error: existErr } = await supabase
      .from('players')
      .select('userid, nickname');
    if (existErr) throw existErr;

    const existingIds = new Set(existingPlayers.map(p => Number(p.userid)));
    const existingNicks = new Set(
      existingPlayers.map(p => (p.nickname || '').trim().toLowerCase())
    );

    // --- 4. Определяем недостающих
    const missingIds = [...idsFromHistory].filter(id => !existingIds.has(id));
    const missingNicknames = [
      ...new Set([...nicksFromHistory, ...nicksFromPool.keys()]),
    ].filter(n => !existingNicks.has(n));

    console.log(
      `📊 Найдено ${missingIds.length} отсутствующих по ID и ${missingNicknames.length} по nickname`
    );

    // --- 5. Создаём игроков для вставки
    const playersToInsert = [];
    const token = await getOsuAccessToken();

    // Сначала — по ID (PP кап)
    for (const id of missingIds) {
      try {
        const res = await axios.get(`https://osu.ppy.sh/api/v2/users/${id}/osu`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const u = res.data;
        playersToInsert.push({
          userid: Number(u.id),
          nickname: u.username,
          avatar_url: u.avatar_url || null,
          elo_pp_cup: 1000,
          elo_pool_cup: 1000,
        });
      } catch (err) {
        console.warn(`⚠️ Не удалось получить osu профиль для ID ${id}, создаём по заглушке`);
        playersToInsert.push({
          userid: Number(id),
          nickname: `Player_${id}`,
          avatar_url: null,
          elo_pp_cup: 1000,
          elo_pool_cup: 1000,
        });
      }
    }

    // Теперь — по nickname (Pool кап)
    for (const nick of missingNicknames) {
      if (playersToInsert.find(p => p.nickname.toLowerCase() === nick)) continue;

      try {
        const res = await axios.get(
          `https://osu.ppy.sh/api/v2/users/${encodeURIComponent(nick)}/osu`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const u = res.data;
        playersToInsert.push({
          userid: Number(u.id),
          nickname: u.username,
          avatar_url: u.avatar_url || nicksFromPool.get(nick) || null,
          elo_pp_cup: 1000,
          elo_pool_cup: 1000,
        });
      } catch {
        // создаём временного игрока без userid
        const fakeId =
          Math.abs(nick.split('').reduce((a, b) => a * 31 + b.charCodeAt(0), 7)) +
          Date.now() % 10000;
        playersToInsert.push({
          userid: fakeId,
          nickname: nick,
          avatar_url: nicksFromPool.get(nick) || null,
          elo_pp_cup: 1000,
          elo_pool_cup: 1000,
        });
        console.warn(`⚠️ Игрок "${nick}" не найден в osu API — создан локально (id=${fakeId})`);
      }
    }

    // --- 6. Удаляем дубликаты
    const seen = new Set();
    const uniquePlayers = playersToInsert.filter(p => {
      if (seen.has(p.userid)) return false;
      seen.add(p.userid);
      return true;
    });

    // --- 7. Вставляем в БД
    if (uniquePlayers.length) {
      const { error: insErr } = await supabase
        .from('players')
        .upsert(uniquePlayers, { onConflict: 'userid' });
      if (insErr) throw insErr;

      console.log(`✅ Добавлено/обновлено игроков: ${uniquePlayers.length}`);
    } else {
      console.log('✅ Все игроки уже есть в базе.');
    }

    return {
      ok: true,
      inserted: uniquePlayers.length,
      missingById: missingIds.length,
      missingByNickname: missingNicknames.length,
    };
  } catch (err) {
    console.error('❌ Ошибка syncPlayersFromHistories:', err);
    return { ok: false, error: err.message || err.toString() };
  }
}



app.get('/profile/:userid', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'profile.html'));
});



// === Запуск сервера ===
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  // При запуске сервера делаем принудительный пересчет статистики
  setTimeout(() => {
    console.log('🚀 Инициализация статистики при запуске...');
    verifyAndFixPlayerStats();
  }, 5000);
});