// 유튜브 검색 함수 (Supabase Edge Function)
// 로그인한 사용자만 호출할 수 있고(함수 안에서 직접 확인), API 키는 비밀값 YOUTUBE_API_KEY에 보관해요.
// 내 유튜브 계정이 아니라 API 키로 검색하므로, 검색 기록이 유튜브 추천에 영향을 주지 않아요.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const auth = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!).auth;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const decode = (s: string) =>
  s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

const cleanChannel = (c: string) => (c || "").replace(/ - Topic$/, "");

type Snippet = { title: string; channelTitle: string; thumbnails?: Record<string, { url: string }> };
const thumb = (s: Snippet) => s.thumbnails?.medium?.url || s.thumbnails?.default?.url || null;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "METHOD" }, 405);

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer /, "");
  const { data: who } = token ? await auth.getUser(token) : { data: { user: null } };
  if (!who?.user) return json({ error: "LOGIN_REQUIRED" }, 401);

  const key = Deno.env.get("YOUTUBE_API_KEY");
  if (!key) return json({ error: "NO_KEY" }, 500);

  let body: { q?: string; id?: string; pageToken?: string } = {};
  try { body = await req.json(); } catch { /* 빈 요청 */ }

  const yt = async (path: string, params: Record<string, string>) => {
    const url = new URL("https://www.googleapis.com/youtube/v3/" + path);
    for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
    url.searchParams.set("key", key);
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) {
      const reason = data?.error?.errors?.[0]?.reason || "YOUTUBE_ERROR";
      throw Object.assign(new Error(reason), { status: res.status });
    }
    return data;
  };

  try {
    // 링크로 단건 조회 (1 유닛)
    if (body.id) {
      const id = String(body.id).slice(0, 20);
      const r = await yt("videos", { part: "snippet,status", id });
      const v = r.items?.[0];
      if (!v) return json({ items: [] });
      return json({
        items: [{
          video_id: v.id,
          title: decode(v.snippet.title),
          channel: cleanChannel(v.snippet.channelTitle),
          thumbnail: thumb(v.snippet),
          embeddable: v.status?.embeddable !== false,
        }],
      });
    }

    // 검색 (100 유닛) — 외부 재생이 허용된 영상만
    const q = String(body.q || "").trim().slice(0, 120);
    if (!q) return json({ items: [] });
    const r = await yt("search", {
      part: "snippet",
      type: "video",
      videoEmbeddable: "true",
      maxResults: "20",
      regionCode: "KR",
      q,
      pageToken: body.pageToken || "",
    });
    return json({
      nextPageToken: r.nextPageToken || null,
      items: (r.items || []).map((it: { id: { videoId: string }; snippet: Snippet }) => ({
        video_id: it.id.videoId,
        title: decode(it.snippet.title),
        channel: cleanChannel(decode(it.snippet.channelTitle)),
        thumbnail: thumb(it.snippet),
        embeddable: true,
      })),
    });
  } catch (e) {
    const err = e as Error & { status?: number };
    return json({ error: err.message }, err.status && err.status < 500 ? err.status : 502);
  }
});
