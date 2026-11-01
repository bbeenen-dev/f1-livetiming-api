const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.log('[Sync] Supabase credentials ontbreken in Render Environment Variables. Sync staat uit.');
}

const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

const PORT = process.env.PORT || 3000;
const API_URL = `http://localhost:${PORT}/api/standings`;

/**
 * Bepaalt automatisch welk `id` actief is op basis van een tijdskader van 6 uur rondom nu.
 */
async function getActiveRaceId() {
  if (!supabase) return null;

  try {
    const now = new Date();
    // 6 uur terug en 6 uur vooruit vanaf nu
    const windowStart = new Date(now.getTime() - (6 * 60 * 60 * 1000)).toISOString();
    const windowEnd = new Date(now.getTime() + (6 * 60 * 60 * 1000)).toISOString();

    const { data, error } = await supabase
      .from('races')
      .select('id, race_name')
      .gte('race_start', windowStart)
      .lte('race_start', windowEnd)
      .limit(1);

    if (!error && data && data.length > 0) {
      return data[0].id; // Dit pakt nu direct ID 20 (Mexico)
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

    // 1. Live posities bijwerken in `actual_standings`
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

    // 2. Punten berekenen voor de actieve race
    const activeRaceId = await getActiveRaceId();

    if (activeRaceId) {
      const { data: predictions, error: predError } = await supabase
        .from('predictions_race')
        .select('*')
        .eq('race_id', activeRaceId);

      if (!predError && predictions && predictions.length > 0) {
        for (const pred of predictions) {
          const userId = pred.user_id || pred.numberuser_id;
          const top10 = pred.top_10_drivers;

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
    console.log('[Sync] Cloud Supabase sync worker gestart...');
    setInterval(syncDataToSupabase, 4000);
  }
}

module.exports = { startSupabaseSync };
