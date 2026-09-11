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
class BankDetector {
  /**
   * Анализирует первые строки выписки и определяет банк
   */
  static detect(rawLines) {
    const preview = rawLines.slice(0, 35).join(' ').toLowerCase();

    if (preview.includes('газпромбанк') || preview.includes('гпб') || preview.includes('gazprombank')) {
      return 'GPB';
    }
    // Сигнатура шапки Газпромбанка: Дата + Дата отражения + Содержание операции
    if (preview.includes('дата отражения') && preview.includes('содержание операции')) {
      return 'GPB';
    }

    // Задел под будущие банки:
    // if (preview.includes('сбербанк')) return 'SBER';
    // if (preview.includes('тинькофф') || preview.includes('т-банк')) return 'TBANK';

    return 'GPB'; // По умолчанию для текущей структуры
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
           text.includes('перевод по сбп');
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

// Главный фасад-диспетчер
class StatementDispatcher {
  static parse(rawLines) {
    const bank = BankDetector.detect(rawLines);
    console.log(`Определен банк выписки: ${bank}`);

    switch (bank) {
      case 'GPB':
      default:
        return GazprombankParser.parse(rawLines, { excludeTransfers: true });
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
    const transactions = StatementDispatcher.parse(lines);

    event.target.value = '';
    document.getElementById('toast-container').classList.add('hidden');

    // 3. Отображаем результат Шага 2 в модальном окне
    renderParsedTransactionsView(file.name, transactions);

  } catch (err) {
    console.error('Ошибка обработки PDF:', err);
    showToast('Ошибка: ' + err.message, true);
  }
}

/**
 * Отрисовывает аккуратную таблицу распознанных операций
 */
function renderParsedTransactionsView(fileName, transactions) {
  const dialog = document.getElementById('pdf-debug-dialog');
  const info = document.getElementById('pdf-debug-info');
  const output = document.getElementById('pdf-debug-output');
  // Запоминаем данные для скачивания
  window._lastParsedTransactions = transactions;

  const totalExpense = transactions.filter(t => t.type === 'Расход').reduce((s, t) => s + t.amount, 0);
  const totalIncome = transactions.filter(t => t.type === 'Доход').reduce((s, t) => s + t.amount, 0);

  info.innerHTML = `
    <b>${fileName}</b> • Найдено операций: <span class="text-white font-bold">${transactions.length}</span><br>
    <span class="text-red-400">Расход: ${formatMoney(totalExpense)}</span> | 
    <span class="text-emerald-400">Доход: ${formatMoney(totalIncome)}</span>
  `;

  if (transactions.length === 0) {
    output.innerHTML = `
      <div class="text-center py-8 text-gray-400">
        Не удалось распознать операции. Проверьте формат выписки.
      </div>
    `;
    dialog.classList.remove('hidden');
    return;
  }

  let html = `
    <div class="space-y-2">
  `;

  transactions.forEach((tx, idx) => {
    const isExp = tx.type === 'Расход';
    const amountClass = isExp ? 'text-white' : 'text-emerald-400';
    const amountSign = isExp ? '-' : '+';

    html += `
      <div class="bg-gray-900/90 border border-gray-700/80 p-3 rounded-xl flex items-center justify-between gap-3">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <span class="text-[10px] text-gray-400 bg-gray-800 px-2 py-0.5 rounded font-mono">${tx.displayDate}</span>
            <span class="text-xs font-semibold text-gray-200 truncate">${escapeHtml(tx.merchant)}</span>
          </div>
          <p class="text-[10px] text-gray-500 truncate mt-1">${escapeHtml(tx.rawDetails)}</p>
        </div>
        <div class="text-right flex-shrink-0">
          <span class="text-sm font-bold ${amountClass}">${amountSign}${formatMoney(tx.amount)}</span>
          <span class="block text-[9px] text-gray-500 uppercase">${tx.type}</span>
        </div>
      </div>
    `;
  });

  html += `</div>`;
  output.innerHTML = html;
  dialog.classList.remove('hidden');
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
