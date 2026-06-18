/* global io */
// transports: только WebSocket — через туннель это заметно быстрее, чем HTTP-поллинг
const socket = io({ transports: ['websocket'], upgrade: false });

// Постоянный идентификатор игрока и сохранение сессии (переживают перезагрузку)
let CLIENT_ID = localStorage.getItem('monopoly_cid');
if (!CLIENT_ID) {
  CLIENT_ID = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : (Date.now() + '-' + Math.random().toString(36).slice(2));
  localStorage.setItem('monopoly_cid', CLIENT_ID);
}
let MY_NAME = null;
const SESSION_KEY = 'monopoly_session';
function saveSession(code, name) { localStorage.setItem(SESSION_KEY, JSON.stringify({ code, name })); }
function clearSession() { localStorage.removeItem(SESSION_KEY); }

let YOU = null;         // socket id
let ROOM = null;        // room code
let STATE = null;       // последнее состояние
let BOARD = null;       // статическая доска
let GROUPS = null;
let TOKEN_HEROES = [];  // герои Dota 2 для выбора фишки
let lastDice = [0, 0];
let clientNowAtState = Date.now(); // момент получения последнего состояния (для кулдауна похвал)
let displayPos = {};               // отображаемая клетка фишки (для пошаговой анимации хода)
let movingIds = new Set();         // игроки, чьи фишки сейчас шагают
let moveDir = {};                  // направление шага (+1/-1) для плавного перемещения
let moveQueue = {};                // очередь клеток-целей для пошагового прохода по пути
let animWatchdog = null;           // страховочный таймер разблокировки
let pendingSounds = [];            // звуки событий, отложенные до прихода фишки

// Звук события: пока фишка идёт — откладываем, иначе играем сразу
function eventSound(fn) { if (turnAnimating) pendingSounds.push(fn); else fn(); }
function flushPendingSounds() { const list = pendingSounds; pendingSounds = []; list.forEach(fn => { try { fn(); } catch (e) {} }); }
let hoppingIds = new Set();        // фишки, которым на этом шаге добавить «прыжок»
let prevMoney = {};                // прошлый баланс игроков (для звука монет)
let prevOwnedCount = null;         // число купленных клеток (для звука покупки)
let turnAnimating = false;         // фишка ещё идёт — прячем оповещения/кнопки хода
let prevPay = null;                // незакрытая оплата аренды из прошлого состояния (для звука монет)
let payShownFor = null;            // чтобы не дублировать звук окна оплаты
let sfxVolume = parseInt(localStorage.getItem('monopoly_sfx_vol') || '70', 10) / 100; // громкость звуков
let sfxMuted = localStorage.getItem('monopoly_sfx_muted') === '1';
function sfxGain() { return sfxMuted ? 0 : sfxVolume; }

// ---------- Доска: получаем статические данные с сервера через первый state ----------
// Чтобы не дублировать board.js, отдадим её через отдельный fetch.
fetch('/board').then(r => r.json()).then(d => { BOARD = d.BOARD; GROUPS = d.GROUPS; TOKEN_HEROES = d.TOKENS || []; if (STATE) { renderAll(); if (!STATE.started) renderWaiting(); } });

const $ = (id) => document.getElementById(id);

// ---------- Экран входа ----------
$('create-btn').onclick = () => {
  const name = $('name-input').value.trim();
  if (!name) return showLobbyError('Введите имя.');
  MY_NAME = name;
  socket.emit('createRoom', { name, clientId: CLIENT_ID }, onJoined);
};
$('join-btn').onclick = () => {
  const name = $('name-input').value.trim();
  const code = $('code-input').value.trim().toUpperCase();
  if (!name) return showLobbyError('Введите имя.');
  if (!code) return showLobbyError('Введите код комнаты.');
  MY_NAME = name;
  socket.emit('joinRoom', { name, code, clientId: CLIENT_ID }, onJoined);
};
$('code-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('join-btn').click(); });
$('name-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('create-btn').click(); });

// заход по ссылке-приглашению ?room=XXXX — только вход, без создания игры
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) {
  const code = urlRoom.toUpperCase();
  $('code-input').value = code;
  $('code-input').readOnly = true;
  $('create-btn').classList.add('hidden');
  $('join-btn').classList.add('btn-primary');
  $('join-btn').textContent = 'Войти в игру';
  const jr = document.querySelector('.join-row');
  if (jr) jr.classList.add('invited');
  const tag = document.querySelector('#lobby-screen .tagline');
  if (tag) tag.textContent = `Вас пригласили в игру (комната ${code}). Введите имя и войдите.`;
}

function onJoined(res) {
  if (!res || !res.ok) return showLobbyError(res ? res.error : 'Ошибка соединения.');
  YOU = res.you; ROOM = res.code;
  saveSession(res.code, MY_NAME);
  $('lobby-screen').classList.add('hidden');
}
function showLobbyError(msg) { $('lobby-error').textContent = msg; }

// Авто-переподключение после перезагрузки: тихо возвращаемся в свою комнату
socket.on('connect', () => {
  YOU = socket.id;
  let s = null;
  try { s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) {}
  if (s && s.code && s.name) {
    MY_NAME = s.name;
    socket.emit('joinRoom', { name: s.name, code: s.code, clientId: CLIENT_ID }, (res) => {
      if (res && res.ok) { YOU = res.you; ROOM = res.code; $('lobby-screen').classList.add('hidden'); }
      else { clearSession(); }
    });
  }
});

// ---------- Ожидание ----------
$('start-btn').onclick = () => socket.emit('startGame');
$('leave-waiting-btn').onclick = leaveGame;
$('room-code').onclick = () => navigator.clipboard && navigator.clipboard.writeText(ROOM);

// ---------- Чат ----------
$('chat-btn').onclick = sendChat;
$('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
function sendChat() {
  const v = $('chat-input').value.trim();
  if (v) { socket.emit('chat', v); $('chat-input').value = ''; }
}

function act(type, extra = {}) { socket.emit('action', { type, ...extra }); }

// Выход из игры: покидаем комнату и очищаем сохранённую сессию
function leaveGame() {
  if (!confirm('Выйти из игры? Вы покинете комнату.')) return;
  socket.emit('leaveRoom');
  clearSession();
  setTimeout(() => window.location.reload(), 150);
}

// тикающий таймер для кулдауна кнопок похвалы
setInterval(() => { if (STATE && STATE.started) updatePraiseButtons(); }, 500);

// ---------- Приём состояния ----------
socket.on('state', (s) => {
  const prevDice = STATE ? STATE.dice : [0, 0];
  STATE = s;
  clientNowAtState = Date.now();
  if (!YOU) YOU = socket.id;
  routeScreen();
  const diceChanged = s.dice && (s.dice[0] !== prevDice[0] || s.dice[1] !== prevDice[1]);
  if (BOARD) {
    if (diceChanged) turnAnimating = true;          // прячем кнопки до прихода фишки
    else if (movingIds.size === 0) turnAnimating = false; // нет активной анимации — точно можно ходить
    renderAll();
    if (diceChanged) { animateDice(); playClip('dice'); startMoves(); }
    else { animateMoves(); }
  }
  // оплата аренды завершилась? (pendingPay был и пропал)
  let rentEvent = false;
  if (prevPay && !STATE.pendingPay && (YOU === prevPay.toId || YOU === prevPay.fromId)) rentEvent = true;
  // звук изменения баланса (мой): аренда — отдельным звуком монет (откладываем, пока фишка идёт)
  const meP = STATE.players && STATE.players.find(p => p.id === YOU);
  if (meP) {
    const prev = prevMoney[YOU];
    if (prev !== undefined && meP.money !== prev) {
      if (rentEvent) eventSound(() => playClip('coins'));
      else eventSound(() => playSnd(meP.money > prev ? 'coinIn' : 'coinOut'));
    }
  }
  if (STATE.players) STATE.players.forEach(p => { prevMoney[p.id] = p.money; });
  prevPay = STATE.pendingPay ? { toId: STATE.pendingPay.toId, fromId: STATE.currentPlayerId } : null;
  // звук покупки — когда появился новый владелец (покупка/аукцион)
  const ownedCount = Object.keys(STATE.ownership || {}).length;
  if (prevOwnedCount !== null && ownedCount > prevOwnedCount) eventSound(() => playClip('buy'));
  prevOwnedCount = ownedCount;
});

// ---------- Уведомления и звук похвалы (как commend в Dota 2) ----------
socket.on('notify', (n) => {
  if (n.type === 'praise') {
    const mine = n.toId === YOU;
    showToast({
      icon: '👍',
      title: mine ? 'Вас похвалили!' : 'Похвала',
      text: `${n.fromToken} ${n.fromName} → ${n.toToken} ${n.toName}`,
      sub: `Всего похвал: ${n.praises}`,
      highlight: mine,
    });
    playPraiseSound();
  } else if (n.type === 'buyback') {
    pendingSounds.push(() => playClip('buyback')); // прозвучит, когда фишка дойдёт
  } else if (n.type === 'rune') {
    pendingSounds.push(() => playClip('rune'));
  }
});

// Воспроизведение mp3-клипов событий с учётом громкости звуков
const clipCache = {};
function playClip(name) {
  const v = sfxGain();
  if (v <= 0) return;
  if (!clipCache[name]) clipCache[name] = new Audio('/' + name + '.mp3');
  const a = clipCache[name];
  a.volume = v;
  a.currentTime = 0;
  a.play().catch(() => {});
}

function showToast({ icon, title, text, sub, highlight }) {
  const wrap = $('toasts');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = 'toast' + (highlight ? ' toast-hl' : '');
  el.innerHTML = `
    <div class="toast-icon">${icon}</div>
    <div class="toast-body">
      <div class="toast-title">${title}</div>
      <div class="toast-text">${text}</div>
      ${sub ? `<div class="toast-sub">${sub}</div>` : ''}
    </div>`;
  wrap.appendChild(el);
  // авто-удаление через 4.5с
  setTimeout(() => {
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 400);
  }, 4500);
}

// Синтез «звона награды» через Web Audio (без внешних файлов)
let audioCtx = null;
function unlockAudio() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { /* нет аудио */ }
  }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}
// разблокировка по первому взаимодействию (политика автоплея)
window.addEventListener('pointerdown', unlockAudio, { once: false });
window.addEventListener('keydown', unlockAudio, { once: false });

function playPraiseSound() {
  unlockAudio();
  if (!audioCtx) return;
  const sv = sfxGain();
  if (sv <= 0) return;
  const ctx = audioCtx;
  const t0 = ctx.currentTime;

  // один «удар» колокола: фундамент + колокольные обертоны, мягкая атака, долгий спад
  function bell(freq, start, gain, dur) {
    gain = gain * sv;
    const partials = [
      { m: 1.0, g: 1.0 },
      { m: 2.0, g: 0.5 },
      { m: 2.76, g: 0.28 },
      { m: 4.07, g: 0.16 },
    ];
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, start);
    out.gain.exponentialRampToValueAtTime(gain, start + 0.012);
    out.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    out.connect(ctx.destination);
    partials.forEach(p => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq * p.m;
      g.gain.value = p.g;
      osc.connect(g).connect(out);
      osc.start(start);
      osc.stop(start + dur + 0.05);
    });
  }

  // восходящий «динь-динь» (квинта) — как позитивный звонок-награда
  bell(1174.66, t0,        0.28, 0.9);  // D6
  bell(1760.00, t0 + 0.085, 0.30, 1.1); // A6

  // короткая яркая искра сверху
  const sp = ctx.createOscillator();
  const sg = ctx.createGain();
  sp.type = 'sine';
  sp.frequency.setValueAtTime(2637, t0 + 0.085);   // E7
  sp.frequency.exponentialRampToValueAtTime(3520, t0 + 0.18); // A7
  sg.gain.setValueAtTime(0.0001, t0 + 0.085);
  sg.gain.exponentialRampToValueAtTime(0.10 * sv, t0 + 0.11);
  sg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5);
  sp.connect(sg).connect(ctx.destination);
  sp.start(t0 + 0.085);
  sp.stop(t0 + 0.55);
}

// Короткие звуки хода (синтез, без файлов)
function playSnd(name) {
  unlockAudio();
  if (!audioCtx) return;
  const vol = sfxGain();
  if (vol <= 0) return;
  const ctx = audioCtx, t = ctx.currentTime;
  const beep = (f1, f2, type, dur, gain, start) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f1, t + start);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + start + dur);
    g.gain.setValueAtTime(0.0001, t + start);
    g.gain.exponentialRampToValueAtTime(gain * vol, t + start + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + start + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t + start); o.stop(t + start + dur + 0.03);
  };
  switch (name) {
    case 'dice':
      for (let i = 0; i < 6; i++) { const f = 170 + Math.random() * 200; beep(f, f * 0.8, 'square', 0.04, 0.09, i * 0.07); }
      beep(150, 95, 'square', 0.11, 0.14, 0.46); // финальный удар, кубики легли
      break;
    case 'step':    beep(340,300,'sine',0.045,0.06,0); break;
    case 'coinIn':  beep(659,988,'triangle',0.11,0.16,0); beep(988,1319,'triangle',0.11,0.14,0.08); break;
    case 'coinOut': beep(440,330,'triangle',0.13,0.15,0); beep(294,220,'triangle',0.15,0.13,0.09); break;
    case 'payAlert':beep(880,880,'sine',0.10,0.16,0); beep(660,660,'sine',0.14,0.16,0.12); break;
  }
}

// ---------- Фоновая музыка ----------
(function initMusic() {
  const audio = document.getElementById('bg-music');
  const slider = document.getElementById('music-volume');
  const toggle = document.getElementById('music-toggle');
  if (!audio || !slider || !toggle) return;

  let vol = parseInt(localStorage.getItem('monopoly_music_vol') || '35', 10);
  let muted = localStorage.getItem('monopoly_music_muted') === '1';
  slider.value = vol;
  audio.volume = vol / 100;

  function refresh() {
    audio.muted = muted || vol === 0;
    toggle.textContent = audio.muted ? '🔇' : '🎵';
    toggle.classList.toggle('off', audio.muted);
  }
  function tryPlay() { audio.play().catch(() => {}); }

  slider.addEventListener('input', () => {
    vol = parseInt(slider.value, 10);
    audio.volume = vol / 100;
    if (vol > 0) muted = false;
    localStorage.setItem('monopoly_music_vol', String(vol));
    localStorage.setItem('monopoly_music_muted', muted ? '1' : '0');
    refresh();
    tryPlay();
  });
  toggle.addEventListener('click', () => {
    muted = !muted;
    localStorage.setItem('monopoly_music_muted', muted ? '1' : '0');
    refresh();
    if (!muted) tryPlay();
  });

  // автозапуск по первому взаимодействию (политика автоплея)
  const startOnce = () => { refresh(); tryPlay(); };
  window.addEventListener('pointerdown', startOnce, { once: true });
  window.addEventListener('keydown', startOnce, { once: true });
  refresh();
})();

// ---------- Громкость звуков (похвала и игровые звуки) ----------
(function initSfx() {
  const slider = document.getElementById('sfx-volume');
  const toggle = document.getElementById('sfx-toggle');
  if (!slider || !toggle) return;
  slider.value = Math.round(sfxVolume * 100);
  function refresh() {
    const off = sfxMuted || sfxVolume <= 0;
    toggle.textContent = off ? '🔇' : '🔊';
    toggle.classList.toggle('off', off);
  }
  slider.addEventListener('input', () => {
    sfxVolume = parseInt(slider.value, 10) / 100;
    if (sfxVolume > 0) sfxMuted = false;
    localStorage.setItem('monopoly_sfx_vol', String(Math.round(sfxVolume * 100)));
    localStorage.setItem('monopoly_sfx_muted', sfxMuted ? '1' : '0');
    refresh();
  });
  slider.addEventListener('change', () => { if (sfxGain() > 0) playPraiseSound(); }); // пример — звук похвалы
  toggle.addEventListener('click', () => {
    sfxMuted = !sfxMuted;
    localStorage.setItem('monopoly_sfx_muted', sfxMuted ? '1' : '0');
    refresh();
    if (!sfxMuted) playPraiseSound();
  });
  refresh();
})();

function routeScreen() {
  if (!STATE.started) {
    $('waiting-screen').classList.remove('hidden');
    $('game-screen').classList.add('hidden');
    renderWaiting();
  } else {
    $('waiting-screen').classList.add('hidden');
    $('game-screen').classList.remove('hidden');
  }
}

function renderWaiting() {
  $('room-code').textContent = STATE.code;
  $('share-link').textContent = `${location.origin}/?room=${STATE.code}`;
  const wp = $('waiting-players');
  wp.innerHTML = '';
  STATE.players.forEach(p => {
    const c = document.createElement('div');
    c.className = 'wp-chip';
    const av = p.avatar ? `<img class="wp-av" src="${p.avatar}" style="border-color:${p.color}">` : `<span>${p.token}</span>`;
    c.innerHTML = `${av} ${p.name}${p.id === STATE.hostId ? ' 👑' : ''}`;
    wp.appendChild(c);
  });
  renderTokenPicker();
  const isHost = STATE.hostId === YOU;
  $('start-btn').classList.toggle('hidden', !isHost);
  $('start-btn').disabled = STATE.players.length < 2;
  $('waiting-hint').textContent = isHost
    ? (STATE.players.length < 2 ? 'Нужно минимум 2 игрока.' : 'Можно начинать!')
    : 'Ждём, пока хост начнёт игру…';
}

function renderTokenPicker() {
  const picker = $('token-picker');
  if (!picker) return;
  picker.innerHTML = '';
  const me = STATE.players.find(p => p.id === YOU);
  TOKEN_HEROES.forEach(h => {
    const takenBy = STATE.players.find(p => p.tokenKey === h.key);
    const mine = me && me.tokenKey === h.key;
    const takenByOther = takenBy && (!me || takenBy.id !== me.id);
    const b = document.createElement('button');
    b.className = 'token-opt' + (mine ? ' chosen' : '') + (takenByOther ? ' taken' : '');
    b.title = takenByOther ? `${h.name} — занят (${takenBy.name})` : h.name;
    b.innerHTML = `<img src="${h.img}" alt="${h.name}" loading="lazy">`;
    if (!takenByOther) b.onclick = () => socket.emit('chooseToken', { key: h.key });
    picker.appendChild(b);
  });
}

// ---------- Полный рендер игры ----------
function renderAll() {
  renderBoard();
  renderPlayers();
  renderActions();
  renderLog();
  renderTrade();
  renderPayPrompt();
}

const GRID = {}; // pos -> {row, col}
function buildGrid() {
  // 11x11. pos0 правый-нижний угол.
  // СТАРТ — в левом верхнем углу, ход по часовой стрелке
  GRID[0] = { r: 1, c: 1 };                                            // СТАРТ (верх-лево)
  for (let i = 1; i <= 9; i++) GRID[i] = { r: 1, c: i + 1 };           // верхний ряд лево→право
  GRID[10] = { r: 1, c: 11 };                                          // верх-право
  for (let i = 11; i <= 19; i++) GRID[i] = { r: (i - 10) + 1, c: 11 }; // правый столбец сверху вниз
  GRID[20] = { r: 11, c: 11 };                                         // низ-право
  for (let i = 21; i <= 29; i++) GRID[i] = { r: 11, c: 11 - (i - 20) }; // нижний ряд право→лево
  GRID[30] = { r: 11, c: 1 };                                          // низ-лево
  for (let i = 31; i <= 39; i++) GRID[i] = { r: 11 - (i - 30), c: 1 }; // левый столбец снизу вверх
}
buildGrid();

function renderBoard() {
  const board = $('board');
  board.innerHTML = '';
  const starBadges = [];

  BOARD.forEach(t => {
    const g = GRID[t.pos];
    const el = document.createElement('div');
    const isCorner = ['go', 'jail', 'parking', 'gotojail'].includes(t.type);
    el.className = 'tile' + (isCorner ? ' corner' : '');
    // ориентация по стороне доски (плашка с цветом — по внешнему краю)
    if (!isCorner) {
      if (g.r === 11) el.classList.add('side-bottom');
      else if (g.r === 1) el.classList.add('side-top');
      else if (g.c === 1) el.classList.add('side-left');
      else if (g.c === 11) el.classList.add('side-right');
    }
    el.style.gridRow = g.r;
    el.style.gridColumn = g.c;
    el.dataset.pos = t.pos;

    const o = STATE.ownership[t.pos];
    if (o && o.mortgaged) el.classList.add('mortgaged');

    // плашка с цветом и ценой (цвет группы у улиц, нейтральный у прочих)
    let stripBg = null;
    if (t.type === 'street') stripBg = GROUPS[t.group].color;
    else if (t.type === 'rail' || t.type === 'utility') stripBg = '#2a3350';
    else if (t.type === 'tax') stripBg = '#3a2536';
    let priceText = '';
    if (t.type === 'tax') priceText = `−${t.amount}🪙`;
    else if (o && o.mortgaged) priceText = 'залог';
    else if (o) priceText = clientRentDisplay(t, o);
    else if (t.price) priceText = `${t.price}🪙`;

    let inner = '';
    if (stripBg) inner += `<div class="strip" style="background:${stripBg}">${priceText}</div>`;
    inner += `<div class="body">`;
    inner += iconMarkup(t);
    // имя показываем только у этих клеток (остальные — только картинка); скобки убираем, чтобы не обрезалось
    if ([4, 10, 30].indexOf(t.pos) !== -1) inner += `<div class="tname">${t.name.replace(/\s*\(.*?\)\s*/g, '')}</div>`;
    inner += `</div>`;
    el.innerHTML = inner;

    // флаг владельца + рамка по периметру в цвет владельца
    if (o) {
      const owner = STATE.players.find(p => p.id === o.owner);
      if (owner) {
        const flag = document.createElement('div');
        flag.className = 'owner-flag';
        flag.style.background = owner.color;
        el.appendChild(flag);
        el.classList.add('owned');
        el.style.boxShadow = `inset 0 0 0 3px ${owner.color}, 0 0 0 2px ${owner.color}, 0 0 9px 1px ${owner.color}`;
        el.style.borderColor = owner.color;
      }
      // уровни застройки — звёздами над клеткой (добавим после цикла)
      if (t.type === 'street' && o.houses > 0) {
        starBadges.push({ r: g.r, c: g.c, houses: o.houses });
      }
    }

    el.onclick = () => openTileModal(t.pos);
    board.appendChild(el);
  });

  // звёзды уровней — поверх, у верхнего края клетки
  starBadges.forEach(b => {
    const sb = document.createElement('div');
    sb.className = 'stars-badge';
    sb.style.gridRow = b.r;
    sb.style.gridColumn = b.c;
    sb.textContent = b.houses === 5 ? '🌟' : '⭐'.repeat(b.houses);
    sb.title = b.houses === 5 ? 'Отель (макс. уровень)' : `Уровень ${b.houses}`;
    board.appendChild(sb);
  });

  // центр
  const center = document.createElement('div');
  center.className = 'board-center';
  const cur = STATE.players[STATE.turnIndex];
  center.innerHTML = `
    <div class="center-top">
      <div class="turn-banner">${STATE.phase === 'over' ? '🏆 Игра окончена' : `Ход: ${cur ? cur.token + ' ' + cur.name : '—'}`}</div>
      <div class="dice-area">
        <div class="die" id="die1">${STATE.dice[0] || '?'}</div>
        <div class="die" id="die2">${STATE.dice[1] || '?'}</div>
      </div>
    </div>
    <div class="center-log-title">📜 Журнал</div>
    <div id="log" class="log center-log"></div>
  `;
  board.appendChild(center);

  // фишки игроков (по отображаемым позициям — для пошаговой анимации)
  placeTokens();
}

// Размещение фишек на доске по displayPos (не пересобирая всю доску)
function placeTokens() {
  const board = $('board');
  if (!board) return;
  board.querySelectorAll('.tokens').forEach(w => w.remove());
  const curId = STATE.players[STATE.turnIndex] ? STATE.players[STATE.turnIndex].id : null;
  const byPos = {};
  STATE.players.forEach(p => {
    if (p.bankrupt) return;
    const dp = displayPos[p.id] !== undefined ? displayPos[p.id] : p.pos;
    (byPos[dp] = byPos[dp] || []).push(p);
  });
  Object.keys(byPos).forEach(pos => {
    const tileEl = board.querySelector(`.tile[data-pos="${pos}"]`);
    if (!tileEl) return;
    const wrap = document.createElement('div');
    wrap.className = 'tokens';
    byPos[pos].forEach(p => {
      const tk = document.createElement('span');
      tk.className = 'player-token';
      if (hoppingIds.has(p.id)) tk.classList.add('hop');
      else if (p.id === curId && STATE.phase !== 'over') tk.classList.add('current');
      tk.style.borderColor = p.color;
      if (p.avatar) {
        tk.classList.add('has-img');
        tk.innerHTML = `<img src="${p.avatar}" alt="" onerror="this.parentNode.classList.remove('has-img');this.parentNode.textContent='${p.token}'">`;
      } else {
        tk.style.background = p.color;
        tk.textContent = p.token;
      }
      tk.title = p.name;
      wrap.appendChild(tk);
    });
    tileEl.appendChild(wrap);
  });
}

// Запуск перемещения после «проигрывания» кубиков (фишка идёт по пути этап за этапом)
function startMoves() {
  if (!STATE || !STATE.started) return;
  // инициализация новых фишек — без анимации
  STATE.players.forEach(p => { if (displayPos[p.id] === undefined) displayPos[p.id] = p.pos; });

  const mover = STATE.animFor;
  let path = (STATE.animPath || []).slice();
  if (mover && displayPos[mover] !== undefined) {
    const fp = STATE.players.find(x => x.id === mover);
    if (path.length === 0 && fp && displayPos[mover] !== fp.pos) path = [fp.pos]; // запасной вариант
    if (path.length && !movingIds.has(mover)) {
      moveQueue[mover] = path;
      movingIds.add(mover);
      walkStep(mover);
    }
  }
  // прочие фишки, если вдруг сместились (без пути) — догнать к их позиции
  STATE.players.forEach(p => {
    if (p.id === mover) return;
    if (displayPos[p.id] !== p.pos && !movingIds.has(p.id)) {
      moveQueue[p.id] = [p.pos];
      movingIds.add(p.id);
      walkStep(p.id);
    }
  });

  if (movingIds.size === 0) finishTurnAnim();
  else armAnimWatchdog();
}

// Фишка прошла ВЕСЬ путь — показать оповещения и кнопки хода
function finishTurnAnim() {
  clearTimeout(animWatchdog);
  if (!turnAnimating) return;
  turnAnimating = false;
  flushPendingSounds(); // фишка дошла — проигрываем отложенные звуки событий
  if (STATE && STATE.started) { renderActions(); renderPayPrompt(); }
}

// Страховка: если анимация почему-то зависла — разблокировать через 12с
function armAnimWatchdog() {
  clearTimeout(animWatchdog);
  animWatchdog = setTimeout(() => {
    movingIds.clear();
    moveQueue = {};
    if (STATE && STATE.players) STATE.players.forEach(p => { displayPos[p.id] = p.pos; });
    placeTokens();
    turnAnimating = false;
    flushPendingSounds();
    if (STATE && STATE.started) { renderActions(); renderPayPrompt(); }
  }, 12000);
}

// Для нестроевых состояний (без броска): инициализация и подтягивание позиций
function animateMoves() {
  if (!STATE || !STATE.started) return;
  STATE.players.forEach(p => {
    if (displayPos[p.id] === undefined) { displayPos[p.id] = p.pos; return; }
    if (displayPos[p.id] !== p.pos && !movingIds.has(p.id)) displayPos[p.id] = p.pos;
  });
  placeTokens();
}

function walkStep(pid) {
  const player = STATE.players.find(x => x.id === pid);
  if (!player) { movingIds.delete(pid); return; }
  let q = moveQueue[pid] || [];
  // пропускаем уже достигнутые цели
  while (q.length && displayPos[pid] === q[0]) q.shift();
  if (q.length === 0) { // весь путь пройден
    movingIds.delete(pid); placeTokens();
    if (movingIds.size === 0) finishTurnAnim();
    return;
  }
  const target = q[0];
  // телепорт на респаун (смерть/тюрьма)
  if (player.inJail && target === 10) {
    displayPos[pid] = 10; moveQueue[pid] = [];
    movingIds.delete(pid); placeTokens();
    if (movingIds.size === 0) finishTurnAnim();
    return;
  }
  // направление к текущей цели: вперёд, назад — только короткий этап (карта «на N назад»)
  const forward = (target - displayPos[pid] + 40) % 40;
  const backward = 40 - forward;
  const dir = (backward >= 1 && backward <= 4) ? -1 : 1;
  displayPos[pid] = (displayPos[pid] + dir + 40) % 40;
  hoppingIds.add(pid);
  playSnd('step');
  placeTokens();
  setTimeout(() => hoppingIds.delete(pid), 180);
  setTimeout(() => walkStep(pid), 230);
}

// Картинка клетки: фото из Dota 2 + запасной эмодзи, если картинка не загрузится
function iconMarkup(t) {
  if (t.img) {
    return `<img class="tphoto" src="${t.img}" alt="${t.name}" loading="lazy" onerror="this.classList.add('img-fail')"><div class="ticon ticon-fb">${t.icon || ''}</div>`;
  }
  return `<div class="ticon">${t.icon || ''}</div>`;
}

// Маленькая миниатюра для списков: картинка Dota 2, если есть, иначе эмодзи
function propThumb(t) {
  if (t.img) return `<img class="pi-img" src="${t.img}" alt="" onerror="this.replaceWith(document.createTextNode('${t.icon || ''}'))">`;
  return `<span class="pi-emoji">${t.icon || ''}</span>`;
}

function animateDice() {
  ['die1', 'die2'].forEach(id => {
    const d = $(id); if (!d) return;
    d.classList.remove('rolling'); void d.offsetWidth; d.classList.add('rolling');
  });
}

function renderPlayers() {
  const panel = $('players-panel');
  panel.innerHTML = '<h3>Игроки</h3>';
  const me = STATE.players.find(p => p.id === YOU);
  STATE.players.forEach((p, i) => {
    const card = document.createElement('div');
    card.className = 'pcard' + (i === STATE.turnIndex && STATE.phase !== 'over' ? ' active' : '') + (p.bankrupt ? ' bankrupt' : '') + (!p.connected ? ' offline' : '');
    card.innerHTML = `
      <div class="ptoken">${p.avatar ? `<img class="ptoken-img" src="${p.avatar}" style="border-color:${p.color}" alt="">` : p.token}</div>
      <div class="pinfo">
        <div class="pname">
          <span class="pdot" style="background:${p.color}"></span>
          <span class="pname-text">${p.name}</span>
          ${p.id === YOU ? '<span class="youtag">вы</span>' : ''}
        </div>
        <div class="pmeta">
          ${p.inJail ? '<span class="jailtag">🔒</span>' : ''}
          ${p.getOutCards ? `<span class="aegistag" title="Свитки Aegis">🛡️${p.getOutCards}</span>` : ''}
          ${p.praises ? `<span class="praisetag" title="Похвалы">👍${p.praises}</span>` : ''}
        </div>
      </div>
      <div class="pmoney">${p.money}🪙</div>
      ${!p.connected ? '<div class="offline-overlay">Отключён</div>' : ''}
    `;
    // клик по карточке — список героев игрока с ценами
    card.style.cursor = 'pointer';
    card.title = 'Показать недвижимость игрока';
    card.onclick = () => openPlayerModal(p.id);
    // кнопка похвалы для других игроков
    if (me && !me.bankrupt && p.id !== YOU && !p.bankrupt) {
      const pb = document.createElement('button');
      pb.className = 'btn praise-btn';
      pb.dataset.to = p.id;
      pb.textContent = '👍';
      pb.title = 'Похвалить игрока';
      pb.onclick = (e) => { e.stopPropagation(); act('praise', { to: p.id }); };
      card.appendChild(pb);
    }
    panel.appendChild(card);
  });
  const leave = document.createElement('button');
  leave.className = 'btn leave-btn';
  leave.textContent = '🚪 Выйти из игры';
  leave.onclick = leaveGame;
  panel.appendChild(leave);
  updatePraiseButtons();
}

// Обновление состояния кнопок похвалы (кулдаун 20 сек)
function updatePraiseButtons() {
  if (!STATE) return;
  const me = STATE.players.find(p => p.id === YOU);
  const cooldown = STATE.praiseCooldown || 20000;
  // компенсация расхождения часов клиента и сервера
  const offset = (STATE.now || Date.now()) - clientNowAtState;
  const elapsed = (Date.now() + offset) - (me ? me.lastPraiseAt : 0);
  const remaining = Math.ceil((cooldown - elapsed) / 1000);
  document.querySelectorAll('.praise-btn').forEach(btn => {
    if (!me || me.lastPraiseAt === 0 || remaining <= 0) {
      btn.disabled = false;
      btn.textContent = '👍';
      btn.classList.remove('cooling');
    } else {
      btn.disabled = true;
      btn.textContent = `⏳${remaining}`;
      btn.classList.add('cooling');
    }
  });
}

// ---------- Панель действий ----------
function renderActions() {
  const panel = $('action-panel');
  panel.innerHTML = '';
  const me = STATE.players.find(p => p.id === YOU);
  const cur = STATE.players[STATE.turnIndex];
  const myTurn = cur && cur.id === YOU && !me.bankrupt;

  if (STATE.phase === 'over') {
    const w = STATE.players.find(p => p.id === STATE.winner);
    panel.innerHTML = `<div class="action-title">🏆 Победа!</div><div class="action-sub">${w ? w.token + ' ' + w.name + ' выигрывает игру.' : ''}</div>`;
    return;
  }

  if (STATE.phase === 'auction' && STATE.auction) {
    renderAuction(panel, me);
    return;
  }

  // пока фишка идёт — прячем кнопки/оповещения текущего игрока
  if (myTurn && turnAnimating) {
    panel.innerHTML = '<div class="action-title">Ваш ход</div><div class="action-sub">🎲 Фишка идёт к клетке…</div>';
    return;
  }

  const title = document.createElement('div');
  title.className = 'action-title';
  title.textContent = myTurn ? 'Ваш ход' : `Ходит ${cur ? cur.name : ''}`;
  panel.appendChild(title);

  if (!myTurn) {
    const sub = document.createElement('div');
    sub.className = 'action-sub';
    sub.textContent = 'Ожидайте свой ход. Можно управлять своей недвижимостью и предлагать сделки.';
    panel.appendChild(sub);
    renderPropertyManager(panel, me, false);
    return;
  }

  // Режим долга — не хватает денег: продать/заложить, затем заплатить или банкротство
  if (STATE.phase === 'debt' && STATE.pendingDebt) {
    const need = STATE.pendingDebt.amount;
    const enough = me.money >= need;
    const sub = document.createElement('div'); sub.className = 'action-sub';
    sub.innerHTML = `⚠️ Не хватает денег! Нужно <b>${need}🪙</b>, у вас <b>${me.money}🪙</b>.<br>Продайте дома или заложите имущество ниже, затем заплатите — или объявите банкротство.`;
    panel.appendChild(sub);
    const row = document.createElement('div'); row.className = 'action-row';
    const payBtn = btn(`💸 Заплатить ${need}🪙`, () => act('payDebt'), 'btn-primary');
    payBtn.disabled = !enough;
    row.appendChild(payBtn);
    row.appendChild(btn('💥 Банкротство', () => { if (confirm('Объявить себя банкротом? Всё имущество перейдёт кредитору/банку.')) act('declareBankruptcy'); }));
    panel.appendChild(row);
    renderPropertyManager(panel, me, true);
    return;
  }

  // Свой ход
  if (STATE.phase === 'roll') {
    if (me.inJail) {
      const sub = document.createElement('div'); sub.className = 'action-sub';
      sub.textContent = 'Вы в тюрьме. Бросьте дубль, заплатите 50🪙 или используйте карту.';
      panel.appendChild(sub);
      const row = document.createElement('div'); row.className = 'action-row';
      row.appendChild(btn('🎲 Бросить (на дубль)', () => act('roll'), 'btn-primary'));
      if (me.money >= 50) row.appendChild(btn('💵 Заплатить 50🪙', () => act('payJail')));
      if (me.getOutCards > 0) row.appendChild(btn('🎟️ Карта выхода', () => act('useJailCard')));
      panel.appendChild(row);
    } else {
      const sub = document.createElement('div'); sub.className = 'action-sub';
      sub.textContent = 'До броска можно строить, закладывать и торговать. После броска ход завершится автоматически.';
      panel.appendChild(sub);
      const row = document.createElement('div'); row.className = 'action-row';
      const again = STATE.doublesCount > 0;
      row.appendChild(btn(again ? '🎲 Бросить ещё раз (дубль!)' : '🎲 Бросить кубики', () => act('roll'), 'btn-primary'));
      panel.appendChild(row);
    }
  } else if (STATE.phase === 'buy') {
    const t = BOARD[STATE.pendingPos];
    const sub = document.createElement('div'); sub.className = 'action-sub';
    sub.innerHTML = `«<b>${t.name}</b>» свободна. Цена <b>${t.price}🪙</b>.`;
    panel.appendChild(sub);
    const row = document.createElement('div'); row.className = 'action-row';
    const buyBtn = btn(`🏷️ Купить за ${t.price}🪙`, () => act('buy'), 'btn-primary');
    buyBtn.disabled = me.money < t.price;
    row.appendChild(buyBtn);
    row.appendChild(btn('🔨 На аукцион', () => act('declineBuy')));
    panel.appendChild(row);
  } else if (STATE.phase === 'pay' && STATE.pendingPay) {
    const pp = STATE.pendingPay;
    const sub = document.createElement('div'); sub.className = 'action-sub';
    sub.innerHTML = `Нужно заплатить аренду <b>${pp.amount}🪙</b> игроку <b>${pp.toName}</b> за «${pp.tileName}».`;
    panel.appendChild(sub);
    const row = document.createElement('div'); row.className = 'action-row';
    row.appendChild(btn(`💸 Заплатить ${pp.amount}🪙`, () => act('payRent'), 'btn-primary'));
    panel.appendChild(row);
  }

  // банкротство добровольно если деньги <0 невозможно, но даём кнопку выхода
  if (me.money < 0 || myTurn) {
    // менеджер недвижимости + банкротство
  }
  renderPropertyManager(panel, me, true);

  const dangerRow = document.createElement('div'); dangerRow.className = 'action-row';
  dangerRow.appendChild(btn('🤝 Предложить сделку', openTradeModal));
  if (myTurn) {
    const bk = btn('💥 Сдаться (банкрот)', () => { if (confirm('Объявить себя банкротом?')) act('declareBankruptcy'); });
    dangerRow.appendChild(bk);
  }
  panel.appendChild(dangerRow);
}

function renderAuction(panel, me) {
  const a = STATE.auction;
  const t = BOARD[a.pos];
  const turnPlayer = STATE.players[a.turn];
  const myAuctionTurn = turnPlayer && turnPlayer.id === YOU && a.active.includes(YOU);
  panel.innerHTML = `<div class="action-title">🔨 Аукцион</div>`;
  const sub = document.createElement('div'); sub.className = 'action-sub';
  const highName = a.highBidder ? STATE.players.find(p => p.id === a.highBidder).name : '—';
  sub.innerHTML = `«<b>${t.name}</b>»<br>Текущая ставка: <b>${a.highBid}🪙</b> (${highName})<br>Сейчас ставит: <b>${turnPlayer ? turnPlayer.name : ''}</b>`;
  panel.appendChild(sub);

  if (myAuctionTurn) {
    const inp = document.createElement('input');
    inp.type = 'number'; inp.min = a.highBid + 1; inp.value = a.highBid + 10;
    inp.style.margin = '8px 0';
    panel.appendChild(inp);
    const row = document.createElement('div'); row.className = 'action-row';
    const bid = btn('Сделать ставку', () => act('auctionBid', { amount: Number(inp.value) }), 'btn-primary');
    bid.disabled = me.money <= a.highBid;
    row.appendChild(bid);
    row.appendChild(btn('Пас', () => act('auctionPass')));
    panel.appendChild(row);
  } else {
    const w = document.createElement('div'); w.className = 'action-sub';
    w.textContent = a.active.includes(YOU) ? 'Ожидайте своей очереди делать ставку.' : 'Вы вышли из торгов.';
    panel.appendChild(w);
  }
}

function renderPropertyManager(panel, me, isMyTurn) {
  const mine = Object.keys(STATE.ownership)
    .map(Number)
    .filter(pos => STATE.ownership[pos].owner === YOU)
    .sort((a, b) => a - b);
  if (mine.length === 0) return;
  const wrap = document.createElement('div');
  wrap.className = 'prop-manage';
  const h = document.createElement('h3'); h.textContent = 'Моя недвижимость'; h.style.margin = '6px 0 0';
  panel.appendChild(h);
  mine.forEach(pos => {
    const t = BOARD[pos];
    const o = STATE.ownership[pos];
    const item = document.createElement('div');
    item.className = 'prop-item';
    const barColor = t.group ? GROUPS[t.group].color : '#888';
    let label = t.name;
    if (t.type === 'street' && o.houses > 0) label += o.houses === 5 ? ' 🌟' : ' ' + '⭐'.repeat(o.houses);
    if (o.mortgaged) label += ' (залог)';
    item.innerHTML = `<div class="pi-bar" style="background:${barColor}"></div>${propThumb(t)}<div class="pi-name">${label}</div>`;

    // кнопки
    if (t.type === 'street' && !o.mortgaged) {
      const builtThisTurn = STATE.builtGroups && STATE.builtGroups[t.group];
      const canBuild = ownsFullGroupClient(t.group) && o.houses < 5 && !builtThisTurn;
      if (canBuild) item.appendChild(smallBtn('🏠+', () => act('build', { pos })));
      else if (builtThisTurn && ownsFullGroupClient(t.group) && o.houses < 5) {
        const b = smallBtn('🏠+', () => {});
        b.disabled = true;
        b.title = 'Эту монополию уже улучшали в этом ходу';
        item.appendChild(b);
      }
      if (o.houses > 0) item.appendChild(smallBtn('🏠−', () => act('sellHouse', { pos })));
    }
    if (!o.mortgaged && (t.type !== 'street' || o.houses === 0)) {
      item.appendChild(smallBtn('Заложить', () => act('mortgage', { pos })));
    }
    if (o.mortgaged) {
      item.appendChild(smallBtn('Выкупить', () => act('unmortgage', { pos })));
    }
    wrap.appendChild(item);
  });
  panel.appendChild(wrap);
}

function ownsFullGroupClient(group) {
  if (!group) return false;
  const tiles = BOARD.filter(t => t.group === group);
  return tiles.every(t => STATE.ownership[t.pos] && STATE.ownership[t.pos].owner === YOU);
}

function ownsFullGroupBy(group, ownerId) {
  if (!group) return false;
  const tiles = BOARD.filter(t => t.group === group);
  return tiles.length > 0 && tiles.every(t => STATE.ownership[t.pos] && STATE.ownership[t.pos].owner === ownerId);
}

// Аренда, которую заплатит попавший на клетку (для отображения)
function clientRentDisplay(t, o) {
  if (t.type === 'street') {
    let r;
    if (o.houses > 0) r = t.rent[o.houses];
    else r = ownsFullGroupBy(t.group, o.owner) ? t.rent[0] * 2 : t.rent[0];
    return r + '🪙';
  }
  if (t.type === 'rail') {
    const n = BOARD.filter(x => x.type === 'rail' && STATE.ownership[x.pos] && STATE.ownership[x.pos].owner === o.owner).length;
    return [0, 25, 50, 100, 200][n] + '🪙';
  }
  if (t.type === 'utility') {
    const n = BOARD.filter(x => x.type === 'utility' && STATE.ownership[x.pos] && STATE.ownership[x.pos].owner === o.owner).length;
    return (n === 2 ? '×10' : '×4') + ' 🎲';
  }
  return '';
}

function btn(text, onclick, cls = '') {
  const b = document.createElement('button');
  b.className = 'btn ' + cls;
  b.textContent = text;
  b.onclick = onclick;
  return b;
}
function smallBtn(text, onclick) {
  const b = document.createElement('button');
  b.className = 'btn btn-sm';
  b.textContent = text;
  b.onclick = onclick;
  return b;
}

function renderLog() {
  const logEl = $('log');
  logEl.innerHTML = '';
  STATE.log.forEach(line => {
    const d = document.createElement('div');
    d.textContent = line;
    logEl.appendChild(d);
  });
  logEl.scrollTop = logEl.scrollHeight;
}

// ---------- Модальное окно клетки ----------
function openTileModal(pos) {
  const t = BOARD[pos];
  const o = STATE.ownership[pos];
  const modal = $('tile-modal');
  const c = $('tile-modal-content');
  let headColor = t.group ? GROUPS[t.group].color : '#2a2f47';
  let rows = '';

  if (t.type === 'street') {
    rows += deedRow('Группа', GROUPS[t.group].name);
    rows += deedRow('Цена', t.price + '🪙');
    rows += deedRow('Аренда', t.rent[0] + '🪙');
    rows += deedRow('Аренда (монополия)', t.rent[0] * 2 + '🪙');
    rows += deedRow('С 1 домом', t.rent[1] + '🪙');
    rows += deedRow('С 2 домами', t.rent[2] + '🪙');
    rows += deedRow('С 3 домами', t.rent[3] + '🪙');
    rows += deedRow('С 4 домами', t.rent[4] + '🪙');
    rows += deedRow('🏨 Отель', t.rent[5] + '🪙');
    rows += deedRow('Цена дома/отеля', t.house + '🪙');
    rows += deedRow('Залог', Math.floor(t.price / 2) + '🪙');
  } else if (t.type === 'rail') {
    rows += deedRow('Цена', t.price + '🪙');
    rows += deedRow('1 башня', '25🪙');
    rows += deedRow('2 башни', '50🪙');
    rows += deedRow('3 башни', '100🪙');
    rows += deedRow('4 башни', '200🪙');
    rows += deedRow('Залог', '100🪙');
  } else if (t.type === 'utility') {
    rows += deedRow('Цена', t.price + '🪙');
    rows += deedRow('1 объект', '4× бросок');
    rows += deedRow('2 объекта', '10× бросок');
    rows += deedRow('Залог', '75🪙');
  } else if (t.type === 'tax') {
    rows += deedRow('Налог', t.amount + '🪙');
  } else {
    rows += deedRow('Тип', tileTypeName(t.type));
  }

  if (o) {
    const owner = STATE.players.find(p => p.id === o.owner);
    rows = deedRow('Владелец', owner ? owner.token + ' ' + owner.name : '—') + rows;
    if (o.mortgaged) rows = deedRow('Статус', '🏦 Заложено') + rows;
  } else if (t.price) {
    rows = deedRow('Владелец', 'Свободно') + rows;
  }

  let desc = tileDescription(t);
  if (t.img && desc) desc = desc.replace(/^\s*[^\s<]+\s+/, ''); // убрать ведущий эмодзи, если есть фото
  c.innerHTML = `
    <div class="deed">
      <div class="deed-head" style="background:${headColor}">
        ${t.img ? `<img class="dh-photo" src="${t.img}" alt="${t.name}" onerror="this.classList.add('img-fail')"><div class="dh-icon dh-fb">${t.icon || '🎩'}</div>` : `<div class="dh-icon">${t.icon || '🎩'}</div>`}
        <div class="dh-name">${t.name}</div>
        ${t.group ? `<div class="dh-group">${GROUPS[t.group].name}</div>` : ''}
      </div>
      <div class="deed-body">
        ${desc ? `<div class="deed-desc">${desc}</div>` : ''}
        ${rows}
      </div>
      <div class="modal-actions"><button class="btn modal-close">Закрыть</button></div>
    </div>`;
  modal.classList.remove('hidden');
  c.querySelector('.modal-close').onclick = () => modal.classList.add('hidden');
  modal.onclick = (e) => { if (e.target === modal) modal.classList.add('hidden'); };
}
function deedRow(l, v) { return `<div class="deed-row"><span class="dl">${l}</span><span class="dv">${v}</span></div>`; }

// Список героев (недвижимости) игрока с ценами
function openPlayerModal(pid) {
  const p = STATE.players.find(x => x.id === pid);
  if (!p) return;
  const modal = $('player-modal');
  const c = $('player-modal-content');
  const owned = Object.keys(STATE.ownership).map(Number)
    .filter(pos => STATE.ownership[pos].owner === pid)
    .sort((a, b) => a - b);
  let rows;
  if (owned.length === 0) {
    rows = '<div class="deed-desc">Пока нет недвижимости.</div>';
  } else {
    rows = owned.map(pos => {
      const t = BOARD[pos];
      const o = STATE.ownership[pos];
      let stars = '';
      if (t.type === 'street' && o.houses > 0) stars = o.houses === 5 ? ' 🌟' : ' ' + '⭐'.repeat(o.houses);
      const bar = t.group ? GROUPS[t.group].color : '#7a849c';
      const price = o.mortgaged
        ? '<span style="color:var(--red)">залог</span>'
        : `${t.price}🪙 · аренда ${clientRentDisplay(t, o)}`;
      return `<div class="pm-row"><span class="pm-bar" style="background:${bar}"></span>${propThumb(t)}<span class="pm-name">${t.name}${stars}</span><span class="pm-price">${price}</span></div>`;
    }).join('');
  }
  c.innerHTML = `
    <div class="deed-head" style="background:${p.color}">
      ${p.avatar ? `<img class="dh-photo" src="${p.avatar}" alt="" style="border-radius:50%">` : `<div class="dh-icon">${p.token}</div>`}
      <div class="dh-name">${p.name}</div>
      <div class="dh-group">💰 ${p.money}🪙 · 💼 капитал ${p.netWorth}🪙 · объектов: ${owned.length}</div>
    </div>
    <div class="deed-body pm-list">${rows}</div>
    <div class="modal-actions"><button class="btn modal-close" style="width:100%">Закрыть</button></div>`;
  modal.classList.remove('hidden');
  c.querySelector('.modal-close').onclick = () => modal.classList.add('hidden');
  modal.onclick = (e) => { if (e.target === modal) modal.classList.add('hidden'); };
}

// Окно подтверждения оплаты аренды
function renderPayPrompt() {
  const modal = $('pay-modal');
  if (!modal) return;
  const pp = STATE.pendingPay;
  // пока фишка идёт — окно оплаты не показываем
  const mine = STATE.phase === 'pay' && pp && STATE.currentPlayerId === YOU && !turnAnimating;
  if (!mine) {
    modal.classList.add('hidden');
    if (!pp) payShownFor = null;
    return;
  }
  const me = STATE.players.find(p => p.id === YOU);
  const key = JSON.stringify(pp);
  if (payShownFor !== key) { payShownFor = key; playSnd('payAlert'); }
  const enough = me && me.money >= pp.amount;
  const c = $('pay-modal-content');
  c.innerHTML = `
    <div class="deed-head" style="background:#5c2020">
      <div class="dh-icon">💸</div>
      <div class="dh-name">Оплата аренды</div>
    </div>
    <div class="deed-body">
      <div class="deed-desc">Вы попали на «<b>${pp.tileName}</b>» игрока <b>${pp.toToken} ${pp.toName}</b>. Нужно заплатить аренду.</div>
      ${deedRow('К оплате', '<b>' + pp.amount + '🪙</b>')}
      ${deedRow('Ваш баланс', (me ? me.money : 0) + '🪙')}
      ${enough ? '' : '<div class="deed-desc" style="color:var(--red)">Денег не хватает — при оплате активы будут проданы/заложены автоматически, а при нехватке наступит банкротство.</div>'}
    </div>
    <div class="modal-actions">
      <button class="btn btn-primary" id="pay-confirm" style="width:100%">💸 Заплатить ${pp.amount}🪙 игроку ${pp.toName}</button>
    </div>`;
  modal.classList.remove('hidden');
  $('pay-confirm').onclick = () => { act('payRent'); };
}
function tileTypeName(type) {
  return { go: 'Фонтан', jail: 'Респаун (ожидание)', parking: 'Лагерь крипов', gotojail: 'Гибель', chance: 'Руна', chest: 'Курьер' }[type] || type;
}

// Описание клетки для карточки
function tileDescription(t) {
  switch (t.type) {
    case 'go':
      return '🌀 <b>Фонтан</b> — точка возрождения вашей команды. Каждый раз, проходя или попадая сюда, вы получаете <b>200🪙</b> золота за круг.';
    case 'jail':
      return '⏳ <b>Респаун.</b> Если вы здесь проездом — просто отдыхаете, ничего не теряете. Если вас сюда отправили после гибели — вы ждёте возрождения: бросьте дубль, заплатите <b>50🪙</b> за выкуп или используйте <b>свиток Aegis</b>, чтобы вернуться в бой.';
    case 'parking':
      return '🐉 <b>Лагерь крипов.</b> Нейтральная территория — фармите спокойно. Ничего не происходит, ход просто переходит дальше.';
    case 'gotojail':
      return '⚰️ <b>Вы убиты!</b> Немедленно отправляйтесь на Респаун. Золото за круг при этом не начисляется.';
    case 'chance':
      return '🔮 <b>Руна.</b> Возьмите карту руны — это случайное событие: золото, телепорт по карте, гибель, бонус First Blood или спасительный свиток Aegis.';
    case 'chest':
      return '📦 <b>Курьер.</b> Курьер доставил карту — может быть бонус или штраф: золото, продажа артефакта, выкуп, награда за серию убийств или потеря золота.';
    case 'street':
      return `🦸 <b>Герой роли «${GROUPS[t.group].name}».</b> Купите его, чтобы соперники платили вам за заход. Соберите всю роль (цветную группу) — аренда удвоится, и можно строить дома и отели, резко повышая плату.`;
    case 'rail':
      return '🗼 <b>Башня.</b> Купите, чтобы брать пошлину за заход. Чем больше башен в ваших руках, тем выше плата: <b>25 / 50 / 100 / 200🪙</b> за 1, 2, 3 и 4 башни.';
    case 'utility':
      return '🛒 <b>Магазин.</b> Пошлина зависит от броска кубиков: <b>×4</b> от суммы кубиков, а если у владельца оба магазина — <b>×10</b>.';
    case 'tax':
      return t.amount >= 200
        ? '💀 <b>Выкуп (Buyback).</b> Заплатите <b>200🪙</b> золота в банк, чтобы вернуться в строй.'
        : '💎 <b>Налог на артефакты.</b> Заплатите <b>100🪙</b> золота в банк за свои закупки.';
    default:
      return '';
  }
}

// ---------- Сделки ----------
function openTradeModal() {
  const me = STATE.players.find(p => p.id === YOU);
  const others = STATE.players.filter(p => p.id !== YOU && !p.bankrupt);
  if (others.length === 0) return;
  const modal = $('trade-modal');
  const c = $('trade-modal-content');

  const myProps = Object.keys(STATE.ownership).map(Number).filter(pos => STATE.ownership[pos].owner === YOU && STATE.ownership[pos].houses === 0);

  const targetOptions = others.map(p => `<option value="${p.id}">${p.token} ${p.name}</option>`).join('');

  c.innerHTML = `
    <div class="deed-head" style="background:#2a2f47"><div class="dh-name">🤝 Сделка</div></div>
    <div class="trade-grid">
      <div>
        <h4>Кому</h4>
        <select id="trade-target" style="width:100%;padding:10px;border-radius:8px;background:var(--bg2);color:var(--ink);border:1px solid var(--line)">${targetOptions}</select>
      </div>
      <div>
        <h4>Вы отдаёте</h4>
        <label>Деньги (🪙)</label>
        <input id="offer-money" type="number" min="0" value="0" max="${me.money}">
        <div class="trade-props" id="offer-props">${myProps.map(pos => propCheck('offer', pos)).join('') || '<span class="action-sub">нет активов без домов</span>'}</div>
      </div>
      <div>
        <h4>Вы получаете</h4>
        <label>Деньги (🪙)</label>
        <input id="req-money" type="number" min="0" value="0">
        <div class="trade-props" id="req-props"></div>
      </div>
      <div class="action-row">
        <button class="btn btn-primary" id="send-trade">Отправить предложение</button>
        <button class="btn" id="close-trade">Отмена</button>
      </div>
    </div>`;
  modal.classList.remove('hidden');

  const fillReq = () => {
    const tid = $('trade-target').value;
    const theirProps = Object.keys(STATE.ownership).map(Number).filter(pos => STATE.ownership[pos].owner === tid && STATE.ownership[pos].houses === 0);
    $('req-props').innerHTML = theirProps.map(pos => propCheck('req', pos)).join('') || '<span class="action-sub">нет активов без домов</span>';
  };
  fillReq();
  $('trade-target').onchange = fillReq;

  $('close-trade').onclick = () => modal.classList.add('hidden');
  modal.onclick = (e) => { if (e.target === modal) modal.classList.add('hidden'); };
  $('send-trade').onclick = () => {
    const to = $('trade-target').value;
    const offerProps = [...c.querySelectorAll('#offer-props input:checked')].map(i => Number(i.value));
    const reqProps = [...c.querySelectorAll('#req-props input:checked')].map(i => Number(i.value));
    act('proposeTrade', {
      to,
      offerMoney: Number($('offer-money').value) || 0,
      reqMoney: Number($('req-money').value) || 0,
      offerProps, reqProps,
    });
    modal.classList.add('hidden');
  };
}
function propCheck(side, pos) {
  const t = BOARD[pos];
  return `<label><input type="checkbox" value="${pos}">${propThumb(t)} ${t.name}</label>`;
}

// показать входящее предложение сделки
let tradeShownFor = null;
function renderTrade() {
  const tr = STATE.trade;
  const modal = $('trade-modal');
  if (tr && tr.to === YOU) {
    if (tradeShownFor === JSON.stringify(tr)) return;
    tradeShownFor = JSON.stringify(tr);
    const c = $('trade-modal-content');
    const give = describeTrade(tr.offerProps, tr.offerMoney);
    const get = describeTrade(tr.reqProps, tr.reqMoney);
    c.innerHTML = `
      <div class="deed-head" style="background:#2a2f47"><div class="dh-name">🤝 Предложение от ${tr.fromName}</div></div>
      <div class="trade-grid">
        <div><h4>Вам предлагают</h4><div class="action-sub">${give || 'ничего'}</div></div>
        <div><h4>Взамен просят</h4><div class="action-sub">${get || 'ничего'}</div></div>
        <div class="action-row">
          <button class="btn btn-primary" id="accept-trade">Принять</button>
          <button class="btn" id="decline-trade">Отклонить</button>
        </div>
      </div>`;
    modal.classList.remove('hidden');
    $('accept-trade').onclick = () => { act('respondTrade', { accept: true }); modal.classList.add('hidden'); };
    $('decline-trade').onclick = () => { act('respondTrade', { accept: false }); modal.classList.add('hidden'); };
  } else if (!tr) {
    tradeShownFor = null;
  }
}
function describeTrade(props, money) {
  const parts = [];
  if (money > 0) parts.push(`${money}🪙`);
  props.forEach(pos => parts.push(`${propThumb(BOARD[pos])} ${BOARD[pos].name}`));
  return parts.join(', ');
}
