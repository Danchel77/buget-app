/**
 * statement-parser.js
 * Парсер банковских PDF-выписок (Шаг 1: извлечение текста, Шаг 2: формирование таблицы)
 */

if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

// -------------------------------------------------------------
// 1. ИЗВЛЕЧЕНИЕ СЫРОГО ТЕКСТА
// -------------------------------------------------------------
class StatementExtractor {
  static async extractLinesFromPDF(file) {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const allLines = [];

    const Y_TOLERANCE = 3.5;

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      
      const sortedItems = textContent.items.filter(it => it.str && it.str.trim().length > 0);
      sortedItems.sort((a, b) => {
        if (Math.abs(a.transform[5] - b.transform[5]) > Y_TOLERANCE) {
          return b.transform[5] - a.transform[5];
        }
        return a.transform[4] - b.transform[4];
      });

      let currentLine = [];
      let currentY = null;

      for (const item of sortedItems) {
        const text = item.str.trim();
        const y = item.transform[5];

        if (currentY === null || Math.abs(y - currentY) <= Y_TOLERANCE) {
          currentLine.push(text);
          if (currentY === null) currentY = y;
        } else {
          if (currentLine.length > 0) {
            allLines.push(currentLine.join(' '));
          }
          currentLine = [text];
          currentY = y;
        }
      }
      if (currentLine.length > 0) {
        allLines.push(currentLine.join(' '));
      }
    }

    return allLines;
  }
}

// -------------------------------------------------------------
// ДИНАМИЧЕСКИЕ КАТЕГОРИИ И ИКОНКИ ИЗ FIREBASE
// -------------------------------------------------------------

/**
 * Возвращает массив названий категорий нужного типа из Firebase
 */
function getActiveCategories(type = 'Расход') {
  const cats = window.Cache?.categories;
  if (!cats) {
    return type === 'Доход' ? ['Зарплата', 'Другое'] : ['Продукты', 'Другое'];
  }
  const list = type === 'Доход' ? (cats.income || []) : (cats.expense || []);
  return list.map(c => c.name);
}

/**
 * Находит актуальную иконку для любой категории из базы (включая созданные пользователем)
 */
function getDynamicCategoryIcon(catName) {
  const cats = window.Cache?.categories;
  if (cats) {
    const all = [...(cats.expense || []), ...(cats.income || [])];
    const found = all.find(c => c.name === catName);
    if (found && found.icon && found.icon !== '📦') return found.icon;
  }
  return 'tag'; // Глобальный вектор-дефолт, вместо эмодзи коробки
}

// -------------------------------------------------------------
// 3. УНИВЕРСАЛЬНЫЙ ОПРЕДЕЛИТЕЛЬ (И ДОХОДЫ, И РАСХОДЫ ИЗ FIREBASE)
// -------------------------------------------------------------
class StatementCategorizer {
  static categorize(merchant, rawDetails, type) {
    const text = `${merchant} ${rawDetails}`.toLowerCase();
    const rules = window.Cache?.categoryRules || [];

    // Получаем ТОЛЬКО актуальные категории нужного типа из базы
    const allowedCategories = getActiveCategories(type);

    // Сверяем с правилами из базы
    for (const rule of rules) {
      if (!rule.pattern || !rule.category) continue;

      // Если категория правила не существует в категориях этого типа — пропускаем
      if (!allowedCategories.includes(rule.category)) continue;

      const pattern = rule.pattern.toLowerCase().trim();
      if (this._matches(text, pattern)) {
        return rule.category;
      }
    }

    // Если ничего не подошло — ставим 'Другое' (или первую категорию из списка)
    return allowedCategories.includes('Другое') ? 'Другое' : (allowedCategories[0] || 'Другое');
  }

  static _matches(text, pattern) {
    if (pattern.length <= 4) {
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(^|[^a-zA-Zа-яА-Я0-9])${escaped}([^a-zA-Zа-яА-Я0-9]|$)`, 'i');
      return regex.test(text);
    }
    return text.includes(pattern);
  }
}

// =============================================================
// 1. УНИВЕРСАЛЬНЫЙ ДВИЖОК ПАРСИНГА ВЫПИСОК
// =============================================================

// Единый список признаков переводов и движения наличных для всех банков
const UNIVERSAL_TRANSFER_KEYWORDS = [
  'перевод', 'сбп', 'между счетами', 'снятие наличных', 'внесение наличных',
  'взнос наличными', 'зачисление наличных', 'пополнение наличными', 'наличными',
  'vklad-karta', 'karta-vklad', 'bpwww', 'брокер', 'vb24'
];

// Общие служебные строки (шапки, подвалы документов)
const COMMON_SERVICE_LINES = [
  'страница', 'выписка по', 'справка о движении', 'входящий остаток',
  'исходящий остаток', 'итого зачислений', 'итого списаний', 'с уважением',
  'руководитель департамента', 'лицензия банка россии', 'номер лицевого счёта'
];

// Утилита очистки суммы из строки в число
function cleanAmount(str) {
  if (!str) return 0;
  const clean = str.replace(/[+−–—\-\u2012\u2013\u2014\u2212]/g, '')
                   .replace(/[^\d.,]/g, '')
                   .replace(',', '.');
  return Math.abs(parseFloat(clean)) || 0;
}

/**
 * ЕДИНЫЙ ДВИЖОК: собирает строки в блоки, проверяет переводы и нормализует данные
 */
class UniversalStatementParser {
  static parse(rawLines, config) {
    const rawBlocks = [];
    let currentBlock = null;

    for (let line of rawLines) {
      line = line.trim();
      if (!line || this._isServiceLine(line, config)) continue;

      if (config.isTxStart(line)) {
        if (currentBlock) rawBlocks.push(currentBlock);
        currentBlock = [line];
      } else if (currentBlock) {
        currentBlock.push(line);
      }
    }
    if (currentBlock) rawBlocks.push(currentBlock);

    return rawBlocks.map(block => this._processBlock(block, config)).filter(Boolean);
  }

  static _processBlock(lines, config) {
    // Извлекаем поля через правила конкретного банка
    const data = config.extract(lines);
    if (!data || !data.date || !data.amount) return null;

    const fullText = lines.join(' ');
    const merchant = data.merchant || 'Банковская операция';

    // Универсальная проверка на перевод / наличные
    const isTransfer = this._checkIfTransfer(fullText, merchant, config);

    // Нормализация даты в YYYY-MM-DD
    let isoDate = data.date;
    if (data.date.includes('.')) {
      const [d, m, y] = data.date.split('.');
      isoDate = `${y.length === 2 ? '20' + y : y}-${m}-${d}`;
    }

    // Динамическая категоризация через базу Firebase
    const category = StatementCategorizer.categorize(merchant, `${data.hint || ''} ${fullText}`, data.type);

    return {
      date: isoDate,
      displayDate: data.date,
      type: data.type,
      amount: data.amount,
      merchant: merchant,
      category: category,
      isTransfer: isTransfer,
      bank: config.name,
      rawDetails: fullText
    };
  }

  static _checkIfTransfer(fullText, merchant, config) {
    const text = `${fullText} ${merchant}`.toLowerCase();
    const hasUniversal = UNIVERSAL_TRANSFER_KEYWORDS.some(kw => text.includes(kw));
    const hasCustom = config.customTransferCheck ? config.customTransferCheck(text) : false;
    return hasUniversal || hasCustom;
  }

  static _isServiceLine(line, config) {
    const l = line.toLowerCase();
    const isCommon = COMMON_SERVICE_LINES.some(kw => l.includes(kw));
    const isCustom = config.isServiceLine ? config.isServiceLine(l) : false;
    return isCommon || isCustom;
  }
}

// =============================================================
// 2. РЕЕСТР БАНКОВ (КАЖДЫЙ БАНК — ПРОСТОЙ ОБЪЕКТ НАСТРОЕК)
// =============================================================

const BANK_REGISTRY = [
  // --- СБЕРБАНК ---
  {
    id: 'SBER',
    name: 'Сбербанк',
    slug: 'sberbank',
    badgeColor: 'bg-emerald-900/60 text-emerald-300 border-emerald-700/60',
    detect: (p) => p.includes('sberbank.ru') || p.includes('сбербанк онлайн') || p.includes('пао сбербанк') || p.includes('выписка по платёжному счёту'),
    isTxStart: (l) => /^(\d{2}\.\d{2}\.\d{4})\s+\d{2}:\d{2}/.test(l) && !/^\d{2}\.\d{2}\.\d{4}\s+\d{6}/.test(l),
    extract: (lines) => {
      const first = lines[0];
      const dMatch = first.match(/^(\d{2}\.\d{2}\.\d{4})/);
      const after = first.replace(/^(\d{2}\.\d{2}\.\d{4})\s+\d{2}:\d{2}\s+/, '');
      const amounts = after.match(/([+-]?\s*[\d\s]+[.,]\d{2})/g) || [];
      const rawAmount = amounts[0] || '0';
      const type = rawAmount.includes('+') ? 'Доход' : 'Расход';

      let sberCat = after;
      amounts.forEach(a => sberCat = sberCat.replace(a, ''));
      sberCat = sberCat.trim();

      let merchant = sberCat;
      if (lines.length > 1) {
        let desc = lines[1].replace(/^\d{2}\.\d{2}\.\d{4}\s+\d+\s*/, '')
                           .replace(/\.?\s*(Операция|Перевод)\s+по.*$/i, '')
                           .trim();
        if (desc) merchant = desc;
      }
      return { date: dMatch[1], amount: cleanAmount(rawAmount), type, merchant, hint: sberCat };
    }
  },

  // --- ГАЗПРОМБАНК ---
  {
    id: 'GPB',
    name: 'Газпромбанк',
    slug: 'gazprombank',
    badgeColor: 'bg-blue-900/60 text-blue-300 border-blue-700/60',
    detect: (p) => p.includes('газпромбанк') || p.includes('банк гпб') || (p.includes('дата отражения') && p.includes('содержание операции')),
    isTxStart: (l) => /^(\d{2}\.\d{2}\.\d{4})\s+(\d{2}\.\d{2}\.\d{4})/.test(l),
    extract: (lines) => {
      const first = lines[0];
      const dMatch = first.match(/^(\d{2}\.\d{2}\.\d{4})/);
      const amounts = first.match(/([+-]?\s*[\d\s]+[.,]\d{2})/g) || [];
      let inc = 0, exp = 0;
      if (amounts.length >= 2) {
        inc = cleanAmount(amounts[amounts.length - 2]);
        exp = cleanAmount(amounts[amounts.length - 1]);
      } else if (amounts.length === 1) {
        exp = cleanAmount(amounts[0]);
      }
      const type = (exp === 0 && inc > 0) ? 'Доход' : 'Расход';
      const amount = type === 'Доход' ? inc : exp;

      const full = lines.join(' ');
      const dev = full.match(/Устройство:\s*([^.]+?)(?:\.\s*Город|\.\s*Сумма|\.|$)/i);
      const sbp = full.match(/Перевод\s+(?:по\s+СБП|клиенту|от)\s+([^.]+?)(?:\.|$)/i);
      let merchant = dev ? dev[1].trim() : (sbp ? sbp[0].trim() : first.replace(/^(\d{2}\.\d{2}\.\d{4}\s*){1,2}/, '').replace(/([+-]?\s*[\d\s]+[.,]\d{2})/g, '').replace(/Операция:\s*/i, '').trim());

      return { date: dMatch[1], amount, type, merchant };
    }
  },

  // --- ЯНДЕКС БАНК ---
  {
    id: 'YANDEX',
    name: 'Яндекс Банк',
    slug: 'yandexbank',
    badgeColor: 'bg-amber-900/60 text-amber-300 border-amber-700/60',
    detect: (p) => p.includes('yabank.yandex.ru') || p.includes('ао «яндекс банк»') || (p.includes('яндекс') && p.includes('в рамках договора открыт счёт')),
    isTxStart: (l) => /\d{2}\.\d{2}\.\d{4}/.test(l) && /[\d\s\xa0]+[.,]\d{2}\s*₽/.test(l),
    isServiceLine: (l) => (l.includes('операции') && l.includes('мск')) || (l.includes('обработки') && l.includes('договора')),
    extract: (lines) => {
      const first = lines[0];
      const dMatch = first.match(/\d{2}\.\d{2}\.\d{4}/);
      const amounts = first.match(/([+−–—\-\u2012\u2013\u2014\u2212]?\s*[\d\s\xa0]+[.,]\d{2})\s*₽/g) || [];
      const raw = amounts[0] || '0';
      const type = raw.includes('+') ? 'Доход' : 'Расход';

      let part1 = first.split(/\d{2}\.\d{2}\.\d{4}/)[0].replace(/^Оплата товаров и услуг\s*/i, '').trim();
      let part2 = lines.slice(1).map(l => l.replace(/в\s+\d{2}:\d{2}/i, '').replace(/\d{2}\.\d{2}\.\d{4}/g, '').replace(/\*\d{4}/g, '').replace(/[\d\s\xa0]+[.,]\d{2}\s*₽/g, '').trim()).filter(Boolean).join(' ');
      let merchant = `${part1} ${part2}`.replace(/^Оплата товаров и услуг\s*/i, '').replace(/\b(операции|обработки|договора|мск|карты|валюте)\b/gi, '').replace(/\s+/g, ' ').trim() || 'Операция Яндекс Банк';

      return { date: dMatch[0], amount: cleanAmount(raw), type, merchant };
    }
  },

  // --- ОЗОН БАНК ---
  {
    id: 'OZON',
    name: 'Озон Банк',
    slug: 'ozonbank',
    badgeColor: 'bg-sky-900/60 text-sky-300 border-sky-700/60',
    detect: (p) => p.includes('ооо «озон банк»') || p.includes('справка о движении средств') || (p.includes('ozon') && p.includes('лицензия банка россии')),
    isTxStart: (l) => /^\d{2}\.\d{2}\.\d{4}/.test(l),
    extract: (lines) => {
      const first = lines[0];
      const dMatch = first.match(/(\d{2}\.\d{2}\.\d{4})/);
      const full = lines.join(' ');
      const amounts = full.match(/([+−–—\-\u2012\u2013\u2014\u2212]\s*[\d\s\xa0]+[.,]\d{2})/g) || [];
      const raw = amounts[0] || '0';
      const type = raw.includes('+') ? 'Доход' : 'Расход';

      let merchant = 'Операция Озон Банк';
      const pos = full.match(/(?:сумма\s*[\d.]+\s*в|\bв)\s+([\s\S]+?)\s+дата\s*\d{4}/i);
      if (pos && pos[1].trim()) {
        merchant = pos[1].replace(/\s+(RU|RUS)$/i, '').replace(/\s+/g, ' ').trim();
      } else if (/выплата\s+к[еэ]шб[еэ]ка/i.test(full)) {
        merchant = 'Кэшбек Ozon';
      } else if (/возврат/i.test(full)) {
        const o = full.match(/заказ\s*№?\s*([0-9a-zA-Z-]+)/i);
        merchant = o ? `Возврат Ozon (${o[0]})` : 'Возврат покупки';
      } else if (/ozon\s*travel/i.test(full)) {
        const o = full.match(/заказ\s*№?\s*([0-9a-zA-Z-]+)/i);
        merchant = o ? `Ozon Travel (${o[0]})` : 'Ozon Travel';
      } else if (/платформе\s+ozon|оплата.*ozon/i.test(full)) {
        const o = full.match(/заказ\s*№?\s*([0-9a-zA-Z-]+)/i);
        merchant = o ? `Ozon (${o[0]})` : 'Ozon';
      } else if (/перевод.*сбп/i.test(full)) {
        const s = full.match(/(?:Отправитель|Получатель):\s*([^.]*?)(?:Без НДС|$)/i);
        merchant = s ? `Перевод СБП (${s[1].trim()})` : 'Перевод через СБП';
      }

      return { date: dMatch[1], amount: cleanAmount(raw), type, merchant };
    }
  }
];

// =============================================================
// 3. ДИСПЕТЧЕР (НАХОДИТ БАНК И ЗАПУСКАЕТ ПАРСИНГ)
// =============================================================
class StatementDispatcher {
  static parse(rawLines) {
    const preview = rawLines.slice(0, 40).join(' ').toLowerCase();
    
    // Ищем подходящий банк в реестре
    const config = BANK_REGISTRY.find(bank => bank.detect(preview));

    if (!config) {
      const supported = BANK_REGISTRY.map(b => b.name).join(', ');
      throw new Error(`Банк не поддерживается. На данный момент доступны: ${supported}.`);
    }

    const transactions = UniversalStatementParser.parse(rawLines, config);
    return { bank: config, transactions };
  }
}

// -------------------------------------------------------------
// 3. UI-ОБРАБОТЧИК И ВЫВОД РЕЗУЛЬТАТА ШАГА 2
// -------------------------------------------------------------
async function handleStatementUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  if (file.type !== 'application/pdf') {
    showToast('Пожалуйста, выберите файл в формате PDF', true);
    return;
  }

  showToast('Обработка выписки...', false, true);

  try {
    // 1. Вытягиваем строки
    const lines = await StatementExtractor.extractLinesFromPDF(file);

    const result = StatementDispatcher.parse(lines);
    renderParsedTransactionsView(file.name, result.transactions, result.bank);

    event.target.value = '';
    document.getElementById('toast-container').classList.add('hidden');

  } catch (err) {
    console.error('Ошибка обработки PDF:', err);
    showToast('Ошибка: ' + err.message, true);
  }
}

// -------------------------------------------------------------
// 4. ПРОВЕРКА ДУБЛИКАТОВ И ИМПОРТ В FIREBASE
// -------------------------------------------------------------

/**
 * Проверяет, есть ли уже такая операция в Cache.transactions
 */
function isTransactionDuplicate(tx) {
  if (!window.Cache || !window.Cache.transactions) return false;

  for (const month of window.Cache.transactions) {
    for (const item of month.items) {
      if (
        item.rawDate === tx.date &&
        Math.abs(item.amount - tx.amount) < 0.01 &&
        item.type === tx.type
      ) {
        return true;
      }
    }
  }
  return false;
}


// -------------------------------------------------------------
// ОБНОВЛЕННЫЙ РЕНДЕР КАРТОЧЕК И ВЫБОРА КАТЕГОРИЙ
// -------------------------------------------------------------
function renderParsedTransactionsView(fileName, transactions, bankConfig) {
  window._lastActiveBank = bankConfig; // Сохраняем весь конфиг банка

  // Сортировка от самых свежих к старым (по убыванию даты)
  transactions.sort((a, b) => b.date.localeCompare(a.date));
  
  const dialog = document.getElementById('pdf-debug-dialog');
  const info = document.getElementById('pdf-debug-info');
  const output = document.getElementById('pdf-debug-output');

  // Берем живые категории строго из базы данных
  const expenseCategories = getActiveCategories('Расход');
  const incomeCategories = getActiveCategories('Доход');

  // Подготовка и принудительная категоризация
  transactions.forEach((tx, idx) => {
    tx._id = 'tx_parsed_' + idx;
    
    // Принудительно определяем категорию, если она не была определена ранее
    if (!tx.category || tx.category === 'Не определено') {
      tx.category = StatementCategorizer.categorize(tx.merchant, tx.rawDetails, tx.type);
    }

    tx.isDuplicate = isTransactionDuplicate(tx);
    // Снимаем галочку, если это дубликат ИЛИ если это перевод
    tx.selected = !tx.isDuplicate && !tx.isTransfer;
  });

  window._lastParsedTransactions = transactions;

  function updateHeaderSummary() {
    const selectedTxs = transactions.filter(t => t.selected);
    const totalExp = selectedTxs.filter(t => t.type === 'Расход').reduce((s, t) => s + t.amount, 0);
    const totalInc = selectedTxs.filter(t => t.type === 'Доход').reduce((s, t) => s + t.amount, 0);

    const bankBadgeColor = bankConfig.badgeColor || 'bg-blue-900/60 text-blue-300 border-blue-700/60';
    const bankName = bankConfig.name || 'Банк';
    
    info.innerHTML = `
      <div class="flex items-center gap-2 mb-1 min-w-0">
        <span class="text-[10px] font-bold px-2 py-0.5 rounded-full border ${bankBadgeColor} flex-shrink-0">${escapeHtml(bankName)}</span>
        <span class="text-xs text-gray-300 truncate flex-1 min-w-0" title="${escapeHtml(fileName)}">${escapeHtml(fileName)}</span>
      </div>
      <div>К импорту: <b class="text-white">${selectedTxs.length}</b> из ${transactions.length} | 
      <span class="text-red-400">Расход: ${formatMoney(totalExp)}</span> | 
      <span class="text-emerald-400">Доход: ${formatMoney(totalInc)}</span></div>
    `;

    const importBtn = document.getElementById('btn-import-transactions');
    if (importBtn) {
      importBtn.innerText = `Импортировать (${selectedTxs.length})`;
      importBtn.disabled = selectedTxs.length === 0;
    }
  }

  let html = `<div class="space-y-2.5">`;

  transactions.forEach(tx => {
    const isInactive = tx.isDuplicate || tx.isTransfer;
    const isExp = tx.type === 'Расход';
    const amountSign = isExp ? '-' : '+';
    // Для неактивных карточек сумма окрашивается в тускло-серый цвет
    const amountColor = isInactive ? 'text-gray-500 font-medium' : (isExp ? 'text-white font-bold' : 'text-emerald-400 font-bold');
    const cats = isExp ? expenseCategories : incomeCategories;
    const currentIcon = getDynamicCategoryIcon(tx.category);
    
    html += `
      <!-- Карточка: активная выделяется ярче, неактивная (перевод/дубль) становится глубоко-серой -->
      <div class="card-parsed-row border ${isInactive ? 'bg-[#0e1217] border-gray-800/90' : 'bg-gray-900 border-gray-700/80 shadow-sm'} p-3 rounded-2xl space-y-2 relative" id="card-tx-${tx._id}">
        
        <!-- СТРОКА 1: Чекбокс, наименование и кнопка запоминания -->
        <div class="flex items-center justify-between gap-2 min-w-0">
          <div class="flex items-center gap-2.5 min-w-0 flex-1">
            <input type="checkbox" 
                   class="w-4 h-4 rounded accent-blue-600 bg-gray-800 border-gray-700 flex-shrink-0 cursor-pointer"
                   data-tx-id="${tx._id}"
                   ${tx.selected ? 'checked' : ''}
                   onchange="toggleTxSelection('${tx._id}', this.checked)">
            
            <span class="text-xs ${isInactive ? 'text-gray-400 font-normal' : 'text-gray-100 font-semibold'} truncate flex-1 min-w-0" title="${escapeHtml(tx.merchant)}">
              ${escapeHtml(tx.merchant)}
            </span>
          </div>

          <button type="button" 
                  onclick="openRememberRuleModal('${tx._id}')" 
                  class="text-xs text-[#848D99] hover:text-[#6C5DD3] bg-[#212430] hover:bg-[#2A2D3C] border border-[rgba(255,255,255,0.06)] px-2 py-1.5 rounded-lg transition-colors cursor-pointer flex-shrink-0 flex items-center justify-center" 
                  title="Запомнить правило для этой точки">
            <i data-lucide="pin" class="w-3.5 h-3.5"></i>
          </button>
        </div>

        <!-- СТРОКА 2: Дата слева, бейдж справа -->
        <div class="flex items-center justify-between gap-2">
          <span class="text-[11px] ${isInactive ? 'text-gray-600' : 'text-gray-400'} font-mono">${tx.displayDate}</span>
          
          <div class="flex items-center gap-1.5 flex-shrink-0">
            ${tx.isTransfer ? '<span class="text-[9px] text-amber-500/90 bg-amber-950/30 px-1.5 py-0.5 rounded border border-amber-900/40">Перевод</span>' : ''}
            ${tx.isDuplicate ? '<span class="text-[9px] text-gray-400 bg-gray-800/80 px-1.5 py-0.5 rounded border border-gray-700/60">В базе</span>' : ''}
          </div>
        </div>

        <!-- СТРОКА 3: Категория слева, сумма справа -->
        <div class="flex items-center justify-between gap-2 pt-2 border-t border-gray-800/60">
          <div class="relative custom-dropdown-wrap" id="cat-wrap-${tx._id}">
            <button type="button" 
                    onclick="toggleImportCatMenu('${tx._id}')" 
                    id="cat-btn-${tx._id}"
                    class="w-44 ${isInactive ? 'bg-transparent border-gray-700/50 text-gray-400' : 'bg-[#181B24] border-[rgba(255,255,255,0.12)] text-[#F2F4F7] shadow-sm'} text-xs font-medium rounded-xl px-2.5 py-2 flex items-center justify-between outline-none transition-colors">
              <span id="cat-label-${tx._id}" class="truncate flex items-center gap-1.5">
                <i data-lucide="${currentIcon}" class="w-[14px] h-[14px]"></i> 
                ${escapeHtml(tx.category)}
              </span>
              <i data-lucide="chevron-down" class="w-3.5 h-3.5 text-gray-500"></i>
            </button>
            
            <div id="cat-menu-${tx._id}" 
                 class="custom-dropdown-menu hidden absolute left-0 w-52 max-h-60 overflow-y-auto bg-[#181B24] border border-[rgba(255,255,255,0.06)] rounded-xl shadow-[0_10px_40px_rgba(0,0,0,0.8)] z-50 p-1.5 space-y-0.5">
              ${cats.map(cat => {
                const defaultList = ['Продукты', 'Кафе и рестораны', 'Маркетплейсы', 'Транспорт', 'Жилье', 'Развлечения', 'Другое', 'Зарплата', 'Возврат', 'Кэшбек'];
                const isCustom = !defaultList.includes(cat);
                const loopIcon = getDynamicCategoryIcon(cat);
                return `
                  <div class="flex items-center justify-between hover:bg-[#2A2D3C] rounded-lg px-2.5 py-1.5 transition-colors group">
                    <button type="button" 
                            onclick="selectImportCat('${tx._id}', '${escapeHtml(cat)}', '${loopIcon}')" 
                            class="flex-1 text-left text-[13px] font-medium text-gray-200 flex items-center gap-2.5 cursor-pointer truncate min-w-0">
                      <i data-lucide="${loopIcon}" class="w-4 h-4 text-[#848D99]"></i>
                      <span class="truncate">${escapeHtml(cat)}</span>
                    </button>
                    ${isCustom ? `
                      <button type="button" onclick="event.stopPropagation(); deleteCategoryFromImport('${escapeHtml(cat)}', '${tx.type}')" class="text-gray-500 hover:text-[#FF453A] p-1 flex-shrink-0 cursor-pointer"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
                    ` : ''}
                  </div>
                `;
              }).join('')}

              <div class="border-t border-[rgba(255,255,255,0.06)] pt-1.5 mt-1.5">
                <button type="button" onclick="event.stopPropagation(); addCategoryFromImport('${tx.type}')" class="w-full text-left px-2.5 py-2 text-[13px] text-blue-400 hover:bg-[#2A2D3C] rounded-lg flex items-center gap-2 font-medium cursor-pointer transition-colors">
                  <i data-lucide="plus" class="w-4 h-4"></i>
                  <span>Добавить категорию</span>
                </button>
              </div>
            </div>
          </div>

          <div class="text-right flex-shrink-0">
            <span class="text-sm ${amountColor}">
              ${amountSign}${formatMoney(tx.amount)}
            </span>
          </div>
        </div>

      </div>
     
    `;
  });

  html += `</div>`;
  output.innerHTML = html;

  updateHeaderSummary();
  window._updateHeaderSummary = updateHeaderSummary;

  dialog.classList.remove('hidden');

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function toggleImportCatMenu(txId) {
  const menu = document.getElementById(`cat-menu-${txId}`);
  const btn = document.getElementById(`cat-btn-${txId}`);
  const card = document.getElementById(`card-tx-${txId}`);
  if (!menu || !btn) return;

  const isClosed = menu.classList.contains('hidden');
  
  // Закрываем все меню и сбрасываем z-index всех карточек
  document.querySelectorAll('.custom-dropdown-menu').forEach(m => m.classList.add('hidden'));
  document.querySelectorAll('.card-parsed-row').forEach(c => c.style.zIndex = '');

  if (isClosed) {
    // Поднимаем слой текущей карточки над соседними
    if (card) card.style.zIndex = '40';
    
    // Позиционируем вниз (или вверх, если внизу нет места)
    const rect = btn.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    if (spaceBelow < 220 && rect.top > 220) {
      menu.style.bottom = 'calc(100% + 4px)';
      menu.style.top = 'auto';
    } else {
      menu.style.top = 'calc(100% + 4px)';
      menu.style.bottom = 'auto';
    }

    menu.classList.remove('hidden');
  }
}

function selectImportCat(txId, newCat, icon) {
  const tx = window._lastParsedTransactions?.find(t => t._id === txId);
  if (tx) {
    tx.category = newCat;
    const labelEl = document.getElementById(`cat-label-${txId}`);
    if (labelEl) {
      labelEl.innerHTML = `<i data-lucide="${icon}" class="w-[14px] h-[14px]"></i> ${escapeHtml(newCat)}`;
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }
  }
  const menu = document.getElementById(`cat-menu-${txId}`);
  if (menu) menu.classList.add('hidden');
  const card = document.getElementById(`card-tx-${txId}`);
  if (card) card.style.zIndex = '';
}

// Удаление категории прямо из окна импорта
async function deleteCategoryFromImport(catName, type) {
  if (typeof deleteCategory === 'function') {
    await deleteCategory(catName, type);
    // Перерисовываем список импорта с обновленными категориями
    if (window._lastParsedTransactions && window._lastParsedFileName) {
      renderParsedTransactionsView(window._lastParsedFileName, window._lastParsedTransactions, window._lastParsedBankName);
    }
  }
}

// Добавление категории прямо из окна импорта
function addCategoryFromImport(type) {
  document.querySelectorAll('.custom-dropdown-menu').forEach(m => m.classList.add('hidden'));
  if (typeof showAddCategoryDialog === 'function') {
    showAddCategoryDialog(type);
  }
}

/**
 * Переключение чекбокса операции
 */
function toggleTxSelection(txId, isSelected) {
  const tx = window._lastParsedTransactions.find(t => t._id === txId);
  if (tx) {
    tx.selected = isSelected;
    if (window._updateHeaderSummary) window._updateHeaderSummary();
  }
}

/**
 * Сохранение всех выбранных операций в Firebase
 */
async function importSelectedTransactions() {
  const selected = (window._lastParsedTransactions || []).filter(t => t.selected);
  if (selected.length === 0) {
    showToast('Выберите хотя бы одну операцию', true);
    return;
  }

  const btn = document.getElementById('btn-import-transactions');
  btn.disabled = true;
  btn.innerText = 'Сохранение...';
  showToast(`Импорт ${selected.length} операций...`, false, true);

  try {
    // В Firestore батч вмещает максимум 500 операций
    const CHUNK_SIZE = 400;
    for (let i = 0; i < selected.length; i += CHUNK_SIZE) {
      const chunk = selected.slice(i, i + CHUNK_SIZE);
      const batch = db.batch();

      chunk.forEach(tx => {
        const docRef = (window.getUserCol ? getUserCol('Transactions') : db.collection('Transactions')).doc();
        batch.set(docRef, {
          type: tx.type,
          amount: tx.amount,
          date: tx.date,            // YYYY-MM-DD
          category: tx.category,
          comment: tx.merchant      // Записываем название точки в комментарий
        });
      });

      await batch.commit();
    }

    showToast(`Успешно добавлено ${selected.length} операций!`);
    document.getElementById('pdf-debug-dialog').classList.add('hidden');

    // Обновляем список транзакций и графики
    if (typeof fetchCollection === 'function') {
      await fetchCollection('Transactions');
    }
  } catch (err) {
    console.error('Ошибка импорта:', err);
    showToast('Ошибка при импорте: ' + err.message, true);
    btn.disabled = false;
    btn.innerText = 'Попробовать снова';
  }
}

// Сохраняем последний результат в глобальную переменную для экспорта
window._lastParsedTransactions = [];

function downloadParsedJSON() {
  if (!window._lastParsedTransactions || window._lastParsedTransactions.length === 0) {
    showToast('Нет данных для скачивания', true);
    return;
  }

  const slug = window._lastActiveBank?.slug || 'statement';
  const today = new Date().toISOString().slice(0, 10);

  const jsonStr = JSON.stringify(window._lastParsedTransactions, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `${slug}_parsed_${today}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// -------------------------------------------------------------
// ЛОГИКА ОКНА "ЗАПОМНИТЬ ПРАВИЛО"
// -------------------------------------------------------------
let currentRememberTx = null;

function openRememberRuleModal(txId) {
  const tx = window._lastParsedTransactions?.find(t => t._id === txId);
  if (!tx) return;

  currentRememberTx = tx;

  const keywordInput = document.getElementById('rule-keyword-input');

  // Предзаполняем ключевое слово названием торговой точки
  keywordInput.value = tx.merchant;

  // Выбираем список категорий в зависимости от типа операции (Доход или Расход)
  let targetCats = [];
  
  if (tx.type === 'Доход') {
    targetCats = window.Cache?.categories?.income?.map(c => c.name) || ['Зарплата', 'Другое'];
  } else {
    targetCats = [
      'Продукты', 'Кафе и рестораны', 'Маркетплейсы', 'Транспорт', 'Жилье', 'Развлечения', 'Другое'
    ];
    if (window.Cache?.categories?.expense) {
      window.Cache.categories.expense.forEach(c => {
        if (!targetCats.includes(c.name)) targetCats.push(c.name);
      });
    }
  }

  populateModalCatMenu('rule', targetCats, tx.category);

  document.getElementById('remember-rule-dialog').classList.remove('hidden');
}

function closeRememberRuleModal() {
  document.getElementById('remember-rule-dialog').classList.add('hidden');
  currentRememberTx = null;
}

async function saveCategoryRuleFromModal() {
  const keyword = document.getElementById('rule-keyword-input').value.trim();
  const category = document.getElementById('rule-category-input').value;
  
  if (!keyword) {
    showToast('Введите ключевую фразу', true);
    return;
  }

  showToast('Сохранение правила...', false, true);

  try {
    // 1. Сохраняем правило в Firebase Firestore
    const newRule = { pattern: keyword, category: category };
    const col = window.getUserCol ? getUserCol('CategoryRules') : db.collection('CategoryRules');
const docRef = await col.add(newRule);
    
    // 2. Обновляем локальный кэш
    if (!window.Cache.categoryRules) window.Cache.categoryRules = [];
    window.Cache.categoryRules.push({ id: docRef.id, ...newRule });

    // 3. Автоматически пересчитываем категории для всех подходящих транзакций в открытом списке!
    if (window._lastParsedTransactions) {
      window._lastParsedTransactions.forEach(t => {
        const full = `${t.merchant} ${t.rawDetails}`.toLowerCase();
        if (full.includes(keyword.toLowerCase())) {
          t.category = category;
          // Обновляем селект в DOM без полной перерисовки
          const sel = document.getElementById(`cat-select-${t._id}`);
          if (sel) sel.value = category;
        }
      });
    }

    closeRememberRuleModal();
    showToast(`Правило сохранено: "${keyword}" → ${category}`);
  } catch (err) {
    console.error('Ошибка сохранения правила:', err);
    showToast('Ошибка при сохранении: ' + err.message, true);
  }
}

// -------------------------------------------------------------
// РЕДАКТОР СЛОВАРЯ КАТЕГОРИЙ (ШЕСТЕРЕНКА ⚙️)
// -------------------------------------------------------------
function openRulesEditorModal() {
  const dialog = document.getElementById('rules-editor-dialog');

  const allCats = [...new Set([...getActiveCategories('Расход'), ...getActiveCategories('Доход')])];
  
  populateModalCatMenu('editor', allCats, 'Продукты');

  document.getElementById('editor-keyword-input').value = '';
  renderRulesList();
  dialog.classList.remove('hidden');
}

function closeRulesEditorModal() {
  document.getElementById('rules-editor-dialog').classList.add('hidden');
  
  // Возврат в кабинет, если открывали оттуда
  if (window._returnToProfile) {
    window._returnToProfile = false;
    if (typeof openProfileModal === 'function') {
      openProfileModal();
    }
  }
}

function renderRulesList() {
  const container = document.getElementById('editor-rules-list');
  const rules = window.Cache?.categoryRules || [];

  if (rules.length === 0) {
    container.innerHTML = '<p class="text-xs text-gray-500 text-center py-4">В словаре пока нет правил</p>';
    return;
  }

  // Группируем правила по категориям
  const grouped = {};
  rules.forEach(r => {
    const cat = r.category || 'Другое';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(r);
  });

  let html = '';
  Object.keys(grouped).sort().forEach(cat => {
    const catIcon = getDynamicCategoryIcon(cat);
    html += `
      <div class="bg-[#181B24] border border-[rgba(255,255,255,0.06)] rounded-2xl p-3 mb-3">
        <div class="text-[13px] font-bold text-gray-200 mb-2.5 flex items-center gap-2 border-b border-[rgba(255,255,255,0.06)] pb-2">
          <i data-lucide="${catIcon}" class="w-4 h-4 text-[#848D99]"></i>
          <span>${escapeHtml(cat)}</span>
          <span class="text-[11px] text-[#848D99] font-normal">(${grouped[cat].length})</span>
        </div>
        <div class="flex flex-wrap gap-2">
    `;

    grouped[cat].forEach(r => {
      html += `
        <span class="inline-flex items-center gap-1.5 bg-[#212430] border border-[rgba(255,255,255,0.06)] text-gray-300 text-[12px] px-2.5 py-1.5 rounded-lg">
          <span>${escapeHtml(r.pattern)}</span>
          <button type="button" onclick="deleteRuleFromEditor('${r.id}')" class="text-gray-500 hover:text-[#FF453A] cursor-pointer"><i data-lucide="x" class="w-3.5 h-3.5"></i></button>
        </span>
      `;
    });

    html += `
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

async function addRuleFromEditor() {
  const input = document.getElementById('editor-keyword-input');
  const keyword = input.value.trim();
  const category = document.getElementById('editor-category-input').value;

  if (!keyword) {
    showToast('Введите слово или фразу', true);
    return;
  }

  showToast('Добавление...', false, true);
  try {
    const newRule = { pattern: keyword, category: category };
    const col = window.getUserCol ? getUserCol('CategoryRules') : db.collection('CategoryRules');
    const docRef = await col.add(newRule);

    if (!window.Cache.categoryRules) window.Cache.categoryRules = [];
    window.Cache.categoryRules.push({ id: docRef.id, ...newRule });

    input.value = '';
    renderRulesList();
    applyRulesToOpenedStatement(keyword, category);
    showToast(`Добавлено: "${keyword}" → ${category}`);
  } catch (e) {
    showToast('Ошибка: ' + e.message, true);
  }
}

async function deleteRuleFromEditor(ruleId) {
  try {
    const col = window.getUserCol ? getUserCol('CategoryRules') : db.collection('CategoryRules');
    await col.doc(ruleId).delete();
    window.Cache.categoryRules = (window.Cache.categoryRules || []).filter(r => r.id !== ruleId);
    renderRulesList();
    showToast('Слово удалено из словаря');
  } catch (e) {
    showToast('Ошибка удаления', true);
  }
}

// Пересчитывает категории в открытой выписке при добавлении нового правила
function applyRulesToOpenedStatement(keyword, category) {
  if (!window._lastParsedTransactions) return;
  window._lastParsedTransactions.forEach(t => {
    const full = `${t.merchant} ${t.rawDetails}`.toLowerCase();
    if (full.includes(keyword.toLowerCase())) {
      t.category = category;
      const sel = document.getElementById(`cat-select-${t._id}`);
      if (sel) sel.value = category;
    }
  });
}

// Функции для кастомных меню в модальных окнах
function toggleModalCatMenu(type) {
  const menu = document.getElementById(`${type}-category-menu`);
  if (!menu) return;
  const isClosed = menu.classList.contains('hidden');
  
  // Закрываем все открытые меню
  document.querySelectorAll('.custom-dropdown-menu').forEach(m => m.classList.add('hidden'));
  
  if (isClosed) menu.classList.remove('hidden');
}

function selectModalCat(type, catName, catIcon) {
  const input = document.getElementById(`${type}-category-input`);
  const label = document.getElementById(`${type}-category-label`);
  const menu = document.getElementById(`${type}-category-menu`);

  if (input) input.value = catName;
  if (label) {
    label.innerHTML = `<i data-lucide="${catIcon || 'tag'}" class="w-4 h-4 inline-block mr-1 align-text-bottom"></i> ${escapeHtml(catName)}`;
    if (typeof lucide !== 'undefined') lucide.createIcons();
    label.classList.remove('text-gray-400');
    label.classList.add('text-white');
  }
  if (menu) menu.classList.add('hidden');
}

// Универсальная функция генерации списка для модального меню
// Универсальная функция генерации списка для модального меню
function populateModalCatMenu(type, categories, selectedCat) {
  const menu = document.getElementById(`${type}-category-menu`);
  const input = document.getElementById(`${type}-category-input`);
  const label = document.getElementById(`${type}-category-label`);
  if (!menu) return;

  const defaultCat = selectedCat || categories[0] || 'Другое';
  const defaultIcon = getDynamicCategoryIcon(defaultCat);

  if (input) input.value = defaultCat;
  if (label) {
    label.innerHTML = `<i data-lucide="${defaultIcon}" class="w-4 h-4 inline-block mr-1 align-text-bottom"></i> ${escapeHtml(defaultCat)}`;
    label.classList.remove('text-gray-400');
    label.classList.add('text-white');
  }

  menu.innerHTML = categories.map(cat => {
    const icon = getDynamicCategoryIcon(cat);
    const isSelected = (cat === defaultCat);
    return `
      <button type="button" 
              onclick="selectModalCat('${type}', '${escapeHtml(cat)}', '${icon}')" 
              class="w-full text-left px-3 py-2 text-[13px] rounded-xl transition-colors flex items-center gap-2.5 cursor-pointer ${isSelected ? 'bg-[#6C5DD3]/15 text-[#6C5DD3] font-semibold' : 'text-gray-300 hover:bg-[#2A2D3C]'}">
        <i data-lucide="${icon}" class="w-4 h-4 ${isSelected ? 'text-[#6C5DD3]' : 'text-[#848D99]'}"></i>
        <span class="truncate">${escapeHtml(cat)}</span>
      </button>
    `;
  }).join('');

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// Глобальное закрытие любых открытых кастомных меню при клике в любое место мимо
document.addEventListener('click', (e) => {
  if (!e.target.closest('.custom-dropdown-wrap')) {
    document.querySelectorAll('.custom-dropdown-menu').forEach(m => m.classList.add('hidden'));
  }
});
