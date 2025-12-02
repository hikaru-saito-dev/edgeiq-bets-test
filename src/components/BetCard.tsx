'use client';

import { useMemo, useState } from 'react';
import {
  Card,
  CardContent,
  Typography,
  Chip,
  Box,
  Button,
  Collapse,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import AttachMoneyIcon from '@mui/icons-material/AttachMoney';
import TrendingUpIcon from '@mui/icons-material/TrendingUp';
import EventIcon from '@mui/icons-material/Event';
import CalculateIcon from '@mui/icons-material/Calculate';
import { apiRequest } from '@/lib/apiClient';
import { useAccess } from './AccessProvider';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import { useToast } from './ToastProvider';
import { alpha, useTheme } from '@mui/material/styles';

interface BetCardProps {
  bet: {
    _id: string;
    eventName: string;
    startTime: string;
    odds: number;
    oddsAmerican: number;
    units: number;
    result: 'pending' | 'win' | 'loss' | 'push' | 'void';
    locked: boolean;
    createdAt: string;
    marketType: 'ML' | 'Spread' | 'Total' | 'Player Prop' | 'Parlay';
    parlaySummary?: string;
    selection?: string;
    line?: number;
    overUnder?: 'Over' | 'Under';
    playerName?: string;
    statType?: string;
    sport?: string;
    league?: string;
    homeTeam?: string;
    awayTeam?: string;
    book?: string;
    provider?: string;
    providerEventId?: string;
    sportKey?: string;
    homeTeamId?: string;
    awayTeamId?: string;
    oddsFormat?: 'american' | 'decimal';
    notes?: string;
    slipImageUrl?: string;
    parlayLegs?: Array<{
      _id: string;
      eventName: string;
      startTime: string;
      oddsAmerican: number;
      marketType: 'ML' | 'Spread' | 'Total' | 'Player Prop';
      selection?: string;
      line?: number;
      overUnder?: 'Over' | 'Under';
      playerName?: string;
      statType?: string;
      odds: number;
      units: number;
      result: 'pending' | 'win' | 'loss' | 'push' | 'void';
    }>;
  };
  onUpdate?: () => void;
  disableDelete?: boolean; // When true, hides the delete button (e.g., for followed bets)
}

export default function BetCard({ bet, onUpdate, disableDelete = false }: BetCardProps) {
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [showParlayLegs, setShowParlayLegs] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const { userId, companyId } = useAccess();
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';
  const statBg = alpha(theme.palette.primary.main, isDark ? 0.25 : 0.12);
  const statBorder = `1px solid ${alpha(theme.palette.primary.main, isDark ? 0.45 : 0.3)}`;
  const infoPanelBg = alpha(theme.palette.primary.main, isDark ? 0.2 : 0.1);
  const fillsBorder = `1px solid ${alpha(theme.palette.primary.main, isDark ? 0.45 : 0.25)}`;
  const fillsBg = alpha(theme.palette.background.paper, isDark ? 0.3 : 0.85);
  const timestampColor = alpha(theme.palette.text.secondary, 0.9);
  const actionGradient = `linear-gradient(135deg, ${theme.palette.primary.main} 0%, ${theme.palette.primary.dark} 100%)`;
  const actionGradientHover = `linear-gradient(135deg, ${theme.palette.primary.dark} 0%, ${theme.palette.primary.main} 100%)`;
  const actionGradientDisabled = alpha(theme.palette.primary.main, 0.35);
  const getResultColor = () => {
    switch (bet.result) {
      case 'win': return 'success';
      case 'loss': return 'error';
      case 'push': return 'warning';
      case 'void': return 'default';
      default: return 'info';
    }
  };

  const getResultIcon = () => {
    switch (bet.result) {
      case 'win': return <CheckCircleIcon />;
      case 'loss': return <CancelIcon />;
      default: return <AccessTimeIcon />;
    }
  };



  // Calculate potential payout using utility function
  const potentialPayout = Math.round(bet.units * (bet.odds - 1) * 100) / 100;
  const totalReturn = Math.round(bet.units * bet.odds * 100) / 100;
  const parlayLegCount = bet.marketType === 'Parlay' ? bet.parlayLegs?.length ?? 0 : 0;

  const parlayLegsSorted = useMemo(() => {
    if (bet.marketType !== 'Parlay' || !bet.parlayLegs) return [];
    return [...bet.parlayLegs].sort(
      (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
    );
  }, [bet.marketType, bet.parlayLegs]);

  const renderLegDescription = (leg: NonNullable<typeof bet.parlayLegs>[number]) => {
    switch (leg.marketType) {
      case 'ML':
        return `${leg.selection ?? 'Team'} ML`;
      case 'Spread':
        return `${leg.selection ?? 'Team'} ${leg.line && leg.line > 0 ? '+' : ''}${leg.line}`;
      case 'Total':
        return `${leg.overUnder ?? ''} ${leg.line ?? ''}`.trim();
      case 'Player Prop':
        return `${leg.playerName ?? 'Player'} ${leg.statType ?? ''} ${leg.overUnder ?? ''} ${leg.line ?? ''}`.trim();
      default:
        return leg.marketType;
    }
  };

  return (
    <>
      <Card 
        sx={{ 
          mb: 2,
          background: theme.palette.background.paper,
          backdropFilter: 'blur(20px)',
          border: bet.locked
            ? `2px solid ${alpha(theme.palette.warning.main, isDark ? 0.6 : 0.5)}`
            : `1px solid ${alpha(theme.palette.primary.main, isDark ? 0.45 : 0.3)}`,
          borderRadius: 3,
          boxShadow: theme.palette.mode === 'light'
            ? '0 12px 32px rgba(34, 197, 94, 0.08)'
            : '0 12px 32px rgba(0, 0, 0, 0.45)',
          transition: 'all 0.3s ease',
          '&:hover': {
            boxShadow: theme.palette.mode === 'light'
              ? '0 12px 40px rgba(34, 197, 94, 0.25), inset 0 1px 0 rgba(34, 197, 94, 0.15)'
              : '0 12px 40px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(34, 197, 94, 0.15)',
            transform: 'translateY(-4px)',
            borderColor: bet.locked
              ? alpha(theme.palette.warning.main, isDark ? 0.8 : 0.7)
              : alpha(theme.palette.primary.main, isDark ? 0.6 : 0.5),
          }
        }}
      >
        <CardContent>
          <Box display="flex" flexDirection={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ xs: 'flex-start', sm: 'start' }} mb={2} gap={{ xs: 1, sm: 0 }}>
            <Box flex={1} sx={{ width: { xs: '100%', sm: 'auto' } }}>
              <Typography
                variant="h6"
                component="div"
                fontWeight={600}
                mb={0.5}
                sx={{
                  color: 'text.primary',
                  fontSize: { xs: '1rem', sm: '1.25rem' },
                  wordBreak: 'break-word',
                }}
              >
                {bet.eventName} • {bet.marketType}
              </Typography>
              <Box
                display="flex"
                flexWrap="wrap"
                alignItems="center"
                gap={1}
                mb={1}
              >
                <EventIcon fontSize="small" color="primary" />
                <Typography
                  variant="body2"
                  sx={{
                    color: 'text.secondary',
                    fontSize: { xs: '0.75rem', sm: '0.875rem' },
                  }}
                >
                  {new Date(bet.startTime).toLocaleString()}
                </Typography>
              </Box>
            </Box>
            <Chip
              label={bet.result.toUpperCase()}
              color={getResultColor()}
              size="medium"
              icon={getResultIcon()}
              sx={{
                fontWeight: 600,
                alignSelf: { xs: 'flex-start', sm: 'auto' },
                fontSize: { xs: '0.75rem', sm: '0.875rem' },
              }}
            />
          </Box>

          

          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, mb: 2 }}>
            <Box 
              sx={{ 
                p: 1.5, 
                  backgroundColor: statBg,
                borderRadius: 2,
                textAlign: 'center',
                width: { xs: 'calc(50% - 8px)', sm: 'calc(25% - 12px)' },
                minWidth: { xs: 'calc(50% - 8px)', sm: 'calc(25% - 12px)' },
                  border: statBorder,
              }}
            >
                <TrendingUpIcon fontSize="small" sx={{ mb: 0.5, color: theme.palette.primary.dark }} />
                <Typography variant="caption" display="block" sx={{ color: 'text.secondary', fontWeight: 600 }}>
                Odds
              </Typography>
                <Typography variant="h6" fontWeight={700} sx={{ color: 'text.primary' }}>
                {bet.oddsAmerican > 0 ? `+${bet.oddsAmerican}` : bet.oddsAmerican}
              </Typography>
            </Box>
            <Box 
              sx={{ 
                p: 1.5, 
                  backgroundColor: statBg,
                borderRadius: 2,
                textAlign: 'center',
                width: { xs: 'calc(50% - 8px)', sm: 'calc(25% - 12px)' },
                minWidth: { xs: 'calc(50% - 8px)', sm: 'calc(25% - 12px)' },
                  border: statBorder,
              }}
            >
                <AttachMoneyIcon fontSize="small" sx={{ mb: 0.5, color: theme.palette.primary.dark }} />
                <Typography variant="caption" display="block" sx={{ color: 'text.secondary', fontWeight: 600 }}>
                Units
              </Typography>
                <Typography variant="h6" fontWeight={700} sx={{ color: 'text.primary' }}>
                {bet.units.toFixed(2)}
              </Typography>
            </Box>
            <Box 
              sx={{ 
                p: 1.5, 
                  backgroundColor: statBg,
                borderRadius: 2,
                textAlign: 'center',
                width: { xs: 'calc(50% - 8px)', sm: 'calc(25% - 12px)' },
                minWidth: { xs: 'calc(50% - 8px)', sm: 'calc(25% - 12px)' },
                  border: statBorder,
              }}
            >
                <CalculateIcon fontSize="small" sx={{ mb: 0.5, color: theme.palette.primary.dark }} />
                <Typography variant="caption" display="block" sx={{ color: 'text.secondary', fontWeight: 600 }}>
                Potential Win
              </Typography>
                <Typography variant="h6" fontWeight={700} sx={{ color: 'text.primary' }}>
                +{potentialPayout.toFixed(2)}
              </Typography>
            </Box>
            <Box 
              sx={{ 
                p: 1.5, 
                  backgroundColor: statBg,
                borderRadius: 2,
                textAlign: 'center',
                width: { xs: 'calc(50% - 8px)', sm: 'calc(25% - 12px)' },
                minWidth: { xs: 'calc(50% - 8px)', sm: 'calc(25% - 12px)' },
                  border: statBorder,
              }}
            >
                <AttachMoneyIcon fontSize="small" sx={{ mb: 0.5, color: theme.palette.primary.dark }} />
                <Typography variant="caption" display="block" sx={{ color: 'text.secondary', fontWeight: 600 }}>
                Total Return
              </Typography>
                <Typography variant="h6" fontWeight={700} sx={{ color: 'text.primary' }}>
                {totalReturn.toFixed(2)}
              </Typography>
            </Box>
          </Box>

          {/* Bet Details Section - Show for all bets, not just parlays */}
          <Box sx={{ mb: 2 }}>
              <Box display="flex" flexDirection={{ xs: 'column', sm: 'row' }} alignItems={{ xs: 'flex-start', sm: 'center' }} justifyContent="space-between" sx={{ mb: 1 }} gap={{ xs: 1, sm: 0 }}>
                <Typography variant="subtitle1" sx={{ color: 'primary.main', fontWeight: 600, fontSize: { xs: '0.875rem', sm: '1rem' } }}>
                {bet.marketType === 'Parlay' ? `Parlay · ${parlayLegCount} ${parlayLegCount === 1 ? 'Leg' : 'Legs'}` : 'Bet Details'}
              </Typography>
                <Box display="flex" gap={1} flexWrap="wrap">
                {bet.marketType === 'Parlay' && (
                  <Button
                    size="small"
                    variant="text"
                    endIcon={showParlayLegs ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                    onClick={() => setShowParlayLegs((prev) => !prev)}
                      sx={{ color: 'primary.main', fontWeight: 600, textTransform: 'none' }}
                  >
                    {showParlayLegs ? 'Hide Legs' : 'View Legs'}
                  </Button>
                )}
                <Button
                  size="small"
                  variant="text"
                  endIcon={showDetails ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                  onClick={() => setShowDetails((prev) => !prev)}
                    sx={{ color: 'primary.main', fontWeight: 600, textTransform: 'none' }}
                >
                  {showDetails ? 'Hide Details' : 'View Details'}
                </Button>
              </Box>
            </Box>
            
            {/* Parlay legs section */}
            {bet.marketType === 'Parlay' && (
              <>
              {bet.parlaySummary && (
                    <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1 }}>
                  {bet.parlaySummary}
                </Typography>
              )}
              <Collapse in={showParlayLegs}>
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                  {parlayLegsSorted.length === 0 && (
                        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                      Legs will appear once data loads.
                    </Typography>
                  )}
                  {parlayLegsSorted.map((leg) => (
                    <Box
                      key={leg._id}
                      sx={{
                        p: 1,
                        borderRadius: 2,
                        border: fillsBorder,
                        backgroundColor: fillsBg,
                        display: 'grid',
                        gridTemplateColumns: {
                          xs: '1fr',
                          sm: '2.2fr 1.6fr 1.2fr auto',
                        },
                        alignItems: 'center',
                        columnGap: { xs: 0.5, sm: 1 },
                        rowGap: { xs: 0.5, sm: 0 },
                      }}
                    >
                      <Typography
                        variant="body2"
                        sx={{
                          color: 'text.primary',
                          fontWeight: 800,
                        }}
                      >
                        {leg.eventName} • {leg.marketType}
                      </Typography>

                      <Typography
                        variant="body2"
                        sx={{
                          color: 'primary.main',
                          fontWeight: 500,
                        }}
                      >
                        {renderLegDescription(leg)}
                      </Typography>

                      <Typography
                        variant="caption"
                        sx={{
                          color: timestampColor,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {new Date(leg.startTime).toLocaleString()}
                      </Typography>

                      <Chip
                        size="small"
                        label={leg.result.toUpperCase()}
                        color={
                          leg.result === 'pending'
                            ? 'info'
                            : leg.result === 'win'
                              ? 'success'
                              : leg.result === 'loss'
                                ? 'error'
                                : 'warning'
                        }
                        sx={{
                          fontWeight: 500,
                          justifySelf: { xs: 'flex-start', sm: 'flex-end' },
                        }}
                      />
                    </Box>
                  ))}
                </Box>
              </Collapse>
              </>
            )}

            {/* Detailed Information Section */}
            <Collapse in={showDetails}>
              <Box
                sx={{
                  mt: 2,
                    p: 1.5,
                    backgroundColor: infoPanelBg,
                  borderRadius: 2,
                }}
              >
                  <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1 }}>
                  Detailed Information
                </Typography>
                
                <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1.5 }}>
                  {bet.sportKey && (
                    <Box>
                        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
                        Sport Key
                      </Typography>
                        <Typography variant="body2" sx={{ color: 'text.primary', fontWeight: 500 }}>
                        {bet.sportKey}
                      </Typography>
                    </Box>
                  )}
                  
                  {bet.homeTeamId && (
                    <Box>
                        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
                        Home Team ID
                      </Typography>
                        <Typography variant="body2" sx={{ color: 'text.primary', fontWeight: 500 }}>
                        {bet.homeTeamId}
                      </Typography>
                    </Box>
                  )}
                  
                  {bet.awayTeamId && (
                    <Box>
                        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
                        Away Team ID
                      </Typography>
                        <Typography variant="body2" sx={{ color: 'text.primary', fontWeight: 500 }}>
                        {bet.awayTeamId}
                      </Typography>
                    </Box>
                  )}
                  
                  <Box>
                      <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
                      Odds Format
                    </Typography>
                      <Typography variant="body2" sx={{ color: 'text.primary', fontWeight: 500 }}>
                      {bet.oddsFormat === 'american' ? 'American' : 'Decimal'} ({bet.odds.toFixed(2)})
                    </Typography>
                  </Box>
                  
                  <Box>
                      <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
                      Created At
                    </Typography>
                      <Typography variant="body2" sx={{ color: 'text.primary', fontWeight: 500 }}>
                      {new Date(bet.createdAt).toLocaleString()}
                    </Typography>
                  </Box>
                </Box>

                {/* Bet-specific details */}
                {(bet.marketType === 'Player Prop' || bet.marketType === 'ML' || bet.marketType === 'Spread' || bet.marketType === 'Total') && (
                    <Box sx={{ mt: 1, pt: 1.5, borderTop: `1px solid ${alpha(theme.palette.divider, 0.5)}` }}>
                      <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1, fontWeight: 600 }}>
                      Bet Selection
                    </Typography>
                    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1.5 }}>
                      {bet.marketType === 'Player Prop' && (
                        <>
                          {bet.playerName && (
                            <Box>
                                <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
                                Player Name
                              </Typography>
                                <Typography variant="body2" sx={{ color: 'text.primary', fontWeight: 500 }}>
                                {bet.playerName}
                              </Typography>
                            </Box>
                          )}
                          {bet.statType && (
                            <Box>
                                <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
                                Stat Type
                              </Typography>
                                <Typography variant="body2" sx={{ color: 'text.primary', fontWeight: 500 }}>
                                {bet.statType}
                              </Typography>
                            </Box>
                          )}
                          {typeof bet.line === 'number' && (
                            <Box>
                                <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
                                Line
                              </Typography>
                                <Typography variant="body2" sx={{ color: 'text.primary', fontWeight: 500 }}>
                                {bet.line}
                              </Typography>
                            </Box>
                          )}
                          {bet.overUnder && (
                            <Box>
                                <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
                                Over/Under
                              </Typography>
                                <Typography variant="body2" sx={{ color: 'text.primary', fontWeight: 500 }}>
                                {bet.overUnder}
                              </Typography>
                            </Box>
                          )}
                        </>
                      )}
                      
                      {bet.marketType === 'ML' && bet.selection && (
                        <Box>
                            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
                            Betted Team
                          </Typography>
                            <Typography variant="body2" sx={{ color: 'text.primary', fontWeight: 500 }}>
                            {bet.selection} ML
                          </Typography>
                        </Box>
                      )}
                      
                      {bet.marketType === 'Spread' && (
                        <>
                          {bet.selection && (
                            <Box>
                                <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
                                Betted Team
                              </Typography>
                                <Typography variant="body2" sx={{ color: 'text.primary', fontWeight: 500 }}>
                                {bet.selection}
                              </Typography>
                            </Box>
                          )}
                          {typeof bet.line === 'number' && (
                            <Box>
                                <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
                                Line
                              </Typography>
                                <Typography variant="body2" sx={{ color: 'text.primary', fontWeight: 500 }}>
                                {bet.line > 0 ? `+${bet.line}` : bet.line}
                              </Typography>
                            </Box>
                          )}
                        </>
                      )}
                      
                      {bet.marketType === 'Total' && (
                        <>
                          {typeof bet.line === 'number' && (
                            <Box>
                                <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
                                Line
                              </Typography>
                                <Typography variant="body2" sx={{ color: 'text.primary', fontWeight: 500 }}>
                                {bet.line}
                              </Typography>
                            </Box>
                          )}
                          {bet.overUnder && (
                            <Box>
                                <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
                                Over/Under
                              </Typography>
                                <Typography variant="body2" sx={{ color: 'text.primary', fontWeight: 500 }}>
                                {bet.overUnder}
                              </Typography>
                            </Box>
                          )}
                        </>
                      )}
                    </Box>
                  </Box>
                )}
                
                {bet.notes && (
                  <Box sx={{ mt: 1 }}>
                      <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 0.5 }}>
                      Notes
                    </Typography>
                      <Typography variant="body2" sx={{ color: 'text.primary', fontStyle: 'italic' }}>
                      {bet.notes}
                    </Typography>
                  </Box>
                )}
                
                {bet.slipImageUrl && (
                  <Box sx={{ mt: 1 }}>
                      <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 0.5 }}>
                      Bet Slip Image
                    </Typography>
                    <Box
                      component="a"
                      href={bet.slipImageUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      sx={{
                        display: 'inline-block',
                          color: 'primary.main',
                        textDecoration: 'none',
                        '&:hover': {
                          textDecoration: 'underline',
                        },
                      }}
                    >
                        <Typography variant="body2" sx={{ color: 'primary.main' }}>
                        View Image →
                      </Typography>
                    </Box>
                  </Box>
                )}
              </Box>
            </Collapse>
          </Box>

          <Box display="flex" gap={1} justifyContent="flex-end">
            {!disableDelete && bet.result === 'pending' && (() => {
              const now = new Date();
              const startTime = new Date(bet.startTime);
              const canDelete = !bet.locked && now < startTime;
              
              // Show delete button only if game hasn't started
              if (canDelete) {
                return (
                  <Button
                    variant="outlined"
                    color="error"
                    size="small"
                    disabled={loading}
                    onClick={async () => {
                      if (!window.confirm('Are you sure you want to delete this bet?')) return;
                      setLoading(true);
                      try {
                        const res = await apiRequest('/api/bets', {
                          method: 'DELETE',
                          body: JSON.stringify({ betId: bet._id }),
                          userId,
                          companyId,
                        });
                        if (res.ok) {
                          toast.showSuccess('Bet deleted.');
                          if (onUpdate) onUpdate();
                        } else {
                          const error = await res.json();
                          toast.showError(error.error || 'Failed to delete bet');
                        }
                      } catch (err) {
                        if (err instanceof Error) {
                          toast.showError(err.message);
                        } else {
                          toast.showError('Failed to delete bet');
                        }
                      } finally {
                        setLoading(false);
                      }
                    }}
                    style={{ marginLeft: 8 }}
                  >
                    Delete
                  </Button>
                );
              }
              
              return null;
            })()}
          </Box>
        </CardContent>
      </Card>

    </>
  );
}

