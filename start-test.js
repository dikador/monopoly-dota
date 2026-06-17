// Тестовый запуск на отдельном порту (для предпросмотра, не мешает основному серверу)
process.env.PORT = process.env.PORT || '3099';
require('./server.js');
