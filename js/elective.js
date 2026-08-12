/**
 * 选修课表（N 选 1）解析与匹配辅助。
 * <p>新版 PDF：同一时段并排多门课 +「四选一/二选一」；用户每组只选 1 门后生成个人课表。</p>
 * <p>与按班级左右列的旧版通过 {@code schedule.mode} 区分。</p>
 *
 * @see parseSchedulePdf
 */

import { isHolidayOrNoteText } from './holiday-note.js';

/**
 * 选项是否为可展示的正常课（排除空格与节假日备注）。
 * @param {object|null|undefined} o 选项单元格
 * @returns {boolean}
 */
function isValidCourseOption(o) {
  if (!o || o.isEmpty || o.isNote) return false;
  if (isHolidayOrNoteText(o.course) || isHolidayOrNoteText(o.raw)) return false;
  return true;
}
/**
 * 根据全文与表头判断课表模式。
 * @param {string} allText 各页文本拼接
 * @param {{str:string,x:number}[]} headerClassItems 表头班级名片段（已带 x）
 * @returns {'class'|'elective'}
 */
export function detectScheduleMode(allText, headerClassItems) {
  if (/[一二三四五六七八九十\d]+选[一二三四五六七八九十\d]+/.test(allText || '')) {
    return 'elective';
  }
  // 表头班级挤在很窄的横向范围 → 全班同一套课，按选课而非按班分列
  const xs = (headerClassItems || []).map((h) => h.x);
  if (xs.length >= 4) {
    const span = Math.max(...xs) - Math.min(...xs);
    if (span < 150) return 'elective';
  }
  return 'class';
}

/**
 * 选项唯一键：按课程名（同课多名老师只选一次）。
 * @param {{course?:string,teacher?:string}} cell 单元格
 * @returns {string}
 */
export function optionKey(cell) {
  return (cell?.course || '').trim();
}

/**
 * 合并老师名（去重，用「 / 」连接，便于一次展示多名老师）。
 * @param {string} a 已有
 * @param {string} b 新增
 * @returns {string}
 */
function mergeTeacherNames(a, b) {
  const set = new Set();
  for (const part of `${a || ''}/${b || ''}`.split(/[/、,，|]/)) {
    const t = part.trim();
    if (t) set.add(t);
  }
  const list = [...set];
  // 去掉被更全姓名包含的短名（如「刘灵」相对「刘灵辉」）
  return list
    .filter((name) => !list.some((other) => other !== name && other.includes(name)))
    .join(' / ');
}

/**
 * 是否像一门课的标题开头（而非地点/标点/老师碎片）。
 * @param {string} str 文本碎片
 * @param {string} [prev] 前一个碎片
 * @returns {boolean}
 */
function isCourseStart(str, prev = '') {
  const t = (str || '').replace(/\s+/g, '');
  const p = (prev || '').replace(/\s+/g, '');
  if (!t) return false;
  if (/^[（）()\d\-－：:./]+$/.test(t)) return false;
  if (/^[-－]/.test(t) || /^（/.test(t)) return false;
  if (/^(沙河|清水河|二教|三教|四教|教室)/.test(t)) return false;
  if (/^\d{2,4}$/.test(t)) return false;
  // 「-」后的短串几乎都是老师名
  if (/[-－]$/.test(p) && t.length <= 4) return false;
  // 老师名通常 2～3 字；课程名更长或含学科关键词
  if (
    t.length <= 3 &&
    !/(学|论|治理|分析|写作|方法|专题|行为|数据|政策|组织|考试)/.test(t)
  ) {
    return false;
  }
  return /[\u4e00-\u9fffA-Za-z]{2,}/.test(t);
}

/**
 * 将同行正文区文本裂成多门课。
 * <p>以课程标题碎片为锚点切片，把后续的「-老师」「（地点）」收进同一门。</p>
 *
 * @param {{str:string,x:number}[]} parts 一行内正文区片段
 * @returns {string[]} 每门课原始串
 */
export function splitBodyCourseRaw(parts) {
  const sorted = (parts || []).slice().sort((a, b) => a.x - b.x);
  if (!sorted.length) return [];

  /** @type {number[]} */
  const starts = [];
  for (let i = 0; i < sorted.length; i++) {
    const prev = i > 0 ? sorted[i - 1].str : '';
    if (isCourseStart(sorted[i].str, prev)) starts.push(i);
  }

  if (!starts.length) {
    // 可能是纯地点续行：按多个「（地点）」拆开，便于按列合并
    const blob = sorted
      .map((p) => p.str)
      .join('')
      .replace(/\s+/g, '');
    if (!blob) return [];
    const locs = blob.match(/（[^）]+）/g);
    if (locs && locs.length > 1) return locs;
    return [blob];
  }

  /** @type {string[]} */
  const raws = [];
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s];
    const to = s + 1 < starts.length ? starts[s + 1] : sorted.length;
    raws.push(
      sorted
        .slice(from, to)
        .map((p) => p.str)
        .join('')
        .replace(/\s+/g, '')
    );
  }
  return raws;
}

/**
 * 课程集合签名（仅用于判断是否同一选课组，与展示顺序无关）。
 * @param {{course?:string}[]} opts 选项
 * @returns {string}
 */
function courseSetKey(opts) {
  return (opts || [])
    .map((o) => (o.course || '').trim())
    .filter(Boolean)
    .slice()
    .sort()
    .join('|');
}

/**
 * 中文数字（选课标注用）转整数。
 * @param {string} cn 如「四」「二」「10」
 * @returns {number}
 */
function cnPickNumber(cn) {
  const t = String(cn || '').trim();
  if (/^\d+$/.test(t)) return Number(t);
  const map = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  return map[t] || 0;
}

/**
 * 时段文案，如「周六 1-4节」。
 * @param {string} weekday 周六/周日
 * @param {string} periodKey 如 1-4
 * @returns {string}
 */
function slotWhenLabel(weekday, periodKey) {
  const period = periodKey ? `${periodKey}节` : '';
  return [weekday || '', period].filter(Boolean).join(' ');
}

/**
 * 从 PDF 右侧课程目录解析选课组（优先顺序来源）。
 * <p>右侧「课程名 + 老师」按从上到下排列，「四选一/二选一」标注夹在组内；
 * 遇到标注后凑满 N 门即成一组。</p>
 *
 * @param {{str:string,x:number,y:number}[]} items 首页（或全文）文本项
 * @param {number} [sideMinX=560] 右侧栏最小横坐标
 * @returns {{label:string,pick:number,options:{course:string,teacher:string,key:string}[]}[]}
 */
export function parseSideChoiceGroups(items, sideMinX = 560) {
  const side = (items || []).filter((it) => (it.x ?? 0) >= sideMinX && (it.str || '').trim());
  if (side.length < 4) return [];

  side.sort((a, b) => b.y - a.y || a.x - b.x);
  /** @type {{y:number,parts:{str:string,x:number}[],text:string}[]} */
  const lines = [];
  /** @type {{str:string,x:number}[]} */
  let buf = [];
  let lastY = null;
  for (const it of side) {
    if (lastY != null && Math.abs(lastY - it.y) > 3.5) {
      lines.push({
        y: lastY,
        parts: buf.slice(),
        text: buf
          .map((p) => p.str)
          .join('')
          .replace(/\s+/g, ''),
      });
      buf = [];
    }
    buf.push({ str: it.str, x: it.x });
    lastY = it.y;
  }
  if (buf.length) {
    lines.push({
      y: lastY,
      parts: buf.slice(),
      text: buf
        .map((p) => p.str)
        .join('')
        .replace(/\s+/g, ''),
    });
  }

  const PICK_RE = /^([一二三四五六七八九十\d]+)选([一二三四五六七八九十\d]+)$/;
  /** @type {{course:string,teacher:string,key:string}[]} */
  let pendingCourses = [];
  let need = 0;
  let label = '';
  /** @type {{label:string,pick:number,options:{course:string,teacher:string,key:string}[]}[]} */
  const groups = [];

  /**
   * 若已凑满 need 门，冲刷为一组。
   * @returns {void}
   */
  function flushIfReady() {
    if (need <= 0 || pendingCourses.length < need) return;
    const options = pendingCourses.splice(0, need);
    groups.push({
      label: label || `${options.length}选1`,
      pick: 1,
      options,
    });
    need = 0;
    label = '';
  }

  for (const line of lines) {
    const pickMatch = line.text.match(PICK_RE);
    if (pickMatch) {
      need = cnPickNumber(pickMatch[1]);
      label = line.text;
      flushIfReady();
      continue;
    }

    const parts = line.parts.slice().sort((a, b) => a.x - b.x);
    const courseParts = parts.filter((p) => p.x < 700);
    const teacherParts = parts.filter((p) => p.x >= 700);
    const course = courseParts
      .map((p) => p.str)
      .join('')
      .replace(/\s+/g, '')
      .trim();
    if (!course || course.length < 2) continue;
    if (/^周次|日期|时间|第.+周$/.test(course)) continue;

    const teacher = teacherParts
      .map((p) => p.str.trim())
      .filter(Boolean)
      .join(' / ');

    pendingCourses.push({
      course,
      teacher,
      key: course,
    });
    flushIfReady();
  }

  // 尾部兜底：剩余 ≥2 门且无标注时，视为一组
  if (pendingCourses.length >= 2 && groups.length === 0) {
    groups.push({
      label: `${pendingCourses.length}选1`,
      pick: 1,
      options: pendingCourses.splice(0),
    });
  }

  return groups.filter((g) => g.options.length >= 2);
}

/**
 * 仅按课表时段归纳选课组（无右侧目录时的兜底）。
 * @param {object[]} weeks 周列表
 * @returns {object[]}
 */
function buildChoiceGroupsFromSchedule(weeks) {
  /** @type {Map<string,{id:string,label:string,when:string,pick:number,appearOrder:number,options:object[]}>} */
  const map = new Map();
  /** @type {string[]} */
  const orderKeys = [];
  let seq = 0;
  const periodRank = { '1-4': 1, '5-8': 2, '9-11': 3 };

  const weekList = [...(weeks || [])].sort(
    (a, b) => (a.weekIndex || 0) - (b.weekIndex || 0)
  );

  for (const week of weekList) {
    const daySpecs = [
      { day: week.saturday, weekday: '周六' },
      { day: week.sunday, weekday: '周日' },
    ];
    for (const { day, weekday } of daySpecs) {
      if (!day?.slots) continue;
      const slots = [...(day.slots || [])].sort(
        (a, b) => (periodRank[a.key] || 9) - (periodRank[b.key] || 9)
      );
      for (const slot of slots) {
        const opts = (slot.options || []).filter(isValidCourseOption);
        if (opts.length < 2) {
          slot.choiceGroupId = null;
          continue;
        }
        const setKey = courseSetKey(opts);
        if (!setKey) {
          slot.choiceGroupId = null;
          continue;
        }

        const when = slotWhenLabel(weekday || day.weekday, slot.key);

        if (!map.has(setKey)) {
          seq += 1;
          orderKeys.push(setKey);
          map.set(setKey, {
            id: `g${seq}`,
            label: `${opts.length}选1`,
            when,
            pick: 1,
            appearOrder: seq,
            options: opts.map((o) => ({
              key: optionKey(o),
              course: (o.course || '').trim(),
              teacher: (o.teacher || '').trim(),
            })),
          });
        } else {
          const group = map.get(setKey);
          for (const o of opts) {
            const course = (o.course || '').trim();
            if (!course) continue;
            const hit = group.options.find((x) => x.course === course);
            if (hit) {
              hit.teacher = mergeTeacherNames(hit.teacher, o.teacher || '');
              hit.key = course;
            } else {
              group.options.push({
                key: course,
                course,
                teacher: (o.teacher || '').trim(),
              });
              group.label = `${group.options.length}选1`;
            }
          }
        }
        slot.choiceGroupId = map.get(setKey).id;
      }
    }
  }

  return orderKeys.map((k) => map.get(k));
}

/**
 * 把周数据中的时段挂到已有选课组（按课程集合匹配），并合并老师名。
 * @param {object[]} weeks 周列表
 * @param {object[]} groups 已确定顺序的选课组
 * @returns {void}
 */
function linkSlotsToChoiceGroups(weeks, groups) {
  /** @type {Map<string,object>} */
  const byKey = new Map();
  for (const g of groups || []) {
    byKey.set(courseSetKey(g.options), g);
  }

  for (const week of weeks || []) {
    for (const day of [week.saturday, week.sunday]) {
      for (const slot of day?.slots || []) {
        const opts = (slot.options || []).filter(isValidCourseOption);
        if (opts.length < 2) {
          slot.choiceGroupId = null;
          continue;
        }
        const setKey = courseSetKey(opts);
        const group = byKey.get(setKey);
        if (!group) {
          slot.choiceGroupId = null;
          continue;
        }
        slot.choiceGroupId = group.id;
        for (const o of opts) {
          const course = (o.course || '').trim();
          if (!course) continue;
          const hit = group.options.find((x) => x.course === course);
          if (hit) {
            hit.teacher = mergeTeacherNames(hit.teacher, o.teacher || '');
            hit.key = course;
          }
        }
      }
    }
  }
}

/**
 * 汇总选课组：优先 PDF 右侧课程目录顺序；无右侧目录时按课表时段归纳。
 *
 * @param {object[]} weeks 已填 options 的周列表
 * @param {{label:string,pick:number,options:{course:string,teacher:string,key:string}[]}[]} [sideGroups] 右侧目录解析结果
 * @returns {{id:string,label:string,when:string,pick:number,appearOrder:number,options:{key:string,course:string,teacher:string}[]}[]}
 */
export function buildChoiceGroups(weeks, sideGroups = []) {
  if (sideGroups?.length) {
    const groups = sideGroups.map((sg, i) => ({
      id: `g${i + 1}`,
      label: sg.label || `${(sg.options || []).length}选1`,
      when: '',
      pick: sg.pick || 1,
      appearOrder: i + 1,
      options: (sg.options || []).map((o) => ({
        key: o.key || o.course,
        course: (o.course || '').trim(),
        teacher: (o.teacher || '').trim(),
      })),
    }));
    linkSlotsToChoiceGroups(weeks, groups);
    return groups;
  }
  return buildChoiceGroupsFromSchedule(weeks);
}

/**
 * 按用户选择解析某时段应展示的单元格。
 * <p>无选课组：取第一门有效课；有选课组：按选项键匹配，否则按课程名回退。</p>
 *
 * @param {object} slot 时段（含 options / choiceGroupId）
 * @param {Record<string,string>} [selections] groupId → optionKey
 * @returns {object} 课程单元格（可能 isEmpty）
 */
export function resolveElectiveSlot(slot, selections = {}) {
  const empty = {
    raw: '',
    course: '',
    teacher: '',
    location: '',
    isEmpty: true,
    isNote: false,
  };
  const opts = slot?.options || [];
  if (!opts.length) return empty;

  const valid = opts.filter(isValidCourseOption);
  const notes = opts.filter(
    (o) => o && (o.isNote || isHolidayOrNoteText(o.course) || isHolidayOrNoteText(o.raw))
  );
  if (!valid.length) {
    return notes[0] || empty;
  }

  const gid = slot.choiceGroupId;
  if (!gid) {
    return valid[0];
  }

  const picked = selections?.[gid] || '';
  if (picked) {
    const byKey = valid.find((o) => optionKey(o) === picked);
    if (byKey) return byKey;
    const byCourse = valid.find((o) => (o.course || '').trim() === picked);
    if (byCourse) return byCourse;
    const courseName = String(picked).split('|')[0];
    const byLegacy = valid.find((o) => (o.course || '').trim() === courseName);
    if (byLegacy) return byLegacy;
  }

  // 尚未选择：占位，便于界面提示
  return {
    raw: '',
    course: '请先完成选课',
    teacher: '',
    location: '',
    isEmpty: false,
    isNote: true,
    needsPick: true,
  };
}

/**
 * 选修模式下该周是否无课（已选课视角）。
 * @param {object} week 周
 * @param {Record<string,string>} selections 选课结果
 * @returns {boolean}
 */
export function isElectiveWeekEmpty(week, selections) {
  for (const day of [week?.saturday, week?.sunday]) {
    for (const slot of day?.slots || []) {
      const cell = resolveElectiveSlot(slot, selections);
      if (cell.needsPick) return false;
      if (!cell.isEmpty && !cell.isNote) {
        if (isHolidayOrNoteText(cell.course) || isHolidayOrNoteText(cell.raw)) continue;
        const has =
          (cell.course || '').trim() ||
          (cell.teacher || '').trim() ||
          (cell.location || '').trim();
        if (has) return false;
      }
    }
  }
  return true;
}
