/* SIPAT CHALLENGE — cliente Supabase
 * Usa somente a chave anon/publicável. A validação e a pontuação são feitas no PostgreSQL.
 */
'use strict';

const CONFIG = {
  SUPABASE_URL: 'https://kffdbfmawbdewnlzuqdm.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtmZmRiZm1hd2JkZXdubHp1cWRtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM5MDI0ODAsImV4cCI6MjEwOTQ3ODQ4MH0.QTD_qlWUDZqrJ009HRmvscjn31t3H2Vs7_dkzRUm9NE'
};
const db = window.supabase?.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
const TOKEN_KEY = 'sipat_challenge_participant_token_v1';
const AVATARS = ['👷','👷‍♀️','🦺','⛑️','🚧','🏗️','🧤','🧑‍🔧','👩‍🔧','👨‍🏭','👩‍🏭','🧑‍🚒','🦺','🛠️','🦺','🧑‍🔬','👩‍🔬','👨‍🔬','🤖','🦊','🐼','🦁','🐯','🐸','🐵','🐻','🐨','🐰','🐱','🐶','🐺','🦉','🐢','🐙','🐝','🐬','🦈','🦖','🦋','🦝'];
const $ = id => document.getElementById(id);
let participant = null;
let accessToken = '';
let activeQuestion = null;
let chosenAnswer = null;
let selectedAvatar = AVATARS[0];
let activeRoom = null;
let roomFromUrl = new URLSearchParams(location.search).get('room');
let adminUser = null;
let allAdminQuestions = [];
let allAdminRooms = [];
let toastTimer = null;

function toast(message) {
  const el = $('toast'); if (!el) return;
  el.textContent = message; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}
function message(id, value, error = false) {
  const el = $(id); if (!el) return;
  el.textContent = value; el.classList.toggle('error', error);
  if (error) el.style.color = '#b42318'; else el.style.color = '#168447';
}
function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function requireDB() {
  if (!db) { toast('Não foi possível inicializar o Supabase. Confira a conexão e a configuração.'); return false; }
  return true;
}
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'ranking') loadRanking();
  if (name === 'admin' && adminUser) loadAdminData();
}
document.querySelectorAll('.nav-btn').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
$('brand-home').addEventListener('click', e => { e.preventDefault(); showView('home'); });

function renderAvatarGrid(targetId, current, onPick) {
  const grid = $(targetId); grid.innerHTML = '';
  AVATARS.forEach((avatar, index) => {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'avatar-choice' + (avatar === current ? ' selected' : '');
    btn.textContent = avatar; btn.setAttribute('aria-label', `Avatar ${index + 1}`);
    btn.addEventListener('click', () => onPick(avatar)); grid.appendChild(btn);
  });
}
function renderJoinAvatars() {
  renderAvatarGrid('avatar-picker', selectedAvatar, avatar => { selectedAvatar = avatar; renderJoinAvatars(); });
}
renderJoinAvatars();

async function resolveRoom() {
  if (!requireDB()) return;
  if (!roomFromUrl) {
    $('room-context').classList.add('hidden');
    $('join-title').textContent = 'Acesse pelo QR Code da SIPAT';
    $('join-description').textContent = 'Escaneie o QR Code disponibilizado pela organização para entrar diretamente na sala do dia.';
    $('join-form').classList.add('hidden');
    message('login-message', 'Nenhuma sala foi informada. Escaneie o QR Code da sua sala.');
    return;
  }
  const { data, error } = await db.rpc('participant_room_info', { p_room_code: roomFromUrl.trim() });
  if (error || !data || data.active !== true) {
    $('login-panel').classList.add('hidden'); $('room-invalid').classList.remove('hidden');
    $('room-invalid-message').textContent = error?.message || 'Esta sala não está ativa ou não existe. Procure a organização.';
    return;
  }
  activeRoom = data;
  $('room-context').classList.remove('hidden');
  $('room-context').innerHTML = `<strong>SALA ${escapeHTML(data.code)}</strong>Dia ${Number(data.day)} da SIPAT • Acesso liberado`;
  $('join-title').textContent = 'Identifique-se para entrar';
  $('join-description').textContent = 'Informe seu nome, setor e escolha um avatar. Não é necessário criar conta ou digitar senha.';
  $('join-form').classList.remove('hidden');
}

$('join-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!requireDB() || !activeRoom) return;
  const name = $('participant-name').value.trim();
  const sector = $('participant-sector').value.trim();
  if (name.length < 2 || sector.length < 2) { message('login-message', 'Informe nome e setor corretamente.', true); return; }
  const btn = $('join-btn'); btn.disabled = true; btn.textContent = 'Entrando...';
  const { data, error } = await db.rpc('participant_join_room', {
    p_room_code: String(activeRoom.code), p_name: name, p_sector: sector, p_avatar: selectedAvatar
  });
  btn.disabled = false; btn.textContent = 'Entrar na sala →';
  if (error || !data?.access_token) { message('login-message', error?.message || 'Não foi possível entrar na sala.', true); return; }
  accessToken = data.access_token;
  localStorage.setItem(TOKEN_KEY, accessToken);
  participant = data.participant;
  await enterParticipant();
});

async function restoreParticipant() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token || !requireDB()) return;
  const { data, error } = await db.rpc('participant_session_info', { p_access_token: token });
  if (error || !data?.id) { localStorage.removeItem(TOKEN_KEY); return; }
  // Se o QR Code aponta para outra sala (ou sala inválida), não reutilize a sessão anterior.
  if (roomFromUrl && (!activeRoom || String(data.room_code) !== String(roomFromUrl))) return;
  accessToken = token; participant = data;
  activeRoom = { code: data.room_code, day: data.day, active: true };
  await enterParticipant();
}
async function enterParticipant() {
  $('login-panel').classList.add('hidden'); $('room-invalid').classList.add('hidden');
  $('participant-panel').classList.remove('hidden'); $('quiz-empty').classList.remove('hidden'); $('quiz-area').classList.add('hidden');
  $('my-name').textContent = participant.name; $('my-sector').textContent = participant.sector;
  $('my-avatar').textContent = participant.avatar || selectedAvatar;
  $('my-room').textContent = `Sala ${participant.room_code || activeRoom?.code || '—'} • Dia ${participant.day || activeRoom?.day || '—'}`;
  selectedAvatar = participant.avatar || AVATARS[0];
  renderLoggedAvatars();
  await refreshMyStats();
  message('game-message', 'Participação confirmada. Bom desafio!');
}
function renderLoggedAvatars() {
  renderAvatarGrid('avatar-picker-logged', selectedAvatar, avatar => { selectedAvatar = avatar; renderLoggedAvatars(); });
}
$('save-avatar').addEventListener('click', async () => {
  if (!participant || !requireDB()) return;
  const { error } = await db.rpc('participant_set_avatar', { p_access_code: accessToken, p_avatar: selectedAvatar });
  if (error) { message('game-message', error.message, true); return; }
  participant.avatar = selectedAvatar; $('my-avatar').textContent = selectedAvatar; toast('Avatar atualizado!');
});
$('participant-logout').addEventListener('click', () => {
  localStorage.removeItem(TOKEN_KEY); participant = null; accessToken = ''; activeQuestion = null;
  $('participant-panel').classList.add('hidden'); $('login-panel').classList.remove('hidden');
  $('quiz-area').classList.add('hidden'); $('quiz-empty').classList.remove('hidden');
  $('join-form').reset(); selectedAvatar = AVATARS[0]; renderJoinAvatars();
});
async function refreshMyStats() {
  if (!participant || !requireDB()) return;
  const { data, error } = await db.rpc('participant_my_stats', { p_access_code: accessToken });
  if (error) { message('game-message', error.message, true); return; }
  $('my-points').textContent = data?.points ?? 0;
  $('my-attempts').textContent = data?.answers ?? 0;
  $('my-rank').textContent = data?.rank ? `${data.rank}º` : '—';
}

$('official-btn').addEventListener('click', () => loadQuestion('official'));
$('bonus-btn').addEventListener('click', () => loadQuestion('bonus'));
async function loadQuestion(kind) {
  if (!participant || !requireDB()) return;
  activeQuestion = null; chosenAnswer = null;
  $('quiz-empty').classList.add('hidden'); $('quiz-area').classList.remove('hidden');
  $('question-text').textContent = 'Carregando pergunta...'; $('answer-options').innerHTML = '';
  $('answer-feedback').textContent = ''; $('answer-submit').disabled = true;
  const { data, error } = await db.rpc('participant_next_question', { p_access_code: accessToken, p_kind: kind });
  if (error) { $('question-text').textContent = 'Não foi possível carregar a pergunta.'; message('answer-feedback', error.message, true); return; }
  if (!data || data.status === 'complete') {
    $('question-text').textContent = kind === 'official' ? 'Você já concluiu as perguntas oficiais disponíveis para este dia.' : 'Você respondeu todas as perguntas bônus disponíveis para este dia.';
    $('question-kind').textContent = kind === 'official' ? 'OFICIAL' : 'BÔNUS';
    $('question-points').textContent = ''; $('question-day').textContent = `Sala ${activeRoom?.code || participant.room_code} • Dia ${activeRoom?.day || participant.day}`;
    $('answer-options').innerHTML = ''; return;
  }
  activeQuestion = data;
  $('question-kind').textContent = kind === 'official' ? 'DESAFIO OFICIAL' : 'RODADA BÔNUS';
  $('question-points').textContent = `Vale ${data.points} pontos`;
  $('question-day').textContent = `DIA ${data.day} • SALA ${activeRoom?.code || participant.room_code}`;
  $('question-text').textContent = data.prompt;
  const order = data.options.map((text, index) => ({ text, index })).sort(() => Math.random() - .5);
  order.forEach((option, index) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'answer-option';
    button.textContent = `${String.fromCharCode(65 + index)}. ${option.text}`;
    button.addEventListener('click', () => {
      chosenAnswer = option.index;
      document.querySelectorAll('.answer-option').forEach(el => el.classList.remove('selected'));
      button.classList.add('selected'); $('answer-submit').disabled = false;
    });
    $('answer-options').appendChild(button);
  });
}
$('answer-submit').addEventListener('click', async () => {
  if (!activeQuestion || chosenAnswer === null || !requireDB()) { message('answer-feedback', 'Escolha uma alternativa.', true); return; }
  const btn = $('answer-submit'); btn.disabled = true; btn.textContent = 'Registrando...';
  const { data, error } = await db.rpc('participant_submit_answer', {
    p_access_code: accessToken, p_question_id: activeQuestion.id, p_selected_index: chosenAnswer
  });
  btn.textContent = 'Confirmar resposta';
  if (error) { btn.disabled = false; message('answer-feedback', error.message, true); return; }
  document.querySelectorAll('.answer-option').forEach(el => { el.disabled = true; });
  message('answer-feedback', data.correct ? `Resposta correta! +${data.points} pontos.` : 'Resposta registrada. Continue aprendendo!');
  activeQuestion = null; chosenAnswer = null;
  await refreshMyStats(); await loadRanking();
});

async function loadRanking() {
  if (!requireDB()) return;
  const body = $('ranking-body'); body.innerHTML = '<tr><td colspan="4">Atualizando...</td></tr>';
  const { data, error } = await db.rpc('public_leaderboard', { p_limit: 650 });
  if (error) { body.innerHTML = `<tr><td colspan="4">${escapeHTML(error.message)}</td></tr>`; return; }
  body.innerHTML = '';
  (data || []).forEach((p, i) => {
    const tr = document.createElement('tr');
    const rank = document.createElement('td'); rank.textContent = String(i + 1);
    const nameCell = document.createElement('td'); nameCell.innerHTML = `<span class="rank-avatar">${escapeHTML(p.avatar || '🙂')}</span>${escapeHTML(p.name)}`;
    const sector = document.createElement('td'); sector.textContent = p.sector;
    const points = document.createElement('td'); const strong = document.createElement('b'); strong.textContent = p.points; points.appendChild(strong);
    tr.append(rank, nameCell, sector, points); body.appendChild(tr);
  });
  if (!data?.length) body.innerHTML = '<tr><td colspan="4">Ainda não há participantes no ranking.</td></tr>';
}
$('refresh-ranking').addEventListener('click', loadRanking);

// ADMINISTRAÇÃO — autenticação existente do Supabase Auth e autorização pela tabela admins.
$('admin-login-btn').addEventListener('click', adminLogin);
async function adminLogin() {
  if (!requireDB()) return;
  const email = $('admin-email').value.trim(), password = $('admin-password').value;
  if (!email || !password) { message('admin-message', 'Informe e-mail e senha.', true); return; }
  const btn = $('admin-login-btn'); btn.disabled = true;
  const { data, error } = await db.auth.signInWithPassword({ email, password }); btn.disabled = false;
  if (error) { message('admin-message', 'Não foi possível entrar. Confira suas credenciais.', true); return; }
  const { data: allowed, error: roleError } = await db.from('admins').select('user_id,display_name').eq('user_id', data.user.id).maybeSingle();
  if (roleError || !allowed) { await db.auth.signOut(); message('admin-message', 'Esta conta não possui permissão administrativa.', true); return; }
  adminUser = data.user; $('admin-login').classList.add('hidden'); $('admin-panel').classList.remove('hidden');
  $('admin-who').textContent = allowed.display_name || data.user.email;
  await loadAdminData();
}
$('admin-logout').addEventListener('click', async () => {
  await db.auth.signOut(); adminUser = null; $('admin-panel').classList.add('hidden'); $('admin-login').classList.remove('hidden');
});
async function loadAdminData() {
  if (!adminUser) return;
  const [p, q, a] = await Promise.all([
    db.from('participants').select('id', { count: 'exact', head: true }),
    db.from('questions').select('id', { count: 'exact', head: true }).eq('active', true),
    db.from('attempts').select('id', { count: 'exact', head: true })
  ]);
  $('admin-participants').textContent = p.count ?? '—'; $('admin-questions').textContent = q.count ?? '—'; $('admin-answers').textContent = a.count ?? '—';
  await Promise.all([loadQuestionList(), loadRoomList()]);
  const { data, error } = await db.from('admin_attempts_view').select('*').order('created_at', { ascending: false }).limit(40);
  const tbody = $('admin-attempts'); tbody.innerHTML = '';
  if (error) { tbody.innerHTML = `<tr><td colspan="5">${escapeHTML(error.message)}</td></tr>`; return; }
  (data || []).forEach(x => {
    const tr = document.createElement('tr');
    [x.participant_name, `Dia ${x.day}`, x.kind === 'official' ? 'Oficial' : 'Bônus', x.correct ? 'Acertou' : 'Errou', x.points].forEach(value => { const td = document.createElement('td'); td.textContent = value; tr.appendChild(td); });
    tbody.appendChild(tr);
  });
}

$('add-question').addEventListener('click', async () => {
  if (!adminUser || !requireDB()) return;
  const prompt = $('q-text').value.trim();
  const options = [0,1,2,3].map(i => $(`opt-${i}`).value.trim());
  const points = Number($('q-points').value);
  if (!prompt || options.some(x => !x) || !Number.isInteger(points) || points < 1 || points > 1000) { message('question-message', 'Preencha a pergunta, as quatro alternativas e uma pontuação de 1 a 1000.', true); return; }
  const btn = $('add-question'); btn.disabled = true;
  const { error } = await db.from('questions').insert({ day: Number($('q-day').value), kind: $('q-kind').value, points, prompt, options, correct_index: Number($('q-correct').value) });
  btn.disabled = false;
  if (error) { message('question-message', error.message, true); return; }
  message('question-message', 'Pergunta cadastrada com sucesso.');
  $('q-text').value = ''; [0,1,2,3].forEach(i => $(`opt-${i}`).value = ''); await loadAdminData();
});
$('question-filter-day').addEventListener('change', renderQuestionList);
async function loadQuestionList() {
  const { data, error } = await db.from('questions').select('id,day,kind,prompt,options,correct_index,points,active,created_at').order('day').order('created_at', { ascending: true });
  if (error) { $('admin-question-list').textContent = error.message; return; }
  allAdminQuestions = data || []; renderQuestionList();
}
function renderQuestionList() {
  const container = $('admin-question-list'); container.innerHTML = '';
  const day = $('question-filter-day').value;
  const rows = allAdminQuestions.filter(q => day === 'all' || String(q.day) === day);
  if (!rows.length) { container.innerHTML = '<p class="empty-note">Nenhuma pergunta cadastrada neste filtro.</p>'; return; }
  rows.forEach(q => {
    const row = document.createElement('div'); row.className = 'question-row';
    const info = document.createElement('div'); info.className = 'question-row-info';
    const meta = document.createElement('small'); meta.textContent = `DIA ${q.day} • ${q.kind === 'official' ? 'OFICIAL' : 'BÔNUS'} • ${q.points} PTS • ${q.active ? 'ATIVA' : 'DESATIVADA'}`;
    const title = document.createElement('span'); title.textContent = q.prompt;
    const alternatives = document.createElement('small'); alternatives.textContent = (q.options || []).map((v, i) => `${String.fromCharCode(65+i)}: ${v}${i === q.correct_index ? ' ✓' : ''}`).join(' | ');
    info.append(meta, title, alternatives); row.appendChild(info);
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove-question'; remove.textContent = '−'; remove.title = q.active ? 'Desativar pergunta' : 'Pergunta desativada'; remove.disabled = !q.active;
    remove.addEventListener('click', () => deactivateQuestion(q)); row.appendChild(remove); container.appendChild(row);
  });
}
async function deactivateQuestion(question) {
  if (!confirm('Desativar somente esta pergunta? O histórico de respostas será preservado.')) return;
  const { error } = await db.from('questions').update({ active: false }).eq('id', question.id);
  if (error) { toast(`Não foi possível desativar: ${error.message}`); return; }
  toast('Pergunta desativada. O histórico foi preservado.'); await loadAdminData();
}

// SALAS
$('create-room').addEventListener('click', createRoom);
async function createRoom() {
  if (!adminUser || !requireDB()) return;
  const code = $('room-code').value.trim(); const day = Number($('room-day').value);
  if (!/^[A-Za-z0-9_-]{2,30}$/.test(code) || day < 1 || day > 5) { message('room-admin-message', 'Use um código de 2 a 30 caracteres (letras, números, _ ou -) e selecione o dia.', true); return; }
  const btn = $('create-room'); btn.disabled = true;
  const { data, error } = await db.rpc('admin_create_activate_room', { p_code: code, p_day: day }); btn.disabled = false;
  if (error) { message('room-admin-message', error.message, true); return; }
  activeRoom = data; message('room-admin-message', `Sala ${data.code} do Dia ${data.day} ativada com sucesso.`);
  await loadRoomList(); renderActiveRoom(); $('qr-output').innerHTML = '';
}
async function loadRoomList() {
  const { data, error } = await db.from('sipat_rooms').select('id,code,day,active,created_at,activated_at').order('created_at', { ascending: false }).limit(50);
  if (error) { $('room-list').textContent = error.message; return; }
  allAdminRooms = data || [];
  activeRoom = allAdminRooms.find(r => r.active) || null;
  renderActiveRoom(); renderRoomList();
}
function renderActiveRoom() {
  const box = $('active-room');
  if (!activeRoom) { box.textContent = 'Nenhuma sala ativa no momento.'; $('make-room-qr').disabled = true; $('copy-room-link').disabled = true; return; }
  box.innerHTML = `<strong>SALA ATIVA: ${escapeHTML(activeRoom.code)}</strong>Dia ${Number(activeRoom.day)} da SIPAT • Novas entradas liberadas`;
  $('make-room-qr').disabled = false; $('copy-room-link').disabled = false;
}
function renderRoomList() {
  const box = $('room-list'); box.innerHTML = '';
  if (!allAdminRooms.length) { box.innerHTML = '<p class="empty-note">Nenhuma sala criada ainda.</p>'; return; }
  allAdminRooms.forEach(room => {
    const row = document.createElement('div'); row.className = 'room-row';
    const info = document.createElement('div'); info.className = 'room-row-info';
    const title = document.createElement('span'); title.textContent = `Sala ${room.code} • Dia ${room.day}`;
    const meta = document.createElement('small'); meta.textContent = room.active ? 'ATIVA PARA NOVAS ENTRADAS' : 'INATIVA';
    info.append(title, meta); const status = document.createElement('span'); status.className = `room-status ${room.active ? 'active' : ''}`; status.textContent = room.active ? 'ATIVA' : 'INATIVA';
    row.append(info, status); box.appendChild(row);
  });
}
function roomUrl(room) { const url = new URL(location.href); url.search = ''; url.hash = ''; url.searchParams.set('room', room.code); return url.toString(); }
$('make-room-qr').addEventListener('click', () => {
  if (!activeRoom || !window.QRCode) { toast('Não foi possível gerar o QR Code.'); return; }
  const output = $('qr-output'); output.innerHTML = '';
  new QRCode(output, { text: roomUrl(activeRoom), width: 220, height: 220, colorDark: '#104d2c', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.H });
  const caption = document.createElement('p'); caption.className = 'muted small'; caption.textContent = `Acesso direto: ${roomUrl(activeRoom)}`; output.appendChild(caption);
});
$('copy-room-link').addEventListener('click', async () => {
  if (!activeRoom) return;
  const link = roomUrl(activeRoom);
  try { await navigator.clipboard.writeText(link); toast('Link da sala copiado!'); }
  catch { toast(link); }
});

$('export-ranking').addEventListener('click', async () => {
  if (!adminUser) return;
  const { data, error } = await db.rpc('admin_export_leaderboard');
  if (error) { toast(`Não foi possível exportar: ${error.message}`); return; }
  const rows = [['Posição','Nome','Setor','Pontos'], ...(data || []).map((x, i) => [i + 1, x.name, x.sector, x.points])];
  const csv = '\uFEFF' + rows.map(row => row.map(v => `"${String(v ?? '').replaceAll('"','""')}"`).join(';')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = 'ranking-sipat.csv'; a.click(); URL.revokeObjectURL(url);
});

async function restoreAdminSession() {
  if (!db) return;
  const { data } = await db.auth.getSession();
  if (!data?.session?.user) return;
  const { data: allowed } = await db.from('admins').select('user_id,display_name').eq('user_id', data.session.user.id).maybeSingle();
  if (!allowed) { await db.auth.signOut(); return; }
  adminUser = data.session.user; $('admin-login').classList.add('hidden'); $('admin-panel').classList.remove('hidden');
  $('admin-who').textContent = allowed.display_name || adminUser.email; await loadAdminData();
}

(async function init() {
  if (!requireDB()) return;
  await resolveRoom();
  await restoreParticipant();
  await restoreAdminSession();
  loadRanking();
})();
