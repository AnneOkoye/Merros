// /api/generate-roadmap.js
// Vercel serverless function that turns a person's goal(s) and sprint length into a
// week-by-week milestone roadmap using Claude (Haiku, the cheapest current model,
// since this task doesn't need a bigger one).
//
// Guardrails (all four discussed with Anne):
//   1. Login required     - verifies the Supabase session before doing anything
//   2. Rate limit          - max 5 requests per user per rolling hour (via ai_usage_log table)
//   3. Input size capped   - max 3 goals, 150 chars each; duration capped at 16 weeks
//   4. Output size capped  - max_tokens on the Claude call, and each milestone truncated
//
// Requires one Vercel environment variable: ANTHROPIC_API_KEY
// (set it in Vercel dashboard, Project, Settings, Environment Variables)
//
// Requires the ai_usage_log table - see /supabase-ai-usage.sql, run once in the
// Supabase SQL editor before this endpoint will work.

const SUPABASE_URL = 'https://nvgzejircugthcacidol.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im52Z3plamlyY3VndGhjYWNpZG9sIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYxODI5OTYsImV4cCI6MjEwMTc1ODk5Nn0.Gagp53MhRoh9m1aW5UdMXAKvFePgJBS__LNV6CbNnuI';
const MAX_REQUESTS_PER_HOUR = 5;
const MAX_GOALS = 3;
const MAX_GOAL_LENGTH = 150;
const MAX_WEEKS = 16;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server not configured. Missing ANTHROPIC_API_KEY' });
  }

  // ---------- Guardrail 1: must be logged in ----------
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  let userId;
  try {
    const userResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!userResp.ok) throw new Error('bad session');
    const user = await userResp.json();
    userId = user.id;
    if (!userId) throw new Error('no user id');
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  // ---------- Guardrail 3: validate + cap input size ----------
  let { goals, totalWeeks } = req.body || {};
  if (!Array.isArray(goals) || goals.length === 0 || goals.length > MAX_GOALS) {
    return res.status(400).json({ error: `Provide 1–${MAX_GOALS} goals` });
  }
  goals = goals.map((g) => String(g).slice(0, MAX_GOAL_LENGTH));

  totalWeeks = parseInt(totalWeeks, 10);
  if (!Number.isFinite(totalWeeks) || totalWeeks < 1 || totalWeeks > MAX_WEEKS) {
    return res.status(400).json({ error: `Duration must be between 1 and ${MAX_WEEKS} weeks` });
  }

  // ---------- Guardrail 2: rate limit (max N per user per rolling hour) ----------
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  try {
    const countResp = await fetch(
      `${SUPABASE_URL}/rest/v1/ai_usage_log?user_id=eq.${userId}&created_at=gte.${oneHourAgo}&select=id`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` } }
    );
    if (countResp.ok) {
      const recent = await countResp.json();
      if (Array.isArray(recent) && recent.length >= MAX_REQUESTS_PER_HOUR) {
        return res.status(429).json({ error: 'Rate limit reached. Try again in a bit.' });
      }
    }
  } catch (e) {
    // If the usage-log check itself fails, fail closed is safer than fail open,
    // but a transient read error shouldn't block a real user, so we log and continue.
    console.error('rate limit check failed', e);
  }

  // Log this attempt now (before the AI call), so even failed/slow calls count
  // against abuse loops, not just successful ones.
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/ai_usage_log`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ user_id: userId, feature: 'generate-roadmap' }),
    });
  } catch (e) {
    console.error('usage log insert failed', e);
  }

  // ---------- Call Claude (Haiku, cheapest model, right-sized for this task) ----------
  const goalsNumbered = goals.map((g, i) => `(${i + 1}) ${g}`).join('; ');
  const prompt = `A person is starting a ${totalWeeks}-week self-improvement sprint with these goal(s): ${goalsNumbered}.

For EACH goal separately, break it into 2 to 5 sequential week-range milestones that together span roughly week 1 through week ${totalWeeks} for that goal (ranges like "1-3", "4-6"; a 1 or 2 week sprint can just use single weeks like "1", "2"). Each milestone's text must be under 50 characters, specific and actionable, not a generic motivational phrase.

Respond with ONLY a JSON array of exactly ${goals.length} objects, nothing else, no markdown formatting. Each object must have this exact shape: {"goal": "<the goal text exactly as given, without the number>", "milestones": [{"weeks": "1-3", "text": "..."}, {"weeks": "4-6", "text": "..."}]}`;

  let aiResp;
  try {
    aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      // Guardrail 4: output size capped
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 900,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
  } catch (e) {
    return res.status(502).json({ error: 'Could not reach the AI service' });
  }

  if (!aiResp.ok) {
    const errText = await aiResp.text().catch(() => '');
    return res.status(502).json({ error: 'AI request failed', detail: errText.slice(0, 200) });
  }

  const aiData = await aiResp.json();
  const text = aiData?.content?.[0]?.text || '';

  let goalPlans;
  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    goalPlans = JSON.parse(jsonMatch ? jsonMatch[0] : text);
  } catch (e) {
    return res.status(502).json({ error: 'Could not parse AI response' });
  }

  if (!Array.isArray(goalPlans) || goalPlans.length !== goals.length) {
    return res.status(502).json({ error: 'Unexpected AI response shape' });
  }
  // Guardrail 4 continued: cap every string field and the milestone count per goal,
  // and fall back to the original goal text if the model altered it.
  goalPlans = goalPlans.map((plan, i) => {
    const milestones = Array.isArray(plan.milestones) ? plan.milestones.slice(0, 6) : [];
    return {
      goal: goals[i],
      milestones: milestones.map((m) => ({
        weeks: String(m && m.weeks != null ? m.weeks : '').slice(0, 12),
        text: String(m && m.text != null ? m.text : '').slice(0, 70),
      })),
    };
  });

  return res.status(200).json({ goalPlans });
}
