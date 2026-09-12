// --- РЕГИСТРАЦИЯ PWA (SERVICE WORKER) ---
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(err => console.log('SW сбой:', err));
  });
}

// --- ИНИЦИАЛИЗАЦИЯ FIREBASE ---
const firebaseConfig = {
  apiKey: "AIzaSyC_JkUF__UfStFrTKecRasKqKBKXlQ4D88",
  authDomain: "familybudget-4245a.firebaseapp.com",
  projectId: "familybudget-4245a",
  storageBucket: "familybudget-4245a.firebasestorage.app",
  messagingSenderId: "129164761119",
  appId: "1:129164761119:web:0303fd6ccd41e071655d2a"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const auth = firebase.auth();

// Хелпер доступа к личной подколлекции авторизованного пользователя
function getUserCol(table) {
  const user = auth.currentUser;
  if (!user) throw new Error('Пользователь не авторизован');
  return db.collection('users').doc(user.uid).collection(table);
}
window.getUserCol = getUserCol;

// Инициализация профиля ТОЛЬКО если это совершенно новый пользователь
async function initNewUserIfNeeded(user) {
  try {
    const userDocRef = db.collection('users').doc(user.uid);
    const userDoc = await userDocRef.get();

    // Пользователь уже зарегистрирован и настроен — сразу выходим
    if (userDoc.exists) return;

    // Новый аккаунт: создаем профиль и начальные категории со словарем
    await seedNewUserInitialData(user);
  } catch (e) {
    console.error('Ошибка инициализации профиля:', e);
  }
}

// Заполнение начальных категорий и правил для нового аккаунта
async function seedNewUserInitialData(user) {
  try {
    const batch = db.batch();
    
    // Начальные правила словаря
    if (typeof StatementCategorizer !== 'undefined' && StatementCategorizer.DEFAULT_RULES) {
      StatementCategorizer.DEFAULT_RULES.forEach(r => {
        batch.set(getUserCol('CategoryRules').doc(), r);
      });
    }

    // Документ пользователя
    batch.set(db.collection('users').doc(user.uid), {
      migrated: true,
      displayName: user.displayName || user.email?.split('@')[0] || 'Пользователь',
      email: user.email || '',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    await batch.commit();
  } catch (err) {
    console.error('Ошибка инициализации нового пользователя:', err);
  }
}

let Cache = null;
let currentEditId = null, currentEditTable = null;
let brokerChartObj = null;
let monthlyChartObj = null;
let categoryChartObj = null;

let currentAuthMode = 'login'; // 'login' или 'register'

// Переключение между вкладками Вход / Регистрация
function setAuthMode(mode) {
  currentAuthMode = mode;
  const loginTab = document.getElementById('tab-auth-login');
  const regTab = document.getElementById('tab-auth-register');
  const submitBtn = document.getElementById('auth-submit-btn');

  if (mode === 'login') {
    loginTab.className = 'flex-1 py-2 text-xs font-semibold rounded-xl bg-blue-600 text-white transition-all cursor-pointer';
    regTab.className = 'flex-1 py-2 text-xs font-semibold rounded-xl text-gray-400 hover:text-white transition-all cursor-pointer';
    submitBtn.innerText = 'Войти';
  } else {
    regTab.className = 'flex-1 py-2 text-xs font-semibold rounded-xl bg-blue-600 text-white transition-all cursor-pointer';
    loginTab.className = 'flex-1 py-2 text-xs font-semibold rounded-xl text-gray-400 hover:text-white transition-all cursor-pointer';
    submitBtn.innerText = 'Создать аккаунт';
  }
}

// Превращает никнейм в безопасный виртуальный email для Firebase
function normalizeAuthEmail(input) {
  const clean = input.trim().toLowerCase();
  // Если пользователь ввел реальную почту с @ — оставляем как есть
  if (clean.includes('@')) {
    return clean;
  }
  // Иначе отсекаем спецсимволы и создаем виртуальный email @budget.local
  const safeNickname = clean.replace(/[^a-z0-9._-]/g, '');
  return `${safeNickname || 'user'}@budget.local`;
}

// Вход через Google в 1 клик
async function loginWithGoogle() {
  const provider = new firebase.auth.GoogleAuthProvider();
  showToast('Вход через Google...', false, true);

  try {
    await auth.signInWithPopup(provider);
    document.getElementById('toast-container')?.classList.add('hidden');
  } catch (err) {
    document.getElementById('toast-container')?.classList.add('hidden');
    // Не показываем ошибку, если пользователь просто сам закрыл окно авторизации
    if (err.code !== 'auth/popup-closed-by-user') {
      showToast('Ошибка авторизации Google: ' + err.message, true);
    }
  }
}

// Обработка отправки формы (Вход или Регистрация)
async function handleAuthSubmit(e) {
  e.preventDefault();
  const usernameInput = document.getElementById('auth-username').value;
  const password = document.getElementById('auth-password').value;
  const btn = document.getElementById('auth-submit-btn');

  if (!usernameInput.trim() || !password) return;

  if (password.length < 6) {
    showToast('Пароль должен быть от 6 символов', true);
    return;
  }

  const email = normalizeAuthEmail(usernameInput);
  btn.disabled = true;

  if (currentAuthMode === 'login') {
    btn.innerText = 'Вход...';
    try {
      await auth.signInWithEmailAndPassword(email, password);
    } catch (err) {
      btn.disabled = false;
      btn.innerText = 'Войти';
      showToast('Неверный логин или пароль', true);
    }
  } else {
    btn.innerText = 'Создание аккаунта...';
    try {
      const cred = await auth.createUserWithEmailAndPassword(email, password);
      // Запоминаем красивый никнейм в профиле пользователя
      if (cred.user) {
        const displayName = usernameInput.includes('@') ? usernameInput.split('@')[0] : usernameInput.trim();
        await cred.user.updateProfile({ displayName });
      }
      showToast('Аккаунт успешно создан!');
    } catch (err) {
      btn.disabled = false;
      btn.innerText = 'Создать аккаунт';
      if (err.code === 'auth/email-already-in-use') {
        showToast('Этот никнейм уже занят', true);
      } else {
        showToast('Ошибка регистрации: ' + err.message, true);
      }
    }
  }
}

function logoutUser() {
  showDialog('Выход', 'Точно выйти из аккаунта?', true, async () => {
    // Полностью стираем кэш в оперативной памяти браузера
    Cache = null;
    window.Cache = null;
    
    // Сбрасываем интерфейс
    document.getElementById('transactions-list').innerHTML = '';
    document.getElementById('month-expense').innerText = '0 ₽';
    document.getElementById('month-income').innerText = '0 ₽';
    
    await auth.signOut();
  });
}

// Полное удаление аккаунта и всех его подколлекций
async function deleteCurrentAccountAndData() {
  const user = auth.currentUser;
  if (!user) return;

  showDialog('Удаление аккаунта', 'ВНИМАНИЕ! Все ваши транзакции, вклады, цели и настройки будут безвозвратно удалены. Продолжить?', true, async () => {
    showToast('Удаление всех данных аккаунта...', false, true);
    try {
      const tables = ['Transactions', 'Deposits', 'Broker', 'Goals', 'Categories', 'CategoryRules'];

      // 1. Стираем все подколлекции пользователя
      for (const table of tables) {
        const snap = await getUserCol(table).get();
        if (!snap.empty) {
          const batch = db.batch();
          snap.docs.forEach(doc => batch.delete(doc.ref));
          await batch.commit();
        }
      }

      // 2. Стираем профиль пользователя в Firestore
      await db.collection('users').doc(user.uid).delete();

      // 3. Стираем учетную запись из Firebase Auth
      await user.delete();

      // Очищаем кэш в памяти
      Cache = null;
      window.Cache = null;

      showToast('Аккаунт и все данные удалены');
    } catch (err) {
      console.error('Ошибка при удалении аккаунта:', err);
      if (err.code === 'auth/requires-recent-login') {
        showToast('Для безопасности требуется повторный вход перед удалением', true);
      } else {
        showToast('Ошибка: ' + err.message, true);
      }
    }
  });
}
window.deleteCurrentAccountAndData = deleteCurrentAccountAndData;

// Показываем экран загрузки сразу при старте
document.getElementById('loading-screen').classList.remove('hidden');

auth.onAuthStateChanged(async user => {
  document.getElementById('loading-screen').classList.add('hidden');
  
  if (user) {
    document.getElementById('login-screen').classList.add('hidden');
    switchTab('transactions');

    // Обновляем никнейм в шапке
    const nameEl = document.getElementById('header-user-name');
    if (nameEl) {
      const name = user.displayName || (user.email?.includes('@budget.local') ? user.email.replace('@budget.local', '') : user.email?.split('@')[0]) || 'Профиль';
      nameEl.textContent = name;
    }

    await initNewUserIfNeeded(user);
    await loadUserSettings(user);
    fetchAllData();
  } else {
    document.getElementById('login-screen').classList.remove('hidden');
  }
});

// --- UI УТИЛИТЫ ---
const formatMoney = (sum) => new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  minimumFractionDigits: 0
}).format(sum);

function formatSumInput(el) {
  let val = el.value.replace(/[^\d.,]/g, '').replace(',', '.');
  if (val) {
    let parts = val.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, " ");
    el.value = parts.join('.');
  }
}

const getUnformattedVal = (el) => parseFloat(el.value.replace(/\s/g, '')) || 0;
const setFormattedVal = (id, val) => {
  const el = document.getElementById(id);
  el.value = val;
  formatSumInput(el);
};

function formatDateStr(dateStr, format) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  if (format === 'dd.MM.yyyy')
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
  if (format === 'yyyy-MM')
    return d.toISOString().substring(0, 7);
  return d.toISOString().substring(0, 10);
}

function showToast(text, isError = false, keep = false) {
  const c = document.getElementById('toast-container');
  document.getElementById('toast-text').innerText = text;
  document.getElementById('toast-spinner').style.display = isError || keep === false ? 'none' : 'block';
  document.getElementById('toast-content').style.borderColor = isError ? '#ef4444' : (keep ? '#3b82f6' : '#10b981');
  c.classList.remove('hidden');
  if (!keep) setTimeout(() => c.classList.add('hidden'), 2500);
}

/* Кастомное диалоговое окно */
function showDialog(title, message, isConfirm, callback) {
  const dialog = document.getElementById('custom-dialog');
  document.getElementById('dialog-title').innerText = title;
  document.getElementById('dialog-message').innerText = message;
  const btns = document.getElementById('dialog-buttons');
  btns.innerHTML = '';

  if (isConfirm) {
    btns.innerHTML = `<button id="dialog-cancel" class="flex-1 bg-gray-700 text-white py-3 rounded-xl font-medium">Отмена</button>
                      <button id="dialog-ok" class="flex-1 bg-blue-600 text-white py-3 rounded-xl font-medium">ОК</button>`;
    document.getElementById('dialog-cancel').onclick = () => dialog.classList.add('hidden');
    document.getElementById('dialog-ok').onclick = () => {
      dialog.classList.add('hidden');
      if (callback) callback();
    };
  } else {
    btns.innerHTML = `<button id="dialog-ok" class="w-full bg-blue-600 text-white py-3 rounded-xl font-medium">Понятно</button>`;
    document.getElementById('dialog-ok').onclick = () => {
      dialog.classList.add('hidden');
      if (callback) callback();
    };
  }
  dialog.classList.remove('hidden');
}

// --- БД И ЛОГИКА ---
async function fetchCollection(table) {
  try {
    const querySnapshot = await getUserCol(table).get();
    const data = querySnapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    switch (table) {
      case 'Transactions':
        Cache.transactions = processTransactions(data);
        renderTransactions();
        break;
      case 'Deposits':
        Cache.deposits = processDeposits(data, Cache.goals);
        renderDeposits();
        break;
      case 'Broker':
        Cache.broker = processBroker(data, Cache.goals);
        renderBroker();
        break;
      case 'Goals':
        // Цели влияют на вклады и брокера, поэтому обновляем всё
        await fetchAllData();
        break;
    }
  } catch (e) {
    showToast("Ошибка загрузки", true);
  }
}

async function fetchAllData() {
  showToast("Синхронизация...", false, true);
  try {
    const [txS, depS, brS, goalS, catS, rulesS] = await Promise.all([
      getUserCol('Transactions').get(),
      getUserCol('Deposits').get(),
      getUserCol('Broker').get(),
      getUserCol('Goals').get(),
      getUserCol('Categories').get(),
      getUserCol('CategoryRules').get()
    ]);
    const txData = txS.docs.map(d => ({ id: d.id, ...d.data() }));
    const depData = depS.docs.map(d => ({ id: d.id, ...d.data() }));
    const brData = brS.docs.map(d => ({ id: d.id, ...d.data() }));
    const goalData = goalS.docs.map(d => ({ id: d.id, ...d.data() }));

    const processedDeposits = processDeposits(depData, goalData);
    const processedBroker = processBroker(brData, goalData);
    const catData = catS.docs.map(d => ({ id: d.id, ...d.data() }));
    const categories = processCategories(catData);
    
    // БЕРЕЖНО СОХРАНЯЕМ СУЩЕСТВУЮЩИЕ НАСТРОЙКИ (showBroker и т.д.) ИЗ loadUserSettings
    const existingSettings = (Cache && Cache.settings) ? Cache.settings : {};
    
    Cache = {
      settings: existingSettings,
      transactions: processTransactions(txData),
      deposits: processedDeposits,
      broker: processedBroker,
      goals: processGoals(goalData, processedDeposits, processedBroker),
      categories: categories,
      categoryRules: await processOrSeedRules(rulesS)
    };
    window.Cache = Cache;

    updateGoalDropdowns();
    renderTransactions();
    renderDeposits();
    renderBroker();
    renderGoals();
    document.getElementById('last-sync').innerText = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    document.getElementById('toast-container').classList.add('hidden');
  } catch (err) {
    showToast("Ошибка", true);
  }
}

/* Универсальная функция добавления/обновления */
async function submitAction(btnId, table, data) {
  const btn = document.getElementById(btnId);
  btn.disabled = true;
  showToast("Сохранение...", false, true);

  try {
    if (currentEditId && currentEditTable === table) {
      await getUserCol(table).doc(currentEditId).update(data);
    } else if (Array.isArray(data)) {
      const batch = db.batch();
      data.forEach(item => batch.set(getUserCol(table).doc(), item));
      await batch.commit();
    } else {
      await getUserCol(table).add(data);
    }

    btn.disabled = false;
    btn.innerText = currentEditId ? 'Сохранить изменения' : btn.innerText;

    // Скрываем форму
    btn.closest('form').parentElement.classList.add('hidden');

    currentEditId = null;
    currentEditTable = null;

    // Оптимизированное обновление: только нужная коллекция
    if (table === 'Transactions') {
      await fetchCollection('Transactions');
      document.getElementById('toast-container').classList.add('hidden');
    } else {
      fetchAllData();
    }
  } catch (e) {
    btn.disabled = false;
    showToast(e.message, true);
  }
}

function deleteRecord(table, id) {
  showDialog('Удаление', 'Точно удалить запись? Это нельзя отменить.', true, async () => {
    showToast("Удаление...", false, true);
    try {
      await getUserCol(table).doc(id).delete();

      // Оптимизированное обновление
      if (table === 'Transactions') {
        await fetchCollection('Transactions');
        document.getElementById('toast-container').classList.add('hidden');
      } else {
        fetchAllData();
      }
    } catch (e) {
      showToast("Ошибка", true);
    }
  });
}

function processTransactions(txs) {
  const grouped = {};
  const months = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
  txs.forEach(tx => {
    const txDate = tx.date ? new Date(tx.date) : new Date();
    const key = formatDateStr(tx.date, 'yyyy-MM');
    if (!grouped[key]) {
      grouped[key] = {
        id: key,
        label: months[txDate.getMonth()] + ' ' + txDate.getFullYear(),
        income: 0,
        expense: 0,
        items: []
      };
    }
    const amount = parseFloat(tx.amount) || 0;
    if (tx.type === 'Расход') grouped[key].expense += amount;
    else if (tx.type === 'Доход') grouped[key].income += amount;
    grouped[key].items.push({
      id: tx.id,
      type: tx.type,
      category: tx.category,
      amount,
      comment: tx.comment || '',
      formattedDate: formatDateStr(tx.date, 'dd.MM.yyyy'),
      rawDate: tx.date,
      timestamp: txDate.getTime()
    });
  });
  return Object.values(grouped)
    .sort((a, b) => b.id.localeCompare(a.id))
    .map(m => {
      m.items.sort((a, b) => b.timestamp - a.timestamp);
      return m;
    });
}

function processCategories(cats) {
  const defaultExpense = [
    { name: 'Продукты', icon: '🍔' },
    { name: 'Кафе и рестораны', icon: '🍽️' },
    { name: 'Маркетплейсы', icon: '🛍️' },
    { name: 'Транспорт', icon: '🚗' },
    { name: 'Жилье', icon: '🏠' },
    { name: 'Развлечения', icon: '🎬' },
    { name: 'Другое', icon: '📦' }
  ];
  const defaultIncome = [
    { name: 'Зарплата', icon: '💼' },
    { name: 'Возврат', icon: '↩️' },
    { name: 'Кэшбек', icon: '💰' },
    { name: 'Другое', icon: '📦' }
  ];

  const expense = [...defaultExpense];
  const income = [...defaultIncome];

  cats.forEach(c => {
    if (c.type === 'Расход') {
      if (!expense.some(item => item.name === c.name)) {
        expense.push({ name: c.name, icon: c.icon || '📦' });
      }
    } else if (c.type === 'Доход') {
      if (!income.some(item => item.name === c.name)) {
        income.push({ name: c.name, icon: c.icon || '📦' });
      }
    }
  });

  return { expense, income };
}

function showAddCategoryDialog(type, selectEl) {
  currentCategoryType = type;
  currentCategorySelect = selectEl;
  selectedCategoryIcon = '📦';
  document.getElementById('category-dialog-title').innerText = `Новая категория (${type})`;
  document.getElementById('category-name-input').value = '';
  renderIconGrid();
  document.getElementById('category-dialog').classList.remove('hidden');
}

function renderIconGrid() {
  const grid = document.getElementById('category-icon-grid');
  grid.innerHTML = availableIcons.map(icon => `
    <button type="button" class="icon-option ${icon === selectedCategoryIcon ? 'selected' : ''}" data-icon="${icon}">${icon}</button>
  `).join('');
  grid.querySelectorAll('.icon-option').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedCategoryIcon = btn.dataset.icon;
      grid.querySelectorAll('.icon-option').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
  });
}

document.getElementById('category-cancel-btn').addEventListener('click', () => {
  document.getElementById('category-dialog').classList.add('hidden');
});

document.getElementById('category-save-btn').addEventListener('click', async () => {
  const name = document.getElementById('category-name-input').value.trim();
  if (!name) {
    showToast('Введите название', true);
    return;
  }
  try {
    await getUserCol('Categories').add({ name, type: currentCategoryType, icon: selectedCategoryIcon });
    const arr = currentCategoryType === 'Доход' ? Cache.categories.income : Cache.categories.expense;
    arr.push({ name, icon: selectedCategoryIcon });
    updateCategorySelect(currentCategorySelect, currentCategoryType);
    document.getElementById('category-dialog').classList.add('hidden');
    showToast('Категория добавлена');
  } catch (e) {
    showToast('Ошибка', true);
  }
});

function showManageCategoriesDialog() {
  renderManageCategories();
  document.getElementById('manage-categories-dialog').classList.remove('hidden');
}

function renderManageCategories() {
  const container = document.getElementById('categories-list-container');
  let html = `<p class="text-xs text-gray-400 mb-2">Расходы</p>`;
  Cache.categories.expense.forEach(cat => {
    const isDefault = ['Продукты', 'Транспорт', 'Жилье', 'Развлечения', 'Другое'].includes(cat.name);
    html += `
      <div class="flex justify-between items-center py-2 border-b border-gray-700">
        <span>${cat.icon} ${escapeHtml(cat.name)}</span>
        ${!isDefault ? `<button class="text-red-400 text-xs" onclick="deleteCategory('${escapeHtml(cat.name)}', 'Расход')">✕</button>` : ''}
      </div>`;
  });
  html += `<p class="text-xs text-gray-400 mt-4 mb-2">Доходы</p>`;
  Cache.categories.income.forEach(cat => {
    const isDefault = ['Зарплата', 'Другое'].includes(cat.name);
    html += `
      <div class="flex justify-between items-center py-2 border-b border-gray-700">
        <span>${cat.icon} ${escapeHtml(cat.name)}</span>
        ${!isDefault ? `<button class="text-red-400 text-xs" onclick="deleteCategory('${escapeHtml(cat.name)}', 'Доход')">✕</button>` : ''}
      </div>`;
  });
  container.innerHTML = html;
}

async function deleteCategory(name, type) {
  showDialog('Удаление', `Удалить категорию "${name}"?`, true, async () => {
    try {
      // Найти документ по name и type
      const snapshot = await getUserCol('Categories')
        .where('name', '==', name)
        .where('type', '==', type)
        .get();
      const batch = db.batch();
      snapshot.docs.forEach(doc => batch.delete(doc.ref));
      await batch.commit();

      // Обновить Cache
      const arr = type === 'Доход' ? Cache.categories.income : Cache.categories.expense;
      const index = arr.findIndex(c => c.name === name);
      if (index !== -1) arr.splice(index, 1);
      renderManageCategories();
      // Обновить все селекты категорий на странице
      document.querySelectorAll('.tx-category').forEach(select => {
        const row = select.closest('.tx-item');
        if (row) {
          const rowType = row.querySelector('.tx-type:checked').value;
          if (rowType === type) updateCategorySelect(select, type);
        }
      });
      showToast('Категория удалена');
    } catch (e) {
      showToast('Ошибка', true);
    }
  });
}

  document.getElementById('close-manage-categories').addEventListener('click', () => {
  document.getElementById('manage-categories-dialog').classList.add('hidden');
  
  // Возврат в кабинет, если открывали оттуда
  if (window._returnToProfile) {
    window._returnToProfile = false;
    openProfileModal();
  }
});

function updateCategorySelect(containerOrRow, type) {
  if (!Cache || !Cache.categories) return;
  
  const row = containerOrRow.closest ? (containerOrRow.closest('.tx-item') || containerOrRow) : containerOrRow;
  const menu = row.querySelector('.tx-category-menu');
  const input = row.querySelector('.tx-category');
  const btn = row.querySelector('.tx-category-btn');
  const label = row.querySelector('.tx-category-label');
  
  if (!menu || !input || !btn || !label) return;

  const cats = type === 'Доход' ? Cache.categories.income : Cache.categories.expense;
  const defaultCats = [
    'Продукты', 'Кафе и рестораны', 'Маркетплейсы', 'Транспорт', 'Жилье', 'Развлечения', 'Другое', 'Зарплата', 'Возврат', 'Кэшбек'
  ];

  // Генерируем пункты: список категорий с крестиками у добавленных пользователем
  let itemsHtml = cats.map(c => {
    const isCustom = !defaultCats.includes(c.name);
    return `
      <div class="flex items-center justify-between hover:bg-gray-700/80 rounded-lg px-2.5 py-1.5 transition-colors group">
        <button type="button" class="flex-1 text-left text-xs text-gray-200 flex items-center gap-2 cursor-pointer truncate min-w-0" data-cat="${escapeHtml(c.name)}" data-icon="${c.icon || '📦'}">
          <span>${c.icon || '📦'}</span>
          <span class="truncate">${escapeHtml(c.name)}</span>
        </button>
        ${isCustom ? `
          <button type="button" onclick="event.stopPropagation(); deleteCategory('${escapeHtml(c.name)}', '${type}')" class="text-gray-500 hover:text-red-400 p-1 text-[11px] leading-none ml-1.5 flex-shrink-0 cursor-pointer" title="Удалить категорию">✕</button>
        ` : ''}
      </div>
    `;
  }).join('');

  // Кнопка "+" в самом низу списка
  itemsHtml += `
    <div class="border-t border-gray-700/80 pt-1 mt-1">
      <button type="button" class="btn-add-cat-in-menu w-full text-left px-2.5 py-1.5 text-xs text-blue-400 hover:bg-gray-700/60 rounded-lg flex items-center gap-1.5 font-semibold cursor-pointer transition-colors">
        <span>+</span> <span>Добавить категорию</span>
      </button>
    </div>
  `;

  menu.innerHTML = itemsHtml;

  // Открытие меню со смарт-позиционированием (вниз / вверх)
  btn.onclick = (e) => {
    e.stopPropagation();
    const isClosed = menu.classList.contains('hidden');
    
    // Закрываем все остальные меню и сбрасываем z-index
    document.querySelectorAll('.custom-dropdown-menu').forEach(m => m.classList.add('hidden'));
    document.querySelectorAll('.tx-item').forEach(r => r.style.zIndex = '');

    if (isClosed) {
      row.style.zIndex = '30';
      smartPositionDropdown(menu, btn);
      menu.classList.remove('hidden');
    } else {
      row.style.zIndex = '';
    }
  };

  // Клик по пункту категории
  menu.querySelectorAll('button[data-cat]').forEach(itemBtn => {
    itemBtn.onclick = (e) => {
      e.stopPropagation();
      const catName = itemBtn.dataset.cat;
      const catIcon = itemBtn.dataset.icon;
      input.value = catName;
      label.innerHTML = `${catIcon} ${escapeHtml(catName)}`;
      label.classList.remove('text-gray-400');
      label.classList.add('text-white');
      menu.classList.add('hidden');
      row.style.zIndex = '';
    };
  });

  // Клик по кнопке "+ Добавить категорию"
  const addBtn = menu.querySelector('.btn-add-cat-in-menu');
  if (addBtn) {
    addBtn.onclick = (e) => {
      e.stopPropagation();
      menu.classList.add('hidden');
      row.style.zIndex = '';
      showAddCategoryDialog(type, row);
    };
  }
}

// Умное позиционирование: открывается вниз, а если снизу нет места — вверх
function smartPositionDropdown(menu, triggerBtn) {
  const rect = triggerBtn.getBoundingClientRect();
  const menuHeight = 220; // примерная высота открытого списка
  const spaceBelow = window.innerHeight - rect.bottom;

  if (spaceBelow < menuHeight && rect.top > menuHeight) {
    menu.style.bottom = 'calc(100% + 4px)';
    menu.style.top = 'auto';
  } else {
    menu.style.top = 'calc(100% + 4px)';
    menu.style.bottom = 'auto';
  }
}

function processDeposits(deposits, goals) {
  const goalsMap = {};
  goals.forEach(g => goalsMap[g.id] = g.name || '');
  return deposits.map(dep => {
    const amount = parseFloat(dep.amount) || 0;
    const rate = parseFloat(dep.rate) || 0;
    const endDate = dep.endDate ? new Date(dep.endDate) : new Date();
    const startDate = dep.startDate ? new Date(dep.startDate) : new Date();

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const end = new Date(endDate);
    end.setHours(0, 0, 0, 0);
    const isClosed = dep.status === 'Закрыт' || today > end;

    const totalDays = Math.max(1, Math.round((endDate - startDate) / 86400000));
    const daysPassed = isClosed ? totalDays : Math.max(0, Math.min(Math.round((new Date() - startDate) / 86400000), totalDays));
    const goalIdStr = isClosed ? '' : (dep.goalId || '');

    return {
      id: dep.id,
      name: dep.name,
      amount,
      rate,
      goalId: goalIdStr,
      goalName: goalsMap[goalIdStr] || '',
      currentInterest: daysPassed * (amount * (rate / 100) / 365),
      expectedInterest: totalDays * (amount * (rate / 100) / 365),
      progress: Math.min(100, (daysPassed / totalDays) * 100).toFixed(1),
      endDateStr: formatDateStr(dep.endDate, 'dd.MM.yyyy'),
      rawStart: dep.startDate,
      rawEnd: dep.endDate,
      isClosed
    };
  });
}

function processBroker(ops, goals) {
  const goalsMap = {};
  goals.forEach(g => goalsMap[g.id] = g.name || '');
  let goalId = '';
  let totalDeposits = 0;
  const depositList = [];
  const points = [];

  ops.forEach(o => {
    if (o.type === 'Цель') {
      goalId = o.goalId || '';
      return;
    }
    const rawDate = o.date || new Date().toISOString().split('T')[0];
    const ds = formatDateStr(rawDate, 'dd.MM');
    const fullDate = formatDateStr(rawDate, 'dd.MM.yyyy');
    const timestamp = new Date(rawDate).getTime();

    if (o.type === 'Пополнение') {
      const depAmount = parseFloat(o.amount) || 0;
      const balAfter = parseFloat(o.balance !== undefined ? o.balance : o.amount) || 0;
      totalDeposits += depAmount;

      depositList.push({
        id: o.id,
        date: rawDate,
        formattedDate: fullDate,
        amount: depAmount,
        balance: balAfter,
        timestamp
      });

      points.push({
        x: ds,
        fullDate,
        y: balAfter,
        type: 'Пополнение',
        depositAmount: depAmount,
        timestamp
      });
    } else if (o.type === 'Баланс') {
      const bal = parseFloat(o.balance !== undefined ? o.balance : o.amount) || 0;
      points.push({
        x: ds,
        fullDate,
        y: bal,
        type: 'Баланс',
        depositAmount: 0,
        timestamp
      });
    }
  });

  // Точки на графике сортируем строго от старых к новым
  points.sort((a, b) => a.timestamp - b.timestamp);

  // Карточки пополнений сортируем от новых к старым
  depositList.sort((a, b) => b.timestamp - a.timestamp);

  // Текущий баланс — это последняя точка по времени
  const currentBalance = points.length > 0 ? points[points.length - 1].y : 0;
  const profit = currentBalance - totalDeposits;

  return {
    balance: currentBalance,
    totalDeposits,
    profit,
    goalId,
    goalName: goalsMap[goalId] || '',
    chartData: points,
    deposits: depositList
  };
}

function processGoals(goals, deps, br) {
  return goals.map(g => {
    const tar = parseFloat(g.target) || 0;
    let saved = deps.filter(d => d.goalId === g.id).reduce((acc, d) => acc + d.amount + d.currentInterest, 0);
    if (br && br.goalId === g.id) saved += br.balance;
    return {
      id: g.id,
      name: g.name,
      target: tar,
      saved,
      progress: Math.min(100, tar > 0 ? (saved / tar) * 100 : 0).toFixed(1),
      deadlineStr: g.deadline ? formatDateStr(g.deadline, 'dd.MM.yyyy') : "Без срока",
      rawDeadline: g.deadline || "",
      isAchieved: saved >= tar
    };
  });
}

// --- НАВИГАЦИЯ, ФОРМЫ, РЕНДЕР ---
function switchTab(tab) {
  if (selectionMode) disableSelectionMode();
  ['transactions', 'deposits', 'broker', 'goals'].forEach(t => {
    document.getElementById(t + '-tab').classList.add('hidden');
    document.getElementById('nav-' + t).classList.replace('text-blue-400', 'text-gray-500');
  });
  document.getElementById(tab + '-tab').classList.remove('hidden');
  document.getElementById('nav-' + tab).classList.replace('text-gray-500', 'text-blue-400');
  if (tab === 'broker' && Cache) setTimeout(drawBrokerChart, 100);
}

function toggleForm(containerId, btnId, btnText, formId, type) {
  const formContainer = document.getElementById(containerId);
  formContainer.classList.toggle('hidden');
  if (currentEditId) {
    currentEditId = null;
    currentEditTable = null;
    document.getElementById(btnId).innerText = btnText;
  }
  if (!formContainer.classList.contains('hidden')) {
    document.getElementById(formId).reset();
    const today = new Date().toISOString().split('T')[0];
    if (type === 'tx') {
      document.getElementById('tx-items-list').innerHTML = '';
      addTxRow();
    } else if (type === 'dep') {
      document.getElementById('dep-start').value = today;
      // Автоматически выбираем первую незавершенную цель
      const firstGoal = Cache?.goals?.find(g => !g.isAchieved);
      if (firstGoal) {
        document.getElementById('dep-goal').value = firstGoal.id;
      }
    } else if (type === 'broker-add') {
      document.getElementById('broker-type').value = 'Пополнение';
      document.getElementById('broker-date').value = today;
      document.getElementById('broker-form-title').innerText = 'Пополнение счета';
      document.getElementById('broker-deposit-group').classList.remove('hidden');
      document.getElementById('broker-amount').required = true;
      document.getElementById('broker-balance-label').innerText = 'Баланс после пополнения (₽)';
    } else if (type === 'broker-bal') {
      document.getElementById('broker-type').value = 'Баланс';
      document.getElementById('broker-date').value = today;
      document.getElementById('broker-form-title').innerText = 'Отметка баланса';
      document.getElementById('broker-deposit-group').classList.add('hidden');
      document.getElementById('broker-amount').required = false;
      document.getElementById('broker-balance-label').innerText = 'Баланс на дату (₽)';
    }
  }
}

function closeForm(containerId, btnId, btnText, formId) {
  document.getElementById(containerId).classList.add('hidden');
  if (formId) document.getElementById(formId).reset();
  if (formId === 'tx-form') document.getElementById('tx-items-list').innerHTML = '';
  if (currentEditId) {
    currentEditId = null;
    currentEditTable = null;
    document.getElementById(btnId).innerText = btnText;
  }
}

function updateGoalDropdowns() {
  if (!Cache) return;
  let html = '<option value="">Без привязки к цели</option>';
  Cache.goals.forEach(g => {
    if (!g.isAchieved) html += `<option value="${g.id}">${g.name}</option>`;
  });
  document.getElementById('dep-goal').innerHTML = html;
  document.getElementById('broker-goal-select').innerHTML = html;
}

function addTxRow() {
  const clone = document.getElementById('tx-row-template').content.cloneNode(true);
  const uid = 'type_' + Math.random().toString(36).substr(2, 9);
  const radios = clone.querySelectorAll('.tx-type');
  radios[0].name = uid;
  radios[1].name = uid;

  const row = clone.querySelector('.tx-item');

  // Проверяем, есть ли уже добавленные строки транзакций
  const existingRows = document.querySelectorAll('#tx-items-list .tx-item');
  const prevRow = existingRows.length > 0 ? existingRows[existingRows.length - 1] : null;

  // Дата: берем из предыдущей строки, иначе ставим сегодняшнюю
  const prevDate = prevRow ? prevRow.querySelector('.tx-date').value : '';
  row.querySelector('.tx-date').value = prevDate || new Date().toISOString().split('T')[0];

  // Тип (Расход/Доход): копируем из предыдущей строки
  const prevType = prevRow ? prevRow.querySelector('.tx-type:checked')?.value : null;
  if (prevType) {
    const radioToSelect = row.querySelector(`.tx-type[value="${prevType}"]`);
    if (radioToSelect) radioToSelect.checked = true;
  }

  // Обработчики переключения типа для обновления категорий
  row.querySelectorAll('.tx-type').forEach(input => {
    input.addEventListener('change', (e) => {
      const select = row.querySelector('.tx-category');
      updateCategorySelect(select, e.target.value);
    });
  });

  // Инициализация категорий
  const currentType = row.querySelector('.tx-type:checked').value;
  const select = row.querySelector('.tx-category');
  updateCategorySelect(select, currentType);

  // Категория: копируем из предыдущей строки
  if (prevRow && prevType === currentType) {
    const prevCat = prevRow.querySelector('.tx-category').value;
    if (prevCat) select.value = prevCat;
  }

  document.getElementById('tx-items-list').appendChild(row);
}

function submitTransactions(e) {
  e.preventDefault();
  const rows = document.querySelectorAll('.tx-item');
  if (rows.length === 0) return showDialog('Ошибка', 'Добавьте хотя бы одну операцию', false);
  if (currentEditId) {
    submitAction('tx-submit-btn', 'Transactions', {
      type: rows[0].querySelector('.tx-type:checked').value,
      amount: getUnformattedVal(rows[0].querySelector('.tx-amount')),
      date: rows[0].querySelector('.tx-date').value,
      category: rows[0].querySelector('.tx-category').value,
      comment: rows[0].querySelector('.tx-comment').value
    });
  } else {
    submitAction('tx-submit-btn', 'Transactions', Array.from(rows).map(row => ({
      type: row.querySelector('.tx-type:checked').value,
      amount: getUnformattedVal(row.querySelector('.tx-amount')),
      date: row.querySelector('.tx-date').value,
      category: row.querySelector('.tx-category').value,
      comment: row.querySelector('.tx-comment').value
    })));
  }
}

function editTx(id, type, amount, cat, comment, rawDate) {
  currentEditId = id;
  currentEditTable = 'Transactions';
  document.getElementById('tx-form-container').classList.remove('hidden');
  document.getElementById('tx-items-list').innerHTML = '';
  addTxRow();
  const row = document.querySelector('.tx-item');
  row.querySelector('.tx-type[value="' + type + '"]').checked = true;
  row.querySelector('.tx-amount').value = amount;
  formatSumInput(row.querySelector('.tx-amount'));
  row.querySelector('.tx-date').value = rawDate;
  updateCategorySelect(row.querySelector('.tx-category'), type);
  row.querySelector('.tx-category').value = cat;
  row.querySelector('.tx-comment').value = (comment && comment !== 'undefined') ? comment : '';
  document.getElementById('tx-submit-btn').innerText = 'Сохранить изменения';
  window.scrollTo(0, 0);
}


let currentFilterMonth = 'all';
let currentFilterCategory = 'all';

function toggleCustomFilterMenu(type) {
  const monthMenu = document.getElementById('menu-filter-month');
  const catMenu = document.getElementById('menu-filter-cat');

  if (type === 'month') {
    monthMenu.classList.toggle('hidden');
    catMenu.classList.add('hidden');
  } else {
    catMenu.classList.toggle('hidden');
    monthMenu.classList.add('hidden');
  }
}

// Закрываем меню при клике снаружи
document.addEventListener('click', (e) => {
  if (!e.target.closest('#wrap-filter-month') && !e.target.closest('#wrap-filter-cat')) {
    const mm = document.getElementById('menu-filter-month');
    const cm = document.getElementById('menu-filter-cat');
    if (mm) mm.classList.add('hidden');
    if (cm) cm.classList.add('hidden');
  }
});

function selectFilterValue(type, value, label) {
  if (type === 'month') {
    currentFilterMonth = value;
    document.getElementById('label-filter-month').textContent = label;
    document.getElementById('menu-filter-month').classList.add('hidden');
  } else {
    currentFilterCategory = value;
    document.getElementById('label-filter-cat').textContent = label;
    document.getElementById('menu-filter-cat').classList.add('hidden');
  }
  renderTransactions();
}

function renderTransactions() {
  const data = Cache.transactions || [];
  const curMonth = data.find(m => m.id === formatDateStr(new Date(), 'yyyy-MM')) || { expense: 0, income: 0 };

  document.getElementById('month-expense').innerText = formatMoney(curMonth.expense);
  document.getElementById('month-income').innerText = formatMoney(curMonth.income);

  // Наполняем пункты выпадающих меню
  const monthMenu = document.getElementById('menu-filter-month');
  const catMenu = document.getElementById('menu-filter-cat');

  if (monthMenu && data.length > 0) {
    let mHtml = `
      <button type="button" onclick="selectFilterValue('month', 'all', 'Все месяцы')" class="w-full text-left px-3 py-2 text-xs rounded-xl transition-colors ${currentFilterMonth === 'all' ? 'bg-blue-600/20 text-blue-300 font-semibold' : 'text-gray-300 hover:bg-gray-700/60'}">
        Все месяцы
      </button>
    `;
    data.forEach(m => {
      const active = (currentFilterMonth === m.id);
      mHtml += `
        <button type="button" onclick="selectFilterValue('month', '${m.id}', '${escapeHtml(m.label)}')" class="w-full text-left px-3 py-2 text-xs rounded-xl transition-colors ${active ? 'bg-blue-600/20 text-blue-300 font-semibold' : 'text-gray-300 hover:bg-gray-700/60'}">
          ${escapeHtml(m.label)}
        </button>
      `;
    });
    monthMenu.innerHTML = mHtml;
  }

  if (catMenu && Cache.categories) {
    const allCats = [
      ...Cache.categories.expense.map(c => ({ name: c.name, icon: c.icon || '📦' })),
      ...Cache.categories.income.map(c => ({ name: c.name, icon: c.icon || '💼' }))
    ];
    // Уникальные категории
    const map = new Map();
    allCats.forEach(c => { if (!map.has(c.name)) map.set(c.name, c.icon); });

    let cHtml = `
      <button type="button" onclick="selectFilterValue('cat', 'all', 'Все категории')" class="w-full text-left px-3 py-2 text-xs rounded-xl transition-colors ${currentFilterCategory === 'all' ? 'bg-blue-600/20 text-blue-300 font-semibold' : 'text-gray-300 hover:bg-gray-700/60'}">
        Все категории
      </button>
    `;
    Array.from(map.entries()).sort((a,b) => a[0].localeCompare(b[0])).forEach(([name, icon]) => {
      const active = (currentFilterCategory === name);
      cHtml += `
        <button type="button" onclick="selectFilterValue('cat', '${escapeHtml(name)}', '${icon} ${escapeHtml(name)}')" class="w-full text-left px-3 py-2 text-xs rounded-xl transition-colors flex items-center gap-2 ${active ? 'bg-blue-600/20 text-blue-300 font-semibold' : 'text-gray-300 hover:bg-gray-700/60'}">
          <span>${icon}</span>
          <span class="truncate">${escapeHtml(name)}</span>
        </button>
      `;
    });
    catMenu.innerHTML = cHtml;
  }

  // Фильтруем данные
  let filteredMonths = data.map(m => {
    if (currentFilterMonth !== 'all' && m.id !== currentFilterMonth) return null;

    let items = m.items;
    if (currentFilterCategory !== 'all') {
      items = items.filter(tx => tx.category === currentFilterCategory);
    }

    if (items.length === 0) return null;

    return { ...m, items };
  }).filter(Boolean);

  if (filteredMonths.length === 0) {
    document.getElementById('transactions-list').innerHTML =
      '<div class="text-center text-gray-500 py-10 text-xs">Операции не найдены</div>';
    return;
  }

  document.getElementById('transactions-list').innerHTML = filteredMonths.map(month => `
    <div class="pt-2 pb-1 border-b border-gray-800 flex justify-between items-end">
      <h3 class="font-bold text-gray-400 text-xs uppercase tracking-wider">${month.label}</h3>
      <span class="text-[10px] text-gray-500">
        Доход: ${formatMoney(month.income)} | Расход: ${formatMoney(month.expense)}
      </span>
    </div>

    <div class="space-y-3 mt-3">
      ${month.items.map(tx => {
        const isExp = tx.type === 'Расход';

        return `
          <div class="card transaction-card bg-gray-800 rounded-2xl border border-gray-700 relative"
               data-id="${tx.id}"
               data-table="Transactions">

            <input type="checkbox"
                   class="select-checkbox"
                   data-id="${tx.id}">

            <button
              onclick="deleteRecord('Transactions','${tx.id}')"
              class="delete-btn tx-delete-btn"
              title="Удалить"
              aria-label="Удалить операцию">✕</button>

            <div class="tx-main-info">
              <p class="tx-category">
                ${(() => {
                  const cat = Cache.categories[
                    tx.type === 'Расход' ? 'expense' : 'income'
                  ]?.find(c => c.name === tx.category);

                  return cat
                    ? `<span class="tx-category__icon">${cat.icon}</span>`
                    : '';
                })()}
                <span>${escapeHtml(tx.category)}</span>
              </p>

              <p class="tx-meta">
                ${tx.formattedDate}${tx.comment ? ' • ' + escapeHtml(tx.comment) : ''}
              </p>
            </div>

            <p class="tx-amount ${isExp ? 'text-white' : 'text-emerald-400'}">
              ${isExp ? '-' : '+'}${formatMoney(tx.amount)}
            </p>

            <button
              onclick="editTx('${tx.id}','${tx.type}',${tx.amount},'${escapeHtml(tx.category)}','${escapeHtml(tx.comment)}','${tx.rawDate}')"
              class="tx-edit-btn"
              aria-label="Редактировать">✎</button>

          </div>
        `;
      }).join('')}
    </div>
  `).join('');
}

function switchTransactionView(view) {
  const isChart = view === 'chart';
  const list = document.getElementById('transactions-list-wrap') || document.getElementById('transactions-list');
  const chart = document.getElementById('transactions-chart');
  const listBtn = document.getElementById('view-list-btn');
  const chartBtn = document.getElementById('view-chart-btn');

  list.classList.toggle('hidden', isChart);
  chart.classList.toggle('hidden', !isChart);
  listBtn.classList.toggle('is-active', !isChart);
  chartBtn.classList.toggle('is-active', isChart);
  listBtn.setAttribute('aria-selected', String(!isChart));
  chartBtn.setAttribute('aria-selected', String(isChart));

  if (isChart) {
    requestAnimationFrame(() => buildCharts());
  }
}

let currentAnalyticsMonthIndex = 0;

function buildCharts() {
  if (!Cache || !Cache.transactions) return;
  const months = Cache.transactions;
  if (!months.length) return;

  const chronological = months.slice().reverse();
  const lastMonths = chronological.slice(-8);
  const labels = lastMonths.map(m => m.label);
  const expenses = lastMonths.map(m => Number(m.expense) || 0);
  const incomes = lastMonths.map(m => Number(m.income) || 0);

  const ctx = document.getElementById('monthlyExpensesChart').getContext('2d');
  if (monthlyChartObj) monthlyChartObj.destroy();

  monthlyChartObj = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Доходы',
          data: incomes,
          backgroundColor: 'rgba(54,214,155,.88)',
          borderColor: '#36d69b',
          borderWidth: 0,
          borderRadius: 7,
          borderSkipped: false,
          barPercentage: .72,
          categoryPercentage: .62
        },
        {
          label: 'Расходы',
          data: expenses,
          backgroundColor: 'rgba(255,111,125,.88)',
          borderColor: '#ff6f7d',
          borderWidth: 0,
          borderRadius: 7,
          borderSkipped: false,
          barPercentage: .72,
          categoryPercentage: .62
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 450, easing: 'easeOutQuart' },
      interaction: { mode: 'index', intersect: true },
      scales: {
        x: {
          stacked: false,
          grid: { display: false },
          border: { display: false },
          ticks: { color: '#737d89', font: { size: 10, weight: '600' }, maxRotation: 0, autoSkip: true, maxTicksLimit: 6 }
        },
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(255,255,255,.055)' },
          border: { display: false },
          ticks: { color: '#737d89', font: { size: 10 }, padding: 7, maxTicksLimit: 6, callback: v => formatCompactChartMoney(v) }
        }
      },
      plugins: {
        legend: {
          position: 'top', align: 'start',
          labels: { color: '#aeb6c1', usePointStyle: true, pointStyle: 'circle', boxWidth: 8, boxHeight: 8, padding: 16, font: { size: 11, weight: '650' } }
        },
        datalabels: { display: false },
        tooltip: {
          backgroundColor: '#1b222a', borderColor: 'rgba(255,255,255,.10)', borderWidth: 1,
          titleColor: '#fff', bodyColor: '#c9ced5', padding: 11, cornerRadius: 12,
          callbacks: { label: context => `${context.dataset.label}: ${formatMoney(context.raw)}` }
        }
      }
    }
  });

  // Запуск отображения текущего выбранного месяца
  updateAnalyticsMonthView();
}

function updateAnalyticsMonthView() {
  const months = Cache?.transactions || [];
  if (!months.length) return;

  currentAnalyticsMonthIndex = Math.max(0, Math.min(months.length - 1, currentAnalyticsMonthIndex));
  const cur = months[currentAnalyticsMonthIndex];

  document.getElementById('analytics-month-label').textContent = cur.label;
  document.getElementById('prev-month-btn').disabled = (currentAnalyticsMonthIndex >= months.length - 1);
  document.getElementById('next-month-btn').disabled = (currentAnalyticsMonthIndex <= 0);

  updateAnalyticsForMonth(cur.id);
}

function changeAnalyticsMonth(direction) {
  const months = Cache?.transactions || [];
  if (!months.length) return;
  currentAnalyticsMonthIndex += direction;
  updateAnalyticsMonthView();
}

function formatCompactChartMoney(value) {
  if (Math.abs(value) >= 1000000) return (value / 1000000).toFixed(value % 1000000 ? 1 : 0) + ' млн';
  if (Math.abs(value) >= 1000) return Math.round(value / 1000) + 'k';
  return value;
}

let currentStructureType = 'Расход'; // 'Расход' или 'Доход'

function switchStructureType(type) {
  currentStructureType = type;
  
  const expBtn = document.getElementById('struct-type-expense');
  const incBtn = document.getElementById('struct-type-income');
  if (expBtn && incBtn) {
    if (type === 'Расход') {
      expBtn.className = 'px-2.5 py-1 text-[11px] font-semibold rounded-lg bg-gray-700 text-white transition-all';
      incBtn.className = 'px-2.5 py-1 text-[11px] font-semibold rounded-lg text-gray-400 hover:text-white transition-all';
    } else {
      incBtn.className = 'px-2.5 py-1 text-[11px] font-semibold rounded-lg bg-emerald-600 text-white transition-all';
      expBtn.className = 'px-2.5 py-1 text-[11px] font-semibold rounded-lg text-gray-400 hover:text-white transition-all';
    }
  }

  const titleEl = document.getElementById('structure-title');
  if (titleEl) {
    titleEl.textContent = type === 'Расход' ? 'Куда уходят деньги' : 'Источники доходов';
  }

  const months = Cache?.transactions || [];
  if (months.length > 0) {
    const curMonth = months[currentAnalyticsMonthIndex] || months[0];
    updateAnalyticsForMonth(curMonth.id);
  }
}

function updateAnalyticsForMonth(monthId) {
  const month = Cache.transactions.find(m => m.id === monthId);
  if (!month) return;

  const income = Number(month.income) || 0;
  const expense = Number(month.expense) || 0;
  const balance = income - expense;
  const rate = income > 0 ? Math.round((expense / income) * 100) : 0;

  const incomeEl = document.getElementById('analytics-income');
  const expenseEl = document.getElementById('analytics-expense');
  const balanceEl = document.getElementById('analytics-month-balance');
  const rateEl = document.getElementById('analytics-rate');
  if (incomeEl) incomeEl.textContent = formatMoney(income);
  if (expenseEl) expenseEl.textContent = formatMoney(expense);
  if (balanceEl) {
    balanceEl.textContent = `${balance >= 0 ? '+' : ''}${formatMoney(balance)}`;
    balanceEl.classList.toggle('is-negative', balance < 0);
  }
  if (rateEl) rateEl.textContent = income > 0 ? `${rate}% дохода` : 'Нет дохода';

  // Фильтруем категории по выбранному типу (Расход или Доход)
  const catMap = {};
  month.items.filter(tx => tx.type === currentStructureType).forEach(tx => {
    catMap[tx.category] = (catMap[tx.category] || 0) + (Number(tx.amount) || 0);
  });

  const entries = Object.entries(catMap).sort((a,b) => b[1] - a[1]);
  const labels = entries.map(([label]) => label);
  const data = entries.map(([,value]) => value);
  const colors = currentStructureType === 'Расход' 
    ? ['#7b83ff', '#ff6f7d', '#f3b65a', '#a878ff', '#ef79b4', '#36bfc0', '#f58b55']
    : ['#36d69b', '#3b82f6', '#10b981', '#6366f1', '#14b8a6', '#8b5cf6'];
  const total = data.reduce((sum, value) => sum + value, 0);

  const totalEl = document.getElementById('category-total');
  const centerLabelEl = document.getElementById('donut-center-label');
  const legendEl = document.getElementById('category-legend');
  
  if (totalEl) totalEl.textContent = formatMoney(total);
  if (centerLabelEl) centerLabelEl.textContent = currentStructureType === 'Расход' ? 'Расходы' : 'Доходы';

  if (legendEl) {
    legendEl.innerHTML = entries.length ? entries.map(([label, value], i) => `
      <div class="category-legend__item">
        <span class="category-legend__dot" style="background:${colors[i % colors.length]}"></span>
        <span class="category-legend__name">${escapeHtml(label)}</span>
        <span class="category-legend__value">${formatMoney(value)}</span>
        <span class="category-legend__percent">${total ? Math.round(value / total * 100) : 0}%</span>
      </div>`).join('') : `<div class="analytics-empty">Нет ${currentStructureType === 'Расход' ? 'расходов' : 'доходов'} за этот месяц</div>`;
  }

  const ctx = document.getElementById('categoryExpensesChart').getContext('2d');
  if (categoryChartObj) categoryChartObj.destroy();
  categoryChartObj = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: data.length ? labels : ['Нет данных'],
      datasets: [{
        data: data.length ? data : [1],
        backgroundColor: data.length ? colors.slice(0, data.length) : ['#303740'],
        borderColor: '#171d24',
        borderWidth: 3,
        hoverOffset: 5
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '72%',
      animation: { duration: 450 },
      plugins: {
        legend: { display: false },
        datalabels: { display: false },
        tooltip: {
          backgroundColor: '#1b222a', borderColor: 'rgba(255,255,255,.10)', borderWidth: 1,
          titleColor: '#fff', bodyColor: '#c9ced5', padding: 10, cornerRadius: 11,
          callbacks: { label: context => `${context.label}: ${formatMoney(context.raw)}` }
        }
      }
    }
  });
}

  function drawBrokerChart() {
  const br = Cache?.broker;
  const canvas = document.getElementById('brokerChart');
  if (!canvas) return;

  const data = br?.chartData || [];
  const ctx = canvas.getContext('2d');

  if (brokerChartObj) {
    brokerChartObj.destroy();
    brokerChartObj = null;
  }

  if (data.length === 0) return;

  brokerChartObj = new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.map(d => d.x),
      datasets: [{
        label: 'Баланс',
        data: data.map(d => d.y),
        borderColor: '#7b83ff',
        backgroundColor: 'rgba(123, 131, 255, 0.12)',
        borderWidth: 2,
        fill: true,
        tension: 0.2,
        // Точки пополнения делаем крупнее и зелёными
        pointRadius: data.map(d => d.type === 'Пополнение' ? 6 : 4),
        pointHoverRadius: data.map(d => d.type === 'Пополнение' ? 8 : 6),
        pointBackgroundColor: data.map(d => d.type === 'Пополнение' ? '#36d69b' : '#7b83ff'),
        pointBorderColor: data.map(d => d.type === 'Пополнение' ? '#ffffff' : '#171d24'),
        pointBorderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'nearest',
        intersect: false
      },
      events: ['mousemove', 'mouseout', 'click', 'touchstart', 'touchmove'],
      plugins: {
        legend: { display: false },
        datalabels: { display: false },
        tooltip: {
          backgroundColor: '#1b222a',
          borderColor: 'rgba(255, 255, 255, 0.12)',
          borderWidth: 1,
          titleColor: '#ffffff',
          bodyColor: '#c9ced5',
          padding: 10,
          cornerRadius: 12,
          displayColors: false,
          callbacks: {
            title: (items) => {
              if (!items.length) return '';
              const pt = data[items[0].dataIndex];
              return pt ? pt.fullDate : '';
            },
            label: (context) => {
              const pt = data[context.dataIndex];
              if (!pt) return '';
              const lines = [`Баланс: ${formatMoney(pt.y)}`];
              if (pt.type === 'Пополнение' && pt.depositAmount > 0) {
                lines.push(`Пополнение: +${formatMoney(pt.depositAmount)}`);
              }
              return lines;
            }
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,0.05)' },
          ticks: { color: '#8d97a4', font: { size: 10 } }
        },
        y: {
          grid: { color: 'rgba(255,255,255,0.05)' },
          ticks: {
            color: '#8d97a4',
            font: { size: 10 },
            callback: v => formatCompactChartMoney(v)
          }
        }
      }
    }
  });
}

function submitDeposit(e) {
  e.preventDefault();
  submitAction('dep-submit-btn', 'Deposits', {
    name: document.getElementById('dep-name').value,
    amount: getUnformattedVal(document.getElementById('dep-amount')),
    rate: getUnformattedVal(document.getElementById('dep-rate')),
    startDate: document.getElementById('dep-start').value,
    endDate: document.getElementById('dep-end').value,
    goalId: document.getElementById('dep-goal').value,
    status: 'Активен'
  });
}

function editDep(id, name, amount, rate, start, end, goalId) {
  currentEditId = id;
  currentEditTable = 'Deposits';
  document.getElementById('dep-name').value = name;
  setFormattedVal('dep-amount', amount);
  setFormattedVal('dep-rate', rate);
  document.getElementById('dep-start').value = start;
  document.getElementById('dep-end').value = end;
  document.getElementById('dep-goal').value = goalId || '';
  document.getElementById('dep-submit-btn').innerText = 'Сохранить изменения';
  document.getElementById('deposit-form-container').classList.remove('hidden');
  window.scrollTo(0, 0);
}

function renderDeposits() {
  const data = Cache.deposits || [];

  if (data.length === 0) {
    document.getElementById('deposits-list').innerHTML =
      '<div class="text-center text-gray-500 py-4">Вкладов нет</div>';
    return;
  }

  const active = data.filter(d => !d.isClosed);
  const closed = data.filter(d => d.isClosed);

  let html = '';

  const renderCard = (dep, isCls) => `
    <div
      class="card deposit-card ${isCls ? 'opacity-60 grayscale' : ''}"
      data-id="${dep.id}"
      data-table="Deposits">

      <input
        type="checkbox"
        class="select-checkbox"
        data-id="${dep.id}">

      <button
        onclick="deleteRecord('Deposits','${dep.id}')"
        class="delete-btn deposit-delete-btn"
        title="Удалить"
        aria-label="Удалить вклад">✕</button>

      ${dep.goalName ? `
        <div class="deposit-goal-badge">
          Цель: ${escapeHtml(dep.goalName)}
        </div>
      ` : ''}

      <div class="deposit-main">
        <h3>${escapeHtml(dep.name)}</h3>
        <p>
          ${isCls ? 'Закрыт ' : 'До '}
          ${dep.endDateStr} • ${dep.rate}%
        </p>
      </div>

      <p class="deposit-amount">
        ${formatMoney(dep.amount)}
      </p>

      ${!isCls ? `
        <button
          onclick="editDep('${dep.id}','${escapeHtml(dep.name)}',${dep.amount},${dep.rate},'${dep.rawStart}','${dep.rawEnd}','${dep.goalId}')"
          class="deposit-edit-btn"
          aria-label="Редактировать">✎</button>
      ` : ''}

      <div class="deposit-interest">
        <p class="deposit-current-interest">
          +${formatMoney(dep.currentInterest)}
        </p>

        <p class="deposit-expected-interest">
          +${formatMoney(dep.expectedInterest)}
        </p>
      </div>

      <div class="deposit-progress">
        <div style="width:${dep.progress}%"></div>
      </div>

    </div>
  `;

  if (active.length > 0) {
    html += `
      <h3 class="deposit-section-title">
        Активные
      </h3>
    `;

    html += active.map(d => renderCard(d, false)).join('');
  }

  if (closed.length > 0) {
    html += `
      <h3 class="deposit-section-title deposit-section-title--closed">
        Завершенные
      </h3>
    `;

    html += closed.map(d => renderCard(d, true)).join('');
  }

  document.getElementById('deposits-list').innerHTML = html;
}

function submitBrokerOperation(e) {
  e.preventDefault();
  const type = document.getElementById('broker-type').value;
  const date = document.getElementById('broker-date').value;
  const balance = getUnformattedVal(document.getElementById('broker-balance-input'));
  const amount = type === 'Пополнение' 
    ? getUnformattedVal(document.getElementById('broker-amount')) 
    : balance;

  submitAction('broker-submit-btn', 'Broker', {
    type,
    date,
    amount,
    balance
  });
}

function submitBrokerGoal(e) {
  e.preventDefault();
  const g = document.getElementById('broker-goal-select').value;
  if (!g) return showDialog('Внимание', 'Выберите цель', false);
  submitAction('broker-goal-btn', 'Broker', {
    type: 'Цель',
    date: new Date().toISOString().split('T')[0],
    goalId: g
  });
}

function renderBroker() {
  const br = Cache?.broker;
  if (!br) return;
  document.getElementById('broker-balance').innerText = formatMoney(br.balance);
  document.getElementById('broker-deposits').innerText = formatMoney(br.totalDeposits);
  const p = document.getElementById('broker-profit');
  p.innerText = (br.profit > 0 ? '+' : '') + formatMoney(br.profit);
  p.className = `text-xs font-bold ${br.profit >= 0 ? 'text-emerald-400' : 'text-red-400'}`;
  const b = document.getElementById('broker-goal-badge');
  if (br.goalName) {
    b.innerText = 'Цель: ' + br.goalName;
    b.classList.remove('hidden');
  } else {
    b.classList.add('hidden');
  }

  // Отрисовка карточек пополнений под графиком
  const list = document.getElementById('broker-deposits-list');
  if (list) {
    const deps = br.deposits || [];
    if (deps.length === 0) {
      list.innerHTML = '<div class="text-center text-gray-500 py-3 text-xs">Пополнений пока нет</div>';
    } else {
      list.innerHTML = `
        <h3 class="text-xs uppercase font-bold tracking-wider text-gray-400 mt-4 mb-2">История пополнений</h3>
        <div class="space-y-2.5">
          ${deps.map(d => `
            <div class="card bg-gray-800 rounded-2xl border border-gray-700 p-3.5 flex justify-between items-center" data-id="${d.id}" data-table="Broker">
              <div>
                <p class="text-sm font-bold text-emerald-400">+${formatMoney(d.amount)}</p>
                <p class="text-[11px] text-gray-400 mt-0.5">${d.formattedDate} • Баланс: ${formatMoney(d.balance)}</p>
              </div>
              <button onclick="deleteRecord('Broker','${d.id}')" class="delete-btn text-gray-500 hover:text-red-400 p-2 text-sm leading-none" title="Удалить" aria-label="Удалить пополнение">✕</button>
            </div>
          `).join('')}
        </div>
      `;
    }
  }

  // Обновляем график, если вкладка открыта
  const brokerTab = document.getElementById('broker-tab');
  if (brokerTab && !brokerTab.classList.contains('hidden')) {
    drawBrokerChart();
  }
}

function submitGoal(e) {
  e.preventDefault();
  submitAction('goal-submit-btn', 'Goals', {
    name: document.getElementById('goal-name').value,
    target: getUnformattedVal(document.getElementById('goal-target')),
    deadline: document.getElementById('goal-deadline').value,
    status: 'В процессе'
  });
}

function editGoal(id, name, target, deadline) {
  currentEditId = id;
  currentEditTable = 'Goals';
  document.getElementById('goal-name').value = name;
  setFormattedVal('goal-target', target);
  document.getElementById('goal-deadline').value = deadline;
  document.getElementById('goal-submit-btn').innerText = 'Сохранить изменения';
  document.getElementById('goal-form-container').classList.remove('hidden');
  window.scrollTo(0, 0);
}

function renderGoals() {
  const data = Cache.goals || [];
  if (data.length === 0) {
    document.getElementById('goals-list').innerHTML = '<div class="text-center text-gray-500 py-4">Целей нет</div>';
    return;
  }
  document.getElementById('goals-list').innerHTML = data.map(g => `
        <div class="card goal-card" data-id="${g.id}" data-table="Goals">
      <input type="checkbox" class="select-checkbox" data-id="${g.id}">

      <button
        onclick="deleteRecord('Goals','${g.id}')"
        class="goal-delete-btn"
        title="Удалить"
      >✕</button>

      <div class="goal-main">
        <h3>${escapeHtml(g.name)}</h3>
        ${g.isAchieved
          ? '<span class="goal-status goal-status--achieved">Достигнута</span>'
          : `<span class="goal-date">До ${escapeHtml(g.deadlineStr)}</span>`}
      </div>

      <div class="goal-progress-value">${g.progress}%</div>

      <button
        onclick="editGoal('${g.id}','${escapeHtml(g.name)}',${g.target},'${escapeHtml(g.rawDeadline)}')"
        class="goal-edit-btn"
        title="Редактировать"
      >✎</button>

      <div class="goal-progress">
        <div
          class="${g.isAchieved ? 'goal-progress-fill goal-progress-fill--achieved' : 'goal-progress-fill'}"
          style="width:${g.progress}%"
        ></div>
      </div>

      <div class="goal-amounts">
        <span>${formatMoney(g.saved)}</span>
        <span>из ${formatMoney(g.target)}</span>
      </div>
    </div>`).join('');
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ==================== РЕЖИМ МУЛЬТИВЫДЕЛЕНИЯ ====================
let selectionMode = false;
let selectedItems = new Set(); // ключи вида "table:id"
let longPressTimer = null;
let longPressTriggered = false;
let suppressClick = false;
let currentCategoryType = 'Расход';
let currentCategorySelect = null;
let selectedCategoryIcon = '📦';
const availableIcons = [
  '🍔', '🚗', '🏠', '🎬', '📦', '💼', '🎓', '👶', '🐾', '💊',
  '🛒', '✈️', '🏋️', '🎮', '📚', '🎵', '🎁', '☕', '🍕', '👕',
  '💡', '🔧', '📱', '💻', '🖥️', '📷', '🎨', '🎸', '⚽', '🏀',
  '🚌', '🚇', '🚕', '⛽', '🛁', '🧹', '🧺', '🪴', '🌍', '💳'
];

function enableSelectionMode() {
  selectionMode = true;
  document.body.classList.add('selection-mode');

  let panel = document.getElementById('selection-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'selection-panel';
    panel.className = 'selection-panel';
    panel.innerHTML = `
      <div class="selection-panel__info">
        <span class="selection-panel__dot"></span>
        <span id="selected-count">Выбрано: 0</span>
      </div>
      <div class="selection-panel__actions">
        <button id="cancel-selection" type="button">Отмена</button>
        <button id="delete-selected" type="button">Удалить</button>
      </div>
    `;
    document.body.appendChild(panel);
  }
  panel.style.display = 'flex';
  document.getElementById('selected-count').textContent = `Выбрано: ${selectedItems.size}`;
}

function disableSelectionMode() {
  selectionMode = false;
  selectedItems.clear();
  document.body.classList.remove('selection-mode');
  const panel = document.getElementById('selection-panel');
  if (panel) panel.style.display = 'none';
  document.querySelectorAll('.card.selected').forEach(card => card.classList.remove('selected'));
  document.querySelectorAll('.select-checkbox').forEach(cb => cb.checked = false);
}

function toggleItemSelection(id, table) {
  const key = `${table}:${id}`;
  if (selectedItems.has(key)) {
    selectedItems.delete(key);
  } else {
    selectedItems.add(key);
  }
  
  const card = document.querySelector(`.card[data-id="${id}"][data-table="${table}"]`);
  if (card) {
    card.classList.toggle('selected', selectedItems.has(key));
    const checkbox = card.querySelector('.select-checkbox');
    if (checkbox) checkbox.checked = selectedItems.has(key);
  }
  
  // Обновляем счётчик
  document.getElementById('selected-count').textContent = `Выбрано: ${selectedItems.size}`;
  
  // Если не осталось выбранных элементов — выключаем режим выбора
  if (selectedItems.size === 0 && selectionMode) {
    disableSelectionMode();
  }
}

function cancelSelection() {
  disableSelectionMode();
}

async function deleteSelectedItems() {
  if (selectedItems.size === 0) return;
  showDialog('Удаление', `Удалить выбранные записи (${selectedItems.size})?`, true, async () => {
    showToast("Удаление...", false, true);
    try {
      const batch = db.batch();
      selectedItems.forEach(key => {
        const [table, id] = key.split(':');
        batch.delete(getUserCol(table).doc(id));
      });
      await batch.commit();
      disableSelectionMode();
      fetchAllData();
    } catch (e) {
      showToast("Ошибка удаления", true);
    }
  });
}

// Обработчики долгого нажатия
function startLongPress(card) {
  longPressTriggered = false;
  clearTimeout(longPressTimer);
  longPressTimer = setTimeout(() => {
    longPressTriggered = true;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 400);
    if (!selectionMode) enableSelectionMode();
    toggleItemSelection(card.dataset.id, card.dataset.table);
  }, 500);
}

function handleTouchStart(e) {
  const card = e.target.closest('.card');
  if (!card) return;
  startLongPress(card);
}

function handleTouchEnd(e) {
  clearTimeout(longPressTimer);
  if (longPressTriggered) {
    e.preventDefault(); // предотвращаем последующий click
  }
}

function handleTouchMove(e) {
  clearTimeout(longPressTimer);
}

function handleMouseDown(e) {
  const card = e.target.closest('.card');
  if (!card) return;
  startLongPress(card);
}

function handleMouseUp(e) {
  clearTimeout(longPressTimer);
}

function handleMouseMove(e) {
  clearTimeout(longPressTimer);
}

// Регистрация глобальных обработчиков
document.addEventListener('touchstart', handleTouchStart, { passive: true });
document.addEventListener('touchend', handleTouchEnd);
document.addEventListener('touchmove', handleTouchMove, { passive: true });
document.addEventListener('mousedown', handleMouseDown);
document.addEventListener('mouseup', handleMouseUp);
document.addEventListener('mousemove', handleMouseMove);

document.addEventListener('click', (e) => {
  // Игнорируем первый клик после долгого нажатия
  if (suppressClick) {
    suppressClick = false;
    return;
  }

  if (e.target.classList.contains('manage-categories-btn')) {
    showManageCategoriesDialog();
    return;
  }

  if (e.target.classList.contains('add-category-btn')) {
    const row = e.target.closest('.tx-item');
    if (!row) return;
    const type = row.querySelector('.tx-type:checked').value;
    const select = row.querySelector('.tx-category');
    showAddCategoryDialog(type, select);
    return;
  }

  // Обработка кнопок панели выбора
  if (e.target.id === 'delete-selected' || e.target.closest('#delete-selected')) {
    deleteSelectedItems();
    return;
  }
  if (e.target.id === 'cancel-selection' || e.target.closest('#cancel-selection')) {
    cancelSelection();
    return;
  }

  // Обработка кликов по карточкам в режиме выбора
  if (!selectionMode) return;
  const card = e.target.closest('.card');
  if (!card) return;

  e.preventDefault();
  toggleItemSelection(card.dataset.id, card.dataset.table);
});

// Автозаполнение словаря в Firebase при первом запуске
async function processOrSeedRules(snapshot) {
  if (!snapshot.empty) {
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  }

  // Базовый стартовый словарь для первого раза
  const defaultRules = [
    { pattern: "perek", category: "Продукты" },
    { pattern: "перекресток", category: "Продукты" },
    { pattern: "pyaterochka", category: "Продукты" },
    { pattern: "пятерочка", category: "Продукты" },
    { pattern: "okey", category: "Продукты" },
    { pattern: "окей", category: "Продукты" },
    { pattern: "lenta", category: "Продукты" },
    { pattern: "лента", category: "Продукты" },
    { pattern: "magnit", category: "Продукты" },
    { pattern: "магнит", category: "Продукты" },
    { pattern: "krasnoe", category: "Продукты" },
    { pattern: "красное и белое", category: "Продукты" },
    { pattern: "fixprice", category: "Продукты" },
    { pattern: "фикс прайс", category: "Продукты" },
    { pattern: "zhivaya voda", category: "Продукты" },
    { pattern: "vlavashe", category: "Кафе и рестораны" },
    { pattern: "rostics", category: "Кафе и рестораны" },
    { pattern: "ростикс", category: "Кафе и рестораны" },
    { pattern: "kfc", category: "Кафе и рестораны" },
    { pattern: "kimchi to go", category: "Кафе и рестораны" },
    { pattern: "mu mu burgers", category: "Кафе и рестораны" },
    { pattern: "bros burritos", category: "Кафе и рестораны" },
    { pattern: "dostaevsky", category: "Кафе и рестораны" },
    { pattern: "nesselbek", category: "Кафе и рестораны" },
    { pattern: "dom lunda", category: "Кафе и рестораны" },
    { pattern: "krem", category: "Кафе и рестораны" },
    { pattern: "kozhura", category: "Кафе и рестораны" },
    { pattern: "1st food factory", category: "Кафе и рестораны" },
    { pattern: "semenova a", category: "Кафе и рестораны" },
    { pattern: "rzd", category: "Транспорт" },
    { pattern: "ржд", category: "Транспорт" },
    { pattern: "szppk", category: "Транспорт" },
    { pattern: "сзппк", category: "Транспорт" },
    { pattern: "transkom", category: "Транспорт" },
    { pattern: "транском", category: "Транспорт" },
    { pattern: "mezhdunarodnaya", category: "Транспорт" },
    { pattern: "baltiyskaya", category: "Транспорт" },
    { pattern: "pionerskaya", category: "Транспорт" },
    { pattern: "tekhnol", category: "Транспорт" },
    { pattern: "pl. lenina", category: "Транспорт" },
    { pattern: "yandex.go", category: "Транспорт" },
    { pattern: "такси", category: "Транспорт" },
    { pattern: "muzej", category: "Развлечения" },
    { pattern: "музей", category: "Развлечения" },
    { pattern: "homlins", category: "Развлечения" },
    { pattern: "afisha", category: "Развлечения" },
    { pattern: "афиша", category: "Развлечения" },
    { pattern: "teatr", category: "Развлечения" },
    { pattern: "театр", category: "Развлечения" },
    { pattern: "shtiglitsa", category: "Развлечения" },
    { pattern: "wb", category: "Маркетплейсы" },
    { pattern: "wildberries", category: "Маркетплейсы" },
    { pattern: "ozon", category: "Маркетплейсы" },
    { pattern: "озон", category: "Маркетплейсы" },
    { pattern: "kleekstore", category: "Маркетплейсы" },
    // Доходы / Зарплата
    { pattern: "заработная плата", category: "Зарплата" },
    { pattern: "salary", category: "Зарплата" },
    { pattern: "цкбм", category: "Зарплата" }
  ];

  try {
    const batch = db.batch();
    const rules = [];
    defaultRules.forEach(rule => {
      const docRef = db.collection('CategoryRules').doc();
      batch.set(docRef, rule);
      rules.push({ id: docRef.id, ...rule });
    });
    await batch.commit();
    return rules;
  } catch (e) {
    console.error("Ошибка заполнения словаря:", e);
    return defaultRules;
  }
}

// =============================================================
// ЛИЧНЫЙ КАБИНЕТ И НАСТРОЙКИ ПОЛЬЗОВАТЕЛЯ
// =============================================================

function openProfileModal() {
  const user = auth.currentUser;
  if (!user) return;

  const dialog = document.getElementById('profile-dialog');
  const nameEl = document.getElementById('profile-username-display');
  const typeEl = document.getElementById('profile-auth-type');
  const avatarLetter = document.getElementById('profile-avatar-letter');

  const rawName = user.displayName || (user.email?.includes('@budget.local') ? user.email.replace('@budget.local', '') : user.email?.split('@')[0]) || 'Пользователь';
  
  if (nameEl) nameEl.textContent = rawName;
  if (avatarLetter) {
    avatarLetter.textContent = rawName.charAt(0).toUpperCase();
  }

  if (typeEl) {
    const isGoogle = user.providerData?.some(p => p.providerId === 'google.com');
    typeEl.textContent = isGoogle ? `Google (${user.email})` : `Никнейм: ${rawName}`;
  }

  // Обновляем состояние чекбокса брокера
  const toggle = document.getElementById('toggle-broker-setting');
  if (toggle) {
    toggle.checked = !!(Cache?.settings?.showBroker);
  }

  dialog.classList.remove('hidden');
}

function closeProfileModal() {
  const dialog = document.getElementById('profile-dialog');
  if (dialog) dialog.classList.add('hidden');
}

// Загрузка настроек пользователя из Firestore
async function loadUserSettings(user) {
  try {
    const doc = await db.collection('users').doc(user.uid).get();
    const settings = doc.data()?.settings || {};
    
    // Если настройка ещё не задана, по умолчанию брокер скрыт (как заказывали)
    const showBroker = settings.showBroker !== undefined ? settings.showBroker : false;

    if (!Cache) Cache = {};
    if (!Cache.settings) Cache.settings = {};
    Cache.settings.showBroker = showBroker;

    applyBrokerVisibility(showBroker);
  } catch (err) {
    console.error('Ошибка загрузки настроек:', err);
  }
}

// Переключение тумблера брокера в настройках
async function toggleBrokerSetting(enable) {
  const user = auth.currentUser;
  if (!user) return;

  showToast(enable ? 'Включение брокера...' : 'Скрытие брокера...', false, true);
  try {
    await db.collection('users').doc(user.uid).set({
      settings: { showBroker: enable }
    }, { merge: true });

    if (!Cache.settings) Cache.settings = {};
    Cache.settings.showBroker = enable;

    applyBrokerVisibility(enable);
    showToast(enable ? 'Раздел «Брокер» включен' : 'Раздел «Брокер» скрыт');
  } catch (e) {
    showToast('Ошибка сохранения: ' + e.message, true);
  }
}

// Применение видимости вкладки в нижней навигации
function applyBrokerVisibility(show) {
  const navBroker = document.getElementById('nav-broker');
  if (navBroker) {
    navBroker.classList.toggle('hidden', !show);
  }

  // Если пользователь находился во вкладке брокера и выключил её — переключаем на трат
  const brokerTab = document.getElementById('broker-tab');
  if (!show && brokerTab && !brokerTab.classList.contains('hidden')) {
    switchTab('transactions');
  }
}

// Публикация в window
window.openProfileModal = openProfileModal;
window.closeProfileModal = closeProfileModal;
window.toggleBrokerSetting = toggleBrokerSetting;

// Память навигации: запоминаем, если окно было вызвано из профиля
window._returnToProfile = false;

window.openSubModalFromProfile = function(type) {
  closeProfileModal(); // временно закрываем профиль
  window._returnToProfile = true; // ставим маячок возврата

  if (type === 'categories') {
    showManageCategoriesDialog();
  } else if (type === 'rules') {
    openRulesEditorModal();
  }
};
