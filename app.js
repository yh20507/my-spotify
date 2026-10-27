import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

// 구글 로그인에서 막 돌아온 상태인지 (Supabase가 주소를 정리하기 전에 확인)
const cameFromOAuth = new URLSearchParams(location.search).has('code');

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
});

const YT_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
const LIKED = 'LIKED';

/* ─────────────────── 상태 ─────────────────── */
const state = {
  user: null,
  playlists: [],        // DB에 저장된 내 플레이리스트
  current: null,        // 지금 보고 있는 플레이리스트
  tracks: [],           // 지금 보고 있는 플레이리스트의 곡
  filter: '',
  base: [],             // 재생 순서의 원본(셔플 전)
  queue: [],            // 실제 재생 순서
  qi: -1,               // queue 안에서의 위치
  nowTrack: null,
  shuffle: pref('shuffle', false),
  repeat: pref('repeat', 'off'), // off | all | one
  volume: pref('volume', 80),
  playing: false,
  player: null,
  apiReady: false,
  pendingVideo: null,
  errorStreak: 0,
  seeking: false,
};

const $ = (s) => document.querySelector(s);
const content = $('#content');

/* ─────────────────── 작은 도구들 ─────────────────── */
function pref(key, fallback) {
  try { const v = localStorage.getItem('replay.' + key); return v === null ? fallback : JSON.parse(v); }
  catch { return fallback; }
}
function setPref(key, value) {
  try { localStorage.setItem('replay.' + key, JSON.stringify(value)); } catch { /* 저장 안 돼도 괜찮음 */ }
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmt(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function ago(iso) {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return '방금';
  if (d < 3600) return `${Math.floor(d / 60)}분 전`;
  if (d < 86400) return `${Math.floor(d / 3600)}시간 전`;
  return `${Math.floor(d / 86400)}일 전`;
}
let toastTimer;
function toast(msg, ms = 2800) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
function setRange(el, value, max) {
  el.value = value;
  el.style.setProperty('--p', `${max ? (value / max) * 100 : 0}%`);
}

/* ─────────────────── 유튜브 연결 토큰 ─────────────────── */
// 구글 로그인 직후에만 받을 수 있는 유튜브 접근 토큰. 1시간쯤 유효해서 그 안에만 불러오기가 가능해요.
function saveYtToken(token) {
  try { localStorage.setItem('replay.yt', JSON.stringify({ token, exp: Date.now() + 55 * 60 * 1000 })); } catch {}
}
function getYtToken() {
  try {
    const v = JSON.parse(localStorage.getItem('replay.yt') || 'null');
    return v && v.exp > Date.now() ? v.token : null;
  } catch { return null; }
}
function clearYtToken() { try { localStorage.removeItem('replay.yt'); } catch {} }

class NeedYouTube extends Error {}

// 윈도우 앱(Replay 데스크톱) 안에서 실행 중이면 이 값이 있어요.
const desktop = window.replayDesktop || null;

async function connectGoogle() {
  if (desktop) {
    // 구글은 앱 안 창에서의 로그인을 막아서, 평소 쓰는 브라우저에서 로그인하고 결과만 앱으로 받아와요.
    const redirectTo = await desktop.startAuth();
    const { data, error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo, scopes: YT_SCOPE, skipBrowserRedirect: true },
    });
    if (error) return toast('로그인을 시작하지 못했어요: ' + error.message, 5000);
    await desktop.openExternal(data.url);
    toast('브라우저에서 로그인을 마치면 자동으로 돌아와요', 6000);
    return;
  }
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: location.origin + location.pathname,
      scopes: YT_SCOPE,
    },
  });
  if (error) toast('로그인을 시작하지 못했어요: ' + error.message, 5000);
}

async function yt(path, params) {
  const token = getYtToken();
  if (!token) throw new NeedYouTube();
  const url = new URL('https://www.googleapis.com/youtube/v3/' + path);
  Object.entries(params).forEach(([k, v]) => v !== undefined && url.searchParams.set(k, v));
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (res.status === 401) { clearYtToken(); throw new NeedYouTube(); }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const reason = body?.error?.errors?.[0]?.reason;
    const messages = {
      quotaExceeded: '오늘 유튜브 API 사용량을 다 썼어요. 한국 시간 오후 4~5시쯤 초기화돼요.',
      accessNotConfigured: 'Google Cloud에서 YouTube Data API v3가 켜져 있지 않아요. 설정 안내를 확인해주세요.',
      insufficientPermissions: '유튜브 읽기 권한이 없어요. 다시 연결하면서 권한을 허용해주세요.',
      youtubeSignupRequired: '이 구글 계정에는 유튜브 채널이 없어요.',
      playlistNotFound: '플레이리스트를 찾을 수 없어요. 유튜브에서 삭제됐을 수 있어요.',
    };
    if (reason === 'insufficientPermissions') clearYtToken();
    throw new Error(messages[reason] || body?.error?.message || `유튜브 요청 실패 (${res.status})`);
  }
  return res.json();
}

/* ─────────────────── 유튜브에서 읽기 ─────────────────── */
async function fetchMyYtPlaylists() {
  const out = [{ id: LIKED, title: '좋아요 표시한 동영상', count: null, thumb: null }];
  let pageToken;
  do {
    const r = await yt('playlists', { part: 'snippet,contentDetails', mine: 'true', maxResults: 50, pageToken });
    for (const p of r.items || []) {
      out.push({
        id: p.id,
        title: p.snippet.title,
        count: p.contentDetails?.itemCount ?? null,
        thumb: p.snippet.thumbnails?.medium?.url || p.snippet.thumbnails?.default?.url || null,
      });
    }
    pageToken = r.nextPageToken;
  } while (pageToken);
  return out;
}

const cleanChannel = (c) => (c || '').replace(/ - Topic$/, '');

async function fetchYtItems(ytId, onProgress) {
  const items = [];
  let pageToken;
  const max = ytId === LIKED ? 1000 : 5000;
  do {
    if (ytId === LIKED) {
      const r = await yt('videos', { part: 'snippet', myRating: 'like', maxResults: 50, pageToken });
      for (const v of r.items || []) {
        items.push({
          video_id: v.id,
          title: v.snippet.title,
          channel: cleanChannel(v.snippet.channelTitle),
          thumbnail: v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.default?.url || null,
        });
      }
      pageToken = r.nextPageToken;
    } else {
      const r = await yt('playlistItems', { part: 'snippet', playlistId: ytId, maxResults: 50, pageToken });
      for (const it of r.items || []) {
        const s = it.snippet;
        const vid = s?.resourceId?.videoId;
        // 삭제되거나 비공개로 바뀐 영상은 채널 정보가 없어요. 건너뛰어요.
        if (!vid || !s.videoOwnerChannelTitle) continue;
        items.push({
          video_id: vid,
          title: s.title,
          channel: cleanChannel(s.videoOwnerChannelTitle),
          thumbnail: s.thumbnails?.medium?.url || s.thumbnails?.default?.url || null,
        });
      }
      pageToken = r.nextPageToken;
    }
    onProgress?.(items.length);
  } while (pageToken && items.length < max);
  return items;
}

/* ─────────────────── DB 저장 ─────────────────── */
async function importOne(ytPl, onProgress) {
  const items = await fetchYtItems(ytPl.id, onProgress);
  const thumb = ytPl.thumb || items[0]?.thumbnail || null;

  // 이 앱에서 직접 추가한 곡은 유튜브와 다시 맞춰도 남겨둬요.
  const existing = state.playlists.find((p) => p.youtube_id === ytPl.id);
  let manual = [];
  if (existing) {
    const { data, error: e } = await sb.from('tracks').select('video_id,title,channel,thumbnail')
      .eq('playlist_id', existing.id).eq('manual', true).order('position');
    if (e) throw e;
    manual = data;
  }

  const { data: pl, error } = await sb.from('playlists')
    .upsert({
      user_id: state.user.id,
      youtube_id: ytPl.id,
      kind: 'youtube',
      title: ytPl.title,
      thumbnail: thumb,
      track_count: items.length + manual.length,
      synced_at: new Date().toISOString(),
    }, { onConflict: 'user_id,youtube_id' })
    .select()
    .single();
  if (error) throw error;

  const del = await sb.from('tracks').delete().eq('playlist_id', pl.id);
  if (del.error) throw del.error;

  const rows = [
    ...items.map((t) => ({ ...t, manual: false })),
    ...manual.map((t) => ({ ...t, manual: true })),
  ].map((t, i) => ({ ...t, playlist_id: pl.id, user_id: state.user.id, position: i }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error: e } = await sb.from('tracks').insert(rows.slice(i, i + 500));
    if (e) throw e;
  }
  return pl;
}

async function loadPlaylists() {
  const { data, error } = await sb.from('playlists').select('*').order('created_at', { ascending: true });
  if (error) { toast('라이브러리를 불러오지 못했어요: ' + error.message, 5000); return; }
  // 좋아요 목록 → 앱에서 만든 목록 → 유튜브에서 불러온 목록 순서
  const rank = (p) => (p.youtube_id === LIKED ? 0 : p.kind === 'local' ? 1 : 2);
  state.playlists = data.sort((a, b) => rank(a) - rank(b));
  if (state.current) state.current = state.playlists.find((p) => p.id === state.current.id) || null;
}

async function loadTracks(playlistId) {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('tracks').select('*')
      .eq('playlist_id', playlistId).order('position').range(from, from + 999);
    if (error) throw error;
    all.push(...data);
    if (data.length < 1000) break;
  }
  return all;
}

/* ─────────────────── 화면: 라이브러리 ─────────────────── */
function renderLibrary() {
  const list = $('#libList');
  $('#libFoot').hidden = !state.user;
  if (!state.user) { list.innerHTML = ''; return; }
  if (!state.playlists.length) {
    list.innerHTML = '<p class="lib-empty">불러온 플레이리스트가 없어요.</p>';
    return;
  }
  list.innerHTML = state.playlists.map((p) => `
    <button class="lib-item" data-id="${p.id}" aria-current="${state.current?.id === p.id}">
      ${p.thumbnail ? `<img src="${esc(p.thumbnail)}" alt="" loading="lazy">` : '<span class="ph"></span>'}
      <span class="lib-text">
        <span class="lib-title" style="display:block">${esc(p.title)}</span>
        <span class="lib-sub">곡 ${p.track_count}개</span>
      </span>
    </button>`).join('');
}

$('#libList').addEventListener('click', (e) => {
  const b = e.target.closest('.lib-item');
  if (b) openPlaylist(b.dataset.id);
});

/* ─────────────────── 화면: 본문 ─────────────────── */
function renderWelcome() {
  content.innerHTML = `
    <section class="welcome">
      <div class="bars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
      <h1>유튜브에 모아둔 노래,<br>여기서 바로 들어요</h1>
      <p>구글 계정으로 로그인하면 내 유튜브 플레이리스트와 좋아요 표시한 동영상을 불러와서, 셔플과 반복으로 이어서 재생해요.</p>
      <div><button class="btn-primary" id="loginBtn">구글로 로그인</button></div>
      <p class="note">유튜브 계정은 읽기만 해요. 플레이리스트를 바꾸거나 지우지 않아요.</p>
    </section>`;
  $('#loginBtn').onclick = connectGoogle;
}

function renderEmptyLibrary() {
  content.innerHTML = `
    <section class="welcome">
      <h1>첫 플레이리스트를<br>만들어 볼까요?</h1>
      <p>유튜브에서 만든 플레이리스트를 가져오거나, 여기서 새 플레이리스트를 만들어 노래를 검색해 담을 수 있어요.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn-primary" id="firstImport">유튜브에서 불러오기</button>
        <button class="btn-ghost" id="firstNew">새 플레이리스트</button>
      </div>
    </section>`;
  $('#firstImport').onclick = openImport;
  $('#firstNew').onclick = openNew;
}

function visibleTracks() {
  const q = state.filter.trim().toLowerCase();
  if (!q) return state.tracks;
  return state.tracks.filter((t) => t.title.toLowerCase().includes(q) || (t.channel || '').toLowerCase().includes(q));
}

function renderPlaylist() {
  const p = state.current;
  content.innerHTML = `
    <header class="pl-head">
      ${p.thumbnail ? `<img class="pl-cover" src="${esc(p.thumbnail)}" alt="">` : '<div class="pl-cover"></div>'}
      <div class="pl-info">
        <h1>${esc(p.title)}</h1>
        <p class="meta">곡 ${state.tracks.length}개, ${p.kind === 'local' ? '이 앱에서 만든 플레이리스트' : `${ago(p.synced_at)} 유튜브와 맞춤`}</p>
      </div>
    </header>
    <div class="pl-actions">
      <button class="btn-primary" id="playAll"><svg><use href="#i-play"/></svg>재생</button>
      <button class="btn-ghost" id="shuffleAll"><svg><use href="#i-shuffle"/></svg>셔플 재생</button>
      <button class="btn-ghost" id="addSongs"><svg><use href="#i-plus"/></svg>곡 추가</button>
      <span class="spacer"></span>
      <label class="search"><svg><use href="#i-search"/></svg><input id="filter" type="search" placeholder="이 목록에서 찾기" value="${esc(state.filter)}"></label>
      ${p.kind === 'local' ? '' : '<button class="icon-btn" id="resync" title="유튜브와 다시 맞추기"><svg><use href="#i-sync"/></svg></button>'}
      <button class="icon-btn danger" id="removePl" title="${p.kind === 'local' ? '플레이리스트 삭제' : '라이브러리에서 빼기'}"><svg><use href="#i-trash"/></svg></button>
    </div>
    <ol class="tracks" id="trackList"></ol>`;

  $('#playAll').onclick = () => startPlayback(0, false);
  $('#shuffleAll').onclick = () => startPlayback(null, true);
  $('#addSongs').onclick = openAdd;
  if ($('#resync')) $('#resync').onclick = () => resyncCurrent();
  $('#removePl').onclick = () => removeCurrent();
  $('#filter').oninput = (e) => { state.filter = e.target.value; renderTracks(); };
  renderTracks();
}

function renderTracks() {
  const list = $('#trackList');
  if (!list) return;
  const rows = visibleTracks();
  if (!state.tracks.length) {
    list.innerHTML = '<li class="empty">아직 곡이 없어요. 곡 추가를 눌러 노래를 검색해 담아보세요.</li>';
    return;
  }
  if (!rows.length) {
    list.innerHTML = '<li class="empty">찾는 곡이 없어요.</li>';
    return;
  }
  const cur = state.nowTrack?.id;
  const local = state.current?.kind === 'local';
  const order = new Map(state.tracks.map((t, i) => [t.id, i]));
  list.innerHTML = rows.map((t, i) => `
    <li class="track${t.id === cur ? ' current' : ''}${t._broken ? ' broken' : ''}" data-i="${i}">
      <span class="num">${t.id === cur ? `<span class="eq${state.playing ? '' : ' paused'}"><i></i><i></i><i></i></span>` : order.get(t.id) + 1}</span>
      ${t.thumbnail ? `<img src="${esc(t.thumbnail)}" alt="" loading="lazy">` : '<img alt="">'}
      <div style="min-width:0"><div class="t-title">${esc(t.title)}</div><div class="t-channel">${esc(t.channel)}</div></div>
      ${local || t.manual ? `<button class="icon-btn rm" data-rm="${t.id}" title="이 플레이리스트에서 빼기"><svg><use href="#i-x"/></svg></button>` : '<span></span>'}
    </li>`).join('');
}

$('#content').addEventListener('click', (e) => {
  const rm = e.target.closest('[data-rm]');
  if (rm) { removeTrack(rm.dataset.rm); return; }
  const row = e.target.closest('.track');
  if (row) startPlayback(Number(row.dataset.i), state.shuffle);
});

async function removeTrack(id) {
  const t = state.tracks.find((x) => x.id === id);
  if (!t) return;
  const { error } = await sb.from('tracks').delete().eq('id', id);
  if (error) return toast('빼지 못했어요: ' + error.message, 5000);
  state.tracks = state.tracks.filter((x) => x.id !== id);
  state.base = state.base.filter((x) => x.id !== id);
  const qi = state.queue.findIndex((x) => x.id === id);
  if (qi > state.qi) state.queue.splice(qi, 1);
  await bumpCount();
  renderPlaylist();
  renderUpNext();
  toast(`'${t.title}'을(를) 뺐어요`);
}

// 곡 수와 표지(첫 곡 썸네일)를 DB에 맞춰 둬요.
async function bumpCount() {
  const p = state.current;
  if (!p) return;
  const patch = { track_count: state.tracks.length };
  if (p.kind === 'local') patch.thumbnail = state.tracks[0]?.thumbnail || null;
  else if (!p.thumbnail && state.tracks[0]) patch.thumbnail = state.tracks[0].thumbnail;
  await sb.from('playlists').update(patch).eq('id', p.id);
  Object.assign(p, patch);
  renderLibrary();
}

async function openPlaylist(id) {
  const p = state.playlists.find((x) => x.id === id);
  if (!p) return;
  state.current = p;
  state.filter = '';
  setPref('lastPlaylist', id);
  renderLibrary();
  content.innerHTML = '<p class="loading">곡 목록을 여는 중…</p>';
  try {
    state.tracks = await loadTracks(id);
  } catch (e) {
    content.innerHTML = `<p class="empty">곡 목록을 열지 못했어요: ${esc(e.message)}</p>`;
    return;
  }
  if (state.current?.id === id) { renderPlaylist(); content.scrollTop = 0; }
}

async function resyncCurrent() {
  const p = state.current;
  if (!getYtToken()) return askReconnect();
  toast('유튜브와 맞추는 중…', 10000);
  try {
    await importOne({ id: p.youtube_id, title: p.title, thumb: p.thumbnail }, null);
    await loadPlaylists();
    toast('최신 상태로 맞췄어요');
    await openPlaylist(p.id);
  } catch (e) {
    if (e instanceof NeedYouTube) return askReconnect();
    toast(e.message, 5000);
  }
}

async function removeCurrent() {
  const p = state.current;
  const msg = p.kind === 'local'
    ? `'${p.title}' 플레이리스트를 삭제할까요? 담아둔 곡 목록도 함께 지워지고 되돌릴 수 없어요.`
    : `'${p.title}'을(를) 라이브러리에서 뺄까요? 유튜브의 원본 플레이리스트는 그대로 남아요.`;
  if (!confirm(msg)) return;
  const { error } = await sb.from('playlists').delete().eq('id', p.id);
  if (error) return toast('빼지 못했어요: ' + error.message, 5000);
  state.current = null;
  await loadPlaylists();
  renderLibrary();
  toast(p.kind === 'local' ? '플레이리스트를 삭제했어요' : '라이브러리에서 뺐어요');
  showHome();
}

function askReconnect() {
  toast('유튜브 연결이 만료됐어요. 다시 연결하는 중…', 4000);
  setTimeout(connectGoogle, 900);
}

function showHome() {
  if (!state.user) return renderWelcome();
  if (!state.playlists.length) return renderEmptyLibrary();
  const last = pref('lastPlaylist', null);
  const target = state.playlists.find((p) => p.id === last) || state.playlists[0];
  openPlaylist(target.id);
}

/* ─────────────────── 불러오기 창 ─────────────────── */
const dlg = $('#importDlg');
let importChoices = [];

async function openImport() {
  if (!getYtToken()) {
    // 토큰이 없으면 구글 로그인을 다시 거쳐야 유튜브를 읽을 수 있어요.
    setPref('openImportAfterLogin', true);
    return connectGoogle();
  }
  dlg.showModal();
  $('#importBody').innerHTML = '<p class="loading" style="padding:24px 8px">내 유튜브 플레이리스트를 확인하는 중…</p>';
  $('#importStatus').textContent = '';
  $('#importGo').disabled = true;
  try {
    importChoices = await fetchMyYtPlaylists();
  } catch (e) {
    if (e instanceof NeedYouTube) { dlg.close(); return askReconnect(); }
    $('#importBody').innerHTML = `<p class="empty">${esc(e.message)}</p>`;
    return;
  }
  const have = new Set(state.playlists.map((p) => p.youtube_id));
  $('#importBody').innerHTML = importChoices.map((p, i) => `
    <label class="pick">
      <input type="checkbox" value="${i}">
      ${p.thumb ? `<img src="${esc(p.thumb)}" alt="" loading="lazy">` : '<span class="ph"></span>'}
      <span style="min-width:0">
        <span class="p-title" style="display:block">${esc(p.title)}</span>
        <span class="p-sub">${p.count === null ? '최대 1000개' : `동영상 ${p.count}개`}${have.has(p.id) ? ' <b>불러옴</b>' : ''}</span>
      </span>
    </label>`).join('') +
    (importChoices.length === 1 ? '<p class="empty">유튜브에 만든 플레이리스트가 없어요. 좋아요 표시한 동영상은 가져올 수 있어요.</p>' : '');
  updateImportButton();
}

function updateImportButton() {
  const n = dlg.querySelectorAll('.pick input:checked').length;
  $('#importGo').disabled = n === 0;
  $('#importGo').textContent = n ? `${n}개 불러오기` : '불러오기';
}
$('#importBody').addEventListener('change', updateImportButton);
$('#openImport').onclick = openImport;

$('#importGo').onclick = async () => {
  const picked = [...dlg.querySelectorAll('.pick input:checked')].map((c) => importChoices[Number(c.value)]);
  const go = $('#importGo');
  const status = $('#importStatus');
  go.disabled = true;
  let last = null, done = 0;
  for (const p of picked) {
    try {
      last = await importOne(p, (n) => { status.textContent = `${p.title}: 곡 ${n}개 읽는 중`; });
      done++;
    } catch (e) {
      if (e instanceof NeedYouTube) { dlg.close(); return askReconnect(); }
      toast(`'${p.title}' 불러오기 실패: ${e.message}`, 6000);
    }
  }
  status.textContent = '';
  await loadPlaylists();
  renderLibrary();
  dlg.close();
  if (done) {
    toast(`플레이리스트 ${done}개를 불러왔어요`);
    if (last) openPlaylist(last.id);
  }
};

/* ─────────────────── 새 플레이리스트 ─────────────────── */
const newDlg = $('#newDlg');
function openNew() {
  $('#newName').value = '';
  newDlg.showModal();
  $('#newName').focus();
}
$('#openNew').onclick = openNew;
$('#newCancel').onclick = () => newDlg.close();
$('#newForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = $('#newName').value.trim();
  if (!title) return;
  const { data, error } = await sb.from('playlists')
    .insert({ user_id: state.user.id, kind: 'local', youtube_id: null, title, track_count: 0 })
    .select().single();
  if (error) return toast('만들지 못했어요: ' + error.message, 5000);
  newDlg.close();
  await loadPlaylists();
  renderLibrary();
  await openPlaylist(data.id);
  openAdd();
});

/* ─────────────────── 곡 추가 (검색 / 링크) ─────────────────── */
const addDlg = $('#addDlg');
let addResults = [];
let addNextPage = null;
let addLastQuery = '';

function openAdd() {
  if (!state.current) return;
  $('#addSub').textContent = `'${state.current.title}'에 담아요`;
  $('#addStatus').textContent = '';
  addDlg.showModal();
  $('#addQuery').focus();
  $('#addQuery').select();
}
$('#addClose').onclick = () => addDlg.close();

// 유튜브 링크에서 영상 ID 꺼내기
function videoIdFrom(text) {
  const s = text.trim();
  const m = s.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/|\/live\/)([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  return null;
}

async function searchYt(body) {
  const { data, error } = await sb.functions.invoke('yt-search', { body });
  if (error) {
    let reason = '';
    try { reason = (await error.context.json()).error; } catch {}
    const messages = {
      NO_KEY: '검색용 API 키가 아직 설정되지 않았어요. Supabase 비밀값에 YOUTUBE_API_KEY를 넣어주세요.',
      quotaExceeded: '오늘 검색 횟수를 다 썼어요(하루 약 100번). 오후 4~5시쯤 초기화돼요. 링크 붙여넣기는 계속 돼요.',
      keyInvalid: 'API 키가 올바르지 않아요. 키를 다시 복사해서 넣어주세요.',
      forbidden: 'API 키에 YouTube Data API v3 사용 권한이 없어요.',
      accessNotConfigured: 'Google Cloud에서 YouTube Data API v3가 꺼져 있어요.',
      LOGIN_REQUIRED: '로그인이 풀렸어요. 새로고침 후 다시 로그인해주세요.',
    };
    throw new Error(messages[reason] || `검색하지 못했어요 (${reason || error.message})`);
  }
  return data;
}

function renderAddResults(append = false) {
  const body = $('#addBody');
  if (!addResults.length) {
    body.innerHTML = '<p class="hint">찾는 결과가 없어요. 가수 이름과 노래 제목을 같이 써보세요.</p>';
    return;
  }
  const have = new Set(state.tracks.map((t) => t.video_id));
  body.innerHTML = addResults.map((r, i) => `
    <div class="result">
      ${r.thumbnail ? `<img src="${esc(r.thumbnail)}" alt="" loading="lazy">` : '<img alt="">'}
      <div style="min-width:0"><div class="r-title">${esc(r.title)}</div><div class="r-channel">${esc(r.channel)}</div></div>
      ${have.has(r.video_id)
        ? '<span class="add-btn done"><svg><use href="#i-check"/></svg>담김</span>'
        : `<button class="add-btn" data-add="${i}"><svg><use href="#i-plus"/></svg>담기</button>`}
    </div>`).join('') +
    (addNextPage ? '<button class="btn-ghost more-btn" id="addMore">결과 더 보기</button>' : '');
  if (!append) body.scrollTop = 0;
}

$('#addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#addQuery').value.trim();
  if (!text) return;
  const body = $('#addBody');
  const vid = videoIdFrom(text);
  body.innerHTML = `<p class="hint">${vid ? '링크의 영상을 확인하는 중…' : '유튜브에서 찾는 중…'}</p>`;
  try {
    const r = await searchYt(vid ? { id: vid } : { q: text });
    addResults = r.items || [];
    addNextPage = vid ? null : r.nextPageToken;
    addLastQuery = text;
    if (vid && addResults[0] && !addResults[0].embeddable) {
      body.innerHTML = '<p class="hint">이 영상은 외부 재생이 막혀 있어서 앱에서 틀 수 없어요. 같은 노래의 다른 영상(예: 가수 이름 - Topic 채널)을 검색해보세요.</p>';
      return;
    }
    renderAddResults();
  } catch (err) {
    body.innerHTML = `<p class="hint">${esc(err.message)}</p>`;
  }
});

$('#addBody').addEventListener('click', async (e) => {
  if (e.target.closest('#addMore')) {
    const btn = e.target.closest('#addMore');
    btn.disabled = true;
    btn.textContent = '불러오는 중…';
    try {
      const r = await searchYt({ q: addLastQuery, pageToken: addNextPage });
      const seen = new Set(addResults.map((x) => x.video_id));
      addResults.push(...(r.items || []).filter((x) => !seen.has(x.video_id)));
      addNextPage = r.nextPageToken;
      renderAddResults(true);
    } catch (err) {
      toast(err.message, 5000);
      btn.remove();
    }
    return;
  }
  const btn = e.target.closest('[data-add]');
  if (!btn) return;
  btn.disabled = true;
  await addTrack(addResults[Number(btn.dataset.add)], btn);
});

async function addTrack(item, btn) {
  const p = state.current;
  if (!p || !item) return;
  if (state.tracks.some((t) => t.video_id === item.video_id)) return;
  const position = state.tracks.reduce((m, t) => Math.max(m, t.position), -1) + 1;
  const { data, error } = await sb.from('tracks').insert({
    playlist_id: p.id,
    user_id: state.user.id,
    video_id: item.video_id,
    title: item.title,
    channel: item.channel,
    thumbnail: item.thumbnail,
    position,
    manual: true,
  }).select().single();
  if (error) {
    if (btn) btn.disabled = false;
    return toast('담지 못했어요: ' + error.message, 5000);
  }
  state.tracks.push(data);
  // 재생 중인 목록이 이 플레이리스트라면 다음 곡 목록 끝에도 붙여요.
  if (state.base.length && state.base.some((t) => t.playlist_id === p.id)) {
    state.base.push(data);
    state.queue.push(data);
    renderUpNext();
  }
  if (btn) btn.outerHTML = '<span class="add-btn done"><svg><use href="#i-check"/></svg>담김</span>';
  $('#addStatus').textContent = `'${item.title}' 담음`;
  await bumpCount();
  renderPlaylist();
}

/* ─────────────────── 재생 ─────────────────── */
function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function startPlayback(index, shuffle) {
  const rows = visibleTracks().filter((t) => !t._broken);
  if (!rows.length) return;
  const all = visibleTracks();
  let first = index === null ? null : all[index];
  if (first?._broken) first = null;
  state.base = rows;
  if (shuffle !== state.shuffle) setShuffle(shuffle, false);
  if (shuffle) {
    const start = first || rows[Math.floor(Math.random() * rows.length)];
    state.queue = [start, ...shuffled(rows.filter((t) => t !== start))];
    state.qi = 0;
  } else {
    state.queue = rows.slice();
    state.qi = Math.max(0, first ? rows.indexOf(first) : 0);
  }
  state.errorStreak = 0;
  playCurrent();
}

function playCurrent() {
  const t = state.queue[state.qi];
  if (!t) return;
  state.nowTrack = t;
  $('#now').classList.remove('idle');
  $('#nowTitle').textContent = t.title;
  $('#nowChannel').textContent = t.channel || '';
  $('#mini').hidden = false;
  $('#miniThumb').src = t.thumbnail || '';
  $('#miniTitle').textContent = t.title;
  $('#miniChannel').textContent = t.channel || '';
  document.title = `${t.title} · Replay`;
  setRange($('#seek'), 0, 1000);
  $('#tCur').textContent = '0:00';
  $('#tDur').textContent = '0:00';
  loadVideo(t.video_id);
  renderTracks();
  renderUpNext();
  updateMediaSession(t);
}

function next(auto = false) {
  if (!state.queue.length) return;
  if (auto && state.repeat === 'one') { state.player?.seekTo(0, true); state.player?.playVideo(); return; }
  if (state.qi < state.queue.length - 1) {
    state.qi++;
  } else if (state.repeat === 'all' || !auto) {
    if (state.shuffle) state.queue = shuffled(state.base);
    state.qi = 0;
  } else {
    state.player?.stopVideo();
    return;
  }
  playCurrent();
}

function prev() {
  if (!state.queue.length) return;
  const cur = state.player?.getCurrentTime?.() || 0;
  if (cur > 3 || state.qi === 0) { state.player?.seekTo(0, true); return; }
  state.qi--;
  playCurrent();
}

function togglePlay() {
  if (!state.player || !state.nowTrack) {
    if (state.current && state.tracks.length) startPlayback(0, state.shuffle);
    return;
  }
  if (state.playing) state.player.pauseVideo(); else state.player.playVideo();
}

function setShuffle(on, reorder = true) {
  state.shuffle = on;
  setPref('shuffle', on);
  $('#shuffleBtn').setAttribute('aria-pressed', on);
  $('#shuffleBtn').title = on ? '셔플 켜짐' : '셔플';
  if (!reorder || !state.nowTrack || !state.base.length) return;
  const cur = state.nowTrack;
  if (on) {
    state.queue = [cur, ...shuffled(state.base.filter((t) => t !== cur))];
    state.qi = 0;
  } else {
    state.queue = state.base.slice();
    state.qi = Math.max(0, state.base.indexOf(cur));
  }
  renderUpNext();
}

function cycleRepeat() {
  state.repeat = { off: 'all', all: 'one', one: 'off' }[state.repeat];
  setPref('repeat', state.repeat);
  applyRepeatUi();
  toast({ off: '반복 안 함', all: '전체 반복', one: '한 곡 반복' }[state.repeat], 1500);
}
function applyRepeatUi() {
  const b = $('#repeatBtn');
  b.setAttribute('aria-pressed', state.repeat !== 'off');
  b.title = { off: '반복 안 함', all: '전체 반복', one: '한 곡 반복' }[state.repeat];
  $('#repeatOne').hidden = state.repeat !== 'one';
}

function renderUpNext() {
  const ol = $('#upNext');
  const upcoming = state.queue.slice(state.qi + 1, state.qi + 21);
  if (!upcoming.length) {
    ol.innerHTML = `<li class="empty">${state.repeat === 'all' ? '처음부터 다시 재생해요' : '마지막 곡이에요'}</li>`;
    return;
  }
  ol.innerHTML = upcoming.map((t, k) => `
    <li data-k="${state.qi + 1 + k}">
      ${t.thumbnail ? `<img src="${esc(t.thumbnail)}" alt="" loading="lazy">` : '<img alt="">'}
      <div><p>${esc(t.title)}</p><p>${esc(t.channel)}</p></div>
    </li>`).join('');
}
$('#upNext').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-k]');
  if (!li) return;
  state.qi = Number(li.dataset.k);
  playCurrent();
});

/* ─────────────────── 유튜브 플레이어 ─────────────────── */
window.onYouTubeIframeAPIReady = () => {
  state.apiReady = true;
  if (state.pendingVideo) createPlayer(state.pendingVideo);
};
(function loadYtApi() {
  const s = document.createElement('script');
  s.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(s);
})();

// 일반 유튜브 플레이어: 유튜브에 로그인돼 있으면 프리미엄이 적용돼 광고 없이 재생돼요.
// (대신 여기서 들은 곡은 유튜브 시청 기록에 남아요.)
function createPlayer(videoId, start = 0) {
  state.player = new YT.Player('ytPlayer', {
    width: '100%', height: '100%', videoId,
    playerVars: { autoplay: 1, playsinline: 1, rel: 0, origin: location.origin, start: Math.floor(start) },
    events: {
      onReady: (e) => { e.target.setVolume(state.volume); e.target.playVideo(); },
      onStateChange: onPlayerState,
      onError: onPlayerError,
    },
  });
  state.pendingVideo = null;
}

function loadVideo(videoId) {
  if (state.player?.loadVideoById) { state.player.loadVideoById(videoId); return; }
  if (state.apiReady && !state.player) { createPlayer(videoId); return; }
  state.pendingVideo = videoId;
}

function onPlayerState(e) {
  const S = YT.PlayerState;
  if (e.data === S.PLAYING) { state.playing = true; state.errorStreak = 0; }
  else if (e.data === S.PAUSED || e.data === S.ENDED) state.playing = false;
  if (e.data === S.ENDED) next(true);
  syncPlayIcons();
  renderTracksPlayingState();
}

function onPlayerError(e) {
  const t = state.nowTrack;
  if (t) t._broken = true;
  state.errorStreak++;
  const why = (e.data === 101 || e.data === 150) ? '외부 재생이 막힌 영상이라' : '재생할 수 없는 영상이라';
  if (state.errorStreak >= Math.min(8, state.queue.length)) {
    state.playing = false;
    syncPlayIcons();
    toast('재생할 수 있는 곡을 찾지 못해 멈췄어요', 5000);
    return;
  }
  toast(`${why} 건너뛰었어요: ${t?.title ?? ''}`, 3500);
  setTimeout(() => next(false), 400);
}

function syncPlayIcons() {
  const icon = state.playing ? '#i-pause' : '#i-play';
  const label = state.playing ? '일시정지' : '재생';
  for (const id of ['#playBtn', '#miniPlay']) {
    const b = $(id);
    b.querySelector('use').setAttribute('href', icon);
    b.title = label;
  }
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = state.playing ? 'playing' : 'paused';
}
function renderTracksPlayingState() {
  document.querySelectorAll('.track .eq').forEach((el) => el.classList.toggle('paused', !state.playing));
}

// 진행 막대 갱신
setInterval(() => {
  const p = state.player;
  if (!p?.getCurrentTime || !state.nowTrack) return;
  const cur = p.getCurrentTime() || 0, dur = p.getDuration() || 0;
  if (!state.seeking) setRange($('#seek'), dur ? Math.round((cur / dur) * 1000) : 0, 1000);
  $('#tCur').textContent = fmt(cur);
  $('#tDur').textContent = fmt(dur);
  $('#miniProgress').style.width = dur ? `${(cur / dur) * 100}%` : '0';
}, 500);

const seek = $('#seek');
seek.addEventListener('input', () => {
  state.seeking = true;
  seek.style.setProperty('--p', `${seek.value / 10}%`);
  const dur = state.player?.getDuration?.() || 0;
  $('#tCur').textContent = fmt((seek.value / 1000) * dur);
});
seek.addEventListener('change', () => {
  const dur = state.player?.getDuration?.() || 0;
  state.player?.seekTo((seek.value / 1000) * dur, true);
  state.seeking = false;
});

const vol = $('#vol');
setRange(vol, state.volume, 100);
vol.addEventListener('input', () => {
  state.volume = Number(vol.value);
  setRange(vol, state.volume, 100);
  state.player?.setVolume?.(state.volume);
  setPref('volume', state.volume);
});

$('#playBtn').onclick = togglePlay;
$('#miniPlay').onclick = togglePlay;
$('#nextBtn').onclick = () => next(false);
$('#miniNext').onclick = () => next(false);
$('#prevBtn').onclick = prev;
$('#shuffleBtn').onclick = () => setShuffle(!state.shuffle);
$('#repeatBtn').onclick = cycleRepeat;
$('#shuffleBtn').setAttribute('aria-pressed', state.shuffle);
applyRepeatUi();

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, dialog') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowRight' && e.shiftKey) next(false);
  else if (e.key === 'ArrowLeft' && e.shiftKey) prev();
});

function updateMediaSession(t) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title, artist: t.channel || '', album: state.current?.title || 'Replay',
    artwork: t.thumbnail ? [{ src: t.thumbnail, sizes: '320x180', type: 'image/jpeg' }] : [],
  });
  const h = { play: togglePlay, pause: togglePlay, nexttrack: () => next(false), previoustrack: prev };
  for (const [k, fn] of Object.entries(h)) { try { navigator.mediaSession.setActionHandler(k, fn); } catch {} }
}

/* ─────────────────── 로그인 상태 ─────────────────── */
$('#signOut').onclick = async () => {
  await sb.auth.signOut();
  clearYtToken();
  location.reload();
};

let seenUid; // undefined = 아직 한 번도 확인 안 함
sb.auth.onAuthStateChange((event, session) => {
  // 유튜브 토큰은 방금 구글 로그인을 마쳤을 때만 새것이에요. 새로고침 때 남아 있는 옛 토큰은 쓰지 않아요.
  if (session?.provider_token && (event === 'SIGNED_IN' || cameFromOAuth)) saveYtToken(session.provider_token);
  const uid = session?.user?.id || null;
  if (uid === seenUid) return;
  seenUid = uid;
  // 콜백 안에서 Supabase를 다시 부르면 멈출 수 있어서, 한 박자 뒤로 미뤄요.
  setTimeout(() => onUser(session?.user || null), 0);
});

async function onUser(user) {
  state.user = user;
  if (!user) {
    state.playlists = [];
    renderLibrary();
    renderWelcome();
    return;
  }
  // 로그인 직후 주소창에 남은 ?code= 같은 흔적 지우기
  if (location.search || location.hash) history.replaceState(null, '', location.pathname);
  await loadPlaylists();
  renderLibrary();
  if (pref('openImportAfterLogin', false) || (!state.playlists.length && getYtToken())) {
    setPref('openImportAfterLogin', false);
    showHome();
    if (getYtToken()) openImport();
    return;
  }
  showHome();
}

// 로그인 오류가 주소에 담겨 돌아온 경우 알려주기
(() => {
  const q = new URLSearchParams(location.search + '&' + location.hash.slice(1));
  const err = q.get('error_description');
  if (err) toast('로그인 실패: ' + err.replace(/\+/g, ' '), 7000);
})();

/* ─────────────────── 윈도우 앱 연동 ─────────────────── */
if (desktop) {
  document.body.classList.add('desktop');

  // 브라우저에서 로그인을 마치면 앱이 받은 코드를 여기로 넘겨줘요.
  desktop.onAuthCode((code) => {
    location.replace(location.pathname + '?code=' + encodeURIComponent(code));
  });
  desktop.onAuthError((msg) => toast('로그인 실패: ' + msg, 7000));

  // 키보드의 미디어 키
  desktop.onMediaKey((key) => {
    if (key === 'playpause') togglePlay();
    else if (key === 'next') next(false);
    else if (key === 'prev') prev();
  });

  // 미니 플레이어 전환
  const toggle = $('#miniToggle');
  toggle.hidden = false;
  let mini = false;
  const setMini = async (on) => {
    mini = on;
    document.body.classList.toggle('mini-mode', on);
    toggle.querySelector('use').setAttribute('href', on ? '#i-expand' : '#i-mini');
    toggle.title = on ? '크게 보기' : '미니 플레이어로 전환';
    await desktop.setMini(on);
  };
  toggle.onclick = () => setMini(!mini);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && mini && !document.querySelector('dialog[open]')) setMini(false);
  });

  // 유튜브 프리미엄 연결: 앱 창 안에서 유튜브에 로그인해야 광고 없이 재생돼요. (앱 1.1.0부터)
  if (desktop.ytLogin) {
    const btn = $('#ytPremium');
    const refresh = async () => {
      const ok = await desktop.ytStatus();
      btn.hidden = ok;
      return ok;
    };
    refresh();
    btn.onclick = async () => {
      const ok = await desktop.ytLogin();
      if (!ok) return toast('유튜브에 로그인하지 않았어요. 로그인 창이 막히면 크롬에서 웹 버전을 써주세요.', 6000);
      await refresh();
      resetPlayer();
      toast('유튜브 프리미엄이 연결됐어요. 이제 광고 없이 재생돼요', 4000);
    };
  }
}

// 로그인 상태가 바뀌면 플레이어를 새로 만들어야 적용돼요. 듣던 곡은 그 자리부터 이어서 틀어요.
function resetPlayer() {
  if (!state.player) return;
  const at = state.player.getCurrentTime?.() || 0;
  const wasPlaying = state.playing;
  try { state.player.destroy(); } catch {}
  state.player = null;
  state.playing = false;
  document.querySelector('.screen').innerHTML = '<div id="ytPlayer"></div>';
  if (state.nowTrack && wasPlaying) createPlayer(state.nowTrack.video_id, at);
  syncPlayIcons();
}
