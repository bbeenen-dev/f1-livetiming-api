import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.log('Supabase credentials ontbreken in Render Environment Variables. Sync staat uit.');
}

const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;
const API_URL = 'http://localhost:3000/api/standings';

async function syncDataToSupabase() {
  if (!supabase) return;

  try {
    const response = await fetch(API_URL);
    if (!response.ok) return;

    const data = await response.json();
    if (!data || !data.Leaderboard) return;

    for (const driverNumber of data.Leaderboard) {
      const driver = data.Lines[driverNumber];
      if (!driver) continue;

      const positionData = {
        driver_number: parseInt(driver.RacingNumber || driverNumber),
        position: parseInt(driver.Position),
        full_name: driver.FullName || 'Onbekend',
        team_name: driver.TeamName || 'Onbekend',
        gap_to_leader: driver.GapToLeader?.Value || (driver.Position === "1" ? "LEADER" : ""),
        updated_at: new Date().toISOString()
      };

      await supabase
        .from('actual_standings')
        .upsert(positionData, { onConflict: ['driver_number'] });
    }
    console.log('F1 standen geüpdatet in Supabase!');
  } catch (err) {
    console.error('Fout bij cloud-sync:', err.message);
  }
}

export function startSupabaseSync() {
  if (supabase) {
    console.log('Cloud Supabase sync worker gestart...');
    setInterval(syncDataToSupabase, 4000);
  }
}
