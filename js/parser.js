/**
 * MPA 周末课表 PDF 解析器。
 * <p>支持两种版式：① 按班级左右列；② 同时段多课「N 选 1」选修。</p>
 */

import {
  buildChoiceGroups,
  detectScheduleMode,
  parseSideChoiceGroups,
  splitBodyCourseRaw,
} from './elective.js';
import { isHolidayOrNoteText } from './holiday-note.js';

export { isHolidayOrNoteText };

/** 班级名到 PDF 列的映射：五六七为左列，八九十为右列（表头未识别时的兜底） */
export const CLASS_COLUMN = {
  五班: 'left',
  六班: 'left',
  七班: 'left',
  八班: 'right',
  九班: 'right',
  十班: 'right',
};

/** 可选具体班级列表（兜底） */
export const CLASS_OPTIONS = Object.keys(CLASS_COLUMN);

/** 班级名，如「五班」「10班」 */
const CLASS_NAME_RE = /([一二三四五六七八九十百零\d]+)班/g;

/** 标准时段 */
const PERIODS = [
  { period: '1-4节', time: '09:00-12:15', key: '1-4' },
  { period: '5-8节', time: '14:00-17:15', key: '5-8' },
  { period: '9-11节', time: '18:30-20:55', key: '9-11' },
];

const WEEK_RE = /第([一二三四五六七八九十百零\d]+)周/;
const DATE_RE = /(\d{1,2})月(\d{1,2})日/;
const PERIOD_RE = /([1-9]|1[0-9])\s*-\s*([1-9]|1[0-9])\s*节/;
const TIME_RE = /(\d{1,2})[:：](\d{2})\s*-\s*(\d{1,2})[:：](\d{2})/;

/**
 * 从文本中规范周次标签（兼容「第一周18:30」等粘连）。
 * @param {string} text 行内周次相关文本
 * @returns {string} 如「第一周」；没有则空串
 */
function normalizeWeekLabel(text) {
  const m = String(text || '').match(WEEK_RE);
  return m ? `第${m[1]}周` : '';
}

/**
 * 中文周次转数字。
 * @param {string} cn 中文数字
 * @returns {number}
 */
function cnWeekToNumber(cn) {
  if (/^\d+$/.test(cn)) return Number(cn);
  const map = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (cn === '十') return 10;
  if (cn.startsWith('十')) return 10 + (map[cn.slice(1)] || 0);
  if (cn.endsWith('十')) return (map[cn[0]] || 0) * 10;
  if (cn.includes('十')) {
    const [a, b] = cn.split('十');
    return (map[a] || 0) * 10 + (map[b] || 0);
  }
  return map[cn] || 0;
}

/**
 * 校验并格式化「M月D日」。
 * @param {string} month 月
 * @param {string} day 日
 * @returns {string} 合法则返回文案，否则空串
 */
function formatValidDateText(month, day) {
  const m = Number(month);
  const d = Number(day);
  if (!Number.isFinite(m) || !Number.isFinite(d)) return '';
  if (m < 1 || m > 12 || d < 1 || d > 31) return '';
  return `${m}月${d}日`;
}

/**
 * 按表头坐标推断班级课表列边界（适配窄版/宽版 PDF）。
 * @param {{str:string,x:number,y:number}[]} items 首页文本
 * @returns {{weekEnd:number,dateEnd:number,timeEnd:number,splitX:number}}
 */
function detectClassColumnBounds(items) {
  let weekX = 70;
  let dateX = 180;
  let timeX = 280;
  /** @type {number[]} */
  const classXs = [];
  for (const it of items || []) {
    const t = (it.str || '').replace(/\s+/g, '');
    if (t === '周次') weekX = it.x;
    else if (t === '日期') dateX = it.x;
    else if (t === '时间') timeX = it.x;
    else {
      CLASS_NAME_RE.lastIndex = 0;
      if (CLASS_NAME_RE.test(t)) classXs.push(it.x);
    }
  }
  classXs.sort((a, b) => a - b);
  const bodyStart = classXs[0] ?? timeX + 90;
  const weekEnd = (weekX + dateX) / 2;
  const dateEnd = (dateX + timeX) / 2;
  const timeEnd = (timeX + bodyStart) / 2;

  let splitX = 500;
  if (classXs.length >= 2) {
    let bestGap = 0;
    for (let i = 1; i < classXs.length; i++) {
      const gap = classXs[i] - classXs[i - 1];
      if (gap > bestGap) {
        bestGap = gap;
        splitX = (classXs[i - 1] + classXs[i]) / 2;
      }
    }
  }
  // 右列只收到最末班级附近，避免把更右侧第三列课（如英语）粘进九～十二班
  const lastClassX = classXs.length ? classXs[classXs.length - 1] : splitX + 120;
  const rightEnd = Math.max(splitX + 40, lastClassX + 55);
  return { weekEnd, dateEnd, timeEnd, splitX, rightEnd };
}

/**
 * 班级课表分列（使用自适应边界）。
 * @param {number} x 横坐标
 * @param {{weekEnd:number,dateEnd:number,timeEnd:number,splitX:number,rightEnd?:number}} bounds 列边界
 * @returns {'week'|'date'|'time'|'left'|'right'|'extra'}
 */
function columnOfClass(x, bounds) {
  if (x < bounds.weekEnd) return 'week';
  if (x < bounds.dateEnd) return 'date';
  if (x < bounds.timeEnd) return 'time';
  if (x < bounds.splitX) return 'left';
  const rightEnd = bounds.rightEnd ?? 1e9;
  if (x < rightEnd) return 'right';
  return 'extra';
}

/**
 * 按横坐标分列（旧版固定阈值，仅作兜底）。
 * @param {number} x 横坐标
 * @returns {'week'|'date'|'time'|'left'|'right'|'extra'}
 */
function columnOf(x) {
  return columnOfClass(x, {
    weekEnd: 160,
    dateEnd: 255,
    timeEnd: 355,
    splitX: 500,
    rightEnd: 1e9,
  });
}

/**
 * 选修版式分列：正文区多课，右侧目录忽略。
 * @param {number} x 横坐标
 * @returns {'week'|'date'|'time'|'body'|'side'}
 */
function columnOfElective(x) {
  if (x < 95) return 'week';
  if (x < 140) return 'date';
  if (x < 175) return 'time';
  if (x < 560) return 'body';
  return 'side';
}

/**
 * 拼接同行文本。
 * @param {{str:string,x:number}[]} parts 片段
 * @returns {string}
 */
function joinParts(parts) {
  return parts
    .slice()
    .sort((a, b) => a.x - b.x)
    .map((p) => p.str)
    .join('')
    .replace(/\s+/g, '');
}

/**
 * 解析单元格。
 * <p>正常课提取学科、老师、地点（允许缺项）；去掉「N学时」；节假日/调班备注标为 {@code isNote}。</p>
 *
 * @param {string} raw 原始文本
 * @returns {{raw:string,course:string,teacher:string,location:string,isEmpty:boolean,isNote:boolean}}
 */
function parseCell(raw) {
  let text = (raw || '').replace(/\s+/g, '').trim();
  if (!text) {
    return { raw: '', course: '', teacher: '', location: '', isEmpty: true, isNote: false };
  }

  // 学时不展示、不参与地点
  text = text.replace(/（\d+学时）/g, '').replace(/\d+学时/g, '');

  let location = '';
  let teacher = '';
  let body = text;
  const locs = [...text.matchAll(/（([^）]+)）/g)];
  if (locs.length) {
    /** @type {string[]} */
    const locParts = [];
    for (const m of locs) {
      const inner = (m[1] || '').trim();
      if (!inner || /^\d+学时$/.test(inner) || /学时/.test(inner)) continue;
      locParts.push(inner);
    }
    body = text.replace(/（[^）]+）/g, '').trim();
    const locBlob = locParts.join(' ').trim();
    if (locBlob) {
      // 括号内「地点-老师」（新版选修课表常见）
      const dash = locBlob.lastIndexOf('-');
      if (dash > 0 && /[\u4e00-\u9fffA-Za-z]{1,}$/.test(locBlob.slice(dash + 1))) {
        location = locBlob.slice(0, dash).trim();
        teacher = locBlob.slice(dash + 1).trim();
      } else {
        location = locBlob;
      }
    }
  }

  // 节假日/调班等备注：不算正常上课（元旦、国庆休、预估考试等）
  if (isHolidayOrNoteText(body) || isHolidayOrNoteText(text)) {
    return {
      raw: text,
      course: body || text,
      teacher: '',
      location: '',
      isEmpty: false,
      isNote: true,
    };
  }

  // 「课程--老师」或「课程-老师」；粘连多门时只取第一门
  body = body.replace(/-{2,}/g, '-');
  const firstCourse = body.match(
    /^([\u4e00-\u9fffA-Za-z0-9·．.]{2,}?)-((?:[\u4e00-\u9fffA-Za-z]{2,4})(?:[、，,][\u4e00-\u9fffA-Za-z]{2,4})*)/
  );
  if (firstCourse) {
    return {
      raw: text,
      course: firstCourse[1].trim(),
      teacher: (firstCourse[2] || teacher).trim(),
      location,
      isEmpty: false,
      isNote: false,
    };
  }

  const idx = body.indexOf('-');
  if (idx > 0) {
    return {
      raw: text,
      course: body.slice(0, idx).trim(),
      teacher: body.slice(idx + 1).trim() || teacher,
      location,
      isEmpty: false,
      isNote: false,
    };
  }

  // 仅有课程名或地点等不完整信息，仍视为正常课
  return {
    raw: text,
    course: body,
    teacher,
    location,
    isEmpty: !body && !location && !teacher,
    isNote: false,
  };
}

/**
 * 空时段。
 * @param {{period:string,time:string,key:string}} meta 时段
 * @returns {object}
 */
function emptySlot(meta) {
  return {
    period: meta.period,
    time: meta.time,
    key: meta.key,
    left: parseCell(''),
    right: parseCell(''),
    options: [],
    choiceGroupId: null,
  };
}

/**
 * 补齐三日段。
 * @param {object|null} day 日
 * @returns {object}
 */
function ensureDaySlots(day) {
  if (!day) day = { date: '', dateText: '', weekday: '', slots: [] };
  const map = new Map((day.slots || []).map((s) => [s.key, s]));
  day.slots = PERIODS.map((p) => map.get(p.key) || emptySlot(p));
  return day;
}

/**
 * 从首页表头文本项拼标题（避免年份被误分到日期/时间列而丢失）。
 * @param {{str:string,x:number,y:number}[]} headerItems 首页上部文本
 * @returns {string}
 */
function buildTitleFromHeaderItems(headerItems) {
  if (!headerItems?.length) return '';
  const maxY = Math.max(...headerItems.map((h) => h.y));
  // 取最上方两行标题带
  const top = headerItems
    .filter((h) => h.y >= maxY - 40)
    .sort((a, b) => b.y - a.y || a.x - b.x);
  let title = '';
  let lastY = null;
  for (const h of top) {
    const t = (h.str || '').trim();
    if (!t || t === '周次') break;
    if (/^周次|日期|时间|五班|六班/.test(t)) break;
    if (lastY != null && lastY - h.y > 25 && title.includes('课程表')) break;
    title += t;
    lastY = h.y;
  }
  return title.replace(/\s+/g, '').slice(0, 100);
}

/**
 * 从课表标题中解析专业简称（如 MPA、MBA）。
 * @param {string} title PDF 标题
 * @returns {string} 专业简称；没有则空串
 */
function extractMajor(title) {
  const text = title || '';
  const m =
    text.match(/([A-Za-z]{2,12})(?:专业学位)?(?:硕士)?研究生课程表/) ||
    text.match(/([A-Za-z]{2,12})研究生/) ||
    text.match(/([A-Za-z]{2,12})课程表/);
  if (!m) return '';
  return m[1].toUpperCase();
}

/**
 * 从课表标题、全文或文件名中解析学期、年级。
 * <p>兼容半角/全角破折号，以及文件名如「…2026-2027-1学期MPA…」。</p>
 *
 * @param {string} title PDF 标题文本
 * @param {string} [allText] 全文或文件名等兜底文本
 * @returns {{semester:string,grade:string}}
 */
export function extractSemesterGrade(title, allText = '') {
  // 统一各类破折号，避免 PDF 用全角「－」导致匹配失败
  const text = `${title || ''} ${allText || ''}`.replace(/[–—－]/g, '-');
  let semester = '';
  const parts =
    text.match(/(20\d{2})\s*-\s*(20\d{2})\s*-\s*(\d)\s*学期/) ||
    text.match(/(20\d{2})\s*-\s*(20\d{2}).{0,12}(\d)\s*学期/);
  if (parts) semester = `${parts[1]}-${parts[2]}-${parts[3]}学期`;
  const gradeMatch = text.match(/（\s*(20\d{2}\s*级)\s*）|\((\s*20\d{2}\s*级\s*)\)|(20\d{2}级)/);
  const grade = gradeMatch
    ? (gradeMatch[1] || gradeMatch[2] || gradeMatch[3] || '').replace(/\s+/g, '')
    : '';
  return { semester, grade };
}

/**
 * 从 PDF 表头解析可选班级，并按横坐标归入左列/右列。
 * <p>例：表头「五班/六班/七班」「八班/九班/十班」→ 前三个 left、后三个 right。</p>
 *
 * @param {{str:string,x:number,y:number}[]} headerItems 首页靠上的文本片段（已过滤空串）
 * @returns {{classOptions:string[],classColumns:Record<string,'left'|'right'>}}
 * @see parseSchedulePdf
 */
function extractClassesFromHeader(headerItems) {
  /** @type {{name:string,x:number}[]} */
  const found = [];
  for (const item of headerItems) {
    const text = (item.str || '').replace(/\s+/g, '');
    CLASS_NAME_RE.lastIndex = 0;
    let m;
    while ((m = CLASS_NAME_RE.exec(text))) {
      found.push({ name: `${m[1]}班`, x: item.x });
    }
  }

  found.sort((a, b) => a.x - b.x);
  /** @type {string[]} */
  const classOptions = [];
  /** @type {{name:string,x:number}[]} */
  const unique = [];
  for (const item of found) {
    if (classOptions.includes(item.name)) continue;
    classOptions.push(item.name);
    unique.push(item);
  }

  /** @type {Record<string,'left'|'right'>} */
  const classColumns = {};
  if (unique.length >= 2) {
    let bestGap = 0;
    let splitX = (unique[0].x + unique[unique.length - 1].x) / 2;
    for (let i = 1; i < unique.length; i++) {
      const gap = unique[i].x - unique[i - 1].x;
      if (gap > bestGap) {
        bestGap = gap;
        splitX = (unique[i - 1].x + unique[i].x) / 2;
      }
    }
    for (const { name, x } of unique) {
      classColumns[name] = x < splitX ? 'left' : 'right';
    }
  } else if (unique.length === 1) {
    classColumns[unique[0].name] = 'left';
  }

  if (classOptions.length) {
    return { classOptions, classColumns };
  }

  return {
    classOptions: [...CLASS_OPTIONS],
    classColumns: { ...CLASS_COLUMN },
  };
}

/**
 * 取课表可用的班级列表与列映射（优先用解析结果）。
 * @param {object|null|undefined} schedule 已解析课表
 * @returns {{classOptions:string[],classColumns:Record<string,'left'|'right'>}}
 */
export function getScheduleClasses(schedule) {
  const opts = schedule?.classOptions;
  const cols = schedule?.classColumns;
  if (Array.isArray(opts) && opts.length && cols && typeof cols === 'object') {
    return { classOptions: opts, classColumns: cols };
  }
  return {
    classOptions: [...CLASS_OPTIONS],
    classColumns: { ...CLASS_COLUMN },
  };
}

/**
 * 推断学期起始年。
 * @param {string} title 标题
 * @returns {number}
 */
function inferYear(title) {
  const m = title.match(/(20\d{2})\s*[-–—]\s*(20\d{2})/);
  if (m) return Number(m[1]);
  const y = title.match(/20\d{2}/);
  return y ? Number(y[0]) : new Date().getFullYear();
}

/**
 * 中文月日转 ISO。
 * @param {string} dateText 月日
 * @param {number} startYear 起始年
 * @returns {string}
 */
function toIsoDate(dateText, startYear) {
  const m = dateText && dateText.match(DATE_RE);
  if (!m) return '';
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  const year = month <= 2 ? startYear + 1 : startYear;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * 页面文本项分行分列。
 * @param {Array} items pdf 文本项
 * @param {number} pageIndex 页码（从 1）
 * @param {'class'|'elective'} [mode='class'] 课表模式
 * @param {{weekEnd:number,dateEnd:number,timeEnd:number,splitX:number}|null} [classBounds] 班级模式列边界
 * @returns {Array}
 */
function buildRows(items, pageIndex, mode = 'class', classBounds = null) {
  const filtered = items
    .filter((it) => it && typeof it.str === 'string' && it.str.trim() !== '')
    .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5] }));

  filtered.sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  for (const it of filtered) {
    let row = rows.find((r) => Math.abs(r.y - it.y) <= 4);
    if (!row) {
      row = { y: it.y, pageIndex, parts: [] };
      rows.push(row);
    }
    row.parts.push(it);
  }

  const bounds =
    classBounds ||
    ({
      weekEnd: 160,
      dateEnd: 255,
      timeEnd: 355,
      splitX: 500,
      rightEnd: 1e9,
    });

  return rows.map((row) => {
    if (mode === 'elective') {
      const buckets = { week: [], date: [], time: [], body: [], side: [] };
      for (const p of row.parts) buckets[columnOfElective(p.x)].push(p);
      const bodyRaws = splitBodyCourseRaw(buckets.body);
      return {
        y: row.y,
        pageIndex,
        order: pageIndex * 10000 - row.y,
        week: joinParts(buckets.week),
        date: joinParts(buckets.date),
        time: joinParts(buckets.time),
        left: bodyRaws[0] || '',
        right: bodyRaws[1] || '',
        bodyRaws,
      };
    }

    const buckets = { week: [], date: [], time: [], left: [], right: [], extra: [] };
    for (const p of row.parts) {
      const col = columnOfClass(p.x, bounds);
      (buckets[col] || buckets.extra).push(p);
    }
    return {
      y: row.y,
      pageIndex,
      order: pageIndex * 10000 - row.y,
      week: joinParts(buckets.week),
      date: joinParts(buckets.date),
      time: joinParts(buckets.time),
      left: joinParts(buckets.left),
      right: joinParts(buckets.right),
      bodyRaws: [],
    };
  });
}

/**
 * 合并课程与地点/断行教师名。
 * @param {string} a 已有
 * @param {string} b 追加
 * @returns {string}
 */
function mergeText(a, b) {
  a = (a || '').trim();
  b = (b || '').trim();
  if (!a) return b;
  if (!b) return a;
  return a + b;
}

/**
 * 从行中提取日期与星期。
 * @param {object} row 行
 * @returns {{dateText:string,weekday:string}}
 */
function extractDateWeekday(row) {
  // 优先日期列，避免节次「5-8」等数字拼出「59月」
  const primary = `${row.date || ''}${row.week || ''}`;
  const secondary = `${row.time || ''}${row.left || ''}${row.right || ''}`;
  /** @type {string} */
  let dateText = '';
  for (const blob of [primary, secondary, `${primary}${secondary}`]) {
    const matches = [...String(blob).matchAll(new RegExp(DATE_RE.source, 'g'))];
    for (const dm of matches) {
      const ok = formatValidDateText(dm[1], dm[2]);
      if (ok) {
        dateText = ok;
        break;
      }
    }
    if (dateText) break;
  }
  const blob = `${primary}${secondary}`;
  let weekday = '';
  if (/周六/.test(blob)) weekday = '周六';
  if (/周日/.test(blob)) weekday = '周日';
  return { dateText, weekday };
}

/**
 * 从行中提取节次 key。
 * @param {object} row 行
 * @returns {string}
 */
function extractPeriodKey(row) {
  const blob = `${row.time}${row.date}`;
  const pm = blob.match(PERIOD_RE);
  return pm ? `${pm[1]}-${pm[2]}` : '';
}

/**
 * 提取时钟时间。
 * @param {object} row 行
 * @returns {string}
 */
function extractClock(row) {
  const tm = `${row.time}${row.date}`.match(TIME_RE);
  if (!tm) return '';
  return `${tm[1].padStart(2, '0')}:${tm[2]}-${tm[3].padStart(2, '0')}:${tm[4]}`;
}

/**
 * 解析 PDF 为周末课表（班级列 或 选修 N 选 1）。
 * @param {*} pdf pdf.js 文档
 * @param {{fileName?:string}} [opts] 可选：文件名用于学期/年级兜底
 * @returns {Promise<object>}
 */
export async function parseSchedulePdf(pdf, opts = {}) {
  /** @type {{pageIndex:number,rawItems:Array,items:{str:string,x:number,y:number}[]}[]} */
  const pages = [];
  /** @type {{str:string,x:number,y:number}[]} */
  let headerItems = [];
  /** @type {{str:string,x:number,y:number}[]} 首页文本，用于右侧选课目录 */
  let page1Items = [];
  let allText = '';
  let title = '';
  const fileName = opts.fileName || '';

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    const items = (tc.items || [])
      .map((it) => ({
        str: it.str || '',
        x: it.transform?.[4] ?? 0,
        y: it.transform?.[5] ?? 0,
      }))
      .filter((it) => it.str.trim());
    pages.push({ pageIndex: i, rawItems: tc.items, items });
    allText += items.map((it) => it.str).join('');

    if (i === 1) {
      page1Items = items;
      const ys = items.map((it) => it.y);
      const maxY = ys.length ? Math.max(...ys) : 0;
      headerItems = items.filter((it) => it.y >= maxY - 120);
    }
  }

  /** 表头班级名带坐标，供模式检测 */
  const headerClassItems = [];
  for (const it of headerItems) {
    const text = (it.str || '').replace(/\s+/g, '');
    CLASS_NAME_RE.lastIndex = 0;
    let m;
    while ((m = CLASS_NAME_RE.exec(text))) {
      headerClassItems.push({ str: `${m[1]}班`, x: it.x });
    }
  }

  const mode = detectScheduleMode(allText, headerClassItems);
  const headerTitle = buildTitleFromHeaderItems(headerItems);
  if (headerTitle) title = headerTitle;

  const classBounds =
    mode === 'class' ? detectClassColumnBounds(page1Items.length ? page1Items : headerItems) : null;

  const allRows = [];
  for (const pg of pages) {
    const rows = buildRows(pg.rawItems, pg.pageIndex, mode, classBounds);
    if (!title) {
      const head = rows
        .slice(0, 5)
        .map((r) => `${r.week}${r.date}${r.time}${r.left}${r.right}${(r.bodyRaws || []).join('')}`)
        .join('');
      if (/课程表|学期/.test(head)) title = head.replace(/周次.*/, '').slice(0, 80);
    }
    const useful = rows.some(
      (r) =>
        !!normalizeWeekLabel(r.week) ||
        DATE_RE.test(`${r.date}${r.time}${r.week}`) ||
        extractPeriodKey(r) ||
        (r.bodyRaws || []).length > 0 ||
        !!(r.left || r.right)
    );
    if (!useful && pg.pageIndex > 2) continue;
    allRows.push(...rows);
  }

  // 优先用表头拼接标题（含 2026-2027-1学期 / MPA）
  if (headerTitle && (/20\d{2}/.test(headerTitle) || /MPA|MBA|课程表/i.test(headerTitle))) {
    title = headerTitle;
  }

  const { classOptions, classColumns } = extractClassesFromHeader(headerItems);

  allRows.sort((a, b) => a.order - b.order);
  const startYear = inferYear(title || '2025-2026');

  // —— 日期锚点（每个周六/日一块；跨页同日扩展 order 范围）——
  /** @type {{dateText:string,weekday:string,order:number,maxOrder:number,pageIndex:number,y:number}[]} */
  const anchors = [];
  for (const row of allRows) {
    const { dateText, weekday } = extractDateWeekday(row);
    if (!dateText) continue;
    const exist = anchors.find((a) => a.dateText === dateText);
    if (exist) {
      if (!exist.weekday && weekday) exist.weekday = weekday;
      exist.order = Math.min(exist.order, row.order);
      exist.maxOrder = Math.max(exist.maxOrder ?? exist.order, row.order);
      continue;
    }
    anchors.push({
      dateText,
      weekday,
      order: row.order,
      maxOrder: row.order,
      pageIndex: row.pageIndex,
      y: row.y,
    });
  }

  // 补全星期：奇数位周六、偶数位周日（按出现顺序）
  anchors.sort((a, b) => a.order - b.order);
  for (let i = 0; i < anchors.length; i++) {
    if (!anchors[i].weekday) anchors[i].weekday = i % 2 === 0 ? '周六' : '周日';
    if (anchors[i].maxOrder == null) anchors[i].maxOrder = anchors[i].order;
  }

  // 周次标签按出现顺序（从粘连文本中抽出「第N周」）
  const weekLabels = [];
  for (const row of allRows) {
    const label = normalizeWeekLabel(row.week) || normalizeWeekLabel(row.date);
    if (!label) continue;
    const num = cnWeekToNumber(label.replace(/^第/, '').replace(/周$/, ''));
    if (!num) continue;
    if (!weekLabels.some((w) => w.num === num)) {
      weekLabels.push({ num, label, order: row.order });
    }
  }
  weekLabels.sort((a, b) => a.num - b.num);

  /**
   * 将行归属到最近的日期锚点（按 order 距离，落在相邻锚点中点之间）。
   * @param {number} order 行序
   * @returns {object|null}
   */
  function anchorFor(order) {
    if (!anchors.length) return null;
    for (let i = 0; i < anchors.length; i++) {
      const prev = anchors[i - 1];
      const next = anchors[i + 1];
      const curStart = anchors[i].order;
      const curEnd = anchors[i].maxOrder ?? anchors[i].order;
      const top = prev ? (prev.maxOrder + curStart) / 2 : -Infinity;
      const bottom = next ? (curEnd + next.order) / 2 : Infinity;
      if (order >= top && order < bottom) return anchors[i];
    }
    return anchors[anchors.length - 1];
  }

  /** @type {Map<string, any>} dayKey -> day */
  const dayMap = new Map();

  function dayKeyOf(anchor) {
    return `${anchor.dateText}|${anchor.weekday}`;
  }

  function getDay(anchor) {
    const key = dayKeyOf(anchor);
    if (!dayMap.has(key)) {
      dayMap.set(key, {
        dateText: anchor.dateText,
        date: toIsoDate(anchor.dateText, startYear),
        weekday: anchor.weekday,
        order: anchor.order,
        slots: PERIODS.map((p) => emptySlot(p)),
      });
    }
    return dayMap.get(key);
  }

  // 预创建所有锚点日
  for (const a of anchors) getDay(a);

  /** 正在填充的时段：{anchor, slot} */
  let pending = null;

  function flushPending() {
    pending = null;
  }

  for (const row of allRows) {
    const hasBody = (row.bodyRaws || []).length > 0 || row.left || row.right;
    if (normalizeWeekLabel(row.week) && !extractPeriodKey(row) && !hasBody) {
      continue;
    }

    const periodKey = extractPeriodKey(row);
    const clock = extractClock(row);
    const anchor = anchorFor(row.order);
    if (!anchor) continue;
    const day = getDay(anchor);

    if (periodKey) {
      flushPending();
      const meta = PERIODS.find((p) => p.key === periodKey) || {
        period: `${periodKey}节`,
        time: clock,
        key: periodKey,
      };
      const slot = day.slots.find((s) => s.key === meta.key) || emptySlot(meta);
      slot.period = meta.period;
      if (clock) slot.time = clock;
      else slot.time = meta.time;

      if (mode === 'elective') {
        const raws =
          row.bodyRaws?.length > 0
            ? row.bodyRaws
            : [row.left, row.right].filter(Boolean);
        slot.options = raws.map((raw) => parseCell(raw));
        slot.left = slot.options[0] || parseCell('');
        slot.right = parseCell('');
      } else {
        slot.left = parseCell(row.left);
        slot.right = parseCell(row.right);
        slot.options = [];
        // 居中备注同步两列
        if (!slot.left.isEmpty && slot.right.isEmpty && slot.left.isNote) {
          slot.right = { ...slot.left };
        } else if (!slot.right.isEmpty && slot.left.isEmpty && slot.right.isNote) {
          slot.left = { ...slot.right };
        }
      }

      const idx = day.slots.findIndex((s) => s.key === slot.key);
      if (idx >= 0) day.slots[idx] = slot;
      pending = { day, slot, order: row.order };
      continue;
    }

    if (pending && pending.day === day) {
      const { slot } = pending;
      if (clock) slot.time = clock;
      if (mode === 'elective') {
        const raws = row.bodyRaws?.length ? row.bodyRaws : [row.left, row.right].filter(Boolean);
        raws.forEach((raw, i) => {
          if (!raw) return;
          const prev = slot.options[i] || parseCell('');
          slot.options[i] = parseCell(mergeText(prev.raw, raw));
        });
        slot.left = slot.options[0] || parseCell('');
      } else {
        if (row.left) {
          const merged = mergeText(slot.left.raw, row.left);
          slot.left = parseCell(merged);
        }
        if (row.right) {
          const merged = mergeText(slot.right.raw, row.right);
          slot.right = parseCell(merged);
        }
        if (!slot.left.isEmpty && slot.right.isEmpty && slot.left.isNote) {
          slot.right = { ...slot.left };
        }
      }
      continue;
    }

    // 无 pending 时的独立备注行
    const noteBlob = `${row.left}${row.right}${(row.bodyRaws || []).join('')}`;
    // 与 holiday-note 词表对齐，避免「元旦」等游离备注行漏挂到时段
    if (hasBody && isHolidayOrNoteText(noteBlob)) {
      const noteCell = parseCell(row.bodyRaws?.[0] || row.left || row.right);
      let target = day.slots.find((s) => s.key === '5-8' && s.left.isEmpty && s.right.isEmpty);
      if (!target) target = day.slots.find((s) => s.left.isEmpty && s.right.isEmpty);
      if (target) {
        target.left = noteCell;
        target.right = { ...noteCell };
        if (mode === 'elective') target.options = [noteCell];
      }
    }
  }

  // 按日期顺序组装周：每两个锚点（六、日）为一周；周次标签按序对齐
  const daysOrdered = [...dayMap.values()].sort((a, b) => a.order - b.order);
  const weeks = [];
  for (let i = 0; i < daysOrdered.length; i++) {
    const d = daysOrdered[i];
    let week = weeks[weeks.length - 1];
    if (d.weekday === '周六' || !week || (week.saturday && week.sunday && d.weekday === '周六')) {
      const meta = weekLabels[weeks.length] || {
        num: weeks.length + 1,
        label: `第${weeks.length + 1}周`,
      };
      week = {
        weekIndex: meta.num,
        weekLabel: meta.label,
        saturday: ensureDaySlots(null),
        sunday: ensureDaySlots(null),
      };
      weeks.push(week);
    }
    if (d.weekday === '周六') {
      week.saturday = ensureDaySlots(d);
    } else {
      week.sunday = ensureDaySlots(d);
    }
  }

  // 若周次数与标签数不一致，用标签覆盖名称
  weeks.forEach((w, i) => {
    if (weekLabels[i]) {
      w.weekIndex = weekLabels[i].num;
      w.weekLabel = weekLabels[i].label;
    }
    w.saturday = ensureDaySlots(w.saturday);
    w.sunday = ensureDaySlots(w.sunday);
    if (w.saturday.date && !w.sunday.dateText) {
      const dt = new Date(w.saturday.date + 'T12:00:00');
      dt.setDate(dt.getDate() + 1);
      w.sunday.date = dt.toISOString().slice(0, 10);
      w.sunday.dateText = `${dt.getMonth() + 1}月${dt.getDate()}日`;
      w.sunday.weekday = '周日';
    }
    if (w.sunday.date && !w.saturday.dateText) {
      const dt = new Date(w.sunday.date + 'T12:00:00');
      dt.setDate(dt.getDate() - 1);
      w.saturday.date = dt.toISOString().slice(0, 10);
      w.saturday.dateText = `${dt.getMonth() + 1}月${dt.getDate()}日`;
      w.saturday.weekday = '周六';
    }
  });

  const sideGroups =
    mode === 'elective' ? parseSideChoiceGroups(page1Items) : [];
  const choiceGroups =
    mode === 'elective' ? buildChoiceGroups(weeks, sideGroups) : [];
  // 标题 + 全文 + 文件名三重兜底，确保学期/年级可解析
  const meta = extractSemesterGrade(title, `${allText}\n${fileName}`);
  const major = extractMajor(title) || extractMajor(`${allText} ${fileName}`) || 'MPA';

  return {
    title: title || '课程表',
    startYear,
    major,
    semester: meta.semester,
    grade: meta.grade,
    sourceFileName: fileName || '',
    mode,
    classOptions,
    classColumns,
    choiceGroups,
    choiceSource: sideGroups.length ? 'side' : mode === 'elective' ? 'schedule' : '',
    /** 当前解析器针对周末课表；后续非纯周末课表为 false */
    weekendOnly: true,
    weeks,
  };
}

/**
 * 日是否无课（无正常课信息，或仅为节假日备注）。
 * @param {object} day 日
 * @param {'left'|'right'} column 列
 * @returns {boolean}
 */
export function isDayEmpty(day, column) {
  return (day.slots || []).every((s) => {
    const cell = s[column];
    if (!cell || cell.isEmpty || cell.isNote) return true;
    const course = (cell.course || '').trim();
    const teacher = (cell.teacher || '').trim();
    const location = (cell.location || '').trim();
    // 旧缓存可能未标 isNote，按课程名再判一次节假日备注
    if (isHolidayOrNoteText(course) || isHolidayOrNoteText(cell.raw)) return true;
    return !course && !teacher && !location;
  });
}

/**
 * 周是否无课。
 * @param {object} week 周
 * @param {'left'|'right'} column 列
 * @returns {boolean}
 */
export function isWeekEmpty(week, column) {
  return isDayEmpty(week.saturday, column) && isDayEmpty(week.sunday, column);
}
