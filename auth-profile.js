// ==========================================
// Variables
// ==========================================
let currentAuthMode = 'login'; // Отвечает за переключение формы (Вход / Регистрация)

// Память навигации: запоминаем, если окно было вызвано из профиля
window._returnToProfile = false;

// ==========================================
// Authentication Functions
// ==========================================
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

// ==========================================
// Account & Data Management
// ==========================================
// Полное удаление аккаунта и всех его подколлекций
async function deleteCurrentAccountAndData() {
  const user = auth.currentUser;
  if (!user) return;

  showDialog('Удаление аккаунта', 'ВНИМАНИЕ! Все ваши транзакции, вклады, цели и настройки будут безвозвратно удалены. Продолжить?', true, async () => {
    showToast('Удаление всех данных аккаунта...', false, true);
    try {
      const tables = ['Transactions', 'Deposits', 'Broker', 'Goals', 'Categories', 'CategoryRules', 'BudgetPlan', 'CalendarBills'];

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

// ==========================================
// Profile & Settings UI
// ==========================================

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

function openSubModalFromProfile(type) {
  closeProfileModal(); // временно закрываем профиль
  window._returnToProfile = true; // ставим маячок возврата

  if (type === 'categories') {
    if (typeof showManageCategoriesDialog === 'function') showManageCategoriesDialog();
  } else if (type === 'rules') {
    if (typeof openRulesEditorModal === 'function') openRulesEditorModal();
  }
}

// ==========================================
// Global Scope Exports
// ==========================================
window.setAuthMode = setAuthMode;
window.loginWithGoogle = loginWithGoogle;
window.handleAuthSubmit = handleAuthSubmit;
window.logoutUser = logoutUser;
window.deleteCurrentAccountAndData = deleteCurrentAccountAndData;
window.openProfileModal = openProfileModal;
window.closeProfileModal = closeProfileModal;
window.toggleBrokerSetting = toggleBrokerSetting;
window.openSubModalFromProfile = openSubModalFromProfile;
window.loadUserSettings = loadUserSettings;
window.applyBrokerVisibility = applyBrokerVisibility;
