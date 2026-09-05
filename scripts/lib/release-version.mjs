/**
 * IronCrew restarted its public version line at 0.1.0 after the inherited 2.8.0.
 * Only that exact legacy release may cross to stable 0.1.x. All other ordering
 * remains SemVer; the retired tag must never become an upgrade target again.
 * Return null when the caller should use its normal version comparator.
 */
export function releaseVersionOrderOverride(target, current) {
  const to = target.replace(/^v/, "");
  const from = current.replace(/^v/, "");
  if (to === "2.8.0" && from !== to) return -1;
  if (from === "2.8.0" && /^0\.1\.(0|[1-9]\d*)$/.test(to)) return 1;
  return null;
}
