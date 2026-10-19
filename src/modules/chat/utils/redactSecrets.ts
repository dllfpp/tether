/**
 * CloudCLI live: hides passwords and tokens in the shell commands (and their
 * output) shown in the chat, so a screen or a screenshot never shows them.
 * Display only: what was run, and the transcript on disk, are unchanged.
 */
export const REDACTED = '*password redacted*';

// Each pattern keeps its first group (the option or key) and replaces the rest.
const PATTERNS: RegExp[] = [
  // sshpass -p 'secret' / -p "secret" / -p secret
  /(\bsshpass\s+-p\s*)(?:'[^']*'|"[^"]*"|\S+)/g,
  // --password=secret, --password secret, --passwd ...
  /(--pass(?:word|wd)?(?:=|\s+))(?:'[^']*'|"[^"]*"|\S+)/gi,
  // password=secret, PASSWORD="secret", pass: secret, "password": "secret" (also *_PASS, *_TOKEN, *_SECRET)
  /((?:\b[A-Za-z_]*(?:pass(?:word|wd)?|secret|token|api[_-]?key))["']?\s*[:=]\s*)(?:'[^']*'|"[^"]*"|[^\s,;&|)}]+)/gi,
  // Authorization: Bearer <token>, Basic <...>
  /(\b(?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]{8,}/g,
  // user:password@ in URLs
  /(:\/\/[^\s/:@]+:)[^\s@/]+(?=@)/g,
  // curl -u user:password
  /(\s-u\s+['"]?[^\s:'"]+:)[^\s'"]+/g,
  // Well-known key shapes, wherever they appear
  /()\b(?:sk-ant-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
];

export function redactSecrets(text: string): string {
  if (!text) return text;
  // A neutral marker while the patterns run, so one pattern does not match
  // the placeholder another one just wrote ("--password=*password ...").
  const MARK = '\u0000';
  let result = text;
  for (const pattern of PATTERNS) {
    result = result.replace(pattern, (_match, keep: string) => `${keep ?? ''}${MARK}`);
  }
  return result.split(MARK).join(REDACTED);
}
