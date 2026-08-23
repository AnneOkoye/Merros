-- Run this once in Supabase: Dashboard → SQL Editor → New query → paste → Run
-- This creates the table the AI roadmap feature uses to rate-limit requests
-- (max 5 per person per rolling hour, enforced in /api/generate-roadmap.js).

create table if not exists ai_usage_log (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  feature text not null default 'generate-roadmap',
  created_at timestamptz not null default now()
);

create index if not exists ai_usage_log_user_time_idx
  on ai_usage_log (user_id, created_at);

alter table ai_usage_log enable row level security;

-- Each person can only insert/read their own usage rows — nobody can see
-- or log usage on someone else's behalf.
create policy "Users can insert their own usage logs"
  on ai_usage_log for insert
  with check (auth.uid() = user_id);

create policy "Users can view their own usage logs"
  on ai_usage_log for select
  using (auth.uid() = user_id);
