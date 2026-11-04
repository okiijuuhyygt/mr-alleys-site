// csv.js — 名單匯出。開頭加 BOM，Excel／Numbers 打開中文不會變亂碼。
// 擋 CSV injection：= + - @ 開頭的欄位前面補一個 '，避免被試算表當公式執行。

function cell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** @param {string[]} columns @param {Record<string, unknown>[]} rows */
export function toCsv(columns, rows) {
  const lines = [columns.join(',')];
  for (const r of rows) lines.push(columns.map((c) => cell(r[c])).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}
