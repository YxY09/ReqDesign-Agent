/**
 * Extract "salient anchor" tokens from a source span that the design MUST
 * preserve verbatim. These deterministic markers are intentionally narrow:
 * numeric/unit parameters, algorithm names, file extensions, and short domain
 * phrases that are easy for generated designs to accidentally generalize away.
 */
export function extractSalientAnchors(sourceText: string): string[] {
  if (!sourceText) return [];
  const anchors = new Set<string>();
  const push = (raw: string) => {
    const t = raw.trim();
    if (t) anchors.add(t);
  };

  const numUnitRe = /\b\d{1,5}\s*[- ]?(?:bit|byte|bytes|ms|s|seconds?|秒|分钟|小时|MB|KB|GB|位|字符|个|次|QPS|RPS)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = numUnitRe.exec(sourceText)) !== null) push(m[0]);

  const cjkNumUnitRe = /\d{1,5}\s*[秒位个次字符分钟小时天]/g;
  while ((m = cjkNumUnitRe.exec(sourceText)) !== null) push(m[0]);

  const algoNames = [
    "AES/Rijndael", "AES-256", "AES-128", "AES",
    "Twofish", "Rijndael",
    "ARC4", "RC4",
    "PBKDF2", "Argon2", "Argon2id", "bcrypt", "scrypt",
    "SHA-256", "SHA-512", "SHA-1", "SHA256", "SHA512",
    "HMAC", "ECDSA", "RSA", "ChaCha20", "Poly1305", "Salsa20",
    "OAuth2", "OAuth 2.0", "OIDC", "JWT",
    "TLS 1.2", "TLS 1.3", "TLS",
  ];
  for (const name of algoNames) {
    if (sourceText.includes(name)) push(name);
  }

  const extRe = /\.[a-z]{2,6}(?=[\s.,;:!?)"'\]]|$)/gi;
  while ((m = extRe.exec(sourceText)) !== null) {
    const ext = m[0];
    if (/^\.(?:com|org|net|gov|edu|io|cn)$/i.test(ext)) continue;
    push(ext);
  }

  const keyPhrases = [
    /Master Password/gi,
    /Master Key/gi,
    /Composite Master Key/gi,
    /Global Hot Key/gi,
    /single[ -]instance/gi,
    /no length limit/gi,
    /no recovery/gi,
    /no back[ -]?door/gi,
    /主密码/g,
    /主密钥/g,
    /单实例/g,
    /无恢复/g,
    /无后门/g,
    /无长度限制/g,
  ];
  for (const re of keyPhrases) {
    while ((m = re.exec(sourceText)) !== null) push(m[0]);
  }

  return [...anchors];
}

/**
 * Loose verbatim check: does `haystack` contain `anchor` as a substring,
 * ignoring case for ASCII and accepting common hyphen/space variations?
 */
export function textIncludesAnchor(haystack: string, anchor: string): boolean {
  if (!anchor) return true;
  if (!haystack) return false;
  if (/[\u4e00-\u9fff]/.test(anchor)) {
    return haystack.includes(anchor);
  }
  const norm = (s: string) =>
    s.toLowerCase().replace(/[-\s]+/g, " ").replace(/\s+/g, " ").trim();
  return norm(haystack).includes(norm(anchor));
}
