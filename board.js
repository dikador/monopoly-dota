// Игровое поле «Монополия: Dota 2».
// Цены и аренда — по классическим правилам Monopoly, тематика — Dota 2.
// Картинки — официальный Steam CDN Dota 2 (портреты героев и иконки предметов).

const HBASE = 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/';
const IBASE = 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/';

const GROUPS = {
  brown:     { name: 'Саппорты',    color: '#7c4a2d' },
  lightblue: { name: 'Нюкеры',      color: '#a9d6e5' },
  pink:      { name: 'Инициаторы',  color: '#d65db1' },
  orange:    { name: 'Стрелки',     color: '#ff8c42' },
  red:       { name: 'Силачи',      color: '#e63946' },
  yellow:    { name: 'Убийцы',      color: '#ffd23f' },
  green:     { name: 'Мидеры',      color: '#2a9d4a' },
  darkblue:  { name: 'Легенды',     color: '#1d3557' },
};

// Тип клеток: go, street, rail, utility, tax, chance, chest, jail, parking, gotojail
const BOARD = [
  { pos: 0,  type: 'go',     name: 'Фонтан', icon: '🌀', img: IBASE + 'tpscroll.png' },
  { pos: 1,  type: 'street', name: 'Crystal Maiden',  icon: '❄️', img: HBASE + 'crystal_maiden.png',  group: 'brown',     price: 60,  rent: [2,10,30,90,160,250],       house: 50 },
  { pos: 2,  type: 'chest',  name: 'Курьер',          icon: '📦', img: IBASE + 'courier.png' },
  { pos: 3,  type: 'street', name: 'Witch Doctor',    icon: '🧙', img: HBASE + 'witch_doctor.png',     group: 'brown',     price: 60,  rent: [4,20,60,180,320,450],      house: 50 },
  { pos: 4,  type: 'tax',    name: 'Выкуп (Buyback)', icon: '💀', img: '/buyback.png', amount: 200 },
  { pos: 5,  type: 'rail',   name: 'Башня (верх)',    icon: '🗼', img: '/tower_radiant.png', price: 200 },
  { pos: 6,  type: 'street', name: 'Lion',            icon: '🦁', img: HBASE + 'lion.png',             group: 'lightblue', price: 100, rent: [6,30,90,270,400,550],      house: 50 },
  { pos: 7,  type: 'chance', name: 'Руна',            icon: '🔮', img: IBASE + 'bottle.png' },
  { pos: 8,  type: 'street', name: 'Lina',            icon: '🔥', img: HBASE + 'lina.png',             group: 'lightblue', price: 100, rent: [6,30,90,270,400,550],      house: 50 },
  { pos: 9,  type: 'street', name: 'Zeus',            icon: '⚡', img: HBASE + 'zuus.png',             group: 'lightblue', price: 120, rent: [8,40,100,300,450,600],     house: 50 },
  { pos: 10, type: 'jail',   name: 'Респаун', icon: '⏳', img: IBASE + 'aegis.png' },
  { pos: 11, type: 'street', name: 'Mars',            icon: '🪖', img: HBASE + 'mars.png',             group: 'pink',      price: 140, rent: [10,50,150,450,625,750],    house: 100 },
  { pos: 12, type: 'utility',name: 'Тайная лавка',    icon: '🛒', img: '/shop.png', price: 150 },
  { pos: 13, type: 'street', name: 'Axe',             icon: '🪓', img: HBASE + 'axe.png',              group: 'pink',      price: 140, rent: [10,50,150,450,625,750],    house: 100 },
  { pos: 14, type: 'street', name: 'Tidehunter',      icon: '🌊', img: HBASE + 'tidehunter.png',       group: 'pink',      price: 160, rent: [12,60,180,500,700,900],    house: 100 },
  { pos: 15, type: 'rail',   name: 'Башня (мид)',     icon: '🗼', img: '/tower_radiant.png', price: 200 },
  { pos: 16, type: 'street', name: 'Drow Ranger',     icon: '🏹', img: HBASE + 'drow_ranger.png',      group: 'orange',    price: 180, rent: [14,70,200,550,750,950],    house: 100 },
  { pos: 17, type: 'chest',  name: 'Курьер',          icon: '📦', img: IBASE + 'courier.png' },
  { pos: 18, type: 'street', name: 'Sniper',          icon: '🎯', img: HBASE + 'sniper.png',           group: 'orange',    price: 180, rent: [14,70,200,550,750,950],    house: 100 },
  { pos: 19, type: 'street', name: 'Windranger',      icon: '🍃', img: HBASE + 'windrunner.png',       group: 'orange',    price: 200, rent: [16,80,220,600,800,1000],   house: 100 },
  { pos: 20, type: 'parking',name: 'Лагерь крипов', icon: '🐉', img: '/creeps.jpg' },
  { pos: 21, type: 'street', name: 'Sven',            icon: '🗡️', img: HBASE + 'sven.png',             group: 'red',       price: 220, rent: [18,90,250,700,875,1050],   house: 150 },
  { pos: 22, type: 'chance', name: 'Руна',            icon: '🔮', img: IBASE + 'bottle.png' },
  { pos: 23, type: 'street', name: 'Slardar',         icon: '🔱', img: HBASE + 'slardar.png',          group: 'red',       price: 220, rent: [18,90,250,700,875,1050],   house: 150 },
  { pos: 24, type: 'street', name: 'Earthshaker',     icon: '🔨', img: HBASE + 'earthshaker.png',      group: 'red',       price: 240, rent: [20,100,300,750,925,1100],  house: 150 },
  { pos: 25, type: 'rail',   name: 'Башня (низ)',     icon: '🏯', img: '/tower_radiant.png', price: 200 },
  { pos: 26, type: 'street', name: 'Phantom Assassin',icon: '🥷', img: HBASE + 'phantom_assassin.png', group: 'yellow',    price: 260, rent: [22,110,330,800,975,1150],  house: 150 },
  { pos: 27, type: 'street', name: 'Riki',            icon: '💨', img: HBASE + 'riki.png',             group: 'yellow',    price: 260, rent: [22,110,330,800,975,1150],  house: 150 },
  { pos: 28, type: 'utility',name: 'Лавка артефактов',icon: '🏪', img: '/shop.png', price: 150 },
  { pos: 29, type: 'street', name: 'Bloodseeker',     icon: '🩸', img: HBASE + 'bloodseeker.png',      group: 'yellow',    price: 280, rent: [24,120,360,850,1025,1200], house: 150 },
  { pos: 30, type: 'gotojail',name: 'Вы убиты!', icon: '⚰️' },
  { pos: 31, type: 'street', name: 'Invoker',         icon: '🌟', img: HBASE + 'invoker.png',          group: 'green',     price: 300, rent: [26,130,390,900,1100,1275], house: 200 },
  { pos: 32, type: 'street', name: 'Storm Spirit',    icon: '🌩️', img: HBASE + 'storm_spirit.png',     group: 'green',     price: 300, rent: [26,130,390,900,1100,1275], house: 200 },
  { pos: 33, type: 'chest',  name: 'Курьер',          icon: '📦', img: IBASE + 'courier.png' },
  { pos: 34, type: 'street', name: 'Templar Assassin',icon: '🔮', img: HBASE + 'templar_assassin.png', group: 'green',     price: 320, rent: [28,150,450,1000,1200,1400],house: 200 },
  { pos: 35, type: 'rail',   name: 'Трон',            icon: '👑', img: '/tower_dire.png', price: 200 },
  { pos: 36, type: 'chance', name: 'Руна',            icon: '🔮', img: IBASE + 'bottle.png' },
  { pos: 37, type: 'street', name: 'Chen',            icon: '🙏', img: HBASE + 'chen.png',             group: 'darkblue',  price: 350, rent: [35,175,500,1100,1300,1500],house: 200 },
  { pos: 38, type: 'tax',    name: 'Налог на артефакты', icon: '💎', img: IBASE + 'gem.png', amount: 100 },
  { pos: 39, type: 'street', name: 'Pudge',           icon: '🪝', img: HBASE + 'pudge.png',            group: 'darkblue',  price: 400, rent: [50,200,600,1400,1700,2000],house: 200 },
];

// Карточки.
const CHANCE = [
  { text: 'Руна богатства: получите 150 золота.', action: 'money', amount: 150 },
  { text: 'Телепорт на Фонтан.', action: 'moveTo', pos: 0 },
  { text: 'Неудачный ганк — вы потеряли 100 золота.', action: 'money', amount: -100 },
  { text: 'Двигайтесь к Pudge (поз. 39). Пройдёте Фонтан — соберите 200.', action: 'moveTo', pos: 39 },
  { text: 'Двигайтесь к Invoker. Пройдёте Фонтан — соберите 200.', action: 'moveTo', pos: 31 },
  { text: 'Вас поймали в лесу — гибель! Идите на респаун.', action: 'gotojail' },
  { text: 'Свиток Aegis — карта спасения от смерти. Сохраните её.', action: 'getout' },
  { text: 'Bounty-руна: получите 50 золота.', action: 'money', amount: 50 },
  { text: 'Враг пушит базу! Ремонт строений: 25 за дом и 100 за отель.', action: 'repairs', perHouse: 25, perHotel: 100 },
  { text: 'Откат на 3 клетки назад.', action: 'moveBy', steps: -3 },
  { text: 'First Blood! Каждый игрок платит вам 50 золота.', action: 'collectEach', amount: 50 },
  { text: 'Двигайтесь к ближайшей башне и заплатите двойную пошлину.', action: 'nearestRail' },
];

const CHEST = [
  { text: 'Курьер привёз Hand of Midas: получите 200 золота.', action: 'money', amount: 200 },
  { text: 'Возврат на Фонтан.', action: 'moveTo', pos: 0 },
  { text: 'Курьер перехвачен врагом — минус 50 золота.', action: 'money', amount: -50 },
  { text: 'Продажа артефакта на рынке: получите 100 золота.', action: 'money', amount: 100 },
  { text: 'Тиммейты зарепортили — гибель! Идите на респаун.', action: 'gotojail' },
  { text: 'Свиток Aegis — карта спасения от смерти. Сохраните её.', action: 'getout' },
  { text: 'Победа в драке 5 на 5: получите 100 золота.', action: 'money', amount: 100 },
  { text: 'Выкуп (buyback): заплатите 100 золота.', action: 'money', amount: -100 },
  { text: 'Ассист в убийстве: получите 25 золота.', action: 'money', amount: 25 },
  { text: 'Roshan разнёс ваши строения: 40 за дом и 115 за отель.', action: 'repairs', perHouse: 40, perHotel: 115 },
  { text: 'Стрик из 5 убийств подряд — каждый дарит вам 30 золота.', action: 'collectEach', amount: 30 },
  { text: 'Серия убийств: получите 75 золота.', action: 'money', amount: 75 },
];

module.exports = { BOARD, GROUPS, CHANCE, CHEST };
