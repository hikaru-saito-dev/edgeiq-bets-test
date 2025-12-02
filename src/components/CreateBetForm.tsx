'use client';

import { useState, useEffect } from 'react';
import {
  Box,
  Typography,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  InputAdornment,
  CircularProgress,
  Divider,
  Autocomplete,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Collapse,
  Chip,
  Paper,
  FormGroup,
  Checkbox,
} from '@mui/material';
import Switch from '@mui/material/Switch';
import FormControlLabel from '@mui/material/FormControlLabel';
import AddIcon from '@mui/icons-material/Add';
import AttachMoneyIcon from '@mui/icons-material/AttachMoney';
import TrendingUpIcon from '@mui/icons-material/TrendingUp';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import SearchIcon from '@mui/icons-material/Search';
import { useToast } from './ToastProvider';
import { MarketType } from '@/models/Bet';
import { apiRequest } from '@/lib/apiClient';
import { americanToDecimal, decimalToAmerican, formatOdds, type OddsFormat } from '@/utils/oddsConverter';
import { useAccess } from './AccessProvider';
import { alpha, useTheme } from '@mui/material/styles';

// Prop types by sport
const propTypesBySport: Record<string, string[]> = {
  // NFL
  'americanfootball_nfl': [
    'Passing Yards',
    'Passing TDs',
    'Interceptions Thrown',
    'Rushing Yards',
    'Rushing Attempts',
    'Receiving Yards',
    'Receptions',
    'Anytime TD Scorer',
    'Longest Reception',
    'Longest Rush',
  ],
  // NCAA Football
  'americanfootball_ncaaf': [
    'Passing Yards',
    'Passing TDs',
    'Interceptions Thrown',
    'Rushing Yards',
    'Receiving Yards',
    'Receptions',
    'Anytime TD Scorer',
  ],
  // NBA
  'basketball_nba': [
    'Points',
    'Rebounds',
    'Assists',
    'Points + Rebounds + Assists (PRA)',
    '3-Pointers Made',
    'Steals',
    'Blocks',
    'Turnovers',
  ],
  // NCAA Basketball
  'basketball_ncaab': [
    'Points',
    'Rebounds',
    'Assists',
    'PRA',
    '3-Pointers Made',
    'Steals',
    'Blocks',
    'Turnovers',
  ],
  // MLB
  'baseball_mlb': [
    'Hits',
    'Home Runs',
    'RBIs',
    'Runs',
    'Total Bases',
    'Stolen Bases',
    'Pitcher Strikeouts',
    'Pitcher Outs Recorded',
    'Walks Drawn',
  ],
  // NHL
  'icehockey_nhl': [
    'Goals',
    'Assists',
    'Points',
    'Shots on Goal',
    'Blocked Shots',
    'Goalie Saves',
  ],
  // Soccer
  'soccer_usa_mls': [
    'Goals',
    'Assists',
    'Shots',
    'Shots on Target',
    'Passes Completed',
    'Tackles',
    'Goalkeeper Saves',
  ],
  // Tennis
  'tennis_atp': [
    'Aces',
    'Double Faults',
    'Total Games Won',
    'Breaks of Serve',
  ],
  'tennis_wta': [
    'Aces',
    'Double Faults',
    'Total Games Won',
    'Breaks of Serve',
  ],
  // UFC/MMA
  'mma_mixed_martial_arts': [
    'Significant Strikes Landed',
    'Takedowns Landed',
    'Control Time (minutes)',
    'Submission Attempts',
  ],
  // Golf
  'golf_masters_tournament': [
    'Round Strokes (Over/Under)',
    'Birdies or Better',
    'Fairways Hit',
    'Greens in Regulation',
  ],
};

// Sports supported by SportsData.io for player props
const SUPPORTED_PLAYER_PROP_SPORTS = new Set([
  'americanfootball_nfl', // NFL
  'americanfootball_ncaaf', // CFB
  'basketball_ncaab', // CBB
  'basketball_nba', // NBA
  'icehockey_nhl', // NHL
  'baseball_mlb', // MLB
]);

// Check if a sport is supported for player props
function isSportSupportedForPlayerProps(sportKey?: string): boolean {
  if (!sportKey) return false;
  return SUPPORTED_PLAYER_PROP_SPORTS.has(sportKey);
}

// Helper function to get prop types for a sport
function getPropTypesForSport(sportKey?: string, sport?: string): string[] {
  let propList: string[] | undefined;

  if (sportKey && propTypesBySport[sportKey]) {
    propList = propTypesBySport[sportKey];
  } else if (sport) {
    const sportLower = sport.toLowerCase();
    for (const [key, props] of Object.entries(propTypesBySport)) {
      if (key.includes(sportLower) || sportLower.includes(key.split('_').pop() || '')) {
        propList = props;
        break;
      }
    }

    if (!propList) {
      const sportMap: Record<string, string[]> = {
        'nfl': propTypesBySport['americanfootball_nfl'] || [],
        'ncaaf': propTypesBySport['americanfootball_ncaaf'] || [],
        'nba': propTypesBySport['basketball_nba'] || [],
        'ncaab': propTypesBySport['basketball_ncaab'] || [],
        'mlb': propTypesBySport['baseball_mlb'] || [],
        'nhl': propTypesBySport['icehockey_nhl'] || [],
        'mls': propTypesBySport['soccer_usa_mls'] || [],
      };

      propList = sportMap[sportLower];
    }
  }

  if (!propList) {
    propList = Object.values(propTypesBySport).flat();
  }

  return Array.from(new Set(propList));
}

interface Game {
  provider?: string;
  providerEventId?: string;
  sport?: string;
  league?: string;
  sportKey?: string; // The Odds API sport_key (e.g., "americanfootball_nfl")
  homeTeam?: string;
  awayTeam?: string;
  homeTeamId?: string;
  awayTeamId?: string;
  startTime: string;
}

interface Player {
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
}

interface CreateBetFormProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export default function CreateBetForm({ open, onClose, onSuccess }: CreateBetFormProps) {
  const toast = useToast();
  const [submitting, setSubmitting] = useState(false);
  const [searchingGames, setSearchingGames] = useState(false);
  const [gameSearchQuery, setGameSearchQuery] = useState('');
  const [gameResults, setGameResults] = useState<Game[]>([]);
  const [selectedGame, setSelectedGame] = useState<Game | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Player search state
  const [searchingPlayers, setSearchingPlayers] = useState(false);
  const [playerSearchQuery, setPlayerSearchQuery] = useState('');
  const [playerResults, setPlayerResults] = useState<Player[]>([]);
  const [selectedPlayer, setSelectedPlayer] = useState<Player | null>(null);
  
  // Form state
  const [marketType, setMarketType] = useState<MarketType>('ML');
  const [selection, setSelection] = useState('');
  const [line, setLine] = useState<number | ''>('');
  const [overUnder, setOverUnder] = useState<'Over' | 'Under' | ''>('');
  const [playerName, setPlayerName] = useState('');
  const [statType, setStatType] = useState('');
  const [isParlay, setIsParlay] = useState(false);
  type ParlayLegLocal = {
    label: string;
    game: Game;
    market: {
      marketType: MarketType;
      selection?: string;
      line?: number;
      overUnder?: 'Over' | 'Under';
      playerName?: string;
      playerId?: string;
      playerKey?: string;
      statType?: string;
    };
    odds?: {
      format: OddsFormat;
      value: number;
    };
  };
  const [parlayLegs, setParlayLegs] = useState<ParlayLegLocal[]>([]);
  
  // Webhook selection - always use array format (can contain 0, 1, or multiple IDs)
  const [userWebhooks, setUserWebhooks] = useState<Array<{ id: string; name: string; url: string; type: 'whop' | 'discord' }>>([]);
  const [selectedWebhookIds, setSelectedWebhookIds] = useState<string[]>([]);
  
  const [oddsFormat, setOddsFormat] = useState<OddsFormat>('american');
  const [oddsValue, setOddsValue] = useState<number | ''>('');
  const [units, setUnits] = useState<number | ''>('');
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';
  const controlBg = alpha(theme.palette.background.paper, isDark ? 0.75 : 0.98);
  const controlBorder = alpha(theme.palette.primary.main, isDark ? 0.45 : 0.25);
  
  const [book, setBook] = useState('');
  const [notes, setNotes] = useState('');
  const [slipImageUrl, setSlipImageUrl] = useState('');
  
  const { userId, companyId } = useAccess();
  
  // Fetch user webhooks when form opens
  useEffect(() => {
    if (open && userId && companyId) {
      const fetchWebhooks = async () => {
        try {
          const response = await apiRequest('/api/user', { userId, companyId });
          if (response.ok) {
            const data = await response.json();
            setUserWebhooks(data.user?.webhooks || []);
          }
        } catch (error) {
          console.error('Error fetching webhooks:', error);
        }
      };
      fetchWebhooks();
    }
  }, [open, userId, companyId]);

  useEffect(() => {
    if (!userWebhooks || userWebhooks.length === 0) {
      setSelectedWebhookIds([]);
      return;
    }

    setSelectedWebhookIds((prev) =>
      prev.filter((id) => userWebhooks.some((webhook) => webhook.id === id))
    );
      
  }, [userWebhooks]);

  const handleWebhookSelection = (webhookId: string, checked: boolean) => {
    setSelectedWebhookIds((prev) => {
      if (checked) {
        if (prev.includes(webhookId)) return prev;
        return [...prev, webhookId];
      }
      return prev.filter((id) => id !== webhookId);
    });
  };
  
  // Calculate parlay odds from leg odds
  const calculateParlayOdds = (legs: ParlayLegLocal[]): number | null => {
    if (legs.length < 2) return null;
    
    // Filter legs that have odds
    const legsWithOdds = legs.filter(leg => leg.odds && leg.odds.value);
    if (legsWithOdds.length !== legs.length) return null; // All legs must have odds
    
    // Convert all leg odds to decimal
    const decimalOdds = legsWithOdds.map(leg => {
      if (!leg.odds) return null;
      return leg.odds.format === 'decimal' 
        ? leg.odds.value 
        : americanToDecimal(leg.odds.value);
    });
    
    // Check for null values
    if (decimalOdds.some(odds => odds === null)) return null;
    
    // Calculate parlay odds: multiply all decimal odds
    const parlayDecimalOdds = (decimalOdds as number[]).reduce((acc, odds) => acc * odds, 1);
    
    return parlayDecimalOdds;
  };
  
  // Auto-update parlay odds when leg odds change
  useEffect(() => {
    if (isParlay && parlayLegs.length >= 2) {
      const calculatedOdds = calculateParlayOdds(parlayLegs);
      if (calculatedOdds !== null) {
        // Update odds value based on current format
        if (oddsFormat === 'decimal') {
          setOddsValue(calculatedOdds);
        } else {
          // Convert to American using the utility function
          const american = decimalToAmerican(calculatedOdds);
          setOddsValue(Math.round(american));
        }
      }
    }
  }, [parlayLegs, isParlay, oddsFormat]);
  
  // Search for games
  const searchGames = async (query: string) => {
    if (!query || query.trim().length === 0) {
      setGameResults([]);
      return;
    }
    
    setSearchingGames(true);
    try {
      const response = await apiRequest(`/api/games/search?q=${encodeURIComponent(query)}`, { userId, companyId });
      if (!response.ok) throw new Error('Failed to search games');
      const data = await response.json();
      setGameResults(data.games || []);
    } catch (error) {
      console.error('Error searching games:', error);
      setGameResults([]);
    } finally {
      setSearchingGames(false);
    }
  };

  // Handle game selection
  const handleGameSelect = (game: Game | null) => {
    setSelectedGame(game);
    // Reset selection when game changes
    setSelection('');
    setPlayerName('');
    setSelectedPlayer(null);
    setPlayerResults([]);
    setStatType(''); // Reset prop type when game changes
    if (game) {
      // Auto-fill form fields from selected game
      // Fields are already in game object
    }
  };

  // Search for players
  const searchPlayers = async (query: string) => {
    if (!selectedGame || marketType !== 'Player Prop') {
      setPlayerResults([]);
      return;
    }

    const normalizedQuery = query?.trim() ?? '';

    setSearchingPlayers(true);
    try {
      const params = new URLSearchParams({ q: normalizedQuery });

      // If a game is selected, try to filter by teams
      // Include both teams in search (comma-separated)
      const teams: string[] = [];
      if (selectedGame.homeTeam) teams.push(selectedGame.homeTeam);
      if (selectedGame.awayTeam) teams.push(selectedGame.awayTeam);
      if (teams.length > 0) {
        params.append('team', teams.join(','));
      }
      if (selectedGame.homeTeam) {
        params.append('homeTeam', selectedGame.homeTeam);
      }
      if (selectedGame.awayTeam) {
        params.append('awayTeam', selectedGame.awayTeam);
      }
      if (selectedGame.providerEventId) {
        params.append('eventId', selectedGame.providerEventId);
      }
      if (selectedGame.league) {
        params.append('league', selectedGame.league);
      }
      if (selectedGame.sportKey) {
        params.append('sportKey', selectedGame.sportKey);
      } else if (selectedGame.sport) {
        const sportMap: Record<string, string> = {
          NFL: 'nfl',
          NBA: 'nba',
          MLB: 'mlb',
          NHL: 'nhl',
          NCAAF: 'ncaaf',
          NCAAB: 'ncaab',
        };
        const sportKey = sportMap[selectedGame.sport] || selectedGame.sport.toLowerCase();
        params.append('sport', sportKey);
      }
      if (marketType === 'Player Prop') {
        // Don't require props - show all players for the selected game
        // params.append('requireProps', 'true'); // Removed - user wants all players to show
        if (selectedGame.startTime) {
          params.append('gameStart', selectedGame.startTime);
        }
      }

      const response = await apiRequest(`/api/players/search?${params.toString()}`, { userId, companyId });
      if (!response.ok) throw new Error('Failed to search players');
      const data = await response.json();
      setPlayerResults(data.players || []);
    } catch (error) {
      console.error('Error searching players:', error);
      setPlayerResults([]);
    } finally {
      setSearchingPlayers(false);
    }
  }; 

  // Validate game support when Player Prop is selected
  useEffect(() => {
    if (marketType === 'Player Prop' && selectedGame) {
      const sportKey = selectedGame.sportKey;
      if (!isSportSupportedForPlayerProps(sportKey)) {
        toast.showError(
          'This game is not supported by SportsData.io for player props. ' +
          'Please search for a game from NFL, CFB, CBB, NBA, NHL, or MLB.'
        );
        // Clear game selection and search query
        setSelectedGame(null);
        setGameSearchQuery('');
        setPlayerName('');
        setSelectedPlayer(null);
        setPlayerResults([]);
        setStatType('');
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketType, selectedGame]);

  // Debounced player search
  useEffect(() => {
    if (!selectedGame || marketType !== 'Player Prop') {
      setPlayerResults([]);
      return;
    }

    const timeoutId = setTimeout(() => {
      searchPlayers(playerSearchQuery);
    }, 300);

    return () => clearTimeout(timeoutId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerSearchQuery, selectedGame, marketType]);

  // Calculate preview values
  const calculatePreview = () => {
    if (typeof oddsValue !== 'number' || typeof units !== 'number') {
      return null;
    }

    const decimalOdds = oddsFormat === 'decimal' 
      ? oddsValue 
      : americanToDecimal(oddsValue);
    
    const profit = units * (decimalOdds - 1);
    const totalReturn = units * decimalOdds;

    return { profit, totalReturn };
  };

  const preview = calculatePreview();

  // Handle form submission
  const handleSubmit = async () => {
    // Validation
    if (!selectedGame || (!selectedGame.homeTeam || !selectedGame.awayTeam || !selectedGame.startTime)) {
      toast.showError('Please select a game or enter game details');
      return;
    }

    if (typeof oddsValue !== 'number') {
      toast.showError('Please enter odds');
      return;
    }

    if (typeof units !== 'number') {
      toast.showError('Please enter units');
      return;
    }

    if (units > 2) {
      toast.showError('Maximum bet is 2 units');
      return;
    }

    // Validation for parlay vs single
    if (isParlay) {
      if (parlayLegs.length < 2) {
        toast.showError('Parlay must have at least 2 legs');
        return;
      }
    } else {
      // Single bet validations
    if (marketType === 'ML' && !selection) {
      toast.showError('Please select a team');
      return;
    }
    if (marketType === 'Spread' && (!selection || typeof line !== 'number')) {
      toast.showError('Please select a team and enter the line');
      return;
    }
    if (marketType === 'Total' && (typeof line !== 'number' || !overUnder)) {
      toast.showError('Please enter the line and select Over/Under');
      return;
    }
    if (marketType === 'Player Prop' && (!playerName || !statType || typeof line !== 'number' || !overUnder)) {
      toast.showError('Please fill in all player prop fields');
      return;
    }
    }

    setSubmitting(true);
    try {
      if (typeof oddsValue === 'string' || typeof units === 'string') {
        toast.showError('Invalid odds or units value');
        return;
      }

      const gameData: Game = selectedGame || {
        homeTeam: '',
        awayTeam: '',
        startTime: new Date().toISOString(),
      };

      // Build market object
      const parlaySummaryText = isParlay
        ? parlayLegs.map((leg) => leg.label).filter(Boolean).join(' + ')
        : '';
      const market: Record<string, unknown> = isParlay
        ? { marketType: 'Parlay', parlaySummary: parlaySummaryText }
        : { marketType };

      if (!isParlay) {
        if (marketType === 'ML') Object.assign(market, { selection });
        if (marketType === 'Spread') Object.assign(market, { selection, line });
        if (marketType === 'Total') Object.assign(market, { line, overUnder });
        if (marketType === 'Player Prop') {
          Object.assign(market, {
            playerName,
            playerId: selectedPlayer?.id,
            playerKey: selectedPlayer?.playerKey,
            statType,
            line,
            overUnder,
          });
        }
      }

      const payload = {
        selectedWebhookIds,
        game: {
          provider: gameData.provider,
          providerEventId: gameData.providerEventId,
          sport: gameData.sport,
          sportKey: gameData.sportKey, // Include sportKey for auto-settlement
          league: gameData.league,
          homeTeam: gameData.homeTeam,
          awayTeam: gameData.awayTeam,
          homeTeamId: gameData.homeTeamId,
          awayTeamId: gameData.awayTeamId,
          startTime: gameData.startTime,
        },
        market,
        ...(isParlay && {
          parlay: {
            legs: parlayLegs.map((l) => ({
              game: l.game,
              market: l.market,
              label: l.label,
              ...(l.odds && typeof l.odds.value === 'number' && l.odds.format && { 
                odds: { 
                  oddsFormat: l.odds.format, 
                  oddsValue: l.odds.value 
                } 
              }),
            })),
          },
        }),
        ...(selectedWebhookIds.length > 0 && { selectedWebhookIds }),
        odds: {
          oddsFormat,
          oddsValue: oddsValue as number,
        },
        units: units as number,
        ...(book && { book }),
        ...(notes && { notes }),
        ...(slipImageUrl && { slipImageUrl }),
      };

      const response = await apiRequest('/api/bets', { userId, companyId, method: 'POST', body: JSON.stringify(payload) });
      if (!response.ok) {
        const error = await response.json() as { error: string };
        toast.showError(error.error || 'Failed to create bet');
        return;
      }

      // Reset form
      setSelectedGame(null);
      setGameSearchQuery('');
      setMarketType('ML');
      setSelection('');
      setLine('');
      setOverUnder('');
      setPlayerName('');
      setStatType('');
      // parlaySummary removed - computed from parlayLegs
      setOddsValue('');
      setUnits('');
      setBook('');
      setNotes('');
      setSlipImageUrl('');
      setShowAdvanced(false);
      setSelectedPlayer(null);
      setSelectedWebhookIds([]);
      setPlayerSearchQuery('');
      setPlayerResults([]);

      toast.showSuccess('Bet created successfully!');
      onSuccess();
      onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create bet';
      toast.showError(message);
    } finally {
      setSubmitting(false);
    }
  };

  // Get available teams from selected game
  const getAvailableTeams = (): string[] => {
    if (!selectedGame || !selectedGame.homeTeam || !selectedGame.awayTeam) {
      return [];
    }
    return [selectedGame.awayTeam, selectedGame.homeTeam];
  };

  const availableTeams = getAvailableTeams();

  // Render market-specific inputs
  const renderMarketInputs = () => {
    switch (marketType) {
      case 'ML':
        return (
          <FormControl fullWidth required>
            <InputLabel sx={{ color: 'var(--text-muted)' }}>Team</InputLabel>
            <Select
            value={selection}
            onChange={(e) => setSelection(e.target.value)}
              label="Team"
              disabled={!selectedGame || availableTeams.length === 0}
              MenuProps={{
                PaperProps: {
                  sx: {
                    backgroundColor: controlBg,
                    '& .MuiMenuItem-root': {
                      color: 'var(--app-text)',
                      '&:hover': {
                        backgroundColor: alpha(theme.palette.primary.main, 0.1),
                      },
                      '&.Mui-selected': {
                        backgroundColor: alpha(theme.palette.primary.main, 0.2),
                        color: 'var(--app-text)',
                        '&:hover': {
                          backgroundColor: alpha(theme.palette.primary.main, 0.3),
                        },
                      },
                    },
                  },
                },
              }}
            sx={{
                color: 'var(--app-text)',
                backgroundColor: controlBg,
                '& .MuiOutlinedInput-notchedOutline': { borderColor: controlBorder },
                '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: theme.palette.primary.main },
                '&.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: theme.palette.primary.main },
                '&.Mui-disabled': { color: alpha(theme.palette.text.primary, 0.38), backgroundColor: alpha(theme.palette.text.primary, 0.04) },
            }}
            >
              {availableTeams.map((team) => (
                <MenuItem key={team} value={team} sx={{ color: 'var(--app-text)' }}>
                  {team}
                </MenuItem>
              ))}
            </Select>
            {!selectedGame && (
              <Typography variant="caption" sx={{ color: 'var(--text-muted)', mt: 0.5 }}>
                Please select a game first
              </Typography>
            )}
          </FormControl>
        );
      
      case 'Spread':
        return (
          <Box sx={{ display: 'flex', gap: 2, flexDirection: { xs: 'column', sm: 'row' } }}>
            <FormControl fullWidth required>
              <InputLabel sx={{ color: 'var(--text-muted)' }}>Team</InputLabel>
              <Select
              value={selection}
              onChange={(e) => setSelection(e.target.value)}
                label="Team"
                disabled={!selectedGame || availableTeams.length === 0}
                MenuProps={{
                  PaperProps: {
                    sx: {
                      backgroundColor: controlBg,
                      '& .MuiMenuItem-root': {
                        color: 'var(--app-text)',
                        '&:hover': {
                          backgroundColor: alpha(theme.palette.primary.main, 0.1),
                        },
                        '&.Mui-selected': {
                          backgroundColor: alpha(theme.palette.primary.main, 0.2),
                          color: 'var(--app-text)',
                          '&:hover': {
                            backgroundColor: alpha(theme.palette.primary.main, 0.3),
                          },
                        },
                      },
                    },
                  },
                }}
              sx={{
                  color: 'var(--app-text)',
                  backgroundColor: controlBg,
                  '& .MuiOutlinedInput-notchedOutline': { borderColor: controlBorder },
                  '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: theme.palette.primary.main },
                  '&.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: theme.palette.primary.main },
                  '&.Mui-disabled': { color: alpha(theme.palette.text.primary, 0.38), backgroundColor: alpha(theme.palette.text.primary, 0.04) },
              }}
              >
                {availableTeams.map((team) => (
                  <MenuItem key={team} value={team} sx={{ color: 'var(--app-text)' }}>
                    {team}
                  </MenuItem>
                ))}
              </Select>
              {!selectedGame && (
                <Typography variant="caption" sx={{ color: 'var(--text-muted)', mt: 0.5 }}>
                  Please select a game first
                </Typography>
              )}
            </FormControl>
            <TextField
              fullWidth
              label="Line *"
              type="number"
              value={line}
              onChange={(e) => setLine(e.target.value ? parseFloat(e.target.value) : '')}
              required
              inputProps={{ step: 0.5 }}
              sx={{
                '& .MuiOutlinedInput-root': { color: 'var(--app-text)', backgroundColor: controlBg },
                '& .MuiInputLabel-root': { color: 'var(--text-muted)' },
                '& fieldset': { borderColor: controlBorder },
              }}
            />
          </Box>
        );
      
      case 'Total':
        return (
          <Box sx={{ display: 'flex', gap: 2, flexDirection: { xs: 'column', sm: 'row' } }}>
            <TextField
              fullWidth
              label="Line *"
              type="number"
              value={line}
              onChange={(e) => setLine(e.target.value ? parseFloat(e.target.value) : '')}
              required
              inputProps={{ step: 0.5 }}
              sx={{
                '& .MuiOutlinedInput-root': { color: 'var(--app-text)', backgroundColor: controlBg },
                '& .MuiInputLabel-root': { color: 'var(--text-muted)' },
                '& fieldset': { borderColor: controlBorder },
              }}
            />
            <FormControl fullWidth required>
              <InputLabel sx={{ color: 'var(--text-muted)' }}>Over/Under</InputLabel>
              <Select
                value={overUnder}
                onChange={(e) => setOverUnder(e.target.value as 'Over' | 'Under')}
                label="Over/Under"
                MenuProps={{
                  PaperProps: {
                    sx: {
                      backgroundColor: controlBg,
                      '& .MuiMenuItem-root': {
                        color: 'var(--app-text)',
                        '&:hover': {
                          backgroundColor: alpha(theme.palette.primary.main, 0.1),
                        },
                        '&.Mui-selected': {
                          backgroundColor: alpha(theme.palette.primary.main, 0.2),
                          color: 'var(--app-text)',
                          '&:hover': {
                            backgroundColor: alpha(theme.palette.primary.main, 0.3),
                          },
                        },
                      },
                    },
                  },
                }}
                sx={{
                  color: 'var(--app-text)',
                  backgroundColor: controlBg,
                  '& .MuiOutlinedInput-notchedOutline': { borderColor: controlBorder },
                  '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: theme.palette.primary.main },
                  '&.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: theme.palette.primary.main },
                }}
              >
                <MenuItem value="Over" sx={{ color: 'var(--app-text)' }}>Over</MenuItem>
                <MenuItem value="Under" sx={{ color: 'var(--app-text)' }}>Under</MenuItem>
              </Select>
            </FormControl>
          </Box>
        );
      
      case 'Player Prop':
        return (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {!selectedGame && (
              <Typography variant="caption" sx={{ color: theme.palette.warning.main, mb: -1 }}>
                Please select a game first to search players
              </Typography>
            )}
            <Autocomplete
              options={playerResults}
              getOptionLabel={(option) => {
                if (typeof option === 'string') return option;
                return `${option.name}${option.team ? ` (${option.team})` : ''}${option.position ? ` - ${option.position}` : ''}`;
              }}
              value={selectedPlayer}
              onChange={(_, newValue) => {
                setSelectedPlayer(newValue);
                setPlayerName(newValue ? newValue.name : '');
              }}
              onInputChange={(_, newInputValue) => {
                setPlayerSearchQuery(newInputValue);
              }}
              onOpen={() => {
                if (selectedGame && marketType === 'Player Prop' && playerResults.length === 0) {
                  searchPlayers(playerSearchQuery);
                }
              }}
              inputValue={playerSearchQuery}
              loading={searchingPlayers}
              disabled={!selectedGame}
              filterOptions={(x) => x} // Disable client-side filtering, we do it server-side
              renderInput={(params) => (
            <TextField
                  {...params}
              label="Player Name *"
              required
                  placeholder={selectedGame ? "Search for a player..." : "Select a game first"}
              sx={{
                '& .MuiOutlinedInput-root': { color: 'var(--app-text)', backgroundColor: controlBg },
                '& .MuiInputLabel-root': { color: 'var(--text-muted)' },
                '& fieldset': { borderColor: controlBorder },
                    '&.Mui-disabled': {
                      backgroundColor: alpha(theme.palette.background.paper, 0.05),
                    },
                  }}
                  InputProps={{
                    ...params.InputProps,
                    startAdornment: (
                      <>
                        <InputAdornment position="start">
                          <SearchIcon sx={{ color: theme.palette.primary.main }} />
                        </InputAdornment>
                        {params.InputProps.startAdornment}
                      </>
                    ),
                    endAdornment: (
                      <>
                        {searchingPlayers ? <CircularProgress size={20} sx={{ color: theme.palette.primary.main }} /> : null}
                        {params.InputProps.endAdornment}
                      </>
                    ),
                  }}
                />
              )}
              renderOption={(props, option) => (
                <Box component="li" {...props} key={option.id}>
                  <Box>
                    <Typography sx={{ color: 'var(--app-text)', fontWeight: 600 }}>
                      {option.name}
                    </Typography>
                    <Typography variant="caption" sx={{ color: 'var(--text-muted)' }}>
                      {option.position}{option.team ? ` • ${option.team}` : ''}{option.number ? ` • #${option.number}` : ''}
                    </Typography>
                  </Box>
                </Box>
              )}
            />
            <FormControl fullWidth required>
              <InputLabel sx={{ color: 'var(--text-muted)' }}>Prop Type</InputLabel>
              <Select
              value={statType}
              onChange={(e) => setStatType(e.target.value)}
                label="Prop Type"
                disabled={!selectedGame}
                MenuProps={{
                  PaperProps: {
                    sx: {
                      backgroundColor: controlBg,
                      '& .MuiMenuItem-root': {
                        color: 'var(--app-text)',
                        '&:hover': {
                          backgroundColor: alpha(theme.palette.primary.main, 0.1),
                        },
                        '&.Mui-selected': {
                          backgroundColor: alpha(theme.palette.primary.main, 0.2),
                          color: 'var(--app-text)',
                          '&:hover': {
                            backgroundColor: alpha(theme.palette.primary.main, 0.3),
                          },
                        },
                      },
                    },
                  },
                }}
              sx={{
                  color: 'var(--app-text)',
                  backgroundColor: controlBg,
                  '& .MuiOutlinedInput-notchedOutline': { borderColor: controlBorder },
                  '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: theme.palette.primary.main },
                  '&.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: theme.palette.primary.main },
                  '&.Mui-disabled': {
                    backgroundColor: 'rgba(0, 0, 0, 0.04)',
                    color: 'rgba(0, 0, 0, 0.38)',
                  },
              }}
              >
                {selectedGame ? (
                  getPropTypesForSport(selectedGame.sportKey, selectedGame.sport).map((propType) => (
                    <MenuItem key={propType} value={propType} sx={{ color: 'var(--app-text)' }}>
                      {propType}
                    </MenuItem>
                  ))
                ) : (
                  <MenuItem disabled value="" sx={{ color: 'var(--text-muted)' }}>
                    Select a game first
                  </MenuItem>
                )}
              </Select>
              {!selectedGame && (
                <Typography variant="caption" sx={{ color: 'var(--text-muted)', mt: 0.5 }}>
                  Please select a game first to see available prop types
                </Typography>
              )}
            </FormControl>
            <Box sx={{ display: 'flex', gap: 2, flexDirection: { xs: 'column', sm: 'row' } }}>
              <TextField
                fullWidth
                label="Line *"
                type="number"
                value={line}
                onChange={(e) => setLine(e.target.value ? parseFloat(e.target.value) : '')}
                required
                inputProps={{ step: 0.5 }}
                sx={{
                  '& .MuiOutlinedInput-root': { color: 'var(--app-text)', backgroundColor: controlBg },
                  '& .MuiInputLabel-root': { color: 'var(--text-muted)' },
                  '& fieldset': { borderColor: controlBorder },
                }}
              />
              <FormControl fullWidth required>
                <InputLabel sx={{ color: 'var(--text-muted)' }}>Over/Under</InputLabel>
                <Select
                  value={overUnder}
                  onChange={(e) => setOverUnder(e.target.value as 'Over' | 'Under')}
                  label="Over/Under"
                  sx={{
                    color: 'var(--app-text)',
                    '& .MuiOutlinedInput-notchedOutline': { borderColor: alpha(theme.palette.primary.main, 0.3) },
                  }}
                >
                  <MenuItem value="Over">Over</MenuItem>
                  <MenuItem value="Under">Under</MenuItem>
                </Select>
              </FormControl>
            </Box>
          </Box>
        );
      
      default:
        return null;
    }
  };

  // Format current selection into a parlay leg string
  const formatCurrentLeg = (): { label: string; game: Game; market: ParlayLegLocal['market'] } | null => {
    if (!selectedGame) return null;
    if (marketType === 'ML') {
      if (!selection) return null;
      return {
        label: `${selection} ML`,
        game: selectedGame,
        market: { marketType: 'ML', selection },
      };
    }
    if (marketType === 'Spread') {
      if (!selection || typeof line !== 'number') return null;
      const sign = line > 0 ? '+' : '';
      return {
        label: `${selection} ${sign}${line}`,
        game: selectedGame,
        market: { marketType: 'Spread', selection, line },
      };
    }
    if (marketType === 'Total') {
      if (!overUnder || typeof line !== 'number') return null;
      return {
        label: `${overUnder} ${line}`,
        game: selectedGame,
        market: { marketType: 'Total', line, overUnder },
      };
    }
    if (marketType === 'Player Prop') {
      if (!playerName || !statType || typeof line !== 'number' || !overUnder) return null;
      return {
        label: `${playerName} ${statType} ${overUnder} ${line}`,
        game: selectedGame,
        market: {
          marketType: 'Player Prop',
          playerName,
          playerId: selectedPlayer?.id,
          playerKey: selectedPlayer?.playerKey,
          statType,
          line,
          overUnder,
        },
      };
    }
    return null;
  };
  
  // State for leg odds input
  const [legOddsInputs, setLegOddsInputs] = useState<Record<number, { format: OddsFormat; value: number | '' }>>({});
  
  // Update leg odds when adding to parlay
  const handleLegOddsChange = (legIndex: number, format: OddsFormat, value: number | '') => {
    setLegOddsInputs(prev => ({
      ...prev,
      [legIndex]: { format, value },
    }));
    
    // Update the leg with odds
    setParlayLegs(prev => prev.map((leg, idx) => 
      idx === legIndex 
        ? { ...leg, odds: value !== '' ? { format, value: value as number } : undefined }
        : leg
    ));
  };

  const handleAddParlayLeg = () => {
    const leg = formatCurrentLeg();
    if (!leg) {
      toast.showError('Please complete the current selection before adding a leg');
      return;
    }
    setParlayLegs((prev) => [...prev, leg]);
    // parlaySummary is computed from parlayLegs when creating bet
    // Reset market-specific fields for next leg
    setSelection('');
    setLine('');
    setOverUnder('');
    setPlayerName('');
    setStatType('');
    setSelectedPlayer(null);
    setPlayerSearchQuery('');
    setPlayerResults([]);
  };

  return (
    <Dialog 
      open={open} 
      onClose={onClose} 
      maxWidth="md" 
      fullWidth
      PaperProps={{
        sx: { 
          borderRadius: 2,
          bgcolor: 'var(--surface-bg)',
          backdropFilter: 'blur(20px)',
          border: '1px solid var(--surface-border)',
          boxShadow: theme.palette.mode === 'light'
            ? '0 12px 32px rgba(34, 197, 94, 0.08)'
            : '0 12px 32px rgba(0, 0, 0, 0.45)',
        }
      }}
    >
      <DialogTitle
        sx={{ 
        bgcolor: alpha(theme.palette.primary.main, isDark ? 0.15 : 0.08),
        borderBottom: `1px solid ${alpha(theme.palette.divider, 0.5)}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 2,
        }}
      >
        <Box display="flex" alignItems="center" gap={1}>
          <AddIcon sx={{ color: theme.palette.primary.main }} />
          <Typography variant="h6" fontWeight={600} sx={{ color: 'var(--app-text)' }}>
            Create New Bet
          </Typography>
        </Box>
        <FormControlLabel
          control={
            <Switch
              checked={isParlay}
              onChange={(_, checked) => {
                setIsParlay(checked);
                if (!checked) {
                  setParlayLegs([]);
                  // parlaySummary removed - computed from parlayLegs
                }
              }}
              sx={{
                '& .MuiSwitch-switchBase.Mui-checked': { color: theme.palette.primary.main },
                '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': { backgroundColor: theme.palette.primary.main },
                '& .MuiSwitch-track': { backgroundColor: alpha(theme.palette.primary.main, 0.3) },
              }}
            />
          }
          label={
            <Typography sx={{ color: 'var(--app-text)' }}>
              Parlay
            </Typography>
          }
          sx={{ margin: 0, alignSelf: 'flex-start' }}
        />
      </DialogTitle>
      
      <DialogContent sx={{ 
        bgcolor: alpha(theme.palette.background.paper, 0.95),
      }}>
        <Box sx={{ mt: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
          {/* Game Selection */}
          <Box>
            <Typography variant="subtitle2" sx={{ color: 'var(--app-text)', mb: 1, fontWeight: 600 }}>
              Game *
            </Typography>
            <Autocomplete
              options={gameResults}
              loading={searchingGames}
              onInputChange={(_, value) => {
                setGameSearchQuery(value);
                searchGames(value);
              }}
              onChange={(_, value) => handleGameSelect(value)}
              value={selectedGame}
              getOptionLabel={(option) => {
                if (option.homeTeam && option.awayTeam) {
                  return `${option.awayTeam} @ ${option.homeTeam}`;
                }
                return gameSearchQuery;
              }}
              ListboxProps={{
                sx: {
                  backgroundColor: controlBg,
                  '& .MuiAutocomplete-option': {
                    color: 'var(--app-text)',
                    '&:hover': {
                      backgroundColor: alpha(theme.palette.primary.main, 0.1),
                    },
                    '&[aria-selected="true"]': {
                      backgroundColor: alpha(theme.palette.primary.main, 0.2),
                    },
                  },
                },
              }}
              PaperComponent={(props) => (
                <Paper {...props} sx={{ backgroundColor: controlBg, color: 'var(--app-text)', border: '1px solid alpha(theme.palette.primary.main, 0.2)' }} />
              )}
              renderInput={(params) => (
                <TextField
                  {...params}
                  placeholder="Search for a game..."
                  InputProps={{
                    ...params.InputProps,
                    startAdornment: (
                      <>
                        <InputAdornment position="start">
                          <SearchIcon sx={{ color: theme.palette.primary.main }} />
                        </InputAdornment>
                        {params.InputProps.startAdornment}
                      </>
                    ),
                    endAdornment: (
                      <>
                        {searchingGames ? <CircularProgress size={20} sx={{ color: theme.palette.primary.main }} /> : null}
                        {params.InputProps.endAdornment}
                      </>
                    ),
                  }}
                  sx={{
                    '& .MuiOutlinedInput-root': { color: 'var(--app-text)', backgroundColor: controlBg },
                    '& .MuiInputLabel-root': { color: 'var(--text-muted)' },
                    '& fieldset': { borderColor: controlBorder },
                    '& input': { color: 'var(--app-text)' },
                  }}
                />
              )}
              renderOption={(props, option) => (
                <Box component="li" {...props} sx={{ color: 'var(--app-text)' }}>
                  <Box>
                    <Typography sx={{ fontWeight: 600, color: 'var(--app-text)' }}>
                      {option.awayTeam} @ {option.homeTeam}
                    </Typography>
                    <Typography variant="caption" sx={{ color: 'var(--text-muted)' }}>
                      {option.league} • {new Date(option.startTime).toLocaleString()}
                    </Typography>
                  </Box>
                </Box>
              )}
            />
            {selectedGame && (
              <Box sx={{ mt: 1, display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                {selectedGame.league && <Chip label={selectedGame.league} size="small" sx={{ bgcolor: 'rgba(34, 197, 94, 0.2)', color: 'var(--app-text)' }} />}
                {selectedGame.provider && <Chip label={selectedGame.provider} size="small" sx={{ bgcolor: 'rgba(34, 197, 94, 0.2)', color: 'var(--app-text)' }} />}
              </Box>
            )}
          </Box>

          {/* Market Type Selection */}
          <Box>
            <Typography variant="subtitle2" sx={{ color: 'var(--app-text)', mb: 1, fontWeight: 600 }}>
              Market & Selection *
            </Typography>

            <FormControl fullWidth>
              <InputLabel sx={{ color: 'var(--text-muted)' }}>Market Type *</InputLabel>
              <Select
                value={marketType}
                onChange={(e) => {
                  setMarketType(e.target.value as MarketType);
                  // Reset market-specific fields
                  setSelection('');
                  setLine('');
                  setOverUnder('');
                  setPlayerName('');
                  setStatType('');
                  // parlaySummary removed - computed from parlayLegs
                  setSelectedPlayer(null);
                  setPlayerSearchQuery('');
                  setPlayerResults([]);
                }}
                label="Market Type *"
                MenuProps={{
                  PaperProps: {
                    sx: {
                      backgroundColor: controlBg,
                      '& .MuiMenuItem-root': {
                        color: 'var(--app-text)',
                        '&:hover': {
                          backgroundColor: alpha(theme.palette.primary.main, 0.1),
                        },
                        '&.Mui-selected': {
                          backgroundColor: alpha(theme.palette.primary.main, 0.2),
                          color: 'var(--app-text)',
                          '&:hover': {
                            backgroundColor: alpha(theme.palette.primary.main, 0.3),
                          },
                        },
                      },
                    },
                  },
                }}
                sx={{
                  color: 'var(--app-text)',
                  backgroundColor: controlBg,
                  '& .MuiOutlinedInput-notchedOutline': { borderColor: controlBorder },
                  '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: theme.palette.primary.main },
                  '&.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: theme.palette.primary.main },
                }}
              >
                <MenuItem value="ML" sx={{ color: 'var(--app-text)' }}>Moneyline (ML)</MenuItem>
                <MenuItem value="Spread" sx={{ color: 'var(--app-text)' }}>Spread</MenuItem>
                <MenuItem value="Total" sx={{ color: 'var(--app-text)' }}>Total (Over/Under)</MenuItem>
                <MenuItem value="Player Prop" sx={{ color: 'var(--app-text)' }}>Player Prop</MenuItem>
              </Select>
            </FormControl>
            
            <Box sx={{ mt: 2 }}>
              {renderMarketInputs()}
            </Box>

            {/* Parlay builder controls */}
            {isParlay && (
              <Box sx={{ mt: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>
                <Box sx={{ display: 'flex', gap: 1 }}>
                  <Button
                    size="small"
                    startIcon={<AddIcon />}
                    onClick={handleAddParlayLeg}
                    sx={{
                      textTransform: 'none',
                      borderColor: alpha(theme.palette.primary.main, 0.3),
                      color: 'var(--app-text)',
                      border: `1px solid ${alpha(theme.palette.primary.main, 0.3)}`,
                    }}
                  >
                    Add Leg
                  </Button>
                  <Button
                    size="small"
                    onClick={() => {
                      setParlayLegs([]);
                      // parlaySummary removed - computed from parlayLegs
                    }}
                    sx={{ textTransform: 'none', color: 'var(--text-muted)' }}
                  >
                    Clear Legs
                  </Button>
                </Box>
                {parlayLegs.length > 0 && (
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 2 }}>
                    {parlayLegs.map((leg, idx) => {
                      const legOdds = legOddsInputs[idx] || { format: oddsFormat, value: '' };
                      return (
                        <Box
                          key={`leg-${idx}`}
                          sx={{
                            p: 2,
                            border: '1px solid alpha(theme.palette.primary.main, 0.3)',
                            borderRadius: 2,
                            bgcolor: alpha(theme.palette.primary.main, isDark ? 0.25 : 0.1),
                          }}
                        >
                          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
                            <Typography variant="body2" sx={{ color: 'var(--app-text)', fontWeight: 600 }}>
                              Leg {idx + 1}: {leg.label}
                            </Typography>
                            <Button
                              size="small"
                              onClick={() => {
                                const next = parlayLegs.filter((_, i) => i !== idx);
                                setParlayLegs(next);
                                const nextOdds = { ...legOddsInputs };
                                delete nextOdds[idx];
                                setLegOddsInputs(nextOdds);
                              }}
                              sx={{ color: theme.palette.error.main, minWidth: 'auto', p: 0.5 }}
                            >
                              Remove
                            </Button>
                          </Box>
                          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                            <FormControl size="small" sx={{ minWidth: 100 }}>
                              <InputLabel sx={{ color: 'var(--text-muted)' }}>Format</InputLabel>
                              <Select
                                value={legOdds.format}
                                onChange={(e) => handleLegOddsChange(idx, e.target.value as OddsFormat, legOdds.value)}
                                label="Format"
                                sx={{
                                  color: 'var(--app-text)',
                                  '& .MuiOutlinedInput-notchedOutline': { borderColor: alpha(theme.palette.primary.main, 0.3) },
                                }}
                              >
                                <MenuItem value="american">American</MenuItem>
                                <MenuItem value="decimal">Decimal</MenuItem>
                              </Select>
                            </FormControl>
                            <TextField
                              size="small"
                              label="Odds"
                              type="number"
                              value={legOdds.value}
                              onChange={(e) => {
                                const val = e.target.value ? parseFloat(e.target.value) : '';
                                handleLegOddsChange(idx, legOdds.format, val);
                              }}
                              sx={{
                                flex: 1,
                                '& .MuiOutlinedInput-root': { color: 'var(--app-text)', backgroundColor: controlBg },
                                '& .MuiInputLabel-root': { color: 'var(--text-muted)' },
                                '& fieldset': { borderColor: controlBorder },
                              }}
                            />
                          </Box>
                        </Box>
                      );
                    })}
                    {parlayLegs.length >= 2 && (
                      <Box sx={{ mt: 1, p: 1.5, bgcolor: 'rgba(34, 197, 94, 0.1)', borderRadius: 1, border: '1px solid rgba(34, 197, 94, 0.3)' }}>
                        <Typography variant="body2" sx={{ color: theme.palette.primary.main, fontWeight: 600 }}>
                          Total Parlay Odds: {oddsValue !== '' 
                            ? (oddsFormat === 'american' 
                              ? formatOdds(americanToDecimal(oddsValue as number), oddsFormat)
                              : formatOdds(oddsValue as number, oddsFormat))
                            : 'Enter odds for all legs'}
                        </Typography>
                        {oddsValue !== '' && oddsFormat === 'american' && (
                          <Typography variant="caption" sx={{ color: 'var(--text-muted)', mt: 0.5, display: 'block' }}>
                            Enter this value in the Odds field below: {formatOdds(americanToDecimal(oddsValue as number), oddsFormat)}
                          </Typography>
                        )}
                      </Box>
                    )}
                  </Box>
                )}
              </Box>
            )}
          </Box>

          {/* Odds & Stake */}
          <Box>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
              <Typography variant="subtitle2" sx={{ color: 'var(--app-text)', fontWeight: 600 }}>
                Odds *
              </Typography>
              <FormControlLabel
                control={
                  <Switch
                    checked={oddsFormat === 'decimal'}
                    onChange={(e) => setOddsFormat(e.target.checked ? 'decimal' : 'american')}
                    sx={{
                      '& .MuiSwitch-switchBase': {
                      '&.Mui-checked': {
                        color: theme.palette.primary.main,
                        '& + .MuiSwitch-track': {
                          backgroundColor: theme.palette.primary.main,
                        },
                      },
                    },
                    '& .MuiSwitch-track': {
                      backgroundColor: alpha(theme.palette.primary.main, 0.3),
                        borderRadius: 12,
                      },
                      '& .MuiSwitch-thumb': {
                        borderRadius: '50%',
                      },
                    }}
                  />
                }
                label={
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography
                      variant="body2"
                      sx={{
                        color: oddsFormat === 'american' ? theme.palette.primary.main : 'var(--text-muted)',
                        fontWeight: oddsFormat === 'american' ? 600 : 400,
                        transition: 'all 0.3s ease',
                      }}
                    >
                      American
                    </Typography>
                    <Typography
                      variant="body2"
                      sx={{
                        color: oddsFormat === 'decimal' ? theme.palette.primary.main : 'var(--text-muted)',
                        fontWeight: oddsFormat === 'decimal' ? 600 : 400,
                        transition: 'all 0.3s ease',
                      }}
                    >
                      Decimal
                    </Typography>
                  </Box>
                }
                labelPlacement="start"
                sx={{ margin: 0 }}
              />
            </Box>
            <Box sx={{ display: 'flex', gap: 2, flexDirection: { xs: 'column', sm: 'row' } }}>
              <Box sx={{ flex: 1 }}>
                <TextField
                  fullWidth
                  label={oddsFormat === 'american' ? 'Odds (e.g., -150 or +180)' : 'Odds (e.g., 2.0 or 1.5)'}
                  type="number"
                  value={oddsValue}
                  onChange={(e) => {
                    const val = e.target.value;
                    setOddsValue(val ? parseFloat(val) : '');
                  }}
                  required
                  InputProps={{
                    startAdornment: (
                      <InputAdornment position="start">
                        <TrendingUpIcon sx={{ color: theme.palette.primary.main }} />
                      </InputAdornment>
                    ),
                  }}
                  helperText={
                    oddsFormat === 'american' 
                      ? typeof oddsValue === 'number'
                        ? `Formatted value: ${formatOdds(americanToDecimal(oddsValue), 'american')} (enter ${oddsValue > 0 ? Math.abs(oddsValue) : oddsValue} in the field)`
                        : 'Enter -150 (favorite) or 180 (underdog - positive odds, + sign is implied)'
                      : 'Enter 2.0 (even) or 1.5 (favorite)'
                  }
                  sx={{
                    '& .MuiOutlinedInput-root': { color: 'var(--app-text)', backgroundColor: controlBg },
                    '& .MuiInputLabel-root': { color: 'var(--text-muted)' },
                    '& .MuiFormHelperText-root': { color: 'var(--text-muted)' },
                    '& fieldset': { borderColor: controlBorder },
                  }}
                />
              </Box>
              
              <Box sx={{ flex: 1 }}>
                <TextField
                  fullWidth
                  label="Stake (Units)"
                  type="number"
                  value={units}
                  onChange={(e) => {
                    const value = e.target.value ? parseFloat(e.target.value) : '';
                    if (value !== '' && value > 2) {
                      setUnits(2);
                      toast.showError('Maximum bet is 2 units');
                    } else {
                      setUnits(value);
                    }
                  }}
                  required
                  inputProps={{ min: 0.01, max: 2, step: 0.01 }}
                  InputProps={{
                    startAdornment: (
                      <InputAdornment position="start">
                        <AttachMoneyIcon sx={{ color: theme.palette.primary.main }} />
                      </InputAdornment>
                    ),
                  }}
                  helperText="Minimum: 0.01 units, Maximum: 2 units"
                  sx={{
                    '& .MuiOutlinedInput-root': { color: 'var(--app-text)', backgroundColor: controlBg },
                    '& .MuiInputLabel-root': { color: 'var(--text-muted)' },
                    '& .MuiFormHelperText-root': { color: 'var(--text-muted)' },
                    '& fieldset': { borderColor: controlBorder },
                  }}
                />
              </Box>
            </Box>
            {typeof oddsValue === 'number' && (
              <Typography variant="caption" sx={{ color: 'var(--text-muted)', mt: 0.5, display: 'block' }}>
                {oddsFormat === 'american' 
                  ? `Decimal: ${americanToDecimal(oddsValue).toFixed(2)}`
                  : `American: ${formatOdds(oddsValue, 'american')}`
                }
              </Typography>
            )}
          </Box>

          {/* Bet Preview */}
          {preview && (
            <>
              <Divider sx={{ borderColor: alpha(theme.palette.primary.main, 0.3) }} />
              <Box sx={{ 
                p: 2, 
                borderRadius: 1,
                backgroundColor: alpha(theme.palette.primary.main, 0.1),
                border: '1px solid alpha(theme.palette.primary.main, 0.3)',
              }}>
                <Typography variant="subtitle2" sx={{ color: 'var(--app-text)', mb: 1, fontWeight: 600 }}>
                  Bet Preview
                </Typography>
                <Box display="flex" justifyContent="space-between" mb={0.5}>
                  <Typography variant="body2" sx={{ color: 'var(--text-muted)' }}>Potential Win:</Typography>
                  <Typography variant="body2" fontWeight={600} sx={{ color: '#10b981' }}>
                    +{preview.profit.toFixed(2)} units
                  </Typography>
                </Box>
                <Box display="flex" justifyContent="space-between">
                  <Typography variant="body2" sx={{ color: 'var(--text-muted)' }}>Total Return:</Typography>
                  <Typography variant="body2" fontWeight={600} sx={{ color: 'var(--app-text)' }}>
                    {preview.totalReturn.toFixed(2)} units
                  </Typography>
                </Box>
              </Box>
            </>
          )}

          {/* Advanced Options */}
          <Box>
            <Button
              onClick={() => setShowAdvanced(!showAdvanced)}
              endIcon={showAdvanced ? <ExpandLessIcon /> : <ExpandMoreIcon />}
              sx={{ color: 'var(--text-muted)', textTransform: 'none' }}
            >
              Advanced Options
            </Button>
            <Collapse in={showAdvanced}>
              <Box sx={{ mt: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
                {/* Webhook Selection - Always allow multiple selection */}
                {userWebhooks.length > 0 && (
                  <Box
                    sx={{
                      border: `1px solid ${alpha(theme.palette.primary.main, 0.2)}`,
                      borderRadius: 2,
                      p: 2,
                      backgroundColor: alpha(theme.palette.primary.main, 0.05),
                    }}
                  >
                    <Typography variant="subtitle2" sx={{ color: 'var(--app-text)', mb: 1, fontWeight: 600 }}>
                      Select Webhooks (Optional)
                    </Typography>
                    <FormGroup>
                      {userWebhooks.map((webhook) => (
                        <FormControlLabel
                          key={webhook.id}
                          control={
                            <Checkbox
                              checked={selectedWebhookIds.includes(webhook.id)}
                              onChange={(_, checked) => handleWebhookSelection(webhook.id, checked)}
                              color="primary"
                            />
                          }
                          label={`${webhook.name} (${webhook.type})`}
                          sx={{ color: 'var(--app-text)' }}
                        />
                      ))}
                    </FormGroup>
                    <Typography variant="caption" sx={{ color: 'var(--text-muted)', mt: 1, display: 'block' }}>
                      Settlement notifications will be sent to every selected webhook.
                    </Typography>
                  </Box>
                )}
                <Autocomplete
                  freeSolo
                  options={['Fanduel', 'DraftKings', 'BetMGM', 'Caesars', 'Fanatics']}
                  value={book}
                  onInputChange={(_, value) => setBook(value)}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      label="Book"
                      placeholder="e.g., Fanduel, DraftKings"
                      sx={{
                        '& .MuiOutlinedInput-root': { color: 'var(--app-text)', backgroundColor: controlBg },
                        '& .MuiInputLabel-root': { color: 'var(--text-muted)' },
                        '& fieldset': { borderColor: controlBorder },
                      }}
                    />
                  )}
                />
                <TextField
                  fullWidth
                  label="Notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  multiline
                  rows={3}
                  placeholder="Add any notes about this bet..."
                  sx={{
                    '& .MuiOutlinedInput-root': { color: 'var(--app-text)', backgroundColor: controlBg },
                    '& .MuiInputLabel-root': { color: 'var(--text-muted)' },
                    '& fieldset': { borderColor: controlBorder },
                  }}
                />
                <TextField
                  fullWidth
                  label="Slip Image URL"
                  value={slipImageUrl}
                  onChange={(e) => setSlipImageUrl(e.target.value)}
                  placeholder="https://..."
                  helperText="URL to uploaded bet slip image"
                  sx={{
                    '& .MuiOutlinedInput-root': { color: 'var(--app-text)', backgroundColor: controlBg },
                    '& .MuiInputLabel-root': { color: 'var(--text-muted)' },
                    '& .MuiFormHelperText-root': { color: 'var(--text-muted)' },
                    '& fieldset': { borderColor: controlBorder },
                  }}
                />
              </Box>
            </Collapse>
          </Box>
        </Box>
      </DialogContent>
      
      <DialogActions sx={{ 
        p: 3, 
        pt: 2,
      }}>
        <Button 
          onClick={onClose} 
          size="large"
          sx={{
            color: 'var(--text-muted)',
            '&:hover': {
                backgroundColor: alpha(theme.palette.primary.main, 0.05),
              },
          }}
        >
          Cancel
        </Button>
        <Button 
          onClick={handleSubmit} 
          variant="contained" 
          disabled={submitting}
          size="large"
          startIcon={submitting ? <CircularProgress size={20} sx={{ color: 'white' }} /> : <AddIcon />}
          sx={{
            background: `linear-gradient(135deg, ${theme.palette.primary.main} 0%, ${theme.palette.primary.dark} 100%)`,
            color: theme.palette.getContrastText(theme.palette.primary.main),
            '&:hover': {
              background: `linear-gradient(135deg, ${theme.palette.primary.dark} 0%, ${theme.palette.primary.main} 100%)`,
            },
            '&:disabled': {
              background: alpha(theme.palette.primary.main, 0.3),
            },
          }}
        >
          {submitting ? 'Creating...' : 'Create Bet'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}


