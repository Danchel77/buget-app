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

// Включение оффлайн-кэширования IndexedDB для моментального запуска на любом интернете
if (typeof db.enablePersistence === 'function') {
  db.enablePersistence({ synchronizeTabs: true }).catch(err => {
    if (err.code !== 'failed-precondition' && err.code !== 'unimplemented') {
      console.warn('Persistence notice:', err);
    }
  });
}

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

let selectionMode = false;
let selectedTxIds = new Set();

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
    switchTab('budget');

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
const formatMoney = (sum, isInputOrDetails = false) => new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  minimumFractionDigits: isInputOrDetails ? 2 : 0, // Убираем копейки везде по умолчанию
  maximumFractionDigits: isInputOrDetails ? 2 : 0
}).format(sum).replace(',', '.'); // Использует неразрывные пробелы встроенно

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

let toastTimer = null;

function showToast(text, isError = false, keep = false) {
  const container = document.getElementById('toast-container');
  const content = document.getElementById('toast-content');
  const textEl = document.getElementById('toast-text');
  const spinner = document.getElementById('toast-spinner');
  const successIcon = document.getElementById('toast-icon-success');
  const errorIcon = document.getElementById('toast-icon-error');

  if (!container || !textEl) return;

  clearTimeout(toastTimer);
  textEl.innerText = text;

  if (isError) {
    if (spinner) spinner.style.display = 'none';
    if (successIcon) successIcon.classList.add('hidden');
    if (errorIcon) errorIcon.classList.remove('hidden');
    if (content) content.style.borderColor = 'rgba(255, 69, 58, 0.4)';
  } else if (keep) {
    if (spinner) spinner.style.display = 'block';
    if (successIcon) successIcon.classList.add('hidden');
    if (errorIcon) errorIcon.classList.add('hidden');
    if (content) content.style.borderColor = 'rgba(108, 93, 211, 0.4)';
  } else {
    if (spinner) spinner.style.display = 'none';
    if (successIcon) successIcon.classList.remove('hidden');
    if (errorIcon) errorIcon.classList.add('hidden');
    if (content) content.style.borderColor = 'rgba(48, 209, 88, 0.4)';
  }

  if (typeof lucide !== 'undefined') {
    lucide.createIcons();
  }

  container.classList.remove('hidden');

  if (!keep) {
    toastTimer = setTimeout(() => {
      container.classList.add('hidden');
    }, 2400);
  }
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
        renderBudgetTab();
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
        await fetchAllData();
        break;
    }
  } catch (e) {
    showToast("Ошибка загрузки", true);
  }
}

async function applySnapshotsToUI([txS, depS, brS, goalS, catS, rulesS, planS, billsS]) {
  const txData = txS.docs.map(d => ({ id: d.id, ...d.data() }));
  const depData = depS.docs.map(d => ({ id: d.id, ...d.data() }));
  const brData = brS.docs.map(d => ({ id: d.id, ...d.data() }));
  const goalData = goalS ? goalS.docs.map(d => ({ id: d.id, ...d.data() })) : [];
  const planData = planS && !planS.empty ? planS.docs[0].data() : {};
  const billsData = billsS ? billsS.docs.map(d => ({ id: d.id, ...d.data() })) : [];
  
  const processedDeposits = processDeposits(depData, goalData);
  const processedBroker = processBroker(brData, goalData);
  const catData = catS.docs.map(d => ({ id: d.id, ...d.data() }));
  const categories = processCategories(catData);

  const existingSettings = (Cache && Cache.settings) ? Cache.settings : {};

  Cache = {
    settings: existingSettings,
    transactions: processTransactions(txData),
    deposits: processedDeposits,
    broker: processedBroker,
    goals: processGoals(goalData),
    categories: categories,
    categoryRules: await processOrSeedRules(rulesS),
    budgetPlan: planData,
    calendarBills: billsData
  };
  window.Cache = Cache;

  updateGoalDropdowns();
  renderBudgetTab();
  renderTransactions();
  renderDeposits();
  renderBroker();
}

async function fetchAllData() {
  const tables = ['Transactions', 'Deposits', 'Broker', 'Goals', 'Categories', 'CategoryRules', 'BudgetPlan', 'CalendarBills'];

  // ЭТАП 1: Мгновенное чтение из локального кэша IndexedDB (15-40 мс)
  try {
    const cachedSnaps = await Promise.all(
      tables.map(tbl => getUserCol(tbl).get({ source: 'cache' }))
    );
    if (cachedSnaps.some(s => !s.empty)) {
      await applySnapshotsToUI(cachedSnaps);
      document.getElementById('loading-screen')?.classList.add('hidden');
    }
  } catch (e) {}

  // ЭТАП 2: Фоновая синхронизация со свежими данными сервера
  try {
    showToast("Синхронизация...", false, true);
    const serverSnaps = await Promise.all(
      tables.map(tbl => getUserCol(tbl).get())
    );
    await applySnapshotsToUI(serverSnaps);
    document.getElementById('last-sync').innerText = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    document.getElementById('toast-container')?.classList.add('hidden');
    document.getElementById('loading-screen')?.classList.add('hidden');
  } catch (err) {
    document.getElementById('toast-container')?.classList.add('hidden');
    document.getElementById('loading-screen')?.classList.add('hidden');
    if (!Cache) {
      showToast("Нет подключения к сети", true);
    }
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
    { name: 'Продукты', icon: 'shopping-cart' },
    { name: 'Кафе и рестораны', icon: 'utensils' },
    { name: 'Маркетплейсы', icon: 'shopping-bag' },
    { name: 'Транспорт', icon: 'car' },
    { name: 'Жилье', icon: 'home' },
    { name: 'Одежда', icon: 'shirt' },
    { name: 'Здоровье', icon: 'heart-pulse' },
    { name: 'Развлечения', icon: 'gamepad-2' },
    { name: 'Другое', icon: 'package' }
  ];
  const defaultIncome = [
    { name: 'Зарплата', icon: 'wallet' },
    { name: 'Возврат', icon: 'undo-2' },
    { name: 'Кэшбек', icon: 'coins' },
    { name: 'Другое', icon: 'package' }
  ];

  const expense = [...defaultExpense];
  const income = [...defaultIncome];
  cats.forEach(c => {
    let rawIcon = c.icon && c.icon.length < 5 ? 'tag' : c.icon;
    if (c.type === 'Расход') { if (!expense.some(item => item.name === c.name)) expense.push({ name: c.name, icon: rawIcon || 'tag' }); } 
    else if (c.type === 'Доход') { if (!income.push({ name: c.name, icon: rawIcon || 'tag' })) income.push({ name: c.name, icon: rawIcon || 'tag' }); }
  });
  return { expense, income };
}

function showAddCategoryDialog(type, selectEl) {
  currentCategoryType = type;
  currentCategorySelect = selectEl;
  selectedCategoryIcon = 'package';
  document.getElementById('category-dialog-title').innerText = `Новая категория (${type})`;
  document.getElementById('category-name-input').value = '';
  renderIconGrid();
  document.getElementById('category-dialog').classList.remove('hidden');
}

function renderIconGrid() {
  const grid = document.getElementById('category-icon-grid');
  
  // Вставляем векторные иконки через i
  grid.innerHTML = availableIcons.map(icon => `
    <button type="button" class="icon-option flex items-center justify-center h-[42px] rounded-xl transition-all border ${icon === selectedCategoryIcon ? 'bg-[#6C5DD3]/15 text-[#6C5DD3] border-[#6C5DD3]/30 scale-105 shadow-sm' : 'bg-[#181B24] border-[rgba(255,255,255,0.06)] text-[#848D99] hover:bg-[#212430]'}" data-icon="${icon}">
      <i data-lucide="${icon}" class="w-5 h-5"></i>
    </button>
  `).join('');

  // Заставляем Lucide нарисовать векторы в добавленном HTML
  if(typeof lucide !== 'undefined') {
    lucide.createIcons();
  }

  // Обновляем логику выбора иконки (изменение цветов Tailwind при тапе)
  grid.querySelectorAll('.icon-option').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedCategoryIcon = btn.dataset.icon;
      
      // Сбрасываем все кнопки в неактивное состояние
      grid.querySelectorAll('.icon-option').forEach(b => {
         b.classList.remove('bg-[#6C5DD3]/15', 'text-[#6C5DD3]', 'border-[#6C5DD3]/30', 'scale-105', 'shadow-sm');
         b.classList.add('bg-[#181B24]', 'border-[rgba(255,255,255,0.06)]', 'text-[#848D99]');
      });

      // Делаем нажатую кнопку активной
      btn.classList.remove('bg-[#181B24]', 'border-[rgba(255,255,255,0.06)]', 'text-[#848D99]');
      btn.classList.add('bg-[#6C5DD3]/15', 'text-[#6C5DD3]', 'border-[#6C5DD3]/30', 'scale-105', 'shadow-sm');
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
  } catch (e) {
    showToast('Ошибка', true);
  }
});

function showManageCategoriesDialog() {
  renderManageCategories();
  document.getElementById('manage-categories-dialog').classList.remove('hidden');
}

const DEFAULT_SYSTEM_CATEGORIES = [
  'Продукты', 'Кафе и рестораны', 'Маркетплейсы', 'Транспорт', 'Жилье',
  'Одежда', 'Здоровье', 'Развлечения', 'Другое', 'Зарплата', 'Возврат', 'Кэшбек'
];

function renderManageCategories() {
  const container = document.getElementById('categories-list-container');
  let html = `<p class="text-[11px] uppercase tracking-wider text-gray-500 font-bold mb-2">Расходы</p>`;
  Cache.categories.expense.forEach(cat => {
    const isDefault = DEFAULT_SYSTEM_CATEGORIES.includes(cat.name);
    const iconName = cat.icon && cat.icon !== '📦' ? cat.icon : 'tag';
    html += `
      <div class="flex justify-between items-center py-2.5 border-b border-[rgba(255,255,255,0.06)]">
        <span class="flex items-center gap-2.5 text-sm font-medium text-gray-200">
          <i data-lucide="${iconName}" class="w-4 h-4 text-[#848D99]"></i>
          ${escapeHtml(cat.name)}
        </span>
        ${!isDefault ? `<button type="button" class="text-gray-500 hover:text-[#FF453A] p-1 cursor-pointer transition-colors" onclick="deleteCategory('${escapeHtml(cat.name)}', 'Расход')"><i data-lucide="trash-2" class="w-4 h-4"></i></button>` : ''}
      </div>`;
  });
  html += `<p class="text-[11px] uppercase tracking-wider text-gray-500 font-bold mt-5 mb-2">Доходы</p>`;
  Cache.categories.income.forEach(cat => {
    const isDefault = DEFAULT_SYSTEM_CATEGORIES.includes(cat.name);
    const iconName = cat.icon && cat.icon !== '📦' ? cat.icon : 'tag';
    html += `
      <div class="flex justify-between items-center py-2.5 border-b border-[rgba(255,255,255,0.06)]">
        <span class="flex items-center gap-2.5 text-sm font-medium text-gray-200">
          <i data-lucide="${iconName}" class="w-4 h-4 text-[#848D99]"></i>
          ${escapeHtml(cat.name)}
        </span>
        ${!isDefault ? `<button type="button" class="text-gray-500 hover:text-[#FF453A] p-1 cursor-pointer transition-colors" onclick="deleteCategory('${escapeHtml(cat.name)}', 'Доход')"><i data-lucide="trash-2" class="w-4 h-4"></i></button>` : ''}
      </div>`;
  });
  container.innerHTML = html;
  if (typeof lucide !== 'undefined') lucide.createIcons();
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

  // Генерируем пункты: список категорий (системные категории защищены от удаления)
  let itemsHtml = cats.map(c => {
    const isCustom = !DEFAULT_SYSTEM_CATEGORIES.includes(c.name);
    const icon = c.icon && c.icon !== '📦' ? c.icon : 'tag';
    return `
      <div class="flex items-center justify-between hover:bg-[#2A2D3C] rounded-xl px-2.5 py-1.5 transition-colors group">
        <button type="button" class="flex-1 text-left text-[13px] font-medium text-gray-200 flex items-center gap-2.5 cursor-pointer truncate min-w-0" data-cat="${escapeHtml(c.name)}" data-icon="${icon}">
          <i data-lucide="${icon}" class="w-[18px] h-[18px] text-[#848D99]"></i>
          <span class="truncate">${escapeHtml(c.name)}</span>
        </button>
        ${isCustom ? `
          <button type="button" onclick="event.stopPropagation(); deleteCategory('${escapeHtml(c.name)}', '${type}')" class="text-gray-500 hover:text-[#FF453A] p-1.5 flex-shrink-0 cursor-pointer"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
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
  if (typeof lucide !== 'undefined') lucide.createIcons();

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
      if (typeof lucide !== 'undefined') lucide.createIcons();
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
      label.innerHTML = `<i data-lucide="${catIcon}" class="w-4 h-4 mr-1.5 inline-block align-text-bottom"></i> ${escapeHtml(catName)}`;
      if(typeof lucide !== 'undefined') lucide.createIcons();
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

// Хелпер склонения месяцев для вкладов
function getDepositDurationStr(startDate, endDate) {
  const totalDays = Math.max(1, Math.round((endDate - startDate) / 86400000));
  let months = Math.round(totalDays / 30.4375);
  if (months < 1) months = 1;

  const mod10 = months % 10;
  const mod100 = months % 100;
  if (mod100 >= 11 && mod100 <= 19) return `${months} месяцев`;
  if (mod10 === 1) return `${months} месяц`;
  if (mod10 >= 2 && mod10 <= 4) return `${months} месяца`;
  return `${months} месяцев`;
}


// --- ЛОГИКА ЦЕЛЕЙ (АВТОНОМНЫЕ ВИРТУАЛЬНЫЕ КОПИЛКИ) ---
function processGoals(goals) {
  return goals.map(g => {
    const tar = parseFloat(g.target) || 0;
    const sav = parseFloat(g.saved) || 0;
    const share = parseFloat(g.share) || (goals.length > 0 ? Math.round(100 / goals.length) : 100);
    return {
      id: g.id,
      name: g.name,
      target: tar,
      saved: sav,
      share: share,
      progress: Math.min(100, tar > 0 ? (sav / tar) * 100 : 0).toFixed(1),
      isAchieved: sav >= tar
    };
  });
}

// =============================================================
// ДВИЖОК ЭКРАНА БЮДЖЕТА: ОНБОРДИНГ, ПУЛЬС, АВТОСВЯЗКА ЧЕКОВ И ЦЕЛИ
// =============================================================
let wizardSelectedIncomeSources = new Set(['Зарплата', 'Кэшбек']);

function renderBudgetTab() {
  if (!Cache) return;

  const plan = Cache.budgetPlan || {};
  const wizardEl = document.getElementById('budget-wizard');
  const dashboardEl = document.getElementById('budget-dashboard');

  // Если бюджет еще не настроен — держим онбординг
  if (!plan.isConfigured) {
    if (wizardEl) wizardEl.classList.remove('hidden');
    if (dashboardEl) dashboardEl.classList.add('hidden');
    initBudgetWizard(false);
    return;
  }

  // Бюджет настроен — показываем дашборд
  if (wizardEl) wizardEl.classList.add('hidden');
  if (dashboardEl) dashboardEl.classList.remove('hidden');

  const bills = Cache.calendarBills || [];
  const goals = Cache.goals || [];
  const today = new Date();

  // Актуализация текущего месяца в шапке
  const monthLabel = document.getElementById('budget-month-label');
  if (monthLabel) {
    const monthNames = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
    monthLabel.innerText = `${monthNames[today.getMonth()]} ${today.getFullYear()}`;
  }

  // Расчет недели (Пн-Вс)
  const dayOfWeek = today.getDay();
  const diffToMonday = (dayOfWeek + 6) % 7;
  const startOfWeek = new Date(today);
  startOfWeek.setDate(today.getDate() - diffToMonday);
  startOfWeek.setHours(0, 0, 0, 0);

  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(startOfWeek.getDate() + 6);
  endOfWeek.setHours(23, 59, 59, 999);

  const currentMonthId = formatDateStr(today, 'yyyy-MM');
  const monthData = Cache.transactions?.find(m => m.id === currentMonthId);
  const monthItems = monthData ? (monthData.items || []) : [];

  let weeklySpent = 0;
  let monthlySpent = 0;

  monthItems.forEach(tx => {
    if (tx.type !== 'Расход') return;
    const val = parseFloat(tx.amount) || 0;
    monthlySpent += val;

    const txDate = new Date(tx.rawDate);
    if (!isNaN(txDate.getTime()) && txDate >= startOfWeek && txDate <= endOfWeek) {
      weeklySpent += val;
    }
  });

  // Защита от деления на ноль и пустых лимитов
  const monthlyLimit = parseFloat(plan.monthlyVariableLimit) || 0;
  const weeklyBaseLimit = monthlyLimit > 0 ? Math.round(monthlyLimit / 4.33) : 0;
  const weeklyAvailable = Math.max(0, weeklyBaseLimit - weeklySpent);
  const daysRemainingInWeek = Math.max(1, 7 - diffToMonday);
  const dailyPace = weeklyBaseLimit > 0 ? Math.round(weeklyAvailable / daysRemainingInWeek) : 0;

  // 1. Блок «Недельный пульс»
  const weekAvailEl = document.getElementById('budget-week-available');
  const weekProgLabel = document.getElementById('budget-week-progress-label');
  const weekProgBar = document.getElementById('budget-week-progress-bar');
  const weekBadge = document.getElementById('budget-week-badge');

  if (weekAvailEl) weekAvailEl.innerText = formatMoney(weeklyAvailable);
  if (weekProgLabel) {
    weekProgLabel.innerHTML = `${formatMoney(weeklySpent)} из ${formatMoney(weeklyBaseLimit)} ${dailyPace > 0 ? `<span class="text-[#848D99]">(${formatMoney(dailyPace)}/дн)</span>` : ''}`;
  }

  if (weekProgBar) {
    const weekPct = weeklyBaseLimit > 0 ? Math.min(100, (weeklySpent / weeklyBaseLimit) * 100) : 0;
    weekProgBar.style.width = `${weekPct}%`;
    if (weeklySpent > weeklyBaseLimit && weeklyBaseLimit > 0) {
      weekProgBar.className = 'bg-[#FF453A] h-full rounded-full transition-all duration-300';
    } else if (weekPct >= 80) {
      weekProgBar.className = 'bg-[#FF9F0A] h-full rounded-full transition-all duration-300';
    } else {
      weekProgBar.className = 'bg-[#30D158] h-full rounded-full transition-all duration-300';
    }
  }

  if (weekBadge) {
    if (weeklyBaseLimit > 0 && weeklySpent > weeklyBaseLimit) {
      weekBadge.innerText = 'Перерасход';
      weekBadge.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wider uppercase bg-[#FF453A]/15 text-[#FF453A]';
    } else {
      weekBadge.innerText = 'В графике';
      weekBadge.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wider uppercase bg-[#30D158]/15 text-[#30D158]';
    }
  }

  // Шкала месяца
  const monthStatEl = document.getElementById('budget-month-stat');
  const monthProgressEl = document.getElementById('budget-month-progress');
  if (monthStatEl) monthStatEl.innerText = `${formatMoney(monthlySpent)} из ${formatMoney(monthlyLimit)}`;
  if (monthProgressEl) {
    const mPct = monthlyLimit > 0 ? Math.min(100, (monthlySpent / monthlyLimit) * 100) : 0;
    monthProgressEl.style.width = `${mPct}%`;
    monthProgressEl.className = mPct >= 95 ? 'bg-[#FF453A] h-full rounded-full transition-all duration-300' : (mPct >= 75 ? 'bg-[#FF9F0A] h-full rounded-full transition-all duration-300' : 'bg-[#30D158] h-full rounded-full transition-all duration-300');
  }

  // 2. Блок «Календарь счетов»
  renderBudgetCalendar(bills, today, monthItems);

  // 3. Блок «Цели накопления»
  renderBudgetGoals(goals, plan, bills);

  // 4. Блок «Лимиты по категориям»
  renderBudgetCategoryLimits(monthItems, plan.categoryLimits || {});

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function isBillPaidInCurrentMonth(bill, monthItems) {
  if (bill.isPaid) return true;

  const billAmount = parseFloat(bill.amount) || 0;
  const billName = (bill.name || '').toLowerCase();

  return monthItems.some(tx => {
    if (tx.type !== 'Расход') return false;
    const isAmountMatch = Math.abs(tx.amount - billAmount) <= (billAmount * 0.15);
    const isCommentMatch = tx.comment && (tx.comment.toLowerCase().includes(billName) || billName.includes(tx.comment.toLowerCase()));
    const isCategoryMatch = (bill.category && tx.category === bill.category) && isAmountMatch;

    return isCategoryMatch || isCommentMatch;
  });
}

// Вызов загрузки выписки прямо из мастера онбординга
function triggerPdfImportFromWizard() {
  window._returnToWizardStep = 2;
  openPdfInfoModal();
}
window.triggerPdfImportFromWizard = triggerPdfImportFromWizard;

// Компактный формат сумм для календаря (40 тыс., 8.5 тыс., 600 ₽)
function formatCompactThousands(amount) {
  const num = parseFloat(amount) || 0;
  if (num >= 1000) {
    const k = num / 1000;
    return `${k % 1 === 0 ? k : k.toFixed(1)} тыс.`;
  }
  return `${num} ₽`;
}

function renderBudgetCalendar(bills, today, monthItems) {
  const container = document.getElementById('budget-calendar-list');
  const totalEl = document.getElementById('budget-bills-total');
  if (!container) return;

  const totalBillsSum = bills.reduce((s, b) => s + (parseFloat(b.amount) || 0), 0);
  if (totalEl) totalEl.innerText = `Обязательные счета: ${formatMoney(totalBillsSum)}`;

  if (bills.length === 0) {
    container.innerHTML = `
      <div class="col-span-2 bg-[#181B24] border border-[rgba(255,255,255,0.06)] rounded-2xl p-4 text-center text-xs text-[#848D99]">
        Нет запланированных платежей на этот месяц
      </div>
    `;
    return;
  }

  const currentDay = today.getDate();

  container.innerHTML = bills.map(b => {
    const billDay = parseInt(b.day, 10) || 1;
    const isPaid = isBillPaidInCurrentMonth(b, monthItems);
    const isPast = billDay < currentDay && !isPaid;

    let statusText = 'Ожидает';
    let statusClass = 'text-[#848D99] bg-[#212430] border-transparent';

    if (isPaid) {
      statusText = 'Оплачено';
      statusClass = 'text-[#30D158] bg-[#30D158]/15 border-[#30D158]/30 font-semibold';
    } else if (isPast) {
      statusText = 'Просрочено';
      statusClass = 'text-[#FF453A] bg-[#FF453A]/15 border-[#FF453A]/30 font-semibold';
    }

    return `
      <div class="card p-3 rounded-2xl border border-[rgba(255,255,255,0.06)] bg-[#181B24] hover:border-[rgba(255,255,255,0.12)] flex flex-col justify-between cursor-pointer transition-all relative overflow-hidden"
           data-id="${b.id}"
           data-table="CalendarBills"
           onclick="openEditBillModal('${b.id}')">
        
        <input type="checkbox" class="select-checkbox hidden" data-id="${b.id}">

        <!-- Верхний ряд: дата слева, бейдж справа (никогда не обрезается) -->
        <div class="flex items-center justify-between gap-1 mb-2">
          <div class="flex items-baseline gap-1">
            <span class="text-[9px] font-bold text-[#6C5DD3] uppercase">СЕН</span>
            <span class="text-base font-black text-white font-mono leading-none">${billDay}</span>
          </div>
          <span class="text-[9px] px-2 py-0.5 rounded-full border ${statusClass} flex-shrink-0">${statusText}</span>
        </div>

        <!-- Нижний ряд: название и сумма -->
        <div>
          <h4 class="text-xs font-medium text-gray-300 truncate leading-tight">${escapeHtml(b.name)}</h4>
          <p class="text-sm font-bold text-white font-mono mt-1">${formatMoney(b.amount)}</p>
        </div>
      </div>
    `;
  }).join('');
}

function renderBudgetGoals(goals, plan, bills) {
  const container = document.getElementById('budget-goals-list');
  const surplusEl = document.getElementById('budget-goals-surplus');
  if (!container) return;

  const monthlyIncome = plan.monthlyIncome || 0;
  const monthlyLimit = plan.monthlyVariableLimit || 0;
  const totalBills = bills.reduce((s, b) => s + (parseFloat(b.amount) || 0), 0);
  const netSurplus = Math.max(0, monthlyIncome - monthlyLimit - totalBills);

  if (surplusEl) surplusEl.innerText = `Накопления по плану: +${formatMoney(netSurplus)}/мес`;

  if (goals.length === 0) {
    container.innerHTML = `
      <div class="bg-[#181B24] border border-[rgba(255,255,255,0.06)] rounded-2xl p-4 text-center text-xs text-[#848D99]">
        Целей пока нет. Нажмите «+», чтобы создать цель.
      </div>
    `;
    return;
  }

  container.innerHTML = goals.map(g => {
    const goalMonthlyAlloc = Math.round(netSurplus * (g.share / 100));
    const remaining = Math.max(0, g.target - g.saved);
    const monthsNeeded = goalMonthlyAlloc > 0 ? Math.ceil(remaining / goalMonthlyAlloc) : 0;
    const timeHint = g.isAchieved ? 'Цель выполнена' : (monthsNeeded > 0 ? `~${monthsNeeded} мес. при текущем плане` : 'Увеличьте профицит');

    return `
      <div class="card bg-[#181B24] border border-[rgba(255,255,255,0.06)] rounded-2xl p-4 shadow-sm cursor-pointer relative hover:border-[rgba(255,255,255,0.12)] transition-all"
           data-id="${g.id}"
           data-table="Goals"
           onclick="openEditGoalModal('${g.id}')">
        
        <input type="checkbox" class="select-checkbox hidden" data-id="${g.id}">

        <div class="flex items-start justify-between mb-2">
          <div class="flex items-center gap-2.5 min-w-0">
            <div class="w-8 h-8 rounded-xl bg-[#6C5DD3]/15 text-[#6C5DD3] flex items-center justify-center flex-shrink-0">
              <i data-lucide="target" class="w-4 h-4"></i>
            </div>
            <div class="min-w-0">
              <h4 class="text-sm font-bold text-white truncate">${escapeHtml(g.name)}</h4>
              <p class="text-[11px] text-[#848D99]">${timeHint} • Доля: ${g.share}%</p>
            </div>
          </div>
          
          <button type="button" onclick="event.stopPropagation(); openGoalTopupModal('${g.id}', '${escapeHtml(g.name)}')" class="bg-[#212430] hover:bg-[#2A2D3C] text-gray-200 border border-[rgba(255,255,255,0.06)] text-xs font-semibold px-2.5 py-1.5 rounded-xl transition-all cursor-pointer flex items-center gap-1">
            <i data-lucide="plus" class="w-3.5 h-3.5"></i>
            <span>Пополнить</span>
          </button>
        </div>

        <div class="flex justify-between items-end text-xs mb-2">
          <span class="text-white font-bold font-mono text-sm">${formatMoney(g.saved)} <span class="text-[#848D99] font-normal text-xs">/ ${formatMoney(g.target)}</span></span>
          <span class="text-[11px] font-semibold text-[#6C5DD3]">${g.progress}%</span>
        </div>

        <div class="w-full bg-[rgba(255,255,255,0.06)] h-2 rounded-full overflow-hidden">
          <div class="bg-gradient-to-r from-[#6C5DD3] to-[#32ADE6] h-full rounded-full transition-all duration-500" style="width: ${g.progress}%"></div>
        </div>
      </div>
    `;
  }).join('');
}

function renderBudgetCategoryLimits(monthItems = [], categoryLimits = {}) {
  const container = document.getElementById('budget-category-limits-list');
  const sectionWrap = container ? container.closest('.space-y-2\\.5') || container.parentElement : null;
  if (!container || !Cache?.categories) return;

  const cats = Cache.categories.expense || [];
  const safeLimits = categoryLimits && typeof categoryLimits === 'object' ? categoryLimits : {};

  // Расчет фактических трат по категориям за текущий месяц
  const spentMap = {};
  (monthItems || []).forEach(tx => {
    if (tx.type === 'Расход' && tx.category) {
      spentMap[tx.category] = (spentMap[tx.category] || 0) + (parseFloat(tx.amount) || 0);
    }
  });

  // Отбираем только категории с лимитом > 0
  const activeLimits = cats.filter(c => {
    const lim = parseFloat(safeLimits[c.name]);
    return !isNaN(lim) && lim > 0;
  });

  // Если нет настроенных лимитов — аккуратная заглушка без пустых рамок
  if (activeLimits.length === 0) {
    container.innerHTML = `
      <div class="py-4 px-2 text-center">
        <p class="text-xs text-[#848D99]">Отдельные лимиты категорий не заданы</p>
        <button type="button" onclick="openAddCategoryLimitPicker()" class="mt-2 text-xs text-[#6C5DD3] hover:text-[#8274ea] font-semibold transition-colors cursor-pointer">
          + Настроить лимит категории
        </button>
      </div>
    `;
    return;
  }

  container.innerHTML = activeLimits.map(cat => {
    const spent = spentMap[cat.name] || 0;
    const limit = parseFloat(safeLimits[cat.name]) || 0;
    const icon = cat.icon && cat.icon !== '📦' ? cat.icon : 'tag';
    const pct = limit > 0 ? Math.min(100, Math.round((spent / limit) * 100)) : 0;
    const isOver = limit > 0 && spent > limit;

    let barColor = 'bg-[#30D158]';
    if (isOver) barColor = 'bg-[#FF453A]';
    else if (pct >= 80) barColor = 'bg-[#FF9F0A]';

    return `
      <div class="py-3 flex items-center justify-between gap-3 cursor-pointer group hover:opacity-90 transition-opacity"
           onclick="openCategoryLimitModal('${escapeHtml(cat.name)}', ${limit})">
        <div class="flex items-center gap-3 min-w-0 flex-1">
          <div class="w-8 h-8 rounded-xl bg-[#212430] text-gray-300 flex items-center justify-center flex-shrink-0">
            <i data-lucide="${icon}" class="w-4 h-4 text-[#848D99]"></i>
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex items-center justify-between text-xs mb-1.5">
              <span class="font-semibold text-gray-200 truncate">${escapeHtml(cat.name)}</span>
              <span class="font-mono font-bold ${isOver ? 'text-[#FF453A]' : 'text-gray-200'} ml-2">
                ${formatMoney(spent)} <span class="text-[#848D99] font-normal text-[11px]">/ ${formatMoney(limit)}</span>
              </span>
            </div>
            <div class="w-full bg-[rgba(255,255,255,0.06)] h-1.5 rounded-full overflow-hidden">
              <div class="${barColor} h-full rounded-full transition-all duration-300" style="width: ${pct}%"></div>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// -------------------------------------------------------------
// МАСТЕР ПЕРВОГО ЗАПУСКА БЮДЖЕТА (БЕЗ СБРОСА ШАГОВ И СКРОЛЛА)
// -------------------------------------------------------------
let wizardData = {
  income: 0,
  categoryLimits: {}
};

// =============================================================
// ВОССТАНОВЛЕННЫЕ ФУНКЦИИ МАСТЕРА И КАЛЕНДАРЯ ДНЕЙ
// =============================================================

// 3. Поддержка долгого тапа по дню в календаре
let dayLongPressTimer = null;

function startDayLongPress(day) {
  clearTimeout(dayLongPressTimer);
  dayLongPressTimer = setTimeout(() => {
    openDayBillsModal(day);
  }, 500);
}

function cancelDayLongPress() {
  clearTimeout(dayLongPressTimer);
}

// 4. Открытие модального окна добавления счета на выбранное число
function openAddBillOnDay(day) {
  openAddBillModal(day);
}

// 5. Модальное окно управления счетами конкретного дня
function openDayBillsModal(day) {
  const dlg = document.getElementById('day-bills-dialog');
  const title = document.getElementById('day-bills-title');
  const list = document.getElementById('day-bills-items-list');
  const addBtn = document.getElementById('btn-add-second-bill');

  if (title) title.innerText = `${day} число: список платежей`;
  if (dlg) dlg.classList.remove('hidden');

  const bills = (Cache?.calendarBills || []).filter(b => parseInt(b.day, 10) === parseInt(day, 10));

  if (list) {
    if (bills.length === 0) {
      list.innerHTML = '<div class="text-center py-4 text-xs text-[#848D99]">Счетов на этот день нет</div>';
    } else {
      list.innerHTML = bills.map(b => `
        <div class="flex items-center justify-between p-2.5 rounded-xl bg-[#12151C] border border-[rgba(255,255,255,0.04)] text-xs">
          <div>
            <div class="font-semibold text-white">${escapeHtml(b.name)}</div>
            <div class="font-mono text-[11px] text-[#848D99]">${formatMoney(b.amount)}</div>
          </div>
          <button type="button" onclick="deleteCalendarBill('${b.id}')" class="text-gray-500 hover:text-[#FF453A] p-1.5 cursor-pointer">
            <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
          </button>
        </div>
      `).join('');
    }
  }

  if (addBtn) {
    addBtn.onclick = () => {
      closeDayBillsModal();
      openAddBillModal(day);
    };
  }

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function closeDayBillsModal() {
  const dlg = document.getElementById('day-bills-dialog');
  if (dlg) dlg.classList.add('hidden');
}

// 6. Быстрое удаление счета из календаря
async function deleteCalendarBill(billId) {
  showToast('Удаление платежа...', false, true);
  try {
    await getUserCol('CalendarBills').doc(billId).delete();
    closeDayBillsModal();
    await fetchAllData();
    renderWizCalendar();
    showToast('Платеж удален');
  } catch (e) {
    showToast('Ошибка удаления', true);
  }
}

// 7. Подстановка исторического среднего значения в поле лимита (Шаг 4)
function applyCatAvgToInput(catName, avg) {
  applyWizCategoryAvg(catName, avg);
}

// Текущий шаг мастера сохраняется в localStorage
let currentWizardStep = parseInt(localStorage.getItem('budget_wizard_step'), 10) || 1;

function initBudgetWizard(forceReset = false) {
  if (forceReset) {
    currentWizardStep = 1;
    localStorage.setItem('budget_wizard_step', '1');
    const gName = document.getElementById('wiz-goal-name');
    const gTarget = document.getElementById('wiz-goal-target');
    const gSaved = document.getElementById('wiz-goal-saved');
    const incInput = document.getElementById('wiz-income-input');
    if (gName) gName.value = '';
    if (gTarget) gTarget.value = '';
    if (gSaved) gSaved.value = '';
    if (incInput) incInput.value = '';
    document.querySelectorAll('[data-wiz-cat]').forEach(inp => inp.value = '');
    updateWizGoalSlider();
  } else {
    currentWizardStep = parseInt(localStorage.getItem('budget_wizard_step'), 10) || currentWizardStep || 1;
  }

  goToWizardStep(currentWizardStep);
  calculateHistoricalIncomeForWizard();
}

function goToWizardStep(step) {
  currentWizardStep = step;
  localStorage.setItem('budget_wizard_step', String(step));

  for (let i = 1; i <= 5; i++) {
    const stepEl = document.getElementById(`wizard-step-${i}`);
    const progEl = document.getElementById(`wiz-progress-${i}`);
    if (stepEl) {
      if (i === step) stepEl.classList.remove('hidden');
      else stepEl.classList.add('hidden');
    }
    if (progEl) {
      progEl.className = i <= step 
        ? 'h-full rounded-full bg-[#6C5DD3] transition-colors duration-300' 
        : 'h-full rounded-full bg-[rgba(255,255,255,0.08)] transition-colors duration-300';
    }
  }

  const badge = document.getElementById('wizard-step-badge');
  const title = document.getElementById('wizard-step-title');
  const counter = document.getElementById('wizard-step-counter');
  if (counter) counter.innerText = `${step}/5`;

  const titles = [
    'Создайте цель накопления',
    'Планируемый доход',
    'Календарь обязательных счетов',
    'Лимиты на каждый день',
    'Итоговый план бюджета'
  ];

  if (badge) badge.innerText = `Шаг ${step} из 5`;
  if (title) title.innerText = titles[step - 1] || 'Настройка';

  if (step === 1) updateWizGoalSlider();
  else if (step === 3) renderWizCalendar();
  else if (step === 4) renderWizLimitsEditor();
  else if (step === 5) calculateAndRenderWizSummary();

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// Текущий выбранный день в мастере для счетов
let currentWizSelectedDay = 10;
let wizGoalIcon = '💻';

function openWizardIconPicker() {
  const picker = document.getElementById('wiz-icon-picker');
  if (picker) picker.classList.toggle('hidden');
}

function selectWizardGoalIcon(icon) {
  wizGoalIcon = icon;
  const display = document.getElementById('wiz-goal-icon-display');
  if (display) display.innerText = icon;
  const picker = document.getElementById('wiz-icon-picker');
  if (picker) picker.classList.add('hidden');
}

function updateWizGoalSlider() {
  const target = getUnformattedVal(document.getElementById('wiz-goal-target'));
  const saved = getUnformattedVal(document.getElementById('wiz-goal-saved'));

  const label = document.getElementById('wiz-goal-pct-label');
  const bar = document.getElementById('wiz-goal-progress-bar');

  if (!target || target <= 0) {
    if (label) label.innerText = '0%';
    if (bar) bar.style.width = '0%';
    return;
  }

  const pct = Math.min(100, Math.max(0, Math.round((saved / target) * 1000) / 10));
  if (label) label.innerText = `${pct}%`;
  if (bar) bar.style.width = `${pct}%`;
}

function adoptCalculatedIncome() {
  const calcText = document.getElementById('wiz-calculated-income')?.innerText || '0';
  const val = parseInt(calcText.replace(/[^\d]/g, ''), 10) || 0;
  const input = document.getElementById('wiz-income-input');
  if (input && val > 0) {
    input.value = formatMoney(val);
    showToast('Сумма дохода подставлена');
  }
}

// Переключение активности источников дохода в мастере (Шаг 2)
let wizardActiveIncomeSources = new Set(['Зарплата', 'Кэшбек']);

function toggleWizardIncomeSource(sourceName) {
  if (wizardActiveIncomeSources.has(sourceName)) {
    wizardActiveIncomeSources.delete(sourceName);
  } else {
    wizardActiveIncomeSources.add(sourceName);
  }

  // Обновляем визуальное состояние чипсов
  document.querySelectorAll('#wiz-income-sources-list [data-source]').forEach(el => {
    const src = el.dataset.source;
    if (wizardActiveIncomeSources.has(src)) {
      el.className = 'text-[10px] bg-[#30D158]/15 text-[#30D158] border border-[#30D158]/20 px-2 py-0.5 rounded-lg font-medium flex items-center gap-1 cursor-pointer transition-all';
      el.innerHTML = `<i data-lucide="check" class="w-2.5 h-2.5"></i> ${escapeHtml(src)}`;
    } else {
      el.className = 'text-[10px] bg-[#212430] text-[#848D99] border border-transparent px-2 py-0.5 rounded-lg font-medium flex items-center gap-1 cursor-pointer transition-all';
      el.innerHTML = `${escapeHtml(src)}`;
    }
  });

  // Пересчитываем сумму по активным источникам
  recalculateWizardIncome();
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function recalculateWizardIncome() {
  const txMonths = Cache?.transactions || [];
  if (txMonths.length === 0) return;

  const monthsCount = Math.min(3, txMonths.length);
  let totalIncome = 0;

  for (let i = 0; i < monthsCount; i++) {
    const items = txMonths[i].items || [];
    items.forEach(tx => {
      if (tx.type === 'Доход') {
        const cat = tx.category || 'Другое';
        // Если категория входит в выбранные источники
        if (wizardActiveIncomeSources.has(cat)) {
          totalIncome += (parseFloat(tx.amount) || 0);
        }
      }
    });
  }

  const avgIncome = monthsCount > 0 ? Math.round(totalIncome / monthsCount) : 0;
  
  const calcEl = document.getElementById('wiz-calculated-income');
  const inputEl = document.getElementById('wiz-income-input');
  
  if (calcEl) calcEl.innerText = `${formatMoney(avgIncome)}/мес`;
  if (inputEl && (!inputEl.value || inputEl.value === '0 ₽')) {
    inputEl.value = formatMoney(avgIncome);
  }
}

// ============================================================
// ВОССТАНОВЛЕННЫЙ БЛОК: ИМПОРТ ВЫПИСОК, КАЛЕНДАРЬ И ДОХОД В МАСТЕРЕ
// ============================================================

function calculateHistoricalIncomeForWizard() {
  const txMonths = Cache?.transactions || [];
  const calcEl = document.getElementById('wiz-calculated-income');
  const inputEl = document.getElementById('wiz-income-input');

  if (!txMonths.length) {
    if (calcEl) calcEl.innerText = '0 ₽/мес';
    return 0;
  }

  let minTime = Infinity;
  let maxTime = -Infinity;
  let totalIncome = 0;

  txMonths.forEach(m => {
    (m.items || []).forEach(tx => {
      const t = tx.timestamp || (tx.rawDate ? new Date(tx.rawDate).getTime() : null);
      if (t) {
        if (t < minTime) minTime = t;
        if (t > maxTime) maxTime = t;
      }

      if (tx.type === 'Доход') {
        const cat = tx.category || 'Другое';
        if (wizardActiveIncomeSources.has(cat)) {
          totalIncome += (parseFloat(tx.amount) || 0);
        }
      }
    });
  });

  const diffDays = Math.max(1, Math.round((maxTime - minTime) / (1000 * 60 * 60 * 24)) + 1);
  const effectiveDays = Math.min(90, diffDays);
  const avgIncome = Math.round(totalIncome * (30.44 / effectiveDays));

  if (calcEl) calcEl.innerText = `${formatMoney(avgIncome)}/мес`;
  if (inputEl && (!inputEl.value || inputEl.value === '0 ₽' || inputEl.value === '0')) {
    inputEl.value = formatMoney(avgIncome);
  }
  return avgIncome;
}

// Алиас для обратной совместимости, если где-то остался старый вызов
window.selectWizCalendarDay = handleWizardDayClick;
window.handleWizardDayClick = handleWizardDayClick;

// 3. Вызов загрузки выписки прямо из мастера онбординга
function triggerPdfImportFromWizard() {
  const fileInput = document.getElementById('pdf-file-input');
  if (fileInput) {
    // Сохраняем флаг, что импорт вызван из мастера
    window.isImportingFromWizard = true;
    fileInput.click();
  } else {
    showToast('Ошибка: элемент выбора файла не найден', true);
  }
}

// =============================================================
// ОБНОВЛЕННЫЙ КАЛЕНДАРЬ И ЛИМИТЫ (ШАГИ 3 И 4)
// =============================================================

// Алиасы для защиты от ошибок отсутствия функции
window.renderWizardCalendar = renderWizCalendar;
window.renderWizCalendar = renderWizCalendar;

// 1. Рендер сетки календаря
function renderWizCalendar() {
  const grid = document.getElementById('wiz-calendar-grid');
  const totalLabel = document.getElementById('wiz-bills-total-label');
  if (!grid) return;

  const bills = Cache?.calendarBills || [];
  const totalSum = bills.reduce((acc, b) => acc + (parseFloat(b.amount) || 0), 0);
  if (totalLabel) totalLabel.innerText = formatMoney(totalSum);

  let html = '';

  for (let day = 1; day <= 31; day++) {
    const dayBills = bills.filter(b => parseInt(b.day, 10) === day);
    const hasBills = dayBills.length > 0;
    const isSelected = day === currentWizSelectedDay;
    const totalDaySum = dayBills.reduce((acc, b) => acc + (parseFloat(b.amount) || 0), 0);

    let sumBadge = '';
    if (hasBills) {
      const shortSum = totalDaySum >= 1000 ? `${Math.round(totalDaySum / 1000)}k` : `${totalDaySum}`;
      sumBadge = `<span class="wiz-bill-badge">${shortSum}</span>`;
    }

    html += `
      <div onclick="handleWizardDayClick(${day})" class="wiz-day-cell ${isSelected ? 'is-selected' : ''} ${hasBills ? 'has-bills' : ''}">
        <span class="${isSelected ? 'text-white font-bold' : (hasBills ? 'text-gray-200' : 'text-[#848D99]')}">${day}</span>
        ${sumBadge}
      </div>
    `;
  }
  grid.innerHTML = html;
}

// 2. Умный клик по дню: пустой -> сразу добавление, со счетом -> красивый тултип
function handleWizardDayClick(day) {
  currentWizSelectedDay = parseInt(day, 10) || 1;
  const bills = (Cache?.calendarBills || []).filter(b => parseInt(b.day, 10) === currentWizSelectedDay);

  if (bills.length === 0) {
    // ДЕНЬ ПУСТОЙ: Сразу открываем модалку добавления с подставленным днем!
    closeWizDayTooltip();
    openAddBillModal(currentWizSelectedDay);
  } else {
    // В ДНЕ ЕСТЬ СЧЕТА: Показываем аккуратный всплывающий тултип
    showWizDayTooltip(currentWizSelectedDay, bills);
  }
  renderWizCalendar();
}
window.handleWizardDayClick = handleWizardDayClick;

function showWizDayTooltip(day, bills) {
  const tooltip = document.getElementById('wiz-day-tooltip');
  const title = document.getElementById('wiz-tooltip-title');
  const list = document.getElementById('wiz-tooltip-bills-list');
  if (!tooltip || !list) return;

  if (title) title.innerText = `${day} число: платежи (${bills.length})`;

  list.innerHTML = bills.map(b => `
    <div class="flex items-center justify-between p-2 rounded-xl bg-[#12151C] border border-[rgba(255,255,255,0.04)]">
      <div class="min-w-0 pr-2 cursor-pointer" onclick="openEditBillModal('${b.id}')">
        <span class="text-xs font-semibold text-white truncate block">${escapeHtml(b.name)}</span>
        <span class="text-[11px] font-mono text-gray-400">-${formatMoney(b.amount)}</span>
      </div>
      <div class="flex items-center gap-1">
        <button type="button" onclick="openEditBillModal('${b.id}')" class="text-gray-400 hover:text-white p-1.5 cursor-pointer">
          <i data-lucide="pencil" class="w-3.5 h-3.5"></i>
        </button>
        <button type="button" onclick="deleteCalendarBill('${b.id}')" class="text-gray-400 hover:text-[#FF453A] p-1.5 cursor-pointer">
          <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
        </button>
      </div>
    </div>
  `).join('');

  tooltip.classList.remove('hidden');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function closeWizDayTooltip() {
  const tooltip = document.getElementById('wiz-day-tooltip');
  if (tooltip) tooltip.classList.add('hidden');
}
window.closeWizDayTooltip = closeWizDayTooltip;

function addAnotherBillFromTooltip() {
  closeWizDayTooltip();
  openAddBillModal(currentWizSelectedDay);
}
window.addAnotherBillFromTooltip = addAnotherBillFromTooltip;

// 3. Исправление сохранения счета: НЕ сбрасывать мастера на Шаг 1!
async function submitCalendarBill(e) {
  e.preventDefault();
  const editId = document.getElementById('bill-edit-id').value;
  const name = document.getElementById('bill-name').value.trim();
  const amount = getUnformattedVal(document.getElementById('bill-amount'));
  const day = parseInt(document.getElementById('bill-day').value, 10);
  const type = document.getElementById('bill-type').value;

  if (!name || !amount) return;

  showToast('Сохранение платежа...', false, true);
  try {
    const col = getUserCol('CalendarBills');
    const billData = { name, amount, day, type, isPaid: false, updatedAt: Date.now() };

    if (editId) {
      await col.doc(editId).update(billData);
    } else {
      await col.add({ ...billData, createdAt: Date.now() });
    }

    closeAddBillModal();
    document.getElementById('calendar-bill-form').reset();
    document.getElementById('bill-edit-id').value = '';
    
    // Синхронизируем кеш
    await fetchAllData();

    // ЕСЛИ НАХОДИМСЯ В МАСТЕРЕ: держим Шаг 3!
    const plan = Cache?.budgetPlan || {};
    if (!plan.isConfigured) {
      goToWizardStep(3);
      renderWizCalendar();
    }
    
    showToast('Платеж сохранен');
  } catch (err) {
    showToast('Ошибка: ' + err.message, true);
  }
}

// Хранилище категорий, добавленных пользователем вручную на шаге 4
let wizardCustomCategories = new Set();

function renderWizLimitsEditor() {
  const container = document.getElementById('wiz-category-limits-editor');
  if (!container) return;

  const avgMap = calculateHistoricalCategoryAverages();

  // Стандартные 3 категории
  const list = [
    { name: 'Продукты', icon: 'shopping-cart' },
    { name: 'Кафе и рестораны', icon: 'utensils' },
    { name: 'Развлечения', icon: 'gamepad-2' }
  ];

  // Добавленные пользователем категории
  wizardCustomCategories.forEach(catName => {
    const catObj = Cache?.categories?.expense?.find(c => c.name === catName);
    list.push({ name: catName, icon: catObj?.icon || 'tag', isCustom: true });
  });

  // Собирательная категория «Прочие расходы»
  const accountedNames = list.map(c => c.name);
  let othersAvg = 0;
  Object.keys(avgMap).forEach(cat => {
    if (!accountedNames.includes(cat)) {
      othersAvg += avgMap[cat] || 0;
    }
  });
  avgMap['Прочие расходы'] = othersAvg;
  list.push({ name: 'Прочие расходы', icon: 'package' });

  container.innerHTML = list.map(cat => {
    const avg = Math.round(avgMap[cat.name] || 0);
    const existingVal = Cache.budgetPlan?.categoryLimits?.[cat.name] || (avg > 0 ? avg : '');

    return `
      <div class="p-3 rounded-2xl bg-[#12151C] border border-[rgba(255,255,255,0.04)] flex items-center justify-between gap-2.5">
        <div class="w-9 h-9 rounded-xl bg-[#1E2330] text-gray-300 flex items-center justify-center flex-shrink-0">
          <i data-lucide="${cat.icon}" class="w-5 h-5 text-[#848D99]"></i>
        </div>
        
        <div class="flex-1 min-w-0 pr-1">
          <div class="flex items-center gap-1.5">
            <span class="text-xs font-bold text-gray-200 truncate">${escapeHtml(cat.name)}</span>
            ${cat.isCustom ? `<button type="button" onclick="removeWizardCustomCat('${escapeHtml(cat.name)}')" class="text-gray-500 hover:text-[#FF453A] text-xs font-bold cursor-pointer">✕</button>` : ''}
          </div>
          ${avg > 0 ? `
            <div onclick="applyWizCategoryAvg('${escapeHtml(cat.name)}', ${avg})" class="wiz-adopt-chip mt-1.5 whitespace-nowrap" title="Нажмите, чтобы применить">
              <span>В среднем: ~${formatMoney(avg)}</span>
              <span class="text-[#727cff] font-bold">↵</span>
            </div>
          ` : `
            <span class="text-[10px] text-[#848D99] mt-0.5 block">В среднем: нет данных</span>
          `}
        </div>

        <div class="w-28 flex-shrink-0">
          <input type="text"
                 inputmode="decimal"
                 data-wiz-cat="${escapeHtml(cat.name)}"
                 oninput="formatSumInput(this); updateWizLiveTotal();"
                 value="${existingVal ? formatMoney(existingVal) : ''}"
                 placeholder="0 ₽"
                 class="w-full bg-[#181B24] border border-[rgba(255,255,255,0.08)] text-white text-right font-mono font-bold text-xs rounded-xl px-2.5 py-2 outline-none focus:border-[#6C5DD3] transition-colors">
        </div>
      </div>
    `;
  }).join('');

  updateWizLiveTotal();
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// НОВЫЕ ФУНКЦИИ: Кнопка «+ Категория» на Шаге 4
function openAddCategoryLimitPicker() {
  const allExpenseCats = Cache?.categories?.expense || [];
  const standardNames = ['Продукты', 'Кафе и рестораны', 'Развлечения', 'Прочие расходы'];
  
  const available = allExpenseCats.filter(c => !standardNames.includes(c.name) && !wizardCustomCategories.has(c.name));

  if (available.length === 0) {
    showAddCategoryDialog('Расход', null);
    return;
  }

  const optionsHtml = available.map(c => `
    <button type="button" onclick="addCategoryToWizard('${escapeHtml(c.name)}')" class="w-full flex items-center justify-between p-3 rounded-xl bg-[#12151C] hover:bg-[#212430] border border-[rgba(255,255,255,0.04)] text-xs text-gray-200 transition-colors cursor-pointer">
      <div class="flex items-center gap-2.5">
        <i data-lucide="${c.icon || 'tag'}" class="w-4 h-4 text-[#848D99]"></i>
        <span>${escapeHtml(c.name)}</span>
      </div>
      <span class="text-[#727cff] font-bold">+ Добавить</span>
    </button>
  `).join('');

  showDialog('Добавить категорию в лимиты', `
    <div class="space-y-2 max-h-60 overflow-y-auto pt-2">
      ${optionsHtml}
    </div>
  `, false);

  if (typeof lucide !== 'undefined') lucide.createIcons();
}
window.openAddCategoryLimitPicker = openAddCategoryLimitPicker;

function addCategoryToWizard(catName) {
  wizardCustomCategories.add(catName);
  const dlg = document.getElementById('custom-dialog');
  if (dlg) dlg.classList.add('hidden');
  renderWizLimitsEditor();
  showToast(`Категория «${catName}» добавлена`);
}
window.addCategoryToWizard = addCategoryToWizard;

function removeWizardCustomCat(catName) {
  wizardCustomCategories.delete(catName);
  renderWizLimitsEditor();
}
window.removeWizardCustomCat = removeWizardCustomCat;

function selectWizCalendarDay(day) {
  currentWizSelectedDay = day;
  renderWizCalendar();
}

function renderWizDayBillsList() {
  const container = document.getElementById('wiz-day-bills-list');
  const label = document.getElementById('wiz-selected-day-label');
  if (label) label.innerText = `${currentWizSelectedDay} число: счета`;
  if (!container) return;

  const bills = (Cache.calendarBills || []).filter(b => parseInt(b.day, 10) === currentWizSelectedDay);

  if (bills.length === 0) {
    container.innerHTML = `
      <div class="py-2 text-center text-[11px] text-[#848D99]">
        Нет списаний на этот день
      </div>
    `;
    return;
  }

  container.innerHTML = bills.map(b => `
    <div class="flex items-center justify-between p-2 rounded-xl bg-[#181B24] border border-[rgba(255,255,255,0.04)]">
      <div class="flex items-center gap-2 min-w-0">
        <div class="w-6 h-6 rounded-lg bg-[#212430] flex items-center justify-center text-xs text-gray-300">
          <i data-lucide="receipt" class="w-3.5 h-3.5 text-[#848D99]"></i>
        </div>
        <span class="text-xs font-medium text-gray-200 truncate">${escapeHtml(b.name)}</span>
      </div>
      <b class="text-xs font-mono font-semibold text-gray-200 ml-2">-${formatMoney(b.amount)}</b>
    </div>
  `).join('');

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function openAddBillModalFromWizard() {
  const dayInput = document.getElementById('bill-day');
  if (dayInput) dayInput.value = currentWizSelectedDay;
  openAddBillModal();
}

function applyWizCategoryAvg(catName, avg) {
  const inp = document.querySelector(`[data-wiz-cat="${catName}"]`);
  if (inp) {
    inp.value = formatMoney(avg);
    updateWizLiveTotal();
  }
}

function updateWizLiveTotal() {
  let total = 0;
  document.querySelectorAll('[data-wiz-cat]').forEach(inp => {
    total += getUnformattedVal(inp) || 0;
  });

  const totalEl = document.getElementById('wiz-limits-live-total');
  const weeklyEl = document.getElementById('wiz-live-weekly-estimate');
  if (totalEl) totalEl.innerText = `${formatMoney(total)}/мес`;
  if (weeklyEl) weeklyEl.innerText = `~${formatMoney(Math.round(total / 4.33))}`;
}

// Расчет финансовой квитанции на Шаге 5
function calculateAndRenderWizSummary() {
  const income = getUnformattedVal(document.getElementById('wiz-income-input')) || 0;
  
  // Считаем обязательные платежи из календаря
  const bills = Cache.calendarBills || [];
  const billsTotal = bills.reduce((acc, b) => acc + (parseFloat(b.amount) || 0), 0);

  // Считаем сумму установленных лимитов
  let limitsTotal = 0;
  document.querySelectorAll('[data-wiz-cat]').forEach(inp => {
    limitsTotal += getUnformattedVal(inp) || 0;
  });

  const surplus = Math.max(0, income - billsTotal - limitsTotal);
  const weekly = limitsTotal > 0 ? Math.round(limitsTotal / 4.33) : 0;

  const goalTarget = getUnformattedVal(document.getElementById('wiz-goal-target')) || 100000;
  const goalSaved = getUnformattedVal(document.getElementById('wiz-goal-saved')) || 0;
  const remainingToGoal = Math.max(0, goalTarget - goalSaved);
  const monthsToGoal = surplus > 0 ? Math.ceil(remainingToGoal / surplus) : 0;

  document.getElementById('wiz-sum-income').innerText = formatMoney(income);
  document.getElementById('wiz-sum-bills').innerText = `-${formatMoney(billsTotal)}`;
  document.getElementById('wiz-sum-limits').innerText = `-${formatMoney(limitsTotal)}`;
  document.getElementById('wiz-sum-surplus').innerText = `+${formatMoney(surplus)}/мес`;
  document.getElementById('wiz-sum-week').innerText = formatMoney(weekly);
  document.getElementById('wiz-sum-timeline').innerText = monthsToGoal > 0 ? `~${monthsToGoal} мес.` : 'Цель достигнута!';
}

// Вспомогательный расчет истории трат из выписок
function calculateHistoricalCategoryAverages() {
  const map = {};
  const txMonths = Cache?.transactions || [];
  if (!txMonths.length) return map;

  let minTime = Infinity;
  let maxTime = -Infinity;
  const catTotals = {};

  txMonths.forEach(m => {
    (m.items || []).forEach(tx => {
      const t = tx.timestamp || (tx.rawDate ? new Date(tx.rawDate).getTime() : null);
      if (t) {
        if (t < minTime) minTime = t;
        if (t > maxTime) maxTime = t;
      }

      if (tx.type === 'Расход' && tx.category) {
        const val = parseFloat(tx.amount) || 0;
        catTotals[tx.category] = (catTotals[tx.category] || 0) + val;
      }
    });
  });

  if (minTime === Infinity || maxTime === -Infinity) return map;

  const diffDays = Math.max(1, Math.round((maxTime - minTime) / (1000 * 60 * 60 * 24)) + 1);
  const effectiveDays = Math.min(90, diffDays);
  const monthFactor = 30.44 / effectiveDays;

  Object.keys(catTotals).forEach(cat => {
    map[cat] = Math.round(catTotals[cat] * monthFactor);
  });

  return map;
}

async function finishBudgetOnboarding() {
  showToast('Запуск бюджета...', false, true);

  const goalName = document.getElementById('wiz-goal-name').value.trim() || 'Новая цель';
  const goalTarget = getUnformattedVal(document.getElementById('wiz-goal-target')) || 100000;
  const goalSaved = getUnformattedVal(document.getElementById('wiz-goal-saved')) || 0;
  const income = getUnformattedVal(document.getElementById('wiz-income-input')) || 0;

  // 1. Собираем установленные лимиты категорий
  let limitsTotal = 0;
  const categoryLimits = {};
  document.querySelectorAll('[data-wiz-cat]').forEach(inp => {
    const val = getUnformattedVal(inp);
    if (val > 0) {
      limitsTotal += val;
      categoryLimits[inp.dataset.wizCat] = val;
    }
  });

  try {
    const batch = db.batch();

    // 2. Создаем или обновляем первую цель накопления
    const goalsCol = getUserCol('Goals');
    const existingGoalsSnap = await goalsCol.limit(1).get();
    let targetGoalRef;

    if (!existingGoalsSnap.empty) {
      targetGoalRef = existingGoalsSnap.docs[0].ref;
      batch.update(targetGoalRef, {
        name: goalName,
        target: goalTarget,
        saved: goalSaved,
        share: 100,
        status: goalSaved >= goalTarget ? 'Выполнена' : 'В процессе',
        updatedAt: Date.now()
      });
    } else {
      targetGoalRef = goalsCol.doc();
      batch.set(targetGoalRef, {
        name: goalName,
        target: goalTarget,
        saved: goalSaved,
        share: 100,
        status: goalSaved >= goalTarget ? 'Выполнена' : 'В процессе',
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
    }

    // 3. Сохраняем генеральный план бюджета
    const planRef = getUserCol('BudgetPlan').doc('plan');
    batch.set(planRef, {
      isConfigured: true,
      monthlyIncome: income,
      monthlyVariableLimit: limitsTotal > 0 ? limitsTotal : Math.max(0, income - 40000), // Фоллбэк
      categoryLimits: categoryLimits,
      updatedAt: Date.now()
    }, { merge: true });

    // 4. Коммитим все изменения единым пакетом
    await batch.commit();

    // 5. Полная перезагрузка актуальных данных и переход к дашборду
    await fetchAllData();
    // Сброс сохраненного шага после успешного запуска бюджета
    localStorage.removeItem('budget_wizard_step');
    currentWizardStep = 1;

    showToast('Бюджет успешно активирован!');
  } catch (err) {
    console.error('Ошибка активации бюджета:', err);
    showToast('Ошибка сохранения: ' + err.message, true);
  }
}

let activeEditCategory = null;

function openCategoryLimitModal(catName, currentLimit) {
  activeEditCategory = catName;
  const dlg = document.getElementById('category-limit-dialog');
  const title = document.getElementById('category-limit-title');
  const inp = document.getElementById('category-limit-amount');

  if (title) title.innerText = catName;
  if (inp) setFormattedVal('category-limit-amount', currentLimit || '');
  if (dlg) dlg.classList.remove('hidden');
}

function closeCategoryLimitModal() {
  const dlg = document.getElementById('category-limit-dialog');
  if (dlg) dlg.classList.add('hidden');
  activeEditCategory = null;
}

async function submitCategoryLimit() {
  if (!activeEditCategory) return;
  const amount = getUnformattedVal(document.getElementById('category-limit-amount'));
  const plan = Cache?.budgetPlan || {};
  const limits = plan.categoryLimits || {};

  if (amount > 0) limits[activeEditCategory] = amount;
  else delete limits[activeEditCategory];

  const totalVarLimit = Object.values(limits).reduce((s, v) => s + v, 0);

  showToast('Сохранение лимита...', false, true);
  try {
    await getUserCol('BudgetPlan').doc('plan').set({
      ...plan,
      isConfigured: true,
      monthlyVariableLimit: totalVarLimit,
      categoryLimits: limits
    }, { merge: true });

    closeCategoryLimitModal();
    await fetchAllData();
    showToast('Лимит обновлен');
  } catch (err) {
    showToast('Ошибка: ' + err.message, true);
  }
}

function deleteBudgetGoal(goalId, goalName) {
  showDialog('Удаление цели', `Удалить цель "${goalName}"? Накопленный прогресс будет удален.`, true, async () => {
    showToast('Удаление цели...', false, true);
    try {
      await getUserCol('Goals').doc(goalId).delete();
      await fetchAllData();
      showToast('Цель удалена');
    } catch (e) {
      showToast('Ошибка удаления', true);
    }
  });
}

window.goToWizardStep = goToWizardStep;
window.toggleWizardIncomeSource = toggleWizardIncomeSource;
window.handleWizardDayClick = handleWizardDayClick;
window.startDayLongPress = startDayLongPress;
window.cancelDayLongPress = cancelDayLongPress;
window.openAddBillOnDay = openAddBillOnDay;
window.openDayBillsModal = openDayBillsModal;
window.closeDayBillsModal = closeDayBillsModal;
window.deleteCalendarBill = deleteCalendarBill;
window.applyCatAvgToInput = applyCatAvgToInput;
window.finishBudgetOnboarding = finishBudgetOnboarding;
window.openCategoryLimitModal = openCategoryLimitModal;
window.closeCategoryLimitModal = closeCategoryLimitModal;
window.submitCategoryLimit = submitCategoryLimit;
window.deleteBudgetGoal = deleteBudgetGoal;

// Управление модальными окнами бюджета
function openBudgetPlanModal() {
  const dlg = document.getElementById('budget-plan-dialog');
  if (!dlg) return;

  const plan = Cache?.budgetPlan || {};
  setFormattedVal('plan-income-input', plan.monthlyIncome || 0);
  setFormattedVal('plan-expense-input', plan.monthlyVariableLimit || 0);

  // Расчет реального среднего дохода за 3 месяца
  const months = Cache?.transactions || [];
  const lastMonths = months.slice(0, 3);
  let totalInc = 0;
  lastMonths.forEach(m => {
    (m.items || []).forEach(tx => {
      if (tx.type === 'Доход') totalInc += tx.amount;
    });
  });
  const avgIncome = Math.round(totalInc / Math.max(1, lastMonths.length));
  const avgEl = document.getElementById('plan-avg-income');
  if (avgEl) avgEl.innerText = `${formatMoney(avgIncome)}/мес`;

  updatePlanForecast();
  dlg.classList.remove('hidden');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}
function closeBudgetPlanModal() {
  const dlg = document.getElementById('budget-plan-dialog');
  if (dlg) dlg.classList.add('hidden');
}

function updatePlanForecast() {
  const inc = getUnformattedVal(document.getElementById('plan-income-input'));
  const exp = getUnformattedVal(document.getElementById('plan-expense-input'));
  const bills = Cache?.calendarBills || [];
  const totalBills = bills.reduce((s, b) => s + (parseFloat(b.amount) || 0), 0);

  const surplus = Math.max(0, inc - exp - totalBills);
  const surplusEl = document.getElementById('plan-forecast-surplus');
  const weekHint = document.getElementById('plan-week-hint');

  if (surplusEl) surplusEl.innerText = `+${formatMoney(surplus)}/мес`;
  if (weekHint) weekHint.innerText = `Базовый лимит недели: ~${formatMoney(Math.round(exp / 4.33))}`;
}

async function submitBudgetPlan(e) {
  e.preventDefault();
  const inc = getUnformattedVal(document.getElementById('plan-income-input'));
  const exp = getUnformattedVal(document.getElementById('plan-expense-input'));

  showToast('Сохранение плана...', false, true);
  try {
    const col = getUserCol('BudgetPlan');
    const snap = await col.get();
    const batch = db.batch();

    const planData = {
      monthlyIncome: inc,
      monthlyVariableLimit: exp,
      updatedAt: Date.now()
    };

    if (snap.empty) {
      batch.set(col.doc(), planData);
    } else {
      batch.update(snap.docs[0].ref, planData);
    }

    await batch.commit();
    closeBudgetPlanModal();
    await fetchAllData();
    showToast('План бюджета обновлен');
  } catch (err) {
    showToast('Ошибка: ' + err.message, true);
  }
}

// Добавление платежа календаря
function openAddBillOnDay(day) {
  openAddBillModal(day);
}

function openAddBillModal(initialDay = null) {
  const form = document.getElementById('calendar-bill-form');
  if (form) form.reset();

  const editIdEl = document.getElementById('bill-edit-id');
  if (editIdEl) editIdEl.value = '';

  const dayInput = document.getElementById('bill-day');
  if (dayInput && initialDay) {
    dayInput.value = initialDay;
  }

  const actions = document.getElementById('bill-dialog-actions');
  const deleteBtn = document.getElementById('bill-delete-btn');
  const title = document.getElementById('calendar-bill-dialog-title');

  if (actions) actions.classList.remove('hidden');
  if (deleteBtn) deleteBtn.classList.add('hidden');
  if (title) title.innerText = initialDay ? `Платеж на ${initialDay} число` : 'Платеж в календарь';

  const dlg = document.getElementById('calendar-bill-dialog');
  if (dlg) dlg.classList.remove('hidden');
}
window.openAddBillModal = openAddBillModal;

function closeAddBillModal() {
  const dlg = document.getElementById('calendar-bill-dialog');
  if (dlg) dlg.classList.add('hidden');
}

function openEditBillModal(billId) {
  const bill = Cache?.calendarBills?.find(b => b.id === billId);
  if (!bill) return;

  const dlg = document.getElementById('calendar-bill-dialog');
  const title = document.getElementById('calendar-bill-dialog-title');
  const deleteBtn = document.getElementById('bill-delete-btn');

  document.getElementById('bill-edit-id').value = bill.id;
  document.getElementById('bill-name').value = bill.name;
  setFormattedVal('bill-amount', bill.amount);
  document.getElementById('bill-day').value = bill.day;
  document.getElementById('bill-type').value = bill.type || 'recurring';

  if (title) title.innerText = 'Редактировать платеж';
  if (deleteBtn) deleteBtn.classList.remove('hidden');

  if (dlg) dlg.classList.remove('hidden');
}
window.openEditBillModal = openEditBillModal;

async function deleteCurrentEditingBill() {
  const id = document.getElementById('bill-edit-id').value;
  if (!id) return;

  showToast('Удаление платежа...', false, true);
  try {
    await getUserCol('CalendarBills').doc(id).delete();
    closeAddBillModal();
    await fetchAllData();
    renderWizardCalendar();
    showToast('Платеж удален');
  } catch (e) {
    showToast('Ошибка удаления', true);
  }
}
window.deleteCurrentEditingBill = deleteCurrentEditingBill;

async function toggleBillPaidStatus(billId, newStatus) {
  try {
    await getUserCol('CalendarBills').doc(billId).update({ isPaid: newStatus });
    await fetchAllData();
  } catch (e) {}
}

// Быстрое пополнение виртуальной копилки цели
let activeTopupGoalId = null;
let currentTopupMode = 'add';

function openGoalTopupModal(goalId, goalName) {
  activeTopupGoalId = goalId;
  const dlg = document.getElementById('goal-topup-dialog');
  const title = document.getElementById('goal-topup-title');
  if (title) title.innerText = goalName;
  document.getElementById('goal-topup-amount').value = '';
  setTopupMode('add');
  if (dlg) dlg.classList.remove('hidden');
}

function closeGoalTopupModal() {
  const dlg = document.getElementById('goal-topup-dialog');
  if (dlg) dlg.classList.add('hidden');
  activeTopupGoalId = null;
}

function setTopupMode(mode) {
  currentTopupMode = mode;
  const addBtn = document.getElementById('tab-topup-add');
  const subBtn = document.getElementById('tab-topup-sub');
  if (mode === 'add') {
    addBtn.className = 'flex-1 py-1.5 rounded-lg font-semibold bg-[#212430] text-white transition-all';
    subBtn.className = 'flex-1 py-1.5 rounded-lg font-medium text-[#848D99] hover:text-white transition-all';
  } else {
    subBtn.className = 'flex-1 py-1.5 rounded-lg font-semibold bg-[#212430] text-white transition-all';
    addBtn.className = 'flex-1 py-1.5 rounded-lg font-medium text-[#848D99] hover:text-white transition-all';
  }
}

async function submitGoalTopup() {
  if (!activeTopupGoalId) return;
  const amount = getUnformattedVal(document.getElementById('goal-topup-amount'));
  if (!amount) return;

  const goal = Cache?.goals?.find(g => g.id === activeTopupGoalId);
  if (!goal) return;

  let newSaved = currentTopupMode === 'add' ? (goal.saved + amount) : Math.max(0, goal.saved - amount);

  showToast('Обновление цели...', false, true);
  try {
    await getUserCol('Goals').doc(activeTopupGoalId).update({ saved: newSaved });
    closeGoalTopupModal();
    await fetchAllData();
    showToast(currentTopupMode === 'add' ? `В цель внесено +${formatMoney(amount)}` : `Из цели снято −${formatMoney(amount)}`);
  } catch (err) {
    showToast('Ошибка: ' + err.message, true);
  }
}

// Управление созданием и редактированием целей бюджета
function openGoalModal() {
  const form = document.getElementById('budget-goal-form');
  if (form) form.reset();

  document.getElementById('goal-edit-id').value = '';
  document.getElementById('goal-share-input').value = 100;
  document.getElementById('goal-share-label').innerText = '100%';
  document.getElementById('goal-delete-btn').classList.add('hidden');
  document.getElementById('budget-goal-dialog-title').innerText = 'Новая цель';

  const dlg = document.getElementById('budget-goal-dialog');
  if (dlg) dlg.classList.remove('hidden');
}
window.openGoalModal = openGoalModal;

function openEditGoalModal(goalId) {
  const goal = Cache?.goals?.find(g => g.id === goalId);
  if (!goal) return;

  document.getElementById('goal-edit-id').value = goal.id;
  document.getElementById('goal-name-input').value = goal.name;
  setFormattedVal('goal-target-input', goal.target);
  setFormattedVal('goal-saved-input', goal.saved);
  document.getElementById('goal-share-input').value = goal.share || 100;
  document.getElementById('goal-share-label').innerText = (goal.share || 100) + '%';
  document.getElementById('goal-delete-btn').classList.remove('hidden');
  document.getElementById('budget-goal-dialog-title').innerText = 'Редактировать цель';

  const dlg = document.getElementById('budget-goal-dialog');
  if (dlg) dlg.classList.remove('hidden');
}
window.openEditGoalModal = openEditGoalModal;

function closeGoalModal() {
  const dlg = document.getElementById('budget-goal-dialog');
  if (dlg) dlg.classList.add('hidden');
}
window.closeGoalModal = closeGoalModal;

async function submitBudgetGoal(e) {
  e.preventDefault();
  const editId = document.getElementById('goal-edit-id').value;
  const name = document.getElementById('goal-name-input').value.trim();
  const target = getUnformattedVal(document.getElementById('goal-target-input'));
  const saved = getUnformattedVal(document.getElementById('goal-saved-input'));
  const share = parseInt(document.getElementById('goal-share-input').value, 10) || 100;

  if (!name || !target) return;

  showToast('Сохранение цели...', false, true);
  try {
    const col = getUserCol('Goals');
    const goalData = {
      name,
      target,
      saved,
      share,
      status: saved >= target ? 'Выполнена' : 'В процессе',
      updatedAt: Date.now()
    };

    if (editId) {
      await col.doc(editId).update(goalData);
    } else {
      await col.add({ ...goalData, createdAt: Date.now() });
    }

    closeGoalModal();
    await fetchAllData();
    showToast('Цель сохранена');
  } catch (err) {
    showToast('Ошибка: ' + err.message, true);
  }
}
window.submitBudgetGoal = submitBudgetGoal;

async function deleteCurrentEditingGoal() {
  const editId = document.getElementById('goal-edit-id').value;
  if (!editId) return;

  showToast('Удаление цели...', false, true);
  try {
    await getUserCol('Goals').doc(editId).delete();
    closeGoalModal();
    await fetchAllData();
    showToast('Цель удалена');
  } catch (err) {
    showToast('Ошибка: ' + err.message, true);
  }
}
window.deleteCurrentEditingGoal = deleteCurrentEditingGoal;

window.openBudgetPlanModal = openBudgetPlanModal;
window.closeBudgetPlanModal = closeBudgetPlanModal;
window.updatePlanForecast = updatePlanForecast;
window.submitBudgetPlan = submitBudgetPlan;
window.openAddBillModal = openAddBillModal;
window.closeAddBillModal = closeAddBillModal;
window.submitCalendarBill = submitCalendarBill;
window.toggleBillPaidStatus = toggleBillPaidStatus;
window.openGoalTopupModal = openGoalTopupModal;
window.closeGoalTopupModal = closeGoalTopupModal;
window.setTopupMode = setTopupMode;
window.submitGoalTopup = submitGoalTopup;
window.openGoalModal = openGoalModal;

// --- НАВИГАЦИЯ, ФОРМЫ, РЕНДЕР ---
function switchTab(tab) {
  if (selectionMode) disableSelectionMode();
  ['budget', 'transactions', 'deposits', 'broker'].forEach(t => {
    const el = document.getElementById(t + '-tab');
    const navBtn = document.getElementById('nav-' + t);
    if (el) el.classList.add('hidden');
    if (navBtn) navBtn.classList.replace('text-blue-400', 'text-gray-500');
  });
  const activeTabEl = document.getElementById(tab + '-tab');
  const activeNavBtn = document.getElementById('nav-' + tab);
  if (activeTabEl) activeTabEl.classList.remove('hidden');
  if (activeNavBtn) activeNavBtn.classList.replace('text-gray-500', 'text-blue-400');
  
  if (tab === 'budget') renderBudgetTab();
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
  const depGoal = document.getElementById('dep-goal');
  if (depGoal) depGoal.innerHTML = html;

  // Меню быстрого выбора цели в брокере
  const brokerMenu = document.getElementById('broker-goal-dropdown');
  if (brokerMenu) {
    let bHtml = `
      <button type="button" onclick="selectBrokerGoal('')" class="w-full text-left px-3 py-2 text-xs rounded-xl text-gray-400 hover:bg-[#212430] hover:text-white transition-colors cursor-pointer">
        Без привязки к цели
      </button>
    `;
    Cache.goals.forEach(g => {
      const isCur = Cache.broker?.goalId === g.id;
      bHtml += `
        <button type="button" onclick="selectBrokerGoal('${g.id}')" class="w-full text-left px-3 py-2 text-xs rounded-xl flex items-center justify-between transition-colors cursor-pointer ${isCur ? 'bg-[#6C5DD3]/15 text-[#6C5DD3] font-semibold' : 'text-gray-200 hover:bg-[#212430]'}">
          <span class="truncate">${escapeHtml(g.name)}</span>
          ${isCur ? '<i data-lucide="check" class="w-3.5 h-3.5"></i>' : ''}
        </button>
      `;
    });
    brokerMenu.innerHTML = bHtml;
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }
}

function toggleBrokerGoalDropdown(e) {
  if (e) e.stopPropagation();
  const menu = document.getElementById('broker-goal-dropdown');
  if (!menu) return;

  const isClosed = menu.classList.contains('hidden');
  closeAllBrokerPopovers();

  if (isClosed) {
    menu.classList.remove('hidden');
  }
}
window.toggleBrokerGoalDropdown = toggleBrokerGoalDropdown;

function toggleBrokerPopover(type, e) {
  if (e) e.stopPropagation();
  const popDep = document.getElementById('broker-popover-deposit');
  const popBal = document.getElementById('broker-popover-balance');
  const goalMenu = document.getElementById('broker-goal-dropdown');
  if (goalMenu) goalMenu.classList.add('hidden');

  const today = new Date().toISOString().split('T')[0];

  if (type === 'deposit') {
    if (popBal) popBal.classList.add('hidden');
    if (popDep) {
      const isHidden = popDep.classList.contains('hidden');
      popDep.classList.toggle('hidden', !isHidden);
      if (isHidden) {
        document.getElementById('popover-dep-date').value = today;
        document.getElementById('popover-dep-amount').value = '';
        document.getElementById('popover-dep-balance').value = '';
      }
    }
  } else {
    if (popDep) popDep.classList.add('hidden');
    if (popBal) {
      const isHidden = popBal.classList.contains('hidden');
      popBal.classList.toggle('hidden', !isHidden);
      if (isHidden) {
        document.getElementById('popover-bal-date').value = today;
        document.getElementById('popover-bal-input').value = '';
      }
    }
  }
}
window.toggleBrokerPopover = toggleBrokerPopover;

function closeAllBrokerPopovers() {
  const popDep = document.getElementById('broker-popover-deposit');
  const popBal = document.getElementById('broker-popover-balance');
  const goalMenu = document.getElementById('broker-goal-dropdown');
  if (popDep) popDep.classList.add('hidden');
  if (popBal) popBal.classList.add('hidden');
  if (goalMenu) goalMenu.classList.add('hidden');
}
window.closeAllBrokerPopovers = closeAllBrokerPopovers;

async function submitBrokerPopover(type) {
  if (type === 'Пополнение') {
    const date = document.getElementById('popover-dep-date').value || new Date().toISOString().split('T')[0];
    const amount = getUnformattedVal(document.getElementById('popover-dep-amount'));
    const balance = getUnformattedVal(document.getElementById('popover-dep-balance')) || amount;
    if (!amount) return showToast('Введите сумму пополнения', true);
    
    closeAllBrokerPopovers();
    try {
      await getUserCol('Broker').add({ type: 'Пополнение', date, amount, balance });
      await fetchAllData();
      
    } catch (e) {
      showToast('Ошибка сохранения: ' + e.message, true);
    }
  } else {
    const date = document.getElementById('popover-bal-date').value || new Date().toISOString().split('T')[0];
    const balance = getUnformattedVal(document.getElementById('popover-bal-input'));
    if (!balance && balance !== 0) return showToast('Введите баланс', true);
    closeAllBrokerPopovers();
   
    try {
      await getUserCol('Broker').add({ type: 'Баланс', date, amount: balance, balance });
      await fetchAllData();
    } catch (e) {
      showToast('Ошибка сохранения: ' + e.message, true);
    }
  }
}
window.submitBrokerPopover = submitBrokerPopover;

async function selectBrokerGoal(goalId) {
  closeAllBrokerPopovers();
  showToast('Сохранение цели...', false, true);
  try {
    const col = getUserCol('Broker');
    // Очищаем все предыдущие записи привязки цели
    const snap = await col.where('type', '==', 'Цель').get();
    const batch = db.batch();
    snap.docs.forEach(doc => batch.delete(doc.ref));

    // Если выбрана конкретная цель — сохраняем её. Если "Без цели" — оставляем очищенным
    if (goalId) {
      const newDoc = col.doc();
      batch.set(newDoc, {
        type: 'Цель',
        date: new Date().toISOString().split('T')[0],
        goalId: goalId,
        timestamp: Date.now()
      });
    }

    await batch.commit();
    await fetchAllData();
  } catch (err) {
    showToast('Ошибка привязки цели: ' + err.message, true);
  }
}
window.selectBrokerGoal = selectBrokerGoal;

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
  
  // Корректно подставляем значение и визуальный лейбл выбранной категории
  const catInput = row.querySelector('.tx-category');
  const catLabel = row.querySelector('.tx-category-label');
  catInput.value = cat;
  
  const catArr = Cache.categories[type === 'Расход' ? 'expense' : 'income'] || [];
  const foundCat = catArr.find(c => c.name === cat);
  const icon = foundCat && foundCat.icon && foundCat.icon !== '📦' ? foundCat.icon : 'tag';
  if (catLabel) {
    catLabel.innerHTML = `<i data-lucide="${icon}" class="w-4 h-4 mr-1.5 inline-block align-text-bottom"></i> ${escapeHtml(cat)}`;
    catLabel.classList.remove('text-gray-400');
    catLabel.classList.add('text-white');
  }
  if (typeof lucide !== 'undefined') lucide.createIcons();

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

  // 1. Формируем меню выбора месяцев
  const monthMenu = document.getElementById('menu-filter-month');
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

  // 2. Формируем меню выбора категорий (с новыми иконками Lucide)
  const catMenu = document.getElementById('menu-filter-cat');
  if (catMenu && Cache.categories) {
    const allCats = [
      ...Cache.categories.expense.map(c => ({ name: c.name, icon: c.icon || 'tag' })),
      ...Cache.categories.income.map(c => ({ name: c.name, icon: c.icon || 'tag' }))
    ];
    // Оставляем только уникальные категории
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
        <button type="button" onclick="selectFilterValue('cat', '${escapeHtml(name)}', '${escapeHtml(name)}')" class="w-full text-left px-3 py-2 text-xs rounded-xl transition-colors flex items-center gap-2 ${active ? 'bg-blue-600/20 text-blue-300 font-semibold' : 'text-gray-300 hover:bg-gray-700/60'}">
          <i data-lucide="${icon}" class="w-4 h-4"></i>
          <span class="truncate">${escapeHtml(name)}</span>
        </button>
      `;
    });
    catMenu.innerHTML = cHtml;
  }

  // 3. Фильтруем данные согласно выбранным пунктам из меню
  let filteredMonths = data.map(m => {
    if (currentFilterMonth !== 'all' && m.id !== currentFilterMonth) return null;

    let items = m.items;
    if (currentFilterCategory !== 'all') {
      items = items.filter(tx => tx.category === currentFilterCategory);
    }

    if (items.length === 0) return null;

    // Пересчитываем итоги конкретно для отфильтрованных данных
    const expense = items.filter(i => i.type === 'Расход').reduce((sum, i) => sum + i.amount, 0);
    const income = items.filter(i => i.type === 'Доход').reduce((sum, i) => sum + i.amount, 0);

    return { ...m, items, expense, income };
  }).filter(Boolean);

  // 4. Обновляем виджеты «Расходы / Доходы» в шапке и поясняем, что именно рассчитано
  let periodText = 'Тек. мес';
  if (currentFilterMonth === 'all') {
    periodText = 'Все время';
  } else {
    const selectedMonthObj = data.find(m => m.id === currentFilterMonth);
    if (selectedMonthObj) periodText = selectedMonthObj.label;
  }
  if (currentFilterCategory !== 'all') {
    periodText += ` • ${currentFilterCategory}`;
  }

  const expLabel = document.getElementById('month-expense-label');
  const incLabel = document.getElementById('month-income-label');
  if (expLabel) expLabel.innerText = `Расходы (${periodText})`;
  if (incLabel) incLabel.innerText = `Доходы (${periodText})`;

  document.getElementById('month-expense').innerText = formatMoney(filteredMonths.reduce((a, b) => a + b.expense, 0));
  document.getElementById('month-income').innerText = formatMoney(filteredMonths.reduce((a, b) => a + b.income, 0));

  // 5. Отрисовка списка (Пустое состояние)
  if (filteredMonths.length === 0) {
    document.getElementById('transactions-list').innerHTML = '<div class="text-center text-gray-500 py-10 text-[13px]">Операции не найдены</div>';
    if (typeof lucide !== 'undefined') lucide.createIcons();
    return;
  }

  // Хелпер: переводит дату (28.09.2023) в понятный день (Вчера / Сегодня / 28 сентября)
  const getRelativeDayName = (dateStr) => {
    const d = new Date(dateStr.split('.').reverse().join('-'));
    const tday = new Date(); tday.setHours(0, 0, 0, 0);
    const yday = new Date(tday); yday.setDate(tday.getDate() - 1);
    
    if (d.getTime() === tday.getTime()) return 'Сегодня';
    if (d.getTime() === yday.getTime()) return 'Вчера';
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  };

  // 6. Основная сборка DOM (группировка по дням)
  document.getElementById('transactions-list').innerHTML = filteredMonths.map(month => {
    const daysObj = {};
    month.items.forEach(tx => { 
       if(!daysObj[tx.formattedDate]) daysObj[tx.formattedDate] = [];
       daysObj[tx.formattedDate].push(tx);
    });

    return Object.keys(daysObj).map(day => `
      <div class="mb-5">
        <h3 class="font-semibold text-[#848D99] text-[13px] mb-2 px-1 tracking-wide">${getRelativeDayName(day)}</h3>
        <div class="bg-[#181B24] border border-[rgba(255,255,255,0.06)] rounded-2xl overflow-hidden divide-y divide-[rgba(255,255,255,0.03)] shadow-sm">
          ${daysObj[day].map(tx => {
            const isExp = tx.type === 'Расход';
            const catArr = isExp ? Cache.categories.expense : Cache.categories.income;
            const catInfo = catArr.find(c => c.name === tx.category);
            
            // Если иконки нет (старая запись с удаленной категории) — ставим 'tag' по умолчанию
            const iconStr = catInfo && catInfo.icon ? catInfo.icon : 'tag';
            // Нейтральная премиальная подложка для расходов вместо кислотно-красной
            const iconBg = isExp 
              ? 'bg-[#212430] text-[#9EA7B3] border border-[rgba(255,255,255,0.04)]' 
              : 'bg-[#30D158]/10 text-[#30D158] border border-[#30D158]/20';

            return `
              <div class="card cursor-pointer w-full py-[13px] px-4 flex items-center justify-between"
                   data-id="${tx.id}"
                   data-table="Transactions"
                   onclick="openCardContextMenu(event, '${escapeHtml(tx.category)}', () => editTx('${tx.id}', '${tx.type}', ${tx.amount}, '${escapeHtml(tx.category)}', '${escapeHtml(tx.comment)}', '${tx.rawDate}'), () => deleteRecord('Transactions', '${tx.id}'))">
                
                <!-- Чекбокс для мультиселекта долгого нажатия -->
                <input type="checkbox" class="select-checkbox hidden" data-id="${tx.id}">

                <div class="flex items-center gap-3.5 min-w-0">
                   <div class="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${iconBg}">
                      <i data-lucide="${iconStr}" class="w-[22px] h-[22px] stroke-[1.75px]"></i>
                   </div>
                   <div class="min-w-0 flex flex-col justify-center">
                     <span class="text-[15px] font-semibold text-gray-200 truncate leading-snug">${escapeHtml(tx.category)}</span>
                     ${tx.comment ? `<span class="text-[12px] text-gray-500 truncate leading-tight">${escapeHtml(tx.comment)}</span>` : ''}
                   </div>
                </div>

               <div class="tx-amount flex-shrink-0 text-right font-medium ml-2 ${isExp ? 'text-gray-200' : 'text-[#30D158]'} text-[16px]">
                      ${isExp ? '-' : '+'}${formatMoney(tx.amount)}
                  </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `).join('');
  }).join('');

  // 7. Конвертируем все сгенерированные теги <i> в красивые SVG
  if (typeof lucide !== 'undefined') lucide.createIcons();
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
          backgroundColor: 'rgba(48, 209, 88, 0.78)',
          hoverBackgroundColor: '#30D158',
          borderColor: '#30D158',
          hoverBorderColor: '#ffffff',
          borderWidth: 0,
          hoverBorderWidth: 1.5,
          borderRadius: 7,
          borderSkipped: false,
          barPercentage: .72,
          categoryPercentage: .62
        },
        {
          label: 'Расходы',
          data: expenses,
          backgroundColor: 'rgba(255, 69, 58, 0.78)',
          hoverBackgroundColor: '#FF453A',
          borderColor: '#FF453A',
          hoverBorderColor: '#ffffff',
          borderWidth: 0,
          hoverBorderWidth: 1.5,
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
      transitions: {
        active: {
          animation: {
            duration: 450,
            easing: 'easeOutCubic'
          }
        }
      },
      interaction: {
        mode: 'nearest',
        intersect: false
      },
      onClick: (e, elements, chart) => {
        const items = chart.getElementsAtEventForMode(e.native || e, 'nearest', { intersect: false }, false);
        const y = e.y !== undefined ? e.y : (e.native ? e.native.offsetY : 0);

        // Область клика строго вокруг столбца (+25px сверху и +15px снизу)
        const el = items[0]?.element;
        const isNearBar = el && y >= (Math.min(el.y, el.base) - 25) && y <= (Math.max(el.y, el.base) + 15);

        if (!items.length || !isNearBar) {
          chart._activeMonthIndex = -1;
          chart.setActiveElements([]);
          chart.tooltip.setActiveElements([], { x: 0, y: 0 });
          chart.update();
          return;
        }

        const clickedIdx = items[0].index;

        // Повторный клик по тому же столбцу — закрывает тултип (toggle)
        if (chart._activeMonthIndex === clickedIdx) {
          chart._activeMonthIndex = -1;
          chart.setActiveElements([]);
          chart.tooltip.setActiveElements([], { x: 0, y: 0 });
          chart.update();
        } else {
          chart._activeMonthIndex = clickedIdx;
          const activeItems = [
            { datasetIndex: 0, index: clickedIdx },
            { datasetIndex: 1, index: clickedIdx }
          ];
          chart.setActiveElements(activeItems);
          chart.tooltip.setActiveElements(activeItems, {
            x: el.x,
            y: el.y
          });
          chart.update();
        }
      },
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
  // В методе updateAnalyticsForMonth
// Глубокие и строгие тона (Dark Mode HIG Standards)
  const colors = currentStructureType === 'Расход' 
    ? ['#0A84FF', '#FF9F0A', '#FF453A', '#BF5AF2', '#30D158', '#FF375F', '#5E5CE6'] 
    : ['#30D158', '#32ADE6', '#FF9F0A', '#64D2FF'];
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
        hoverOffset: 8,
        hoverBorderColor: '#ffffff',
        hoverBorderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '72%',
      animation: { duration: 350 },
      onClick: (e, elements, chart) => {
        if (!elements || elements.length === 0) {
          chart.setActiveElements([]);
          chart.tooltip.setActiveElements([], { x: 0, y: 0 });
          chart.update();
          return;
        }

        const clickedIdx = elements[0].index;
        const currentActive = chart.getActiveElements();

        // Повторный тап по тому же сегменту закрывает тултип (toggle)
        if (currentActive.length > 0 && currentActive[0].index === clickedIdx) {
          chart.setActiveElements([]);
          chart.tooltip.setActiveElements([], { x: 0, y: 0 });
          chart.update();
        } else {
          chart.setActiveElements([{ datasetIndex: 0, index: clickedIdx }]);
          chart.tooltip.setActiveElements([{ datasetIndex: 0, index: clickedIdx }], {
            x: elements[0].element.x,
            y: elements[0].element.y
          });
          chart.update();
        }
      },
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

// -------------------------------------------------------------
// ГРАФИК БРОКЕРА С ТАЙМФРЕЙМАМИ, ГРАДИЕНТОМ И СКРАББИНГОМ
// -------------------------------------------------------------

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

function submitGoal(e) {
  e.preventDefault();
  submitAction('goal-submit-btn', 'Goals', {
    name: document.getElementById('goal-name').value,
    target: getUnformattedVal(document.getElementById('goal-target')),
    saved: 0,
    share: 100,
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

function openGoalSheet(id, name, target, rawDeadline) {
  openActionSheet(
    id, 
    name, 
    `Цель: ${formatMoney(target)}`,
    () => editGoal(id, name, target, rawDeadline),
    () => deleteRecord('Goals', id)
  );
}

// Умный определитель векторной иконки цели по смыслу названия
function getGoalIcon(name) {
  const n = (name || '').toLowerCase();
  if (/квартир|дом|ремонт|жиль/i.test(n)) return 'home';
  if (/машин|авто|тачк|мото/i.test(n)) return 'car';
  if (/отпуск|море|путешеств|билет|тур/i.test(n)) return 'plane';
  if (/учеб|курс|образов/i.test(n)) return 'graduation-cap';
  if (/подушк|безопасн|резерв/i.test(n)) return 'shield-check';
  if (/инвест|акци/i.test(n)) return 'trending-up';
  if (/телефон|ноут|комп|айфон|гаджет/i.test(n)) return 'smartphone';
  return 'target';
}

function renderGoals() {
  const data = Cache.goals || [];
  if (data.length === 0) {
    document.getElementById('goals-list').innerHTML = '<div class="text-center text-[#848D99] py-10 text-[13px]">Целей нет</div>';
    return;
  }
  document.getElementById('goals-list').innerHTML = data.map(g => {
    const goalIcon = getGoalIcon(g.name);

    // Расчет ежемесячного плана пополнений для достижения цели в срок
    let paceBadge = '';
    if (g.rawDeadline && !g.isAchieved) {
      const now = new Date();
      const dl = new Date(g.rawDeadline);
      const monthsRemaining = Math.max(1, Math.round((dl - now) / (1000 * 60 * 60 * 24 * 30.4375)));
      const remainingSum = Math.max(0, g.target - g.saved);
      const monthlyNeed = Math.ceil(remainingSum / monthsRemaining);
      paceBadge = `<span class="text-[11px] text-[#848D99] font-normal">Осталось ${monthsRemaining} мес. • <span class="whitespace-nowrap">Вносить ~${formatMoney(monthlyNeed)}/мес.</span></span>`;
    }

    return `
      <div class="card rounded-2xl w-full flex flex-col p-5 cursor-pointer overflow-hidden mb-4 border border-[rgba(255,255,255,0.06)] ${g.isAchieved ? 'ring-1 ring-[#30D158]/40 bg-[#30D158]/5' : 'bg-[#181B24]'}" 
           data-id="${g.id}" data-table="Goals"
           onclick="openCardContextMenu(event, '${escapeHtml(g.name)}', () => editGoal('${g.id}', '${escapeHtml(g.name)}', ${g.target}, '${g.rawDeadline}'), () => deleteRecord('Goals', '${g.id}'))">
        
        <div class="flex justify-between items-start w-full mb-3">
          <div class="flex items-center gap-3 min-w-0">
            <div class="w-10 h-10 rounded-2xl ${g.isAchieved ? 'bg-[#30D158]/15 text-[#30D158]' : 'bg-[#6C5DD3]/15 text-[#6C5DD3]'} flex items-center justify-center flex-shrink-0">
              <i data-lucide="${goalIcon}" class="w-5 h-5"></i>
            </div>
            <div class="min-w-0">
              <h3 class="text-[16px] font-semibold text-gray-100 truncate leading-tight">${escapeHtml(g.name)}</h3>
              <div class="mt-0.5">${paceBadge || `<span class="text-[11px] text-[#848D99]">До ${escapeHtml(g.deadlineStr)}</span>`}</div>
            </div>
          </div>

          ${g.isAchieved 
            ? `<span class="px-2.5 py-0.5 text-[10px] font-bold tracking-wider uppercase bg-[#30D158]/20 text-[#30D158] rounded-full flex-shrink-0">Выполнена</span>`
            : `<span class="text-[15px] font-bold ${g.progress >= 75 ? 'text-emerald-400' : 'text-[#6C5DD3]'}">${g.progress}%</span>`
          }
        </div>

        <div class="flex items-end justify-between w-full mt-2 mb-2">
          <div class="text-[13px] font-medium tracking-wide">
            <span class="text-white text-[17px] font-bold">${formatMoney(g.saved)}</span>
            <span class="text-gray-600 mx-1">из</span>
            <span class="text-gray-400">${formatMoney(g.target)}</span>
          </div>
        </div>

        <!-- Выразительный градиентный прогресс-бар высотой 8.5px -->
        <div class="w-full bg-[rgba(255,255,255,0.06)] h-[8.5px] rounded-full overflow-hidden">
          <div class="h-full rounded-full transition-all duration-500 ${g.isAchieved ? 'bg-[#30D158]' : 'bg-gradient-to-r from-[#6C5DD3] to-[#32ADE6]'}" style="width:${g.progress}%"></div>
        </div>
      </div>
    `;
  }).join('');
  
  if(typeof lucide !== 'undefined') lucide.createIcons();
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
let selectedItems = new Set(); // ключи вида "table:id"
let longPressTimer = null;
let longPressTriggered = false;
let suppressClick = false;
let currentCategoryType = 'Расход';
let currentCategorySelect = null;
let selectedCategoryIcon = 'package';
const availableIcons = [
  'shopping-cart', 'utensils', 'car', 'home', 'film', 'package', 'briefcase', 'baby', 'paw-print', 'pill',
  'shopping-bag', 'plane', 'dumbbell', 'gamepad-2', 'book', 'music', 'gift', 'coffee', 'pizza', 'shirt',
  'lightbulb', 'wrench', 'smartphone', 'laptop', 'monitor', 'camera', 'palette', 'headphones', 'target', 'trophy',
  'bus', 'train', 'navigation', 'zap', 'bath', 'sparkles', 'archive', 'leaf', 'globe', 'credit-card'
];

function attachSelectionPanelDirectEvents() {
  const cancelBtn = document.getElementById('cancel-selection');
  const deleteBtn = document.getElementById('delete-selected');
  if (!cancelBtn || !deleteBtn) return;

  const onCancel = (e) => {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    cancelSelection();
  };

  const onDelete = (e) => {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    deleteSelectedItems();
  };

  cancelBtn.onclick = onCancel;
  cancelBtn.ontouchend = onCancel;
  deleteBtn.onclick = onDelete;
  deleteBtn.ontouchend = onDelete;
}

// Регистрация глобальных обработчиков
document.addEventListener('touchstart', handleTouchStart, { passive: true });
document.addEventListener('touchend', handleTouchEnd);
document.addEventListener('touchmove', handleTouchMove, { passive: true });
document.addEventListener('mousedown', handleMouseDown);
document.addEventListener('mouseup', handleMouseUp);
document.addEventListener('mousemove', handleMouseMove);

document.addEventListener('click', (e) => {
  // Кнопки панели мультивыбора должны срабатывать ВСЕГДА, даже если выделена всего одна карточка
  if (e.target.id === 'cancel-selection' || e.target.closest('#cancel-selection')) {
    if (e) e.stopPropagation();
    cancelSelection();
    return;
  }
  if (e.target.id === 'delete-selected' || e.target.closest('#delete-selected')) {
    if (e) e.stopPropagation();
    deleteSelectedItems();
    return;
  }

  // Игнорируем клик после долгого нажатия только для прочих элементов
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

  // Обработка кликов по карточкам в режиме выбора
  if (!selectionMode) return;
  const card = e.target.closest('.card');
  if (!card) return;

  e.preventDefault();
  toggleItemSelection(card.dataset.id, card.dataset.table);
});

// Гибридная загрузка: системный словарь из файла + пользовательские оверрайды из Firestore
async function processOrSeedRules(snapshot) {
  const userDocs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

  const norm = (str) => typeof StatementCategorizer !== 'undefined' ? StatementCategorizer.normalize(str) : String(str || '').toLowerCase().trim();

  // Маркеры подавленных пользователем системных слов
  const disabledPatterns = new Set(
    userDocs.filter(d => d.disabled).map(d => norm(d.pattern))
  );

  // Пользовательские добавленные правила
  const customRules = userDocs.filter(d => !d.disabled && d.pattern && d.category).map(d => ({
    id: d.id,
    pattern: d.pattern.trim(),
    category: d.category,
    isSystem: false
  }));

  const customMap = new Map();
  customRules.forEach(r => customMap.set(norm(r.pattern), r));

  // Берем системные правила из default-rules.js
  const systemDefaults = window.DEFAULT_CATEGORY_RULES || [];
  const combined = [];

  systemDefaults.forEach((rule, idx) => {
    const patKey = norm(rule.pattern);
    if (disabledPatterns.has(patKey)) return;

    if (customMap.has(patKey)) {
      combined.push(customMap.get(patKey));
      customMap.delete(patKey);
    } else {
      combined.push({
        id: 'sys_' + idx,
        pattern: rule.pattern,
        category: rule.category,
        isSystem: true
      });
    }
  });

  customMap.forEach(rule => combined.push(rule));

  return combined;
}

  // Если пользователь находился во вкладке брокера и выключил её — переключаем на трат
  const brokerTab = document.getElementById('broker-tab');
  if (!show && brokerTab && !brokerTab.classList.contains('hidden')) {
    switchTab('transactions');
  }
}
