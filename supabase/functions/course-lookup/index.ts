// Supabase Edge Function: course-lookup
// Searches GolfCourseAPI for a course, saves the results to public.courses (so each course is
// only ever fetched once for everyone), and returns them.
//
// Setup (Supabase dashboard): Edge Functions -> Deploy a new function -> "Via Editor",
// name it course-lookup, paste this file, deploy. Then Edge Functions -> Secrets ->
// add GOLFCOURSEAPI_KEY = your key from golfcourseapi.com.
// Leave "Verify JWT" on: only signed-in golfers can trigger lookups.
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

type Tee = { name: string; gender: 'M' | 'F'; rating: number; slope: number; par: number | null; yards: number | null; holes: number };

// deno-lint-ignore no-explicit-any
function normalize(c: any) {
  const club = (c.club_name || '').trim(), course = (c.course_name || '').trim();
  const name = !course || course.toLowerCase() === club.toLowerCase() ? club || course
    : course.toLowerCase().includes(club.toLowerCase()) ? course : `${club} – ${course}`;
  const tees: Tee[] = [];
  const add = (list: unknown, gender: 'M' | 'F') => {
    if (!Array.isArray(list)) return;
    // deno-lint-ignore no-explicit-any
    for (const t of list as any[]) {
      const rating = Number(t.course_rating), slope = Number(t.slope_rating);
      if (!rating || !slope) continue;
      tees.push({ name: String(t.tee_name || '').trim() || 'Tee', gender, rating, slope,
        par: Number(t.par_total) || null, yards: Number(t.total_yards) || null, holes: Number(t.number_of_holes) || 18 });
    }
  };
  add(c.tees?.male, 'M'); add(c.tees?.female, 'F');
  const loc = c.location || {};
  return { name, city: loc.city || null, state: loc.state || null, country: loc.country || null,
    tees, source: 'golfcourseapi', source_id: 'gca:' + c.id, updated_at: new Date().toISOString() };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const key = Deno.env.get('GOLFCOURSEAPI_KEY');
    if (!key) return json({ error: 'GOLFCOURSEAPI_KEY is not set' }, 501);
    const { q } = await req.json().catch(() => ({}));
    const query = String(q || '').trim().slice(0, 80);
    if (query.length < 3) return json({ courses: [] });

    const r = await fetch('https://api.golfcourseapi.com/v1/search?search_query=' + encodeURIComponent(query), {
      headers: { Authorization: 'Key ' + key },
    });
    if (r.status === 429) return json({ error: 'daily lookup limit reached' }, 429);
    if (!r.ok) return json({ error: 'lookup failed (' + r.status + ')' }, 502);
    const body = await r.json();
    const courses = (body.courses || []).slice(0, 10).map(normalize).filter((c: { tees: Tee[] }) => c.tees.length);
    if (courses.length) {
      const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
      const { data, error } = await admin.from('courses').upsert(courses, { onConflict: 'source_id' }).select();
      if (!error && data) return json({ courses: data });
    }
    return json({ courses });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
