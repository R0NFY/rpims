// api/bot.js
const { Telegraf, Markup } = require('telegraf');
const sqlite3 = require('sqlite3').verbose();

// ─── Инициализация бота и БД ───
// (токен берётся из переменных окружения)
const bot = new Telegraf(process.env.BOT_TOKEN);
const db = new sqlite3.Database('users.db');

// ─── Устанавливаем webhook при cold start ───
(async () => {
  try {
    const url = `${process.env.BASE_URL}/api/bot`;
    await bot.telegram.setWebhook(url);
    console.log('✅ Webhook установлен на', url);
  } catch (err) {
    console.error('❌ Не удалось установить webhook:', err);
  }
})();

// ─── Миграция схемы (если нужно) ───
db.serialize(() => {
  db.run(`ALTER TABLE users ADD COLUMN tg TEXT`, () => {});
  db.run(`ALTER TABLE users ADD COLUMN category TEXT`, () => {});
  db.run(`ALTER TABLE users ADD COLUMN count INTEGER DEFAULT 0`, () => {});
  db.run(`ALTER TABLE users ADD COLUMN creativity TEXT`, () => {});
  db.run(`ALTER TABLE users ADD COLUMN gender TEXT`, () => {});

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      chat_id    INTEGER PRIMARY KEY,
      name       TEXT,
      about      TEXT,
      tg         TEXT,
      category   TEXT,
      count      INTEGER DEFAULT 0,
      creativity TEXT,
      gender     TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS meetings (
      chat_id  INTEGER,
      meet_id  TEXT,
      UNIQUE(chat_id, meet_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS pairs (
      user_id    INTEGER,
      partner_id INTEGER,
      UNIQUE(user_id, partner_id)
    )
  `);
});

// ─── Предзаполним фейковых пользователей ───
db.serialize(() => {
  db.run(
    `INSERT OR IGNORE INTO users(chat_id,name,about,tg,category,count,creativity,gender)
     VALUES(?,?,?,?,?,?,?,?)`,
    [-1, 'Алиса',  'Люблю гулять',        '@alice_bot',      'friendship', 0, null,      null]
  );
  db.run(
    `INSERT OR IGNORE INTO users(chat_id,name,about,tg,category,count,creativity,gender)
     VALUES(?,?,?,?,?,?,?,?)`,
    [-2, 'Борис',  'Пишу стихи каждый',   '@boris_creative', 'collab',     0, 'пишу стихи каждый', null]
  );
  db.run(
    `INSERT OR IGNORE INTO users(chat_id,name,about,tg,category,count,creativity,gender)
     VALUES(?,?,?,?,?,?,?,?)`,
    [-3, 'Виктор', 'Люблю кино вечер',    '@viktor_love',    'love',       0, null,      'мужской']
  );
  db.run(
    `INSERT OR IGNORE INTO users(chat_id,name,about,tg,category,count,creativity,gender)
     VALUES(?,?,?,?,?,?,?,?)`,
    [-4, 'Оксана', 'Читаю книги ночью',    '@oksana_love',    'love',       0, null,      'женский']
  );

  db.run(
    `UPDATE users
     SET creativity = 'пишу стихи каждый'
     WHERE chat_id = -2 AND creativity IS NULL`
  );
});

// ─── Храним состояния пользователя при вводе ───
const states = new Map();

// ─── Функция: показать клавиатуру только с «Устроить встречу» ───
async function showMeetButton(ctx) {
  await ctx.reply(
    '📋',
    Markup.keyboard([['🚀 Устроить встречу']]).resize()
  );
}

// ─── Функция: начать «короткую регистрацию» ───
async function beginRegistration(ctx) {
  const id = ctx.chat.id;
  // Сброс старых данных
  db.run(`DELETE FROM users WHERE chat_id = ?`, [id]);
  db.run(`DELETE FROM meetings WHERE chat_id = ?`, [id]);
  db.run(`DELETE FROM pairs WHERE user_id = ? OR partner_id = ?`, [id, id]);
  states.delete(id);

  // Сообщение про регистрацию
  await ctx.reply('👋 Чтобы встречать друзей PIMS, нужно пройти короткую регистрацию.');
  // Устанавливаем состояние «ввод имени» и убираем клавиатуру
  states.set(id, { step: 'name', mode: 'register' });
  await ctx.reply('📋 Введите своё имя:', Markup.removeKeyboard());
}

// ─── Обработчик команды /start ───
bot.start(async (ctx) => {
  const id = ctx.chat.id;
  const meet_id = ctx.startPayload;

  const userExists = await new Promise(res =>
    db.get(`SELECT 1 FROM users WHERE chat_id = ?`, [id], (_, row) => res(!!row))
  );

  if (meet_id) {
    if (userExists) {
      const already = await new Promise(res =>
        db.get(
          `SELECT 1 FROM meetings WHERE chat_id = ? AND meet_id = ?`,
          [id, meet_id],
          (_, row) => res(!!row)
        )
      );
      if (already) {
        return ctx.reply('❗ Встреча уже зачислена');
      } else {
        db.run(`INSERT INTO meetings(chat_id, meet_id) VALUES(?,?)`, [id, meet_id]);
        db.run(`UPDATE users SET count = count + 1 WHERE chat_id = ?`, [id]);
        return ctx.reply('➕ Встреча зачислена');
      }
    }
  }

  if (userExists) {
    return showMeetButton(ctx);
  }

  return beginRegistration(ctx);
});

// ─── Обработчик «Устроить встречу» ───
async function handleMeet(ctx) {
  const id = ctx.chat.id;

  const user = await new Promise(res =>
    db.get(`SELECT count, gender, creativity, name, about, tg FROM users WHERE chat_id = ?`, [id], (_, r) => res(r))
  );
  if (!user) {
    return beginRegistration(ctx);
  }
  if (user.count < 1) {
    return ctx.reply(
      'Встреч не осталось — может, по стаканчику PIMS? 🍹',
      Markup.keyboard([['🚀 Устроить встречу']]).resize()
    );
  }

  return ctx.reply(
    '🚀 Выберите категорию встречи:',
    Markup.keyboard([
      ['🤝 Дружба'],
      ['💡 Сотворчество'],
      ['❤️ Отношения']
    ])
      .resize()
      .oneTime(true)
  );
}

bot.command('meet', handleMeet);
bot.hears('🚀 Устроить встречу', handleMeet);

// ─── «Секретная» команда «встречиN» ───
bot.hears(/^встречи(\d+)$/i, async (ctx) => {
  const id = ctx.chat.id;
  const num = parseInt(ctx.match[1], 10);
  if (isNaN(num) || num <= 0) {
    return ctx.reply('Неверный формат. Напишите «встречи<number>».');
  }
  const user = await new Promise(res =>
    db.get(`SELECT count FROM users WHERE chat_id = ?`, [id], (_, r) => res(r))
  );
  if (!user) {
    return beginRegistration(ctx);
  }
  db.run(`UPDATE users SET count = count + ? WHERE chat_id = ?`, [num, id]);
  const newCount = await new Promise(res =>
    db.get(`SELECT count FROM users WHERE chat_id = ?`, [id], (_, r) => res(r))
  ).then(r => r.count);
  return ctx.reply(
    `🛠 Добавлено ${num} встреч. Всего: ${newCount}`,
    Markup.keyboard([['🚀 Устроить встречу']]).resize()
  );
});

// ─── Обработка выбора категории («Дружба», «Сотворчество», «Отношения») ───
bot.hears(['🤝 Дружба', '💡 Сотворчество', '❤️ Отношения'], async (ctx) => {
  const id = ctx.chat.id;
  const text = ctx.message.text;
  const state = states.get(id);

  // Если в процессе регистрации (step === 'category')
  if (state && state.step === 'category') {
    const map = {
      '🤝 Дружба':       ['friendship', 'Дружба'],
      '💡 Сотворчество': ['collab',     'Сотворчество'],
      '❤️ Отношения':    ['love',       'Отношения']
    };
    const [category, catText] = map[text];
    const tg = ctx.from.username ? '@' + ctx.from.username : '';
    const initialCount = 1;

    // Регистрация «Дружба»
    if (category === 'friendship') {
      await db.run(
        `INSERT OR REPLACE INTO users(chat_id, name, about, tg, category, count, creativity, gender)
         VALUES(?,?,?,?,?,?,NULL,NULL)`,
        [id, state.name, state.about, tg, category, initialCount]
      );
      await ctx.reply(
        `✅ Регистрация завершена!
Вы ищете: ${catText}
Имя: ${state.name}
О себе: ${state.about}
Контакт: ${tg || '(не указан)'}
➕ Зачислена 1 встреча.`,
        Markup.keyboard([['🚀 Устроить встречу']]).resize()
      );
      states.delete(id);
      return;
    }

    // Регистрация «Сотворчество»
    if (category === 'collab') {
      state.category = category;
      state.step = 'creativity';
      return ctx.reply('✍️ Опишите своё творчество тремя словами:', Markup.removeKeyboard());
    }

    // Регистрация «Отношения»
    if (category === 'love') {
      state.category = category;
      state.step = 'gender';
      return ctx.reply(
        '🧭 Укажите ваш пол:',
        Markup.keyboard([['Мужской'], ['Женский']])
          .resize()
          .oneTime(true)
      );
    }

    return;
  }

  // Если выбор категории для встречи
  const user = await new Promise(res =>
    db.get(`SELECT count, gender, creativity, name, about, tg FROM users WHERE chat_id = ?`, [id], (_, r) => res(r))
  );
  if (!user) {
    return beginRegistration(ctx);
  }
  if (user.count < 1) {
    return ctx.reply(
      'Встреч не осталось — может, по стаканчику PIMS? 🍹',
      Markup.keyboard([['🚀 Устроить встречу']]).resize()
    );
  }

  const categoryMap = {
    '🤝 Дружба':       'friendship',
    '💡 Сотворчество': 'collab',
    '❤️ Отношения':    'love'
  };
  const chosenCategory = categoryMap[text];

  // Если «Сотворчество» без сохранённого творчества
  if (chosenCategory === 'collab' && !user.creativity) {
    states.set(id, { step: 'meet_creativity', category: 'collab' });
    return ctx.reply('✍️ Опишите своё творчество тремя словами:', Markup.removeKeyboard());
  }
  // Если «Отношения» без сохранённого пола
  if (chosenCategory === 'love' && !user.gender) {
    states.set(id, { step: 'meet_gender', category: 'love' });
    return ctx.reply(
      '🧭 Укажите ваш пол:',
      Markup.keyboard([['Мужской'], ['Женский']])
        .resize()
        .oneTime(true)
    );
  }

  return findAndSendPartner(id, chosenCategory);
});

// ─── Обработчик текстовых ответов (творчество, пол, имя, «о себе») ───
bot.on('text', async (ctx, next) => {
  const id = ctx.chat.id;
  const state = states.get(id);
  const text = ctx.message.text.trim();

  if (!state) {
    return next();
  }

  // Ввод творчества при регистрации
  if (state.step === 'creativity') {
    if (text.length === 0) {
      return ctx.reply('❗ Опишите своё творчество хотя бы одним предложением (три слова).', Markup.removeKeyboard());
    }
    state.creativity = text;
    const tg = ctx.from.username ? '@' + ctx.from.username : '';
    await db.run(
      `INSERT OR REPLACE INTO users(chat_id, name, about, tg, category, count, creativity, gender)
       VALUES(?,?,?,?,?,?,?,NULL)`,
      [id, state.name, state.about, tg, state.category, 1, state.creativity]
    );
    await ctx.reply(
      `✅ Регистрация завершена!
Вы ищете: Сотворчество
Имя: ${state.name}
О себе: ${state.about}
Контакт: ${tg || '(не указан)'}
➕ Творчество: ${state.creativity}
➕ Зачислена 1 встреча.`,
      Markup.keyboard([['🚀 Устроить встречу']]).resize()
    );
    states.delete(id);
    return;
  }

  // Ввод творчества перед подбором
  if (state.step === 'meet_creativity') {
    if (text.length === 0) {
      return ctx.reply('❗ Опишите своё творчество хотя бы одним предложением (три слова).', Markup.removeKeyboard());
    }
    await db.run(`UPDATE users SET creativity = ? WHERE chat_id = ?`, [text, id]);
    states.delete(id);
    await ctx.reply('✅ Творчество сохранено. Ищем партнёра...', Markup.keyboard([['🚀 Устроить встречу']]).resize());
    return findAndSendPartner(id, 'collab');
  }

  // Ввод пола при регистрации
  if (state.step === 'gender') {
    const low = text.toLowerCase();
    if (low !== 'мужской' && low !== 'женский') {
      return ctx.reply('❗ Неверный ввод, выберите «Мужской» или «Женский».', Markup.keyboard([['Мужской'], ['Женский']]).resize());
    }
    const tg = ctx.from.username ? '@' + ctx.from.username : '';
    await db.run(
      `INSERT OR REPLACE INTO users(chat_id, name, about, tg, category, count, creativity, gender)
       VALUES(?,?,?,?,?,?,NULL,?)`,
      [id, state.name, state.about, tg, state.category, 1, low]
    );
    await ctx.reply(
      `✅ Регистрация завершена!
Вы ищете: Отношения
Имя: ${state.name}
О себе: ${state.about}
Контакт: ${tg || '(не указан)'}
➕ Пол: ${text}
➕ Зачислена 1 встреча.`,
      Markup.keyboard([['🚀 Устроить встречу']]).resize()
    );
    states.delete(id);
    return;
  }

  // Ввод имени (step === 'name')
  if (state.step === 'name') {
    if (text.length === 0) {
      return ctx.reply('❗ Пожалуйста, введите своё имя (минимум одно слово).', Markup.removeKeyboard());
    }
    state.name = text;
    state.step = 'about';
    return ctx.reply('💬 Напишите о себе двумя словами:', Markup.removeKeyboard());
  }

  // Ввод «о себе» (step === 'about')
  if (state.step === 'about') {
    if (text.length === 0) {
      return ctx.reply('❗ Пожалуйста, напишите о себе хотя бы двумя словами.', Markup.removeKeyboard());
    }
    state.about = text;
    state.step = 'category';
    return ctx.reply(
      '🧭 Кого вы хотите найти?',
      Markup.keyboard([['🤝 Дружба'], ['💡 Сотворчество'], ['❤️ Отношения']])
        .resize()
        .oneTime(true)
    );
  }

  return next();
});

// ─── Обработчик пола при «встрече» ───
bot.hears(['Мужской', 'Женский'], async (ctx) => {
  const id = ctx.chat.id;
  const text = ctx.message.text.toLowerCase();
  const state = states.get(id);

  if (state && state.step === 'meet_gender') {
    await db.run(`UPDATE users SET gender = ? WHERE chat_id = ?`, [text, id]);
    states.delete(id);
    await ctx.reply(
      '✅ Пол сохранён. Ищем партнёра...',
      Markup.keyboard([['🚀 Устроить встречу']]).resize()
    );
    return findAndSendPartner(id, 'love');
  }

  return;
});

// ─── Функция: найти и отправить партнёра и уведомить обоих ───
async function findAndSendPartner(id, chosenCategory) {
  // Получим данные инициатора
  const initiator = await new Promise(res =>
    db.get(
      `SELECT name, about, tg, category, creativity, gender, count FROM users WHERE chat_id = ?`,
      [id],
      (_, r) => res(r)
    )
  );
  if (!initiator) {
    return bot.telegram.sendMessage(
      id,
      'Ошибка: не удалось получить ваши данные.',
      Markup.keyboard([['🚀 Устроить встречу']]).resize()
    );
  }

  // Проверяем, что у инициатора есть встречи
  if (initiator.count < 1) {
    return bot.telegram.sendMessage(
      id,
      'Встреч не осталось — может, по стаканчику PIMS? 🍹',
      Markup.keyboard([['🚀 Устроить встречу']]).resize()
    );
  }

  // Поиск кандидатов (включаем также ботов с отрицательными chat_id)
  let rows;
  if (chosenCategory === 'love') {
    const targetGender = initiator.gender === 'мужской' ? 'женский' : 'мужской';
    rows = await new Promise(res =>
      db.all(
        `SELECT * FROM users WHERE category = ? AND gender = ? AND chat_id <> ?`,
        [chosenCategory, targetGender, id],
        (_, r) => res(r)
      )
    );
  } else {
    rows = await new Promise(res =>
      db.all(
        `SELECT * FROM users WHERE category = ? AND chat_id <> ?`,
        [chosenCategory, id],
        (_, r) => res(r)
      )
    );
  }

  if (!rows.length) {
    return bot.telegram.sendMessage(
      id,
      'Нет подходящих участников в этой категории.',
      Markup.keyboard([['🚀 Устроить встречу']]).resize()
    );
  }

  // Отфильтруем тех, с кем уже встречались
  const filtered = await new Promise(res => {
    const placeholders = rows.map(() => '?').join(',');
    const ids = rows.map(r => r.chat_id);
    if (!ids.length) return res([]);
    db.all(
      `SELECT partner_id FROM pairs WHERE user_id = ? AND partner_id IN (${placeholders})`,
      [id, ...ids],
      (_, met) => {
        const metIds = new Set(met.map(m => m.partner_id));
        res(rows.filter(r => !metIds.has(r.chat_id)));
      }
    );
  });

  if (!filtered.length) {
    return bot.telegram.sendMessage(
      id,
      'Нет новых участников (вы уже встречались со всеми).',
      Markup.keyboard([['🚀 Устроить встречу']]).resize()
    );
  }

  // Выбираем партнёра
  const pick = filtered[Math.floor(Math.random() * filtered.length)];

  // Списываем встречу у инициатора
  await db.run(`UPDATE users SET count = count - 1 WHERE chat_id = ?`, [id]);
  // Записываем пару в обе стороны
  await db.run(`INSERT OR IGNORE INTO pairs(user_id, partner_id) VALUES(?,?)`, [id, pick.chat_id]);
  await db.run(`INSERT OR IGNORE INTO pairs(user_id, partner_id) VALUES(?,?)`, [pick.chat_id, id]);

  // ─── Уведомление партнёру ───
  let notifyMsg = `🎉 У вас новый матч!

Имя: ${initiator.name}
О себе: ${initiator.about}
Контакт: ${initiator.tg || '(не указан)'}`;
  if (initiator.category === 'collab') {
    notifyMsg += `\nТворчество: ${initiator.creativity}`;
  }
  if (initiator.category === 'love') {
    notifyMsg += `\nПол: ${initiator.gender.charAt(0).toUpperCase() + initiator.gender.slice(1)}`;
  }

  // Если recipient — бот (отрицательный chat_id), Telegram игнорирует sendMessage, но ошибки не будет
  await bot.telegram.sendMessage(pick.chat_id, notifyMsg).catch(() => {});

  // ─── Сообщение инициатору ───
  let meetMsg = `🎉 Ваша встреча:

Имя: ${pick.name}
О себе: ${pick.about}
Контакт: ${pick.tg || '(не указан)'}`;
  if (chosenCategory === 'collab') {
    meetMsg += `\nТворчество: ${pick.creativity}`;
  }
  if (chosenCategory === 'love') {
    meetMsg += `\nПол: ${pick.gender.charAt(0).toUpperCase() + pick.gender.slice(1)}`;
  }

  return bot.telegram.sendMessage(
    id,
    meetMsg,
    Markup.keyboard([['🚀 Устроить встречу']]).resize()
  );
}

// ─── Дополнительные обработчики ───

// /count ───
bot.command('count', (ctx) => {
  const id = ctx.chat.id;
  db.get(`SELECT count FROM users WHERE chat_id = ?`, [id], (_, row) => {
    if (row) {
      return ctx.reply(
        `У вас встреч: ${row.count}`,
        Markup.keyboard([['🚀 Устроить встречу']]).resize()
      );
    } else {
      return beginRegistration(ctx);
    }
  });
});

// /reset ───
bot.command('reset', (ctx) => {
  const id = ctx.chat.id;
  db.run(`DELETE FROM users WHERE chat_id = ?`, [id]);
  db.run(`DELETE FROM meetings WHERE chat_id = ?`, [id]);
  db.run(`DELETE FROM pairs WHERE user_id = ? OR partner_id = ?`, [id, id]);
  states.delete(id);
  return ctx.reply(
    '🧹 Данные удалены. Чтобы начать заново, отправьте /start.',
    Markup.keyboard([['🚀 Устроить встречу']]).resize()
  );
});

// ─── Экспорт handler’а для Vercel ───
module.exports = async (req, res) => {
  if (req.method === 'POST') {
    try {
      await bot.handleUpdate(req.body);
      return res.status(200).send('OK');
    } catch (err) {
      console.error('Ошибка обработки update:', err);
      return res.status(500).send('Error');
    }
  }
  // На GET-запросы отвечаем просто «OK», чтобы Telegram или проверка HTTP не ломались
  return res.status(200).send('OK');
};
