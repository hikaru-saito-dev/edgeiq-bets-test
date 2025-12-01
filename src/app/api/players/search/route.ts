import { NextRequest, NextResponse } from 'next/server';
import type { Event } from 'sports-odds-api/resources/events';
import type { Player as SportsGameOddsPlayer } from 'sports-odds-api/resources/players';

import { getSportsGameOddsClient } from '@/lib/sportsGameOdds';

type PlayerResponse = {
  id: string;
  playerKey: string;
  name: string;
  firstName: string;
  lastName: string;
  position: string;
  team: string | null;
  number?: number | null;
  status?: string;
  active?: boolean;
  experience?: number;
  height?: string;
  weight?: number;
  college?: string;
};

const SPORT_KEY_TO_LEAGUE: Record<string, string> = {
  americanfootball_nfl: 'NFL',
  americanfootball_ncaaf: 'NCAAF',
  basketball_nba: 'NBA',
  basketball_ncaab: 'NCAAB',
  baseball_mlb: 'MLB',
  icehockey_nhl: 'NHL',
};

const LEAGUE_FALLBACK_BY_SPORT: Record<string, string> = {
  nfl: 'NFL',
  ncaaf: 'NCAAF',
  nba: 'NBA',
  ncaab: 'NCAAB',
  mlb: 'MLB',
  nhl: 'NHL',
};

const DEFAULT_LEAGUE = 'NFL';

function normalize(value?: string | null): string {
  if (!value) return '';
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function namesForTeam(team?: Event.Teams.Home | Event.Teams.Away): string[] {
  if (!team) return [];
  const names = new Set<string>();
  const variants = [
    team.names?.long,
    team.names?.medium,
    team.names?.short,
  ];

  for (const value of variants) {
    const normalized = normalize(value);
    if (normalized) {
      names.add(normalized);
    }
  }

  return Array.from(names);
}

function teamMatches(team: Event.Teams.Home | Event.Teams.Away | undefined, target: string): boolean {
  if (!target) return true;
  const normalizedTarget = normalize(target);
  if (!normalizedTarget) return true;
  const candidates = namesForTeam(team);

  return candidates.some((candidate) => candidate === normalizedTarget || candidate.includes(normalizedTarget) || normalizedTarget.includes(candidate));
}

function buildTeamLabel(team?: Event.Teams.Home | Event.Teams.Away): string | undefined {
  if (!team) return undefined;
  return team.names?.long || team.names?.medium || team.names?.short;
}

function getLeagueId({ sportKey, leagueParam, sportParam }: { sportKey?: string; leagueParam?: string; sportParam?: string }): string {
  if (leagueParam) {
    return leagueParam.toUpperCase();
  }

  if (sportKey && SPORT_KEY_TO_LEAGUE[sportKey]) {
    return SPORT_KEY_TO_LEAGUE[sportKey];
  }

  if (sportParam) {
    const normalized = sportParam.toLowerCase();
    if (LEAGUE_FALLBACK_BY_SPORT[normalized]) {
      return LEAGUE_FALLBACK_BY_SPORT[normalized];
    }
  }

  return DEFAULT_LEAGUE;
}

async function findEvent(options: {
  client: ReturnType<typeof getSportsGameOddsClient>;
  leagueID: string;
  eventId?: string;
  homeTeam?: string;
  awayTeam?: string;
  gameStart?: string;
}): Promise<Event | null> {
  const { client, leagueID, eventId, homeTeam, awayTeam, gameStart } = options;

  if (eventId) {
    const page = await client.events.get({
      eventIDs: eventId,
      limit: 1,
      includeOpposingOdds: true,
      includeAltLines: true,
    });
    if (page.data.length > 0) {
      return page.data[0];
    }
  }

  if (!gameStart) {
    return null;
  }

  const startDate = new Date(gameStart);
  if (Number.isNaN(startDate.getTime())) {
    return null;
  }

  const windowBefore = new Date(startDate.getTime() - 6 * 60 * 60 * 1000).toISOString();
  const windowAfter = new Date(startDate.getTime() + 6 * 60 * 60 * 1000).toISOString();

  const page = await client.events.get({
    leagueID,
    startsAfter: windowBefore,
    startsBefore: windowAfter,
    oddsPresent: true,
    limit: 200,
  });

  for (const event of page.data) {
    const homeMatch = teamMatches(event.teams?.home, homeTeam ?? '');
    const awayMatch = teamMatches(event.teams?.away, awayTeam ?? '');
    const swappedHomeMatch = teamMatches(event.teams?.home, awayTeam ?? '');
    const swappedAwayMatch = teamMatches(event.teams?.away, homeTeam ?? '');

    if ((homeMatch && awayMatch) || (swappedHomeMatch && swappedAwayMatch)) {
      return event;
    }
  }

  return null;
}

async function fetchPlayersForEvent(
  client: ReturnType<typeof getSportsGameOddsClient>,
  eventId: string,
  homeTeamId?: string,
  awayTeamId?: string,
): Promise<SportsGameOddsPlayer[]> {
  // Method 1: Try to fetch by eventID
  try {
    const players: SportsGameOddsPlayer[] = [];
    const iterator = client.players.get({
      eventID: eventId,
      limit: 200,
    });

    for await (const player of iterator) {
      players.push(player);
    }

    if (players.length > 0) {
      return players;
    }
  } catch (error) {
    // Continue to fallback methods
    console.warn(`Failed to fetch players for event ${eventId}:`, error instanceof Error ? error.message : String(error));
  }

  // Method 2: Fallback - fetch by teamID (if available)
  const players: SportsGameOddsPlayer[] = [];
  const teamIds = [homeTeamId, awayTeamId].filter((id): id is string => Boolean(id));
  const seenPlayerIds = new Set<string>();

  for (const teamId of teamIds) {
    try {
      const iterator = client.players.get({
        teamID: teamId,
        limit: 200,
      });

      for await (const player of iterator) {
        // Only add if we haven't seen this player ID yet (in case player is in both teams somehow)
        if (player.playerID && !seenPlayerIds.has(player.playerID)) {
          players.push(player);
          seenPlayerIds.add(player.playerID);
        }
      }
    } catch (error) {
      // Continue to next team
      console.warn(`Failed to fetch players for team ${teamId}:`, error instanceof Error ? error.message : String(error));
    }
  }

  return players;
}

function getPlayerIdsWithProps(event: Event): Set<string> {
  const ids = new Set<string>();
  if (!event.odds) {
    return ids;
  }

  for (const odd of Object.values(event.odds)) {
    if (odd.playerID) {
      ids.add(odd.playerID);
    }
  }

  return ids;
}

function mapPlayerToResponse(options: {
  player: SportsGameOddsPlayer | null;
  fallback: Event.Players | null;
  teamName?: string;
}): PlayerResponse | null {
  const { player, fallback, teamName } = options;

  const playerKey = player?.playerID ?? fallback?.playerID;
  if (!playerKey) {
    return null;
  }

  const firstName = player?.names?.firstName || fallback?.firstName || '';
  const lastName = player?.names?.lastName || fallback?.lastName || '';
  const displayName =
    player?.names?.display || fallback?.name || [firstName, lastName].filter(Boolean).join(' ').trim();

  if (!displayName) {
    return null;
  }

  return {
    id: playerKey,
    playerKey,
    name: displayName,
    firstName,
    lastName,
    position: player?.position || '',
    team: teamName || fallback?.teamID || null,
    number: typeof player?.jerseyNumber === 'number' ? player.jerseyNumber : null,
    status: 'Active',
    active: true,
  };
}

function filterByTeam(players: PlayerResponse[], teamParam: string): PlayerResponse[] {
  if (!teamParam) return players;
  const targets = teamParam
    .split(',')
    .map((value) => normalize(value))
    .filter((value) => value.length > 0);

  if (targets.length === 0) {
    return players;
  }

  return players.filter((player) => {
    if (!player.team) return false;
    const normalizedTeam = normalize(player.team);
    return targets.some((target) => normalizedTeam.includes(target) || target.includes(normalizedTeam));
  });
}

function filterByQuery(players: PlayerResponse[], query: string): PlayerResponse[] {
  if (!query.trim()) {
    return players;
  }

  const normalized = query.toLowerCase().trim();
  return players.filter((player) => {
    return (
      player.name.toLowerCase().includes(normalized) ||
      player.firstName.toLowerCase().includes(normalized) ||
      player.lastName.toLowerCase().includes(normalized) ||
      player.position.toLowerCase().includes(normalized) ||
      (player.team && player.team.toLowerCase().includes(normalized))
    );
  });
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const query = searchParams.get('q') || '';
    const teamFilter = searchParams.get('team') || '';
    const sportKey = searchParams.get('sportKey') || '';
    const sportParam = searchParams.get('sport') || '';
    const leagueParam = searchParams.get('league') || '';
    const homeTeamName = searchParams.get('homeTeam') || '';
    const awayTeamName = searchParams.get('awayTeam') || '';
    const gameStart = searchParams.get('gameStart') || '';
    const eventId = searchParams.get('eventId') || '';
    const requireProps = searchParams.get('requireProps') === 'true';

    const client = getSportsGameOddsClient();

    const leagueID = getLeagueId({ sportKey, leagueParam, sportParam });
    const event = await findEvent({
      client,
      leagueID,
      eventId,
      homeTeam: homeTeamName,
      awayTeam: awayTeamName,
      gameStart,
    });

    if (!event || !event.eventID) {
      return NextResponse.json({
        players: [],
        total: 0,
        message: 'Could not find event for supplied teams/game.',
      });
    }

    const propEligibleIds = requireProps ? getPlayerIdsWithProps(event) : null;

    const homeTeamId = event.teams?.home?.teamID;
    const awayTeamId = event.teams?.away?.teamID;

    const [playersFromEndpoint, eventPlayerMap] = await Promise.all([
      fetchPlayersForEvent(client, event.eventID, homeTeamId, awayTeamId),
      Promise.resolve(Object.values(event.players ?? {}).filter((player): player is Event.Players => Boolean(player.playerID))),
    ]);

    const teamMap = new Map<string, string>();
    if (event.teams?.home?.teamID) {
      const label = buildTeamLabel(event.teams.home);
      if (label) {
        teamMap.set(event.teams.home.teamID, label);
      }
    }
    if (event.teams?.away?.teamID) {
      const label = buildTeamLabel(event.teams.away);
      if (label) {
        teamMap.set(event.teams.away.teamID, label);
      }
    }

    const playerDetailsById = new Map<string, SportsGameOddsPlayer>();
    for (const player of playersFromEndpoint) {
      if (player.playerID) {
        playerDetailsById.set(player.playerID, player);
      }
    }

    const combinedPlayers = new Map<string, PlayerResponse>();

    for (const eventPlayer of eventPlayerMap) {
      const details = eventPlayer.playerID ? playerDetailsById.get(eventPlayer.playerID) ?? null : null;

      const teamName = eventPlayer.teamID ? teamMap.get(eventPlayer.teamID) : undefined;
      const responsePlayer = mapPlayerToResponse({
        player: details,
        fallback: eventPlayer,
        teamName,
      });

      if (responsePlayer) {
        combinedPlayers.set(responsePlayer.id, responsePlayer);
      }
    }

    for (const player of playersFromEndpoint) {
      if (!player.playerID) continue;

      const teamName = player.teamID ? teamMap.get(player.teamID) : undefined;
      const responsePlayer = mapPlayerToResponse({
        player,
        fallback: null,
        teamName,
      });

      if (responsePlayer) {
        combinedPlayers.set(responsePlayer.id, responsePlayer);
      }
    }

    // Fallback: If no players found from API or event.players, try to extract from odds
    let allPlayers = Array.from(combinedPlayers.values());
    
    if (allPlayers.length === 0 && event.odds) {
      // Extract player information from odds
      const playerDataFromOdds = new Map<string, { playerID: string; name?: string; teamID?: string }>();
      
      for (const odd of Object.values(event.odds)) {
        if (odd.playerID) {
          const oddAny = odd as { playerName?: string; teamID?: string };
          if (!playerDataFromOdds.has(odd.playerID)) {
            playerDataFromOdds.set(odd.playerID, {
              playerID: odd.playerID,
              name: oddAny.playerName || undefined,
              teamID: oddAny.teamID || undefined,
            });
          } else {
            // Update with more complete data if available
            const existing = playerDataFromOdds.get(odd.playerID)!;
            if (!existing.name && oddAny.playerName) {
              existing.name = oddAny.playerName;
            }
            if (!existing.teamID && oddAny.teamID) {
              existing.teamID = oddAny.teamID;
            }
          }
        }
      }

      // Create player entries from odds data
      for (const [playerId, oddsData] of playerDataFromOdds) {
        const teamName = oddsData.teamID ? teamMap.get(oddsData.teamID) : null;
        const playerName = oddsData.name || `Player ${playerId}`;
        
        const responsePlayer: PlayerResponse = {
          id: playerId,
          playerKey: playerId,
          name: playerName,
          firstName: playerName.split(' ')[0] || '',
          lastName: playerName.split(' ').slice(1).join(' ') || '',
          position: '',
          team: teamName || oddsData.teamID || null,
          status: 'Active',
          active: true,
        };
        
        if (!combinedPlayers.has(playerId)) {
          combinedPlayers.set(playerId, responsePlayer);
        }
      }
      
      allPlayers = Array.from(combinedPlayers.values());
    }

    let players = allPlayers;

    if (requireProps && propEligibleIds && propEligibleIds.size > 0) {
      const withProps = allPlayers.filter((player) => propEligibleIds.has(player.playerKey));
      if (withProps.length > 0) {
        players = withProps;
      }
    }

    players = filterByTeam(players, teamFilter);
    players = filterByQuery(players, query);

    players.sort((a, b) => a.name.localeCompare(b.name));
    players = players.slice(0, 100);

    return NextResponse.json({
      players,
      total: players.length,
      ...(allPlayers.length === 0 && {
        message: 'Player data not available for this game. This may be due to API tier limitations.',
      }),
    });
  } catch (error) {
    console.error('Error searching players with SportsGameOdds:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
