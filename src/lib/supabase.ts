// ============================================================
// SUPABASE CLIENT
// ============================================================

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// ── Browser client (use in Client Components) ────────────────
export function createBrowserSupabaseClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

// ── Admin client — service role, bypasses RLS ────────────────
//
// Lazy Proxy: ``createClient`` is NOT called until first property access.
// Without this, ``next build`` crashes during the "Collecting page data"
// step because the constructor reads env vars at module-load time and
// they're empty in CI / fresh checkouts. The Proxy preserves the
// existing call-site syntax (``supabaseAdmin.from(...)``) at every
// existing import — no churn elsewhere.
//
// Methods accessed off the proxy are bound to the underlying client so
// ``this`` references stay correct inside the Supabase SDK.
let _admin: SupabaseClient | null = null;
function getAdminClient(): SupabaseClient {
  if (_admin) return _admin;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'Supabase admin client requested before env was configured. ' +
      'Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.'
    );
  }
  _admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return _admin;
}

export const supabaseAdmin = new Proxy({} as SupabaseClient, {
  get(_target, prop, _receiver) {
    const target = getAdminClient();
    const value = Reflect.get(target, prop);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

// ── League Helpers ───────────────────────────────────────────
export async function getLeagueBySlug(slug: string) {
  const { data, error } = await supabaseAdmin
    .from('leagues').select('*').eq('slug', slug).single();
  if (error) return null;
  return data;
}

export async function getLeagueMembers(leagueId: string) {
  const { data } = await supabaseAdmin
    .from('league_members').select('*, profile:profiles(*)').eq('league_id', leagueId);
  return data ?? [];
}

export async function getActiveTournament() {
  const { data } = await supabaseAdmin
    .from('tournaments').select('*')
    .in('status', ['active', 'cut_made'])
    .order('start_date', { ascending: true }).limit(1).single();
  return data;
}

export async function getUpcomingTournaments(limit = 5) {
  const { data } = await supabaseAdmin
    .from('tournaments').select('*').eq('status', 'upcoming')
    .order('start_date', { ascending: true }).limit(limit);
  return data ?? [];
}

export async function getPicksForTournament(leagueId: string, tournamentId: string) {
  const { data } = await supabaseAdmin
    .from('picks')
    .select(`*, golfer_1:golfers!picks_golfer_1_id_fkey(*), golfer_2:golfers!picks_golfer_2_id_fkey(*), golfer_3:golfers!picks_golfer_3_id_fkey(*), golfer_4:golfers!picks_golfer_4_id_fkey(*)`)
    .eq('league_id', leagueId).eq('tournament_id', tournamentId);
  return data ?? [];
}

export async function getScoresForTournament(tournamentId: string) {
  const { data } = await supabaseAdmin
    .from('scores').select('*').eq('tournament_id', tournamentId);
  return data ?? [];
}

export async function getFantasyLeaderboard(leagueId: string, tournamentId: string) {
  const { data } = await supabaseAdmin
    .from('fantasy_results').select('*, profile:profiles(*)')
    .eq('league_id', leagueId).eq('tournament_id', tournamentId)
    .order('rank', { ascending: true });
  return data ?? [];
}

export async function getSeasonStandings(leagueId: string, season: number) {
  const { data } = await supabaseAdmin
    .from('season_standings').select('*, profile:profiles(*)')
    .eq('league_id', leagueId).eq('season', season)
    .order('rank', { ascending: true });
  return data ?? [];
}

export function generateInviteCode(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}
