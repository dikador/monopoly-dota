// Запуск игры с публичным доступом для друзей через интернет.
// Поднимает игровой сервер и открывает туннель через localtunnel (loca.lt) —
// без бинарников и без вопросов в терминале.

const localtunnel = require('localtunnel');

require('./server'); // запускает игровой сервер (порт 3000 или PORT)

const PORT = Number(process.env.PORT || 3000);

(async () => {
  console.log('\n⏳ Открываю публичный доступ для друзей… (несколько секунд)\n');

  let tunnel;
  try {
    tunnel = await localtunnel({ port: PORT });
  } catch (e) {
    console.error('❌ Не удалось открыть туннель:', e.message);
    console.error('Проверьте интернет и попробуйте снова: npm run online\n');
    return;
  }

  // Пароль для страницы-напоминания loca.lt — это ваш публичный IP
  let pass = '(см. на странице loca.lt)';
  try {
    const r = await fetch('https://loca.lt/mytunnelpassword');
    pass = (await r.text()).trim();
  } catch (e) { /* не критично */ }

  banner(tunnel.url, pass);

  tunnel.on('error', (err) => console.error('⚠️  Ошибка туннеля:', err && err.message));
  tunnel.on('close', () => console.log('Туннель закрыт.'));

  process.on('SIGINT', () => { try { tunnel.close(); } catch (e) {} process.exit(0); });
})();

function banner(url, pass) {
  const line = '═'.repeat(58);
  console.log('\n╔' + line + '╗');
  console.log('  ✅ ИГРА ДОСТУПНА В ИНТЕРНЕТЕ!');
  console.log('');
  console.log('  1) Отправьте друзьям ссылку:');
  console.log('     👉  ' + url);
  console.log('');
  console.log('  2) При первом заходе откроется страница loca.lt');
  console.log('     с одним полем. Пусть друг впишет туда пароль:');
  console.log('     🔑  ' + pass);
  console.log('     и нажмёт «Click to Submit» — дальше игра.');
  console.log('');
  console.log('  3) Откройте ссылку сами, создайте игру и пришлите');
  console.log('     друзьям ссылку-приглашение с экрана ожидания.');
  console.log('');
  console.log('  Не закрывайте это окно, пока играете. Выход — Ctrl+C.');
  console.log('╚' + line + '╝\n');
}
