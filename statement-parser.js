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
// 2. ДЕТЕКТОР БАНКА И ПАРСЕРЫ
// -------------------------------------------------------------
class StatementCategorizer {
  static RULES = {
    "Зарплата": [
      /заработная плата/i, /salary/i, /ао\s+"цкбм"/i
    ],
    "Продукты": [
      /perek/i, /перекресток/i, /pyaterochka/i, /пятерочка/i, /dostavka iz pyaterochk/i,
      /okey/i, /окей/i, /lenta/i, /лента/i, /magnit/i, /магнит/i,
      /krasnoe(&|\s*i\s*)beloe/i, /красное\s*и\s*белое/i, /zhivaya voda/i,
      /fixprice/i, /фикс\s*прайс/i
    ],
    "Кафе и рестораны": [
      /vlavashe/i, /rostics/i, /ростикс/i, /kfc/i, /kimchi to go/i, /mu mu burgers/i,
      /bros burritos/i, /dostaevsky/i, /nesselbek/i, /mare dmore/i, /dom lunda/i,
      /krem/i, /kozhura/i, /fler/i, /vypechka i kofe/i, /1st food factory/i,
      /kafe/i, /кафе/i, /restoran/i, /ресторан/i, /garden/i,
      /semenova a/i // Столовая / кафе рядом с работой
    ],
    "Транспорт": [
      /rzd/i, /ржд/i, /szppk/i, /сзппк/i, /transkom/i, /транском/i,
      // Метро СПб (автоматы пополнения)
      /mezhdunarodnaya/i, /baltiyskaya/i, /pionerskaya/i, /tekhnol/i, /pl\.\s*lenina/i,
      /yandex.*go/i, /uber/i, /ситимобил/i, /такси/i
    ],
    "Развлечения": [
      /muzej/i, /музей/i, /homlins/i, /крендел/i, /krantstrevel/i, /lindenmarkt/i,
      /shtiglitsa/i, /штиглиц/i, /spghpa/i,
      /afisha/i, /афиша/i, /teatr/i, /театр/i, /masterskaya/i, /отдых и развлечения/i
    ],
    "Маркетплейсы": [
      /\bwb\b/i, /wildberries/i, /вайлдберриз/i, /ozon/i, /озон/i,
      /kleekstore/i, /yandex.*market/i, /яндекс.*маркет/i, /megamarket/i, /алиэкспресс/i
    ]
  };

  static categorize(merchant, rawDetails, type) {
    const text = `${merchant} ${rawDetails}`;

    // Доходы
    if (type === 'Доход') {
      for (const pattern of this.RULES["Зарплата"]) {
        if (pattern.test(text)) return "Зарплата";
      }
      return "Другое";
    }

    // Расходы
    for (const [category, patterns] of Object.entries(this.RULES)) {
      if (category === "Зарплата") continue;
      for (const pattern of patterns) {
        if (pattern.test(text)) return category;
      }
    }

    // T2, Vezaruspro, МФЦ и прочее неопределенное уйдут сюда автоматически
    return "Другое";
  }
}

class GazprombankParser {
  static VTB_ROW_START = /^(\d{2}\.\d{2}\.\d{4})\s+(\d{2}\.\d{2}\.\d{4})\s+(.+?)\s*([+-]\s*[\d\s]+[.,]\d{2})\s+([+-]\s*[\d\s]+[.,]\d{2})$/;
  static DATE_PREFIX = /^(\d{2}\.\d{2}\.\d{4})\s+(\d{2}\.\d{2}\.\d{4})/;

  static parse(rawLines, options = { excludeTransfers: true }) {
    const rawBlocks = [];
    let currentBlock = null;

    for (let line of rawLines) {
      line = line.trim();
      if (!line || this._isServiceLine(line)) continue;

      if (this.DATE_PREFIX.test(line)) {
        if (currentBlock) rawBlocks.push(currentBlock);
        currentBlock = [line];
      } else if (currentBlock) {
        currentBlock.push(line);
      }
    }
    if (currentBlock) rawBlocks.push(currentBlock);

    const parsed = rawBlocks.map(block => this._parseTransactionBlock(block)).filter(Boolean);

    // Исключаем переводы между счетами и СБП при необходимости
    if (options.excludeTransfers) {
      return parsed.filter(tx => !tx.isTransfer);
    }
    return parsed;
  }

  static _parseTransactionBlock(lines) {
    const firstLine = lines[0];
    const match = firstLine.match(this.VTB_ROW_START);

    let txDate = '', rawIncome = '+0,00', rawExpense = '-0,00', opTitle = '';

    if (match) {
      txDate = match[1];
      opTitle = match[3];
      rawIncome = match[4];
      rawExpense = match[5];
    } else {
      const dateMatch = firstLine.match(this.DATE_PREFIX);
      if (!dateMatch) return null;
      txDate = dateMatch[1];
      const amounts = firstLine.match(/([+-]?\s*[\d\s]+[.,]\d{2})/g) || [];
      if (amounts.length >= 2) {
        rawIncome = amounts[amounts.length - 2];
        rawExpense = amounts[amounts.length - 1];
      } else if (amounts.length === 1) {
        rawExpense = amounts[0];
      }
    }

    const incomeVal = this._parseAmount(rawIncome);
    const expenseVal = this._parseAmount(rawExpense);

    let type = 'Расход';
    let amount = expenseVal;

    if (expenseVal === 0 && incomeVal > 0) {
      type = 'Доход';
      amount = incomeVal;
    } else if (expenseVal > 0) {
      type = 'Расход';
      amount = expenseVal;
    }

    const fullText = lines.join(' ');
    const merchant = this._extractMerchant(lines, fullText, opTitle);

    // Проверка: является ли операция переводом (СБП, между своими счетами)
    const isTransfer = this._isTransferOperation(fullText, merchant);

    const [d, m, y] = txDate.split('.');
    const isoDate = `${y}-${m}-${d}`;

    return {
      date: isoDate,
      displayDate: txDate,
      type,
      amount,
      merchant,
      isTransfer,
      bank: 'Газпромбанк',
      rawDetails: fullText
    };
  }

  static _isTransferOperation(fullText, merchant) {
    const text = (fullText + ' ' + merchant).toLowerCase();
    return text.includes('sbp c2c') ||
           text.includes('перевод с банк') ||
           text.includes('перевод на банк') ||
           text.includes('перевод между') ||
           text.includes('перевод по сбп') ||
           text.includes('снятие наличных') ||
           text.includes('vb24');
  }

  static _extractMerchant(lines, fullText, opTitle) {
    const deviceMatch = fullText.match(/Устройство:\s*([^.]+?)(?:\.\s*Город|\.\s*Сумма|\.|$)/i);
    if (deviceMatch && deviceMatch[1].trim()) {
      return deviceMatch[1].trim();
    }

    const sbpMatch = fullText.match(/Перевод\s+(?:по\s+СБП|клиенту|от)\s+([^.]+?)(?:\.|$)/i);
    if (sbpMatch) return sbpMatch[0].trim();

    let fallback = opTitle || lines[0];
    fallback = fallback.replace(/^(\d{2}\.\d{2}\.\d{4}\s*){1,2}/, '')
                       .replace(/([+-]?\s*[\d\s]+[.,]\d{2})/g, '')
                       .replace(/Операция:\s*/i, '')
                       .trim();

    return fallback || 'Банковская операция';
  }

  static _parseAmount(str) {
    if (!str) return 0;
    const clean = str.replace(/[^\d.,]/g, '').replace(',', '.');
    return Math.abs(parseFloat(clean)) || 0;
  }

  static _isServiceLine(line) {
    const l = line.toLowerCase();
    return l.includes('дата отражения') ||
           l.includes('содержание операции') ||
           l.includes('денежных средств') ||
           l.includes('страница') ||
           l.includes('входящий остаток') ||
           l.includes('исходящий остаток') ||
           l.includes('обороты за период');
  }
}

// -------------------------------------------------------------
// ПАРСЕР СБЕРБАНКА
// -------------------------------------------------------------
class SberbankParser {
  // Начало операции: Дата + Время (например: 24.08.2026 18:07)
  static ROW_START = /^(\d{2}\.\d{2}\.\d{4})\s+(\d{2}:\d{2})\s+(.+)$/;

  static parse(rawLines, options = { excludeTransfers: true }) {
    const rawBlocks = [];
    let currentBlock = null;

    for (let line of rawLines) {
      line = line.trim();
      if (!line || this._isServiceLine(line)) continue;

      // Вторая строка операции содержит дату и 6-значный код авторизации — не путаем её с началом!
      const isTxStart = this.ROW_START.test(line) && !/^\d{2}\.\d{2}\.\d{4}\s+\d{6}/.test(line);

      if (isTxStart) {
        if (currentBlock) rawBlocks.push(currentBlock);
        currentBlock = [line];
      } else if (currentBlock) {
        currentBlock.push(line);
      }
    }
    if (currentBlock) rawBlocks.push(currentBlock);

    const parsed = rawBlocks.map(block => this._parseTransactionBlock(block)).filter(Boolean);

    if (options.excludeTransfers) {
      return parsed.filter(tx => !tx.isTransfer);
    }
    return parsed;
  }

  static _parseTransactionBlock(lines) {
    const firstLine = lines[0];
    const match = firstLine.match(this.ROW_START);
    if (!match) return null;

    const txDate = match[1];
    const afterDateTime = match[3];

    // Ищем суммы в конце первой строки (Сумма операции и Остаток средств)
    const amounts = afterDateTime.match(/([+-]?\s*[\d\s]+[.,]\d{2})/g) || [];
    if (amounts.length === 0) return null;

    // Сумма операции — это первое найденное число в блоке сумм
    const rawAmount = amounts[0];
    const isIncome = rawAmount.includes('+');
    const type = isIncome ? 'Доход' : 'Расход';
    const amount = Math.abs(parseFloat(rawAmount.replace(/[^\d.,]/g, '').replace(',', '.'))) || 0;

    // Категория от самого Сбера (например: "Отдых и развлечения", "Перевод СБП")
    let sberCategory = afterDateTime;
    amounts.forEach(a => sberCategory = sberCategory.replace(a, ''));
    sberCategory = sberCategory.trim();

    // Вторая строка обычно содержит дату обработки, код авторизации и описание точки
    const fullText = lines.join(' ');
    let merchant = this._extractMerchant(lines, sberCategory);

    // Проверка на перевод
    const isTransfer = this._isTransferOperation(sberCategory, fullText);

    // Нормализация даты
    const [d, m, y] = txDate.split('.');
    const isoDate = `${y}-${m}-${d}`;

    // Определяем категорию через наш категоризатор (учитывая и родную категорию Сбера)
    const category = StatementCategorizer.categorize(merchant, `${sberCategory} ${fullText}`, type);

    return {
      date: isoDate,
      displayDate: txDate,
      type,
      amount,
      merchant,
      category,
      isTransfer,
      bank: 'Сбербанк',
      rawDetails: fullText
    };
  }

  static _extractMerchant(lines, sberCategory) {
    if (lines.length > 1) {
      // Убираем дату обработки и код авторизации из начала второй строки
      let descLine = lines[1].replace(/^\d{2}\.\d{2}\.\d{4}\s+\d+\s*/, '');
      // Отрезаем хвост "Операция по карте ****XXXX" или "Операция по счету ****XXXX"
      descLine = descLine.replace(/\.?\s*Операция\s+по\s+(карте|счету)\s+\*{2,4}\d+/i, '').trim();
      if (descLine) return descLine;
    }
    return sberCategory || 'Операция Сбербанк';
  }

  static _isTransferOperation(sberCategory, fullText) {
    const text = (sberCategory + ' ' + fullText).toLowerCase();
    return text.includes('перевод') ||
           text.includes('сбп') ||
           text.includes('перевод на карту') ||
           text.includes('перевод с карты') ||
           text.includes('перевод для') ||
           text.includes('перевод от');
  }

  static _isServiceLine(line) {
    const l = line.toLowerCase();
    return l.includes('выписка по платёжному счёту') ||
           l.includes('расшифровка операций') ||
           l.includes('дата операции') ||
           l.includes('сумма в валюте') ||
           l.includes('остаток средств') ||
           l.includes('страница') ||
           l.includes('продолжение на следующей странице') ||
           l.includes('для проверки подлинности') ||
           l.includes('действителен до') ||
           l.includes('итого по операциям');
  }
}

class BankDetector {
  static detect(rawLines) {
    const preview = rawLines.slice(0, 35).join(' ').toLowerCase();

    // Проверка на Сбербанк
    if (preview.includes('сбербанк') || preview.includes('sberbank') || preview.includes('сбер')) {
      return 'SBER';
    }

    // Проверка на Газпромбанк
    if (preview.includes('газпромбанк') || preview.includes('гпб') || preview.includes('gazprombank')) {
      return 'GPB';
    }
    if (preview.includes('дата отражения') && preview.includes('содержание операции')) {
      return 'GPB';
    }

    return 'UNKNOWN';
  }
}

class StatementDispatcher {
  static parse(rawLines) {
    const bankCode = BankDetector.detect(rawLines);

    if (bankCode === 'UNKNOWN') {
      throw new Error('Банк не поддерживается. На данный момент доступны: Газпромбанк и Сбербанк.');
    }

    switch (bankCode) {
      case 'SBER':
        return { bankName: 'Сбербанк', transactions: SberbankParser.parse(rawLines, { excludeTransfers: true }) };
      case 'GPB':
      default:
        return { bankName: 'Газпромбанк', transactions: GazprombankParser.parse(rawLines, { excludeTransfers: true }) };
    }
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

    // 2. Формируем таблицу операций
    const result = StatementDispatcher.parse(lines);

    event.target.value = '';
    document.getElementById('toast-container').classList.add('hidden');

    // 3. Отображаем результат Шага 2 в модальном окне
    renderParsedTransactionsView(file.name, result.transactions, result.bankName);

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

// Единый справочник иконок для быстрого переключения
const CATEGORY_ICONS = {
  'Продукты': '🍔',
  'Кафе и рестораны': '🍽️',
  'Маркетплейсы': '🛍️',
  'Транспорт': '🚗',
  'Жилье': '🏠',
  'Развлечения': '🎬',
  'Зарплата': '💼',
  'Другое': '📦'
};

function renderParsedTransactionsView(fileName, transactions, bankName = 'Банк') {
  const dialog = document.getElementById('pdf-debug-dialog');
  const info = document.getElementById('pdf-debug-info');
  const output = document.getElementById('pdf-debug-output');

  // Полный список категорий с гарантией наличия новых
  const expenseCategories = [
    'Продукты', 'Кафе и рестораны', 'Маркетплейсы', 'Транспорт', 'Жилье', 'Развлечения', 'Другое'
  ];
  const incomeCategories = ['Зарплата', 'Другое'];

  // Добавляем любые пользовательские категории, если они были созданы в приложении
  if (window.Cache?.categories?.expense) {
    window.Cache.categories.expense.forEach(c => {
      if (!expenseCategories.includes(c.name)) expenseCategories.push(c.name);
      if (c.icon) CATEGORY_ICONS[c.name] = c.icon;
    });
  }

  // Подготовка и принудительная категоризация
  transactions.forEach((tx, idx) => {
    tx._id = 'tx_parsed_' + idx;
    
    // Принудительно определяем категорию, если она не была определена ранее
    if (!tx.category || tx.category === 'Не определено') {
      tx.category = StatementCategorizer.categorize(tx.merchant, tx.rawDetails, tx.type);
    }

    tx.isDuplicate = isTransactionDuplicate(tx);
    tx.selected = !tx.isDuplicate; // дубликаты по умолчанию выключены
  });

  window._lastParsedTransactions = transactions;

  function updateHeaderSummary() {
    const selectedTxs = transactions.filter(t => t.selected);
    const totalExp = selectedTxs.filter(t => t.type === 'Расход').reduce((s, t) => s + t.amount, 0);
    const totalInc = selectedTxs.filter(t => t.type === 'Доход').reduce((s, t) => s + t.amount, 0);

    const bankBadgeColor = bankName === 'Сбербанк' ? 'bg-emerald-900/60 text-emerald-300 border-emerald-700/60' : 'bg-blue-900/60 text-blue-300 border-blue-700/60';
    
    info.innerHTML = `
      <div class="flex items-center gap-2 mb-1">
        <span class="text-[10px] font-bold px-2 py-0.5 rounded-full border ${bankBadgeColor}">${escapeHtml(bankName)}</span>
        <span class="text-xs text-gray-300 truncate">${fileName}</span>
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
    const isExp = tx.type === 'Расход';
    const amountSign = isExp ? '-' : '+';
    const amountColor = isExp ? 'text-white' : 'text-emerald-400';
    const cats = isExp ? expenseCategories : incomeCategories;
    const currentIcon = CATEGORY_ICONS[tx.category] || '📦';

    const optionsHtml = cats.map(cat => 
      `<option value="${escapeHtml(cat)}" ${cat === tx.category ? 'selected' : ''}>${CATEGORY_ICONS[cat] || '📦'} ${escapeHtml(cat)}</option>`
    ).join('');

    html += `
      <div class="bg-gray-900 border ${tx.isDuplicate ? 'border-gray-800 opacity-60' : 'border-gray-700/80'} p-3 rounded-2xl">
        
        <!-- СТРОКА 1: Чекбокс, Дата слева, справа от нее название операции (с обрезкой) -->
        <div class="flex items-center gap-2.5 min-w-0">
          <input type="checkbox" 
                 class="w-4 h-4 rounded accent-blue-600 bg-gray-800 border-gray-700 flex-shrink-0 cursor-pointer"
                 data-tx-id="${tx._id}"
                 ${tx.selected ? 'checked' : ''}
                 onchange="toggleTxSelection('${tx._id}', this.checked)">
          
          <span class="text-xs text-gray-400 font-mono flex-shrink-0">${tx.displayDate}</span>
          
          <span class="text-xs font-semibold text-gray-200 truncate flex-1 min-w-0" title="${escapeHtml(tx.merchant)}">
            ${escapeHtml(tx.merchant)}
          </span>

          ${tx.isDuplicate ? '<span class="text-[9px] text-gray-400 bg-gray-800 px-1.5 py-0.5 rounded border border-gray-700 flex-shrink-0">В базе</span>' : ''}
        </div>

        <!-- СТРОКА 2: Категория с иконкой слева, Сумма справа по правому краю -->
        <div class="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-gray-800/60">
          
          <!-- Селект категории с живой иконкой -->
          <div class="flex items-center gap-1.5 min-w-0">
            <select class="bg-gray-800 border border-gray-700 text-xs text-blue-200 rounded-lg px-2.5 py-1 outline-none cursor-pointer focus:border-blue-500 font-medium"
                    onchange="changeTxCategory('${tx._id}', this.value)">
              ${optionsHtml}
            </select>
          </div>

          <!-- Сумма по правому краю -->
          <div class="text-right flex-shrink-0">
            <span class="text-sm font-bold ${amountColor}">
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
}

/**
 * Ручное изменение категории в карточке
 */
function changeTxCategory(txId, newCat) {
  const tx = window._lastParsedTransactions.find(t => t._id === txId);
  if (tx) {
    tx.category = newCat;
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
        const docRef = db.collection('Transactions').doc();
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

  const jsonStr = JSON.stringify(window._lastParsedTransactions, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `gazprombank_parsed_${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
