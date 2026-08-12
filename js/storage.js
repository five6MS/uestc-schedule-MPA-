/**
 * 本地课表持久化（localStorage）。
 * <p>保存解析后的课表、班级模式所选班级、或选修模式的选课结果。</p>
 */

const STORAGE_KEY = 'schedule-pwa-v1';
/** 旧版存储键，读取时自动迁移 */
const LEGACY_STORAGE_KEY = 'weekend-schedule-pwa-v1';

/**
 * 读取本机已保存课表。
 * @returns {{className?:string,courseSelections?:Record<string,string>,schedule:object,importedAt:string}|null}
 */
export function loadStore() {
  try {
    let raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      raw = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (raw) {
        localStorage.setItem(STORAGE_KEY, raw);
        localStorage.removeItem(LEGACY_STORAGE_KEY);
      }
    }
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * 写入本机课表（覆盖旧数据）。
 * @param {{className?:string,courseSelections?:Record<string,string>,schedule:object,importedAt?:string}} data
 * @returns {void}
 */
export function saveStore(data) {
  const payload = {
    className: data.className || '',
    courseSelections: data.courseSelections || {},
    schedule: data.schedule,
    importedAt: data.importedAt || new Date().toISOString(),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  localStorage.removeItem(LEGACY_STORAGE_KEY);
}

/**
 * 清空本机课表。
 * @returns {void}
 */
export function clearStore() {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(LEGACY_STORAGE_KEY);
}
