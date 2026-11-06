'use strict';

/* =========================================================
   CONFIGURAÇÃO
========================================================= */

const SUPABASE_URL = 'https://kffdbfmawbdewnlzuqdm.supabase.co';

const SUPABASE_ANON_KEY =
  'SUA_SUPABASE_ANON_KEY_AQUI';

const db =
  window.supabase?.createClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY
  );

const PARTICIPANT_TOKEN_KEY = 'sipat_participant_token';

const AVATARS = [
  '🦺',
  '👷',
  '👷‍♀️',
  '👨‍🔧',
  '👩‍🔧',
  '🧑‍💻',
  '👨‍💼',
  '👩‍💼',
  '🧑‍🚒',
  '🚀',
  '⭐',
  '🏆',
  '😎',
  '🤝',
  '💪'
];

/* =========================================================
   ESTADO
========================================================= */

let participant = null;
let accessToken = null;

let activeQuestion = null;
let chosenAnswer = null;

let selectedAvatar = AVATARS[0];

let activeRoom = null;
let roomFromUrl = null;

let adminUser = null;

let adminQuestionList = [];
let adminRoomList = [];

let toastTimer = null;

/* =========================================================
   HELPERS
========================================================= */

function $(id) {
  return document.getElementById(id);
}

function requireDB() {
  if (!db) {
    toast(
      'Supabase não foi inicializado. Verifique o carregamento da biblioteca.',
      true
    );

    return false;
  }

  return true;
}

function toast(text, error = false) {
  const el = $('toast');

  if (!el) {
    alert(text);
    return;
  }

  clearTimeout(toastTimer);

  el.textContent = text;
  el.classList.toggle('error', error);
  el.classList.add('show');

  toastTimer = setTimeout(() => {
    el.classList.remove('show');
  }, 3500);
}

function message(id, text, error = false) {
  const el = $(id);

  if (!el) return;

  el.textContent = text;
  el.classList.toggle('error', error);
  el.classList.toggle('success', !error && Boolean(text));
}

function escapeHTML(value) {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function showView(viewId) {
  document.querySelectorAll('.view').forEach(view => {
    view.classList.add('hidden');
    view.classList.remove('active-view');
  });

  const view = $(viewId);

  if (view) {
    view.classList.remove('hidden');
    view.classList.add('active-view');
  }

  document
    .querySelectorAll('.nav-button')
    .forEach(button => {
      button.classList.toggle(
        'active',
        button.dataset.view === viewId
      );
    });
}

function normalizeText(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
}

/* =========================================================
   NAVEGAÇÃO
========================================================= */

function setupNavigation() {
  document
    .querySelectorAll('.nav-button')
    .forEach(button => {

      button.addEventListener('click', async () => {

        const viewId = button.dataset.view;

        showView(viewId);

        if (viewId === 'ranking-view') {
          await loadRanking();
        }

        if (viewId === 'admin-view' && adminUser) {
          await loadAdminData();
          await loadAdminParticipants();
          await loadAdminQuestions();
          await loadAdminRooms();
        }

      });

    });
}

/* =========================================================
   AVATARES
========================================================= */

function renderAvatarPicker(containerId, currentAvatar = null) {
  const container = $(containerId);

  if (!container) return;

  container.innerHTML = '';

  AVATARS.forEach(avatar => {

    const button = document.createElement('button');

    button.type = 'button';
    button.className = 'avatar-option';
    button.textContent = avatar;

    button.setAttribute(
      'aria-label',
      `Escolher avatar ${avatar}`
    );

    if (avatar === currentAvatar) {
      button.classList.add('selected');
    }

    button.addEventListener('click', () => {

      container
        .querySelectorAll('.avatar-option')
        .forEach(item => {
          item.classList.remove('selected');
        });

      button.classList.add('selected');

      selectedAvatar = avatar;

    });

    container.appendChild(button);
  });
}

/* =========================================================
   SALA
========================================================= */

function getRoomFromUrl() {
  const params = new URLSearchParams(
    window.location.search
  );

  return (
    params.get('room') ||
    params.get('sala') ||
    ''
  ).trim();
}

function roomUrl(roomCode) {
  const url = new URL(window.location.href);

  url.search = '';
  url.hash = '';

  url.searchParams.set(
    'room',
    String(roomCode || '').toUpperCase()
  );

  return url.toString();
}

async function resolveRoom() {
  if (!requireDB()) return;

  roomFromUrl = getRoomFromUrl();

  if (!roomFromUrl) {
    activeRoom = null;

    const context = $('room-context');

    if (context) {
      context.classList.add('hidden');
      context.textContent = '';
    }

    return;
  }

  const { data, error } = await db.rpc(
    'participant_room_info',
    {
      p_room_code: roomFromUrl
    }
  );

  if (error || !data) {

    activeRoom = null;

    const context = $('room-context');

    if (context) {
      context.classList.remove('hidden');
      context.textContent =
        'Sala não encontrada ou não está ativa.';
    }

    return;
  }

  activeRoom = Array.isArray(data)
    ? data[0] || null
    : data;

  const context = $('room-context');

  if (context) {

    context.classList.remove('hidden');

    context.textContent =
      `Sala: ${
        activeRoom.room_name ||
        activeRoom.name ||
        activeRoom.room_code ||
        roomFromUrl
      }`;

  }
}

/* =========================================================
   PARTICIPANTE
========================================================= */

async function joinParticipant(event) {
  event.preventDefault();

  if (!requireDB()) return;

  const name = normalizeText(
    $('participant-name')?.value
  );

  const sector = normalizeText(
    $('participant-sector')?.value
  );

  if (!name || !sector) {
    message(
      'join-message',
      'Informe seu nome e setor.',
      true
    );

    return;
  }

  if (!roomFromUrl) {
    message(
      'join-message',
      'Nenhuma sala foi informada. Acesse o link ou QR Code da sala.',
      true
    );

    return;
  }

  const button = $('join-button');

  if (button) {
    button.disabled = true;
  }

  message(
    'join-message',
    'Entrando na SIPAT...'
  );

  try {

    const { data, error } = await db.rpc(
      'participant_join_room',
      {
        p_room_code: roomFromUrl,
        p_name: name,
        p_sector: sector,
        p_avatar: selectedAvatar
      }
    );

    if (error) {
      throw error;
    }

    const result =
      Array.isArray(data)
        ? data[0]
        : data;

    if (!result) {
      throw new Error(
        'O servidor não retornou os dados do participante.'
      );
    }

    accessToken =
      result.access_token ||
      result.p_access_token ||
      result.session_token ||
      null;

    if (!accessToken) {
      throw new Error(
        'O servidor não retornou o token de acesso do participante.'
      );
    }

    localStorage.setItem(
      PARTICIPANT_TOKEN_KEY,
      accessToken
    );

    participant = result;

    await enterParticipant();

    message(
      'join-message',
      ''
    );

  } catch (error) {

    console.error(error);

    message(
      'join-message',
      `Não foi possível entrar: ${error.message}`,
      true
    );

  } finally {

    if (button) {
      button.disabled = false;
    }

  }
}

async function restoreParticipant() {
  if (!requireDB()) return;

  const token =
    localStorage.getItem(
      PARTICIPANT_TOKEN_KEY
    );

  if (!token) {
    return;
  }

  accessToken = token;

  try {

    const { data, error } = await db.rpc(
      'participant_session_info',
      {
        p_access_token: token
      }
    );

    if (error) {
      throw error;
    }

    const result =
      Array.isArray(data)
        ? data[0]
        : data;

    if (!result) {
      throw new Error(
        'Sessão do participante não encontrada.'
      );
    }

    if (
      roomFromUrl &&
      result.room_code &&
      String(result.room_code).toUpperCase() !==
        String(roomFromUrl).toUpperCase()
    ) {
      return;
    }

    participant = result;

    if (result.avatar) {
      selectedAvatar = result.avatar;
    }

    await enterParticipant();

  } catch (error) {

    console.warn(
      'Não foi possível restaurar a sessão do participante:',
      error
    );

    localStorage.removeItem(
      PARTICIPANT_TOKEN_KEY
    );

    accessToken = null;
    participant = null;

  }
}

async function enterParticipant() {
  if (!participant) return;

  $('join-panel')?.classList.add('hidden');
  $('participant-panel')?.classList.remove('hidden');

  const name =
    participant.name ||
    participant.participant_name ||
    'Participante';

  const sector =
    participant.sector ||
    participant.participant_sector ||
    '';

  const avatar =
    participant.avatar ||
    '🙂';

  const room =
    participant.room_name ||
    participant.room_code ||
    activeRoom?.room_name ||
    activeRoom?.room_code ||
    roomFromUrl ||
    '';

  $('participant-name-display').textContent = name;
  $('participant-sector-display').textContent = sector;
  $('participant-avatar').textContent = avatar;
  $('participant-room-display').textContent =
    room ? `Sala: ${room}` : '';

  renderAvatarPicker(
    'logged-avatar-picker',
    avatar
  );

  await loadParticipantStats();

  showView('home-view');
}

async function logoutParticipant() {
  localStorage.removeItem(
    PARTICIPANT_TOKEN_KEY
  );

  accessToken = null;
  participant = null;
  activeQuestion = null;
  chosenAnswer = null;

  $('participant-panel')?.classList.add('hidden');
  $('join-panel')?.classList.remove('hidden');

  $('join-form')?.reset();

  $('quiz-panel')?.classList.add('hidden');

  selectedAvatar = AVATARS[0];

  renderAvatarPicker(
    'avatar-picker',
    selectedAvatar
  );

  $('logged-avatar-picker')?.classList.add('hidden');

  message(
    'join-message',
    ''
  );

  showView('home-view');
}

async function updateParticipantAvatar() {
  if (!requireDB() || !accessToken) {
    return;
  }

  const container =
    $('logged-avatar-picker');

  if (!container) return;

  if (
    container.classList.contains('hidden')
  ) {

    container.classList.remove('hidden');

    renderAvatarPicker(
      'logged-avatar-picker',
      participant?.avatar || selectedAvatar
    );

    return;
  }

  const avatar =
    selectedAvatar || participant?.avatar;

  if (!avatar) return;

  const { data, error } = await db.rpc(
    'participant_set_avatar',
    {
      p_access_code: accessToken,
      p_avatar: avatar
    }
  );

  if (error) {

    message(
      'join-message',
      `Não foi possível alterar o avatar: ${error.message}`,
      true
    );

    return;
  }

  participant = {
    ...participant,
    avatar
  };

  $('participant-avatar').textContent =
    avatar;

  container.classList.add('hidden');

  toast('Avatar atualizado com sucesso.');

  await loadParticipantStats();
}

/* =========================================================
   ESTATÍSTICAS DO PARTICIPANTE
========================================================= */

async function loadParticipantStats() {
  if (!requireDB() || !accessToken) {
    return;
  }

  const { data, error } = await db.rpc(
    'participant_my_stats',
    {
      p_access_code: accessToken
    }
  );

  if (error) {

    console.warn(
      'Não foi possível carregar estatísticas:',
      error
    );

    return;
  }

  const stats =
    Array.isArray(data)
      ? data[0]
      : data;

  if (!stats) return;

  $('participant-points').textContent =
    stats.points ?? 0;

  $('participant-rank').textContent =
    stats.rank ?? '—';

  $('participant-answers').textContent =
    stats.answers ?? stats.answers_count ?? 0;
}

/* =========================================================
   QUIZ
========================================================= */

async function loadQuestion(kind) {
  if (!requireDB() || !accessToken) {
    return;
  }

  activeQuestion = null;
  chosenAnswer = null;

  const quizPanel =
    $('quiz-panel');

  quizPanel?.classList.remove('hidden');

  $('answer-feedback').textContent = '';

  $('submit-answer-button').disabled = true;

  $('question-text').textContent =
    'Carregando pergunta...';

  $('answer-options').innerHTML = '';

  const { data, error } = await db.rpc(
    'participant_next_question',
    {
      p_access_code: accessToken,
      p_kind: kind
    }
  );

  if (error) {

    $('question-text').textContent =
      'Não foi possível carregar a pergunta.';

    message(
      'answer-feedback',
      error.message,
      true
    );

    return;
  }

  const question =
    Array.isArray(data)
      ? data[0]
      : data;

  if (!question) {

    $('question-text').textContent =
      kind === 'bonus'
        ? 'Não há mais desafios bônus disponíveis.'
        : 'Não há mais perguntas disponíveis.';

    $('answer-options').innerHTML = '';

    $('submit-answer-button').disabled = true;

    return;
  }

  activeQuestion = question;

  $('question-text').textContent =
    question.question ||
    question.question_text ||
    '';

  $('question-type').textContent =
    kind === 'bonus'
      ? '⭐ Desafio bônus'
      : '🏆 Desafio oficial';

  $('question-points').textContent =
    `${question.points ?? 0} pontos`;

  $('question-day').textContent =
    `Dia ${question.day ?? '—'}`;

  const options =
    Array.isArray(question.options)
      ? question.options
      : [];

  const optionsContainer =
    $('answer-options');

  optionsContainer.innerHTML = '';

  options.forEach((option, index) => {

    const label =
      document.createElement('label');

    label.className =
      'answer-option';

    const input =
      document.createElement('input');

    input.type = 'radio';
    input.name = 'answer';
    input.value = String(index);

    input.addEventListener(
      'change',
      () => {
        chosenAnswer = index;

        $('submit-answer-button')
          .disabled = false;
      }
    );

    const span =
      document.createElement('span');

    span.textContent =
      option;

    label.append(
      input,
      span
    );

    optionsContainer.appendChild(label);
  });
}

async function submitAnswer(event) {
  event.preventDefault();

  if (
    !requireDB() ||
    !accessToken ||
    !activeQuestion ||
    chosenAnswer === null
  ) {
    return;
  }

  const button =
    $('submit-answer-button');

  button.disabled = true;

  message(
    'answer-feedback',
    'Registrando resposta...'
  );

  try {

    const { data, error } =
      await db.rpc(
        'participant_submit_answer',
        {
          p_access_code: accessToken,
          p_question_id:
            activeQuestion.id ||
            activeQuestion.question_id,
          p_selected_index: chosenAnswer
        }
      );

    if (error) {
      throw error;
    }

    const result =
      Array.isArray(data)
        ? data[0]
        : data;

    const correct =
      Boolean(
        result?.correct ??
        result?.is_correct
      );

    const points =
      result?.points_awarded ??
      result?.points ??
      0;

    if (correct) {

      message(
        'answer-feedback',
        `✅ Resposta correta! Você ganhou ${points} ponto(s).`
      );

    } else {

      message(
        'answer-feedback',
        `❌ Resposta incorreta. ${points > 0 ? `Você ganhou ${points} ponto(s).` : ''}`,
        true
      );

    }

    await loadParticipantStats();

    setTimeout(() => {
      loadQuestion(
        activeQuestion.kind ||
        $('question-type').dataset.kind ||
        'official'
      );
    }, 1400);

  } catch (error) {

    console.error(error);

    message(
      'answer-feedback',
      `Não foi possível registrar a resposta: ${error.message}`,
      true
    );

    button.disabled = false;
  }
}

/* =========================================================
   RANKING
========================================================= */

async function loadRanking() {
  if (!requireDB()) return;

  const body =
    $('ranking-body');

  if (!body) return;

  body.innerHTML = `
    <tr>
      <td colspan="5">
        Carregando ranking...
      </td>
    </tr>
  `;

  const { data, error } =
    await db.rpc(
      'public_leaderboard',
      {
        p_limit: 100
      }
    );

  if (error) {

    body.innerHTML = '';

    message(
      'ranking-message',
      `Não foi possível carregar o ranking: ${error.message}`,
      true
    );

    return;
  }

  body.innerHTML = '';

  if (!data?.length) {

    body.innerHTML = `
      <tr>
        <td colspan="5">
          Nenhum participante encontrado.
        </td>
      </tr>
    `;

    return;
  }

  data.forEach((row, index) => {

    const tr =
      document.createElement('tr');

    const position =
      row.rank ??
      row.position ??
      index + 1;

    const name =
      row.name ??
      row.participant_name ??
      '';

    const sector =
      row.sector ??
      '';

    const points =
      row.points ??
      0;

    const answers =
      row.answers ??
      row.answers_count ??
      0;

    tr.innerHTML = `
      <td>${escapeHTML(position)}</td>
      <td>
        ${escapeHTML(row.avatar || '🙂')}
        ${escapeHTML(name)}
      </td>
      <td>${escapeHTML(sector)}</td>
      <td>${escapeHTML(points)}</td>
      <td>${escapeHTML(answers)}</td>
    `;

    body.appendChild(tr);
  });
}

/* =========================================================
   ADMIN LOGIN
========================================================= */

async function adminLogin(event) {
  event.preventDefault();

  if (!requireDB()) return;

  const email =
    normalizeText(
      $('admin-email')?.value
    );

  const password =
    $('admin-password')?.value || '';

  if (!email || !password) {
    message(
      'admin-login-message',
      'Informe e-mail e senha.',
      true
    );

    return;
  }

  const button =
    event.submitter;

  if (button) {
    button.disabled = true;
  }

  try {

    const {
      data,
      error
    } =
      await db.auth.signInWithPassword({
        email,
        password
      });

    if (error) {
      throw error;
    }

    const user =
      data?.user;

    if (!user) {
      throw new Error(
        'Usuário autenticado não foi retornado.'
      );
    }

    const {
      data: admin,
      error: adminError
    } =
      await db
        .from('admins')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle();

    if (adminError) {
      throw adminError;
    }

    if (!admin) {

      await db.auth.signOut();

      throw new Error(
        'Este usuário não possui permissão administrativa.'
      );
    }

    adminUser = admin;

    $('admin-login-panel')
      ?.classList.add('hidden');

    $('admin-panel')
      ?.classList.remove('hidden');

    $('admin-user-display').textContent =
      user.email || '';

    message(
      'admin-login-message',
      ''
    );

    await loadAdminData();
    await loadAdminParticipants();
    await loadAdminQuestions();
    await loadAdminRooms();
    await loadModeSettings();

  } catch (error) {

    console.error(error);

    message(
      'admin-login-message',
      `Não foi possível entrar: ${error.message}`,
      true
    );

  } finally {

    if (button) {
      button.disabled = false;
    }

  }
}

async function restoreAdminSession() {
  if (!requireDB()) return;

  try {

    const {
      data,
      error
    } =
      await db.auth.getSession();

    if (error) {
      throw error;
    }

    const session =
      data?.session;

    if (!session?.user) {
      return;
    }

    const {
      data: admin,
      error: adminError
    } =
      await db
        .from('admins')
        .select('*')
        .eq('user_id', session.user.id)
        .maybeSingle();

    if (adminError) {
      throw adminError;
    }

    if (!admin) {
      return;
    }

    adminUser = admin;

    $('admin-login-panel')
      ?.classList.add('hidden');

    $('admin-panel')
      ?.classList.remove('hidden');

    $('admin-user-display').textContent =
      session.user.email || '';

    await loadAdminData();
    await loadAdminParticipants();
    await loadAdminQuestions();
    await loadAdminRooms();
    await loadModeSettings();

  } catch (error) {

    console.warn(
      'Não foi possível restaurar sessão administrativa:',
      error
    );

  }
}

async function adminLogout() {
  if (!requireDB()) return;

  await db.auth.signOut();

  adminUser = null;

  $('admin-panel')
    ?.classList.add('hidden');

  $('admin-login-panel')
    ?.classList.remove('hidden');

  $('admin-login-form')?.reset();

  showView('admin-view');
}

/* =========================================================
   CONFIGURAÇÃO DOS MODOS
========================================================= */

function ensureModeSettingsUI() {
  const container =
    $('mode-settings');

  if (!container || container.dataset.ready) {
    return;
  }

  container.dataset.ready = 'true';

  container.innerHTML = `
    <div class="mode-setting">
      <label>
        <input
          type="checkbox"
          id="official-enabled"
          checked
        >
        Desafio oficial habilitado
      </label>

      <div class="form-group">
        <label for="official-limit">
          Limite diário oficial
        </label>

        <input
          id="official-limit"
          type="number"
          min="0"
          value="1"
        >
      </div>
    </div>

    <div class="mode-setting">
      <label>
        <input
          type="checkbox"
          id="bonus-enabled"
          checked
        >
        Desafio bônus habilitado
      </label>

      <div class="form-group">
        <label for="bonus-limit">
          Limite diário bônus
        </label>

        <input
          id="bonus-limit"
          type="number"
          min="0"
          value="1"
        >
      </div>
    </div>

    <button
      id="save-mode-settings-button"
      type="button"
      class="primary-button"
    >
      💾 Salvar configurações
    </button>
  `;

  $('save-mode-settings-button')
    ?.addEventListener(
      'click',
      saveModeSettings
    );
}

async function loadModeSettings() {
  if (!adminUser || !requireDB()) {
    return;
  }

  ensureModeSettingsUI();

  const {
    data,
    error
  } =
    await db.rpc(
      'admin_get_mode_settings'
    );

  if (error) {

    message(
      'mode-settings-message',
      `Não foi possível carregar configurações: ${error.message}`,
      true
    );

    return;
  }

  const settings =
    Array.isArray(data)
      ? data
      : [];

  const official =
    settings.find(
      item => item.kind === 'official'
    );

  const bonus =
    settings.find(
      item => item.kind === 'bonus'
    );

  if (official) {

    $('official-enabled').checked =
      official.enabled !== false;

    $('official-limit').value =
      official.daily_limit ??
      official.limit ??
      1;

  }

  if (bonus) {

    $('bonus-enabled').checked =
      bonus.enabled !== false;

    $('bonus-limit').value =
      bonus.daily_limit ??
      bonus.limit ??
      1;

  }
}

async function saveModeSettings() {
  if (!adminUser || !requireDB()) {
    return;
  }

  const button =
    $('save-mode-settings-button');

  if (button) {
    button.disabled = true;
  }

  try {

    const settings = [
      {
        kind: 'official',
        enabled:
          $('official-enabled').checked,
        daily_limit:
          Number(
            $('official-limit').value
          )
      },
      {
        kind: 'bonus',
        enabled:
          $('bonus-enabled').checked,
        daily_limit:
          Number(
            $('bonus-limit').value
          )
      }
    ];

    for (const setting of settings) {

      const {
        error
      } =
        await db.rpc(
          'admin_update_mode_settings',
          {
            p_kind: setting.kind,
            p_enabled: setting.enabled,
            p_daily_limit: setting.daily_limit
          }
        );

      if (error) {
        throw error;
      }
    }

    message(
      'mode-settings-message',
      'Configurações salvas com sucesso.'
    );

  } catch (error) {

    message(
      'mode-settings-message',
      `Não foi possível salvar: ${error.message}`,
      true
    );

  } finally {

    if (button) {
      button.disabled = false;
    }

  }
}

/* =========================================================
   ADMIN — PARTICIPANTES
========================================================= */

function ensureParticipantManagementUI() {
  const box =
    $('admin-participant-list');

  if (!box) return;
}

async function loadAdminParticipants() {
  if (!adminUser || !requireDB()) {
    return;
  }

  ensureParticipantManagementUI();

  const box =
    $('admin-participant-list');

  if (!box) return;

  box.innerHTML =
    '<p class="muted">Carregando participantes...</p>';

  const {
    data,
    error
  } =
    await db.rpc(
      'admin_list_participants'
    );

  if (error) {

    box.textContent =
      `Não foi possível carregar participantes: ${error.message}`;

    return;
  }

  box.innerHTML = '';

  if (!data?.length) {

    box.innerHTML =
      '<p class="empty-note">Nenhum participante cadastrado.</p>';

    return;
  }

  data.forEach(p => {

    const row =
      document.createElement('div');

    row.className =
      'room-row';

    const info =
      document.createElement('div');

    info.className =
      'room-row-info';

    const title =
      document.createElement('span');

    title.textContent =
      `${p.avatar || '🙂'} ${p.name} • ${p.sector}`;

    const meta =
      document.createElement('small');

    meta.textContent =
      `${p.points ?? 0} pontos • ${p.answers ?? 0} respostas`;

    info.append(
      title,
      meta
    );

    const remove =
      document.createElement('button');

    remove.type = 'button';
    remove.className = 'remove-question';
    remove.textContent = 'Excluir';
    remove.title =
      'Excluir participante, respostas e pontos';

    remove.addEventListener(
      'click',
      async () => {

        const confirmed =
          confirm(
            `Excluir definitivamente o participante "${p.name}" do setor "${p.sector}"?\n\n` +
            `Todas as respostas e os pontos desse perfil também serão apagados. ` +
            `Essa ação não pode ser desfeita.`
          );

        if (!confirmed) {
          return;
        }

        remove.disabled = true;

        if (!p.participant_id) {

          remove.disabled = false;

          message(
            'participant-management-message',
            'Erro: ID do participante não encontrado.',
            true
          );

          return;
        }

        const {
          error: deleteError
        } =
          await db.rpc(
            'admin_delete_participant',
            {
              p_participant_id:
                p.participant_id
            }
          );

        remove.disabled = false;

        if (deleteError) {

          message(
            'participant-management-message',
            `Não foi possível excluir: ${deleteError.message}`,
            true
          );

          return;
        }

        message(
          'participant-management-message',
          `Participante ${p.name} e seu histórico foram excluídos.`
        );

        await loadAdminParticipants();
        await loadAdminData();
        await loadRanking();

      }
    );

    row.append(
      info,
      remove
    );

    box.appendChild(row);
  });
}

/* =========================================================
   ADMIN — PERGUNTAS
========================================================= */

async function addQuestion(event) {
  event.preventDefault();

  if (!adminUser || !requireDB()) {
    return;
  }

  const kind =
    $('question-kind').value;

  const day =
    Number(
      $('question-day').value
    );

  const points =
    Number(
      $('question-points').value
    );

  const questionText =
    normalizeText(
      $('question-text-admin').value
    );

  const options = [
    normalizeText(
      $('option-0').value
    ),
    normalizeText(
      $('option-1').value
    ),
    normalizeText(
      $('option-2').value
    ),
    normalizeText(
      $('option-3').value
    )
  ];

  const correctIndex =
    Number(
      $('correct-index').value
    );

  if (
    !questionText ||
    options.some(option => !option)
  ) {

    message(
      'question-message',
      'Preencha a pergunta e todas as alternativas.',
      true
    );

    return;
  }

  try {

    const {
      error
    } =
      await db
        .from('questions')
        .insert({
          kind,
          day,
          points,
          question:
            questionText,
          options,
          correct_index:
            correctIndex,
          active: true
        });

    if (error) {
      throw error;
    }

    message(
      'question-message',
      'Pergunta adicionada com sucesso.'
    );

    $('question-form').reset();

    $('question-day').value = 1;
    $('question-points').value = 10;

    await loadAdminQuestions();

  } catch (error) {

    console.error(error);

    message(
      'question-message',
      `Não foi possível adicionar a pergunta: ${error.message}`,
      true
    );

  }
}

async function loadAdminQuestions() {
  if (!adminUser || !requireDB()) {
    return;
  }

  const kind =
    $('question-filter-kind')?.value ||
    '';

  const day =
    $('question-filter-day')?.value ||
    '';

  let query =
    db
      .from('questions')
      .select('*')
      .order('day', {
        ascending: true
      })
      .order('created_at', {
        ascending: true
      });

  if (kind) {
    query =
      query.eq(
        'kind',
        kind
      );
  }

  if (day) {
    query =
      query.eq(
        'day',
        Number(day)
      );
  }

  const {
    data,
    error
  } = await query;

  const box =
    $('admin-question-list');

  if (!box) return;

  if (error) {

    box.textContent =
      `Não foi possível carregar perguntas: ${error.message}`;

    return;
  }

  adminQuestionList =
    data || [];

  box.innerHTML = '';

  if (!adminQuestionList.length) {

    box.innerHTML =
      '<p class="empty-note">Nenhuma pergunta encontrada.</p>';

    return;
  }

  adminQuestionList.forEach(question => {

    const row =
      document.createElement('div');

    row.className =
      'question-row';

    const info =
      document.createElement('div');

    info.className =
      'question-row-info';

    const title =
      document.createElement('strong');

    title.textContent =
      `[Dia ${question.day}] ` +
      `${question.kind === 'bonus' ? '⭐ Bônus' : '🏆 Oficial'} ` +
      `${question.points ?? 0} pontos`;

    const text =
      document.createElement('p');

    text.textContent =
      question.question ||
      question.question_text ||
      '';

    const status =
      document.createElement('small');

    status.textContent =
      question.active
        ? 'Ativa'
        : 'Desativada';

    info.append(
      title,
      text,
      status
    );

    const button =
      document.createElement('button');

    button.type = 'button';

    button.className =
      question.active
        ? 'remove-question'
        : 'secondary-button';

    button.textContent =
      question.active
        ? 'Desativar'
        : 'Ativada';

    if (!question.active) {
      button.disabled = true;
    }

    button.addEventListener(
      'click',
      () =>
        deactivateQuestion(
          question.id
        )
    );

    row.append(
      info,
      button
    );

    box.appendChild(row);
  });
}

async function deactivateQuestion(
  questionId
) {
  if (!adminUser || !requireDB()) {
    return;
  }

  const confirmed =
    confirm(
      'Desativar esta pergunta?'
    );

  if (!confirmed) {
    return;
  }

  const {
    error
  } =
    await db
      .from('questions')
      .update({
        active: false
      })
      .eq(
        'id',
        questionId
      );

  if (error) {

    message(
      'question-message',
      `Não foi possível desativar: ${error.message}`,
      true
    );

    return;
  }

  message(
    'question-message',
    'Pergunta desativada.'
  );

  await loadAdminQuestions();
}

/* =========================================================
   ADMIN — SALAS
========================================================= */

async function createRoom(event) {
  event.preventDefault();

  if (!adminUser || !requireDB()) {
    return;
  }

  const code =
    normalizeText(
      $('room-code').value
    ).toUpperCase();

  const name =
    normalizeText(
      $('room-name').value
    );

  if (!code) {

    message(
      'room-message',
      'Informe o código da sala.',
      true
    );

    return;
  }

  try {

    const {
      data,
      error
    } =
      await db.rpc(
        'admin_create_activate_room',
        {
          p_room_code: code,
          p_room_name: name || code
        }
      );

    if (error) {
      throw error;
    }

    const room =
      Array.isArray(data)
        ? data[0]
        : data;

    message(
      'room-message',
      'Sala criada/ativada com sucesso.'
    );

    await loadAdminRooms();

    if (room?.room_code) {
      showRoomQRCode(
        room.room_code
      );
    } else {
      showRoomQRCode(code);
    }

  } catch (error) {

    console.error(error);

    message(
      'room-message',
      `Não foi possível criar a sala: ${error.message}`,
      true
    );

  }
}

async function loadAdminRooms() {
  if (!adminUser || !requireDB()) {
    return;
  }

  const {
    data,
    error
  } =
    await db
      .from('sipat_rooms')
      .select('*')
      .order('created_at', {
        ascending: false
      });

  const box =
    $('admin-room-list');

  if (!box) return;

  if (error) {

    box.textContent =
      `Não foi possível carregar salas: ${error.message}`;

    return;
  }

  adminRoomList =
    data || [];

  box.innerHTML = '';

  if (!adminRoomList.length) {

    box.innerHTML =
      '<p class="empty-note">Nenhuma sala encontrada.</p>';

    return;
  }

  adminRoomList.forEach(room => {

    const row =
      document.createElement('div');

    row.className =
      'room-row';

    const info =
      document.createElement('div');

    info.className =
      'room-row-info';

    const title =
      document.createElement('strong');

    title.textContent =
      `${room.room_name || room.room_code}`;

    const meta =
      document.createElement('small');

    meta.textContent =
      `${room.room_code} • ${
        room.active
          ? 'Ativa'
          : 'Inativa'
      }`;

    info.append(
      title,
      meta
    );

    const button =
      document.createElement('button');

    button.type = 'button';
    button.className =
      'secondary-button';

    button.textContent =
      'QR Code';

    button.addEventListener(
      'click',
      () => {
        showRoomQRCode(
          room.room_code
        );
      }
    );

    row.append(
      info,
      button
    );

    box.appendChild(row);
  });
}

function showRoomQRCode(
  roomCode
) {
  const area =
    $('qr-area');

  const qr =
    $('qr-code');

  const link =
    $('qr-link');

  if (!area || !qr || !link) {
    return;
  }

  const url =
    roomUrl(roomCode);

  qr.innerHTML = '';

  new QRCode(qr, {
    text: url,
    width: 220,
    height: 220,
    correctLevel:
      QRCode.CorrectLevel.M
  });

  link.textContent = url;

  area.classList.remove('hidden');

  area.dataset.roomCode =
    roomCode;
}

async function copyRoomLink() {
  const link =
    $('qr-link')?.textContent;

  if (!link) {
    return;
  }

  try {

    await navigator.clipboard.writeText(
      link
    );

    toast(
      'Link copiado.'
    );

  } catch (error) {

    toast(
      'Não foi possível copiar automaticamente.',
      true
    );

  }
}

/* =========================================================
   ADMIN — DADOS
========================================================= */

async function loadAdminData() {
  if (!adminUser || !requireDB()) {
    return;
  }

  const summary =
    $('admin-summary');

  if (summary) {
    summary.textContent =
      'Carregando dados...';
  }

  try {

    const [
      participantsResult,
      questionsResult,
      attemptsResult
    ] =
      await Promise.all([
        db
          .from('participants')
          .select('*', {
            count: 'exact',
            head: true
          }),

        db
          .from('questions')
          .select('*', {
            count: 'exact',
            head: true
          }),

        db
          .from('attempts')
          .select('*', {
            count: 'exact',
            head: true
          })
      ]);

    if (
      participantsResult.error ||
      questionsResult.error ||
      attemptsResult.error
    ) {

      throw (
        participantsResult.error ||
        questionsResult.error ||
        attemptsResult.error
      );
    }

    const participants =
      participantsResult.count ?? 0;

    const questions =
      questionsResult.count ?? 0;

    const attempts =
      attemptsResult.count ?? 0;

    if (summary) {

      summary.innerHTML = `
        <div class="stats-grid">
          <div class="stat-card">
            <span>Participantes</span>
            <strong>${participants}</strong>
          </div>

          <div class="stat-card">
            <span>Perguntas</span>
            <strong>${questions}</strong>
          </div>

          <div class="stat-card">
            <span>Respostas</span>
            <strong>${attempts}</strong>
          </div>
        </div>
      `;
    }

    await loadAdminAttempts();

  } catch (error) {

    console.error(error);

    message(
      'admin-data-message',
      `Não foi possível carregar os dados: ${error.message}`,
      true
    );
  }
}

async function loadAdminAttempts() {
  if (!adminUser || !requireDB()) {
    return;
  }

  const body =
    $('admin-attempts-body');

  if (!body) return;

  const {
    data,
    error
  } =
    await db
      .from('admin_attempts_view')
      .select('*')
      .order('created_at', {
        ascending: false
      })
      .limit(100);

  if (error) {

    body.innerHTML = `
      <tr>
        <td colspan="8">
          Não foi possível carregar respostas.
        </td>
      </tr>
    `;

    return;
  }

  body.innerHTML = '';

  if (!data?.length) {

    body.innerHTML = `
      <tr>
        <td colspan="8">
          Nenhuma resposta encontrada.
        </td>
      </tr>
    `;

    return;
  }

  data.forEach(row => {

    const tr =
      document.createElement('tr');

    const correct =
      Boolean(
        row.correct ??
        row.is_correct
      );

    tr.innerHTML = `
      <td>${escapeHTML(row.name || row.participant_name || '')}</td>

      <td>${escapeHTML(row.sector || '')}</td>

      <td>
        ${row.kind === 'bonus'
          ? '⭐ Bônus'
          : '🏆 Oficial'}
      </td>

      <td>${escapeHTML(row.day ?? '')}</td>

      <td>
        ${escapeHTML(
          row.question ||
          row.question_text ||
          ''
        )}
      </td>

      <td>
        ${correct
          ? '✅ Correta'
          : '❌ Incorreta'}
      </td>

      <td>
        ${escapeHTML(
          row.points_awarded ??
          row.points ??
          0
        )}
      </td>

      <td>
        ${escapeHTML(
          row.created_at
            ? new Date(
                row.created_at
              ).toLocaleString('pt-BR')
            : ''
        )}
      </td>
    `;

    body.appendChild(tr);
  });
}

/* =========================================================
   EXPORTAÇÃO
========================================================= */

async function exportRanking() {
  if (!adminUser || !requireDB()) {
    return;
  }

  const button =
    $('export-ranking-button');

  if (button) {
    button.disabled = true;
  }

  try {

    const {
      data,
      error
    } =
      await db.rpc(
        'admin_export_leaderboard'
      );

    if (error) {
      throw error;
    }

    const rows =
      Array.isArray(data)
        ? data
        : [];

    if (!rows.length) {

      toast(
        'Não há dados para exportar.'
      );

      return;
    }

    const headers =
      Object.keys(rows[0]);

    const csv = [
      headers.join(';'),

      ...rows.map(row =>
        headers
          .map(header => {

            const value =
              row[header] ?? '';

            return `"${String(value)
              .replaceAll('"', '""')}"`;

          })
          .join(';')
      )

    ].join('\n');

    const blob =
      new Blob(
        [
          '\uFEFF' +
          csv
        ],
        {
          type:
            'text/csv;charset=utf-8;'
        }
      );

    const url =
      URL.createObjectURL(blob);

    const a =
      document.createElement('a');

    a.href = url;

    a.download =
      `ranking-sipat-${new Date()
        .toISOString()
        .slice(0, 10)}.csv`;

    document.body.appendChild(a);

    a.click();

    a.remove();

    URL.revokeObjectURL(url);

    toast(
      'Ranking exportado com sucesso.'
    );

  } catch (error) {

    console.error(error);

    message(
      'admin-data-message',
      `Não foi possível exportar: ${error.message}`,
      true
    );

  } finally {

    if (button) {
      button.disabled = false;
    }

  }
}

/* =========================================================
   EVENTOS
========================================================= */

function setupEvents() {

  $('join-form')
    ?.addEventListener(
      'submit',
      joinParticipant
    );

  $('participant-logout')
    ?.addEventListener(
      'click',
      logoutParticipant
    );

  $('change-avatar-button')
    ?.addEventListener(
      'click',
      updateParticipantAvatar
    );

  $('official-challenge-button')
    ?.addEventListener(
      'click',
      () => loadQuestion('official')
    );

  $('bonus-challenge-button')
    ?.addEventListener(
      'click',
      () => loadQuestion('bonus')
    );

  $('answer-form')
    ?.addEventListener(
      'submit',
      submitAnswer
    );

  $('refresh-ranking-button')
    ?.addEventListener(
      'click',
      loadRanking
    );

  $('admin-login-form')
    ?.addEventListener(
      'submit',
      adminLogin
    );

  $('admin-logout-button')
    ?.addEventListener(
      'click',
      adminLogout
    );

  $('create-room-form')
    ?.addEventListener(
      'submit',
      createRoom
    );

  $('copy-room-link-button')
    ?.addEventListener(
      'click',
      copyRoomLink
    );

  $('question-form')
    ?.addEventListener(
      'submit',
      addQuestion
    );

  $('question-filter-kind')
    ?.addEventListener(
      'change',
      loadAdminQuestions
    );

  $('question-filter-day')
    ?.addEventListener(
      'change',
      loadAdminQuestions
    );

  $('refresh-participants-button')
    ?.addEventListener(
      'click',
      loadAdminParticipants
    );

  $('refresh-admin-data-button')
    ?.addEventListener(
      'click',
      loadAdminData
    );

  $('export-ranking-button')
    ?.addEventListener(
      'click',
      exportRanking
    );
}

/* =========================================================
   INICIALIZAÇÃO
========================================================= */

async function init() {

  setupNavigation();
  setupEvents();

  renderAvatarPicker(
    'avatar-picker',
    selectedAvatar
  );

  ensureModeSettingsUI();

  await resolveRoom();

  await restoreParticipant();

  await restoreAdminSession();

  await loadRanking();

}

document.addEventListener(
  'DOMContentLoaded',
  init
);
