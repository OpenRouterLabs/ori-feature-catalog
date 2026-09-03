const RECENT_STARTS = 512;

export const claimStart = (): ((ts: string | undefined) => boolean) => {
  const seen = new Set<string>();
  return (ts) => {
    if (ts === undefined || seen.has(ts)) {
      return false;
    }
    seen.add(ts);
    while (seen.size > RECENT_STARTS) {
      const oldest = seen.values().next().value;
      if (oldest === undefined) {
        break;
      }
      seen.delete(oldest);
    }
    return true;
  };
};
