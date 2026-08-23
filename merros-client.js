/**
 * MERROS — Supabase data-access layer.
 *
 * Load order in your HTML:
 *   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
 *   <script src="merros-client.js"></script>
 *   <script> ...your app code, calling window.Merros.* ... </script>
 *
 * Fill in SUPABASE_URL and SUPABASE_ANON_KEY below (Project Settings > API in your Supabase dashboard).
 * The anon key is safe to expose in client code — Row Level Security in schema.sql does the real access control.
 */
const SUPABASE_URL = 'https://nvgzejircugthcacidol.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im52Z3plamlyY3VndGhjYWNpZG9sIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYxODI5OTYsImV4cCI6MjEwMTc1ODk5Nn0.Gagp53MhRoh9m1aW5UdMXAKvFePgJBS__LNV6CbNnuI';

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ---------------------------------------------------------------- AUTH */
async function signInWithEmail(email) {
  const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.href } });
  if (error) throw error;
  return true; // magic link sent
}
async function signUpWithPassword(email, password) {
  const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: window.location.href } });
  if (error) throw error;
  return data; // data.session is null if email confirmation is required
}
async function signInWithPassword(email, password) {
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}
async function resetPassword(email) {
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: window.location.href });
  if (error) throw error;
  return true;
}
async function signOut() { await sb.auth.signOut(); }
async function getUser() {
  const { data: { user } } = await sb.auth.getUser();
  return user;
}
async function getAccessToken() {
  const { data: { session } } = await sb.auth.getSession();
  return session?.access_token || null;
}
function onAuthChange(cb) {
  sb.auth.onAuthStateChange((_event, session) => cb(session?.user ?? null));
}

/* ---------------------------------------------------------------- PROFILE */
async function getMyProfile() {
  const user = await getUser();
  if (!user) return null;
  const { data, error } = await sb.from('profiles').select('*').eq('id', user.id).single();
  if (error) throw error;
  return data;
}
async function updateMyProfile({ callsign, life_stage, match_pref, city, timezone }) {
  const user = await getUser();
  const { data, error } = await sb.from('profiles')
    .update({ callsign, life_stage, match_pref, city, timezone })
    .eq('id', user.id).select().single();
  if (error) throw error;
  return data;
}
async function isCallsignAvailable(callsign) {
  const { data, error } = await sb.from('public_profiles').select('id').eq('callsign', callsign).maybeSingle();
  if (error) throw error;
  return !data;
}
async function getSettings() {
  const user = await getUser();
  const { data, error } = await sb.from('settings').select('*').eq('profile_id', user.id).single();
  if (error) throw error;
  return data;
}
async function updateSetting(key, value) {
  const user = await getUser();
  const { error } = await sb.from('settings').update({ [key]: value }).eq('profile_id', user.id);
  if (error) throw error;
}

/* ---------------------------------------------------------------- PODS */
async function createPod({ track, track_key, tone, plan, name }) {
  const user = await getUser();
  const { data: pod, error } = await sb.from('pods')
    .insert({ track, track_key, tone, plan, name: name || 'New Pod', created_by: user.id }).select().single();
  if (error) throw error;
  const { data: member, error: mErr } = await sb.from('pod_members')
    .insert({ pod_id: pod.id, profile_id: user.id, role: 'anchor', anchor_week_start: 1, anchor_week_end: 3 })
    .select().single();
  if (mErr) throw mErr;
  return { pod, member };
}
async function joinPodByCode(invite_code) {
  const user = await getUser();
  const { data: pod, error } = await sb.from('pods').select('*').eq('invite_code', invite_code.toUpperCase()).single();
  if (error) throw error;
  const { data: member, error: mErr } = await sb.from('pod_members')
    .insert({ pod_id: pod.id, profile_id: user.id }).select().single();
  if (mErr) throw mErr;
  return { pod, member };
}
async function findOpenPod(matchLifeStage) {
  // Pods with fewer than 4 filled members, optionally filtered by a shared life-stage member
  const { data, error } = await sb.rpc('noop'); // placeholder if you add a Postgres function later
  // Simple client-side approach: fetch pods and their member counts
  const { data: pods, error: pErr } = await sb
    .from('pods')
    .select('*, pod_members(count)')
    .limit(20);
  if (pErr) throw pErr;
  return (pods || []).filter(p => (p.pod_members?.[0]?.count ?? 0) < 4);
}
async function joinPod(podId) {
  const user = await getUser();
  const { data, error } = await sb.from('pod_members').insert({ pod_id: podId, profile_id: user.id }).select().single();
  if (error) throw error;
  return data;
}
async function getMyPod() {
  const user = await getUser();
  const { data: membership, error } = await sb.from('pod_members').select('*, pods(*)').eq('profile_id', user.id).maybeSingle();
  if (error) throw error;
  return membership;
}
async function getPodSeats(podId) {
  const { data, error } = await sb.from('pod_members').select('*, public_profiles(*)').eq('pod_id', podId);
  if (error) throw error;
  return data;
}

/* ---------------------------------------------------------------- ROADMAP */
async function saveRoadmap(podMemberId, weeks /* [{week,label}] */) {
  const rows = weeks.map(w => ({ pod_member_id: podMemberId, week: w.week, label: w.label }));
  const { error } = await sb.from('roadmap_items').upsert(rows, { onConflict: 'pod_member_id,week' });
  if (error) throw error;
}
async function toggleRoadmapItem(itemId, done) {
  const { error } = await sb.from('roadmap_items').update({ done }).eq('id', itemId);
  if (error) throw error;
}
async function getMyRoadmap(podMemberId) {
  const { data, error } = await sb.from('roadmap_items').select('*').eq('pod_member_id', podMemberId).order('week');
  if (error) throw error;
  return data;
}

/* ---------------------------------------------------------------- CHECK-INS / MICROLINES */
async function postCheckin(podId, week, text, status, kind = 'microline') {
  const user = await getUser();
  const { data, error } = await sb.from('checkins')
    .insert({ pod_id: podId, profile_id: user.id, week, text, status, kind }).select().single();
  if (error) throw error;
  return data;
}
async function getPodFeed(podId, limit = 20) {
  const { data, error } = await sb.from('checkins')
    .select('*, public_profiles(callsign)').eq('pod_id', podId)
    .order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return data;
}

/* ---------------------------------------------------------------- CHARTER */
async function proposeRule(podId, text) {
  const user = await getUser();
  const { data: rule, error } = await sb.from('charter_rules')
    .insert({ pod_id: podId, text, proposed_by: user.id }).select().single();
  if (error) throw error;
  await sb.from('charter_votes').insert({ rule_id: rule.id, profile_id: user.id }); // proposer auto-votes yes
  return rule;
}
async function voteRule(ruleId) {
  const user = await getUser();
  const { error } = await sb.from('charter_votes').insert({ rule_id: ruleId, profile_id: user.id });
  if (error) throw error;
  // Check vote count vs. pod size; flip to inforce at 4-of-4 (adjust threshold to your pod size)
  const { count } = await sb.from('charter_votes').select('id', { count: 'exact', head: true }).eq('rule_id', ruleId);
  if (count >= 4) {
    await sb.from('charter_rules').update({ status: 'inforce' }).eq('id', ruleId);
  }
}
async function withdrawRule(ruleId) {
  const { error } = await sb.from('charter_rules').update({ status: 'withdrawn' }).eq('id', ruleId);
  if (error) throw error;
}
async function getCharter(podId) {
  const { data, error } = await sb.from('charter_rules')
    .select('*, charter_votes(count)').eq('pod_id', podId).neq('status', 'withdrawn')
    .order('created_at');
  if (error) throw error;
  return data;
}

/* ---------------------------------------------------------------- NOTICE BOARD */
async function postNotice(podId, kind, text) {
  const user = await getUser();
  const { data, error } = await sb.from('notices').insert({ pod_id: podId, author_id: user.id, kind, text }).select().single();
  if (error) throw error;
  return data;
}
async function getNotices(podId) {
  const { data, error } = await sb.from('notices').select('*, public_profiles(callsign)').eq('pod_id', podId).order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

/* ---------------------------------------------------------------- WAITLIST (public, no login required) */
async function joinWaitlist(email, plan = 'Fellow') {
  const { error } = await sb.from('waitlist_signups').insert({ email, plan_interested: plan });
  if (error) throw error;
  return true;
}

/* ---------------------------------------------------------------- ROOTPRINT */
async function saveRootPrint({ species, weeksCompleted, consistencyPct, sentimentArc, witnessedMoments, seedHash }) {
  const user = await getUser();
  const { data, error } = await sb.from('root_prints').insert({
    profile_id: user.id, species, weeks_completed: weeksCompleted, consistency_pct: consistencyPct,
    sentiment_arc: sentimentArc, witnessed_moments: witnessedMoments, seed_hash: seedHash,
  }).select().single();
  if (error) throw error;
  return data;
}
async function getMyRootPrints() {
  const user = await getUser();
  const { data, error } = await sb.from('root_prints').select('*').eq('profile_id', user.id).order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}
async function getRootPrintById(id) {
  const { data, error } = await sb.from('root_prints').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
}

/* ---------------------------------------------------------------- POD CHANNEL (realtime) */
async function postChannelMessage(podId, text) {
  const user = await getUser();
  const { error } = await sb.from('channel_messages').insert({ pod_id: podId, author_id: user.id, text });
  if (error) throw error;
}
async function getChannelMessages(podId) {
  const { data, error } = await sb.from('channel_messages')
    .select('*, public_profiles(callsign)').eq('pod_id', podId).order('created_at');
  if (error) throw error;
  return data;
}
function subscribeToChannel(podId, onInsert) {
  return sb.channel('channel:' + podId)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'channel_messages', filter: `pod_id=eq.${podId}` },
      payload => onInsert(payload.new))
    .subscribe();
}

/* ---------------------------------------------------------------- CHAPTERS */
async function createChapter({ name, description, joining_policy }) {
  const user = await getUser();
  const { data: chapter, error } = await sb.from('chapters')
    .insert({ name, description, joining_policy, created_by: user.id }).select().single();
  if (error) throw error;
  await sb.from('chapter_members').insert({ chapter_id: chapter.id, profile_id: user.id, role: 'lead' });
  return chapter;
}
async function listChapters() {
  const { data, error } = await sb.from('chapters').select('*, chapter_members(count)').order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}
async function joinChapter(chapterId) {
  const user = await getUser();
  const { error } = await sb.from('chapter_members').insert({ chapter_id: chapterId, profile_id: user.id });
  if (error) throw error;
}
async function getChapterMembers(chapterId) {
  const { data, error } = await sb.from('chapter_members').select('*, public_profiles(*)').eq('chapter_id', chapterId);
  if (error) throw error;
  return data;
}
async function postChapterNotice(chapterId, text) {
  const user = await getUser();
  const { error } = await sb.from('chapter_notices').insert({ chapter_id: chapterId, author_id: user.id, text });
  if (error) throw error;
}
async function getChapterNotices(chapterId) {
  const { data, error } = await sb.from('chapter_notices').select('*, public_profiles(callsign)').eq('chapter_id', chapterId).order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

/* ---------------------------------------------------------------- JOURNAL (private) */
async function saveJournalEntry(text) {
  const user = await getUser();
  const { data, error } = await sb.from('journal_entries').insert({ profile_id: user.id, text }).select().single();
  if (error) throw error;
  return data;
}
async function getJournalEntries() {
  const user = await getUser();
  const { data, error } = await sb.from('journal_entries').select('*').eq('profile_id', user.id).order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

/* ---------------------------------------------------------------- PULSE (realtime) */
async function postPulse({ icon, text, pod_id, chapter_id }) {
  const user = await getUser();
  const { error } = await sb.from('pulse_posts').insert({ author_id: user.id, icon, text, pod_id, chapter_id });
  if (error) throw error;
}
async function getPulseFeed(limit = 30) {
  const { data, error } = await sb.from('pulse_posts')
    .select('*, pulse_reactions(emoji, profile_id)')
    .order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return data;
}
async function reactToPulse(postId, emoji) {
  const user = await getUser();
  const { error } = await sb.from('pulse_reactions').insert({ post_id: postId, profile_id: user.id, emoji });
  if (error && error.code !== '23505') throw error; // ignore duplicate-reaction conflicts
}
function subscribeToPulse(onInsert) {
  return sb.channel('pulse')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'pulse_posts' }, payload => onInsert(payload.new))
    .subscribe();
}

/* ---------------------------------------------------------------- EXPORT */
window.Merros = {
  sb,
  auth: { signInWithEmail, signUpWithPassword, signInWithPassword, resetPassword, signOut, getUser, getAccessToken, onAuthChange },
  profile: { getMyProfile, updateMyProfile, isCallsignAvailable, getSettings, updateSetting },
  pods: { createPod, joinPodByCode, findOpenPod, joinPod, getMyPod, getPodSeats },
  roadmap: { saveRoadmap, toggleRoadmapItem, getMyRoadmap },
  checkins: { postCheckin, getPodFeed },
  charter: { proposeRule, voteRule, withdrawRule, getCharter },
  notices: { postNotice, getNotices },
  waitlist: { joinWaitlist },
  rootprints: { saveRootPrint, getMyRootPrints, getRootPrintById },
  channel: { postChannelMessage, getChannelMessages, subscribeToChannel },
  chapters: { createChapter, listChapters, joinChapter, getChapterMembers, postChapterNotice, getChapterNotices },
  journal: { saveJournalEntry, getJournalEntries },
  pulse: { postPulse, getPulseFeed, reactToPulse, subscribeToPulse },
};
