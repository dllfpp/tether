import fs from 'node:fs';
import path from 'node:path';

/**
 * Used by the system module before running the built-in update: an install of
 * CloudCLI live (its package.json carries a `cloudcliLive` block) must not run
 * it. The command would install the original CloudCLI elsewhere, leave this
 * copy unchanged and still report success; a new original release has to be
 * merged into the fork instead.
 */
export function isLiveForkInstall(appRoot: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')) as { cloudcliLive?: unknown };
    return Boolean(pkg.cloudcliLive);
  } catch {
    return false;
  }
}
