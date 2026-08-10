export const UPDATE_POLICY_URL = "/api/media/version";

function versionParts(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(value || "").trim());
  return match ? match.slice(1).map(Number) : null;
}

export function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function updateStatus(currentVersion, policy) {
  const latestVersion = String(policy?.latestVersion || "");
  const minimumVersion = String(policy?.minimumVersion || "");
  const belowMinimum = compareVersions(currentVersion, minimumVersion);
  const belowLatest = compareVersions(currentVersion, latestVersion);
  if (belowMinimum === null || belowLatest === null) return null;
  if (belowMinimum < 0) return "required";
  if (belowLatest < 0) return "available";
  return "current";
}
