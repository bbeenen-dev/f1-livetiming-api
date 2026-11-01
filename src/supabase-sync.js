const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.log('[Sync] Supabase credentials ontbreken in Render Environment Variables. Sync staat uit.');
}

const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

// Dynamische poort ophalen zodat deze exact matcht met Render (bijv. poort 10000 of 3000)
const PORT = process.env.PORT || 3000;
const API_URL = `http://localhost:${PORT}/api/standings`;

/**
 * Bepaalt automatisch welk `id` uit jouw `races` tabel vandaag actief is.
 * Kijkt naar races waarvan `race_start` op de huidige kalenderdag valt.
 */
async function getActiveRaceId() {
  if (!supabase) return null;

  try {
    const now = new Date();
    // Bepaal de grenzen van vandaag in UTC
    const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0)).toISOString();
    const endOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59)).toISOString();

    const { data, error } = await supabase
      .from('races')
      .select('id, race_name')
      .gte('race_start', startOfToday)
      .lte('race_start', endOfToday)
      .limit(1);

    if (!error && data && data.length > 0) {
      return data[0].id; // Retourneert het ID van de race die vandaag plaatsvindt (bijv. 20)
    }
  } catch (err) {
    console.error('[Sync] Fout bij bepalen actieve race:', err.message);
  }

  return null;
}

async function syncDataToSupabase() {
  if (!supabase) return;

  try {
    const response = await fetch(API_URL);
    if (!response.ok) return;

    const data = await response.json();
    if (!data || !data.Leaderboard) return;

    // 1. Bouw een lookup map van live posities op basis van TLA (bijv. { "VER": 1, "NOR": 4, ... })
    const livePositionsByTla = {};

    for (const driverNumber of data.Leaderboard) {
      const driver = data.Lines[driverNumber];
      if (!driver) continue;

      const positionInt = parseInt(driver.Position);
      const tla = driver.Tla;

      if (tla && !isNaN(positionInt)) {
        livePositionsByTla[tla] = positionInt;
      }

      const positionData = {
        driver_number: parseInt(driver.RacingNumber || driverNumber),
        position: positionInt,
        full_name: driver.FullName || 'Onbekend',
        team_name: driver.TeamName || 'Onbekend',
        gap_to_leader: driver.GapToLeader?.Value || (driver.Position === "1" ? "LEADER" : ""),
        updated_at: new Date().toISOString()
      };

      await supabase
        .from('actual_standings')
        .upsert(positionData, { onConflict: ['driver_number'] });
    }

    // 2. Bepaal welke race er VANDAAG op het programma staat
    const activeRaceId = await getActiveRaceId();

    // Alleen punten berekenen als er vandaag daadwerkelijk een race is
    if (activeRaceId) {
      const { data: predictions, error: predError } = await supabase
        .from('predictions_race')
        .select('*')
        .eq('race_id', activeRaceId); // <--- FILTERT EXCLUSIEF OP DE ACTIEVE RACE VAN VANDAAG!

      if (!predError && predictions && predictions.length > 0) {
        for (const pred of predictions) {
          const userId = pred.user_id || pred.numberuser_id;
          const top10 = pred.top_10_drivers; // Array van TLA's: ["RUS", "ANT", ...]

          if (!userId || !Array.isArray(top10)) continue;

          let userPoints = 0;

          top10.forEach((predictedTla, index) => {
            const predictedPosition = index + 1;
            const actualPosition = livePositionsByTla[predictedTla];

            if (actualPosition !== undefined) {
              const diff = Math.abs(predictedPosition - actualPosition);

              if (diff === 0) {
                userPoints += 5; // Exact goed
              } else if (diff === 1) {
                userPoints += 2; // 1 plek ernaast
              }
            }
          });

          // Schrijf de punten weg naar `actual_scores` voor dit specifieke activeRaceId
          await supabase
            .from('actual_scores')
            .upsert({
              user_id: userId,
              race_id: activeRaceId,
              points: userPoints,
              updated_at: new Date().toISOString()
            }, { onConflict: 'user_id,race_id' });
        }
      }
    }
  } catch (err) {
    console.error('[Sync] Fout bij cloud-sync:', err.message);
  }
}

function startSupabaseSync() {
  if (supabase) {
    console.log('[Sync] Cloud Supabase sync worker gestart (inclusief actieve race filter)...');
    setInterval(syncDataToSupabase, 4000);
  }
}

module.exports = { startSupabaseSync };
