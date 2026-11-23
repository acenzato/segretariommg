// Ricostruzione delle righe di testo dalle pagine PDF.
"use strict";

function textContentToLines(textContent) {
  const items = (textContent?.items || [])
    .filter(item => typeof item?.str === "string" && item.str.trim());

  if (!items.length) return "";

  // Content-stream order is not reading order: group baselines first.
  const rows = [];
  for (const item of items.slice().sort((a,b) => b.transform[5]-a.transform[5])) {
    const y = Number(item.transform[5]);
    let row = rows.find(r => Math.abs(r.y-y) <= 2.5);
    if (!row) { row = {y, items:[]}; rows.push(row); }
    row.items.push(item);
  }
  return rows.map(row => {
    const ordered = row.items.sort((a,b) => a.transform[4]-b.transform[4]);
    let text = '', right = null;
    for (const item of ordered) {
      const x = Number(item.transform[4]);
      const gap = right === null ? 0 : x-right;
      text += (right === null ? '' : gap > 12 ? '\t' : ' ') + item.str.trim();
      right = x + Number(item.width || 0);
    }
    return text.trim();
  }).filter(Boolean).join('\n');
}

module.exports = {
  textContentToLines,
};
