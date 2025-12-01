/**
 * Bet Validation Utilities (SportsGameOdds edition)
 * Validates bets against live SportsGameOdds data to prevent tampering
 */

import type { Event } from 'sports-odds-api/resources/events';

import { getSportsGameOddsClient } from '@/lib/sportsGameOdds';
import { americanToDecimal } from '@/utils/oddsConverter';

const TOLERANCE = 0.05; // 5% tolerance
const EVENT_CACHE_TTL_MS = 15_000;

const client = getSportsGameOddsClient();
const eventCache = new Map<string, { event: Event; fetchedAt: number }>();

export interface ValidationResult {
  valid: boolean;
  error?: string;
  warning?: string;
}

type MoneylineSide = 'home' | 'away';

const YES_NO_PROP_STATS = new Set([
  'anytime td scorer',
  'anytime touchdown scorer',
  'first touchdown scorer',
  'last touchdown scorer',
  'double double',
  'triple double',
  'double-double',
  'triple-double',
]);

const STAT_ALIAS_MAP: Record<string, string> = {
  'passing yards': 'passing_yards',
  'passing tds': 'passing_touchdowns',
  'passing touchdowns': 'passing_touchdowns',
  'interceptions thrown': 'passing_interceptions',
  'rushing yards': 'rushing_yards',
  'rushing attempts': 'rushing_attempts',
  'receiving yards': 'receiving_yards',
  receptions: 'receiving_receptions',
  'anytime td scorer': 'touchdowns',
  'anytime touchdown scorer': 'touchdowns',
  'longest reception': 'receiving_longestReception',
  'longest rush': 'rushing_longestRush',
  'points': 'points',
  'rebounds': 'rebounds',
  'assists': 'assists',
  'points + rebounds + assists (pra)': 'points+rebounds+assists',
  'points + rebounds + assists': 'points+rebounds+assists',
  pra: 'points+rebounds+assists',
  '3-pointers made': 'threePointersMade',
  '3 pointers made': 'threePointersMade',
  'steals': 'steals',
  'blocks': 'blocks',
  'turnovers': 'turnovers',
  'hits': 'hits',
  'home runs': 'homeRuns',
  rbis: 'runsBattedIn',
  'runs': 'runs',
  'total bases': 'totalBases',
  'stolen bases': 'stolenBases',
  'pitcher strikeouts': 'pitcher_strikeouts',
  'pitcher outs recorded': 'pitcher_outsRecorded',
  'walks drawn': 'walks',
  'shots on goal': 'shotsOnGoal',
  'blocked shots': 'blockedShots',
  'goalie saves': 'goalie_saves',
  'points + assists': 'points+assists',
  'points + rebounds': 'points+rebounds',
  'rebounds + assists': 'rebounds+assists',
};

export async function getEvent(eventId: string): Promise<Event | null> {
  if (!eventId) {
    return null;
  }

  const cached = eventCache.get(eventId);
  if (cached && Date.now() - cached.fetchedAt < EVENT_CACHE_TTL_MS) {
    return cached.event;
  }

  try {
    const page = await client.events.get({
      eventID: eventId,
      limit: 1,
      includeOpposingOdds: true,
      includeAltLines: true,
      oddsPresent: true,
    });

    const event = page.data[0] ?? null;
    if (event) {
      eventCache.set(eventId, { event, fetchedAt: Date.now() });
    }

    return event;
  } catch (error) {
    console.error(`Failed to fetch event ${eventId} from SportsGameOdds:`, error);
    return null;
  }
}

export function normalize(value?: string | null): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s+]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getTeamNames(team?: Event.Teams.Home | Event.Teams.Away): string[] {
  if (!team) return [];
  const names = [
    team.names?.long,
    team.names?.medium,
    team.names?.short,
  ].filter(Boolean) as string[];

  return names.map((name) => normalize(name));
}

export function resolveTeamSide(event: Event, selection: string): MoneylineSide | null {
  const normalizedSelection = normalize(selection);
  if (!normalizedSelection) return null;

  const homeNames = getTeamNames(event.teams?.home);
  const awayNames = getTeamNames(event.teams?.away);

  const matches = (names: string[]) =>
    names.some((name) => name === normalizedSelection || name.includes(normalizedSelection) || normalizedSelection.includes(name));

  if (matches(homeNames)) return 'home';
  if (matches(awayNames)) return 'away';
  return null;
}

function pickBookOdds(odd: Event.Odds): number | null {
  const tryParse = (value?: string | null) => {
    if (value === undefined || value === null) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const direct = tryParse(odd.bookOdds ?? odd.fairOdds);
  if (direct !== null) {
    return direct;
  }

  const bookmakerEntries = Object.values(odd.byBookmaker ?? {});
  for (const entry of bookmakerEntries) {
    const parsed = tryParse(entry?.odds);
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
}

function pickSpreadValue(odd: Event.Odds): number | null {
  const tryParse = (value?: string | null) => {
    if (value === undefined || value === null) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const direct = tryParse(odd.bookSpread ?? odd.fairSpread);
  if (direct !== null) {
    return direct;
  }

  const bookmakerEntries = Object.values(odd.byBookmaker ?? {});
  for (const entry of bookmakerEntries) {
    const parsed = tryParse(entry?.spread);
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
}

function pickTotalValue(odd: Event.Odds): number | null {
  const tryParse = (value?: string | null) => {
    if (value === undefined || value === null) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const direct = tryParse(odd.bookOverUnder ?? odd.fairOverUnder);
  if (direct !== null) {
    return direct;
  }

  const bookmakerEntries = Object.values(odd.byBookmaker ?? {});
  for (const entry of bookmakerEntries) {
    const parsed = tryParse(entry?.overUnder);
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
}

/**
 * Get ALL available lines from an odd (including all bookmaker alternative lines)
 * Returns an array of { line: number, bookmaker?: string } entries
 */
function getAllAvailableLines(odd: Event.Odds): Array<{ line: number; bookmaker?: string }> {
  const tryParse = (value?: string | null) => {
    if (value === undefined || value === null) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const lines: Array<{ line: number; bookmaker?: string }> = [];
  const seenLines = new Set<number>();

  // Add direct line (bookOverUnder or fairOverUnder)
  const direct = tryParse(odd.bookOverUnder ?? odd.fairOverUnder);
  if (direct !== null && !seenLines.has(direct)) {
    lines.push({ line: direct });
    seenLines.add(direct);
  }

  // Add all bookmaker lines
  if (odd.byBookmaker && typeof odd.byBookmaker === 'object') {
    for (const [bookmaker, entry] of Object.entries(odd.byBookmaker)) {
      if (entry && typeof entry === 'object') {
        // Type guard: check if entry has overUnder property
        const bookmakerEntry = entry as { overUnder?: string | null };
        const parsed = tryParse(bookmakerEntry.overUnder);
        if (parsed !== null && !seenLines.has(parsed)) {
          lines.push({ line: parsed, bookmaker });
          seenLines.add(parsed);
        }
      }
    }
  }

  return lines;
}

/**
 * Find the closest line to the requested line from all available lines in an odd
 * Returns { line: number, bookmaker?: string } or null
 */
function findClosestLine(
  odd: Event.Odds,
  requestedLine: number,
): { line: number; bookmaker?: string; odd: Event.Odds } | null {
  const availableLines = getAllAvailableLines(odd);
  
  if (availableLines.length === 0) {
    return null;
  }

  // Find the line closest to requestedLine
  let closest = availableLines[0];
  let closestDiff = Math.abs(availableLines[0].line - requestedLine);

  for (const lineEntry of availableLines) {
    const diff = Math.abs(lineEntry.line - requestedLine);
    if (diff < closestDiff) {
      closestDiff = diff;
      closest = lineEntry;
    }
  }

  return { ...closest, odd };
}

async function ensureGameNotStarted(event: Event | null, startTime: Date): Promise<ValidationResult | null> {
  const now = new Date();
  if (now >= startTime) {
    return {
      valid: false,
      error: 'Cannot create bet after game has started',
    };
  }

  if (event?.status?.started || event?.status?.live || event?.status?.completed) {
    return {
      valid: false,
      error: 'Cannot create bet after game has started',
    };
  }

  return null;
}

function validateDecimalOdds(apiDecimal: number, submitted: number): ValidationResult | null {
  if (apiDecimal <= 0 || !Number.isFinite(apiDecimal)) {
    return {
      valid: false,
      error: 'Invalid odds from provider',
    };
  }

  const tolerance = Math.abs(submitted - apiDecimal) / apiDecimal;
  if (tolerance > TOLERANCE) {
    return {
      valid: false,
      error: `Odds differ by more than 5% from provider. Submitted: ${submitted.toFixed(2)}, Provider: ${apiDecimal.toFixed(2)}`,
    };
  }

  return null;
}

function validateLineTolerance(submitted: number, providerLine: number): ValidationResult | null {
  if (providerLine === 0) {
    if (Math.abs(submitted) > 0.01) {
      return {
        valid: false,
        error: `Line must be 0 when provider line is 0. Submitted: ${submitted}`,
      };
    }
    return null;
  }

  const diffRatio = Math.abs(submitted - providerLine) / Math.abs(providerLine);
  if (diffRatio > TOLERANCE) {
    return {
      valid: false,
      error: `Line differs by more than 5% from provider. Submitted: ${submitted}, Provider: ${providerLine}`,
    };
  }

  return null;
}

function findOdd(
  event: Event,
  predicate: (odd: Event.Odds) => boolean,
): Event.Odds | null {
  const odds = event.odds ? Object.values(event.odds) : [];
  for (const odd of odds) {
    if (predicate(odd)) {
      return odd;
    }
  }
  return null;
}

export function mapStatTypeToStatId(statType: string): string {
  const normalized = normalize(statType);
  
  // First try direct lookup
  if (STAT_ALIAS_MAP[normalized]) {
    return STAT_ALIAS_MAP[normalized];
  }
  
  // Try to find a key that normalizes to the same value
  for (const [key, value] of Object.entries(STAT_ALIAS_MAP)) {
    if (normalize(key) === normalized) {
      return value;
    }
  }
  
  // Fallback: replace spaces with underscores, but preserve + signs
  return normalized.replace(/\s+/g, '_').replace(/_\+_/g, '+').replace(/_\+/g, '+').replace(/\+_/g, '+');
}

export function resolvePropBetType(statType: string): 'ou' | 'yn' {
  const normalized = normalize(statType);
  if (YES_NO_PROP_STATS.has(normalized)) {
    return 'yn';
  }
  return 'ou';
}

export async function validateMoneylineBet(
  _sportKey: string,
  eventId: string,
  selection: string,
  odds: number,
  startTime: Date,
): Promise<ValidationResult> {
  const event = await getEvent(eventId);
  const started = await ensureGameNotStarted(event, startTime);
  if (started) {
    return started;
  }
  if (!event) {
    return { valid: false, error: 'Unable to fetch event data from SportsGameOdds.' };
  }

  const side = resolveTeamSide(event, selection);
  if (!side) {
    return {
      valid: false,
      error: `Could not match "${selection}" to event teams`,
    };
  }

  const odd = findOdd(
    event,
    (o) =>
      o.betTypeID === 'ml' &&
      o.periodID === 'game' &&
      o.sideID === side &&
      o.statID === 'points' &&
      !o.playerID,
  );

  if (!odd) {
    return {
      valid: false,
      error: 'Moneyline odds not available for this selection.',
    };
  }

  const americanOdds = pickBookOdds(odd);
  if (americanOdds === null) {
    return {
      valid: false,
      error: 'Provider did not return odds for this moneyline.',
    };
  }

  const apiDecimal = americanToDecimal(americanOdds);
  const oddsValidation = validateDecimalOdds(apiDecimal, odds);
  if (oddsValidation) {
    return oddsValidation;
  }

  return { valid: true };
}

export async function validateSpreadBet(
  _sportKey: string,
  eventId: string,
  selection: string,
  line: number,
  odds: number,
  startTime: Date,
): Promise<ValidationResult> {
  const event = await getEvent(eventId);
  const started = await ensureGameNotStarted(event, startTime);
  if (started) {
    return started;
  }
  if (!event) {
    return { valid: false, error: 'Unable to fetch event data from SportsGameOdds.' };
  }

  const side = resolveTeamSide(event, selection);
  if (!side) {
    return {
      valid: false,
      error: `Could not match "${selection}" to event teams`,
    };
  }

  const odd = findOdd(
    event,
    (o) =>
      o.betTypeID === 'sp' &&
      o.periodID === 'game' &&
      o.sideID === side &&
      o.statID === 'points' &&
      !o.playerID,
  );

  if (!odd) {
    return {
      valid: false,
      error: 'Spread odds not available for this selection.',
    };
  }

  const providerLine = pickSpreadValue(odd);
  if (providerLine === null) {
    return {
      valid: false,
      error: 'Provider did not return a spread line.',
    };
  }

  const lineValidation = validateLineTolerance(line, providerLine);
  if (lineValidation) {
    return lineValidation;
  }

  const americanOdds = pickBookOdds(odd);
  if (americanOdds === null) {
    return {
      valid: false,
      error: 'Provider did not return odds for this spread.',
    };
  }

  const apiDecimal = americanToDecimal(americanOdds);
  const oddsValidation = validateDecimalOdds(apiDecimal, odds);
  if (oddsValidation) {
    return oddsValidation;
  }

  return { valid: true };
}

export async function validateTotalBet(
  _sportKey: string,
  eventId: string,
  overUnder: 'Over' | 'Under',
  line: number,
  odds: number,
  startTime: Date,
): Promise<ValidationResult> {
  const event = await getEvent(eventId);
  const started = await ensureGameNotStarted(event, startTime);
  if (started) {
    return started;
  }
  if (!event) {
    return { valid: false, error: 'Unable to fetch event data from SportsGameOdds.' };
  }

  const targetSide = overUnder.toLowerCase();
  const odd = findOdd(
    event,
    (o) =>
      o.betTypeID === 'ou' &&
      o.periodID === 'game' &&
      o.sideID === targetSide &&
      o.statID === 'points' &&
      o.statEntityID === 'all' &&
      !o.playerID,
  );

  if (!odd) {
    return {
      valid: false,
      error: 'Total odds not available for this selection.',
    };
  }

  const providerLine = pickTotalValue(odd);
  if (providerLine === null) {
    return {
      valid: false,
      error: 'Provider did not return a total line.',
    };
  }

  const lineValidation = validateLineTolerance(line, providerLine);
  if (lineValidation) {
    return lineValidation;
  }

  const americanOdds = pickBookOdds(odd);
  if (americanOdds === null) {
    return {
      valid: false,
      error: 'Provider did not return odds for this total.',
    };
  }

  const apiDecimal = americanToDecimal(americanOdds);
  const oddsValidation = validateDecimalOdds(apiDecimal, odds);
  if (oddsValidation) {
    return oddsValidation;
  }

  return { valid: true };
}

export async function validatePlayerPropBet(
  playerKey: string,
  statType: string,
  line: number,
  overUnder: 'Over' | 'Under',
  odds: number,
  startTime: Date,
  eventId?: string,
): Promise<ValidationResult> {
  if (!eventId) {
    return {
      valid: false,
      error: 'Missing provider event ID for player prop validation.',
    };
  }

  const event = await getEvent(eventId);
  const started = await ensureGameNotStarted(event, startTime);
  if (started) {
    return started;
  }
  if (!event) {
    return { valid: false, error: 'Unable to fetch event data from SportsGameOdds.' };
  }

  const propBetType = resolvePropBetType(statType);
  const desiredSide =
    propBetType === 'yn' ? (overUnder === 'Over' ? 'yes' : 'no') : overUnder.toLowerCase();
  const statId = mapStatTypeToStatId(statType);

  const oddsArray = Object.values(event.odds ?? {}).filter((odd) => odd.playerID === playerKey);
  if (oddsArray.length === 0) {
    return {
      valid: false,
      error: 'No props available for the selected player.',
    };
  }

  // Filter odds by bet type and side
  const candidateOdds = oddsArray.filter(
    (odd) => odd.betTypeID === propBetType && odd.sideID === desiredSide,
  );

  if (candidateOdds.length === 0) {
    return {
      valid: false,
      error: `Stat type "${statType}" with side "${overUnder}" not available for this player.`,
    };
  }

  // Filter all valid matches by stat type (exclude composites/quarters when appropriate)
  const normalizedStatType = normalize(statType);
  const statWords = normalizedStatType.split(/\s+/).filter(Boolean);

  const validMatches = candidateOdds.filter((odd) => {
    // Check for quarter/half markets first - filter them out unless explicitly requested
    if (odd.marketName) {
      const isQuarterMarket = /\b(1st|2nd|3rd|4th|first|second|third|fourth)\s+(quarter|half|period)/i.test(odd.marketName);
      const isQuarterStat = /\b(1st|2nd|3rd|4th|first|second|third|fourth)\s+(quarter|half|period)/i.test(statType);
      if (isQuarterMarket && !isQuarterStat) {
        return false;
      }
    }

    // Priority 1: Exact statID match is best
    if (odd.statID?.toLowerCase() === statId.toLowerCase()) {
      return true;
    }

    // Priority 2: Check if statID is composite - skip if we're looking for single stat
    if (odd.statID) {
      const oddStatId = odd.statID.toLowerCase();
      const isCompositeStatId = oddStatId.includes('+');
      if (isCompositeStatId && !normalizedStatType.includes('+')) {
        // Skip composite statIDs when looking for single stats
        return false;
      }
    }

    // Priority 3: Market name matching (fallback)
    if (!odd.marketName) return false;
    const marketNameNormalized = normalize(odd.marketName);

    if (statWords.length === 1) {
      // Single word stat - check for composites and quarters
      const isCompositeMarket = /\+|and|plus/i.test(odd.marketName);
      if (isCompositeMarket && !normalizedStatType.includes('+')) {
        return false;
      }
      
      // Match if the word appears as a whole word
      return new RegExp(`\\b${statWords[0]}\\b`).test(marketNameNormalized);
    } else {
      // Multi-word stat
      const isCompositeMarket = /\+|and|plus/i.test(odd.marketName);
      if (isCompositeMarket && !normalizedStatType.includes('+')) {
        return false;
      }
      
      return statWords.every((word) => marketNameNormalized.includes(word));
    }
  });

  if (validMatches.length === 0) {
    return {
      valid: false,
      error: `Stat type "${statType}" not available for this player.`,
    };
  }

  // Among all valid matches, find the one closest to the submitted line
  // For over/under props, prioritize by line proximity
  let matchingOdd: typeof candidateOdds[0] | undefined;

  if (propBetType === 'ou') {
    // Sort by: 1) exact statID match (prefer exact), 2) line proximity (checking ALL available lines including bookmaker lines)
    const matchesWithScores = validMatches.map((odd) => {
      const closestLineEntry = findClosestLine(odd, line);
      const providerLine = closestLineEntry?.line ?? pickTotalValue(odd);
      const isExactStatId = odd.statID?.toLowerCase() === statId.toLowerCase();
      const lineDiff = providerLine !== null ? Math.abs(providerLine - line) : Infinity;
      
      return {
        odd,
        providerLine,
        closestLineEntry, // Store the closest line entry (includes bookmaker info if applicable)
        isExactStatId,
        lineDiff,
        // Score: lower is better
        // Exact statID matches get priority (score 0-1000 range)
        // Non-exact matches get score 1000+ based on line difference
        score: isExactStatId ? lineDiff : 1000 + lineDiff,
      };
    });

    // Sort by score (lower is better), then pick the best match
    matchesWithScores.sort((a, b) => a.score - b.score);
    const bestMatch = matchesWithScores[0];
    matchingOdd = bestMatch.odd;
    
    // Use the closest line we already found (from bookmaker lines if available)
    const providerLine = bestMatch.providerLine;
    
    if (providerLine === null) {
      return {
        valid: false,
        error: 'Provider did not return a line for this player prop.',
      };
    }

    const lineValidation = validateLineTolerance(line, providerLine);
    if (lineValidation) {
      return lineValidation;
    }
  } else {
    // For yes/no props, prefer exact statID match
    const exactMatch = validMatches.find(
      (odd) => odd.statID?.toLowerCase() === statId.toLowerCase(),
    );
    matchingOdd = exactMatch || validMatches[0];
  }

  if (!matchingOdd) {
    return {
      valid: false,
      error: `Stat type "${statType}" not available for this player.`,
    };
  }

  // Validate odds for player props
  const americanOdds = pickBookOdds(matchingOdd);
  if (americanOdds === null) {
    return {
      valid: false,
      error: 'Provider did not return odds for this player prop.',
    };
  }

  const apiDecimal = americanToDecimal(americanOdds);
  const oddsValidation = validateDecimalOdds(apiDecimal, odds);
  if (oddsValidation) {
    return oddsValidation;
  }

  return { valid: true };
}

export async function validatePlayerPropLineOnly(
  playerKey: string,
  statType: string,
  line: number,
  overUnder: 'Over' | 'Under',
  startTime: Date,
  eventId?: string,
): Promise<ValidationResult> {
  if (!eventId) {
    return {
      valid: false,
      error: 'Missing provider event ID for player prop validation.',
    };
  }

  const event = await getEvent(eventId);
  const started = await ensureGameNotStarted(event, startTime);
  if (started) {
    return started;
  }
  if (!event) {
    return { valid: false, error: 'Unable to fetch event data from SportsGameOdds.' };
  }

  const propBetType = resolvePropBetType(statType);
  const desiredSide =
    propBetType === 'yn' ? (overUnder === 'Over' ? 'yes' : 'no') : overUnder.toLowerCase();
  const statId = mapStatTypeToStatId(statType);

  const oddsArray = Object.values(event.odds ?? {}).filter((odd) => odd.playerID === playerKey);
  if (oddsArray.length === 0) {
    return {
      valid: false,
      error: 'No props available for the selected player.',
    };
  }

  // Filter odds by bet type and side
  const candidateOdds = oddsArray.filter(
    (odd) => odd.betTypeID === propBetType && odd.sideID === desiredSide,
  );

  if (candidateOdds.length === 0) {
    return {
      valid: false,
      error: `Stat type "${statType}" with side "${overUnder}" not available for this player.`,
    };
  }

  // Filter all valid matches by stat type (exclude composites/quarters when appropriate)
  const normalizedStatType = normalize(statType);
  const statWords = normalizedStatType.split(/\s+/).filter(Boolean);

  const validMatches = candidateOdds.filter((odd) => {
    // Check for quarter/half markets first - filter them out unless explicitly requested
    if (odd.marketName) {
      const isQuarterMarket = /\b(1st|2nd|3rd|4th|first|second|third|fourth)\s+(quarter|half|period)/i.test(odd.marketName);
      const isQuarterStat = /\b(1st|2nd|3rd|4th|first|second|third|fourth)\s+(quarter|half|period)/i.test(statType);
      if (isQuarterMarket && !isQuarterStat) {
        return false;
      }
    }

    // Priority 1: Exact statID match is best
    if (odd.statID?.toLowerCase() === statId.toLowerCase()) {
      return true;
    }

    // Priority 2: Check if statID is composite - skip if we're looking for single stat
    if (odd.statID) {
      const oddStatId = odd.statID.toLowerCase();
      const isCompositeStatId = oddStatId.includes('+');
      if (isCompositeStatId && !normalizedStatType.includes('+')) {
        return false;
      }
    }

    // Priority 3: Market name matching (fallback)
    if (!odd.marketName) return false;
    const marketNameNormalized = normalize(odd.marketName);

    if (statWords.length === 1) {
      const isCompositeMarket = /\+|and|plus/i.test(odd.marketName);
      if (isCompositeMarket && !normalizedStatType.includes('+')) {
        return false;
      }
      
      return new RegExp(`\\b${statWords[0]}\\b`).test(marketNameNormalized);
    } else {
      const isCompositeMarket = /\+|and|plus/i.test(odd.marketName);
      if (isCompositeMarket && !normalizedStatType.includes('+')) {
        return false;
      }
      
      return statWords.every((word) => marketNameNormalized.includes(word));
    }
  });

  if (validMatches.length === 0) {
    return {
      valid: false,
      error: `Stat type "${statType}" not available for this player.`,
    };
  }

  // Among all valid matches, find the one closest to the submitted line
  let matchingOdd: typeof candidateOdds[0] | undefined;

  if (propBetType === 'ou') {
    // Sort by: 1) exact statID match (prefer exact), 2) line proximity (checking ALL available lines including bookmaker lines)
    const matchesWithScores = validMatches.map((odd) => {
      const closestLineEntry = findClosestLine(odd, line);
      const providerLine = closestLineEntry?.line ?? pickTotalValue(odd);
      const isExactStatId = odd.statID?.toLowerCase() === statId.toLowerCase();
      const lineDiff = providerLine !== null ? Math.abs(providerLine - line) : Infinity;
      
      return {
        odd,
        providerLine,
        closestLineEntry,
        isExactStatId,
        lineDiff,
        score: isExactStatId ? lineDiff : 1000 + lineDiff,
      };
    });

    matchesWithScores.sort((a, b) => a.score - b.score);
    matchingOdd = matchesWithScores[0].odd;
  } else {
    const exactMatch = validMatches.find(
      (odd) => odd.statID?.toLowerCase() === statId.toLowerCase(),
    );
    matchingOdd = exactMatch || validMatches[0];
  }

  if (!matchingOdd) {
    return {
      valid: false,
      error: `Stat type "${statType}" not available for this player.`,
    };
  }

  if (propBetType === 'ou') {
    // Use the closest line we found (from bookmaker lines if available)
    const closestLineEntry = findClosestLine(matchingOdd, line);
    const providerLine = closestLineEntry?.line ?? pickTotalValue(matchingOdd);
    
    if (providerLine === null) {
      return {
        valid: false,
        error: 'Provider did not return a line for this player prop.',
      };
    }

    const lineValidation = validateLineTolerance(line, providerLine);
    if (lineValidation) {
      return lineValidation;
    }
  }

  // For parlay legs, we skip odds validation (parlay odds are calculated separately)
  return { valid: true };
}

export async function validateSpreadLineOnly(
  _sportKey: string,
  eventId: string,
  selection: string,
  line: number,
  startTime: Date,
): Promise<ValidationResult> {
  const event = await getEvent(eventId);
  const started = await ensureGameNotStarted(event, startTime);
  if (started) {
    return started;
  }
  if (!event) {
    return { valid: false, error: 'Unable to fetch event data from SportsGameOdds.' };
  }

  const side = resolveTeamSide(event, selection);
  if (!side) {
    return {
      valid: false,
      error: `Could not match "${selection}" to event teams`,
    };
  }

  const odd = findOdd(
    event,
    (o) =>
      o.betTypeID === 'sp' &&
      o.periodID === 'game' &&
      o.sideID === side &&
      o.statID === 'points' &&
      !o.playerID,
  );

  if (!odd) {
    return {
      valid: false,
      error: 'Spread odds not available for this selection.',
    };
  }

  const providerLine = pickSpreadValue(odd);
  if (providerLine === null) {
    return {
      valid: false,
      error: 'Provider did not return a spread line.',
    };
  }

  const lineValidation = validateLineTolerance(line, providerLine);
  if (lineValidation) {
    return lineValidation;
  }

  return { valid: true };
}

export async function validateTotalLineOnly(
  _sportKey: string,
  eventId: string,
  overUnder: 'Over' | 'Under',
  line: number,
  startTime: Date,
): Promise<ValidationResult> {
  const event = await getEvent(eventId);
  const started = await ensureGameNotStarted(event, startTime);
  if (started) {
    return started;
  }
  if (!event) {
    return { valid: false, error: 'Unable to fetch event data from SportsGameOdds.' };
  }

  const targetSide = overUnder.toLowerCase();
  const odd = findOdd(
    event,
    (o) =>
      o.betTypeID === 'ou' &&
      o.periodID === 'game' &&
      o.sideID === targetSide &&
      o.statID === 'points' &&
      o.statEntityID === 'all' &&
      !o.playerID,
  );

  if (!odd) {
    return {
      valid: false,
      error: 'Total odds not available for this selection.',
    };
  }

  const providerLine = pickTotalValue(odd);
  if (providerLine === null) {
    return {
      valid: false,
      error: 'Provider did not return a total line.',
    };
  }

  const lineValidation = validateLineTolerance(line, providerLine);
  if (lineValidation) {
    return lineValidation;
  }

  return { valid: true };
}

export async function checkGameStarted(
  _sportKey: string | undefined,
  eventId: string | undefined,
  startTime: Date,
): Promise<{ started: boolean; error?: string }> {
  const event = eventId ? await getEvent(eventId) : null;
  const started = await ensureGameNotStarted(event, startTime);
  if (started) {
    return { started: true, error: started.error };
  }
  return { started: false };
}
