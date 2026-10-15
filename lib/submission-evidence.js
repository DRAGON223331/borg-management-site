'use strict';

const MAX_TOTAL_BYTES = 9 * 1024 * 1024;
const MAX_FILES = 10;
const EXT_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
};

function text(value, max = 150) {
  return String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, max);
}

function getSiteBase() {
  const configured = process.env.SITE_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || 'https://borg-management-site.vercel.app';
  const value = String(configured).trim().replace(/\/$/, '');
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function parseFiles(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
  }
  return [];
}

function detectMediaType(buffer, fallback = '') {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'image/png';
  const head6 = buffer.subarray(0, 6).toString('latin1');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buffer.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('latin1');
    if (['avif', 'avis'].includes(brand)) return 'image/avif';
    if (['qt  '].includes(brand)) return 'video/quicktime';
    return 'video/mp4';
  }
  const mime = String(fallback || '').split(';')[0].trim().toLowerCase();
  return EXT_BY_MIME[mime] ? mime : null;
}

/**
 * Fetches private evidence through the website's token-protected evidence route,
 * so Discord button reviews attach the same files that website reviews attach.
 */
async function loadSubmissionEvidence(submission) {
  const attachments = [];
  const linkOnly = [];
  let total = 0;
  const files = parseFiles(submission?.files_json ?? submission?.filesJson);
  if (!files.length) return { attachments, linkOnly };

  const base = getSiteBase();
  for (const file of files) {
    const token = text(file?.token, 160);
    if (!token) continue;
    const link = `${base}/api/evidence?token=${encodeURIComponent(token)}`;
    const label = `• ${text(file?.originalName || 'ملف مرفوع', 100)}: ${link}`;
    if (attachments.length >= MAX_FILES || total + Number(file?.size || 0) > MAX_TOTAL_BYTES) {
      linkOnly.push(label);
      continue;
    }
    try {
      const response = await fetch(link, { signal: AbortSignal.timeout(7000) });
      if (!response.ok) throw new Error(`evidence HTTP ${response.status}`);
      const fallbackType = response.headers.get('content-type') || file?.mimeType || '';
      const data = Buffer.from(await response.arrayBuffer());
      const type = detectMediaType(data, fallbackType);
      if (!type) {
        linkOnly.push(`• ${text(file?.originalName || 'ملف مرفوع', 100)}: تعذّر إرفاقه كصورة أو فيديو — ${link}`);
        continue;
      }
      if (total + data.length > MAX_TOTAL_BYTES) {
        linkOnly.push(label);
        continue;
      }
      total += data.length;
      attachments.push({ name: `evidence-${attachments.length + 1}.${EXT_BY_MIME[type] || 'bin'}`, type, data });
    } catch (error) {
      console.warn('[submission evidence fetch]', text(error?.message || error, 160));
      linkOnly.push(label);
    }
  }
  return { attachments, linkOnly };
}

function appendEvidenceLinks(content, linkOnly) {
  const links = Array.isArray(linkOnly) ? linkOnly : [];
  return (links.length ? `${String(content || '')}\n\n📎 **مرفقات كبيرة:**\n${links.join('\n')}` : String(content || '')).slice(0, 1990);
}

module.exports = { loadSubmissionEvidence, appendEvidenceLinks, getSiteBase };
