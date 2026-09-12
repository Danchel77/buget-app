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
    if (found && found.icon) return found.icon;
  }
  return CATEGORY_ICONS[catName] || '📦';
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
           text.includes('внесение наличных') ||  // <--- добавлено
           text.includes('взнос наличными') ||    // <--- добавлено
           text.includes('пополнение наличными') ||
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
// ПАРСЕР ЯНДЕКС БАНКА
// -------------------------------------------------------------
class YandexBankParser {
  // Строка операции в Яндексе всегда содержит дату DD.MM.YYYY и сумму со знаком (+ или −) и символом ₽
  static DATE_REGEX = /\d{2}\.\d{2}\.\d{4}/;
  static AMOUNT_REGEX = /[\d\s\xa0]+[.,]\d{2}\s*₽/;
  static parse(rawLines, options = { excludeTransfers: true }) {
    const rawBlocks = [];
    let currentBlock = null;

    for (let line of rawLines) {
      line = line.trim();
      if (!line || this._isServiceLine(line)) continue;

      // Новая операция начинается со строки, где есть и дата, и сумма
      const isTxStart = this.DATE_REGEX.test(line) && this.AMOUNT_REGEX.test(line);

      if (isTxStart) {
        if (currentBlock) rawBlocks.push(currentBlock);
        currentBlock = [line];
      } else if (currentBlock) {
        currentBlock.push(line);
      }
    }
    if (currentBlock) rawBlocks.push(currentBlock);

    const parsed = rawBlocks.map(block => this._parseTransactionBlock(block)).filter(Boolean);

    return parsed;
  }

  static _parseTransactionBlock(lines) {
    const firstLine = lines[0];

    // 1. Извлекаем дату (берем первую дату — дату операции)
    const dateMatch = firstLine.match(this.DATE_REGEX);
    if (!dateMatch) return null;
    const txDate = dateMatch[0];

    // 2. Извлекаем сумму (с учетом типографского минуса −)
    const amountMatches = firstLine.match(/([+−–—\-\u2012\u2013\u2014\u2212]?\s*[\d\s\xa0]+[.,]\d{2})\s*₽/g) || [];
    if (amountMatches.length === 0) return null;

    const rawAmount = amountMatches[0];
    const isIncome = rawAmount.includes('+');
    const type = isIncome ? 'Доход' : 'Расход';
    
    // Очищаем сумму в число
    const cleanNum = rawAmount.replace(/[+−\-]/g, '').replace(/[^\d.,]/g, '').replace(',', '.');
    const amount = Math.abs(parseFloat(cleanNum)) || 0;

    // 3. Извлекаем описание (в первой строке всё, что идёт ДО даты)
    const beforeDate = firstLine.split(this.DATE_REGEX)[0].trim();
    const fullText = lines.join(' ');
    
    // Чистим мерчанта
    const merchant = this._extractMerchant(beforeDate, lines);

    // 4. Фильтрация переводов
    const isTransfer = this._isTransferOperation(fullText, merchant);

    // 5. Дата в YYYY-MM-DD
    const [d, m, y] = txDate.split('.');
    const isoDate = `${y}-${m}-${d}`;

    // 6. Категоризация по нашей базе
    const category = StatementCategorizer.categorize(merchant, fullText, type);

    return {
      date: isoDate,
      displayDate: txDate,
      type,
      amount,
      merchant,
      category,
      isTransfer,
      bank: 'Яндекс Банк',
      rawDetails: fullText
    };
  }

  static _extractMerchant(beforeDate, lines) {
    let part1 = beforeDate.replace(/^Оплата товаров и услуг\s*/i, '').trim();

    let part2 = lines.slice(1).map(line => {
      return line.replace(/в\s+\d{2}:\d{2}/i, '')
                 .replace(/\d{2}\.\d{2}\.\d{4}/g, '')
                 .replace(/\*\d{4}/g, '')
                 .replace(/[\d\s\xa0]+[.,]\d{2}\s*₽/g, '')
                 .trim();
    }).filter(Boolean).join(' ');

    let fullMerchant = `${part1} ${part2}`.replace(/^Оплата товаров и услуг\s*/i, '').trim();

    // Зачищаем служебные слова от разорванных шапок страниц Яндекса
    fullMerchant = fullMerchant
      .replace(/\b(операции|обработки|договора|мск|карты|валюте)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

    return fullMerchant || 'Операция Яндекс Банк';
  }

  static _isTransferOperation(fullText, merchant) {
    const text = `${fullText} ${merchant}`.toLowerCase();
    return text.includes('перевод') ||
           text.includes('сбп') ||
           text.includes('между счетами') ||
           text.includes('внесение') ||           // <--- добавлено
           text.includes('наличными');
  }

  static _isServiceLine(line) {
    const l = line.toLowerCase();
    return l.includes('выписка по договору') ||
           l.includes('описание операции') ||
           l.includes('дата и время') ||
           l.includes('дата обработки') ||
           l.includes('сумма в валюте') ||
           l.includes('входящий остаток') ||
           l.includes('исходящий остаток') ||
           l.includes('всего расходных') ||
           l.includes('всего приходных') ||
           l.includes('с уважением') ||
           l.includes('в рамках договора') ||
           l.includes('продолжение на') ||
           l.includes('страница') ||
           l.includes('номер счёта') ||
           (l.includes('операции') && l.includes('мск')) ||      // шапка страницы
           (l.includes('обработки') && l.includes('договора'));   // шапка страницы
  }
}

// -------------------------------------------------------------
// ПАРСЕР СБЕРБАНКА
// -------------------------------------------------------------
class SberbankParser {
  static ROW_START = /^(\d{2}\.\d{2}\.\d{4})\s+(\d{2}:\d{2})\s+(.+)$/;

  static parse(rawLines, options = { excludeTransfers: true }) {
    const rawBlocks = [];
    let currentBlock = null;

    for (let line of rawLines) {
      line = line.trim();
      if (!line || this._isServiceLine(line)) continue;

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

    return parsed;
  }

  static _parseTransactionBlock(lines) {
    const firstLine = lines[0];
    const match = firstLine.match(this.ROW_START);
    if (!match) return null;

    const txDate = match[1];
    const afterDateTime = match[3];

    const amounts = afterDateTime.match(/([+-]?\s*[\d\s]+[.,]\d{2})/g) || [];
    if (amounts.length === 0) return null;

    const rawAmount = amounts[0];
    const isIncome = rawAmount.includes('+');
    const type = isIncome ? 'Доход' : 'Расход';
    const amount = Math.abs(parseFloat(rawAmount.replace(/[^\d.,]/g, '').replace(',', '.'))) || 0;

    // Категория от самого Сбербанка (например: "Отдых и развлечения", "Рестораны и кафе")
    let sberCategory = afterDateTime;
    amounts.forEach(a => sberCategory = sberCategory.replace(a, ''));
    sberCategory = sberCategory.trim();

    const fullText = lines.join(' ');
    const merchant = this._extractMerchant(lines, sberCategory);

    // Проверка: перевод, закрытие вклада или брокерский счет
    const isTransfer = this._isTransferOperation(sberCategory, fullText, merchant);

    const [d, m, y] = txDate.split('.');
    const isoDate = `${y}-${m}-${d}`;

    // Приоритетная категоризация с учетом категорий Сбера
    const category = this._determineCategory(sberCategory, merchant, fullText, type);

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

  static _determineCategory(sberCat, merchant, fullText, type) {
    const sberLower = sberCat.toLowerCase();

    // 1. Прямой маппинг родных категорий Сбера
    if (sberLower.includes('отдых и развлечения')) return 'Развлечения';
    if (sberLower.includes('рестораны и кафе') || sberLower.includes('кафе и рестораны')) return 'Кафе и рестораны';
    if (sberLower.includes('супермаркеты')) return 'Продукты';
    if (sberLower.includes('транспорт')) return 'Транспорт';
    if (sberLower.includes('коммунальные') || sberLower.includes('жилье')) return 'Жилье';

    // 2. Если у Сбера "Прочие операции/расходы" — используем наш общий классификатор
    return StatementCategorizer.categorize(merchant, `${sberCat} ${fullText}`, type);
  }

  static _extractMerchant(lines, sberCategory) {
    if (lines.length > 1) {
      // Убираем дату проводки и код авторизации
      let descLine = lines[1].replace(/^\d{2}\.\d{2}\.\d{4}\s+\d+\s*/, '');
      // Убираем технические хвосты "Операция по карте...", "Операция по счету..."
      descLine = descLine.replace(/\.?\s*Операция\s+по.*$/i, '')
                         .replace(/\.?\s*Перевод\s+по.*$/i, '')
                         .trim();
      if (descLine) return descLine;
    }
    return sberCategory || 'Операция Сбербанк';
  }

  static _isTransferOperation(sberCategory, fullText, merchant) {
    const text = `${sberCategory} ${fullText} ${merchant}`.toLowerCase();
    return text.includes('перевод') ||
           text.includes('сбп') ||
           text.includes('vklad-karta') ||
           text.includes('karta-vklad') ||
           text.includes('bpwww') ||
           text.includes('брокер') ||
           text.includes('внесение наличных') ||  // <--- добавлено
           text.includes('зачисление наличных') || // <--- добавлено
           text.includes('взнос наличными');
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

// -------------------------------------------------------------
// ПАРСЕР ОЗОН БАНКА
// -------------------------------------------------------------
class OzonBankParser {
  // Начало операции: любая строка, начинающаяся с даты ДД.ММ.ГГГГ
  static ROW_START = /^\d{2}\.\d{2}\.\d{4}/;

  static parse(rawLines) {
    const rawBlocks = [];
    let currentBlock = null;

    for (let line of rawLines) {
      line = line.trim();
      if (!line || this._isServiceLine(line)) continue;

      if (this.ROW_START.test(line)) {
        if (currentBlock) rawBlocks.push(currentBlock);
        currentBlock = [line];
      } else if (currentBlock) {
        currentBlock.push(line);
      }
    }
    if (currentBlock) rawBlocks.push(currentBlock);

    return rawBlocks.map(block => this._parseTransactionBlock(block)).filter(Boolean);
  }

  static _parseTransactionBlock(lines) {
    const firstLine = lines[0];
    const dateMatch = firstLine.match(/(\d{2}\.\d{2}\.\d{4})/);
    if (!dateMatch) return null;

    const txDate = dateMatch[1];
    const fullText = lines.join(' ');

    // Ищем сумму: обязательный знак (+ или -), число с копейками, а знак ₽ делаем необязательным
    const amounts = fullText.match(/([+−–—\-\u2012\u2013\u2014\u2212]\s*[\d\s\xa0]+[.,]\d{2})/g) || [];
    if (amounts.length === 0) return null;

    const rawAmount = amounts[0];
    const isIncome = rawAmount.includes('+');
    const type = isIncome ? 'Доход' : 'Расход';

    const cleanNum = rawAmount.replace(/[^\d.,]/g, '').replace(',', '.');
    const amount = Math.abs(parseFloat(cleanNum)) || 0;

    // Извлекаем понятное имя мерчанта
    const merchant = this._extractMerchant(fullText);

    // Проверка на перевод (СБП, пополнение)
    const isTransfer = this._isTransferOperation(fullText, merchant);

    const [d, m, y] = txDate.split('.');
    const isoDate = `${y}-${m}-${d}`;

    const category = StatementCategorizer.categorize(merchant, fullText, type);

    return {
      date: isoDate,
      displayDate: txDate,
      type,
      amount,
      merchant,
      category,
      isTransfer,
      bank: 'Озон Банк',
      rawDetails: fullText
    };
  }

 static _extractMerchant(fullText) {
    // 1. Покупки картой в магазинах/терминалах: "в [ТОЧКА] дата [ДАТА]"
    // Вырезаем название точки между "сумма ... в" и "дата 202X"
    const posMatch = fullText.match(/(?:сумма\s*[\d.]+\s*в|\bв)\s+([\s\S]+?)\s+дата\s*\d{4}/i);
    if (posMatch && posMatch[1].trim()) {
      let store = posMatch[1].trim();
      // Убираем хвостики страны (RU, RUS) и лишние пробелы
      return store.replace(/\s+(RU|RUS)$/i, '').replace(/\s+/g, ' ').trim();
    }

    // 2. Возвраты
    if (/возврат/i.test(fullText)) {
      const orderMatch = fullText.match(/заказ\s*№?\s*([0-9-]+)/i);
      return orderMatch ? `Возврат Ozon (${orderMatch[0]})` : 'Возврат покупки';
    }

    // 3. Покупки на маркетплейсе Ozon
    if (/платформе\s+ozon/i.test(fullText) || /оплата.*ozon/i.test(fullText)) {
      const orderMatch = fullText.match(/заказ\s*№?\s*([0-9-]+)/i);
      return orderMatch ? `Ozon (${orderMatch[0]})` : 'Ozon';
    }

    // 4. Переводы СБП
    if (/перевод.*сбп/i.test(fullText)) {
      const senderMatch = fullText.match(/Отправитель:\s*([^.]*?)(?:Без НДС|$)/i);
      return senderMatch ? `Перевод СБП (${senderMatch[1].trim()})` : 'Перевод через СБП';
    }

    // Резервная очистка
    let clean = fullText.replace(/^(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}:\d{2}\s+\d+\s*)/, '')
                        .replace(/Оплата товаров(\/услуг)?\s*(по карте \d+)?\s*(на\s*)?/i, '')
                        .replace(/Без НДС\.?/i, '')
                        .replace(/([+−–—\-\u2012\u2013\u2014\u2212]?\s*[\d\s\xa0]+[.,]\d{2}\s*₽)/g, '')
                        .trim();

    return clean || 'Операция Озон Банк';
  } 

  static _isTransferOperation(fullText, merchant) {
    const text = `${fullText} ${merchant}`.toLowerCase();
    return text.includes('перевод') ||
           text.includes('сбп') ||
           text.includes('отправитель:') ||
           text.includes('внесение наличных') ||  // <--- добавлено
           text.includes('пополнение наличными');
  }

  static _isServiceLine(line) {
    const l = line.toLowerCase();
    return l.includes('справка о движении средств') ||
           l.includes('ооо «озон банк»') ||
           l.includes('лицензия банка россии') ||
           l.includes('владелец:') ||
           l.includes('номер лицевого счёта') ||
           l.includes('период выписки') ||
           l.includes('входящий остаток') ||
           l.includes('дата операции') ||
           l.includes('назначение платежа') ||
           l.includes('сумма операции') ||
           l.includes('российские рубли') ||
           l.includes('страница');
  }
}

class BankDetector {
  static detect(rawLines) {
    // Берем первые 40 строк документа для анализа шапки
    const preview = rawLines.slice(0, 40).join(' ').toLowerCase();

    // 1. Сбербанк (ищем реквизиты эмитента)
    if (preview.includes('sberbank.ru') || 
        preview.includes('сбербанк онлайн') || 
        preview.includes('пао сбербанк') || 
        preview.includes('выписка по платёжному счёту')) {
      return 'SBER';
    }

    // 2. Озон Банк (только официальные реквизиты Озона в шапке)
    if (preview.includes('ооо «озон банк»') || 
        preview.includes('справка о движении средств') || 
        (preview.includes('ozon') && preview.includes('лицензия банка россии'))) {
      return 'OZON';
    }

    // 3. Яндекс Банк (реквизиты договора и сайта)
    if (preview.includes('yabank.yandex.ru') || 
        preview.includes('ао «яндекс банк»') || 
        (preview.includes('яндекс') && preview.includes('в рамках договора открыт счёт'))) {
      return 'YANDEX';
    }

    // 4. Газпромбанк
    if (preview.includes('газпромбанк') || 
        preview.includes('банк гпб') || 
        (preview.includes('дата отражения') && preview.includes('содержание операции'))) {
      return 'GPB';
    }

    return 'UNKNOWN';
  }
}

class StatementDispatcher {
  static parse(rawLines) {
    const bankCode = BankDetector.detect(rawLines);

    if (bankCode === 'UNKNOWN') {
      throw new Error('Банк не поддерживается. На данный момент доступны: Газпромбанк, Сбербанк, Яндекс Банк и Озон Банк.');
    }

    switch (bankCode) {
        case 'OZON':
        return { bankName: 'Озон Банк', transactions: OzonBankParser.parse(rawLines) };
      case 'YANDEX':
        return { bankName: 'Яндекс Банк', transactions: YandexBankParser.parse(rawLines, { excludeTransfers: true }) };
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
function renderParsedTransactionsView(fileName, transactions, bankName = 'Банк') {
  window._lastParsedBankName = bankName;

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

    let bankBadgeColor = 'bg-blue-900/60 text-blue-300 border-blue-700/60';
    if (bankName === 'Сбербанк') {
      bankBadgeColor = 'bg-emerald-900/60 text-emerald-300 border-emerald-700/60';
    } else if (bankName === 'Яндекс Банк') {
      bankBadgeColor = 'bg-amber-900/60 text-amber-300 border-amber-700/60'; // Фирменный жёлто-янтарный цвет
    } else if (bankName === 'Озон Банк') {
      bankBadgeColor = 'bg-sky-900/60 text-sky-300 border-sky-700/60';
    }
    
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

    const optionsHtml = cats.map(cat => 
      `<option value="${escapeHtml(cat)}" ${cat === tx.category ? 'selected' : ''}>${getDynamicCategoryIcon(cat)} ${escapeHtml(cat)}</option>`
    ).join('');

    html += `
      <!-- Карточка: активная выделяется ярче, неактивная (перевод/дубль) становится глубоко-серой -->
      <div class="card-parsed-row border ${isInactive ? 'bg-[#0e1217] border-gray-800/90' : 'bg-gray-900 border-gray-700/80 shadow-sm'} p-3 rounded-2xl space-y-2 relative" id="card-tx-${tx._id}">
        
        <!-- СТРОКА 1: Чекбокс, наименование и кнопка запоминания 📌 -->
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
                  class="text-xs text-gray-400 hover:text-blue-400 bg-gray-800 hover:bg-gray-700 border border-gray-700 px-2 py-0.5 rounded-lg transition-colors cursor-pointer flex-shrink-0" 
                  title="Запомнить правило для этой точки">
            📌
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
                    class="w-44 ${isInactive ? 'bg-[#14181f] border-gray-800 text-gray-400' : 'bg-gray-800 border-gray-700 text-blue-200'} text-xs rounded-xl px-2.5 py-1.5 flex items-center justify-between outline-none cursor-pointer hover:border-gray-600 transition-colors">
              <span id="cat-label-${tx._id}" class="truncate">${getDynamicCategoryIcon(tx.category)} ${escapeHtml(tx.category)}</span>
              <span class="text-gray-400 text-[8px] ml-1">▼</span>
            </button>
            
            <div id="cat-menu-${tx._id}" 
                 class="custom-dropdown-menu hidden absolute left-0 w-48 max-h-56 overflow-y-auto bg-gray-800 border border-gray-700 rounded-xl shadow-2xl z-50 p-1 space-y-0.5">
              ${cats.map(cat => {
                const defaultList = ['Продукты', 'Кафе и рестораны', 'Маркетплейсы', 'Транспорт', 'Жилье', 'Развлечения', 'Другое', 'Зарплата', 'Возврат', 'Кэшбек'];
                const isCustom = !defaultList.includes(cat);
                return `
                  <div class="flex items-center justify-between rounded-lg px-2 py-1.5 transition-colors ${cat === tx.category ? 'bg-blue-600/20 text-blue-300 font-semibold' : 'text-gray-300 hover:bg-gray-700/70'}">
                    <button type="button" 
                            onclick="selectImportCat('${tx._id}', '${escapeHtml(cat)}')" 
                            class="flex-1 text-left text-xs flex items-center gap-2 cursor-pointer truncate min-w-0">
                      <span>${getDynamicCategoryIcon(cat)}</span>
                      <span class="truncate">${escapeHtml(cat)}</span>
                    </button>
                    ${isCustom ? `
                      <button type="button" onclick="event.stopPropagation(); deleteCategoryFromImport('${escapeHtml(cat)}', '${tx.type}')" class="text-gray-500 hover:text-red-400 p-1 text-[11px] leading-none ml-1 cursor-pointer" title="Удалить категорию">✕</button>
                    ` : ''}
                  </div>
                `;
              }).join('')}

              <div class="border-t border-gray-700/80 pt-1 mt-1">
                <button type="button" onclick="event.stopPropagation(); addCategoryFromImport('${tx.type}')" class="w-full text-left px-2 py-1.5 text-xs text-blue-400 hover:bg-gray-700/60 rounded-lg flex items-center gap-1.5 font-semibold cursor-pointer transition-colors">
                  <span>+</span> <span>Добавить категорию</span>
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

function selectImportCat(txId, newCat) {
  const tx = window._lastParsedTransactions?.find(t => t._id === txId);
  if (tx) {
    tx.category = newCat;
    const labelEl = document.getElementById(`cat-label-${txId}`);
    if (labelEl) {
      labelEl.innerHTML = `${getDynamicCategoryIcon(newCat)} ${escapeHtml(newCat)}`;
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

  // Определяем префикс файла по банку
  let bankPrefix = 'gazprombank';
  if (window._lastParsedBankName === 'Сбербанк') bankPrefix = 'sberbank';
  if (window._lastParsedBankName === 'Яндекс Банк') bankPrefix = 'yandexbank';
  if (window._lastParsedBankName === 'Озон Банк') bankPrefix = 'ozonbank';
  const today = new Date().toISOString().slice(0, 10);

  const jsonStr = JSON.stringify(window._lastParsedTransactions, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `${bankPrefix}_parsed_${today}.json`;
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
    const docRef = await db.collection('CategoryRules').add(newRule);
    
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
      <div class="bg-gray-900/70 border border-gray-700/60 rounded-2xl p-3">
        <div class="text-xs font-bold text-gray-200 mb-2 flex items-center gap-1.5 border-b border-gray-800 pb-1">
          <span>${catIcon}</span>
          <span>${escapeHtml(cat)}</span>
          <span class="text-[10px] text-gray-500 font-normal">(${grouped[cat].length})</span>
        </div>
        <div class="flex flex-wrap gap-1.5">
    `;

    grouped[cat].forEach(r => {
      html += `
        <span class="inline-flex items-center gap-1 bg-gray-800 border border-gray-700 text-gray-300 text-xs px-2.5 py-1 rounded-lg">
          <span>${escapeHtml(r.pattern)}</span>
          <button type="button" onclick="deleteRuleFromEditor('${r.id}')" class="text-gray-500 hover:text-red-400 font-bold ml-1 text-xs cursor-pointer" title="Удалить слово">✕</button>
        </span>
      `;
    });

    html += `
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
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
    const docRef = await db.collection('CategoryRules').add(newRule);

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
    await db.collection('CategoryRules').doc(ruleId).delete();
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
    label.innerHTML = `${catIcon || '📦'} ${escapeHtml(catName)}`;
    label.classList.remove('text-gray-400');
    label.classList.add('text-white');
  }
  if (menu) menu.classList.add('hidden');
}

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
    label.innerHTML = `${defaultIcon} ${escapeHtml(defaultCat)}`;
    label.classList.remove('text-gray-400');
    label.classList.add('text-white');
  }

  menu.innerHTML = categories.map(cat => {
    const icon = getDynamicCategoryIcon(cat);
    const isSelected = (cat === defaultCat);
    return `
      <button type="button" 
              onclick="selectModalCat('${type}', '${escapeHtml(cat)}', '${icon}')" 
              class="w-full text-left px-3 py-2 text-xs rounded-xl transition-colors flex items-center gap-2 cursor-pointer ${isSelected ? 'bg-blue-600/20 text-blue-300 font-semibold' : 'text-gray-300 hover:bg-gray-700/70'}">
        <span>${icon}</span>
        <span class="truncate">${escapeHtml(cat)}</span>
      </button>
    `;
  }).join('');
}

// Глобальное закрытие любых открытых кастомных меню при клике в любое место мимо
document.addEventListener('click', (e) => {
  if (!e.target.closest('.custom-dropdown-wrap')) {
    document.querySelectorAll('.custom-dropdown-menu').forEach(m => m.classList.add('hidden'));
  }
});
