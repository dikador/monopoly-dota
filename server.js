const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { BOARD, GROUPS, CHANCE, CHEST } = require('./board');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Статические данные доски для клиента
app.get('/board', (_req, res) => res.json({ BOARD, GROUPS, TOKENS: TOKEN_HEROES }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Монополия запущена на порту ${PORT}`));

// ---------- Утилиты ----------
const TOKENS = ['🚀', '🤖', '💻', '📱', '🎮', '🛰️', '🔋', '🧠'];
// Герои Dota 2 для выбора фишки игрока
const HERO_IMG = 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/';
const TOKEN_HEROES = [
  { key: 'pudge', name: 'Pudge', emoji: '🪝' },
  { key: 'invoker', name: 'Invoker', emoji: '🌟' },
  { key: 'antimage', name: 'Anti-Mage', emoji: '🗡️' },
  { key: 'juggernaut', name: 'Juggernaut', emoji: '⚔️' },
  { key: 'phantom_assassin', name: 'Phantom Assassin', emoji: '🥷' },
  { key: 'crystal_maiden', name: 'Crystal Maiden', emoji: '❄️' },
  { key: 'lina', name: 'Lina', emoji: '🔥' },
  { key: 'zuus', name: 'Zeus', emoji: '⚡' },
  { key: 'axe', name: 'Axe', emoji: '🪓' },
  { key: 'mars', name: 'Mars', emoji: '🪖' },
  { key: 'sniper', name: 'Sniper', emoji: '🎯' },
  { key: 'earthshaker', name: 'Earthshaker', emoji: '🔨' },
  { key: 'storm_spirit', name: 'Storm Spirit', emoji: '🌩️' },
  { key: 'drow_ranger', name: 'Drow Ranger', emoji: '🏹' },
  { key: 'lion', name: 'Lion', emoji: '🦁' },
  { key: 'sven', name: 'Sven', emoji: '🛡️' },
].map(h => ({ ...h, img: HERO_IMG + h.key + '.png' }));
const PLAYER_COLORS = ['#e63946', '#457b9d', '#2a9d4a', '#ff8c42', '#d65db1', '#ffd23f', '#6a4c93', '#1d3557'];
const START_MONEY = 1500;
const PRAISE_COOLDOWN = 20000; // 20 секунд между похвалами
const MORTGAGE_TURNS = 15; // через сколько ходов заложенная клетка освобождается
const GO_LANDING_BONUS = 100; // бонус за остановку ровно на СТАРТе

const rooms = {}; // code -> room

function makeCode() {
  let code;
  do {
    code = Math.random().toString(36).slice(2, 6).toUpperCase();
  } while (rooms[code]);
  return code;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function newRoom(code) {
  return {
    code,
    hostId: null,
    started: false,
    players: [],
    turnIndex: 0,
    dice: [0, 0],
    doublesCount: 0,
    phase: 'lobby', // lobby | roll | buy | pay | auction | end | over
    pendingPos: null,
    pendingPay: null,
    animFor: null,    // id игрока, чьё перемещение анимируется
    animPath: [],     // последовательность клеток для прохода фишки
    builtGroups: {},  // какие монополии уже улучшали в этом ходу
    pendingDebt: null,    // долг, который игрок должен погасить (продав имущество) или обанкротиться
    debtReturnPhase: null,// фаза, в которую вернуться после погашения долга
    turnCount: 0,         // счётчик ходов (для таймера залога)
    ownership: {}, // pos -> { owner, houses(0-5), mortgaged }
    chanceDeck: shuffle(CHANCE.map((_, i) => i)),
    chestDeck: shuffle(CHEST.map((_, i) => i)),
    log: [],
    auction: null,
    trade: null,
    winner: null,
  };
}

function getRoom(code) { return rooms[code]; }
function currentPlayer(room) { return room.players[room.turnIndex]; }
function playerById(room, id) { return room.players.find(p => p.id === id); }
function tile(pos) { return BOARD[pos]; }

function log(room, msg) {
  room.log.push(msg);
  if (room.log.length > 200) room.log.shift();
}

// Сколько объектов группы во владении игрока (включая заложенные)
function ownsGroupCount(room, ownerId, group) {
  const groupTiles = BOARD.filter(t => t.group === group);
  return groupTiles.filter(t => room.ownership[t.pos] && room.ownership[t.pos].owner === ownerId).length;
}
function ownsFullGroup(room, ownerId, group) {
  const groupTiles = BOARD.filter(t => t.group === group);
  return groupTiles.length > 0 && groupTiles.every(t => room.ownership[t.pos] && room.ownership[t.pos].owner === ownerId);
}
function ownedRails(room, ownerId) {
  return BOARD.filter(t => t.type === 'rail' && room.ownership[t.pos] && room.ownership[t.pos].owner === ownerId).length;
}
function ownedUtils(room, ownerId) {
  return BOARD.filter(t => t.type === 'utility' && room.ownership[t.pos] && room.ownership[t.pos].owner === ownerId).length;
}

function calcRent(room, pos, diceSum) {
  const t = tile(pos);
  const o = room.ownership[pos];
  if (!o || o.mortgaged) return 0;
  if (t.type === 'street') {
    if (o.houses > 0) return t.rent[o.houses];
    // без домов: x2 если монополия
    return ownsFullGroup(room, o.owner, t.group) ? t.rent[0] * 2 : t.rent[0];
  }
  if (t.type === 'rail') {
    const n = ownedRails(room, o.owner);
    return [0, 25, 50, 100, 200][n];
  }
  if (t.type === 'utility') {
    const n = ownedUtils(room, o.owner);
    return diceSum * (n === 2 ? 10 : 4);
  }
  return 0;
}

// Чистая стоимость игрока (для отображения)
function netWorth(room, p) {
  let w = p.money;
  for (const pos in room.ownership) {
    const o = room.ownership[pos];
    if (o.owner !== p.id) continue;
    const t = tile(Number(pos));
    if (o.mortgaged) w += Math.floor((t.price || 0) / 2);
    else w += t.price || 0;
    if (t.type === 'street') w += o.houses * Math.floor(t.house / 2);
  }
  return w;
}

// ---------- Передача состояния клиентам ----------
function publicState(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    started: room.started,
    phase: room.phase,
    turnIndex: room.turnIndex,
    currentPlayerId: room.players[room.turnIndex] ? room.players[room.turnIndex].id : null,
    dice: room.dice,
    doublesCount: room.doublesCount,
    pendingPos: room.pendingPos,
    pendingPay: room.pendingPay,
    animFor: room.animFor,
    animPath: room.animPath,
    builtGroups: room.builtGroups,
    pendingDebt: room.pendingDebt,
    turnCount: room.turnCount,
    mortgageTurns: MORTGAGE_TURNS,
    ownership: room.ownership,
    auction: room.auction,
    trade: room.trade,
    winner: room.winner,
    now: Date.now(),
    praiseCooldown: PRAISE_COOLDOWN,
    log: room.log.slice(-60),
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      token: p.token,
      avatar: p.avatar,
      tokenName: p.tokenName,
      tokenKey: p.tokenKey,
      color: p.color,
      money: p.money,
      pos: p.pos,
      inJail: p.inJail,
      jailTurns: p.jailTurns,
      getOutCards: p.getOutCards,
      bankrupt: p.bankrupt,
      connected: p.connected,
      netWorth: netWorth(room, p),
      praises: p.praises,
      lastPraiseAt: p.lastPraiseAt,
    })),
  };
}

function broadcast(room) {
  io.to(room.code).emit('state', publicState(room));
}

// ---------- Игровая логика ----------
function activePlayers(room) { return room.players.filter(p => !p.bankrupt); }

// Таймер залога идёт только в ходы владельца: в конце его хода −1, на нуле клетка освобождается
function tickMortgages(room, ownerId) {
  if (!ownerId) return;
  for (const pos in room.ownership) {
    const o = room.ownership[pos];
    if (!o.mortgaged || o.owner !== ownerId) continue;
    if (o.mortgageLeft == null) o.mortgageLeft = MORTGAGE_TURNS; // заложено до обновления
    o.mortgageLeft -= 1;
    if (o.mortgageLeft <= 0) {
      const t = tile(Number(pos));
      delete room.ownership[pos]; // снова свободна
      log(room, `⏳ Срок залога «${t.name}» истёк — клетка снова свободна.`);
    }
  }
}

function nextTurn(room) {
  room.doublesCount = 0;
  room.pendingPos = null;
  room.pendingPay = null;
  room.pendingDebt = null;
  room.debtReturnPhase = null;
  room.builtGroups = {}; // новый ход — снова можно улучшить каждую монополию по разу
  room.turnCount = (room.turnCount || 0) + 1;
  const ending = currentPlayer(room); // игрок, чей ход закончился
  // таймер залога идёт только если в ходе владельца не выпадал дубль
  if (!room.turnHadDouble) tickMortgages(room, ending && !ending.bankrupt ? ending.id : null);
  room.turnHadDouble = false;
  if (checkWin(room)) return;
  let i = room.turnIndex;
  for (let k = 0; k < room.players.length; k++) {
    i = (i + 1) % room.players.length;
    if (!room.players[i].bankrupt) break;
  }
  room.turnIndex = i;
  const p = currentPlayer(room);
  room.phase = 'roll';
  log(room, `▶️ Ход игрока ${p.token} ${p.name}.`);
}

// Автозавершение хода: при дубле — повторный бросок, иначе передаём ход
function autoEndTurn(room) {
  const p = currentPlayer(room);
  if (p && canRollAgain(room, p)) room.phase = 'roll';
  else nextTurn(room);
}

function checkWin(room) {
  const alive = activePlayers(room);
  if (room.started && alive.length === 1) {
    room.winner = alive[0].id;
    room.phase = 'over';
    log(room, `🏆 ${alive[0].token} ${alive[0].name} побеждает! Все соперники разорены.`);
    return true;
  }
  return false;
}

function sendToJail(room, p, reason) {
  p.pos = 10;
  p.inJail = true;
  p.jailTurns = 0;
  room.doublesCount = 0;
  if (room.animFor === p.id) room.animPath.push(10);
  log(room, `💀 ${p.name} погибает и отправляется на респаун.`);
  // звук + окно смерти у всех (покажутся, когда фишка дойдёт)
  io.to(room.code).emit('notify', { type: 'death', byId: p.id, byName: p.name, reason: reason || '' });
}

// Изменить деньги; если уходит в минус — вернёт false (нужно решать про банкротство)
function pay(room, p, amount, toPlayer) {
  // amount > 0 — получение, amount < 0 — списание
  if (amount >= 0) {
    p.money += amount;
    return true;
  }
  const owe = -amount;
  if (p.money >= owe) {
    p.money -= owe;
    if (toPlayer) toPlayer.money += owe;
    return true;
  }
  return false; // не хватает денег
}

function landOn(room, p, diceSum) {
  const t = tile(p.pos);
  room.phase = 'end'; // по умолчанию после обработки — конец действий
  if (t.type === 'street' || t.type === 'rail' || t.type === 'utility') {
    const o = room.ownership[p.pos];
    if (!o) {
      // свободно — предложить покупку
      room.pendingPos = p.pos;
      room.phase = 'buy';
      log(room, `${p.token} ${p.name} на «${t.name}». Можно купить за ${t.price}🪙.`);
    } else if (o.owner === p.id) {
      log(room, `${p.token} ${p.name} на своей «${t.name}».`);
    } else if (o.mortgaged) {
      log(room, `${p.token} ${p.name} на «${t.name}» (заложено) — аренды нет.`);
    } else {
      const owner = playerById(room, o.owner);
      const rent = calcRent(room, p.pos, diceSum);
      setPendingPay(room, p, owner, rent, t);
    }
  } else if (t.type === 'tax') {
    if (p.pos === 4) io.to(room.code).emit('notify', { type: 'buyback' }); // звук выкупа
    // налог — тоже через подтверждение оплаты (можно сначала поторговаться)
    room.pendingPay = { amount: t.amount, toId: null, toName: 'банку', toToken: '🏦', pos: t.pos, tileName: t.name };
    room.phase = 'pay';
    log(room, `${p.token} ${p.name} должен заплатить «${t.name}» ${t.amount}🪙.`);
  } else if (t.type === 'gotojail') {
    sendToJail(room, p, 'Вы попали на клетку «Вы убиты!».');
  } else if (t.type === 'chance') {
    io.to(room.code).emit('notify', { type: 'rune' }); // звук руны
    drawCard(room, p, 'chance', diceSum);
  } else if (t.type === 'chest') {
    drawCard(room, p, 'chest', diceSum);
  } else {
    // go / jail(visiting) / parking
    if (t.type === 'parking') log(room, `${p.token} ${p.name} отдыхает на парковке.`);
    if (t.type === 'go') {
      // бонус именно за остановку на СТАРТе (сверх 200 за круг)
      p.money += GO_LANDING_BONUS;
      log(room, `🌀 ${p.name} остановился на Фонтане: бонус +${GO_LANDING_BONUS}🪙.`);
    }
  }
}

// Поставить аренду на подтверждение игроком (фаза 'pay')
function setPendingPay(room, p, owner, rent, t) {
  room.pendingPay = {
    amount: rent,
    toId: owner.id, toName: owner.name, toToken: owner.token,
    pos: t.pos, tileName: t.name,
  };
  room.phase = 'pay';
  log(room, `${p.token} ${p.name} должен аренду ${rent}🪙 игроку ${owner.token} ${owner.name} за «${t.name}» — ждём оплату.`);
}

function passGoIfNeeded(room, p, oldPos) {
  if (p.pos < oldPos) {
    p.money += 200;
    log(room, `💰 ${p.name} проходит СТАРТ: +200🪙.`);
  }
}

function moveTo(room, p, pos, awardGo = true) {
  const old = p.pos;
  p.pos = pos;
  if (awardGo && pos < old) {
    p.money += 200;
    log(room, `💰 ${p.name} проходит СТАРТ: +200🪙.`);
  }
  if (room.animFor === p.id) room.animPath.push(pos);
}

function drawCard(room, p, kind, diceSum) {
  const deck = kind === 'chance' ? room.chanceDeck : room.chestDeck;
  const list = kind === 'chance' ? CHANCE : CHEST;
  if (deck.length === 0) {
    const fresh = shuffle(list.map((_, i) => i));
    deck.push(...fresh);
  }
  const idx = deck.shift();
  const card = list[idx];
  log(room, `${kind === 'chance' ? '🔮 Руна' : '📦 Курьер'}: ${card.text}`);
  io.to(room.code).emit('notify', { type: 'card', kind, text: card.text, byId: p.id, byName: p.name });
  applyCard(room, p, card, diceSum, deck, idx);
}

function applyCard(room, p, card, diceSum, deck, idx) {
  switch (card.action) {
    case 'money':
      if (card.amount >= 0) p.money += card.amount;
      else charge(room, p, -card.amount, null, 'end');
      break;
    case 'moveTo': {
      moveTo(room, p, card.pos, true);
      landOn(room, p, diceSum);
      return;
    }
    case 'moveBy': {
      let np = (p.pos + card.steps + 40) % 40;
      p.pos = np; // назад без бонуса СТАРТ
      if (room.animFor === p.id) room.animPath.push(np);
      landOn(room, p, diceSum);
      return;
    }
    case 'gotojail':
      sendToJail(room, p, card.text);
      break;
    case 'getout':
      p.getOutCards += 1;
      break;
    case 'repairs': {
      let houses = 0, hotels = 0;
      for (const pos in room.ownership) {
        const o = room.ownership[pos];
        if (o.owner === p.id) {
          if (o.houses === 5) hotels++;
          else houses += o.houses;
        }
      }
      const cost = houses * card.perHouse + hotels * card.perHotel;
      if (cost > 0) {
        log(room, `Ремонт: ${houses} дом./${hotels} отел. = ${cost}🪙.`);
        charge(room, p, cost, null, 'end');
      }
      break;
    }
    case 'collectEach': {
      let total = 0;
      for (const other of activePlayers(room)) {
        if (other.id === p.id) continue;
        const give = Math.min(card.amount, other.money); // платят сколько есть
        other.money -= give;
        total += give;
      }
      p.money += total;
      break;
    }
    case 'nearestRail': {
      const rails = [5, 15, 25, 35];
      let target = rails.find(r => r > p.pos);
      if (target === undefined) target = rails[0];
      moveTo(room, p, target, true);
      const o = room.ownership[target];
      const t = tile(target);
      if (!o) {
        room.pendingPos = target;
        room.phase = 'buy';
      } else if (o.owner === p.id || o.mortgaged) {
        // ничего
      } else {
        const owner = playerById(room, o.owner);
        const rent = calcRent(room, target, diceSum) * 2; // двойная аренда
        setPendingPay(room, p, owner, rent, t);
      }
      return;
    }
  }
}

// ---------- Оплата / долг / банкротство ----------
// Списать сумму; если не хватает — перевести игрока в режим долга (он сам продаёт/закладывает).
function charge(room, p, amount, creditorId, returnPhase) {
  const creditor = creditorId ? playerById(room, creditorId) : null;
  if (p.money >= amount) {
    p.money -= amount;
    if (creditor) creditor.money += amount;
    return true;
  }
  room.pendingDebt = { amount, toId: creditorId || null };
  room.debtReturnPhase = returnPhase || 'end';
  room.phase = 'debt';
  log(room, `⚠️ ${p.token} ${p.name}: не хватает ${amount}🪙. Продайте дома/заложите имущество или объявите банкротство.`);
  return false;
}

// Банкротство: все активы освобождаются (в банк). Ничего не переходит другому игроку.
function declareBankrupt(room, debtor, creditorId) {
  // все клетки игрока снова свободны (дома/залог сбрасываются)
  for (const pos in room.ownership) {
    if (room.ownership[pos].owner === debtor.id) delete room.ownership[pos];
  }
  debtor.money = 0;
  debtor.getOutCards = 0;
  debtor.bankrupt = true;
  log(room, `💥 ${debtor.name} банкрот! Его клетки снова свободны.`);
}

// ---------- Действия игроков ----------
function doRoll(room, p) {
  room.animFor = p.id;   // фишка этого игрока пойдёт по пути
  room.animPath = [];
  const d1 = 1 + Math.floor(Math.random() * 6);
  const d2 = 1 + Math.floor(Math.random() * 6);
  room.dice = [d1, d2];
  const sum = d1 + d2;
  const isDouble = d1 === d2;
  if (isDouble) room.turnHadDouble = true; // в этот ход был дубль — таймер залога не тикает

  if (p.inJail) {
    if (isDouble) {
      p.inJail = false;
      p.jailTurns = 0;
      log(room, `${p.name} выбросил дубль ${d1}-${d2} и возрождается!`);
      moveTo(room, p, (p.pos + sum) % 40, true);
      landOn(room, p, sum);
      room.doublesCount = 0; // из тюрьмы дубль не даёт повторный ход
      return;
    } else {
      p.jailTurns += 1;
      log(room, `${p.name} на респауне, бросок ${d1}-${d2} — не дубль.`);
      if (p.jailTurns >= 3) {
        log(room, `${p.name} ждал 3 хода — нужно заплатить 50🪙 за выкуп.`);
        const paid = charge(room, p, 50, null, 'end');
        p.inJail = false;
        p.jailTurns = 0;
        if (paid) {
          moveTo(room, p, (p.pos + sum) % 40, true);
          landOn(room, p, sum);
        }
        // если не хватило — режим долга, ход завершится после оплаты/банкротства
      } else {
        room.phase = 'end';
      }
      return;
    }
  }

  if (isDouble) {
    room.doublesCount += 1;
    if (room.doublesCount >= 3) {
      log(room, `${p.name} выбросил третий дубль подряд — в тюрьму!`);
      sendToJail(room, p, 'Третий дубль подряд.');
      room.phase = 'end';
      return;
    }
    // дубль = новый ход: снова можно улучшить каждую монополию перед следующим броском
    room.builtGroups = {};
  }
  log(room, `🎲 ${p.name} бросает ${d1} и ${d2} = ${sum}${isDouble ? ' (дубль!)' : ''}.`);
  moveTo(room, p, (p.pos + sum) % 40, true);
  landOn(room, p, sum);
}

function canRollAgain(room, p) {
  // повторный бросок при дубле, если не попал в тюрьму и фаза не buy/auction
  return room.dice[0] === room.dice[1] && room.doublesCount > 0 && room.doublesCount < 3 && !p.inJail;
}

// ---------- Сокеты ----------
io.on('connection', (socket) => {
  let joinedCode = null;

  socket.on('createRoom', ({ name, clientId }, cb) => {
    const code = makeCode();
    const room = newRoom(code);
    rooms[code] = room;
    const player = addPlayer(room, socket.id, name, clientId);
    room.hostId = socket.id;
    socket.join(code);
    joinedCode = code;
    cb && cb({ ok: true, code, you: socket.id });
    log(room, `🎮 ${player.name} создал комнату ${code}.`);
    broadcast(room);
  });

  socket.on('joinRoom', ({ name, code, clientId }, cb) => {
    code = (code || '').toUpperCase().trim();
    const room = getRoom(code);
    if (!room) return cb && cb({ ok: false, error: 'Комната не найдена.' });

    // 1) восстановление сессии по постоянному clientId (работает и в лобби, и в игре)
    const byClient = clientId && room.players.find(p => p.clientId === clientId);
    if (byClient) {
      const oldId = byClient.id;
      byClient.id = socket.id;
      byClient.connected = true;
      reassignId(room, oldId, socket.id);
      socket.join(code);
      joinedCode = code;
      cb && cb({ ok: true, code, you: socket.id });
      log(room, `🔌 ${byClient.name} вернулся в игру.`);
      broadcast(room);
      return;
    }

    if (room.started) {
      // запасное переподключение по имени
      const existing = room.players.find(p => p.name === name && !p.connected);
      if (existing) {
        const oldId = existing.id;
        existing.id = socket.id;
        existing.connected = true;
        if (clientId) existing.clientId = clientId;
        reassignId(room, oldId, socket.id);
        socket.join(code);
        joinedCode = code;
        cb && cb({ ok: true, code, you: socket.id });
        log(room, `🔌 ${name} переподключился.`);
        broadcast(room);
        return;
      }
      return cb && cb({ ok: false, error: 'Игра уже началась.' });
    }
    if (room.players.length >= 8) return cb && cb({ ok: false, error: 'Комната заполнена (макс. 8).' });
    if (room.players.some(p => p.name === name)) return cb && cb({ ok: false, error: 'Имя занято.' });
    const player = addPlayer(room, socket.id, name, clientId);
    socket.join(code);
    joinedCode = code;
    cb && cb({ ok: true, code, you: socket.id });
    log(room, `👋 ${player.name} присоединился.`);
    broadcast(room);
  });

  socket.on('chooseToken', ({ key }) => {
    const room = getRoom(joinedCode);
    if (!room || room.started) return;
    const p = playerById(room, socket.id);
    if (!p) return;
    const hero = TOKEN_HEROES.find(h => h.key === key);
    if (!hero) return;
    if (room.players.some(x => x.id !== p.id && x.tokenKey === key)) return; // занят
    p.tokenKey = hero.key;
    p.token = hero.emoji;
    p.tokenName = hero.name;
    p.avatar = hero.img;
    log(room, `${p.name} выбирает героя ${hero.name}.`);
    broadcast(room);
  });

  socket.on('startGame', () => {
    const room = getRoom(joinedCode);
    if (!room || room.hostId !== socket.id || room.started) return;
    if (room.players.length < 2) return;
    room.players = shuffle(room.players);
    room.started = true;
    room.turnIndex = 0;
    room.phase = 'roll';
    log(room, `🚦 Игра началась! Первым ходит ${currentPlayer(room).name}.`);
    broadcast(room);
  });

  socket.on('action', (msg) => {
    const room = getRoom(joinedCode);
    if (!room || !room.started) return;
    handleAction(room, socket.id, msg);
    if (room.phase === 'end') autoEndTurn(room); // ход завершается автоматически
    broadcast(room);
  });

  socket.on('chat', (text) => {
    const room = getRoom(joinedCode);
    if (!room) return;
    const p = playerById(room, socket.id);
    if (!p || !text) return;
    log(room, `💬 ${p.name}: ${String(text).slice(0, 200)}`);
    broadcast(room);
  });

  socket.on('leaveRoom', () => {
    const room = getRoom(joinedCode);
    if (!room) return;
    const p = playerById(room, socket.id);
    if (!p) { joinedCode = null; return; }
    if (room.started && !p.bankrupt) {
      const wasCurrent = currentPlayer(room) && currentPlayer(room).id === p.id;
      log(room, `🚪 ${p.name} вышел из игры.`);
      declareBankrupt(room, p, null); // активы возвращаются в банк
      if (room.phase !== 'over' && wasCurrent) {
        room.phase = 'end';
        nextTurn(room);
      }
    } else {
      // лобби: просто убрать игрока
      room.players = room.players.filter(x => x.id !== socket.id);
      if (room.hostId === socket.id && room.players.length) room.hostId = room.players[0].id;
      if (room.players.length === 0) { delete rooms[room.code]; joinedCode = null; return; }
    }
    socket.leave(room.code);
    joinedCode = null;
    broadcast(room);
  });

  socket.on('disconnect', () => {
    const room = getRoom(joinedCode);
    if (!room) return;
    const p = playerById(room, socket.id);
    if (!p) return;
    p.connected = false;
    log(room, `📴 ${p.name} отключился.`);
    if (!room.started) {
      // отсрочка: даём время на переподключение (перезагрузка страницы),
      // комната и место в лобби не пропадают сразу
      const cid = p.clientId;
      const leftId = p.id;
      setTimeout(() => {
        const r = getRoom(room.code);
        if (!r) return;
        const still = r.players.find(x => (cid ? x.clientId === cid : x.id === leftId));
        if (!still || still.connected) return; // вернулся — ничего не делаем
        r.players = r.players.filter(x => x !== still);
        if (r.hostId === still.id && r.players.length) r.hostId = r.players[0].id;
        if (r.players.length === 0) { delete rooms[r.code]; return; }
        broadcast(r);
      }, 45000);
    }
    broadcast(room);
  });
});

// Перенести все ссылки со старого socket id на новый (после переподключения)
function reassignId(room, oldId, newId) {
  if (oldId === newId) return;
  for (const pos in room.ownership) {
    if (room.ownership[pos].owner === oldId) room.ownership[pos].owner = newId;
  }
  if (room.hostId === oldId) room.hostId = newId;
  if (room.auction) {
    if (room.auction.highBidder === oldId) room.auction.highBidder = newId;
    room.auction.active = room.auction.active.map(id => (id === oldId ? newId : id));
  }
  if (room.trade) {
    if (room.trade.from === oldId) room.trade.from = newId;
    if (room.trade.to === oldId) room.trade.to = newId;
  }
}

function addPlayer(room, id, name, clientId) {
  const idx = room.players.length;
  // выбрать первого свободного героя как фишку по умолчанию
  const taken = new Set(room.players.map(p => p.tokenKey));
  const hero = TOKEN_HEROES.find(h => !taken.has(h.key)) || TOKEN_HEROES[idx % TOKEN_HEROES.length];
  const player = {
    id,
    clientId: clientId || null,
    name: (name || `Игрок ${idx + 1}`).slice(0, 16),
    token: hero.emoji,
    tokenKey: hero.key,
    tokenName: hero.name,
    avatar: hero.img,
    color: PLAYER_COLORS[idx % PLAYER_COLORS.length],
    money: START_MONEY,
    pos: 0,
    inJail: false,
    jailTurns: 0,
    getOutCards: 0,
    bankrupt: false,
    connected: true,
    praises: 0,         // получено похвал
    lastPraiseAt: 0,    // когда игрок в последний раз кого-то похвалил
  };
  room.players.push(player);
  return player;
}

function handleAction(room, sid, msg) {
  const p = playerById(room, sid);
  if (!p || p.bankrupt) return;
  const cur = currentPlayer(room);
  const isCurrent = cur && cur.id === sid;
  const type = msg.type;

  // Похвала доступна в любой момент любому игроку (с кулдауном)
  if (type === 'praise') {
    const target = playerById(room, msg.to);
    if (!target || target.id === p.id || target.bankrupt) return;
    const now = Date.now();
    if (now - p.lastPraiseAt < PRAISE_COOLDOWN) return; // кулдаун ещё не прошёл
    p.lastPraiseAt = now;
    target.praises += 1;
    log(room, `👍 ${p.token} ${p.name} похвалил ${target.token} ${target.name}! (всего похвал: ${target.praises})`);
    io.to(room.code).emit('notify', {
      type: 'praise',
      fromName: p.name, fromToken: p.token,
      toName: target.name, toToken: target.token,
      toId: target.id,
      praises: target.praises,
    });
    return;
  }

  // Действия с недвижимостью разрешены в свой ход в фазах roll/end
  switch (type) {
    case 'roll':
      if (!isCurrent || room.phase !== 'roll') return;
      doRoll(room, p);
      return;

    case 'buy':
      if (!isCurrent || room.phase !== 'buy') return;
      buyPending(room, p);
      room.phase = canRollAgain(room, p) ? 'roll' : 'end';
      return;

    case 'declineBuy':
      if (!isCurrent || room.phase !== 'buy') return;
      startAuction(room, room.pendingPos);
      return;

    case 'payRent': {
      if (!isCurrent || room.phase !== 'pay' || !room.pendingPay) return;
      const pp = room.pendingPay;
      room.pendingPay = null;
      const back = canRollAgain(room, p) ? 'roll' : 'end';
      if (charge(room, p, pp.amount, pp.toId || null, back)) {
        const owner = pp.toId ? playerById(room, pp.toId) : null;
        if (owner) log(room, `${p.token} ${p.name} платит аренду ${pp.amount}🪙 игроку ${owner.name} за «${pp.tileName}».`);
        else log(room, `${p.token} ${p.name} платит «${pp.tileName}» ${pp.amount}🪙.`);
        room.phase = back;
      }
      // если не хватило — charge перевёл в режим долга
      return;
    }

    case 'payDebt': {
      if (!isCurrent || room.phase !== 'debt' || !room.pendingDebt) return;
      const d = room.pendingDebt;
      if (p.money < d.amount) return; // ещё не хватает — продайте/заложите
      const creditor = d.toId ? playerById(room, d.toId) : null;
      p.money -= d.amount;
      if (creditor) creditor.money += d.amount;
      log(room, `${p.token} ${p.name} платит ${d.amount}🪙${creditor ? ' игроку ' + creditor.name : ''}.`);
      room.pendingDebt = null;
      room.phase = room.debtReturnPhase || 'end';
      room.debtReturnPhase = null;
      return;
    }

    case 'auctionBid':
      if (room.phase !== 'auction' || !room.auction) return;
      auctionBid(room, p, msg.amount);
      return;

    case 'auctionPass':
      if (room.phase !== 'auction' || !room.auction) return;
      auctionPass(room, p);
      return;

    case 'build':
      if (!isCurrent || (room.phase !== 'end' && room.phase !== 'roll')) return;
      buildHouse(room, p, msg.pos);
      return;

    case 'sellHouse':
      sellHouse(room, p, msg.pos);
      return;

    case 'mortgage':
      mortgage(room, p, msg.pos);
      return;

    case 'unmortgage':
      unmortgage(room, p, msg.pos);
      return;

    case 'payJail':
      if (!isCurrent || room.phase !== 'roll' || !p.inJail) return;
      if (pay(room, p, -50)) {
        p.inJail = false; p.jailTurns = 0;
        log(room, `${p.name} платит 50🪙 за выкуп и возрождается. Теперь можно бросать кубики.`);
      }
      return;

    case 'useJailCard':
      if (!isCurrent || room.phase !== 'roll' || !p.inJail || p.getOutCards < 1) return;
      p.getOutCards -= 1;
      p.inJail = false; p.jailTurns = 0;
      log(room, `${p.name} использует свиток Aegis и мгновенно возрождается.`);
      return;

    case 'endTurn':
      if (!isCurrent) return;
      if (room.phase !== 'end') return;
      nextTurn(room);
      return;

    case 'declareBankruptcy': {
      if (!isCurrent) return;
      const creditorId = (room.phase === 'debt' && room.pendingDebt) ? room.pendingDebt.toId : null;
      declareBankrupt(room, p, creditorId);
      room.pendingDebt = null; room.debtReturnPhase = null; room.pendingPay = null;
      if (room.phase !== 'over') nextTurn(room);
      return;
    }

    case 'proposeTrade':
      proposeTrade(room, p, msg);
      return;
    case 'respondTrade':
      respondTrade(room, p, msg.accept);
      return;
    case 'cancelTrade':
      if (room.trade && (room.trade.from === sid || room.trade.to === sid)) {
        log(room, `Сделка отменена.`);
        room.trade = null;
      }
      return;
  }
}

function buyPending(room, p) {
  const pos = room.pendingPos;
  if (pos == null) return;
  const t = tile(pos);
  if (room.ownership[pos]) return;
  if (p.money < t.price) { log(room, `${p.name}: недостаточно денег для покупки.`); return; }
  p.money -= t.price;
  room.ownership[pos] = { owner: p.id, houses: 0, mortgaged: false };
  log(room, `🏷️ ${p.name} покупает «${t.name}» за ${t.price}🪙.`);
  room.pendingPos = null;
}

// ---------- Аукцион ----------
function startAuction(room, pos) {
  const bidders = activePlayers(room).map(p => p.id);
  if (bidders.length === 0) { room.phase = 'end'; return; }
  room.auction = {
    pos,
    name: tile(pos).name,
    minBid: tile(pos).price || 0, // стартовая ставка = цена клетки
    highBid: 0,
    highBidder: null,
    active: bidders,
    turn: room.turnIndex, // индекс в room.players
  };
  room.phase = 'auction';
  advanceAuctionTurn(room, true);
  log(room, `🔨 Аукцион за «${tile(pos).name}». Стартовая ставка ${room.auction.minBid}🪙.`);
}

function advanceAuctionTurn(room, first = false) {
  const a = room.auction;
  if (!a) return;
  if (a.active.length === 1) { finishAuction(room); return; }
  let guard = 0;
  do {
    if (!first) a.turn = (a.turn + 1) % room.players.length;
    first = false;
    guard++;
    if (guard > 50) break;
  } while (!a.active.includes(room.players[a.turn].id));
}

function auctionBid(room, p, amount) {
  const a = room.auction;
  if (!a || !a.active.includes(p.id)) return;
  if (room.players[a.turn].id !== p.id) return; // не его очередь
  amount = Math.floor(Number(amount) || 0);
  if (a.highBidder ? amount <= a.highBid : amount < (a.minBid || 0)) return; // первая ставка ≥ цены, дальше — выше текущей
  if (amount > p.money) return;
  a.highBid = amount;
  a.highBidder = p.id;
  log(room, `🔨 ${p.name} ставит ${amount}🪙 за «${a.name}».`);
  advanceAuctionTurn(room);
}

function auctionPass(room, p) {
  const a = room.auction;
  if (!a || !a.active.includes(p.id)) return;
  if (room.players[a.turn].id !== p.id) return;
  a.active = a.active.filter(id => id !== p.id);
  log(room, `🔨 ${p.name} пасует.`);
  if (a.active.length <= 1) { finishAuction(room); return; }
  // если текущий выбыл — turn уже указывает дальше
  if (!a.active.includes(room.players[a.turn].id)) advanceAuctionTurn(room, true);
  else advanceAuctionTurn(room);
}

function finishAuction(room) {
  const a = room.auction;
  if (!a) return;
  const cur = currentPlayer(room);
  if (a.highBidder) {
    const w = playerById(room, a.highBidder);
    w.money -= a.highBid;
    room.ownership[a.pos] = { owner: w.id, houses: 0, mortgaged: false };
    log(room, `🔨 «${a.name}» уходит к ${w.name} за ${a.highBid}🪙.`);
  } else {
    log(room, `🔨 За «${a.name}» никто не дал ставку — остаётся свободной.`);
  }
  room.auction = null;
  room.pendingPos = null;
  room.phase = canRollAgain(room, cur) ? 'roll' : 'end';
}

// ---------- Строительство и залог ----------
function buildHouse(room, p, pos) {
  const t = tile(pos);
  const o = room.ownership[pos];
  if (!o || o.owner !== p.id || t.type !== 'street') return;
  if (!ownsFullGroup(room, p.id, t.group)) { log(room, 'Нужна вся группа для застройки.'); return; }
  // нет заложенных в группе
  const groupTiles = BOARD.filter(x => x.group === t.group);
  if (groupTiles.some(x => room.ownership[x.pos].mortgaged)) { log(room, 'В группе есть заложенный объект.'); return; }
  if (o.houses >= 5) { log(room, 'Уже отель.'); return; }
  // одну монополию можно улучшать только раз за ход
  if (room.builtGroups[t.group]) { log(room, 'Эту монополию уже улучшали в этом ходу.'); return; }
  // равномерная застройка
  const minHouses = Math.min(...groupTiles.map(x => room.ownership[x.pos].houses));
  if (o.houses > minHouses) { log(room, 'Стройте равномерно по группе.'); return; }
  if (p.money < t.house) { log(room, 'Недостаточно денег.'); return; }
  p.money -= t.house;
  o.houses += 1;
  room.builtGroups[t.group] = true; // эта монополия улучшена в этом ходу
  log(room, `🏠 ${p.name} строит ${o.houses === 5 ? 'отель' : 'дом'} на «${t.name}».`);
}

function sellHouse(room, p, pos) {
  const t = tile(pos);
  const o = room.ownership[pos];
  if (!o || o.owner !== p.id || t.type !== 'street' || o.houses < 1) return;
  const groupTiles = BOARD.filter(x => x.group === t.group);
  const maxHouses = Math.max(...groupTiles.map(x => room.ownership[x.pos].houses));
  if (o.houses < maxHouses) { log(room, 'Продавайте равномерно.'); return; }
  o.houses -= 1;
  p.money += Math.floor(t.house / 2);
  log(room, `🏚️ ${p.name} продаёт строение на «${t.name}» за ${Math.floor(t.house / 2)}🪙.`);
}

function mortgage(room, p, pos) {
  const t = tile(pos);
  const o = room.ownership[pos];
  if (!o || o.owner !== p.id || o.mortgaged) return;
  if (t.type === 'street' && o.houses > 0) { log(room, 'Сначала продайте дома.'); return; }
  // в группе не должно быть домов
  if (t.type === 'street') {
    const groupTiles = BOARD.filter(x => x.group === t.group);
    if (groupTiles.some(x => room.ownership[x.pos] && room.ownership[x.pos].houses > 0)) {
      log(room, 'В группе есть постройки — продайте их.'); return;
    }
  }
  o.mortgaged = true;
  o.mortgageLeft = MORTGAGE_TURNS; // считается только в ходы владельца
  p.money += Math.floor(t.price / 2);
  log(room, `🏦 ${p.name} закладывает «${t.name}» за ${Math.floor(t.price / 2)}🪙 (выкупить в течение ${MORTGAGE_TURNS} своих ходов).`);
}

function unmortgage(room, p, pos) {
  const t = tile(pos);
  const o = room.ownership[pos];
  if (!o || o.owner !== p.id || !o.mortgaged) return;
  const cost = Math.ceil((t.price / 2) * 1.1);
  if (p.money < cost) { log(room, 'Недостаточно денег для выкупа.'); return; }
  p.money -= cost;
  o.mortgaged = false;
  delete o.mortgageLeft;
  delete o.mortgagedTurn;
  log(room, `🏦 ${p.name} выкупает «${t.name}» за ${cost}🪙.`);
}

// ---------- Сделки ----------
function proposeTrade(room, p, msg) {
  const to = playerById(room, msg.to);
  if (!to || to.bankrupt || to.id === p.id) return;
  // валидация владения
  const offer = (msg.offerProps || []).filter(pos => room.ownership[pos] && room.ownership[pos].owner === p.id && room.ownership[pos].houses === 0);
  const request = (msg.reqProps || []).filter(pos => room.ownership[pos] && room.ownership[pos].owner === to.id && room.ownership[pos].houses === 0);
  room.trade = {
    from: p.id, fromName: p.name,
    to: to.id, toName: to.name,
    offerMoney: Math.max(0, Math.floor(msg.offerMoney || 0)),
    reqMoney: Math.max(0, Math.floor(msg.reqMoney || 0)),
    offerProps: offer,
    reqProps: request,
  };
  log(room, `🤝 ${p.name} предлагает сделку игроку ${to.name}.`);
}

function respondTrade(room, p, accept) {
  const tr = room.trade;
  if (!tr || tr.to !== p.id) return;
  if (!accept) { log(room, `🤝 ${p.name} отклонил сделку.`); room.trade = null; return; }
  const from = playerById(room, tr.from);
  const to = playerById(room, tr.to);
  if (!from || !to) { room.trade = null; return; }
  if (from.money < tr.offerMoney || to.money < tr.reqMoney) { log(room, 'Недостаточно средств для сделки.'); room.trade = null; return; }
  // проверка владения ещё раз
  const okOffer = tr.offerProps.every(pos => room.ownership[pos] && room.ownership[pos].owner === from.id);
  const okReq = tr.reqProps.every(pos => room.ownership[pos] && room.ownership[pos].owner === to.id);
  if (!okOffer || !okReq) { room.trade = null; return; }
  from.money -= tr.offerMoney; to.money += tr.offerMoney;
  to.money -= tr.reqMoney; from.money += tr.reqMoney;
  tr.offerProps.forEach(pos => room.ownership[pos].owner = to.id);
  tr.reqProps.forEach(pos => room.ownership[pos].owner = from.id);
  log(room, `🤝 Сделка между ${from.name} и ${to.name} состоялась!`);
  room.trade = null;
}
