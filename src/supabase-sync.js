const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.log('Supabase credentials ontbreken in Render Environment Variables. Sync staat uit.');
}

const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

// Dynamische poort ophalen zodat deze exact matcht met Render (bijv. poort 10000)
const PORT = process.env.PORT || 3000;
const API_URL = `http://localhost:${PORT}/api/standings`;

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

    // 2. Bereken direct de punten voor alle gebruikersvoorspellingen (`predictions_race`)
    const { data: predictions, error: predError } = await supabase
      .from('predictions_race')
      .select('*');

    if (!predError && predictions && predictions.length > 0) {
      for (const pred of predictions) {
        const userId = pred.user_id || pred.numberuser_id;
        const raceId = pred.race_id;
        const top10 = pred.top_10_drivers; // Array van TLA's: ["RUS", "ANT", ...]

        if (!userId || !raceId || !Array.isArray(top10)) continue;

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

        // Schrijf weg naar `actual_scores`
        await supabase
          .from('actual_scores')
          .upsert({
            user_id: userId,
            race_id: raceId,
            points: userPoints,
            updated_at: new Date().toISOString()
          }, { onConflict: 'user_id,race_id' });
      }
    }

    console.log('[Sync] F1 standen en live scores geüpdatet in Supabase!');
  } catch (err) {
    console.error('[Sync] Fout bij cloud-sync:', err.message);
  }
}

function startSupabaseSync() {
  if (supabase) {
    console.log('[Sync] Cloud Supabase sync worker gestart (inclusief puntenberekening)...');
    setInterval(syncDataToSupabase, 4000);
  }
}

module.exports = { startSupabaseSync };
