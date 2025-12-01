'use client';

import { useState, useEffect } from 'react';
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
} from '@mui/material';
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

  const fetchFollowingFeed = async () => {
    if (!isAuthorized || accessLoading) return;

    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
      });
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

  useEffect(() => {
    if (isAuthorized && !accessLoading) {
      fetchFollowingFeed();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthorized, accessLoading, page, pageSize]);

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
            <Typography variant="h6" sx={{ color: 'var(--app-text)', fontWeight: 600, mb: 2 }}>
              Active Follows
            </Typography>
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
                    {follow.capper.avatarUrl && (
                      <Avatar src={follow.capper.avatarUrl} sx={{ width: 40, height: 40 }}>
                        {follow.capper.alias.charAt(0).toUpperCase()}
                      </Avatar>
                    )}
                    <Box flex={1}>
                      <Typography variant="body1" sx={{ color: 'var(--app-text)', fontWeight: 600 }}>
                        {follow.capper.alias}
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
                        width: `${(follow.remainingPlays / follow.numPlaysPurchased) * 100}%`,
                        background: 'linear-gradient(90deg, #3b82f6, #2563eb)',
                        transition: 'width 0.3s ease',
                      }}
                    />
                  </Box>
                </Box>
              ))}
            </Box>
          </Paper>
        )}

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
              {total > 0 ? `of ${total} bets` : 'No bets'}
            </Typography>
          </Box>
        </Box>

        {/* Bets Feed */}
        {loading ? (
          <Box display="flex" justifyContent="center" alignItems="center" minHeight="400px">
            <CircularProgress />
          </Box>
        ) : bets.length === 0 ? (
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
              No bets yet
            </Typography>
            <Typography variant="body2" sx={{ color: 'var(--text-muted)' }}>
              {follows.length === 0
                ? "You're not following anyone yet. Follow creators on the leaderboard to see their bets here."
                : "The creators you're following haven't posted any bets yet."}
            </Typography>
          </Paper>
        ) : (
          <Box display="flex" flexDirection="column" gap={3}>
            {bets.map((bet) => (
              <motion.div
                key={bet._id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3 }}
              >
                <BetCard bet={bet} onUpdate={fetchFollowingFeed} />
              </motion.div>
            ))}
          </Box>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
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

