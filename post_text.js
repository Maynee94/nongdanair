// Giữ nguyên URL, email, số thập phân và dấu chấm trong chữ viết tắt.
function cleanPostPunctuation(text) {
  const protectedParts = [];
  let out = String(text || '').replace(/https?:\/\/[^\s<>]+|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b\d+(?:\.\d+)+\b|\b(?:[A-Za-z]\.){2,}/gi, value => {
    // Dấu chấm cuối URL thường là dấu câu, không thuộc đường dẫn.
    const clean = /^(?:[A-Za-z]\.){2,}$/.test(value) ? value : value.replace(/\.$/, '');
    protectedParts.push(clean);
    return `\uE000${protectedParts.length - 1}\uE001`;
  });
  out = out.replace(/[ \t]*—[ \t]*/g, ', ')
    .replace(/(?<!\.)\.(?!\.)(?=[ \t]+|\n|$|[”"’'])/g, '')
    .replace(/\uE000(\d+)\uE001/g, (_, index) => protectedParts[Number(index)]);
  return out.trim();
}
