/**
 * 周末课表 PWA 入口。
 * <p>负责导入 PDF、选择具体班级、按当前周展示、覆盖导入与 Service Worker 注册。</p>
 */

import { getDocument, GlobalWorkerOptions } from '../lib/pdf.min.mjs?v=49';
import QRCode from '../lib/qrcode-bundle.js?v=49';
import {
  extractSemesterGrade,
  getScheduleClasses,
  isHolidayOrNoteText,
  parseSchedulePdf,
} from './parser.js?v=49';
import {
  resolveElectiveSlot,
} from './elective.js?v=49';
import { loadStore, saveStore } from './storage.js?v=49';

GlobalWorkerOptions.workerSrc = new URL(
  '../lib/pdf.worker.min.mjs?v=49',
  import.meta.url
).href;

/** 前端资源版本：与 sw / HTML 查询参数同步，用于强制刷新旧缓存 */
const APP_VERSION = '49';

/**
 * 版本升级时清掉旧 Service Worker 与 Cache，避免「选 PDF 没反应」。
 * @returns {Promise<boolean>} 若已触发刷新返回 true（调用方应停止后续初始化）
 */
async function migrateCachesIfNeeded() {
  const key = 'schedule-pwa-boot-v';
  try {
    if (localStorage.getItem(key) === APP_VERSION) return false;
    localStorage.setItem(key, APP_VERSION);
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if (window.caches?.keys) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
    window.location.reload();
    return true;
  } catch {
    return false;
  }
}

/** @type {{className:string,schedule:object,importedAt:string}|null} */
let store = loadStore();
/** 已解析但尚未确认班级的课表（导入第二步） */
let pendingSchedule = null;
/** 当前周在 weeks 数组中的下标；-1 表示课表外真实本周 */
let weekIndex = 0;

/** 标准空时段（课表外本周用） */
const EMPTY_PERIODS = [
  { period: '1-4节', time: '09:00-12:15', key: '1-4' },
  { period: '5-8节', time: '14:00-17:15', key: '5-8' },
  { period: '9-11节', time: '18:30-20:55', key: '9-11' },
];

const els = {
  viewImport: document.getElementById('viewImport'),
  viewSchedule: document.getElementById('viewSchedule'),
  headerSub: document.getElementById('headerSub'),
  brandTitle: document.getElementById('brandTitle'),
  btnSettings: document.getElementById('btnSettings'),
  classSelect: document.getElementById('classSelect'),
  classStep: document.getElementById('classStep'),
  btnConfirmClass: document.getElementById('btnConfirmClass'),
  courseStep: document.getElementById('courseStep'),
  courseGroups: document.getElementById('courseGroups'),
  btnConfirmCourses: document.getElementById('btnConfirmCourses'),
  pdfInput: document.getElementById('pdfInput'),
  uploadArea: document.getElementById('uploadArea'),
  uploadLabel: document.getElementById('uploadLabel'),
  importStatus: document.getElementById('importStatus'),
  weekLabel: document.getElementById('weekLabel'),
  weekTerm: document.getElementById('weekTerm'),
  weekJump: document.getElementById('weekJump'),
  btnWeekPicker: document.getElementById('btnWeekPicker'),
  weekPickerValue: document.getElementById('weekPickerValue'),
  weekPickerDialog: document.getElementById('weekPickerDialog'),
  weekPickerList: document.getElementById('weekPickerList'),
  btnCloseWeekPicker: document.getElementById('btnCloseWeekPicker'),
  weekEmptyState: document.getElementById('weekEmptyState'),
  /** 课表卡片滚动容器；换周后需滚回顶部 */
  scheduleScroll: document.querySelector('#viewSchedule .schedule-scroll'),
  days: document.getElementById('days'),
  btnPrev: document.getElementById('btnPrev'),
  btnNext: document.getElementById('btnNext'),
  btnToday: document.getElementById('btnToday'),
  settingsDialog: document.getElementById('settingsDialog'),
  settingsClass: document.getElementById('settingsClass'),
  settingsClassBlock: document.getElementById('settingsClassBlock'),
  settingsCourseBlock: document.getElementById('settingsCourseBlock'),
  settingsCourseGroups: document.getElementById('settingsCourseGroups'),
  btnReimport: document.getElementById('btnReimport'),
  btnSaveSettings: document.getElementById('btnSaveSettings'),
  btnCloseSettings: document.getElementById('btnCloseSettings'),
  btnShare: document.getElementById('btnShare'),
  shareDialog: document.getElementById('shareDialog'),
  btnCloseShare: document.getElementById('btnCloseShare'),
  shareUrlInput: document.getElementById('shareUrlInput'),
  btnCopyLink: document.getElementById('btnCopyLink'),
  copyStatus: document.getElementById('copyStatus'),
  tabLink: document.getElementById('tabLink'),
  tabQr: document.getElementById('tabQr'),
  sharePaneLink: document.getElementById('sharePaneLink'),
  sharePaneQr: document.getElementById('sharePaneQr'),
  shareQrImg: document.getElementById('shareQrImg'),
  btnDownloadQr: document.getElementById('btnDownloadQr'),
  courseConfirmDialog: document.getElementById('courseConfirmDialog'),
  courseConfirmMsg: document.getElementById('courseConfirmMsg'),
  btnCourseConfirmEnter: document.getElementById('btnCourseConfirmEnter'),
  btnCourseConfirmContinue: document.getElementById('btnCourseConfirmContinue'),
};

/**
 * 填充班级下拉框。
 * @param {HTMLSelectElement} select 下拉元素
 * @param {string} [selected] 当前选中班级
 * @returns {void}
 */
/**
 * 填充班级下拉框（选项来自课表表头解析结果）。
 * @param {HTMLSelectElement} select 下拉元素
 * @param {string[]} options 可选班级，来自 {@link getScheduleClasses}
 * @param {string} [selected] 当前选中班级
 * @returns {void}
 */
function fillClassOptions(select, options, selected = '') {
  const list = options?.length ? options : [];
  const pick = list.includes(selected) ? selected : list[0] || '';
  select.innerHTML = list
    .map(
      (name) =>
        `<option value="${name}" ${name === pick ? 'selected' : ''}>${name}</option>`
    )
    .join('');
}

/**
 * 具体班级对应 PDF 左右列（优先用本次课表解析的 classColumns）。
 * @param {string} className 具体班级
 * @param {object} [schedule] 课表对象；默认取 store / pending
 * @returns {'left'|'right'}
 */
function columnOfClass(className, schedule) {
  const sch = schedule || store?.schedule || pendingSchedule;
  const { classColumns } = getScheduleClasses(sch);
  return classColumns[className] || 'left';
}

/**
 * 本地日期格式化为 YYYY-MM-DD。
 * @param {Date} d 日期
 * @returns {string}
 */
function toIsoLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 格式化周次旁的日期区间文案（主页展示用，不加前导零）。
 * @param {object} week 周对象
 * @returns {string}
 */
function weekRangeText(week) {
  const a = week.saturday?.dateText || '';
  const b = week.sunday?.dateText || '';
  if (a && b) return `${a}–${b}`;
  return a || b || '';
}

/**
 * 将「M月D日」规范为两位月日，便于下拉对齐。
 * @param {string} dateText 如「9月6日」
 * @returns {string} 如「09月06日」
 */
function padDateText(dateText) {
  const m = (dateText || '').match(/(\d{1,2})月(\d{1,2})日/);
  if (!m) return dateText || '';
  return `${m[1].padStart(2, '0')}月${m[2].padStart(2, '0')}日`;
}

/**
 * 选择周次列表文案：周次固定宽度对齐 + 日期等宽数字。
 * @param {object} week 周对象
 * @param {boolean} weekendOnly 是否周末课表
 * @returns {string}
 */
function weekJumpLabel(week, weekendOnly) {
  if (!weekendOnly) {
    return fullWeekRangeText(week);
  }
  const weekPart = String(week.weekLabel || '').padEnd(4, '　');
  const a = padDateText(week.saturday?.dateText);
  const b = padDateText(week.sunday?.dateText);
  if (a && b) return `${weekPart}  ${a} – ${b}`;
  return weekPart + (a || b ? `  ${a || b}` : '');
}

/**
 * 周次文案 + 可选「无课」标记（绿色，与系统主色一致）。
 * @param {string} baseLabel 周次与日期文案
 * @param {boolean} empty 是否无课
 * @returns {string} 安全 HTML
 */
function weekLabelHtml(baseLabel, empty) {
  const base = escapeHtml(baseLabel);
  if (!empty) return base;
  return `${base}<span class="week-empty-tag">  ·  无课</span>`;
}

/**
 * 当前选择周次按钮上的文案。
 * <p>仅周次与日期；不追加「无课」——主界面已有空态插图「本周无课」，避免累赘。</p>
 *
 * @returns {string} 安全 HTML
 */
function currentWeekPickerLabelHtml() {
  const weeks = store?.schedule?.weeks || [];
  const weekendOnly = store?.schedule?.weekendOnly !== false;
  if (weekIndex < 0) return escapeHtml('本周（不在课表内）');
  const week = weeks[weekIndex];
  if (!week) return escapeHtml('选择周次');
  // 按钮不加「无课」；弹层列表仍用 weekLabelHtml 标注便于扫周
  return escapeHtml(weekJumpLabel(week, weekendOnly));
}

/**
 * 刷新选择周次列表：大触控行、对齐日期；无课用绿色「无课」标注。
 * <p>无课判定与主界面空态共用 {@link isWeekEmptyForView}，避免列表漏标。</p>
 * @returns {void}
 */
function fillWeekSelect() {
  const weeks = store?.schedule?.weeks || [];
  const weekendOnly = store?.schedule?.weekendOnly !== false;
  const jumpable = weeks
    .map((w, i) => ({ w, i }))
    .filter(({ w }) => hasTermWeekLabel(w));

  if (els.weekPickerValue) {
    els.weekPickerValue.innerHTML = currentWeekPickerLabelHtml();
  }

  /** @type {{value:number,labelHtml:string,selected:boolean}[]} */
  const items = [];
  if (weekIndex < 0) {
    items.push({
      value: -1,
      labelHtml: escapeHtml('本周（不在课表内）'),
      selected: true,
    });
  }
  for (const { w, i } of jumpable) {
    items.push({
      value: i,
      labelHtml: weekLabelHtml(weekJumpLabel(w, weekendOnly), isWeekEmptyForView(w)),
      selected: weekIndex === i,
    });
  }

  if (!els.weekPickerList) return;
  els.weekPickerList.innerHTML = items
    .map((item) => {
      const selectedClass = item.selected ? ' is-selected' : '';
      return `<button type="button" class="week-picker-option${selectedClass}" role="option" aria-selected="${item.selected}" data-week="${item.value}">
        <span class="week-picker-option-text">${item.labelHtml}</span>
      </button>`;
    })
    .join('');
}

/**
 * 打开选择周次弹层，并滚到当前项。
 * @returns {void}
 */
function openWeekPicker() {
  fillWeekSelect();
  els.weekPickerDialog?.showModal();
  requestAnimationFrame(() => {
    const cur = els.weekPickerList?.querySelector('.week-picker-option.is-selected');
    cur?.scrollIntoView({ block: 'center' });
  });
}

/**
 * 非纯周末课表：本周标题/跳转用的周一至周日文案。
 * @param {object} week 周对象（至少含周六或周日日期）
 * @returns {string} 如「8月10日-8月16日」
 */
function fullWeekRangeText(week) {
  const satIso = week.saturday?.date;
  const sunIso = week.sunday?.date;
  let monday;
  let sunday;
  if (satIso) {
    const sat = new Date(`${satIso}T12:00:00`);
    monday = new Date(sat);
    monday.setDate(sat.getDate() - 5);
    sunday = sunIso
      ? new Date(`${sunIso}T12:00:00`)
      : new Date(sat.getTime() + 24 * 60 * 60 * 1000);
  } else if (sunIso) {
    sunday = new Date(`${sunIso}T12:00:00`);
    monday = new Date(sunday);
    monday.setDate(sunday.getDate() - 6);
  } else {
    return weekRangeText(week);
  }
  const fmt = (d) => `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${fmt(monday)}-${fmt(sunday)}`;
}

/**
 * 从已存课表解析专业简称（兼容旧数据：从标题里再识别一次）。
 * @returns {string}
 */
function getMajorName() {
  const schedule = store?.schedule;
  if (!schedule) return '';
  if (schedule.major) return String(schedule.major).trim();
  const title = schedule.title || '';
  const m =
    title.match(/([A-Za-z]{2,12})(?:专业学位)?(?:硕士)?研究生课程表/) ||
    title.match(/([A-Za-z]{2,12})课程表/);
  return m ? m[1].toUpperCase() : '';
}

/**
 * 应用标题：默认「电子科大MPA课表」；能解析到其它专业则替换专业名。
 * @returns {string}
 */
function appBrandTitle() {
  const major = getMajorName() || 'MPA';
  return `电子科大${major}课表`;
}

/**
 * 刷新页头、浏览器标题、分享下载名等品牌文案。
 * @returns {void}
 */
function applyBrandTitle() {
  const title = appBrandTitle();
  if (els.brandTitle) els.brandTitle.textContent = title;
  document.title = title;
  if (els.btnDownloadQr) {
    els.btnDownloadQr.setAttribute('download', `${title}-二维码.png`);
  }
  if (els.shareQrImg) {
    els.shareQrImg.alt = `${title}二维码，长按可保存`;
  }
}

/**
 * 主页副标题：班级或已选课摘要 · 年级 · 学期。
 * <p>选修模式用「已选 N 科」缩短文案，避免顶栏副标题换行挤出「期」字。</p>
 *
 * @returns {string} 无课表时为空串；有课表时为用间隔点拼接的摘要
 */
function headerMetaText() {
  if (!store?.schedule) return '';
  const { className, courseSelections, schedule } = store;
  ensureScheduleMeta(schedule);
  const semester = schedule.semester || '';
  const grade = schedule.grade || '';
  let head = className || '';
  if (schedule.mode === 'elective') {
    const n = Object.keys(courseSelections || {}).length;
    head = n ? `已选${n}科` : '选修课表';
  }
  return [head, grade, semester].filter(Boolean).join('  ·  ');
}

/**
 * 补全课表上的学期/年级（旧缓存或标题残缺时从标题、文件名回填）。
 * @param {object} schedule 课表对象（会被就地补字段）
 * @returns {object} 同一 schedule
 */
function ensureScheduleMeta(schedule) {
  if (!schedule) return schedule;
  const hint = `${schedule.title || ''}\n${schedule.sourceFileName || ''}`;
  const meta = extractSemesterGrade(schedule.title || '', hint);
  if (!schedule.semester && meta.semester) schedule.semester = meta.semester;
  if (!schedule.grade && meta.grade) schedule.grade = meta.grade;
  // 标题里有学期但字段空：再强制写一次
  if (!schedule.semester) {
    const again = extractSemesterGrade('', hint);
    if (again.semester) schedule.semester = again.semester;
    if (!schedule.grade && again.grade) schedule.grade = again.grade;
  }
  return schedule;
}

/**
 * 是否选修模式。
 * @param {object} [schedule]
 * @returns {boolean}
 */
function isElectiveMode(schedule) {
  return (schedule || store?.schedule || pendingSchedule)?.mode === 'elective';
}

/**
 * 是否具备可跳转的学期周次标签（如「第一周」）。
 * @param {object} week 周对象
 * @returns {boolean}
 */
function hasTermWeekLabel(week) {
  return !!(week?.weekLabel && /^第.+周$/.test(week.weekLabel));
}

/**
 * 按真实今天计算「本周」周六、周日（周一至周日为一周）。
 * @returns {{saturday:object,sunday:object,rangeText:string}}
 */
function getRealThisWeekend() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = today.getDay(); // 0=日 … 6=六
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(today);
  monday.setDate(today.getDate() + mondayOffset);

  const saturday = new Date(monday);
  saturday.setDate(monday.getDate() + 5);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  /**
   * @param {Date} d 日期
   * @param {string} weekday 星期文案
   */
  function buildDay(d, weekday) {
    const emptyCell = {
      raw: '',
      course: '',
      teacher: '',
      location: '',
      isEmpty: true,
      isNote: false,
    };
    return {
      date: toIsoLocal(d),
      dateText: `${d.getMonth() + 1}月${d.getDate()}日`,
      weekday,
      slots: EMPTY_PERIODS.map((p) => ({
        period: p.period,
        time: p.time,
        key: p.key,
        left: { ...emptyCell },
        right: { ...emptyCell },
      })),
    };
  }

  const sat = buildDay(saturday, '周六');
  const sun = buildDay(sunday, '周日');
  return {
    saturday: sat,
    sunday: sun,
    rangeText: `${sat.dateText}–${sun.dateText}`,
  };
}

/**
 * 在课表中查找与真实本周周末对应的周次下标。
 * @param {object[]} weeks 课表周列表
 * @returns {number} 命中下标；不在课表内返回 -1
 */
function findRealWeekendInSchedule(weeks) {
  const real = getRealThisWeekend();
  const satIso = real.saturday.date;
  const idx = weeks.findIndex((w) => w.saturday?.date === satIso);
  return idx;
}

/**
 * 定位「本周」：优先真实日历周末对应的课表周；不在课表内则返回 -1（显示真实日期）。
 * @param {object[]} weeks 周列表
 * @returns {number}
 */
function currentWeekIndex(weeks) {
  if (!weeks?.length) return -1;
  return findRealWeekendInSchedule(weeks);
}

/**
 * 进入课表时的默认周次：落在课表内则用本周，否则打开第一周（避免误显示「课表外本周」空态却像第一周）。
 * @param {object[]} weeks 周列表
 * @returns {number}
 */
function defaultWeekIndex(weeks) {
  if (!weeks?.length) return -1;
  const cur = findRealWeekendInSchedule(weeks);
  return cur >= 0 ? cur : 0;
}

/**
 * 当前选班/选课视角下，该周是否无课（与主界面是否展示课程一致）。
 * <p>按与 {@code renderSchedule} 相同的 resolve 规则统计可见课；
 * 仅节假日备注（如「元旦」）或空格视为无课；选修待选（{@code needsPick}）不算无课。</p>
 *
 * @param {object} week 周对象
 * @returns {boolean} true 表示周次列表/按钮应标「无课」，主界面应显示空态
 */
function isWeekEmptyForView(week) {
  if (!store?.schedule || !week) return true;
  const elective = isElectiveMode(store.schedule);
  const column = columnOfClass(store.className);
  const selections = store.courseSelections || {};
  const resolveCell = elective
    ? (slot) => resolveElectiveSlot(slot, selections)
    : (slot) => slot[column] || { isEmpty: true };

  let needsPick = false;
  for (const day of [week.saturday, week.sunday]) {
    for (const slot of day?.slots || []) {
      const cell = resolveCell(slot) || { isEmpty: true };
      if (cell.needsPick) needsPick = true;
      if (isNormalClass(cell) && !cell.needsPick) return false;
    }
  }
  // 尚有未选组：不算「无课」，避免列表与待选状态矛盾
  if (needsPick) return false;
  return true;
}

/**
 * 是否为正常上课条目（课程名/老师/地点至少有一项；信息可不全）。
 * <p>节假日备注（元旦、国庆休、国庆班等）返回 false，界面显示无课。</p>
 *
 * @param {object} cell 单元格解析结果
 * @returns {boolean}
 */
function isNormalClass(cell) {
  if (!cell || cell.isEmpty || cell.isNote) return false;
  const course = (cell.course || '').trim();
  const teacher = (cell.teacher || '').trim();
  const location = (cell.location || '').trim();
  // 兼容旧导入数据：未标 isNote 的「元旦」等仍不当作课程
  if (isHolidayOrNoteText(course) || isHolidayOrNoteText(cell.raw)) return false;
  return !!(course || teacher || location);
}

/**
 * 展示用人名排版：两字名中间插全角空格，与三字名同宽对齐。
 * <p>例如「陈霞」→「陈　霞」，与「陈良雨」左列对齐；非恰好两字则原样返回。</p>
 *
 * @param {string} name 老师姓名，来自课表单元格 {@code teacher}（已去学时等杂质）
 * @returns {string} 用于界面展示的姓名；空串原样返回
 */
function formatTeacherDisplay(name) {
  const n = (name || '').trim();
  if (!n) return '';
  // 恰好两个汉字时插全角空格（排版惯例）；含间隔点/多姓名不处理
  if (/^[\u4e00-\u9fff]{2}$/.test(n)) {
    return `${n[0]}　${n[1]}`;
  }
  return n;
}

/**
 * 拼「左列 · 右列」两栏行（节次/时间、老师/地点），便于纵向对齐。
 * <p>仅一侧有内容时不显示间隔点，避免孤立的「·」。</p>
 *
 * @param {string} leftClass 左列 class（如 {@code slot-period}）
 * @param {string} rightClass 右列 class（如 {@code slot-clock}）
 * @param {string} left 左列文案，来自 slot/cell 字段
 * @param {string} right 右列文案；空则整行只渲染左列
 * @returns {string} 安全 HTML 片段；两侧皆空时为空串
 */
function slotPairHtml(leftClass, rightClass, left, right) {
  const l = (left || '').trim();
  const r = (right || '').trim();
  if (!l && !r) return '';
  if (l && r) {
    return `<span class="${leftClass}">${escapeHtml(l)}</span><span class="slot-sep" aria-hidden="true">·</span><span class="${rightClass}">${escapeHtml(r)}</span>`;
  }
  const only = l || r;
  const cls = l ? leftClass : rightClass;
  return `<span class="${cls}">${escapeHtml(only)}</span>`;
}

/**
 * 渲染单日卡片：只罗列有课的时段；该日全无课则不输出。
 * <p>展示顺序：时间 → 课程名 →「老师 · 地点」（缺项不显示、不留空）。</p>
 * <p>时间行、元信息行拆成固定左列 + 右列，使「·」后时间/地点在多门课之间纵向对齐。</p>
 *
 * @param {object} day 日对象
 * @param {(slot:object)=>object} resolveCell 由时段解析出要展示的单元格
 * @returns {string} HTML，无课时为空串
 */
function renderDay(day, resolveCell) {
  const slotHtml = (day.slots || [])
    .map((slot) => {
      const cell = resolveCell(slot) || { isEmpty: true };
      if (!isNormalClass(cell) || cell.needsPick) return '';

      const period = (slot.period || '').trim();
      const time = (slot.time || '').trim();
      const timeInner = slotPairHtml('slot-period', 'slot-clock', period, time);
      const course = (cell.course || '').trim();
      const teacher = formatTeacherDisplay(
        (cell.teacher || '').trim().replace(/\d+学时/g, '').trim()
      );
      const location = (cell.location || '')
        .trim()
        .replace(/（?\d+学时）?/g, '')
        .replace(/\d+学时/g, '')
        .trim();
      const metaInner = slotPairHtml('slot-teacher', 'slot-loc', teacher, location);

      if (!timeInner && !course && !metaInner) return '';

      return `<article class="slot">
        ${timeInner ? `<div class="slot-time">${timeInner}</div>` : ''}
        ${course ? `<div class="slot-course">${escapeHtml(course)}</div>` : ''}
        ${metaInner ? `<div class="slot-meta">${metaInner}</div>` : ''}
      </article>`;
    })
    .filter(Boolean)
    .join('');

  if (!slotHtml) return '';

  const weekday = (day.weekday || '').trim();
  const dateText = (day.dateText || '').trim();
  const dayTitle = [
    weekday ? escapeHtml(weekday) : '',
    dateText ? `<span>${escapeHtml(dateText)}</span>` : '',
  ]
    .filter(Boolean)
    .join(' ');

  return `<section class="day"><h2>${dayTitle}</h2>${slotHtml}</section>`;
}

/**
 * 更新「本周」按钮高亮：已在本周则灰色，否则金色高亮。
 * @returns {void}
 */
function updateTodayButtonState() {
  const current = currentWeekIndex(store?.schedule?.weeks || []);
  const onThisWeek = weekIndex === current;
  els.btnToday.classList.toggle('is-current', onThisWeek);
  els.btnToday.classList.toggle('is-active', !onThisWeek);
}

/**
 * HTML 转义。
 * @param {string} s 原文
 * @returns {string}
 */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 将课程卡片滚动区重置到顶部。
 * <p>换周、点「本周」、从选择周次弹层选周后调用，避免仍停在上一周的滚动位置。</p>
 *
 * @returns {void}
 * @see renderSchedule
 */
function scrollScheduleToTop() {
  const scroller = els.scheduleScroll;
  if (!scroller) return;
  scroller.scrollTop = 0;
}

/**
 * 渲染当前周视图。
 * <p>写完 DOM 后调用 {@link scrollScheduleToTop}，保证更换周次后课程卡片从顶部开始看。</p>
 *
 * @returns {void}
 */
function renderSchedule() {
  if (!store?.schedule?.weeks?.length) {
    showImport();
    return;
  }

  els.viewImport.hidden = true;
  els.viewSchedule.hidden = false;
  els.btnSettings.hidden = false;

  const weeks = store.schedule.weeks;
  const weekendOnly = store.schedule.weekendOnly !== false;
  const elective = isElectiveMode(store.schedule);
  const column = columnOfClass(store.className);
  const selections = store.courseSelections || {};
  const resolveCell = elective
    ? (slot) => resolveElectiveSlot(slot, selections)
    : (slot) => slot[column] || { isEmpty: true };

  const outside = weekIndex < 0;
  /** @type {object} */
  let week;
  if (outside) {
    const real = getRealThisWeekend();
    week = {
      weekLabel: '',
      saturday: real.saturday,
      sunday: real.sunday,
    };
  } else {
    weekIndex = Math.max(0, Math.min(weekIndex, weeks.length - 1));
    week = weeks[weekIndex];
  }

  els.headerSub.textContent = headerMetaText();
  applyBrandTitle();

  els.weekLabel.textContent = weekendOnly
    ? weekRangeText(week)
    : fullWeekRangeText(week);

  const showTerm = weekendOnly && !outside && hasTermWeekLabel(week);
  els.weekTerm.hidden = !showTerm;
  els.weekTerm.textContent = showTerm ? week.weekLabel : '';

  // 与周次列表共用同一套无课判定，避免「主界面空、列表未标无课」
  const empty = isWeekEmptyForView(week);
  const dayHtml =
    renderDay(week.saturday, resolveCell) + renderDay(week.sunday, resolveCell);

  if (empty) {
    els.days.innerHTML = '';
    els.days.hidden = true;
    els.weekEmptyState.hidden = false;
  } else {
    // 选修未选完时时段不渲染具体课，给简短提示（不算无课）
    els.days.innerHTML =
      dayHtml.trim() ||
      '<p class="hint">本周有待选课程，请先在设置中完成选课</p>';
    els.days.hidden = false;
    els.weekEmptyState.hidden = true;
  }

  const jumpableCount = weeks.filter(hasTermWeekLabel).length;
  els.weekJump.hidden = jumpableCount === 0;
  if (jumpableCount > 0) fillWeekSelect();

  els.btnPrev.disabled = outside || weekIndex <= 0;
  els.btnNext.disabled = outside || weekIndex >= weeks.length - 1;
  updateTodayButtonState();
  // 左右箭头 / 选择周次 /「本周」最终都走这里，统一置顶
  scrollScheduleToTop();
}

/**
 * 在指定容器渲染选修分组（导入页 / 设置页共用，大触控块）。
 * @param {HTMLElement|null} host 容器
 * @param {object[]} groups 选课组（已按课表出现顺序）
 * @param {Record<string,string>} [selected] 已选 map
 * @param {string} [namePrefix] radio name 前缀，避免同页冲突
 * @returns {void}
 */
function renderCourseGroupsInto(host, groups, selected = {}, namePrefix = 'group') {
  if (!host) return;
  host.innerHTML = (groups || [])
    .map((g) => {
      const opts = (g.options || [])
        .map((o, oi) => {
          const id = `${namePrefix}-${g.id}-${oi}`;
          const picked = selected[g.id];
          const checked = picked === o.key || picked === o.course ? 'checked' : '';
          const teacherLine = o.teacher
            ? `<span class="course-teacher">${escapeHtml(o.teacher)}</span>`
            : '';
          return `<label class="course-option" for="${id}">
            <input type="radio" name="${namePrefix}-${g.id}" id="${id}" value="${escapeHtml(o.key || o.course)}" ${checked} />
            <span class="course-option-text">
              <span class="course-name">${escapeHtml(o.course || o.key)}</span>
              ${teacherLine}
            </span>
          </label>`;
        })
        .join('');
      return `<div class="course-group" data-group="${escapeHtml(g.id)}">
        <h3>${escapeHtml(g.when ? `${g.when} · ${g.label || '任选1门'}` : g.label || '任选1门')}</h3>
        ${opts}
      </div>`;
    })
    .join('');
}

/**
 * 渲染选修「N 选 1」分组到导入页。
 * @param {object[]} groups 选课组
 * @param {Record<string,string>} [selected] 已选
 * @returns {void}
 */
function renderCourseGroups(groups, selected = {}) {
  renderCourseGroupsInto(els.courseGroups, groups, selected, 'cg');
}

/**
 * 读取页面上的选课结果。
 * @returns {Record<string,string>}
 */
function readCourseSelectionsFromDom() {
  /** @type {Record<string,string>} */
  const out = {};
  els.courseGroups?.querySelectorAll('.course-group').forEach((box) => {
    const gid = box.getAttribute('data-group');
    const checked = box.querySelector('input[type="radio"]:checked');
    if (gid && checked) out[gid] = checked.value;
  });
  return out;
}

/**
 * 显示导入页；解析后按模式进入选班或选课。
 * @param {string} [message] 状态文案
 * @param {{resetPending?:boolean}} [opts]
 * @returns {void}
 */
function showImport(message = '', opts = {}) {
  if (opts.resetPending) pendingSchedule = null;

  els.viewImport.hidden = false;
  els.viewSchedule.hidden = true;
  els.btnSettings.hidden = !store;
  els.headerSub.textContent = '';
  applyBrandTitle();

  const ready = !!pendingSchedule?.weeks?.length;
  const elective = isElectiveMode(pendingSchedule);
  if (els.classStep) els.classStep.hidden = !(ready && !elective);
  if (els.courseStep) els.courseStep.hidden = !(ready && elective);
  if (els.uploadArea) {
    els.uploadArea.hidden = false;
    els.uploadArea.classList.toggle('is-dimmed', ready);
  }

  if (ready && !elective) {
    const { classOptions } = getScheduleClasses(pendingSchedule);
    fillClassOptions(els.classSelect, classOptions, store?.className || classOptions[0]);
  }
  if (ready && elective) {
    renderCourseGroups(
      pendingSchedule.choiceGroups || [],
      store?.courseSelections || {}
    );
  }

  els.importStatus.textContent = message || '';
  els.importStatus.className = 'status';
}

/**
 * 设置导入状态。
 * @param {string} text 文案
 * @param {'ok'|'error'|''} [type] 类型
 * @returns {void}
 */
function setImportStatus(text, type = '') {
  els.importStatus.textContent = text;
  els.importStatus.className = `status ${type}`.trim();
}

/** 是否正在导入，避免重复选择与 SW 刷新打断 */
let importing = false;

/**
 * 处理 PDF 文件导入：解析成功后进入选班，确认后再写入本地。
 * @param {File} file PDF 文件
 * @returns {Promise<void>}
 */
async function importPdf(file) {
  if (!file || importing) return;

  const name = (file.name || '').toLowerCase();
  const looksPdf =
    file.type === 'application/pdf' ||
    name.endsWith('.pdf') ||
    file.type === '' ||
    file.type === 'application/octet-stream';
  if (!looksPdf) {
    setImportStatus('请选择 PDF 格式的课表文件', 'error');
    return;
  }

  importing = true;
  els.uploadArea?.classList.add('is-busy');
  els.uploadLabel.textContent = file.name || '已选择文件';
  setImportStatus('正在解析 PDF，请稍候…');
  if (els.classStep) els.classStep.hidden = true;

  try {
    const buffer = await file.arrayBuffer();
    if (!buffer || buffer.byteLength < 100) {
      throw new Error('文件读取失败或文件过小，请重新选择 PDF');
    }
    const pdf = await getDocument({ data: new Uint8Array(buffer) }).promise;
    const schedule = await parseSchedulePdf(pdf, { fileName: file.name || '' });
    if (!schedule.weeks?.length) {
      throw new Error('未能识别课表周次，请确认是学校下发的课表 PDF');
    }
    ensureScheduleMeta(schedule);

    pendingSchedule = schedule;
    showImport();
  } catch (err) {
    console.error(err);
    pendingSchedule = null;
    const msg = err?.message || String(err) || '解析失败';
    setImportStatus(msg.includes('Invalid PDF') ? '无法打开该文件，请确认是 PDF 课表' : msg, 'error');
    els.uploadLabel.textContent = '点此重新选择 PDF 文件';
    if (els.classStep) els.classStep.hidden = true;
    if (els.courseStep) els.courseStep.hidden = true;
  } finally {
    importing = false;
    els.uploadArea?.classList.remove('is-busy');
  }
}

/**
 * 确认班级并写入本地，进入课表视图。
 * @returns {void}
 */
function confirmClassAndEnter() {
  if (!pendingSchedule?.weeks?.length) {
    setImportStatus('请先上传课表 PDF', 'error');
    return;
  }
  const { classOptions } = getScheduleClasses(pendingSchedule);
  const className = els.classSelect.value || classOptions[0];
  if (!className) {
    setImportStatus('未解析到班级，请重新导入课表', 'error');
    return;
  }

  store = {
    className,
    courseSelections: {},
    schedule: pendingSchedule,
    importedAt: new Date().toISOString(),
  };
  saveStore(store);
  pendingSchedule = null;
  weekIndex = defaultWeekIndex(store.schedule.weeks);
  renderSchedule();
}

/**
 * 确认选修课并进入课表；未选完时询问是否仍进入。
 * @returns {Promise<void>}
 */
async function confirmCoursesAndEnter() {
  if (!pendingSchedule?.weeks?.length) {
    setImportStatus('请先上传课表 PDF', 'error');
    return;
  }
  const groups = pendingSchedule.choiceGroups || [];
  const courseSelections = readCourseSelectionsFromDom();
  const missing = groups.filter((g) => !courseSelections[g.id]);
  if (missing.length) {
    const enterAnyway = await askIncompleteCourseConfirm(missing.length);
    if (!enterAnyway) return;
  }

  store = {
    className: '',
    courseSelections,
    schedule: pendingSchedule,
    importedAt: new Date().toISOString(),
  };
  saveStore(store);
  pendingSchedule = null;
  weekIndex = defaultWeekIndex(store.schedule.weeks);
  renderSchedule();
}

/**
 * 未选完时弹窗：进入课表 / 继续选择。
 * @param {number} missingCount 未选组数
 * @returns {Promise<boolean>} true=进入课表，false=继续选择
 */
function askIncompleteCourseConfirm(missingCount) {
  return new Promise((resolve) => {
    if (!els.courseConfirmDialog) {
      resolve(false);
      return;
    }
    if (els.courseConfirmMsg) {
      els.courseConfirmMsg.textContent = `还有 ${missingCount} 组未选择，是否进入课表？`;
    }

    const finish = (enter) => {
      els.btnCourseConfirmEnter?.removeEventListener('click', onEnter);
      els.btnCourseConfirmContinue?.removeEventListener('click', onContinue);
      els.courseConfirmDialog.removeEventListener('cancel', onCancel);
      if (els.courseConfirmDialog.open) els.courseConfirmDialog.close();
      resolve(enter);
    };
    const onEnter = () => finish(true);
    const onContinue = () => finish(false);
    const onCancel = (ev) => {
      ev.preventDefault();
      finish(false);
    };

    els.btnCourseConfirmEnter?.addEventListener('click', onEnter);
    els.btnCourseConfirmContinue?.addEventListener('click', onContinue);
    els.courseConfirmDialog.addEventListener('cancel', onCancel);
    els.courseConfirmDialog.showModal();
  });
}

/**
 * 注册 Service Worker（离线缓存页面与脚本）。
 * @returns {void}
 */
/**
 * 注册 Service Worker，并在有新版本时自动激活刷新。
 * @returns {void}
 */
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register(`./sw.js?v=${APP_VERSION}`, {
        updateViaCache: 'none',
      });
      reg.update().catch(() => {});
      if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (importing) return;
        window.location.reload();
      });
    } catch (err) {
      console.warn('SW register failed', err);
    }
  });
}

/**
 * 绑定文件选择：change + input，兼容部分安卓机型只触发其一。
 * @returns {void}
 */
function bindPdfInput() {
  if (!els.pdfInput) {
    setImportStatus('页面未就绪，请强制刷新后重试', 'error');
    return;
  }

  let lastToken = '';
  const onPick = async () => {
    const file = els.pdfInput.files?.[0];
    if (!file) return;
    const token = `${file.name}:${file.size}:${file.lastModified}`;
    if (token === lastToken && importing) return;
    lastToken = token;
    setImportStatus(`已选中：${file.name}，开始解析…`);
    await importPdf(file);
    window.setTimeout(() => {
      els.pdfInput.value = '';
      lastToken = '';
    }, 300);
  };

  els.pdfInput.addEventListener('change', onPick);
  els.pdfInput.addEventListener('input', onPick);
}

try {
  fillClassOptions(
    els.settingsClass,
    getScheduleClasses(store?.schedule).classOptions,
    store?.className || ''
  );

  bindPdfInput();

  els.btnConfirmClass?.addEventListener('click', () => {
    confirmClassAndEnter();
  });

  els.btnConfirmCourses?.addEventListener('click', () => {
    confirmCoursesAndEnter();
  });
} catch (err) {
  console.error(err);
  if (els.importStatus) {
    els.importStatus.textContent = `页面脚本异常：${err?.message || err}`;
    els.importStatus.className = 'status error';
  }
}

els.btnPrev.addEventListener('click', () => {
  if (weekIndex < 0) return;
  weekIndex -= 1;
  renderSchedule();
});
els.btnNext.addEventListener('click', () => {
  if (weekIndex < 0) return;
  weekIndex += 1;
  renderSchedule();
});
els.btnWeekPicker?.addEventListener('click', () => {
  openWeekPicker();
});
els.btnCloseWeekPicker?.addEventListener('click', () => {
  els.weekPickerDialog?.close();
});
els.weekPickerList?.addEventListener('click', (event) => {
  const btn = event.target.closest('.week-picker-option');
  if (!btn) return;
  const next = Number(btn.getAttribute('data-week'));
  weekIndex = Number.isNaN(next) ? 0 : next;
  els.weekPickerDialog?.close();
  renderSchedule();
});
els.weekPickerDialog?.addEventListener('click', (event) => {
  if (event.target === els.weekPickerDialog) els.weekPickerDialog.close();
});
els.btnToday.addEventListener('click', () => {
  // 本周 = 真实日历本周；落在课表内则打开对应周次，否则只显示真实周末日期
  weekIndex = currentWeekIndex(store.schedule.weeks);
  renderSchedule();
});

els.btnSettings.addEventListener('click', () => {
  const elective = isElectiveMode(store?.schedule);
  if (els.settingsClassBlock) els.settingsClassBlock.hidden = !!elective;
  if (els.settingsCourseBlock) els.settingsCourseBlock.hidden = !elective;
  if (elective) {
    // 设置里改选课：把当前课表当作 pending 源渲染分组
    const groups = store.schedule.choiceGroups || [];
    renderCourseGroupsInto(els.settingsCourseGroups, groups, store.courseSelections || {}, 'scg');
  } else {
    const { classOptions } = getScheduleClasses(store?.schedule);
    fillClassOptions(els.settingsClass, classOptions, store?.className || '');
  }
  els.settingsDialog.showModal();
});

els.btnCloseSettings.addEventListener('click', () => {
  els.settingsDialog.close();
});

els.btnSaveSettings.addEventListener('click', async () => {
  if (!store) return;
  if (isElectiveMode(store.schedule)) {
    /** @type {Record<string,string>} */
    const courseSelections = {};
    els.settingsCourseGroups?.querySelectorAll('.course-group').forEach((box) => {
      const gid = box.getAttribute('data-group');
      const checked = box.querySelector('input[type="radio"]:checked');
      if (gid && checked) courseSelections[gid] = checked.value;
    });
    const groups = store.schedule.choiceGroups || [];
    const missing = groups.filter((g) => !courseSelections[g.id]);
    if (missing.length) {
      const enterAnyway = await askIncompleteCourseConfirm(missing.length);
      if (!enterAnyway) return;
    }
    store.courseSelections = courseSelections;
  } else {
    store.className = els.settingsClass.value;
  }
  saveStore(store);
  els.settingsDialog.close();
  renderSchedule();
});

els.btnReimport.addEventListener('click', () => {
  els.settingsDialog.close();
  els.uploadLabel.textContent = '点此选择 PDF 文件';
  showImport('', { resetPending: true });
});

/**
 * 当前可分享的打开链接（本机访问地址）。
 * @returns {string}
 */
function getShareUrl() {
  return window.location.href.split('#')[0];
}

/**
 * 切换分享弹窗内「链接 / 二维码」面板。
 * @param {'link'|'qr'} tab 面板
 * @returns {void}
 */
function switchShareTab(tab) {
  const isLink = tab === 'link';
  els.tabLink.classList.toggle('active', isLink);
  els.tabQr.classList.toggle('active', !isLink);
  els.sharePaneLink.hidden = !isLink;
  els.sharePaneQr.hidden = isLink;
}

/**
 * 生成带应用标题的分享二维码图（有专业才带专业名）。
 * @param {string} url 分享链接
 * @returns {Promise<string>} PNG data URL
 */
async function buildShareQrDataUrl(url) {
  const qrDataUrl = await QRCode.toDataURL(url, {
    width: 280,
    margin: 2,
    color: { dark: '#0a3d2e', light: '#ffffff' },
  });

  const title = appBrandTitle();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const qrImg = await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = qrDataUrl;
  });

  const pad = 20;
  const titleH = 36;
  canvas.width = qrImg.width + pad * 2;
  canvas.height = qrImg.height + pad * 2 + titleH;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0a3d2e';
  ctx.font = 'bold 20px "Microsoft YaHei","PingFang SC",sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(title, canvas.width / 2, pad + titleH / 2);
  ctx.drawImage(qrImg, pad, pad + titleH);
  return canvas.toDataURL('image/png');
}

/**
 * 打开分享弹窗并生成链接与二维码。
 * @returns {Promise<void>}
 */
async function openShareDialog() {
  const url = getShareUrl();
  els.shareUrlInput.value = url;
  els.copyStatus.textContent = '';
  switchShareTab('link');

  try {
    const dataUrl = await buildShareQrDataUrl(url);
    els.shareQrImg.src = dataUrl;
    els.btnDownloadQr.href = dataUrl;
  } catch (err) {
    console.error(err);
    els.shareQrImg.removeAttribute('src');
    els.copyStatus.textContent = '二维码生成失败，请改用复制链接';
  }

  els.shareDialog.showModal();
}

els.btnShare.addEventListener('click', () => {
  openShareDialog();
});

els.btnCloseShare.addEventListener('click', () => {
  els.shareDialog.close();
});

els.tabLink.addEventListener('click', () => switchShareTab('link'));
els.tabQr.addEventListener('click', () => switchShareTab('qr'));

els.btnCopyLink.addEventListener('click', async () => {
  const url = els.shareUrlInput.value;
  const text = `${appBrandTitle()}\n${url}`;
  try {
    await navigator.clipboard.writeText(text);
    els.copyStatus.textContent = '已复制到剪贴板';
  } catch {
    els.shareUrlInput.select();
    els.copyStatus.textContent = '复制失败，请手动长按链接全选复制';
  }
});

applyBrandTitle();

(async () => {
  if (await migrateCachesIfNeeded()) return;

  if (store?.schedule?.weeks?.length) {
    const before = `${store.schedule.semester || ''}|${store.schedule.grade || ''}`;
    ensureScheduleMeta(store.schedule);
    const after = `${store.schedule.semester || ''}|${store.schedule.grade || ''}`;
    if (before !== after) saveStore(store);
    weekIndex = defaultWeekIndex(store.schedule.weeks);
    renderSchedule();
  } else {
    showImport();
  }

  registerSW();
})();
