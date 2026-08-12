/**
 * 课表单元格中的节假日/调班备注识别。
 * <p>PDF 格内常单独写「元旦」「国庆休」等，不得当作正常课程展示。</p>
 */

/**
 * 是否为节假日/调班等非课程备注（不当作正常课展示）。
 * <p>覆盖「元旦」「国庆休」「中秋假」等 PDF 格内短备注，以及带「放假/调休/预估」的说明。</p>
 *
 * @param {string} text 单元格正文、课程名或原始串；来自 PDF 格或已存 {@code cell.course}
 * @returns {boolean} true 表示节假日/备注，界面应按无课处理
 */
export function isHolidayOrNoteText(text) {
  const t = (text || '').replace(/\s+/g, '').trim();
  if (!t) return false;
  // 常见法定/校历节日名（可单独出现，或带休/假/班）
  if (
    /元旦|春节|除夕|清明|劳动节|五一|端午|中秋|国庆|圣诞|寒假|暑假|妇女节|儿童节/.test(
      t
    )
  ) {
    return true;
  }
  if (/放假|休假|预估|调休/.test(t)) return true;
  if (/休$/.test(t) || /补班$/.test(t)) return true;
  return false;
}
