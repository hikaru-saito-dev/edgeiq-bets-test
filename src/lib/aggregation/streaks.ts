export const aggregationStreakFunction = function (
  bets: Array<{ result?: string; createdAt?: Date | string; updatedAt?: Date | string }>
) {
  if (!Array.isArray(bets) || bets.length === 0) {
    return { current: 0, longest: 0 };
  }

  const normalized: Array<{ result?: string; date: Date }> = [];
  for (const bet of bets) {
    if (!bet) continue;
    const timestamp = (bet.createdAt as Date | string | undefined) ?? (bet.updatedAt as Date | string | undefined);
    if (!timestamp) continue;
    const parsedDate = new Date(timestamp);
    if (Number.isNaN(parsedDate.getTime())) continue;
    normalized.push({ result: bet.result, date: parsedDate });
  }

  if (normalized.length === 0) {
    return { current: 0, longest: 0 };
  }

  // Sort by date (oldest first) to calculate streaks chronologically
  normalized.sort((a, b) => a.date.getTime() - b.date.getTime());

  // Calculate current streak from most recent bet
  // For current streak, we need to look from the end (most recent)
  const reversed = [...normalized].reverse();
  let current = 0;
  const mostRecentResult = reversed[0]?.result;
  
  if (mostRecentResult === 'win' || mostRecentResult === 'loss') {
    let streakCount = 0;
    for (const entry of reversed) {
      if (entry.result === mostRecentResult) {
        streakCount += 1;
      } else if (entry.result === 'push' || entry.result === 'void') {
        // Push and void don't break or extend streaks - continue
        continue;
      } else {
        // Different actionable result breaks the streak
        break;
      }
    }
    current = mostRecentResult === 'win' ? streakCount : -streakCount;
  }

  // Calculate longest streak (chronologically from oldest to newest)
  let maxWin = 0;
  let maxLoss = 0;
  let winStreak = 0;
  let lossStreak = 0;

  for (const entry of normalized) {
    const result = entry.result;
    if (result === 'win') {
      winStreak += 1;
      lossStreak = 0;
      if (winStreak > maxWin) {
        maxWin = winStreak;
      }
    } else if (result === 'loss') {
      lossStreak += 1;
      winStreak = 0;
      if (lossStreak > maxLoss) {
        maxLoss = lossStreak;
      }
    } else if (result === 'push' || result === 'void') {
      // Push and void don't break or extend streaks - continue counting
      continue;
    } else {
      // Unknown result resets streaks
      winStreak = 0;
      lossStreak = 0;
    }
  }

  let longest = 0;
  if (maxWin > maxLoss) {
    longest = maxWin;
  } else if (maxLoss > maxWin) {
    longest = -maxLoss;
  } else if (maxWin > 0) {
    longest = maxWin;
  } else if (maxLoss > 0) {
    longest = -maxLoss;
  }

  return { current, longest };
};

