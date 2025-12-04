'use client';

import { useState, useEffect, useRef } from 'react';
import {
  Box,
  Typography,
  Container,
  Paper,
  CircularProgress,
  Alert,
  Pagination,
  FormControl,
  Select,
  MenuItem,
  Chip,
  Avatar,
  Button,
  Collapse,
  TextField,
  InputAdornment,
  Tabs,
  Tab,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import BetCard from '@/components/BetCard';
import { useToast } from '@/components/ToastProvider';
import { motion } from 'framer-motion';
import { useAccess } from '@/components/AccessProvider';
import { apiRequest } from '@/lib/apiClient';
import { alpha, useTheme } from '@mui/material/styles';

interface Bet {
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
  followInfo?: {
    followPurchaseId: string;
    remainingPlays: number;
  };
  actionStatus?: {
    action: 'follow' | 'fade';
    followedBetId?: string;
  } | null;
}

interface Follow {
  followPurchaseId: string;
  capper: {
    userId: string;
    alias: string;
    avatarUrl?: string;
  };
  numPlaysPurchased: number;
  numPlaysConsumed: number;
  remainingPlays: number;
  status: 'active' | 'completed';
  createdAt: string;
}

export default function FollowingPage() {
  const toast = useToast();
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';
  const { isAuthorized, loading: accessLoading, userId, companyId } = useAccess();
  const [bets, setBets] = useState<Bet[]>([]);
  const [follows, setFollows] = useState<Follow[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [selectedFollowId, setSelectedFollowId] = useState<string>('all');
  const [showFollows, setShowFollows] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedMarketType, setSelectedMarketType] = useState<string>('All');

  const fetchFollowingFeed = async () => {
    if (!isAuthorized || accessLoading) return;

    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
      });
      
      // Add search parameter if provided (use debouncedSearch for API call)
      if (debouncedSearch.trim()) {
        params.set('search', debouncedSearch.trim());
      }
      
      // Add marketType filter if not "All"
      if (selectedMarketType !== 'All') {
        params.set('marketType', selectedMarketType);
      }
      
      const response = await apiRequest(`/api/follow/feed?${params.toString()}`, { userId, companyId });
      if (!response.ok) {
        throw new Error('Failed to fetch following feed');
      }
      const data = await response.json();
      setBets(data.bets || []);
      setFollows(data.follows || []);
      setTotalPages(data.totalPages || 1);
      setTotal(data.total || 0);
    } catch (error) {
      console.error('Error fetching following feed:', error);
      toast.showError('Failed to load following feed');
    } finally {
      setLoading(false);
    }
  };

  // Debounced search - separate state to prevent race conditions
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  const previousSearchRef = useRef(search);
  
  useEffect(() => {
    // If not authorized or loading, sync immediately (no API calls will be made anyway)
    if (!isAuthorized || accessLoading) {
      setDebouncedSearch(search);
      previousSearchRef.current = search;
      return;
    }
    
    // Debounce search updates to avoid excessive API calls
    const timeoutId = setTimeout(() => {
      const previousSearch = previousSearchRef.current;
      setDebouncedSearch(search);
      previousSearchRef.current = search;
      // Reset page when search actually changed (after debounce)
      if (search !== previousSearch) {
        setPage(1);
      }
    }, 300); // 300ms debounce

    return () => clearTimeout(timeoutId);
  }, [search, isAuthorized, accessLoading]);

  // Main effect - fetches data when dependencies change (uses debouncedSearch, not search)
  useEffect(() => {
    if (isAuthorized && !accessLoading) {
      fetchFollowingFeed();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthorized, accessLoading, page, pageSize, debouncedSearch, selectedMarketType]);

  if (accessLoading) {
    return (
      <Container maxWidth="lg" sx={{ py: 4 }}>
        <Box display="flex" justifyContent="center" alignItems="center" minHeight="400px">
          <CircularProgress />
        </Box>
      </Container>
    );
  }

  if (!isAuthorized) {
    return (
      <Container maxWidth="lg" sx={{ py: 4 }}>
        <Alert severity="warning">Please sign in to view your following feed.</Alert>
      </Container>
    );
  }

  const controlBg = alpha(theme.palette.background.paper, isDark ? 0.6 : 0.98);
  const controlBorder = alpha(theme.palette.primary.main, isDark ? 0.45 : 0.25);
  const controlStyles = {
    '& .MuiOutlinedInput-root': {
      color: 'var(--app-text)',
      backgroundColor: controlBg,
      '& fieldset': { borderColor: controlBorder },
      '&:hover fieldset': { borderColor: theme.palette.primary.main },
      '&.Mui-focused fieldset': {
        borderColor: theme.palette.primary.main,
        boxShadow: `0 0 0 2px ${alpha(theme.palette.primary.main, 0.15)}`,
      },
    },
    '& .MuiInputBase-input::placeholder': {
      color: 'var(--text-muted)',
      opacity: 1,
    },
  };

  // Client-side filtering by creator (for display only)
  // Note: Pagination and totals are server-side based on all bets
  const filteredBets =
    selectedFollowId === 'all'
      ? bets
      : bets.filter(
          (bet) => bet.followInfo?.followPurchaseId === selectedFollowId
        );
  
  // Calculate filtered total for display
  const filteredTotal = selectedFollowId === 'all' 
    ? total 
    : filteredBets.length;

  return (
    <Container maxWidth="lg" sx={{ py: 4 }}>
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
      >
        <Box mb={4}>
          <Typography
            variant="h4"
            sx={{
              color: 'var(--app-text)',
              fontWeight: 700,
              mb: 1,
            }}
          >
            Following
          </Typography>
          <Typography variant="body1" sx={{ color: 'var(--text-muted)' }}>
            Bets from creators you&apos;re following
          </Typography>
        </Box>

        {/* Active Follows Summary */}
        {follows.length > 0 && (
          <Paper
            sx={{
              p: 3,
              mb: 3,
              bgcolor: 'var(--surface-bg)',
              backdropFilter: 'blur(6px)',
              borderRadius: 2,
              border: `1px solid ${alpha(theme.palette.primary.main, isDark ? 0.3 : 0.2)}`,
            }}
          >
            <Box display="flex" alignItems="center" justifyContent="space-between" mb={showFollows ? 2 : 0}>
              <Typography variant="h6" sx={{ color: 'var(--app-text)', fontWeight: 600 }}>
                Active Follows
              </Typography>
              <Button
                variant="text"
                size="small"
                sx={{
                  textTransform: 'none',
                  color: theme.palette.primary.light,
                }}
                onClick={() => setShowFollows((prev) => !prev)}
              >
                {showFollows ? 'Hide Follows' : 'View Follows'}
              </Button>
            </Box>
            <Collapse in={showFollows}>
              <Box display="flex" flexDirection="column" gap={2}>
                {follows.map((follow) => (
                  <Box
                    key={follow.followPurchaseId}
                    sx={{
                      p: 2,
                      borderRadius: 2,
                      backgroundColor: alpha(theme.palette.primary.main, isDark ? 0.15 : 0.08),
                      border: `1px solid ${alpha(theme.palette.primary.main, 0.2)}`,
                    }}
                  >
                    <Box display="flex" alignItems="center" gap={2} mb={1}>
                      <Avatar 
                        src={follow.capper.avatarUrl} 
                        sx={{ width: 40, height: 40 }}
                      >
                        {follow.capper.alias && follow.capper.alias.length > 0
                          ? follow.capper.alias.charAt(0).toUpperCase()
                          : '?'}
                      </Avatar>
                      <Box flex={1}>
                        <Typography variant="body1" sx={{ color: 'var(--app-text)', fontWeight: 600 }}>
                          {follow.capper.alias || 'Unknown'}
                        </Typography>
                        <Typography variant="caption" sx={{ color: 'var(--text-muted)' }}>
                          {follow.remainingPlays} of {follow.numPlaysPurchased} plays remaining
                        </Typography>
                      </Box>
                      <Chip
                        label={follow.status === 'active' ? 'Active' : 'Completed'}
                        size="small"
                        color={follow.status === 'active' ? 'primary' : 'default'}
                      />
                    </Box>
                    <Box
                      sx={{
                        height: 6,
                        borderRadius: 3,
                        backgroundColor: alpha(theme.palette.primary.main, 0.2),
                        overflow: 'hidden',
                        mt: 1,
                      }}
                    >
                      <Box
                        sx={{
                          height: '100%',
                          width: `${follow.numPlaysPurchased > 0 ? Math.max(0, Math.min(100, (follow.remainingPlays / follow.numPlaysPurchased) * 100)) : 0}%`,
                          background: 'linear-gradient(90deg, #3b82f6, #2563eb)',
                          transition: 'width 0.3s ease',
                        }}
                      />
                    </Box>
                  </Box>
                ))}
              </Box>
            </Collapse>
          </Paper>
        )}

        {/* Search and Filters */}
        <Paper
          sx={{
            p: 2,
            mb: 3,
            bgcolor: 'var(--surface-bg)',
            backdropFilter: 'blur(6px)',
            borderRadius: 2,
            border: `1px solid ${alpha(theme.palette.primary.main, isDark ? 0.3 : 0.2)}`,
          }}
        >
          <Box display="flex" flexDirection="column" gap={2}>
            {/* Search Bar */}
            <TextField
              fullWidth
              placeholder="Search bets (team, sport, league...)"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              size="small"
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon sx={{ color: 'var(--text-muted)' }} />
                  </InputAdornment>
                ),
              }}
              sx={controlStyles}
            />

            {/* Market Type Filter */}
            <Tabs
              value={selectedMarketType}
              onChange={(_, value) => {
                setSelectedMarketType(value);
                setPage(1);
              }}
              variant="scrollable"
              scrollButtons="auto"
              sx={{
                '& .MuiTab-root': {
                  color: 'var(--text-muted)',
                  textTransform: 'none',
                  minHeight: 40,
                  '&.Mui-selected': {
                    color: theme.palette.primary.main,
                  },
                },
                '& .MuiTabs-indicator': {
                  backgroundColor: theme.palette.primary.main,
                },
              }}
            >
              <Tab label="All" value="All" />
              <Tab label="Moneyline" value="ML" />
              <Tab label="Spread" value="Spread" />
              <Tab label="Total" value="Total" />
              <Tab label="Player Prop" value="Player Prop" />
              <Tab label="Parlay" value="Parlay" />
            </Tabs>
          </Box>
        </Paper>

        {/* Page Size Control */}
        <Box display="flex" justifyContent="space-between" alignItems="center" mb={3}>
          <Box display="flex" alignItems="center" gap={2}>
            <Typography variant="body2" sx={{ color: 'var(--app-text)' }}>
              Show
            </Typography>
            <FormControl size="small">
              <Select
                value={pageSize}
                onChange={(e) => {
                  setPageSize(e.target.value as number);
                  setPage(1);
                }}
                sx={{
                  minWidth: 80,
                  color: 'var(--app-text)',
                  backgroundColor: controlBg,
                  '& .MuiOutlinedInput-notchedOutline': { borderColor: controlBorder },
                  '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: theme.palette.primary.main },
                }}
              >
                {[10, 20, 50].map((s) => (
                  <MenuItem key={s} value={s} sx={{ color: 'var(--app-text)' }}>
                    {s}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <Typography variant="body2" sx={{ color: 'var(--text-muted)' }}>
              {filteredTotal > 0 ? `of ${filteredTotal} bets${selectedFollowId !== 'all' ? ' (filtered)' : ''}` : 'No bets'}
            </Typography>
          </Box>
          {follows.length > 0 && (
            <Box display="flex" alignItems="center" gap={1}>
              <Typography variant="body2" sx={{ color: 'var(--text-muted)' }}>
                Creator
              </Typography>
              <FormControl size="small">
                <Select
                  value={selectedFollowId}
                  onChange={(e) => {
                    const newFollowId = e.target.value as string;
                    // Reset to page 1 whenever creator filter changes (client-side filter)
                    if (newFollowId !== selectedFollowId) {
                      setPage(1);
                    }
                    setSelectedFollowId(newFollowId);
                  }}
                  sx={{
                    minWidth: 140,
                    color: 'var(--app-text)',
                    backgroundColor: controlBg,
                    '& .MuiOutlinedInput-notchedOutline': { borderColor: controlBorder },
                    '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: theme.palette.primary.main },
                  }}
                >
                  <MenuItem value="all" sx={{ color: 'var(--app-text)' }}>
                    All creators
                  </MenuItem>
                  {follows.map((follow) => (
                    <MenuItem
                      key={follow.followPurchaseId}
                      value={follow.followPurchaseId}
                      sx={{ color: 'var(--app-text)' }}
                    >
                      {follow.capper.alias || 'Unknown'}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Box>
          )}
        </Box>

        {/* Bets Feed */}
        {loading ? (
          <Box display="flex" justifyContent="center" alignItems="center" minHeight="400px">
            <CircularProgress />
          </Box>
        ) : filteredBets.length === 0 ? (
          <Paper
            sx={{
              p: 6,
              textAlign: 'center',
              bgcolor: 'var(--surface-bg)',
              backdropFilter: 'blur(6px)',
              borderRadius: 2,
              border: `1px solid ${alpha(theme.palette.primary.main, isDark ? 0.3 : 0.2)}`,
            }}
          >
            <Typography variant="h6" sx={{ color: 'var(--app-text)', mb: 1 }}>
              {selectedFollowId !== 'all' ? 'No bets from this creator' : 'No bets yet'}
            </Typography>
            <Typography variant="body2" sx={{ color: 'var(--text-muted)' }}>
              {selectedFollowId !== 'all'
                ? "This creator doesn't have any bets matching your search/filter criteria on this page."
                : follows.length === 0
                ? "You're not following anyone yet. Follow creators on the leaderboard to see their bets here."
                : "The creators you're following haven't posted any bets yet."}
            </Typography>
          </Paper>
        ) : (
          <Box display="flex" flexDirection="column" gap={3}>
            {filteredBets.map((bet) => (
              <motion.div
                key={bet._id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3 }}
              >
                <BetCard 
                  bet={bet} 
                  onUpdate={fetchFollowingFeed} 
                  disableDelete={true}
                  onAction={async (betId: string, action: 'follow' | 'fade') => {
                    try {
                      const res = await apiRequest('/api/follow/bet-action', {
                        method: 'POST',
                        body: JSON.stringify({ betId, action }),
                        userId,
                        companyId,
                      });
                      
                      if (!res.ok) {
                        let errorMessage = `Failed to ${action} bet`;
                        try {
                          const error = await res.json();
                          errorMessage = error.error || errorMessage;
                        } catch {
                          // If response is not JSON, use default message
                        }
                        throw new Error(errorMessage);
                      }
                      
                      // Parse response (handle potential JSON parsing errors)
                      let successMessage = `Bet ${action === 'follow' ? 'followed' : 'faded'} successfully`;
                      try {
                        const data = await res.json();
                        successMessage = data.message || successMessage;
                      } catch {
                        // If response is not JSON, use default success message
                      }
                      toast.showSuccess(successMessage);
                      
                      // Refresh the feed to update action status
                      await fetchFollowingFeed();
                    } catch (error) {
                      if (error instanceof Error) {
                        toast.showError(error.message);
                      } else {
                        toast.showError(`Failed to ${action} bet`);
                      }
                      throw error;
                    }
                  }}
                />
              </motion.div>
            ))}
          </Box>
        )}

        {/* Pagination */}
        {/* Only show pagination if not filtering by creator (since creator filter is client-side) */}
        {selectedFollowId === 'all' && totalPages > 1 && (
          <Box display="flex" justifyContent="center" mt={4}>
            <Pagination
              count={totalPages}
              page={page}
              onChange={(_, value) => setPage(value)}
              color="primary"
              sx={{
                '& .MuiPaginationItem-root': {
                  color: 'var(--app-text)',
                  '&.Mui-selected': {
                    backgroundColor: theme.palette.primary.main,
                    color: 'white',
                  },
                },
              }}
            />
          </Box>
        )}
      </motion.div>
    </Container>
  );
}

