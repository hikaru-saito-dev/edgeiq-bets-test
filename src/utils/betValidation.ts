/**
 * Utility functions for bet validation and anti-tamper checks
 */

/**
 * Check if a bet can be edited based on its lock status and start time
 */
export function canEditBet(startTime: Date, locked: boolean): {
  canEdit: boolean;
  reason?: string;
} {
  const now = new Date();
  const eventStartTime = new Date(startTime);

  // Check if bet is already locked
  if (locked) {
    return {
      canEdit: false,
      reason: 'Bet is locked. Event has already started.',
    };
  }
 
  // Check if current time has passed start time
  if (now >= eventStartTime) {
    return {
      canEdit: false,
      reason: 'Cannot edit bet after event start time.',
    };
  }

  return { canEdit: true };
}

/**
 * Validate bet creation data
 */
export function validateBetCreation(data: {
  eventName: string;
  startTime: Date | string;
  odds: number;
  units: number;
}): { valid: boolean; error?: string } {
  const now = new Date();
  const startTime = new Date(data.startTime);

  // Check start time is in the future
  if (startTime <= now) {
    return {
      valid: false,
      error: 'Start time must be in the future',
    };
  }

  // Check odds
  if (data.odds < 1.01) {
    return {
      valid: false,
      error: 'Odds must be at least 1.01',
    };
  }

  // Check units
  if (data.units < 0.01) {
    return {
      valid: false,
      error: 'Units must be at least 0.01',
    };
  }

  // Check event name
  if (!data.eventName || data.eventName.trim().length === 0) {
    return {
      valid: false,
      error: 'Event name is required',
    };
  }

  return { valid: true };
}

/**
 * Calculate bet metrics
 */
export function calculateBetMetrics(odds: number, units: number) {
  const potentialWin = units * (odds - 1);
  const totalReturn = units * odds;
  const risk = units;

  return {
    potentialWin: Math.round(potentialWin * 100) / 100,
    totalReturn: Math.round(totalReturn * 100) / 100,
    risk: Math.round(risk * 100) / 100,
    roi: odds > 0 ? Math.round((potentialWin / risk) * 10000) / 100 : 0,
  };
}

